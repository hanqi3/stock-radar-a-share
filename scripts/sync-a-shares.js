import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(DATA_DIR, "all-a-shares.json");
const META_FILE = path.join(DATA_DIR, "meta.json");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 700;
const PAGE_DELAY_MS = 60;
const MIN_EXPECTED_STOCKS = 4000;
const COVERAGE_RATIO = 0.98;
const HARD_PAGE_CAP = 250;

// A transient upstream outage can outlast the per-request retries, so pages that
// failed the first pass get one more chance after a cool-down. If a run of pages
// fails that long, the upstream is down rather than flaky and we give up early.
const RETRY_PASS_COOLDOWNS_MS = [15000];
const ABORT_AFTER_CONSECUTIVE_FAILURES = 15;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * 400);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "-" || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toPositiveNumber(value) {
  const number = toNumber(value);
  return number === null || number <= 0 ? null : number;
}

function inferExchange(code) {
  if (/^(600|601|603|605|688|689)/.test(code)) return "SH";
  if (/^(000|001|002|003|300|301|302)/.test(code)) return "SZ";
  if (/^(4|8|9)/.test(code)) return "BJ";
  return "CN";
}

function inferBoard(code) {
  if (/^(688|689)/.test(code)) return "科创板";
  if (/^(300|301)/.test(code)) return "创业板";
  if (/^(4|8|9)/.test(code)) return "北交所";
  if (/^(600|601|603|605)/.test(code)) return "沪市主板";
  if (/^(000|001|002|003|302)/.test(code)) return "深市主板";
  return "未分类";
}

/**
 * The on-disk contract consumed by server.js and public/app.js.
 * All money is in CNY yuan, turnover in percent, volume in lots (手).
 */
function normalizeStock(partial) {
  const code = String(partial.code ?? "").trim().padStart(6, "0");
  return {
    code,
    name: (partial.name ?? "").trim(),
    exchange: inferExchange(code),
    board: inferBoard(code),
    price: toPositiveNumber(partial.price),
    changePct: toNumber(partial.changePct),
    change: toNumber(partial.change),
    volume: toNumber(partial.volume),
    amount: toNumber(partial.amount),
    turnover: toNumber(partial.turnover),
    marketCap: toNumber(partial.marketCap),
    source: partial.source ?? null
  };
}

function compareStocks(a, b) {
  return a.exchange.localeCompare(b.exchange) || a.code.localeCompare(b.code);
}

// ---------------------------------------------------------------------------
// Provider: Sina (primary)
//
// Two independent mirrors serve the same JSON API, it answers in ~5s for the
// whole market, and it excludes delisted/suspended shells that Eastmoney still
// lists (they carry no price anyway). Units differ from Eastmoney:
//   volume        shares        -> /100 = lots
//   amount        yuan          -> as-is
//   mktcap        ten-thousand yuan -> *10000 = yuan
//   turnoverratio percent       -> as-is
// ---------------------------------------------------------------------------

const SINA_MIRRORS = [
  "https://vip.stock.finance.sina.com.cn",
  "https://money.finance.sina.com.cn"
];
const SINA_PATH = "/quotes_service/api/json_v2.php";
const SINA_NODE = "hs_a";
const SINA_PAGE_SIZE = 100;

let sinaActiveMirror = SINA_MIRRORS[0];

function sinaUrl(pathAndQuery, mirror = sinaActiveMirror) {
  return `${mirror}${SINA_PATH}/${pathAndQuery}`;
}

function sinaPageQuery(page) {
  return `Market_Center.getHQNodeData?page=${page}&num=${SINA_PAGE_SIZE}&sort=symbol&asc=1&node=${SINA_NODE}`;
}

function sinaPageUrl(page, mirror = sinaActiveMirror) {
  return sinaUrl(sinaPageQuery(page), mirror);
}

