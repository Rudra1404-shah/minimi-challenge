import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import {
  SEARCH_MAX_RESULTS,
  SEARCH_TIMEOUT_MS,
  VENDOR_DOMAINS,
  getTavilyApiKey,
} from "./config.js";
import { getCachedSearch, setCachedSearch } from "./db.js";

export type SourceKind = "official" | "secondary" | "unknown";
export type ReadStatus = "READ" | "SNIPPET ONLY";

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
  kind: SourceKind;
  readStatus: ReadStatus;
  label?: "searched";
}

export interface WebSearchOutput {
  text: string;
  sources: SearchSource[];
  isError: boolean;
  cacheHit: boolean;
}

interface EnrichedSearchResult extends SearchResult {
  pageText: string | null;
  readStatus: ReadStatus;
  kind: SourceKind;
  unreadableReason: string | null;
}

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const PAGE_FETCH_LIMIT = 3;
const PAGE_FETCH_TIMEOUT_MS = 5_000;
const MAX_PAGE_CHARS = 4_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MIN_READABLE_CHARS = 80;

interface TavilyApiResult {
  title?: unknown;
  url?: unknown;
  published_date?: unknown;
  content?: unknown;
}

interface TavilyApiResponse {
  results?: unknown;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COMMON_DICTIONARY_VENDORS = new Set([
  "linear",
  "render",
  "cursor",
  "neon",
  "stripe",
  "fly.io",
]);

const VENDOR_CONTEXT_REGEX =
  /\b(pricing|price|prices|cost|costs|plan|plans|tier|tiers|subscription|limit|limits|feature|features|guest|guests|pro|plus|enterprise|seat|seats|license|software|app|tool|platform|saas|api|docs|company|workspace|founder|ceo)\b/i;

/**
 * Matches vendor names or domains from config.ts against the query.
 * Restricts vendor-name matches to clear pricing/product queries or explicit domains,
 * preventing generic words (linear, render, cursor, stripe) from triggering false boosts.
 */
function detectVendorDomains(query: string): string[] {
  const domains = new Set<string>();
  const trimmed = query.trim();

  for (const [vendor, vendorDomains] of Object.entries(VENDOR_DOMAINS)) {
    // 1. Explicit domain in query
    const domainMatch = vendorDomains.some((d) =>
      new RegExp(`\\b${escapeRegex(d)}\\b`, "i").test(trimmed)
    );
    if (domainMatch) {
      for (const d of vendorDomains) domains.add(d.toLowerCase());
      continue;
    }

    // 2. Possessive match (e.g. Notion's, Linear's, Figma's)
    const possessivePattern = new RegExp(`\\b${escapeRegex(vendor)}['’]s?\\b`, "i");
    const hasPossessive = possessivePattern.test(trimmed);

    // 3. Exact vendor word
    const vendorPattern = new RegExp(`\\b${escapeRegex(vendor)}\\b`, "i");
    const hasVendorWord = vendorPattern.test(trimmed);

    if (COMMON_DICTIONARY_VENDORS.has(vendor.toLowerCase())) {
      const disambiguator =
        vendor === "linear"
          ? /\blinear\s*(?:app|issue|tracker|project|ticket|pricing|plan|software)\b/i
          : vendor === "render"
            ? /\brender\s*(?:cloud|hosting|service|pricing|deploy|platform)\b/i
            : vendor === "cursor"
              ? /\bcursor\s*(?:ai|editor|ide|pricing|tool)\b/i
              : vendor === "neon"
                ? /\bneon\s*(?:tech|db|database|postgres|serverless|pricing)\b/i
                : vendor === "stripe"
                  ? /\bstripe\s*(?:payment|billing|checkout|api|pricing|fee)\b/i
                  : null;

      if (hasPossessive || (disambiguator && disambiguator.test(trimmed))) {
        for (const d of vendorDomains) domains.add(d.toLowerCase());
      }
    } else {
      if (hasPossessive || (hasVendorWord && VENDOR_CONTEXT_REGEX.test(trimmed))) {
        for (const d of vendorDomains) domains.add(d.toLowerCase());
      }
    }
  }

  return [...domains];
}

function isOfficialUrl(url: string, vendorDomains: string[]): boolean {
  if (vendorDomains.length === 0) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return vendorDomains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function classifySourceKind(url: string, vendorDomains: string[]): SourceKind {
  if (vendorDomains.length === 0) return "unknown";
  return isOfficialUrl(url, vendorDomains) ? "official" : "secondary";
}

function normalizeUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${host}${pathname}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * Combines a timeout signal with an optional caller abort signal so requests
 * never hang past their timeout and cancel immediately if the client disconnects.
 */
function createRequestSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
  signal?: AbortSignal,
  includeDomains?: string[]
): Promise<SearchResult[]> {
  const payload: Record<string, unknown> = {
    query,
    max_results: SEARCH_MAX_RESULTS,
    search_depth: "basic",
    include_published_date: true,
  };
  if (includeDomains && includeDomains.length > 0) {
    payload.include_domains = includeDomains;
  }

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: createRequestSignal(SEARCH_TIMEOUT_MS, signal),
  });

  if (!response.ok) {
    let detail = response.statusText || `HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as {
        detail?: unknown;
        error?: unknown;
      };
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

function isValidDateCandidate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (!/(19|20)\d{2}/.test(trimmed)) return false;
  return !Number.isNaN(Date.parse(trimmed));
}

function findDateInJsonLd(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findDateInJsonLd(item);
      if (found) return found;
    }
    return null;
  }

  const record = node as Record<string, unknown>;
  for (const key of ["dateModified", "datePublished"]) {
    if (isValidDateCandidate(record[key])) {
      return record[key].trim();
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const found = findDateInJsonLd(value);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extracts a publish or last-updated date from structured HTML metadata,
 * JSON-LD blocks, or <time> elements. Never infers a date from body prose.
 */
function extractDateFromDocument(doc: Document): string | null {
  const metaSelectors = [
    'meta[property="article:modified_time"]',
    'meta[property="og:updated_time"]',
    'meta[name="last-modified"]',
    'meta[name="dcterms.modified"]',
    'meta[itemprop="dateModified"]',
    'meta[property="article:published_time"]',
    'meta[property="og:published_time"]',
    'meta[name="pubdate"]',
    'meta[name="publishdate"]',
    'meta[name="date"]',
    'meta[name="DC.date.issued"]',
    'meta[name="dcterms.date"]',
    'meta[itemprop="datePublished"]',
  ];

  for (const selector of metaSelectors) {
    const content = doc.querySelector(selector)?.getAttribute("content");
    if (isValidDateCandidate(content)) {
      return content.trim();
    }
  }

  const jsonLdScripts = doc.querySelectorAll(
    'script[type="application/ld+json"]'
  );
  for (const script of jsonLdScripts) {
    if (!script.textContent) continue;
    try {
      const parsed: unknown = JSON.parse(script.textContent);
      const found = findDateInJsonLd(parsed);
      if (found) return found;
    } catch {
      // Ignore malformed JSON-LD blocks on third-party pages.
    }
  }

  const timeElements = doc.querySelectorAll("time[datetime]");
  for (const el of timeElements) {
    const dt = el.getAttribute("datetime");
    if (isValidDateCandidate(dt)) {
      return dt.trim();
    }
  }

  return null;
}

function normalizeExtractedText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isBotChallengeOrLoginText(text: string): boolean {
  if (text.length > 700) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("enable javascript and cookies to continue") ||
    (lower.includes("just a moment") && lower.includes("cloudflare")) ||
    lower.includes("access denied") ||
    lower.includes("sign in to continue") ||
    lower.includes("log in to continue")
  );
}

/**
 * Truncates long pages to MAX_PAGE_CHARS. Keeps the start of the page when
 * pricing info appears early, or shifts the window if the pricing section
 * appears further down a very long page.
 */
function capPageText(text: string): string {
  if (text.length <= MAX_PAGE_CHARS) return text;

  const pricingMatch = text.match(
    /(?:\$\s*\d+|\b(?:pricing|plans?\s*(?:&|and)\s*pricing|plus\s+plan|per\s+(?:member|seat|user)\s*\/\s*month)\b)/i
  );
  if (
    pricingMatch &&
    pricingMatch.index !== undefined &&
    pricingMatch.index > 2_500
  ) {
    const start = Math.max(0, pricingMatch.index - 300);
    return `...[truncated leading content]\n${text.slice(start, start + MAX_PAGE_CHARS)}\n...[truncated]`;
  }

  return `${text.slice(0, MAX_PAGE_CHARS)}\n...[truncated]`;
}

/**
 * Converts an HTML fragment into readable plain text while preserving breaks
 * between paragraphs, headings, list items, and table cells.
 */
function extractTextFromHtmlFragment(
  doc: Document,
  htmlFragment: string
): string {
  const spaced = htmlFragment
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ");
  const container = doc.createElement("div");
  container.innerHTML = spaced;
  return normalizeExtractedText(container.textContent ?? "");
}

/**
 * Fallback extraction for pricing/product pages where Readability strips out
 * non-article card/table layouts.
 */
function extractFallbackText(doc: Document): string {
  const root = (doc.querySelector("main") ?? doc.body)?.cloneNode(
    true
  ) as Element | null;
  if (!root) return "";

  for (const el of root.querySelectorAll(
    "script, style, noscript, svg, nav, footer, header"
  )) {
    el.remove();
  }

  return extractTextFromHtmlFragment(doc, root.innerHTML);
}

function extractMainTextAndDate(
  html: string,
  pageUrl: string
): { text: string | null; date: string | null; reason: string | null } {
  // Suppress noisy JSDOM CSS parse warnings from third-party stylesheets.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  const dom = new JSDOM(html, { url: pageUrl, virtualConsole });
  try {
    const doc = dom.window.document;
    // Extract metadata before Readability mutates the document.
    const metaDate = extractDateFromDocument(doc);
    const fallbackText = extractFallbackText(doc);

    const article = new Readability(doc).parse();
    const articleText = article?.content
      ? extractTextFromHtmlFragment(doc, article.content)
      : article?.textContent
        ? normalizeExtractedText(article.textContent)
        : "";
    const readabilityDate = isValidDateCandidate(article?.publishedTime)
      ? article.publishedTime.trim()
      : null;

    // Prefer Readability's clean text unless it stripped out structured pricing cards/tables.
    const articleTopPrices = (articleText.slice(0, 2_000).match(/\$\s*\d+/g) ?? []).length;
    const fallbackTopPrices = (fallbackText.slice(0, 2_000).match(/\$\s*\d+/g) ?? []).length;
    const readabilityDroppedPrices =
      fallbackTopPrices > articleTopPrices ||
      (!/\$\s*\d+/.test(articleText) && /\$\s*\d+/.test(fallbackText));
    const chosenText =
      !readabilityDroppedPrices &&
      articleText.length >= MIN_READABLE_CHARS &&
      articleText.length >= fallbackText.length * 0.25
        ? articleText
        : fallbackText;

    if (!chosenText || chosenText.length < MIN_READABLE_CHARS) {
      return {
        text: null,
        date: metaDate ?? readabilityDate,
        reason: "insufficient readable content",
      };
    }

    if (isBotChallengeOrLoginText(chosenText)) {
      return {
        text: null,
        date: null,
        reason: "blocked by bot protection or login wall",
      };
    }

    return {
      text: capPageText(chosenText),
      date: metaDate ?? readabilityDate,
      reason: null,
    };
  } finally {
    dom.window.close();
  }
}

async function fetchAndReadPage(
  result: SearchResult,
  vendorDomains: string[],
  signal?: AbortSignal
): Promise<EnrichedSearchResult> {
  const initialKind = classifySourceKind(result.url, vendorDomains);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(result.url);
  } catch {
    return {
      ...result,
      pageText: null,
      readStatus: "SNIPPET ONLY",
      kind: initialKind,
      unreadableReason: "invalid URL",
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      ...result,
      pageText: null,
      readStatus: "SNIPPET ONLY",
      kind: initialKind,
      unreadableReason: "unsupported URL scheme",
    };
  }

  try {
    const response = await fetch(parsedUrl.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; MinimiBot/1.0; +https://localhost)",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: createRequestSignal(PAGE_FETCH_TIMEOUT_MS, signal),
    });

    // Use the final post-redirect URL for citations and official-domain checks.
    const finalUrl = response.url || parsedUrl.toString();
    const kind = classifySourceKind(finalUrl, vendorDomains);

    if (!response.ok) {
      return {
        ...result,
        url: finalUrl,
        pageText: null,
        readStatus: "SNIPPET ONLY",
        kind,
        unreadableReason: `HTTP ${response.status}`,
      };
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      return {
        ...result,
        url: finalUrl,
        pageText: null,
        readStatus: "SNIPPET ONLY",
        kind,
        unreadableReason: `non-HTML content (${contentType.split(";")[0].trim()})`,
      };
    }

    const rawHtml = await response.text();
    const boundedHtml =
      rawHtml.length > MAX_HTML_BYTES
        ? rawHtml.slice(0, MAX_HTML_BYTES)
        : rawHtml;

    const extracted = extractMainTextAndDate(boundedHtml, finalUrl);

    // Only a date the page itself explicitly states should be used.
    // Never fallback to Tavily's synthetic date for fetched pages.
    const publishedDate = extracted.date ?? "unknown";

    if (!extracted.text) {
      return {
        ...result,
        url: finalUrl,
        publishedDate,
        pageText: null,
        readStatus: "SNIPPET ONLY",
        kind,
        unreadableReason: extracted.reason ?? "could not extract main text",
      };
    }

    return {
      ...result,
      url: finalUrl,
      publishedDate,
      pageText: extracted.text,
      readStatus: "READ",
      kind,
      unreadableReason: null,
    };
  } catch (err) {
    let reason = "fetch failed";
    if (err instanceof Error) {
      if (err.name === "TimeoutError") {
        reason = `timed out after ${PAGE_FETCH_TIMEOUT_MS / 1000}s`;
      } else if (err.name === "AbortError") {
        reason = "request aborted";
      } else {
        reason = err.message;
      }
    }
    return {
      ...result,
      pageText: null,
      readStatus: "SNIPPET ONLY",
      kind: initialKind,
      unreadableReason: reason,
    };
  }
}

function mergeSearchResults(
  officialResults: SearchResult[],
  generalResults: SearchResult[]
): SearchResult[] {
  const merged: SearchResult[] = [];
  const seen = new Set<string>();

  for (const item of [...officialResults, ...generalResults]) {
    const key = item.url ? normalizeUrlKey(item.url) : item.title;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

function formatResultsAsPlainText(
  results: EnrichedSearchResult[],
  vendorDomains: string[]
): string {
  if (results.length === 0) {
    return "No search results found.";
  }

  const lines: string[] = [];

  if (
    vendorDomains.length > 0 &&
    !results.some((r) => r.kind === "official")
  ) {
    lines.push(
      `Notice: Official vendor page (${vendorDomains.join(", ")}) was not found in search results; only secondary results are available.`
    );
  }

  const formattedBlocks = results.map((result, index) => {
    const header = [
      `[${index + 1}] [${result.readStatus}] [${result.kind}] Title: ${result.title}`,
      `URL: ${result.url || "unknown"}`,
      `Published date: ${result.publishedDate}`,
    ];

    if (result.readStatus === "READ" && result.pageText) {
      return [...header, `Content (READ):\n${result.pageText}`].join("\n");
    }

    const reasonText = result.unreadableReason
      ? ` (${result.unreadableReason})`
      : "";
    return [
      ...header,
      `Status: SNIPPET ONLY${reasonText}`,
      `Snippet (SNIPPET ONLY): ${result.content || "(no snippet)"}`,
    ].join("\n");
  });

  lines.push(...formattedBlocks);
  return lines.join("\n\n");
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
 * Executes a web search (with vendor-domain boost when a known vendor is named),
 * reads the top 3 pages in parallel, and always returns a structured result.
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
      cacheHit: false,
    };
  }

  // Check search cache (1 hr TTL for pricing queries, 24 hr for general)
  const cached = getCachedSearch(trimmedQuery);
  if (cached) {
    return { ...cached, cacheHit: true };
  }

  const apiKey = getTavilyApiKey();
  if (!apiKey) {
    return {
      text: "Search failed: TAVILY_API_KEY is not configured on the server.",
      sources: [],
      isError: true,
      cacheHit: false,
    };
  }

  try {
    const vendorDomains = detectVendorDomains(trimmedQuery);
    let combinedResults: SearchResult[];

    if (vendorDomains.length > 0) {
      const [officialSettled, generalSettled] = await Promise.allSettled([
        searchProvider(trimmedQuery, apiKey, signal, vendorDomains),
        searchProvider(trimmedQuery, apiKey, signal),
      ]);

      const officialResults =
        officialSettled.status === "fulfilled" ? officialSettled.value : [];
      const generalResults =
        generalSettled.status === "fulfilled" ? generalSettled.value : [];

      if (
        officialSettled.status === "rejected" &&
        generalSettled.status === "rejected"
      ) {
        throw generalSettled.reason;
      }

      combinedResults = mergeSearchResults(officialResults, generalResults);
    } else {
      combinedResults = await searchProvider(trimmedQuery, apiKey, signal);
    }

    const topResults = combinedResults.slice(0, PAGE_FETCH_LIMIT);
    const remainingResults: EnrichedSearchResult[] = combinedResults
      .slice(PAGE_FETCH_LIMIT)
      .map((r) => ({
        ...r,
        pageText: null,
        readStatus: "SNIPPET ONLY",
        kind: classifySourceKind(r.url, vendorDomains),
        unreadableReason: "not fetched (beyond top 3)",
      }));

    const fetchedTopResults = await Promise.all(
      topResults.map((result) => fetchAndReadPage(result, vendorDomains, signal))
    );

    const enrichedResults = [...fetchedTopResults, ...remainingResults];
    const sources: SearchSource[] = enrichedResults
      .filter((r) => Boolean(r.url))
      .map((r) => ({
        title: r.title,
        url: r.url,
        date: r.publishedDate,
        kind: r.kind,
        readStatus: r.readStatus,
      }));

    const output: WebSearchOutput = {
      text: formatResultsAsPlainText(enrichedResults, vendorDomains),
      sources,
      isError: false,
      cacheHit: false,
    };

    const isPricing =
      /\b(price|pricing|cost|costs|plan|plans|tier|tiers|fee|fees|rate|rates|subscription|license)\b/i.test(
        trimmedQuery
      );
    setCachedSearch(trimmedQuery, output, isPricing);

    return output;
  } catch (err) {
    return {
      text: formatSearchError(err),
      sources: [],
      isError: true,
      cacheHit: false,
    };
  }
}
