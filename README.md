# StockRadar A股事件雷达

StockRadar 是一个面向 A股市场的行情与事件雷达应用。项目会同步沪深北全量股票池（主源新浪财经，节点 `hs_a`），基于涨跌幅、成交额、换手率和市值等公开行情字段生成异动信号，并在此之上叠加板块成员关系、日线指标、公告与新闻事件和事件驱动回测，提供市场概览、拼音检索、K 线图、自选监控、事件雷达和个股画像。

> 本项目仅用于公开行情信息整理与研究，不构成任何投资建议。

## 功能特性

- 全量股票池：同步沪深北 A股，当前 `data/all-a-shares.json` 含 5575 只股票
- 左侧工作台：竖直 tab 栏分五栏 —— 主力资金、股票、新闻政策、我的自选、明日参考，切换后中间主舞台整体换内容，右侧个股详情与异动信号常驻
- 拼音检索：按代码 / 名称 / 全拼 / 首字母即时联想，支持上下键选择、回车确认、Esc 关闭
- 市场概览：统计上涨、下跌、平盘、涨停附近、跌停附近、成交额和交易所分布
- 异动信号：识别涨停、跌停、涨停附近、跌停附近、强势拉升、快速回撤、换手放大、成交活跃、异动关注
- 个股画像：现价、涨跌幅、成交额、市值、异动原因、走势概览、同板块对比和相关事件
- 主力资金：`data/flow.json` 按东方财富口径记录「主力净额 = 超大单净额 + 大单净额」的最近 250 个交易日（约一年），个股榜与申万行业榜都从同一份数据聚合，可切净流入 / 净流出，并可按 当日 / 近 5 日 / 近 10 日 / 近 20 日 / 近 60 日 / 近 120 日 / 近 1 年 重排；顶部柱状图是整段窗口的全市场净额走势；面板右上角有一个和「股票」tab 同源同行为的搜索框（代码 / 名称 / 拼音 / 首字母 / 行业，带联想下拉、方向键与 Enter 选中），输入即筛选榜单，行业榜里也按行业名过滤
- K 线看盘台：原生 canvas 绘制日 K（`public/chart.js`），占满主舞台并支持**滚轮缩放、拖动平移、双击复位**，鼠标悬停出十字光标与 OHLC 读数条；**蜡烛图 / 线图可切换**（线图带渐变面积与最新价标签），支持 5 / 10 / 15 / 30 / 60 / 120 / 250 日区间切换，可开关 MA5 / MA10 / MA15 / MA20、布林带和成交量副图，带买点 / 止损 / 目标标记
- 板块消息面：`/api/sector-news` 把当天 900 条标题归因到 31 个申万行业，逐板块统计利好 / 利空 / 中立条数与方向净值；归因只认两件事——标题里点名的 A 股代码（权重 1.0）和命中的主题词（权重 0.45、最多取 2 个），归不到任何板块的标题直接丢弃而不是摊到全市场
- 明日参考：`/api/outlook` 把当日结构（涨跌家数、涨跌停、主力资金、个股中位涨跌幅）和隔夜/海外输入（富时中国 A50 期货、美股三大指数、费城半导体、美元指数、离岸人民币、美债 10 年期、布伦特原油）合成一个 **-100 ~ +100 的「证据一致性」评分**，并给出判断逻辑链、宏观传导表（一个变量落到哪些板块）、利好 / 利空清单、风险点和次日盯盘清单；每个驱动因子都有权重与原始读数，缺数据就报缺而不是填中性值
- 交易计划：历史行情接口同时返回买点区间、止损价、目标和失效条件，图表右侧展示
- 双板块简报：`/api/briefing` 同时给出「中国 · A股简报」和「海外 · 全球市场简报」，海外板块覆盖美洲 / 美股龙头 / 亚太欧洲 / 外汇 / 商品五组共 36 个标的，并附海外事件主题与要闻
- 顶部指数条：上证指数 / 深证成指 / 创业板指 / 科创50 / 沪深300 / 上证50 / 中证500 / 北证50 的点位与涨跌幅常驻页面顶部（与全球指数共用同一次新浪批量行情请求，不额外发请求）
- 新闻政策：`/api/news` 把 900 条事件按区域分「中国 / 海外」两栏，支持关键词搜索（标题、摘要、来源、主题、代码）与命中高亮，公告类按发行人限流，避免同一公司的公告刷屏
- 主题雷达：`/api/briefing` 生成市场简报文字、主题事件雷达和行业相对强弱
- 板块异动监测：每个行业输出宽度（`breadth`）与 `anomalyScore`，对横截面相对强弱离群、涨跌停扎堆、宽度极端的板块打 `flags` 标签，并在雷达带行业行上显示异动 chip；`/api/briefing` 附 `sectorAnomalies`
- 板块成员：`data/sectors.json` 记录 31 个申万行业和 213 个概念板块的成员关系，用于行业相对强度和主题事件扩散
- 事件驱动：`data/events.json` 聚合政策新闻、市场快讯和交易所公告，读取时分类并做时间衰减
- 策略回测：`/api/backtest` 用事件分 + 异动分驱动的动量策略回测，含交易成本、T+1、涨跌停撮合限制和样本内 / 样本外拆分
- 自选监控：浏览器本地保存关注股票，并按规则生成告警标签（涨停 / 跌停 / 放量 / 异动 / RSI / ST / 相关事件）
- 明暗主题：支持亮色和暗色模式，并在浏览器本地保存偏好
- 多维排序：支持按异动分、涨幅、跌幅、成交额、换手率、市值和代码排序
- 零依赖运行：使用 Node.js 原生 HTTP 服务，无需安装第三方依赖

