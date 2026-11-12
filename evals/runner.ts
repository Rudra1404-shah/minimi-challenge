import fs from "node:fs";
import path from "node:path";
import { runAgent, type ChatMessage } from "../src/agent.js";
import { saveMessage, getDb } from "../src/db.js";
import { type SearchSource } from "../src/search.js";

interface TestCase {
  id: string;
  category: string;
  question: string;
  vendor?: string | null;
  expectedDomains?: string[];
  expectReadOfficial?: boolean;
  expectSearch?: boolean;
  minDistinctDomains?: number;
  expectedFacts?: string[];
  notes?: string;
}

interface RunResult {
  runIndex: number;
  latencyMs: number;
  passed: boolean;
  searchCalled: boolean;
  sourcesCount: number;
  sources: SearchSource[];
  contentPreview: string;
  failures: string[];
}

interface CaseSummary {
  id: string;
  category: string;
  question: string;
  runs: RunResult[];
  passCount: number;
  totalRuns: number;
  passRate: string;
  avgLatencyMs: number;
}

const CASES_PATH = path.resolve(process.cwd(), "evals", "cases.json");
const REPORT_PATH = path.resolve(process.cwd(), "evals", "report.json");

function loadCases(): TestCase[] {
  if (!fs.existsSync(CASES_PATH)) {
    throw new Error(`Test cases file not found at ${CASES_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CASES_PATH, "utf8")) as TestCase[];
}

function extractDomainsFromSources(sources: SearchSource[]): string[] {
  return sources
    .map((s) => {
      try {
        return new URL(s.url).hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

async function executeSingleRun(
  testCase: TestCase,
  runIndex: number,
  sessionId: string
): Promise<RunResult> {
  let fullContent = "";
  let finalSources: SearchSource[] = [];
  const statusEvents: string[] = [];
  const failures: string[] = [];

  const messages: ChatMessage[] = [{ role: "user", content: testCase.question }];

  const t0 = Date.now();
  await runAgent({
    messages,
    sessionId,
    callbacks: {
      onToken: (t) => {
        fullContent += t;
      },
      onStatus: (m) => {
        statusEvents.push(m);
      },
      onDone: (res) => {
        finalSources = res.sources;
      },
      onError: (err) => {
        failures.push(`Agent error: ${err}`);
      },
    },
  });
  const latencyMs = Date.now() - t0;

  const searchCalled = statusEvents.some((s) => s.startsWith("Searching:"));

  // Check 1: Tool search expectations
  if (testCase.expectSearch === false && searchCalled) {
    failures.push("web_search was called but test expects NO search");
  }
  if (testCase.expectSearch === true && !searchCalled) {
    failures.push("web_search was NOT called but test expects search");
  }

  // Check 2: Expected official domains
  if (testCase.expectedDomains && testCase.expectedDomains.length > 0) {
    const citedLower = fullContent.toLowerCase();
    const matchesDomain = testCase.expectedDomains.some((d) =>
      citedLower.includes(d.toLowerCase())
    );
    if (!matchesDomain) {
      failures.push(
        `Answer did not cite any expected official domain (${testCase.expectedDomains.join(", ")})`
      );
    }
  }

  // Check 3: Minimum distinct domains
  if (testCase.minDistinctDomains && testCase.minDistinctDomains > 1) {
    const domains = new Set(extractDomainsFromSources(finalSources));
    if (domains.size < testCase.minDistinctDomains) {
      failures.push(
        `Expected >= ${testCase.minDistinctDomains} distinct domains, found ${domains.size}`
      );
    }
  }

  // Check 4: Source fidelity (all source chips must appear in text)
  for (const src of finalSources) {
    const urlLower = src.url.toLowerCase();
    try {
      const u = new URL(urlLower);
      const hostPath = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
      if (!fullContent.toLowerCase().includes(urlLower) && !fullContent.toLowerCase().includes(hostPath)) {
        failures.push(`Source chip ${src.url} does not appear in answer text`);
      }
    } catch {
      if (!fullContent.toLowerCase().includes(urlLower)) {
        failures.push(`Source chip ${src.url} does not appear in answer text`);
      }
    }
  }

  const passed = failures.length === 0;

  return {
    runIndex,
    latencyMs,
    passed,
    searchCalled,
    sourcesCount: finalSources.length,
    sources: finalSources,
    contentPreview: fullContent.slice(0, 150).replace(/\n/g, " "),
    failures,
  };
}

export async function runAllEvals(): Promise<void> {
  const cases = loadCases();
  console.log(`\n======================================================`);
  console.log(`  Minimi Evaluation Suite (3 runs per case)`);
  console.log(`  Loaded ${cases.length} cases from ${CASES_PATH}`);
  console.log(`======================================================\n`);

  // Seed sample history for the Nov 3 history check test
  const historySession = "eval_history_session";
  const nov3Ts = Date.parse("2026-11-03T14:30:00+05:30");
  saveMessage(historySession, "user", "What is the best way to implement vector search in PostgreSQL?", nov3Ts);
  saveMessage(historySession, "assistant", "pgvector is the standard extension for vector search in Postgres.", nov3Ts + 2000);

  const summaries: CaseSummary[] = [];

  for (const tc of cases) {
    console.log(`[Eval] ${tc.id} (${tc.category}): "${tc.question}"`);
    const runs: RunResult[] = [];
    const sessionId = tc.id === "history-nov-3-check" ? historySession : `eval_session_${tc.id}`;

    for (let r = 1; r <= 3; r++) {
      process.stdout.write(`  Run ${r}/3... `);
      const res = await executeSingleRun(tc, r, sessionId);
      runs.push(res);
      const mark = res.passed ? "PASS" : "FAIL";
      console.log(`${mark} (${(res.latencyMs / 1000).toFixed(2)}s, sources: ${res.sourcesCount})`);
      if (!res.passed) {
        for (const f of res.failures) {
          console.log(`    ↳ Failure: ${f}`);
        }
      }
    }

    const passCount = runs.filter((r) => r.passed).length;
    const avgLatencyMs = Math.round(runs.reduce((acc, r) => acc + r.latencyMs, 0) / runs.length);

    summaries.push({
      id: tc.id,
      category: tc.category,
      question: tc.question,
      runs,
      passCount,
      totalRuns: runs.length,
      passRate: `${Math.round((passCount / runs.length) * 100)}%`,
      avgLatencyMs,
    });
    console.log("");
  }

  // Generate Report
  const totalRuns = summaries.reduce((acc, s) => acc + s.totalRuns, 0);
  const totalPasses = summaries.reduce((acc, s) => acc + s.passCount, 0);
  const overallRate = `${Math.round((totalPasses / totalRuns) * 100)}%`;
  const overallAvgLatency = Math.round(
    summaries.reduce((acc, s) => acc + s.avgLatencyMs, 0) / summaries.length
  );

  const report = {
    timestamp: new Date().toISOString(),
    overallPassRate: overallRate,
    overallPassCount: totalPasses,
    overallTotalRuns: totalRuns,
    overallAvgLatencyMs: overallAvgLatency,
    cases: summaries,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log(`\n================== EVALUATION REPORT ==================`);
  console.log(`Overall Pass Rate: ${totalPasses}/${totalRuns} (${overallRate})`);
  console.log(`Average Latency: ${(overallAvgLatency / 1000).toFixed(2)}s`);
  console.log(`Detailed report written to: ${REPORT_PATH}\n`);

  console.log(
    `| ID | Category | Pass Rate | Avg Latency | Notes |`
  );
  console.log(
    `|:---|:---|:---:|:---:|:---|`
  );
  for (const s of summaries) {
    console.log(
      `| ${s.id} | ${s.category} | ${s.passRate} | ${(s.avgLatencyMs / 1000).toFixed(2)}s | ${s.passCount === s.totalRuns ? "All passed" : "Needs review"} |`
    );
  }
  console.log(`=======================================================\n`);
}

// Auto-run when invoked directly
if (process.argv[1] && process.argv[1].endsWith("runner.ts")) {
  runAllEvals()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Eval runner failed:", err);
      process.exit(1);
    });
}

