import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRegion,
  isGlobalSymbol,
  regionCounts,
  splitByRegion,
  tagRegions
} from "../lib/news-region.js";
import {
  A_SHARE_INDEX_SYMBOLS,
  GLOBAL_INDEX_SYMBOLS,
  OVERSEAS_INDEX_GROUPS,
  parseCninfo,
  parseEastmoneyAnnouncements,
  parseGlobalQuotes
} from "../scripts/sync-news.js";

const cnAnnouncement = {
  kind: "announcement",
  source: "东方财富公告",
  title: "贵州茅台:贵州茅台酒股份有限公司2026年第三季度报告",
  codes: ["600519"],
  publishedAt: "2026-10-15T02:00:00.000Z"
};

const globalMacro = {
  source: "新浪财经7x24·公司",
  title: "华福证券：美联储加息必要性上升",
  codes: [],
  publishedAt: "2026-10-15T02:00:00.000Z"
};

test("A-share disclosures stay in the China column even when they mention 海外", () => {
  assert.equal(classifyRegion(cnAnnouncement), "cn");
  assert.equal(
    classifyRegion({
      source: "新浪财经·要闻",
      title: "安井食品高溢价海外并购：标的近7倍市净率高于行业均值",
      codes: ["603345"]
    }),
    "cn"
  );
});

test("explicit region wins over keyword rules", () => {
  assert.equal(classifyRegion({ ...globalMacro, region: "cn" }), "cn");
  assert.equal(classifyRegion({ ...cnAnnouncement, region: "global" }), "global");
});

test("overseas macro and market vocabulary lands in the global column", () => {
  for (const title of [
    "华福证券：美联储加息必要性上升",
    "Needham将台积电目标价从530美元上调至560美元",
    "伊朗外长将于10月17日访问伊拉克",
    "乌克兰通过所有税收法案，以解锁捐助资金",
    "隔夜美股三大指数集体收跌"
  ]) {
    assert.equal(classifyRegion({ source: "新浪财经7x24·公司", title, codes: [] }), "global", title);
  }
});

test("domestic policy vocabulary stays in the China column", () => {
  for (const title of [
    "证监会就程序化交易管理规定答记者问",
    "国常会部署新一轮稳增长措施",
    "沪深两市成交额突破1.5万亿元"
  ]) {
    assert.equal(classifyRegion({ source: "东方财富快讯", title, codes: [] }), "cn", title);
  }
});

test("mixed headlines are decided by whichever subject comes first", () => {
  assert.equal(classifyRegion({ title: "美股收跌，A股今日关注科技板块", codes: [] }), "global");
  assert.equal(classifyRegion({ title: "A股震荡，隔夜美股收跌", codes: [] }), "cn");
});

test("plain headlines with no vocabulary default to the China column", () => {
  assert.equal(classifyRegion({ title: "某公司发布日常经营公告", codes: [] }), "cn");
  assert.equal(classifyRegion({ title: "", codes: [] }), "cn");
});

test("tagRegions and splitByRegion agree with classifyRegion", () => {
  const items = [cnAnnouncement, globalMacro, { title: "证监会发布新规", codes: [] }];
  const tagged = tagRegions(items);
  assert.deepEqual(
    tagged.map((item) => item.region),
    ["cn", "global", "cn"]
  );
  const { cn, global } = splitByRegion(items);
  assert.equal(cn.length, 2);
  assert.equal(global.length, 1);
  assert.deepEqual(regionCounts(items), { cn: 2, global: 1 });
});

test("isGlobalSymbol recognises overseas quote prefixes", () => {
  assert.equal(isGlobalSymbol("gb_dji"), true);
  assert.equal(isGlobalSymbol("int_nikkei"), true);
  assert.equal(isGlobalSymbol("rt_hkHSI"), true);
  assert.equal(isGlobalSymbol("hf_GC"), true);
  assert.equal(isGlobalSymbol("sh600519"), false);
  assert.equal(isGlobalSymbol(""), false);
});

test("parseGlobalQuotes reads every family layout", () => {
  const text = [
    'var hq_str_gb_dji="道琼斯,51621.4805,-0.09,2026-10-14 20:36:28,-48.6200,51684.7500,51869.7500,51365.4219";',
    'var hq_str_int_nikkei="日经指数,44946.64,-408.35,-0.90";',
    'var hq_str_int_ftse="伦敦指数,9284.83,70.85,0.77";',
    'var hq_str_hf_GC="4179.970,,4179.500,4179.800,4183.300,4120.900,19:15:10,4107.900,4128.300,0,4,1,2026-10-15,纽约黄金,0";',
    'var hq_str_fx_susdcnh="19:15:10,6.690800,6.691400,6.695900,95,6.696100,6.697500,6.688000,6.690800,离岸人民币（香港）,-0.080000,-0.005100,0.001419,,6.995700,6.689000,,2026-10-15";',
    'var hq_str_rt_hkHSI="HSI,恒生指数,24119.140,24314.170,24162.710,23945.840,24062.721,-251.450,-1.030,0.000,0.000,224164565.414,12902356495,0.000,0.000,28056.100,22518.000,2026/10/15,16:09:30";',
    'var hq_str_DINIW="19:29:38,102.0273,102.0273,102.5296,6914,102.5293,102.5654,101.8740,102.0273,美元指数,2026-10-15";'
  ].join("\n");

  const items = parseGlobalQuotes(text, new Date("2026-10-15T12:00:00Z"));
  const bySymbol = new Map(items.map((item) => [item.symbol, item]));

  assert.equal(items.length, 7);

  const dji = bySymbol.get("gb_dji");
  assert.equal(dji.name, "道琼斯");
  assert.equal(dji.price, 51621.48);
  assert.equal(dji.changePct, -0.09);
  assert.equal(dji.updatedAt, "2026-10-14T12:36:28.000Z");

  const nikkei = bySymbol.get("int_nikkei");
  assert.equal(nikkei.price, 44946.64);
  assert.equal(nikkei.change, -408.35);
  assert.equal(nikkei.changePct, -0.9);

  const gold = bySymbol.get("hf_GC");
  assert.equal(gold.price, 4179.97);
  assert.equal(gold.changePct, 1.75);
  assert.equal(gold.updatedAt, "2026-10-15T11:15:10.000Z");

  const cnh = bySymbol.get("fx_susdcnh");
  assert.equal(cnh.price, 6.6908);
  assert.equal(cnh.changePct, -0.08);
  assert.equal(cnh.change, -0.0051);
  assert.equal(cnh.updatedAt, "2026-10-15T11:15:10.000Z");

  const hsi = bySymbol.get("rt_hkHSI");
  assert.equal(hsi.name, "恒生指数");
  assert.equal(hsi.price, 24062.72);
  assert.equal(hsi.change, -251.45);
  assert.equal(hsi.changePct, -1.03);
  assert.equal(hsi.updatedAt, "2026-10-15T08:09:30.000Z");

  // DINIW has no 涨跌幅 field, so it must be derived from 昨收 (parts[5]).
  const dxy = bySymbol.get("DINIW");
  assert.equal(dxy.price, 102.027);
  assert.equal(dxy.changePct, -0.49);
  assert.equal(dxy.updatedAt, "2026-10-15T11:29:38.000Z");
});

