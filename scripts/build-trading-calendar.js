/**
 * Regenerates `lib/trading-days.json` from the sessions in `data/flow.json`.
 *
 * The flow snapshot already stores the last 250 trading sessions, which is a
 * free and exact record of when the exchange was open. Weekday gaps inside that
 * window are therefore real closures (春节, 国庆, 清明 …), not missing data.
 *
 * Beyond the window the calendar falls back to `lib/market-holidays.js`; this
 * script validates that curated list against any entry the data now covers and
 * prints a warning when they disagree, so a stale hand-maintained holiday shows
 * up in the CI log instead of quietly mislabelling a date.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FORWARD_CLOSURES } from "../lib/market-holidays.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLOW_FILE = path.join(ROOT, "data", "flow.json");
const OUT_FILE = path.join(ROOT, "lib", "trading-days.json");

const isWeekday = (iso) => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

function shift(iso, step) {
  const cursor = new Date(`${iso}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + step);
  return cursor.toISOString().slice(0, 10);
}

/** Every weekday between two ISO dates, inclusive. */
function weekdaysBetween(first, last) {
  const out = [];
  for (let cursor = first; cursor <= last; cursor = shift(cursor, 1)) {
    if (isWeekday(cursor)) out.push(cursor);
  }
  return out;
}

async function main() {
  const raw = JSON.parse(await fs.readFile(FLOW_FILE, "utf8"));
  const sessions = new Set(
    (raw.sessions ?? []).map((entry) => String(entry).slice(0, 10)).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))
  );
  if (sessions.size < 60) {
    throw new Error(`data/flow.json only carries ${sessions.size} sessions; refusing to build a calendar from it`);
  }

  const days = [...sessions].sort();
  const first = days[0];
  const last = days[days.length - 1];
  const closures = weekdaysBetween(first, last).filter((iso) => !sessions.has(iso));

  // Cross-check the curated forward list against what the data actually shows.
  const observed = new Set(closures);
  const conflicts = [];
  for (const iso of FORWARD_CLOSURES) {
    if (iso < first || iso > last) continue; // still in the future, nothing to compare
    if (!observed.has(iso)) conflicts.push(iso);
  }
  if (conflicts.length) {
    console.warn(
      `WARN: lib/market-holidays.js lists ${conflicts.length} weekday closure(s) inside the observed window that the data says were trading days: ${conflicts.join(", ")}`
    );
  }

  let previous = null;
  try {
    previous = JSON.parse(await fs.readFile(OUT_FILE, "utf8"));
  } catch {
    previous = null;
  }
  const unchanged =
    previous &&
    JSON.stringify(previous.days) === JSON.stringify(days) &&
    JSON.stringify(previous.closures) === JSON.stringify(closures);
  if (unchanged) {
    console.log(`${path.relative(ROOT, OUT_FILE)} already current: ${days.length} sessions, ${closures.length} weekday closures`);
    return;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "data/flow.json sessions",
    first,
    last,
    days,
    closures
  };
  await fs.writeFile(OUT_FILE, `${JSON.stringify(payload, null, 0)}\n`, "utf8");
  console.log(
    `Wrote ${path.relative(ROOT, OUT_FILE)}: ${days.length} sessions ${first}..${last}, ${closures.length} weekday closures`
  );
  if (conflicts.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
