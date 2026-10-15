/**
 * Local disk cache for daily K-line history.
 *
 * History is derived, refetchable data: committing a multi-megabyte series for
 * 5,000+ stocks would churn the repository every single day for no benefit, so
 * it lives in a git-ignored cache directory instead.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { fetchDailyBars } from "./history.js";

export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function fileFor(dir, code) {
  return path.join(dir, `${code}.json`);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function isFresh(record, ttlMs, days, now) {
  if (!record?.bars?.length) return false;
  if (record.bars.length < days) return false;
  const updated = Date.parse(record.updatedAt || 0);
  if (!Number.isFinite(updated)) return false;
  return now - updated < ttlMs;
}

export function createHistoryCache(dir, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const days = options.days ?? 250;
  const fetchImpl = options.fetchImpl ?? options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20000;
  let inflight = new Map();

  async function load(code) {
    return readJson(fileFor(dir, code));
  }

  async function save(record) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fileFor(dir, record.code), `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  /**
   * Return cached bars, fetching from the network when the cache is missing,
   * stale, or too shallow for the requested window.
   */
  async function get(code, exchange, request = {}) {
    const wantDays = request.days ?? days;
    const force = request.force === true;
    const now = request.now ?? Date.now();

    if (!force) {
      const cached = await load(code);
      if (isFresh(cached, ttlMs, wantDays, now)) return { ...cached, cached: true };
    }

    const key = `${code}:${wantDays}`;
    if (inflight.has(key)) return inflight.get(key);

    const pending = (async () => {
      const result = await fetchDailyBars(code, exchange, { days: wantDays, timeoutMs, fetchImpl });
      const record = {
        code,
        exchange,
        source: result.source,
        days: result.bars.length,
        updatedAt: new Date(now).toISOString(),
        bars: result.bars
      };
      await save(record);
      return { ...record, cached: false };
    })();

    inflight.set(key, pending);
    try {
      return await pending;
    } finally {
      inflight.delete(key);
    }
  }

  return { get, load, save, dir };
}

export const cacheFileFor = fileFor;
