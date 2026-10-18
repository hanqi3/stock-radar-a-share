import { drawPriceChart } from "./chart.js";

const state = {
  tab: localStorage.getItem("stockradar-tab") || "stocks",
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
    type: localStorage.getItem("stockradar-chart-type") || "candle",
    overlays: new Set(
      (localStorage.getItem("stockradar-chart-overlays") || "ma5,ma10,ma15,ma20,boll,volume").split(",")
    ),
    payload: null,
    token: 0,
    hover: null,
    from: null,
    to: null,
    drag: null,
    geometry: null
  },
  news: {
    query: "",
    scope: "all",
    items: [],
    index: [],
    overseas: null,
    loaded: false,
    loading: false
  },
  sectorNews: {
    data: null,
    loaded: false,
    loading: false
  },
  outlook: {
    data: null,
    loaded: false,
    loading: false
  },
  flow: {
    scope: localStorage.getItem("stockradar-flow-scope") || "stock",
    side: localStorage.getItem("stockradar-flow-side") || "inflow",
    w: Number(localStorage.getItem("stockradar-flow-window")) || 1,
    data: null,
    token: 0
  }
};

const els = {
  overview: document.querySelector("#overview"),
  boardList: document.querySelector("#boardList"),
  watchlist: document.querySelector("#watchlist"),
  watchCount: document.querySelector("#watchCount"),
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
  chartTypeSegment: document.querySelector("#chartTypeSegment"),
  chartClose: document.querySelector("#chartClose"),
  chartReset: document.querySelector("#chartReset"),
  chartWrap: document.querySelector("#chartWrap"),
  chartLegend: document.querySelector("#chartLegend"),
  briefingTime: document.querySelector("#briefingTime"),
  briefingBody: document.querySelector("#briefingBody"),
  overseasTime: document.querySelector("#overseasTime"),
  overseasBriefingBody: document.querySelector("#overseasBriefingBody"),
  overseasThemeChips: document.querySelector("#overseasThemeChips"),
  indexCount: document.querySelector("#indexCount"),
  themeList: document.querySelector("#themeList"),
  industryList: document.querySelector("#industryList"),
  backtestRun: document.querySelector("#backtestRun"),
  backtestBody: document.querySelector("#backtestBody"),
  backtestStatus: document.querySelector("#backtestStatus"),
  tabRail: document.querySelector("#tabRail"),
  panelFlow: document.querySelector("#panelFlow"),
  panelStocks: document.querySelector("#panelStocks"),
  panelNews: document.querySelector("#panelNews"),
  panelWatch: document.querySelector("#panelWatch"),
  flowBody: document.querySelector("#flowBody"),
  flowSummary: document.querySelector("#flowSummary"),
  flowTrend: document.querySelector("#flowTrend"),
  flowTime: document.querySelector("#flowTime"),
  flowScopeSegment: document.querySelector("#flowScopeSegment"),
  flowSideSegment: document.querySelector("#flowSideSegment"),
  flowWindowSegment: document.querySelector("#flowWindowSegment"),
  globalIndexList: document.querySelector("#globalIndexList"),
  newsSearchInput: document.querySelector("#newsSearchInput"),
  newsScopeSegment: document.querySelector("#newsScopeSegment"),
  newsCnList: document.querySelector("#newsCnList"),
  newsGlobalList: document.querySelector("#newsGlobalList"),
  newsCnCount: document.querySelector("#newsCnCount"),
  newsGlobalCount: document.querySelector("#newsGlobalCount"),
  newsCount: document.querySelector("#newsCount"),
  sectorNewsBoard: document.querySelector("#sectorNewsBoard"),
  sectorNewsCount: document.querySelector("#sectorNewsCount"),
  panelOutlook: document.querySelector("#panelOutlook"),
  outlookScore: document.querySelector("#outlookScore"),
  outlookBias: document.querySelector("#outlookBias"),
  outlookConfidence: document.querySelector("#outlookConfidence"),
  outlookForDate: document.querySelector("#outlookForDate"),
  outlookSummary: document.querySelector("#outlookSummary"),
  outlookChips: document.querySelector("#outlookChips"),
  outlookLogic: document.querySelector("#outlookLogic"),
  outlookTransmissions: document.querySelector("#outlookTransmissions"),
  outlookBullish: document.querySelector("#outlookBullish"),
  outlookBearish: document.querySelector("#outlookBearish"),
  outlookRisks: document.querySelector("#outlookRisks"),
  outlookWatch: document.querySelector("#outlookWatch"),
  outlookInputs: document.querySelector("#outlookInputs"),
  outlookInputsTime: document.querySelector("#outlookInputsTime"),
  outlookNote: document.querySelector("#outlookNote")
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
  const seps = `<span class="metric-sep">/</span>`;
  const metrics = [
    ["股票池", data.total, `${data.meta.mode === "full" ? "全量" : "样例"} · ${data.meta.source || "local"}`, false],
    ["上涨", data.advancers, `下跌 ${data.decliners} · 平盘 ${data.flat}`, false],
    ["涨停附近", data.limitUp, `跌停附近 ${data.limitDown}`, false],
    ["成交额", money(data.totalAmount), "全市场合计", false],
    [
      "沪深北",
      `${data.byExchange.SH || 0}${seps}${data.byExchange.SZ || 0}${seps}${data.byExchange.BJ || 0}`,
      `SH / SZ / BJ · 合计 ${data.total}`,
      true
    ],
    ["可交易", data.tradable, "有价格记录", false]
  ];

  els.overview.innerHTML = metrics
    .map(
      ([label, value, foot, dense]) => `
        <div class="metric">
          <div class="metric-label">${label}</div>
          <div class="metric-value${dense ? " is-dense" : ""}">${value}</div>
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
  showTab("stocks");
  renderRows();
  loadChart(code);
  const stock = await api(`/api/stocks/${code}`);
  renderDetail(stock);
}

// --- tab rail ---------------------------------------------------------------

const TAB_IDS = {
  flow: "panelFlow",
  stocks: "panelStocks",
  news: "panelNews",
  watch: "panelWatch",
  outlook: "panelOutlook"
};

function showTab(name) {
  if (!TAB_IDS[name]) name = "stocks";
  state.tab = name;
  localStorage.setItem("stockradar-tab", name);
  for (const [key, id] of Object.entries(TAB_IDS)) {
    const panel = document.getElementById(id);
    if (panel) panel.hidden = key !== name;
    const button = els.tabRail?.querySelector(`[data-tab="${key}"]`);
    if (button) {
      button.classList.toggle("active", key === name);
      button.setAttribute("aria-selected", key === name ? "true" : "false");
    }
  }
  if (name === "flow" && !state.flow.data) reloadFlow();
  if (name === "news") {
    if (!state.news.loaded) reloadNews();
    if (!state.sectorNews.loaded) loadSectorNews();
  }
  if (name === "watch") refreshWatchlist();
  if (name === "outlook" && !state.outlook.loaded) loadOutlook();
  if (name === "stocks") {
    requestAnimationFrame(() => paintChart());
  }
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

function chartWindow() {
  // The visible slice is kept in state so wheel-zoom and drag-pan only move the
  // window; the payload itself is never re-fetched.
  return { from: state.chart.from, to: state.chart.to };
}

function clampWindow(from, to) {
  const total = state.chart.payload?.bars?.length || 0;
  if (!total) return { from: 0, to: 0 };
  const minSpan = 12;
  let span = Math.min(Math.max(Math.round(to - from), minSpan), total);
  let start = Math.round(from);
  start = Math.min(Math.max(start, 0), Math.max(total - span, 0));
  return { from: start, to: start + span };
}

function resetChartWindow() {
  const total = state.chart.payload?.bars?.length || 0;
  const range = Math.max(Math.min(state.chart.range, total || state.chart.range), 2);
  state.chart.from = Math.max(total - range, 0);
  state.chart.to = total;
}

/** Default window follows the range segment unless the user has zoomed. */
function ensureChartWindow() {
  if (Number.isInteger(state.chart.from) && Number.isInteger(state.chart.to)) return;
  resetChartWindow();
}

function paintChart() {
  if (!els.priceChart || !state.chart.payload) return;
  ensureChartWindow();
  const result = drawPriceChart(els.priceChart, state.chart.payload, {
    range: state.chart.range,
    from: state.chart.from,
    to: state.chart.to,
    overlays: state.chart.overlays,
    hover: state.chart.hover,
    type: state.chart.type
  });
  if (!result) return;
  state.chart.from = result.from;
  state.chart.to = result.to;
  state.chart.geometry = {
    slot: result.slot,
    offsetLeft: result.offsetLeft,
    count: result.count,
    from: result.from,
    to: result.to,
    total: result.total
  };
  els.priceChart.dataset.barCount = result.count;
  const end = result.bars[result.bars.length - 1];
  const start = result.bars[0];
  if (els.chartLegend) {
    els.chartLegend.innerHTML = end
      ? `<span>区间 <b>${start.date}</b> → <b>${end.date}</b>（${result.count} / ${result.total} 根）</span>` +
        `<span>买点 <b>${state.chart.payload.plan?.buyZones?.[0]?.price?.toFixed(2) ?? "—"}</b></span>` +
        `<span>止损 <b>${state.chart.payload.plan?.stopLoss?.toFixed(2) ?? "—"}</b></span>` +
        `<span>目标 <b>${state.chart.payload.plan?.target?.toFixed(2) ?? "—"}</b></span>`
      : "";
  }
}

async function loadChart(code) {
  if (!els.chartStage) return;
  const token = (state.chart.token += 1);
  state.chart.code = code;
  state.chart.hover = null;
  state.chart.from = null;
  state.chart.to = null;
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
    els.chartChange.className = `tv-change ${toneClass(pct)}`;
  }
  if (els.chartLast) els.chartLast.className = `tv-last ${toneClass(Number.isFinite(analysis.changePct) ? analysis.changePct : 0)}`;

  if (!bars.length) {
    els.chartEmpty.hidden = false;
    els.chartEmpty.textContent = "该股暂无可用历史行情。";
    if (els.planBlock) els.planBlock.innerHTML = "";
    if (els.eventBlock) els.eventBlock.innerHTML = "";
    if (els.chartLegend) els.chartLegend.innerHTML = "";
    return;
  }

  els.chartEmpty.hidden = true;
  els.chartStage.dataset.source = history.source || "";
  // Reset the zoom window AFTER the payload lands: a tab switch or resize may
  // repaint with the previous stock's payload while this request is in flight,
  // which would otherwise leave the new chart stuck on that stale window.
  state.chart.from = null;
  state.chart.to = null;
  paintChart();
  renderPlanBlock(analysis);
  renderEventBlock(analysis);
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
  if (els.briefingTime) els.briefingTime.textContent = timeLabel(data.dataUpdatedAt || data.generatedAt);
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
      const flag = sector.anomalyScore >= 70 ? (sector.flags || [])[0] : null;
      return `
        <div class="industry-row clickable" data-industry="${escapeHtml(sector.name)}" title="点击筛选 ${escapeHtml(sector.name)} 板块成分股">
          <span class="industry-name">${escapeHtml(sector.name)}</span>
          <span class="industry-bar"><i class="${value >= 0 ? "up" : "down"}" style="width:${width}%"></i></span>
          ${flag ? `<span class="anomaly-chip" title="${escapeHtml((sector.flags || []).join(" · "))}">${escapeHtml(flag)}</span>` : ""}
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

// --- capital flow -----------------------------------------------------------

async function reloadFlow() {
  if (!els.flowBody) return;
  const token = (state.flow.token += 1);
  els.flowBody.innerHTML = `<div class="empty-state">加载资金流数据中</div>`;
  try {
    const data = await api(
      `/api/flow?scope=${encodeURIComponent(state.flow.scope)}&side=${encodeURIComponent(state.flow.side)}&w=${encodeURIComponent(state.flow.w)}&limit=60`
    );
    if (token !== state.flow.token) return;
    state.flow.data = data;
    renderFlow(data);
  } catch (error) {
    if (token !== state.flow.token) return;
    state.flow.data = null;
    if (els.flowSummary) els.flowSummary.innerHTML = "";
    if (els.flowTrend) els.flowTrend.hidden = true;
    els.flowBody.innerHTML = `<div class="empty-state">资金流数据暂不可用：${escapeHtml(error.message)}</div>`;
  }
}

function signedMoney(value) {
  if (!Number.isFinite(value)) return "暂无";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${money(Math.abs(value))}`;
}

function flowWindowLabel(w) {
  if (w === 250) return "近 1 年";
  return w > 1 ? `近 ${w} 日` : "当日";
}

function renderFlowTrend(data) {
  if (!els.flowTrend) return;
  const history = Array.isArray(data?.history) ? data.history : [];
  if (history.length < 3) {
    els.flowTrend.hidden = true;
    els.flowTrend.innerHTML = "";
    return;
  }
  const ordered = history.slice().reverse(); // oldest -> newest
  const max = Math.max(...ordered.map((day) => Math.abs(day.mainNet || 0)), 1);
  const bars = ordered
    .map((day) => {
      const net = day.mainNet || 0;
      const height = Math.max(Math.round((Math.abs(net) / max) * 100), 3);
      const tip = `${day.date}　主力净额 ${signedMoney(net)}　流入/流出 ${day.inflows}/${day.outflows} 家`;
      return `<i class="${net >= 0 ? "up" : "down"}" style="height:${height}%" title="${escapeHtml(tip)}"></i>`;
    })
    .join("");
  const span = `${ordered[0].date} → ${ordered[ordered.length - 1].date}`;
  els.flowTrend.hidden = false;
  els.flowTrend.innerHTML = `
    <div class="flow-trend-head">
      <span>市场主力净额走势 · ${escapeHtml(span)}</span>
      <span class="flow-trend-legend">${ordered.length} 个交易日 · 柱高按当日净额绝对值</span>
    </div>
    <div class="flow-trend-bars${ordered.length > 120 ? " dense" : ""}">${bars}</div>`;
}

function renderFlowSummary(data) {
  if (!els.flowSummary) return;
  const market = data?.market;
  if (!market) {
    els.flowSummary.innerHTML = "";
    return;
  }
  const total = (market.inflows || 0) + (market.outflows || 0);
  const inflowPct = total ? Math.round(((market.inflows || 0) / total) * 100) : 0;
  els.flowSummary.innerHTML = `
    <div class="flow-stat">
      <span class="flow-stat-label">全市场主力净额</span>
      <span class="flow-stat-value ${toneClass(market.mainNet)}">${signedMoney(market.mainNet)}</span>
    </div>
    <div class="flow-stat">
      <span class="flow-stat-label">主力净流入 / 净流出</span>
      <span class="flow-stat-value"><b class="positive">${market.inflows ?? 0}</b> / <b class="negative">${market.outflows ?? 0}</b> 家</span>
    </div>
    <div class="flow-stat">
      <span class="flow-stat-label">流入占比</span>
      <span class="flow-stat-value">${inflowPct}%</span>
    </div>
    <div class="flow-stat">
      <span class="flow-stat-label">口径 / 窗口</span>
      <span class="flow-stat-value flow-stat-note">${escapeHtml(data.definition || "主力 = 超大单 + 大单")} · 当日 ${escapeHtml(data.date || "—")} · 共 ${data.days ?? "—"} 个交易日</span>
    </div>`;
  renderFlowTrend(data);
}

function renderFlow(data) {
  if (!els.flowBody) return;
  const items = data?.items || [];
  if (els.flowTime) {
    const stamp = data?.date || (data?.generatedAt ? String(data.generatedAt).slice(0, 10) : "");
    els.flowTime.textContent = stamp ? `${stamp}${data?.sourceLabel ? ` · ${data.sourceLabel}` : ""}` : "";
  }
  renderFlowSummary(data);
  if (!items.length) {
    els.flowBody.innerHTML = `<div class="empty-state">暂无资金流数据</div>`;
    return;
  }

  const industry = data.scope === "industry";
  const w = data.w || 1;
  const windowLabel = flowWindowLabel(w);
  const columnLabel = industry ? `${windowLabel}行业净额` : `${windowLabel}个股净额`;
  const valueOf = (item) => (Number.isFinite(item.flow) ? item.flow : item.mainNet) || 0;
  const max = Math.max(...items.map((item) => Math.abs(valueOf(item))), 1);
  const rows = items
    .map((item, index) => {
      const net = valueOf(item);
      const width = Math.max(Math.round((Math.abs(net) / max) * 100), 2);
      const title = industry
        ? escapeHtml(item.name || "—")
        : `${escapeHtml(item.name || "—")} <span class="flow-code">${escapeHtml(item.code || "")}</span>`;
      const sub = industry
        ? `${item.count ?? 0} 只成分 · 平均涨跌 ${Number.isFinite(item.avgChangePct) ? signed(item.avgChangePct, "%") : "—"} · 当日成交 ${money(item.amount)}`
        : `${escapeHtml(item.industry || "—")} · ${Number.isFinite(item.changePct) ? signed(item.changePct, "%") : "—"} · 当日成交 ${money(item.amount)}`;
      const compare = industry
        ? `${money(item.amount)}`
        : `${signedMoney(item.main5)}`;
      const compareLabel = industry ? "当日成交额合计" : "近 5 日主力";
      const trend = `<div class="flow-side-value ${toneClass(industry ? null : item.main5)}">${compare}</div><div class="flow-side-label">${compareLabel}</div>`;
      const partial = !industry && Number.isFinite(item.sessions) && item.sessions < w;
      const windowNote = partial ? `${windowLabel}·仅 ${item.sessions} 日` : windowLabel;
      const detail = industry
        ? `${item.name}：${windowLabel}净额 ${signedMoney(net)}（${item.count ?? 0} 只成分）`
        : `${item.name} ${item.code}\n${windowLabel}主力净额 ${signedMoney(net)}${partial ? `（该股上市仅 ${item.sessions} 个交易日，此为该股全部交易日之和）` : ""}\n当日 ${signedMoney(item.mainNet)}（占比 ${Number.isFinite(item.mainRatio) ? signed(item.mainRatio, "%") : "—"}）\n近 5 日 ${signedMoney(item.main5)} · 近 20 日 ${signedMoney(item.main20)} · 近 60 日 ${signedMoney(item.main60)}\n超大单 ${signedMoney(item.superNet)} · 大单 ${signedMoney(item.bigNet)}\n中单 ${signedMoney(item.midNet)} · 小单 ${signedMoney(item.smallNet)}\n成交额 ${money(item.amount)}`;
      return `
        <div class="flow-row" ${item.code ? `data-code="${escapeHtml(item.code)}"` : ""} title="${escapeHtml(detail)}">
          <div class="flow-rank">${index + 1}</div>
          <div class="flow-main">
            <div class="flow-name">${title}</div>
            <div class="flow-sub">${sub}</div>
          </div>
          <div class="flow-side">
            ${trend}
          </div>
          <div class="flow-net ${toneClass(net)}">
            <div class="flow-net-value">${signedMoney(net)}</div>
            <div class="flow-net-ratio">${industry ? `${item.count ?? 0} 只成分` : windowNote}</div>
          </div>
          <div class="flow-bar"><i class="${net >= 0 ? "up" : "down"}" style="width:${width}%"></i></div>
        </div>`;
    })
    .join("");

  els.flowBody.innerHTML = `
    <div class="flow-head">
      <div class="flow-rank">#</div>
      <div class="flow-main">${industry ? "行业" : "个股 / 行业 / 成交额"}</div>
      <div class="flow-side">${industry ? "成交额" : "近 5 日主力"}</div>
      <div class="flow-net">${columnLabel}</div>
      <div class="flow-bar-head"></div>
    </div>
    ${rows}`;
}

// --- news + policy ----------------------------------------------------------

async function reloadNews() {
  state.news.loading = true;
  try {
    const [data, overseas] = await Promise.all([
      api("/api/news?limit=900"),
      api("/api/briefing/overseas").catch(() => null)
    ]);
    state.news.items = data.items || [];
    state.news.index = data.indices || [];
    state.news.overseas = overseas;
    state.news.loaded = true;
  } catch {
    state.news.items = [];
    state.news.index = [];
    state.news.overseas = null;
    state.news.loaded = true;
  } finally {
    state.news.loading = false;
  }
  renderGlobalIndices();
  renderOverseasBriefing();
  renderNews();
}

// 35 instruments across five desks; the group heading keeps the board legible.
function renderGlobalIndices() {
  if (!els.globalIndexList) return;
  const list = state.news.index || [];
  if (!list.length) {
    els.globalIndexList.innerHTML = `<div class="empty-state">暂无全球指数数据</div>`;
    if (els.indexCount) els.indexCount.textContent = "";
    return;
  }
  const groups = new Map();
  for (const item of list) {
    const key = item.group || "其他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  els.globalIndexList.innerHTML = [...groups.entries()]
    .map(([group, items]) => {
      const cells = items
        .map(
          (item) => `
          <div class="index-cell">
            <div class="index-name">${escapeHtml(item.name || item.symbol || "")}</div>
            <div class="index-value">${Number.isFinite(item.price) ? item.price.toFixed(indexDigits(item.price, item.digits)) : "—"}</div>
            <div class="index-change ${toneClass(item.changePct)}">${signed(item.changePct, "%")}</div>
          </div>`
        )
        .join("");
      return `<div class="index-group"><div class="index-group-title">${escapeHtml(group)}</div><div class="index-group-body">${cells}</div></div>`;
    })
    .join("");
  if (els.indexCount) els.indexCount.textContent = `${list.length} 个标的 · 新浪行情`;
}

function indexDigits(price, digits) {
  if (Number.isInteger(digits)) return digits;
  return Math.abs(Number(price) || 0) >= 100 ? 2 : 4;
}

function renderOverseasBriefing() {
  const data = state.news.overseas;
  if (els.overseasTime) {
    els.overseasTime.textContent = data?.dataUpdatedAt ? timeLabel(data.dataUpdatedAt) : "";
  }
  if (els.overseasBriefingBody) {
    const lines = data?.narrative || [];
    const headlines = (data?.headlines || [])
      .slice(0, 5)
      .map(
        (item) => `
        <div class="headline" data-sentiment="${escapeHtml(item.sentiment || "neutral")}">
          <div class="headline-title">${escapeHtml(item.title)}</div>
          <div class="headline-meta">${escapeHtml(item.source || "")} · ${timeLabel(item.publishedAt)}</div>
        </div>`
      )
      .join("");
    els.overseasBriefingBody.innerHTML = lines.length
      ? `<ul class="briefing-lines">${lines.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>
         <div class="briefing-subtitle">海外要闻</div>
         <div class="headline-list">${headlines || '<div class="empty-state">暂无海外新闻</div>'}</div>`
      : `<div class="empty-state">暂无海外数据</div>`;
  }
  if (els.overseasThemeChips) {
    const themes = (data?.themes || []).slice(0, 8);
    els.overseasThemeChips.innerHTML = themes.length
      ? themes
          .map((entry) => `<span class="chip chip-overseas">${escapeHtml(entry.theme)} ${entry.count}</span>`)
          .join("")
      : "";
  }
}

function regionOf(item) {
  return item.region === "global" ? "global" : "cn";
}

function newsMatches(item, query) {
  if (!query) return true;
  const haystack = `${item.title || ""} ${item.summary || ""} ${item.source || ""} ${(item.themes || []).join(" ")} ${(item.codes || []).join(" ")}`;
  return haystack.toLowerCase().includes(query);
}

function highlightKeyword(text, query) {
  const safe = escapeHtml(text || "");
  if (!query) return safe;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(escaped, "gi"), (match) => `<mark class="keyword">${match}</mark>`);
}

function newsCard(item, query) {
  const themes = (item.themes || []).slice(0, 3).map((theme) => `<span class="chip">${escapeHtml(theme)}</span>`).join("");
  return `
    <div class="headline" data-sentiment="${escapeHtml(item.sentiment || "neutral")}">
      <div class="headline-title">
        ${item.url
          ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${highlightKeyword(item.title, query)}</a>`
          : highlightKeyword(item.title, query)}
      </div>
      <div class="headline-meta">
        ${escapeHtml(item.category || "资讯")} · ${escapeHtml(item.source || "")} · ${timeLabel(item.publishedAt)}
      </div>
      ${themes ? `<div class="chip-row">${themes}</div>` : ""}
    </div>`;
}

// Corporate filings arrive in bursts: one issuer can file eleven documents in a
// minute and bury the actual news. Two guards keep a column readable — at most
// two items per issuer, and filings limited to roughly a third of the column.
// Recency alone still puts a wall of 16:00 filings above the day's reporting,
// so the two streams are interleaved two-for-one instead of concatenated.
const FILING_SOURCES = new Set(["东方财富公告", "巨潮资讯"]);
const FILING_CATEGORIES = new Set(["公告", "财报"]);
const MAX_PER_ISSUER = 2;
const FILING_SHARE = 0.34;

function isFiling(item) {
  return item.kind === "announcement" || FILING_SOURCES.has(item.source) || FILING_CATEGORIES.has(item.category);
}

function composeColumn(items, limit) {
  const perIssuer = new Map();
  const filings = [];
  const reporting = [];
  const filingQuota = Math.max(8, Math.round(limit * FILING_SHARE));

  for (const item of items) {
    const match = String(item.title || "").match(/^([^:：]{2,12})[:：]/);
    if (match) {
      const seen = perIssuer.get(match[1]) ?? 0;
      if (seen >= MAX_PER_ISSUER) continue;
      perIssuer.set(match[1], seen + 1);
    }
    if (isFiling(item)) {
      if (filings.length < filingQuota) filings.push(item);
    } else {
      reporting.push(item);
    }
  }

  const out = [];
  let fi = 0;
  let ri = 0;
  while (out.length < limit && (ri < reporting.length || fi < filings.length)) {
    for (let n = 0; n < 2 && ri < reporting.length; n += 1) out.push(reporting[ri++]);
    if (fi < filings.length) out.push(filings[fi++]);
  }
  return out.slice(0, limit);
}

function renderNews() {
  if (!els.newsCnList || !els.newsGlobalList) return;
  const query = state.news.query.trim().toLowerCase();
  const scope = state.news.scope;
  const all = state.news.items || [];
  const matched = all.filter((item) => newsMatches(item, query));
  const cn = matched.filter((item) => regionOf(item) === "cn");
  const global = matched.filter((item) => regionOf(item) === "global");

  const cnShown = scope === "global" ? [] : composeColumn(cn, 80);
  const globalShown = scope === "cn" ? [] : composeColumn(global, 80);

  els.newsCnList.innerHTML = cnShown.length
    ? cnShown.map((item) => newsCard(item, query)).join("")
    : `<div class="empty-state">${scope === "global" ? "已筛选到海外视图" : "没有匹配的中国资讯"}</div>`;
  els.newsGlobalList.innerHTML = globalShown.length
    ? globalShown.map((item) => newsCard(item, query)).join("")
    : `<div class="empty-state">${scope === "cn" ? "已筛选到中国视图" : "没有匹配的海外资讯"}</div>`;

  if (els.newsCnCount) els.newsCnCount.textContent = `${cn.length} 条`;
  if (els.newsGlobalCount) els.newsGlobalCount.textContent = `${global.length} 条`;
  if (els.newsCount) {
    els.newsCount.textContent = query ? `匹配 ${matched.length} / ${all.length} 条` : `共 ${all.length} 条`;
  }
}

// --- sector news (板块消息面: 利好 / 利空) ----------------------------------

async function loadSectorNews() {
  if (!els.sectorNewsBoard || state.sectorNews.loading) return;
  state.sectorNews.loading = true;
  if (!state.sectorNews.data) els.sectorNewsBoard.innerHTML = `<div class="empty-state">正在按板块归集当日消息…</div>`;
  try {
    const data = await api("/api/sector-news?limit=31&samples=3");
    state.sectorNews.data = data;
    state.sectorNews.loaded = true;
  } catch (error) {
    els.sectorNewsBoard.innerHTML = `<div class="empty-state">板块消息面不可用：${escapeHtml(error.message)}</div>`;
  } finally {
    state.sectorNews.loading = false;
  }
  renderSectorNews();
}

function renderSectorNews() {
  if (!els.sectorNewsBoard) return;
  const data = state.sectorNews.data;
  if (!data) return;
  const sectors = Array.isArray(data.items) ? data.items : Array.isArray(data.sectors) ? data.sectors : [];
  const bullish = sectors.reduce((sum, entry) => sum + (Number(entry.bullish) || 0), 0);
  const bearish = sectors.reduce((sum, entry) => sum + (Number(entry.bearish) || 0), 0);
  if (els.sectorNewsCount) {
    const active = sectors.filter((entry) => entry.bullish || entry.bearish).length;
    els.sectorNewsCount.textContent = `${active} 个板块有信号 · 利好 ${bullish} / 利空 ${bearish}`;
  }
  if (!sectors.length) {
    els.sectorNewsBoard.innerHTML = `<div class="empty-state">今日还没有可归因到板块的消息。</div>`;
    return;
  }
  els.sectorNewsBoard.innerHTML = sectors
    .map((entry) => {
      const bull = Number(entry.bullish) || 0;
      const bear = Number(entry.bearish) || 0;
      const net = Number(entry.net) || 0;
      const total = bull + bear;
      const bullPct = total ? (bull / total) * 100 : 0;
      const bearPct = total ? 100 - bullPct : 0;
      const tone = net > 0.05 ? "up" : net < -0.05 ? "down" : "flat";
      const samples = (entry.samples || [])
        .map(
          (sample) => `
          <a title="${escapeHtml(sample.title || "")}">
            <span class="via">${escapeHtml(sample.category || "")}</span>${escapeHtml(sample.title || "")}
          </a>`
        )
        .join("");
      return `
        <article class="sector-card">
          <header class="sector-card-head">
            <span class="sector-card-name">${escapeHtml(entry.industry)}</span>
            <span class="sector-card-net ${tone}">${net > 0 ? "+" : ""}${net.toFixed(2)}</span>
          </header>
          <div class="sector-bar" title="利好 ${bull} · 利空 ${bear}">
            <i class="bull" style="width:${bullPct.toFixed(1)}%"></i>
            <i class="bear" style="width:${bearPct.toFixed(1)}%"></i>
          </div>
          <div class="sector-card-counts">
            <span class="sector-chip bull">利好 ${bull}</span>
            <span class="sector-chip bear">利空 ${bear}</span>
            ${entry.neutral ? `<span class="sector-chip neutral">中性 ${entry.neutral}</span>` : ""}
          </div>
          <div class="sector-samples">${samples || `<span class="via">无消息</span>`}</div>
        </article>`;
    })
    .join("");
}

// --- tomorrow outlook (明日参考) -------------------------------------------

async function loadOutlook() {
  if (!els.outlookScore || state.outlook.loading) return;
  state.outlook.loading = true;
  if (!state.outlook.data) {
    els.outlookSummary.textContent = "正在汇总当日新闻、海外市场、美债、商品与主力资金…";
    els.outlookScore.textContent = "—";
  }
  try {
    const data = await api("/api/outlook");
    state.outlook.data = data;
    state.outlook.loaded = true;
  } catch (error) {
    els.outlookSummary.textContent = `明日参考不可用：${error.message}`;
  } finally {
    state.outlook.loading = false;
  }
  renderOutlook();
}

function signedScore(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? "+" : ""}${number.toFixed(0)}`;
}

function outlookEntries(list, { showEffect = false } = {}) {
  if (!Array.isArray(list) || !list.length) return `<li class="empty-state small">无</li>`;
  return list
    .map((entry) => {
      if (typeof entry === "string") return `<li>${escapeHtml(entry)}</li>`;
      const effect = showEffect && entry.effect ? ` <span class="side-reason">${escapeHtml(entry.effect)}</span>` : "";
      return `<li>${escapeHtml(entry.label || "")}${entry.reason ? ` <span class="side-reason">${escapeHtml(entry.reason)}${effect}</span>` : effect}</li>`;
    })
    .join("");
}

/** 利好/利空 两侧列表：用 side-list 的既有样式（side-item / side-label / side-reason） */
function outlookSides(list) {
  if (!Array.isArray(list) || !list.length) return `<div class="empty-state small">无</div>`;
  return list
    .map(
      (entry) => `
      <div class="side-item">
        <span class="side-label">${escapeHtml(entry.label || "")}</span>
        <span class="side-reason">${escapeHtml(entry.reason || "")}</span>
      </div>`
    )
    .join("");
}

function renderOutlook() {
  const data = state.outlook.data;
  if (!data || !els.outlookScore) return;
  const tone = data.tone || "neutral";
  els.outlookScore.textContent = signedScore(data.score);
  els.outlookScore.className = `outlook-score ${tone}`;
  if (els.outlookBias) {
    els.outlookBias.textContent = data.bias || "—";
    els.outlookBias.className = `outlook-bias ${tone}`;
  }
  if (els.outlookConfidence) els.outlookConfidence.textContent = `置信度 ${data.confidence ?? "—"} · 一致性 ${((data.agreement ?? 0) * 100).toFixed(0)}%`;
  if (els.outlookForDate) els.outlookForDate.textContent = `${data.forDate || ""} 交易日参考`;
  if (els.outlookSummary) els.outlookSummary.textContent = data.note || "";

  if (els.outlookChips) {
    const chips = [];
    if (data.dataDate) chips.push(`数据基准 ${data.dataDate}`);
    if (Array.isArray(data.missing) && data.missing.length) chips.push(`缺 ${data.missing.map((item) => item.label).join("、")}`);
    els.outlookChips.innerHTML = chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join("");
  }

  if (els.outlookLogic) {
    els.outlookLogic.innerHTML = (data.logic || [])
      .map((step) => {
        const effectTone = step.effect === "利空" ? "down" : step.effect === "利好" ? "up" : "flat";
        return `
        <div class="logic-item ${effectTone}">
          <div class="logic-item-head">
            <span>${escapeHtml(step.title || "")}</span>
            <span>${escapeHtml(step.effect || "")}</span>
          </div>
          <div class="logic-item-chain">${escapeHtml(step.chain || "")}</div>
        </div>`;
      })
      .join("");
  }

  if (els.outlookTransmissions) {
    // The label must describe the effect on A-shares, not the raw move: a falling
    // dollar ("down") is bullish for metals, so printing 利空 there would be wrong.
    const moveText = (value) => (value === "up" ? "上行" : value === "down" ? "下行" : "");
    const rows = (data.transmissions || [])
      .map((item) => {
        const bull = item.bullish?.length || 0;
        const bear = item.bearish?.length || 0;
        const net = bull - bear;
        const effect = net > 0 ? "利多" : net < 0 ? "利空" : "中性";
        const move = moveText(item.direction);
        const tag = (name, names) => `<div class="row"><span class="tag">${name}</span><span>${names.map(escapeHtml).join("、")}</span></div>`;
        return `
          <div class="transmission-item">
            <div class="transmission-reason">${escapeHtml(item.label || "")}${move ? ` ${move}` : ""}（权重 ${item.weight ?? 0}）· ${effect} — ${escapeHtml(item.reason || "")}</div>
            <div class="transmission-rows">
              ${bull ? tag("利好", item.bullish) : ""}
              ${bear ? tag("利空", item.bearish) : ""}
            </div>
          </div>`;
      })
      .join("");
    els.outlookTransmissions.innerHTML = rows || `<div class="empty-state small">数据不足，未形成传导链</div>`;
  }

  if (els.outlookBullish) els.outlookBullish.innerHTML = outlookSides(data.bullish);
  if (els.outlookBearish) els.outlookBearish.innerHTML = outlookSides(data.bearish);
  if (els.outlookRisks) els.outlookRisks.innerHTML = outlookEntries(data.risks);
  if (els.outlookWatch) {
    els.outlookWatch.innerHTML = (data.watch || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("") || `<li class="empty-state small">无</li>`;
  }

  if (els.outlookInputs) {
    const drivers = Array.isArray(data.drivers) ? data.drivers : [];
    els.outlookInputs.innerHTML = drivers
      .map(
        (driver) => `
        <div class="input-cell">
          <div class="k">${escapeHtml(driver.label || "")}</div>
          <div class="v">${escapeHtml(driver.rawText || "—")}</div>
          <div class="d">${escapeHtml(driver.effect || "")}</div>
        </div>`
      )
      .join("");
    if (els.outlookInputsTime) {
      const inputs = data.inputs || {};
      els.outlookInputsTime.textContent = inputs.flowDate ? `资金 ${inputs.flowDate} · 生成于 ${timeLabel(data.generatedAt)}` : `生成于 ${timeLabel(data.generatedAt)}`;
    }
  }
  if (els.outlookNote) els.outlookNote.textContent = data.note || "";
}

async function refreshWatchlist() {
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
  if (els.watchCount) els.watchCount.textContent = state.watchlist.size ? `${state.watchlist.size} 只` : "";
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

  // --- chart type controls ---
  els.chartTypeSegment?.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.chartType === state.chart.type);
    button.addEventListener("click", () => {
      els.chartTypeSegment.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.chart.type = button.dataset.chartType;
      localStorage.setItem("stockradar-chart-type", state.chart.type);
      paintChart();
    });
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
      state.chart.from = null;
      state.chart.to = null;
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
    els.chartEmpty.hidden = false;
    els.chartEmpty.textContent = "从下方列表选择一只股票，或直接搜索代码开始看盘";
    state.chart.payload = null;
    state.chart.code = null;
    if (els.chartLegend) els.chartLegend.innerHTML = "";
  });

  els.chartReset?.addEventListener("click", () => {
    state.chart.hover = null;
    state.chart.from = null;
    state.chart.to = null;
    paintChart();
  });

  // --- crosshair ------------------------------------------------------------
  let hoverFrame = 0;
  els.priceChart?.addEventListener("mousemove", (event) => {
    if (state.chart.drag) return;
    const geometry = state.chart.geometry;
    if (!geometry) return;
    const rect = els.priceChart.getBoundingClientRect();
    const index = Math.floor((event.clientX - rect.left - geometry.offsetLeft) / geometry.slot);
    const clamped = Math.min(Math.max(index, 0), geometry.count - 1);
    if (clamped === state.chart.hover) return;
    state.chart.hover = clamped;
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      paintChart();
    });
  });

  els.priceChart?.addEventListener("mouseleave", () => {
    if (state.chart.hover === null) return;
    state.chart.hover = null;
    paintChart();
  });

  // --- wheel zoom (anchored at the cursor) ----------------------------------
  els.priceChart?.addEventListener(
    "wheel",
    (event) => {
      if (!state.chart.payload) return;
      event.preventDefault();
      const geometry = state.chart.geometry;
      if (!geometry) return;
      const rect = els.priceChart.getBoundingClientRect();
      const ratio = Math.min(
        Math.max((event.clientX - rect.left - geometry.offsetLeft) / Math.max(geometry.slot * geometry.count, 1), 0),
        1
      );
      const span = geometry.to - geometry.from;
      const zoom = event.deltaY > 0 ? 1.18 : 1 / 1.18;
      const nextSpan = Math.min(Math.max(Math.round(span * zoom), 12), geometry.total);
      const anchor = geometry.from + span * ratio;
      const next = clampWindow(Math.round(anchor - nextSpan * ratio), Math.round(anchor - nextSpan * ratio) + nextSpan);
      state.chart.from = next.from;
      state.chart.to = next.to;
      state.chart.hover = null;
      paintChart();
    },
    { passive: false }
  );

  // --- drag to pan ----------------------------------------------------------
  els.priceChart?.addEventListener("pointerdown", (event) => {
    if (!state.chart.payload) return;
    els.priceChart.setPointerCapture?.(event.pointerId);
    state.chart.drag = { x: event.clientX, from: state.chart.from, to: state.chart.to };
    els.priceChart.style.cursor = "grabbing";
  });

  els.priceChart?.addEventListener("pointermove", (event) => {
    const drag = state.chart.drag;
    const geometry = state.chart.geometry;
    if (!drag || !geometry) return;
    const shift = Math.round((drag.x - event.clientX) / Math.max(geometry.slot, 0.5));
    if (!shift) return;
    const span = drag.to - drag.from;
    const next = clampWindow(drag.from + shift, drag.from + shift + span);
    state.chart.from = next.from;
    state.chart.to = next.to;
    state.chart.hover = null;
    paintChart();
  });

  const endDrag = () => {
    if (!state.chart.drag) return;
    state.chart.drag = null;
    if (els.priceChart) els.priceChart.style.cursor = "";
  };
  els.priceChart?.addEventListener("pointerup", endDrag);
  els.priceChart?.addEventListener("pointercancel", endDrag);

  els.priceChart?.addEventListener("dblclick", () => {
    state.chart.hover = null;
    state.chart.from = null;
    state.chart.to = null;
    paintChart();
  });

  window.addEventListener("resize", debounce(() => paintChart(), 160));

  // --- vertical tab rail ---
  els.tabRail?.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });

  // --- capital flow controls ---
  const bindSegment = (segment, attribute, onChange) => {
    segment?.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        segment.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        onChange(button.dataset[attribute]);
      });
    });
  };

  // Reflect a persisted choice back onto its segment (segments default to the
  // first button, so a restored 近 60 日 window would otherwise look unselected).
  const paintSegment = (segment, attribute, value) => {
    segment?.querySelectorAll("button").forEach((button) => {
      button.classList.toggle("active", String(button.dataset[attribute]) === String(value));
    });
  };

  bindSegment(els.flowScopeSegment, "flowScope", (value) => {
    state.flow.scope = value;
    localStorage.setItem("stockradar-flow-scope", value);
    state.flow.data = null;
    reloadFlow();
  });

  bindSegment(els.flowSideSegment, "flowSide", (value) => {
    state.flow.side = value;
    localStorage.setItem("stockradar-flow-side", value);
    state.flow.data = null;
    reloadFlow();
  });

  bindSegment(els.flowWindowSegment, "flowWindow", (value) => {
    const w = Number(value);
    state.flow.w = Number.isFinite(w) && w > 0 ? w : 1;
    localStorage.setItem("stockradar-flow-window", String(state.flow.w));
    state.flow.data = null;
    reloadFlow();
  });

  els.flowBody?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-code]");
    if (row) selectStock(row.dataset.code);
  });

  // --- news + keyword search ---
  paintSegment(els.flowScopeSegment, "flowScope", state.flow.scope);
  paintSegment(els.flowSideSegment, "flowSide", state.flow.side);
  paintSegment(els.flowWindowSegment, "flowWindow", state.flow.w);

  bindSegment(els.newsScopeSegment, "newsScope", (value) => {
    state.news.scope = value;
    renderNews();
  });

  const runNewsSearch = debounce((value) => {
    state.news.query = value;
    renderNews();
  }, 160);

  els.newsSearchInput?.addEventListener("input", (event) => runNewsSearch(event.target.value));
  els.newsSearchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      els.newsSearchInput.value = "";
      runNewsSearch("");
    }
  });
  paintSegment(els.newsScopeSegment, "newsScope", state.news.scope);
}

async function init() {
  els.dataStatus.textContent = "加载市场数据中";
  applyTheme(state.theme);
  showTab(state.tab || "stocks");
  await Promise.all([reloadOverview(), reloadForecast(), reloadSignals(), reloadStocks(), reloadRadar()]);
  refreshWatchlist();
  if (state.tab === "flow") reloadFlow();
  if (state.tab === "news") reloadNews();
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
