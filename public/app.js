import { drawPriceChart } from "./chart.js";

const state = {
  query: "",
  exchange: "ALL",
  board: "ALL",
  sort: "score",
  offset: 0,
  limit: 100,
  total: 0,
  rows: [],
  selectedCode: null,
  activeSuggestion: -1,
  suggestions: [],
  suggestionToken: 0,
  theme: localStorage.getItem("stockradar-theme") || "light",
  watchlist: new Set(JSON.parse(localStorage.getItem("stockradar-watchlist") || "[]")),
  watchItems: [],
  chart: {
    code: null,
    range: Number(localStorage.getItem("stockradar-chart-range") || 120),
    overlays: new Set(
      (localStorage.getItem("stockradar-chart-overlays") || "ma5,ma10,ma15,ma20,boll,volume").split(",")
    ),
    payload: null,
    token: 0,
    hover: null
  }
};

const els = {
  overview: document.querySelector("#overview"),
  boardList: document.querySelector("#boardList"),
  watchlist: document.querySelector("#watchlist"),
  stockRows: document.querySelector("#stockRows"),
  resultCount: document.querySelector("#resultCount"),
  loadMoreButton: document.querySelector("#loadMoreButton"),
  searchInput: document.querySelector("#searchInput"),
  searchWrap: document.querySelector("#searchWrap"),
  searchSuggestions: document.querySelector("#searchSuggestions"),
  sortSelect: document.querySelector("#sortSelect"),
  exchangeSegment: document.querySelector("#exchangeSegment"),
  signalList: document.querySelector("#signalList"),
  detailPanel: document.querySelector("#detailPanel"),
  forecastPanel: document.querySelector("#forecastPanel"),
  dataStatus: document.querySelector("#dataStatus"),
  refreshButton: document.querySelector("#refreshButton"),
  themeToggle: document.querySelector("#themeToggle"),
  chartStage: document.querySelector("#chartStage"),
  chartName: document.querySelector("#chartName"),
  chartMeta: document.querySelector("#chartMeta"),
  chartLast: document.querySelector("#chartLast"),
  chartChange: document.querySelector("#chartChange"),
  priceChart: document.querySelector("#priceChart"),
  chartEmpty: document.querySelector("#chartEmpty"),
  planBlock: document.querySelector("#planBlock"),
  eventBlock: document.querySelector("#eventBlock"),
  rangeSegment: document.querySelector("#rangeSegment"),
  overlaySegment: document.querySelector("#overlaySegment"),
  chartClose: document.querySelector("#chartClose"),
  briefingTime: document.querySelector("#briefingTime"),
  briefingBody: document.querySelector("#briefingBody"),
  themeList: document.querySelector("#themeList"),
  industryList: document.querySelector("#industryList"),
  backtestRun: document.querySelector("#backtestRun"),
  backtestBody: document.querySelector("#backtestBody"),
  backtestStatus: document.querySelector("#backtestStatus")
};

const moneyFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2
});

function money(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "暂无";
  if (value >= 100_000_000_000) return `${moneyFormatter.format(value / 100_000_000_000)}千亿`;
  if (value >= 100_000_000) return `${moneyFormatter.format(value / 100_000_000)}亿`;
  if (value >= 10_000) return `${moneyFormatter.format(value / 10_000)}万`;
  return moneyFormatter.format(value);
}

function number(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "暂无";
  return Number(value).toFixed(digits);
}

