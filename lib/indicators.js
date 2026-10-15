// Technical indicators used by the radar's scoring, chart overlays and
// backtester. Every series function returns an array aligned to the input:
// `null` during the warm-up window, numbers afterwards.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (prev === null) {
      // Seed with the first value so short series still produce output.
      prev = value;
    } else {
      prev = value * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 1) return out;
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += values[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) variance += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}

/** Bollinger Bands. `mult` is the standard-deviation multiplier (2 by default). */
export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const sd = stdev(values, period);
  return values.map((_, i) => {
    if (mid[i] === null || sd[i] === null) return { mid: null, upper: null, lower: null, width: null, percentB: null };
    const upper = mid[i] + mult * sd[i];
    const lower = mid[i] - mult * sd[i];
    const span = upper - lower;
    return {
      mid: mid[i],
      upper,
      lower,
      width: mid[i] ? (span / mid[i]) * 100 : null,
      percentB: span ? ((values[i] - lower) / span) * 100 : 50
    };
  });
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const dif = values.map((_, i) => (fastEma[i] === null || slowEma[i] === null ? null : fastEma[i] - slowEma[i]));
  const clean = dif.map((v) => v ?? 0);
  const dea = ema(clean, signal);
  return values.map((_, i) => {
    if (dif[i] === null || dea[i] === null) return { dif: null, dea: null, hist: null };
    return { dif: dif[i], dea: dea[i], hist: (dif[i] - dea[i]) * 2 };
  });
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;
    gain = (gain * (period - 1) + up) / period;
    loss = (loss * (period - 1) + down) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** KDJ (随机指标). */
export function kdj(highs, lows, closes, period = 9, kSmooth = 3, dSmooth = 3) {
  const k = new Array(closes.length).fill(null);
  const d = new Array(closes.length).fill(null);
  const j = new Array(closes.length).fill(null);
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < closes.length; i += 1) {
    if (i < period - 1) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let n = i - period + 1; n <= i; n += 1) {
      if (highs[n] > hi) hi = highs[n];
      if (lows[n] < lo) lo = lows[n];
    }
    const rsv = hi === lo ? 50 : ((closes[i] - lo) / (hi - lo)) * 100;
    prevK = (prevK * (kSmooth - 1) + rsv) / kSmooth;
    prevD = (prevD * (dSmooth - 1) + prevK) / dSmooth;
    k[i] = prevK;
    d[i] = prevD;
    j[i] = 3 * prevK - 2 * prevD;
  }
  return { k, d, j };
}

/** Average True Range — used for volatility-scaled stops. */
export function atr(highs, lows, closes, period = 14) {
  const tr = closes.map((close, i) => {
    if (i === 0) return highs[i] - lows[i];
    const prevClose = closes[i - 1];
    return Math.max(highs[i] - lows[i], Math.abs(highs[i] - prevClose), Math.abs(lows[i] - prevClose));
  });
  return ema(tr, period);
}

export function dailyReturns(closes) {
  const out = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1]) out[i] = closes[i] / closes[i - 1] - 1;
  }
  return out;
}

/** Annualised realised volatility from daily returns (252 trading days). */
export function realizedVolatility(closes, period = 20) {
  const returns = dailyReturns(closes);
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i += 1) {
    const window = [];
    for (let n = i - period + 1; n <= i; n += 1) if (returns[n] !== null) window.push(returns[n]);
    if (window.length < period - 1) continue;
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
    out[i] = Math.sqrt(variance) * Math.sqrt(252);
  }
  return out;
}

/** Trailing return over `period` bars, in percent. */
export function momentum(closes, period = 20) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i += 1) {
    const base = closes[i - period];
    if (base) out[i] = (closes[i] / base - 1) * 100;
  }
  return out;
}

export function maxDrawdown(equity) {
  let peak = -Infinity;
  let worst = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    if (peak > 0) {
      const drawdown = value / peak - 1;
      if (drawdown < worst) worst = drawdown;
    }
  }
  return worst;
}

