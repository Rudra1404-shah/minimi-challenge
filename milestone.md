Review of origin/main (Milestone 2): fixes and next steps
Nov 12, 2026
Milestone 2 is mostly in place and type-checks; one date bug and several missing rules need fixing before Milestones 3 and 4 are merged.
What is working
• Page reading: the top 3 results are fetched in parallel with a 5-second timeout, read with Readability and jsdom, and capped at 4,000 characters.
• Each result is labeled READ or SNIPPET ONLY, with a reason. Sources carry a kind of official, secondary, or unknown.
• A notice is added when no official vendor page appears in the results.
• Partial replies that fail mid-stream keep their text and add "(reply cut off)".
• npm run typecheck passes on the pushed code.
Problems to fix, ranked by impact
1. Date bug. In src/search.ts (lines 507–509), the search provider's date is used whenever it exists. Only a date the page states should be used. In the Notion test, notion.com/pricing showed "published 2025-06-30" from the provider.
2. Vendor boost matches ordinary words. Keys in src/config.ts such as linear, render, cursor, neon, stripe, and airtable match any query containing those words. Restrict vendor-name matches to clear pricing or product queries, or match domains only.
3. Prompt is missing rules. No trigger rule for time-sensitive questions (the cause of Test 3 scoring 0/3), no rule against overclaiming ("verified", "current"), no billing-basis rule for prices, and no one-source-per-fact rule.
4. Used-source filter is loose. The match is a substring check, so notion.com/pricing also matches notion.com/pricing/us. The fallback also shows the top 2 READ results as "searched", which breaks the rule of no chips for unused results. Choose one behavior and make the acceptance test match it.
5. Eval case expects the wrong guest limit. evals/cases.json expects "100 guests". The official Notion page shows unlimited guests on Plus.
6. README lost content. The Milestone 1 setup section (about 21 lines) was deleted. Restore it.
7. No eval runner on main. evals/cases.json has one case, and the three-run harness from the report is not in the pushed code.
What to build next, in order
1. Start from origin/main. Keep the pushed page reader. Do not reuse the local search.ts. Add only the Milestone 4 search cache around webSearch.
2. Add the new files unchanged. src/db.ts, src/dates.ts, src/history.ts, and src/dates.test.ts do not conflict with anything upstream.
3. Merge by hand. Apply the Milestone 3 and 4 changes to agent.ts, prompt.ts, config.ts, app.js, server.ts, package.json, .gitignore, and README.md. Keep the upstream source filter in agent.ts.
4. Fix problems 1 to 7 above before running the merged code.
5. Run the live checks. Ask the Notion, Figma, and LLM questions, plus the three example questions. These need API keys and must be run by you.
6. Build the Milestone 5 eval runner on top of evals/cases.json, with three runs per case and a report file.
7. Write DESIGN.md last, using the measured results.