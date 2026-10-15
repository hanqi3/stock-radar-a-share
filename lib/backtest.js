// Daily-bar backtester with A-share trading frictions.
//
// Deliberate correctness choices:
//  * Signals are computed from bar `t` (close) and executed at the open of
//    bar `t + 1` — no look-ahead.
//  * T+1: a position opened on day t cannot be sold before t + 1.
//  * A stock that opens limit-up cannot be bought that day; one that opens
//    limit-down cannot be sold that day. Both are common enough in A-shares
//    that ignoring them makes a strategy look far better than it is.
//  * Costs: commission 0.025% (min ¥5), stamp duty 0.05% on sells, transfer
//    fee 0.001%.

import { computeIndicators, maxDrawdown, sharpeRatio, sortinoRatio, dailyReturns, percentile } from "./indicators.js";
import { limitPctFor, limitPrice } from "./boards.js";

export const DEFAULT_COSTS = {
  commissionRate: 0.00025,
  commissionMin: 5,
  stampDutyRate: 0.0005,
  transferFeeRate: 0.00001,
  slippageRate: 0.001
};

export function buildCalendar(history) {
  const dates = new Set();
  for (const bars of history.values()) {
    for (const bar of bars) dates.add(bar.date);
  }
  return [...dates].sort();
}

/** Map every stock code to a date -> index lookup for O(1) alignment. */
function indexBars(history) {
  const index = new Map();
  for (const [code, bars] of history) {
    const byDate = new Map();
    bars.forEach((bar, i) => byDate.set(bar.date, i));
    index.set(code, byDate);
  }
  return index;
}

function tradeCost(notional, side, costs) {
  const commission = Math.max(notional * costs.commissionRate, costs.commissionMin);
  const transfer = notional * costs.transferFeeRate;
  const stamp = side === "sell" ? notional * costs.stampDutyRate : 0;
  return commission + transfer + stamp;
}

/**
 * @param {object} config
 * @param {Map<string, Array>} config.history      code -> daily bars (ascending)
 * @param {Function} config.signal                 (code, bars, index) => number|null
 * @param {string[]} [config.calendar]
 * @param {number} [config.topN]                   positions held at once
 * @param {number} [config.minScore]               entry threshold
 * @param {number} [config.holdDays]               forced exit after N sessions
 * @param {number} [config.stopLossPct]            e.g. 0.08
 * @param {number} [config.takeProfitPct]          e.g. 0.15
 * @param {number} [config.rebalanceDays]          re-rank every N sessions
 * @param {number} [config.cash]                   starting capital
 * @param {object} [config.costs]
 * @param {string} [config.startDate]
 * @param {string} [config.endDate]
 */
