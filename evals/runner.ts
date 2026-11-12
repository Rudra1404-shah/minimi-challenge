import fs from "node:fs";
import path from "node:path";
import { runAgent, type ChatMessage } from "../src/agent.js";
import { saveMessage } from "../src/db.js";
import { type SearchSource } from "../src/search.js";
import {
  evaluateAnswer,
  getCitedSources,
  canonicalizeUrl,
  type TestCase,
} from "./evaluator.js";

export interface RecordedSource {
  title: string;
  url: string; // canonical URL
  kind: string;
  readStatus: string;
  date: string;
}

export interface RecordedRun {
  runIndex: number;
  latencyMs: number;
  passed: boolean;
  searchCalled: boolean;
  cacheHit: boolean;
  citedSources: RecordedSource[];
  answerText: string; // full answer text, not a preview
  failures: string[];
}

export interface CaseSummary {
  id: string;
  category: string;
  question: string;
  runs: RecordedRun[];
  passCount: number;
  totalRuns: number;
  passRate: string;
  avgLatencyMs: number;
  cacheHitAvgLatencyMs: number | null;
  cacheMissAvgLatencyMs: number | null;
}

export interface CategorySummary {
  category: string;
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

async function executeSingleRun(
  testCase: TestCase,
  runIndex: number,
  sessionId: string
): Promise<RecordedRun> {
  let fullContent = "";
  let finalSources: SearchSource[] = [];
  let cacheHit = false;
  const statusEvents: string[] = [];
  const runnerErrors: string[] = [];

  const messages: ChatMessage[] = [{ role: "user", content: testCase.question }];

  const t0 = Date.now();
  try {
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
          cacheHit = Boolean(res.cacheHit);
        },
        onError: (err) => {
          runnerErrors.push(`Agent error: ${err}`);
        },
      },
    });
  } catch (err) {
    runnerErrors.push(`Exception: ${err instanceof Error ? err.message : String(err)}`);
  }
  const latencyMs = Date.now() - t0;

  const searchCalled = statusEvents.some((s) => s.startsWith("Searching:"));

  // Check cited sources (only sources whose canonical URL appears in the answer text)
  const citedSources = getCitedSources(finalSources, fullContent);

  // Evaluate against testCase rules
  const ruleFailures = evaluateAnswer(testCase, fullContent, searchCalled, citedSources);
  const allFailures = [...runnerErrors, ...ruleFailures];

  const recordedCitedSources: RecordedSource[] = citedSources.map((s) => ({
    title: s.title,
    url: canonicalizeUrl(s.url),
    kind: s.kind,
    readStatus: s.readStatus,
    date: s.date,
  }));

  return {
    runIndex,
    latencyMs,
    passed: allFailures.length === 0,
    searchCalled,
    cacheHit,
    citedSources: recordedCitedSources,
    answerText: fullContent,
    failures: allFailures,
  };
}

