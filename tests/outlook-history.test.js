import assert from "node:assert/strict";
import test from "node:test";

import { attachActuals, MAX_RECORDS, NEUTRAL_BAND, summarizeHistory, toRecord, upsertRecord } from "../lib/outlook-history.js";

function outlook(overrides = {}) {
  return {
    dataDate: "2026-10-16",
    forDate: "2026-10-19",
    forDateExact: true,
    score: 42.5,
    bias: "看多",
    tone: "bullish",
    availableWeight: 100,
    drivers: [
      { key: "us", label: "美股", z: -0.5, contribution: -5.5, rawText: "跌", effect: "拖累" },
      { key: "vix", label: "VIX", z: 0.2, contribution: 0.6, rawText: "16.46", effect: "轻微支撑" }
    ],
    generatedAt: "2026-10-16T08:00:00.000Z",
    ...overrides
  };
}

test("toRecord keeps the call and drops the prose", () => {
  const record = toRecord(outlook());
  assert.equal(record.dataDate, "2026-10-16");
  assert.equal(record.forDate, "2026-10-19");
  assert.equal(record.score, 42.5);
  assert.equal(record.actual, null);
  assert.deepEqual(record.drivers, [
    { key: "us", z: -0.5, contribution: -5.5 },
    { key: "vix", z: 0.2, contribution: 0.6 }
  ]);
  // Labels and prose belong to the page, not to the ledger.
  assert.equal("label" in record.drivers[0], false);
  assert.equal("logic" in record, false);
});

test("toRecord refuses an outlook without a data date", () => {
  assert.equal(toRecord({ ...outlook(), dataDate: null }), null);
  assert.equal(toRecord(null), null);
});

test("upsertRecord replaces the same evening instead of appending", () => {
  const first = upsertRecord([], toRecord(outlook()));
  const second = upsertRecord(first, toRecord(outlook({ score: -10, bias: "震荡" })));
  assert.equal(second.length, 1);
  assert.equal(second[0].score, -10);
});

test("re-serving the same evening keeps the moment the call was first shown", () => {
  // Every page load rebuilds the outlook with a fresh generatedAt. Restamping
  // recordedAt would rewrite data/outlook-history.json on every refresh.
  const first = upsertRecord([], toRecord(outlook({ generatedAt: "2026-10-16T08:01:00.000Z" })));
  const again = upsertRecord(first, toRecord(outlook({ generatedAt: "2026-10-18T08:52:00.000Z" })));
  assert.equal(again[0].recordedAt, "2026-10-16T08:01:00.000Z");
  assert.equal(JSON.stringify(again), JSON.stringify(first));
});

test("upsertRecord never overwrites a grade that was already attached", () => {
  const graded = attachActuals(upsertRecord([], toRecord(outlook())), { "2026-10-16": 3716.28, "2026-10-19": 3750 });
  assert.equal(graded[0].actual.hit, true);
  const again = upsertRecord(graded, toRecord(outlook({ score: 5 })));
  assert.equal(again.length, 1);
  assert.equal(again[0].score, 5);
  assert.deepEqual(again[0].actual, graded[0].actual);
});

test("upsertRecord keeps the ledger ordered and bounded", () => {
  let records = [];
  for (let day = 1; day <= MAX_RECORDS + 5; day += 1) {
    const dataDate = `2026-${String(Math.floor((day - 1) / 28) + 1).padStart(2, "0")}-${String(((day - 1) % 28) + 1).padStart(2, "0")}`;
    records = upsertRecord(records, toRecord(outlook({ dataDate, forDate: null })));
  }
  assert.equal(records.length, MAX_RECORDS);
  assert.equal(records[0].dataDate < records[records.length - 1].dataDate, true);
});

test("attachActuals grades a directional call against the next close", () => {
  const records = attachActuals([toRecord(outlook({ score: 42.5 }))], {
    "2026-10-16": 3716.28,
    "2026-10-19": 3750
  });
  const actual = records[0].actual;
  assert.equal(actual.date, "2026-10-19");
  assert.equal(actual.changePct, 0.907);
  assert.equal(actual.direction, "up");
  assert.equal(actual.hit, true);
  assert.equal(actual.prevClose, 3716.28);
});

