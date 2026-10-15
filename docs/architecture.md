# Architecture

StockRadar 使用轻量化架构组织行情同步、指标计算、事件聚合和前端页面。当前版本优先保证本地运行简单：Node.js 原生 HTTP 服务 + JSON 文件 + 手写前端，没有第三方运行时依赖，后续可以平滑迁移到数据库、缓存和定时任务体系。

## Data Flow

```text
行情股票池（按顺序故障转移）
  新浪财经 Market_Center.getHQNodeData (hs_a, 100/页)
  -> 腾讯财经 getBoardRankList (aStock)
  -> 东方财富 push2*/api/qt/clist/get
        |
        v
scripts/sync-a-shares.js  --写-->  data/all-a-shares.json + data/meta.json

板块节点树（新浪 sw_* / gn_*）
  -> scripts/sync-sectors.js      --写-->  data/sectors.json

日线 K 线（新浪 getKLineData -> 腾讯 fqkline）
  -> scripts/sync-history.js      --写-->  data/indicators.json
                                  --缓存--> .cache/history/（git 忽略，6h TTL）

新闻与公告（新浪 7x24 / 新浪滚动 / 东财快讯 / 巨潮公告 / 东财公告）
  -> scripts/sync-news.js         --写-->  data/events.json

data/*.json + lib/pinyin-index.json
  -> server.js（读取 + 15s 内存缓存 + 路由）
  -> public/index.html + public/app.js + public/chart.js
```

`.github/workflows/update-data.yml` 是唯一的生产写入方：交易日 15:30（cron `30 7 * * 1-5`，即 07:30 UTC）依次执行 `npm run update`、`npm run sectors`、`npm run history`、`npm run news`、`npm run check:api`，最后提交有变化的数据文件。三个增量来源都标了 `continue-on-error: true`，单个第三方源失败不会阻断当天的行情提交。

## Modules

### Data Sync

`scripts/sync-a-shares.js` 分页拉取沪深北 A股列表，并将原始字段标准化为项目内部使用的数据结构。

同步采用提供者链：新浪财经（主，节点 `hs_a`）-> 腾讯财经（备份，`board_code=aStock`）-> 东方财富（兜底）。每个提供者把各自的原始字段归一化为统一单位（金额为元、换手率为百分比、成交量为手），再交给同一套 `inferExchange` / `inferBoard` / 排序逻辑。任一提供者在连续 15 页失败后判定为整体不可用并自动切换下一个，全部失败则抛错并且不覆盖已有数据文件。写入前还会校验「不少于 4000 只」和「不低于自报总数的 98%」。实际来源写入 `data/meta.json` 的 `source` / `sourceLabel` / `sourceUrl`。

### Sector Sync

`scripts/sync-sectors.js` 抓取新浪节点树，把 `sw_*`（申万行业，31 个）和 `gn_*`（概念，213 个）扁平化为 `{id, name, count, members}`，并生成 `membership`（6 位代码 -> 所属板块 id 数组）。`chgn_*`（热门概念，705 个）体积约为前两者之和的三倍，默认不抓取，需要时加 `--include-hot-concepts`。行业数少于 31 或单页失败率超过 10% 时拒绝写盘。

### History Sync

`scripts/sync-history.js` 以并发 16 拉取全市场日线（默认 250 天），用 `lib/indicators.js` 计算指标后写入 `data/indicators.json`；覆盖率低于 0.8 且未加 `--allow-partial` 时不写盘。

`lib/history.js` 定义提供者链：新浪 `CN_MarketDataService.getKLineData`（`datalen` 上限 1023，volume 单位为股）-> 腾讯 `fqkline/get`（上限约 800，volume 单位为手，列顺序为 `date/open/CLOSE/high/low/volume`）。两个解码器分别由 `parseSinaKline` / `parseTencentKline` 实现，`normalizeBars` 负责去重、校验并按日期升序排列，`fetchDailyBars` 负责按顺序回退并把各提供者的失败聚合成一条错误信息。腾讯没有北交所历史，因此 `bj*` 代码实际只能由新浪提供服务。

`lib/history-cache.js` 提供磁盘缓存（`createHistoryCache(dir, { ttlMs, days, fetchImpl, timeoutMs })`，默认 TTL 6 小时），目录默认为 `.cache/history/`，可用 `HISTORY_CACHE_DIR` 覆盖。缓存在请求路径上生效，因此 clone 后第一次请求某个代码的 K 线会现拉一次。`data/indicators.json` 是缓存的物化快照，被提交；`.cache/` 本身被 git 忽略。

