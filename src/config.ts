import dotenv from "dotenv";

// Load .env if present; silently continue if it is missing so the server still starts.
dotenv.config();

export const MODEL_NAME = "gpt-5.4-mini";
export const MAX_AGENT_STEPS = 4;
export const MAX_TOKENS = 2048;
export const SEARCH_MAX_RESULTS = 5;
export const SEARCH_TIMEOUT_MS = 10_000;

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

export const PORT = parsePort(process.env.PORT, 3000);

export function getOpenAIApiKey(): string {
  return (process.env.OPENAI_API_KEY ?? "").trim();
}

export function getTavilyApiKey(): string {
  return (process.env.TAVILY_API_KEY ?? "").trim();
}

export function getMissingEnvKeys(): string[] {
  const missing: string[] = [];
  if (!getOpenAIApiKey()) missing.push("OPENAI_API_KEY");
  if (!getTavilyApiKey()) missing.push("TAVILY_API_KEY");
  return missing;
}

export function logEnvWarnings(): void {
  const missing = getMissingEnvKeys();
  if (missing.length > 0) {
    console.error(
      `[config] Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Create a .env file (see .env.example) and set them before chatting.`
    );
  }
}
