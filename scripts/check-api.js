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

  // Pinyin search: code, Chinese name, full pinyin and initials must all reach
  // the same row.
  const byCode = await get("/api/stocks?q=600519&limit=5");
  const byName = await get("/api/stocks?q=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0&limit=5");
  const byPinyin = await get("/api/stocks?q=guizhoumaotai&limit=5");
  const byInitials = await get("/api/stocks?q=gzmt&limit=5");
  check(
    "GET /api/stocks?q=600519 -> the same row as q=贵州茅台",
    byCode.body?.total === 1 && byName.body?.total === 1 && byName.body?.items?.[0]?.code === byCode.body?.items?.[0]?.code
  );
  check(
    "GET /api/stocks?q=guizhoumaotai -> the same row",
    byPinyin.body?.total === 1 && byPinyin.body?.items?.[0]?.code === byCode.body?.items?.[0]?.code
  );
  check(
    "GET /api/stocks?q=gzmt -> the same row",
    byInitials.body?.total === 1 && byInitials.body?.items?.[0]?.code === byCode.body?.items?.[0]?.code
  );

  const banks = await get("/api/stocks?q=yinhang&limit=500");
  check(
    "GET /api/stocks?q=yinhang -> several bank rows",
    banks.body?.total >= 2 && banks.body.items.every((item) => typeof item.code === "string")
  );

  const suggestHit = await get("/api/search?q=gzmt");
  check(
    "GET /api/search?q=gzmt -> first suggestion is 600519",
    suggestHit.status === 200 && suggestHit.body?.items?.[0]?.code === byCode.body?.items?.[0]?.code,
    `items=${JSON.stringify(suggestHit.body?.items?.slice(0, 1))}`
  );
  check("GET /api/search suggestion carries pinyin", typeof suggestHit.body?.items?.[0]?.pinyin === "string");

  const suggestBlank = await get("/api/search?q=");
  check("GET /api/search?q= (blank) -> empty list", suggestBlank.body?.count === 0 && suggestBlank.body?.items?.length === 0);

  const suggestCapped = await get("/api/search?q=600&limit=3");
  check("GET /api/search?q=600&limit=3 -> 3 suggestions", suggestCapped.body?.items?.length === 3);

  const suggestOverCap = await get("/api/search?q=a&limit=999");
  check("GET /api/search?limit=999 -> capped at 50", suggestOverCap.body?.limit === 50);

  const polyphone = await get("/api/search?q=chongqing&limit=10");
  check(
    "GET /api/search?q=chongqing -> a 重庆 name (polyphone resolved)",
    polyphone.body?.items?.some((item) => String(item.name).startsWith("重庆")),
    `names=${polyphone.body?.items?.map((item) => item.name).join(",")}`
  );

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

  const sectors = await get("/api/sectors");
  check(
    "GET /api/sectors -> 200 with industry groups",
    sectors.status === 200 && Array.isArray(sectors.body?.sectors) && sectors.body.sectors.length > 0 &&
      Number.isFinite(sectors.body?.marketAvg)
  );
  check(
    "GET /api/sectors -> industries carry relative strength",
    (sectors.body?.sectors || []).every(
      (sector) => typeof sector.name === "string" && Number.isFinite(sector.avgChangePct) && "relativeStrength" in sector
    )
  );
  check(
    "GET /api/sectors -> industries carry breadth and an anomaly score",
    (sectors.body?.sectors || []).every(
      (sector) => Number.isFinite(sector.breadth) && Number.isFinite(sector.anomalyScore) && Array.isArray(sector.flags)
    )
  );
  check(
    "GET /api/sectors -> anomaly screen lists flagged sectors",
    Array.isArray(sectors.body?.anomalies) &&
      (sectors.body.anomalies.length === 0 || sectors.body.anomalies.every((row) => row.flags.length > 0 && Number.isFinite(row.anomalyScore)))
  );

  const events = await get("/api/events?limit=5");
  check(
    "GET /api/events?limit=5 -> 200 and honours the limit",
    events.status === 200 && Array.isArray(events.body?.items) && events.body.items.length <= 5
  );
  check(
    "GET /api/events -> classified entries carry category and sentiment",
    (events.body?.items || []).every((item) => typeof item.title === "string" && typeof item.category === "string" && typeof item.sentiment === "string")
  );

  const briefing = await get("/api/briefing");
  check(
    "GET /api/briefing -> 200 with narrative and overview",
    briefing.status === 200 && Array.isArray(briefing.body?.narrative) && briefing.body.narrative.length > 0 &&
      briefing.body?.overview?.total > 0
  );
  check(
    "GET /api/briefing -> carries the sector anomaly screen",
    Array.isArray(briefing.body?.sectorAnomalies) &&
      briefing.body.sectorAnomalies.every((row) => typeof row.name === "string" && Array.isArray(row.flags))
  );
  check(
    "GET /api/briefing -> splits the narrative into China and overseas boards",
    Array.isArray(briefing.body?.narrative) &&
      Array.isArray(briefing.body?.overseas?.narrative) &&
      briefing.body.overseas.narrative.length > 0 &&
      Array.isArray(briefing.body.overseas.groups) &&
      briefing.body.overseas.groups.length > 0 &&
      Array.isArray(briefing.body.overseas.headlines),
    `overseas=${briefing.body?.overseas?.narrative?.length} groups=${briefing.body?.overseas?.groups?.length}`
  );
  check(
    "GET /api/briefing -> overseas board carries a quote for every group",
    (briefing.body?.overseas?.groups || []).length > 0 &&
      (briefing.body?.overseas?.groups || []).every(
        (entry) =>
          typeof entry.group === "string" &&
          Array.isArray(entry.items) &&
          entry.items.length > 0 &&
          entry.items.every((item) => typeof item.name === "string" && Number.isFinite(item.price))
      ),
    `groups=${(briefing.body?.overseas?.groups || []).map((entry) => entry.group).join(",")}`
  );
  check(
    "GET /api/briefing -> both boards expose the data timestamp, not the request time",
    typeof briefing.body?.dataUpdatedAt === "string" &&
      !Number.isNaN(Date.parse(briefing.body.dataUpdatedAt)) &&
      typeof briefing.body?.overseas?.dataUpdatedAt === "string" &&
      !Number.isNaN(Date.parse(briefing.body.overseas.dataUpdatedAt)) &&
      briefing.body.overseas.dataUpdatedAt <= briefing.body.overseas.generatedAt,
    `china=${briefing.body?.dataUpdatedAt} overseas=${briefing.body?.overseas?.dataUpdatedAt}`
  );

  const macro = await get("/api/macro");
  check(
    "GET /api/macro -> 200 with US treasury and fed-funds series",
    macro.status === 200 && Array.isArray(macro.body?.items) && macro.body.items.length >= 4,
    `items=${macro.body?.items?.length} updatedAt=${macro.body?.updatedAt}`
  );
  check(
    "GET /api/macro -> each yield carries value, change and basis-point move",
    (macro.body?.items || []).every(
      (item) =>
        typeof item.symbol === "string" &&
        typeof item.name === "string" &&
        Number.isFinite(item.value) &&
        Number.isFinite(item.change) &&
        Number.isFinite(item.changeBp)
    ),
    `symbols=${(macro.body?.items || []).map((item) => item.symbol).join(",")}`
  );
  check(
    "GET /api/macro -> the 10Y yield reads in percent, not basis points",
    (macro.body?.items || []).every((item) => Math.abs(item.value) < 30),
    `us10y=${(macro.body?.items || []).find((item) => item.symbol === "us10y")?.value}`
  );

  const outlook = await get("/api/outlook");
  check(
    "GET /api/outlook -> 200 with a bounded score and a named bias",
    outlook.status === 200 &&
      Number.isFinite(outlook.body?.score) &&
      outlook.body.score <= 100 &&
      outlook.body.score >= -100 &&
      typeof outlook.body?.bias === "string" &&
      outlook.body.bias.length > 0,
    `score=${outlook.body?.score} bias=${outlook.body?.bias} confidence=${outlook.body?.confidence}`
  );
  check(
    "GET /api/outlook -> weights of the available drivers sum to at most 100",
    Number.isFinite(outlook.body?.availableWeight) &&
      outlook.body.availableWeight > 0 &&
      outlook.body.availableWeight <= 100,
    `availableWeight=${outlook.body?.availableWeight} missing=${(outlook.body?.missing || []).map((item) => item.key).join(",")}`
  );
  check(
    "GET /api/outlook -> every driver shows its raw reading and its effect",
    (outlook.body?.drivers || []).length >= 6 &&
      (outlook.body.drivers || []).every(
        (driver) =>
          typeof driver.label === "string" &&
          typeof driver.rawText === "string" &&
          typeof driver.effect === "string" &&
          Number.isFinite(driver.contribution)
      ),
    `drivers=${(outlook.body?.drivers || []).length}`
  );
  check(
    "GET /api/outlook -> the macro transmission legs keep their own direction",
    (outlook.body?.transmissions || []).length >= 2 &&
      (outlook.body.transmissions || []).every(
        (item) =>
          typeof item.key === "string" &&
          ["up", "down"].includes(item.direction) &&
          Number.isFinite(item.weight) &&
          Array.isArray(item.bullish) &&
          Array.isArray(item.bearish) &&
          // A driver moves sectors in ONE direction, never both.
          !(item.bullish.length && item.bearish.length && item.bullish.some((name) => item.bearish.includes(name)))
      ),
    `transmissions=${(outlook.body?.transmissions || []).map((item) => `${item.key}:${item.direction}`).join(",")}`
  );
  check(
    "GET /api/outlook -> 利好 and 利空 never list the same industry",
    (() => {
      const bullish = new Set((outlook.body?.bullish || []).map((item) => item.label));
      return (outlook.body?.bearish || []).every((item) => !bullish.has(item.label));
    })(),
    `bullish=${(outlook.body?.bullish || []).length} bearish=${(outlook.body?.bearish || []).length}`
  );
  check(
    "GET /api/outlook -> the narrative cites the evidence it was built from",
    Array.isArray(outlook.body?.logic) &&
      outlook.body.logic.length >= 3 &&
      Array.isArray(outlook.body?.risks) &&
      outlook.body.risks.length >= 1 &&
      Array.isArray(outlook.body?.watch) &&
      outlook.body.watch.length >= 1 &&
      /09:25/.test(outlook.body.watch[0])
  );

  const sectorNews = await get("/api/sector-news?limit=31&samples=3");
  check(
    "GET /api/sector-news -> 200 with industry-level 利好/利空 counts",
    sectorNews.status === 200 &&
      Array.isArray(sectorNews.body?.items) &&
      sectorNews.body.items.length >= 5,
    `sectors=${sectorNews.body?.items?.length}`
  );
  check(
    "GET /api/sector-news -> every card has finite counts and at most N samples",
    (sectorNews.body?.items || []).every(
      (item) =>
        typeof item.industry === "string" &&
        Number.isFinite(item.bullish) &&
        Number.isFinite(item.bearish) &&
        Number.isFinite(item.net) &&
        Array.isArray(item.samples) &&
        item.samples.length <= 3 &&
        item.samples.every((sample) => typeof sample.title === "string" && ["code", "theme"].includes(sample.via))
    )
  );
  check(
    "GET /api/sector-news -> limit and sample caps are honoured",
    (await get("/api/sector-news?limit=3&samples=1")).body?.items?.length === 3,
    `limit=3 -> ${(await get("/api/sector-news?limit=3&samples=1")).body?.items?.length}`
  );

  const indices = await get("/api/indices");
  check(
    "GET /api/indices -> 200 with overseas benchmarks",
    indices.status === 200 && indices.body?.items?.length >= 20,
    `items=${indices.body?.items?.length}`
  );
  check(
    "GET /api/indices -> every quote carries a group, name and precision",
    (indices.body?.items || []).every(
      (item) =>
        typeof item.symbol === "string" &&
        typeof item.name === "string" &&
        typeof item.group === "string" &&
        Number.isInteger(item.digits) &&
        (Number.isFinite(item.price) || item.price === null)
    )
  );
  const indexGroups = new Set((indices.body?.items || []).map((item) => item.group));
  check(
    "GET /api/indices -> covers Americas, Europe/Asia, FX and commodities",
    ["美洲", "亚太欧洲", "外汇", "商品"].every((group) => indexGroups.has(group)),
    `groups=${[...indexGroups].join(",")}`
  );

  // The top strip needs real A-share index levels, and the 海外 board must not
  // count them as overseas quotes.
  const domesticIndices = (indices.body?.items || []).filter((item) => item.group === "A股指数");
  const shanghai = domesticIndices.find((item) => item.symbol === "s_sh000001");
  check(
    "GET /api/indices -> carries the A-share benchmarks for the top strip",
    domesticIndices.length >= 6 &&
      domesticIndices.every((item) => Number.isFinite(item.price) && Number.isFinite(item.changePct)),
    `domestic=${domesticIndices.length}`
  );
  check(
    "GET /api/indices -> 上证指数 is an index level, not a stock count",
    Number.isFinite(shanghai?.price) && shanghai.price > 1000,
    `sh000001=${shanghai?.price}`
  );
  const overseasBoard = await get("/api/briefing/overseas");
  check(
    "GET /api/briefing/overseas -> the overseas count excludes the A-share strip",
    overseasBoard.status === 200 &&
      overseasBoard.body?.count === (indices.body?.items || []).filter((item) => item.group !== "A股指数").length,
    `count=${overseasBoard.body?.count} overseas=${(indices.body?.items || []).filter((item) => item.group !== "A股指数").length}`
  );

  const news = await get("/api/news?limit=15");
  check(
    "GET /api/news?limit=15 -> 200 and honours the limit",
    news.status === 200 && news.body?.items?.length === 15 && news.body?.limit === 15,
    `items=${news.body?.items?.length}`
  );
  check(
    "GET /api/news -> counts split into cn and global",
    news.body?.counts?.cn + news.body?.counts?.global === news.body?.total,
    `cn=${news.body?.counts?.cn} global=${news.body?.counts?.global} total=${news.body?.total}`
  );
  check(
    "GET /api/news -> both columns are populated",
    news.body?.counts?.cn > 0 && news.body?.counts?.global > 0
  );
  check(
    "GET /api/news -> entries carry a region and a filing flag",
    (news.body?.items || []).every(
      (item) => ["cn", "global"].includes(item.region) && typeof item.title === "string" && "kind" in item
    )
  );
  check(
    "GET /api/news -> announcements are tagged as such",
    (news.body?.items || []).every((item) => item.kind === null || item.kind === "announcement")
  );

  const newsCorpus = await get("/api/news?limit=1");
  const corpusTotal = newsCorpus.body?.total ?? 0;
  const newsQuery = await get("/api/news?q=%E7%BE%8E%E8%81%94%E5%82%A8&limit=200");
  check(
    "GET /api/news?q=美联储 -> filtered subset, all matching",
    newsQuery.status === 200 &&
      newsQuery.body.items.length > 0 &&
      newsQuery.body.total < corpusTotal &&
      newsQuery.body.items.every((item) => `${item.title} ${item.summary ?? ""}`.includes("美联储")),
    `matched=${newsQuery.body?.items?.length} corpus=${corpusTotal}`
  );
  check(
    "GET /api/news?q=<junk> -> empty result, not an error",
    (await get("/api/news?q=zzzznotakeyword")).body?.items?.length === 0
  );

  const flowIn = await get("/api/flow?scope=stock&side=inflow&limit=5");
  check(
    "GET /api/flow -> 200 with five ranked stocks",
    flowIn.status === 200 && flowIn.body?.items?.length === 5,
    `items=${flowIn.body?.items?.length}`
  );
  check(
    "GET /api/flow -> declares its provider and definition",
    typeof flowIn.body?.definition === "string" && flowIn.body.definition.length > 0 && Number.isFinite(flowIn.body?.market?.mainNet)
  );
  check(
    "GET /api/flow -> entries carry the four-tier breakdown",
    (flowIn.body?.items || []).every(
      (item) =>
        typeof item.code === "string" &&
        Number.isFinite(item.mainNet) &&
        Number.isFinite(item.superNet) &&
        Number.isFinite(item.bigNet) &&
        Number.isFinite(item.midNet) &&
        Number.isFinite(item.smallNet) &&
        Number.isFinite(item.amount)
    )
  );
  const flowNets = (flowIn.body?.items || []).map((item) => item.mainNet);
  check(
    "GET /api/flow?side=inflow -> mainNet sorted descending",
    flowNets.every((value, index) => index === 0 || flowNets[index - 1] >= value),
    `nets=${flowNets.join(",")}`
  );
  check(
    "GET /api/flow?side=inflow -> every row is a net inflow",
    flowNets.every((value) => value > 0)
  );

  const flowOut = await get("/api/flow?scope=stock&side=outflow&limit=5");
  check(
    "GET /api/flow?side=outflow -> largest outflows first",
    flowOut.body?.items?.length === 5 && flowOut.body.items.every((item) => item.mainNet < 0)
  );

  const flowIndustry = await get("/api/flow?scope=industry&side=inflow&limit=8");
  check(
    "GET /api/flow?scope=industry -> aggregated 申万 industries",
    flowIndustry.status === 200 &&
      flowIndustry.body?.scope === "industry" &&
      flowIndustry.body.items.length === 8 &&
      flowIndustry.body.items.every((item) => typeof item.name === "string" && Number.isFinite(item.mainNet) && item.count > 0),
    `items=${flowIndustry.body?.items?.length}`
  );

  const flowJunk = await get("/api/flow?scope=nonsense&side=nonsense&limit=abc");
  check(
    "GET /api/flow?<junk args> -> falls back to the defaults instead of 500",
    flowJunk.status === 200 && flowJunk.body?.scope === "stock" && flowJunk.body?.side === "inflow" && flowJunk.body?.items?.length > 0,
    `scope=${flowJunk.body?.scope} side=${flowJunk.body?.side}`
  );

  check(
    "GET /api/flow -> exposes the rolling windows it was built with",
    Array.isArray(flowIn.body?.windows) &&
      flowIn.body.windows.length >= 4 &&
      flowIn.body.days > 20 &&
      typeof flowIn.body?.window?.start === "string" &&
      typeof flowIn.body?.window?.end === "string",
    `windows=${(flowIn.body?.windows || []).join(",")} days=${flowIn.body?.days}`
  );
  check(
    "GET /api/flow -> history covers the whole stored window regardless of w",
    Array.isArray(flowIn.body?.history) &&
      flowIn.body.history.length === flowIn.body.days &&
      flowIn.body.history.every((day) => typeof day.date === "string" && Number.isFinite(day.mainNet)),
    `history=${flowIn.body?.history?.length} days=${flowIn.body?.days}`
  );
  check(
    "GET /api/flow -> every row carries a number for each rolling window",
    (flowIn.body?.items || []).every((item) =>
      (flowIn.body.windows || []).every((w) => Number.isFinite(item[`main${w}`]) && Number.isFinite(item[`amount${w}`]))
    )
  );

  const flow60 = await get("/api/flow?scope=stock&side=inflow&w=60&limit=8");
  const nets60 = (flow60.body?.items || []).map((item) => item.flow);
  check(
    "GET /api/flow?w=60 -> ranks by the 60-session sum",
    flow60.status === 200 &&
      flow60.body?.w === 60 &&
      nets60.length === 8 &&
      nets60.every((value, index) => index === 0 || nets60[index - 1] >= value) &&
      (flow60.body?.items || []).every((item) => item.flow === item.main60),
    `nets=${nets60.map((v) => Math.round(v / 1e8)).join(",")}亿`
  );
  check(
    "GET /api/flow?w=60 -> w actually changes the ordering",
    JSON.stringify(nets60) !== JSON.stringify(flowNets.slice(0, 8)) ||
      JSON.stringify((flow60.body?.items || []).map((i) => i.code)) !== JSON.stringify((flowIn.body?.items || []).map((i) => i.code))
  );
  const flowIndustry60 = await get("/api/flow?scope=industry&side=inflow&w=60&limit=5");
  check(
    "GET /api/flow?scope=industry&w=60 -> industries carry the same windows",
    flowIndustry60.status === 200 &&
      flowIndustry60.body?.w === 60 &&
      flowIndustry60.body.items.every((item) => Number.isFinite(item.flow) && item.flow === item.main60)
  );
  const flowYear = await get("/api/flow?scope=stock&side=inflow&w=250&limit=8");
  const netsYear = (flowYear.body?.items || []).map((item) => item.flow);
  check(
    "GET /api/flow?w=250 -> the one-year window is stored and ranks by it",
    flowYear.status === 200 &&
      flowYear.body?.days >= 200 &&
      (flowYear.body?.windows || []).includes(250) &&
      flowYear.body?.w === 250 &&
      netsYear.length === 8 &&
      netsYear.every((value, index) => index === 0 || netsYear[index - 1] >= value) &&
      (flowYear.body?.items || []).every((item) => item.flow === item.main250),
    `days=${flowYear.body?.days} windows=${(flowYear.body?.windows || []).join(",")} nets=${netsYear.map((v) => Math.round(v / 1e8)).join(",")}亿`
  );
  check(
    "GET /api/flow?w=250 -> the year window is a real sum, not the 60-session value re-labelled",
    (flowYear.body?.items || []).some((item) => item.main250 !== item.main60) &&
      (flowYear.body?.items || []).every((item) => item.flow === item.main250),
    `changed=${(flowYear.body?.items || []).filter((item) => item.main250 !== item.main60).map((item) => `${item.name}:${Math.round(item.main250 / 1e8)} vs ${Math.round(item.main60 / 1e8)}`).join(" ")}`
  );
  const flowBadW = await get("/api/flow?w=999&limit=2");  check(
    "GET /api/flow?w=<unsupported> -> falls back to the one-session window",
    flowBadW.status === 200 && flowBadW.body?.w === 1,
    `w=${flowBadW.body?.w}`
  );

  const watch = await get("/api/watchlist?codes=600519,000001,999999");
  check("GET /api/watchlist -> 200 with one item per code", watch.status === 200 && watch.body?.items?.length === 3);
  check(
    "GET /api/watchlist -> unknown codes are flagged missing",
    watch.body?.items?.find((item) => item.code === "999999")?.missing === true
  );
  check(
    "GET /api/watchlist -> known codes carry alerts",
    (watch.body?.items || []).filter((item) => !item.missing).every((item) => Array.isArray(item.alerts))
  );

  const junkWatch = await get("/api/watchlist?codes=abc,12,600519");
  check(
    "GET /api/watchlist -> non 6-digit codes are dropped",
    junkWatch.status === 200 && junkWatch.body?.items?.length === 1 && junkWatch.body.items[0].code === "600519"
  );

  const analysis = await get("/api/stocks/600519/analysis");
  check(
    "GET /api/stocks/600519/analysis -> 200 or 502 when history is unreachable",
    analysis.status === 200 || analysis.status === 502
  );
  if (analysis.status === 200) {
    check(
      "GET /api/stocks/600519/analysis -> board-aware limit metadata",
      typeof analysis.body?.limitLabel === "string" && "limitUp" in (analysis.body || {})
    );
  }

  const history = await get("/api/stocks/600519/history?days=30");
  check(
    "GET /api/stocks/600519/history -> 200 or 502 when history is unreachable",
    history.status === 200 || history.status === 502
  );

  const badBacktest = await get("/api/backtest?codes=notacode&sessions=1");
  check(
    "GET /api/backtest -> 200/422/502 rather than 500",
    [200, 422, 502].includes(badBacktest.status)
  );

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
