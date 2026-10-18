import test from "node:test";
import assert from "node:assert/strict";

import { buildOutlook, nextTradingDay, DRIVER_WEIGHTS } from "../lib/outlook.js";
import { buildSectorNews, THEME_INDUSTRIES } from "../lib/sector-news.js";

const NOW = new Date("2026-10-17T02:00:00.000Z");

function quote(symbol, name, price, changePct, extra = {}) {
  return { symbol, name, price, change: null, changePct, group: "test", digits: 2, updatedAt: "2026-10-16T20:00:00.000Z", ...extra };
}

function yieldItem(symbol, name, value, prevValue) {
  // data/macro.json keeps `change` in percentage points and `changeBp` in basis points.
  const change = Number((value - prevValue).toFixed(4));
  return { symbol, name, group: "美债", kind: "rate", digits: 3, unit: "%", value, prevValue, change, changeBp: Math.round(change * 100), changePct: null, updatedAt: "2026-10-15" };
}

function levelItem(symbol, name, value, prevValue) {
  // A level series (VIX) reports a percentage change, never basis points.
  const change = Number((value - prevValue).toFixed(4));
  return {
    symbol,
    name,
    group: "风险",
    kind: "level",
    digits: 2,
    unit: "",
    value,
    prevValue,
    change,
    changeBp: null,
    changePct: Number(((change / prevValue) * 100).toFixed(2)),
    updatedAt: "2026-10-15"
  };
}

/** A fully-populated, internally consistent input set. */
function baseInput(overrides = {}) {
  return {
    now: NOW,
    meta: { updatedAt: "2026-10-15T10:39:28.911Z" },
    stocks: [{ code: "600519", changePct: -3.04 }, { code: "000001", changePct: -2.5 }, { code: "300750", changePct: -4.1 }],
    briefing: {
      overview: { advancers: 429, decliners: 5108 },
      limitUpCount: 38,
      limitDownCount: 46,
      themes: [{ theme: "人工智能" }],
      sectorAnomalies: []
    },
    flow: {
      date: "2026-10-15",
      market: { mainNet: -637.56e8, amount: 16454e8, inflows: 1594, outflows: 3932 },
      industries: [
        { name: "食品饮料", mainNet: 4.2e8 },
        { name: "医药生物", mainNet: 3.0e8 },
        { name: "电子", mainNet: -136.44e8 },
        { name: "通信", mainNet: -90.61e8 }
      ]
    },
    indices: [
      quote("hf_CHA50CFD", "富时中国A50期货", 13278.83, -0.46),
      quote("gb_dji", "道琼斯", 51621.48, -0.34),
      quote("gb_inx", "标普500", 7718.94, -1.09),
      quote("gb_ixic", "纳斯达克", 26692.87, -2.14),
      quote("gb_sox", "费城半导体", 11137.29, -3.83),
      quote("DINIW", "美元指数", 101.783, -0.21),
      quote("fx_susdcnh", "离岸人民币", 6.685, -0.07),
      quote("hf_OIL", "布伦特原油", 104.44, 3.78)
    ],
    macro: {
      updatedAt: "2026-10-15",
      items: [
        yieldItem("us10y", "美国10年期国债", 5.1, 5.19),
        yieldItem("us2y", "美国2年期国债", 4.77, 4.82),
        levelItem("vix", "VIX 波动率指数", 21.5, 20.0)
      ]
    },
    sectorNews: [],
    ...overrides
  };
}

test("nextTradingDay skips the weekend but not holidays", () => {
  assert.equal(nextTradingDay("2026-10-15T00:00:00Z"), "2026-10-16");
  // Friday -> Monday
  assert.equal(nextTradingDay("2026-10-16T00:00:00Z"), "2026-10-19");
  assert.equal(nextTradingDay("bogus"), null);
});

test("driver weights are the documented 100-point budget", () => {
  const total = Object.values(DRIVER_WEIGHTS).reduce((sum, value) => sum + value, 0);
  assert.equal(total, 100);
});

test("a fully-populated day puts every weight on the table", () => {
  const outlook = buildOutlook(baseInput({ sectorNews: [] }));
  assert.equal(outlook.availableWeight, 100);
  assert.equal(outlook.missing.length, 0);
  assert.ok(outlook.score <= 100 && outlook.score >= -100);
  assert.equal(outlook.forDate, "2026-10-16");
  assert.equal(outlook.dataDate, "2026-10-15");
});

