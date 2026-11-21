#!/usr/bin/env node
// Build the data bundle for the read-only GitHub Pages build.
//
// It boots the normal server on a private port, asks it for the precomputed
// payloads and a curated set of per-stock analyses, then writes everything to
// static-data/ so scripts/assemble-static-site.mjs can package it without a
// server. Needs the local history cache (.cache/history) for the K-line files,
// which is why this step runs on a development machine and the result is
// committed; the Pages workflow only assembles.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "static-data");
const analysisDir = path.join(outDir, "analysis");
const flowDir = path.join(outDir, "flow");
const port = Number(process.env.STATIC_PORT || 5199);
const base = `http://127.0.0.1:${port}`;
const EXTRA_CODES =
  "000001,300750,600519,601988,000858,600036,601318,000333,002594,300059,600030,601899,000651,600887,601012,688981";

const server = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", STATIC_EXPORT: "1" },
  stdio: ["ignore", "inherit", "inherit"]
});

let exiting = false;
async function shutdown(code) {
  if (exiting) return;
  exiting = true;
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.exit(code);
}
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

async function waitForHealth() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // Server not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("server did not become ready in time");
}

async function getJson(route) {
  const response = await fetch(`${base}${route}`);
  if (!response.ok) throw new Error(`${route} -> HTTP ${response.status}`);
  return response.json();
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value));
}

// Bars dominate the payload, so they ship as parallel arrays and the shim expands
// them back into objects. Numbers are rounded to two decimals; the chart never
// needs more.
function compactBars(bars) {
  const columns = { dates: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const bar of bars) {
    columns.dates.push(bar.date);
    columns.open.push(round2(bar.open));
    columns.high.push(round2(bar.high));
    columns.low.push(round2(bar.low));
    columns.close.push(round2(bar.close));
    columns.volume.push(Math.round(bar.volume || 0));
  }
  return columns;
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function roundDeep(value) {
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = roundDeep(inner);
    return out;
  }
  return typeof value === "number" ? round2(value) : value;
}

// The analysis payload carries a lot of quote/derivation fields that the chart
// panel already has from the stock row; keep only what loadChart() reads.
function compactChart(payload) {
  const history = payload.history || {};
  return {
    code: payload.code,
    name: payload.name,
    exchange: payload.exchange,
    board: payload.board,
    price: payload.price,
    changePct: payload.changePct,
    limitLabel: payload.limitLabel,
    updatedAt: history.updatedAt || null,
    history: {
      source: history.source || null,
      updatedAt: history.updatedAt || null,
      days: history.days || null,
      bars: compactBars(history.bars || []),
      plan: history.plan || null
    },
    technicals: payload.technicals || null,
    events: payload.events
      ? {
          items: (payload.events.items || []).slice(0, 4),
          eventScore: payload.events.eventScore,
          eventBias: payload.events.eventBias
        }
      : null,
    narrative: payload.narrative || "",
    node: payload.node || null,
    themes: payload.themes || null
  };
}

async function writeAllCharts(rows) {
  const chartDir = path.join(outDir, "charts");
  await fs.mkdir(chartDir, { recursive: true });
  const cached = new Set(
    (await fs.readdir(path.join(root, ".cache", "history")).catch(() => []))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
  );
  const codes = rows.map((row) => row.code).filter((code) => cached.has(code));
  let done = 0;
  let written = 0;
  const queue = codes.slice();
  const worker = async () => {
    for (;;) {
      const code = queue.shift();
      if (!code) return;
      try {
        const payload = await getJson(`/api/stocks/${code}/analysis`);
        if (payload?.history?.bars?.length) {
          await writeJson(path.join(chartDir, `${code}.json`), compactChart(payload));
          written += 1;
        }
      } catch (error) {
        // A single missing history must not sink the whole build.
      }
      done += 1;
      if (done % 500 === 0) console.log(`  charts ${done}/${codes.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return written;
}

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(analysisDir, { recursive: true });
  await fs.mkdir(flowDir, { recursive: true });

  await waitForHealth();
  const started = Date.now();

  const exported = await getJson(`/api/static/export?top=80&extra=${EXTRA_CODES}`);
  await writeJson(path.join(outDir, "stocks.json"), {
    generatedAt: exported.generatedAt,
    meta: exported.meta,
    total: exported.total,
    rows: exported.rows
  });
  await writeJson(path.join(outDir, "details.json"), exported.details);
  console.log(`stocks: ${exported.total} rows, ${exported.curated.length} curated`);

  const fixed = [
    ["overview", "/api/overview"],
    ["forecast", "/api/forecast"],
    ["indices", "/api/indices"],
    ["alerts", "/api/alerts"],
    ["signals", "/api/signals?limit=200"],
    ["briefing", "/api/briefing"],
    ["briefing-overseas", "/api/briefing/overseas"],
    ["news", "/api/news?limit=900"],
    ["sector-news", "/api/sector-news?limit=31&samples=3"],
    ["outlook", "/api/outlook"]
  ];
  for (const [name, route] of fixed) {
    const payload = await getJson(route);
    await writeJson(path.join(outDir, `${name}.json`), payload);
    console.log(`  ${name}.json`);
  }

  const windows = [1, 5, 10, 20, 60, 120, 250];
  for (const scope of ["stock", "industry"]) {
    for (const side of ["inflow", "outflow"]) {
      for (const w of windows) {
        const payload = await getJson(
          `/api/flow?scope=${scope}&side=${side}&w=${w}&limit=200`
        );
        await writeJson(path.join(flowDir, `${scope}-${side}-${w}.json`), payload);
      }
    }
  }
  console.log("flow: 28 combinations");

  let analyses = 0;
  for (const code of exported.curated) {
    try {
      const payload = await getJson(`/api/stocks/${code}/analysis`);
      await writeJson(path.join(analysisDir, `${code}.json`), payload);
      analyses += 1;
    } catch (error) {
      console.warn(`  analysis ${code} skipped: ${error.message}`);
    }
  }
  console.log(`analysis: ${analyses} stocks`);

  // Every stock that has a cached K-line gets its own compact chart payload, so
  // the public build can open any code instead of only the curated ones. Missing
  // cache entries are skipped: the page then says the chart is unavailable.
  const charts = await writeAllCharts(exported.rows);
  console.log(`charts: ${charts} stocks`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    dataUpdatedAt: exported.meta?.updatedAt || null,
    dataDate: exported.meta?.updatedAt || null,
    stocks: exported.total,
    curated: exported.curated,
    analyses,
    charts,
    sources: exported.meta?.sourceLabel || exported.meta?.source || null
  };
  await writeJson(path.join(outDir, "manifest.json"), manifest);

  console.log(`static-data ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await shutdown(0);
}

main().catch(async (error) => {
  console.error(error);
  await shutdown(1);
});
