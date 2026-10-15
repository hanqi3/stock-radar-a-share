/**
 * scripts/sync-sectors.js
 *
 * Builds data/sectors.json: A-share industry and concept boards plus their member
 * stock codes, so the app can compute real industry membership, industry relative
 * strength, and theme -> stock propagation.
 *
 * Source: Sina Finance market centre node tree + node member pages.
 *   1. getHQNodes          -> the whole board tree (~91 KB, one request)
 *   2. getHQNodeStockCount -> member total for one board (QUOTED JSON string)
 *   3. getHQNodeData       -> member rows for one board page (bare JSON array, num<=100)
 *
 * Both vip.stock.finance.sina.com.cn and money.finance.sina.com.cn serve the same
 * paths, so the second is used as a failover mirror.
 *
 * Zero dependencies, Node >= 18 (global fetch + AbortSignal.timeout).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(DATA_DIR, "sectors.json");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 700;
const PAGE_DELAY_MS = 60;
const PAGE_SIZE = 100;
const MIRRORS = ["https://vip.stock.finance.sina.com.cn", "https://money.finance.sina.com.cn"];
const CONCURRENCY = 6;

const SINA_API_PATH = "/quotes_service/api/json_v2.php";
const NODES_QUERY = "Market_Center.getHQNodes";
const SECTOR_SOURCE_URL = `${MIRRORS[0]}${SINA_API_PATH}/${NODES_QUERY}`;
const SOURCE_LABEL = "Sina Finance market centre node tree";

// Node id families. IN industry families hold the 31 申万行业 boards ("sw_mt" 煤炭,
// "sw_dlsb" 电力设备, "sw_yx" 银行). The gn_* family is the default concept set;
// chgn_* (热门概念) is roughly 3x the size and is opt-in via --include-hot-concepts.
const INDUSTRY_FAMILY = "sw_";
const CONCEPT_FAMILY = "gn_";
const HOT_CONCEPT_FAMILY = "chgn_";
const FAMILY_LABELS = [
  ["sw_", "申万行业"],
  ["sw1_", "申万一级"],
  ["sw2_", "申万二级"],
  ["sw3_", "申万三级"],
  ["gn_", "概念"],
  ["chgn_", "热门概念"],
  ["hangye_", "证监会行业"],
  ["diyu_", "地域"],
  ["new_", "新浪行业"]
];

const MIN_EXPECTED_INDUSTRIES = 31;
// A small number of stubborn pages is tolerable; a genuinely broken source is not.
const MAX_PAGE_FAILURE_RATIO = 0.1;
// Safety valve: a count endpoint that reports nonsense must not run away.
const MAX_PAGES_PER_NODE = 200;

const DEFAULT_NOTES =
  "Industries are the Sina 申万行业 (sw_*) board family (all 31 kept even when empty); " +
  "concepts are gn_* boards (chgn_* only with --include-hot-concepts). " +
  "count is the deduplicated member count; membership maps each 6-digit code to its board ids. " +
  "A board with count 0 is still listed in Sina's node tree but reports no members (retired id).";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * 400);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "-" || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * "sh600519" / "600519" / 600519 -> "600519". Returns null when the value does
 * not carry a 6-digit A-share code.
 */
function normalizeCode(value) {
  const cooked = String(value ?? "")
    .trim()
    .replace(/^(sh|sz|bj)/i, "")
    .trim();
  if (!cooked || !/^\d{1,6}$/.test(cooked)) return null;
  return cooked.padStart(6, "0");
}

/**
 * Runs `worker` over `items` with at most `limit` in flight. The worker is
 * expected to handle its own errors; results keep the input order.
 */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Pure, unit-testable helpers
// ---------------------------------------------------------------------------

/**
 * Flattens the getHQNodes tree into leaves. A leaf is a node whose third element
 * is a non-empty string id, e.g. ["煤炭", "", "sw_mt"]. Container nodes such as
 * ["申万二级", [...children...]] carry no id and are only traversed.
 *
 * @returns {{name: string, id: string}[]}
 */
function flattenNodes(tree) {
  const leaves = [];

  const walk = (node) => {
    if (!Array.isArray(node)) return;
    const id = typeof node[2] === "string" ? node[2].trim() : "";
    if (id) {
      leaves.push({ name: String(node[0] ?? "").trim(), id });
    }
    // Defensive: only recurse when there really is a child list. Verified against
    // the live tree, where no node carries both an id and children.
    if (Array.isArray(node[1])) {
      for (const child of node[1]) walk(child);
    }
  };

  walk(tree);
  return leaves;
}

