# StockRadar A股事件雷达

一个适合面试展示的 A股数据应用：自动同步全量 A股股票池，识别涨跌幅、成交额、换手率等异动信号，并提供搜索、自选监控、市场结构、事件画像和可视化工作台。

> 这是工程演示项目，只做公开行情聚合和异动识别，不构成投资建议。

## 功能

- 全量 A股股票池：通过同步脚本拉取沪深北 5000+ 股票
- 市场概览：上涨、下跌、涨停附近、跌停附近、成交额、交易所分布
- 股票搜索：支持代码、名称、交易所、板块搜索
- 异动排序：按异动分、涨幅、跌幅、成交额、换手率、市值排序
- 事件信号：涨停附近、跌停附近、强势拉升、快速回撤、换手放大、成交活跃
- 自选监控：浏览器本地保存关注股票
- 个股画像：现价、涨跌幅、成交额、市值、异动原因和模拟走势图
- 零依赖运行：Node.js 原生 HTTP 服务，无需安装第三方包

## 技术栈

- Frontend: HTML + CSS + JavaScript
- Backend: Node.js HTTP Server
- Data: JSON 文件存储
- Source: 东方财富公开延迟行情接口
- Runtime: Node.js 18+

## 快速开始

```bash
git clone <your-repo-url>
cd stock-radar-a-share
npm run sync
npm start
```

打开：

```text
http://localhost:5173
```

如果只是先看界面，可以不运行同步脚本，项目会自动使用 `data/sample-a-shares.json` 样例数据。

## 同步全量 A股

```bash
npm run sync
```

同步成功后会生成：

```text
data/all-a-shares.json
data/meta.json
```

`data/all-a-shares.json` 包含股票代码、名称、交易所、板块、现价、涨跌幅、成交额、换手率、总市值等字段。当前同步脚本会校验返回数量，如果少于 4000 只会中止，避免误把异常响应写入数据文件。

## 数据检查

```bash
npm run check
```

输出示例：

```text
Data file: data/all-a-shares.json
Stocks: 5000+
Exchanges: {"BJ":200+,"SH":2000+,"SZ":2800+}
Updated at: 2026-07-22T...
```

## API

```text
GET /api/health
GET /api/overview
GET /api/signals?limit=80
GET /api/stocks?q=茅台&exchange=SH&board=沪市主板&sort=score&limit=100&offset=0
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

## 项目结构

```text
.
├── data/
│   ├── sample-a-shares.json
│   ├── all-a-shares.json
│   └── meta.json
├── docs/
│   └── interview.md
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── scripts/
│   ├── check-data.js
│   └── sync-a-shares.js
├── server.js
├── package.json
└── README.md
```

## 面试讲法

可以这样概括：

> 我做了一个 A股事件雷达系统，重点不是预测股价，而是把全市场 5000+ 股票接入一个统一的异动识别平台。系统会同步公开行情数据，基于涨跌幅、成交额、换手率和市值生成异动分，再把个股组织成可搜索、可筛选、可监控的工作台。这个项目展示了数据采集、后端 API 设计、指标计算、前端数据可视化和产品化落地能力。

更多面试准备见 [docs/interview.md](docs/interview.md)。

## 后续可扩展

- PostgreSQL 存储历史快照
- Redis 缓存热门查询
- 定时任务每日收盘后同步
- 接入公告、研报、新闻做事件归因
- 用向量检索聚合同类新闻
- WebSocket 推送自选股异动
- 用户登录和多端自选股同步

## License

MIT