export async function runAllEvals(): Promise<void> {
  const cases = loadCases();
  console.log(`\n======================================================`);
  console.log(`  Minimi Evaluation Suite (3 runs per case)`);
  console.log(`  Loaded ${cases.length} cases from ${CASES_PATH}`);
  console.log(`======================================================\n`);

  // Seed message for the Nov 3 history check test
  const historySession = "eval_history_session_v2";
  const nov3Ts = Date.parse("2026-11-03T14:30:00+05:30");
  const seedQuestion = "How do I configure connection pooling for Postgres?";
  const seedAnswer = "Use PgBouncer for connection pooling with max_connections tuning.";
  saveMessage(historySession, "user", seedQuestion, nov3Ts);
  saveMessage(historySession, "assistant", seedAnswer, nov3Ts + 2000);

  const summaries: CaseSummary[] = [];
  const allRuns: RecordedRun[] = [];

  for (const tc of cases) {
    console.log(`[Eval] ${tc.id} (${tc.category}): "${tc.question}"`);
    const runs: RecordedRun[] = [];
    const sessionId = tc.id === "history-nov-3-check" ? historySession : `eval_session_${tc.id}_${Date.now()}`;

    for (let r = 1; r <= 3; r++) {
      process.stdout.write(`  Run ${r}/3... `);
      const res = await executeSingleRun(tc, r, sessionId);
      runs.push(res);
      allRuns.push(res);

      const mark = res.passed ? "PASS" : "FAIL";
      console.log(
        `${mark} (${(res.latencyMs / 1000).toFixed(2)}s, cacheHit: ${res.cacheHit}, sources: ${res.citedSources.length})`
      );
      if (!res.passed) {
        for (const f of res.failures) {
          console.log(`    ↳ Rule Failure: ${f}`);
        }
      }
    }

    const passCount = runs.filter((r) => r.passed).length;
    const avgLatencyMs = Math.round(runs.reduce((acc, r) => acc + r.latencyMs, 0) / runs.length);

    const cacheHitRuns = runs.filter((r) => r.cacheHit);
    const cacheMissRuns = runs.filter((r) => !r.cacheHit);

    const cacheHitAvg =
      cacheHitRuns.length > 0
        ? Math.round(cacheHitRuns.reduce((acc, r) => acc + r.latencyMs, 0) / cacheHitRuns.length)
        : null;
    const cacheMissAvg =
      cacheMissRuns.length > 0
        ? Math.round(cacheMissRuns.reduce((acc, r) => acc + r.latencyMs, 0) / cacheMissRuns.length)
        : null;

    summaries.push({
      id: tc.id,
      category: tc.category,
      question: tc.question,
      runs,
      passCount,
      totalRuns: runs.length,
      passRate: `${Math.round((passCount / runs.length) * 100)}%`,
      avgLatencyMs,
      cacheHitAvgLatencyMs: cacheHitAvg,
      cacheMissAvgLatencyMs: cacheMissAvg,
    });
    console.log("");
  }

  // Aggregate Category Summaries
  const categoriesMap = new Map<string, { passCount: number; totalRuns: number; totalLatencyMs: number }>();
  for (const s of summaries) {
    const existing = categoriesMap.get(s.category) ?? { passCount: 0, totalRuns: 0, totalLatencyMs: 0 };
    existing.passCount += s.passCount;
    existing.totalRuns += s.totalRuns;
    existing.totalLatencyMs += s.avgLatencyMs * s.totalRuns;
    categoriesMap.set(s.category, existing);
  }

  const categorySummaries: CategorySummary[] = [...categoriesMap.entries()].map(([cat, data]) => ({
    category: cat,
    passCount: data.passCount,
    totalRuns: data.totalRuns,
    passRate: `${Math.round((data.passCount / data.totalRuns) * 100)}%`,
    avgLatencyMs: Math.round(data.totalLatencyMs / data.totalRuns),
  }));

  // Latency by Cache Hit
  const allCacheHitRuns = allRuns.filter((r) => r.cacheHit);
  const allCacheMissRuns = allRuns.filter((r) => !r.cacheHit);

  const overallCacheHitAvgLatency =
    allCacheHitRuns.length > 0
      ? Math.round(allCacheHitRuns.reduce((acc, r) => acc + r.latencyMs, 0) / allCacheHitRuns.length)
      : 0;
  const overallCacheMissAvgLatency =
    allCacheMissRuns.length > 0
      ? Math.round(allCacheMissRuns.reduce((acc, r) => acc + r.latencyMs, 0) / allCacheMissRuns.length)
      : 0;

  const totalRunsCount = allRuns.length;
  const totalPassCount = allRuns.filter((r) => r.passed).length;
  const overallPassRate = `${Math.round((totalPassCount / totalRunsCount) * 100)}%`;
  const overallAvgLatency = Math.round(allRuns.reduce((acc, r) => acc + r.latencyMs, 0) / totalRunsCount);

  const report = {
    timestamp: new Date().toISOString(),
    overallPassRate,
    overallPassCount: totalPassCount,
    overallTotalRuns: totalRunsCount,
    overallAvgLatencyMs: overallAvgLatency,
    overallCacheHitAvgLatencyMs: overallCacheHitAvgLatency,
    overallCacheMissAvgLatencyMs: overallCacheMissAvgLatency,
    categorySummaries,
    cases: summaries,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log(`\n================== EVALUATION REPORT ==================`);
  console.log(`Overall Pass Rate: ${totalPassCount}/${totalRunsCount} (${overallPassRate})`);
  console.log(`Average Latency: ${(overallAvgLatency / 1000).toFixed(2)}s`);
  console.log(`Cache Hit Avg Latency: ${(overallCacheHitAvgLatency / 1000).toFixed(2)}s (${allCacheHitRuns.length} runs)`);
  console.log(`Cache Miss Avg Latency: ${(overallCacheMissAvgLatency / 1000).toFixed(2)}s (${allCacheMissRuns.length} runs)`);
  console.log(`Detailed report written to: ${REPORT_PATH}\n`);

  console.log(`--- By Category ---`);
  for (const c of categorySummaries) {
    console.log(`• ${c.category}: ${c.passCount}/${c.totalRuns} (${c.passRate}), avg ${(c.avgLatencyMs / 1000).toFixed(2)}s`);
  }

  console.log(`\n--- By Case ---`);
  console.log(`| ID | Category | Pass Rate | Avg Latency | Cache Hit / Miss Avg | Notes |`);
  console.log(`|:---|:---|:---:|:---:|:---:|:---|`);
  for (const s of summaries) {
    const hitStr = s.cacheHitAvgLatencyMs ? `${(s.cacheHitAvgLatencyMs / 1000).toFixed(2)}s` : "-";
    const missStr = s.cacheMissAvgLatencyMs ? `${(s.cacheMissAvgLatencyMs / 1000).toFixed(2)}s` : "-";
    const statusNote = s.passCount === s.totalRuns ? "All passed" : `${s.totalRuns - s.passCount} runs failed`;
    console.log(
      `| ${s.id} | ${s.category} | ${s.passRate} | ${(s.avgLatencyMs / 1000).toFixed(2)}s | ${hitStr} / ${missStr} | ${statusNote} |`
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
