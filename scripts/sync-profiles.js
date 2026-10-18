// Sync a fundamentals snapshot into data/profiles.json.
//
// Two free sources carry PE / PB / turnover together for SH, SZ and BJ:
//
//   腾讯 qt.gtimg.cn/q=   60 codes per request, ~93 requests, GBK text
//   东财 push2/api/qt/clist/get  100 rows per request, ~60 requests, JSON
//
// 腾讯 goes first because the 东财 quote cluster blocks a shared IP after a
// couple of full-market runs (observed: only `push2*.eastmoney.com` refused,
// `datacenter-web.eastmoney.com` kept working). Either way the run prefers
// whichever source actually answers, and keeps the previous file if none does.
//
// Everything here is a *snapshot of the last session*, not a live quote: the
// dashboard is a post-close research tool, so staleness is fine as long as the
// payload says when it was taken.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_FILE = path.join(ROOT, "data", "profiles.json");
const UNIVERSE_FILE = path.join(ROOT, "data", "all-a-shares.json");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://quote.eastmoney.com/",
  Accept: "application/json,text/plain,*/*"
};

// f2 last, f3 change %, f4 change, f5 volume (lots), f6 amount, f7 amplitude %,
// f8 turnover %, f9 PE (dynamic), f10 volume ratio, f12 code, f14 name,
// f15 high, f16 low, f17 open, f18 previous close, f20 total cap, f21 float cap,
// f23 PB, f114 PE (static), f115 PE (TTM).
const FIELDS = "f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f21,f23,f114,f115";
const MARKET_FILTER = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
const PAGE_SIZE = 100;
const DEFAULTS = { timeoutMs: 20_000, maxAttempts: 3, pageDelayMs: 120, maxPages: 90 };