function signed(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "暂无";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${Number(value).toFixed(2)}${suffix}`;
}

function toneClass(value) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("stockradar-theme", theme);
  els.themeToggle.textContent = theme === "dark" ? "☀" : "☾";
  els.themeToggle.title = theme === "dark" ? "切换亮色模式" : "切换暗色模式";
  els.themeToggle.setAttribute("aria-label", els.themeToggle.title);
}

function encode(params) {
  const query = new URLSearchParams(params);
  return query.toString();
}

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function saveWatchlist() {
  localStorage.setItem("stockradar-watchlist", JSON.stringify([...state.watchlist]));
}

function isWatched(code) {
  return state.watchlist.has(code);
}

function toggleWatch(code) {
  if (state.watchlist.has(code)) {
    state.watchlist.delete(code);
  } else {
    state.watchlist.add(code);
  }
  saveWatchlist();
  renderRows();
  refreshWatchlist();
}

function renderOverview(data) {
  const metrics = [
    ["股票池", data.total, `${data.meta.mode === "full" ? "全量" : "样例"} · ${data.meta.source || "local"}`],
    ["上涨", data.advancers, `下跌 ${data.decliners} · 平盘 ${data.flat}`],
    ["涨停附近", data.limitUp, `跌停附近 ${data.limitDown}`],
    ["成交额", money(data.totalAmount), "全市场合计"],
    ["沪深北", `${data.byExchange.SH || 0}/${data.byExchange.SZ || 0}/${data.byExchange.BJ || 0}`, "SH / SZ / BJ"],
    ["可交易", data.tradable, "有价格记录"]
  ];

  els.overview.innerHTML = metrics
    .map(
      ([label, value, foot]) => `
        <div class="metric">
          <div class="metric-label">${label}</div>
          <div class="metric-value">${value}</div>
          <div class="metric-foot">${foot}</div>
        </div>
      `
    )
    .join("");

  const time = data.meta.updatedAt ? new Date(data.meta.updatedAt).toLocaleString("zh-CN") : "未知时间";
  els.dataStatus.textContent = `${data.meta.mode === "full" ? "全量股票池" : "样例数据"} · ${data.total} 只 · 更新 ${time}`;

  els.boardList.innerHTML = data.hotBoards
    .map(
      (item) => `
        <div class="board-item" data-board="${item.board}">
          <div>
            <div class="board-name">${item.board}</div>
            <div class="board-count">${item.count} 只 · 成交额 ${money(item.amount)}</div>
          </div>
          <div class="${toneClass(item.avgChangePct)}">${signed(item.avgChangePct, "%")}</div>
        </div>
      `
    )
    .join("");

  els.boardList.querySelectorAll(".board-item").forEach((item) => {
    item.addEventListener("click", () => {
      state.board = item.dataset.board;
      reloadStocks();
    });
  });
}

function renderForecast(data) {
  els.forecastPanel.innerHTML = `
    <div class="forecast-head">
      <div>
        <div class="panel-kicker">${data.title}</div>
        <div class="forecast-direction ${forecastTone(data.score)}">${data.direction}</div>
      </div>
      <div class="forecast-score">
        <span>${number(data.score, 1)}</span>
        <small>情绪分</small>
      </div>
    </div>
    <div class="forecast-body">
      <div class="confidence-row">
        <span>置信度</span>
        <strong>${data.confidence}</strong>
      </div>
      <div class="narrative forecast-copy">${data.posture}</div>
      <div class="driver-list">
        ${data.drivers
          .map(
            (driver) => `
              <div class="driver-item">
                <div>
                  <div class="driver-label">${driver.label}</div>
                  <div class="driver-detail">${driver.detail}</div>
                </div>
                <div class="${driver.tone}">${driver.value}</div>
              </div>
            `
          )
          .join("")}
      </div>
      <div class="board-snapshot">
        <div>
          <div class="driver-label">相对强势</div>
          <div>${formatBoards(data.leadingBoards)}</div>
        </div>
        <div>
          <div class="driver-label">相对承压</div>
          <div>${formatBoards(data.laggingBoards)}</div>
        </div>
      </div>
      <div class="forecast-note">${data.risks[0]}</div>
    </div>
  `;
}

function forecastTone(score) {
  if (score >= 8) return "positive";
  if (score <= -8) return "negative";
  return "neutral";
}

function formatBoards(boards) {
  return boards
    .map((board) => `<span class="${toneClass(board.avgChangePct)}">${board.board} ${signed(board.avgChangePct, "%")}</span>`)
    .join(" · ");
}

function renderRows(append = false, rows = state.rows) {
  const html = rows
    .map(
      (stock) => `
        <tr class="${stock.code === state.selectedCode ? "selected" : ""}" data-code="${stock.code}">
          <td>
            <div class="stock-name">${stock.code}</div>
            <div class="stock-code">${stock.exchange}</div>
          </td>
          <td>${stock.name}</td>
          <td>${stock.board}</td>
          <td>${number(stock.price)}</td>
          <td class="${toneClass(stock.changePct)}">${signed(stock.changePct, "%")}</td>
          <td>${money(stock.amount)}</td>
          <td>${number(stock.turnover)}%</td>
          <td><span class="pill ${Math.abs(stock.changePct || 0) >= 6 ? "hot" : ""}">${signalType(stock)}</span></td>
          <td>
            <button class="row-button ${isWatched(stock.code) ? "active" : ""}" data-watch="${stock.code}" title="自选" aria-label="自选">★</button>
          </td>
        </tr>
      `
    )
    .join("");

  if (append) {
    els.stockRows.insertAdjacentHTML("beforeend", html);
  } else {
    els.stockRows.innerHTML = html;
  }

  els.stockRows.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("[data-watch]")) return;
      selectStock(row.dataset.code);
    });
  });

  els.stockRows.querySelectorAll("[data-watch]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleWatch(button.dataset.watch);
    });
  });

  els.resultCount.textContent = `显示 ${state.rows.length} / ${state.total}`;
  els.loadMoreButton.disabled = state.rows.length >= state.total;
}

function signalType(stock) {
  if ((stock.changePct || 0) >= 9.8) return "涨停附近";
  if ((stock.changePct || 0) <= -9.8) return "跌停附近";
  if ((stock.changePct || 0) >= 6) return "强势拉升";
  if ((stock.changePct || 0) <= -6) return "快速回撤";
  if ((stock.turnover || 0) >= 8) return "换手放大";
  if ((stock.amount || 0) >= 5_000_000_000) return "成交活跃";
  return "异动关注";
}

function renderSignals(data) {
  els.signalList.innerHTML = data.items
    .slice(0, 18)
    .map(
      (stock) => `
        <div class="signal-item" data-code="${stock.code}">
          <div class="signal-top">
            <div class="signal-title">${stock.name}</div>
            <div class="${toneClass(stock.changePct)}">${signed(stock.changePct, "%")}</div>
          </div>
          <div class="signal-meta">${stock.code} · ${stock.signalType} · ${stock.reason}</div>
        </div>
      `
    )
    .join("");

  els.signalList.querySelectorAll(".signal-item").forEach((item) => {
    item.addEventListener("click", () => selectStock(item.dataset.code));
  });
}

async function selectStock(code) {
  state.selectedCode = code;
  renderRows();
  loadChart(code);
  const stock = await api(`/api/stocks/${code}`);
  renderDetail(stock);
}

// --- TradingView-style chart stage ------------------------------------------

function chartRangeLabel(range) {
  const map = { 5: "5日", 10: "10日", 15: "15日", 30: "30日", 60: "60日", 120: "120日", 250: "250日" };
  return map[range] || `${range}日`;
}

function renderPlanBlock(analysis) {
  if (!els.planBlock) return;
  const plan = analysis?.history?.plan;
  if (!plan) {
    els.planBlock.innerHTML = `<div class="chart-empty-line">该股历史样本不足，暂不生成买卖点计划。</div>`;
    return;
  }
  const money2 = (value) => (Number.isFinite(value) ? value.toFixed(2) : "—");
  const zoneRows = (plan.buyZones || [])
    .map(
      (zone) => `
        <div class="plan-zone">
          <span class="plan-zone-price">${money2(zone.price)}</span>
          <span class="plan-zone-reason">${escapeHtml(zone.reason || "")}</span>
        </div>`
    )
    .join("");
  const notes = (plan.notes || []).map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  const maText =
    plan.ma && typeof plan.ma === "object"
      ? Object.entries(plan.ma)
          .filter(([, value]) => Number.isFinite(value))
          .map(([key, value]) => `MA${key} ${value.toFixed(2)}`)
          .join(" · ")
      : String(plan.ma || "");
  els.planBlock.innerHTML = `
    <div class="plan-head">
      <span class="plan-trend">${escapeHtml(plan.trend || "—")}</span>
      <span class="plan-ma">${escapeHtml(maText)}</span>
    </div>
    <div class="plan-grid">
      <div class="plan-cell"><span>支撑</span><strong>${money2(plan.support)}</strong></div>
      <div class="plan-cell"><span>压力</span><strong>${money2(plan.resistance)}</strong></div>
      <div class="plan-cell"><span>止损</span><strong class="down">${money2(plan.stopLoss)}</strong></div>
      <div class="plan-cell"><span>目标</span><strong class="up">${money2(plan.target)}</strong></div>
      <div class="plan-cell"><span>距MA20</span><strong>${signed(plan.distanceFromMa20Pct, "%")}</strong></div>
      <div class="plan-cell"><span>布林带</span><strong>${money2(plan.bollLower)} ~ ${money2(plan.bollUpper)}</strong></div>
    </div>
    <div class="plan-zones">
      <div class="plan-zones-title">买入点参考</div>
      ${zoneRows || `<div class="chart-empty-line">暂无买点</div>`}
    </div>
    ${notes ? `<ul class="plan-notes">${notes}</ul>` : ""}
  `;
}

function renderEventBlock(analysis) {
  if (!els.eventBlock) return;
  const items = analysis?.events?.items || [];
  const themes = analysis?.themes || [
    ...new Set(items.flatMap((item) => item.themes || []))
  ].map((theme) => ({ theme }));
  if (!items.length && !themes.length) {
    els.eventBlock.innerHTML = `<div class="chart-empty-line">暂无关联事件与主题。</div>`;
    return;
  }
  const themeChips = themes
    .slice(0, 8)
    .map((theme) => `<span class="chip">${escapeHtml(theme.theme || theme.name || theme)}</span>`)
    .join("");
  const rows = items
    .slice(0, 6)
    .map((item) => {
      const tone = item.sentiment === "positive" ? "up" : item.sentiment === "negative" ? "down" : "";
      const title = escapeHtml(item.title || "");
      const link = item.url
        ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${title}</a>`
        : title;
      return `
        <li class="event-item ${tone}">
          <span class="event-dot"></span>
          <div>
            <div class="event-title">${link}</div>
            <div class="event-meta">${escapeHtml(item.source || "")} · ${escapeHtml(item.category || "")} · ${escapeHtml(
              (item.publishedAt || "").slice(0, 16).replace("T", " ")
            )}</div>
          </div>
        </li>`;
    })
    .join("");
  els.eventBlock.innerHTML = `
    <div class="event-head">
      <span>事件分 <strong>${number(analysis?.events?.eventScore ?? 0, 1)}</strong></span>
      <span>偏向 <strong>${number(analysis?.events?.eventBias ?? 0, 2)}</strong></span>
    </div>
    ${themeChips ? `<div class="chip-row">${themeChips}</div>` : ""}
    <ul class="event-list">${rows || `<li class="event-item"><div class="event-title">暂无匹配新闻</div></li>`}</ul>
  `;
}

