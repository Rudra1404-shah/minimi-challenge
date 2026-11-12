import assert from "node:assert";
import {
  evaluateAnswer,
  canonicalizeUrl,
  getCitedSources,
  getRegistrableDomain,
  type TestCase,
} from "./evaluator.js";
import type { SearchSource } from "../src/search.js";

console.log("Running unit tests for eval runner rules...\n");

// Test 1: An answer missing an expected fact fails
{
  const testCase: TestCase = {
    id: "test-missing-fact",
    category: "test",
    question: "test question",
    expectedFacts: ["unlimited guests"],
  };
  const answer = "Notion Plus includes 100 guests per workspace.";
  const failures = evaluateAnswer(testCase, answer, true, []);
  assert(failures.length > 0, "Expected failure for missing fact");
  assert(
    failures.some((f) => f.includes('Missing expected fact: "unlimited guests"')),
    "Expected failure message to name the missing fact"
  );
  console.log("✓ Test 1: An answer missing an expected fact fails");
}

// Test 2: An answer with a price and no billing basis fails when requireBillingBasis is set
{
  const testCase: TestCase = {
    id: "test-billing-basis",
    category: "test",
    question: "test question",
    requireBillingBasis: true,
  };
  const answerWithoutBasis = "The price of the plan is $10 for all users.";
  const failures1 = evaluateAnswer(testCase, answerWithoutBasis, true, []);
  assert(failures1.length > 0, "Expected failure when billing basis is missing");
  assert(
    failures1.some((f) => f.includes("missing required billing basis")),
    "Expected message stating billing basis is missing"
  );

  const answerWithBasis = "The price of the plan is $10 per member/month billed annually.";
  const failures2 = evaluateAnswer(testCase, answerWithBasis, true, []);
  assert.strictEqual(failures2.length, 0, "Expected pass when billing basis is present");
  console.log("✓ Test 2: Price without billing basis fails; with billing basis passes");
}

// Test 3: An answer that cites only a SNIPPET ONLY official page fails when expectReadOfficial is set
{
  const testCase: TestCase = {
    id: "test-read-official",
    category: "test",
    question: "test question",
    expectReadOfficial: true,
  };
  const answer = "According to https://notion.com/pricing, the plan costs $10.";
  const snippetOnlySources: SearchSource[] = [
    {
      title: "Notion Pricing",
      url: "https://notion.com/pricing",
      date: "unknown",
      kind: "official",
      readStatus: "SNIPPET ONLY",
    },
  ];
  const cited = getCitedSources(snippetOnlySources, answer);
  const failures = evaluateAnswer(testCase, answer, true, cited);
  assert(failures.length > 0, "Expected failure when official source is only SNIPPET ONLY");
  assert(
    failures.some((f) => f.includes("Expected at least one official source with readStatus 'READ'")),
    "Expected failure message regarding readStatus READ"
  );
  console.log("✓ Test 3: Citing only SNIPPET ONLY official page fails expectReadOfficial");
}

// Test 4: Two URLs that differ only by a query string count as one domain and one source
{
  const url1 = "https://www.notion.com/pricing?ref=banner";
  const url2 = "https://notion.com/pricing/?utm_source=twitter#faq";

  const can1 = canonicalizeUrl(url1);
  const can2 = canonicalizeUrl(url2);
  assert.strictEqual(can1, "https://notion.com/pricing");
  assert.strictEqual(can2, "https://notion.com/pricing");
  assert.strictEqual(can1, can2, "Canonical URLs should be identical");

  const dom1 = getRegistrableDomain(url1);
  const dom2 = getRegistrableDomain(url2);
  assert.strictEqual(dom1, "notion.com");
  assert.strictEqual(dom2, "notion.com");

  const sources: SearchSource[] = [
    {
      title: "Page 1",
      url: url1,
      date: "unknown",
      kind: "official",
      readStatus: "READ",
    },
    {
      title: "Page 2",
      url: url2,
      date: "unknown",
      kind: "official",
      readStatus: "READ",
    },
  ];

  const answer = `Checked both [Link 1](${url1}) and [Link 2](${url2}).`;
  const cited = getCitedSources(sources, answer);
  assert.strictEqual(cited.length, 1, "Two URLs differing only by query string must count as 1 source");

  const distinctDomains = new Set(cited.map((s) => getRegistrableDomain(s.url)));
  assert.strictEqual(distinctDomains.size, 1, "Must count as 1 distinct domain");
  console.log("✓ Test 4: URLs differing only by query string count as one source and one domain");
}

// Test 5: A phrase in forbiddenPhrases fails when no official READ source is cited
{
  const testCase: TestCase = {
    id: "test-forbidden-phrase",
    category: "test",
    question: "test question",
    forbiddenPhrases: ["verified", "guaranteed current"],
  };

  const answerWithForbidden = "This is verified pricing information according to https://blog.example.com/post.";
  const secondarySource: SearchSource[] = [
    {
      title: "Example Blog",
      url: "https://blog.example.com/post",
      date: "unknown",
      kind: "secondary",
      readStatus: "READ",
    },
  ];
  const citedSecondary = getCitedSources(secondarySource, answerWithForbidden);
  const failuresWithoutOfficial = evaluateAnswer(testCase, answerWithForbidden, true, citedSecondary);
  assert(
    failuresWithoutOfficial.some((f) => f.includes('Answer contains forbidden phrase "verified"')),
    "Expected failure when forbidden phrase is used with secondary source"
  );

  const officialSource: SearchSource[] = [
    {
      title: "Official Page",
      url: "https://official.example.com/pricing",
      date: "unknown",
      kind: "official",
      readStatus: "READ",
    },
  ];
  const answerWithOfficial = "This is verified pricing information according to https://official.example.com/pricing.";
  const citedOfficial = getCitedSources(officialSource, answerWithOfficial);
  const failuresWithOfficial = evaluateAnswer(testCase, answerWithOfficial, true, citedOfficial);
  assert.strictEqual(
    failuresWithOfficial.length,
    0,
    "Forbidden phrase rule should pass when an official READ source is cited"
  );
  console.log("✓ Test 5: Forbidden phrase fails when no official READ source is cited; passes when official READ cited");
}

console.log("\nAll 5 eval runner unit tests passed successfully!");