## 技术栈

- Frontend: HTML, CSS, JavaScript（K 线为手写 canvas，不引入图表库）
- Backend: Node.js HTTP Server
- Storage: JSON file（行情 / 板块 / 指标 / 事件 / 全球指数 / 宏观利率 / 资金流七个数据文件）
- Data Source: 多源提供者链（新浪财经 → 腾讯财经 → 东方财富），自动故障转移
- Search: 预生成拼音索引 `lib/pinyin-index.json`
- Runtime: Node.js 18+

## 本地运行

环境要求：

- Git
- Node.js 18 或更高版本

项目没有第三方 npm 依赖，clone 后可以直接启动：

```bash
git clone https://github.com/hanqi3/stock-radar-a-share.git
cd stock-radar-a-share
npm start
```

访问：

```text
http://localhost:5173
```

默认端口是 `5173`。如果端口被占用，可以改用其他端口：

```bash
PORT=3000 npm start
```

Windows PowerShell 可以这样写：

```powershell
$env:PORT=3000; npm start
```

默认监听地址是 `HOST` 环境变量，取值 `localhost`。注意 `localhost` 在部分系统上只解析到 IPv6 的 `::1`，此时用 `http://127.0.0.1:5173` 反而会被拒绝连接；想同时监听 IPv4 和 IPv6，改成：

```bash
HOST=0.0.0.0 PORT=5173 npm start
```

如果看到 `StockRadar is running at http://localhost:5173`，说明服务已经启动成功。

## npm 脚本

| 命令 | 作用 |
| --- | --- |
| `npm start` / `npm run dev` | 启动服务（`node server.js`） |
| `npm run sync` | 只同步股票池（`scripts/sync-a-shares.js`） |
| `npm run sectors` | 同步板块节点树与成员关系（`scripts/sync-sectors.js`） |
| `npm run history` | 同步日线并计算全市场指标（`scripts/sync-history.js`） |
| `npm run news` | 聚合新闻与公告，并抓取全球指数（`scripts/sync-news.js`） |
| `npm run flow` | 同步全市场主力资金流（`scripts/sync-flow.js`） |
| `npm run macro` | 同步美债收益率与联邦基金利率（`scripts/sync-macro.js`，数据来自 FRED） |
| `npm run update` | `sync` + `check`，即同步行情并校验数据文件 |
| `npm run enrich` | `sectors` + `history` + `news` + `flow`，即全部增量数据 |
| `npm run check` | 校验 `data/all-a-shares.json`（`scripts/check-data.js`） |
| `npm run check:api` | 启动服务并逐个接口自检（`scripts/check-api.js`） |
| `npm run test` | 运行单元测试（`node --test tests/`） |
| `npm run index:pinyin` | 重建拼音索引（`scripts/build-pinyin-index.js`） |

## 数据文件

```text
data/all-a-shares.json    原始股票池（每晚更新，已提交）
data/meta.json            数据来源与更新时间（已提交）
data/sectors.json         板块节点树 + 成员关系（已提交）
data/indicators.json      全市场个股指标快照（已提交）
data/events.json           新闻与公告事件（已提交）
data/indices.json         全球指数、外汇与大宗商品报价（已提交）
data/macro.json           美债收益率与联邦基金利率（已提交）
data/flow.json            全市场主力资金流最近 250 个交易日（已提交）
.cache/history/           日线磁盘缓存（git 忽略，不提交）
```

`data/all-a-shares.json` 字段包括：

```text
code        股票代码
name        股票名称
exchange    SH / SZ / BJ
board       沪市主板 / 深市主板 / 创业板 / 科创板 / 北交所
price       最新价
changePct   涨跌幅
change      涨跌额
volume      成交量
amount      成交额
turnover    换手率
marketCap   总市值
source      数据来源
```

`data/meta.json` 记录本次同步实际生效的来源：

```text
source         提供者 id（sina / tencent / eastmoney）
sourceLabel    提供者可读名称
sourceUrl      实际请求的完整 URL
count          写入的股票数量
reportedTotal  提供者自报总数
updatedAt      同步时间（ISO 8601）
note           说明文字
```

