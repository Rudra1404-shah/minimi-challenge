# minimi-challenge

Browser chat agent with live web search (`web_search`) powered by OpenAI and Tavily.

## Setup & Run (Milestone 1)

1. Copy `.env.example` to `.env` and fill in your API keys:
   - `OPENAI_API_KEY`
   - `TAVILY_API_KEY`
   - `PORT` (defaults to `3000`)

2. Install dependencies and start the dev server:
   ```bash
   npm install
   npm run dev
   ```

3. Open `http://localhost:3000` in your browser.

## Scripts

- `npm run dev` — Start the Fastify server with TypeScript watch mode (`tsx watch`).
- `npm run typecheck` — Run `tsc --noEmit`.
- `npm run build` — Compile TypeScript to `dist/`.

Browser chat agent with live web search (`web_search`) powered by OpenAI and Tavily.

## Setup & Run (Milestone 1)

1. Copy `.env.example` to `.env` and fill in your API keys:
   - `OPENAI_API_KEY`
   - `TAVILY_API_KEY`
   - `PORT` (defaults to `3000`)

2. Install dependencies and start the dev server:
   ```bash
   npm install
   npm run dev
   ```

3. Open `http://localhost:3000` in your browser.

## Scripts

- `npm run dev` — Start the Fastify server with TypeScript watch mode (`tsx watch`).
- `npm run typecheck` — Run `tsc --noEmit`.
- `npm run build` — Compile TypeScript to `dist/`.
