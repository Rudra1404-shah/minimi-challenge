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
import {
  resolveHistoryForQuery,
  saveMessage,
  trimMessagesToBudget,
} from "./history.js";

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
      "Search the web for current or time-sensitive information such as prices, pricing models, market rates, product releases, news, or people's current roles.",
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

function extractUrlsFromText(text: string): string[] {
  const urls: string[] = [];
  // Match markdown links: [text](https://...)
  const mdRegex = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdRegex.exec(text)) !== null) {
    urls.push(mdMatch[1]);
  }

  // Match raw URLs: https://...
  const rawRegex = /(https?:\/\/[^\s<)\]'",]+)/gi;
  let rawMatch: RegExpExecArray | null;
  while ((rawMatch = rawRegex.exec(text)) !== null) {
    urls.push(rawMatch[1]);
  }

  return urls;
}

function canonicalizeUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`;
  } catch {
    return urlStr.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * Strictly filters collected sources so that only sources whose canonical URL
 * appears in the answer text are returned. If no sources were cited, returns []
 * (enforcing: no chips for unused results).
 */
export function filterSourcesForAnswer(
  sources: SearchSource[],
  answerText: string
): SearchSource[] {
  const citedUrls = extractUrlsFromText(answerText);
  if (citedUrls.length === 0) {
    return [];
  }

  const canonicalCited = new Set(citedUrls.map(canonicalizeUrl));

  return sources.filter((source) => {
    if (!source.url) return false;
    const sourceCanonical = canonicalizeUrl(source.url);
    return canonicalCited.has(sourceCanonical);
  });
}

export async function runAgent(params: {
  messages: ChatMessage[];
  callbacks: AgentCallbacks;
  signal?: AbortSignal;
  sessionId?: string;
}): Promise<void> {
  const { messages, callbacks, signal, sessionId = "default" } = params;

  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    callbacks.onError(
      "Missing OPENAI_API_KEY. Set it in your .env file and restart or retry."
    );
    return;
  }

  // Persist the latest user message to SQLite history
  const lastUserMsg = messages[messages.length - 1];
  if (lastUserMsg && lastUserMsg.role === "user") {
    saveMessage(sessionId, "user", lastUserMsg.content);
  }

  // Resolve relative/absolute date queries in code (e.g. "what did I ask on 3 November")
  const dateResolution = lastUserMsg
    ? resolveHistoryForQuery(sessionId, lastUserMsg.content)
    : { isDateQuery: false, historyText: null };

  const client = new OpenAI({ apiKey });
  const systemPrompt = buildSystemPrompt();

  // Trim older history turns beyond the token budget (Milestone 4)
  const trimmedMessages = trimMessagesToBudget(messages);

  const conversation: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  // If a date query matched past history (or lack thereof), inject it into context
  if (dateResolution.historyText) {
    conversation.push({
      role: "system",
      content: dateResolution.historyText,
    });
  }

  for (const m of trimmedMessages) {
    conversation.push({
      role: m.role,
      content: m.content,
    });
  }

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

        // Save assistant response to SQLite history
        saveMessage(sessionId, "assistant", fullText);

        const usedSources = filterSourcesForAnswer(collectedSources, fullText);
        callbacks.onDone({
          content: fullText,
          sources: usedSources,
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

        saveMessage(sessionId, "assistant", fullText);
        const usedSources = filterSourcesForAnswer(collectedSources, fullText);
        callbacks.onDone({
          content: fullText,
          sources: usedSources,
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

    const formattedError = formatOpenAIError(err);

    // If an error arrives after tokens have streamed, keep partial text and add (reply cut off).
    if (fullText.trim().length > 0) {
      const cutOffNotice = "\n\n(reply cut off)";
      fullText += cutOffNotice;
      callbacks.onToken(cutOffNotice);
      saveMessage(sessionId, "assistant", fullText);
      const usedSources = filterSourcesForAnswer(collectedSources, fullText);
      callbacks.onDone({
        content: fullText,
        sources: usedSources,
      });
    }

    callbacks.onError(formattedError);
  }
}
