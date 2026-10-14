import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(DATA_DIR, "all-a-shares.json");
const META_FILE = path.join(DATA_DIR, "meta.json");

const PAGE_SIZE = 100;
const MIN_EXPECTED_STOCKS = 4000;

// Eastmoney serves the same clist API from several hosts. The scheduled sync
// used to fail the whole run whenever the first host rate limited us or closed
// the socket mid-handshake, so every request now fails over across hosts.
const HOSTS = [
  "https://push2delay.eastmoney.com",
  "https://push2.eastmoney.com",
  "https://82.push2.eastmoney.com"
];
const API_PATH = "/api/qt/clist/get";
const EASTMONEY_QUERY =
  "po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f12,f14,f2,f3,f4,f5,f6,f8,f20";

const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 800;
const PAGE_DELAY_MS = 150;

// A transient upstream outage can outlast the per-request retries, so pages that
// failed the first pass get one more chance after a cool-down. If a run of pages
// fails that long, the upstream is down rather than flaky and we give up early.
const RETRY_PASS_COOLDOWNS_MS = [20000];
const ABORT_AFTER_CONSECUTIVE_FAILURES = 15;

let activeHost = HOSTS[0];

function buildUrl(page, host = activeHost) {
  return `${host}${API_PATH}?pn=${page}&pz=${PAGE_SIZE}&${EASTMONEY_QUERY}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  if (value === null || value === undefined || value === "-" || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function normalizeRow(row) {
  const code = String(row.f12 || "").padStart(6, "0");
  return {
    code,
    name: row.f14 || "",
    exchange: inferExchange(code),
    board: inferBoard(code),
    price: toNumber(row.f2),
    changePct: toNumber(row.f3),
    change: toNumber(row.f4),
    volume: toNumber(row.f5),
    amount: toNumber(row.f6),
    turnover: toNumber(row.f8),
    marketCap: toNumber(row.f20),
    source: "eastmoney"
  };
}

async function pullPages(pages, sink) {
  const failed = [];
  let consecutiveFailures = 0;

  for (const page of pages) {
    try {
      const pageData = await fetchPage(page);
      sink.push(...pageData.rows);
      consecutiveFailures = 0;
    } catch (error) {
      // A single stubborn page should not throw away an otherwise complete
      // sync; the coverage guard below still rejects a genuinely broken payload.
      failed.push(page);
      consecutiveFailures += 1;
      console.warn(`WARN: ${error.message}`);
      if (consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
        throw new Error(
          `Aborting after ${consecutiveFailures} consecutive page failures; the data source looks unreachable.\n${error.message}`
        );
      }
    }
    if (PAGE_DELAY_MS > 0) await sleep(PAGE_DELAY_MS);
  }

  return failed;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const firstPage = await fetchPage(1);
  const total = firstPage.total;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const rows = [...firstPage.rows];

  const remainingPages = [];
  for (let page = 2; page <= pageCount; page += 1) remainingPages.push(page);

  let failedPages = await pullPages(remainingPages, rows);

  for (const cooldownMs of RETRY_PASS_COOLDOWNS_MS) {
    if (failedPages.length === 0) break;
    console.warn(
      `Retrying ${failedPages.length} page(s) after a ${Math.round(cooldownMs / 1000)}s cool-down...`
    );
    await sleep(cooldownMs);
    failedPages = await pullPages(failedPages, rows);
  }

  if (failedPages.length > 0) {
    console.warn(
      `WARN: ${failedPages.length}/${pageCount - 1} page(s) failed: ${failedPages.join(", ")}`
    );
  }

  const unique = new Map();
  for (const row of rows) {
    if (row?.f12) unique.set(String(row.f12), row);
  }

  if (unique.size < MIN_EXPECTED_STOCKS || unique.size < total * 0.98) {
    throw new Error(
      `Unexpected stock universe size: ${unique.size} of ${total} (expected at least ${MIN_EXPECTED_STOCKS}); ` +
        `failed pages: ${failedPages.join(", ") || "none"}`
    );
  }

  const stocks = [...unique.values()]
    .map(normalizeRow)
    .filter((stock) => stock.code && stock.name)
    .sort((a, b) => a.exchange.localeCompare(b.exchange) || a.code.localeCompare(b.code));

  const updatedAt = new Date().toISOString();
  const sourceUrl = buildUrl(1, activeHost);
  await fs.writeFile(OUT_FILE, `${JSON.stringify(stocks, null, 2)}\n`, "utf8");
  await fs.writeFile(
    META_FILE,
    `${JSON.stringify(
      {
        source: "eastmoney",
        sourceUrl,
        count: stocks.length,
        updatedAt,
        note: "Generated by scripts/sync-a-shares.js. Market data is delayed/public web data and is for research only."
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const partial = failedPages.length > 0 ? ` (partial: ${failedPages.length} page(s) missing)` : "";
  console.log(`Synced ${stocks.length} A-share stocks at ${updatedAt}${partial}`);
}

async function requestPage(page, host) {
  const response = await fetch(buildUrl(page, host), {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      referer: "https://quote.eastmoney.com/"
    },
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
  return { rows, total };
}

async function fetchPage(page) {
  const hosts = [activeHost, ...HOSTS.filter((host) => host !== activeHost)];
  const failures = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    for (const host of hosts) {
      try {
        const result = await requestPage(page, host);
        if (host !== activeHost) {
          console.log(`Page ${page}: switched data host to ${host}`);
          activeHost = host;
        }
        return result;
      } catch (error) {
        failures.push(`${host} attempt ${attempt}: ${error?.message || error}`);
      }
    }
    if (attempt < MAX_ATTEMPTS) {
      const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(backoff + Math.floor(Math.random() * 400));
    }
  }

  throw new Error(`Page ${page} failed after ${MAX_ATTEMPTS} attempts:\n    ${failures.join("\n    ")}`);
}

export { main, fetchPage, requestPage, pullPages, buildUrl, normalizeRow, HOSTS, DATA_DIR, OUT_FILE, META_FILE };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