function toNumber(value) {
  if (value === null || value === undefined || value === "-" || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 2) {
  const parsed = toNumber(value);
  return parsed === null ? null : Number(parsed.toFixed(digits));
}

/**
 * Collapse one push2 row into our own vocabulary.
 * Every field is nullable: a suspended stock reports "-" for the prices.
 */
export function normalizeProfileRow(row) {
  if (!row || typeof row !== "object") return null;
  const code = String(row.f12 ?? "").trim();
  if (!/^\d{6}$/.test(code)) return null;
  return {
    code,
    name: typeof row.f14 === "string" ? row.f14 : null,
    price: round(row.f2, 3),
    changePct: round(row.f3),
    change: round(row.f4, 3),
    volume: toNumber(row.f5),
    amount: toNumber(row.f6, 2),
    amplitudePct: round(row.f7),
    turnoverPct: round(row.f8),
    peDynamic: round(row.f9),
    volumeRatio: round(row.f10),
    high: round(row.f15, 3),
    low: round(row.f16, 3),
    open: round(row.f17, 3),
    prevClose: round(row.f18, 3),
    marketCap: toNumber(row.f20),
    floatMarketCap: toNumber(row.f21),
    pb: round(row.f23),
    peStatic: round(row.f114),
    peTtm: round(row.f115)
  };
}

async function getJson(url, options = {}) {
  const { timeoutMs = DEFAULTS.timeoutMs, maxAttempts = DEFAULTS.maxAttempts } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function pageUrl(page) {
  return (
    "https://push2.eastmoney.com/api/qt/clist/get" +
    `?pn=${page}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f12` +
    `&fs=${encodeURIComponent(MARKET_FILTER)}&fields=${FIELDS}`
  );
}

/** Fetch every page and return the normalised rows, in source order. */
export async function fetchAllProfiles(options = {}) {
  const { maxPages = DEFAULTS.maxPages, pageDelayMs = DEFAULTS.pageDelayMs, log = () => {} } = options;
  const rows = [];
  let total = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await getJson(pageUrl(page), options);
    const data = payload?.data;
    if (!data) break;
    if (total === null) total = toNumber(data.total);
    const pageRows = Array.isArray(data.diff) ? data.diff : Object.values(data.diff || {});
    if (pageRows.length === 0) break;
    for (const row of pageRows) {
      const profile = normalizeProfileRow(row);
      if (profile) rows.push(profile);
    }
    log(`page ${page}: ${rows.length}${total ? ` / ${total}` : ""}`);
    if (total !== null && rows.length >= total) break;
    if (page < maxPages && pageDelayMs) await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
  }
  return rows;
}

// --- 腾讯 fallback -------------------------------------------------------
//
// https://qt.gtimg.cn/q=sh600519,sz000001,... answers with GBK-encoded lines of
// `v_sh600519="1~name~code~price~prevClose~open~...~";`. The fields we use:
// 1 name, 2 code, 3 price, 4 prev close, 5 open, 31 change, 32 change %,
// 33 high, 34 low, 36 volume (lots), 37 amount (万元), 38 turnover %,
// 39 PE (TTM), 43 amplitude %, 44 float cap (亿元), 45 total cap (亿元),
// 46 PB, 49 volume ratio, 52 PE (dynamic), 53 PE (static).

const TENCENT_BATCH = 60;
const TENCENT_HEADERS = {
  "User-Agent": HEADERS["User-Agent"],
  Referer: "https://gu.qq.com/",
  Accept: "text/plain,*/*"
};

/** Market prefix from the code alone: 6xxxxx=SH, 0/3= SZ, 4/8/9= BJ. */
function tencentSymbol(code) {
  if (/^6/.test(code)) return `sh${code}`;
  if (/^[03]/.test(code)) return `sz${code}`;
  if (/^[489]/.test(code)) return `bj${code}`;
  return null;
}

/**
 * Parse the batch-quote body into our own vocabulary.
 * Tencent writes "0.00" for a ratio it has no value for (freshly listed BJ
 * names), so a non-positive volume ratio is reported as null like 东财 does.
 */
export function parseTencentQuote(text) {
  const profiles = [];
  for (const line of String(text).split(";")) {
    const match = line.match(/v_(\w+)="([^"]*)"/);
    if (!match) continue;
    const fields = match[2].split("~");
    const code = String(fields[2] ?? "").trim();
    if (!/^\d{6}$/.test(code)) continue;
    const volumeRatio = round(fields[49]);
    profiles.push({
      code,
      name: fields[1] ? fields[1] : null,
      price: round(fields[3], 3),
      changePct: round(fields[32]),
      change: round(fields[31], 3),
      volume: toNumber(fields[36]),
      amount: (toNumber(fields[37]) ?? 0) * 1e4 || null,
      amplitudePct: round(fields[43]),
      turnoverPct: round(fields[38]),
      peDynamic: round(fields[52]),
      volumeRatio: volumeRatio && volumeRatio > 0 ? volumeRatio : null,
      high: round(fields[33], 3),
      low: round(fields[34], 3),
      open: round(fields[5], 3),
      prevClose: round(fields[4], 3),
      marketCap: (toNumber(fields[45]) ?? 0) * 1e8 || null,
      floatMarketCap: (toNumber(fields[44]) ?? 0) * 1e8 || null,
      pb: round(fields[46]),
      peStatic: round(fields[53]),
      peTtm: round(fields[39])
    });
  }
  return profiles;
}

