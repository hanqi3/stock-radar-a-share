// Rule-based event understanding.
//
// There is no LLM in the pipeline, so "AI news analysis" here means a
// deterministic, auditable dictionary + scoring model: every headline and
// announcement is classified into a category, a sentiment, a magnitude and a
// set of industry themes, then propagated to the stocks in those industries
// with a time decay. Everything is inspectable and reproducible, which matters
// for a research tool.

/** theme -> keywords that put a headline into that theme */
export const THEME_KEYWORDS = {
  半导体: ["芯片", "半导体", "晶圆", "光刻", "封测", "封装", "集成电路", "存储", "EDA", "碳化硅", "先进制程", "算力芯片"],
  人工智能: ["人工智能", "AI", "大模型", "算力", "GPU", "数据中心", "智能体", "AIGC", "机器学习", "英伟达"],
  机器人: ["机器人", "人形机器人", "减速器", "伺服", "灵巧手", "具身智能"],
  消费电子: ["消费电子", "手机", "折叠屏", "苹果", "AR", "VR", "MR", "可穿戴", "耳机"],
  新能源车: ["新能源车", "新能源汽车", "电动车", "整车", "动力电池", "固态电池", "充电桩", "换电", "车企"],
  锂电池: ["锂电", "正极", "负极", "隔膜", "电解液", "碳酸锂", "电池级"],
  光伏: ["光伏", "硅料", "硅片", "组件", "逆变器", "电池片", "HJT", "TOPCon", "钙钛矿"],
  风电: ["风电", "风机", "海上风电", "塔筒", "叶片"],
  储能: ["储能", "电化学储能", "抽水蓄能", "工商业储能", "钠电池"],
  电力: ["电力", "电网", "核电", "水电", "特高压", "火电", "电价"],
  医药生物: ["医药", "创新药", "仿制药", "疫苗", "CXO", "生物医药", "医疗器械", "中药", "集采", "医保谈判", "临床"],
  白酒食品: ["白酒", "食品", "饮料", "调味品", "乳业", "啤酒", "预制菜"],
  银行: ["银行", "存款", "息差", "信贷", "不良率"],
  非银金融: ["券商", "证券", "保险", "IPO", "注册制", "并购重组", "公募", "基金"],
  房地产: ["房地产", "地产", "楼市", "土拍", "房贷", "保交楼", "限购"],
  建筑基建: ["基建", "建筑", "水泥", "专项债", "水利", "城投", "一带一路"],
  军工: ["军工", "国防", "航空", "航天", "导弹", "军费", "大飞机", "卫星"],
  有色金属: ["铜", "铝", "锂矿", "稀土", "黄金", "白银", "钨", "有色", "小金属"],
  煤炭石油: ["煤炭", "动力煤", "焦煤", "石油", "原油", "天然气", "油价", "OPEC"],
  钢铁化工: ["钢铁", "螺纹钢", "铁矿石", "化工", "纯碱", "涤纶", "农药", "化肥"],
  通信: ["5G", "6G", "通信", "光模块", "运营商", "卫星互联网", "基站"],
  传媒游戏: ["游戏", "传媒", "影视", "短视频", "版号", "广告", "院线"],
  计算机软件: ["软件", "信创", "国产替代", "操作系统", "数据库", "网络安全", "SaaS", "数字经济"],
  汽车零部件: ["汽车零部件", "汽配", "轮胎", "座椅", "热管理", "一体化压铸"],
  家电: ["家电", "空调", "冰箱", "洗衣机", "小家电", "以旧换新"],
  纺织服装: ["纺织", "服装", "鞋", "棉花", "品牌服饰"],
  农业: ["农业", "种业", "猪", "养殖", "粮食", "饲料", "转基因", "白羽鸡"],
  交通运输: ["航运", "港口", "航空", "物流", "快递", "铁路", "机场", "运价"],
  环保: ["环保", "污水", "固废", "碳交易", "碳中和", "垃圾焚烧"],
  旅游消费: ["旅游", "酒店", "免税", "餐饮", "景区", "出行"],
  教育: ["教育", "培训", "职教", "教培"],
  零售商贸: ["零售", "超市", "电商", "直播带货", "商贸"],
  建材: ["建材", "玻璃", "玻纤", "瓷砖", "防水"],
  机械: ["机械", "工程机械", "机床", "工业母机", "叉车", "注塑机"],
  券商概念: ["牛市", "行情", "成交量", "两融"]
};