`data/sectors.json` 顶层为 `{generatedAt, source, sourceLabel, sourceUrl, industries, concepts, membership, notes}`。`industries` 是 31 个申万行业（`sw_*`），`concepts` 是 213 个概念板块（`gn_*`），每个板块形如 `{id, name, count, members}`；`membership` 把 6 位股票代码映射到该股票所属的板块 id 数组。新浪节点树里的 `chgn_*`（热门概念，约 705 个）默认不抓取，需要时用 `--include-hot-concepts` 显式打开。脚本在行业数少于 31 或单页失败率超过 10% 时拒绝写盘。

`data/indicators.json` 顶层为 `{generatedAt, days, requested, succeeded, failed, coverage, note, failures, items}`，`items` 以 6 位代码为键，值为 `{date, close, ma5, ma10, ma20, ma60, ma20Gap, ma60Gap, momentum5, momentum20, momentum60, volatility20, atrPct, rsi14, macdHist, bollPercentB, volumeRatio, bars, source, industryMomentum20, group}`，其中 `bars` 是该股票实际可用的日线根数。默认覆盖率为 0.8，低于该值且没有 `--allow-partial` 时脚本退出并保留旧文件。

`data/events.json` 顶层为 `{generatedAt, providers, count, note, items}`，`providers` 是每个来源的 `{id, label, count, error?}`，单条事件为 `{id, kind, title, summary, url, source, publishedAt, codes[]}`。`kind` 只有公告披露类来源（巨潮资讯、东方财富公告）会写成 `"announcement"`，区域分类和前端「公告 / 报道」配比都依赖它；缺失时全部事件会退化成按正文关键词评分。

`data/indices.json` 顶层为 `{generatedAt, source, count, note, items}`，`source` 固定为 `sina-hq`。单条为 `{symbol, name, group, digits, price, change, changePct, updatedAt}`，`group` 取 `美洲 / 美股龙头 / 亚太欧洲 / 外汇 / 商品`（海外板块，36 个）或 `A股指数`（顶部指数条，8 个：上证指数 / 深证成指 / 创业板指 / 科创50 / 沪深300 / 上证50 / 中证500 / 北证50），`digits` 是该标的的合理小数位（美元指数 3 位、汇率 4 位、指数 2 位），前端按它格式化。44 个标的由一次新浪批量行情请求取回（`gb_*`/`int_*`/`rt_hk*`/`hf_*`/`fx_*`/`DINIW` 与 A 股的 `s_*` 同批），指数抓取失败不会影响事件同步。`A股指数` 组只进顶部指数条，不进「海外」板块——`/api/briefing/overseas` 的 `count` 按海外组统计。其中 `hf_CHA50CFD`（富时中国 A50 期货）是「明日参考」最重要的领先输入——A 股收盘后仍在交易，是唯一还在给次日开盘定价的品种。

`data/macro.json` 顶层为 `{generatedAt, updatedAt, source, sourceLabel, count, items, series, note}`，`source` 固定为 `fred`。单条为 `{symbol, name, group, digits, unit, value, prevValue, change, changeBp, updatedAt}`：`us10y / us2y / us30y` 是美债收益率（`change` 单位为百分点，`changeBp` 为基点），`fedfunds` 是联邦基金有效利率，另有一条 `us10y2y` 是 10Y−2Y 期限利差（单位 `pp`）。数据取自 FRED 公开 CSV（`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10`，无需 API key），`series` 保留最近 30 个观测点用于画走势。注意：新浪与东财的行情接口都拿不到美债收益率（实测全部返回空），所以这条链路只能走 FRED；美债缺失时「明日参考」会把该因子标为缺失并相应缩小可用权重，而不是填 0。

`data/flow.json` 顶层为 `{generatedAt, date, sessions, windows, window, days, source, definition, coverage, market, history, industries, stocks}`，`source` 为 `eastmoney`，`definition` 写明「主力净额 = 超大单净额 + 大单净额（东方财富口径）」。

- `windows` = `[1, 5, 10, 20, 60, 120, 250]`，`window` = `{start, end}`，`days` = 实际取到的交易日数（默认 250，约一年）。
- `stocks` 每条为 `{code, name, exchange, board, industry, date, sessions, price, changePct, amount, mainNet, mainRatio, superNet, bigNet, midNet, smallNet}` 加上每个窗口的 `main1/main5/…/main250` 与 `amount1/…/amount250`（累计净额，单位元）。`mainNet` 即 `main1`（最新交易日）。
- `history` 是**市场层面**的逐日序列 `{date, mainNet, amount, inflows, outflows, count}`，整段窗口都保留，用于资金流 tab 顶部的走势柱。
- `industries` 用 `data/sectors.json` 的申万行业成员聚合出每个行业的净额，同样带全部窗口。
- 同一只股票若上市不足 250 个交易日，`sessions` 会小于 `days`，各窗口是该股实际存在的天数之和（不会补零）。

