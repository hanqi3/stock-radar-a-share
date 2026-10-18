// Sync a fundamentals snapshot into data/profiles.json.
//
// The 东方财富 push2 list endpoint pages 100 rows at a time, so a full-market
// snapshot is ~60 requests: cheap enough to refresh on every data run, and it
// is the only free source we found that carries PE / PB / turnover together for
// SH, SZ and BJ in one shape.
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

export function buildProfilesPayload(profiles, { universeCodes = null, now = new Date() } = {}) {
  const allowed = universeCodes ? new Set(universeCodes) : null;
  const items = {};
  for (const profile of profiles) {
    if (allowed && !allowed.has(profile.code)) continue;
    items[profile.code] = { ...profile };
    delete items[profile.code].code;
  }
  return {
    generatedAt: now.toISOString(),
    source: "东方财富 push2 收盘快照",
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

async function main() {
  const profiles = await fetchAllProfiles({ log: (line) => console.log(line) });
  const universeCodes = await readUniverseCodes();
  const payload = buildProfilesPayload(profiles, { universeCodes });
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(payload), "utf8");
  const missing = universeCodes ? universeCodes.filter((code) => !payload.items[code]).length : 0;
  console.log(
    `Wrote data/profiles.json: ${payload.count} profiles` +
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