export const POLICY_KEYWORDS = [
  "国务院", "国常会", "政治局", "中央经济工作会议", "央行", "人民银行", "财政部", "发改委", "工信部",
  "证监会", "银保监会", "金融监管总局", "商务部", "科技部", "能源局", "住建部", "农业农村部",
  "降准", "降息", "加息", "MLF", "LPR", "逆回购", "专项债", "特别国债", "财政政策", "货币政策",
  "补贴", "试点", "规划", "指导意见", "管理办法", "关税", "出口管制", "制裁", "反倾销", "减税", "退税",
  "十五五", "十四五", "新质生产力", "统一大市场", "以旧换新", "设备更新"
];

export const POSITIVE_KEYWORDS = {
  强: 3,
  超预期: 4, 大幅增长: 4, 增长: 2, 扭亏: 4, 预增: 4, 盈利: 2, 增收: 2, 提价: 3, 涨价: 3,
  中标: 4, 签约: 3, 订单: 3, 获批: 4, 批准: 3, 通过: 2, 突破: 3, 创新高: 3, 领先: 2,
  回购: 3, 增持: 3, 分红: 3, 上调: 3, 评级上调: 4, 合作: 2, 战略合作: 3, 扩产: 3, 投产: 3,
  利好: 4, 受益: 3, 放量: 2, 提速: 2, 落地: 2, 国产替代: 3, 政策支持: 4, 免税: 3, 补贴: 3
};

export const NEGATIVE_KEYWORDS = {
  下滑: -2, 下降: -2, 亏损: -4, 预亏: -4, 首亏: -4, 低于预期: -4, 不及预期: -4,
  减持: -3, 清仓: -3, 退市: -5, 面值退市: -5, 处罚: -4, 罚款: -3, 立案: -5, 调查: -4,
  警示: -3, 问询: -2, 关注函: -2, 下调: -3, 降价: -2, 暴雷: -5, 违约: -5, 债务: -3,
  诉讼: -3, 仲裁: -3, 召回: -4, 停产: -4, 停产整顿: -4, 终止: -3, 失败: -4, 延期: -2,
  商誉减值: -5, 计提: -3, 解禁: -3, 质押: -2, 监管: -2, 风险警示: -4, 制裁: -4, 关税: -2,
  反倾销: -3, 出口管制: -4, 限产: -2, 关停: -3
};

export const CATEGORY_RULES = [
  { category: "财报", keywords: ["年报", "半年报", "季报", "业绩", "净利润", "营业收入", "预告", "财报", "分红", "送转"] },
  { category: "公告", keywords: ["公告", "股东", "增持", "减持", "回购", "质押", "解禁", "定增", "可转债", "收购", "重组", "资产"] },
  { category: "政策", keywords: POLICY_KEYWORDS },
  { category: "宏观", keywords: ["CPI", "PPI", "PMI", "GDP", "社融", "M2", "进出口", "外汇", "汇率", "美联储", "非农", "通胀"] },
  { category: "海外", keywords: ["美股", "纳斯达克", "标普", "欧洲", "日本", "港股", "隔夜", "外盘"] },
  { category: "行业", keywords: ["行业", "产能", "库存", "价格", "供需", "订单", "开工率"] },
  { category: "公司", keywords: ["公司", "子公司", "拟", "签署", "合同", "项目"] }
];

function countMatches(text, dictionary) {
  let hits = 0;
  let score = 0;
  const matched = [];
  for (const [keyword, weight] of Object.entries(dictionary)) {
    if (text.includes(keyword)) {
      hits += 1;
      score += weight;
      matched.push(keyword);
    }
  }
  return { hits, score, matched };
}

export function detectThemes(text) {
  const themes = [];
  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    const matched = keywords.filter((keyword) => text.includes(keyword));
    if (matched.length) themes.push({ theme, matched, weight: matched.length });
  }
  return themes.sort((a, b) => b.weight - a.weight);
}