脚本要求覆盖率不低于 90%，否则拒绝写盘。窗口长度用 `npm run flow -- --days=<n>` 调整，上限 250（约一年）：60 个交易日约 12 s（冷启动 50 s）、约 2.6 MB；250 个交易日约 5.4 min、约 2.7 MB（约 140 万行、70 页，主要成本是下页传输）。

> 新浪与东方财富对同一只股票的主力净额可能给出相反的符号（实测新易盛：成交额与价格一致，净额一个 −19.25 亿、一个 +12.92 亿）。本项目统一采用东方财富口径，整个榜单不得混用两家数据。

所有金额统一为「元」、换手率统一为百分比、成交量统一为「手」，由各数据源的
normalize 函数换算，所以换数据源不会改变前端展示。

## 数据源与故障转移

同步脚本不绑定单一数据源，而是按顺序尝试一条提供者链：

| 顺序 | 来源 | 接口 | 股票池 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | 新浪财经 | `Market_Center.getHQNodeData`（节点 `hs_a`，每页 100 行） | 约 5573 | 主力来源。含沪深主板 / 创业板 / 科创板 / 北交所，可分页；两个镜像域名互为备份 |
| 2 | 腾讯财经 | `proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList`（`board_code=aStock`） | 约 4607 | 独立运营商，作为第二重备份。**不含科创板与北交所**，因此只有在新浪不可用时才会启用 |
| 3 | 东方财富 | `push2*/api/qt/clist/get` | 约 5923 | 最后兜底。包含已退市 / 停牌的空壳记录（价格字段全为 null 的行），所以数量比新浪多；三个镜像域名轮询 |

东方财富从主源降级为兜底源，是因为 `push2delay.eastmoney.com` / `push2.eastmoney.com` / `82.push2.eastmoney.com` 变得不可达：TCP 能连上，但服务端随即断开连接，间歇性失败会直接让每日任务连续多天失败。新浪返回的 5573 条与东财的 5923 条之差，主要就是这些已退市 / 停牌的空壳记录。

行为约定：

- 任一来源在连续 15 页失败后会判定为「整体不可用」，立刻换下一个来源，不会空跑。
- 每个来源内部先做重试（4 次指数退避），新浪/东财还会先切换镜像域名。
- 一个来源失败不影响其他来源；全部来源都失败时脚本抛错并且**不覆盖**已有数据文件。
- 最终结果必须同时满足「不少于 4000 只」与「不低于该来源自报总数的 98%」，否则视为响应残缺，同样不写盘。
- 实际生效的来源记录在 `data/meta.json` 的 `source` / `sourceLabel` / `sourceUrl` 字段里，前端抬头会显示。

### 日线历史

`scripts/sync-history.js` 拉取个股日线，来源顺序与行情链一致：

| 顺序 | 来源 | 接口 | 说明 |
| --- | --- | --- | --- |
| 1 | 新浪财经 | `quotes_service/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=<sh\|sz\|bj><code>&scale=240&ma=no&datalen=N` | 主力来源。返回裸数组，volume 单位是股、价格原样，解码后换算为「手」。`datalen` 上限 1023 |
| 2 | 腾讯财经 | `proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=<sym>,day,,,<n>,qfq` | 兜底来源。volume 单位已经是「手」，行内列顺序是 `date / open / CLOSE / high / low / volume`（收盘价在第三列，不是第四列）；请求的 `n` 会被服务端静默截断。腾讯没有北交所历史数据，因此 `bj*` 代码只能依赖新浪 |

日线在磁盘上缓存于 `.cache/history/`（git 忽略，默认 6 小时 TTL，可用 `HISTORY_CACHE_DIR` 覆盖目录、默认取 250 天），**故意不提交**到仓库，所以 clone 后第一次请求 `/api/stocks/:code/history` 会现拉一次。

## 每日更新

仓库内置 GitHub Actions 定时任务：

```text
.github/workflows/update-data.yml
.github/workflows/refresh-globals.yml
```

```yaml
# update-data.yml
schedule:
  - cron: "30 7 * * 1-5"   # 07:30 UTC = 15:30 Asia/Shanghai

# refresh-globals.yml
schedule:
  - cron: "30 21 * * 0-4"  # 21:30 UTC = 05:30 Asia/Shanghai next morning
```

`update-data.yml` 在交易日北京时间 **15:30**（收盘后）依次执行：

```text
npm run update      # 同步行情并校验
npm run sectors     # continue-on-error: true
npm run history     # continue-on-error: true
npm run news        # continue-on-error: true，同时写 data/indices.json
npm run macro       # continue-on-error: true，写 data/macro.json（FRED 美债）
npm run flow        # continue-on-error: true
npm run check:api   # 接口冒烟测试
```