/**
 * Filters leaves by id prefix ("sw_", ["gn_", "chgn_"], ...). Rows are returned in
 * input order and deduplicated by id, because the live tree repeats a few ids
 * (gn_hdgn, hgt_hk, sgt_sz, sgt_hk, zly_qh).
 *
 * @returns {{name: string, id: string}[]}
 */
function selectNodes(nodes, families) {
  const prefixes = (Array.isArray(families) ? families : [families])
    .filter((prefix) => typeof prefix === "string" && prefix)
    .map((prefix) => prefix.trim());
  const seen = new Set();
  const selected = [];

  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = typeof node?.id === "string" ? node.id.trim() : "";
    if (!id || seen.has(id)) continue;
    if (!prefixes.some((prefix) => id.startsWith(prefix))) continue;
    seen.add(id);
    selected.push({ name: String(node.name ?? "").trim(), id });
  }

  return selected;
}

/**
 * Parses the bare JSON array returned by getHQNodeData. Throws a descriptive
 * error for any other shape (HTML error page, `null`, wrapped object, ...) so the
 * caller can record it as a page failure instead of writing a partial file.
 *
 * Money is in CNY yuan and percentages in percent, matching scripts/sync-a-shares.js
 * (Sina reports mktcap in 万元, hence the *10000).
 *
 * @returns {{code: string, name: string, symbol: string, price: number|null,
 *            changePct: number|null, amount: number|null, marketCap: number|null,
 *            turnover: number|null}[]}
 */
function parseMembers(text) {
  const raw = String(text ?? "").trim();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`unexpected members payload (not JSON): ${raw.slice(0, 120)}`);
  }
  if (!Array.isArray(payload)) {
    throw new Error(
      `unexpected members payload shape (${payload === null ? "null" : typeof payload}); ` +
        `expected a bare JSON array: ${raw.slice(0, 120)}`
    );
  }

  return payload.map((row) => {
    const symbol = String(row?.symbol ?? "").trim();
    const code = normalizeCode(row?.code || symbol) ?? String(row?.code ?? "").trim();
    const mktcapWan = toNumber(row?.mktcap);
    return {
      code,
      name: String(row?.name ?? "").trim(),
      symbol,
      price: toNumber(row?.trade),
      changePct: toNumber(row?.changepercent),
      amount: toNumber(row?.amount),
      marketCap: mktcapWan === null ? null : Math.round(mktcapWan * 10000),
      turnover: toNumber(row?.turnoverratio)
    };
  });
}

/**
 * Number of pages needed for `total` rows of `size`. Deliberately no +1: the
 * count endpoint already reports the exact member total.
 */
function pageCountFor(total, size = PAGE_SIZE) {
  const count = Number(total);
  const perPage = Number(size);
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (!Number.isFinite(perPage) || perPage <= 0) return 0;
  return Math.ceil(count / perPage);
}

function normalizeMemberCodes(members) {
  const codes = new Set();
  for (const entry of members ?? []) {
    const raw = typeof entry === "string" ? entry : entry?.code ?? entry?.symbol ?? "";
    const code = normalizeCode(raw);
    if (code) codes.add(code);
  }
  return [...codes].sort();
}

function normalizeBoard(entry) {
  const id = typeof entry?.id === "string" ? entry.id.trim() : "";
  if (!id) return null;
  const name = String(entry?.name ?? "").trim() || id;
  const members = normalizeMemberCodes(entry?.members);
  return { id, name, count: members.length, members };
}

function dedupeBoards(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const board = normalizeBoard(entry);
    if (!board) continue;
    const existing = byId.get(board.id);
    if (!existing) {
      byId.set(board.id, board);
      continue;
    }
    // Same id twice in the tree: keep the first name, union the members.
    const members = normalizeMemberCodes([...existing.members, ...board.members]);
    byId.set(board.id, { id: board.id, name: existing.name || board.name, count: members.length, members });
  }
  return [...byId.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/**
 * Assembles the final on-disk object: boards sorted by descending member count,
 * duplicate boards merged, and a code -> board ids membership index.
 *
 * @param {{industries?: any[], concepts?: any[], generatedAt?: string,
 *          sourceUrl?: string, notes?: string}} input
 */
function buildSectorIndex(input = {}) {
  const industries = dedupeBoards(input.industries ?? []);
  const concepts = dedupeBoards(input.concepts ?? []);

  const membership = new Map();
  const bucket = (code) => {
    let entry = membership.get(code);
    if (!entry) {
      entry = { industries: new Set(), concepts: new Set() };
      membership.set(code, entry);
    }
    return entry;
  };
  for (const board of industries) for (const code of board.members) bucket(code).industries.add(board.id);
  for (const board of concepts) for (const code of board.members) bucket(code).concepts.add(board.id);

  const orderedMembership = {};
  for (const code of [...membership.keys()].sort()) {
    const entry = membership.get(code);
    orderedMembership[code] = {
      industries: [...entry.industries].sort(),
      concepts: [...entry.concepts].sort()
    };
  }

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: "sina",
    sourceLabel: SOURCE_LABEL,
    sourceUrl: input.sourceUrl ?? SECTOR_SOURCE_URL,
    industries,
    concepts,
    membership: orderedMembership,
    notes: input.notes ?? DEFAULT_NOTES
  };
}

