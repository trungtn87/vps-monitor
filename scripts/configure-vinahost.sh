#!/usr/bin/env bash
# VPS Monitor VinaHost deployment helper. Run AFTER scripts/install.sh vinahost.
# Secrets are read from a root-owned env file provided by the VPS owner.
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then echo "Run as root"; exit 1; fi
PRIVATE_ENV="${1:-/root/vps-monitor-private.env}"
INSTALL_DIR="/opt/vps-monitor"
[[ -f "$PRIVATE_ENV" ]] || { echo "Missing credentials file: $PRIVATE_ENV"; exit 1; }
[[ -f "$INSTALL_DIR/src/server.js" ]] || { echo "Run scripts/install.sh vinahost first"; exit 1; }
# Do not eval or source untrusted credential file. Extract only exact expected keys.
getval() { sed -n "s/^$1=//p" "$PRIVATE_ENV" | tail -n1; }
DB_URL="$(getval DATABASE_URL)"
SHARED_SECRET="$(getval HEARTBEAT_SECRET)"
[[ "$DB_URL" == postgresql://* || "$DB_URL" == postgres://* ]] || {
  echo "DATABASE_URL must be PostgreSQL"; exit 1;
}
[[ "$DB_URL" == *gmpgtwtxhjwjeincvkxn* ]] || {
  echo "DATABASE_URL must target dedicated VPS-Monitor Supabase project"; exit 1;
}
[[ "${#SHARED_SECRET}" -ge 32 ]] || { echo "HEARTBEAT_SECRET must be >= 32 characters"; exit 1; }
[[ "$DB_URL" != *$'\n'* && "$DB_URL" != *$'\r'* ]] || { echo "Invalid DB URL"; exit 1; }
[[ "$SHARED_SECRET" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "Invalid heartbeat secret characters"; exit 1; }

# Only write the Monitor's own config; do not edit 11Ship configuration.
TEMP_ENV="$(mktemp "$INSTALL_DIR/.env.new.XXXXXXXX")"
trap 'rm -f "$TEMP_ENV"' EXIT
cat > "$TEMP_ENV" <<EOF
NODE_ENV=production
SERVER_ID=vinahost
SERVER_NAME=VinaHost (11Ship)
HOST=127.0.0.1
PORT=5050
TRUSTED_PLATFORM_PROXY=true
PUBLIC_DASHBOARD=true
REQUIRE_TLS=false
DB_BACKEND=supabase_postgres
DATABASE_URL=$DB_URL
HEARTBEAT_SECRET=$SHARED_SECRET
PEER_SERVER_ID=nhanhoa
PEER_SERVER_NAME=Nhân Hòa (AutoTrade)
PEER_URL=https://vibetpmzwpxt7.vibe3.vnws.com
PEER_METRIC_SCOPE=CONTAINER
HEARTBEAT_INTERVAL_SEC=60
DISCONNECT_THRESHOLD_SEC=180
STARTUP_GRACE_SEC=1800
# Payment dates confirmed 2026-11-01; change after renewal.
EXPIRY_DATE=2027-01-12
PEER_EXPIRY_DATE=2026-11-30
APP_SERVICE_ID=11ship
APP_SERVICE_NAME=11Ship Backend
APP_HEALTH_URL=http://127.0.0.1:3000/v1/health/ready
RETENTION_DAYS=30
CPU_THRESHOLD_PCT=85
RAM_THRESHOLD_PCT=85
DISK_THRESHOLD_PCT=85
CONSECUTIVE_THRESHOLD_COUNT=3
EOF

# Prevent false app-down alerts if the previously reported 11Ship readiness
# endpoint is no longer present.
if ! curl --max-time 5 --silent --fail -o /dev/null   "http://127.0.0.1:3000/v1/health/ready"; then
  sed -i 's|^APP_HEALTH_URL=.*|APP_HEALTH_URL=|' "$TEMP_ENV"
  echo "11Ship health URL unavailable; app probe disabled pending verification."
fi
chown vpsmon:vpsmon "$TEMP_ENV"
chmod 600 "$TEMP_ENV"
if [[ -f "$INSTALL_DIR/.env" ]]; then
  cp -p "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.bak.$(date -u +%Y%m%dT%H%M%SZ)"
fi
mv -f "$TEMP_ENV" "$INSTALL_DIR/.env"
trap - EXIT

# Install only Monitor's Node dependency. Never run npm in 11Ship's directory.
runuser -u vpsmon -- npm install --prefix "$INSTALL_DIR" --omit=dev --no-audit --no-fund
systemctl daemon-reload
systemctl enable vps-monitor >/dev/null
systemctl restart vps-monitor
for i in $(seq 1 20); do
  if curl --max-time 3 -fsS "http://127.0.0.1:5050/healthz"; then
    echo; echo "VinaHost VPS Monitor is running on localhost:5050"
    exit 0
  fi
  sleep 2
done
echo "Monitor is not healthy; latest systemd logs:"
journalctl -u vps-monitor -n 35 --no-pager | sed -E 's#(postgresql?|DATABASE_URL)[^[:space:]]+#<redacted-connection>#g'
exit 1