### News Pipeline

`scripts/sync-news.js` 聚合 5 个免鉴权来源：新浪 7x24 快讯、新浪滚动新闻、东财快讯、巨潮公告（POST `www.cninfo.com.cn/new/hisAnnouncement/query`，`pageSize` 上限 30）、东财公告。各来源独立解析（`parseSinaLive` / `parseSinaRoll` / `parseKuaixun` / `parseCninfo` / `parseEastmoneyAnnouncements`），经 `dedupeEvents` 与 `isUsableEvent` 去重过滤后写入 `data/events.json`，按时间倒序截断到 600 条。顶层为 `{generatedAt, providers, count, note, items}`，`providers` 记录每个来源的条数或错误，便于区分「当天没消息」和「来源挂了」。

### API Server

`server.js` 基于 Node.js 原生 HTTP 模块实现接口和静态资源服务，同时是唯一的数据读取方。启动时读取 `data/all-a-shares.json`（缺失时退回 `data/sample-a-shares.json`），并把 `meta.json` / `indicators.json` / `sectors.json` / `events.json` / `lib/pinyin-index.json` 合并成内存数据集，其中 `computeFactorTable` 负责生成截面因子。内存缓存有效期 15 秒（`isFresh()`），所以叠加脚本跑完后最多 15 秒即生效。

路由集中在 `handleApi`：`/api/health`、`/api/search`、`/api/overview`、`/api/forecast`、`/api/sectors`、`/api/events`、`/api/watchlist`、`/api/briefing`、`/api/backtest`、`/api/signals`、`/api/stocks`，以及三个正则路由 `/api/stocks/:code`、`/api/stocks/:code/history`、`/api/stocks/:code/analysis`。所有数量参数都经过 `parsePositiveInt(value, fallback, max)` 钳制（默认 `limit=100`/上限 500 的 `/api/stocks`、默认 60/上限 200 的 `/api/signals`、默认 10/上限 50 的 `/api/search`、默认 30/上限 200 的 `/api/events`、默认 250/上限 1023 的历史 `days`），未知 `sort` 回退到 `score`。

静态资源从 `public/` 目录读取，`/` 映射到 `/index.html`，并对 `filePath.startsWith(PUBLIC_DIR)` 做路径穿越防护。服务监听 `HOST`（默认 `localhost`）和 `PORT`（默认 5173）。

### Dashboard

`public/app.js` 负责调用 API、维护页面状态、处理筛选排序、即时检索、自选股和个股详情渲染。`public/chart.js` 是独立的 `drawPriceChart(canvas, payload, options)`，用原生 canvas 绘制日 K、均线、布林带、成交量副图和十字光标，并渲染买点 / 止损 / 目标标记，不引入任何图表库。检索的四个维度（代码 / 名称 / 全拼 / 首字母）统一走 `/api/search`。

### Search

`lib/search.js` 读取 `lib/pinyin-index.json`（预生成，含 `chars` 单字表与 `names` 名称表），`buildSearchIndex` 为每只股票建立代码、小写名称、全拼、首字母四个键，`suggest(index, query, limit)` 按「代码精确 > 代码前缀 > 名称前缀 > 全拼前缀 > 首字母前缀 > 包含匹配」的权重排序。索引缺失时退回纯代码 / 名称匹配。生成器 `scripts/build-pinyin-index.js` 依赖 `pinyin-pro`，但只以 `npm install --no-save pinyin-pro` 的方式使用，不是 `package.json` 的依赖。

### Events

`lib/events.js` 在读取时对每条事件做规则分类：`classifyCategory` / `detectPolicy` / `detectThemes` / `extractMetrics` / `classifyEvent` 输出类别、倾向、量级、命中指标与主题，`timeDecay(publishedAt, now, halfLifeHours = 18)` 按 18 小时半衰期做指数衰减，`buildEventImpacts(events, stocks, { now, themeIndex, halfLifeHours })` 把命中的主题扩散到该主题的成员股（直接点名权重 3，主题扩散权重 0.45）。整个过程不调用任何模型。

### Backtest

`lib/backtest.js` 是事件分 / 异动分驱动的回测引擎，详见下方「Backtest Engine」。

### Boards / Indicators / Factors

