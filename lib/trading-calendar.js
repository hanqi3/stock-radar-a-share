/**
 * Trading-day calendar.
 *
 * Weekends are not enough: the A-share market also closes for a week around
 * 春节 and 国庆, and the 明日参考 board prints a concrete date ("下一交易日").
 * Getting that wrong means it quotes a public holiday.
 *
 * Two layers:
 *   1. `lib/trading-days.json` — the actual sessions, regenerated from
 *      `data/flow.json` by `scripts/build-trading-calendar.js`. Exact.
 *   2. `lib/market-holidays.js` — curated weekday closures beyond that window.
 *      Checked against layer 1 whenever they overlap.
 */
import fs from "node:fs";

import { FORWARD_CLOSURES, VERIFIED_THROUGH } from "./market-holidays.js";

const HANDBOOK = JSON.parse(fs.readFileSync(new URL("./trading-days.json", import.meta.url), "utf8"));

// Observed closures tell us about the past; the curated list covers the dates
// the snapshot cannot reach yet. A closure wins over a weekday guess either way.
const CLOSURES = [...new Set([...HANDBOOK.closures, ...FORWARD_CLOSURES])].sort();

// Re-export inside a plain default so tests can build a synthetic calendar too.
export const DEFAULT_CALENDAR = {
  days: HANDBOOK.days,
  closures: CLOSURES,
  exactThrough: VERIFIED_THROUGH
};

export function createCalendar({ days = [], closures = [], exactThrough = null } = {}) {
  const sessionSet = new Set(days);
  const closureSet = new Set(closures);
  const sorted = [...sessionSet].sort();
  const first = sorted[0] ?? null;
  const last = sorted[sorted.length - 1] ?? null;

  const inRange = (iso) => Boolean(first && last && iso >= first && iso <= last);

  // Just past the observed window we may still know the answer: the notice for
  // the current year is published, and the curated closures fill the gaps.
  const inKnownFuture = (iso) => Boolean(last && exactThrough && iso > last && iso <= exactThrough);

  function isWeekday(iso) {
    const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
    return day !== 0 && day !== 6;
  }

  /** @returns {{trading: boolean, exact: boolean}} */
  function inspect(iso) {
    if (!iso) return { trading: false, exact: false };
    if (closureSet.has(iso)) return { trading: false, exact: true };
    if (sessionSet.has(iso)) return { trading: true, exact: true };
    if (inRange(iso)) return { trading: false, exact: true };
    if (inKnownFuture(iso)) return { trading: isWeekday(iso), exact: true };
    return { trading: isWeekday(iso), exact: false };
  }

  function isTradingDay(iso) {
    return inspect(iso).trading;
  }

  function shift(iso, step) {
    const cursor = new Date(`${iso}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() + step);
    return cursor.toISOString().slice(0, 10);
  }

  /** Next session after `iso`. `exact` is false when it is only a weekday guess. */
  function next(iso) {
    if (!iso) return { date: null, exact: false };
    let cursor = iso;
    for (let i = 0; i < 20; i += 1) {
      cursor = shift(cursor, 1);
      const state = inspect(cursor);
      // A known closure (or a weekend) is skipped; the first open day wins.
      if (state.trading) return { date: cursor, exact: state.exact };
    }
    return { date: null, exact: false };
  }

  /** Last session on or before `iso`. */
  function previous(iso) {
    if (!iso) return { date: null, exact: false };
    let cursor = iso;
    for (let i = 0; i < 40; i += 1) {
      cursor = shift(cursor, -1);
      const state = inspect(cursor);
      if (state.trading) return { date: cursor, exact: state.exact };
    }
    return { date: null, exact: false };
  }

  function lastOnOrBefore(iso) {
    if (!iso) return null;
    if (sessionSet.has(iso)) return iso;
    return previous(iso).date;
  }

  return { first, last, size: sessionSet.size, closureCount: closureSet.size, inspect, isTradingDay, next, previous, lastOnOrBefore };
}

const DEFAULT = createCalendar(DEFAULT_CALENDAR);

export const calendarRange = () => ({ first: DEFAULT.first, last: DEFAULT.last, size: DEFAULT.size });

/** How far past the snapshot the calendar still speaks with certainty. */
export const calendarHorizon = () => VERIFIED_THROUGH;

/** Compatibility helper: a plain date string, or null. */
export function nextTradingDay(date, calendar = DEFAULT) {
  const iso = toIso(date);
  return calendar.next(iso).date;
}

/** Same as `nextTradingDay`, but says whether the answer is calendar-exact. */
export function nextTradingDayDetail(date, calendar = DEFAULT) {
  const iso = toIso(date);
  return calendar.next(iso);
}

export function previousTradingDay(date, calendar = DEFAULT) {
  return calendar.previous(toIso(date)).date;
}

export function isTradingDay(date, calendar = DEFAULT) {
  return calendar.isTradingDay(toIso(date));
}

export function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const text = String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}