function paintChart() {
  if (!els.priceChart || !state.chart.payload) return;
  const result = drawPriceChart(els.priceChart, state.chart.payload, {
    range: state.chart.range,
    overlays: state.chart.overlays,
    hover: state.chart.hover
  });
  state.chart.geometry = result
    ? { slot: result.slot, offsetLeft: result.offsetLeft, count: result.count }
    : null;
  els.priceChart.dataset.barCount = result?.bars?.length || 0;
}

async function loadChart(code) {
  if (!els.chartStage) return;
  const token = (state.chart.token += 1);
  state.chart.code = code;
  state.chart.hover = null;
  els.chartStage.hidden = false;
  els.chartEmpty.hidden = false;
  els.chartEmpty.textContent = "加载历史行情…";

  let analysis;
  try {
    analysis = await api(`/api/stocks/${code}/analysis`);
  } catch (error) {
    if (token !== state.chart.token) return;
    state.chart.payload = null;
    els.chartEmpty.hidden = false;
    els.chartEmpty.textContent = `历史行情不可用：${error.message}`;
    if (els.planBlock) els.planBlock.innerHTML = "";
    if (els.eventBlock) els.eventBlock.innerHTML = "";
    return;
  }
  if (token !== state.chart.token) return;

  const history = analysis.history || {};
  const bars = history.bars || [];
  state.chart.payload = { bars, indicators: history.indicators || {}, plan: history.plan || null };

  if (els.chartName) els.chartName.textContent = `${analysis.name || ""} ${analysis.code || code}`;
  if (els.chartMeta) {
    const bits = [
      analysis.board || "",
      history.source ? `数据源 ${history.source}` : "",
      bars.length ? `${bars.length} 根日K` : "",
      analysis.limitLabel ? `涨跌停 ${analysis.limitLabel}` : ""
    ].filter(Boolean);
    els.chartMeta.textContent = bits.join(" · ");
  }
  const lastBar = bars[bars.length - 1];
  if (els.chartLast) els.chartLast.textContent = lastBar ? lastBar.close.toFixed(2) : "—";
  if (els.chartChange) {
    const pct = Number.isFinite(analysis.changePct) ? analysis.changePct : 0;
    els.chartChange.textContent = signed(pct, "%");
    els.chartChange.className = `chart-change ${toneClass(pct)}`;
  }

  if (!bars.length) {
    els.chartEmpty.hidden = false;
    els.chartEmpty.textContent = "该股暂无可用历史行情。";
    if (els.planBlock) els.planBlock.innerHTML = "";
    if (els.eventBlock) els.eventBlock.innerHTML = "";
    return;
  }

  els.chartEmpty.hidden = true;
  els.chartStage.dataset.source = history.source || "";
  paintChart();
  renderPlanBlock(analysis);
  renderEventBlock(analysis);
  scrollStageIntoView();
}