`lib/boards.js` 集中编码交易所与板块推断（`inferExchange` / `inferBoard`）、ST 识别（`isSt` / `isRiskWarned`）、各板块涨跌幅限制（`limitPctFor`）、涨跌停价推导（`limitPrice` / `limitState` / `limitLabel`）。`lib/indicators.js`（`sma` / `ema` / `bollinger` / `rsi` / `macd` / `kdj` / `atr` / `momentum` / `maxDrawdown` / `sharpeRatio` / `computeIndicators`）与 `lib/factors.js`（`percentileRanks` / `normalizedMove` / `computeFactorTable` / `directionalScore`）构成纯函数形式的指标与截面因子层，被同步脚本、接口和回测共用。

### Theme

前端使用 CSS variables 实现亮色和暗色主题，主题偏好保存在浏览器 `localStorage`。

## Signal Scoring

异动分综合使用涨跌幅、换手率、成交额和市值影响。存在指标快照时直接使用 `computeFactorTable` 生成的截面分；缺失时退回规则评分：

```text
score = min(100, max(0, (abs(changePct) * 2.2 + turnover * 0.9
        + log10(amount) * 0.7 - marketCapPenalty) * 3.2))
```

信号标签按个股所属板块的限制幅度归一化后再分档（`getSignalType`），因此 20% 的创业板不会被 10% 的尺子误判。该分数用于排序和筛选，不用于预测未来价格。

## Event Pipeline

```text
data/events.json
  -> classifyEvent（类别 / 倾向 / 量级 / 主题 / 指标）
  -> timeDecay（18h 半衰期）
  -> buildEventImpacts（直接点名 ×3，主题扩散 ×0.45）
  -> /api/events、/api/briefing、/api/stocks/:code 的 events 字段
```

事件同时用于市场简报（`/api/briefing` 的主题雷达、涨停板和异动名单）和回测的信号来源。

## Backtest Engine

`/api/backtest` 由 `lib/backtest.js` 驱动。信号取自第 t 日收盘，第 t+1 日**开盘**成交，因此不存在未来函数；引擎同时遵守 T+1、开盘涨停不允许买入、开盘跌停不允许卖出、100 股整手交易，并支持止损 / 止盈 / 持有期到期 / 定期换仓。成本模型为佣金 0.025%（最低 5 元）、卖出印花税 0.05%、过户费 0.001%、滑点 0.1%。

`summarize()` 输出总收益、年化收益、最大回撤、波动率、Sharpe、Sortino、交易笔数、胜率、盈亏比、平均持有交易日、等权基准收益和超额收益。接口在返回前调用 `walkForwardValidation(config, 0.7)` 按时间顺序切分样本内 / 样本外两段，并附带净值曲线与最近 50 笔成交；没有可用历史时返回 422。

## Direction Forecast

方向观察模块使用当日市场宽度、涨跌停强度、平均涨跌幅、强势/弱势个股数量和成交活跃度生成可解释方向标签。该模块不输出买卖建议，也不把结果视作价格预测。

## Stock Outlook

个股详情接口会为每只股票生成 `outlook`。该字段基于个股涨跌幅、相对板块表现、换手率、成交额、日线指标和大盘方向观察生成明日走势、观察分、置信度、驱动因子、交易计划、失效条件和情景推演；历史不可用时 `history` 字段降级为 `{error}`，接口仍返回 200。

## Testing

`npm run test` 等价于 `node --test tests/`，使用 Node.js 内置测试运行器。`tests/lib.test.js` 覆盖板块 / 涨跌停 / 指标 / 因子与回测端到端，`tests/events.test.js` 覆盖事件分类与扩散，`tests/search.test.js` 覆盖检索与拼音索引，`tests/history.test.js` 覆盖两种 K 线载荷解码与缓存，`tests/sectors.test.js` 覆盖节点树扁平化与成员合并。`npm run check:api` 另有接口层面的冒烟测试，会在 `127.0.0.1:5179` 临时拉起服务逐条断言。

## Production Upgrade

后续可以将 JSON 文件替换为 PostgreSQL，将高频读取结果放入 Redis，并把 `.github/workflows/update-data.yml` 的定时任务迁移到常驻调度器。日线缓存目前落在本地磁盘，多实例部署时需要换成共享存储。此外还可以继续扩充事件源（龙虎榜、资金流向、财报）并复用现有的分类与扩散管线。