五个增量数据来源都是第三方服务，单个源抽风不应该让当天数据提交失败，所以 `sectors` / `history` / `news` / `macro` / `flow` 都标了 `continue-on-error: true`。任务 `timeout-minutes` 为 40。最后如果 `data/all-a-shares.json data/meta.json data/sectors.json data/indicators.json data/events.json data/indices.json data/macro.json data/flow.json` 有变化，就用 `github-actions[bot]` 身份提交一次 `Update A-share market data`。

`refresh-globals.yml` 是专为「明日参考」补的一趟：北京时间 **05:30**（美股收盘后、A 股集合竞价前约四小时）只跑 `npm run news` 与 `npm run macro`，刷新 `data/events.json`（隔夜新闻）、`data/indices.json`（美股 / 欧洲 / 亚洲收盘与 A50 期货）和 `data/macro.json`（美债收益率），**不动 A 股行情快照**——05:30 跑 `npm run update` 会把上一交易日收盘写成盘前空值。

这一趟不是可有可无的：15:30 的定时任务看到的其实是**上一个**交易日的美股收盘，因为北京 15:30 时美股当天还没开盘。要让「明日参考」在开盘前真的可读，只能靠隔夜刷新。

也可以在 GitHub 页面手动触发：

```text
Actions -> Update A-share data -> Run workflow
Actions -> Refresh overnight backdrop -> Run workflow
```

如果自动提交失败，需要在仓库设置里确认 GitHub Actions 有写入权限：

```text
Settings -> Actions -> General -> Workflow permissions -> Read and write permissions
```

本地运行时，应用读取的是当前目录里的数据文件。想刷新本地数据，就执行 `npm run update`（或 `npm run enrich`），完成后刷新浏览器。

## 数据检查

```bash
npm run check
npm run check:api
```

`scripts/check-data.js` 校验 `data/all-a-shares.json`（缺失时退回 `data/sample-a-shares.json`），检查代码是否重复并输出统计：

```text
Data file: data/all-a-shares.json
Stocks: 5573
Exchanges: {"BJ":...,"SH":...,"SZ":...}
Updated at: 2026-10-14T07:36:19.254Z
```

`scripts/check-api.js` 会在 `127.0.0.1:${CHECK_API_PORT:-5179}` 上临时拉起 `server.js`，逐个接口断言状态码与响应结构（分页默认值与上限、拼音四种写法等价、排序枚举、404 / 502 分支、静态资源与路径穿越防护），全部通过输出 `All API checks passed.`，否则以退出码 1 打印 `N API check(s) failed.`。

## 测试

```bash
npm run test
```