export function detectPolicy(text) {
  return POLICY_KEYWORDS.filter((keyword) => text.includes(keyword));
}

export function classifyCategory(text) {
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) return rule.category;
  }
  return "资讯";
}

/** Pull the hard numbers out of a headline so magnitude is not hand-waved. */
export function extractMetrics(text) {
  const metrics = {};
  const growth = text.match(/(净利润|营业收入|营收|扣非净利润)[^%]{0,20}?(同比)?\s*(增长|下降|下滑|减少)?\s*(-?\d+(?:\.\d+)?)\s*%/);
  if (growth) {
    const negative = ["下降", "下滑", "减少"].includes(growth[3]);
    metrics.growthField = growth[1];
    metrics.growthPct = Number(growth[4]) * (negative ? -1 : 1);
  }
  // Deal size is often stated without a field label ("中标12.6亿元"), so the
  // largest money figure in the headline is used when no label is present.
  const candidates = [];
  const labelled = text.match(/(净利润|营业收入|营收|中标金额|订单金额|合同金额)[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(亿元|万元|亿|万)/);
  if (labelled) {
    metrics.amountField = labelled[1];
    candidates.push(Number(labelled[2]) * (labelled[3].startsWith("亿") ? 1e8 : 1e4));
  }
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(亿元|万元|亿|万)(?:元)?/g)) {
    candidates.push(Number(match[1]) * (match[2].startsWith("亿") ? 1e8 : 1e4));
  }
  if (candidates.length) {
    metrics.amount = Math.max(...candidates);
    metrics.amountField ??= "金额";
  }
  return metrics;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Turn a raw news/announcement item into a scored event.
 * @returns {{category:string, sentiment:string, sentimentScore:number,
 *            magnitude:number, themes:Array, policy:string[], metrics:object}}
 */
export function classifyEvent(item) {
  const text = `${item.title || ""} ${item.summary || ""} ${item.content || ""}`.replace(/\s+/g, " ");
  const positive = countMatches(text, POSITIVE_KEYWORDS);
  const negative = countMatches(text, NEGATIVE_KEYWORDS);
  const policy = detectPolicy(text);
  const themes = detectThemes(text);
  const metrics = extractMetrics(text);

  let sentimentScore = positive.score + negative.score;
  if (policy.length) sentimentScore += policy.length * 1.5;
  // Reported growth is itself a signal: a headline can state "+11%" without
  // ever using one of the sentiment keywords, so fold the parsed rate in too.
  if (Number.isFinite(metrics.growthPct)) sentimentScore += clamp(metrics.growthPct / 8, -6, 6);

  const sentiment = sentimentScore >= 3 ? "positive" : sentimentScore <= -3 ? "negative" : "neutral";

  // Magnitude 0-10: how much attention this deserves, regardless of direction.
  const keywordWeight = Math.min(positive.hits + negative.hits, 6);
  const policyWeight = Math.min(policy.length * 1.6, 5);
  const themeWeight = Math.min(themes.length * 0.8, 3);
  const magnitude = Number(clamp(keywordWeight + policyWeight + themeWeight + (metrics.amount ? 2 : 0), 0, 10).toFixed(2));

  return {
    category: classifyCategory(text),
    sentiment,
    sentimentScore: Number(sentimentScore.toFixed(2)),
    magnitude,
    themes,
    policy,
    metrics,
    positiveKeywords: positive.matched,
    negativeKeywords: negative.matched
  };
}

/** Exponential decay with a half-life in hours. */
export function timeDecay(publishedAt, now, halfLifeHours = 18) {
  const published = new Date(publishedAt).getTime();
  if (!Number.isFinite(published)) return 0.3;
  const hours = Math.max(0, (now - published) / 3_600_000);
  return Math.pow(0.5, hours / halfLifeHours);
}

/**
 * Propagate classified events onto stocks.
 *
 * Direct mentions (code or full company name in the text) get full weight;
 * theme matches hit every stock whose industry is mapped to that theme with a
 * smaller weight.
 *
 * @param {Array} events      items with {title, summary, publishedAt, url, source, ...}
 * @param {Array} stocks      the universe [{code, name, industry, ...}]
 * @param {object} options    { now, themeIndex?: Map<theme, code[]>, halfLifeHours }
 */
