// US treasury yields for the A-share "明日参考" board.
//
// Why a second source at all: the rest of the dashboard is Sina/Eastmoney, but
// neither exposes a usable US treasury series (Sina returns "" for every
// gb_$tnx / znb_* bond symbol, and the Eastmoney quote API returns data:null for
// 100.US10Y). FRED publishes the exact same numbers as a plain CSV with no key
// and no quota, so that is the source of record here.
//
// A yield moving from 5.19 to 5.10 is "-0.09pp" = "-9bp": never a percentage
// change, and never silently treated as one.

/** @typedef {{date:string, value:number}} MacroPoint */

export const MACRO_DEFINITIONS = [
  { symbol: "us10y", name: "美国10年期国债", group: "美债", fredId: "DGS10", digits: 3, unit: "%" },
  { symbol: "us2y", name: "美国2年期国债", group: "美债", fredId: "DGS2", digits: 3, unit: "%" },
  { symbol: "us30y", name: "美国30年期国债", group: "美债", fredId: "DGS30", digits: 3, unit: "%" },
  { symbol: "fedfunds", name: "联邦基金有效利率", group: "美债", fredId: "DFF", digits: 3, unit: "%" },
  // VIX is a level, not a rate: its change is a percentage, never basis points.
  { symbol: "vix", name: "VIX 波动率指数", group: "风险", fredId: "VIXCLS", digits: 2, unit: "", level: true }
];

export const SPREAD_DEFINITION = {
  symbol: "us10y2y",
  name: "美债10Y-2Y利差",
  group: "美债",
  digits: 3,
  unit: "pp"
};

const round = (value, digits = 4) => Number(Number(value).toFixed(digits));

/**
 * Parse a FRED CSV download. "." is FRED's holiday marker, so those rows drop.
 * @param {string} text
 * @returns {MacroPoint[]} ascending by date
 */
export function parseFredCsv(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const points = [];
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.toLowerCase().startsWith("observation_date")) continue;
    const [date, value] = line.split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    points.push({ date, value: parsed });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

/**
 * Turn a raw series into the display item the API hands to the browser.
 * @param {{symbol:string,name:string,group:string,digits:number,unit:string}} definition
 * @param {MacroPoint[]} series ascending
 */
export function buildMacroItem(definition, series) {
  const points = Array.isArray(series) ? series.filter((point) => Number.isFinite(point?.value)) : [];
  if (!points.length) return null;
  const last = points[points.length - 1];
  const previous = points.length > 1 ? points[points.length - 2] : null;
  const change = previous ? round(last.value - previous.value) : null;
  const isLevel = definition.level === true;
  return {
    symbol: definition.symbol,
    name: definition.name,
    group: definition.group,
    kind: isLevel ? "level" : "rate",
    digits: definition.digits,
    unit: definition.unit,
    value: round(last.value, 4),
    prevValue: previous ? round(previous.value, 4) : null,
    change,
    // Basis points is how a rate desk actually talks about a yield move — and it
    // is meaningless for an index level, which gets a percentage instead.
    changeBp: !isLevel && change !== null ? round(change * 100, 2) : null,
    changePct: isLevel && previous && previous.value ? round((change / previous.value) * 100, 2) : null,
    updatedAt: last.date
  };
}

/** 10Y minus 2Y: positive = normal curve, negative = inverted (recession signal). */
export function buildTermSpread(seriesBySymbol = {}) {
  const long = seriesBySymbol.us10y;
  const short = seriesBySymbol.us2y;
  if (!Array.isArray(long) || !Array.isArray(short) || !long.length || !short.length) return null;
  // Align on the newest date both legs publish — FRED occasionally lags one leg.
  const shortByDate = new Map(short.map((point) => [point.date, point.value]));
  const aligned = [];
  for (const point of long) {
    const other = shortByDate.get(point.date);
    if (Number.isFinite(other)) aligned.push({ date: point.date, value: round(point.value - other) });
  }
  return aligned;
}

/**
 * @param {object} input
 * @param {Record<string, MacroPoint[]>} input.seriesBySymbol
 * @param {string} [input.source]
 * @param {string} [input.sourceLabel]
 * @param {Date} [input.now]
 * @param {number} [input.historyPoints] how many tail points to keep per series
 */
export function buildMacroPayload({
  seriesBySymbol = {},
  source = "fred",
  sourceLabel = "FRED 美债与波动率",
  now = new Date(),
  historyPoints = 30
} = {}) {
  const items = [];
  const series = {};
  for (const definition of MACRO_DEFINITIONS) {
    const points = seriesBySymbol[definition.symbol] ?? [];
    const item = buildMacroItem(definition, points);
    if (!item) continue;
    items.push(item);
    series[definition.symbol] = points.slice(-historyPoints);
  }

  const spreadSeries = buildTermSpread(seriesBySymbol);
  if (spreadSeries && spreadSeries.length) {
    const spreadItem = buildMacroItem(SPREAD_DEFINITION, spreadSeries);
    if (spreadItem) items.push({ ...spreadItem, derived: "us10y - us2y" });
    series[SPREAD_DEFINITION.symbol] = spreadSeries.slice(-historyPoints);
  }

  const latest = items.map((item) => item.updatedAt).filter(Boolean).sort().at(-1) ?? null;

  return {
    generatedAt: now.toISOString(),
    updatedAt: latest,
    source,
    sourceLabel,
    count: items.length,
    items,
    series,
    note:
      "美国国债收益率来自 FRED（DGS10 / DGS2 / DGS30 / DFF），VIX 来自 VIXCLS，收盘后一个交易日更新；" +
      "rate 类 item 用 change（百分点差）与 changeBp（基点），level 类用 changePct；收益率是利率不是价格，没有涨跌幅概念。"
  };
}
