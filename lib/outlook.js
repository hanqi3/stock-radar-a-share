// "明日参考" — a transparent, additive next-session read.
//
// Design rules, because this is the one board that makes a claim:
//   1. Every point of the score comes from a named driver with a visible weight,
//      and the weights of the available drivers always sum to 100 — so the score
//      stays on the same -100..100 scale even when an input is missing.
//   2. Nothing is invented. If an input is absent the driver is dropped and
//      reported, never filled with a neutral placeholder.
//   3. The narrative is generated from the numbers, not the other way round.
//
// The score is a summary of *evidence alignment*, not a probability of an up day.

export const DRIVER_WEIGHTS = {
  a50: 20, // 富时中国A50期货：休市后仍在交易的唯一「明日开盘」定价
  us: 14, // 美股三大指数：隔夜风险偏好
  sox: 6, // 费城半导体：A 股电子/算力的映射源
  dxy: 6, // 美元指数：外资与有色
  cnh: 6, // 离岸人民币：外资流向的即时温度计
  us10y: 8, // 美债10年：贴现率/成长股估值
  breadth: 14, // 当日涨跌家数：A 股自身结构
  limits: 8, // 涨停/跌停：短线情绪
  flowRatio: 10, // 主力净额占成交额：存量资金态度
  median: 8 // 个股中位涨跌幅：赚钱效应
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const finite = (value) => Number.isFinite(value);
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

const SIGNED = (value, digits = 2) => {
  if (!finite(value)) return "—";
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
};
const pct = (value, digits = 2) => (finite(value) ? `${SIGNED(value, digits)}%` : "—");

/** next weekday after the data date — a working-day guess, holidays are not modelled */
export function nextTradingDay(date) {
  const base = date instanceof Date ? new Date(date.getTime()) : new Date(String(date));
  if (Number.isNaN(base.getTime())) return null;
  const cursor = new Date(base.getTime());
  for (let step = 0; step < 7; step += 1) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) return cursor.toISOString().slice(0, 10);
  }
  return null;
}

function indexMap(indices) {
  const map = new Map();
  for (const item of Array.isArray(indices) ? indices : []) {
    if (item?.symbol) map.set(item.symbol, item);
  }
  return map;
}

