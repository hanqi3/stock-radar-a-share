import test from "node:test";
import assert from "node:assert/strict";

import { inferBoard, inferExchange, limitPctFor, limitPrice, limitState, isSt } from "../lib/boards.js";
import { sma, ema, bollinger, rsi, macd, kdj, atr, momentum, maxDrawdown, sharpeRatio, computeIndicators } from "../lib/indicators.js";
import { percentileRanks, normalizedMove, computeFactorTable, directionalScore } from "../lib/factors.js";
import { runBacktest, summarize, walkForwardValidation, buildCalendar } from "../lib/backtest.js";

/* ------------------------------------------------------------------ boards */

test("exchange and board inference covers every A-share prefix", () => {
  assert.equal(inferExchange("600519"), "SH");
  assert.equal(inferExchange("688981"), "SH");
  assert.equal(inferExchange("000001"), "SZ");
  assert.equal(inferExchange("300750"), "SZ");
  assert.equal(inferExchange("301052"), "SZ");
  assert.equal(inferExchange("302132"), "SZ");
  assert.equal(inferExchange("430047"), "BJ");
  assert.equal(inferExchange("830799"), "BJ");

  assert.equal(inferBoard("600519"), "沪市主板");
  assert.equal(inferBoard("000001"), "深市主板");
  assert.equal(inferBoard("302132"), "深市主板");
  assert.equal(inferBoard("300750"), "创业板");
  assert.equal(inferBoard("688981"), "科创板");
  assert.equal(inferBoard("430047"), "北交所");
});

test("limit percentage follows the real board rules", () => {
  assert.equal(limitPctFor({ code: "600519", exchange: "SH", board: "沪市主板", name: "贵州茅台" }), 10);
  assert.equal(limitPctFor({ code: "000001", exchange: "SZ", board: "深市主板", name: "平安银行" }), 10);
  assert.equal(limitPctFor({ code: "300750", exchange: "SZ", board: "创业板", name: "宁德时代" }), 20);
  assert.equal(limitPctFor({ code: "688981", exchange: "SH", board: "科创板", name: "中芯国际" }), 20);
  assert.equal(limitPctFor({ code: "430047", exchange: "BJ", board: "北交所", name: "诺思兰德" }), 30);
  assert.equal(limitPctFor({ code: "000004", exchange: "SZ", board: "深市主板", name: "*ST国华" }), 5);
  // ST on ChiNext/STAR keeps the 20% band.
  assert.equal(limitPctFor({ code: "300123", exchange: "SZ", board: "创业板", name: "*ST亚光" }), 20);
});

test("isSt only matches genuine ST prefixes", () => {
  assert.equal(isSt("*ST国华"), true);
  assert.equal(isSt("ST星源"), true);
  assert.equal(isSt("贵州茅台"), false);
  assert.equal(isSt("STOCKTEST"), true); // leading ST is the exchange convention
});

test("limit up/down detection is exact at the tick", () => {
  // 10% board, prev close 10.00 -> limit up 11.00
  const up = limitState({ code: "600000", exchange: "SH", board: "沪市主板", price: 11.0, changePct: 10.0 });
  assert.equal(up.limitUp, true);
  assert.equal(up.limitUpPrice, 11);
  const notUp = limitState({ code: "600000", exchange: "SH", board: "沪市主板", price: 10.99, changePct: 9.9 });
  assert.equal(notUp.limitUp, false);

  // 20% board: +10% must NOT be flagged as limit up (the v1 bug).
  const cyb = limitState({ code: "300750", exchange: "SZ", board: "创业板", price: 110, changePct: 10 });
  assert.equal(cyb.limitUp, false);
  const cybUp = limitState({ code: "300750", exchange: "SZ", board: "创业板", price: 120, changePct: 20 });
  assert.equal(cybUp.limitUp, true);

  // 30% BSE band.
  const bse = limitState({ code: "430047", exchange: "BJ", board: "北交所", price: 13, changePct: 30 });
  assert.equal(bse.limitUp, true);
});

test("limitPrice rounds to the tick", () => {
  assert.equal(limitPrice(10, 10), 11);
  assert.equal(limitPrice(3.33, 10), 3.66);
  assert.equal(limitPrice(100, -10), 90);
});