等价于 `node --test tests/`，不依赖任何第三方测试框架。当前 7 个文件共 94 个用例，全部通过：

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/lib.test.js` | 交易所 / 板块推断、各板块涨跌停规则、ST 识别、涨跌停价取整与临界判定、SMA/EMA/布林/RSI/MACD/KDJ/ATR、百分位排名与因子表、回测端到端（T+1、整手、涨停不买）与样本内外拆分 |
| `tests/events.test.js` | 政策与主题关键词识别、利好利空分类与量级、指标抽取、18 小时半衰期衰减、事件向直接提及个股与主题成员扩散 |
| `tests/news-region.test.js` | 中国 / 海外区域判定优先级（显式 region、公告带 A股代码、地理词与强信号词）、`tagRegions` / `splitByRegion` / `regionCounts` 一致性、全球指数符号前缀、新浪五种行情族布局解析、未知符号与空载荷降级、公告解析器写入 `kind: "announcement"` |
| `tests/outlook.test.js` | 驱动权重合计 100、缺因子时按可用权重缩放而不塌缩到 0、**传导方向必须读原始变动而不是市场影响符号**（美债/美元/人民币走弱对成长股是利多，这正是最容易写反的一处）、同一驱动只出现一次、利好利空互斥、中位涨跌幅回退到全市场而不是最大涨跌榜、净流出文案不带双重否定、板块归因（代码优先于主题、无归属标题丢弃、同题去重）、主题映射必须是 31 个申万一级之一且不含「券商概念」 |
| `tests/search.test.js` | 查询归一化、多音字、按字符兜底、代码 / 名称 / 全拼 / 首字母命中与排序权重、空查询语义、随仓库发布的拼音索引覆盖率 |
| `tests/history.test.js` | 交易所前缀、URL 深度钳制、新浪与腾讯两种载荷解码（含列顺序）、异常载荷降级、去重排序、提供者回退与错误聚合、磁盘缓存 TTL 与窗口深度 |
| `tests/sectors.test.js` | 节点树扁平化、按前缀筛选去重、成员数组解析、分页页数计算、成员数解析、板块索引合并去重与落盘字段形状 |

## API

```text
GET /api/health
GET /api/overview
GET /api/forecast
GET /api/signals?limit=60
GET /api/stocks?q=&exchange=&board=&signal=&sort=score&limit=100&offset=0
GET /api/stocks/600519
GET /api/stocks/600519/history?days=250
GET /api/stocks/600519/analysis
GET /api/search?q=gzmt&limit=10
GET /api/sectors
GET /api/events?limit=30
GET /api/briefing
GET /api/indices
GET /api/news?limit=400&q=
GET /api/sector-news?limit=12&samples=3
GET /api/macro
GET /api/outlook
GET /api/flow?scope=stock&side=inflow&w=60&limit=60&q=茅台
GET /api/backtest?topN=10&holdDays=10&days=250
GET /api/watchlist?codes=600519,000001
```

查询参数与上限：

| 接口 | 参数 | 默认 | 上限 |
| --- | --- | --- | --- |
| `/api/search` | `q`、`limit` | `limit=10` | 50；`q` 为空时直接返回 `{query:"",items:[],count:0,limit}` |
| `/api/signals` | `limit` | 60 | 200 |
| `/api/stocks` | `limit`、`offset`、`q`、`exchange`、`board`、`signal`、`sort` | `limit=100`、`offset=0`、`sort=score` | `limit` 500；`sort` 不在枚举内时回退 `score` |
| `/api/stocks/:code/history` | `days` | 250 | 1023；历史不可用时返回 502 `{"error":"history unavailable"}` |
| `/api/stocks/:code/analysis` | 无 | 固定取 250 天 | 历史失败时 `history` 字段变成 `{error}`，接口仍返回 200 |
| `/api/events` | `limit` | 30 | 200 |
| `/api/indices` | 无 | 返回 `data/indices.json` 的全部标的（海外 36 + A股指数 8） | — |
| `/api/news` | `limit`、`q` | `limit=400` | `limit` 1000；`q` 匹配标题 / 摘要 / 来源 / 主题 / 代码，`counts` 与 `total` 都是筛选后的口径 |
| `/api/sector-news` | `limit`、`samples` | `limit=12`、`samples=3` | `limit` 40、`samples` 8；按方向净值绝对值倒序 |
| `/api/macro` | 无 | 返回 `data/macro.json` 的全部序列 | — |
| `/api/outlook` | 无 | 聚合 flow + indices + macro + 板块消息面 | — |
| `/api/flow` | `scope`、`side`、`w`、`limit`、`q` | `scope=stock`、`side=inflow`、`w=1`、`limit=60` | `limit` 500；`scope` 取 `stock` / `industry`，`side` 取 `inflow` / `outflow`，`w` 取 `windows` 里的值（不支持时回退 `1`），`q` 按名称 / 代码 / 行业 / 概念做子串匹配（不区分大小写，无命中返回空榜），非法值回退默认 |
| `/api/watchlist` | `codes` | 空 | 最多 60 个 6 位代码，非 6 位直接丢弃；未知代码返回 `{code, missing:true, alerts:[]}` |
| `/api/backtest` | 见下方「策略回测」 | — | 参数越界会被钳制到区间内，无历史时返回 422 |

`GET /api/stocks/:code` 会返回个股详情和 `outlook` 字段。`outlook` 包含明日走势、观察分、置信度、驱动因子、交易计划、偏多/中性/偏空情景和风险提示；同时附带 `node`（`limitPct` / `limitLabel` / `st` / `anomalyScore` / `trendScore`）和该股的相关事件。

排序参数：

```text
score      异动优先
change     涨幅优先
decline    跌幅优先
amount     成交额优先
turnover   换手率优先
cap        市值优先
code       代码排序
```

`exchange` 取 `ALL` / `SH` / `SZ` / `BJ`，`board` 取 `ALL` 或板块中文名，`signal` 取 `ALL` 或信号标签（涨停 / 跌停 / 涨停附近 / 跌停附近 / 强势拉升 / 快速回撤 / 换手放大 / 成交活跃 / 异动关注）。

## 异动评分

异动分用于把全市场股票按关注度排序。有指标快照时直接使用 `data/indicators.json` 计算出的截面分；缺失时退回可解释的规则评分：

```text
score =
  min(100, max(0, (
      abs(changePct) * 2.2
    + turnover * 0.9
    + log10(amount) * 0.7
    - marketCapPenalty
  ) * 3.2))
