import { getMessagesByDateRange, getAllMessages, saveMessage, type StoredMessage } from "./db.js";
import { resolveDateFromQuery, type ResolvedDateRange } from "./dates.js";

export const MAX_HISTORY_TOKENS = 3500;

export interface HistoryResolutionResult {
  isDateQuery: boolean;
  dateRange: ResolvedDateRange | null;
  historyText: string | null;
}

/**
 * Rough token estimator (4 characters per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Trims a list of messages to fit within a token budget, keeping the most
 * recent messages.
 */
export function trimMessagesToBudget(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  budgetTokens: number = MAX_HISTORY_TOKENS
): Array<{ role: "user" | "assistant"; content: string }> {
  if (messages.length === 0) return [];

  let currentTokens = 0;
  const result: Array<{ role: "user" | "assistant"; content: string }> = [];

  // Iterate backwards from most recent message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const cost = estimateTokens(msg.content);
    if (currentTokens + cost > budgetTokens && result.length > 0) {
      break;
    }
    currentTokens += cost;
    result.unshift(msg);
  }

  return result;
}

/**
 * Formats past messages into human-readable IST dialogue for context injection.
 */
function formatPastMessages(messages: StoredMessage[]): string {
  return messages
    .map((m) => {
      const timeStr = new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }).format(new Date(m.timestamp));
      return `[${timeStr}] ${m.role === "user" ? "User" : "Assistant"}: ${m.content}`;
    })
    .join("\n\n");
}

/**
 * Checks if the user message mentions a relative or absolute date, queries SQLite,
 * and produces verified historical context.
 */
export function resolveHistoryForQuery(
  sessionId: string,
  userMessage: string,
  nowDate: Date = new Date()
): HistoryResolutionResult {
  const range = resolveDateFromQuery(userMessage, nowDate);
  if (!range) {
    return { isDateQuery: false, dateRange: null, historyText: null };
  }

  const pastMessages = getMessagesByDateRange(sessionId, range.startTs, range.endTs);

  if (pastMessages.length === 0) {
    return {
      isDateQuery: true,
      dateRange: range,
      historyText:
        `[Verified Chat History]: No past messages were found for ${range.label} in this chat history. ` +
        `Explicitly inform the user that you found no past record on that date. Never invent history.`,
    };
  }

  const formatted = formatPastMessages(pastMessages);
  return {
    isDateQuery: true,
    dateRange: range,
    historyText:
      `[Verified Chat History for ${range.label} (Asia/Kolkata)]:\n` +
      `${formatted}\n` +
      `[End of Verified History. Answer strictly based on the above history without inventing turns.]`,
  };
}

export { saveMessage, getAllMessages };

