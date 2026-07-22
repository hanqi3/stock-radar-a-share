# Architecture

StockRadar 使用轻量化架构组织行情同步、指标计算和前端页面。当前版本优先保证本地运行简单，后续可以平滑迁移到数据库、缓存和定时任务体系。

## Data Flow

```text
东方财富公开延迟行情接口
  -> scripts/sync-a-shares.js
  -> data/all-a-shares.json
  -> server.js
  -> public/app.js
```

## Modules

### Data Sync

`scripts/sync-a-shares.js` 分页拉取沪深北 A股列表，并将原始字段标准化为项目内部使用的数据结构。

### API Server

`server.js` 基于 Node.js 原生 HTTP 模块实现接口和静态资源服务。服务启动后会读取全量股票池，并在内存中缓存短时间数据，减少重复文件读取。

### Dashboard

`public/app.js` 负责调用 API、维护页面状态、处理筛选排序、自选股和个股详情渲染。

### Theme

前端使用 CSS variables 实现亮色和暗色主题，主题偏好保存在浏览器 `localStorage`。

## Signal Scoring

异动分综合使用涨跌幅、换手率、成交额和市值影响。该分数用于排序和筛选，不用于预测未来价格。

## Direction Forecast

方向观察模块使用当日市场宽度、涨跌停强度、平均涨跌幅、强势/弱势个股数量和成交活跃度生成可解释方向标签。该模块不输出买卖建议，也不把结果视作价格预测。

## Stock Outlook

个股详情接口会为每只股票生成 `outlook`。该字段基于个股涨跌幅、相对板块表现、换手率、成交额和大盘方向观察生成明日走势、观察分、交易计划、失效条件和情景推演。当前版本不包含历史 K 线、公告、财报和新闻，因此置信度默认保持克制。

## Production Upgrade

后续可以将 JSON 文件替换为 PostgreSQL，将高频读取结果放入 Redis，并使用定时任务在交易日同步行情快照。公告、新闻和龙虎榜等事件源可以作为独立数据管道接入，再与股票代码做实体关联。
