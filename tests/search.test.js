import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSearchIndex,
  matchesQuery,
  normalizeQuery,
  pinyinOf,
  scoreEntry,
  suggest,
  EMPTY_LOOKUP
} from "../lib/search.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lookup = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "pinyin-index.json"), "utf8"));

const STOCKS = [
  { code: "600519", name: "贵州茅台", industry: "白酒" },
  { code: "601398", name: "工商银行", industry: "银行" },
  { code: "600900", name: "长江电力", industry: "电力" },
  { code: "601005", name: "重庆钢铁", industry: "钢铁" },
  { code: "000001", name: "平安银行", industry: "银行" },
  { code: "300750", name: "宁德时代", industry: "电池" }
];

const index = buildSearchIndex(STOCKS, lookup);

const codeFor = (query, limit = 5) => suggest(index, query, limit).map((hit) => hit.code);

test("normalizeQuery strips separators and case", () => {
  assert.equal(normalizeQuery("  600519 "), "600519");
  assert.equal(normalizeQuery("GuiZhou MaoTai"), "guizhoumaotai");
  assert.equal(normalizeQuery("贵州·茅台"), "贵州茅台");
  assert.equal(normalizeQuery(null), "");
});

test("pinyin resolves polyphones from the full name", () => {
  assert.equal(pinyinOf("工商银行", lookup).pinyin, "gongshangyinhang");
  assert.equal(pinyinOf("长江电力", lookup).pinyin, "changjiangdianli");
  assert.equal(pinyinOf("重庆钢铁", lookup).pinyin, "chongqinggangtie");
  assert.equal(pinyinOf("工商银行", lookup).initials, "gsyh");
});

test("unknown names fall back to the per-character table", () => {
  const { pinyin, initials } = pinyinOf("测试公司", lookup);
  assert.equal(pinyin, "ceshigongsi");
  assert.equal(initials, "csgs");
  const bare = pinyinOf("新上公司", EMPTY_LOOKUP);
  assert.equal(bare.pinyin, "");
  assert.equal(bare.initials, "");
});

test("codes, names, pinyin and initials all resolve", () => {
  assert.deepEqual(codeFor("600519"), ["600519"]);
  assert.deepEqual(codeFor("贵州茅台"), ["600519"]);
  assert.deepEqual(codeFor("guizhoumaotai"), ["600519"]);
  assert.deepEqual(codeFor("gzmt"), ["600519"]);
  assert.deepEqual(codeFor("GZMT"), ["600519"]);
});

test("prefix queries rank the strongest match first", () => {
  const hits = suggest(index, "600", 10);
  assert.deepEqual(hits.map((h) => h.code), ["600519", "600900"]);
  const banks = suggest(index, "yinhang", 10).map((h) => h.code);
  assert.ok(banks.includes("601398"));
  assert.ok(banks.includes("000001"));
  assert.equal(banks[0], "000001", "equal scores fall back to ascending code");
});

test("industry matches score lowest but still match", () => {
  const entry = index.get("600519");
  assert.equal(scoreEntry(entry, "白酒"), 20);
  assert.equal(scoreEntry(entry, "600519"), 120);
  assert.equal(scoreEntry(entry, "maotai"), 45, "maotai is a suffix of guizhoumaotai");
  assert.equal(scoreEntry(entry, "guizhou"), 80);
  assert.equal(scoreEntry(entry, "zzzz"), 0);
});

test("empty and whitespace queries match nothing in suggest but everything in matchesQuery", () => {
  assert.deepEqual(suggest(index, "", 5), []);
  assert.deepEqual(suggest(index, "   ", 5), []);
  assert.equal(matchesQuery(index.get("600519"), ""), true);
});

test("the shipped index covers the universe with sane phonetics", () => {
  const names = Object.keys(lookup.names);
  assert.ok(names.length > 5000, `expected >5000 names, got ${names.length}`);
  assert.ok(Object.keys(lookup.chars).length > 1000);
  for (const name of names.slice(0, 200)) {
    const [full, ini] = lookup.names[name];
    assert.ok(full && /^[a-z]+$/.test(full), `${name} -> ${full}`);
    assert.ok(ini && /^[a-z]+$/.test(ini), `${name} -> ${ini}`);
    assert.ok(ini.length > 0 && ini.length <= [...name].length, `${name} -> ${ini}`);
  }
});
