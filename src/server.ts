import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { runAgent, type ChatMessage } from "./agent.js";
import { PORT, logEnvWarnings } from "./config.js";
import { getAllMessages } from "./history.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

function validateMessages(body: unknown): { messages: ChatMessage[]; sessionId: string } | string {
  if (!body || typeof body !== "object") {
    return "Request body must be a JSON object.";
  }

  const { messages, sessionId } = body as { messages?: unknown; sessionId?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) {
    return "'messages' must be a non-empty array.";
  }

  const cleaned: ChatMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      return "Each message must be an object with 'role' and 'content'.";
    }
    const { role, content } = msg as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") {
      return "Message 'role' must be 'user' or 'assistant'.";
    }
    if (typeof content !== "string" || !content.trim()) {
      return "Message 'content' must be a non-empty string.";
    }
    cleaned.push({ role, content: content.trim() });
  }

  if (cleaned[cleaned.length - 1].role !== "user") {
    return "The last message must have role 'user'.";
  }

  const validSessionId =
    typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "default";

  return { messages: cleaned, sessionId: validSessionId };
}

const app = Fastify({ logger: false });

await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: "/",
});

app.get("/health", async () => {
  return { ok: true };
});

app.get("/api/history", async (request) => {
  const query = request.query as { sessionId?: string };
  const sessionId = query.sessionId?.trim() || "default";
  const messages = getAllMessages(sessionId);
  return { messages };
});

app.post("/api/chat", async (request, reply) => {
  const validated = validateMessages(request.body);
  if (typeof validated === "string") {
    return reply.code(400).send({ error: validated });
  }

  // Hijack response so Fastify does not close the stream before SSE completes.
  reply.hijack();

  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) {
      abortController.abort();
    }
  });

  const sendEvent = (event: string, data: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await runAgent({
      messages: validated.messages,
      sessionId: validated.sessionId,
      signal: abortController.signal,
      callbacks: {
        onToken: (text) => sendEvent("token", { text }),
        onStatus: (message) => sendEvent("status", { message }),
        onDone: (result) => sendEvent("done", result),
        onError: (error) => sendEvent("error", { error }),
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unexpected server error.";
    sendEvent("error", { error: message });
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }
});

async function start(): Promise<void> {
  logEnvWarnings();
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server listening on http://localhost:${PORT}`);
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

await start();
