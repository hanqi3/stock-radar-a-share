// Turning the on-screen 异动信号 into something that can leave the page.
//
// The dashboard already ranks every stock by its anomaly score, but that list
// only exists while the tab is open. A digest is a small, stable snapshot of the
// same ranking so a scheduled job can push it to a chat webhook and the next
// evening can say which names are new.
//
// It deliberately carries no recommendation: the score is a "how unusual", not a
// "buy" signal, and the message says so.

export const DIGEST_LIMIT = 8;

const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

/**
 * @param {object} briefing The payload served by /api/briefing.
 */
export function buildDigest(briefing, { limit = DIGEST_LIMIT } = {}) {
  if (!briefing) return null;
  const items = (briefing.anomalies || []).slice(0, limit).map((item) => ({
    code: item.code,
    name: item.name,
    changePct: round(item.changePct),
    anomalyScore: round(item.anomalyScore),
    trendScore: round(item.trendScore),
    signalType: item.signalType ?? null
  }));
  const date = briefing.generatedAt ? String(briefing.generatedAt).slice(0, 10) : (briefing.date ?? null);
  const overview = briefing.overview || {};
  return {
    date,
    generatedAt: new Date().toISOString(),
    limitUpCount: briefing.limitUpCount ?? 0,
    limitDownCount: briefing.limitDownCount ?? 0,
    advancers: overview.advancers ?? null,
    decliners: overview.decliners ?? null,
    items
  };
}

/** Dates and codes of the previous digest, so a push can mark what is new. */
export function previousCodes(store) {
  const previous = store?.previous;
  if (!previous || !Array.isArray(previous.codes)) return { date: null, codes: new Set() };
  return { date: previous.date ?? null, codes: new Set(previous.codes) };
}

/**
 * Fold today's digest into the store, keeping yesterday's codes only as a
 * reference set. Re-running on the same date refreshes the items but must not
 * erase what "new since" is measured against.
 */
export function mergeDigest(store, digest) {
  const base = store && typeof store === "object" ? store : {};
  if (!digest) return base;
  const sameDay = base.date === digest.date;
  const previous = sameDay
    ? base.previous ?? null
    : base.date
      ? { date: base.date, codes: (base.items || []).map((item) => item.code) }
      : null;
  return { ...digest, previous };
}

/** @returns {Set<string>} codes that were not in the previous digest. */
export function newCodes(store) {
  const previous = previousCodes(store);
  return new Set((store?.items || []).map((item) => item.code).filter((code) => !previous.codes.has(code)));
}

export function digestChanged(a, b) {
  const strip = (value) => {
    if (!value) return null;
    const { generatedAt, ...rest } = value;
    return JSON.stringify(rest);
  };
  return strip(a) !== strip(b);
}

/**
 * Plain text, because it has to survive being pasted into 飞书 / 企业微信 /
 * Slack without a markdown renderer.
 */
export function formatDigest(store) {
  if (!store || !store.items?.length) return null;
  const fresh = store.previous?.date ? newCodes(store) : new Set();
  const lines = [];
  const breadth =
    Number.isFinite(store.advancers) && Number.isFinite(store.decliners) ? ` · 上涨 ${store.advancers} / 下跌 ${store.decliners}` : "";
  lines.push(`【${store.date ?? "—"} 异动信号】涨停 ${store.limitUpCount ?? 0} · 跌停 ${store.limitDownCount ?? 0}${breadth}`);
  lines.push("");
  for (const item of store.items) {
    const marker = fresh.has(item.code) ? " 🆕" : "";
    const change = Number.isFinite(item.changePct) ? `${item.changePct > 0 ? "+" : ""}${item.changePct}%` : "—";
    lines.push(`${item.name} ${item.code} ${change} · 异动 ${item.anomalyScore ?? "—"} · ${item.signalType ?? "异动关注"}${marker}`);
  }
  if (store.previous?.date) lines.push("", `🆕 = 相对 ${store.previous.date} 新进榜`);
  lines.push("", "异动分衡量的是「程度有多不寻常」，不是买卖建议。数据为收盘后复盘，非实时行情。");
  return lines.join("\n");
}
