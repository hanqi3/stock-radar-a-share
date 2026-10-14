// End-to-end API smoke test: boots server.js on a throwaway port and asserts the
// documented behaviour of every public endpoint.
//
// Regression guard: a missing/blank `limit` used to be parsed as 0 because
// `Number(null) === 0`, so `GET /api/signals` and `GET /api/stocks` returned an
// empty list whenever the caller omitted the parameter.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.CHECK_API_PORT || 5179);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`ok   - ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function get(pathname) {
  const response = await fetch(`${BASE}${pathname}`);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become ready on ${BASE} within ${timeoutMs}ms`);
}

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "ignore", "inherit"]
});
let serverExit = null;
server.on("exit", (code, signal) => {
  serverExit = `code=${code} signal=${signal}`;
});

try {
  await waitForServer();

  const health = await get("/api/health");
  check("GET /api/health -> 200 ok", health.status === 200 && health.body?.ok === true);
  const universe = health.body?.stocks ?? 0;
  check("data universe loaded", universe > 0, `stocks=${universe}`);

  const overview = await get("/api/overview");
  check("GET /api/overview -> 200 with totals", overview.status === 200 && overview.body?.total === universe);

  const forecast = await get("/api/forecast");
  check("GET /api/forecast -> 200", forecast.status === 200 && typeof forecast.body === "object");

  const signalsDefault = await get("/api/signals");
  check(
    "GET /api/signals (no limit) -> default 60 items",
    signalsDefault.status === 200 && signalsDefault.body?.items?.length === 60,
    `items=${signalsDefault.body?.items?.length}`
  );

  const signalsExplicit = await get("/api/signals?limit=5");
  check("GET /api/signals?limit=5 -> 5 items", signalsExplicit.body?.items?.length === 5);

  const signalsBlank = await get("/api/signals?limit=");
  check(
    "GET /api/signals?limit= (blank) -> default 60 items",
    signalsBlank.body?.items?.length === 60,
    `items=${signalsBlank.body?.items?.length}`
  );

  const signalsJunk = await get("/api/signals?limit=abc");
  check("GET /api/signals?limit=abc -> default 60 items", signalsJunk.body?.items?.length === 60);

  const signalsCapped = await get("/api/signals?limit=999");
  check("GET /api/signals?limit=999 -> capped at 200", signalsCapped.body?.limit === 200);

  const stocksDefault = await get("/api/stocks");
  check(
    "GET /api/stocks (no limit) -> default 100 items",
    stocksDefault.status === 200 && stocksDefault.body?.limit === 100 && stocksDefault.body?.items?.length === 100,
    `limit=${stocksDefault.body?.limit} items=${stocksDefault.body?.items?.length}`
  );
  check("GET /api/stocks total matches universe", stocksDefault.body?.total === universe);

  const stocksBlank = await get("/api/stocks?limit=&offset=");
  check(
    "GET /api/stocks?limit=&offset= (blank) -> defaults 100/0",
    stocksBlank.body?.limit === 100 && stocksBlank.body?.offset === 0 && stocksBlank.body?.items?.length === 100,
    `limit=${stocksBlank.body?.limit} offset=${stocksBlank.body?.offset}`
  );

  const stocksZero = await get("/api/stocks?limit=0");
  check("GET /api/stocks?limit=0 -> clamped to 1", stocksZero.body?.limit === 1, `limit=${stocksZero.body?.limit}`);

  const stocksNegative = await get("/api/stocks?limit=-5&offset=-5");
  check(
    "GET /api/stocks?limit=-5&offset=-5 -> clamped to 1/0",
    stocksNegative.body?.limit === 1 && stocksNegative.body?.offset === 0,
    `limit=${stocksNegative.body?.limit} offset=${stocksNegative.body?.offset}`
  );

  const stocksPaged = await get("/api/stocks?limit=5&offset=10");
  const firstPage = await get("/api/stocks?limit=5&offset=0");
  check(
    "GET /api/stocks paging returns distinct rows",
    stocksPaged.body?.items?.length === 5 &&
      stocksPaged.body.items[0].code !== firstPage.body.items[0].code
  );

  const stocksCapped = await get("/api/stocks?limit=9999");
  check("GET /api/stocks?limit=9999 -> capped at 500", stocksCapped.body?.limit === 500);

  const search = await get("/api/stocks?q=600519&limit=5");
  check(
    "GET /api/stocks?q=600519 -> 1 hit",
    search.body?.total === 1 && search.body?.items?.[0]?.code === "600519",
    `total=${search.body?.total}`
  );

  const noMatch = await get("/api/stocks?q=zzzzzznotacompany");
  check("GET /api/stocks?q=<junk> -> 0 hits, limit still 100", noMatch.body?.total === 0 && noMatch.body?.limit === 100);

  for (const sort of ["score", "change", "decline", "amount", "turnover", "cap", "code"]) {
    const sorted = await get(`/api/stocks?sort=${sort}&limit=5`);
    check(`GET /api/stocks?sort=${sort} -> 5 items`, sorted.status === 200 && sorted.body?.items?.length === 5);
  }

  const badSort = await get("/api/stocks?sort=not-a-sort&limit=5");
  check("GET /api/stocks?sort=<unknown> -> falls back, still 200", badSort.status === 200 && badSort.body?.items?.length === 5);

  const detail = await get("/api/stocks/600519");
  check("GET /api/stocks/600519 -> 200 with code", detail.status === 200 && detail.body?.code === "600519");

  const missing = await get("/api/stocks/999999");
  check("GET /api/stocks/999999 -> 404", missing.status === 404);

  const unknown = await get("/api/nope");
  check("GET /api/nope -> 404", unknown.status === 404);

  const index = await fetch(`${BASE}/`);
  const html = await index.text();
  check("GET / -> 200 html shell", index.status === 200 && html.includes("<title>"));

  const traversal = await fetch(`${BASE}/../server.js`);
  check("path traversal is refused", traversal.status !== 200 || !(await traversal.text()).includes("createServer"));
} catch (error) {
  failures += 1;
  console.error(`FAIL - harness error: ${error.stack || error}`);
  if (serverExit) console.error(`FAIL - server exited early (${serverExit})`);
} finally {
  server.kill("SIGKILL");
}

if (failures > 0) {
  console.error(`\n${failures} API check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll API checks passed.");
}
