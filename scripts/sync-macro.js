// Sync US treasury yields into data/macro.json.
//
// FRED serves the whole series as CSV, so there is no key, no quota and no SDK.
// `cosd` trims the download to the recent window we actually use.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MACRO_DEFINITIONS, buildMacroPayload } from "../lib/macro.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_FILE = path.join(ROOT, "data", "macro.json");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/csv,*/*"
};

const DEFAULTS = {
  historyDays: 60,
  timeoutMs: 20_000,
  maxAttempts: 3
};

function fredUrl(fredId, from, reference = new Date()) {
  return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(fredId)}&cosd=${from}`;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

async function getText(url, options = {}) {
  const { timeoutMs = DEFAULTS.timeoutMs, maxAttempts = DEFAULTS.maxAttempts } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("fetch failed");
}

/**
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.historyDays]
 * @param {(url:string)=>Promise<string>} [options.fetchText] injection seam for tests
 */
export async function syncMacro(options = {}) {
  const { now = new Date(), historyDays = DEFAULTS.historyDays, fetchText = (url) => getText(url, options) } = options;
  const from = isoDay(shiftDays(now, -historyDays));
  const { parseFredCsv } = await import("../lib/macro.js");
  const seriesBySymbol = {};
  const failures = [];

  for (const definition of MACRO_DEFINITIONS) {
    try {
      const text = await fetchText(fredUrl(definition.fredId, from, now));
      const points = parseFredCsv(text);
      if (!points.length) throw new Error("empty series");
      seriesBySymbol[definition.symbol] = points;
    } catch (error) {
      failures.push({ symbol: definition.symbol, fredId: definition.fredId, error: String(error?.message ?? error) });
    }
  }

  if (!Object.keys(seriesBySymbol).length) {
    throw new Error(`no macro series fetched: ${failures.map((entry) => `${entry.fredId}:${entry.error}`).join("; ")}`);
  }

  const payload = {
    ...buildMacroPayload({
      seriesBySymbol,
      source: "fred",
      sourceLabel: "FRED 美国国债收益率",
      now
    }),
    requested: MACRO_DEFINITIONS.length,
    succeeded: Object.keys(seriesBySymbol).length,
    failed: failures.length,
    failures
  };
  return payload;
}

async function main(argv = process.argv.slice(2)) {
  const outIndex = argv.findIndex((arg) => arg.startsWith("--out="));
  const outFile = outIndex >= 0 ? argv[outIndex].slice("--out=".length) : OUT_FILE;
  const startedAt = Date.now();
  const payload = await syncMacro();
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, `${JSON.stringify(payload)}\n`, "utf8");
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `Macro: ${payload.succeeded}/${payload.requested} series, updated ${payload.updatedAt ?? "—"}, ` +
      `${(JSON.stringify(payload).length / 1024).toFixed(1)} KB in ${seconds}s -> ${path.relative(ROOT, outFile)}`
  );
  for (const item of payload.items) {
    console.log(
      `  ${item.symbol.padEnd(10)} ${item.name.padEnd(14)} ${item.value} ${item.unit}` +
        (item.changeBp === null ? "" : ` (${item.changeBp > 0 ? "+" : ""}${item.changeBp}bp)`)
    );
  }
  for (const failure of payload.failures) console.warn(`  ! ${failure.fredId}: ${failure.error}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("sync-macro failed:", error?.message ?? error);
    process.exitCode = 1;
  });
}
