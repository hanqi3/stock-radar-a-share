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

  const manifest = {
    generatedAt: new Date().toISOString(),
    dataUpdatedAt: exported.meta?.updatedAt || null,
    dataDate: exported.meta?.updatedAt || null,
    stocks: exported.total,
    curated: exported.curated,
    analyses,
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
