# 静态演示版（GitHub Pages）

仓库里同时存在两种运行方式：

| 方式 | 入口 | 能做什么 | 需要什么 |
| --- | --- | --- | --- |
| 完整版 | `node server.js` | 全部功能：账号、按用户自选、回测、每日同步 | 一台常开的机器（VPS / 家里的电脑） |
| 静态版 | GitHub Pages | 看行情、搜索、个股图表（96 只）、新闻、明日参考、资金流；自选存本机 | 什么都不用，公开链接即可 |

静态版是给"发个链接让人看看"用的：没有后端，所有数据在构建时预先算好写成 JSON，浏览器端把 `/api/...` 的请求就地接住，所以界面完全一样，只是只读。

## 它是怎么工作的

1. `scripts/build-static-data.mjs` 在本机启动一次正常的服务，把要用的接口结果整理进 `static-data/`：
   - `stocks.json`：5579 只股票的完整表格行（已按异动分排序并带 `rank`）
   - `details.json`：热门个股的详情（事件信号、明日走势、叙述）
   - `analysis/<code>.json`：96 只个股的 250 根日 K、指标、交易计划（需要 `.cache/history`）
   - `overview / forecast / indices / alerts / signals / briefing / news / sector-news / outlook.json`
   - `flow/<scope>-<side>-<window>.json`：2×2×7 共 28 种资金流组合
2. `scripts/assemble-static-site.mjs` 把 `public/` 和 `static-data/` 拼成 `dist/`，并把绝对路径改成相对路径（Pages 项目站点在 `/<repo>/` 下）。
3. `public/static-api.js` 只在这个构建里加载，拦截 `window.fetch` 的 `/api/*`，用本地 JSON 作答；自选直接读写 `localStorage`。

## 本地预览

```bash
npm run static:data     # 需要先跑过 npm run enrich / npm run history，图表才有数据
npm run static:build
npx serve dist          # 或 python -m http.server 5200 --directory dist
```

## 自动部署

整条链路分两段，全部在 GitHub 上跑，不需要任何机器常开：

1. **`Update A-share data`（`update-data.yml`）**：每天 12:30、16:30、22:00（北京时间）各跑一次，从公开数据源现拉数据：
   - 新浪 `Market_Center.getHQNodeData`：全量 A 股行情快照
   - 东方财富 `push2`：资金流与估值（PE/PB/换手/量比）
   - 新浪新闻 / 东财事件：个股事件与新闻
   - 板块、历史 K 线、指标、宏观（美债）等补全
   跑完把 `data/**` 提交回 `main`。
2. **`Deploy static site to Pages`（`pages.yml`）**：由上面那次提交触发（`workflow_run`，因为 `GITHUB_TOKEN` 的提交不会触发普通 `push` 事件），恢复历史 K 线缓存 → 生成 `static-data/` → 打包 `dist/` → 部署到 Pages。

`public/**`、`server.js`、`lib/**`、`scripts/*static*` 的改动也会单独触发一次部署。

**数据为什么总是新的**：`assemble-static-site.mjs` 会把数据目录命名成 `static-data-<构建哈希>/`，每次构建 URL 都变，GitHub Pages 的 CDN 缓存不会把旧快照发出去。

**唯一的延迟**：Pages 对 `index.html` 本身有约 10 分钟的 CDN 缓存，所以刚刚部署完的头几分钟，个别访客可能还看到上一版 HTML（数据目录是新的，下一次刷新就换过来）。

**首次启用**：仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**，然后跑一次 `Deploy static site to Pages` 工作流即可。

## 与完整版的差别

- 没有账号系统：顶部是"游客"，自选只存在当前浏览器。
- 图表只内置 96 只（当天异动分前 80 + 常见权重股）；其余个股会提示"静态演示版只内置了部分个股的 K 线"。
- 没有回测、没有自选新闻聚合、没有每日推送。
- 数据以最后一次 `data/**` 提交为准；超过 4 天没更新，顶栏会出现橙色的"数据待更新"角标。
- GitHub 的机器人在境外访问新浪 / 腾讯/ 东财，偶尔会限流；如果某天的提交没来，数据就停在前一天，页面本身仍然可用。

需要完整功能（账号同步、任意个股 K 线、回测、推送），用 [deploy.md](deploy.md) 里的云服务器方案，或者 [ios-app.md](ios-app.md) 把它装进 iPhone。