```

其中 `marketCapPenalty = min(log10(marketCap) / 20, 1)`，市值缺失时取 `0.3`。该评分综合考虑价格波动、筹码交换、成交活跃度和市值影响，只用于信息排序，不代表收益预测。

## 板块与涨跌停

`lib/boards.js` 集中编码各板块的价格限制，信号判断按该股所在板块的「尺子」来算，不会用 10% 去衡量创业板：

| 板块 | 涨跌幅限制 |
| --- | --- |
| 沪市主板 / 深市主板 | ±10% |
| 创业板 / 科创板 | ±20% |
| 北交所 | ±30% |
| 主板 ST | ±5%（创业板 / 科创板 ST 仍为 ±20%） |

新股按板块分别处理（主板上市首日 44%、创业板 / 科创板 / 北交所前 5 个交易日不设限），涨跌停价按最新价与昨收价推导并四舍五入到分，判定时留有 0.005 的容差。

## 事件分类与扩散

`lib/events.js` 在读取时对事件做规则分类，不调用任何模型：

- 分类：`CATEGORY_RULES` 决定事件类别，`POLICY_KEYWORDS` 识别政策类表述，正负面关键词表给出 sentiment 与 magnitude。
- 主题：`THEME_KEYWORDS` 目前覆盖 35 个主题（半导体、人工智能、机器人、新能源车、光伏、军工、医药生物……），按命中次数排序。
- 衰减：`timeDecay(publishedAt, now, halfLifeHours = 18)` 按 18 小时半衰期对事件强度做指数衰减，旧消息会自动变弱。
- 扩散：`buildEventImpacts(events, stocks, { now, themeIndex, halfLifeHours })` 把命中的主题扩散到该主题的成员股，直接点名个股权重 3，主题扩散权重 0.45。

## 策略回测

`/api/backtest` 由 `lib/backtest.js` 驱动：

```text
GET /api/backtest?codes=600519,000001&topN=10&minScore=5&holdDays=10
                 &stopLossPct=0.08&takeProfitPct=0.2&rebalanceDays=1
                 &days=250&startDate=&endDate=
