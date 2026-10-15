// Region tagging for news / disclosures.
//
// The event pipeline mixes A-share disclosures with macro and overseas
// headlines. The UI shows them in two separate columns, so every item needs a
// stable `region` of either "cn" or "global".
//
// Deterministic keyword rules only - no network, no dependencies - so the same
// item always lands in the same column and the sync script and the server agree.

export const REGIONS = ["cn", "global"];

export const GLOBAL_STRONG_KEYWORDS = [
  // markets
  "美股", "美国股市", "华尔街", "纳斯达克", "道琼斯", "标普", "标普500", "费城半导体",
  "欧洲股市", "欧股", "英国股市", "德国股市", "法国股市", "日经", "日股", "东京股市",
  "韩国股市", "kospi", "印度股市", "sensex", "越南股市", "澳洲股市",
  "隔夜", "美股期指",
  // macro / policy
  "美联储", "鲍威尔", "fomc", "点阵图", "非农", "cpi", "ppi", "pce",
  "美国财政部", "美债", "美元指数", "欧元区", "欧央行", "日本央行", "英央行",
  "关税", "出口管制", "实体清单", "白宫", "特朗普", "拜登",
  "opec", "欧佩克", "国际油价", "布伦特", "wti", "伦敦金", "纽约金", "comex", "伦铜",
  // overseas companies
  "英伟达", "nvidia", "苹果公司", "特斯拉", "微软", "谷歌", "alphabet", "亚马逊", "meta",
  "台积电", "三星电子", "阿斯麦", "asml", "英特尔", "amd", "高通", "博通", "美光",
  "波音", "摩根大通", "高盛", "摩根士丹利", "伯克希尔", "巴菲特", "纳斯达克指数"
];

export const GLOBAL_GEO_KEYWORDS = [
  "俄罗斯", "乌克兰", "中东", "以色列", "伊朗", "红海", "霍尔木兹", "朝鲜", "欧盟",
  "海外", "全球市场", "国际市场", "外汇市场", "离岸人民币", "港股", "恒生指数", "恒指",
  "新兴市场", "罗马尼亚", "保加利亚", "日本", "韩国", "印度", "德国", "法国", "英国",
  "沙特", "土耳其", "巴西", "阿根廷", "墨西哥", "加拿大", "澳大利亚"
];

export const GLOBAL_KEYWORDS = [...GLOBAL_STRONG_KEYWORDS, ...GLOBAL_GEO_KEYWORDS];

export const CN_KEYWORDS = [
  "A股", "沪指", "深成指", "创业板指", "科创板", "北交所", "沪深", "两市",
  "证监会", "人民银行", "央行", "国常会", "国务院", "发改委", "财政部", "工信部",
  "上交所", "深交所", "中证", "中金所", "上市公司", "公告", "回购", "增持", "减持",
  "定增", "可转债", "分红", "业绩预告", "股东大会", "限售股", "解禁"
];

const STRONG_RE = new RegExp(GLOBAL_STRONG_KEYWORDS.map(escapeRegExp).join("|"), "i");
const GEO_RE = new RegExp(GLOBAL_GEO_KEYWORDS.map(escapeRegExp).join("|"), "i");
const GLOBAL_RE = new RegExp(GLOBAL_KEYWORDS.map(escapeRegExp).join("|"), "i");
const CN_RE = new RegExp(CN_KEYWORDS.map(escapeRegExp).join("|"), "i");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isGlobalSymbol(symbol) {
  const text = String(symbol ?? "").toLowerCase();
  if (!text) return false;
  return /^(gb_|int_|rt_hk|hf_|fx_|znb_|us_|hk)/.test(text);
}

/**
 * Decide which column an event belongs to.
 *
 * Order matters: an explicit `region` wins, then A-share disclosures (which
 * always carry CN codes or come from the cninfo feed), then global market
 * vocabulary, then CN policy vocabulary, defaulting to "cn" because every feed
 * we ingest is published for a mainland audience.
 */
export function classifyRegion(item = {}) {
  if (item.region === "global" || item.region === "cn") return item.region;

  const codes = Array.isArray(item.codes) ? item.codes : [];
  const text = `${item.title ?? ""} ${item.summary ?? ""}`;
  const hasStrong = STRONG_RE.test(text);
  const hasGlobal = hasStrong || GEO_RE.test(text);
  const hasCn = CN_RE.test(text);

  // A mainland disclosure pinned to mainland codes is domestic unless the
  // headline is really about an overseas market event. "海外并购" alone is a
  // Chinese company announcing an overseas deal, so geography words do not
  // outrank the attached code.
  if (codes.length && !hasStrong) return "cn";
  if (item.kind === "announcement" && codes.length) return "cn";
  if (hasGlobal && !hasCn) return "global";
  if (hasGlobal && hasCn) {
    // Both vocabularies present: count which appears first - headlines usually
    // lead with their actual subject.
    const firstGlobal = text.search(GLOBAL_RE);
    const firstCn = text.search(CN_RE);
    if (firstGlobal >= 0 && (firstCn < 0 || firstGlobal < firstCn)) return "global";
    return "cn";
  }
  if (hasCn) return "cn";
  if (codes.length) return "cn";
  return "cn";
}

export function tagRegions(items = []) {
  return items.map((item) => ({ ...item, region: classifyRegion(item) }));
}

export function splitByRegion(items = []) {
  const cn = [];
  const global = [];
  for (const item of items) {
    (classifyRegion(item) === "global" ? global : cn).push(item);
  }
  return { cn, global };
}

export function regionCounts(items = []) {
  const { cn, global } = splitByRegion(items);
  return { cn: cn.length, global: global.length };
}
