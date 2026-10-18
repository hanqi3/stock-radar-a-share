// Technical read of a single stock.
//
// The indicator maths lives in lib/indicators.js; this module is the analyst on
// top of it: it looks at the same numbers a trading desk would, turns each one
// into a signal with a direction and a plain-language note, weighs them into a
// 0-100 bias, and writes the two or three sentences a person would say.
//
// Deterministic and auditable on purpose - no model, no black box. Every point
// of the score can be traced to a line in `reasons`.

const BANDS = [
  { min: 70, label: "强势", tone: "positive" },
  { min: 56, label: "偏强", tone: "positive" },
  { min: 45, label: "震荡", tone: "neutral" },
  { min: 30, label: "偏弱", tone: "negative" },
  { min: -Infinity, label: "弱势", tone: "negative" }
];

const TONE = { positive: "positive", negative: "negative", neutral: "neutral" };

function num(value) {
  return Number.isFinite(value) ? value : null;
}

function pct(value, digits = 2) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : "—";
}

function price(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

function toneOf(direction) {
  return direction > 0 ? TONE.positive : direction < 0 ? TONE.negative : TONE.neutral;
}

/** Where the close sits inside the last `days` highs and lows, 0-1. */
export function rangePosition(bars, days = 20) {
  const window = bars.slice(-days);
  if (window.length === 0) return null;
  const highs = window.map((bar) => bar.high).filter((value) => Number.isFinite(value));
  const lows = window.map((bar) => bar.low).filter((value) => Number.isFinite(value));
  const close = window[window.length - 1].close;
  if (!highs.length || !lows.length || !Number.isFinite(close)) return null;
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  if (!(high > low)) return null;
  return Number(((close - low) / (high - low)).toFixed(4));
}

/**
 * @param {object} indicators   the snapshot from computeIndicators()
 * @param {Array}  bars         the same bars it was computed from, oldest first
 * @param {object} options      { phase, limitPct, name }
 * @returns {object|null}
 */
export function buildTechnicalView(indicators, bars, options = {}) {
  if (!indicators || !Array.isArray(bars) || bars.length < 2) return null;
  const { phase = "postclose", limitPct = 10 } = options;
  const last = bars[bars.length - 1];
  const close = num(indicators.close) ?? num(last.close);
  if (!Number.isFinite(close) || close <= 0) return null;

  const signals = [];
  const reasons = [];
  let score = 50;

  const add = (points, text) => {
    score += points;
    if (text) reasons.push(points === 0 ? text : `${text}（${points > 0 ? "+" : ""}${points}）`);
  };

  // --- trend: moving-average stack ---------------------------------------
  const ma = indicators.ma || {};
  const ma5 = num(ma[5]);
  const ma10 = num(ma[10]);
  const ma20 = num(ma[20]);
  const ma60 = num(ma[60]);
  if (Number.isFinite(ma5) && Number.isFinite(ma10) && Number.isFinite(ma20)) {
    const stacked = ma5 > ma10 && ma10 > ma20;
    const inverted = ma5 < ma10 && ma10 < ma20;
    const above20 = Number.isFinite(ma20) && close > ma20;
    const gap20 = Number.isFinite(ma20) && ma20 > 0 ? ((close - ma20) / ma20) * 100 : null;
    let points = 0;
    if (stacked) points += 8;
    else if (inverted) points -= 8;
    if (above20) points += 4;
    else points -= 4;
    if (Number.isFinite(ma60)) points += close > ma60 ? 3 : -3;
    signals.push({
      key: "ma",
      label: "均线",
      value: stacked ? "多头排列" : inverted ? "空头排列" : "交织",
      tone: toneOf(points),
      note:
        `MA5 ${price(ma5)} / MA10 ${price(ma10)} / MA20 ${price(ma20)}` +
        (gap20 === null ? "" : `，收盘距 MA20 ${gap20 >= 0 ? "+" : ""}${gap20.toFixed(2)}%`)
    });
    add(points, stacked ? "均线多头排列，回踩不破仍属强势结构" : inverted ? "均线空头排列，反弹先看压制" : "均线交织，方向尚未选择");
  }

  // --- MACD ---------------------------------------------------------------
  const macd = indicators.macd || {};
  if (Number.isFinite(macd.hist) || (Number.isFinite(macd.dif) && Number.isFinite(macd.dea))) {
    const hist = num(macd.hist);
    const above = Number.isFinite(macd.dif) && Number.isFinite(macd.dea) ? macd.dif >= macd.dea : null;
    let points = 0;
    if (Number.isFinite(hist)) points += hist > 0 ? 6 : hist < 0 ? -6 : 0;
    if (above === true) points += 2;
    else if (above === false) points -= 2;
    signals.push({
      key: "macd",
      label: "MACD",
      value: Number.isFinite(hist) ? (hist > 0 ? "柱翻红" : "柱翻绿") : "—",
      tone: toneOf(points),
      note: `DIF ${Number.isFinite(macd.dif) ? macd.dif.toFixed(3) : "—"} / DEA ${Number.isFinite(macd.dea) ? macd.dea.toFixed(3) : "—"} / 柱 ${Number.isFinite(hist) ? hist.toFixed(3) : "—"}`
    });
    add(points, Number.isFinite(hist) && hist > 0 ? "MACD 柱在零轴上方，动能仍在多头一侧" : Number.isFinite(hist) ? "MACD 柱为负，短线动能偏弱" : "MACD 数据不足");
  }

  // --- RSI -----------------------------------------------------------------
  if (Number.isFinite(indicators.rsi)) {
    const rsi = indicators.rsi;
    let points = 0;
    let note;
    if (rsi >= 80) {
      points = -6;
      note = `RSI ${rsi.toFixed(1)} 严重超买，追高风险大`;
    } else if (rsi >= 70) {
      points = -3;
      note = `RSI ${rsi.toFixed(1)} 进入超买区，注意冲高回落`;
    } else if (rsi <= 20) {
      points = -2;
      note = `RSI ${rsi.toFixed(1)} 极度超卖，弱趋势里超卖不等于见底`;
    } else if (rsi <= 30) {
      points = 2;
      note = `RSI ${rsi.toFixed(1)} 超卖，存在反弹修复需求`;
    } else if (rsi >= 55) {
      points = 4;
      note = `RSI ${rsi.toFixed(1)} 偏多但未过热`;
    } else if (rsi <= 45) {
      points = -2;
      note = `RSI ${rsi.toFixed(1)} 偏弱`;
    } else {
      note = `RSI ${rsi.toFixed(1)} 中性`;
    }
    signals.push({ key: "rsi", label: "RSI(14)", value: rsi.toFixed(1), tone: toneOf(points), note });
    add(points, note);
  }

  // --- KDJ -----------------------------------------------------------------
  const kdj = indicators.kdj || {};
  if (Number.isFinite(kdj.k) && Number.isFinite(kdj.d)) {
    const golden = kdj.k > kdj.d;
    const extremeHigh = kdj.k > 80;
    const extremeLow = kdj.k < 20;
    let points = golden ? 3 : -3;
    if (extremeHigh) points -= 2;
    if (extremeLow) points += 2;
    const value = golden ? "K 上穿 D" : "K 下穿 D";
    signals.push({
      key: "kdj",
      label: "KDJ",
      value,
      tone: toneOf(points),
      note: `K ${kdj.k.toFixed(1)} / D ${kdj.d.toFixed(1)} / J ${Number.isFinite(kdj.j) ? kdj.j.toFixed(1) : "—"}`
    });
    add(points, golden ? "KDJ 金叉，短线有向上动能" : "KDJ 死叉，短线动能转弱");
  }

  // --- Bollinger -----------------------------------------------------------
  const boll = indicators.boll || {};
  const percentB = num(boll.percentB);
  if (Number.isFinite(percentB)) {
    let points = 0;
    let value;
    let note;
    if (percentB > 1.02) {
      points = -4;
      value = "突破上轨";
      note = `%B ${percentB.toFixed(2)}，价格冲出上轨 ${price(boll.upper)}，容易回落`;
    } else if (percentB >= 0.8) {
      points = 2;
      value = "贴近上轨";
      note = `%B ${percentB.toFixed(2)}，上轨 ${price(boll.upper)} 是短期压力`;
    } else if (percentB < 0) {
      points = 2;
      value = "跌破下轨";
      note = `%B ${percentB.toFixed(2)}，跌破下轨 ${price(boll.lower)}，超卖但需右侧确认`;
    } else if (percentB <= 0.2) {
      points = 1;
      value = "贴近下轨";
      note = `%B ${percentB.toFixed(2)}，下轨 ${price(boll.lower)} 附近是短线支撑`;
    } else {
      value = "中轨附近";
      note = `%B ${percentB.toFixed(2)}，中轨 ${price(boll.mid)} 是多空分界`;
    }
    signals.push({ key: "boll", label: "布林带", value, tone: toneOf(points), note });
    add(points, note);
  }

  // --- volume --------------------------------------------------------------
  const volumeRatio = num(indicators.volumeRatio);
  if (Number.isFinite(volumeRatio)) {
    const points = volumeRatio >= 1.5 ? 3 : volumeRatio <= 0.6 ? -1 : 0;
    const value = volumeRatio >= 1.5 ? `放量 ${volumeRatio.toFixed(2)}×` : volumeRatio <= 0.6 ? `缩量 ${volumeRatio.toFixed(2)}×` : `量能 ${volumeRatio.toFixed(2)}×`;
    signals.push({
      key: "volume",
      label: "量能",
      value,
      tone: toneOf(points),
      note: `成交量为 20 日均量的 ${volumeRatio.toFixed(2)} 倍（上涨需要量能配合）`
    });
    add(points, volumeRatio >= 1.5 ? "成交显著放量，趋势延续性更强" : volumeRatio <= 0.6 ? "量能萎缩，突破缺乏确认" : "量能中性");
  }

  // --- range position ------------------------------------------------------
  const position = rangePosition(bars, 20);
  if (percentB !== null && Number.isFinite(position)) {
    const points = position >= 0.8 ? 2 : position <= 0.2 ? -2 : 0;
    signals.push({
      key: "range",
      label: "20 日位置",
      value: `${(position * 100).toFixed(0)}%`,
      tone: toneOf(points),
      note: `近 20 个交易日区间内的相对位置（100% 为区间高点）`
    });
    add(points, position >= 0.8 ? "价格位于近 20 日区间上沿" : position <= 0.2 ? "价格位于近 20 日区间下沿" : "价格处于区间中部");
  }

  // --- volatility warning --------------------------------------------------
  if (Number.isFinite(indicators.atrPct)) {
    const atrPct = indicators.atrPct;
    const points = atrPct >= 6 ? -3 : atrPct >= 3 ? -1 : 0;
    signals.push({
      key: "atr",
      label: "波动率 ATR",
      value: `${atrPct.toFixed(2)}%`,
      tone: toneOf(points),
      note: atrPct >= 6 ? "日内波动很大，止损要放宽或降低仓位" : atrPct >= 3 ? "波动偏高，注意仓位管理" : "波动温和"
    });
    add(points, atrPct >= 6 ? "ATR 超过 6%，属于高波动标的" : atrPct >= 3 ? "ATR 偏高，波动风险需要计入" : null);
  }

  // Higher score is bullish; keep it inside the bands so one extreme indicator
  // cannot claim certainty on its own.
  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = BANDS.find((item) => score >= item.min) || BANDS[BANDS.length - 1];

  const levels = buildLevels({ close, bars, indicators, ma20, limitPct });
  const title = phase === "postclose" ? "明日走势" : "今日分析";
  const summary = buildSummary({ band, levels, phase, signals, limitPct });

  return {
    phase,
    title,
    asOf: last.date ?? indicators.lastDate ?? null,
    verdict: { label: band.label, tone: band.tone, score },
    summary,
    signals,
    reasons,
    levels,
    sampleSize: bars.length
  };
}

/** Support / resistance / stop levels, all derived from the same window. */
export function buildLevels({ close, bars, indicators, ma20, limitPct = 10 }) {
  const window = bars.slice(-20);
  const highs = window.map((bar) => bar.high).filter((value) => Number.isFinite(value));
  const lows = window.map((bar) => bar.low).filter((value) => Number.isFinite(value));
  const atr = num(indicators?.atr);
  const boll = indicators?.boll || {};
  const recentHigh = highs.length ? Math.max(...highs) : null;
  const recentLow = lows.length ? Math.min(...lows) : null;
  const supportCandidates = [num(boll.lower), num(ma20), recentLow].filter((value) => Number.isFinite(value) && value < close);
  const resistanceCandidates = [num(boll.upper), recentHigh].filter((value) => Number.isFinite(value) && value > close);
  const support = supportCandidates.length ? Math.max(...supportCandidates) : null;
  const resistance = resistanceCandidates.length ? Math.min(...resistanceCandidates) : null;
  const stop = Number.isFinite(atr) && atr > 0 ? Math.max(close - 2 * atr, (support ?? close - 2 * atr) * 0.995) : support ?? null;
  const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(2)) : null);
  return {
    close: round(close),
    support: round(support),
    resistance: round(resistance),
    stop: round(stop),
    ma20: round(num(ma20)),
    bollUpper: round(num(boll.upper)),
    bollLower: round(num(boll.lower)),
    atr: round(atr),
    limitUp: Number.isFinite(limitPct) ? round(close * (1 + limitPct / 100)) : null,
    limitDown: Number.isFinite(limitPct) ? round(close * (1 - limitPct / 100)) : null
  };
}

