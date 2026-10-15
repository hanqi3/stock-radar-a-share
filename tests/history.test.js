import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  fetchDailyBars,
  marketPrefix,
  normalizeBars,
  parseSinaKline,
  parseTencentKline,
  sinaHistoryUrl,
  symbolFor,
  tencentHistoryUrl,
  SINA_HISTORY_DAYS,
  TENCENT_HISTORY_DAYS,
  TENCENT_HISTORY_HOSTS,
  TENCENT_HISTORY_PATH
} from "../lib/history.js";
import { createHistoryCache } from "../lib/history-cache.js";

// Real payload shape from money.finance.sina.com.cn (volume in 股).
const SINA_PAYLOAD = JSON.stringify([
  { day: "2026-10-13", open: "11.730", high: "11.770", low: "11.550", close: "11.570", volume: "99493700" },
  { day: "2026-10-14", open: "11.570", high: "11.720", low: "11.480", close: "11.500", volume: "96908200" },
  { day: "2026-10-15", open: "11.500", high: "11.520", low: "11.260", close: "11.410", volume: "151176700" }
]);

// Real payload shape from ifzq.gtimg.cn: [date, open, CLOSE, high, low, volume(手)].
const TENCENT_PAYLOAD = JSON.stringify({
  code: 0,
  msg: "",
  data: {
    sz000001: {
      qfqday: [
        ["2026-10-13", "11.730", "11.570", "11.770", "11.550", "994937.000"],
        ["2026-10-14", "11.570", "11.500", "11.720", "11.480", "969082.000"],
        ["2026-10-15", "11.50", "11.41", "11.52", "11.26", "1511767"]
      ],
      qt: {}
    }
  }
});

test("market prefix maps every exchange", () => {
  assert.equal(marketPrefix("SH"), "sh");
  assert.equal(marketPrefix("SZ"), "sz");
  assert.equal(marketPrefix("BJ"), "bj");
  assert.equal(marketPrefix(undefined), "sh");
  assert.equal(symbolFor("600519", "SH"), "sh600519");
  assert.equal(symbolFor("920157", "BJ"), "bj920157");
});

test("history urls clamp the requested depth", () => {
  assert.match(sinaHistoryUrl("600519", "SH", 250), /datalen=250/);
  assert.match(sinaHistoryUrl("600519", "SH", 99999), new RegExp(`datalen=${SINA_HISTORY_DAYS}`));
  // A zero / missing depth falls back to the default rather than requesting 1 bar.
  assert.match(tencentHistoryUrl("600519", "SH", 0), /,day,,,250,qfq/);
  assert.match(tencentHistoryUrl("600519", "SH", undefined), /,day,,,250,qfq/);
  assert.match(tencentHistoryUrl("600519", "SH", 99999), new RegExp(`,day,,,${TENCENT_HISTORY_DAYS},qfq`));
  // Each mirror host produces the same path shape.
  for (const host of TENCENT_HISTORY_HOSTS) {
    assert.ok(tencentHistoryUrl("000001", "SZ", 250, host).startsWith(`${host}${TENCENT_HISTORY_PATH}`));
  }
  assert.ok(tencentHistoryUrl("000001", "SZ", 250).startsWith(TENCENT_HISTORY_HOSTS[0]));
});

test("sina payload decodes and converts volume 股 -> 手", () => {
  const bars = parseSinaKline(SINA_PAYLOAD);
  assert.equal(bars.length, 3);
  assert.deepEqual(bars[0], { date: "2026-10-13", open: 11.73, high: 11.77, low: 11.55, close: 11.57, volume: 994937 });
  assert.deepEqual(bars[2], { date: "2026-10-15", open: 11.5, high: 11.52, low: 11.26, close: 11.41, volume: 1511767 });
});

test("tencent payload decodes despite the open/close/high/low column order", () => {
  const bars = parseTencentKline(TENCENT_PAYLOAD);
  assert.equal(bars.length, 3);
  assert.deepEqual(bars[0], { date: "2026-10-13", open: 11.73, high: 11.77, low: 11.55, close: 11.57, volume: 994937 });
  assert.deepEqual(bars[2], { date: "2026-10-15", open: 11.5, high: 11.52, low: 11.26, close: 11.41, volume: 1511767 });
});

test("both providers agree on the same session", () => {
  const sina = parseSinaKline(SINA_PAYLOAD);
  const tencent = parseTencentKline(TENCENT_PAYLOAD);
  assert.deepEqual(sina, tencent);
});

test("malformed payloads degrade to an empty series", () => {
  assert.deepEqual(parseSinaKline("<html>nope</html>"), []);
  assert.deepEqual(parseSinaKline("{}"), []);
  assert.deepEqual(parseTencentKline("not json"), []);
  assert.deepEqual(parseTencentKline('{"data":{}}'), []);
  assert.deepEqual(parseTencentKline('{"data":{"sz1":{}}}'), []);
});

test("normalizeBars sorts, de-duplicates and drops impossible rows", () => {
  const bars = normalizeBars([
    { date: "2026-10-15", close: 10, high: 11, low: 9, open: 9.5, volume: 1 },
    { date: "2026-10-13", close: 9, high: 10, low: 8, open: 8.5, volume: 2 },
    { date: "2026-10-15", close: 10.5, high: 11.5, low: 9.5, open: 9.6, volume: 3 },
    { date: "2026-13-99", close: 10 },
    { date: "2026-10-16", close: null },
    { date: "2026-10-17", close: 10, high: 8, low: 9 }
  ]);
  assert.deepEqual(bars.map((bar) => bar.date), ["2026-10-13", "2026-10-15"]);
  assert.equal(bars[1].close, 10.5, "last duplicate wins");
});

test("fetchDailyBars falls back to the second provider", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("sina")) throw new Error("boom");
    return { ok: true, status: 200, text: async () => TENCENT_PAYLOAD };
  };
  const result = await fetchDailyBars("000001", "SZ", { days: 3, fetchImpl });
  assert.equal(result.source, "tencent");
  assert.equal(result.bars.length, 3);
  assert.equal(calls.length, 2);
});

test("fetchDailyBars throws with every provider's reason", async () => {
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  await assert.rejects(() => fetchDailyBars("000001", "SZ", { days: 3, fetchImpl }), /no history provider could serve 000001/);
});

test("history cache reuses a fresh entry and refetches when forced", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sr-hist-"));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => SINA_PAYLOAD };
  };
  const cache = createHistoryCache(dir, { days: 3, fetchImpl, ttlMs: 60_000 });

  const first = await cache.get("000001", "SZ");
  assert.equal(first.cached, false);
  assert.equal(first.source, "sina");
  assert.equal(calls, 1);

  const second = await cache.get("000001", "SZ");
  assert.equal(second.cached, true);
  assert.equal(calls, 1, "fresh cache must not refetch");

  const forced = await cache.get("000001", "SZ", { force: true });
  assert.equal(forced.cached, false);
  assert.equal(calls, 2);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "000001.json"), "utf8"));
  assert.equal(onDisk.bars.length, 3);
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test("history cache refetches when the cached window is too shallow", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sr-hist-"));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => SINA_PAYLOAD };
  };
  const cache = createHistoryCache(dir, { days: 3, fetchImpl, ttlMs: 60_000 });
  await cache.get("000001", "SZ");
  await cache.get("000001", "SZ", { days: 10 });
  assert.equal(calls, 2, "a deeper request must not be served from a 3-bar cache");
  await fs.promises.rm(dir, { recursive: true, force: true });
});