test("score drops when a driver is missing but the scale does not break", () => {
  const outlook = buildOutlook({
    ...baseInput(),
    // Drop just the 10Y leg; everything else, VIX included, is still on the table.
    macro: { updatedAt: null, items: [levelItem("vix", "VIX 波动率指数", 21.5, 20.0)] }
  });
  assert.equal(outlook.availableWeight, 100 - DRIVER_WEIGHTS.us10y);
  assert.deepEqual(
    outlook.missing.map((item) => item.key),
    ["us10y"]
  );
  assert.ok(outlook.score <= 100 && outlook.score >= -100);
});

// This is the regression that matters: for the dollar, CNH and UST yields the
// *market impact* sign (z) is the opposite of the *input* sign. Sector
// transmission must follow the input, otherwise a falling 10-year yield would be
// reported as bearish for growth stocks.
test("transmission follows the raw macro direction, not the impact sign", () => {
  const outlook = buildOutlook(baseInput());
  const byKey = new Map(outlook.transmissions.map((item) => [item.key, item]));

  // 10Y yield fell (5.19 -> 5.10) => macro "down" => growth sectors are 利好.
  const us10y = byKey.get("us10y");
  assert.equal(us10y.direction, "down");
  assert.ok(us10y.bullish.includes("电子"), "falling yields must be bullish for growth");
  assert.equal(us10y.bearish.length, 0);

  // Dollar fell => macro "down" => 有色金属 利好, not 利空.
  const dxy = byKey.get("dxy");
  assert.equal(dxy.direction, "down");
  assert.ok(dxy.bullish.includes("有色金属"));
  assert.ok(!dxy.bearish.includes("有色金属"));

  // CNH fell (renminbi stronger) => macro "down" => 外资流入改善.
  const cnh = byKey.get("cnh");
  assert.equal(cnh.direction, "down");
  assert.ok(cnh.bullish.includes("非银金融"));

  // Brent rose 3.78% => upstream 利好, 交运/化工 利空.
  const brent = byKey.get("brent");
  assert.equal(brent.direction, "up");
  assert.ok(brent.bullish.includes("石油石化"));
  assert.ok(brent.bearish.includes("交通运输"));
});

test("the same driver is reported once, not once per sector", () => {
  const outlook = buildOutlook(baseInput());
  const keys = outlook.transmissions.map((item) => `${item.key}:${item.direction}`);
  assert.equal(new Set(keys).size, keys.length);
  // Sorted by weight desc, so the biggest macro leg leads.
  for (let index = 1; index < outlook.transmissions.length; index += 1) {
    assert.ok(outlook.transmissions[index - 1].weight >= outlook.transmissions[index].weight);
  }
});

test("a sector never lands on both the 利好 and 利空 lists", () => {
  const outlook = buildOutlook(baseInput());
  const bullish = new Set(outlook.bullish.map((item) => item.label));
  for (const item of outlook.bearish) assert.ok(!bullish.has(item.label), `${item.label} is on both sides`);
  assert.ok(outlook.bullish.length <= 6);
  assert.ok(outlook.bearish.length <= 6);
});

test("median breadth falls back to the universe, not to the biggest movers", () => {
  const outlook = buildOutlook(
    baseInput({
      briefing: { ...baseInput().briefing, medianChangePct: undefined, anomalies: [{ changePct: 10.02 }, { changePct: 9.98 }] }
    })
  );
  const medianDriver = outlook.drivers.find((driver) => driver.key === "median");
  assert.equal(medianDriver.raw, -3.04);
  assert.equal(outlook.briefingMedian, undefined);
});

test("median uses the briefing value when it is present", () => {
  const outlook = buildOutlook(baseInput({ briefing: { ...baseInput().briefing, medianChangePct: -1.25 } }));
  const medianDriver = outlook.drivers.find((driver) => driver.key === "median");
  assert.equal(medianDriver.raw, -1.25);
});

test("an outflow is described once, without a double negative sign", () => {
  const outlook = buildOutlook(baseInput());
  const flowDriver = outlook.drivers.find((driver) => driver.key === "flowRatio");
  assert.match(flowDriver.rawText, /^净流出 637\.56亿（占成交额 3\.87%）$/);
  assert.ok(!flowDriver.rawText.includes("--"));
  assert.ok(!flowDriver.rawText.includes("+-"));
});

