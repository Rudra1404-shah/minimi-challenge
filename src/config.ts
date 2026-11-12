import dotenv from "dotenv";

// Load .env if present; silently continue if it is missing so the server still starts.
dotenv.config();

export const MODEL_NAME = "gpt-5.4-mini";
export const MAX_AGENT_STEPS = 4;
export const MAX_TOKENS = 2048;
export const SEARCH_MAX_RESULTS = 5;
export const SEARCH_TIMEOUT_MS = 10_000;

/**
 * Known vendor names mapped to their official domains for vendor-domain search
 * boosting and official/secondary source classification.
 */
export const VENDOR_DOMAINS: Record<string, string[]> = {
  notion: ["notion.com", "notion.so"],
  linear: ["linear.app"],
  figma: ["figma.com"],
  slack: ["slack.com"],
  github: ["github.com"],
  vercel: ["vercel.com"],
  supabase: ["supabase.com"],
  neon: ["neon.tech", "neon.com"],
  render: ["render.com"],
  railway: ["railway.app", "railway.com"],
  "fly.io": ["fly.io"],
  openai: ["openai.com"],
  anthropic: ["anthropic.com", "claude.com"],
  stripe: ["stripe.com"],
  hubspot: ["hubspot.com"],
  salesforce: ["salesforce.com"],
  atlassian: ["atlassian.com"],
  jira: ["atlassian.com"],
  airtable: ["airtable.com"],
  asana: ["asana.com"],
  "monday.com": ["monday.com"],
  clickup: ["clickup.com"],
  cursor: ["cursor.com"],
  cloudflare: ["cloudflare.com"],
  netlify: ["netlify.com"],
  heroku: ["heroku.com"],
  intercom: ["intercom.com"],
  zendesk: ["zendesk.com"],
  pipedrive: ["pipedrive.com"],
  datadog: ["datadoghq.com"],
  sentry: ["sentry.io"],
  posthog: ["posthog.com"],
  planetscale: ["planetscale.com"],
  turso: ["turso.tech"],
  upstash: ["upstash.com"],
};

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
