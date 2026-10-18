#!/usr/bin/env node
// Grades the 「明日参考」 calls.
//
// The server writes a row for every session it serves an outlook for; this
// script fetches the 上证指数 daily closes and attaches what the index actually
// did on the following session, then prints the running hit rate.
//
// Usage: node scripts/sync-outlook-history.js [--dry-run]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachActuals, MAX_RECORDS, summarizeHistory } from "../lib/outlook-history.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "outlook-history.json");

const SINA_KLINE =
  "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData" +
  "?symbol=sh000001&scale=240&ma=no&datalen=400";

const dryRun = process.argv.includes("--dry-run");

async function readStore() {
  try {
    const payload = JSON.parse(await fs.readFile(OUT, "utf8"));
    return {
      generatedAt: payload.generatedAt ?? null,
      source: payload.source ?? null,
      closes: payload.closes && typeof payload.closes === "object" ? payload.closes : {},
      records: Array.isArray(payload.records) ? payload.records : []
    };
  } catch {
    return { generatedAt: null, source: null, closes: {}, records: [] };
  }
}

async function fetchCloses() {
  const response = await fetch(SINA_KLINE, {
    headers: {
      Referer: "https://finance.sina.com.cn/",
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) throw new Error(`sina kline responded ${response.status}`);
  const bars = await response.json();
  if (!Array.isArray(bars) || bars.length === 0) throw new Error("sina kline returned no bars");
  const closes = {};
  for (const bar of bars) {
    const close = Number(bar?.close);
    if (bar?.day && Number.isFinite(close)) closes[bar.day] = close;
  }
  return closes;
}

function pct(value) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

async function main() {
  const store = await readStore();
  if (store.records.length === 0) {
    console.log("Outlook history: no records yet; open 明日参考 once to start recording.");
    return;
  }

  let closes = store.closes;
  try {
    closes = await fetchCloses();
  } catch (error) {
    console.warn(`WARN: could not refresh index closes (${error.message}); grading with the committed series.`);
  }

  const records = attachActuals(store.records, closes).slice(-MAX_RECORDS);
  const summary = summarizeHistory(records);
  const dates = Object.keys(closes).sort();
  const newest = dates[dates.length - 1] ?? null;

  console.log(
    `Outlook history: ${summary.scored}/${summary.total} scored (${summary.pending} pending), ` +
      `hitRate ${pct(summary.hitRate)} over ${summary.directional} directional calls, ` +
      `correlation ${summary.correlation ?? "—"}, closes ${dates.length} through ${newest ?? "—"}`
  );
  for (const bucket of summary.buckets) {
    if (!bucket.count) continue;
    console.log(
      `  ${bucket.label.padEnd(12)} n=${String(bucket.count).padStart(3)}  ` +
        `avg ${bucket.avgChangePct > 0 ? "+" : ""}${bucket.avgChangePct ?? "—"}%  up ${pct(bucket.upRate)}`
    );
  }

  if (dryRun) {
    console.log("--dry-run: not writing data/outlook-history.json");
    return;
  }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "上证指数(000001) 日线收盘 via 新浪财经",
        closes,
        records
      },
      null,
      1
    ),
    "utf8"
  );
  console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${records.length} records)`);
}

await main();
