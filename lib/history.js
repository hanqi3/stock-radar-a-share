/**
 * Daily K-line history.
 *
 * Two providers serve adjusted daily bars and both are reachable from networks
 * where Eastmoney's push2his is not:
 *
 *   sina    CN_MarketData.getKLineData   up to ~2000 bars, volume in 股
 *   tencent fqkline/get (qfqday)         up to ~800 bars,  volume in 手
 *
 * Tencent's row order is [date, open, close, high, low, volume] — NOT the
 * OHLC order the field names suggest — so it is decoded explicitly.
 *
 * Everything leaving this module uses the project-wide contract: prices in 元
 * with two decimals, volume in 手.
 */

export const SINA_HISTORY_HOST = "https://money.finance.sina.com.cn";
export const SINA_HISTORY_PATH = "/quotes_service/api/json_v2.php/CN_MarketData.getKLineData";
// Sina returns a bare JSON array and honours datalen up to 1023 reliably.
export const SINA_HISTORY_DAYS = 1023;

// `web.ifzq.gtimg.cn` is WAF-blocked (HTTP 501); these two hosts serve the same
// path and payload. proxy.finance.qq.com is the primary, ifzq.gtimg.cn the
// fallback that was also observed working.
export const TENCENT_HISTORY_HOSTS = [
  "https://proxy.finance.qq.com/ifzqgtimg",
  "https://ifzq.gtimg.cn"
];
export const TENCENT_HISTORY_PATH = "/appstock/app/fqkline/get";
export const TENCENT_HISTORY_DAYS = 800;

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Exchange prefix used by both Sina and Tencent symbol syntax. */
export function marketPrefix(exchange) {
  if (exchange === "SH") return "sh";
  if (exchange === "SZ") return "sz";
  if (exchange === "BJ") return "bj";
  return "sh";
}

export function symbolFor(code, exchange) {
  return `${marketPrefix(exchange)}${code}`;
}

export function sinaHistoryUrl(code, exchange, days = 250) {
  const limit = Math.min(Math.max(Math.trunc(days) || 250, 1), SINA_HISTORY_DAYS);
  return `${SINA_HISTORY_HOST}${SINA_HISTORY_PATH}?symbol=${symbolFor(code, exchange)}&scale=240&ma=no&datalen=${limit}`;
}

export function tencentHistoryUrl(code, exchange, days = 250, host = TENCENT_HISTORY_HOSTS[0]) {
  const limit = Math.min(Math.max(Math.trunc(days) || 250, 1), TENCENT_HISTORY_DAYS);
  return `${host}${TENCENT_HISTORY_PATH}?param=${symbolFor(code, exchange)},day,,,${limit},qfq`;
}

function toPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

function toVolumeLots(shares) {
  const number = Number(shares);
  if (!Number.isFinite(number)) return null;
  return Math.round(number / 100);
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  // Round-trip so impossible dates (2026-13-99) cannot roll over silently.
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

/** Sort, de-duplicate and validate a bar series (oldest first). */
export function normalizeBars(bars) {
  const byDate = new Map();
  for (const bar of bars) {
    const date = validDate(bar?.date);
    if (!date) continue;
    if (bar.close === null || bar.close === undefined || !Number.isFinite(bar.close)) continue;
    const high = bar.high ?? bar.close;
    const low = bar.low ?? bar.close;
    if (high < low) continue;
    byDate.set(date, {
      date,
      open: bar.open ?? bar.close,
      high,
      low,
      close: bar.close,
      volume: Number.isFinite(bar.volume) ? bar.volume : 0
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Sina returns a bare JSON array; volume is in 股. */
export function parseSinaKline(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(payload)) return [];
  return normalizeBars(
    payload.map((row) => ({
      date: row?.day,
      open: toPrice(row?.open),
      high: toPrice(row?.high),
      low: toPrice(row?.low),
      close: toPrice(row?.close),
      volume: toVolumeLots(row?.volume)
    }))
  );
}

/** Tencent returns {data:{symbol:{qfqday:[[date,open,close,high,low,vol]]}}}; volume is in 手. */
export function parseTencentKline(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  const node = payload?.data?.[Object.keys(payload?.data || {})[0]];
  if (!node) return [];
  const rows = node.qfqday || node.day || node.hfqday;
  if (!Array.isArray(rows)) return [];
  return normalizeBars(
    rows
      .filter((row) => Array.isArray(row) && row.length >= 6)
      .map((row) => ({
        date: row[0],
        open: toPrice(row[1]),
        close: toPrice(row[2]),
        high: toPrice(row[3]),
        low: toPrice(row[4]),
        volume: Math.round(Number(row[5])) || 0
      }))
  );
}

export const HISTORY_PROVIDERS = [
  {
    id: "sina",
    label: "Sina Finance K-line",
    url: (code, exchange, days) => sinaHistoryUrl(code, exchange, days),
    parse: parseSinaKline,
    headers: { referer: "https://finance.sina.com.cn/" },
    maxDays: SINA_HISTORY_DAYS
  },
  {
    id: "tencent",
    label: "Tencent Finance K-line",
    url: (code, exchange, days) => tencentHistoryUrl(code, exchange, days),
    parse: parseTencentKline,
    headers: { referer: "https://gu.qq.com/" },
    maxDays: TENCENT_HISTORY_DAYS
  }
];

/**
 * Fetch daily bars for one stock, trying each provider in order.
 * Returns { code, source, bars, attempts } or throws when every provider fails.
 */
export async function fetchDailyBars(code, exchange, options = {}) {
  const days = options.days ?? 250;
  const timeoutMs = options.timeoutMs ?? 20000;
  const providers = options.providers ?? HISTORY_PROVIDERS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = [];

  for (const provider of providers) {
    try {
      const response = await fetchImpl(provider.url(code, exchange, days), {
        headers: { "user-agent": BROWSER_UA, ...(provider.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        attempts.push(`${provider.id}: HTTP ${response.status}`);
        continue;
      }
      const text = await response.text();
      const bars = provider.parse(text);
      if (!bars.length) {
        attempts.push(`${provider.id}: empty series`);
        continue;
      }
      return { code, source: provider.id, bars, attempts };
    } catch (error) {
      attempts.push(`${provider.id}: ${error?.cause?.code || error.name}: ${error.message}`);
    }
  }

  throw new Error(`no history provider could serve ${code}:\n  ${attempts.join("\n  ")}`);
}
