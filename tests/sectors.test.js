import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSectorIndex,
  flattenNodes,
  pageCountFor,
  parseMemberCount,
  parseMembers,
  selectNodes,
  MIRRORS,
  OUT_FILE
} from "../scripts/sync-sectors.js";

// Trimmed real getHQNodes shape: root has a label and children, leaf nodes are
// [name, "", id], containers carry no id.
const TREE = JSON.parse(
  JSON.stringify([
    "行情中心",
    [
      [
        "A股",
        [
          ["新浪行业", [["玻璃行业", "", "new_blhy"], ["传媒娱乐", "", "new_cmyl"]]],
          [
            "申万行业",
            [
              ["煤炭", "", "sw_mt"],
              ["食品饮料", "", "sw_spyl"],
              ["银行", "", "sw_yx"]
            ]
          ],
          ["概念板块", [["华为汽车", "", "gn_hwqc"], ["贵州板块", "", "gn_gzbk"], ["华为汽车", "", "gn_hwqc"]]]
        ]
      ]
    ]
  ])
);

// Real getHQNodeData shape: a bare array, `trade` is a string, `mktcap` is 万元.
const MEMBERS_PAYLOAD = JSON.stringify([
  {
    symbol: "sh600519",
    code: "600519",
    name: "贵州茅台",
    trade: "1680.000",
    pricechange: -12.5,
    changepercent: -0.74,
    volume: 257535270,
    amount: 1403636600,
    per: 30.2,
    pb: 8.1,
    mktcap: 21100000.5,
    nmc: 21100000.5,
    turnoverratio: 0.42
  },
  {
    symbol: "sz000625",
    code: "000625",
    name: "长安汽车",
    trade: "13.010",
    pricechange: 0.11,
    changepercent: 0.85,
    amount: null,
    mktcap: null,
    turnoverratio: "1.10"
  }
]);

test("flattenNodes returns only leaves, using the third element as the id", () => {
  const leaves = flattenNodes(TREE);
  assert.deepEqual(
    leaves.map((leaf) => leaf.id),
    ["new_blhy", "new_cmyl", "sw_mt", "sw_spyl", "sw_yx", "gn_hwqc", "gn_gzbk", "gn_hwqc"]
  );
  assert.deepEqual(leaves[0], { name: "玻璃行业", id: "new_blhy" });
  // Containers ("行情中心", "A股", "申万行业", ...) must not appear.
  assert.equal(leaves.some((leaf) => leaf.name === "申万行业"), false);
});

test("flattenNodes tolerates junk input", () => {
  assert.deepEqual(flattenNodes(null), []);
  assert.deepEqual(flattenNodes("nope"), []);
  assert.deepEqual(flattenNodes([["empty", "", ""]]), []);
});

test("selectNodes filters by prefix and deduplicates by id", () => {
  const leaves = flattenNodes(TREE);
  assert.deepEqual(
    selectNodes(leaves, "sw_").map((node) => node.id),
    ["sw_mt", "sw_spyl", "sw_yx"]
  );
  // gn_hwqc appears twice in the tree and must survive only once.
  assert.deepEqual(
    selectNodes(leaves, ["gn_"]).map((node) => node.id),
    ["gn_hwqc", "gn_gzbk"]
  );
  assert.equal(selectNodes(leaves, ["sw2_"]).length, 0);
  assert.deepEqual(selectNodes(null, "sw_"), []);
});

test("parseMembers parses the bare array shape", () => {
  const rows = parseMembers(MEMBERS_PAYLOAD);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    code: "600519",
    name: "贵州茅台",
    symbol: "sh600519",
    price: 1680,
    changePct: -0.74,
    amount: 1403636600,
    marketCap: 211000005000,
    turnover: 0.42
  });
  // A "sz" prefixed symbol still yields a 6-digit code, and missing numbers are null.
  assert.equal(rows[1].code, "000625");
  assert.equal(rows[1].amount, null);
  assert.equal(rows[1].marketCap, null);
  assert.equal(rows[1].turnover, 1.1);
});

test("parseMembers throws a clear error for a non bare-array payload", () => {
  assert.throws(() => parseMembers('{"result":[]}'), /expected a bare JSON array/);
  assert.throws(() => parseMembers("null"), /expected a bare JSON array/);
  assert.throws(() => parseMembers("<html>502 Bad Gateway</html>"), /not JSON/);
  assert.throws(() => parseMembers('"5573"'), /expected a bare JSON array/);
  // An empty list is a legitimate (if empty) page, not an error.
  assert.deepEqual(parseMembers("[]"), []);
});

test("parseMembers pads short codes to six digits", () => {
  const rows = parseMembers(JSON.stringify([{ symbol: "sz1", code: "1", name: "甲" }]));
  assert.equal(rows[0].code, "000001");
});

test("pageCountFor rounds up without an extra page", () => {
  // The count endpoint answers with a QUOTED JSON string.
  const total = Number(JSON.parse('"5573"'));
  assert.equal(total, 5573);
  assert.equal(pageCountFor(total), 56);
  assert.equal(pageCountFor(5573, 100), 56);
  // Number('"5573"') is NaN, which is exactly the bug pageCountFor must not hide.
  assert.equal(Number.isNaN(Number('"5573"')), true);
  assert.equal(pageCountFor(Number('"5573"')), 0);
  // Exact multiples stay exact, so a full last page is not double counted.
  assert.equal(pageCountFor(100), 1);
  assert.equal(pageCountFor(200), 2);
  assert.equal(pageCountFor(101), 2);
  assert.equal(pageCountFor(1), 1);
});

