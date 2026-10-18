// Nightly capital-flow snapshot (主力资金流入流出).
//
// The 资金流 tab ranks the whole market by net inflow. Eastmoney's datacenter
// report RPT_DMSK_TS_FUNDFLOW carries one row per stock per session with the full
// 4-tier breakdown, a server-side sort and a server-side *date range* filter, so
// the whole market over a long window costs a dozen paged requests instead of one
// request per symbol per day.
//
// Window size: the report holds per-session rows back to 2010-01-04, so the only
// real limit is transfer size. At pageSize 20000 a session is ~6500 rows, i.e. one
// page per three sessions; 60 sessions is ~344k rows / ~12 pages / ~25 s. Each
// symbol keeps rolling sums for 1 / 5 / 10 / 20 / 60 sessions, and the market-level
// per-session series is kept whole so the tab can show the window's own trend.
//
// Why Eastmoney and not Sina: the two providers disagree in *sign* for the same
// session. On 2026-10-15 the market-wide total was -637.5亿 from Eastmoney
// (主力 = 超大单 + 大单, the 东财 standard) while Sina's r0_net summed to
// +185亿. 新易盛 reported the identical 成交额 (171.36亿) and close (-7.49%),
// yet Eastmoney said -19.25亿 and Sina said +12.92亿. A ranking column may only
// ever use one definition, so this script is Eastmoney-only.
//
//   node scripts/sync-flow.js [--days=250] [--limit=100] [--codes=600519,000001]
//                             [--out=data/flow.json] [--page-size=20000]
//                             [--timeout-ms=20000] [--max-attempts=3]
//                             [--min-coverage=0.9] [--allow-partial]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inferExchange } from "../lib/boards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const FULL_DATA_FILE = path.join(DATA_DIR, "all-a-shares.json");
const SECTORS_FILE = path.join(DATA_DIR, "sectors.json");
const DEFAULT_OUT = path.join(DATA_DIR, "flow.json");

const DATACENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const REPORT = "RPT_DMSK_TS_FUNDFLOW";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://data.eastmoney.com/"
};
/** Money and volume columns are 万元 / 万股; ratios are already percentages. */
const WAN = 10_000;
/** 600519 (贵州茅台) is used only to read back the most recent trading dates. */
const CALENDAR_CODE = "600519";
/** Only the columns this script reads; trims each page from ~5.8 KB/row to ~0.3 KB/row. */
const COLUMNS = [
  "SECURITY_CODE",
  "SECURITY_NAME_ABBR",
  "TRADE_DATE",
  "CLOSE_PRICE",
  "CHANGE_RATE",
  "DEAL_AMOUNT",
  "NET_INFLOW",
  "NET_INFLOW_RATIO",
  "SUPERDEAL_NET",
  "BIGDEAL_NET",
  "MIDDEAL_NET",
  "SMALLDEAL_NET"
].join(",");
/** Rolling net-inflow windows kept per symbol, in trading sessions. */
export const WINDOWS = [1, 5, 10, 20, 60, 120, 250];

export const DEFAULTS = {
  days: 250,
  maxDays: 250,
  pageSize: 20000,
  minCoverage: 0.9,
  timeoutMs: 20000,
  maxAttempts: 3
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, allowPartial: false, force: false, out: DEFAULT_OUT, codes: null, limit: null };
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const [, rawKey, rawValue] = match;
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === "allowPartial" || key === "force") {
      options[key] = true;
      continue;
    }
    if (rawValue === undefined) continue;
    if (["days", "maxDays", "pageSize", "limit", "timeoutMs", "maxAttempts"].includes(key)) options[key] = Number(rawValue);
    else if (key === "minCoverage") options.minCoverage = Number(rawValue);
    else if (key === "codes") options.codes = rawValue.split(",").map((c) => c.trim()).filter(Boolean);
    else options[key] = rawValue;
  }
  return options;
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