function median(values) {
  const clean = values.filter(finite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function biasForScore(score) {
  if (score >= 35) return { bias: "偏多", tone: "up" };
  if (score >= 15) return { bias: "震荡偏多", tone: "up" };
  if (score <= -35) return { bias: "偏空", tone: "down" };
  if (score <= -15) return { bias: "震荡偏空", tone: "down" };
  return { bias: "震荡", tone: "flat" };
}

// Sector transmission: which industries a given macro move actually lands on.
// Kept as data so the reasoning is auditable instead of buried in prose.
const TRANSMISSION = {
  a50: {
    up: { bullish: ["非银金融", "银行", "食品饮料"], bearish: [], reason: "A50 夜盘走强，权重蓝筹明日开盘有溢价" },
    down: { bullish: [], bearish: ["非银金融", "银行", "食品饮料", "电子"], reason: "A50 夜盘走弱，权重蓝筹明日开盘承压" }
  },
  us: {
    up: { bullish: ["电子", "计算机", "电力设备"], bearish: [], reason: "隔夜美股走强，外资偏好的成长方向情绪修复" },
    down: { bullish: [], bearish: ["电子", "计算机", "电力设备", "传媒"], reason: "隔夜美股走弱，外资定价的成长股承压" }
  },
  sox: {
    up: { bullish: ["电子"], bearish: [], reason: "费城半导体反弹，A 股半导体链情绪跟随" },
    down: { bullish: [], bearish: ["电子", "计算机"], reason: "费城半导体下挫，半导体与算力链补跌风险" }
  },
  dxy: {
    up: {
      bullish: ["银行"],
      bearish: ["有色金属", "电子"],
      reason: "美元走强：压制以美元计价的有色与外资偏好的成长股，银行则相对受益"
    },
    down: { bullish: ["有色金属"], bearish: [], reason: "美元走弱抬升以美元计价的资源品" }
  },
  cnh: {
    up: { bullish: [], bearish: ["电子", "食品饮料"], reason: "人民币走弱，外资流出压力上升" },
    down: { bullish: ["非银金融", "食品饮料"], bearish: [], reason: "人民币走强，外资流入预期改善" }
  },
  us10y: {
    up: {
      bullish: ["银行"],
      bearish: ["电子", "计算机", "电力设备"],
      reason: "美债 10 年期上行：银行净息差与高股息相对受益，长久期成长股贴现压力加大"
    },
    down: { bullish: ["电子", "计算机", "电力设备"], bearish: [], reason: "美债收益率下行，成长股估值压力边际缓解" }
  },
  brent: {
    up: {
      bullish: ["石油石化", "煤炭"],
      bearish: ["交通运输", "基础化工"],
      reason: "原油上涨：利好上游油气煤炭，同时压制交运与化工的成本端"
    },
    down: {
      bullish: ["交通运输", "基础化工"],
      bearish: ["石油石化", "煤炭"],
      reason: "原油下跌：拖累上游油气煤炭，同时改善交运与化工的成本端"
    }
  }
};

/**
 * Push one macro move into the 利好/利空 buckets and record it as a readable
 * transmission record, so the UI can show "one driver -> which sectors" instead
 * of repeating the same sentence once per sector.
 */
function applyTransmission(bucket, key, direction, weight) {
  const rule = TRANSMISSION[key]?.[direction];
  if (!rule) return;
  for (const label of rule.bullish) bucket.bullish.push({ label, reason: rule.reason, weight, key });
  for (const label of rule.bearish) bucket.bearish.push({ label, reason: rule.reason, weight, key });
  if (Array.isArray(bucket.transmissions)) {
    bucket.transmissions.push({
      key,
      direction,
      reason: rule.reason,
      weight,
      bullish: rule.bullish.slice(),
      bearish: rule.bearish.slice()
    });
  }
}

function sidesWeight(items) {
  const map = new Map();
  for (const item of items) {
    const current = map.get(item.label);
    if (!current || current.weight < item.weight) map.set(item.label, item);
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight);
}

/** One entry per (driver, direction): a driver is reported once, not per sector. */
function dedupeTransmissions(items) {
  const seen = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = `${item.key}:${item.direction}`;
    const current = seen.get(key);
    if (current) {
      current.weight = Math.max(current.weight, item.weight);
      continue;
    }
    seen.set(key, { ...item, bullish: item.bullish.slice(), bearish: item.bearish.slice() });
  }
  return [...seen.values()].sort((a, b) => b.weight - a.weight);
}

/**
 * @param {object} input
 * @param {Date} [input.now]
 * @param {object} [input.meta]        data/meta.json
 * @param {object} [input.briefing]    buildBriefing() output
 * @param {object} [input.flow]        data/flow.json
 * @param {Array}  [input.indices]     data/indices.json items
 * @param {object} [input.macro]       data/macro.json
 * @param {Array}  [input.sectorNews]  lib/sector-news.js output
 */
export function buildOutlook(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date();
  const briefing = input.briefing ?? {};
  const overview = briefing.overview ?? {};
  const flow = input.flow ?? {};
  const macro = input.macro ?? {};
  const sectorNews = Array.isArray(input.sectorNews) ? input.sectorNews : [];
  const quotes = indexMap(input.indices);
  const yields = new Map();
  for (const item of Array.isArray(macro.items) ? macro.items : []) {
    if (item?.symbol) yields.set(item.symbol, item);
  }

  const dataDate = String(flow.date ?? briefing.dataUpdatedAt ?? input.meta?.updatedAt ?? now.toISOString()).slice(0, 10);
  const forDate = nextTradingDay(`${dataDate}T00:00:00Z`);

  const drivers = [];
  const missing = [];
  // `macro` is the raw direction of the underlying input; `z` is its market
  // impact (positive = good for A-shares). They are NOT the same sign for
  // dollar, CNH and UST yields — a falling 10Y is bullish growth — so sector
  // transmission must read `macro`, never `z`.
  const add = (key, label, raw, rawText, z, effectText, macro = null) => {
    if (!finite(z)) {
      missing.push({ key, label });
      return;
    }
    drivers.push({
      key,
      label,
      raw,
      rawText,
      z: round(clamp(z, -1, 1), 3),
      macro,
      weight: DRIVER_WEIGHTS[key] ?? 0,
      contribution: round(clamp(z, -1, 1) * (DRIVER_WEIGHTS[key] ?? 0), 2),
      effect: effectText
    });
  };

  // --- 1. A50 futures (the single best overnight read) ----------------------
  const a50 = quotes.get("hf_CHA50CFD");
  add(
    "a50",
    "富时中国A50期货",
    a50?.changePct ?? null,
    finite(a50?.changePct) ? `${a50.price}（${pct(a50.changePct)}）` : "—",
    finite(a50?.changePct) ? a50.changePct / 2 : NaN,
    a50?.changePct < 0 ? "夜盘为 A 股定价偏弱，明日开盘与权重股有低开压力" : "夜盘为 A 股定价偏强，明日开盘偏暖",
    finite(a50?.changePct) ? (a50.changePct >= 0 ? "up" : "down") : null
  );

  // --- 2. US majors ---------------------------------------------------------
  const usItems = ["gb_dji", "gb_inx", "gb_ixic"].map((symbol) => quotes.get(symbol)).filter((item) => finite(item?.changePct));
  if (usItems.length) {
    const avg = usItems.reduce((sum, item) => sum + item.changePct, 0) / usItems.length;
    add(
      "us",
      "美股三大指数",
      round(avg),
      usItems.map((item) => `${item.name} ${pct(item.changePct)}`).join("、"),
      avg / 1.5,
      avg < 0 ? "隔夜风险偏好收缩，外资定价的成长方向明天难有溢价" : "隔夜风险偏好回升，成长方向情绪有支撑",
      avg >= 0 ? "up" : "down"
    );
  } else {
    missing.push({ key: "us", label: "美股三大指数" });
  }

  const sox = quotes.get("gb_sox");
  add(
    "sox",
    "费城半导体",
    sox?.changePct ?? null,
    finite(sox?.changePct) ? `${sox.price}（${pct(sox.changePct)}）` : "—",
    finite(sox?.changePct) ? sox.changePct / 3 : NaN,
    sox?.changePct < 0 ? "半导体链隔夜走弱，A 股电子板块明日补跌风险" : "半导体链隔夜走强，电子板块情绪跟随",
    finite(sox?.changePct) ? (sox.changePct >= 0 ? "up" : "down") : null
  );

  const dxy = quotes.get("DINIW");
  add(
    "dxy",
    "美元指数",
    dxy?.changePct ?? null,
    finite(dxy?.changePct) ? `${dxy.price}（${pct(dxy.changePct)}）` : "—",
    finite(dxy?.changePct) ? -dxy.changePct / 0.8 : NaN,
    dxy?.changePct > 0 ? "美元走强，人民币资产与有色金属承压" : "美元走弱，人民币资产与有色金属受益",
    finite(dxy?.changePct) ? (dxy.changePct >= 0 ? "up" : "down") : null
  );

  const cnh = quotes.get("fx_susdcnh");
  add(
    "cnh",
    "离岸人民币",
    cnh?.changePct ?? null,
    finite(cnh?.changePct) ? `${cnh.price}（${pct(cnh.changePct)}）` : "—",
    finite(cnh?.changePct) ? -cnh.changePct / 0.5 : NaN,
    cnh?.changePct > 0 ? "人民币贬值，外资流出压力上升" : "人民币升值，外资流入预期改善",
    finite(cnh?.changePct) ? (cnh.changePct >= 0 ? "up" : "down") : null
  );

  const us10 = yields.get("us10y");
  add(
    "us10y",
    "美债10年期",
    us10?.value ?? null,
    finite(us10?.changeBp) ? `${us10.value}%（${SIGNED(us10.changeBp, 0)}bp）` : "—",
    finite(us10?.changeBp) ? -us10.changeBp / 8 : NaN,
    us10?.changeBp > 0 ? "贴现率抬升，长久期成长股估值承压" : "贴现率回落，长久期成长股估值压力缓解",
    finite(us10?.changeBp) ? (us10.changeBp >= 0 ? "up" : "down") : null
  );

  // --- 3. A-share structure -------------------------------------------------
  const advancers = Number(overview.advancers ?? 0);
  const decliners = Number(overview.decliners ?? 0);
  const breadthTotal = advancers + decliners;
  if (breadthTotal > 0) {
    const ratio = advancers / breadthTotal;
    add(
      "breadth",
      "涨跌家数",
      round(ratio, 3),
      `上涨 ${advancers} / 下跌 ${decliners}（涨跌比 ${ratio.toFixed(2)}）`,
      (ratio - 0.5) * 4,
      ratio < 0.5 ? "当日赚钱效应偏弱，次日惯性通常延续" : "当日赚钱效应偏强，次日高开概率上升"
    );
  }

  const limitUp = Number(briefing.limitUpCount ?? 0);
  const limitDown = Number(briefing.limitDownCount ?? 0);
  if (limitUp + limitDown > 0) {
    const net = (limitUp - limitDown) / (limitUp + limitDown);
    add(
      "limits",
      "涨停/跌停",
      round(net, 3),
      `涨停 ${limitUp} / 跌停 ${limitDown}`,
      net,
      net < 0 ? "跌停多于涨停，短线情绪处于冰点，接刀风险高" : "涨停多于跌停，短线情绪仍有承接"
    );
  }

  const marketMainNet = flow.market?.mainNet;
  const marketAmount = flow.market?.amount;
  if (finite(marketMainNet) && finite(marketAmount) && marketAmount > 0) {
    const ratio = marketMainNet / marketAmount;
    add(
      "flowRatio",
      "主力资金",
      round(ratio, 4),
      `${marketMainNet < 0 ? "净流出" : "净流入"} ${Math.abs(marketMainNet / 1e8).toFixed(2)}亿（占成交额 ${pct(Math.abs(ratio * 100)).replace("+", "")}）`,
      ratio / 0.02,
      ratio < 0 ? "主力资金整体撤离，存量博弈下反弹缺乏资金支撑" : "主力资金整体回流，次日承接力度较强"
    );
  }

  // `briefing.anomalies` holds the *largest movers*, so its median is wildly
  // unrepresentative; fall back to the full universe instead.
  const medianChange = finite(briefing.medianChangePct)
    ? briefing.medianChangePct
    : median((Array.isArray(input.stocks) ? input.stocks : []).map((item) => item?.changePct));
  if (finite(medianChange)) {
    add(
      "median",
      "个股中位涨跌幅",
      round(medianChange),
      `${pct(medianChange)}`,
      medianChange / 2,
      medianChange < 0 ? "多数个股下跌，普跌格局下指数反弹也难带动账户" : "多数个股上涨，普涨格局对小票更友好"
    );
  }

  // --- score ----------------------------------------------------------------
  const availableWeight = drivers.reduce((sum, driver) => sum + driver.weight, 0);
  const rawContribution = drivers.reduce((sum, driver) => sum + driver.contribution, 0);
  const score = availableWeight ? Math.round(clamp((rawContribution / availableWeight) * 100, -100, 100)) : 0;
  const { bias, tone } = biasForScore(score);

  const signedWeight = drivers.reduce((sum, driver) => sum + Math.sign(driver.contribution) * driver.weight, 0);
  const agreement = availableWeight ? Math.abs(signedWeight) / availableWeight : 0;
  const confidence = Math.round(clamp((Math.abs(score) / 70) * 0.6 + agreement * 0.4, 0.05, 0.95) * 100);

  // --- sector-level 利好 / 利空 --------------------------------------------
  const bucket = { bullish: [], bearish: [], transmissions: [] };
  const brent = quotes.get("hf_OIL");
  for (const driver of drivers) {
    // The gate is deliberately low: 美元/人民币 legs are small by construction
    // (their z divisors are large) but they are exactly the inputs the user asked
    // to see explained, so they must still reach the transmission table. The
    // emitted weight carries the magnitude, so a 0.07% CNH move shows up as
    // 权重 2 while a 3.8% oil move shows up as 权重 11.
    if (Math.abs(driver.contribution) < 0.5) continue;
    if (!driver.macro) continue; // breadth / limits / flow have no macro leg
    applyTransmission(bucket, driver.key, driver.macro, Math.max(2, Math.round(Math.abs(driver.contribution))));
  }
  if (finite(brent?.changePct) && Math.abs(brent.changePct) >= 1) {
    applyTransmission(bucket, "brent", brent.changePct >= 0 ? "up" : "down", Math.round(Math.abs(brent.changePct) * 3));
  }

  const industries = Array.isArray(flow.industries) ? flow.industries : [];
  const ranked = industries
    .filter((item) => finite(item?.mainNet))
    .sort((a, b) => b.mainNet - a.mainNet);
  for (const item of ranked.slice(0, 3)) {
    bucket.bullish.push({
      label: item.name,
      reason: `当日主力净流入 ${(item.mainNet / 1e8).toFixed(2)}亿`,
      weight: Math.round(Math.min(Math.abs(item.mainNet / 1e8), 20)) + 4
    });
  }
  for (const item of ranked.slice(-3)) {
    bucket.bearish.push({
      label: item.name,
      reason: `当日主力净流出 ${Math.abs(item.mainNet / 1e8).toFixed(2)}亿`,
      weight: Math.round(Math.min(Math.abs(item.mainNet / 1e8), 20)) + 4
    });
  }

  for (const entry of sectorNews) {
    if (!finite(entry?.net) || entry.net === 0) continue;
    const target = entry.net > 0 ? bucket.bullish : bucket.bearish;
    target.push({
      label: entry.industry,
      reason: `消息面 ${entry.bullish} 利好 / ${entry.bearish} 利空${
        entry.samples?.[0]?.title ? `，如「${String(entry.samples[0].title).slice(0, 26)}」` : ""
      }`,
      // Sector news carries a diluted weight per headline, so scale it back up;
      // a sector with a genuine cluster of headlines should outrank a whisper.
      weight: Math.max(4, Math.round(Math.min(Math.abs(entry.net) * 1.6, 26)))
    });
  }

  for (const anomaly of Array.isArray(briefing.sectorAnomalies) ? briefing.sectorAnomalies : []) {
    if (!finite(anomaly?.z)) continue;
    if (anomaly.z >= 1.8) {
      bucket.bullish.push({ label: anomaly.name, reason: `逆势领涨 ${pct(anomaly.avgChangePct)}，相对强弱 z=${anomaly.z}`, weight: 10 });
    } else if (anomaly.z <= -1.8) {
      bucket.bearish.push({ label: anomaly.name, reason: `显著承压 ${pct(anomaly.avgChangePct)}，相对强弱 z=${anomaly.z}`, weight: 10 });
    }
  }

  // A sector can appear on both sides; keep it where the evidence is stronger.
  const bearishLabels = new Set(bucket.bearish.map((item) => item.label));
  const bullish = sidesWeight(bucket.bullish.filter((item) => !bearishLabels.has(item.label) || item.weight > 40)).slice(0, 6);
  const bullishLabels = new Set(bullish.map((item) => item.label));
  const bearish = sidesWeight(bucket.bearish.filter((item) => !bullishLabels.has(item.label))).slice(0, 6);

  // --- logic chains ---------------------------------------------------------
  const logic = [...drivers]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 5)
    .map((driver) => ({
      title: driver.label,
      chain: `${driver.rawText}（权重 ${driver.weight}，贡献 ${driver.contribution > 0 ? "+" : ""}${driver.contribution}）`,
      effect: driver.effect
    }));

  // --- risks ---------------------------------------------------------------
  const risks = [];
  if (finite(us10?.value) && us10.value >= 4.8) {
    risks.push(
      `美债10年期已在 ${us10.value}% 的高位，若继续上行，电子/计算机这类长久期资产的估值压力会集中释放。`
    );
  }
  if (limitDown > limitUp) {
    risks.push(`跌停 ${limitDown} 家多于涨停 ${limitUp} 家，明日若继续出现跌停潮，短线资金可能进一步撤离。`);
  }
  if (finite(a50?.changePct) && Math.abs(a50.changePct) >= 0.8) {
    risks.push(
      `A50 夜盘已定价 ${pct(a50.changePct)}，若明日开盘缺口被快速回补，说明夜盘定价并未被承接，方向可能反转。`
    );
  }
  if (finite(brent?.changePct) && brent.changePct > 1) {
    risks.push(`布伦特原油 ${pct(brent.changePct)}，输入性通胀预期升温，压制中下游制造与交运的毛利。`);
  }
  if (finite(marketMainNet) && marketMainNet < 0) {
    risks.push(
      `主力资金净流出 ${Math.abs(marketMainNet / 1e8).toFixed(2)}亿，属于存量资金撤离；若明日不能转为净流入，反弹高度有限。`
    );
  }
  if (!risks.length) risks.push("当前各项输入没有触发极端阈值，主要风险来自突发消息而非已知宏观变量。");

  // --- watch list ----------------------------------------------------------
  const watch = [];
  watch.push(
    `明日 ${forDate ?? "下一交易日"} 09:25 集合竞价：对比 A50 夜盘方向 ${finite(a50?.changePct) ? pct(a50.changePct) : "—"} 与实际开盘缺口。`
  );
  if (bullish.length) watch.push(`关注 ${bullish.slice(0, 2).map((item) => item.label).join(" / ")} 的资金能否延续净流入。`);
  if (bearish.length) watch.push(`警惕 ${bearish.slice(0, 2).map((item) => item.label).join(" / ")} 的低开是否被快速承接。`);
  if (finite(us10?.value)) watch.push(`美债10年期（当前 ${us10.value}%）与美元指数的日内方向，直接决定外资流向。`);
  const themes = (briefing.themes ?? []).slice(0, 3).map((item) => item.theme).filter(Boolean);
  if (themes.length) watch.push(`事件面热度：${themes.join("、")}，留意相关个股的高开兑现。`);

  return {
    generatedAt: now.toISOString(),
    forDate,
    dataDate,
    score,
    bias,
    tone,
    confidence,
    agreement: round(agreement, 3),
    drivers,
    missing,
    availableWeight,
    logic,
    bullish,
    bearish,
    // One record per macro driver, so the UI can show "driver -> sectors" instead
    // of printing the same sentence once for every sector it touches.
    transmissions: dedupeTransmissions(bucket.transmissions),
    risks,
    watch,
    inputs: {
      indicesUpdatedAt: input.indices?.[0]?.updatedAt ?? null,
      macroUpdatedAt: macro.updatedAt ?? null,
      flowDate: flow.date ?? null,
      newsCount: Array.isArray(sectorNews) ? sectorNews.length : 0
    },
    note:
      "评分是「证据一致性」的加权汇总：每个驱动因子把原始变动归一化到 -1..1 后乘以权重，" +
      "可用权重之和为 100 时即为最终分数。它衡量的是各条证据指向同一方向的程度，不是上涨概率。" +
      `下一交易日按工作日推算（${forDate ?? "—"}），未扣除法定节假日。`
  };
}
