import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "all-a-shares.json");
const SAMPLE_FILE = path.join(ROOT, "data", "sample-a-shares.json");
const META_FILE = path.join(ROOT, "data", "meta.json");
const PROFILES_FILE = path.join(ROOT, "data", "profiles.json");

async function readJson(file) {
  const content = await fs.readFile(file, "utf8");
  return JSON.parse(content);
}

async function main() {
  let source = DATA_FILE;
  try {
    await fs.access(DATA_FILE);
  } catch {
    source = SAMPLE_FILE;
  }

  const stocks = await readJson(source);
  const meta = await readJson(META_FILE).catch(() => ({}));
  const codes = new Set(stocks.map((stock) => stock.code));
  const exchangeCounts = stocks.reduce((acc, stock) => {
    acc[stock.exchange] = (acc[stock.exchange] || 0) + 1;
    return acc;
  }, {});

  if (codes.size !== stocks.length) {
    throw new Error(`Duplicate stock codes detected: ${stocks.length - codes.size}`);
  }

  console.log(`Data file: ${path.relative(ROOT, source)}`);
  console.log(`Stocks: ${stocks.length}`);
  console.log(`Exchanges: ${JSON.stringify(exchangeCounts)}`);
  console.log(`Updated at: ${meta.updatedAt || "unknown"}`);

  // The profile snapshot feeds the PE column and the quote grid; a partial file
  // silently blanks those fields, so report how much is covered — and by which
  // vendor, because 东财 is the primary source and 腾讯 only serves as fallback.
  const profiles = await readJson(PROFILES_FILE).catch(() => null);
  if (!profiles) {
    console.log("Profiles: missing (run `npm run profiles`)");
  } else {
    const covered = Object.keys(profiles.items || {}).filter((code) => codes.has(code)).length;
    const coverage = stocks.length ? covered / stocks.length : 0;
    console.log(
      `Profiles: ${covered}/${stocks.length} covered (${(coverage * 100).toFixed(1)}%), ` +
        `updated ${profiles.generatedAt || "unknown"} via ${profiles.source || "unknown source"}`
    );
    if (coverage < 0.98) {
      throw new Error(`Profile coverage too low: ${(coverage * 100).toFixed(1)}% < 98%`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