function scrollStageIntoView() {
  if (!els.chartStage || els.chartStage.hidden) return;
  const rect = els.chartStage.getBoundingClientRect();
  const visible = rect.top < window.innerHeight * 0.7 && rect.bottom > 0;
  if (visible) return;
  els.chartStage.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderStockOutlook(outlook) {
  if (!outlook) return "";
  return `
    <section class="stock-outlook">
      <div class="outlook-head">
        <div>
          <div class="panel-kicker">${outlook.title}</div>
          <div class="outlook-direction ${outlook.tone}">${outlook.direction}</div>
        </div>
        <div class="outlook-score">
          <span>${number(outlook.score, 1)}</span>
          <small>${outlook.confidence}</small>
        </div>
      </div>
      <div class="outlook-summary">${outlook.summary}</div>
      <div class="outlook-factor-grid">
        ${outlook.factors.map(renderOutlookFactor).join("")}
      </div>
      <div class="strategy-block">
        <div class="strategy-title">交易计划</div>
        <div class="strategy-stance">${outlook.strategy.stance}</div>
        <div class="strategy-zones">
          ${outlook.strategy.entryZones.map(renderEntryZone).join("")}
        </div>
        <div class="strategy-line">
          <span>失效条件</span>
          <strong>${outlook.strategy.invalidation}</strong>
        </div>
        <div class="strategy-line">
          <span>风控重点</span>
          <strong>${outlook.strategy.riskControl}</strong>
        </div>
        <div class="strategy-line">
          <span>复盘点</span>
          <strong>${outlook.strategy.reviewPoint}</strong>
        </div>
      </div>
      <div class="scenario-list">
        ${outlook.scenarios.map(renderScenario).join("")}
      </div>
      <div class="outlook-risk">${outlook.risks[0]} ${outlook.disclaimer}</div>
    </section>
  `;
}

function renderOutlookFactor(factor) {
  return `
    <div class="outlook-factor">
      <div class="driver-label">${factor.label}</div>
      <div class="${factor.tone}">${factor.value}</div>
      <div class="driver-detail">${factor.detail}</div>
    </div>
  `;
}

function renderEntryZone(zone) {
  return `
    <div class="entry-zone">
      <div>
        <div class="driver-label">${zone.label}</div>
        <div class="driver-detail">${zone.detail}</div>
      </div>
      <strong>${zone.value}</strong>
    </div>
  `;
}

function renderScenario(scenario) {
  return `
    <div class="scenario-item">
      <div class="scenario-label">${scenario.label}</div>
      <div class="scenario-copy">${scenario.condition}</div>
      <div class="scenario-action">${scenario.action}</div>
    </div>
  `;
}

function renderDetail(stock) {
  els.detailPanel.innerHTML = `
    <div class="detail-head">
      <div class="detail-title-row">
        <div>
          <div class="detail-name">${stock.name}</div>
          <div class="detail-sub">${stock.code}.${stock.exchange} · ${stock.board}</div>
        </div>
        <button class="row-button ${isWatched(stock.code) ? "active" : ""}" id="detailWatch" title="自选" aria-label="自选">★</button>
      </div>
      <div class="detail-price">
        <div>
          <div class="detail-sub">现价</div>
          <div class="detail-number">${number(stock.price)}</div>
        </div>
        <div>
          <div class="detail-sub">涨跌幅</div>
          <div class="detail-number ${toneClass(stock.changePct)}">${signed(stock.changePct, "%")}</div>
        </div>
      </div>
    </div>
    <canvas class="sparkline" id="sparkline" width="720" height="176"></canvas>
    <div class="detail-body">
      <div class="kv-grid">
        <div class="kv">
          <div class="kv-label">事件信号</div>
          <div class="kv-value">${stock.signalType}</div>
        </div>
        <div class="kv">
          <div class="kv-label">异动分</div>
          <div class="kv-value">${number(stock.score)}</div>
        </div>
        <div class="kv">
          <div class="kv-label">成交额</div>
          <div class="kv-value">${money(stock.amount)}</div>
        </div>
        <div class="kv">
          <div class="kv-label">总市值</div>
          <div class="kv-value">${money(stock.marketCap)}</div>
        </div>
        <div class="kv">
          <div class="kv-label">明日走势</div>
          <div class="kv-value ${stock.outlook?.tone || "neutral"}">${stock.outlook?.direction || "暂无"}</div>
        </div>
        <div class="kv">
          <div class="kv-label">策略偏向</div>
          <div class="kv-value">${stock.outlook?.strategy?.stance || "暂无"}</div>
        </div>
      </div>
      <div class="narrative">${stock.narrative}</div>
      ${renderStockOutlook(stock.outlook)}
    </div>
  `;

  document.querySelector("#detailWatch").addEventListener("click", () => toggleWatch(stock.code));
  drawSparkline(stock);
}

function drawSparkline(stock) {
  const canvas = document.querySelector("#sparkline");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  const seed = Number(stock.code) || 1;
  const change = stock.changePct || 0;
  const points = Array.from({ length: 36 }, (_, index) => {
    const wave = Math.sin((seed % 17) + index / 3) * 0.18;
    const trend = (index / 35 - 0.5) * (change / 12);
    const pulse = Math.cos(index / 2 + seed) * 0.06;
    return 0.5 - trend - wave - pulse;
  });

  const styles = getComputedStyle(document.documentElement);
  ctx.fillStyle = styles.getPropertyValue("--chart-bg").trim() || "#fbfcff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = styles.getPropertyValue("--line").trim() || "#d9e1ec";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = change >= 0 ? "#d92d20" : "#079455";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = (width / (points.length - 1)) * index;
    const y = Math.max(18, Math.min(height - 18, point * height));
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// --- Event radar, daily briefing and watchlist monitoring -------------------

function timeLabel(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

async function reloadBriefing() {
  if (!els.briefingBody) return;
  try {
    renderBriefing(await api("/api/briefing"));
  } catch {
    els.briefingBody.innerHTML = `<div class="empty-state">简报暂不可用</div>`;
  }
}

function renderBriefing(data) {
  if (!els.briefingBody) return;
  const overview = data.overview || {};
  const kpis = [
    ["上涨 / 下跌", `${overview.advancers ?? "—"} / ${overview.decliners ?? "—"}`],
    ["涨停 / 跌停", `${data.limitUpCount ?? "—"} / ${data.limitDownCount ?? "—"}`],
    ["总成交额", money(overview.totalAmount)],
    ["数据源", data.source || "—"]
  ];
  const lines = (data.narrative || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const headlines = (data.headlines || [])
    .slice(0, 6)
    .map(
      (item) => `
        <div class="headline" data-sentiment="${escapeHtml(item.sentiment || "neutral")}">
          <div class="headline-title">${escapeHtml(item.title)}</div>
          <div class="headline-meta">${escapeHtml(item.category || "资讯")} · ${escapeHtml(item.source || "")} · ${timeLabel(item.publishedAt)}</div>
        </div>`
    )
    .join("");
  els.briefingBody.innerHTML = `
    <div class="briefing-kpis">
      ${kpis
        .map(
          ([label, value]) =>
            `<div class="briefing-kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
        )
        .join("")}
    </div>
    <ul class="briefing-lines">${lines}</ul>
    <div class="headline-list">${headlines || '<div class="empty-state">暂无新闻</div>'}</div>
  `;
  if (els.briefingTime) els.briefingTime.textContent = timeLabel(data.generatedAt);
}

function renderThemes(themes) {
  if (!els.themeList) return;
  const list = (themes || []).slice(0, 12);
  if (!list.length) {
    els.themeList.innerHTML = `<div class="empty-state">暂无主题事件</div>`;
    return;
  }
  const max = Math.max(...list.map((theme) => Math.abs(theme.score)), 1);
  els.themeList.innerHTML = list
    .map((theme) => {
      const dir = theme.score > 0 ? "up" : theme.score < 0 ? "down" : "flat";
      const width = Math.round((Math.abs(theme.score) / max) * 100);
      const top = (theme.events || [])[0];
      return `
        <div class="theme-row">
          <div class="theme-head">
            <span class="theme-name">${escapeHtml(theme.theme)}</span>
            <span class="theme-score ${dir}">${theme.score > 0 ? "+" : ""}${round1(theme.score)}</span>
          </div>
          <div class="theme-bar"><i class="${dir}" style="width:${width}%"></i></div>
          <div class="theme-meta">${(theme.events || []).length} 条事件${top ? ` · ${escapeHtml(String(top.title).slice(0, 24))}` : ""}</div>
        </div>`;
    })
    .join("");
}

function renderIndustries(sectors) {
  if (!els.industryList) return;
  const rows = (sectors || []).slice(0, 14);
  if (!rows.length) {
    els.industryList.innerHTML = `<div class="empty-state">暂无行业数据</div>`;
    return;
  }
  const max = Math.max(...rows.map((sector) => Math.abs(sector.avgChangePct || 0)), 1);
  els.industryList.innerHTML = rows
    .map((sector) => {
      const value = sector.avgChangePct ?? 0;
      const width = Math.round((Math.abs(value) / max) * 100);
      return `
        <div class="industry-row clickable" data-industry="${escapeHtml(sector.name)}" title="点击筛选 ${escapeHtml(sector.name)} 板块成分股">
          <span class="industry-name">${escapeHtml(sector.name)}</span>
          <span class="industry-bar"><i class="${value >= 0 ? "up" : "down"}" style="width:${width}%"></i></span>
          <span class="industry-value ${toneClass(value)}">${signed(value, "%")}</span>
        </div>`;
    })
    .join("");
}

async function reloadRadar() {
  try {
    const data = await api("/api/briefing");
    renderBriefing(data);
    renderThemes(data.themes);
    renderIndustries([...(data.sectors || []), ...(data.laggards || [])].slice(0, 20));
  } catch {
    /* the briefing band is optional; the rest of the dashboard keeps working */
  }
}

async function refreshWatchlist() {
  if (!els.watchlist) return;
  const codes = [...state.watchlist];
  if (!codes.length) {
    state.watchItems = [];
    renderWatchlist();
    return;
  }
  try {
    const data = await api(`/api/watchlist?codes=${codes.join(",")}`);
    state.watchItems = data.items || [];
  } catch {
    state.watchItems = [];
  }
  renderWatchlist();
}

function renderWatchlist() {
  if (!els.watchlist) return;
  const items = state.watchItems || [];
  if (!items.length && !state.watchlist.size) {
    els.watchlist.innerHTML = `<div class="empty-state">暂无自选</div>`;
    return;
  }
  els.watchlist.innerHTML = items
    .map((item) => {
      if (item.missing) {
        return `
          <div class="watch-item" data-code="${item.code}">
            <div class="watch-main">
              <div class="stock-name">${escapeHtml(item.code)}</div>
              <div class="stock-code">已退市或无法取得行情</div>
            </div>
            <div class="watch-right"><div class="neutral">—</div></div>
          </div>`;
      }
      const alerts = (item.alerts || [])
        .map((alert) => `<span class="alert-chip ${escapeHtml(alert.level)}">${escapeHtml(alert.label)}</span>`)
        .join("");
      return `
        <div class="watch-item" data-code="${item.code}">
          <div class="watch-main">
            <div class="stock-name">${escapeHtml(item.name)}</div>
            <div class="stock-code">${item.code} · ${escapeHtml(item.board)}</div>
            ${alerts ? `<div class="watch-alerts">${alerts}</div>` : ""}
          </div>
          <div class="watch-right">
            <div class="${toneClass(item.changePct)}">${signed(item.changePct, "%")}</div>
            <button class="watch-remove" data-remove="${item.code}" title="移除自选" aria-label="移除自选">✕</button>
          </div>
        </div>`;
    })
    .join("");

  els.watchlist.querySelectorAll(".watch-item").forEach((node) => {
    node.addEventListener("click", (event) => {
      if (event.target.closest("[data-remove]")) return;
      selectStock(node.dataset.code);
    });
  });
  els.watchlist.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleWatch(button.dataset.remove);
      refreshWatchlist();
    });
  });
}

function metricCell(label, value, tone = "") {
  return `<div class="metric-cell"><span>${escapeHtml(label)}</span><strong class="${tone}">${escapeHtml(value)}</strong></div>`;
}

function renderBacktest(data) {
  if (!els.backtestBody) return;
  if (data.error) {
    els.backtestBody.innerHTML = `<div class="empty-state">${escapeHtml(data.error)}</div>`;
    els.backtestStatus.textContent = "";
    return;
  }
  const s = data.summary || {};
  const wf = data.walkForward || {};
  const pct = (value) => signed(value, "%");
  const cells = [
    metricCell("区间", `${s.startDate || "—"} → ${s.endDate || "—"}`),
    metricCell("交易日", `${s.sessions ?? "—"}`),
    metricCell("总收益", pct(s.totalReturn), toneClass(s.totalReturn)),
    metricCell("年化", pct(s.annualizedReturn), toneClass(s.annualizedReturn)),
    metricCell("最大回撤", pct(s.maxDrawdown), toneClass(s.maxDrawdown)),
    metricCell("夏普", Number.isFinite(s.sharpe) ? String(s.sharpe) : "—"),
    metricCell("索提诺", Number.isFinite(s.sortino) ? String(s.sortino) : "—"),
    metricCell("交易次数", `${s.trades ?? "—"}`),
    metricCell("胜率", Number.isFinite(s.winRate) ? `${s.winRate}%` : "—"),
    metricCell("盈亏比", Number.isFinite(s.profitFactor) ? String(s.profitFactor) : "—"),
    metricCell("基准(等权)", pct(s.benchmarkReturn), toneClass(s.benchmarkReturn)),
    metricCell("超额收益", pct(s.excessReturn), toneClass(s.excessReturn))
  ].join("");

  const wfRow = wf.inSample
    ? `<div class="walk-forward">
         <div class="wf-title">样本外验证（切分日 ${escapeHtml(wf.splitDate || "—")}）</div>
         <div class="metric-grid">
           ${metricCell("样本内收益", pct(wf.inSample.totalReturn), toneClass(wf.inSample.totalReturn))}
           ${metricCell("样本外收益", pct(wf.outOfSample?.totalReturn), toneClass(wf.outOfSample?.totalReturn))}
           ${metricCell("样本外回撤", pct(wf.outOfSample?.maxDrawdown), toneClass(wf.outOfSample?.maxDrawdown))}
           ${metricCell("样本外夏普", Number.isFinite(wf.outOfSample?.sharpe) ? String(wf.outOfSample.sharpe) : "—")}
         </div>
       </div>`
    : "";

  els.backtestBody.innerHTML = `
    <div class="metric-grid">${cells}</div>
    ${wfRow}
    <div class="backtest-note">
      标的 ${data.universe?.length ?? 0} 只 · 数据源 ${escapeHtml([...(data.sources || [])].join("/") || "—")}
      ${data.failures?.length ? ` · ${data.failures.length} 只取数失败` : ""}
      · 已计入佣金（万2.5、最低 5 元）、印花税（卖出千0.5）、过户费与 0.1% 滑点，T+1 且涨停不可买、跌停不可卖。
    </div>`;
  els.backtestStatus.textContent = `最近一次：${timeLabel(new Date().toISOString())}`;
}

async function runStrategyBacktest() {
  if (!els.backtestBody) return;
  const params = new URLSearchParams({
    days: String(Number(document.querySelector("#backtestDays")?.value || 250)),
    topN: String(Number(document.querySelector("#backtestTopN")?.value || 3)),
    holdDays: String(Number(document.querySelector("#backtestHold")?.value || 10)),
    rebalanceDays: "5"
  });
  const codes = [...state.watchlist];
  if (codes.length) params.set("codes", codes.join(","));
  els.backtestStatus.textContent = "回测中…";
  els.backtestBody.innerHTML = `<div class="empty-state">正在拉取历史行情并回测…</div>`;
  try {
    renderBacktest(await api(`/api/backtest?${params.toString()}`));
  } catch (error) {
    els.backtestStatus.textContent = "";
    els.backtestBody.innerHTML = `<div class="empty-state">回测失败：${escapeHtml(error.message)}</div>`;
  }
}

async function reloadOverview() {
  const overview = await api("/api/overview");
  renderOverview(overview);
}

async function reloadForecast() {
  const forecast = await api("/api/forecast");
  renderForecast(forecast);
}

async function reloadSignals() {
  const signals = await api("/api/signals?limit=80");
  renderSignals(signals);
}

async function reloadStocks({ append = false } = {}) {
  if (!append) {
    state.offset = 0;
    state.rows = [];
  }
  const params = encode({
    q: state.query,
    exchange: state.exchange,
    board: state.board,
    sort: state.sort,
    limit: state.limit,
    offset: state.offset
  });
  const data = await api(`/api/stocks?${params}`);
  state.total = data.total;
  // Appending must only insert the rows that are actually new: the old code
  // re-appended the whole list, so every "load more" duplicated the table.
  const renderedCount = append ? state.rows.length : 0;
  state.rows = append ? [...state.rows, ...data.items] : data.items;
  state.offset = state.rows.length;
  renderRows(append, append ? state.rows.slice(renderedCount) : state.rows);
  renderWatchlist();
}

function debounce(fn, delay = 220) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function closeSuggestions() {
  state.suggestions = [];
  state.activeSuggestion = -1;
  if (els.searchSuggestions) {
    els.searchSuggestions.hidden = true;
    els.searchSuggestions.innerHTML = "";
  }
  els.searchInput?.setAttribute("aria-expanded", "false");
}

function highlightSuggestion(nodes) {
  nodes.forEach((node, index) => {
    node.classList.toggle("active", index === state.activeSuggestion);
  });
  const active = nodes[state.activeSuggestion];
  if (active) active.scrollIntoView({ block: "nearest" });
}

function renderSuggestions(items) {
  state.suggestions = items;
  state.activeSuggestion = items.length ? 0 : -1;
  const box = els.searchSuggestions;
  if (!box) return;

  if (!items.length) {
    box.innerHTML = '<div class="suggestion-empty">没有匹配的股票</div>';
    box.hidden = false;
    els.searchInput?.setAttribute("aria-expanded", "true");
    return;
  }

  box.innerHTML = items
    .map(
      (item) => `
        <div class="suggestion" role="option" data-code="${escapeHtml(item.code)}" data-name="${escapeHtml(item.name)}">
          <span class="s-name">${escapeHtml(item.name)}</span>
          <span class="s-code">${escapeHtml(item.code)}</span>
          <span class="s-py">${escapeHtml(item.pinyin || "")}${item.initials ? ` · ${escapeHtml(item.initials)}` : ""}</span>
        </div>`
    )
    .join("");
  box.hidden = false;
  els.searchInput?.setAttribute("aria-expanded", "true");
  highlightSuggestion([...box.querySelectorAll(".suggestion")]);

  box.querySelectorAll(".suggestion").forEach((node) => {
    // mousedown fires before blur, so the list is still alive when picked.
    node.addEventListener("mousedown", (event) => {
      event.preventDefault();
      pickSuggestion(node.dataset.code, node.dataset.name);
    });
  });
}

async function loadSuggestions(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    closeSuggestions();
    return;
  }
  const token = ++state.suggestionToken;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(trimmed)}&limit=8`);
    if (token !== state.suggestionToken) return;
    renderSuggestions(data.items || []);
  } catch {
    if (token === state.suggestionToken) closeSuggestions();
  }
}

