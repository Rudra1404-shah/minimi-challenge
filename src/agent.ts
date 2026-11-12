import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";
import {
  MAX_AGENT_STEPS,
  MAX_TOKENS,
  MODEL_NAME,
  getOpenAIApiKey,
} from "./config.js";
import { buildSystemPrompt } from "./prompt.js";
import { webSearch, type SearchSource } from "./search.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentCallbacks {
  onToken: (text: string) => void;
  onStatus: (message: string) => void;
  onDone: (result: { content: string; sources: SearchSource[] }) => void;
  onError: (error: string) => void;
}

const WEB_SEARCH_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current or time-sensitive information such as prices, product releases, news, or people's current roles.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to run.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

function formatOpenAIError(err: unknown): string {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 401) {
      return "OpenAI API authentication failed (401). Check your OPENAI_API_KEY.";
    }
    if (err.status === 429) {
      return "OpenAI API rate limit reached (429). Please wait a moment and try again.";
    }
    return `OpenAI API error (${err.status ?? "unknown"}): ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "An unexpected error occurred while calling the model.";
}

function addUniqueSources(target: SearchSource[], incoming: SearchSource[]): void {
  const seen = new Set(target.map((s) => s.url));
  for (const source of incoming) {
    if (!seen.has(source.url)) {
      seen.add(source.url);
      target.push(source);
    }
  }
}

export async function runAgent(params: {
  messages: ChatMessage[];
  callbacks: AgentCallbacks;
  signal?: AbortSignal;
}): Promise<void> {
  const { messages, callbacks, signal } = params;

  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    callbacks.onError(
      "Missing OPENAI_API_KEY. Set it in your .env file and restart or retry."
    );
    return;
  }

  const client = new OpenAI({ apiKey });
  const systemPrompt = buildSystemPrompt();
  const conversation: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  const collectedSources: SearchSource[] = [];
  let fullText = "";

  try {
    for (let step = 1; step <= MAX_AGENT_STEPS; step++) {
      if (signal?.aborted) return;

      const stream = await client.chat.completions.create(
        {
          model: MODEL_NAME,
          max_completion_tokens: MAX_TOKENS,
          messages: conversation,
          tools: [WEB_SEARCH_TOOL],
          stream: true,
        },
        { signal }
      );

      let stepText = "";
      let finishReason: string | null = null;
      const toolCallsByIndex = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const chunk of stream) {
        if (signal?.aborted) return;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta;
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content.length > 0) {
          stepText += delta.content;
          fullText += delta.content;
          callbacks.onToken(delta.content);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tcDelta of delta.tool_calls) {
            const index = tcDelta.index;
            const existing = toolCallsByIndex.get(index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            if (tcDelta.id) existing.id += tcDelta.id;
            if (tcDelta.function?.name) existing.name += tcDelta.function.name;
            if (tcDelta.function?.arguments) {
              existing.arguments += tcDelta.function.arguments;
            }
            toolCallsByIndex.set(index, existing);
          }
        }
      }

      const toolCalls = [...toolCallsByIndex.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => tc);

      if (finishReason !== "tool_calls" && toolCalls.length === 0) {
        if (!fullText.trim()) {
          callbacks.onError("Model returned an empty response.");
          return;
        }

        callbacks.onDone({
          content: fullText,
          sources: collectedSources,
        });
        return;
      }

      if (toolCalls.length === 0) {
        callbacks.onError(
          "Model requested a tool call but returned no valid tool_calls."
        );
        return;
      }

      // Enforce the 4-step cap: if step 4 still asks for tools, stop with a clear message.
      if (step === MAX_AGENT_STEPS) {
        const prefix =
          fullText.length > 0 && !fullText.endsWith("\n") ? "\n\n" : "";
        const capNotice =
          `${prefix}I reached the ${MAX_AGENT_STEPS}-step search limit before finishing. ` +
          `Please try asking a narrower question.`;
        fullText += capNotice;
        callbacks.onToken(capNotice);
        callbacks.onDone({
          content: fullText,
          sources: collectedSources,
        });
        return;
      }

      // Preserve the assistant turn (including tool_calls) before appending tool outputs.
      conversation.push({
        role: "assistant",
        content: stepText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        })),
      });

      for (const tc of toolCalls) {
        if (signal?.aborted) return;

        if (!tc.id) {
          callbacks.onError("Model returned a malformed tool call without an ID.");
          return;
        }

        if (tc.name !== "web_search") {
          conversation.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `Unsupported tool "${tc.name}". Only web_search is available.`,
          });
          continue;
        }

        let query = "";
        try {
          const parsed = JSON.parse(tc.arguments) as { query?: unknown };
          if (typeof parsed?.query === "string") {
            query = parsed.query.trim();
          }
        } catch {
          conversation.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "Invalid web_search arguments: malformed JSON.",
          });
          continue;
        }

        if (!query) {
          conversation.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "Invalid web_search input: missing non-empty string 'query'.",
          });
          continue;
        }

        callbacks.onStatus(`Searching: ${query}`);
        const searchOutput = await webSearch(query, signal);
        addUniqueSources(collectedSources, searchOutput.sources);

        conversation.push({
          role: "tool",
          tool_call_id: tc.id,
          content: searchOutput.text,
        });
      }

      if (fullText.length > 0 && !fullText.endsWith("\n")) {
        fullText += "\n\n";
        callbacks.onToken("\n\n");
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      return;
    }
    callbacks.onError(formatOpenAIError(err));
  }
}
