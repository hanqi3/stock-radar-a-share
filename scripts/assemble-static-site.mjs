#!/usr/bin/env node
// Package the read-only GitHub Pages build: public/ + static-data/ -> dist/.
// No server, no dependencies, deterministic, so the Pages workflow only runs this.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "static-data");
const distDir = path.join(root, "dist");

const BANNER = `
  <style>
    .static-chip {
      margin-left: 8px; padding: 2px 7px; border-radius: 999px;
      font: 10px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      font-weight: 500; letter-spacing: .02em;
      color: #2b6cb0; background: rgba(96, 165, 250, .16);
      border: 1px solid rgba(96, 165, 250, .38);
      vertical-align: 2px; white-space: nowrap;
    }
    :root[data-theme="dark"] .static-chip { color: #9ec5ff; }
    @media (max-width: 820px) { .static-chip { display: none; } }
  </style>
  <script>
    document.addEventListener("DOMContentLoaded", function () {
      var brand = document.querySelector(".brand");
      if (!brand) return;
      var chip = document.createElement("span");
      chip.className = "static-chip";
      chip.textContent = "演示版";
      chip.title = "静态演示：数据只读，自选只保存在这台设备";
      brand.appendChild(chip);
    });
  </script>
`;

const BOOT = `<script>window.STATIC_SITE = true; window.STATIC_DATA_BASE = "static-data";</script>`;
const BOOT_HEAD = `<script>
  window.STATIC_SITE = true;
  window.STATIC_DATA_BASE = "static-data";
  try {
    if (!localStorage.getItem("stockradar-token")) localStorage.setItem("stockradar-guest", "1");
    localStorage.removeItem("stockradar-api-base");
  } catch (error) { /* ignore */ }
</script>`;

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

  await fs.rm(distDir, { recursive: true, force: true });
  await copyDir(publicDir, distDir);
  await copyDir(dataDir, path.join(distDir, "static-data"));

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
        当前是<strong>静态演示版</strong>，没有后端账号系统。直接点下面的「游客登录」就能进去浏览。
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
      "<p>这个地址不存在。</p><p><a href=\"./\">回到 StockRadar 演示版</a></p>"
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
