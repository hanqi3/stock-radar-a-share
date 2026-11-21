#!/bin/sh
# Daily data sync for StockRadar on Linux / inside the container.
# Quotes first, then the enrich chain. Logs to data/sync.log.
#
#   ./scripts/daily-sync.sh          full run (after the close)
#   ./scripts/daily-sync.sh news     news + events only (usable intraday)

set -u
cd "$(dirname "$0")/.." || exit 1
LOG="${DATA_DIR:-data}/sync.log"
mkdir -p "$(dirname "$LOG")"

log() { echo "==== $(date '+%F %T') $* ====" >> "$LOG"; }

run() {
  echo "---- $* ----" >> "$LOG"
  "$@" >> "$LOG" 2>&1 || { log "FAILED: $*"; exit 1; }
}

if [ "${1:-}" = "news" ]; then
  log "news refresh start"
  run node scripts/sync-news.js
  log "news refresh done"
  exit 0
fi

log "sync start"
run node scripts/sync-a-shares.js
run node scripts/check-data.js
run node scripts/sync-sectors.js
run node scripts/sync-history.js
run node scripts/sync-profiles.js
run node scripts/sync-news.js
run node scripts/sync-macro.js
run node scripts/sync-flow.js
log "sync done"
