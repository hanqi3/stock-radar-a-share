// Nightly indicator snapshot.
//
// Two things need history: the chart (fetched on demand and cached) and the
// cross-sectional trend factors (needs *every* stock at once, so it is
// precomputed here and committed as a small file). Daily bars themselves are
// derived data and would bloat the repo, so only the indicator values are kept.
//
//   node scripts/sync-history.js [--days=250] [--concurrency=16] [--limit=100]
//                                [--codes=600519,000001] [--out=data/indicators.json]
//                                [--cache-dir=.cache/history] [--min-coverage=0.8]
//                                [--allow-partial]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeIndicators } from "../lib/indicators.js";
import { createHistoryCache } from "../lib/history-cache.js";
import { inferExchange } from "../lib/boards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const FULL_DATA_FILE = path.join(DATA_DIR, "all-a-shares.json");
const DEFAULT_OUT = path.join(DATA_DIR, "indicators.json");
const DEFAULT_CACHE_DIR = path.join(ROOT, ".cache", "history");

export const DEFAULTS = {
  days: 250,
  concurrency: 16,
  minCoverage: 0.8,
  timeoutMs: 20000,
  maxAttempts: 3
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, allowPartial: false, out: DEFAULT_OUT, cacheDir: DEFAULT_CACHE_DIR, codes: null, limit: null };
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const [, rawKey, rawValue] = match;
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === "allowPartial") {
      options.allowPartial = true;
      continue;
    }
    if (rawValue === undefined) continue;
    if (["days", "concurrency", "limit", "timeoutMs", "maxAttempts"].includes(key)) options[key] = Number(rawValue);
    else if (key === "minCoverage") options.minCoverage = Number(rawValue);
    else if (key === "codes") options.codes = rawValue.split(",").map((c) => c.trim()).filter(Boolean);
    else options[key] = rawValue;
  }
  return options;
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/**
 * Reduce a full indicator set to the handful of numbers the factor table and the
 * stock page actually consume.
 */
export function snapshotFromBars(code, bars) {
  const indicators = computeIndicators(bars);
  if (!indicators) return null;
  const close = indicators.close;
  const ma20 = indicators.ma[20];
  const ma60 = indicators.ma[60];
  return {
    date: indicators.lastDate,
    close: round(close, 3),
    ma5: round(indicators.ma[5], 3),
    ma10: round(indicators.ma[10], 3),
    ma20: round(ma20, 3),
    ma60: round(ma60, 3),
    ma20Gap: Number.isFinite(ma20) && ma20 ? round(((close / ma20) - 1) * 100, 3) : null,
    ma60Gap: Number.isFinite(ma60) && ma60 ? round(((close / ma60) - 1) * 100, 3) : null,
    momentum5: round(indicators.momentum[5], 3),
    momentum20: round(indicators.momentum[20], 3),
    momentum60: round(indicators.momentum[60], 3),
    volatility20: round(indicators.volatility20, 3),
    atrPct: round(indicators.atrPct, 3),
    rsi14: round(indicators.rsi, 2),
    macdHist: indicators.macd ? round(indicators.macd.hist, 4) : null,
    bollPercentB: indicators.boll ? round(indicators.boll.percentB, 2) : null,
    volumeRatio: round(indicators.volumeRatio, 3),
    bars: bars.length
  };
}

/** Median of a numeric list, used for the sector relative-strength column. */
function median(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

/**
 * Fill `industryMomentum20` so the trend factor can measure relative strength
 * within a group. Falls back to the board when no industry is available.
 */
export function attachIndustryMomentum(items, stocks) {
  const byCode = new Map(stocks.map((stock) => [String(stock.code), stock]));
  const groups = new Map();
  for (const [code, item] of Object.entries(items)) {
    const stock = byCode.get(code);
    const key = stock?.industry || stock?.board || "未分类";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.momentum20);
  }
  const medians = new Map();
  for (const [key, values] of groups) medians.set(key, median(values));
  for (const [code, item] of Object.entries(items)) {
    const stock = byCode.get(code);
    const key = stock?.industry || stock?.board || "未分类";
    item.industryMomentum20 = round(medians.get(key), 3);
    item.group = key;
  }
  return items;
}

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, tasks.length)).fill(0).map(async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const started = Date.now();

  const stocks = JSON.parse(await fs.readFile(FULL_DATA_FILE, "utf8"));
  const byCode = new Map(stocks.map((stock) => [String(stock.code), stock]));

  let universe = stocks;
  if (options.codes) {
    universe = options.codes.map((code) => byCode.get(String(code))).filter(Boolean);
  } else if (options.limit) {
    universe = stocks
      .slice()
      .sort((a, b) => (b.amount || 0) - (a.amount || 0))
      .slice(0, options.limit);
  }
  if (universe.length === 0) throw new Error("no symbols selected for the indicator snapshot");

  console.log(`Snapshotting indicators for ${universe.length} symbols (days=${options.days}, concurrency=${options.concurrency})`);

  const cache = createHistoryCache(options.cacheDir, { days: options.days, timeoutMs: options.timeoutMs });
  const items = {};
  const failures = [];

  const tasks = universe.map((stock) => async () => {
    const code = String(stock.code);
    const exchange = stock.exchange || inferExchange(code);
    let lastError = null;
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      try {
        const record = await cache.get(code, exchange, { days: options.days, force: attempt > 1 });
        const snapshot = snapshotFromBars(code, record.bars.slice(-options.days));
        if (!snapshot) throw new Error("no usable bars");
        snapshot.source = record.source;
        items[code] = snapshot;
        return;
      } catch (error) {
        lastError = error;
        if (attempt < options.maxAttempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
    failures.push({ code, name: stock.name, error: String(lastError?.message || lastError) });
  });

  await runPool(tasks, options.concurrency);
  attachIndustryMomentum(items, stocks);

  const coverage = universe.length ? Object.keys(items).length / universe.length : 0;
  const payload = {
    generatedAt: new Date().toISOString(),
    days: options.days,
    requested: universe.length,
    succeeded: Object.keys(items).length,
    failed: failures.length,
    coverage: Number(coverage.toFixed(4)),
    note: "Derived from daily K-lines (Sina primary, Tencent fallback). Bars are cached locally, not committed.",
    failures: failures.slice(0, 50),
    items
  };

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Indicators ready: ${payload.succeeded}/${payload.requested} (coverage ${(coverage * 100).toFixed(1)}%) in ${seconds}s`);

  if (coverage < options.minCoverage && !options.allowPartial) {
    console.error(`Refusing to write ${options.out}: coverage ${(coverage * 100).toFixed(1)}% is below the ${(options.minCoverage * 100).toFixed(0)}% floor.`);
    if (failures.length) console.error(`First failures: ${failures.slice(0, 5).map((f) => `${f.code} ${f.error}`).join("; ")}`);
    process.exitCode = 1;
    return { ...payload, written: false };
  }

  await fs.mkdir(path.dirname(options.out), { recursive: true });
  await fs.writeFile(options.out, `${JSON.stringify(payload)}\n`, "utf8");
  console.log(`Wrote ${options.out} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB)`);
  if (payload.failed) console.log(`Skipped ${payload.failed} symbol(s) with no usable history.`);
  return { ...payload, written: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
