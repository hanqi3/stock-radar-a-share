import assert from "node:assert/strict";
import test from "node:test";

import { buildDigest, digestChanged, formatDigest, mergeDigest, newCodes } from "../lib/alert-digest.js";

function briefing(overrides = {}) {
  return {
    generatedAt: "2026-10-16T08:30:00.000Z",
    overview: { tradable: 5570, advancers: 3301, decliners: 2127, flat: 142 },
    limitUpCount: 71,
    limitDownCount: 15,
    anomalies: [
      { code: "920196", name: "N南乳", changePct: 58.76, anomalyScore: 99.99, trendScore: 82, signalType: "涨停", board: "北交所", price: 22.56 },
      { code: "301569", name: "C联亚", changePct: -28.33, anomalyScore: 99.94, trendScore: 13, signalType: "跌停", board: "创业板", price: 30.1 }
    ],
    ...overrides
  };
}

test("buildDigest keeps the ranking and drops the page-only fields", () => {
  const digest = buildDigest(briefing());
  assert.equal(digest.date, "2026-10-16");
  assert.equal(digest.limitUpCount, 71);
  assert.equal(digest.advancers, 3301);
  assert.equal(digest.items.length, 2);
  assert.deepEqual(Object.keys(digest.items[0]).sort(), ["anomalyScore", "changePct", "code", "name", "signalType", "trendScore"]);
});

test("buildDigest honours the item limit", () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ code: `60000${index}`, name: `股${index}`, changePct: index, anomalyScore: 90 }));
  assert.equal(buildDigest(briefing({ anomalies: many }), { limit: 3 }).items.length, 3);
});

test("buildDigest returns null without a briefing", () => {
  assert.equal(buildDigest(null), null);
});

test("mergeDigest remembers yesterday's codes, not today's", () => {
  const day1 = mergeDigest(null, buildDigest(briefing()));
  assert.equal(day1.previous, null);
  const day2Briefing = briefing({
    generatedAt: "2026-10-19T08:30:00.000Z",
    anomalies: [{ code: "600519", name: "贵州茅台", changePct: 1.2, anomalyScore: 95 }]
  });
  const day2 = mergeDigest(day1, buildDigest(day2Briefing));
  assert.equal(day2.date, "2026-10-19");
  assert.equal(day2.previous.date, "2026-10-16");
  assert.deepEqual(day2.previous.codes, ["920196", "301569"]);
});

test("merging the same date twice keeps the original reference set", () => {
  const first = mergeDigest(null, buildDigest(briefing()));
  const again = mergeDigest(first, buildDigest(briefing({ limitUpCount: 80 })));
  assert.equal(again.limitUpCount, 80);
  assert.equal(again.previous, null);
});

test("newCodes marks only the names that were not there yesterday", () => {
  const day1 = mergeDigest(null, buildDigest(briefing()));
  const day2 = mergeDigest(
    day1,
    buildDigest(
      briefing({
        generatedAt: "2026-10-19T08:30:00.000Z",
        anomalies: [{ code: "920196", name: "N南乳", changePct: 10, anomalyScore: 97 }, { code: "600519", name: "贵州茅台", changePct: 1.2, anomalyScore: 95 }]
      })
    )
  );
  assert.deepEqual([...newCodes(day2)], ["600519"]);
});

test("formatDigest is plain text that names the fresh entries", () => {
  const day1 = mergeDigest(null, buildDigest(briefing()));
  const day2 = mergeDigest(
    day1,
    buildDigest(
      briefing({
        generatedAt: "2026-10-19T08:30:00.000Z",
        anomalies: [{ code: "600519", name: "贵州茅台", changePct: 1.2, anomalyScore: 95, signalType: "放量突破" }]
      })
    )
  );
  const text = formatDigest(day2);
  assert.match(text, /【2026-10-19 异动信号】涨停 71 · 跌停 15 · 上涨 3301 \/ 下跌 2127/);
  assert.match(text, /贵州茅台 600519 \+1\.2% · 异动 95 · 放量突破 🆕/);
  assert.match(text, /相对 2026-10-16 新进榜/);
  // The first ever digest has nothing to compare against, so it marks nothing.
  assert.equal(formatDigest(day1).includes("🆕"), false);
});

test("formatDigest refuses an empty digest", () => {
  assert.equal(formatDigest(null), null);
  assert.equal(formatDigest({ date: "2026-10-16", items: [] }), null);
});

test("digestChanged ignores the timestamp but sees a new ranking", () => {
  const first = buildDigest(briefing());
  const sameContent = { ...buildDigest(briefing()), generatedAt: "2030-01-01T00:00:00.000Z" };
  assert.equal(digestChanged(first, sameContent), false);
  assert.equal(digestChanged(first, buildDigest(briefing({ limitUpCount: 80 }))), true);
  assert.equal(digestChanged(null, first), true);
});
