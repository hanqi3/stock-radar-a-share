// Cross-sectional factor engine.
//
// The v1 radar scored anomalies with a hand-tuned formula on three raw fields
// (|changePct|, turnover, log10(amount)). That cannot compare a 20%-band
// ChiNext stock against a 10%-band main-board stock, ignores trend entirely,
// and has no notion of "is this move unusual *for this stock*".
//
// This module builds a cross-sectional factor table. Every raw factor is
// converted to a percentile rank across the whole universe, which makes the
// composite robust to outliers and stable when the universe changes size.

export function percentileRanks(values) {
  const indexed = values
    .map((value, index) => ({ value, index }))
    .filter((item) => Number.isFinite(item.value));
  if (!indexed.length) return values.map(() => null);

  indexed.sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length).fill(null);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    const averageRank = (i + j) / 2;
    const percentile = indexed.length === 1 ? 0.5 : averageRank / (indexed.length - 1);
    for (let n = i; n <= j; n += 1) ranks[indexed[n].index] = percentile;
    i = j + 1;
  }
  return ranks;
}

export function medianOf(values) {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

/** Board-normalised daily move: +10% on a main board == +20% on ChiNext. */
export function normalizedMove(changePct, limitPct) {
  if (!Number.isFinite(changePct)) return null;
  const band = Number.isFinite(limitPct) && limitPct > 0 ? limitPct : 10;
  return (Math.abs(changePct) / band) * 100;
}

export const DEFAULT_FACTOR_WEIGHTS = {
  anomaly: {
    move: 0.28,
    liquidity: 0.18,
    volumeSurge: 0.18,
    volatility: 0.14,
    rangePosition: 0.12,
    industryDivergence: 0.1
  },
  trend: {
    momentum20: 0.26,
    momentum60: 0.18,
    industryRs: 0.22,
    maGap: 0.2,
    macdHist: 0.14
  }
};

function weightedAverage(pairs) {
  let total = 0;
  let weightSum = 0;
  for (const [value, weight] of pairs) {
    if (!Number.isFinite(value)) continue;
    total += value * weight;
    weightSum += weight;
  }
  if (!weightSum) return null;
  return total / weightSum;
}

/**
 * @param {Array<object>} rows Each row needs:
 *   code, changePct, turnover, amount, limitPct,
 *   momentum5/20/60, volatility20, volumeRatio, ma20Gap, bollPercentB,
 *   macdHist, industryMomentum20 (median 20d momentum of the row's industry)
 * @param {object} weights Optional override of DEFAULT_FACTOR_WEIGHTS
 */
export function computeFactorTable(rows, weights = DEFAULT_FACTOR_WEIGHTS) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const move = rows.map((r) => normalizedMove(r.changePct, r.limitPct));
  const liquidity = rows.map((r) => {
    if (!Number.isFinite(r.turnover) && !Number.isFinite(r.amount)) return null;
    const turnover = Number.isFinite(r.turnover) ? r.turnover : 0;
    const amount = Number.isFinite(r.amount) ? Math.log10(Math.max(r.amount, 1)) : 0;
    return turnover * 0.6 + amount * 0.4;
  });
  const volumeSurge = rows.map((r) => (Number.isFinite(r.volumeRatio) ? Math.log2(Math.max(r.volumeRatio, 0.01)) : null));
  const volatility = rows.map((r) => (Number.isFinite(r.volatility20) ? r.volatility20 : null));
  const rangePosition = rows.map((r) => {
    if (Number.isFinite(r.bollPercentB)) return Math.abs(r.bollPercentB - 50);
    return null;
  });
  const industryDivergence = rows.map((r) => {
    if (Number.isFinite(r.momentum20) && Number.isFinite(r.industryMomentum20)) {
      return Math.abs(r.momentum20 - r.industryMomentum20);
    }
    return null;
  });

  const pct = {
    move: percentileRanks(move),
    liquidity: percentileRanks(liquidity),
    volumeSurge: percentileRanks(volumeSurge),
    volatility: percentileRanks(volatility),
    rangePosition: percentileRanks(rangePosition),
    industryDivergence: percentileRanks(industryDivergence),
    momentum20: percentileRanks(rows.map((r) => (Number.isFinite(r.momentum20) ? r.momentum20 : null))),
    momentum60: percentileRanks(rows.map((r) => (Number.isFinite(r.momentum60) ? r.momentum60 : null))),
    industryRs: percentileRanks(rows.map((r) => {
      if (Number.isFinite(r.momentum20) && Number.isFinite(r.industryMomentum20)) return r.momentum20 - r.industryMomentum20;
      return null;
    })),
    maGap: percentileRanks(rows.map((r) => (Number.isFinite(r.ma20Gap) ? r.ma20Gap : null))),
    macdHist: percentileRanks(rows.map((r) => (Number.isFinite(r.macdHist) ? r.macdHist : null)))
  };

  return rows.map((row, i) => {
    const anomaly = weightedAverage([
      [pct.move[i], weights.anomaly.move],
      [pct.liquidity[i], weights.anomaly.liquidity],
      [pct.volumeSurge[i], weights.anomaly.volumeSurge],
      [pct.volatility[i], weights.anomaly.volatility],
      [pct.rangePosition[i], weights.anomaly.rangePosition],
      [pct.industryDivergence[i], weights.anomaly.industryDivergence]
    ]);
    const trend = weightedAverage([
      [pct.momentum20[i], weights.trend.momentum20],
      [pct.momentum60[i], weights.trend.momentum60],
      [pct.industryRs[i], weights.trend.industryRs],
      [pct.maGap[i], weights.trend.maGap],
      [pct.macdHist[i], weights.trend.macdHist]
    ]);

    return {
      ...row,
      factors: {
        move: pct.move[i],
        liquidity: pct.liquidity[i],
        volumeSurge: pct.volumeSurge[i],
        volatility: pct.volatility[i],
        rangePosition: pct.rangePosition[i],
        industryDivergence: pct.industryDivergence[i],
        momentum20: pct.momentum20[i],
        momentum60: pct.momentum60[i],
        industryRs: pct.industryRs[i],
        maGap: pct.maGap[i],
        macdHist: pct.macdHist[i]
      },
      raw: {
        normalizedMove: move[i],
        volatility20: row.volatility20,
        volumeRatio: row.volumeRatio,
        momentum20: row.momentum20,
        momentum60: row.momentum60,
        industryMomentum20: row.industryMomentum20,
        ma20Gap: row.ma20Gap,
        bollPercentB: row.bollPercentB,
        macdHist: row.macdHist
      },
      // 0-100 "how unusual is today" score.
      anomalyScore: anomaly === null ? null : Number((anomaly * 100).toFixed(2)),
      // 0-100 "how constructive is the trend" score (50 = neutral).
      trendScore: trend === null ? null : Number((trend * 100).toFixed(2))
    };
  });
}

/** Directional bias in [-100, 100] combining today's move and the trend rank. */
export function directionalScore(row, marketBias = 0) {
  const trend = Number.isFinite(row.trendScore) ? (row.trendScore - 50) * 2 : 0;
  const move = Number.isFinite(row.changePct) ? Math.max(-30, Math.min(30, row.changePct * 3)) : 0;
  return Number(Math.max(-100, Math.min(100, trend * 0.6 + move * 0.4 + marketBias)).toFixed(1));
}
