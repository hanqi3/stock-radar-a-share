# StockRadar A股事件雷达

StockRadar 是一个面向 A股市场的行情雷达应用。项目会同步沪深北全量股票池，基于涨跌幅、成交额、换手率和市值等公开行情字段生成异动信号，并提供市场概览、股票检索、自选监控和个股画像。

> 本项目仅用于公开行情信息整理与研究，不构成任何投资建议。

## 功能特性

- 全量股票池：同步沪深北 A股，当前数据文件包含 5000+ 只股票
- 市场概览：统计上涨、下跌、平盘、涨停附近、跌停附近、成交额和交易所分布
- 股票检索：支持按代码、名称、交易所、板块快速筛选
- 异动信号：识别强势拉升、快速回撤、换手放大、成交活跃等状态
- 明日方向观察：基于市场宽度、涨跌停强度、平均涨跌幅和成交活跃度给出可解释方向判断
- 个股交易计划：点击任意股票后生成明日走势、观察区间、失效条件、风控重点和情景推演
- 明暗主题：支持亮色和暗色模式，并在浏览器本地保存偏好
- 多维排序：支持按异动分、涨幅、跌幅、成交额、换手率、市值和代码排序
- 自选监控：在浏览器本地保存关注股票
- 个股画像：呈现现价、涨跌幅、成交额、市值、异动原因和走势概览
- 零依赖运行：使用 Node.js 原生 HTTP 服务，无需安装第三方依赖

## 技术栈

- Frontend: HTML, CSS, JavaScript
- Backend: Node.js HTTP Server
- Storage: JSON file
- Data Source: 东方财富公开延迟行情接口
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

默认只监听本机 `localhost`。如果部署在云服务器或容器里，可以指定监听地址：

```bash
HOST=0.0.0.0 PORT=5173 npm start
```

如果看到 `StockRadar is running at http://localhost:5173`，说明服务已经启动成功。

## 数据同步

同步脚本位于：

```text
scripts/sync-a-shares.js
```

仓库已包含一份全量股票池数据，可以直接打开应用查看。如果需要更新到最新行情，运行：

```bash
npm run update
```

该命令会先同步行情，再检查数据文件。运行后会生成或更新：

```text
data/all-a-shares.json
data/meta.json
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

同步脚本会校验返回数量。如果股票数量少于 4000 只，脚本会中止，避免把异常响应写入数据文件。

## 每日更新

仓库内置 GitHub Actions 定时任务：

```text
.github/workflows/update-data.yml
```

该任务会在交易日北京时间 16:30 运行 `npm run update`，如果 `data/all-a-shares.json` 或 `data/meta.json` 有变化，就自动提交一次数据更新。

也可以在 GitHub 页面手动触发：

```text
Actions -> Update A-share data -> Run workflow
```

如果自动提交失败，需要在仓库设置里确认 GitHub Actions 有写入权限：

```text
Settings -> Actions -> General -> Workflow permissions -> Read and write permissions
```

本地运行时，应用读取的是当前目录里的 `data/all-a-shares.json`。想刷新本地数据，就执行 `npm run update`，完成后刷新浏览器。

## 数据检查

```bash
npm run check
```

输出示例：

```text
Data file: data/all-a-shares.json
Stocks: 5880
Exchanges: {"BJ":340,"SH":2458,"SZ":3082}
Updated at: 2026-07-22T12:08:34.539Z
```

## API

```text
GET /api/health
GET /api/overview
GET /api/forecast
GET /api/signals?limit=80
GET /api/stocks?q=600519&exchange=SH&sort=score&limit=100&offset=0
GET /api/stocks/600519
```

`GET /api/stocks/:code` 会返回个股详情和 `outlook` 字段。`outlook` 包含明日走势、观察分、置信度、驱动因子、交易计划、偏多/中性/偏空情景和风险提示。

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

## 异动评分

异动分用于把全市场股票按关注度排序。当前版本采用可解释的规则评分：

```text
score =
  abs(changePct) * 2.2
  + turnover * 0.9
  + log10(amount) * 0.7
  - marketCapPenalty
```

该评分综合考虑价格波动、筹码交换、成交活跃度和市值影响。它只用于信息排序，不代表收益预测。

## 方向观察

`/api/forecast` 会基于当日市场截面生成明日方向观察，包括方向标签、情绪分、置信度、驱动因子和风险提示。该模块只使用公开行情中的统计特征，不包含隔夜消息、政策、公告、外盘等变量，因此结果仅用于研究和观察。

个股详情中的 `outlook` 使用同一套公开行情快照，并额外结合个股涨跌幅、相对板块表现、成交额、换手率和大盘背景生成条件化交易计划。价格区间按最新价比例估算，不代表技术支撑/压力，也不构成买卖建议。

## 项目结构

```text
.
├── .github/
│   └── workflows/
│       └── update-data.yml
├── data/
│   ├── all-a-shares.json
│   ├── meta.json
│   └── sample-a-shares.json
├── docs/
│   └── architecture.md
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── scripts/
│   ├── check-data.js
│   └── sync-a-shares.js
├── server.js
├── package.json
└── README.md
```

## 部署说明

这是一个带后端 API 的 Node.js 应用，不是纯静态网页。前端会请求 `/api/overview`、`/api/forecast`、`/api/stocks` 等接口，所以不能只把 `public/` 目录放到 GitHub Pages 上运行。

部署时需要选择能运行 Node.js 服务的平台，例如云服务器、Render、Railway、Fly.io 或容器环境。启动命令保持一致：

```bash
npm start
```

## 路线图

- 接入历史行情快照
- 使用 PostgreSQL 存储多日市场数据
- 增加 Redis 缓存热门榜单和搜索结果
- 接入公告、新闻、龙虎榜等事件数据
- 支持自选股异动推送
- 增加用户系统和云端自选股同步
- 增加板块、概念和指数维度分析

## 说明

行情数据来自公开网络接口，可能存在延迟、缺失或口径差异。生产环境使用前需要确认数据授权、缓存策略、访问频率限制和合规要求。

## License

MIT
