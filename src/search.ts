import {
  SEARCH_MAX_RESULTS,
  SEARCH_TIMEOUT_MS,
  getTavilyApiKey,
} from "./config.js";

export interface SearchResult {
  title: string;
  url: string;
  publishedDate: string;
  content: string;
}

export interface SearchSource {
  title: string;
  url: string;
  date: string;
}

export interface WebSearchOutput {
  text: string;
  sources: SearchSource[];
  isError: boolean;
}

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

interface TavilyApiResult {
  title?: unknown;
  url?: unknown;
  published_date?: unknown;
  content?: unknown;
}

interface TavilyApiResponse {
  results?: unknown;
}

/**
 * Combines a timeout signal with an optional caller abort signal so a search
 * never hangs past SEARCH_TIMEOUT_MS and cancels immediately if the client disconnects.
 */
function createSearchSignal(parentSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  if (!parentSignal) return timeoutSignal;
  return AbortSignal.any([parentSignal, timeoutSignal]);
}

/**
 * Provider implementation for web search (Tavily).
 * Kept behind this single function so the provider can be swapped easily later.
 */
async function searchProvider(
  query: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: SEARCH_MAX_RESULTS,
      search_depth: "basic",
      include_published_date: true,
    }),
    signal: createSearchSignal(signal),
  });

  if (!response.ok) {
    let detail = response.statusText || `HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as { detail?: unknown; error?: unknown };
      if (typeof errBody?.detail === "string" && errBody.detail) {
        detail = errBody.detail;
      } else if (typeof errBody?.error === "string" && errBody.error) {
        detail = errBody.error;
      }
    } catch {
      // Ignore JSON parse failure on error responses and fall back to status text.
    }
    throw new Error(`Tavily API error (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as TavilyApiResponse;
  if (!data || !Array.isArray(data.results)) {
    throw new Error("Tavily API returned an unexpected response format.");
  }

  return data.results.map((item): SearchResult => {
    const record = (item ?? {}) as TavilyApiResult;
    const title =
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : "Untitled";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const publishedDate =
      typeof record.published_date === "string" && record.published_date.trim()
        ? record.published_date.trim()
        : "unknown";
    const content =
      typeof record.content === "string" ? record.content.trim() : "";

    return { title, url, publishedDate, content };
  });
}

function formatResultsAsPlainText(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No search results found.";
  }

  return results
    .map((result, index) => {
      return [
        `[${index + 1}] Title: ${result.title}`,
        `URL: ${result.url || "unknown"}`,
        `Published date: ${result.publishedDate}`,
        `Snippet: ${result.content || "(no snippet)"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatSearchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") {
      return `Search failed: request timed out after ${SEARCH_TIMEOUT_MS / 1000} seconds.`;
    }
    if (err.name === "AbortError") {
      return "Search failed: request was aborted.";
    }
    return `Search failed: ${err.message}`;
  }
  return "Search failed: unknown network or provider error.";
}

/**
 * Executes a web search and always returns a structured result—never throws—so
 * the agent loop can inform the model when search is unavailable.
 */
export async function webSearch(
  query: string,
  signal?: AbortSignal
): Promise<WebSearchOutput> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return {
      text: "Search failed: query must not be empty.",
      sources: [],
      isError: true,
    };
  }

  const apiKey = getTavilyApiKey();
  if (!apiKey) {
    return {
      text: "Search failed: TAVILY_API_KEY is not configured on the server.",
      sources: [],
      isError: true,
    };
  }

  try {
    const results = await searchProvider(trimmedQuery, apiKey, signal);
    const sources: SearchSource[] = results
      .filter((r) => Boolean(r.url))
      .map((r) => ({
        title: r.title,
        url: r.url,
        date: r.publishedDate,
      }));

    return {
      text: formatResultsAsPlainText(results),
      sources,
      isError: false,
    };
  } catch (err) {
    return {
      text: formatSearchError(err),
      sources: [],
      isError: true,
    };
  }
}

