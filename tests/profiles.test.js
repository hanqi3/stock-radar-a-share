import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildProfilesPayload,
  coversUniverse,
  normalizeProfileRow,
  parseTencentQuote
} from "../scripts/sync-profiles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A verbatim batch response (600519 / 000001 / 920196) so the tests pin the
// real field offsets instead of a hand-written approximation of them.
const BATCH = fs.readFileSync(path.join(__dirname, "fixtures", "tencent-quotes.txt"), "utf8");
const byCode = (code) => parseTencentQuote(BATCH).find((profile) => profile.code === code);

// A suspended stock answers "-" for every price.
const SUSPENDED =
  'v_sz000005="1~ST星源~000005~-~1.72~-~0~0~0~-~0~-~-~-~-~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20261016150000~-~-~-~-~0~0~0~0~-~0~-~-~-~-~-~-~-1~-1~0.00~-1~-1~0~0~0~0~0~0~0~0~-~-~"';

test("parseTencentQuote reads a real batch response into our vocabulary", () => {
  assert.deepEqual(
    parseTencentQuote(BATCH).map((profile) => profile.code),
    ["600519", "000001", "920196"]
  );
  const maotai = byCode("600519");
  assert.equal(maotai.name, "贵州茅台");
  assert.equal(maotai.price, 1329);
  assert.equal(maotai.prevClose, 1312.97);
  assert.equal(maotai.open, 1311.57);
  assert.equal(maotai.high, 1329.88);
  assert.equal(maotai.low, 1301.68);
  assert.equal(maotai.changePct, 1.22);
  assert.equal(maotai.turnoverPct, 0.31);
  assert.equal(maotai.amplitudePct, 2.15);
  assert.equal(maotai.volumeRatio, 1.1);
  assert.equal(maotai.peDynamic, 18.66);
  assert.equal(maotai.peTtm, 20.4);
  assert.equal(maotai.peStatic, 20.18);
  assert.equal(maotai.pb, 6.61);
  assert.equal(maotai.volume, 38502);
});

test("parseTencentQuote converts 万元 and 亿元 into yuan", () => {
  const maotai = byCode("600519");
  assert.equal(maotai.amount, 507553 * 1e4);
  assert.equal(maotai.marketCap, 16613.58 * 1e8);
  assert.equal(maotai.floatMarketCap, 16613.58 * 1e8);
});

test("parseTencentQuote keeps a zero volume ratio null like the primary source", () => {
  const newListing = byCode("920196");
  assert.equal(newListing.name, "N南乳");
  assert.equal(newListing.volumeRatio, null);
  assert.equal(newListing.price, 22.56);
  assert.equal(newListing.peDynamic, 20.3);
});

test("parseTencentQuote keeps a suspended stock with null prices", () => {
  const [profile] = parseTencentQuote(SUSPENDED);
  assert.equal(profile.code, "000005");
  assert.equal(profile.price, null);
  assert.equal(profile.open, null);
  assert.equal(profile.high, null);
  assert.equal(profile.prevClose, 1.72);
});

test("parseTencentQuote ignores junk and short lines", () => {
  const body = `garbage;v_sh600519="1~name";v_indeterminate="~";${BATCH};`;
  assert.equal(parseTencentQuote(body).length, 3);
  assert.deepEqual(parseTencentQuote(""), []);
});

test("normalizeProfileRow still reads the push2 shape", () => {
  const profile = normalizeProfileRow({ f12: "600519", f14: "贵州茅台", f2: 1680.5, f9: 41.2, f23: 8.9 });
  assert.equal(profile.code, "600519");
  assert.equal(profile.price, 1680.5);
  assert.equal(profile.peDynamic, 41.2);
  assert.equal(profile.pb, 8.9);
  assert.equal(normalizeProfileRow({ f12: "abc" }), null);
});

test("both sources agree on the same stock once parsed", () => {
  const fromTencent = byCode("600519");
  const fromPush2 = normalizeProfileRow({
    f12: "600519",
    f14: "贵州茅台",
    f2: 1329,
    f3: 1.22,
    f17: 1311.57,
    f18: 1312.97,
    f15: 1329.88,
    f16: 1301.68,
    f8: 0.31,
    f7: 2.15,
    f9: 18.66,
    f115: 20.4,
    f114: 20.18,
    f23: 6.61,
    f10: 1.1,
    f20: 16613.58 * 1e8,
    f21: 16613.58 * 1e8
  });
  for (const key of ["price", "open", "high", "low", "prevClose", "changePct", "turnoverPct", "amplitudePct", "peDynamic", "peTtm", "peStatic", "pb", "volumeRatio", "marketCap", "floatMarketCap"]) {
    assert.equal(fromTencent[key], fromPush2[key], `${key} should agree`);
  }
});

test("buildProfilesPayload names the source and keeps only the universe", () => {
  const payload = buildProfilesPayload(
    [
      { code: "600519", name: "贵州茅台", price: 1329 },
      { code: "999999", name: "不在股票池", price: 1 }
    ],
    { universeCodes: ["600519"], source: "腾讯行情收盘快照", now: new Date("2026-10-18T10:00:00Z") }
  );
  assert.equal(payload.source, "腾讯行情收盘快照");
  assert.equal(payload.count, 1);
  assert.equal(payload.items["600519"].price, 1329);
  assert.equal(payload.items["600519"].code, undefined);
  assert.equal(payload.generatedAt, "2026-10-18T10:00:00.000Z");
});

test("coversUniverse rejects a thin page instead of trusting it", () => {
  const universe = ["600519", "000001", "920196", "601988"];
  assert.equal(coversUniverse([{ code: "600519" }], universe), false);
  assert.equal(coversUniverse([{ code: "600519" }], universe, 0.2), true);
  assert.equal(coversUniverse(universe.map((code) => ({ code })), universe), true);
  assert.equal(coversUniverse([], universe), false);
  assert.equal(coversUniverse([{ code: "600519" }], null), true);
});
