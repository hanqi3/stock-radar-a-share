import assert from "node:assert/strict";
import test from "node:test";

import { computeIndicators } from "../lib/indicators.js";
import { buildLevels, buildTechnicalView, rangePosition } from "../lib/technicals.js";

/** Build a bar series from closing prices, with a little intraday range. */
function barsFrom(closes, { spread = 0.01, volume = 100000 } = {}) {
  return closes.map((close, index) => ({
    date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
    open: Number((close * (1 - spread / 2)).toFixed(2)),
    high: Number((close * (1 + spread)).toFixed(2)),
    low: Number((close * (1 - spread)).toFixed(2)),
    close,
    volume
  }));
}

/** A steady trend then a flat tail, long enough for MA60 / RSI / MACD. */
function trending(start, step, count = 90) {
  const closes = [];
  for (let index = 0; index < count; index += 1) closes.push(Number((start + step * index).toFixed(2)));
  return closes;
}

function view(closes, options = {}) {
  const bars = barsFrom(closes);
  return buildTechnicalView(computeIndicators(bars), bars, { phase: "postclose", limitPct: 10, ...options });
}

test("an uptrend scores above neutral and says so", () => {
  const result = view(trending(10, 0.12));
  assert.ok(result.verdict.score > 55, `expected a bullish score, got ${result.verdict.score}`);
  assert.equal(result.verdict.tone, "positive");
  assert.match(result.summary, /偏多/);
  assert.equal(result.title, "明日走势");
});

test("a downtrend scores below neutral", () => {
  const result = view(trending(30, -0.18));
  assert.ok(result.verdict.score < 45, `expected a bearish score, got ${result.verdict.score}`);
  assert.equal(result.verdict.tone, "negative");
  assert.match(result.summary, /偏弱|弱势/);
});

test("the verdict title follows the session phase", () => {
  const closes = trending(20, 0.05);
  const bars = barsFrom(closes);
  const indicators = computeIndicators(bars);
  assert.equal(buildTechnicalView(indicators, bars, { phase: "postclose" }).title, "明日走势");
  assert.equal(buildTechnicalView(indicators, bars, { phase: "preopen" }).title, "今日分析");
  assert.equal(buildTechnicalView(indicators, bars, { phase: "intraday" }).title, "今日分析");
});

test("insufficient data returns null instead of guessing", () => {
  assert.equal(buildTechnicalView(null, barsFrom([10, 11])), null);
  assert.equal(buildTechnicalView(computeIndicators(barsFrom([10])), barsFrom([10])), null);
  assert.equal(buildTechnicalView({}, []), null);
});

test("every signal carries a label, a value and a tone", () => {
  const result = view(trending(15, 0.1));
  assert.ok(result.signals.length >= 6);
  for (const signal of result.signals) {
    assert.ok(signal.key, "signal key");
    assert.ok(signal.label, "signal label");
    assert.ok(signal.value !== undefined && signal.value !== null, "signal value");
    assert.ok(["positive", "negative", "neutral"].includes(signal.tone), `bad tone ${signal.tone}`);
    assert.equal(typeof signal.note, "string");
  }
  assert.ok(result.reasons.length >= 3);
});

test("the score stays inside 0-100 even when every input is extreme", () => {
  const closes = trending(10, 0.6, 120);
  const result = view(closes);
  assert.ok(result.verdict.score >= 0 && result.verdict.score <= 100);
  const falling = view(trending(60, -0.4, 120));
  assert.ok(falling.verdict.score >= 0 && falling.verdict.score <= 100);
});

test("levels bracket the close and the stop sits below it", () => {
  const result = view(trending(10, 0.1));
  const { levels } = result;
  assert.ok(levels.support < levels.close);
  assert.ok(levels.resistance > levels.close);
  assert.ok(levels.stop < levels.close);
  assert.ok(levels.support <= levels.stop + 0.02, "stop should sit at or below support");
  assert.ok(levels.limitUp > levels.close);
  assert.ok(levels.limitDown < levels.close);
});

test("a stock without a price band gets null limit prices", () => {
  const closes = trending(10, 0.1);
  const bars = barsFrom(closes);
  const levels = buildLevels({
    close: closes[closes.length - 1],
    bars,
    indicators: computeIndicators(bars),
    ma20: computeIndicators(bars).ma[20],
    limitPct: null
  });
  assert.equal(levels.limitUp, null);
  assert.equal(levels.limitDown, null);
  assert.ok(levels.support < levels.close);
});

test("rangePosition maps the window low to 0 and the window high to 1", () => {
  const bare = (closes) =>
    closes.map((close, index) => ({ date: `2026-02-${String(index + 1).padStart(2, "0")}`, open: close, high: close, low: close, close, volume: 1 }));
  assert.equal(rangePosition(bare([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 10), 1);
  assert.equal(rangePosition(bare([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), 10), 0);
  assert.equal(rangePosition(bare([5, 5, 5, 5]), 4), null);
  assert.equal(rangePosition([], 20), null);
});

test("overbought conditions are called out rather than rewarded", () => {
  // Eleven straight up days push RSI into the overbought zone; the RSI signal
  // must then read as a warning even though the trend is up.
  const result = view(trending(10, 0.9, 40));
  const rsi = result.signals.find((signal) => signal.key === "rsi");
  assert.ok(rsi, "rsi signal present");
  assert.equal(rsi.tone, "negative");
  assert.match(rsi.note, /超买/);
});

test("a flat tape does not swing to either extreme", () => {
  const closes = [];
  for (let index = 0; index < 90; index += 1) closes.push(20 + (index % 2 === 0 ? 0.05 : -0.05));
  const result = view(closes);
  assert.ok(result.verdict.score > 20 && result.verdict.score < 80, `score ${result.verdict.score}`);
});
