#!/usr/bin/env node
// Package the read-only GitHub Pages build: public/ + static-data/ -> dist/.
// No server, no dependencies, deterministic, so the Pages workflow only runs this.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "static-data");
const distDir = path.join(root, "dist");

// No extra badge: the page should read as the product itself. The login page
// is only reachable after an explicit sign-out and explains the guest mode.
const BANNER = "";

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(source, target);
    else await fs.copyFile(source, target);
  }
}

async function main() {
  if (!(await fs.stat(dataDir).catch(() => null))) {
    throw new Error("static-data/ is missing; run `npm run static:data` first");
  }

  // GitHub Pages caches files by URL for ten minutes, so a rebuild that reuses
  // "static-data/stocks.json" can keep serving yesterday's snapshot. Namespacing
  // the directory with the build stamp makes every deploy a fresh URL.
  const dataManifest = JSON.parse(await fs.readFile(path.join(dataDir, "manifest.json"), "utf8"));
  const stamp = `${dataManifest.generatedAt || ""}:${dataManifest.stocks || 0}:${dataManifest.dataUpdatedAt || ""}`;
  const dataBase = `static-data-${crypto.createHash("sha1").update(stamp).digest("hex").slice(0, 8)}`;

  await fs.rm(distDir, { recursive: true, force: true });
  await copyDir(publicDir, distDir);
  await copyDir(dataDir, path.join(distDir, dataBase));

  const boot = (key, value) => key.replaceAll("static-data", dataBase);
  const BOOT = boot(`<script>window.STATIC_SITE = true; window.STATIC_DATA_BASE = "static-data";</script>`, dataBase);
  const BOOT_HEAD = boot(`<script>
  window.STATIC_SITE = true;
  window.STATIC_DATA_BASE = "static-data";
  try {
    if (!localStorage.getItem("stockradar-token")) localStorage.setItem("stockradar-guest", "1");
    localStorage.removeItem("stockradar-api-base");
  } catch (error) { /* ignore */ }
</script>`, dataBase);

  // Pages project sites live under /<repo>/, so every root-absolute asset path
  // has to become relative.
  const relative = (html) => html.replace(/(href|src)="\/(?!\/)/g, '$1="');

  const indexPath = path.join(distDir, "index.html");
  let index = await fs.readFile(indexPath, "utf8");
  index = relative(index);
  index = index.replace("<head>", `<head>\n${BOOT_HEAD}`);
  index = index.replace(
    '<script src="app.js" type="module"></script>',
    `<script src="static-api.js"></script>\n    <script src="app.js" type="module"></script>`
  );
  index = index.replace("</body>", `${BANNER}</body>`);
  await fs.writeFile(indexPath, index);

  for (const page of ["login.html", "register.html"]) {
    const file = path.join(distDir, page);
    const html = await fs.readFile(file, "utf8").catch(() => null);
    if (!html) continue;
    const notice = `
      <div style="margin:0 0 16px;padding:12px 14px;border-radius:14px;background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.35);font:13px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1d4ed8">
        当前是<strong>公开只读版</strong>，数据每交易日自动更新；直接点下面的「游客登录」就能进去浏览，自选股保存在这台设备。
      </div>`;
    let patched = relative(html).replace('<div class="auth-card">', `<div class="auth-card">${notice}`);
    patched = patched.replace("<body>", `<body>${BOOT}`);
    await fs.writeFile(file, patched);
  }

  // The PWA manifest has to work from a subdirectory too.
  const manifestPath = path.join(distDir, "manifest.webmanifest");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.start_url = ".";
  manifest.scope = ".";
  manifest.icons = (manifest.icons || []).map((icon) => ({ ...icon, src: icon.src.replace(/^\//, "") }));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // Pages should not try to render the huge JSON as text/plain HTML — it is fine,
  // but keep a friendly 404 for unknown paths.
  await fs.writeFile(
    path.join(distDir, "404.html"),
    "<!doctype html><meta charset=\"utf-8\"><title>Not found</title>" +
      "<body style=\"font:16px -apple-system,sans-serif;padding:48px\">" +
      "<p>这个地址不存在。</p><p><a href=\"./\">回到 StockRadar 首页</a></p>"
  );

  const files = await countFiles(distDir);
  const size = await dirSize(distDir);
  console.log(`dist ready: ${files} files, ${(size / 1024 / 1024).toFixed(1)} MB`);
}

async function countFiles(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(path.join(dir, entry.name));
    else total += 1;
  }
  return total;
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(target);
    else total += (await fs.stat(target)).size;
  }
  return total;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