export function buildEventImpacts(events, stocks, options = {}) {
  const { now = Date.now(), themeIndex = new Map(), halfLifeHours = 18 } = options;
  const byCode = new Map(stocks.map((stock) => [stock.code, stock]));
  const byName = new Map();
  for (const stock of stocks) {
    if (stock.name && stock.name.length >= 2) byName.set(stock.name, stock);
  }

  const impacts = new Map(); // code -> {score, items:[]}
  const themeImpacts = new Map();
  const classified = [];

  const addImpact = (code, contribution, entry) => {
    if (!impacts.has(code)) impacts.set(code, { score: 0, items: [] });
    const bucket = impacts.get(code);
    bucket.score += contribution;
    if (bucket.items.length < 8) bucket.items.push(entry);
  };

  for (const raw of events) {
    const analysis = classifyEvent(raw);
    const decay = timeDecay(raw.publishedAt, now, halfLifeHours);
    const direction = analysis.sentiment === "positive" ? 1 : analysis.sentiment === "negative" ? -1 : 0;
    const baseWeight = analysis.magnitude * decay;

    const entry = {
      title: raw.title,
      url: raw.url,
      source: raw.source,
      publishedAt: raw.publishedAt,
      category: analysis.category,
      sentiment: analysis.sentiment,
      magnitude: analysis.magnitude,
      themes: analysis.themes.slice(0, 4).map((t) => t.theme),
      policy: analysis.policy.slice(0, 4),
      decay: Number(decay.toFixed(3))
    };

    const text = `${raw.title || ""} ${raw.summary || ""}`;
    const directCodes = new Set();

    for (const stock of stocks) {
      const code = stock.code;
      const bare = code.replace(/^(6|0|3|8|4)/, "");
      if (text.includes(code)) directCodes.add(code);
      else if (stock.name && stock.name.length >= 2 && text.includes(stock.name)) directCodes.add(code);
      else if (bare.length >= 5 && text.includes(bare)) directCodes.add(code);
    }

    if (directCodes.size === 0 && analysis.themes.length === 0) {
      // Off-theme, unnamed headlines are still recorded so the brief can show them.
      classified.push({ ...entry, affectedCodes: [] });
      continue;
    }

    for (const code of directCodes) {
      const stock = byCode.get(code);
      if (!stock) continue;
      // A neutral but explicitly named item still creates an entry (score 0) so
      // the stock page can list "相关公告" without inventing a direction.
      addImpact(code, direction * baseWeight * 3, {
        ...entry,
        relevance: "direct",
        detail: `直接提及 ${stock.name}`
      });
    }

    for (const theme of analysis.themes) {
      if (!themeImpacts.has(theme.theme)) themeImpacts.set(theme.theme, { theme: theme.theme, score: 0, events: [] });
      const bucket = themeImpacts.get(theme.theme);
      bucket.score += direction * baseWeight;
      bucket.events.push({ title: raw.title, publishedAt: raw.publishedAt, sentiment: analysis.sentiment });

      const members = themeIndex.get(theme.theme) || [];
      for (const code of members) {
        if (directCodes.has(code)) continue;
        addImpact(code, direction * baseWeight * 0.45, {
          ...entry,
          relevance: "theme",
          detail: `行业事件：${theme.theme}（命中关键词 ${theme.matched.slice(0, 3).join("/")}）`
        });
      }
    }

    classified.push({ ...entry, affectedCodes: [...directCodes] });
  }

  // Normalise to a readable 0-100 attention scale plus a signed -100..100 bias.
  const result = new Map();
  for (const [code, bucket] of impacts) {
    result.set(code, {
      code,
      eventScore: Number(bucket.score.toFixed(2)),
      eventBias: Number(clamp(bucket.score * 6, -100, 100).toFixed(1)),
      items: bucket.items
    });
  }

  return {
    impacts: result,
    themeImpacts: [...themeImpacts.values()].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)),
    classified
  };
}