// ---------------------------------------------------------------------------
// Network layer: mirror failover + exponential backoff
// ---------------------------------------------------------------------------

let activeMirror = MIRRORS[0];

function mirrorOrder() {
  return [activeMirror, ...MIRRORS.filter((mirror) => mirror !== activeMirror)];
}

function apiUrl(pathAndQuery, mirror = activeMirror) {
  return `${mirror}${SINA_API_PATH}/${pathAndQuery}`;
}

function memberPageQuery(nodeId, page) {
  return (
    `Market_Center.getHQNodeData?page=${page}&num=${PAGE_SIZE}&sort=symbol&asc=1` +
    `&node=${encodeURIComponent(nodeId)}&symbol=&_s_r_a=page`
  );
}

async function sinaRequest(pathAndQuery, label = "") {
  const failures = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    for (const mirror of mirrorOrder()) {
      try {
        const response = await fetch(apiUrl(pathAndQuery, mirror), {
          headers: { "user-agent": BROWSER_UA, referer: "https://finance.sina.com.cn/" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const text = await response.text();
        if (mirror !== activeMirror) {
          console.log(`switched data host to ${mirror}`);
          activeMirror = mirror;
        }
        return text;
      } catch (error) {
        const message = error?.message || String(error);
        failures.push(`${mirror} attempt ${attempt}: ${message}`);
        console.warn(`WARN: [sina] ${label || pathAndQuery} ${mirror} attempt ${attempt}: ${message}`);
      }
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(jitter(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }

  throw new Error(`sina request failed after ${MAX_ATTEMPTS} attempts:\n    ${failures.join("\n    ")}`);
}

/**
 * Fetches and parses the whole board tree (root is ["行情中心", [...children...]]).
 */
async function fetchNodeTree() {
  const text = (await sinaRequest(NODES_QUERY, "getHQNodes")).trim();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`unexpected node tree payload (not JSON): ${text.slice(0, 120)}`);
  }
  if (!Array.isArray(payload)) {
    throw new Error(`unexpected node tree shape (${typeof payload}); expected a nested array`);
  }
  return payload;
}

/**
 * Member total from a getHQNodeStockCount payload.
 *
 * The endpoint answers with a QUOTED JSON string (`"5573"`), so JSON.parse is
 * mandatory: Number('"5573"') is NaN and would silently yield 0 pages.
 *
 * A bare `[]` is a real answer, not a broken response: the live tree still lists
 * retired board ids (37 of the 213 gn_* boards today) whose count AND member
 * endpoints both answer `[]`. Treating that as a failure would blow the 10%
 * failure budget and stop the nightly sync, so it maps to 0 members instead.
 * Anything else non-numeric throws.
 *
 * @returns {number} 0 for an empty board, otherwise the member total.
 */
function parseMemberCount(text, label = "node") {
  const raw = String(text ?? "").trim();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`unexpected stock count payload for ${label} (not JSON): ${raw.slice(0, 80)}`);
  }
  if (Array.isArray(payload) && payload.length === 0) return 0;
  const total =
    typeof payload === "number"
      ? payload
      : typeof payload === "string" && payload.trim() !== ""
        ? Number(payload)
        : Number.NaN;
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`unexpected stock count payload for ${label}: ${raw.slice(0, 80)}`);
  }
  return total;
}

/**
 * Member total for one board.
 */
async function fetchMemberCount(nodeId) {
  const text = await sinaRequest(
    `Market_Center.getHQNodeStockCount?node=${encodeURIComponent(nodeId)}`,
    `count ${nodeId}`
  );
  return parseMemberCount(text, nodeId);
}

