import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { buildSearchIndex, matchesQuery, suggest, EMPTY_LOOKUP } from "./lib/search.js";
import { inferBoard, inferExchange, isRiskWarned, isSt, limitLabel, limitPctFor, limitState } from "./lib/boards.js";
import { computeFactorTable, directionalScore } from "./lib/factors.js";
import { computeIndicators } from "./lib/indicators.js";
import { buildEventImpacts, classifyEvent, THEME_KEYWORDS } from "./lib/events.js";
import { createHistoryCache } from "./lib/history-cache.js";
import { runBacktest, summarize, walkForwardValidation } from "./lib/backtest.js";
import { classifyRegion } from "./lib/news-region.js";
import { buildSectorNews } from "./lib/sector-news.js";
import { buildDigest, digestChanged, mergeDigest } from "./lib/alert-digest.js";
import { buildOutlook } from "./lib/outlook.js";
import { attachActuals, summarizeHistory, toRecord, upsertRecord } from "./lib/outlook-history.js";
import { emptyWatchlist, normalizeCodes, parseWatchlist } from "./lib/watchlist.js";
import { buildTechnicalView } from "./lib/technicals.js";
import { buildAlerts as buildMacroAlerts, formatAlerts } from "./lib/alerts.js";
import { isTradingDay, nextTradingDayDetail } from "./lib/trading-calendar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "localhost";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const FULL_DATA_FILE = path.join(DATA_DIR, "all-a-shares.json");
const SAMPLE_DATA_FILE = path.join(DATA_DIR, "sample-a-shares.json");
const META_FILE = path.join(DATA_DIR, "meta.json");
const INDICATORS_FILE = path.join(DATA_DIR, "indicators.json");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const SECTORS_FILE = path.join(DATA_DIR, "sectors.json");
const INDICES_FILE = path.join(DATA_DIR, "indices.json");
const FLOW_FILE = path.join(DATA_DIR, "flow.json");
const MACRO_FILE = path.join(DATA_DIR, "macro.json");
const OUTLOOK_HISTORY_FILE = path.join(DATA_DIR, "outlook-history.json");
const ALERT_DIGEST_FILE = path.join(DATA_DIR, "alert-digest.json");
const WATCHLIST_FILE = path.join(DATA_DIR, "watchlist.json");
const PINYIN_INDEX_FILE = path.join(__dirname, "lib", "pinyin-index.json");
const HISTORY_CACHE_DIR = process.env.HISTORY_CACHE_DIR || path.join(__dirname, ".cache", "history");
const historyCache = createHistoryCache(HISTORY_CACHE_DIR, { days: 250 });

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
  sourceFile: null,
  searchIndex: new Map(),
  events: []
};

let pinyinLookup = null;

async function loadPinyinLookup() {
  if (pinyinLookup) return pinyinLookup;
  try {
    pinyinLookup = JSON.parse(await fs.readFile(PINYIN_INDEX_FILE, "utf8"));
  } catch {
    // Search still works on codes and Chinese names without the pinyin table.
    pinyinLookup = EMPTY_LOOKUP;
  }
  return pinyinLookup;
}

function isFresh() {
  return Date.now() - cache.loadedAt < 15_000 && cache.stocks.length > 0;
}

async function readJson(file) {
  const content = await fs.readFile(file, "utf8");
  return JSON.parse(content);
}

/**
 * Merge the nightly indicator snapshot into a quote row and add the exchange /
 * board / price-limit facts that every downstream view needs.
 */
function decorateStock(stock, indicators = {}, sector = null, profile = null) {
  const exchange = stock.exchange || inferExchange(stock.code);
  const board = stock.board || inferBoard(stock.code, exchange);
  const merged = {
    ...stock,
    ...indicators,
    code: stock.code,
    name: stock.name,
    exchange,
    board,
    // Real 申万 industry plus concept tags come from data/sectors.json. Until the
    // nightly sector sync has run we fall back to the exchange board so the
    // grouping views keep working.
    industry: sector?.industry || board,
    industries: sector?.industries ?? [],
    concepts: sector?.concepts ?? []
  };
  const state = limitState(merged);
  return {
    ...merged,
    // The quote feed gives price/change; the fundamentals snapshot fills in the
    // rest of what a quote screen shows. Units follow the source: ratios are
    // percentages already scaled (0.62 means 0.62%), caps are yuan.
    open: profile?.open ?? null,
    high: profile?.high ?? null,
    low: profile?.low ?? null,
    prevClose: profile?.prevClose ?? null,
    amplitudePct: profile?.amplitudePct ?? null,
    volumeRatio: profile?.volumeRatio ?? null,
    pe: profile?.peDynamic ?? profile?.peTtm ?? null,
    peStatic: profile?.peStatic ?? null,
    peTtm: profile?.peTtm ?? null,
    pb: profile?.pb ?? null,
    floatMarketCap: profile?.floatMarketCap ?? null,
    limitPct: state.pct,
    limitLabel: state.pct === null ? "无限制" : `±${state.pct}%`,
    limitUpPrice: state.limitUpPrice ?? null,
    limitDownPrice: state.limitDownPrice ?? null,
    limitUp: state.limitUp,
    limitDown: state.limitDown,
    st: isSt(stock.name),
    riskWarned: isRiskWarned(stock.name)
  };
}

async function loadIndicators() {
  try {
    const payload = await readJson(INDICATORS_FILE);
    if (payload && payload.items && typeof payload.items === "object") return payload.items;
    return {};
  } catch {
    return {};
  }
}

/** Fundamentals snapshot (PE, PB, open/high/low, turnover...) keyed by code. */
async function loadProfiles() {
  try {
    const payload = await readJson(PROFILES_FILE);
    if (payload && payload.items && typeof payload.items === "object") {
      return { items: payload.items, generatedAt: payload.generatedAt ?? null, source: payload.source ?? null };
    }
    return { items: {}, generatedAt: null, source: null };
  } catch {
    return { items: {}, generatedAt: null, source: null };
  }
}

async function loadEvents() {
  try {
    const payload = await readJson(EVENTS_FILE);
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.items)) return payload.items;
    return [];
  } catch {
    return [];
  }
}

async function loadIndicesPayload() {
  try {
    const payload = await readJson(INDICES_FILE);
    if (Array.isArray(payload)) return { generatedAt: null, items: payload };
    if (payload && Array.isArray(payload.items)) {
      return { generatedAt: payload.generatedAt ?? null, items: payload.items };
    }
  } catch {
    /* indices.json is optional until the nightly news sync has run once */
  }
  return { generatedAt: null, items: [] };
}

async function loadIndices() {
  return (await loadIndicesPayload()).items;
}

/**
 * Macro tape from scripts/sync-macro.js (UST yields, DXY, Brent, A50 ...).
 * ~4 KB, but it only changes once a day, so a short cache is plenty.
 */
const macroCache = { payload: null, loadedAt: 0 };

async function loadMacroPayload() {
  if (macroCache.payload && Date.now() - macroCache.loadedAt < 30_000) return macroCache.payload;
  try {
    const payload = await readJson(MACRO_FILE);
    if (payload && Array.isArray(payload.items)) {
      macroCache.payload = payload;
      macroCache.loadedAt = Date.now();
      return payload;
    }
  } catch {
    /* macro.json is optional until the nightly macro sync has run once */
  }
  return { generatedAt: null, risk: null, treasuries: [], quotes: [], items: [] };
}

async function loadMacro() {
  return (await loadMacroPayload()).items;
}

/**
 * 「明日参考」self-grading. A record is written from the *served* outlook, and
 * `actual` is attached from the index closes that scripts/sync-outlook-history.js
 * commits. Writing happens only when the day's call is new or a grade lands, so
 * a page refresh does not churn the file.
 */
const OUTLOOK_HISTORY_EMPTY = { generatedAt: null, source: null, closes: {}, records: [] };

async function loadOutlookHistory() {
  try {
    const payload = await readJson(OUTLOOK_HISTORY_FILE);
    return {
      ...OUTLOOK_HISTORY_EMPTY,
      ...payload,
      closes: payload.closes && typeof payload.closes === "object" ? payload.closes : {},
      records: Array.isArray(payload.records) ? payload.records : []
    };
  } catch {
    /* The history file does not exist until the first outlook is served. */
    return { ...OUTLOOK_HISTORY_EMPTY };
  }
}