export function runBacktest(config) {
  const {
    history,
    signal,
    topN = 10,
    minScore = 0,
    holdDays = 10,
    stopLossPct = 0.08,
    takeProfitPct = 0.2,
    rebalanceDays = 1,
    cash = 1_000_000,
    costs = DEFAULT_COSTS,
    startDate,
    endDate
  } = config;

  const fullCalendar = config.calendar || buildCalendar(history);
  const calendar = fullCalendar.filter(
    (date) => (!startDate || date >= startDate) && (!endDate || date <= endDate)
  );
  const byDate = indexBars(history);

  // Pre-compute the signal for every (code, date) we will ever evaluate.
  const signalCache = new Map();
  const barsByCode = new Map();
  for (const [code, bars] of history) {
    barsByCode.set(code, bars);
  }

  const getSignal = (code, date) => {
    const key = `${code}|${date}`;
    if (signalCache.has(key)) return signalCache.get(key);
    const bars = barsByCode.get(code);
    const pos = byDate.get(code)?.get(date);
    let value = null;
    if (bars && pos !== undefined && pos >= 60) {
      value = signal(code, bars, pos);
      if (!Number.isFinite(value)) value = null;
    }
    signalCache.set(key, value);
    return value;
  };

  const barAt = (code, date) => {
    const pos = byDate.get(code)?.get(date);
    return pos === undefined ? null : barsByCode.get(code)[pos];
  };

  let equity = cash;
  const positions = new Map(); // code -> {entryDate, entryPrice, shares, entryIndex}
  const curve = [];
  const trades = [];
  const closedReturns = [];
  const marketReturns = [];

  const priceOf = (code, date) => {
    const bar = barAt(code, date);
    return bar ? bar.close : null;
  };

  const sell = (code, date, bar, reason) => {
    const position = positions.get(code);
    if (!position) return;
    const prevClose = priceOf(code, date);
    // Cannot sell into a limit-down open.
    if (prevClose !== null) {
      const pct = limitPctFor({ code });
      const down = limitPrice(prevClose, -pct);
      if (down !== null && bar.open <= down + 0.005) return;
    }
    const price = bar.open * (1 - costs.slippageRate);
    const notional = price * position.shares;
    const fee = tradeCost(notional, "sell", costs);
    equity += notional - fee;
    const pnl = notional - fee - position.cost;
    trades.push({
      code,
      entryDate: position.entryDate,
      exitDate: date,
      entryPrice: position.entryPrice,
      exitPrice: price,
      shares: position.shares,
      pnl,
      returnPct: position.cost ? (pnl / position.cost) * 100 : 0,
      reason,
      holdSessions: position.sessions
    });
    closedReturns.push(position.cost ? pnl / position.cost : 0);
    positions.delete(code);
  };

  for (let i = 0; i < calendar.length; i += 1) {
    const date = calendar[i];
    const nextDate = calendar[i + 1];

    // 1. Manage open positions on today's bar.
    for (const [code, position] of [...positions]) {
      const bar = barAt(code, date);
      if (!bar) continue;
      position.sessions += 1;
      const prevClose = priceOf(code, calendar[i - 1] ?? date);
      const pct = limitPctFor({ code });

      if (prevClose !== null) {
        const down = limitPrice(prevClose, -pct);
        if (down !== null && bar.open <= down + 0.005) continue; // locked limit-down
      }

      const stopPrice = position.entryPrice * (1 - stopLossPct);
      const targetPrice = position.entryPrice * (1 + takeProfitPct);
      let reason = null;
      let exitPrice = bar.open;

      if (bar.low <= stopPrice) {
        reason = "stop-loss";
        exitPrice = Math.min(bar.open, stopPrice);
      } else if (bar.high >= targetPrice) {
        reason = "take-profit";
        exitPrice = Math.max(bar.open, targetPrice);
      } else if (position.sessions >= holdDays) {
        reason = "time-exit";
      }

      if (reason && position.sessions >= 1) {
        // T+1 is satisfied because positions are opened at the previous open.
        const price = exitPrice * (1 - costs.slippageRate);
        const notional = price * position.shares;
        const fee = tradeCost(notional, "sell", costs);
        equity += notional - fee;
        const pnl = notional - fee - position.cost;
        trades.push({
          code,
          entryDate: position.entryDate,
          exitDate: date,
          entryPrice: position.entryPrice,
          exitPrice: price,
          shares: position.shares,
          pnl,
          returnPct: position.cost ? (pnl / position.cost) * 100 : 0,
          reason,
          holdSessions: position.sessions
        });
        closedReturns.push(position.cost ? pnl / position.cost : 0);
        positions.delete(code);
      }
    }

    // 2. Enter new positions at tomorrow's open using today's signal.
    if (nextDate && (i % rebalanceDays === 0 || positions.size === 0)) {
      const candidates = [];
      for (const [code, bars] of barsByCode) {
        const pos = byDate.get(code)?.get(date);
        if (pos === undefined || pos < 60) continue;
        const score = getSignal(code, date);
        if (score === null || score < minScore) continue;
        if (positions.has(code)) continue;
        candidates.push({ code, score, close: bars[pos].close });
      }
      candidates.sort((a, b) => b.score - a.score);

      const slots = Math.max(0, topN - positions.size);
      const picks = candidates.slice(0, slots);
      if (picks.length) {
        const perPosition = equity / topN;
        for (const pick of picks) {
          const bar = barAt(pick.code, nextDate);
          if (!bar) continue;
          const prevClose = pick.close;
          const pct = limitPctFor({ code: pick.code });
          const up = limitPrice(prevClose, pct);
          if (up !== null && bar.open >= up - 0.005) continue; // cannot buy a limit-up open

          const price = bar.open * (1 + costs.slippageRate);
          if (!price || !Number.isFinite(price)) continue;
          const budget = Math.min(perPosition, equity);
          if (budget < 1000) continue;
          const shares = Math.floor(budget / price / 100) * 100; // A-share lots
          if (shares < 100) continue;
          const notional = price * shares;
          const fee = tradeCost(notional, "buy", costs);
          if (notional + fee > equity) continue;
          equity -= notional + fee;
          positions.set(pick.code, {
            entryDate: nextDate,
            entryPrice: price,
            shares,
            cost: notional + fee,
            sessions: 0
          });
        }
      }
    }

    // 3. Mark to market.
    let holdings = 0;
    for (const [code, position] of positions) {
      const price = priceOf(code, date);
      if (price !== null) holdings += price * position.shares;
    }
    curve.push({ date, equity: equity + holdings, cash: equity, positions: positions.size });

    // Equal-weight universe return, used as the benchmark series.
    const universeReturns = [];
    for (const [code, bars] of barsByCode) {
      const pos = byDate.get(code)?.get(date);
      if (pos === undefined || pos < 1) continue;
      const prev = bars[pos - 1].close;
      if (prev) universeReturns.push(bars[pos].close / prev - 1);
    }
    marketReturns.push(universeReturns.length ? universeReturns.reduce((a, b) => a + b, 0) / universeReturns.length : 0);
  }

  // Liquidate whatever is still open on the final bar.
  const lastDate = calendar[calendar.length - 1];
  for (const [code, position] of [...positions]) {
    const bar = barAt(code, lastDate);
    if (!bar) continue;
    const price = bar.close * (1 - costs.slippageRate);
    const notional = price * position.shares;
    const fee = tradeCost(notional, "sell", costs);
    equity += notional - fee;
    const pnl = notional - fee - position.cost;
    trades.push({
      code,
      entryDate: position.entryDate,
      exitDate: lastDate,
      entryPrice: position.entryPrice,
      exitPrice: price,
      shares: position.shares,
      pnl,
      returnPct: position.cost ? (pnl / position.cost) * 100 : 0,
      reason: "final-liquidation",
      holdSessions: position.sessions
    });
    closedReturns.push(position.cost ? pnl / position.cost : 0);
    positions.delete(code);
  }
  if (curve.length) curve[curve.length - 1] = { ...curve[curve.length - 1], equity, cash: equity, positions: 0 };

  return { curve, trades, closedReturns, marketReturns, finalEquity: equity, initialCash: cash };
}

