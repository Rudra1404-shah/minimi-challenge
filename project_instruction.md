# Project: Chat agent with web search (hiring challenge)

Build a chat agent I can talk to in the browser. Its only tool is web search. It should answer fast, be correct about things that change over time, and be pleasant to talk to.

## Hard rules (must follow)
- Backend: TypeScript on Node 20+. Frontend: plain JavaScript (no framework required).
- Must run with `npm install` then `npm run dev`. Nothing else should be needed to start it.
- List every API key the app needs in `.env.example` with empty values. Never commit `.env`.
- The model has exactly ONE tool: `web_search`. Do not add a fetch tool, memory tool, or date tool. Date and history are handled in code, not by the model calling tools.
- Every piece of code must be something I can explain. Keep it simple and commented where the reasoning isn't obvious.

## Stack
- Node 20+, TypeScript, Fastify (or Express) for the server.
- `@anthropic-ai/sdk` for the model. Model: `claude-haiku-5-5`. Put the model name in one constant so it's easy to change.
- Search provider: Tavily (`https://api.tavily.com/search`), using `TAVILY_API_KEY`. Keep the provider behind one function so it can be swapped.
- SQLite via `better-sqlite3` for chat history (added in milestone 4, not milestone 1).
- Frontend: `public/index.html`, `public/app.js`, `public/style.css`, served by the Node server.
- Dev tooling: `tsx` for running TypeScript in dev, `typescript` for type checking.

## Environment
`.env.example`:
```
ANTHROPIC_API_KEY=
TAVILY_API_KEY=
PORT=3000
```
Load env vars with `node --env-file=.env` or `dotenv`. The app must still start if `.env` is missing, and must print a clear error naming any missing key.

## Repo layout
```
src/
  server.ts        # Fastify app, routes, SSE streaming
  agent.ts         # the tool-use loop
  search.ts        # web_search implementation (Tavily)
  prompt.ts        # system prompt builder (includes today's date in Asia/Kolkata)
  config.ts        # model name, max steps, env loading
public/
  index.html
  app.js
  style.css
.env.example
package.json
tsconfig.json
DESIGN.md
README.md
```
`package.json` scripts: `dev` starts the server with watch mode, `build` compiles TypeScript, `typecheck` runs `tsc --noEmit`.

## Milestone 1 (build this now, nothing more)
Goal: a working chat in the browser with streaming, where the model can call `web_search` and answer with sources.

### Requirements
1. `POST /api/chat` takes `{ messages: [{role, content}] }` and streams the reply using Server-Sent Events. Events: `token` (text chunk), `status` (e.g. "Searching: <query>"), `done` (final message with sources), `error`.
2. The agent loop:
   - Call the model with the system prompt, the tool definition, and the conversation.
   - If `stop_reason` is `tool_use`, run each `web_search` call, append results as `tool_result` blocks, and loop.
   - Cap the loop at 4 steps. If the cap is reached, return a clear message saying the question needs to be narrower.
   - Stream text tokens to the client as they arrive.
3. `web_search(query)`:
   - Call Tavily with `max_results: 5`.
   - Return a plain-text list: title, URL, published date (or "unknown"), and content snippet, one result per block.
   - On failure, return an error string to the model (do not crash the request). The model should then say it couldn't search.
   - Timeout: 10 seconds.
4. System prompt (built in `prompt.ts`):
   - Includes the current date and time in Asia/Kolkata, computed on every request.
   - Use web search for anything that may have changed (prices, releases, news, people's roles). Don't search for stable facts or simple math.
   - Cite sources with URL and date when using search results.
   - If something can't be verified, say so rather than guessing.
   - Keep answers concise unless asked for detail.
5. Frontend (`public/`):
   - Chat window with a message list and an input box. Enter sends; Shift+Enter adds a newline.
   - Renders tokens as they stream in.
   - Shows status lines (e.g. "Searching: ...") in a muted style, removed when the answer starts.
   - Keeps the conversation in memory on the page (no persistence yet).
   - Disables the send button while a reply is streaming.
   - Shows errors inline in the chat.
   - Simple, clean styling. Mobile-friendly.
6. Error handling: missing API key, network failure, and malformed model output must all produce a readable error in the UI, not a hung request.

### Acceptance tests (must pass before milestone 1 is done)
1. "What's the current price of Notion's Plus plan?" → the agent searches, answers with a price, and cites a URL and date.
2. "What's 17 × 23?" → answers directly, no search.
3. "Tell me about yourself." → answers directly, no search.
4. Disconnect the network or use a bad Tavily key → the UI shows a readable error and the app keeps running.
5. `npm install && npm run dev` works on a clean clone.

## Later milestones (do NOT build yet, but structure code so they're easy to add)
- **M2: Page reading.** Inside `search.ts`, fetch the top 2–3 result URLs in parallel and extract main text (Readability + jsdom, or similar). Cap each page at ~4,000 characters. Timeout per page.
- **M3: History and dates.** SQLite store of every message with a timestamp. Before each model call, resolve relative dates in the user message ("last Tuesday", "3 November") in code, and inject matching past turns into the context. Never invent history: if nothing matches, say so.
- **M4: Speed and cost.** Cache search results with a TTL (1 hour for pricing-type queries, 24 hours otherwise). Prompt caching for the system prompt. Trim old history beyond a token budget.
- **M5: Evals.** `npm run eval` runs ~25 questions from `evals/questions.json` (include the three examples: a CRM pricing check, "what did I ask on 3 November", and a Postgres hosting pricing check). Log latency, sources used, and pass/fail per question to a report file.
- **M6: DESIGN.md.** See below.

## DESIGN.md (one page, write it at the end)
Sections:
1. Problem and constraints
2. Architecture (a text diagram of request flow: browser → server → agent loop → search → model → SSE stream)
3. Key decisions and why (one tool; search returns extracted content; date resolution in code; SSE streaming; SQLite for history)
4. Rejected alternatives (LangChain/agent frameworks, vector DB, multi-agent, separate fetch tool) with reasons
5. Failure modes and how each is handled
6. Measured results (latency, eval pass rate) — fill in from real runs, don't invent numbers
7. What I'd do with another week

## Process rules for you (Claude Code)
- Build milestone 1 only. Commit to git after it passes its acceptance tests, with a clear message.
- Show me the final file tree and the commands to run it when done.
- If something in these instructions conflicts with the rules above, the hard rules win. Tell me about the conflict.
- Don't add features outside the milestones without asking.