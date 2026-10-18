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
                                  --写-->  data/indices.json（一次批量行情取 36 个海外标的 + 8 个 A 股指数，含 A50 期货）

美债收益率与波动率（FRED 公开 CSV，无需 key：DGS10 / DGS2 / DGS30 / DFF / DCOILBRENTEU / VIXCLS）
  -> scripts/sync-macro.js        --写-->  data/macro.json

主力资金流（东方财富 datacenter-web RPT_DMSK_TS_FUNDFLOW，默认最近 250 个交易日，约一年）
  -> scripts/sync-flow.js         --写-->  data/flow.json
                                  --读-->  data/flow.json（已覆盖最新交易日则整步跳过）

交易日日历
  data/flow.json 的 sessions --减去周一至周五--> lib/trading-days.json（观测到的休市日）
  lib/market-holidays.js 的人工休市表 --合入-->   同一份日历

data/*.json + lib/pinyin-index.json + lib/trading-days.json
  -> server.js（读取 + 内存缓存 + 路由）
       其中 buildSectorNews(events) 做板块消息面归因
       其中 buildOutlook(...)     把当日结构 + 隔夜/海外输入合成次日倾向评分
       其中 recordOutlook(...)    --写--> data/outlook-history.json（当天评分落盘）
       其中 recordAlertDigest(...)--写--> data/alert-digest.json（当天异动摘要落盘）
  -> public/index.html + public/app.js + public/chart.js
```

盘中不接实时行情是刻意的：A 股实时行情的再分发需要交易所授权，本项目只做收盘后复盘，所以所有数据都来自收盘快照加隔夜刷新。

`.github/workflows/update-data.yml` 是收盘后的主写入方：交易日 15:30（cron `30 7 * * 1-5`，即 07:30 UTC）依次执行 `npm run update`、`npm run sectors`、`npm run history`、`npm run news`、`npm run macro`、`npm run flow`、`npm run index:pinyin`、`npm run index:calendar`、`npm run check:api`、`npm run outlook:history`、`npm run notify`，最后提交有变化的数据文件。增量来源与索引重建都标了 `continue-on-error: true`，单个第三方源失败不会阻断当天的行情提交。

顺序上有两个依赖关系值得注意：`index:calendar` 必须排在 `flow` 之后，因为它从 `data/flow.json` 的交易日反推休市日；`outlook:history` 必须排在 `check:api` 之后，因为评分记录是由 `/api/outlook` 那次真实请求写下的，先计分只会拿到空账本。

`.github/workflows/refresh-globals.yml` 是盘前的一趟补刷新：05:30（cron `30 21 * * 0-4`，即前一天 21:30 UTC）只跑 `npm run news` 与 `npm run macro`，更新 `events.json` / `indices.json` / `macro.json`，**刻意不跑 `npm run update`**——盘前跑它会用空值覆盖上一交易日收盘。存在的理由很具体：北京 15:30 时美股当天还没开盘，收盘那趟拿到的必然是**前一晚**的美股与美债，「明日参考」要能指导开盘就必须在美股收盘后再刷一次。

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

`scripts/sync-news.js` 聚合 5 个免鉴权来源：新浪 7x24 快讯（tag 0 公司 / 1 政策 / 2 数据 / 102 国际）、新浪滚动新闻、东财快讯（含美联储 / 欧洲央行 / 日本央行 / 期货商品 / 外汇债券 / 宏观等 desk）、巨潮公告（POST `www.cninfo.com.cn/new/hisAnnouncement/query`，`pageSize` 上限 30）、东财公告。各来源独立解析（`parseSinaLive` / `parseSinaRoll` / `parseKuaixun` / `parseCninfo` / `parseEastmoneyAnnouncements`），经 `dedupeEvents` 与 `isUsableEvent` 去重过滤后写入 `data/events.json`，按时间倒序截断到 900 条。顶层为 `{generatedAt, providers, count, note, items}`，`providers` 记录每个来源的条数或错误，便于区分「当天没消息」和「来源挂了」。公告类来源会写 `kind: "announcement"`，这是区域判定与前端「公告 / 报道」配比的唯一依据。

`dedupeEvents` 做两件事：先按 `id` 去重，再按**归一化标题**跨源合并。`eventTitleKey(title)` 先剥掉尾部的媒体署名（`— 新浪财经` / `| 东方财富` 之类），去掉全部标点与空白，转小写；**归一化后短于 6 个字符的标题不参与合并**，否则「公告」「午评」这种词会把不相关的消息串成一条。同组保留发布更早的那条（同一分钟则留摘要更长的），`codes` 取并集，并把其它来源记进 `alsoIn`（按 `·` 切出 `sourceFamily`，同一来源的不同栏目不算「另见」）。实测 871 条里合并掉 26 组跨源重复。

同一次运行还会把 36 个海外标的（道指 / 纳指 / 标普 / 费半 / 美股龙头 4 只 / 日经 / 恒指 / 恒生国企 / 富时 / 富时中国 A50 期货 / 美元指数 / 8 个汇率 / 12 个商品）与 8 个 A 股指数（上证 / 深证成指 / 创业板指 / 科创50 / 沪深300 / 上证50 / 中证500 / 北证50）合成**一次** `hq.sinajs.cn/list=` 批量请求，GBK 解码后写入 `data/indices.json`。字段布局按前缀分派（`gb_*` / `int_*` / `rt_hk*` / `hf_*` / `fx_*` / `DINIW` / A 股的 `s_*` 各不相同），美元指数没有涨跌幅字段，只能由昨收推导。A 股指数的 `group` 是 `A股指数`，只供页面顶部的指数条使用，`buildGlobalBriefing` 按 `OVERSEAS_GROUPS` 过滤，所以「海外」板块的 `count` 仍是 36。指数抓取失败只记进 `errors`，不影响事件同步。其中 `hf_CHA50CFD`（富时中国 A50 期货）是「明日参考」最关键的领先输入——A 股收盘后只有它还在给次日开盘定价。

`lib/news-region.js` 在读取时把事件分成 `cn` / `global`：显式 `region` 优先，其次带 A股 `codes` 且只命中地理词的判 `cn`，再次 `kind === "announcement"` 且有代码的判 `cn`，然后才看强海外信号词与地理词，最后默认 `cn`。600 条真实事件的分布约为 509 / 91。

### Macro Sync

`scripts/sync-macro.js` 从 FRED 公开 CSV（`https://fred.stlouisfed.org/graph/fredgraph.csv?id=<ID>`，无需 API key）取美债收益率、联邦基金利率与 VIX 波动率，写 `data/macro.json`。`lib/macro.js` 负责解析与成形：`parseFredCsv`（`.` 是假期标记要跳过，按日期去重升序）、`buildMacroItem`（收益率类 `change` 为百分点、`changeBp` 为基点；VIX 这类点位序列 `kind: "level"`，只给 `change` 与 `changePct`，`changeBp` 为 null）、`buildTermSpread`（同日对齐求 10Y−2Y）、`buildMacroPayload`（保留最近 30 个观测点画走势）。

这条链路只能走 FRED：实测新浪（`US10Y` / `gb_$tnx` / `znb_UST10Y` 等 9 个符号）与东财（`100.US10Y` / `100.TNX` 等 secid）全部返回空，东财 `RPTA_WEB_TREASURYYIELD` 虽有数据但列名是匿名 `EMM/EMG` 编码、无法安全命名期限，因此不采用。美债缺失时「明日参考」把该因子记进 `missing` 并按可用权重重新归一，不填 0。

### Money Flow

`scripts/sync-flow.js` 用东方财富 `datacenter-web` 的 `RPT_DMSK_TS_FUNDFLOW` 报表取全市场主力资金流，汇总成 `data/flow.json`。选它的原因是东财对 `push2*` 做了按路径封锁，`datacenter-web` 的报表接口仍然可用，且口径完整（超大单 / 大单 / 中单 / 小单四档，单位元）。

窗口长度是这个脚本的核心设计点。报表的 `filter` 支持**双边** `TRADE_DATE` 区间（`(TRADE_DATE>='a')(TRADE_DATE<='b')`），表里每个交易日约 5600 行、并可回溯到 2010-01-04，所以一次分页扫描就能覆盖一整段窗口，而不需要每个交易日各扫一次。默认 `--days=250`（约一年）：`pageSize=20000` 时约 70 个请求、约 5.4 分钟、约 2.7 MB 落盘（约 140 万行传输是全部成本）；`--days=60`（约一个季度）约 12 个请求、12 秒（冷启动 50 秒）。落盘体积几乎不随窗口变化，因为存的是滚动汇总而不是逐日明细。`columns` 只取本脚本读的 12 列，把每行从约 5.8 KB 压到约 0.3 KB——这也是长窗口能跑通的前提。

落盘结构分成两层：`stocks[]` 每只股票保留 `main1/5/10/20/60/120/250` 与 `amount1/…/amount250` 的滚动累计，`history[]` 保留整段窗口的**市场层面**逐日序列（`mainNet` / `amount` / `inflows` / `outflows`），供前端画走势柱。行业榜用 `data/sectors.json` 的申万行业成员聚合，个股榜与行业榜共用同一份数据，避免混用不一致的提供者。上市不足 250 个交易日的股票 `sessions` 会小于 `days`，窗口按实际存在的天数求和。脚本要求覆盖率不低于 90%，否则保留旧文件。

脚本开头会先探一次最新交易日（`sessions[0]`），如果 `data/flow.json` 已经覆盖这个交易日、交易日数没变少、成功率不低于 98%，就直接打印 `Flow snapshot already covers …; skipping.` 返回，不发那 70 个请求。这条短路是为节假日和重复触发准备的：CI 里原本每次空跑要花 647 秒，现在约 2 秒。需要强制重建时加 `--force`。

### Sector News

`lib/sector-news.js` 的 `buildSectorNews(events, stocks, options)` 把当天事件归因到 31 个申万一级行业，输出每板块的利好 / 利空 / 中立条数与方向净值。三条设计约束都来自实测踩坑：

1. **只对标题分类**（`classifyEvent({ title })`）。公告正文动辄上万字符，一条文件会把十几个板块同时命中；标题才说明它到底在讲哪个板块。
2. **两条归因腿带权重**：命中 A 股 `codes` → 该股所属行业（权重 1.0，硬证据）；命中主题 → `THEME_INDUSTRIES` 映射（权重 0.45，最多取最强 2 个主题）。有代码命中时不再用主题重复归因。
3. **「券商概念」故意不在映射表里**：它的关键词（牛市 / 行情 / 成交量）几乎对每一条行情评论都生效，会把非银金融刷成满屏利好。归不到任何板块的标题直接丢弃，不摊到全市场。

样本按标题去重（同一标题会从多个来源到达），`via: "code"` 的排在前面，供前端展示「这条为什么算这个板块的」。

### Outlook

`lib/outlook.js` 的 `buildOutlook({ now, meta, stocks, briefing, flow, indices, macro, sectorNews })` 是「明日参考」引擎，输出 `{score, bias, tone, confidence, agreement, drivers, missing, availableWeight, logic, bullish, bearish, transmissions, risks, watch, inputs}`。

- **十一个驱动因子，权重合计 100**（`DRIVER_WEIGHTS`）：A50 20、美股三大指数 11、费城半导体 6、美元指数 6、离岸人民币 6、美债 10 年期 8、VIX 3、涨跌家数 14、涨停/跌停 8、主力净额占成交额 10、个股中位涨跌幅 8。VIX 与美股指数高度同源（都是「隔夜风险偏好」的读数），所以只分 3 点，从美股指数的 14 里扣出来的，不是额外加权重。
- 每个因子把原始变动归一化到 `-1..1` 再乘权重，`score = Σ贡献 / Σ可用权重 × 100` 截到 `±100`。可用权重做分母意味着**缺一个输入只是把它移出分母并记进 `missing`**，不会把分数往 0 拽，也不拿中性值冒充数据。
- `score` 是「证据一致性」而不是上涨概率；`confidence` 由分数绝对值与方向一致性（`agreement`）加权得出。
- **分数与传导读取不同的符号，这是最容易写反的地方**：`z` 表示「对 A 股的净影响」（正=利多），而 `dxy` / `cnh` / `us10y` 的 `z` 与原始变动方向相反。因此 `add(key, label, raw, rawText, z, effectText, macro)` 额外记录原始方向，`TRANSMISSION` 表按 `driver.macro` 查，不按 `driver.z` 查。否则美债收益率下行会套用「上行」的传导表，把电子、计算机打成利空。`tests/outlook.test.js` 专门守这一条。
- `TRANSMISSION` 的每个键是 `{up: {bullish, bearish, reason}, down: {...}}`，`reason` 必须同时讲两侧（例如原油上涨：利好上游油气煤炭，同时压制交运与化工的成本端），前端用 `dedupeTransmissions` 按 `key:direction` 合并，避免同一句话按板块重复六遍。
- `risks` 是条件式的：只有美债 ≥4.8%、跌停多于涨停、|A50| ≥0.8%、原油单日 >1%、主力净流出这些条件真的触发时才出现，不预先写死结论。
- `forDate` 不再由 `new Date(now + 1d)` 推出，而是查 `lib/trading-calendar.js`。返回体里的 `forDateExact` 区分两种可信度：`true` 表示该日期落在已知交易日快照内或人工休市表已确认的区间，`false` 表示只是按工作日推断（已确认区间之外）。watch 清单在 `exact: false` 时把「明日 <日期>」降级成「下一交易日」，宁可不给日期，也不承诺一个可能放假的日期。

### Trading Calendar

`lib/trading-days.json` 不是抄来的节假日表，而是**从数据里反推**的：`scripts/build-trading-calendar.js` 取 `data/flow.json` 的 `sessions`（250 个交易日），与区间内的周一至周五相减，差集就是这 250 天里实际休市的工作日。这样得到的日历天然和行情数据对齐——行情哪天没有，日历就哪天不开市。

跨年问题用两层兜底：`lib/market-holidays.js` 手工维护 `FORWARD_CLOSURES`（次日及以后的周内休市日，含 2027 年元旦 / 春节 / 清明 / 劳动 / 端午 / 中秋 / 国庆）与 `VERIFIED_THROUGH`。`lib/trading-calendar.js` 的 `createCalendar({days, closures, exactThrough})` 把两者合并成 `{first, last, size, closureCount, inspect, isTradingDay, next, previous, lastOnOrBefore}`；`inspect(iso)` 返回 `{trading, exact}`，落在快照区间内或 `<= exactThrough` 的已知未来都算 `exact: true`，更远只按工作日推断。导出 `nextTradingDayDetail` 给「明日参考」用，`nextTradingDay` 保持返回字符串以兼容旧调用方。

农历节日（春节、端午、中秋）的公历日期每年漂移，国务院一般 11 月才公布次年安排，所以**跨年前必须对照通知复核 `FORWARD_CLOSURES`**。构建脚本会和已观测到的休市日交叉校验，冲突时打印 `WARN` 并非零退出，避免人工表和数据打架却没人发现。

### Outlook History

`lib/outlook-history.js` 是「明日参考」的成绩单，全部是纯函数：`toRecord(outlook)` 把一份评分压成 `{dataDate, forDate, forDateExact, score, bias, tone, availableWeight, drivers:[{key,z,contribution}], recordedAt, actual}`；`upsertRecord` 按 `dataDate` 去重（保留已填好的 `actual`，所以重复打开页面不会把成绩擦掉）；`attachActuals(records, closes)` 用上证指数收盘价算出次日 `changePct` 与 `direction`（±0.05% 内算平盘），`hit` 只对 `|score| >= NEUTRAL_BAND(20)` 的方向性判断下结论，震荡记 `null` 而不是算错；`summarizeHistory` 输出命中率、待计分数、皮尔逊相关系数（样本 <3 返回 null）与五档表现。

落盘在 `server.js`：`/api/outlook` 每次处理请求都会 `recordOutlook(outlook)`，但只有序列化结果真的变了才写 `data/outlook-history.json`，否则每次刷新都会脏掉工作区。计分在 `scripts/sync-outlook-history.js`（`npm run outlook:history`）：拉上证指数日线收盘（新浪 `CN_MarketData.getKLineData`，`datalen=400`），补 `actual` 后截断到 `MAX_RECORDS`(180)。前端只拿 `history` 聚合值，不拿原始账本——账本越长，接口越不该把它整包吐出来。

### Alert Digest

`lib/alert-digest.js` 把当天异动榜压成一条可推送的摘要：`buildDigest(briefing, {limit: 8})` 取涨停 / 跌停 / 涨跌家数与前 8 只异动股（`{code, name, changePct, anomalyScore, trendScore, signalType}`），`mergeDigest` 每天保留一份并记住前一天在榜的代码，`newCodes` 据此算 🆕，`digestChanged` 比较时剔除 `generatedAt` 所以内容没变就不重复推送，`formatDigest` 输出纯文本。

`/api/briefing` 在处理请求时落盘 `data/alert-digest.json`（同样是内容变了才写）。`scripts/notify-alerts.js`（`npm run notify`）读它并推到 `ALERT_WEBHOOK_URL`，支持 `wecom` / `feishu` / `json` 三种载荷；没配 webhook 就只打印。注意聊天机器人常用 HTTP 200 包业务错误码，所以脚本除了状态码还会检查响应体的 `errcode` / `code`。

### API Server

`server.js` 基于 Node.js 原生 HTTP 模块实现接口和静态资源服务，同时是唯一的数据读取方。启动时读取 `data/all-a-shares.json`（缺失时退回 `data/sample-a-shares.json`），并把 `meta.json` / `indicators.json` / `sectors.json` / `events.json` / `indices.json` / `macro.json` / `flow.json` / `lib/pinyin-index.json` 合并成内存数据集，其中 `computeFactorTable` 负责生成截面因子，`loadFlow()` 与 `loadMacroPayload()` 分别对资金流和美债单独做 TTL 缓存（15 秒 / 30 秒）。内存缓存有效期 15 秒（`isFresh()`），所以叠加脚本跑完后最多 15 秒即生效。

路由集中在 `handleApi`：`/api/health`、`/api/search`、`/api/overview`、`/api/forecast`、`/api/sectors`、`/api/events`、`/api/indices`、`/api/news`、`/api/sector-news`、`/api/macro`、`/api/outlook`、`/api/flow`、`/api/watchlist`、`/api/briefing`、`/api/backtest`、`/api/signals`、`/api/stocks`，以及三个正则路由 `/api/stocks/:code`、`/api/stocks/:code/history`、`/api/stocks/:code/analysis`。所有数量参数都经过 `parsePositiveInt(value, fallback, max)` 钳制（默认 `limit=100`/上限 500 的 `/api/stocks`、默认 60/上限 200 的 `/api/signals`、默认 10/上限 50 的 `/api/search`、默认 30/上限 200 的 `/api/events`、默认 400/上限 1000 的 `/api/news`、默认 12/上限 40 的 `/api/sector-news`、默认 60/上限 500 的 `/api/flow`、默认 250/上限 1023 的历史 `days`），未知 `sort` 回退到 `score`，未知 `scope` / `side` 回退到 `stock` / `inflow`。`/api/flow` 的 `w` 参数用 `parsePositiveInt(w, 1, 1024)` 取值后再用 `windows.includes()` 判定，这样**不支持的 `w` 回退到当日而不是被钳到 250**（250 现在是合法窗口）；排序键、返回的 `flow` 字段与表头都跟着它走，`history` 始终返回整段窗口，所以 `w=1` 时顶部走势柱仍然是 250 个交易日。

`buildNewsFeed(events, indices, { limit, q })` 对每条事件跑 `classifyEvent` 与 `classifyRegion`，拼 `title/summary/source/themes/codes` 做关键词过滤，返回 `{generatedAt, count, total, limit, query, counts:{cn,global}, indices, items}`，其中 `counts` 与 `total` 都是筛选后的口径。`buildGlobalBriefing(indices, events, quotesUpdatedAt, now)` 生成海外板块的 `{count, groups, themes, newsCount, headlines, narrative, dataUpdatedAt}`，挂在 `/api/briefing` 的 `overseas` 字段上；`dataUpdatedAt` 是**行情数据的时间戳**，不是请求时间，两张简报卡都显示它。`/api/outlook` 用 `Promise.all([loadFlow(), loadIndicesPayload(), loadMacroPayload()])` 加 `buildSectors()`、`buildSectorNews()`、`buildBriefing()` 一起喂给 `buildOutlook`。

静态资源从 `public/` 目录读取，`/` 映射到 `/index.html`，并对 `filePath.startsWith(PUBLIC_DIR)` 做路径穿越防护。服务监听 `HOST`（默认 `localhost`）和 `PORT`（默认 5173）。

所有响应统一走 `writeResponse(req, res, statusCode, contentType, body, cacheControl)`：可压缩类型（JSON / JS / CSS / HTML / SVG）超过 1 KB 时按 `Accept-Encoding` 协商 gzip，并附上基于内容 sha1 的 `ETag`；带 `If-None-Match` 命中时直接回 304。实测 `/api/stocks` 从 135 KB 压到 28 KB（4.8×）、`/api/flow` 3.5×、`/styles.css` 5.8×。因为 ETag 需要浏览器回源校验，JSON 的 `cache-control` 从 `no-store` 改成 `no-cache`——`no-store` 会让浏览器连条件请求都不发，ETag 就白设了。

`/api/outlook` 与 `/api/briefing` 除了返回数据，还会顺带写落盘文件（`data/outlook-history.json` / `data/alert-digest.json`），所以这两个 GET 是有副作用的；好消息是它们有内容比对，重复请求不会产生 diff。`/api/outlook` 的 `history` 只回聚合指标，不回原始账本。

### Dashboard

`public/app.js` 负责调用 API、维护页面状态、处理筛选排序、即时检索、自选股和个股详情渲染。页面是三栏工作台：左侧竖直 tab 栏（`showTab`，共 `flow` / `stocks` / `news` / `watch` / `outlook` 五栏）驱动中间主舞台，右侧个股详情与异动信号常驻。三栏之上是 A 股指数条（`reloadMarketIndices` → `renderMarketIndexStrip`，只取 `group === "A股指数"` 的 8 个标的），它在启动时加载一次、不属于任何 tab；概览条里的「沪深北 · 只数」是三个交易所的股票数量，与指数点位无关，用 `is-dense` 字号避免三组数字被裁切。`public/chart.js` 是独立的 `drawPriceChart(canvas, payload, options)`，用原生 canvas 绘制日 K、均线、布林带、成交量副图和十字光标，并渲染买点 / 止损 / 目标标记，不引入任何图表库。看盘台支持 `options.from` / `options.to` 指定可视窗口，返回值带 `{from, to, total}` 供调用方维护缩放状态；`options.hover` 是可视窗口内的整数 bar 索引，触发十字线、右侧价格标签和 OHLC 读数条。`options.type` 取 `"candle"`（默认）或 `"line"`，线图模式画收盘折线加渐变面积，两种模式都带 TradingView 式最新价标签。滚轮缩放以光标位置为锚点、拖动平移用 Pointer Events、双击复位，最小可视跨度 12 根。检索的四个维度（代码 / 名称 / 全拼 / 首字母）统一走 `/api/search`。搜索框本身由 `createSearchBox({ input, list, wrap, ... })` 这个工厂生成，「股票」与「主力资金」两个 tab 各实例化一个，共享联想下拉、方向键 / Enter / Esc 键盘处理、点外关闭和 220ms 防抖；两者只在 `onPick` / `onQuery` 上不同——股票 tab 把选中项送进 `selectStock` 并重查 `/api/stocks`，主力资金 tab 把选中项写进 `state.flow.q` 并重查 `/api/flow?q=`，所以资金流榜单可以直接按代码、名称、拼音甚至行业名过滤。

新闻栏的两列内容来自同一份事件池，`composeColumn` 对每列做三件事：同一发行人最多 2 条、公告类不超过整栏三分之一、报道与公告两股流按 2:1 交错，避免收盘公告把当天报道整段压到底部。

「明日参考」tab 的历史战绩面板由 `renderOutlookHistory(history)` 渲染，分三态：没有账本、有账本但一条都没到计分时点（只显示「已记录 N 个交易日 / 待计分 N」）、有已计分样本（四格指标 + 五档表）。**待计分的记录单独计数、不混进命中率**，样本不足 3 条时相关系数显示「样本不足」而不是 0——这两点决定了这块面板是可核查的成绩单而不是装饰。

响应式在 1280 / 1080 / 720 三档实测过（把页面塞进指定宽度的 iframe，媒体查询按 iframe 视口求值，所以能在单个窗口里真测）：三档下五个 tab 全部零横向溢出。≤1080 时中间舞台收窄，≤720 时左栏折成横向一行、概览卡变 2 列、搜索框占满整行。指数条在窄屏改成横向滚动，`syncIndexStripOverflow()` 在 `scrollWidth > clientWidth` 时给 `.index-strip` 加 `is-scrollable`，CSS 用 `mask-image` 在右缘做渐隐——否则最后一格被硬切会看起来像布局错了。窗口 resize 时重算这个类。

### Search

`lib/search.js` 读取 `lib/pinyin-index.json`（预生成，含 `chars` 单字表与 `names` 名称表），`buildSearchIndex` 为每只股票建立代码、小写名称、全拼、首字母四个键，`suggest(index, query, limit)` 按「代码精确 > 代码前缀 > 名称前缀 > 全拼前缀 > 首字母前缀 > 包含匹配」的权重排序。索引缺失时退回纯代码 / 名称匹配。

索引按「剥掉 `XD / XR / DR / N / C / *ST` 前缀后的名字」建条目：`stripNamePrefix(name)` 去掉临时标记，`pinyinOf` 查表与按字兜底都走剥离后的名字，所以 `XD片仔癀` 存的是 `pianzaihuang / pzh`，不会把 `xd` 拼进去；同时保留带前缀的原名作为别名键，输入原样也能命中。生成器 `scripts/build-pinyin-index.js` 依赖 `pinyin-pro`，但只以 `npm install --no-save pinyin-pro` 的方式使用，不是 `package.json` 的依赖；内容与上一版一致时只打印 `already current` 不重写文件，避免每天产生一个 230 KB 的无意义 diff。CI 里重建这一步是 `continue-on-error`，因为它要临时从 npm 装 `pinyin-pro`。

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

注意区分两个同名概念：个股的 `outlook` 是**单只股票**的条件化交易计划，而「明日参考」tab 的 `/api/outlook` 是**全市场**的次日倾向评分，两者共用词但数据链路不同（后者见 `lib/outlook.js` 的 Outlook 一节）。

## Testing

`npm run test` 等价于 `node --test tests/`，使用 Node.js 内置测试运行器，当前 11 个文件 138 个用例。`tests/lib.test.js` 覆盖板块 / 涨跌停 / 指标 / 因子与回测端到端，`tests/events.test.js` 覆盖事件分类与扩散，`tests/news-region.test.js` 覆盖中国 / 海外区域判定、新浪六种行情族（含 A 股的 `s_*`）解析与公告解析器的 `kind` 标记，`tests/news-dedupe.test.js` 覆盖跨源标题归一化与合并，`tests/outlook.test.js` 覆盖明日参考的驱动权重、缺失因子的归一化、**传导方向必须读原始变动而不是市场影响符号**、利好利空互斥与中位涨跌幅回退，以及板块消息面的归因规则，`tests/trading-calendar.test.js` 覆盖节假日与跨年推算，`tests/outlook-history.test.js` 覆盖评分落盘、计分口径与五档统计，`tests/alert-digest.test.js` 覆盖摘要截断、新进榜标记与推送格式，`tests/search.test.js` 覆盖检索与拼音索引，`tests/history.test.js` 覆盖两种 K 线载荷解码与缓存，`tests/sectors.test.js` 覆盖节点树扁平化与成员合并。`npm run check:api` 另有接口层面的冒烟测试，会在 `127.0.0.1:5179` 临时拉起服务逐条断言，其中 `/api/indices`、`/api/news`、`/api/sector-news`、`/api/macro`、`/api/outlook`、`/api/briefing`、`/api/flow` 的断言覆盖分组完整性、筛选口径、榜单排序方向、窗口存储、「明日参考」各项结构与它的 `history` 聚合块，以及 `/api/briefing` 是否真的把异动摘要落了盘。

## Production Upgrade

后续可以将 JSON 文件替换为 PostgreSQL，将高频读取结果放入 Redis，并把 `.github/workflows/update-data.yml` 的定时任务迁移到常驻调度器。日线缓存目前落在本地磁盘，多实例部署时需要换成共享存储。此外还可以继续扩充事件源（龙虎榜、财报、北向资金）并复用现有的分类与扩散管线。资金流已滚动保留 250 个交易日（约一年），要做更长周期的资金趋势需要改为按年归档；美债与商品目前只取 FRED 的国家级日频序列，若需要盘中实时收益率曲线需引入付费行情源。

几条已知的边界：交易日历的 2027 年部分是按农历推算后人工维护的，国务院公布次年安排后需要复核 `lib/market-holidays.js` 里的 `FORWARD_CLOSURES` 与 `VERIFIED_THROUGH`；自选股存在浏览器 `localStorage`，所以 webhook 推的是全市场异动摘要而不是「我的自选」名单，按名单推送需要先把自选搬到服务端；「明日参考」的历史账本才刚开始积累，等样本够了才能给不同 score 区间标历史胜率。