test("risk callouts cite the evidence that triggered them", () => {
  const outlook = buildOutlook(baseInput());
  assert.ok(outlook.risks.length >= 3);
  assert.ok(outlook.risks.some((line) => line.includes("5.1%")));
  assert.ok(outlook.risks.some((line) => line.includes("跌停 46")));
  assert.ok(outlook.risks.some((line) => line.includes("637.56亿")));
});

test("watch list always opens with the auction check", () => {
  const outlook = buildOutlook(baseInput());
  assert.match(outlook.watch[0], /09:25 集合竞价/);
  assert.ok(outlook.watch.length >= 2);
});

test("a neutral day still returns a well-formed payload", () => {
  const outlook = buildOutlook({ now: NOW, meta: {}, stocks: [], briefing: {}, flow: {}, indices: [], macro: {}, sectorNews: [] });
  assert.equal(outlook.score, 0);
  assert.equal(outlook.availableWeight, 0);
  assert.ok(Array.isArray(outlook.logic));
  assert.ok(Array.isArray(outlook.bullish));
  assert.ok(Array.isArray(outlook.bearish));
  assert.ok(outlook.risks.length >= 1, "an empty day still explains what the risk is");
});

// --- sector attribution -----------------------------------------------------

const STOCKS = [
  { code: "600519", industry: "食品饮料" },
  { code: "000725", industry: "电子" },
  { code: "601988", industry: "银行" }
];

test("a headline naming an A-share code lands on that stock's industry only", () => {
  const events = [{ title: "600519:关于回购公司股份的进展公告", publishedAt: "2026-10-15T08:00:00.000Z", codes: ["600519"] }];
  const sectors = buildSectorNews(events, STOCKS, { now: NOW, samplesPerSector: 3 });
  const names = sectors.map((entry) => entry.industry);
  assert.deepEqual(names, ["食品饮料"]);
  assert.equal(sectors[0].samples[0].via, "code");
});

test("a headline without a code can still be attributed by theme", () => {
  const events = [{ title: "半导体设备订单回暖，国产替代加速", publishedAt: "2026-10-15T08:00:00.000Z" }];
  const sectors = buildSectorNews(events, STOCKS, { now: NOW, samplesPerSector: 3 });
  assert.ok(sectors.some((entry) => entry.industry === "电子"));
  const via = new Set(sectors.flatMap((entry) => entry.samples.map((sample) => sample.via)));
  assert.ok(via.has("theme"));
});

test("an unattributed headline is dropped rather than smeared everywhere", () => {
  const events = [{ title: "公司召开第四届董事会第二次临时会议", publishedAt: "2026-10-15T08:00:00.000Z" }];
  const sectors = buildSectorNews(events, STOCKS, { now: NOW });
  assert.ok(sectors.every((entry) => !entry.samples.some((sample) => sample.title.includes("董事会"))));
});

test("the same wire story is shown once per sector", () => {
  const duplicated = [
    { title: "半导体设备订单回暖", source: "新浪", publishedAt: "2026-10-15T08:00:00.000Z" },
    { title: "半导体设备订单回暖", source: "东财", publishedAt: "2026-10-15T08:05:00.000Z" }
  ];
  const sectors = buildSectorNews(duplicated, STOCKS, { now: NOW, samplesPerSector: 3 });
  const electronics = sectors.find((entry) => entry.industry === "电子");
  assert.ok(electronics);
  const titles = electronics.samples.map((sample) => sample.title);
  assert.equal(new Set(titles).size, titles.length);
});

test("every mapped industry is one of the 31 申万一级 names", () => {
  const allowed = new Set([
    "农林牧渔","基础化工","钢铁","有色金属","电子","家用电器","食品饮料","纺织服饰","轻工制造","医药生物",
    "公用事业","交通运输","房地产","商贸零售","社会服务","银行","非银金融","综合","建筑材料","建筑装饰",
    "电力设备","国防军工","计算机","传媒","通信","煤炭","石油石化","环保","美容护理","机械设备","汽车"
  ]);
  for (const [theme, industries] of Object.entries(THEME_INDUSTRIES)) {
    for (const industry of industries) {
      assert.ok(allowed.has(industry), `${theme} maps to unknown industry ${industry}`);
    }
  }
});

test("券商概念 is deliberately not mapped (it would flood 非银金融)", () => {
  assert.equal(THEME_INDUSTRIES["券商概念"], undefined);
});
