import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "127.0.0.1";
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

function getStockDetail(stock, allStocks) {
  const boardPeers = allStocks
    .filter((item) => item.board === stock.board && item.code !== stock.code && item.changePct !== null)
    .sort((a, b) => Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0))
    .slice(0, 8);

  return {
    ...stock,
    signalType: getSignalType(stock),
    reason: getSignalReason(stock),
    score: Number(getStockScore(stock).toFixed(2)),
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
    return json(res, 200, getStockDetail(stock, stocks));
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
  console.log(`StockRadar is running at http://${HOST}:${PORT}`);
});
