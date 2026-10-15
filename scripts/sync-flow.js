// Nightly capital-flow snapshot (主力资金流入流出).
//
// The 资金流 tab ranks the whole market by net inflow. Eastmoney's datacenter
// report RPT_DMSK_TS_FUNDFLOW already carries one row per stock per session with
// the full 4-tier breakdown and a server-side sort, so the whole market costs a
// handful of HTTP calls (~5 s) instead of one request per symbol.
//
// Why Eastmoney and not Sina: the two providers disagree in *sign* for the same
// session. On 2026-10-15 the market-wide total was -637.5亿 from Eastmoney
// (主力 = 超大单 + 大单, the 东财 standard) while Sina's r0_net summed to
// +185亿. 新易盛 reported the identical 成交额 (171.36亿) and close (-7.49%),
// yet Eastmoney said -19.25亿 and Sina said +12.92亿. A ranking column may only
// ever use one definition, so this script is Eastmoney-only.
//
//   node scripts/sync-flow.js [--days=5] [--limit=100] [--codes=600519,000001]
//                             [--out=data/flow.json] [--page-size=5000]
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

export const DEFAULTS = {
  days: 5,
  pageSize: 5000,
  minCoverage: 0.9,
  timeoutMs: 20000,
  maxAttempts: 3
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, allowPartial: false, out: DEFAULT_OUT, codes: null, limit: null };
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
    if (["days", "pageSize", "limit", "timeoutMs", "maxAttempts"].includes(key)) options[key] = Number(rawValue);
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
  const result = await fetchReport(
    reportUrl({
      pageSize: Math.max(options.days, 1),
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

export async function fetchDay(date, options) {
  const rows = [];
  for (let page = 1; page <= 4; page += 1) {
    const result = await fetchReport(
      reportUrl({
        pageNumber: page,
        pageSize: options.pageSize,
        sortColumns: "TRADE_DATE,SECURITY_CODE",
        sortTypes: "-1,1",
        filter: `(TRADE_DATE='${date}')`
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
    if (!groups.has(name)) groups.set(name, { name, count: 0, mainNet: 0, amount: 0, changes: [] });
    const group = groups.get(name);
    group.count += 1;
    group.mainNet += stock.mainNet || 0;
    group.amount += stock.amount || 0;
    if (Number.isFinite(stock.changePct)) group.changes.push(stock.changePct);
  }
  return [...groups.values()]
    .map((group) => ({
      name: group.name,
      count: group.count,
      mainNet: round(group.mainNet, 0),
      amount: round(group.amount, 0),
      avgChangePct: group.changes.length ? round(group.changes.reduce((a, b) => a + b, 0) / group.changes.length, 2) : null
    }))
    .sort((a, b) => b.mainNet - a.mainNet);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const started = Date.now();

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

  const dates = await fetchTradeDates(options);
  if (dates.length === 0) throw new Error("could not resolve any trading session from the datacenter report");
  const sessions = dates.slice(0, options.days);
  console.log(`Snapshotting capital flow for ${universe.length} symbols over ${sessions.length} session(s): ${sessions.join(", ")}`);

  const failures = [];
  const byCodeFlow = new Map();
  for (const date of sessions) {
    let rows = [];
    try {
      rows = await fetchDay(date, options);
    } catch (error) {
      failures.push({ date, error: String(error?.message || error) });
      continue;
    }
    let matched = 0;
    for (const row of rows) {
      const code = String(row.SECURITY_CODE || "");
      const stock = byCode.get(code);
      if (!stock) continue;
      const summary = summarizeFlow(row);
      if (!summary) continue;
      matched += 1;
      if (!byCodeFlow.has(code)) {
        byCodeFlow.set(code, {
          code,
          name: stock.name || row.SECURITY_NAME_ABBR || null,
          exchange: stock.exchange || inferExchange(code),
          board: stock.board || null,
          industry: industries.get(code) || stock.industry || null,
          date,
          session: true
        });
      }
      const record = byCodeFlow.get(code);
      if (date === sessions[0]) {
        Object.assign(record, summary);
        record.date = date;
      }
      record.main5 = round((record.main5 || 0) + summary.mainNet, 0);
      record.amount5 = round((record.amount5 || 0) + (summary.amount || 0), 0);
      record.sessions = (record.sessions || 0) + 1;
    }
    console.log(`  ${date}: ${rows.length} rows from the report, ${matched} matched the A-share universe`);
  }

  const records = [...byCodeFlow.values()].sort((a, b) => (b.mainNet || 0) - (a.mainNet || 0));
  const market = records.reduce(
    (total, record) => ({
      mainNet: total.mainNet + (record.mainNet || 0),
      amount: total.amount + (record.amount || 0)
    }),
    { mainNet: 0, amount: 0 }
  );
  const inflows = records.filter((record) => (record.mainNet || 0) > 0).length;
  const outflows = records.filter((record) => (record.mainNet || 0) < 0).length;

  const coverage = universe.length ? records.length / universe.length : 0;
  const payload = {
    generatedAt: new Date().toISOString(),
    date: sessions[0],
    sessions,
    source: "eastmoney",
    sourceLabel: "东方财富资金流向",
    definition: "主力净额 = 超大单净额 + 大单净额（东方财富口径）",
    days: sessions.length,
    requested: universe.length,
    succeeded: records.length,
    failed: failures.length,
    coverage: Number(coverage.toFixed(4)),
    market: { mainNet: round(market.mainNet, 0), amount: round(market.amount, 0), inflows, outflows },
    note: "One row per stock and session from datacenter RPT_DMSK_TS_FUNDFLOW. 东财资金流口径与新浪不同（同一日全市场合计可能反号），本文件不可与新浪数据混用；单位元。",
    failures: failures.slice(0, 50),
    industries: aggregateIndustries(records),
    stocks: records
  };

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Flow ready: ${payload.succeeded}/${payload.requested} (coverage ${(coverage * 100).toFixed(1)}%) in ${seconds}s, session ${sessions[0]}`);

  if (coverage < options.minCoverage && !options.allowPartial) {
    console.error(`Refusing to write ${options.out}: coverage ${(coverage * 100).toFixed(1)}% is below the ${(options.minCoverage * 100).toFixed(0)}% floor.`);
    if (failures.length) console.error(`First failures: ${failures.slice(0, 5).map((f) => `${f.date} ${f.error}`).join("; ")}`);
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
