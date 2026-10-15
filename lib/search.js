/**
 * Search matching for the A-share universe.
 *
 * Supports Chinese names, stock codes, full pinyin and pinyin initials, e.g.
 * 600519 / 贵州茅台 / guizhoumaotai / gzmt all resolve to the same row.
 *
 * The pinyin table lives in `lib/pinyin-index.json`, generated offline by
 * `scripts/build-pinyin-index.js`, so this module has no dependencies.
 */

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const ALNUM = /[a-z0-9]/;

export const EMPTY_LOOKUP = { chars: {}, names: {} };

export function normalizeQuery(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s·．.\-_/]+/g, "");
}

/** Resolve one name to its full pinyin and its initials. */
export function pinyinOf(name, lookup = EMPTY_LOOKUP) {
  const key = String(name || "").trim();
  if (!key) return { pinyin: "", initials: "" };

  const exact = lookup?.names?.[key];
  if (Array.isArray(exact) && exact.length === 2) {
    return { pinyin: exact[0] || "", initials: exact[1] || "" };
  }

  // A listing created after the last regeneration falls back to the per-char
  // table, which is context-free but still better than no phonetics at all.
  const chars = lookup?.chars || {};
  let pinyin = "";
  let initials = "";
  for (const ch of key) {
    if (HAN.test(ch)) {
      const syllable = chars[ch];
      if (!syllable) continue;
      pinyin += syllable;
      initials += syllable[0];
    } else if (ALNUM.test(ch)) {
      const lower = ch.toLowerCase();
      pinyin += lower;
      initials += lower;
    }
  }
  return { pinyin, initials };
}

/** Precompute immutable search keys for a stock universe. */
export function buildSearchIndex(stocks, lookup = EMPTY_LOOKUP) {
  const index = new Map();
  for (const stock of stocks) {
    const code = String(stock.code ?? "").trim();
    if (!code) continue;
    const name = String(stock.name || "").trim();
    const { pinyin, initials } = pinyinOf(name, lookup);
    index.set(code, {
      code,
      name,
      lowerName: name.toLowerCase(),
      pinyin,
      initials,
      industry: String(stock.industry || "").trim()
    });
  }
  return index;
}

export const MATCH_SCORE = {
  codeExact: 120,
  codePrefix: 100,
  namePrefix: 90,
  pinyinPrefix: 80,
  initialsPrefix: 70,
  nameContains: 55,
  pinyinContains: 45,
  initialsContains: 35,
  industryContains: 20
};

/** Relevance of one indexed row against an already-normalised query. */
export function scoreEntry(entry, query) {
  const q = typeof query === "string" ? query : normalizeQuery(query);
  if (!q) return 0;
  if (entry.code === q) return MATCH_SCORE.codeExact;
  if (entry.code.startsWith(q)) return MATCH_SCORE.codePrefix;
  if (entry.lowerName.startsWith(q)) return MATCH_SCORE.namePrefix;
  if (entry.pinyin.startsWith(q)) return MATCH_SCORE.pinyinPrefix;
  if (entry.initials.startsWith(q)) return MATCH_SCORE.initialsPrefix;
  if (entry.lowerName.includes(q)) return MATCH_SCORE.nameContains;
  if (entry.pinyin.includes(q)) return MATCH_SCORE.pinyinContains;
  if (entry.initials.includes(q)) return MATCH_SCORE.initialsContains;
  if (entry.industry && entry.industry.toLowerCase().includes(q)) return MATCH_SCORE.industryContains;
  return 0;
}

export function matchesQuery(entry, query) {
  const q = typeof query === "string" ? query : normalizeQuery(query);
  // An empty query is not a filter at all.
  if (!q) return true;
  return scoreEntry(entry, q) > 0;
}

/** Ranked suggestions, strongest match first. */
export function suggest(index, query, limit = 10) {
  const q = normalizeQuery(query);
  if (!q) return [];
  const hits = [];
  for (const entry of index.values()) {
    const score = scoreEntry(entry, q);
    if (score > 0) hits.push({ ...entry, score });
  }
  hits.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return Number.isFinite(limit) && limit > 0 ? hits.slice(0, limit) : hits;
}