async function sinaRequest(pathAndQuery) {
  const mirrors = [
    sinaActiveMirror,
    ...SINA_MIRRORS.filter((mirror) => mirror !== sinaActiveMirror)
  ];
  const failures = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    for (const mirror of mirrors) {
      try {
        const response = await fetch(sinaUrl(pathAndQuery, mirror), {
          headers: { "user-agent": BROWSER_UA, referer: "https://finance.sina.com.cn/" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const text = await response.text();
        if (mirror !== sinaActiveMirror) {
          console.log(`Sina: switched mirror to ${mirror}`);
          sinaActiveMirror = mirror;
        }
        return text;
      } catch (error) {
        failures.push(`${mirror} attempt ${attempt}: ${error?.message || error}`);
      }
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(jitter(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }

  throw new Error(`sina request failed after ${MAX_ATTEMPTS} attempts:\n    ${failures.join("\n    ")}`);
}

function sinaNormalize(row) {
  const shares = toNumber(row.volume);
  const mktcapWan = toNumber(row.mktcap);
  return {
    code: row.code,
    name: row.name,
    price: row.trade,
    changePct: row.changepercent,
    change: row.pricechange,
    volume: shares === null ? null : Math.round(shares / 100),
    amount: toNumber(row.amount),
    turnover: toNumber(row.turnoverratio),
    marketCap: mktcapWan === null ? null : Math.round(mktcapWan * 10000)
  };
}

const sinaProvider = {
  id: "sina",
  label: "Sina Finance market centre (hs_a)",
  async open() {
    const text = (await sinaRequest(`Market_Center.getHQNodeStockCount?node=${SINA_NODE}`)).trim();
    let total;
    try {
      total = Number(JSON.parse(text));
    } catch {
      total = Number.NaN;
    }
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error(`unexpected stock count payload: ${text.slice(0, 80)}`);
    }
    return { total, pageCount: Math.ceil(total / SINA_PAGE_SIZE), sourceUrl: sinaPageUrl(1) };
  },
  async fetchPage(page) {
    // sinaRequest takes a path+query; sinaPageUrl is only for display in meta.
    const text = (await sinaRequest(sinaPageQuery(page))).trim();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`unexpected payload (${text.slice(0, 80)})`);
    }
    if (!Array.isArray(payload)) {
      throw new Error(`unexpected payload shape (${typeof payload})`);
    }
    if (payload.length === 0) {
      throw new Error(`empty page payload (page ${page})`);
    }
    return { rows: payload.map(sinaNormalize), isLast: payload.length < SINA_PAGE_SIZE };
  }
};

// ---------------------------------------------------------------------------
// Provider: Tencent (secondary)
//
// Covers the Shanghai/Shenzhen universe only (the board has no STAR/BSE
// section), so it yields a slightly smaller pool than Sina but is a fully
// independent operator. Units:
//   volume   lots      -> as-is
//   turnover ten-thousand yuan -> *10000 = yuan
//   hsl      percent   -> as-is
//   zsz      hundred-million yuan -> *1e8 = yuan
// ---------------------------------------------------------------------------

const TENCENT_HOST = "https://proxy.finance.qq.com";
const TENCENT_BOARD = "aStock";
const TENCENT_PAGE_SIZE = 100;

function tencentUrl(offset) {
  return (
    `${TENCENT_HOST}/cgi/cgi-bin/rank/hs/getBoardRankList` +
    `?board_code=${TENCENT_BOARD}&sort_type=price&direct=down&offset=${offset}&count=${TENCENT_PAGE_SIZE}`
  );
}

async function tencentRequest(offset) {
  const failures = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(tencentUrl(offset), {
        headers: { "user-agent": BROWSER_UA, referer: "https://gu.qq.com/" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const payload = await response.json();
      const rows = payload?.data?.rank_list;
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`unexpected payload (rows=${rows?.length ?? 0})`);
      }
      return { rows, total: Number(payload?.data?.total || 0) };
    } catch (error) {
      failures.push(`offset ${offset} attempt ${attempt}: ${error?.message || error}`);
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(jitter(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }

  throw new Error(`tencent request failed after ${MAX_ATTEMPTS} attempts:\n    ${failures.join("\n    ")}`);
}

function tencentNormalize(row) {
  const amountWan = toNumber(row.turnover);
  const capYi = toNumber(row.zsz);
  return {
    // Tencent quotes are prefixed with the market, e.g. "sh600519".
    code: String(row.code || "").replace(/^[a-z]{2}/i, ""),
    name: row.name,
    price: row.zxj,
    changePct: row.zdf,
    change: row.zd,
    volume: toNumber(row.volume),
    amount: amountWan === null ? null : Math.round(amountWan * 10000),
    turnover: toNumber(row.hsl),
    marketCap: capYi === null ? null : Math.round(capYi * 1e8)
  };
}

const tencentProvider = {
  id: "tencent",
  label: "Tencent Finance board rank (aStock)",
  async open() {
    const { total } = await tencentRequest(0);
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error(`unexpected board total (${total})`);
    }
    return { total, pageCount: Math.ceil(total / TENCENT_PAGE_SIZE), sourceUrl: tencentUrl(0) };
  },
  async fetchPage(page) {
    const offset = (page - 1) * TENCENT_PAGE_SIZE;
    const { rows, total } = await tencentRequest(offset);
    return {
      rows: rows.map(tencentNormalize),
      isLast: offset + rows.length >= total || rows.length < TENCENT_PAGE_SIZE
    };
  }
};

// ---------------------------------------------------------------------------
// Provider: Eastmoney (last resort)
//
// Kept as a final fallback: it is the only source that still lists delisted and
// long-suspended shells, and from some networks it is the only one reachable.
// Units: f5 lots, f6 yuan, f8 percent, f20 yuan.
// ---------------------------------------------------------------------------

const EASTMONEY_HOSTS = [
  "https://push2delay.eastmoney.com",
  "https://push2.eastmoney.com",
  "https://82.push2.eastmoney.com"
];
const EASTMONEY_API_PATH = "/api/qt/clist/get";
const EASTMONEY_QUERY =
  "po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f12,f14,f2,f3,f4,f5,f6,f8,f20";
const EASTMONEY_PAGE_SIZE = 100;

let eastmoneyActiveHost = EASTMONEY_HOSTS[0];

function eastmoneyUrl(page, host = eastmoneyActiveHost) {
  return `${host}${EASTMONEY_API_PATH}?pn=${page}&pz=${EASTMONEY_PAGE_SIZE}&${EASTMONEY_QUERY}`;
}

function eastmoneyNormalize(row) {
  return {
    code: String(row.f12 || "").padStart(6, "0"),
    name: row.f14,
    price: row.f2,
    changePct: row.f3,
    change: row.f4,
    volume: toNumber(row.f5),
    amount: toNumber(row.f6),
    turnover: toNumber(row.f8),
    marketCap: toNumber(row.f20)
  };
}

async function eastmoneyRequest(page) {
  const hosts = [
    eastmoneyActiveHost,
    ...EASTMONEY_HOSTS.filter((host) => host !== eastmoneyActiveHost)
  ];
  const failures = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    for (const host of hosts) {
      try {
        const response = await fetch(eastmoneyUrl(page, host), {
          headers: { "user-agent": BROWSER_UA, referer: "https://quote.eastmoney.com/" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const payload = await response.json();
        const rows = payload?.data?.diff;
        const total = Number(payload?.data?.total || 0);
        if (!Array.isArray(rows) || rows.length === 0 || total === 0) {
          throw new Error(`unexpected payload (rows=${rows?.length ?? 0}, total=${total})`);
        }
        if (host !== eastmoneyActiveHost) {
          console.log(`Eastmoney: switched data host to ${host}`);
          eastmoneyActiveHost = host;
        }
        return { rows, total };
      } catch (error) {
        failures.push(`${host} attempt ${attempt}: ${error?.message || error}`);
      }
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(jitter(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }

  throw new Error(`eastmoney request failed after ${MAX_ATTEMPTS} attempts:\n    ${failures.join("\n    ")}`);
}

const eastmoneyProvider = {
  id: "eastmoney",
  label: "Eastmoney clist (delayed quotes)",
  async open() {
    const { total } = await eastmoneyRequest(1);
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error(`unexpected universe total (${total})`);
    }
    return { total, pageCount: Math.ceil(total / EASTMONEY_PAGE_SIZE), sourceUrl: eastmoneyUrl(1) };
  },
  async fetchPage(page) {
    const { rows, total } = await eastmoneyRequest(page);
    return {
      rows: rows.map(eastmoneyNormalize),
      isLast: page >= Math.ceil(total / EASTMONEY_PAGE_SIZE)
    };
  }
};

export const PROVIDERS = [sinaProvider, tencentProvider, eastmoneyProvider];

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

async function pullPages(provider, queuedPages, sink, { stopOnRunOfFailures }) {
  const failed = [];
  let consecutiveFailures = 0;

  for (const page of queuedPages) {
    try {
      const { rows } = await provider.fetchPage(page);
      sink.push(...rows);
      consecutiveFailures = 0;
    } catch (error) {
      // A single stubborn page should not throw away an otherwise complete
      // sync; the coverage guard below still rejects a genuinely broken payload.
      failed.push(page);
      consecutiveFailures += 1;
      console.warn(`WARN: [${provider.id}] page ${page}: ${error.message}`);
      if (stopOnRunOfFailures && consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
        throw new Error(
          `[${provider.id}] aborting after ${consecutiveFailures} consecutive page failures; ` +
            `the data source looks unreachable.\n${error.message}`
        );
      }
    }
    if (PAGE_DELAY_MS > 0) await sleep(PAGE_DELAY_MS);
  }

  return failed;
}

async function collectUniverse(provider) {
  const { total, pageCount, sourceUrl } = await provider.open();
  const rows = [];
  const pageLimit = Math.min(pageCount ?? HARD_PAGE_CAP, HARD_PAGE_CAP);
  let failedPages = [];
  let consecutiveFailures = 0;
  let page = 1;
  let isLast = false;

  // Read the first pass sequentially so a mid-sync payload change cannot skip a
  // page; `isLast` comes from the provider rather than from a stale total, and
  // `pageLimit` keeps a failing tail from running away.
  while (!isLast && page <= pageLimit) {
    const current = page;
    page += 1;
    try {
      const result = await provider.fetchPage(current);
      rows.push(...result.rows);
      isLast = result.isLast;
      consecutiveFailures = 0;
    } catch (error) {
      // A single stubborn page should not throw away an otherwise complete
      // sync; the coverage guard below still rejects a genuinely broken payload.
      failedPages.push(current);
      consecutiveFailures += 1;
      console.warn(`WARN: [${provider.id}] page ${current}: ${error.message}`);
      if (consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
        throw new Error(
          `[${provider.id}] aborting after ${consecutiveFailures} consecutive page failures; ` +
            `the data source looks unreachable.\n${error.message}`
        );
      }
    }
    if (PAGE_DELAY_MS > 0) await sleep(PAGE_DELAY_MS);
  }

  for (const cooldownMs of RETRY_PASS_COOLDOWNS_MS) {
    if (failedPages.length === 0) break;
    console.warn(
      `[${provider.id}] retrying ${failedPages.length} page(s) after a ${Math.round(cooldownMs / 1000)}s cool-down...`
    );
    await sleep(cooldownMs);
    failedPages = await pullPages(provider, failedPages, rows, { stopOnRunOfFailures: false });
  }

  const unique = new Map();
  for (const row of rows) {
    if (row?.code) unique.set(row.code, row);
  }

  const stocks = [...unique.values()]
    .map((row) => normalizeStock({ ...row, source: provider.id }))
    .filter((stock) => stock.code && stock.name)
    .sort(compareStocks);

  if (stocks.length < MIN_EXPECTED_STOCKS || stocks.length < total * COVERAGE_RATIO) {
    throw new Error(
      `incomplete universe: ${stocks.length} of ${total} ` +
        `(expected at least ${MIN_EXPECTED_STOCKS}); failed pages: ${failedPages.join(", ") || "none"}`
    );
  }

  return { stocks, sourceUrl, reportedTotal: total, failedPages };
}

/**
 * Try each provider in order and return the first complete universe.
 */
async function resolveUniverse(providers = PROVIDERS) {
  const failures = [];

  for (const provider of providers) {
    console.log(`Trying data provider: ${provider.id} (${provider.label})`);
    try {
      const result = await collectUniverse(provider);
      return { provider, ...result };
    } catch (error) {
      failures.push(`${provider.id}: ${error.message}`);
      console.warn(`WARN: provider ${provider.id} failed: ${error.message}`);
    }
  }

  throw new Error(`All data providers failed:\n  ${failures.join("\n  ")}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const { provider, stocks, sourceUrl, reportedTotal } = await resolveUniverse();

  if (stocks.length < MIN_EXPECTED_STOCKS) {
    throw new Error(`Refusing to write ${stocks.length} stocks (minimum ${MIN_EXPECTED_STOCKS})`);
  }

  const updatedAt = new Date().toISOString();
  await fs.writeFile(OUT_FILE, `${JSON.stringify(stocks, null, 2)}\n`, "utf8");
  await fs.writeFile(
    META_FILE,
    `${JSON.stringify(
      {
        source: provider.id,
        sourceLabel: provider.label,
        sourceUrl,
        count: stocks.length,
        reportedTotal,
        updatedAt,
        note: "Generated by scripts/sync-a-shares.js. Market data is delayed/public web data and is for research only."
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`Synced ${stocks.length} A-share stocks from ${provider.id} at ${updatedAt}`);
}

export {
  main,
  collectUniverse,
  resolveUniverse,
  normalizeStock,
  inferExchange,
  inferBoard,
  sinaNormalize,
  tencentNormalize,
  eastmoneyNormalize,
  sinaPageUrl,
  tencentUrl,
  eastmoneyUrl,
  DATA_DIR,
  OUT_FILE,
  META_FILE,
  MIN_EXPECTED_STOCKS
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
