#!/bin/sh
# Container entrypoint: optionally start busybox crond for the daily sync,
# then hand over to the server process.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR" /app/.cache/history

if [ "${ENABLE_CRON:-1}" = "1" ] && command -v crond >/dev/null 2>&1; then
  # Busybox crond reads /etc/crontabs/root; times are container-local (set TZ).
  {
    echo "${SYNC_CRON:-30 17 * * 1-5} sh /app/scripts/daily-sync.sh >> ${DATA_DIR}/sync.log 2>&1"
    echo "${NEWS_CRON:-30 12 * * 1-5} sh /app/scripts/daily-sync.sh news >> ${DATA_DIR}/sync.log 2>&1"
  } > /etc/crontabs/root
  crond -b -l 8 || echo "stockradar: crond failed to start, daily sync disabled"
fi

exec "$@"