export function reportUrl({ pageNumber = 1, pageSize, sortColumns, sortTypes, filter, columns = "ALL" } = {}) {
  const params = new URLSearchParams({
    reportName: REPORT,
    columns,
    source: "WEB",
    client: "WEB",
    pageNumber: String(pageNumber),
    pageSize: String(pageSize)
  });
  if (sortColumns) params.set("sortColumns", sortColumns);
  if (sortTypes) params.set("sortTypes", sortTypes);
  if (filter) params.set("filter", filter);
  return `${DATACENTER}?${params.toString()}`;
}

async function getJson(url, options) {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(options.timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchReport(url, options) {
  let lastError = null;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const payload = await getJson(url, options);
      if (!payload || payload.success === false) throw new Error(payload?.message || "report returned no result");
      return payload.result || { data: [] };
    } catch (error) {
      lastError = error;
      if (attempt < options.maxAttempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

/** The report has no date index, so the recent sessions are read off one liquid stock. */
export async function fetchTradeDates(options, code = CALENDAR_CODE) {
  const wanted = Math.max(Math.min(options.days || 1, options.maxDays || 250), 1);
  const result = await fetchReport(
    reportUrl({
      pageSize: wanted,
      sortColumns: "TRADE_DATE",
      sortTypes: "-1",
      filter: `(SECURITY_CODE="${code}")`,
      columns: "TRADE_DATE"
    }),
    options
  );
  const dates = [];
  for (const row of result.data || []) {
    const date = String(row.TRADE_DATE || "").slice(0, 10);
    if (date && !dates.includes(date)) dates.push(date);
  }
  return dates;
}

/**
 * Every stock/session row between two dates, newest session first.
 *
 * The report honours a two-sided TRADE_DATE range filter, which is what makes a
 * long window affordable: one paged scan instead of one scan per session.
 */
export async function fetchWindow(start, end, options) {
  const rows = [];
  const sessions = options.windowSessions || options.days || 1;
  const maxPages = Math.ceil((sessions * 6500) / options.pageSize) + 4;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchReport(
      reportUrl({
        pageNumber: page,
        pageSize: options.pageSize,
        sortColumns: "TRADE_DATE,SECURITY_CODE",
        sortTypes: "-1,1",
        filter: `(TRADE_DATE>='${start}')(TRADE_DATE<='${end}')`,
        columns: COLUMNS
      }),
      options
    );
    const data = result.data || [];
    rows.push(...data);
    if (data.length < options.pageSize) break;
  }
  return rows;
}

/** One provider row -> the numbers the tab ranks on. Money is converted to 元. */
export function summarizeFlow(row) {
  const mainNet = Number(row?.NET_INFLOW);
  if (!Number.isFinite(mainNet)) return null;
  const scale = (value) => (Number.isFinite(Number(value)) ? Number(value) * WAN : null);
  const changePct = Number(row?.CHANGE_RATE);
  const price = Number(row?.CLOSE_PRICE);
  return {
    price: round(price, 3),
    changePct: Number.isFinite(changePct) ? round(changePct, 2) : null,
    mainNet: round(mainNet * WAN, 0),
    mainRatio: round(Number(row?.NET_INFLOW_RATIO), 2),
    superNet: scale(row?.SUPERDEAL_NET),
    bigNet: scale(row?.BIGDEAL_NET),
    midNet: scale(row?.MIDDEAL_NET),
    smallNet: scale(row?.SMALLDEAL_NET),
    amount: scale(row?.DEAL_AMOUNT)
  };
}

/** Sum the newest `count` entries of a session series. */
function windowSum(series, count, field) {
  let total = 0;
  let seen = 0;
  for (let i = 0; i < series.length && seen < count; i += 1) {
    const value = series[i][field];
    if (!Number.isFinite(value)) continue;
    total += value;
    seen += 1;
  }
  return round(total, 0);
}

function industryMap(sectors) {
  const byId = new Map((sectors?.industries || []).map((item) => [item.id, item.name]));
  const byCode = new Map();
  for (const [code, entry] of Object.entries(sectors?.membership || {})) {
    const id = (entry?.industries || [])[0];
    if (id && byId.has(id)) byCode.set(code, byId.get(id));
  }
  return byCode;
}

function aggregateIndustries(stocks) {
  const groups = new Map();
  for (const stock of stocks) {
    const name = stock.industry || stock.board || "未分类";
    if (!groups.has(name)) {
      const fresh = { name, count: 0, amount: 0, changes: [] };
      for (const window of WINDOWS) fresh[`main${window}`] = 0;
      groups.set(name, fresh);
    }
    const group = groups.get(name);
    group.count += 1;
    group.amount += stock.amount || 0;
    for (const window of WINDOWS) group[`main${window}`] += stock[`main${window}`] || 0;
    if (Number.isFinite(stock.changePct)) group.changes.push(stock.changePct);
  }
  return [...groups.values()]
    .map((group) => {
      const row = {
        name: group.name,
        count: group.count,
        amount: round(group.amount, 0),
        avgChangePct: group.changes.length ? round(group.changes.reduce((a, b) => a + b, 0) / group.changes.length, 2) : null
      };
      for (const window of WINDOWS) row[`main${window}`] = round(group[`main${window}`], 0);
      return row;
    })
    .sort((a, b) => b.main1 - a.main1);
}

/**
 * True when `file` already holds a complete snapshot ending on `end`.
 *
 * Coverage matters: a partial run leaves a file whose `date` looks current but
 * whose symbol list is short, and skipping that would freeze the gap in place.
 */
export async function flowAlreadyCurrent(file, end, wantedSessions, minCoverage = 0.98) {
  let existing;
  try {
    existing = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return false;
  }
  if (!existing || existing.date !== end) return false;
  if (!Array.isArray(existing.sessions) || existing.sessions.length < wantedSessions) return false;
  const requested = Number(existing.requested) || 0;
  const succeeded = Number(existing.succeeded) || 0;
  if (!requested) return false;
  return succeeded / requested >= minCoverage;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const started = Date.now();
  options.days = Math.max(Math.min(options.days || 1, options.maxDays), 1);

  const stocks = JSON.parse(await fs.readFile(FULL_DATA_FILE, "utf8"));
  const byCode = new Map(stocks.map((stock) => [String(stock.code), stock]));

  let sectors = null;
  try {
    sectors = JSON.parse(await fs.readFile(SECTORS_FILE, "utf8"));
  } catch {
    console.warn("data/sectors.json missing - industry aggregation will fall back to the board");
  }
  const industries = industryMap(sectors);

  let universe = stocks;
  if (options.codes) universe = options.codes.map((code) => byCode.get(String(code))).filter(Boolean);
  else if (options.limit) universe = stocks.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, options.limit);
  if (universe.length === 0) throw new Error("no symbols selected for the flow snapshot");
  const universeCodes = new Set(universe.map((stock) => String(stock.code)));

  const dates = await fetchTradeDates(options);
  if (dates.length === 0) throw new Error("could not resolve any trading session from the datacenter report");
  const sessions = dates.slice(0, options.days);
  const start = sessions[sessions.length - 1];
  const end = sessions[0];

  // A holiday, a weekend or a re-run would otherwise repull ~250 sessions for
  // data we already have. The whole sync costs ten minutes in CI, so this check
  // is worth the extra branch.
  if (!options.force && (await flowAlreadyCurrent(options.out, end, sessions.length))) {
    console.log(`Flow snapshot already covers ${end} (${sessions.length} sessions); skipping. Pass --force to rebuild.`);
    return null;
  }

  console.log(`Snapshotting capital flow for ${universe.length} symbols over ${sessions.length} session(s): ${start}..${end}`);

  options.windowSessions = sessions.length;
  const failures = [];
  const series = new Map(); // code -> newest-first per-session rows
  const byDate = new Map(); // session -> market aggregate

  let matched = 0;
  let scanned = 0;
  try {
    const rows = await fetchWindow(start, end, options);
    scanned = rows.length;
    for (const row of rows) {
      const code = String(row.SECURITY_CODE || "");
      if (!universeCodes.has(code)) continue;
      const summary = summarizeFlow(row);
      if (!summary) continue;
      const date = String(row.TRADE_DATE || "").slice(0, 10);
      matched += 1;
      if (!series.has(code)) series.set(code, []);
      series.get(code).push({ date, name: row.SECURITY_NAME_ABBR || null, ...summary });
      if (!byDate.has(date)) byDate.set(date, { date, mainNet: 0, amount: 0, inflows: 0, outflows: 0, count: 0 });
      const bucket = byDate.get(date);
      bucket.mainNet += summary.mainNet || 0;
      bucket.amount += summary.amount || 0;
      if (summary.mainNet > 0) bucket.inflows += 1;
      else if (summary.mainNet < 0) bucket.outflows += 1;
      bucket.count += 1;
    }
    console.log(`  ${scanned} rows over ${sessions.length} sessions, ${matched} matched the A-share universe`);
  } catch (error) {
    failures.push({ window: `${start}..${end}`, error: String(error?.message || error) });
  }

  const records = [];
  for (const [code, entries] of series) {
    entries.sort((a, b) => (a.date < b.date ? 1 : -1));
    const stock = byCode.get(code);
    const latest = entries[0];
    const record = {
      code,
      name: stock?.name || latest.name || null,
      exchange: stock?.exchange || inferExchange(code),
      board: stock?.board || null,
      industry: industries.get(code) || stock?.industry || null,
      date: latest.date,
      sessions: entries.length,
      price: latest.price,
      changePct: latest.changePct,
      mainNet: latest.mainNet,
      mainRatio: latest.mainRatio,
      superNet: latest.superNet,
      bigNet: latest.bigNet,
      midNet: latest.midNet,
      smallNet: latest.smallNet,
      amount: latest.amount
    };
    for (const window of WINDOWS) {
      record[`main${window}`] = windowSum(entries, window, "mainNet");
      record[`amount${window}`] = windowSum(entries, window, "amount");
    }
    records.push(record);
  }
  records.sort((a, b) => (b.mainNet || 0) - (a.mainNet || 0));

  const history = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((bucket) => ({
      date: bucket.date,
      mainNet: round(bucket.mainNet, 0),
      amount: round(bucket.amount, 0),
      inflows: bucket.inflows,
      outflows: bucket.outflows,
      count: bucket.count
    }));

  const today = history[0] || { mainNet: 0, amount: 0, inflows: 0, outflows: 0 };
  const coverage = universe.length ? records.length / universe.length : 0;
  const payload = {
    generatedAt: new Date().toISOString(),
    date: end,
    sessions,
    source: "eastmoney",
    sourceLabel: "东方财富资金流向",
    definition: "主力净额 = 超大单净额 + 大单净额（东方财富口径）",
    days: sessions.length,
    windows: WINDOWS,
    window: { start, end },
    requested: universe.length,
    succeeded: records.length,
    failed: failures.length,
    coverage: Number(coverage.toFixed(4)),
    market: { mainNet: round(today.mainNet, 0), amount: round(today.amount, 0), inflows: today.inflows, outflows: today.outflows },
    history,
    note: "One row per stock and session from datacenter RPT_DMSK_TS_FUNDFLOW. 东财资金流口径与新浪不同（同一日全市场合计可能反号），本文件不可与新浪数据混用；单位元。",
    failures: failures.slice(0, 50),
    industries: aggregateIndustries(records),
    stocks: records
  };

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Flow ready: ${payload.succeeded}/${payload.requested} (coverage ${(coverage * 100).toFixed(1)}%) in ${seconds}s, ${sessions.length} sessions`);

  if (coverage < options.minCoverage && !options.allowPartial) {
    console.error(`Refusing to write ${options.out}: coverage ${(coverage * 100).toFixed(1)}% is below the ${(options.minCoverage * 100).toFixed(0)}% floor.`);
    if (failures.length) console.error(`First failures: ${failures.slice(0, 5).map((f) => `${f.window} ${f.error}`).join("; ")}`);
    process.exitCode = 1;
    return { ...payload, written: false };
  }

  await fs.mkdir(path.dirname(options.out), { recursive: true });
  await fs.writeFile(options.out, `${JSON.stringify(payload)}\n`, "utf8");
  console.log(`Wrote ${options.out} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB)`);
  return { ...payload, written: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