function buildSummary({ band, levels, phase, limitPct }) {
  const when = phase === "postclose" ? "下一交易日" : "今日";
  const parts = [];
  const support = levels.support;
  const resistance = levels.resistance;
  if (band.tone === "positive") {
    parts.push(
      Number.isFinite(resistance)
        ? `技术面偏多（${band.label}），${when}关注 ${price(resistance)} 一带的压力`
        : `技术面偏多（${band.label}），价格已在近 20 日区间上沿，${when}上方没有参照压力，留意冲高回落`
    );
    if (Number.isFinite(support)) parts.push(`回踩 ${price(support)} 不破可视为强势整理`);
  } else if (band.tone === "negative") {
    parts.push(
      Number.isFinite(support)
        ? `技术面偏弱（${band.label}），${when}先看 ${price(support)} 的支撑`
        : `技术面偏弱（${band.label}），${when}下方缺少参照支撑，先看能否止跌`
    );
    if (Number.isFinite(resistance)) parts.push(`反弹到 ${price(resistance)} 附近容易遇到抛压`);
  } else {
    const lower = Number.isFinite(support) ? price(support) : "近期低点";
    const upper = Number.isFinite(resistance) ? price(resistance) : "近期高点";
    parts.push(`技术面中性（${band.label}），${when}大概率在 ${lower} - ${upper} 之间震荡`);
    parts.push("方向选择需要成交量配合");
  }
  const bandText = Number.isFinite(limitPct) ? `（涨跌停 ±${limitPct}%）` : "";
  parts.push(`跌破 ${price(levels.stop)} 视为结构走坏${bandText}`);
  return parts.join("；") + "。";
}
