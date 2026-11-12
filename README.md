# Minimi Chat Agent

Fast, accurate browser chat agent with live web search (`web_search`), page reading, relative date resolution in code, SQLite conversation history, and search result caching.

## Hard Rules

- **Backend**: TypeScript on Node 20+. **Frontend**: Plain JavaScript (no framework).
- **Startup**: Runs with `npm install` followed by `npm run dev`.
- **Single Tool**: The model has exactly **ONE** tool: `web_search`. Date and history are handled in deterministic code, never by the model calling tools.
- **Environment**: All keys listed in `.env.example`. Starts safely with clear warnings if keys are missing.

## Prerequisites & Setup

1. **Clone repository and configure environment**:
   ```bash
   cp .env.example .env
   ```
   Set your keys in `.env`:
   - `OPENAI_API_KEY` (or Anthropic key if configured)
   - `TAVILY_API_KEY`
   - `PORT=3000`

2. **Install and run**:
   ```bash
   npm install
   npm run dev
   ```

3. **Open in browser**:
   Navigate to `http://localhost:3000`.

## Scripts

- `npm run dev` — Start the Fastify dev server with TypeScript hot reloading (`tsx watch src/server.ts`).
- `npm run build` — Compile TypeScript to `dist/`.
- `npm run typecheck` — Typecheck the project with `tsc --noEmit`.
- `npm run start` — Run the compiled production build from `dist/server.js`.
- `npm run test:dates` — Run unit tests for relative and absolute date resolution in `Asia/Kolkata`.
- `npm run eval` — Run the 3-run evaluation suite across benchmark test cases and output `evals/report.json`.

## Architecture & Features

```text
[ Browser UI ]  <--- (SSE Stream: token, status, done, error) ---  [ Fastify Server ]
      |                                                                   |
  app.js                                                          agent.ts (Loop)
      |                                                                   |
      +---> POST /api/chat { messages, sessionId }                       / \
                                                      Date Resolution --+   +-- webSearch()
                                                      (dates.ts/history.ts)      (search.ts)
                                                                                  |
                                                         SQLite Cache <-----------+
                                                         (db.ts, 1h/24h TTL)      |
                                                                             Tavily API
                                                                                  |
                                                                        Parallel Page Reader
                                                                        (Readability + jsdom)
```

1. **Live Web Search & Page Reading** (`src/search.ts`):
   - Vendor-domain search boost when a vendor or domain is queried.
   - Fetches the top 3 URLs in parallel with a 5-second timeout.
   - Extracts main page text via Readability and jsdom, capped at 4,000 characters.
   - Extracts stated publish/update dates directly from page metadata; uses `"unknown"` if unstated.
   - Tags every result as `[READ]` or `[SNIPPET ONLY]`, with source kind `official`, `secondary`, or `unknown`.
2. **Speed & Cost Optimization** (`src/db.ts`):
   - SQLite search cache: 1-hour TTL for pricing queries, 24-hour TTL for general queries.
   - Context budget trimming: limits historical turns to 3,500 tokens before model calls.
3. **History & Relative Dates in Code** (`src/dates.ts`, `src/history.ts`):
   - Resolves relative queries ("yesterday", "last Tuesday", "3 November") in `Asia/Kolkata` time.
   - Pulls matching past messages from SQLite and injects verified history into context. Never invents past turns.
4. **Strict Source Citation** (`src/agent.ts`, `public/app.js`):
   - Only URLs explicitly cited in the assistant's answer are emitted in `done.sources` and displayed as chips.
   - Mid-stream network/provider interruptions preserve partial text and append `(reply cut off)`.
