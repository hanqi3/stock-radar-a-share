import assert from "node:assert/strict";
import test from "node:test";

import { emptyWatchlist, normalizeCodes, parseWatchlist, WATCHLIST_LIMIT } from "../lib/watchlist.js";

test("normalizeCodes keeps six-digit codes, dedupes and sorts", () => {
  const result = normalizeCodes(["600519", "000001", "600519", " 920196 "]);
  assert.deepEqual(result.codes, ["000001", "600519", "920196"]);
  assert.equal(result.rejected, 0);
  assert.equal(result.truncated, false);
});

test("normalizeCodes rejects anything that is not a six-digit code", () => {
  const result = normalizeCodes(["60051", "6005199", "sh600519", "", null, undefined, 12, "60051a"]);
  assert.deepEqual(result.codes, []);
  assert.equal(result.rejected, 8);
});

test("normalizeCodes tolerates a non-array payload", () => {
  for (const input of [null, undefined, "600519", 42, {}]) {
    assert.deepEqual(normalizeCodes(input).codes, []);
  }
});

test("normalizeCodes caps the list and says so", () => {
  const many = Array.from({ length: WATCHLIST_LIMIT + 5 }, (_, index) => String(600000 + index));
  const result = normalizeCodes(many);
  assert.equal(result.codes.length, WATCHLIST_LIMIT);
  assert.equal(result.truncated, true);
});

test("parseWatchlist survives a hand-edited file", () => {
  assert.deepEqual(parseWatchlist(null), emptyWatchlist());
  assert.deepEqual(parseWatchlist("nope"), emptyWatchlist());
  assert.deepEqual(parseWatchlist({ codes: ["600519", "junk"], updatedAt: 7 }), { updatedAt: null, codes: ["600519"] });
  assert.equal(parseWatchlist({ codes: [], updatedAt: "2026-10-18T00:00:00.000Z" }).updatedAt, "2026-10-18T00:00:00.000Z");
});