async function saveOutlookHistory(payload) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(OUTLOOK_HISTORY_FILE, JSON.stringify(payload, null, 1), "utf8");
}

async function recordOutlook(outlook) {
  const store = await loadOutlookHistory();
  const record = toRecord(outlook);
  if (!record) return summarizeHistory(store.records);
  const merged = upsertRecord(attachActuals(store.records, store.closes), record);
  if (JSON.stringify(merged) !== JSON.stringify(store.records)) {
    try {
      await saveOutlookHistory({ ...store, generatedAt: new Date().toISOString(), records: merged });
    } catch {
      /* A read-only checkout still shows the grade, it just cannot persist it. */
    }
  }
  return summarizeHistory(merged);
}

/**
 * The persisted 自选 list. The browser is authoritative while it is open; this
 * file is the copy the scheduled job can read.
 */
async function loadWatchlist() {
  try {
    return parseWatchlist(JSON.parse(await fs.readFile(WATCHLIST_FILE, "utf8")));
  } catch {
    return emptyWatchlist();
  }
}

async function saveWatchlist(codes) {
  const current = await loadWatchlist();
  // Idempotent: the browser republishes its list on every edit and on boot, so
  // an unchanged list must not bump `updatedAt` and dirty the committed file.
  const same = current.codes.length === codes.length && current.codes.every((code, index) => code === codes[index]);
  if (same) return current;
  const payload = { updatedAt: new Date().toISOString(), codes };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(WATCHLIST_FILE, JSON.stringify(payload, null, 1), "utf8");
  return payload;
}

/** Read and parse a JSON request body. Bodies are tiny, so the cap is small. */
function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * The 异动信号 ranking, written out so scripts/notify-alerts.js can push it to a
 * chat webhook. Written only when it changes, so a refresh does not dirty the tree.
 */
async function recordAlertDigest(briefing, stocks) {
  const { codes } = await loadWatchlist();
  const digest = buildDigest(briefing, { watchCodes: codes, stocks });
  if (!digest) return;
  let store = null;
  try {
    store = JSON.parse(await fs.readFile(ALERT_DIGEST_FILE, "utf8"));
  } catch {
    /* First run: there is nothing to diff against yet. */
  }
  const merged = mergeDigest(store, digest);
  if (!digestChanged(store, merged)) return;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(ALERT_DIGEST_FILE, JSON.stringify(merged, null, 1), "utf8");
  } catch {
    /* Same as above: a read-only checkout just cannot persist the digest. */
  }
}

/**
 * Capital-flow snapshot from scripts/sync-flow.js. It is ~1 MB, so it is read
 * once per 15 s instead of once per request.
 */
const flowCache = { payload: null, loadedAt: 0 };

async function loadFlow() {
  if (flowCache.payload && Date.now() - flowCache.loadedAt < 15_000) return flowCache.payload;
  try {
    const payload = await readJson(FLOW_FILE);
    if (payload && Array.isArray(payload.stocks)) {
      flowCache.payload = payload;
      flowCache.loadedAt = Date.now();
      return payload;
    }
  } catch {
    /* flow.json is optional until the nightly flow sync has run once */
  }
  return { generatedAt: null, date: null, stocks: [], industries: [], market: null };
}

async function loadSectors() {
  try {
    const payload = await readJson(SECTORS_FILE);
    if (payload && typeof payload === "object") {
      return {
        industries: Array.isArray(payload.industries) ? payload.industries : [],
        concepts: Array.isArray(payload.concepts) ? payload.concepts : [],
        membership: payload.membership && typeof payload.membership === "object" ? payload.membership : {}
      };
    }
  } catch {
    /* sectors.json is optional until the nightly sync has run once */
  }
  return { industries: [], concepts: [], membership: {} };
}

/** Board id -> display name, plus the per-stock membership map. */
function sectorLookupFor(sectors) {
  const industryNames = new Map();
  const conceptNames = new Map();
  for (const board of sectors.industries) {
    if (board && board.id) industryNames.set(board.id, board.name);
  }
  for (const board of sectors.concepts) {
    if (board && board.id) conceptNames.set(board.id, board.name);
  }
  return { industryNames, conceptNames, membership: sectors.membership };
}

function sectorInfoFor(code, lookup) {
  const entry = lookup.membership[String(code)];
  if (!entry) return null;
  const industries = (entry.industries || []).map((id) => lookup.industryNames.get(id)).filter(Boolean);
  const concepts = (entry.concepts || []).map((id) => lookup.conceptNames.get(id)).filter(Boolean);
  if (!industries.length && !concepts.length) return null;
  return { industry: industries[0] || null, industries, concepts };
}

/**
 * theme -> member codes, so a policy headline about e.g. 半导体 can propagate to
 * the actual constituents instead of only to companies named in the text.
 */
function buildThemeIndex(stocks) {
  const index = new Map();
  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    const codes = [];
    for (const stock of stocks) {
      const name = stock.name || "";
      const industry = stock.industry || "";
      const concepts = stock.concepts || [];
      // Industry and name may match loosely, but a concept has to *be* the
      // keyword: "保险重仓" is a holding-style tag, not the insurance business,
      // and substring matching there dragged banks into the 非银金融 theme.
      const hit = keywords.some(
        (keyword) => industry.includes(keyword) || name.includes(keyword) || concepts.includes(keyword)
      );
      if (hit) codes.push(stock.code);
    }
    if (codes.length) index.set(theme, codes);
  }
  return index;
}

async function loadData() {
  if (isFresh()) return cache;

  let sourceFile = FULL_DATA_FILE;
  try {
    await fs.access(FULL_DATA_FILE);
  } catch {
    sourceFile = SAMPLE_DATA_FILE;
  }

  const [rawStocks, meta, indicators, profiles, events, lookup, sectors] = await Promise.all([
    readJson(sourceFile),
    readJson(META_FILE).catch(() => ({})),
    loadIndicators(),
    loadProfiles(),
    loadEvents(),
    loadPinyinLookup(),
    loadSectors()
  ]);
  const sectorLookup = sectorLookupFor(sectors);

  // The factor table ranks the whole universe at once, so it must be rebuilt
  // from the fully decorated rows rather than per request.
  const stocks = computeFactorTable(
    rawStocks.map((stock) =>
      decorateStock(
        stock,
        indicators[String(stock.code)] || {},
        sectorInfoFor(stock.code, sectorLookup),
        profiles.items[String(stock.code)] || null
      )
    )
  );
  const withTrend = stocks.filter((stock) => Number.isFinite(stock.momentum20)).length;
  const withPe = stocks.filter((stock) => Number.isFinite(stock.pe)).length;

  cache = {
    stocks,
    meta: {
      ...meta,
      mode: sourceFile === FULL_DATA_FILE ? "full" : "sample",
      indicatorCoverage: withTrend,
      profileCoverage: withPe,
      profileCount: Object.keys(profiles.items).length,
      profilesUpdatedAt: profiles.generatedAt,
      eventCount: events.length,
      industryCount: sectors.industries.length,
      conceptCount: sectors.concepts.length
    },
    sourceFile,
    searchIndex: buildSearchIndex(stocks, lookup),
    events,
    themeIndex: buildThemeIndex(stocks),
    loadedAt: Date.now()
  };
  return cache;
}

// --- response plumbing -------------------------------------------------------
//
// The dashboard pulls two multi-megabyte JSON payloads on load (/api/stocks and
// /api/flow), so both compression and revalidation are worth the ten lines:
//   * gzip cuts the big boards by roughly an order of magnitude;
//   * the ETag lets the browser skip the body entirely on reload, which is the
//     common case since the data only changes once a day after the close.

const COMPRESSIBLE_TYPE = /^(?:application\/json|application\/javascript|text\/|image\/svg)/;
const GZIP_MIN_BYTES = 1024;

function etagOf(buffer) {
  return `"${createHash("sha1").update(buffer).digest("base64url").slice(0, 22)}"`;
}

