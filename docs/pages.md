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

`.github/workflows/pages.yml` 在 `main` 分支上以下任一变化时触发：

- `public/**`、`server.js`、`lib/**`、`scripts/*static*` 改动；
- `data/**` 改动 —— 也就是每天几次的 `Update A-share market data` 提交。

流程：恢复历史 K 线缓存（`npm run history`，失败则跳过）→ 生成 `static-data/` → 打包 `dist/` → 部署到 Pages。

**首次启用**：仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**，然后跑一次 `Deploy static site to Pages` 工作流即可。

## 与完整版的差别

- 没有账号系统：顶部是"游客"，自选只存在当前浏览器。
- 图表只内置 96 只（当天异动分前 80 + 常见权重股）；其余个股会提示"静态演示版只内置了部分个股的 K 线"。
- 没有回测、没有自选新闻聚合、没有每日推送。
- 数据以最后一次 `data/**` 提交为准；超过 4 天没更新，顶栏会出现橙色的"数据待更新"角标。
- GitHub 的机器人在境外访问新浪 / 腾讯/ 东财，偶尔会限流；如果某天的提交没来，数据就停在前一天，页面本身仍然可用。

需要完整功能（账号同步、任意个股 K 线、回测、推送），用 [deploy.md](deploy.md) 里的云服务器方案，或者 [ios-app.md](ios-app.md) 把它装进 iPhone。