```

| 参数 | 默认 | 区间 |
| --- | --- | --- |
| `codes` | 空（取全市场成交额靠前的股票） | 最多 60 个 6 位代码 |
| `topN` | 10 | 1 ~ 50 |
| `minScore` | 5 | -100 ~ 100 |
| `holdDays` | 10 | 1 ~ 120 |
| `stopLossPct` | 0.08 | 0.005 ~ 0.5 |
| `takeProfitPct` | 0.2 | 0.01 ~ 3 |
| `rebalanceDays` | 1 | 1 ~ 30 |
| `days` | 250 | 120 ~ 1023 |

撮合规则：

- 用第 t 日收盘生成信号，第 t+1 日**开盘**成交，不存在未来函数。
- 遵守 T+1，当日买入不能当日卖出。
- 开盘涨停不允许买入、开盘跌停不允许卖出。
- 按 100 股整手交易，支持止损 / 止盈 / 持有期到期 / 定期换仓。
- 成本模型：佣金 0.025%（最低 5 元）、卖出印花税 0.05%、过户费 0.001%、滑点 0.1%。

`summarize()` 输出总收益、年化收益、最大回撤、波动率、Sharpe、Sortino、交易笔数、胜率、盈亏比、平均持有交易日、等权基准收益和超额收益；响应里还会带上 `walkForwardValidation(config, 0.7)` 拆出的样本内 / 样本外两段指标、净值曲线和最近 50 笔成交。

## 方向观察

`/api/forecast` 会基于当日市场截面生成明日方向观察，包括方向标签、情绪分、置信度、驱动因子和风险提示。该模块只使用公开行情中的统计特征，不包含隔夜消息、政策、公告、外盘等变量，因此结果仅用于研究和观察。

个股详情中的 `outlook` 使用同一套公开行情快照，并额外结合个股涨跌幅、相对板块表现、成交额、换手率和大盘背景生成条件化交易计划。价格区间按最新价比例估算，不代表技术支撑/压力，也不构成买卖建议。

## 明日参考

`/api/outlook` 是唯一会给出「判断」的板块，所以它的每一点分数都必须可追溯：

- **十个驱动因子，权重合计 100**：A50 期货 20、美股三大指数 14、费城半导体 6、美元指数 6、离岸人民币 6、美债 10 年期 8、当日涨跌家数 14、涨停/跌停 8、主力净额占成交额 10、个股中位涨跌幅 8。
- 每个因子把原始变动归一化到 `-1..1` 再乘以权重；**可用权重之和就是分母**，所以缺一个输入只是把该因子移出分母并报缺（`missing`），不会把分数往 0 拽，也不会拿中性值冒充数据。
- 分数是「证据一致性」而不是上涨概率：`score = Σ(归一化 × 权重) / Σ可用权重 × 100`，截到 `±100`；`confidence` 由分数绝对值与方向一致性共同决定。
- 传导表刻意和分数分开：**分数读的是「对 A 股的影响符号」，传导读的是「原始变动方向」**——美元走弱、人民币走强、美债收益率下行对成长股都是利多，但它们的原始方向是「下行」，两者混用会把利多写成利空。这一点有单测守着。
- 输出的 `logic`（前 5 强因子的数据链）、`bullish` / `bearish`（宏观传导 + 行业资金流两端 + 板块消息面 + 相对强弱离群）、`risks`（条件式风险，只在触发时才出现）、`watch`（次日 09:25 集合竞价对比 A50 等）全部由数字生成，不是先写结论再找理由。

## 工作台布局

页面分三栏：最左是竖直 tab 栏，中间是随 tab 切换的主舞台，右侧常驻个股详情与异动信号。三栏之上是 A 股指数条，之下是概览条（股票池 / 涨跌家数 / 涨跌停 / 成交额 / 沪深北只数 / 可交易只数）；概览里的「沪深北」是三个交易所的**股票只数**，不是指数点位，点位看最上方的指数条。

```text
主力资金   全市场主力净额汇总 + 搜索框（代码 / 名称 / 拼音 / 行业）+ 个股 / 行业榜单（净流入 / 净流出）+ 市场结构 + 行业相对强弱
股票       TradingView 式看盘台：占满主舞台的 K 线（滚轮缩放 / 拖动平移 / 十字光标 OHLC）+ 搜索筛选排序分页
新闻政策   中国 · A股简报 | 海外 · 全球市场简报（36 个标的）+ 板块消息面 + 主题雷达 + 新闻政策双栏与关键词搜索
我的自选   自选监控与告警 + 策略回测与表现追踪
明日参考   次日倾向评分 + 判断逻辑链 + 宏观传导表 + 利好 / 利空清单 + 风险点 + 明日盯什么 + 输入快照
```

当前 tab 存在 `localStorage` 的 `stockradar-tab`，刷新后保持；图表类型存在 `stockradar-chart-type`，资金流的范围、方向和净额窗口分别存在 `stockradar-flow-scope` / `stockradar-flow-side` / `stockradar-flow-window`。

新闻政策栏的两列内容来自同一份事件池，按 `lib/news-region.js` 的区域判定拆分。公告披露会成串到达（实测某公司一分钟内提交 11 份文件），因此每列做了两道限制：同一发行人最多 2 条，公告类不超过整栏的三分之一，并把「报道」与「公告」两股流按 2:1 交错排列，避免收盘公告把当天报道整段压到底部。

## 项目结构

```text
.
├── .github/
│   └── workflows/
│       └── update-data.yml
├── data/
│   ├── all-a-shares.json
│   ├── events.json
│   ├── flow.json
│   ├── indices.json
│   ├── indicators.json
│   ├── macro.json
│   ├── meta.json
│   ├── sample-a-shares.json
│   └── sectors.json
├── docs/
│   └── architecture.md
├── lib/
│   ├── backtest.js
│   ├── boards.js
│   ├── events.js
│   ├── factors.js
│   ├── history-cache.js
│   ├── history.js
│   ├── indicators.js
│   ├── macro.js
│   ├── news-region.js
│   ├── outlook.js
│   ├── pinyin-index.json
│   ├── search.js
│   └── sector-news.js
├── public/
│   ├── app.js
│   ├── chart.js
│   ├── index.html
│   └── styles.css
├── scripts/
│   ├── build-pinyin-index.js
│   ├── check-api.js
│   ├── check-data.js
│   ├── sync-a-shares.js
│   ├── sync-flow.js
│   ├── sync-history.js
│   ├── sync-macro.js
│   ├── sync-news.js
│   └── sync-sectors.js
├── tests/
│   ├── events.test.js
│   ├── history.test.js
│   ├── lib.test.js
│   ├── news-region.test.js
│   ├── outlook.test.js
│   ├── search.test.js
│   └── sectors.test.js
├── server.js
├── package.json
└── README.md
```

## 拼音索引

检索用的 `lib/pinyin-index.json` 是**预生成**文件，随仓库提交（约 230 KB，含 `chars` 单字表和 `names` 名称表），因此运行时不依赖任何拼音库。索引需要重建时：

```bash
npm install --no-save pinyin-pro && npm run index:pinyin
```

`pinyin-pro` 只是开发期的生成器，**不是** `package.json` 的依赖，所以 `--no-save` 安装后仓库依然保持零运行时依赖。索引缺失时 `lib/search.js` 会退回按代码和名称匹配，拼音与首字母检索不可用。

## 部署说明

这是一个带后端 API 的 Node.js 应用，不是纯静态网页。前端会请求 `/api/overview`、`/api/forecast`、`/api/stocks` 等接口，所以不能只把 `public/` 目录放到 GitHub Pages 上运行。

部署时需要选择能运行 Node.js 服务的平台，例如云服务器、Render、Railway、Fly.io 或容器环境。启动命令保持一致：

```bash
npm start
```

记得把 `HOST` 设为 `0.0.0.0`，否则容器外的健康检查连不上。日线磁盘缓存位于 `.cache/history/`，容器重建会丢失，属于预期行为。

## 路线图

- 使用 PostgreSQL 存储多日市场数据
- 增加 Redis 缓存热门榜单和搜索结果
- 接入龙虎榜、资金流向等更多事件源
- 支持自选股异动推送
- 增加用户系统和云端自选股同步
- 增加指数维度分析

## 说明

行情数据来自公开网络接口，可能存在延迟、缺失或口径差异。生产环境使用前需要确认数据授权、缓存策略、访问频率限制和合规要求。

## License

MIT
