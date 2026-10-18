// 板块消息面：fold the day's ~900 headlines onto the 31 申万一级 industries and
// count how many land as 利好 vs 利空.
//
// Attribution has two independent legs, and a headline can hit several sectors:
//   1. It names A-share codes  -> those stocks' industries (hard evidence, w=1.0).
//   2. It matches a theme      -> THEME_INDUSTRIES[theme] (a documented mapping,
//      w=0.45 per theme, and only the two strongest themes count) because a
//      keyword hit is weaker evidence than a named code, and a long announcement
//      body mentions half the economy at once.
// Headlines that resolve to neither are dropped rather than smeared across the
// whole market — an unattributed headline is not evidence about any sector.

import { classifyEvent, timeDecay } from "./events.js";

/** theme (lib/events.js THEME_KEYWORDS) -> 申万一级 industries it lands on */
export const THEME_INDUSTRIES = {
  半导体: ["电子"],
  人工智能: ["计算机"],
  机器人: ["机械设备"],
  消费电子: ["电子"],
  新能源车: ["汽车"],
  锂电池: ["电力设备"],
  光伏: ["电力设备"],
  风电: ["电力设备"],
  储能: ["电力设备"],
  电力: ["公用事业"],
  医药生物: ["医药生物"],
  白酒食品: ["食品饮料"],
  银行: ["银行"],
  非银金融: ["非银金融"],
  房地产: ["房地产"],
  建筑基建: ["建筑装饰"],
  军工: ["国防军工"],
  有色金属: ["有色金属"],
  煤炭石油: ["石油石化", "煤炭"],
  钢铁化工: ["钢铁", "基础化工"],
  通信: ["通信"],
  传媒游戏: ["传媒"],
  计算机软件: ["计算机"],
  汽车零部件: ["汽车"],
  家电: ["家用电器"],
  纺织服装: ["纺织服饰"],
  农业: ["农林牧渔"],
  交通运输: ["交通运输"],
  环保: ["环保"],
  旅游消费: ["社会服务", "商贸零售"],
  教育: ["社会服务"],
  零售商贸: ["商贸零售"],
  建材: ["建筑材料"],
  机械: ["机械设备"]
  // 券商概念 is deliberately absent: its keywords (牛市 / 行情 / 成交量) fire on
  // almost every market commentary, which would flood 非银金融 with noise.
};

const CODE_WEIGHT = 1;
const THEME_WEIGHT = 0.45;
const MAX_THEMES = 2;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

function codeToIndustry(stocks) {
  const map = new Map();
  for (const stock of Array.isArray(stocks) ? stocks : []) {
    if (stock?.code) map.set(String(stock.code), stock.industry || stock.board || "未分类");
  }
  return map;
}

/**
 * @param {Array} events raw data/events.json items
 * @param {Array} stocks the decorated stock list (needs code + industry)
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {string[]} [options.industries] restrict output to these industry names
 * @param {number} [options.limit]
 * @param {number} [options.samplesPerSector]
 */
export function buildSectorNews(events, stocks, options = {}) {
  const {
    now = new Date(),
    industries = null,
    limit = 12,
    samplesPerSector = 3,
    halfLifeHours = 20
  } = options;
  const allowed = Array.isArray(industries) && industries.length ? new Set(industries) : null;
  const byCode = codeToIndustry(stocks);
  const buckets = new Map();

  const bucketFor = (industry) => {
    if (allowed && !allowed.has(industry)) return null;
    if (!buckets.has(industry)) {
      buckets.set(industry, { industry, bullish: 0, bearish: 0, neutral: 0, net: 0, events: 0, samples: [] });
    }
    return buckets.get(industry);
  };

  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  for (const item of Array.isArray(events) ? events : []) {
    if (!item?.title) continue;
    // Title-only on purpose: announcement bodies run to thousands of characters
    // and mention half the economy, which would attribute one filing to a dozen
    // sectors. The headline is what actually says which sector it is about.
    const analysis = classifyEvent({ title: item.title });
    const targets = resolveIndustries(item, analysis, byCode);
    if (!targets.length) continue;

    if (analysis.sentiment === "neutral") {
      // Neutral headlines still tell us a sector is in the news, but they carry
      // no direction — count them separately instead of biasing the net.
      for (const { industry } of targets) {
        const bucket = bucketFor(industry);
        if (!bucket) continue;
        bucket.neutral += 1;
        bucket.events += 1;
      }
      continue;
    }

    const decay = timeDecay(item.publishedAt, nowMs, halfLifeHours);
    const direction = analysis.sentiment === "positive" ? 1 : -1;
    const strength = clamp(Math.abs(analysis.sentimentScore), 0.5, 6) * (analysis.magnitude / 10) * decay;
    for (const { industry, via, confidence } of targets) {
      const bucket = bucketFor(industry);
      if (!bucket) continue;
      const weight = round(direction * strength * confidence, 3);
      bucket.events += 1;
      bucket.net = round(bucket.net + weight, 3);
      if (direction > 0) bucket.bullish += 1;
      else bucket.bearish += 1;
      bucket.samples.push({
        title: item.title,
        summary: item.summary ?? null,
        source: item.source ?? null,
        publishedAt: item.publishedAt ?? null,
        sentiment: analysis.sentiment,
        category: analysis.category,
        via,
        weight
      });
    }
  }

  const results = [];
  for (const bucket of buckets.values()) {
    if (!bucket.bullish && !bucket.bearish) continue;
    // A named code outranks a keyword hit, so those headlines lead the samples.
    bucket.samples.sort((a, b) => {
      if (a.via !== b.via) return a.via === "code" ? -1 : 1;
      return Math.abs(b.weight) - Math.abs(a.weight);
    });
    // The same wire story arrives from several providers; show it once.
    const seen = new Set();
    const samples = [];
    for (const sample of bucket.samples) {
      const key = sample.title.replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({
        title: sample.title,
        source: sample.source,
        publishedAt: sample.publishedAt,
        sentiment: sample.sentiment,
        category: sample.category,
        via: sample.via
      });
      if (samples.length >= samplesPerSector) break;
    }
    results.push({
      industry: bucket.industry,
      bullish: bucket.bullish,
      bearish: bucket.bearish,
      neutral: bucket.neutral,
      net: bucket.net,
      heat: round(bucket.bullish + bucket.bearish + bucket.neutral * 0.3, 2),
      samples
    });
  }

  results.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  return results.slice(0, limit);
}

/**
 * Attribute one headline to industries.
 * @returns {{industry:string, via:"code"|"theme", confidence:number}[]}
 */
function resolveIndustries(item, analysis, byCode) {
  const targets = new Map();
  for (const code of Array.isArray(item.codes) ? item.codes : []) {
    const industry = byCode.get(String(code));
    if (industry) targets.set(industry, { industry, via: "code", confidence: CODE_WEIGHT });
  }
  const themes = (analysis.themes ?? []).slice(0, MAX_THEMES);
  for (const entry of themes) {
    const theme = entry.theme ?? entry;
    for (const industry of THEME_INDUSTRIES[theme] ?? []) {
      if (targets.has(industry)) continue; // a named code already pinned this sector
      targets.set(industry, { industry, via: "theme", confidence: THEME_WEIGHT });
    }
  }
  return [...targets.values()];
}
