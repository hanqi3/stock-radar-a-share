// Board classification and A-share price-limit rules.
//
// The original radar treated "limit up" as changePct >= 9.8 for every stock,
// which is only correct on the main boards. The real rules are:
//
//   沪市主板  (SH 600/601/603/605)   ±10%
//   深市主板  (SZ 000/001/002/003)   ±10%
//   ST / *ST on a main board          ±5%
//   创业板    (SZ 300/301)            ±20%
//   科创板    (SH 688/689)            ±20%
//   北交所    (BJ 4xx/8xx/9xx)        ±30%
//
// New listings are special: a main-board debut is capped at +44% / -36%, while
// 创业板 / 科创板 are uncapped for the first 5 sessions and 北交所 for the
// first session. We treat an unknown listing age as "seasoned" so the default
// path stays conservative.

export const BOARD_SH_MAIN = "沪市主板";
export const BOARD_SZ_MAIN = "深市主板";
export const BOARD_CHINEXT = "创业板";
export const BOARD_STAR = "科创板";
export const BOARD_BSE = "北交所";
export const BOARD_UNKNOWN = "未分类";

export const EXCHANGE_SZ = "SZ";
export const EXCHANGE_BJ = "BJ";
export const EXCHANGE_SH = "SH";

export function inferExchange(code) {
  const value = String(code || "").padStart(6, "0");
  if (/^(600|601|603|605|688|689)/.test(value)) return EXCHANGE_SH;
  if (/^(000|001|002|003|300|301|302)/.test(value)) return EXCHANGE_SZ;
  if (/^(4|8|9)/.test(value)) return EXCHANGE_BJ;
  return EXCHANGE_SH;
}

export function inferBoard(code, exchange = inferExchange(code)) {
  const value = String(code || "").padStart(6, "0");
  if (exchange === EXCHANGE_BJ) return BOARD_BSE;
  if (/^(688|689)/.test(value)) return BOARD_STAR;
  if (/^(300|301)/.test(value)) return BOARD_CHINEXT;
  if (exchange === EXCHANGE_SH) return BOARD_SH_MAIN;
  if (exchange === EXCHANGE_SZ) return BOARD_SZ_MAIN;
  return BOARD_UNKNOWN;
}

// ST / *ST / 退市整理期 names are monitored separately because their daily
// band is narrower (main boards) or unchanged (创业板/科创板/北交所).
export function isRiskWarned(name) {
  const text = String(name || "").toUpperCase();
  return text.includes("ST") || text.includes("退");
}

export function isSt(name) {
  const text = String(name || "").toUpperCase();
  return /^\*?ST/.test(text) || text.startsWith("SST") || text.startsWith("S*ST");
}

/**
 * Daily price-limit percentage for one stock.
 * `listingDays` is optional; when it is a number and small the new-listing
 * exemption is applied instead of a fixed band.
 */
export function limitPctFor(stock = {}) {
  const exchange = stock.exchange || inferExchange(stock.code);
  const board = stock.board || inferBoard(stock.code, exchange);
  const { listingDays } = stock;

  if (Number.isFinite(listingDays)) {
    if (listingDays <= 5 && (board === BOARD_CHINEXT || board === BOARD_STAR)) return null;
    if (listingDays <= 1 && board === BOARD_BSE) return null;
    if (listingDays <= 1 && (board === BOARD_SH_MAIN || board === BOARD_SZ_MAIN)) {
      // Main-board debut: asymmetric +44% / -36%; callers that need a single
      // number get the upside cap.
      return 44;
    }
  }

  if (board === BOARD_BSE) return 30;
  if (board === BOARD_CHINEXT || board === BOARD_STAR) return 20;
  if (isSt(stock.name)) return 5;
  return 10;
}

/** Round a limit price the way the exchange does (2 decimals, half-up). */
export function limitPrice(prevClose, pct) {
  if (!Number.isFinite(prevClose) || !Number.isFinite(pct)) return null;
  return Math.round(prevClose * (1 + pct / 100) * 100) / 100;
}

/**
 * Exact limit-up / limit-down detection from a live quote.
 * The snapshot has no previous close, so we derive it from price and changePct,
 * then confirm against the board-specific band. This is what makes a 20% board
 * or a 30% BSE stock classify correctly.
 */
export function limitState(stock = {}) {
  const price = stock.price;
  const changePct = stock.changePct;
  const pct = limitPctFor(stock);

  if (pct === null) {
    return { pct: null, capped: false, limitUp: false, limitDown: false, reason: "上市初期无涨跌幅限制" };
  }
  if (!Number.isFinite(price) || !Number.isFinite(changePct)) {
    // Fall back to a band comparison when the price is missing.
    return {
      pct,
      capped: true,
      limitUp: changePct >= pct - 0.2,
      limitDown: changePct <= -(pct - 0.2),
      reason: `无有效价格，按 ${pct}% 带宽近似判断`
    };
  }

  const prevClose = price / (1 + changePct / 100);
  const up = limitPrice(prevClose, pct);
  const down = limitPrice(prevClose, -pct);
  const epsilon = 0.005;

  return {
    pct,
    prevClose: Math.round(prevClose * 100) / 100,
    limitUpPrice: up,
    limitDownPrice: down,
    capped: true,
    limitUp: up !== null && price >= up - epsilon,
    limitDown: down !== null && price <= down + epsilon,
    reason: `涨跌幅限制 ±${pct}%`
  };
}

export function isLimitUp(stock) {
  return limitState(stock).limitUp;
}

export function isLimitDown(stock) {
  return limitState(stock).limitDown;
}

/** Human-readable band label used by the UI badges. */
export function limitLabel(stock) {
  const pct = limitPctFor(stock);
  return pct === null ? "无限制" : `±${pct}%`;
}
