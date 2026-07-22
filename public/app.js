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
  dataStatus: document.querySelector("#dataStatus"),
  refreshButton: document.querySelector("#refreshButton")
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
      </div>
      <div class="narrative">${stock.narrative}</div>
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

  ctx.fillStyle = "#fbfcff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#d9e1ec";
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
}

async function init() {
  els.dataStatus.textContent = "加载市场数据中";
  await Promise.all([reloadOverview(), reloadSignals(), reloadStocks()]);
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
