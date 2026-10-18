import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CALENDAR, calendarRange, createCalendar, isTradingDay, nextTradingDay, nextTradingDayDetail, previousTradingDay, toIso } from "../lib/trading-calendar.js";

// 2026 国庆: 09-30 (Wed) closed 10-01..10-07, reopens 10-08 (Thu).
test("the calendar knows about the 国庆 week", () => {
  assert.deepEqual(nextTradingDayDetail("2026-09-30"), { date: "2026-10-08", exact: true });
  assert.deepEqual(nextTradingDayDetail("2026-10-07"), { date: "2026-10-08", exact: true });
  // Through the break the answer is exact because the data covers it.
  assert.deepEqual(nextTradingDayDetail("2026-09-29"), { date: "2026-09-30", exact: true });
});

test("the calendar knows about the 春节 week", () => {
  assert.deepEqual(nextTradingDayDetail("2026-02-13"), { date: "2026-02-24", exact: true });
  assert.equal(DEFAULT_CALENDAR.closures.includes("2026-02-16"), true);
  assert.equal(DEFAULT_CALENDAR.closures.includes("2026-02-23"), true);
});

test("ordinary weeks still advance one day", () => {
  assert.equal(nextTradingDay("2026-10-15"), "2026-10-16");
  // Friday -> Monday. The snapshot ends on Friday, but the current year's
  // notice is published, so the answer is still exact rather than a guess.
  assert.deepEqual(nextTradingDayDetail("2026-10-16"), { date: "2026-10-19", exact: true });
});

test("curated forward closures cover a holiday the snapshot cannot see", () => {
  // 元旦 2027 lands on a Friday; without the curated list this would answer 01-01.
  assert.equal(nextTradingDay("2026-12-31"), "2027-01-04");
  assert.equal(nextTradingDay("2027-01-01"), "2027-01-04");
  // 春节 2027.
  assert.equal(nextTradingDay("2027-02-04"), "2027-02-15");
  assert.equal(nextTradingDay("2027-02-15"), "2027-02-16");
});

test("a date outside the calendar is marked inexact rather than silently guessed", () => {
  const detail = nextTradingDayDetail("2027-06-08");
  assert.equal(detail.date, "2027-06-10"); // 端午 06-09 is a curated closure
  assert.equal(detail.exact, false);
});

test("previousTradingDay walks back over weekends and closures", () => {
  assert.equal(previousTradingDay("2026-10-19"), "2026-10-16");
  assert.equal(previousTradingDay("2026-10-08"), "2026-09-30"); // skips the 国庆 week
  assert.equal(previousTradingDay("2027-01-04"), "2026-12-31");
});

test("calendarRange reports the span the snapshot actually covers", () => {
  const range = calendarRange();
  assert.equal(range.first, "2025-09-29");
  assert.equal(range.last, "2026-10-16");
  assert.equal(range.size, 250);
});

test("isTradingDay and toIso normalise inputs", () => {
  assert.equal(isTradingDay("2026-10-16"), true);
  assert.equal(isTradingDay("2026-10-17"), false); // Saturday
  assert.equal(isTradingDay("2026-10-05"), false); // 国庆
  assert.equal(toIso("2026-10-16T09:30:00Z"), "2026-10-16");
  assert.equal(toIso("bogus"), null);
  assert.equal(nextTradingDay("bogus"), null);
  assert.equal(nextTradingDay(null), null);
});

test("createCalendar builds an isolated calendar", () => {
  const calendar = createCalendar({
    days: ["2026-01-05", "2026-01-06", "2026-01-09"],
    closures: ["2026-01-07"]
  });
  assert.equal(calendar.first, "2026-01-05");
  assert.equal(calendar.last, "2026-01-09");
  assert.equal(calendar.size, 3);
  assert.equal(calendar.closureCount, 1);
  assert.deepEqual(calendar.next("2026-01-05"), { date: "2026-01-06", exact: true });
  // 01-07 is a known closure, 01-08 is a weekday gap the data does not list as a
  // session — both are skipped as non-trading.
  assert.deepEqual(calendar.next("2026-01-06"), { date: "2026-01-09", exact: true });
  assert.equal(calendar.isTradingDay("2026-01-07"), false);
  assert.equal(calendar.lastOnOrBefore("2026-01-08"), "2026-01-06");
});
