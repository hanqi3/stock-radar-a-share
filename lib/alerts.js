// Overnight macro alerts for the top bar.
//
// The dashboard is a post-close review tool, so the only thing worth pushing at
// the top of the page is the overnight backdrop that changed enough to move the
// A-share open: US rates, the Fed, volatility, the US indices, oil and the RMB.
// Everything here is a pure function of the committed data files; there is no
// live feed and no notification transport.

export const ALERT_LIMIT = 3;

const RULES = [
  {
    key: "fed",
    // The macro file names the series `fedfunds`, not `fed`.
    symbol: "fedfunds",
    // A Fed move is the one truly scheduled macro event, so it outranks the rest.
    severity: 100,
    tone: (item) => (item.change > 0 ? "negative" : "positive"),
    test: (item) => Number.isFinite(item.changeBp) && item.changeBp !== 0,
    title: (item) => `美联储利率 ${item.changeBp > 0 ? "上调" : "下调"} ${Math.abs(item.changeBp)}bp`,
    detail: (item) =>
      item.changeBp > 0
        ? `联邦基金有效利率升至 ${item.value}%，全球风险资产的贴现率同步抬升，A 股成长板块明日开盘承压。`
        : `联邦基金有效利率降至 ${item.value}%，贴现率压力缓解，A 股成长板块明日开盘偏有利。`
  },
  {
    key: "us10y",
    severity: 80,
    tone: (item) => (item.changeBp > 0 ? "negative" : "positive"),
    test: (item) => Number.isFinite(item.changeBp) && Math.abs(item.changeBp) >= 8,
    title: (item) => `10年期美债 ${item.value}%（${item.changeBp > 0 ? "↑" : "↓"}${Math.abs(item.changeBp)}bp）`,
    detail: (item) =>
      item.changeBp > 0
        ? "长端收益率跳升，外资定价的成长股估值压力变大，重点看明日创业板与科创50的分歧。"
        : "长端收益率回落，外资定价的成长股估值压力缓解，明日对科技成长更友好。"
  },
  {
    key: "vix",
    severity: 60,
    tone: (item) => (item.changePct > 0 ? "negative" : "positive"),
    test: (item) => Number.isFinite(item.changePct) && Math.abs(item.changePct) >= 12,
    title: (item) => `VIX ${item.value}（${item.changePct > 0 ? "跳升" : "回落"} ${Math.abs(item.changePct).toFixed(1)}%）`,
    detail: (item) =>
      item.changePct > 0
        ? "波动率明显抬升，隔夜风险偏好收缩，明日开盘容易被情绪主导，避免追高。"
        : "波动率回落，隔夜风险偏好修复，明日承接意愿通常更好。"
  },
  {
    key: "sox",
    severity: 55,
    tone: (item) => (item.changePct > 0 ? "positive" : "negative"),
    test: (item) => Number.isFinite(item.changePct) && Math.abs(item.changePct) >= 3,
    title: (item) => `费城半导体 ${signedPct(item.changePct)}`,
    detail: () => "半导体是全球科技股的领先指标，A 股电子、算力板块明日多半跟随这个方向。"
  },
  {
    key: "nasdaq",
    severity: 50,
    tone: (item) => (item.changePct > 0 ? "positive" : "negative"),
    test: (item) => Number.isFinite(item.changePct) && Math.abs(item.changePct) >= 1.5,
    title: (item) => `纳斯达克 ${signedPct(item.changePct)}`,
    detail: () => "隔夜美股科技股的方向决定明日 A 股风险偏好的起点。"
  },
  {
    key: "brent",
    severity: 45,
    tone: (item) => (item.changePct > 0 ? "neutral" : "positive"),
    test: (item) => Number.isFinite(item.changePct) && Math.abs(item.changePct) >= 3,
    title: (item) => `布伦特原油 ${signedPct(item.changePct)}`,
    detail: (item) =>
      item.changePct > 0
        ? "油价大涨，利好上游油气煤炭，同时压制交运与化工的成本端。"
        : "油价回落，交运与化工的成本压力缓解。"
  },
  {
    key: "dxy",
    severity: 40,
    tone: (item) => (item.changePct > 0 ? "negative" : "positive"),
    test: (item) => Number.isFinite(item.changePct) && Math.abs(item.changePct) >= 0.8,
    title: (item) => `美元指数 ${item.value}（${signedPct(item.changePct)}）`,
    detail: (item) =>
      item.changePct > 0
        ? "美元走强，人民币资产与有色金属承压。"
        : "美元走弱，人民币资产与以美元计价的资源品受益。"
  },
  {
    key: "a50",
    severity: 70,
    tone: (item) => (item.changePct > 0 ? "positive" : "negative"),
    test: (item) => Number.isFinite(item.changePct) && Math.abs(item.changePct) >= 1,
    title: (item) => `富时中国A50期货 ${signedPct(item.changePct)}`,
    detail: () => "A50 期货是外资对 A 股开盘的直接定价，明日蓝筹多半跟着这个方向开。"
  },
  {
    key: "cnh",
    severity: 35,
    tone: (item) => (item.changePct > 0 ? "negative" : "positive"),
    test: (item) => Number.isFinite(item.changePct) && Math.abs(item.changePct) >= 0.3,
    title: (item) => `离岸人民币 ${item.value}（${signedPct(item.changePct)}）`,
    detail: (item) =>
      item.changePct > 0
        ? "人民币走弱，外资偏谨慎，北向风格资产承压。"
        : "人民币走强，外资流入预期改善。"
  }
];

function signedPct(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function indexMap(indices) {
  const map = new Map();
  const items = indices?.items ?? indices ?? [];
  for (const item of items) {
    if (item?.name) map.set(item.name, item);
  }
  return map;
}

/**
 * Turns the committed macro and index snapshots into at most `limit` alerts.
 * Returns `[]` when nothing moved enough to be worth a banner.
 */
export function buildAlerts({ macro, indices, now = new Date(), limit = ALERT_LIMIT } = {}) {
  const macroItems = new Map((macro?.items ?? []).map((item) => [item.symbol, item]));
  const indexItems = indexMap(indices);
  const found = [];

  for (const rule of RULES) {
    const source =
      rule.key === "sox"
        ? indexItems.get("费城半导体")
        : rule.key === "nasdaq"
          ? indexItems.get("纳斯达克")
          : rule.key === "brent"
            ? indexItems.get("布伦特原油")
            : rule.key === "dxy"
              ? indexItems.get("美元指数")
              : rule.key === "a50"
                ? indexItems.get("富时中国A50期货")
                : rule.key === "cnh"
                  ? indexItems.get("离岸人民币")
                  : macroItems.get(rule.symbol ?? rule.key);
    if (!source || !rule.test(source)) continue;
    // Index moves carry changePct; a small move is scaled by its threshold so
    // that a 4% Nasdaq drop outranks a 1.6% one inside the same rule family.
    const magnitude = Math.abs(source.changePct ?? source.changeBp ?? 0);
    found.push({
      key: rule.key,
      tone: rule.tone(source),
      title: rule.title(source),
      detail: rule.detail(source),
      severity: rule.severity + Math.min(20, magnitude)
    });
  }

  found.sort((a, b) => b.severity - a.severity);
  const items = found.slice(0, limit).map(({ severity, ...item }) => item);
  if (!items.length) return [];
  return items;
}

/** One-line summary used as the banner's accessible label and the push body. */
export function formatAlerts(items, date) {
  if (!items?.length) return "";
  const head = `【${date || ""} 隔夜宏观】`;
  return head + items.map((item) => `${item.title}`).join(" · ");
}