/**
 * Write one response, negotiating gzip and conditional requests.
 *
 * `req` is optional so the existing call sites keep working; without it the
 * response is simply sent uncompressed.
 */
function writeResponse(req, res, statusCode, contentType, body, cacheControl = "no-cache") {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const etag = etagOf(buffer);

  if (req) {
    const ifNoneMatch = String(req.headers["if-none-match"] || "");
    if (ifNoneMatch.split(",").some((entry) => entry.trim() === etag || entry.trim() === "*")) {
      res.writeHead(304, { etag, "cache-control": cacheControl, vary: "accept-encoding" });
      res.end();
      return;
    }
  }

  const acceptsGzip = req && /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""));
  const headers = { "content-type": contentType, "cache-control": cacheControl, etag };
  let payload = buffer;
  if (acceptsGzip && buffer.length >= GZIP_MIN_BYTES && COMPRESSIBLE_TYPE.test(contentType)) {
    payload = zlib.gzipSync(buffer, { level: 6 });
    headers["content-encoding"] = "gzip";
    headers.vary = "accept-encoding";
  }
  headers["content-length"] = payload.length;
  res.writeHead(statusCode, headers);
  res.end(req && req.method === "HEAD" ? undefined : payload);
}

function json(res, statusCode, body) {
  writeResponse(res.req, res, statusCode, "application/json; charset=utf-8", JSON.stringify(body));
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function parseNumber(value, fallback) {
  // Number(null) and Number("") are both 0, which silently turned a missing
  // query parameter into a zero limit (empty result list). Treat absent or
  // blank values as "not provided" and fall back to the default.
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (text === "") return fallback;
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Math.trunc(parseNumber(value, fallback));
  return Math.min(Math.max(parsed, 1), max);
}

function formatSigned(value, suffix = "") {
  if (value === null || value === undefined) return "暂无";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}${suffix}`;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * 0-100 anomaly score. Rank based (see lib/factors.js) whenever the nightly
 * indicator snapshot covers the stock; a legacy absolute formula otherwise, so
 * the endpoint stays useful before the first indicator sync.
 */
function getStockScore(stock) {
  if (Number.isFinite(stock.anomalyScore)) return stock.anomalyScore;
  const absChange = Math.abs(stock.changePct || 0);
  const turnover = stock.turnover || 0;
  const amountScore = Math.log10(Math.max(stock.amount || 1, 1));
  const capPenalty = stock.marketCap ? Math.min(Math.log10(stock.marketCap) / 20, 1) : 0.3;
  const legacy = absChange * 2.2 + turnover * 0.9 + amountScore * 0.7 - capPenalty;
  return Number(Math.max(0, Math.min(100, legacy * 3.2)).toFixed(2));
}

/** Board-aware signal label: a 20% board must not be judged with a 10% ruler. */
function getSignalType(stock) {
  const changePct = stock.changePct || 0;
  if (stock.limitUp) return "涨停";
  if (stock.limitDown) return "跌停";
  const limit = Number.isFinite(stock.limitPct) && stock.limitPct > 0 ? stock.limitPct : 10;
  const ratio = Math.abs(changePct) / limit;
  if (ratio >= 0.6) return changePct > 0 ? "涨停附近" : "跌停附近";
  if (ratio >= 0.35) return changePct > 0 ? "强势拉升" : "快速回撤";
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
  if (Number.isFinite(stock.trendScore)) {
    parts.push(`趋势分 ${stock.trendScore.toFixed(0)}`);
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
      score: getStockScore(stock),
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
  // Board-aware: a 20% board must not be counted with a 10% ruler.
  const limitUp = tradable.filter((stock) => stock.limitUp).length;
  const limitDown = tradable.filter((stock) => stock.limitDown).length;
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
  // Board-aware: a 20% board must not be counted with a 10% ruler.
  const limitUp = tradable.filter((stock) => stock.limitUp).length;
  const limitDown = tradable.filter((stock) => stock.limitDown).length;
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
  const isLimitUp = stock.limitUp === true;
  const isLimitDown = stock.limitDown === true;
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

function filterStocks(stocks, params, searchIndex = null) {
  const query = normalizeText(params.get("q"));
  const exchange = params.get("exchange");
  const board = params.get("board");
  const signal = params.get("signal");
  const sort = params.get("sort") || "score";

  let result = stocks;

  if (query) {
    result = result.filter((stock) => {
      const entry = searchIndex?.get(String(stock.code));
      if (entry) return matchesQuery(entry, query);
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
  const limitPct = Number.isFinite(stock.limitPct) && stock.limitPct > 0 ? stock.limitPct : 10;
  const limitRatio = absPct / limitPct;
  const tone = pct >= 0 ? "偏强" : "偏弱";
  const attention =
    stock.limitUp ? "今日已封涨停，重点核验封单强度、公告事项与板块联动。"
      : stock.limitDown ? "今日已封跌停，注意流动性风险与次日承接情况。"
      : limitRatio >= 0.75 ? `已接近 ${stock.limitLabel || `±${limitPct}%`} 涨跌停阈值，适合重点核验公告、板块消息和资金流。`
      : limitRatio >= 0.4 ? "日内波动显著，建议结合成交额、换手率和同板块表现确认是否为事件驱动。"
      : (stock.turnover || 0) >= 8 ? "换手率较高，说明筹码交换活跃，需要观察次日延续性。"
      : "波动未达到强异动阈值，可作为普通跟踪对象。";
  return `${stock.name} 当前信号为${tone}，${attention}`;
}

function round2(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

// Which session is the reader in? The technical read says "今日分析" before and
// during the session and "明日走势" afterwards, so the wording never promises a
// session that has already happened.
function sessionPhase(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const iso = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  if (!isTradingDay(iso)) return "postclose";
  if (minutes < 9 * 60 + 30) return "preopen";
  if (minutes < 15 * 60) return "intraday";
  return "postclose";
}

/** Candlestick + overlay series, aligned bar-for-bar with the returned bars. */
function chartIndicators(indicators, barCount) {
  if (!indicators) return null;
  const tail = (series, map) => {
    if (!Array.isArray(series)) return null;
    const out = series.slice(-barCount).map(map);
    return out.some((value) => value !== null) ? out : null;
  };
  const ma = {};
  for (const period of [5, 10, 15, 20, 60]) {
    ma[period] = tail(indicators.maSeries?.[period], (value) => round2(value));
  }
  const boll = indicators.bollSeries;
  return {
    ma,
    boll: boll
      ? {
          upper: tail(boll, (item) => round2(item?.upper)),
          middle: tail(boll, (item) => round2(item?.mid)),
          lower: tail(boll, (item) => round2(item?.lower))
        }
      : null,
    macd: indicators.macdSeries
      ? {
          dif: tail(indicators.macdSeries, (item) => round2(item?.dif, 3)),
          dea: tail(indicators.macdSeries, (item) => round2(item?.dea, 3)),
          hist: tail(indicators.macdSeries, (item) => round2(item?.hist, 3))
        }
      : null,
    rsi: tail(indicators.rsiSeries, (value) => round2(value)),
    atr: round2(indicators.atr),
    atrPct: round2(indicators.atrPct),
    volatility20: round2(indicators.volatility20),
    volumeRatio: round2(indicators.volumeRatio),
    momentum: indicators.momentum
  };
}

/**
 * Explainable entry/exit plan. Every number here comes from a named indicator so
 * the UI can show the reasoning instead of a black-box arrow.
 */
function buildTradePlan(stock, indicators, bars) {
  if (!indicators || bars.length < 30) return null;
  const last = (series) => (Array.isArray(series) && series.length ? series[series.length - 1] : null);
  const ma5 = last(indicators.maSeries?.[5]);
  const ma10 = last(indicators.maSeries?.[10]);
  const ma15 = last(indicators.maSeries?.[15]);
  const ma20 = last(indicators.maSeries?.[20]);
  const ma60 = last(indicators.maSeries?.[60]);
  const upper = indicators.boll?.upper ?? null;
  const lower = indicators.boll?.lower ?? null;
  const close = bars[bars.length - 1].close;
  const recent = bars.slice(-20);
  const swingLow = recent.reduce((min, bar) => Math.min(min, bar.low), Infinity);
  const swingHigh = recent.reduce((max, bar) => Math.max(max, bar.high), 0);

  const finite = (value) => Number.isFinite(value);
  const bullish = finite(ma5) && finite(ma10) && finite(ma20) && ma5 >= ma10 && ma10 >= ma20;
  const bearish = finite(ma5) && finite(ma10) && finite(ma20) && ma5 < ma10 && ma10 < ma20;

  const buyZones = [];
  if (finite(ma10)) buyZones.push({ price: round2(ma10), reason: "回踩 MA10 支撑" });
  if (finite(ma20)) buyZones.push({ price: round2(ma20), reason: "回踩 MA20 支撑" });
  if (finite(lower)) buyZones.push({ price: round2(lower), reason: "布林带下轨超卖区" });
  if (finite(upper)) buyZones.push({ price: round2(upper), reason: "突破布林上轨放量确认" });

  const notes = [];
  if (bullish) notes.push("均线多头排列：回踩 MA10 不破可分批建仓");
  if (bearish) notes.push("均线空头排列：反弹到 MA10/MA20 减仓为主");
  if (finite(indicators.rsi) && indicators.rsi >= 70) notes.push(`RSI ${round2(indicators.rsi)} 超买，追高风险大`);
  if (finite(indicators.rsi) && indicators.rsi <= 30) notes.push(`RSI ${round2(indicators.rsi)} 超卖，等待企稳信号`);
  if (finite(indicators.volumeRatio) && indicators.volumeRatio >= 1.8) notes.push(`成交量为 20 日均量 ${round2(indicators.volumeRatio)} 倍，放量`);
  if (finite(indicators.macd?.hist) && indicators.macd.hist > 0) notes.push("MACD 柱翻红");
  if (finite(indicators.macd?.hist) && indicators.macd.hist < 0) notes.push("MACD 柱翻绿");
  if (stock.limitUp) notes.push("今日涨停：明日观察能否连板及封单变化");
  if (stock.limitDown) notes.push("今日跌停：注意流动性风险与次日承接");
  if (stock.st) notes.push(`${stock.name} 为风险警示股，涨跌幅限制 ${limitLabel(stock)}`);

  const stopBase = Math.min(
    finite(swingLow) ? swingLow : close,
    finite(lower) ? lower : close
  );

  return {
    asOf: bars[bars.length - 1].date,
    trend: bullish ? "多头排列" : bearish ? "空头排列" : "均线纠缠",
    trendScore: Number.isFinite(stock.trendScore) ? stock.trendScore : null,
    anomalyScore: Number.isFinite(stock.anomalyScore) ? stock.anomalyScore : null,
    ma: { 5: round2(ma5), 10: round2(ma10), 15: round2(ma15), 20: round2(ma20), 60: round2(ma60) },
    distanceFromMa20Pct: finite(ma20) && ma20 ? round2(((close / ma20) - 1) * 100) : null,
    support: round2(swingLow),
    resistance: round2(swingHigh),
    bollUpper: round2(upper),
    bollLower: round2(lower),
    buyZones: buyZones.slice(0, 4),
    stopLoss: round2(stopBase * 0.98),
    target: round2(finite(upper) ? Math.max(upper, swingHigh) : swingHigh),
    notes
  };
}

/** Industry (or board) aggregation with a relative-strength column. */
function buildSectors(stocks) {
  const groups = new Map();
  for (const stock of stocks) {
    const key = stock.industry || stock.board || "未分类";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(stock);
  }

  const sectors = [...groups.entries()].map(([name, members]) => {
    const priced = members.filter((s) => Number.isFinite(s.price) && Number.isFinite(s.changePct));
    const changes = priced.map((s) => s.changePct);
    const sum = changes.reduce((a, b) => a + b, 0);
    return {
      name,
      count: members.length,
      tradable: priced.length,
      avgChangePct: round2(sum / (changes.length || 1)),
      medianChangePct: round2(median(changes)),
      advancers: changes.filter((c) => c > 0).length,
      limitUp: priced.filter((s) => s.limitUp).length,
      limitDown: priced.filter((s) => s.limitDown).length,
      amount: priced.reduce((total, s) => total + (s.amount || 0), 0),
      momentum20: round2(median(priced.map((s) => s.momentum20).filter(Number.isFinite))),
      topStock: priced.slice().sort((a, b) => (b.changePct || 0) - (a.changePct || 0))[0]?.name ?? null
    };
  });

  const rated = sectors.filter((s) => Number.isFinite(s.avgChangePct));
  const marketAvg = rated.reduce((a, s) => a + s.avgChangePct, 0) / (rated.length || 1);
  for (const sector of sectors) {
    sector.relativeStrength = Number.isFinite(sector.avgChangePct) ? round2(sector.avgChangePct - marketAvg) : null;
  }

  // Sector anomaly screen: a board is "moving abnormally" when its move is a
  // cross-sectional outlier, when its internal breadth is lopsided, or when it
  // is hosting a cluster of limit moves. All three are computed from today's
  // own snapshot so the flag needs no stored history to stay honest.
  const strengths = sectors.map((s) => s.relativeStrength).filter(Number.isFinite);
  const meanStrength = strengths.reduce((a, b) => a + b, 0) / (strengths.length || 1);
  const variance =
    strengths.reduce((total, value) => total + (value - meanStrength) ** 2, 0) / (strengths.length || 1);
  const sdStrength = Math.sqrt(variance) || 1;

  for (const sector of sectors) {
    const z = Number.isFinite(sector.relativeStrength) ? (sector.relativeStrength - meanStrength) / sdStrength : 0;
    const limitMoves = sector.limitUp + sector.limitDown;
    const limitDensity = sector.tradable ? limitMoves / sector.tradable : 0;
    const breadth = sector.tradable ? sector.advancers / sector.tradable : 0.5;

    sector.breadth = round2(breadth * 100);
    sector.anomalyScore = Math.round(
      Math.min(100, Math.abs(z) * 32 + limitDensity * 400 + Math.abs(breadth - 0.5) * 60)
    );

    // Breadth feeds the score but is deliberately not a standalone flag: on a
    // broad market day nearly every board is one-sided, which would flag them all.
    const flags = [];
    const strengthText = `${sector.relativeStrength >= 0 ? "+" : ""}${sector.relativeStrength}pp`;
    if (Math.abs(z) >= 1.8) flags.push(z > 0 ? `逆势领涨 ${strengthText}` : `显著承压 ${strengthText}`);
    if (sector.limitUp >= 3) flags.push(`涨停 ${sector.limitUp} 家`);
    if (sector.limitDown >= 3) flags.push(`跌停 ${sector.limitDown} 家`);
    sector.flags = flags;
  }

  const anomalies = sectors
    .filter((sector) => sector.flags.length > 0)
    .sort((a, b) => b.anomalyScore - a.anomalyScore)
    .slice(0, 8)
    .map((sector) => ({
      name: sector.name,
      anomalyScore: sector.anomalyScore,
      avgChangePct: sector.avgChangePct,
      relativeStrength: sector.relativeStrength,
      flags: sector.flags
    }));

  sectors.sort((a, b) => (b.avgChangePct ?? -Infinity) - (a.avgChangePct ?? -Infinity));
  return { count: sectors.length, marketAvg: round2(marketAvg), sectors, anomalies };
}

function eventView(stocks, events, now = new Date()) {
  if (!events.length) return { impacts: new Map(), themeImpacts: [], classified: [] };
  // Event matching walks every headline against every name once; without this
  // memo the quote list would re-do ~1.7s of work on each poll. Keyed to the
  // data load so a refreshed snapshot drops it immediately.
  if (cache.eventView && cache.eventView.loadedAt === cache.loadedAt && Date.now() - cache.eventView.at < 60_000) {
    return cache.eventView.view;
  }
  const view = buildEventImpacts(events, stocks, { now, themeIndex: cache.themeIndex || new Map() });
  cache.eventView = { at: Date.now(), loadedAt: cache.loadedAt, view };
  return view;
}

/**
 * News matched to one stock. `relevance: "direct"` means the headline actually
 * names the company; theme matches are kept separately because a 白酒 headline
 * must not paint 中国平安 as bearish. The badge only counts headlines with a
 * direction, and prefers company-specific ones over sector chatter.
 */
function eventsForCode(code, view, limit = 8) {
  const impact = view.impacts.get(code);
  if (!impact) {
    return { eventScore: 0, eventBias: 0, items: [], positive: 0, negative: 0, neutral: 0, sentiment: null, scope: null };
  }
  const direct = impact.items.filter((item) => item.relevance === "direct");
  const directional = (list) => list.filter((item) => item.sentiment !== "neutral");
  const directDirectional = directional(direct);
  const themeDirectional = directional(impact.items.filter((item) => item.relevance !== "direct"));
  const basis = directDirectional.length ? directDirectional : themeDirectional;
  const scope = directDirectional.length ? "direct" : themeDirectional.length ? "theme" : null;
  const positive = basis.filter((item) => item.sentiment === "positive").length;
  const negative = basis.filter((item) => item.sentiment === "negative").length;
  const neutral = basis.length - positive - negative;
  const sentiment = positive > negative ? "positive" : negative > positive ? "negative" : positive + negative > 0 ? "mixed" : null;
  return {
    eventScore: impact.eventScore,
    eventBias: impact.eventBias,
    items: impact.items.slice(0, limit),
    positive,
    negative,
    neutral,
    sentiment,
    scope
  };
}

/**
 * Rule-based alert tags for a single stock, combining price action, the limit
 * rules of its board, its indicator snapshot and any matched events.
 */
function buildAlerts(stock, events = { eventScore: 0, eventBias: 0, items: [] }) {
  const alerts = [];
  if (stock.limitUp) alerts.push({ kind: "limit-up", level: "high", label: "涨停" });
  if (stock.limitDown) alerts.push({ kind: "limit-down", level: "high", label: "跌停" });
  if (Number.isFinite(stock.volumeRatio) && stock.volumeRatio >= 2) {
    alerts.push({ kind: "volume", level: "medium", label: `放量 ${round2(stock.volumeRatio)}×` });
  }
  if (Number.isFinite(stock.anomalyScore) && stock.anomalyScore >= 90) {
    alerts.push({ kind: "anomaly", level: "medium", label: `异动分 ${round2(stock.anomalyScore)}` });
  }
  if (Number.isFinite(stock.rsi14)) {
    if (stock.rsi14 >= 80) alerts.push({ kind: "rsi", level: "medium", label: `RSI 超买 ${round2(stock.rsi14)}` });
    else if (stock.rsi14 <= 20) alerts.push({ kind: "rsi", level: "medium", label: `RSI 超卖 ${round2(stock.rsi14)}` });
  }
  if (stock.st) alerts.push({ kind: "st", level: "high", label: "ST 风险警示" });
  else if (stock.riskWarned) alerts.push({ kind: "risk", level: "medium", label: "退市风险警示" });
  if (events.items.length) {
    const bias = events.eventBias;
    alerts.push({
      kind: "event",
      level: Math.abs(bias) >= 2 ? "high" : "low",
      label: `相关事件 ${events.items.length} 条${bias > 0 ? "（偏多）" : bias < 0 ? "（偏空）" : ""}`
    });
  }
  return alerts;
}

async function historyFor(codes, stocks, days) {
  const byCode = new Map(stocks.map((stock) => [String(stock.code), stock]));
  const history = new Map();
  const failures = [];
  const sources = new Set();
  await Promise.all(
    codes.map(async (code) => {
      const stock = byCode.get(String(code));
      if (!stock) {
        failures.push({ code, error: "unknown symbol" });
        return;
      }
      try {
        const record = await historyCache.get(stock.code, stock.exchange, { days });
        if (!record?.bars?.length) {
          failures.push({ code, error: "empty history" });
          return;
        }
        history.set(stock.code, record.bars.slice(-days));
        sources.add(record.source);
      } catch (error) {
        failures.push({ code, error: String(error?.message || error) });
      }
    })
  );
  return { history, failures, sources: [...sources] };
}

/** Momentum + trend signal, evaluated with only the bars visible at that time. */
function momentumSignal(code, bars, index) {
  if (index < 60) return null;
  const closes = bars.map((bar) => bar.close);
  const close = closes[index];
  const past20 = closes[index - 20];
  const past60 = closes[index - 60];
  if (!past20 || !past60) return null;
  const mom20 = (close / past20 - 1) * 100;
  const mom60 = (close / past60 - 1) * 100;
  let sum = 0;
  for (let i = index - 19; i <= index; i += 1) sum += closes[i];
  const ma20 = sum / 20;
  const gap = (close / ma20 - 1) * 100;
  const volume = bars[index].volume || 0;
  let volumeSum = 0;
  for (let i = index - 19; i <= index; i += 1) volumeSum += bars[i].volume || 0;
  const volumeRatio = volumeSum ? (volume / (volumeSum / 20)) : 1;
  return mom20 * 0.8 + mom60 * 0.35 + gap * 1.4 + (volumeRatio - 1) * 2;
}

function selectBacktestUniverse(stocks, codesParam, limit) {
  if (codesParam) {
    return codesParam
      .split(",")
      .map((code) => code.trim())
      .filter(Boolean)
      .slice(0, 60);
  }
  return stocks
    .filter((stock) => Number.isFinite(stock.price) && Number.isFinite(stock.amount) && stock.amount > 0)
    .sort((a, b) => (b.amount || 0) - (a.amount || 0))
    .slice(0, Math.min(limit, 40))
    .map((stock) => stock.code);
}

function backtestQuery(params) {
  const num = (key, fallback, min, max) => {
    const parsed = parseNumber(params.get(key), fallback);
    return Math.min(Math.max(parsed, min), max);
  };
  return {
    topN: Math.trunc(num("topN", 10, 1, 50)),
    minScore: num("minScore", 5, -100, 100),
    holdDays: Math.trunc(num("holdDays", 10, 1, 120)),
    stopLossPct: num("stopLossPct", 0.08, 0.005, 0.5),
    takeProfitPct: num("takeProfitPct", 0.2, 0.01, 3),
    rebalanceDays: Math.trunc(num("rebalanceDays", 1, 1, 30)),
    days: Math.trunc(num("days", 250, 120, 1023)),
    startDate: params.get("startDate") || undefined,
    endDate: params.get("endDate") || undefined
  };
}

async function runBacktestEndpoint(params, stocks) {
  const options = backtestQuery(params);
  const codes = selectBacktestUniverse(stocks, params.get("codes"), options.topN * 2);
  if (codes.length === 0) {
    return { error: "no symbols with history capacity were selected", options };
  }
  const { history, failures, sources } = await historyFor(codes, stocks, options.days);
  if (history.size === 0) {
    return { error: "history unavailable for every requested symbol", failures, options };
  }

  const config = {
    history,
    signal: momentumSignal,
    topN: options.topN,
    minScore: options.minScore,
    holdDays: options.holdDays,
    stopLossPct: options.stopLossPct,
    takeProfitPct: options.takeProfitPct,
    rebalanceDays: options.rebalanceDays,
    startDate: options.startDate,
    endDate: options.endDate
  };

  const result = runBacktest(config);
  const validation = walkForwardValidation(config, 0.7);
  return {
    options,
    universe: [...history.keys()],
    sources,
    failures,
    summary: summarize(result, { label: "全周期" }),
    walkForward: {
      splitDate: validation.splitDate,
      inSample: validation.inSample,
      outOfSample: validation.outOfSample
    },
    curve: result.curve,
    trades: result.trades.slice(-50)
  };
}

/**
 * The "新闻/政策" tab feed: every collected event, classified once, tagged with
 * a region so the UI can render the China and overseas columns side by side.
 */
function buildNewsFeed(events, indices, { limit = 400, q = "" } = {}) {
  const classified = [];
  for (const item of events) {
    if (!item || !item.title) continue;
    const analysis = classifyEvent(item);
    const themes = (analysis.themes || []).map((entry) => entry.theme);
    const haystack = `${item.title} ${item.summary ?? ""} ${themes.join(" ")} ${
      Array.isArray(item.codes) ? item.codes.join(" ") : ""
    }`.toLowerCase();
    if (q && !haystack.includes(q)) continue;
    classified.push({
      id: item.id ?? null,
      kind: item.kind ?? null,
      title: item.title,
      summary: item.summary ?? null,
      url: item.url ?? null,
      source: item.source ?? null,
      publishedAt: item.publishedAt ?? null,
      category: analysis.category,
      sentiment: analysis.sentiment,
      magnitude: analysis.magnitude,
      themes,
      policy: analysis.policy ?? null,
      codes: Array.isArray(item.codes) ? item.codes : [],
      region: classifyRegion(item)
    });
  }

  classified.sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")));
  const items = classified.slice(0, limit);
  const counts = { cn: 0, global: 0 };
  for (const item of classified) counts[item.region] += 1;

  return {
    generatedAt: new Date().toISOString(),
    count: items.length,
    total: classified.length,
    limit,
    query: q,
    counts,
    indices: indices || [],
    items
  };
}

function buildBriefing(stocks, meta, events, now = new Date()) {
  const overview = buildOverview(stocks, meta);
  const forecast = buildForecast(stocks, meta);
  const { sectors, anomalies } = buildSectors(stocks);
  const view = eventView(stocks, events, now);
  const priced = stocks.filter((stock) => Number.isFinite(stock.price) && Number.isFinite(stock.changePct));

  const limitUps = priced.filter((stock) => stock.limitUp);
  const limitDowns = priced.filter((stock) => stock.limitDown);
  const strong = priced
    .filter((stock) => Number.isFinite(stock.anomalyScore))
    .sort((a, b) => b.anomalyScore - a.anomalyScore)
    .slice(0, 10)
    .map((stock) => ({
      code: stock.code,
      name: stock.name,
      board: stock.board,
      price: stock.price,
      changePct: stock.changePct,
      anomalyScore: stock.anomalyScore,
      trendScore: stock.trendScore,
      signalType: getSignalType(stock)
    }));

  const timestamp = now.toISOString();
  const medianChangePct = round2(median(priced.map((stock) => stock.changePct)));
  const topSectors = sectors.slice(0, 3);
  const weakSectors = sectors.slice(-3).reverse();
  const describeSectors = (list) => list.map((s) => `${s.name}(${s.avgChangePct}%)`).join("、");
  // "领涨" only makes sense when the leader is actually up. On a broad down day the
  // best sector is merely the most resilient one, and calling it 领涨 is misleading.
  const sectorLines = [];
  if (topSectors.length) {
    sectorLines.push(
      topSectors[0].avgChangePct > 0
        ? `领涨板块：${describeSectors(topSectors)}。`
        : `抗跌板块（全市场普跌，无一板块收红）：${describeSectors(topSectors)}。`
    );
  }
  if (weakSectors.length) {
    sectorLines.push(
      weakSectors[0].avgChangePct < 0
        ? `领跌板块：${describeSectors(weakSectors)}。`
        : `相对偏弱板块：${describeSectors(weakSectors)}。`
    );
  }
  const lines = [
    `${timestamp.slice(0, 10)} 市场简报：可交易 ${overview.tradable} 只，上涨 ${overview.advancers} 家 / 下跌 ${overview.decliners} 家 / 平盘 ${overview.flat} 家。`,
    `涨停 ${limitUps.length} 家、跌停 ${limitDowns.length} 家；中位涨跌幅 ${medianChangePct}%。`,
    ...sectorLines,
    forecast.summary ? `明日方向：${forecast.summary}` : null,
    view.themeImpacts.length ? `事件主题：${view.themeImpacts.slice(0, 3).map((t) => t.theme).join("、")}。` : null
  ].filter(Boolean);

  return {
    generatedAt: timestamp,
    dataUpdatedAt: meta.updatedAt ?? null,
    source: meta.source ?? null,
    overview,
    forecast,
    sectors: sectors.slice(0, 12),
    laggards: sectors.slice(-6),
    sectorAnomalies: anomalies,
    limitUpCount: limitUps.length,
    limitDownCount: limitDowns.length,
    limitUpSamples: limitUps.slice(0, 12).map((stock) => ({ code: stock.code, name: stock.name, board: stock.board, limitLabel: stock.limitLabel })),
    anomalies: strong,
    themes: view.themeImpacts.slice(0, 10),
    headlines: view.classified.slice(0, 10).map((entry) => ({
      title: entry.title,
      source: entry.source ?? null,
      publishedAt: entry.publishedAt ?? null,
      category: entry.category,
      sentiment: entry.sentiment,
      themes: entry.themes
    })),
    narrative: lines
  };
}

const OVERSEAS_GROUPS = ["美洲", "美股龙头", "亚太欧洲", "外汇", "商品"];

function formatIndexQuote(item) {
  if (!Number.isFinite(item?.price)) return null;
  const pct = Number.isFinite(item.changePct) ? `（${item.changePct > 0 ? "+" : ""}${item.changePct}%）` : "";
  return `${item.name} ${item.price}${pct}`;
}

// The 海外 board needs its own narrative: the A-share briefing says nothing about
// New York, Frankfurt or the dollar. All 35 quotes ride on a single Sina batch.
function buildGlobalBriefing(indices, events, quotesUpdatedAt = null, now = new Date()) {
  const timestamp = now.toISOString();
  // indices.json also carries the domestic benchmarks for the top strip; the
  // 海外 board must not count them as overseas quotes.
  const overseasIndices = indices.filter((item) => OVERSEAS_GROUPS.includes(item.group));
  const grouped = new Map();
  for (const item of overseasIndices) {
    if (!grouped.has(item.group)) grouped.set(item.group, []);
    grouped.get(item.group).push(item);
  }
  const pick = (group, symbols, limit) => {
    const pool = grouped.get(group) ?? [];
    const chosen = symbols ? pool.filter((item) => symbols.includes(item.symbol)) : limit ? pool.slice(0, limit) : pool;
    return chosen.map(formatIndexQuote).filter(Boolean);
  };
  const line = (label, quotes) => (quotes.length ? `${label}：${quotes.join("、")}。` : null);

  const overseas = events.filter((entry) => classifyRegion(entry) === "global");
  overseas.sort((a, b) => new Date(b.publishedAt ?? 0) - new Date(a.publishedAt ?? 0));

  const themeCounts = new Map();
  const classified = new Map();
  for (const entry of overseas) {
    const result = classifyEvent(entry);
    classified.set(entry, result);
    for (const theme of result.themes ?? []) {
      const name = theme.theme ?? theme;
      themeCounts.set(name, (themeCounts.get(name) ?? 0) + 1);
    }
  }
  const themes = [...themeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([theme, count]) => ({ theme, count }));

  const narrative = [
    line("美股三大指数", pick("美洲", ["gb_dji", "gb_inx", "gb_ixic"])),
    line("科技与半导体", pick("美洲", ["gb_ndx", "gb_sox"])),
    line("美股龙头", pick("美股龙头", null, 4)),
    line("亚太与欧洲", pick("亚太欧洲", null, 4)),
    line("外汇", pick("外汇", null, 5)),
    line("大宗商品", pick("商品", null, 6)),
    themes.length ? `海外事件主题：${themes.slice(0, 4).map((entry) => entry.theme).join("、")}。` : null
  ].filter(Boolean);

  return {
    generatedAt: timestamp,
    dataUpdatedAt: quotesUpdatedAt,
    count: overseasIndices.length,
    groups: OVERSEAS_GROUPS.map((group) => ({ group, items: grouped.get(group) ?? [] })).filter((entry) => entry.items.length),
    themes,
    newsCount: overseas.length,
    headlines: overseas.slice(0, 14).map((entry) => {
      const result = classified.get(entry) ?? classifyEvent(entry);
      return {
        title: entry.title,
        source: entry.source ?? null,
        publishedAt: entry.publishedAt ?? null,
        category: result.category,
        sentiment: result.sentiment,
        themes: (result.themes || []).map((theme) => theme.theme ?? theme)
      };
    }),
    narrative
  };
}

async function handleApi(req, res, pathname, params) {
  const { stocks, meta, searchIndex, events } = await loadData();

  if (pathname === "/api/health") {
    return json(res, 200, { ok: true, stocks: stocks.length, mode: meta.mode });
  }

  if (pathname === "/api/search") {
    const q = normalizeText(params.get("q"));
    const limit = parsePositiveInt(params.get("limit"), 10, 50);
    if (!q) return json(res, 200, { query: "", items: [], count: 0, limit });
    const hits = suggest(searchIndex, q, limit);
    const byCode = new Map(stocks.map((stock) => [String(stock.code), stock]));
    const items = hits.map((hit) => {
      const stock = byCode.get(hit.code);
      return {
        code: hit.code,
        name: hit.name,
        exchange: stock?.exchange ?? null,
        board: stock?.board ?? null,
        price: stock?.price ?? null,
        changePct: stock?.changePct ?? null,
        pinyin: hit.pinyin,
        initials: hit.initials
      };
    });
    return json(res, 200, { query: q, items, count: items.length, limit });
  }

  if (pathname === "/api/overview") {
    return json(res, 200, buildOverview(stocks, meta));
  }

  if (pathname === "/api/forecast") {
    return json(res, 200, buildForecast(stocks, meta));
  }

  if (pathname === "/api/sectors") {
    return json(res, 200, { ...buildSectors(stocks), meta });
  }

  if (pathname === "/api/events") {
    const limit = parsePositiveInt(params.get("limit"), 30, 200);
    const view = eventView(stocks, events);
    const classified = view.classified
      .slice()
      .sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")))
      .slice(0, limit);
    return json(res, 200, {
      count: classified.length,
      total: view.classified.length,
      limit,
      themes: view.themeImpacts.slice(0, 20),
      items: classified,
      meta
    });
  }

  if (pathname === "/api/indices") {
    return json(res, 200, { items: await loadIndices() });
  }

  if (pathname === "/api/news") {
    const limit = parsePositiveInt(params.get("limit"), 400, 2000);
    const q = normalizeText(params.get("q")).toLowerCase();
    const indices = await loadIndices();
    return json(res, 200, { ...buildNewsFeed(events, indices, { limit, q }), meta });
  }

  if (pathname === "/api/sector-news") {
    const limit = parsePositiveInt(params.get("limit"), 12, 40);
    const samples = parsePositiveInt(params.get("samples"), 3, 8);
    const { sectors: sectorView } = buildSectors(stocks);
    return json(res, 200, {
      generatedAt: new Date().toISOString(),
      count: sectorView.length,
      items: buildSectorNews(events, stocks, { limit, samplesPerSector: samples }),
      meta
    });
  }

  if (pathname === "/api/macro") {
    const payload = await loadMacroPayload();
    return json(res, 200, { ...payload, meta });
  }

  if (pathname === "/api/outlook") {
    const [flow, indicesPayload, macro] = await Promise.all([
      loadFlow(),
      loadIndicesPayload(),
      loadMacroPayload()
    ]);
    const { sectors: sectorView } = buildSectors(stocks);
    const sectorNews = buildSectorNews(events, stocks, { limit: 31, samplesPerSector: 2 });
    const outlook = buildOutlook({
      stocks,
      meta,
      flow,
      indices: indicesPayload.items,
      macro,
      sectorNews,
      events,
      briefing: buildBriefing(stocks, meta, events),
      sectors: sectorView
    });
    const history = await recordOutlook(outlook);
    return json(res, 200, { ...outlook, history, meta });
  }

  if (pathname === "/api/flow") {
    // `scope` accepts 个股/行业 in either spelling (stock|stocks, industry|industries).
    const scope = String(params.get("scope") || "").toLowerCase().startsWith("ind") ? "industry" : "stock";
    const side = params.get("side") === "outflow" ? "outflow" : "inflow";
    const limit = parsePositiveInt(params.get("limit"), 60, 500);
    const q = normalizeText(params.get("q"));
    const flow = await loadFlow();
    const byCode = new Map(stocks.map((stock) => [String(stock.code), stock]));
    const windows = Array.isArray(flow.windows) && flow.windows.length ? flow.windows : [1, 5, 10, 20, 60, 120, 250];
    // `w` picks which rolling window the ranking is sorted and labelled by. The
    // clamp is deliberately loose so that an out-of-range request falls through
    // to the membership test below and lands on the one-session window, instead
    // of being silently rounded up to the largest stored window.
    const requested = parsePositiveInt(params.get("w"), 1, 1024);
    const window = windows.includes(requested) ? requested : 1;
    const key = `main${window}`;
    const windowKey = `amount${window}`;
    const metric = (row) => row[key] ?? row.mainNet ?? null;
    const head = {
      generatedAt: flow.generatedAt ?? null,
      date: flow.date ?? null,
      sessions: flow.sessions ?? null,
      days: flow.days ?? null,
      window: flow.window ?? null,
      windows,
      w: window,
      source: flow.source ?? null,
      sourceLabel: flow.sourceLabel ?? null,
      definition: flow.definition ?? null,
      note: flow.note ?? null,
      market: flow.market ?? null,
      // The market trend strip always shows the whole stored window, not just the
      // selected rolling window, so `w=1` still draws 60 sessions.
      history: Array.isArray(flow.history) ? flow.history : [],
      scope,
      side,
      query: q,
      limit,
      meta
    };

    if (scope === "industry") {
      const rows = (flow.industries || []).filter((row) => !q || String(row.name || "").includes(q));
      // industries are sorted by net inflow descending, so the outflow side is the tail
      const ordered = rows.slice().sort((a, b) => (metric(b) || 0) - (metric(a) || 0));
      const picked = side === "outflow" ? ordered.slice(-limit).reverse() : ordered.slice(0, limit);
      const items = picked.map((row) => ({
        ...row,
        mainNet: metric(row),
        flow: metric(row),
        amountWindow: row[windowKey] ?? row.amount ?? null
      }));
      return json(res, 200, { ...head, count: items.length, total: rows.length, items });
    }

    const needle = q.toLowerCase();
    // The flow file only carries the first 申万 industry, so keyword hits are
    // widened with the live row's name / industry / concept tags.
    const rows = (flow.stocks || []).filter((row) => {
      if (!needle) return true;
      const stock = byCode.get(String(row.code));
      const haystack = [
        row.name,
        row.code,
        row.industry,
        stock?.name,
        stock?.industry,
        ...(stock?.industries || []),
        ...(stock?.concepts || [])
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
    const ordered = rows.slice().sort((a, b) => (metric(b) || 0) - (metric(a) || 0));
    const picked = side === "outflow" ? ordered.slice(-limit).reverse() : ordered.slice(0, limit);
    const items = picked.map((row) => {
      const stock = byCode.get(String(row.code));
      const sector = stock?.industry && stock.industry !== stock.board ? stock.industry : row.industry;
      const item = {
        code: row.code,
        name: stock?.name ?? row.name ?? null,
        exchange: stock?.exchange ?? row.exchange ?? null,
        board: stock?.board ?? row.board ?? null,
        industry: sector ?? null,
        price: stock?.price ?? row.price ?? null,
        changePct: stock?.changePct ?? row.changePct ?? null,
        mainNet: row.mainNet ?? null,
        flow: metric(row),
        mainRatio: row.mainRatio ?? null,
        superNet: row.superNet ?? null,
        bigNet: row.bigNet ?? null,
        midNet: row.midNet ?? null,
        smallNet: row.smallNet ?? null,
        amount: row.amount ?? null,
        amountWindow: row[windowKey] ?? null,
        sessions: row.sessions ?? null
      };
      for (const candidate of windows) {
        item[`main${candidate}`] = row[`main${candidate}`] ?? null;
        item[`amount${candidate}`] = row[`amount${candidate}`] ?? null;
      }
      return item;
    });
    return json(res, 200, { ...head, count: items.length, total: rows.length, items });
  }

  if (pathname === "/api/watchlist") {
    if (req.method === "PUT" || req.method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      const input = Array.isArray(body) ? body : body?.codes;
      const { codes, rejected, truncated } = normalizeCodes(input);
      if (!codes.length && rejected) {
        return json(res, 400, { error: "codes must be six-digit A-share codes", rejected });
      }
      try {
        const saved = await saveWatchlist(codes);
        return json(res, 200, { ...saved, rejected, truncated, meta });
      } catch {
        return json(res, 500, { error: "Could not persist the watchlist" });
      }
    }
    const query = String(params.get("codes") || "").trim();
    // `?codes=` is the live check of an ad-hoc list; without it, hand back the
    // persisted 自选 the scheduled job reads.
    if (!query) return json(res, 200, { ...(await loadWatchlist()), meta });
    const codes = query
      .split(",")
      .map((code) => code.trim())
      .filter((code) => /^\d{6}$/.test(code))
      .slice(0, 60);
    const view = eventView(stocks, events);
    const byCode = new Map(stocks.map((stock) => [String(stock.code), stock]));
    const items = codes.map((code) => {
      const stock = byCode.get(code);
      if (!stock) return { code, missing: true, alerts: [] };
      const matched = eventsForCode(code, view, 4);
      return {
        ...stock,
        events: matched.items,
        eventScore: matched.eventScore,
        eventBias: matched.eventBias,
        alerts: buildAlerts(stock, matched)
      };
    });
    return json(res, 200, { count: items.length, items, meta });
  }

  // 自选股的利好利空面板：只读当前自选（或 ?codes= 临时列表），把每条消息的
  // 方向、逻辑与原文链接一起给出去，前端不需要再自己归类。
  if (pathname === "/api/watchlist/news") {
    const query = String(params.get("codes") || "").trim();
    const codes = query
      ? query
          .split(",")
          .map((code) => code.trim())
          .filter((code) => /^\d{6}$/.test(code))
          .slice(0, 60)
      : (await loadWatchlist()).codes;
    const byCode = new Map(stocks.map((stock) => [String(stock.code), stock]));
    const view = eventView(stocks, events);
    const items = codes.map((code) => {
      const stock = byCode.get(code);
      const matched = eventsForCode(code, view, 8);
      return {
        code,
        name: stock?.name ?? null,
        price: stock?.price ?? null,
        changePct: stock?.changePct ?? null,
        signalType: stock?.signalType ?? null,
        missing: !stock,
        sentiment: matched.sentiment,
        scope: matched.scope,
        positive: matched.positive,
        negative: matched.negative,
        neutral: matched.neutral,
        items: matched.items.map((item) => ({
          title: item.title,
          url: item.url,
          source: item.source,
          publishedAt: item.publishedAt,
          category: item.category,
          sentiment: item.sentiment,
          relevance: item.relevance,
          detail: item.detail
        }))
      };
    });
    return json(res, 200, { generatedAt: events.generatedAt ?? null, count: items.length, items, meta });
  }

  if (pathname === "/api/alerts") {
    const [indicesPayload, macro] = await Promise.all([loadIndicesPayload(), loadMacroPayload()]);
    const alerts = buildMacroAlerts({ macro, indices: indicesPayload.items });
    const date = nextTradingDayDetail(new Date()).date;
    return json(res, 200, {
      generatedAt: macro.generatedAt ?? null,
      date,
      items: alerts,
      summary: formatAlerts(alerts, date),
      meta
    });
  }

  if (pathname === "/api/briefing") {
    const indicesPayload = await loadIndicesPayload();
    const briefing = buildBriefing(stocks, meta, events);
    await recordAlertDigest(briefing, stocks);
    return json(res, 200, {
      ...briefing,
      overseas: buildGlobalBriefing(indicesPayload.items, events, indicesPayload.generatedAt)
    });
  }

  if (pathname === "/api/briefing/overseas") {
    const indicesPayload = await loadIndicesPayload();
    return json(res, 200, {
      ...buildGlobalBriefing(indicesPayload.items, events, indicesPayload.generatedAt),
      meta
    });
  }

  if (pathname === "/api/backtest") {
    const result = await runBacktestEndpoint(params, stocks);
    return json(res, result.error ? 422 : 200, result);
  }

  const historyMatch = pathname.match(/^\/api\/stocks\/([0-9]{6})\/history$/);
  if (historyMatch) {
    const stock = stocks.find((item) => item.code === historyMatch[1]);
    if (!stock) return notFound(res);
    const requested = parsePositiveInt(params.get("days"), 250, 1023);
    try {
      const record = await historyCache.get(stock.code, stock.exchange, { days: requested });
      const bars = record.bars.slice(-requested);
      const indicators = computeIndicators(bars);
      return json(res, 200, {
        code: stock.code,
        name: stock.name,
        exchange: stock.exchange,
        board: stock.board,
        source: record.source,
        updatedAt: record.updatedAt,
        requestedDays: requested,
        days: bars.length,
        bars,
        indicators: chartIndicators(indicators, bars.length),
        plan: buildTradePlan(stock, indicators, bars)
      });
    } catch (error) {
      return json(res, 502, {
        error: "history unavailable",
        code: stock.code,
        detail: String(error?.message || error)
      });
    }
  }

  const analysisMatch = pathname.match(/^\/api\/stocks\/([0-9]{6})\/analysis$/);
  if (analysisMatch) {
    const stock = stocks.find((item) => item.code === analysisMatch[1]);
    if (!stock) return notFound(res);
    const view = eventView(stocks, events);
    const detail = getStockDetail(stock, stocks, meta);
    const related = eventsForCode(stock.code, view);
    let history = null;
    let technicals = null;
    try {
      const record = await historyCache.get(stock.code, stock.exchange, { days: 250 });
      const bars = record.bars;
      const indicators = computeIndicators(bars);
      history = {
        source: record.source,
        updatedAt: record.updatedAt,
        days: bars.length,
        bars,
        indicators: chartIndicators(indicators, bars.length),
        plan: buildTradePlan(stock, indicators, bars)
      };
      technicals = buildTechnicalView(indicators, bars, {
        phase: sessionPhase(),
        limitPct: limitPctFor(stock)
      });
    } catch (error) {
      history = { error: String(error?.message || error) };
    }
    return json(res, 200, {
      ...detail,
      node: {
        code: stock.code,
        name: stock.name,
        board: stock.board,
        limitLabel: limitLabel(stock),
        st: stock.st,
        factors: stock.factors ?? null,
        anomalyScore: stock.anomalyScore ?? null,
        trendScore: stock.trendScore ?? null,
        directional: directionalScore(stock, 0)
      },
      history,
      technicals,
      events: related
    });
  }

  const stockMatch = pathname.match(/^\/api\/stocks\/([0-9]{6})$/);
  if (stockMatch) {
    const stock = stocks.find((item) => item.code === stockMatch[1]);
    if (!stock) return notFound(res);
    const view = eventView(stocks, events);
    return json(res, 200, {
      ...getStockDetail(stock, stocks, meta),
      node: {
        limitPct: stock.limitPct,
        limitLabel: limitLabel(stock),
        st: stock.st,
        anomalyScore: stock.anomalyScore ?? null,
        trendScore: stock.trendScore ?? null
      },
      events: eventsForCode(stock.code, view, 5)
    });
  }

  if (pathname === "/api/signals") {
    const limit = parsePositiveInt(params.get("limit"), 60, 200);
    return json(res, 200, { items: buildSignals(stocks, limit), count: stocks.length, limit, meta });
  }

  if (pathname === "/api/stocks") {
    const limit = parsePositiveInt(params.get("limit"), 100, 500);
    const offset = Math.max(Math.trunc(parseNumber(params.get("offset"), 0)), 0);
    const result = filterStocks(stocks, params, searchIndex);
    const page = result.slice(offset, offset + limit);
    // Only the page is annotated, so the badge shown next to a name costs one
    // map lookup per row rather than a scan of the whole universe.
    const view = eventView(stocks, events);
    const items = page.map((stock) => {
      const matched = eventsForCode(stock.code, view, 0);
      return {
        ...stock,
        eventBias: matched.eventBias,
        eventSentiment: matched.sentiment,
        eventScope: matched.scope,
        eventPositive: matched.positive,
        eventNegative: matched.negative
      };
    });
    return json(res, 200, {
      items,
      total: result.length,
      limit,
      offset,
      meta
    });
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
    writeResponse(res.req, res, 200, MIME_TYPES[ext] || "application/octet-stream", content);
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