test("attachActuals records a miss when the index goes the other way", () => {
  const records = attachActuals([toRecord(outlook({ score: -60 }))], {
    "2026-10-16": 3716.28,
    "2026-10-19": 3750
  });
  assert.equal(records[0].actual.hit, false);
});

test("a call inside the neutral band is scored but not right or wrong", () => {
  const records = attachActuals([toRecord(outlook({ score: NEUTRAL_BAND - 1 }))], {
    "2026-10-16": 3716.28,
    "2026-10-19": 3750
  });
  assert.equal(records[0].actual.direction, "up");
  assert.equal(records[0].actual.hit, null);
});

test("a move inside the flat band counts as flat, not as a direction", () => {
  const records = attachActuals([toRecord(outlook({ score: 80 }))], {
    "2026-10-16": 1000,
    "2026-10-19": 1000.3
  });
  assert.equal(records[0].actual.direction, "flat");
  assert.equal(records[0].actual.hit, false);
});

test("attachActuals leaves a call pending until the close exists", () => {
  const pending = toRecord(outlook({ forDate: null }));
  const records = attachActuals([pending], { "2026-10-16": 3716.28 });
  assert.equal(records[0].actual, null);
  assert.equal(records[0], pending);
});

test("attachActuals does not regrade a row that already has an actual", () => {
  const graded = { ...toRecord(outlook()), actual: { date: "2026-10-19", changePct: 9.99, direction: "up", hit: true } };
  const records = attachActuals([graded], { "2026-10-16": 1, "2026-10-19": 2 });
  assert.deepEqual(records[0].actual, graded.actual);
});

/** Build a record that is already graded. */
function graded(score, changePct) {
  return {
    ...toRecord(outlook({ dataDate: `2026-10-${String(10 + Math.abs(score)).padStart(2, "0")}` })),
    score,
    actual: {
      date: "next",
      changePct,
      direction: changePct > 0.05 ? "up" : changePct < -0.05 ? "down" : "flat",
      hit: Math.abs(score) >= NEUTRAL_BAND ? (score > 0 ? changePct > 0.05 : changePct < -0.05) : null
    }
  };
}

test("summarizeHistory counts only the calls that made a directional claim", () => {
  const summary = summarizeHistory([graded(60, 1.2), graded(-55, -0.8), graded(5, 3), graded(40, -1)]);
  assert.equal(summary.total, 4);
  assert.equal(summary.scored, 4);
  assert.equal(summary.directional, 3);
  assert.equal(summary.hits, 2);
  assert.equal(summary.hitRate, 0.667);
  assert.equal(summary.neutralBand, NEUTRAL_BAND);
});

test("summarizeHistory reports pending rows as pending, not as warm-up", () => {
  const summary = summarizeHistory([toRecord(outlook()), graded(30, 0.5)]);
  assert.equal(summary.total, 2);
  assert.equal(summary.scored, 1);
  assert.equal(summary.pending, 1);
});

test("summarizeHistory withholds correlation until there are three samples", () => {
  assert.equal(summarizeHistory([graded(30, 0.5), graded(-30, -0.5)]).correlation, null);
  const summary = summarizeHistory([graded(30, 0.5), graded(40, 0.8), graded(-30, -0.4)]);
  assert.equal(summary.correlation > 0.9, true);
});

test("summarizeHistory buckets every scored row exactly once", () => {
  const summary = summarizeHistory([graded(60, 1), graded(30, 0.5), graded(5, 0), graded(-30, -0.5), graded(-70, -1)]);
  assert.deepEqual(
    summary.buckets.map((bucket) => bucket.count),
    [1, 1, 1, 1, 1]
  );
  const total = summary.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  assert.equal(total, summary.scored);
  assert.equal(summary.buckets[0].avgChangePct, 1);
  assert.equal(summary.buckets[4].avgChangePct, -1);
});

test("summarizeHistory of an empty ledger is empty, not NaN", () => {
  const summary = summarizeHistory([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.hitRate, null);
  assert.equal(summary.avgChangePct, null);
  assert.equal(summary.span, null);
  assert.equal(summary.correlation, null);
});
