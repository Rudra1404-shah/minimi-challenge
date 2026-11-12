/**
 * Relative and absolute date resolution in Asia/Kolkata (IST).
 * Used to detect when a user asks about past conversations or specific days
 * (e.g. "last Tuesday", "3 November", "yesterday") without relying on LLM date tools.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

export interface ResolvedDateRange {
  label: string;
  startTs: number; // UTC ms representing 00:00:00.000 in IST
  endTs: number;   // UTC ms representing 23:59:59.999 in IST
  year: number;
  month: number;   // 1-12
  day: number;     // 1-31
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * Returns the current date in Asia/Kolkata components.
 */
export function getKolkataDateParts(date: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: istDate.getUTCFullYear(),
    month: istDate.getUTCMonth() + 1,
    day: istDate.getUTCDate(),
    weekday: istDate.getUTCDay(),
  };
}

/**
 * Converts a specific year/month/day in IST to UTC start and end timestamps.
 */
export function makeIstDayRange(year: number, month: number, day: number, label: string): ResolvedDateRange {
  const pad = (n: number) => String(n).padStart(2, "0");
  const isoDate = `${year}-${pad(month)}-${pad(day)}`;
  const startTs = Date.parse(`${isoDate}T00:00:00.000+05:30`);
  const endTs = Date.parse(`${isoDate}T23:59:59.999+05:30`);

  return { label, startTs, endTs, year, month, day };
}

/**
 * Parses user queries to find relative or absolute date references.
 */
export function resolveDateFromQuery(query: string, referenceDate: Date = new Date()): ResolvedDateRange | null {
  const q = query.trim().toLowerCase();
  const now = getKolkataDateParts(referenceDate);

  // 1. "yesterday"
  if (/\byesterday\b/.test(q)) {
    const d = new Date(Date.UTC(now.year, now.month - 1, now.day - 1));
    return makeIstDayRange(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), "yesterday");
  }

  // 2. "today"
  if (/\btoday\b/.test(q)) {
    return makeIstDayRange(now.year, now.month, now.day, "today");
  }

  // 3. "<N> days ago"
  const daysAgoMatch = q.match(/\b(\d+)\s+days?\s+ago\b/);
  if (daysAgoMatch) {
    const n = Number.parseInt(daysAgoMatch[1], 10);
    const d = new Date(Date.UTC(now.year, now.month - 1, now.day - n));
    return makeIstDayRange(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), `${n} days ago`);
  }

  // 4. "last <weekday>" or "this past <weekday>"
  const lastWeekdayMatch = q.match(/\b(?:last|this\s+past)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/);
  if (lastWeekdayMatch) {
    const targetWeekday = WEEKDAY_NAMES[lastWeekdayMatch[1]];
    let diff = (now.weekday - targetWeekday + 7) % 7;
    if (diff === 0) diff = 7; // "last Tuesday" on a Tuesday means 7 days ago
    const d = new Date(Date.UTC(now.year, now.month - 1, now.day - diff));
    return makeIstDayRange(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), `last ${lastWeekdayMatch[1]}`);
  }

  // 5. "3 November", "3rd of November", "3rd November"
  const dayMonthMatch = q.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+(\d{4}))?\b/
  );
  if (dayMonthMatch) {
    const day = Number.parseInt(dayMonthMatch[1], 10);
    const month = MONTH_NAMES[dayMonthMatch[2]];
    const year = dayMonthMatch[3] ? Number.parseInt(dayMonthMatch[3], 10) : now.year;
    return makeIstDayRange(year, month, day, `${day} ${dayMonthMatch[2]}`);
  }

  // 6. "November 3", "November 3rd"
  const monthDayMatch = q.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/
  );
  if (monthDayMatch) {
    const month = MONTH_NAMES[monthDayMatch[1]];
    const day = Number.parseInt(monthDayMatch[2], 10);
    const year = monthDayMatch[3] ? Number.parseInt(monthDayMatch[3], 10) : now.year;
    return makeIstDayRange(year, month, day, `${monthDayMatch[1]} ${day}`);
  }

  return null;
}