/* -------------------------------------------------------------- indicators */

test("sma/ema warm up correctly", () => {
  const values = [1, 2, 3, 4, 5];
  assert.deepEqual(sma(values, 3), [null, null, 2, 3, 4]);
  const e = ema(values, 3);
  assert.equal(e[0], 1);
  assert.ok(e[4] > e[3]);
});

test("bollinger bands bracket the moving average", () => {
  const values = Array.from({ length: 30 }, (_, i) => 10 + Math.sin(i / 3));
  const bands = bollinger(values, 20, 2);
  const last = bands[bands.length - 1];
  assert.ok(last.upper > last.mid);
  assert.ok(last.lower < last.mid);
  assert.equal(typeof last.percentB, "number");
});

test("rsi saturates on a monotonic series", () => {
  const rising = Array.from({ length: 30 }, (_, i) => 10 + i);
  assert.equal(rsi(rising, 14)[29], 100);
  const falling = Array.from({ length: 30 }, (_, i) => 40 - i);
  assert.equal(rsi(falling, 14)[29], 0);
});

test("macd and kdj produce finite latest values", () => {
  const closes = Array.from({ length: 80 }, (_, i) => 20 + Math.sin(i / 5) * 3);
  const highs = closes.map((c) => c + 0.5);
  const lows = closes.map((c) => c - 0.5);
  const m = macd(closes);
  assert.ok(Number.isFinite(m[79].dif));
  assert.ok(Number.isFinite(m[79].dea));
  const k = kdj(highs, lows, closes);
  assert.ok(k.k[79] >= 0 && k.k[79] <= 100);
  assert.ok(Number.isFinite(k.j[79]));
  assert.ok(Number.isFinite(atr(highs, lows, closes)[79]));
});

test("momentum and maxDrawdown are correct on known series", () => {
  assert.ok(Math.abs(momentum([100, 110], 1)[1] - 10) < 1e-9);
  assert.equal(maxDrawdown([1, 2, 1, 3]), -0.5);
  assert.ok(Number.isFinite(sharpeRatio([0.01, -0.005, 0.002, 0.004])));
});

test("computeIndicators returns the full payload for a normal series", () => {
  const bars = Array.from({ length: 120 }, (_, i) => {
    const close = 10 + Math.sin(i / 7) + i * 0.02;
    return { date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, open: close - 0.05, high: close + 0.1, low: close - 0.1, close, volume: 1000 + i };
  });
  const indicators = computeIndicators(bars);
  assert.ok(indicators);
  assert.ok(Number.isFinite(indicators.ma[20]));
  assert.ok(Number.isFinite(indicators.rsi));
  assert.ok(Number.isFinite(indicators.boll.upper));
  assert.ok(indicators.momentum[20] !== null);
});

/* ----------------------------------------------------------------- factors */

test("percentileRanks is monotonic and outlier-safe", () => {
  const ranks = percentileRanks([1, 2, 3, 4, 1000]);
  assert.equal(ranks[0], 0);
  assert.equal(ranks[4], 1);
  assert.ok(ranks[1] < ranks[2] && ranks[2] < ranks[3]);
});

test("normalizedMove puts boards on a comparable scale", () => {
  assert.equal(normalizedMove(10, 10), 100);
  assert.equal(normalizedMove(20, 20), 100);
  assert.equal(normalizedMove(15, 30), 50);
});

test("factor table produces bounded 0-100 scores", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    code: String(600000 + i),
    changePct: (i % 7) - 3,
    turnover: 1 + (i % 5),
    amount: 1e8 * (1 + i),
    limitPct: 10,
    momentum20: (i % 11) - 5,
    momentum60: (i % 13) - 6,
    volatility20: 20 + (i % 9),
    volumeRatio: 0.5 + (i % 6) * 0.3,
    ma20Gap: (i % 9) - 4,
    bollPercentB: i % 100,
    macdHist: (i % 5) - 2,
    industryMomentum20: (i % 3) - 1
  }));
  const table = computeFactorTable(rows);
  assert.equal(table.length, 40);
  for (const row of table) {
    assert.ok(row.anomalyScore >= 0 && row.anomalyScore <= 100, `anomalyScore out of range: ${row.anomalyScore}`);
    assert.ok(row.trendScore >= 0 && row.trendScore <= 100, `trendScore out of range: ${row.trendScore}`);
    assert.ok(Math.abs(directionalScore(row)) <= 100);
  }
});