/**
 * Fetches every member page of one board.
 *
 * `pageCount` (optional):
 *   - a positive number: pages to fetch, taken from getHQNodeStockCount. Paging
 *     still stops on the first short page and, if the last planned page is full,
 *     the walk extends once per full page (the reported count can lag the data).
 *   - 0: the board is known to hold no members (a retired id) -> no request.
 *   - absent/null: probe pages until the first short page (used when the count
 *     request itself failed).
 *
 * Pages that exhaust their retries are reported in `failures` instead of throwing,
 * so one bad board cannot abort the run.
 *
 * @param {string} nodeId
 * @param {{pageCount?: number|null}} [options]
 * @returns {Promise<{nodeId: string, rows: any[], members: string[], pages: number,
 *                    failures: {nodeId: string, page: number, message: string}[]}>}
 */
async function fetchMembers(nodeId, options = {}) {
  const planned = options.pageCount;
  const hasPlan = planned !== null && planned !== undefined && Number.isFinite(Number(planned));
  if (hasPlan && Number(planned) <= 0) {
    return { nodeId, rows: [], members: [], pages: 0, failures: [] };
  }

  const failures = [];
  const rows = [];
  let pages = 0;
  let limit = hasPlan ? Math.min(Number(planned), MAX_PAGES_PER_NODE) : 1;
  let page = 1;

  while (page <= limit) {
    const current = page;
    page += 1;
    try {
      const text = (await sinaRequest(memberPageQuery(nodeId, current), `${nodeId} page ${current}`)).trim();
      const parsed = parseMembers(text);
      if (parsed.length === 0) {
        // With a count in hand, page 1 must hold rows: an empty answer means the
        // data endpoint disagrees with the count and the board is unreliable.
        if (current === 1 && hasPlan) {
          throw new Error(`empty page payload (page 1) but the node reported ${Number(planned)} member(s)`);
        }
        // Otherwise a later empty page is just the end of the list.
        break;
      }
      pages += 1;
      rows.push(...parsed);
      if (parsed.length < PAGE_SIZE) break;
      if (current === limit && limit < MAX_PAGES_PER_NODE) {
        limit += 1; // the reported count was short; keep walking
      }
    } catch (error) {
      failures.push({ nodeId, page: current, message: error?.message || String(error) });
      console.warn(`WARN: [sina] ${nodeId} page ${current}: ${error?.message || error}`);
    }
    if (PAGE_DELAY_MS > 0) await sleep(PAGE_DELAY_MS);
  }

  const members = normalizeMemberCodes(rows);
  return { nodeId, rows, members, pages, failures };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parsePositiveInt(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${flag} expects a non-negative integer, got: ${value}`);
  }
  return number;
}

function parseArgs(argv = []) {
  const options = {
    industriesOnly: false,
    includeHotConcepts: false,
    maxConcepts: null,
    concurrency: CONCURRENCY,
    out: OUT_FILE,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const takeValue = () => {
      if (inline !== null) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} expects a value`);
      return String(argv[index]);
    };

    if (arg === "--industries-only") options.industriesOnly = true;
    else if (arg === "--include-hot-concepts") options.includeHotConcepts = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (flag === "--max-concepts") options.maxConcepts = parsePositiveInt(takeValue(), flag);
    else if (flag === "--concurrency") {
      const value = parsePositiveInt(takeValue(), flag);
      if (value < 1) throw new Error(`${flag} expects an integer >= 1, got: ${value}`);
      options.concurrency = value;
    } else if (flag === "--out") options.out = path.resolve(process.cwd(), takeValue());
    else throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/sync-sectors.js [options]",
      "",
      "  --industries-only        sync only the 31 sw_* 申万行业 boards",
      "  --include-hot-concepts   also sync the 705 chgn_* 热门概念 boards (slow)",
      "  --max-concepts N         only sync the first N gn_* concept boards",
      "  --concurrency N          parallel board workers (default 6)",
      "  --out <path>             output file (default data/sectors.json)",
      "  -h, --help               show this message"
    ].join("\n")
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return null;
  }

  const startedAt = Date.now();
  const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1);
  await fs.mkdir(path.dirname(options.out), { recursive: true });

  console.log(`Fetching Sina board tree from ${SECTOR_SOURCE_URL}`);
  const tree = await fetchNodeTree();
  const nodes = flattenNodes(tree);
  console.log(`Board tree: ${nodes.length} leaf nodes`);
  for (const [family, label] of FAMILY_LABELS) {
    console.log(`  ${family.padEnd(8)} ${label}  ${selectNodes(nodes, family).length}`);
  }

  const industries = selectNodes(nodes, INDUSTRY_FAMILY);
  const conceptFamilies = options.includeHotConcepts
    ? [CONCEPT_FAMILY, HOT_CONCEPT_FAMILY]
    : [CONCEPT_FAMILY];
  let concepts = options.industriesOnly ? [] : selectNodes(nodes, conceptFamilies);
  if (options.industriesOnly && options.includeHotConcepts) {
    console.warn("WARN: [sina] --include-hot-concepts ignored because --industries-only is set");
  }
  if (options.maxConcepts !== null && concepts.length > options.maxConcepts) {
    console.log(`Limiting concepts to the first ${options.maxConcepts} of ${concepts.length} board(s)`);
    concepts = concepts.slice(0, options.maxConcepts);
  }

  const boards = [
    ...industries.map((board) => ({ ...board, kind: "industry" })),
    ...concepts.map((board) => ({ ...board, kind: "concept" }))
  ];
  console.log(
    `Planned: ${industries.length} industry + ${concepts.length} concept board(s), ` +
      `concurrency ${options.concurrency}`
  );

  const failures = [];

  const counted = await mapPool(boards, options.concurrency, async (board) => {
    try {
      const total = await fetchMemberCount(board.id);
      return { board, total, pageCount: pageCountFor(total) };
    } catch (error) {
      const message = error?.message || String(error);
      failures.push({ nodeId: board.id, page: 0, message: `member count failed: ${message}` });
      console.warn(`WARN: [sina] ${board.id} member count failed: ${message}`);
      // Count unknown: fall back to probing pages until the first short page.
      return { board, total: null, pageCount: null };
    }
  });
  const emptyBoards = counted.filter(
    (entry) => Number.isFinite(entry.pageCount) && entry.pageCount === 0
  ).length;

  let pagesFetched = 0;
  let rowsFetched = 0;
  const collected = new Map();

  const results = await mapPool(counted, options.concurrency, async ({ board, pageCount }) => {
    const result = await fetchMembers(board.id, { pageCount });
    pagesFetched += result.pages;
    rowsFetched += result.rows.length;
    failures.push(...result.failures);
    collected.set(board.id, result.members);
    return result;
  });

  const attempted = pagesFetched + failures.length;
  if (attempted > 0 && failures.length / attempted > MAX_PAGE_FAILURE_RATIO) {
    throw new Error(
      `refusing to write a partial ${path.relative(ROOT, options.out)}: ` +
        `${failures.length} of ${attempted} request(s) failed (limit ${Math.round(
          MAX_PAGE_FAILURE_RATIO * 100
        )}%)`
    );
  }

  const index = buildSectorIndex({
    industries: industries.map((board) => ({ ...board, members: collected.get(board.id) ?? [] })),
    concepts: concepts.map((board) => ({ ...board, members: collected.get(board.id) ?? [] })),
    generatedAt: new Date().toISOString(),
    sourceUrl: SECTOR_SOURCE_URL,
    notes:
      DEFAULT_NOTES +
      (failures.length > 0
        ? ` ${failures.length} request(s) failed and those boards may be short of members: ` +
          failures
            .slice(0, 10)
            .map((failure) => `${failure.nodeId}${failure.page ? `#${failure.page}` : ""}`)
            .join(", ")
        : "")
  });

  if (index.industries.length < MIN_EXPECTED_INDUSTRIES) {
    throw new Error(
      `refusing to write: only ${index.industries.length} of ${MIN_EXPECTED_INDUSTRIES} expected sw_* industries`
    );
  }

  await fs.writeFile(options.out, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const membershipCodes = Object.keys(index.membership).length;
  console.log(
    `Summary: industries=${index.industries.length} concepts=${index.concepts.length} ` +
      `pages=${pagesFetched} rows=${rowsFetched} failures=${failures.length} ` +
      `boards=${results.length} emptyBoards=${emptyBoards} memberCodes=${membershipCodes} ` +
      `elapsed=${elapsed()}s`
  );
  if (emptyBoards > 0) {
    console.log(
      `Note: ${emptyBoards} board(s) are still listed in the Sina tree but report no members ` +
        `(retired ids); they are kept with count 0 and an empty member list.`
    );
  }
  for (const failure of failures.slice(0, 10)) {
    console.warn(`WARN: [sina] ${failure.nodeId}${failure.page ? ` page ${failure.page}` : ""}: ${failure.message}`);
  }
  if (failures.length > 10) console.warn(`WARN: [sina] ...and ${failures.length - 10} more failure(s)`);
  console.log(`Wrote ${path.relative(ROOT, options.out)} at ${index.generatedAt} (${elapsed()}s)`);

  return index;
}

export {
  main,
  fetchNodeTree,
  fetchMemberCount,
  fetchMembers,
  parseMembers,
  parseMemberCount,
  flattenNodes,
  selectNodes,
  pageCountFor,
  buildSectorIndex,
  parseArgs,
  MIRRORS,
  DATA_DIR,
  OUT_FILE
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
