import type { SearchSource } from "../src/search.js";

export interface TestCase {
  id: string;
  category: string;
  question: string;
  vendor?: string | null;
  expectedDomains?: string[];
  expectReadOfficial?: boolean;
  expectSearch?: boolean;
  minDistinctDomains?: number;
  requireBillingBasis?: boolean;
  expectedFacts?: Array<string | string[]>;
  forbiddenPhrases?: string[];
  notes?: string;
}

/**
 * Canonicalizes a URL by:
 * - lowercasing
 * - removing "www."
 * - removing query strings and fragments
 * - removing trailing slashes
 */
export function canonicalizeUrl(urlStr: string): string {
  const cleaned = urlStr.trim().replace(/[.,;:!?]+$/, "");
  try {
    const u = new URL(cleaned);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${host}${pathname}`;
  } catch {
    return cleaned
      .toLowerCase()
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .replace(/^(https?:\/\/)?www\./, "$1");
  }
}

/**
 * Extracts the registrable domain (e.g. "notion.com", "linear.app").
 * Handles multi-part and simple TLDs.
 */
export function getRegistrableDomain(urlStr: string): string {
  try {
    const canonical = canonicalizeUrl(urlStr);
    const u = new URL(canonical);
    const host = u.hostname.replace(/^www\./, "");
    const parts = host.split(".");
    if (parts.length >= 2) {
      return parts.slice(-2).join(".");
    }
    return host;
  } catch {
    return "";
  }
}

/**
 * Extracts raw URLs and markdown link URLs from text.
 */
export function extractUrlsFromText(text: string): string[] {
  const urls: string[] = [];
  const mdRegex = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdRegex.exec(text)) !== null) {
    urls.push(mdMatch[1].replace(/[.,;:!?]+$/, ""));
  }

  const rawRegex = /(https?:\/\/[^\s<)\]'",]+)/gi;
  let rawMatch: RegExpExecArray | null;
  while ((rawMatch = rawRegex.exec(text)) !== null) {
    urls.push(rawMatch[1].replace(/[.,;:!?]+$/, ""));
  }

  return urls;
}

/**
 * Filters source items to only those whose canonical URL is cited in the text.
 */
export function getCitedSources(sources: SearchSource[], answerText: string): SearchSource[] {
  const citedRawUrls = extractUrlsFromText(answerText);
  if (citedRawUrls.length === 0) return [];

  const canonicalCited = new Set(citedRawUrls.map(canonicalizeUrl));

  const seen = new Set<string>();
  const result: SearchSource[] = [];

  for (const s of sources) {
    if (!s.url) continue;
    const can = canonicalizeUrl(s.url);
    if (canonicalCited.has(can) && !seen.has(can)) {
      seen.add(can);
      result.push({
        ...s,
        url: can,
      });
    }
  }

  return result;
}

function checkFact(fact: string | string[], answerText: string): boolean {
  if (Array.isArray(fact)) {
    return fact.every((word) => answerText.toLowerCase().includes(word.toLowerCase()));
  }

  if (fact.startsWith("/") && fact.lastIndexOf("/") > 0) {
    const lastSlash = fact.lastIndexOf("/");
    const pattern = fact.slice(1, lastSlash);
    const flags = fact.slice(lastSlash + 1);
    try {
      const re = new RegExp(pattern, flags);
      return re.test(answerText);
    } catch {
      // ignore
    }
  }

  return answerText.toLowerCase().includes(fact.toLowerCase());
}

/**
 * Evaluates an answer against the test case rules.
 * Returns an array of human-readable failure reasons (empty array means PASS).
 */
export function evaluateAnswer(
  testCase: TestCase,
  answerText: string,
  searchCalled: boolean,
  citedSources: SearchSource[]
): string[] {
  const failures: string[] = [];

  // Rule 1: expectSearch
  if (testCase.expectSearch === true && !searchCalled) {
    failures.push("Expected web_search to be called, but search was not called.");
  }
  if (testCase.expectSearch === false && searchCalled) {
    failures.push("Expected NO web_search call, but search was called.");
  }

  // Rule 2: expectReadOfficial
  if (testCase.expectReadOfficial === true) {
    const hasOfficialRead = citedSources.some(
      (s) => s.kind === "official" && s.readStatus === "READ"
    );
    if (!hasOfficialRead) {
      failures.push(
        "Expected at least one official source with readStatus 'READ' to be cited in the answer, but none was cited."
      );
    }
  }

  // Rule 3: minDistinctDomains
  if (testCase.minDistinctDomains && testCase.minDistinctDomains > 1) {
    const domains = new Set(
      citedSources.map((s) => getRegistrableDomain(s.url)).filter(Boolean)
    );
    if (domains.size < testCase.minDistinctDomains) {
      failures.push(
        `Expected at least ${testCase.minDistinctDomains} distinct domains among cited sources, found ${domains.size} (${[...domains].join(", ")}).`
      );
    }
  }

  // Rule 4: requireBillingBasis
  if (testCase.requireBillingBasis === true) {
    const priceRegex = /\$\s*([1-9]\d*(?:\.\d{2})?)\b|\b([1-9]\d*(?:\.\d{2})?)\s*(?:USD|dollars)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = priceRegex.exec(answerText)) !== null) {
      const windowAfter = answerText
        .slice(match.index + match[0].length, match.index + match[0].length + 60)
        .toLowerCase();
      const hasBasis = /(?:\b(?:monthly|annual|annually|yearly)\b|\/(?:mo|month|yr|year)\b|\bper\s+(?:month|year)\b|\b(?:a|each)\s+(?:month|year)\b)/i.test(
        windowAfter
      );
      if (!hasBasis) {
        failures.push(
          `Price '${match[0]}' is missing required billing basis ('monthly', 'annual', or 'yearly'). Following context: "${windowAfter.trim().slice(0, 30)}..."`
        );
      }
    }
  }

  // Rule 5: forbiddenPhrases
  const hasOfficialRead = citedSources.some(
    (s) => s.kind === "official" && s.readStatus === "READ"
  );
  if (!hasOfficialRead && Array.isArray(testCase.forbiddenPhrases)) {
    for (const phrase of testCase.forbiddenPhrases) {
      if (answerText.toLowerCase().includes(phrase.toLowerCase())) {
        failures.push(
          `Answer contains forbidden phrase "${phrase}" when no official READ source is cited.`
        );
      }
    }
  }

  // Rule 6: expectedFacts
  if (Array.isArray(testCase.expectedFacts)) {
    for (const fact of testCase.expectedFacts) {
      if (!checkFact(fact, answerText)) {
        const desc = Array.isArray(fact) ? `all of [${fact.map((w) => `"${w}"`).join(", ")}]` : `"${fact}"`;
        failures.push(`Missing expected fact: ${desc}.`);
      }
    }
  }

  return failures;
}
