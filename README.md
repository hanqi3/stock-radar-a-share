# StockRadar A股事件雷达

StockRadar 是一个面向 A股市场的行情雷达应用。项目会同步沪深北全量股票池，基于涨跌幅、成交额、换手率和市值等公开行情字段生成异动信号，并提供市场概览、股票检索、自选监控和个股画像。

> 本项目仅用于公开行情信息整理与研究，不构成任何投资建议。

## 功能特性

- 全量股票池：同步沪深北 A股，当前数据文件包含 5000+ 只股票
- 市场概览：统计上涨、下跌、平盘、涨停附近、跌停附近、成交额和交易所分布
- 股票检索：支持按代码、名称、交易所、板块快速筛选
- 异动信号：识别强势拉升、快速回撤、换手放大、成交活跃等状态
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

## 快速开始

```bash
git clone <your-repo-url>
cd stock-radar-a-share
npm start
```

访问：

```text
http://localhost:5173
```

仓库已包含一份全量股票池数据。如果需要更新到最新行情，运行：

```bash
npm run sync
```

## 数据同步

同步脚本位于：

```text
scripts/sync-a-shares.js
```

运行后会生成或更新：

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

## 数据检查

```bash
npm run check
```

输出示例：

```text
Data file: data/all-a-shares.json
Stocks: 5880
Exchanges: {"BJ":340,"SZ":3082,"SH":2458}
Updated at: 2026-07-22T10:51:37.974Z
```

## API

```text
GET /api/health
GET /api/overview
GET /api/signals?limit=80
GET /api/stocks?q=600519&exchange=SH&sort=score&limit=100&offset=0
GET /api/stocks/600519
```

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

## 项目结构

```text
.
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
