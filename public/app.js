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
  theme: localStorage.getItem("stockradar-theme") || "light",
  watchlist: new Set(JSON.parse(localStorage.getItem("stockradar-watchlist") || "[]"))
};

const els = {
  overview: document.querySelector("#overview"),
  boardList: document.querySelector("#boardList"),
  watchlist: document.querySelector("#watchlist"),
  stockRows: document.querySelector("#stockRows"),
  resultCount: document.querySelector("#resultCount"),
  loadMoreButton: document.querySelector("#loadMoreButton"),
  searchInput: document.querySelector("#searchInput"),
  sortSelect: document.querySelector("#sortSelect"),
  exchangeSegment: document.querySelector("#exchangeSegment"),
  signalList: document.querySelector("#signalList"),
  detailPanel: document.querySelector("#detailPanel"),
  forecastPanel: document.querySelector("#forecastPanel"),
  dataStatus: document.querySelector("#dataStatus"),
  refreshButton: document.querySelector("#refreshButton"),
  themeToggle: document.querySelector("#themeToggle")
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
  renderWatchlist();
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

function renderRows(append = false) {
  const html = state.rows
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

function renderWatchlist() {
  const watched = state.rows.filter((stock) => state.watchlist.has(stock.code));
  const missing = [...state.watchlist].filter((code) => !watched.some((stock) => stock.code === code));

  if (!watched.length && !missing.length) {
    els.watchlist.innerHTML = `<div class="empty-state">暂无自选</div>`;
    return;
  }

  els.watchlist.innerHTML = [
    ...watched.map(
      (stock) => `
        <div class="watch-item" data-code="${stock.code}">
          <div>
            <div class="stock-name">${stock.name}</div>
            <div class="stock-code">${stock.code} · ${stock.board}</div>
          </div>
          <div class="${toneClass(stock.changePct)}">${signed(stock.changePct, "%")}</div>
        </div>
      `
    ),
    ...missing.map(
      (code) => `
        <div class="watch-item" data-code="${code}">
          <div>
            <div class="stock-name">${code}</div>
            <div class="stock-code">未在当前筛选结果</div>
          </div>
          <div class="neutral">自选</div>
        </div>
      `
    )
  ].join("");

  els.watchlist.querySelectorAll(".watch-item").forEach((item) => {
    item.addEventListener("click", () => selectStock(item.dataset.code));
  });
}

async function selectStock(code) {
  state.selectedCode = code;
  renderRows();
  const stock = await api(`/api/stocks/${code}`);
  renderDetail(stock);
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
  state.rows = append ? [...state.rows, ...data.items] : data.items;
  state.offset = state.rows.length;
  renderRows(append);
  renderWatchlist();
}

function debounce(fn, delay = 220) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function bindEvents() {
  els.searchInput.addEventListener(
    "input",
    debounce((event) => {
      state.query = event.target.value;
      reloadStocks();
    })
  );

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

  els.refreshButton.addEventListener("click", () => {
    init();
  });

  els.themeToggle.addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
    if (state.selectedCode) selectStock(state.selectedCode);
  });
}

async function init() {
  els.dataStatus.textContent = "加载市场数据中";
  applyTheme(state.theme);
  await Promise.all([reloadOverview(), reloadForecast(), reloadSignals(), reloadStocks()]);
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
