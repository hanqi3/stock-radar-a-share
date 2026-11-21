// Read-only data layer for the GitHub Pages build.
//
// The public/javascript app is built against a JSON API, so instead of rewriting
// the UI this file intercepts window.fetch for /api/* and answers from the static
// bundle produced by scripts/build-static-data.mjs. Everything is read-only
// except the watchlist, which stays in localStorage on the visitor's device.
(function () {
  if (!window.STATIC_SITE) return;

  const DATA = window.STATIC_DATA_BASE || "static-data";
  const WATCHLIST_KEY = "stockradar-watchlist";
  const nativeFetch = window.fetch.bind(window);
  const cache = new Map();

  function load(name) {
    if (!cache.has(name)) {
      const request = nativeFetch(`${DATA}/${name}`).then((response) => {
        if (!response.ok) throw new Error(`${name} -> HTTP ${response.status}`);
        return response.json();
      }).catch((error) => {
        cache.delete(name);
        throw error;
      });
      cache.set(name, request);
    }
    return cache.get(name);
  }

  function reply(status, payload) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const replyOk = (payload) => reply(200, payload);
  const replyMissing = (message) => reply(404, { error: message, code: "static" });

  function localWatchlist() {
    try {
      const parsed = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((code) => /^\d{6}$/.test(code)) : [];
    } catch {
      return [];
    }
  }

  function saveWatchlist(codes) {
    const clean = [...new Set((codes || []).filter((code) => /^\d{6}$/.test(code)))].slice(0, 200);
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(clean));
    return clean;
  }

  function stockPage(rows, meta, params) {
    const query = (params.get("q") || "").trim().toLowerCase();
    const exchange = params.get("exchange");
    const board = params.get("board");
    const signal = params.get("signal");
    const sort = params.get("sort") || "score";

    let result = rows;
    if (query) {
      result = result.filter((row) => {
        const haystack = `${row.code} ${row.name} ${row.exchange} ${row.board}`.toLowerCase();
        return haystack.includes(query);
      });
    }
    if (exchange && exchange !== "ALL") result = result.filter((row) => row.exchange === exchange);
    if (board && board !== "ALL") result = result.filter((row) => row.board === board);
    if (signal && signal !== "ALL") result = result.filter((row) => row.signalType === signal);

    const sorters = {
      score: (a, b) => (a.rank || 0) - (b.rank || 0),
      change: (a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity),
      decline: (a, b) => (a.changePct ?? Infinity) - (b.changePct ?? Infinity),
      amount: (a, b) => (b.amount || 0) - (a.amount || 0),
      turnover: (a, b) => (b.turnover || 0) - (a.turnover || 0),
      cap: (a, b) => (b.marketCap || 0) - (a.marketCap || 0),
      code: (a, b) => a.code.localeCompare(b.code)
    };
    result = [...result].sort(sorters[sort] || sorters.score);

    const limit = Math.min(Math.max(Number(params.get("limit")) || 100, 1), 500);
    const offset = Math.max(Number(params.get("offset")) || 0, 0);
    return {
      items: result.slice(offset, offset + limit),
      total: result.length,
      limit,
      offset,
      meta
    };
  }

  async function handle(pathname, params, method, body) {
    if (pathname.startsWith("/api/auth/")) {
      return reply(401, { error: "静态演示版没有账号系统", code: "static" });
    }

    if (pathname === "/api/health") {
      const manifest = await load("manifest.json");
      return replyOk({ ok: true, static: true, dataUpdatedAt: manifest.dataUpdatedAt });
    }

    if (pathname === "/api/static/manifest") {
      return replyOk(await load("manifest.json"));
    }

    const fixed = {
      "/api/overview": "overview.json",
      "/api/forecast": "forecast.json",
      "/api/indices": "indices.json",
      "/api/alerts": "alerts.json",
      "/api/briefing": "briefing.json",
      "/api/briefing/overseas": "briefing-overseas.json",
      "/api/news": "news.json",
      "/api/sector-news": "sector-news.json",
      "/api/outlook": "outlook.json"
    };
    if (fixed[pathname]) {
      const payload = await load(fixed[pathname]);
      if (pathname === "/api/news" && Array.isArray(payload.items)) {
        const limit = Math.min(Number(params.get("limit")) || 60, 900);
        return replyOk({ ...payload, items: payload.items.slice(0, limit) });
      }
      return replyOk(payload);
    }

    if (pathname === "/api/signals") {
      const payload = await load("signals.json");
      const limit = Math.min(Number(params.get("limit")) || 60, 200);
      return replyOk({ ...payload, items: (payload.items || []).slice(0, limit) });
    }

    if (pathname === "/api/search") {
      const query = (params.get("q") || "").trim().toLowerCase();
      const limit = Math.min(Number(params.get("limit")) || 10, 50);
      if (!query) return replyOk({ query: "", items: [], count: 0, limit });
      const { rows } = await load("stocks.json");
      const items = rows
        .filter((row) => `${row.code}${row.name}`.toLowerCase().includes(query) || row.name.toLowerCase().includes(query))
        .slice(0, limit)
        .map((row) => ({
          code: row.code,
          name: row.name,
          board: row.board,
          price: row.price,
          changePct: row.changePct
        }));
      return replyOk({ query, items, count: items.length, limit });
    }

    if (pathname === "/api/stocks") {
      const { rows, meta } = await load("stocks.json");
      return replyOk(stockPage(rows, meta, params));
    }

    const analysis = pathname.match(/^\/api\/stocks\/(\d{6})\/analysis$/);
    if (analysis) {
      try {
        return replyOk(await load(`analysis/${analysis[1]}.json`));
      } catch {
        return reply(404, {
          error: "静态演示版只内置了部分个股的 K 线，可以试试 600519 贵州茅台，或在搜索里换一只。",
          code: "static-no-analysis"
        });
      }
    }

    const detail = pathname.match(/^\/api\/stocks\/(\d{6})$/);
    if (detail) {
      const code = detail[1];
      const [details, stocks] = await Promise.all([load("details.json"), load("stocks.json")]);
      const row = stocks.rows.find((item) => item.code === code);
      if (!row) return replyMissing("没有这只股票");
      return replyOk({ ...row, ...(details[code] || {}) });
    }

    if (pathname === "/api/watchlist/news") {
      return replyOk({ items: [], codes: localWatchlist() });
    }

    if (pathname === "/api/watchlist") {
      if (method === "PUT" || method === "POST") {
        const codes = saveWatchlist(body?.codes);
        return replyOk({ updatedAt: new Date().toISOString(), codes, rejected: 0, truncated: false });
      }
      const codesParam = params.get("codes");
      if (codesParam) {
        const wanted = codesParam.split(",").map((code) => code.trim()).filter(Boolean);
        const { rows } = await load("stocks.json");
        const items = wanted
          .map((code) => rows.find((row) => row.code === code))
          .filter(Boolean);
        return replyOk({ items, codes: wanted, updatedAt: new Date().toISOString() });
      }
      return replyOk({ codes: localWatchlist(), updatedAt: new Date().toISOString() });
    }

    if (pathname === "/api/flow") {
      const scope = params.get("scope") || "stock";
      const side = params.get("side") || "inflow";
      const window = params.get("w") || "1";
      const file = `flow/${scope}-${side}-${window}.json`;
      try {
        const payload = await load(file);
        const query = (params.get("q") || "").trim().toLowerCase();
        const limit = Math.min(Number(params.get("limit")) || 60, 200);
        if (!query) return replyOk(payload);
        const items = (payload.items || [])
          .filter((item) => `${item.code || ""}${item.name || ""}`.toLowerCase().includes(query))
          .slice(0, limit);
        return replyOk({ ...payload, items });
      } catch {
        return replyMissing("这个资金流组合没有预生成");
      }
    }

    if (pathname === "/api/backtest") {
      return reply(422, {
        error: "静态演示版不带回测，部署带 Node 的版本即可使用。",
        code: "static"
      });
    }

    return replyMissing(`静态演示版没有 ${pathname} 这个接口`);
  }

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    if (!url) return nativeFetch(input, init);
    let parsed;
    try {
      parsed = new URL(url, window.location.href);
    } catch {
      return nativeFetch(input, init);
    }
    if (!parsed.pathname.startsWith("/api/")) return nativeFetch(input, init);

    const method = (init?.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    let body = null;
    if (typeof init?.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    try {
      return await handle(parsed.pathname, parsed.searchParams, method, body);
    } catch (error) {
      return reply(500, { error: String(error?.message || error) });
    }
  };
})();
