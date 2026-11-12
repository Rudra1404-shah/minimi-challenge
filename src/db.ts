import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { WebSearchOutput } from "./search.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "minimi.db");

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("synchronous = NORMAL");

    initSchema(dbInstance);
  }
  return dbInstance;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_ts
      ON messages (session_id, timestamp);

    CREATE TABLE IF NOT EXISTS search_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT UNIQUE NOT NULL,
      is_pricing INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_search_cache_query
      ON search_cache (query);
  `);
}

export interface StoredMessage {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  created_at: string;
}

export function saveMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  timestamp: number = Date.now()
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO messages (session_id, role, content, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(sessionId, role, content, timestamp, new Date(timestamp).toISOString());
}

export function getMessagesByDateRange(
  sessionId: string,
  startTs: number,
  endTs: number
): StoredMessage[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `);
  return stmt.all(sessionId, startTs, endTs) as StoredMessage[];
}

export function getAllMessages(sessionId: string): StoredMessage[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `);
  return stmt.all(sessionId) as StoredMessage[];
}

/**
 * Cache TTL: 1 hour for pricing queries, 24 hours otherwise.
 */
export const PRICING_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const GENERAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getCachedSearch(query: string): WebSearchOutput | null {
  const db = getDb();
  const normalizedQuery = query.trim().toLowerCase();
  const now = Date.now();

  const stmt = db.prepare(`
    SELECT result_json, expires_at FROM search_cache
    WHERE query = ?
  `);
  const row = stmt.get(normalizedQuery) as { result_json: string; expires_at: number } | undefined;

  if (!row) return null;

  if (row.expires_at <= now) {
    db.prepare("DELETE FROM search_cache WHERE query = ?").run(normalizedQuery);
    return null;
  }

  try {
    return JSON.parse(row.result_json) as WebSearchOutput;
  } catch {
    return null;
  }
}

export function setCachedSearch(
  query: string,
  output: WebSearchOutput,
  isPricing: boolean
): void {
  const db = getDb();
  const normalizedQuery = query.trim().toLowerCase();
  const now = Date.now();
  const ttl = isPricing ? PRICING_CACHE_TTL_MS : GENERAL_CACHE_TTL_MS;
  const expiresAt = now + ttl;

  const stmt = db.prepare(`
    INSERT INTO search_cache (query, is_pricing, result_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(query) DO UPDATE SET
      is_pricing = excluded.is_pricing,
      result_json = excluded.result_json,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `);
  stmt.run(normalizedQuery, isPricing ? 1 : 0, JSON.stringify(output), now, expiresAt);
}

