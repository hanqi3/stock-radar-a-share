/**
 * Regenerates `lib/pinyin-index.json`.
 *
 * The index is committed so the runtime never needs a pinyin dependency (the
 * project ships with zero dependencies and CI installs nothing). It stores an
 * exact entry for every name currently in the universe plus a per-character
 * fallback, so a newly listed stock still gets a usable phonetics match before
 * the next regeneration.
 *
 * Requires pinyin-pro, installed on demand:
 *   npm install --no-save pinyin-pro && npm run index:pinyin
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pinyin } from "pinyin-pro";

import { THEME_KEYWORDS } from "../lib/events.js";
import { stripNamePrefix } from "../lib/search.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = path.join(ROOT, "data", "all-a-shares.json");
const BOARDS_FILE = path.join(ROOT, "lib", "boards.js");
const OUT_FILE = path.join(ROOT, "lib", "pinyin-index.json");

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;

function fullPinyin(text) {
  return pinyin(text, { toneType: "none", type: "string", nonZh: "removed" }).replace(/\s+/g, "");
}

function initials(text) {
  return pinyin(text, { toneType: "none", pattern: "first", type: "array", nonZh: "removed" }).join("");
}

async function collectText() {
  const stocks = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  const parts = [];
  for (const stock of stocks) {
    if (stock.name) parts.push(String(stock.name));
    if (stock.industry) parts.push(String(stock.industry));
  }
  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    parts.push(theme);
    parts.push(...keywords);
  }
  const boards = await fs.readFile(BOARDS_FILE, "utf8");
  for (const match of boards.matchAll(/[\u4e00-\u9fff]{2,}/g)) parts.push(match[0]);
  // Characters a future listing might plausibly need, beyond today's universe.
  parts.push("中国证券银行长江长城重庆长安重工石油石化科技股份有限公司集团控股发展实业能源电力医药生物半导体芯片智能装备新材料环保传媒通信计算机汽车家电食品饮料农业有色金属煤炭钢铁建筑工程房地产交通运输旅游酒店零售贸易金融保险信托租赁物流航空港口航运船舶军工航天卫星核电风电光伏储能电池氢能机器人数控机床仪器仪表量子和软件互联网数据云服务区块链游戏影视教育医疗健康养老化妆品纺织服装纸业包装印刷化工化学橡胶塑料玻璃陶瓷水泥矿业勘探冶炼加工制造销售服务咨询");

  const chars = new Set();
  for (const part of parts) {
    for (const ch of part) if (HAN.test(ch)) chars.add(ch);
  }
  return { stocks, chars };
}

async function main() {
  const { stocks, chars } = await collectText();

  // Exact entries: pinyin-pro resolves polyphones with full-name context, which
  // a per-character table cannot (银行 → yinhang, 长江 → changjiang).
  //
  // The key is the *bare* name: 片仔癀 is listed as XD片仔癀 on its ex-dividend
  // day and as C联亚 during a debut week, and those decorations change daily.
  // Indexing them verbatim used to make phonetics depend on which day the file
  // was generated. The decorated spelling is kept as an alias so an exact lookup
  // by the name as it appears in the table still hits.
  const names = {};
  for (const stock of stocks) {
    const name = String(stock.name || "").trim();
    if (!name || !HAN.test(name)) continue;
    const bare = stripNamePrefix(name);
    const entry = [fullPinyin(bare), initials(bare)];
    names[bare] = entry;
    if (name !== bare) names[name] = entry;
  }

  const charMap = {};
  for (const ch of [...chars].sort()) {
    const p = pinyin(ch, { toneType: "none", type: "array", nonZh: "removed" })[0];
    if (p) charMap[ch] = p;
  }

  // Keep the committed file stable: `generatedAt` only moves when the content
  // does, otherwise every CI run would churn a 200 KB blob for nothing.
  let previous = null;
  try {
    previous = JSON.parse(await fs.readFile(OUT_FILE, "utf8"));
  } catch {
    previous = null;
  }
  const unchanged =
    previous &&
    JSON.stringify(previous.names) === JSON.stringify(names) &&
    JSON.stringify(previous.chars) === JSON.stringify(charMap);
  if (unchanged) {
    console.log(
      `${path.relative(ROOT, OUT_FILE)} already current: ${Object.keys(names).length} names, ${Object.keys(charMap).length} chars`
    );
    return;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    generator: "pinyin-pro",
    note: "Exact bare-name entries plus a per-character fallback. Regenerate with: npm install --no-save pinyin-pro && npm run index:pinyin",
    chars: charMap,
    names
  };

  await fs.writeFile(OUT_FILE, `${JSON.stringify(payload)}\n`, "utf8");
  const size = (await fs.stat(OUT_FILE)).size;
  console.log(
    `Wrote ${path.relative(ROOT, OUT_FILE)}: ${Object.keys(names).length} names, ${Object.keys(charMap).length} chars, ${(size / 1024).toFixed(0)} KB`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