export function summarize(result, options = {}) {
  const { riskFreeRate = 0.02, label = "策略" } = options;
  const { curve, trades, closedReturns, marketReturns, finalEquity, initialCash } = result;
  if (!curve.length) {
    return { label, sessions: 0, totalReturn: 0, annualizedReturn: 0, maxDrawdown: 0, sharpe: 0, sortino: 0, trades: 0, winRate: 0, profitFactor: 0, avgHoldSessions: 0, benchmarkReturn: 0, excessReturn: 0, bestTrade: 0, worstTrade: 0, volatility: 0 };
  }

  const equitySeries = curve.map((point) => point.equity);
  const strategyReturns = dailyReturns(equitySeries).filter((r) => Number.isFinite(r));
  const totalReturn = finalEquity / initialCash - 1;
  const sessions = curve.length;
  const years = sessions / 252;
  const annualizedReturn = years > 0 ? (1 + totalReturn) ** (1 / years) - 1 : totalReturn;

  const benchmarkSeries = [1];
  for (const r of marketReturns) benchmarkSeries.push(benchmarkSeries[benchmarkSeries.length - 1] * (1 + r));
  const benchmarkReturn = benchmarkSeries[benchmarkSeries.length - 1] - 1;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));

  const volatility = strategyReturns.length > 1
    ? Math.sqrt(strategyReturns.reduce((a, b) => a + b ** 2, 0) / (strategyReturns.length - 1) - (strategyReturns.reduce((a, b) => a + b, 0) / strategyReturns.length) ** 2) * Math.sqrt(252)
    : 0;

  return {
    label,
    sessions,
    startDate: curve[0].date,
    endDate: curve[curve.length - 1].date,
    totalReturn: Number((totalReturn * 100).toFixed(2)),
    annualizedReturn: Number((annualizedReturn * 100).toFixed(2)),
    maxDrawdown: Number((maxDrawdown(equitySeries) * 100).toFixed(2)),
    volatility: Number((volatility * 100).toFixed(2)),
    sharpe: Number(sharpeRatio(strategyReturns, riskFreeRate).toFixed(2)),
    sortino: Number(sortinoRatio(strategyReturns, riskFreeRate).toFixed(2)),
    trades: trades.length,
    winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(2)) : 0,
    profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit ? 99 : 0,
    avgHoldSessions: trades.length ? Number((trades.reduce((a, t) => a + t.holdSessions, 0) / trades.length).toFixed(1)) : 0,
    avgTradeReturn: closedReturns.length ? Number(((closedReturns.reduce((a, b) => a + b, 0) / closedReturns.length) * 100).toFixed(2)) : 0,
    bestTrade: closedReturns.length ? Number((Math.max(...closedReturns) * 100).toFixed(2)) : 0,
    worstTrade: closedReturns.length ? Number((Math.min(...closedReturns) * 100).toFixed(2)) : 0,
    benchmarkReturn: Number((benchmarkReturn * 100).toFixed(2)),
    excessReturn: Number(((totalReturn - benchmarkReturn) * 100).toFixed(2)),
    finalEquity: Number(finalEquity.toFixed(2))
  };
}

/**
 * In-sample / out-of-sample split. Params are chosen on the first `splitRatio`
 * of the timeline and then re-run unchanged on the remainder, which is the
 * cheapest honest check that a factor is not pure curve-fitting.
 */
export function walkForwardValidation(config, splitRatio = 0.7) {
  const calendar = config.calendar || buildCalendar(config.history);
  const splitIndex = Math.max(1, Math.min(calendar.length - 2, Math.floor(calendar.length * splitRatio)));
  const splitDate = calendar[splitIndex];

  const inSample = runBacktest({ ...config, calendar, endDate: splitDate });
  const outOfSample = runBacktest({ ...config, calendar, startDate: splitDate });

  return {
    splitDate,
    splitRatio,
    inSample: summarize(inSample, { label: "样本内" }),
    outOfSample: summarize(outOfSample, { label: "样本外" }),
    curve: outOfSample.curve
  };
}

export { computeIndicators, percentile };