async function getText(url, options = {}) {
  const { timeoutMs = DEFAULTS.timeoutMs, maxAttempts = DEFAULTS.maxAttempts } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: TENCENT_HEADERS, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      return new TextDecoder("gbk").decode(buffer);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** Fetch the fallback snapshot for an explicit code list (batches of 60). */
export async function fetchTencentProfiles(codes, options = {}) {
  const { pageDelayMs = DEFAULTS.pageDelayMs, log = () => {} } = options;
  const symbols = codes.map(tencentSymbol).filter(Boolean);
  const profiles = [];
  for (let index = 0; index < symbols.length; index += TENCENT_BATCH) {
    const batch = symbols.slice(index, index + TENCENT_BATCH);
    const text = await getText(`https://qt.gtimg.cn/q=${batch.join(",")}`, options);
    for (const profile of parseTencentQuote(text)) profiles.push(profile);
    log(`tencent batch ${Math.floor(index / TENCENT_BATCH) + 1}: ${profiles.length} / ${symbols.length}`);
    if (index + TENCENT_BATCH < symbols.length && pageDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
    }
  }
  return profiles;
}

export function buildProfilesPayload(profiles, { universeCodes = null, now = new Date(), source = "腾讯行情收盘快照" } = {}) {
  const allowed = universeCodes ? new Set(universeCodes) : null;
  const items = {};
  for (const profile of profiles) {
    if (allowed && !allowed.has(profile.code)) continue;
    items[profile.code] = { ...profile };
    delete items[profile.code].code;
  }
  return {
    generatedAt: now.toISOString(),
    source,
    count: Object.keys(items).length,
    items
  };
}

async function readUniverseCodes() {
  try {
    const raw = await fs.readFile(UNIVERSE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => item.code).filter(Boolean);
    if (Array.isArray(parsed?.items)) return parsed.items.map((item) => item.code).filter(Boolean);
  } catch {
    /* fall through: keep every row the source returns */
  }
  return null;
}

/** Cache the previous snapshot so a total vendor outage keeps the last good read. */
async function readExistingPayload() {
  try {
    const raw = await fs.readFile(OUT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.items === "object" && parsed.items ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Does a source's row list actually cover the universe?
 * A half-empty page is worse than the previous snapshot, so a source has to
 * reach `minCoverage` of the expected codes before we accept it.
 */
export function coversUniverse(profiles, universeCodes = null, minCoverage = 0.9) {
  if (!Array.isArray(profiles) || profiles.length === 0) return false;
  if (!Array.isArray(universeCodes) || universeCodes.length === 0) return true;
  const seen = new Set(profiles.map((profile) => profile.code));
  const covered = universeCodes.filter((code) => seen.has(code)).length;
  return covered >= Math.ceil(universeCodes.length * minCoverage);
}

/**
 * Pull the snapshot, preferring 腾讯 and falling back to 东财.
 *
 * The order is not arbitrary: share the same IP and the 东财 quote cluster
 * (`push2*.eastmoney.com`) starts refusing connections — that is exactly what
 * happened on the dev box after two full-market runs, while
 * `datacenter-web.eastmoney.com` kept answering. 腾讯's batch endpoint has
 * served every run since, so it goes first and 东财 stays as the backup.
 */
export async function collectProfiles({ universeCodes = null, minCoverage = 0.9, source = "auto", log = () => {} } = {}) {
  const attempts = [];
  if (source === "auto" || source === "tencent") {
    attempts.push({
      name: "腾讯行情收盘快照",
      run: () => {
        if (!universeCodes || universeCodes.length === 0) {
          throw new Error("the 腾讯 source needs the universe list to batch by code");
        }
        return fetchTencentProfiles(universeCodes, { log });
      }
    });
  }
  if (source === "auto" || source === "eastmoney") {
    attempts.push({
      name: "东方财富 push2 收盘快照",
      run: () => fetchAllProfiles({ log })
    });
  }

  const failures = [];
  for (const attempt of attempts) {
    try {
      const profiles = await attempt.run();
      if (coversUniverse(profiles, universeCodes, minCoverage)) return { profiles, source: attempt.name };
      failures.push(`${attempt.name}: only ${profiles.length} rows`);
      log(`${attempt.name} returned too few rows, trying the next source`);
    } catch (error) {
      failures.push(`${attempt.name}: ${error.message}`);
      log(`${attempt.name} failed (${error.message})`);
    }
  }
  return { profiles: null, source: null, failures };
}

async function main() {
  const universeCodes = await readUniverseCodes();
  const requested = (process.argv.find((arg) => arg.startsWith("--source=")) || "").replace("--source=", "") || "auto";
  const { profiles, source, failures } = await collectProfiles({
    universeCodes,
    source: requested,
    log: (line) => console.log(line)
  });
  if (!profiles) {
    const existing = await readExistingPayload();
    if (existing && existing.count > 0) {
      console.warn(
        `profiles sync failed from every source (${failures.join("; ")}); keeping the previous snapshot from ${existing.generatedAt}`
      );
      return;
    }
    throw new Error(`profiles sync failed from every source: ${failures.join("; ")}`);
  }
  const payload = buildProfilesPayload(profiles, { universeCodes, source });
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(payload), "utf8");
  const missing = universeCodes ? universeCodes.filter((code) => !payload.items[code]).length : 0;
  console.log(
    `Wrote data/profiles.json: ${payload.count} profiles from ${payload.source}` +
      (universeCodes ? ` (${missing} universe codes missing)` : "")
  );
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error("profiles sync failed:", error);
    process.exitCode = 1;
  });
}
