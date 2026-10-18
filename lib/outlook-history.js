// Scoring the score.
//
// 「明日参考」 makes a directional call every trading evening. Without a record
// of those calls there is no way to know whether they are worth reading, so this
// module stores one row per session and later attaches what actually happened.
//
// Two rules keep it honest:
//   1. A row is written from the *served* outlook, never re-derived, so the
//      grade is attached to exactly the call a user could have read.
//   2. `actual` stays null until the next close is known. An unscored row is
//      shown as pending rather than assumed correct.

export const MAX_RECORDS = 180;

/** A score inside this band is called 震荡, so it makes no directional claim. */
export const NEUTRAL_BAND = 20;

const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

/** Compact the served outlook down to the part worth keeping. */
export function toRecord(outlook) {
  if (!outlook || !outlook.dataDate) return null;
  return {
    dataDate: outlook.dataDate,
    forDate: outlook.forDate ?? null,
    forDateExact: Boolean(outlook.forDateExact),
    score: round(outlook.score),
    bias: outlook.bias ?? null,
    tone: outlook.tone ?? null,
    availableWeight: outlook.availableWeight ?? null,
    drivers: (outlook.drivers || []).map((driver) => ({
      key: driver.key,
      z: driver.z,
      contribution: driver.contribution
    })),
    recordedAt: outlook.generatedAt ?? new Date().toISOString(),
    actual: null
  };
}

/** Insert or replace the row for `dataDate`, keeping the list ordered by date. */
export function upsertRecord(records, record, { max = MAX_RECORDS } = {}) {
  const list = Array.isArray(records) ? records.filter((entry) => entry && entry.dataDate) : [];
  const index = list.findIndex((entry) => entry.dataDate === record.dataDate);
  if (index >= 0) {
    const previous = list[index];
    // Two things must survive a re-serve of the same evening: an actual that was
    // already filled, and the moment the call was first shown. Restamping
    // `recordedAt` on every page load would rewrite the snapshot each time and
    // make the committed file churn without any call actually changing.
    list[index] = {
      ...previous,
      ...record,
      recordedAt: previous.recordedAt ?? record.recordedAt,
      actual: previous.actual ?? null
    };
  } else {
    list.push(record);
  }
  list.sort((a, b) => String(a.dataDate).localeCompare(String(b.dataDate)));
  return list.slice(-max);
}

/** A next-session move inside this band is not a directional outcome. */
const FLAT_BAND = 0.05;

/**
 * Fill in what happened for every row whose `forDate` now has a close.
 *
 * @param {object[]} records
 * @param {Record<string, number>} closes  ISO date -> index close
 */
export function attachActuals(records, closes = {}) {
  const list = Array.isArray(records) ? records : [];
  return list.map((record) => {
    if (record?.actual) return record;
    const forClose = closes[record?.forDate];
    const baseClose = closes[record?.dataDate];
    if (!Number.isFinite(forClose) || !Number.isFinite(baseClose) || baseClose === 0) return record;
    const changePct = round(((forClose - baseClose) / baseClose) * 100, 3);
    const direction = changePct > FLAT_BAND ? "up" : changePct < -FLAT_BAND ? "down" : "flat";
    const called = Math.abs(record.score) >= NEUTRAL_BAND ? (record.score > 0 ? "up" : "down") : null;
    return {
      ...record,
      actual: {
        date: record.forDate,
        close: round(forClose, 2),
        prevClose: round(baseClose, 2),
        changePct,
        direction,
        hit: called ? called === direction : null
      }
    };
  });
}

function pearson(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of pairs) {
    num += (x - meanX) * (y - meanY);
    dx += (x - meanX) ** 2;
    dy += (y - meanY) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return round(num / Math.sqrt(dx * dy), 3);
}

const BUCKETS = [
  { label: "强看多 ≥50", min: 50, max: 100 },
  { label: "看多 20~50", min: NEUTRAL_BAND, max: 50 },
  { label: "震荡 -20~20", min: -NEUTRAL_BAND, max: NEUTRAL_BAND },
  { label: "看空 -50~-20", min: -50, max: -NEUTRAL_BAND },
  { label: "强看空 ≤-50", min: -100, max: -50 }
];

/**
 * Score the record. Only rows with an `actual` count; a pending call is not a
 * correct call.
 */
export function summarizeHistory(records) {
  const list = Array.isArray(records) ? records.filter((entry) => entry && entry.dataDate) : [];
  const scored = list.filter((entry) => entry.actual && Number.isFinite(entry.actual.changePct));
  const directional = scored.filter((entry) => entry.actual.hit !== null);

  const hits = directional.filter((entry) => entry.actual.hit).length;
  const avg = (values) => (values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 3) : null);

  const buckets = BUCKETS.map((bucket) => {
    const members = scored.filter((entry) => entry.score >= bucket.min && entry.score < bucket.max);
    return {
      label: bucket.label,
      count: members.length,
      avgChangePct: avg(members.map((entry) => entry.actual.changePct)),
      upRate: members.length ? round(members.filter((entry) => entry.actual.direction === "up").length / members.length, 3) : null
    };
  });

  const first = scored[0] ?? null;
  const last = scored[scored.length - 1] ?? null;

  return {
    total: list.length,
    scored: scored.length,
    pending: list.length - scored.length,
    directional: directional.length,
    hits,
    hitRate: directional.length ? round(hits / directional.length, 3) : null,
    neutralBand: NEUTRAL_BAND,
    avgChangePct: avg(scored.map((entry) => entry.actual.changePct)),
    avgWhenBullish: avg(scored.filter((entry) => entry.score >= NEUTRAL_BAND).map((entry) => entry.actual.changePct)),
    avgWhenBearish: avg(scored.filter((entry) => entry.score <= -NEUTRAL_BAND).map((entry) => entry.actual.changePct)),
    correlation: pearson(scored.map((entry) => [entry.score, entry.actual.changePct])),
    buckets,
    span: first && last ? { from: first.dataDate, to: last.dataDate } : null,
    note:
      "命中率只统计 |score| ≥ 20 的方向性判断（±20 以内视作震荡，不计入对错）；" +
      "correlation 是 score 与次日涨跌幅的皮尔逊相关系数；样本不足 3 条时不计算。"
  };
}
