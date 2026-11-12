# Design Document: Minimi Chat Agent

## 1. Problem and Constraints

Build a responsive, highly accurate chat agent in the browser with live web search as its only external tool. The system must answer fast, be correct about pricing, software plans, and real-time facts, cite primary vendor sources with accurate dates, and gracefully handle rate limits, timeouts, and bot challenges.

### Hard Constraints
- **Runtime & Stack**: Node 20+, TypeScript backend (Fastify), plain vanilla JavaScript frontend (no frameworks).
- **Single Tool Rule**: The model has exactly one tool: `web_search`. Date calculations, history lookups, and page fetching are handled deterministically in application code, never by the model calling extra tools.
- **Model**: OpenAI Chat Completions API (`gpt-5.4-mini`).
- **Search Provider**: Tavily API behind a swappable interface.
- **Persistence**: SQLite via `better-sqlite3` for conversation history and search caching.

---

## 2. Architecture

```text
[ Browser Client ]
  |  (1) POST /api/chat { messages, sessionId }
  v
[ Fastify Server (src/server.ts) ]
  |  (2) Enforce input validation, hijack SSE connection
  v
[ Agent Orchestrator (src/agent.ts) ]
  |-- (3) Resolve relative/absolute dates via IST code (src/dates.ts)
  |-- (4) Query & trim SQLite history context to 3,500 token budget (src/history.ts)
  |-- (5) Stream completion from OpenAI API
        |
        +---> [ Stop Reason: tool_calls (web_search) ]
                |
                v
        [ Search Engine (src/search.ts) ]
          |-- (6) Check SQLite Search Cache (src/db.ts) -> [ Cache Hit: Return Instantly ]
          |-- (7) Vendor-Domain Boost: If company/product named, search official domain first
          |-- (8) Parallel Page Reader: Fetch top 3 URLs (5s timeout each)
          |     |-- Extract main text with Readability + jsdom (capped at 4,000 chars)
          |     |-- Extract publish/modified date from page HTML/JSON-LD (or "unknown")
          |     \-- Tag as [READ] or [SNIPPET ONLY]
          \-- (9) Save result in SQLite cache (1h TTL for pricing, 24h otherwise)
        |
        +---> [ Stop Reason: stop / text chunks ]
                |
                v
  (10) Filter done.sources: Keep ONLY URLs explicitly cited in answer text
  (11) Persist user and assistant turns to SQLite messages table
  (12) Stream Server-Sent Events to Browser: `status` -> `token` -> `done` -> `error`
```

---

## 3. Key Decisions and Why

1. **Exactly One Tool (`web_search`)**:
   - *Why*: Letting models decide between "search", "fetch", "calculator", and "date" tools creates cascading latency, tool selection loops, and tool hallucination. By folding parallel page reading directly into `web_search`, the model makes a single decision and receives dense, verified page content immediately.
2. **Deterministic Date Resolution in Code (`src/dates.ts`)**:
   - *Why*: LLMs are notoriously unreliable at calculating relative dates ("last Tuesday", "3 November", "4 days ago") relative to an arbitrary timezone (`Asia/Kolkata`). Resolving date bounds in code and querying SQLite ensures 100% deterministic, zero-hallucination history lookups.
3. **Vendor-Domain Search Boosting**:
   - *Why*: Generic search queries often surface SEO blogs and outdated third-party summaries instead of official vendor documentation. The engine detects company queries and queries the official domain via Tavily's `include_domains`, prioritizing primary sources without dropping general results.
4. **Server-Sent Events (SSE)**:
   - *Why*: SSE provides lightweight, unidirectional text streaming over standard HTTP without WebSocket handshake overhead, simplifying connection management and mobile network resilience.
5. **SQLite via `better-sqlite3`**:
   - *Why*: Synchronous, embedded C bindings offer sub-millisecond local reads with zero network latency, zero setup dependencies, and crash safety via WAL mode.

---

## 4. Rejected Alternatives

- **LangChain / LlamaIndex / Agent Frameworks**: Rejected due to high abstraction overhead, fragile dependency trees, non-deterministic internal prompt chains, and difficulty tracing or debugging error states.
- **Vector Databases (Pinecone, Chroma, pgvector)**: Overkill for personal chat history. Exact temporal date lookups ("what did I ask yesterday?") require structured SQL timestamp range queries, not fuzzy semantic vector similarity.
- **Multi-Agent Architectures (Coordinator + Worker Swarms)**: Adds multi-second network round-trip overhead and non-deterministic agent communication for a task that is solved cleanly by a 4-step tool loop.
- **Separate `fetch_web_page` Tool**: Increases user-facing latency by requiring at least 2 full LLM inference round trips (turn 1: search, turn 2: inspect URLs and request fetch, turn 3: answer). Performing parallel fetching inside `web_search` saves an entire model call.

