#!/usr/bin/env bash
# One-command setup for StockRadar on a fresh Ubuntu / Debian VPS.
#
#   cd /opt/stockradar            # the cloned repo
#   sudo ./deploy/install.sh stockradar.example.com
#
# What it does:
#   * installs Node 22 if needed
#   * creates a stockradar system user and /var/lib/stockradar for data
#   * installs and starts the systemd service (auto-restart on boot)
#   * schedules the daily sync at 17:30 and a news refresh at 12:30 (Mon-Fri)
#   * with a domain argument: installs Caddy and serves HTTPS in front
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-/var/lib/stockradar}"
NODE_MAJOR="${NODE_MAJOR:-22}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行：sudo ./deploy/install.sh [域名]" >&2
  exit 1
fi

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

say "Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v

say "System user and data directory"
if ! id -u stockradar >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin stockradar
fi
mkdir -p "$DATA_DIR" "$DATA_DIR/watchlists" "$APP_DIR/.cache/history"
if [ ! -f "$DATA_DIR/meta.json" ]; then
  cp -n "$APP_DIR"/data/*.json "$DATA_DIR"/ 2>/dev/null || true
fi
chown -R stockradar:stockradar "$DATA_DIR" "$APP_DIR/.cache"
chmod +x "$APP_DIR/scripts/daily-sync.sh"

say "systemd service"
install -m 0644 "$APP_DIR/deploy/stockradar.service" /etc/systemd/system/stockradar.service
sed -i "s#^WorkingDirectory=.*#WorkingDirectory=$APP_DIR#; s#^Environment=DATA_DIR=.*#Environment=DATA_DIR=$DATA_DIR#" \
  /etc/systemd/system/stockradar.service
systemctl daemon-reload
systemctl enable stockradar
systemctl restart stockradar

say "Daily sync (cron)"
timedatectl set-timezone Asia/Shanghai 2>/dev/null || true
cat > /etc/cron.d/stockradar <<EOF
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CRON_TZ=Asia/Shanghai
30 17 * * 1-5 stockradar DATA_DIR=$DATA_DIR sh $APP_DIR/scripts/daily-sync.sh >> $DATA_DIR/cron.log 2>&1
30 12 * * 1-5 stockradar DATA_DIR=$DATA_DIR sh $APP_DIR/scripts/daily-sync.sh news >> $DATA_DIR/cron.log 2>&1
EOF
chmod 0644 /etc/cron.d/stockradar

if [ -n "$DOMAIN" ]; then
  say "Caddy + HTTPS for $DOMAIN"
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update && apt-get install -y caddy
  fi
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}
	reverse_proxy 127.0.0.1:5173
}
EOF
  systemctl reload caddy || systemctl restart caddy
  say "打开 https://$DOMAIN"
else
  say "没给域名：先用 ssh -L 5173:127.0.0.1:5173 user@server 在本地打开 http://localhost:5173"
fi

say "完成"
systemctl --no-pager --lines=5 status stockradar || true
echo "健康检查：curl -s http://127.0.0.1:5173/api/health"
echo "同步日志：tail -f $DATA_DIR/cron.log"