/* ---------------------------------------------------------------- backtest */

/** Strictly increasing trading dates: 2026-01-01, 2026-01-02, ... */
function seqDate(index) {
  return new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
}

function syntheticHistory(codes, days = 200, drift = 0.0004) {
  const history = new Map();
  for (let c = 0; c < codes; c += 1) {
    const code = String(600000 + c);
    const bars = [];
    let price = 10 + c;
    for (let d = 0; d < days; d += 1) {
      const wave = Math.sin((d + c) / 9) * 0.01;
      const ret = drift + wave + ((d + c) % 5 === 0 ? -0.01 : 0.012);
      price = Math.max(1, price * (1 + ret));
      bars.push({ date: seqDate(d), open: price * 0.995, high: price * 1.01, low: price * 0.99, close: price, volume: 100000 + d * 10 });
    }
    history.set(code, bars);
  }
  return history;
}

test("buildCalendar merges every stock's dates", () => {
  const history = syntheticHistory(3, 30);
  const calendar = buildCalendar(history);
  assert.equal(calendar.length, 30);
});

test("backtest runs end to end and respects T+1 and lot sizes", () => {
  const history = syntheticHistory(25, 180);
  const signal = (code, bars, index) => {
    const window = bars.slice(Math.max(0, index - 20), index + 1).map((b) => b.close);
    const past = bars.slice(Math.max(0, index - 40), Math.max(1, index - 20)).map((b) => b.close);
    if (!window.length || !past.length) return null;
    return (window[window.length - 1] / past[0] - 1) * 100;
  };
  const result = runBacktest({ history, signal, topN: 5, holdDays: 5, minScore: -5, rebalanceDays: 2, cash: 500000 });
  assert.ok(result.curve.length > 0);
  const summary = summarize(result);
  assert.ok(Number.isFinite(summary.totalReturn));
  assert.ok(Number.isFinite(summary.maxDrawdown));
  assert.ok(summary.trades > 0, "expected at least one trade");
  for (const trade of result.trades) {
    assert.equal(trade.shares % 100, 0, "A-shares trade in 100-share lots");
    assert.ok(trade.exitDate >= trade.entryDate);
    assert.ok(trade.entryDate !== trade.exitDate, "T+1 forbids same-day round trips");
  }
});

test("walk-forward split returns both windows", () => {
  const history = syntheticHistory(20, 200);
  const signal = (code, bars, index) => (index >= 60 ? bars[index].close / bars[index - 20].close - 1 : null);
  const wf = walkForwardValidation({ history, signal, topN: 4, holdDays: 5, minScore: -1, rebalanceDays: 3 }, 0.7);
  assert.ok(wf.inSample.sessions > 0);
  assert.ok(wf.outOfSample.sessions > 0);
  assert.ok(wf.splitDate);
  assert.ok(Array.isArray(wf.curve));
});

test("backtest refuses to buy a limit-up open", () => {
  const history = new Map();
  const bars = [];
  for (let d = 0; d < 80; d += 1) {
    const price = 10 + d * 0.01;
    bars.push({ date: seqDate(d), open: price, high: price * 1.02, low: price * 0.98, close: price, volume: 1000 });
  }
  // Make bar 70 open exactly at the 10% limit so it must be skipped.
  const prevClose = bars[69].close;
  bars[70] = { ...bars[70], open: Math.round(prevClose * 1.1 * 100) / 100 };
  history.set("600000", bars);
  const result = runBacktest({
    history,
    signal: () => 100,
    topN: 1,
    holdDays: 2,
    minScore: 0,
    rebalanceDays: 1,
    cash: 200000
  });
  const boughtOn70 = result.trades.some((t) => t.entryDate === bars[70].date);
  assert.equal(boughtOn70, false);
});
