// Event ingestion: policy news, market news and company announcements.
//
// Every provider here was probed for reachability from this project's own
// network before being wired in. Eastmoney's push2/push2his quote hosts are
// blocked from here, so nothing in this file depends on them; the announcement
// and news APIs below live on separate hosts and answer reliably.
//
// Output: data/events.json -> {generatedAt, providers, count, note, items:[...]}
// Each item is the raw shape lib/events.js classifies:
//   {id, title, summary, url, source, publishedAt, codes[], category?}

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(DATA_DIR, "events.json");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const DEFAULTS = {
  timeoutMs: 20000,
  maxAttempts: 3,
  maxEvents: 600,
  announcementDays: 2,
  cninfoPages: 4,
  emAnnouncementPages: 2,
  kuaixunPages: 2
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stripTags(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function toIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric) && numeric > 1e9) {
    // Seconds vs milliseconds: anything below 1e11 is seconds.
    const ms = numeric < 1e11 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toDateOnly(value) {
  const iso = toIso(value);
  return iso ? iso.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

async function request(url, options = {}, settings = DEFAULTS) {
  const { timeoutMs = DEFAULTS.timeoutMs, maxAttempts = DEFAULTS.maxAttempts, fetchImpl = fetch, ...rest } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...rest,
        headers: { "user-agent": BROWSER_UA, ...(rest.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(400 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${url} failed after ${maxAttempts} attempts: ${lastError?.message || lastError}`);
}

function parseJsonp(text) {
  const trimmed = String(text).trim().replace(/;$/, "");
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");
  if (start === -1 || end <= start) throw new Error("unexpected JSONP payload");
  return JSON.parse(trimmed.slice(start + 1, end));
}

// --- Sina 7x24 live feed ----------------------------------------------------

export const SINA_LIVE_TAGS = [
  { tagId: 0, label: "公司" },
  { tagId: 1, label: "政策" },
  { tagId: 2, label: "数据" }
];

export function parseSinaLive(payload, meta = {}) {
  const list = payload?.result?.data?.feed?.list;
  if (!Array.isArray(list)) throw new Error("unexpected payload shape (no result.data.feed.list)");
  return list.map((item) => {
    const text = stripTags(item.rich_text);
    const bracket = text.match(/^【(.+?)】/);
    const title = bracket ? bracket[1] : text.slice(0, 60);
    const summary = bracket ? text.slice(bracket[0].length).trim() : text;
    let codes = [];
    try {
      const ext = typeof item.ext === "string" ? JSON.parse(item.ext) : item.ext;
      codes = (ext?.stocks || [])
        .map((stock) => String(stock.symbol || "").replace(/^[a-z]{2}/i, ""))
        .filter((code) => /^\d{6}$/.test(code));
    } catch {
      codes = [];
    }
    return {
      id: `sina-live-${item.id || item.docid || item.create_time}`,
      title: title || summary.slice(0, 60),
      summary,
      url: item.docurl || "",
      source: `新浪财经7x24${meta.label ? `·${meta.label}` : ""}`,
      publishedAt: toIso(item.create_time),
      codes
    };
  });
}

export async function fetchSinaLive(settings = DEFAULTS) {
  const items = [];
  for (const { tagId, label } of SINA_LIVE_TAGS) {
    const url = `https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152&tag_id=${tagId}`;
    try {
      const payload = JSON.parse(await request(url, { headers: { referer: "https://finance.sina.com.cn/" } }, settings));
      items.push(...parseSinaLive(payload, { label }));
    } catch (error) {
      items.push({ __error: `sina-live[${tagId}]: ${error.message}` });
    }
  }
  return items;
}

// --- Sina rolling news ------------------------------------------------------

export const SINA_ROLL_CHANNELS = [
  { lid: 2516, label: "股市" },
  { lid: 2517, label: "要闻" },
  { lid: 2510, label: "财经" }
];

export function parseSinaRoll(payload, meta = {}) {
  const list = payload?.result?.data;
  if (!Array.isArray(list)) throw new Error("unexpected payload shape (no result.data)");
  return list.map((item) => ({
    id: `sina-roll-${item.docid || item.url}`,
    title: stripTags(item.title),
    summary: stripTags(item.intro || item.summary || ""),
    url: item.url || "",
    source: `新浪财经·${meta.label || "要闻"}`,
    publishedAt: toIso(item.ctime)
  }));
}

export async function fetchSinaRoll(settings = DEFAULTS) {
  const items = [];
  for (const { lid, label } of SINA_ROLL_CHANNELS) {
    const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=${lid}&num=50&page=1`;
    try {
      const payload = JSON.parse(await request(url, { headers: { referer: "https://finance.sina.com.cn/" } }, settings));
      items.push(...parseSinaRoll(payload, { label }));
    } catch (error) {
      items.push({ __error: `sina-roll[${lid}]: ${error.message}` });
    }
  }
  return items;
}

// --- Eastmoney 7x24 kuaixun -------------------------------------------------

export function parseKuaixun(text) {
  const json = String(text).replace(/^var\s+ajaxResult\s*=\s*/, "").trim();
  const payload = JSON.parse(json);
  const list = payload?.LivesList;
  if (!Array.isArray(list)) throw new Error("unexpected payload shape (no LivesList)");
  return list.map((item) => ({
    id: `em-kuaixun-${item.id || item.url_w || item.title}`,
    title: stripTags(item.title),
    summary: stripTags(item.digest || ""),
    url: item.url_w || item.url_unique || "",
    source: "东方财富快讯",
    publishedAt: toIso(item.showtime)
  }));
}

export async function fetchEastmoneyKuaixun(settings = DEFAULTS, pages = DEFAULTS.kuaixunPages) {
  const items = [];
  for (let page = 1; page <= pages; page += 1) {
    const url = `https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_${page}_.html`;
    try {
      items.push(...parseKuaixun(await request(url, { headers: { referer: "https://kuaixun.eastmoney.com/" } }, settings)));
    } catch (error) {
      items.push({ __error: `em-kuaixun[${page}]: ${error.message}` });
    }
  }
  return items;
}

// --- cninfo announcements (official disclosure channel) ---------------------

export const CNINFO_URL = "http://www.cninfo.com.cn/new/hisAnnouncement/query";

export function parseCninfo(payload) {
  const list = payload?.announcements;
  if (!Array.isArray(list)) throw new Error("unexpected payload shape (no announcements)");
  return list.map((item) => ({
    id: `cninfo-${item.announcementId || item.adjunctUrl}`,
    title: stripTags(item.announcementTitle),
    summary: `${stripTags(item.secName)} ${stripTags(item.announcementTypeName)}`.trim(),
    url: item.adjunctUrl ? `http://static.cninfo.com.cn/${item.adjunctUrl}` : "",
    source: "巨潮资讯",
    publishedAt: toIso(item.announcementTime),
    codes: item.secCode ? [String(item.secCode).padStart(6, "0")] : [],
    category: stripTags(item.announcementTypeName)
  }));
}

export function cninfoBody({ pageNum = 1, pageSize = 30, seDate = "" } = {}) {
  return new URLSearchParams({
    pageNum: String(pageNum),
    pageSize: String(pageSize),
    column: "szse",
    tabName: "fulltext",
    plate: "",
    stock: "",
    searchkey: "",
    secid: "",
    category: "",
    trade: "",
    seDate,
    sortName: "time",
    sortType: "desc",
    isHLtitle: "true"
  }).toString();
}

export async function fetchCninfoAnnouncements(settings = DEFAULTS, days = DEFAULTS.announcementDays) {
  const items = [];
  const today = new Date();
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    for (let page = 1; page <= DEFAULTS.cninfoPages; page += 1) {
      try {
        const text = await request(
          CNINFO_URL,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
              referer: "http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice",
              "x-requested-with": "XMLHttpRequest"
            },
            body: cninfoBody({ pageNum: page, pageSize: 30, seDate: `${date}~${date}` })
          },
          settings
        );
        const parsed = parseCninfo(JSON.parse(text));
        items.push(...parsed);
        if (parsed.length < 30) break;
      } catch (error) {
        items.push({ __error: `cninfo[${date} p${page}]: ${error.message}` });
        break;
      }
    }
  }
  return items;
}

// --- Eastmoney announcements (typed, multi-market) --------------------------

export function parseEastmoneyAnnouncements(payload) {
  const list = payload?.data?.list;
  if (!Array.isArray(list)) throw new Error("unexpected payload shape (no data.list)");
  return list.map((item) => {
    const code = item.codes?.[0]?.stock_code ? String(item.codes[0].stock_code).padStart(6, "0") : "";
    const columns = (item.columns || []).map((column) => column.column_name).filter(Boolean);
    return {
      id: `em-ann-${item.art_code}`,
      title: stripTags(item.title),
      summary: `${stripTags(item.codes?.[0]?.short_name || "")} ${columns.join("/")}`.trim(),
      url: code && item.art_code ? `https://data.eastmoney.com/notices/detail/${code}/${item.art_code}.html` : "",
      source: "东方财富公告",
      publishedAt: toIso(item.notice_date),
      codes: item.codes?.map((entry) => String(entry.stock_code).padStart(6, "0")) || [],
      category: columns[0] || ""
    };
  });
}

export async function fetchEastmoneyAnnouncements(settings = DEFAULTS, pages = DEFAULTS.emAnnouncementPages) {
  const items = [];
  for (let page = 1; page <= pages; page += 1) {
    const url =
      "https://np-anotice-stock.eastmoney.com/api/security/ann?" +
      `sr=-1&page_size=50&page_index=${page}&ann_type=A&client_source=web&f_node=0&s_node=0`;
    try {
      const payload = JSON.parse(await request(url, { headers: { referer: "https://data.eastmoney.com/notices/" } }, settings));
      const parsed = parseEastmoneyAnnouncements(payload);
      items.push(...parsed);
      // page_index is ignored server-side for this endpoint: stop after one repeat page.
      if (page > 1 && parsed.length === 0) break;
    } catch (error) {
      items.push({ __error: `em-announcement[${page}]: ${error.message}` });
      break;
    }
  }
  return items;
}

// --- aggregation ------------------------------------------------------------

export const PROVIDERS = [
  { id: "sina-live", label: "新浪财经7x24", run: fetchSinaLive },
  { id: "sina-roll", label: "新浪财经滚动", run: fetchSinaRoll },
  { id: "em-kuaixun", label: "东方财富快讯", run: fetchEastmoneyKuaixun },
  { id: "cninfo", label: "巨潮资讯公告", run: fetchCninfoAnnouncements },
  { id: "em-announcement", label: "东方财富公告", run: fetchEastmoneyAnnouncements }
];

export function dedupeEvents(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.id || `${item.title}|${item.publishedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function isUsableEvent(item) {
  if (!item || item.__error) return false;
  if (!item.title || item.title.length < 4) return false;
  return true;
}

export async function collectEvents(settings = DEFAULTS, providers = PROVIDERS) {
  const items = [];
  const errors = [];
  const used = [];
  for (const provider of providers) {
    try {
      const result = await provider.run(settings);
      const good = result.filter(isUsableEvent);
      const failed = result.filter((item) => item && item.__error);
      for (const failure of failed) errors.push(failure.__error);
      items.push(...good);
      used.push({ id: provider.id, label: provider.label, count: good.length });
    } catch (error) {
      errors.push(`${provider.id}: ${error.message}`);
      used.push({ id: provider.id, label: provider.label, count: 0, error: String(error.message) });
    }
  }

  const unique = dedupeEvents(items)
    .filter((item) => item.publishedAt)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  return { items: unique.slice(0, settings.maxEvents), providers: used, errors };
}

export async function main() {
  const started = Date.now();
  const { items, providers, errors } = await collectEvents();
  if (items.length === 0) {
    throw new Error(`no events collected from any provider; errors:\n  ${errors.join("\n  ") || "none recorded"}`);
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    providers,
    count: items.length,
    note: "Public policy/market news and exchange announcements, classified at read time by lib/events.js.",
    items
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const windowHours = (Date.now() - new Date(items[items.length - 1].publishedAt).getTime()) / 3_600_000;
  console.log(
    `Collected ${items.length} events from ${providers.filter((p) => p.count > 0).length}/${providers.length} providers ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s (latest ${items[0].publishedAt}, oldest ${items[items.length - 1].publishedAt}, span ${windowHours.toFixed(1)}h)`
  );
  for (const provider of providers) {
    console.log(`  ${provider.count > 0 ? "ok  " : "MISS"} ${provider.id.padEnd(16)} ${String(provider.count).padStart(4)}${provider.error ? `  ${provider.error}` : ""}`);
  }
  if (errors.length) console.warn(`WARN: ${errors.length} provider error(s), first: ${errors[0]}`);
  return payload;
}

export { DATA_DIR, OUT_FILE, ROOT };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Event sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}
