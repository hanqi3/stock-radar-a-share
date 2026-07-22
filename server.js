import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "localhost";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const FULL_DATA_FILE = path.join(DATA_DIR, "all-a-shares.json");
const SAMPLE_DATA_FILE = path.join(DATA_DIR, "sample-a-shares.json");
const META_FILE = path.join(DATA_DIR, "meta.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

let cache = {
  stocks: [],
  meta: {},
  loadedAt: 0,
  sourceFile: null
};

function isFresh() {
  return Date.now() - cache.loadedAt < 15_000 && cache.stocks.length > 0;
}

async function readJson(file) {
  const content = await fs.readFile(file, "utf8");
  return JSON.parse(content);
}

async function loadData() {
  if (isFresh()) return cache;

  let sourceFile = FULL_DATA_FILE;
  try {
    await fs.access(FULL_DATA_FILE);
  } catch {
    sourceFile = SAMPLE_DATA_FILE;
  }

  const stocks = await readJson(sourceFile);
  const meta = await readJson(META_FILE).catch(() => ({}));
  cache = {
    stocks,
    meta: {
      ...meta,
      mode: sourceFile === FULL_DATA_FILE ? "full" : "sample"
    },
    sourceFile,
    loadedAt: Date.now()
  };
  return cache;
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function parseNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatSigned(value, suffix = "") {
  if (value === null || value === undefined) return "暂无";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}${suffix}`;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function getStockScore(stock) {
  const absChange = Math.abs(stock.changePct || 0);
  const turnover = stock.turnover || 0;
  const amountScore = Math.log10(Math.max(stock.amount || 1, 1));
  const capPenalty = stock.marketCap ? Math.min(Math.log10(stock.marketCap) / 20, 1) : 0.3;
  return absChange * 2.2 + turnover * 0.9 + amountScore * 0.7 - capPenalty;
}

function getSignalType(stock) {
  if ((stock.changePct || 0) >= 9.8) return "涨停附近";
  if ((stock.changePct || 0) <= -9.8) return "跌停附近";
  if ((stock.changePct || 0) >= 6) return "强势拉升";
  if ((stock.changePct || 0) <= -6) return "快速回撤";
  if ((stock.turnover || 0) >= 8) return "换手放大";
  if ((stock.amount || 0) >= 5_000_000_000) return "成交活跃";
  return "异动关注";
}

function getSignalReason(stock) {
  const parts = [];
  if (stock.changePct !== null && stock.changePct !== undefined) {
    parts.push(`涨跌幅 ${formatSigned(stock.changePct, "%")}`);
  }
  if (stock.turnover !== null && stock.turnover !== undefined) {
    parts.push(`换手率 ${stock.turnover.toFixed(2)}%`);
  }
  if (stock.amount) {
    parts.push(`成交额 ${formatMoney(stock.amount)}`);
  }
  return parts.join(" · ");
}

function buildSignals(stocks, limit = 60) {
  return stocks
    .filter((stock) => stock.price !== null && stock.changePct !== null)
    .map((stock) => ({
      ...stock,
      signalType: getSignalType(stock),
      reason: getSignalReason(stock),
      score: Number(getStockScore(stock).toFixed(2)),
      sentiment: (stock.changePct || 0) >= 0 ? "positive" : "negative"
    }))
    .filter((stock) => Math.abs(stock.changePct || 0) >= 4 || (stock.turnover || 0) >= 6 || (stock.amount || 0) >= 3_000_000_000)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildOverview(stocks, meta) {
  const tradable = stocks.filter((stock) => stock.price !== null);
  const advancers = tradable.filter((stock) => (stock.changePct || 0) > 0).length;
  const decliners = tradable.filter((stock) => (stock.changePct || 0) < 0).length;
  const flat = tradable.length - advancers - decliners;
  const limitUp = tradable.filter((stock) => (stock.changePct || 0) >= 9.8).length;
  const limitDown = tradable.filter((stock) => (stock.changePct || 0) <= -9.8).length;
  const totalAmount = tradable.reduce((sum, stock) => sum + (stock.amount || 0), 0);

  const byExchange = groupCount(stocks, "exchange");
  const byBoard = groupCount(stocks, "board");
  const hotBoards = Object.entries(
    tradable.reduce((acc, stock) => {
      const key = stock.board || "未分类";
      if (!acc[key]) {
        acc[key] = { board: key, count: 0, changeSum: 0, amount: 0 };
      }
      acc[key].count += 1;
      acc[key].changeSum += stock.changePct || 0;
      acc[key].amount += stock.amount || 0;
      return acc;
    }, {})
  )
    .map(([, item]) => ({
      board: item.board,
      count: item.count,
      avgChangePct: Number((item.changeSum / item.count).toFixed(2)),
      amount: item.amount
    }))
    .sort((a, b) => b.avgChangePct - a.avgChangePct);

  return {
    total: stocks.length,
    tradable: tradable.length,
    advancers,
    decliners,
    flat,
    limitUp,
    limitDown,
    totalAmount,
    byExchange,
    byBoard,
    hotBoards,
    meta
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function forecastToneFromScore(score) {
  if (score >= 8) return "positive";
  if (score <= -8) return "negative";
  return "neutral";
}

function buildForecast(stocks, meta) {
  const tradable = stocks.filter((stock) => stock.price !== null && stock.changePct !== null);
  const changes = tradable.map((stock) => stock.changePct || 0);
  const advancers = tradable.filter((stock) => (stock.changePct || 0) > 0).length;
  const decliners = tradable.filter((stock) => (stock.changePct || 0) < 0).length;
  const limitUp = tradable.filter((stock) => (stock.changePct || 0) >= 9.8).length;
  const limitDown = tradable.filter((stock) => (stock.changePct || 0) <= -9.8).length;
  const strongUp = tradable.filter((stock) => (stock.changePct || 0) >= 6).length;
  const strongDown = tradable.filter((stock) => (stock.changePct || 0) <= -6).length;
  const highTurnover = tradable.filter((stock) => (stock.turnover || 0) >= 8).length;
  const totalAmount = tradable.reduce((sum, stock) => sum + (stock.amount || 0), 0);
  const breadth = tradable.length ? advancers / tradable.length : 0.5;
  const avgChangePct = average(changes);
  const medianChangePct = median(changes);

  const breadthScore = (breadth - 0.5) * 85;
  const avgScore = clamp(avgChangePct * 9, -24, 24);
  const medianScore = clamp(medianChangePct * 7, -18, 18);
  const limitScore = tradable.length ? ((limitUp - limitDown) / tradable.length) * 1200 : 0;
  const momentumScore = tradable.length ? ((strongUp - strongDown) / tradable.length) * 900 : 0;
  const liquidityScore = totalAmount >= 2_000_000_000_000 ? 6 : totalAmount >= 1_200_000_000_000 ? 2 : -4;
  const score = Number(clamp(breadthScore + avgScore + medianScore + limitScore + momentumScore + liquidityScore, -100, 100).toFixed(1));

  const direction =
    score >= 24 ? "偏多延续"
      : score >= 8 ? "震荡偏强"
      : score <= -24 ? "偏弱承压"
      : score <= -8 ? "震荡偏弱"
      : "震荡观察";

  const confidence =
    Math.abs(score) >= 45 ? "中高"
      : Math.abs(score) >= 18 ? "中等"
      : "较低";

  const posture =
    score >= 8 ? "市场短线情绪仍有延续基础，明日更适合观察强势板块是否扩散。"
      : score <= -8 ? "市场短线承压，明日需要观察下跌家数收敛和成交额能否稳定。"
      : "多空线索接近均衡，明日更可能围绕热点轮动和指数震荡展开。";

  const drivers = [
    {
      label: "市场宽度",
      value: `${advancers}/${decliners}`,
      tone: breadth >= 0.52 ? "positive" : breadth <= 0.42 ? "negative" : "neutral",
      detail: `上涨占比 ${(breadth * 100).toFixed(1)}%`
    },
    {
      label: "涨跌停强度",
      value: `${limitUp}/${limitDown}`,
      tone: limitUp > limitDown * 1.4 ? "positive" : limitDown > limitUp * 1.2 ? "negative" : "neutral",
      detail: "涨停附近 / 跌停附近"
    },
    {
      label: "平均涨跌幅",
      value: formatSigned(avgChangePct, "%"),
      tone: avgChangePct > 0 ? "positive" : avgChangePct < 0 ? "negative" : "neutral",
      detail: `中位数 ${formatSigned(medianChangePct, "%")}`
    },
    {
      label: "活跃度",
      value: formatMoney(totalAmount),
      tone: totalAmount >= 2_000_000_000_000 ? "positive" : "neutral",
      detail: `${highTurnover} 只换手率超过 8%`
    }
  ];

  const boardGroups = Object.values(
    tradable.reduce((acc, stock) => {
      const key = stock.board || "未分类";
      if (!acc[key]) acc[key] = { board: key, count: 0, changeSum: 0, amount: 0 };
      acc[key].count += 1;
      acc[key].changeSum += stock.changePct || 0;
      acc[key].amount += stock.amount || 0;
      return acc;
    }, {})
  ).map((item) => ({
    board: item.board,
    count: item.count,
    avgChangePct: Number((item.changeSum / item.count).toFixed(2)),
    amount: item.amount
  }));

  const leadingBoards = [...boardGroups].sort((a, b) => b.avgChangePct - a.avgChangePct).slice(0, 2);
  const laggingBoards = [...boardGroups].sort((a, b) => a.avgChangePct - b.avgChangePct).slice(0, 2);

  return {
    title: "明日方向观察",
    direction,
    score,
    confidence,
    posture,
    drivers,
    leadingBoards,
    laggingBoards,
    risks: [
      "该判断仅基于当日截面行情，不包含隔夜消息、外盘、政策和公告变量。",
      "若明日开盘成交额萎缩或下跌家数继续扩大，方向需要重新评估。"
    ],
    asOf: meta.updatedAt || new Date().toISOString(),
    disclaimer: "仅供公开行情研究，不构成投资建议。"
  };
}

function priceRange(price, lowPct, highPct) {
  if (!price) return "暂无";
  const low = price * (1 + lowPct / 100);
  const high = price * (1 + highPct / 100);
  return `${low.toFixed(2)} - ${high.toFixed(2)}`;
}

function getBoardSnapshot(stock, allStocks) {
  const peers = allStocks.filter((item) => item.board === stock.board && item.price !== null && item.changePct !== null);
  const changes = peers.map((item) => item.changePct || 0);
  const advancers = peers.filter((item) => (item.changePct || 0) > 0).length;
  return {
    count: peers.length,
    avgChangePct: average(changes),
    medianChangePct: median(changes),
    breadth: peers.length ? advancers / peers.length : 0.5
  };
}

function getLiquidityTone(stock) {
  const turnover = stock.turnover || 0;
  const amount = stock.amount || 0;
  if (turnover >= 8 || amount >= 3_000_000_000) return "positive";
  if (turnover >= 3 || amount >= 800_000_000) return "neutral";
  if (turnover < 0.8 || amount < 50_000_000) return "negative";
  return "neutral";
}

function getStockOutlook(stock, allStocks, meta) {
  const price = stock.price;
  if (price === null || price === undefined || stock.changePct === null || stock.changePct === undefined) {
    return {
      title: "个股明日走势",
      horizon: "1-3 个交易日",
      direction: "暂无有效价格",
      score: 0,
      confidence: "低",
      tone: "neutral",
      summary: "该股票当前缺少有效价格或涨跌幅数据，暂不生成交易计划。",
      factors: [],
      strategy: {
        stance: "等待恢复有效报价后再评估。",
        entryZones: [],
        invalidation: "恢复交易后的首个有效收盘价和成交额需要重新确认。",
        riskControl: "缺少报价时不适合做短线计划。",
        reviewPoint: "有连续有效行情后重新评估。"
      },
      scenarios: [],
      risks: ["缺少有效报价，无法判断流动性、波动和次日开盘风险。"],
      asOf: meta.updatedAt || new Date().toISOString(),
      disclaimer: "仅供公开行情研究，不构成投资建议。"
    };
  }

  const marketForecast = buildForecast(allStocks, meta);
  const board = getBoardSnapshot(stock, allStocks);
  const change = stock.changePct || 0;
  const turnover = stock.turnover || 0;
  const amount = stock.amount || 0;
  const relativeToBoard = change - board.avgChangePct;
  const isLimitUp = change >= 9.8;
  const isLimitDown = change <= -9.8;
  const highVolatility = Math.abs(change) >= 6 || turnover >= 10;
  const liquidityScore = amount >= 3_000_000_000 ? 8 : amount >= 800_000_000 ? 4 : amount < 50_000_000 ? -8 : 0;
  const turnoverScore = turnover >= 10 ? 8 : turnover >= 5 ? 5 : turnover < 0.8 ? -5 : 0;
  const boardScore = clamp((board.breadth - 0.5) * 35 + relativeToBoard * 3, -18, 18);
  const marketScore = clamp(marketForecast.score / 4, -14, 14);
  const score = Number(clamp(change * 6 + boardScore + turnoverScore + liquidityScore + marketScore, -100, 100).toFixed(1));

  const direction =
    isLimitUp ? "强势高波动"
      : isLimitDown ? "弱势风险释放"
      : score >= 36 ? "偏强延续"
      : score >= 14 ? "震荡偏强"
      : score <= -36 ? "继续承压"
      : score <= -14 ? "震荡偏弱"
      : "震荡观察";

  const confidence =
    highVolatility ? "较低"
      : Math.abs(score) >= 28 && amount >= 200_000_000 ? "中等"
      : "较低";

  const summary =
    score >= 14 ? `${stock.name} 相对自身板块表现偏强，但明日仍需要成交额和板块同步确认。`
      : score <= -14 ? `${stock.name} 当前短线承压，明日先观察抛压是否收敛和是否出现止跌承接。`
      : `${stock.name} 多空线索接近均衡，明日更适合等待方向选择。`;

  const strategy = buildStrategyPlan({
    stock,
    score,
    isLimitUp,
    isLimitDown,
    highVolatility,
    marketDirection: marketForecast.direction
  });

  return {
    title: "个股明日走势",
    horizon: "1-3 个交易日",
    direction,
    score,
    confidence,
    tone: forecastToneFromScore(score),
    summary,
    factors: [
      {
        label: "个股动量",
        value: formatSigned(change, "%"),
        tone: change > 0 ? "positive" : change < 0 ? "negative" : "neutral",
        detail: getSignalType(stock)
      },
      {
        label: "相对板块",
        value: formatSigned(relativeToBoard, "%"),
        tone: relativeToBoard > 0 ? "positive" : relativeToBoard < 0 ? "negative" : "neutral",
        detail: `${stock.board} 均值 ${formatSigned(board.avgChangePct, "%")}`
      },
      {
        label: "成交活跃",
        value: `${turnover.toFixed(2)}%`,
        tone: getLiquidityTone(stock),
        detail: `成交额 ${formatMoney(amount)}`
      },
      {
        label: "大盘背景",
        value: marketForecast.direction,
        tone: forecastToneFromScore(marketForecast.score),
        detail: `情绪分 ${marketForecast.score}`
      }
    ],
    strategy,
    scenarios: [
      {
        label: "偏多情景",
        condition: "放量走强，且所属板块涨跌幅转强或继续领先。",
        action: "可把它作为观察候选，优先等突破或回踩确认，避免开盘急拉后追高。"
      },
      {
        label: "中性情景",
        condition: "价格围绕最新价窄幅震荡，成交额没有明显放大。",
        action: "保持观察，不主动放大仓位，等待方向和量能给出更清晰信号。"
      },
      {
        label: "偏空情景",
        condition: "低开低走、板块同步转弱，或跌破计划失效区间。",
        action: "以风险控制为先，短线计划降级，等待新的止跌结构。"
      }
    ],
    risks: [
      "该计划只基于当日截面行情，不包含公告、财报、隔夜新闻和历史 K 线。",
      "A股存在涨跌停、停复牌和跳空风险，价格区间只是观察参考，不是保证成交价。",
      "若明日大盘方向与当前判断相反，个股计划需要同步降级。"
    ],
    asOf: meta.updatedAt || new Date().toISOString(),
    disclaimer: "仅供公开行情研究，不构成投资建议。"
  };
}

function buildStrategyPlan({ stock, score, isLimitUp, isLimitDown, highVolatility, marketDirection }) {
  const price = stock.price;

  if (isLimitUp) {
    return {
      stance: "强势股只做承接确认，不把涨停附近视为追高信号。",
      entryZones: [
        {
          label: "开板承接",
          value: priceRange(price, -3, -1),
          detail: "开板或回落后仍有资金承接，再观察是否重新走强。"
        },
        {
          label: "强势确认",
          value: priceRange(price, 1, 3),
          detail: "高位继续放量时只作为动量观察，追高风险较大。"
        }
      ],
      invalidation: `若跌回 ${priceRange(price, -6, -4)} 且成交额放大，短线强势计划失效。`,
      riskControl: "高波动品种需要降低单次试错暴露，避免把涨停情绪当作确定性。",
      reviewPoint: `明日收盘后重点复盘封板质量、换手率和 ${stock.board} 同步性。`
    };
  }

  if (isLimitDown) {
    return {
      stance: "风险释放阶段，不做左侧抄底假设，先等止跌确认。",
      entryZones: [
        {
          label: "止跌观察",
          value: priceRange(price, -2, 1),
          detail: "只有跌势收敛、成交不再失控时才进入观察。"
        },
        {
          label: "修复确认",
          value: priceRange(price, 2, 4),
          detail: "放量收复最新价上方区间，说明抛压可能缓和。"
        }
      ],
      invalidation: `若继续跌破 ${priceRange(price, -6, -4)}，短线仍按弱势处理。`,
      riskControl: "跌停附近容易出现流动性和跳空风险，等待可成交性恢复更重要。",
      reviewPoint: "明日优先观察能否打开流动性和是否出现板块修复。"
    };
  }

  if (score >= 14) {
    return {
      stance: "偏强候选，优先等待突破确认或回撤承接，不追开盘急拉。",
      entryZones: [
        {
          label: "突破确认",
          value: priceRange(price, 1, 3),
          detail: "需要成交额同步放大，且大盘/板块没有明显转弱。"
        },
        {
          label: "回撤承接",
          value: priceRange(price, -3, -1),
          detail: "回落后跌幅收敛，说明短线资金仍有承接。"
        }
      ],
      invalidation: `若跌破 ${priceRange(price, -5, -3)} 且板块同步走弱，偏强计划失效。`,
      riskControl: highVolatility ? "波动已经偏高，策略上更适合小仓位试错和快进快出。" : "只在信号确认后行动，避免单纯因为上涨而追价。",
      reviewPoint: `明日收盘后复盘是否跑赢 ${stock.board}，以及大盘是否仍为${marketDirection}。`
    };
  }

  if (score <= -14) {
    return {
      stance: "防守优先，反弹先看修复质量，不急于左侧介入。",
      entryZones: [
        {
          label: "止跌确认",
          value: priceRange(price, -1, 2),
          detail: "需要下跌家数收敛，个股不再明显弱于板块。"
        },
        {
          label: "右侧修复",
          value: priceRange(price, 3, 5),
          detail: "放量收复上方区间后，才说明短线情绪可能改善。"
        }
      ],
      invalidation: `若跌破 ${priceRange(price, -6, -4)}，弱势计划延续。`,
      riskControl: "承压品种先控制回撤，避免把技术反抽误判为趋势反转。",
      reviewPoint: `明日重点看它能否从弱于 ${stock.board} 转为同步或略强。`
    };
  }

  return {
    stance: "震荡观察，等待方向选择，暂不把它列为强交易信号。",
    entryZones: [
      {
        label: "向上确认",
        value: priceRange(price, 2, 4),
        detail: "突破需要量能配合，否则容易变成冲高回落。"
      },
      {
        label: "向下失守",
        value: priceRange(price, -4, -2),
        detail: "跌入该区间且无承接时，短线需要降级。"
      }
    ],
    invalidation: `若明日收盘仍低于 ${priceRange(price, -4, -2)}，继续等待更清晰结构。`,
    riskControl: "震荡股不适合频繁追涨杀跌，先等价格和成交额给出方向。",
    reviewPoint: "明日收盘后根据突破、失守或继续横盘三种结果重新分类。"
  };
}

function groupCount(stocks, key) {
  return stocks.reduce((acc, stock) => {
    const value = stock[key] || "未知";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function filterStocks(stocks, params) {
  const query = normalizeText(params.get("q"));
  const exchange = params.get("exchange");
  const board = params.get("board");
  const signal = params.get("signal");
  const sort = params.get("sort") || "score";

  let result = stocks;

  if (query) {
    result = result.filter((stock) => {
      const haystack = `${stock.code} ${stock.name} ${stock.exchange} ${stock.board}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  if (exchange && exchange !== "ALL") {
    result = result.filter((stock) => stock.exchange === exchange);
  }

  if (board && board !== "ALL") {
    result = result.filter((stock) => stock.board === board);
  }

  if (signal && signal !== "ALL") {
    result = result.filter((stock) => getSignalType(stock) === signal);
  }

  const sorters = {
    score: (a, b) => getStockScore(b) - getStockScore(a),
    change: (a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity),
    decline: (a, b) => (a.changePct ?? Infinity) - (b.changePct ?? Infinity),
    amount: (a, b) => (b.amount || 0) - (a.amount || 0),
    turnover: (a, b) => (b.turnover || 0) - (a.turnover || 0),
    cap: (a, b) => (b.marketCap || 0) - (a.marketCap || 0),
    code: (a, b) => a.code.localeCompare(b.code)
  };

  return [...result].sort(sorters[sort] || sorters.score);
}

function formatMoney(value) {
  if (!value) return "暂无";
  if (value >= 100_000_000_000) return `${(value / 100_000_000_000).toFixed(2)}千亿`;
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)}万`;
  return `${value}`;
}

function getStockDetail(stock, allStocks, meta) {
  const boardPeers = allStocks
    .filter((item) => item.board === stock.board && item.code !== stock.code && item.changePct !== null)
    .sort((a, b) => Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0))
    .slice(0, 8);

  return {
    ...stock,
    signalType: getSignalType(stock),
    reason: getSignalReason(stock),
    score: Number(getStockScore(stock).toFixed(2)),
    outlook: getStockOutlook(stock, allStocks, meta),
    peers: boardPeers,
    narrative: buildNarrative(stock)
  };
}

function buildNarrative(stock) {
  const pct = stock.changePct ?? 0;
  const absPct = Math.abs(pct);
  const tone = pct >= 0 ? "偏强" : "偏弱";
  const attention =
    absPct >= 9.8 ? "接近涨跌停阈值，适合重点核验公告、板块消息和资金流。"
      : absPct >= 6 ? "日内波动显著，建议结合成交额、换手率和同板块表现确认是否为事件驱动。"
      : (stock.turnover || 0) >= 8 ? "换手率较高，说明筹码交换活跃，需要观察次日延续性。"
      : "波动未达到强异动阈值，可作为普通跟踪对象。";
  return `${stock.name} 当前信号为${tone}，${attention}`;
}

async function handleApi(req, res, pathname, params) {
  const { stocks, meta } = await loadData();

  if (pathname === "/api/health") {
    return json(res, 200, { ok: true, stocks: stocks.length, mode: meta.mode });
  }

  if (pathname === "/api/overview") {
    return json(res, 200, buildOverview(stocks, meta));
  }

  if (pathname === "/api/forecast") {
    return json(res, 200, buildForecast(stocks, meta));
  }

  if (pathname === "/api/signals") {
    const limit = Math.min(parseNumber(params.get("limit"), 60), 200);
    return json(res, 200, { items: buildSignals(stocks, limit), count: stocks.length, meta });
  }

  if (pathname === "/api/stocks") {
    const limit = Math.min(parseNumber(params.get("limit"), 100), 500);
    const offset = Math.max(parseNumber(params.get("offset"), 0), 0);
    const result = filterStocks(stocks, params);
    return json(res, 200, {
      items: result.slice(offset, offset + limit),
      total: result.length,
      limit,
      offset,
      meta
    });
  }

  const stockMatch = pathname.match(/^\/api\/stocks\/([0-9]{6})$/);
  if (stockMatch) {
    const stock = stocks.find((item) => item.code === stockMatch[1]);
    if (!stock) return notFound(res);
    return json(res, 200, getStockDetail(stock, stocks, meta));
  }

  return notFound(res);
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return badRequest(res, "Invalid path");
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(content);
  } catch {
    notFound(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(`StockRadar is running at http://${displayHost}:${PORT}`);
});