test("pageCountFor returns 0 for empty or invalid totals", () => {
  assert.equal(pageCountFor(0), 0);
  assert.equal(pageCountFor(-5), 0);
  assert.equal(pageCountFor(null), 0);
  assert.equal(pageCountFor(undefined), 0);
  assert.equal(pageCountFor(Number.NaN), 0);
  assert.equal(pageCountFor(50, 0), 0);
});

test("parseMemberCount parses the quoted count string", () => {
  // getHQNodeStockCount answers `"5573"`, NOT 5573.
  assert.equal(parseMemberCount('"5573"'), 5573);
  assert.equal(pageCountFor(parseMemberCount('"5573"')), 56);
  assert.equal(parseMemberCount("42"), 42);
  assert.equal(parseMemberCount('"0"'), 0);
});

test("parseMemberCount treats a bare [] as an empty board", () => {
  // 37 retired gn_* ids are still listed in the tree and answer [] from both the
  // count and the member endpoints; that is "no members", not a failure.
  assert.equal(parseMemberCount("[]"), 0);
  assert.equal(parseMemberCount("  []  "), 0);
  assert.equal(pageCountFor(parseMemberCount("[]")), 0);
});

test("parseMemberCount throws for payloads that are not a count", () => {
  assert.throws(() => parseMemberCount("<html>not json"), /not JSON/);
  assert.throws(() => parseMemberCount("null"), /unexpected stock count payload/);
  assert.throws(() => parseMemberCount('{"total":5}'), /unexpected stock count payload/);
  assert.throws(() => parseMemberCount('"abc"'), /unexpected stock count payload/);
  assert.throws(() => parseMemberCount(""), /not JSON|unexpected stock count payload/);
  // The label is what makes a bad node identifiable in the nightly log.
  assert.throws(() => parseMemberCount("nope", "gn_hwqc"), /gn_hwqc/);
});

test("buildSectorIndex merges duplicate boards, sorts by count and builds membership", () => {
  const index = buildSectorIndex({
    generatedAt: "2026-01-01T00:00:00.000Z",
    industries: [
      { id: "sw_mt", name: "煤炭", members: ["601088", "sh600121", "601088"] },
      { id: "sw_spyl", name: "食品饮料", members: ["600519", "sz000858", "600519", "600809"] }
    ],
    concepts: [
      { id: "gn_bj", name: "白酒", members: ["600519", "000858"] },
      // Duplicate id: names keep the first, members are unioned.
      { id: "gn_bj", name: "白酒(dup)", members: ["600809"] }
    ]
  });

  assert.equal(index.source, "sina");
  assert.equal(index.sourceLabel, "Sina Finance market centre node tree");
  assert.equal(index.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(index.industries.map((board) => board.id).join(","), "sw_spyl,sw_mt");
  assert.equal(index.industries[0].count, 3);
  assert.deepEqual(index.industries[0].members, ["000858", "600519", "600809"]);
  assert.equal(index.industries[1].count, 2);
  assert.deepEqual(index.industries[1].members, ["600121", "601088"]);

  assert.equal(index.concepts.length, 1);
  assert.equal(index.concepts[0].name, "白酒");
  assert.equal(index.concepts[0].count, 3);

  assert.deepEqual(index.membership["600519"], { industries: ["sw_spyl"], concepts: ["gn_bj"] });
  assert.deepEqual(index.membership["000858"], { industries: ["sw_spyl"], concepts: ["gn_bj"] });
  assert.deepEqual(index.membership["601088"], { industries: ["sw_mt"], concepts: [] });
  // Membership keys are written in sorted order, but JSON object key order is not
  // guaranteed (V8 hoists integer-like keys such as "600519" ahead of "000858"),
  // so compare as a set. Every code must still be exactly 6 digits.
  assert.deepEqual(Object.keys(index.membership).sort(), ["000858", "600121", "600519", "600809", "601088"]);
  for (const code of Object.keys(index.membership)) {
    assert.match(code, /^\d{6}$/);
  }
});

test("buildSectorIndex emits the exact on-disk key shape", () => {
  const index = buildSectorIndex({ generatedAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(Object.keys(index), [
    "generatedAt",
    "source",
    "sourceLabel",
    "sourceUrl",
    "industries",
    "concepts",
    "membership",
    "notes"
  ]);
  assert.deepEqual(index.industries, []);
  assert.deepEqual(index.concepts, []);
  assert.deepEqual(index.membership, {});
  assert.equal(typeof index.notes, "string");
  assert.equal(index.sourceUrl, MIRRORS[0] + "/quotes_service/api/json_v2.php/Market_Center.getHQNodes");
});

test("module constants point at data/sectors.json", () => {
  assert.equal(OUT_FILE.replace(/\\/g, "/").endsWith("stock-radar-a-share/data/sectors.json"), true);
});