async function pickSuggestion(code, name) {
  closeSuggestions();
  els.searchInput.value = code;
  state.query = code;
  await reloadStocks();
  await selectStock(code);
}

/** Clicking a sector row filters the table down to that board. */
async function filterByIndustry(name) {
  const industry = String(name || "").trim();
  if (!industry) return;
  els.searchInput.value = industry;
  state.query = industry;
  closeSuggestions();
  await reloadStocks();
  els.stockRows?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function bindEvents() {
  const runSearch = debounce((value) => {
    state.query = value;
    reloadStocks();
  }, 220);

  els.searchInput.addEventListener("input", (event) => {
    const value = event.target.value;
    runSearch(value);
    loadSuggestions(value);
  });

  els.searchInput.addEventListener("keydown", (event) => {
    if (els.searchSuggestions?.hidden) return;
    const nodes = [...(els.searchSuggestions?.querySelectorAll(".suggestion") || [])];
    if (!nodes.length) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      state.activeSuggestion = (state.activeSuggestion + delta + nodes.length) % nodes.length;
      highlightSuggestion(nodes);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const node = nodes[state.activeSuggestion] || nodes[0];
      pickSuggestion(node.dataset.code, node.dataset.name);
    } else if (event.key === "Escape") {
      closeSuggestions();
    }
  });

  els.industryList?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-industry]");
    if (row) filterByIndustry(row.dataset.industry);
  });

  els.searchInput.addEventListener("blur", () => {
    // Delay so a suggestion mousedown still lands.
    setTimeout(closeSuggestions, 140);  });

  els.sortSelect.addEventListener("change", (event) => {
    state.sort = event.target.value;
    reloadStocks();
  });

  els.exchangeSegment.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      els.exchangeSegment.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.exchange = button.dataset.exchange;
      state.board = "ALL";
      reloadStocks();
    });
  });

  els.loadMoreButton.addEventListener("click", () => {
    reloadStocks({ append: true });
  });

  els.backtestRun?.addEventListener("click", () => {
    runStrategyBacktest();
  });

  els.refreshButton.addEventListener("click", () => {
    init();
  });

  els.themeToggle.addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
    paintChart();
    if (state.selectedCode) selectStock(state.selectedCode);
  });

  // --- chart stage controls ---
  els.rangeSegment?.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.range) === state.chart.range);
    button.addEventListener("click", () => {
      els.rangeSegment.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.chart.range = Number(button.dataset.range);
      localStorage.setItem("stockradar-chart-range", String(state.chart.range));
      state.chart.hover = null;
      paintChart();
    });
  });

  els.overlaySegment?.querySelectorAll("button").forEach((button) => {
    const key = button.dataset.overlay;
    button.classList.toggle("active", state.chart.overlays.has(key));
    button.addEventListener("click", () => {
      if (state.chart.overlays.has(key)) state.chart.overlays.delete(key);
      else state.chart.overlays.add(key);
      button.classList.toggle("active", state.chart.overlays.has(key));
      localStorage.setItem("stockradar-chart-overlays", [...state.chart.overlays].join(","));
      state.chart.hover = null;
      paintChart();
    });
  });

  els.chartClose?.addEventListener("click", () => {
    els.chartStage.hidden = true;
    state.chart.payload = null;
    state.chart.code = null;
  });

  els.priceChart?.addEventListener("mousemove", (event) => {
    const geometry = state.chart.geometry;
    if (!geometry) return;
    const rect = els.priceChart.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const index = Math.floor((x - geometry.offsetLeft) / geometry.slot);
    const clamped = Math.min(Math.max(index, 0), geometry.count - 1);
    if (clamped === state.chart.hover) return;
    state.chart.hover = clamped;
    paintChart();
  });

  els.priceChart?.addEventListener("mouseleave", () => {
    if (state.chart.hover === null) return;
    state.chart.hover = null;
    paintChart();
  });

  window.addEventListener("resize", debounce(() => paintChart(), 160));
}

async function init() {
  els.dataStatus.textContent = "加载市场数据中";
  applyTheme(state.theme);
  await Promise.all([reloadOverview(), reloadForecast(), reloadSignals(), reloadStocks(), reloadRadar()]);
  refreshWatchlist();
  if (!state.selectedCode && state.rows[0]) {
    await selectStock(state.rows[0].code);
  }
}

bindEvents();
init().catch((error) => {
  console.error(error);
  els.dataStatus.textContent = "数据加载失败";
  els.stockRows.innerHTML = `<tr><td colspan="9">数据加载失败：${error.message}</td></tr>`;
});