test("parseGlobalQuotes ignores unknown symbols and blank payloads", () => {
  const text = [
    'var hq_str_sh600519="贵州茅台,1286.0";',
    'var hq_str_znb_UDI="";',
    "garbage line"
  ].join("\n");
  assert.deepEqual(parseGlobalQuotes(text), []);
});

// The domestic benchmarks ride the same Sina batch as the overseas tape and are
// what the top strip shows. They use the `s_` family, which is
// 名称,最新,涨跌额,涨跌幅%,量,额 — same shape as `int_*` but a different prefix.
test("parseGlobalQuotes reads the A-share index family", () => {
  const text = [
    'var hq_str_s_sh000001="上证指数,3716.2842,8.8082,0.24,4726321,73247519";',
    'var hq_str_s_sz399001="深证成指,11802.46,-14.329,-0.12,550782708,82293909";',
    'var hq_str_s_bj899050="北证50,949.995,-17.510,-1.810,719091949,13811611941.000";'
  ].join("\n");

  const items = parseGlobalQuotes(text, new Date("2026-10-15T12:00:00Z"));
  const bySymbol = new Map(items.map((item) => [item.symbol, item]));
  assert.equal(items.length, 3);

  const sh = bySymbol.get("s_sh000001");
  assert.equal(sh.name, "上证指数");
  assert.equal(sh.group, "A股指数");
  assert.equal(sh.price, 3716.28);
  assert.equal(sh.change, 8.81);
  assert.equal(sh.changePct, 0.24);

  const bj = bySymbol.get("s_bj899050");
  assert.equal(bj.price, 950);
  assert.equal(bj.changePct, -1.81);
});

test("every configured symbol has a display name and a known group", () => {
  const groups = new Set(["美洲", "美股龙头", "亚太欧洲", "外汇", "商品", "A股指数"]);
  for (const entry of [...GLOBAL_INDEX_SYMBOLS, ...A_SHARE_INDEX_SYMBOLS]) {
    assert.ok(entry.name && entry.name.length >= 2, entry.symbol);
    assert.ok(groups.has(entry.group), `${entry.symbol} -> ${entry.group}`);
  }
  // The overseas board must never count the domestic strip.
  assert.equal(A_SHARE_INDEX_SYMBOLS.every((entry) => entry.group === "A股指数"), true);
  assert.deepEqual(OVERSEAS_INDEX_GROUPS, ["美洲", "美股龙头", "亚太欧洲", "外汇", "商品"]);
});

// The region rules and the reader's filing/news split both key off
// kind === "announcement". Nothing else sets it, and a regression here silently
// turns every disclosure into a keyword-scored headline.
test("disclosure parsers tag items as announcements", () => {
  const cninfo = parseCninfo({
    announcements: [
      {
        announcementId: "1220000001",
        announcementTitle: "贵州茅台:2026年第三季度报告",
        secName: "贵州茅台",
        announcementTypeName: "三季度报告",
        adjunctUrl: "finalpage/2026-10-15/1220000001.PDF",
        announcementTime: 1_761_000_000_000,
        secCode: "600519"
      }
    ]
  });
  assert.equal(cninfo.length, 1);
  assert.equal(cninfo[0].kind, "announcement");
  assert.equal(cninfo[0].source, "巨潮资讯");
  assert.deepEqual(cninfo[0].codes, ["600519"]);
  assert.equal(classifyRegion(cninfo[0]), "cn");

  const eastmoney = parseEastmoneyAnnouncements({
    data: {
      list: [
        {
          art_code: "AN202610151830526593",
          title: "申菱环境:向不特定对象发行可转换公司债券募集说明书",
          notice_date: "2026-10-15T16:00:00.000Z",
          codes: [{ stock_code: "301018", short_name: "申菱环境" }],
          columns: [{ column_name: "其他" }]
        }
      ]
    }
  });
  assert.equal(eastmoney.length, 1);
  assert.equal(eastmoney[0].kind, "announcement");
  assert.equal(eastmoney[0].source, "东方财富公告");
  assert.equal(classifyRegion(eastmoney[0]), "cn");
});
