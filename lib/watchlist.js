// The watchlist, persisted.
//
// 自选 used to live only in `localStorage`, which is fine for a browser tab but
// invisible to the scheduled job: the nightly digest could only describe the
// market's top movers, never the names a user actually tracks. Keeping the list
// in the repo fixes that — CI reads the committed file, so the push covers
// whatever was in 自选 when it was last committed.
//
// The browser stays the source of truth while it is open; the file is the copy
// the pipeline can see.

export const WATCHLIST_LIMIT = 200;

/** A-share codes are six digits in every exchange, including 北交所. */
const CODE = /^\d{6}$/;

/**
 * Clean an arbitrary list into something safe to store and to send.
 *
 * @param {unknown} input
 * @returns {{codes: string[], rejected: number, truncated: boolean}}
 */
export function normalizeCodes(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  let rejected = 0;
  for (const raw of list) {
    const code = String(raw ?? "").trim();
    if (!CODE.test(code)) {
      rejected += 1;
      continue;
    }
    seen.add(code);
  }
  const sorted = [...seen].sort();
  return {
    codes: sorted.slice(0, WATCHLIST_LIMIT),
    rejected,
    truncated: sorted.length > WATCHLIST_LIMIT
  };
}

export function emptyWatchlist() {
  return { updatedAt: null, codes: [] };
}

/** Read a stored file defensively: a hand-edited watchlist must not 500 the API. */
export function parseWatchlist(raw) {
  if (!raw || typeof raw !== "object") return emptyWatchlist();
  const { codes } = normalizeCodes(raw.codes);
  return {
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    codes
  };
}
