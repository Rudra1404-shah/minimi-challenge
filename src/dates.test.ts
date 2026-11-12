import assert from "node:assert";
import { resolveDateFromQuery, getKolkataDateParts } from "./dates.js";

// Reference: Thursday, 12 November 2026 23:15:00 IST (UTC 17:45)
const refDate = new Date("2026-11-12T17:45:00.000Z");

console.log("Running date resolution unit tests...");

// Test 1: getKolkataDateParts
const parts = getKolkataDateParts(refDate);
assert.strictEqual(parts.year, 2026);
assert.strictEqual(parts.month, 11);
assert.strictEqual(parts.day, 12);
assert.strictEqual(parts.weekday, 4); // Thursday
console.log("✓ getKolkataDateParts passed");

// Test 2: "yesterday"
const yesterday = resolveDateFromQuery("What did I ask yesterday?", refDate);
assert(yesterday !== null);
assert.strictEqual(yesterday.year, 2026);
assert.strictEqual(yesterday.month, 11);
assert.strictEqual(yesterday.day, 11);
console.log("✓ yesterday passed");

// Test 3: "today"
const today = resolveDateFromQuery("What was my first message today?", refDate);
assert(today !== null);
assert.strictEqual(today.day, 12);
console.log("✓ today passed");

// Test 4: "last Tuesday" (Thursday - 2 days = Tuesday 10 Nov)
const lastTuesday = resolveDateFromQuery("Show my questions from last Tuesday", refDate);
assert(lastTuesday !== null);
assert.strictEqual(lastTuesday.year, 2026);
assert.strictEqual(lastTuesday.month, 11);
assert.strictEqual(lastTuesday.day, 10);
console.log("✓ last Tuesday passed");

// Test 5: "3 November"
const nov3 = resolveDateFromQuery("what did I ask on 3 November?", refDate);
assert(nov3 !== null);
assert.strictEqual(nov3.year, 2026);
assert.strictEqual(nov3.month, 11);
assert.strictEqual(nov3.day, 3);
console.log("✓ 3 November passed");

// Test 6: "November 3rd"
const nov3b = resolveDateFromQuery("Did we talk on November 3rd?", refDate);
assert(nov3b !== null);
assert.strictEqual(nov3b.day, 3);
console.log("✓ November 3rd passed");

// Test 7: "4 days ago" (12 - 4 = 8 Nov)
const daysAgo = resolveDateFromQuery("Find what I searched 4 days ago", refDate);
assert(daysAgo !== null);
assert.strictEqual(daysAgo.day, 8);
console.log("✓ 4 days ago passed");

// Test 8: Non-date query returns null
const noDate = resolveDateFromQuery("What is 17 * 23?", refDate);
assert.strictEqual(noDate, null);
console.log("✓ non-date query returns null");

console.log("All date resolution tests passed successfully!");

