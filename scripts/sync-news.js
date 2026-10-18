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
const INDICES_FILE = path.join(DATA_DIR, "indices.json");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const DEFAULTS = {
  timeoutMs: 20000,
  maxAttempts: 3,
  // The 中国 | 海外 boards both need depth, so the feed keeps more than the
  // announcement firehose alone would need.
  maxEvents: 900,
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
  { tagId: 2, label: "数据" },
  // tag 102 is the overseas desk: US/HK/Japan/Europe macro and market wire.
  { tagId: 102, label: "国际" }
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
  { lid: 2509, label: "财经" }
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

export function parseKuaixun(text, meta = {}) {
  const json = String(text).replace(/^var\s+ajaxResult\s*=\s*/, "").trim();
  const payload = JSON.parse(json);
  const list = payload?.LivesList;
  if (!Array.isArray(list)) throw new Error("unexpected payload shape (no LivesList)");
  return list.map((item) => ({
    id: `em-kuaixun-${item.id || item.url_w || item.title}`,
    title: stripTags(item.title),
    summary: stripTags(item.digest || ""),
    url: item.url_w || item.url_unique || "",
    source: `东方财富快讯${meta.label ? `·${meta.label}` : ""}`,
    publishedAt: toIso(item.showtime)
  }));
}

// Eastmoney splits its 7x24 wire into channels; 102 is the firehose, the rest are
// desks that carry overseas central-bank / macro / commodity coverage.
export const KUAIXUN_CHANNELS = [
  { channel: 102, label: "", pages: 2 },
  { channel: 111, label: "宏观", pages: 1 },
  { channel: 119, label: "美国·美联储", pages: 1 },
  { channel: 120, label: "欧洲央行", pages: 1 },
  { channel: 122, label: "日本央行", pages: 1 },
  { channel: 107, label: "外汇债券", pages: 1 },
  { channel: 106, label: "期货商品", pages: 1 }
];

export async function fetchEastmoneyKuaixun(
  settings = DEFAULTS,
  channels = KUAIXUN_CHANNELS
) {
  const items = [];
  for (const { channel, label = "", pages = 1 } of channels) {
    for (let page = 1; page <= pages; page += 1) {
      const url = `https://newsapi.eastmoney.com/kuaixun/v1/getlist_${channel}_ajaxResult_50_${page}_.html`;
      try {
        items.push(
          ...parseKuaixun(
            await request(url, { headers: { referer: "https://kuaixun.eastmoney.com/" } }, settings),
            { label }
          )
        );
      } catch (error) {
        items.push({ __error: `em-kuaixun[${channel}/${page}]: ${error.message}` });
      }
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
    kind: "announcement",
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
      kind: "announcement",
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

// --- global markets ---------------------------------------------------------
//
// One Sina batch call covers the overseas benchmarks the "海外" column needs.
// Field layouts differ per family, so each prefix gets its own reader:
//   gb_*   名称,最新,涨跌幅%,时间,涨跌额,昨收,今开,最高,最低,...
//   int_*  名称,最新,涨跌额,涨跌幅%
//   rt_hk* 代码,名称,今开,昨收,最高,最低,最新,涨跌额,涨跌幅%,...,日期,时间
//   hf_*   最新,?,买,卖,最高,最低,时间,昨收,今开,...,日期,名称
//   fx_*   时间,买,卖,?,?,昨收,今开,最低,最新,名称,涨跌幅%,涨跌额,振幅,...,日期
//   DINIW  时间,买,卖,?,?,昨收,今开,最低,最新,名称,日期
//
// All of it arrives in ONE batch call, so the 海外 board costs a single request.
export const GLOBAL_INDEX_SYMBOLS = [
  // 美洲
  { symbol: "gb_dji", name: "道琼斯", group: "美洲" },
  { symbol: "gb_ixic", name: "纳斯达克", group: "美洲" },
  { symbol: "gb_inx", name: "标普500", group: "美洲" },
  { symbol: "gb_ndx", name: "纳斯达克100", group: "美洲" },
  { symbol: "gb_sox", name: "费城半导体", group: "美洲" },
  // 美股龙头（中概/科技）
  { symbol: "gb_nvda", name: "英伟达", group: "美股龙头" },
  { symbol: "gb_aapl", name: "苹果", group: "美股龙头" },
  { symbol: "gb_tsm", name: "台积电", group: "美股龙头" },
  { symbol: "gb_baba", name: "阿里巴巴", group: "美股龙头" },
  // 亚太 / 欧洲
  { symbol: "int_nikkei", name: "日经225", group: "亚太欧洲" },
  { symbol: "rt_hkHSI", name: "恒生指数", group: "亚太欧洲" },
  { symbol: "rt_hkHSCEI", name: "恒生国企", group: "亚太欧洲" },
  { symbol: "int_ftse", name: "伦敦富时", group: "亚太欧洲" },
  // 富时中国 A50 期货：A 股休市后仍在交易的唯一「明日开盘」定价，明日参考的核心输入。
  { symbol: "hf_CHA50CFD", name: "富时中国A50期货", group: "亚太欧洲" },
  // 外汇
  { symbol: "DINIW", name: "美元指数", group: "外汇", digits: 3 },
  { symbol: "fx_susdcnh", name: "离岸人民币", group: "外汇", digits: 4 },
  { symbol: "fx_susdcny", name: "在岸人民币", group: "外汇", digits: 4 },
  { symbol: "fx_susdjpy", name: "美元日元", group: "外汇", digits: 3 },
  { symbol: "fx_seurcnh", name: "欧元离岸人民币", group: "外汇", digits: 4 },
  { symbol: "fx_sgbpusd", name: "英镑美元", group: "外汇", digits: 4 },
  { symbol: "fx_saudcnh", name: "澳元离岸人民币", group: "外汇", digits: 4 },
  { symbol: "fx_susdchf", name: "美元瑞郎", group: "外汇", digits: 4 },
  { symbol: "fx_susdhkd", name: "美元港元", group: "外汇", digits: 4 },
  { symbol: "fx_susdkrw", name: "美元韩元", group: "外汇" },
  // 商品
  { symbol: "hf_GC", name: "纽约黄金", group: "商品" },
  { symbol: "hf_SI", name: "纽约白银", group: "商品" },
  { symbol: "hf_CL", name: "纽约原油", group: "商品" },
  { symbol: "hf_OIL", name: "布伦特原油", group: "商品" },
  { symbol: "hf_HG", name: "美铜", group: "商品" },
  { symbol: "hf_CAD", name: "伦铜", group: "商品" },
  { symbol: "hf_AHD", name: "伦铝", group: "商品" },
  { symbol: "hf_NG", name: "美国天然气", group: "商品", digits: 3 },
  { symbol: "hf_S", name: "美国大豆", group: "商品" },
  { symbol: "hf_C", name: "美国玉米", group: "商品" },
  { symbol: "hf_W", name: "美国小麦", group: "商品" },
  { symbol: "hf_CT", name: "美国棉花", group: "商品" }
];

const SINA_QUOTE_HOST = "https://hq.sinajs.cn/list=";

function num(value) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits ?? 2));
}

// Sina stamps quotes as local Beijing time in a mix of "2026-10-15 09:49",
// "2026/10/15 16:09:30", "2026-10-15"+"19:29:38" and "19:29:33"+"2026-10-15".
function sinoStamp(date, time) {
  const day = String(date ?? "").trim().replace(/\//g, "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const clock = String(time ?? "").trim();
  const hhmmss = /^\d{2}:\d{2}(:\d{2})?$/.test(clock) ? (clock.length === 5 ? `${clock}:00` : clock) : "00:00:00";
  const parsed = new Date(`${day}T${hhmmss}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseGlobalQuotes(text, now = new Date()) {
  const symbols = new Map(GLOBAL_INDEX_SYMBOLS.map((entry) => [entry.symbol, entry]));
  const items = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/var hq_str_(\w+)="([^"]*)"/);
    if (!match) continue;
    const meta = symbols.get(match[1]);
    const raw = match[2];
    if (!meta || !raw) continue;
    const parts = raw.split(",");
    let price = null;
    let changePct = null;
    let change = null;
    let updatedAt = now.toISOString();

    if (match[1].startsWith("gb_")) {
      price = num(parts[1]);
      changePct = num(parts[2]);
      change = num(parts[4]);
      // parts[3] is "YYYY-MM-DD HH:MM" in Beijing time.
      const stamp = String(parts[3] ?? "").trim();
      if (stamp) {
        const parsed = new Date(`${stamp.replace(/\//g, "-").replace(" ", "T")}+08:00`);
        if (!Number.isNaN(parsed.getTime())) updatedAt = parsed.toISOString();
      }
    } else if (match[1].startsWith("rt_hk")) {
      price = num(parts[6]);
      change = num(parts[7]);
      changePct = num(parts[8]);
      updatedAt = sinoStamp(parts[17], parts[18]) || updatedAt;
    } else if (match[1].startsWith("int_")) {
      price = num(parts[1]);
      change = num(parts[2]);
      changePct = num(parts[3]);
    } else if (match[1].startsWith("hf_")) {
      price = num(parts[0]);
      const prev = num(parts[7]);
      if (price !== null && prev) {
        change = price - prev;
        changePct = (change / prev) * 100;
      }
      updatedAt = sinoStamp(parts[12], parts[6]) || updatedAt;
    } else {
      // fx_* carries 涨跌幅% / 涨跌额 explicitly; DINIW has neither and is
      // derived from 昨收 (parts[5]) instead.
      price = num(parts[8]) ?? num(parts[1]);
      const prev = num(parts[5]);
      const pct = num(parts[10]);
      const diff = num(parts[11]);
      if (Number.isFinite(pct) && Number.isFinite(diff)) {
        changePct = pct;
        change = diff;
      } else if (price !== null && prev) {
        change = price - prev;
        changePct = (change / prev) * 100;
      }
      updatedAt = sinoStamp(parts[17] ?? parts[10], parts[0]) || updatedAt;
    }

    if (price === null && changePct === null) continue;
    items.push({
      symbol: match[1],
      name: meta.name,
      group: meta.group,
      digits: meta.digits ?? 2,
      price: round(price, meta.digits),
      change: round(change, meta.digits),
      changePct: changePct === null ? null : Number(changePct.toFixed(2)),
      updatedAt
    });
  }
  return items;
}

export async function fetchGlobalIndices(settings = DEFAULTS, fetchImpl = fetch) {
  const url = SINA_QUOTE_HOST + GLOBAL_INDEX_SYMBOLS.map((entry) => entry.symbol).join(",");
  const { timeoutMs = DEFAULTS.timeoutMs, maxAttempts = DEFAULTS.maxAttempts } = settings;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          "user-agent": BROWSER_UA,
          Referer: "https://finance.sina.com.cn/"
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      // hq.sinajs.cn answers in GBK, so read bytes and decode explicitly.
      const buffer = Buffer.from(await response.arrayBuffer());
      return parseGlobalQuotes(new TextDecoder("gbk").decode(buffer));
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(400 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${url} failed after ${maxAttempts} attempts: ${lastError?.message || lastError}`);
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

  let indices = { generatedAt: payload.generatedAt, count: 0, items: [] };
  try {
    const indexItems = await fetchGlobalIndices();
    if (indexItems.length) {
      indices = {
        generatedAt: payload.generatedAt,
        source: "sina-hq",
        count: indexItems.length,
        note: "Overseas benchmarks and commodities quoted by Sina hq.sinajs.cn.",
        items: indexItems
      };
      await fs.writeFile(INDICES_FILE, `${JSON.stringify(indices, null, 2)}\n`, "utf8");
    } else {
      errors.push("global indices: empty response");
    }
  } catch (error) {
    // Overseas quotes are a nice-to-have: never fail the event sync for them.
    errors.push(`global indices: ${error.message}`);
  }

  const windowHours = (Date.now() - new Date(items[items.length - 1].publishedAt).getTime()) / 3_600_000;
  console.log(
    `Collected ${items.length} events from ${providers.filter((p) => p.count > 0).length}/${providers.length} providers ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s (latest ${items[0].publishedAt}, oldest ${items[items.length - 1].publishedAt}, span ${windowHours.toFixed(1)}h)`
  );
  for (const provider of providers) {
    console.log(`  ${provider.count > 0 ? "ok  " : "MISS"} ${provider.id.padEnd(16)} ${String(provider.count).padStart(4)}${provider.error ? `  ${provider.error}` : ""}`);
  }
  console.log(`  ${indices.count > 0 ? "ok  " : "MISS"} ${"global-indices".padEnd(16)} ${String(indices.count).padStart(4)}`);
  if (errors.length) console.warn(`WARN: ${errors.length} provider error(s), first: ${errors[0]}`);
  return { ...payload, indices };
}

export { DATA_DIR, OUT_FILE, INDICES_FILE, ROOT };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Event sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}