/** Annualised Sharpe ratio from a series of daily returns. */
export function sharpeRatio(returns, riskFreeRate = 0.02) {
  const clean = returns.filter((r) => Number.isFinite(r));
  if (clean.length < 2) return 0;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / (clean.length - 1);
  const sd = Math.sqrt(variance);
  if (!sd) return 0;
  return ((mean - riskFreeRate / 252) / sd) * Math.sqrt(252);
}

export function sortinoRatio(returns, riskFreeRate = 0.02) {
  const clean = returns.filter((r) => Number.isFinite(r));
  if (clean.length < 2) return 0;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const downside = clean.filter((r) => r < 0);
  if (!downside.length) return 0;
  const dd = Math.sqrt(downside.reduce((a, b) => a + b ** 2, 0) / clean.length);
  if (!dd) return 0;
  return ((mean - riskFreeRate / 252) / dd) * Math.sqrt(252);
}

export function percentile(values, p) {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = (clean.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return clean[lower];
  return clean[lower] + (clean[upper] - clean[lower]) * (index - lower);
}

/**
 * Everything the UI and the scoring engine need for one stock, computed from
 * its daily bars. Returns `null` fields when there is not enough history.
 */
export function computeIndicators(bars, options = {}) {
  const { bollPeriod = 20, bollMult = 2, rsiPeriod = 14, macdFast = 12, macdSlow = 26, macdSignal = 9 } = options;
  if (!Array.isArray(bars) || bars.length === 0) return null;

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume ?? 0);
  const last = bars.length - 1;

  const ma = {
    5: sma(closes, 5),
    10: sma(closes, 10),
    15: sma(closes, 15),
    20: sma(closes, 20),
    30: sma(closes, 30),
    60: sma(closes, 60),
    120: sma(closes, 120),
    250: sma(closes, 250)
  };
  const boll = bollinger(closes, bollPeriod, bollMult);
  const macdSeries = macd(closes, macdFast, macdSlow, macdSignal);
  const rsiSeries = rsi(closes, rsiPeriod);
  const kdjSeries = kdj(highs, lows, closes);
  const atrSeries = atr(highs, lows, closes);
  const vol = realizedVolatility(closes, 20);
  const vol5 = realizedVolatility(closes, 5);
  const vol60 = realizedVolatility(closes, 60);
  const returns = dailyReturns(closes);
  const volumeMa5 = sma(volumes, 5);
  const volumeMa20 = sma(volumes, 20);

  const pick = (series) => (last >= 0 ? series[last] : null);
  const round = (value, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

  return {
    bars: bars.length,
    lastDate: bars[last].date,
    close: closes[last],
    ma: Object.fromEntries(Object.entries(ma).map(([period, series]) => [period, round(pick(series))])),
    maSeries: ma,
    boll: boll[last],
    bollSeries: boll,
    macd: macdSeries[last],
    macdSeries,
    rsi: round(pick(rsiSeries)),
    rsiSeries,
    kdj: { k: round(pick(kdjSeries.k)), d: round(pick(kdjSeries.d)), j: round(pick(kdjSeries.j)) },
    kdjSeries,
    atr: round(pick(atrSeries)),
    atrPct: round(pick(atrSeries) && closes[last] ? (pick(atrSeries) / closes[last]) * 100 : null),
    volatility20: round(pick(vol) === null ? null : pick(vol) * 100),
    volatility5: round(pick(vol5) === null ? null : pick(vol5) * 100),
    volatility60: round(pick(vol60) === null ? null : pick(vol60) * 100),
    momentum: {
      5: round(momentum(closes, 5)[last]),
      10: round(momentum(closes, 10)[last]),
      20: round(momentum(closes, 20)[last]),
      60: round(momentum(closes, 60)[last]),
      120: round(momentum(closes, 120)[last])
    },
    volumeRatio: round(volumeMa20[last] ? volumes[last] / volumeMa20[last] : null),
    volumeMa5: round(pick(volumeMa5), 0),
    volumeMa20: round(pick(volumeMa20), 0),
    returns,
    series: { closes, highs, lows, volumes }
  };
}
