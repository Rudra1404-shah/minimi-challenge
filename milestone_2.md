Milestone 2: page reading and source fidelity
Nov 12, 2026 · @Dev Patel
Milestone 2 should make answers rest on the pages they cite, starting with the official vendor page.
Goal
The agent should answer from pages it has actually read, and cite the official source first when a question names a vendor.
The Notion test showed three gaps:
1. The answer cited two third-party blogs. The official pricing page was in the results but was never read.
2. The answer did not say whether its figures came from snippets or full pages.
3. Five source chips were shown, but the answer used only two.
The figures in that answer matched the official page. The problem is provenance, not accuracy.
Changes by file
src/search.ts
• Vendor-domain boost. When the query names a company, add the company's domain to the Tavily request using include_domains, and keep the general search as a second pass. Store the domain list in config.ts, not in the code.
• Read the top pages. Fetch the top 3 URLs in parallel, with a 5-second timeout each. Extract the main text with Readability and jsdom. Cap each page at 4,000 characters.
• Use the page date. Use the publish or last-updated date from the page when Tavily gives none. If neither exists, show "unknown".
• Tag every result. Each result is labeled READ (full page text) or SNIPPET ONLY (fetch failed or timed out). Keep the function signature.
• Return the source type. Add a kind field to each source: official, secondary, or unknown.
src/agent.ts
• Send only used sources. Build the done event's sources from URLs that appear in the final answer text. If nothing matches, send the top 2 READ sources, labeled as searched.
• Keep history clean on error. If an error arrives after tokens have streamed, keep the partial text, add "(reply cut off)", and keep it in history.
src/prompt.ts
• Add a rule: for a question about a company's price or product, the official page is the primary source. Say if it was not read.
• Add a rule: state which claims come from READ pages and which come from snippets only.
• Add a rule: cite each figure with the URL it came from.
public/app.js
• Render the source chips from done.sources only.
evals/cases.json (new)
• Add the Notion case as the first entry. The runner comes in Milestone 5.
Acceptance tests
All five must pass before Milestone 2 is done.
#
Question
Pass rule
1
Current price and guest limit of Notion's Plus plan
Cites notion.com, marks the page READ, and states the annual and monthly price.
2
Pricing for a vendor whose official page is blocked
Says the official page was not read, and labels the figure SNIPPET ONLY.
3
A question with no vendor named
Does not apply the vendor-domain boost. Cites at least two distinct domains.
4
A page that takes longer than 5 seconds
Falls back to the snippet, and the answer still arrives within 15 seconds.
5
Sources shown in the UI
Every chip appears in the answer text. No chip is shown for an unused result.
Run each test three times. Record the pass rate, not a single run.
Edge cases
• Page blocks bots or returns a login wall. Mark it SNIPPET ONLY and say so in the answer.
• Official domain is missing from results. Keep the general results, and tell the user the official page was not found.
• Two official pages conflict. Report both, with their URLs and dates.
• Page has no date. Show "unknown". Do not infer a date from the text.
• Redirects to another domain. Use the final URL for the citation, and check that its domain is still the official one.
• Very long pages. Truncate at 4,000 characters, and keep the pricing section if it is found first.
• Search or page fetch fails completely. Keep the existing error message from Milestone 1.
Out of scope
• Persistent history and date resolution (Milestone 3).
• Caching of search results (Milestone 4).
• The eval runner (Milestone 5). Only the case file is added here.
• Changes to the web UI beyond the source chips.
• Non-English pages and PDFs.