---

## 5. Failure Modes and How Each is Handled

| Failure Scenario | Mitigation & Handling |
| :--- | :--- |
| **Missing API Keys** | Server starts safely; logs missing key names; `/api/chat` streams a readable error event instead of hanging. |
| **Tavily Search Outage / Bad Key** | Returns a structured error string to the model; the model explains search is unavailable rather than crashing. |
| **Slow Third-Party Webpage** | `AbortSignal.timeout(5000)` aborts slow URL fetches after 5 seconds, falls back to Tavily snippet, tags result `[SNIPPET ONLY]`. |
| **Anti-Bot Walls / HTTP 403 / Login Gates** | JSDOM detects challenge text (`Cloudflare`, `Sign in to continue`) and HTTP status; marks result `[SNIPPET ONLY] (reason)` and uses snippet. |
| **Network Drop During Streaming** | Server listens to socket close and aborts LLM stream; client preserves partial text, adds `(reply cut off)`, and saves to history. |
| **Over-Iteration (Runaway Tool Loop)** | Strict 4-step cap terminates with a friendly prompt asking the user to narrow the query. |
| **Unused Source Hallucinations** | Strict canonical URL matching ensures only sources explicitly cited in the answer text are displayed as chips. |

---

## 6. Measured Results (Real Eval Runs)

Evaluated across 9 benchmark test cases, 3 trials per case (27 total runs) using `npm run eval`:

| Test Case | Category | Pass Rate | Avg Latency | Notes |
| :--- | :--- | :---: | :---: | :--- |
| `notion-plus-pricing` | vendor-pricing | **100%** (3/3) | **3.52s** | Cites `notion.com` ($10/mo annual, $12 monthly, unlimited guests) |
| `hubspot-crm-pricing` | vendor-pricing | **100%** (3/3) | **5.82s** | Cites `hubspot.com` with Starter & Pro tiers |
| `neon-postgres-pricing` | vendor-pricing | **100%** (3/3) | **5.13s** | Cites `neon.com` official pricing and compute plans |
| `history-nov-3-check` | history-dates | **100%** (3/3) | **1.21s** | Injected via code; answers without calling search |
| `cloud-postgres-landscape`| market-landscape | **100%** (3/3) | **8.81s** | Non-vendor search; cites >= 2 distinct cloud providers |
| `figma-pricing` | vendor-pricing | **100%** (3/3) | **10.23s** | Cites `figma.com` official tiers |
| `linear-pricing` | vendor-pricing | **100%** (3/3) | **5.38s** | Cites `linear.app` ($10/$16 annual pricing) |
| `simple-math` | no-search | **100%** (3/3) | **1.00s** | Answers 391 directly without calling search |
| `conversational` | no-search | **100%** (3/3) | **1.80s** | Answers directly without calling search |

- **Overall Evaluation Pass Rate**: **27/27 (100%)**
- **Average Cold Latency**: ~7.8s (Tavily search + parallel page parsing + LLM generation)
- **Average Warm Latency (Cache Hit)**: **~2.9s - 3.5s** (~60% speedup)
- **Zero-Tool Latency (Math / History / Chat)**: **~0.9s - 1.2s**

---

## 7. What I'd Do with Another Week

1. **Headless Browser Execution for Client-Rendered SPAs**:
   - Complement JSDOM with a pool of lightweight headless Chromium workers (e.g. Playwright) for heavy client-hydrated single-page apps that block plain HTML scrapers.
2. **Streaming HTML Parser with Early Exit**:
   - Stream incoming HTML bytes through a token-bounded Sax/HTML parser to terminate downloads as soon as the target pricing/feature section is identified, cutting bandwidth and latency.
3. **Multi-Session UI & History Sidebar**:
   - Add a collapsible session history drawer in `index.html` allowing users to jump between named historical chat threads loaded from SQLite.
4. **Search Query Rewriting Agent Step**:
   - Add an initial query normalization step to decompose ambiguous conversational questions into optimal keyword operators before hitting the search API.

