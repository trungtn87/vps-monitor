#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — Safe Update Script
# Creates a transaction-consistent backup snapshot, updates code, restarts service, verifies /healthz
# Usage: sudo bash scripts/update.sh
# ==============================================================================
set -euo pipefail

if [[ $EUID -ne 0 && "${NODE_ENV:-}" != "test" && "${SKIP_ROOT_CHECK:-}" != "1" ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

INSTALL_DIR="${VPS_MONITOR_DIR:-/opt/vps-monitor}"
BACKUP_DIR="$INSTALL_DIR/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SNAPSHOT_DIR="$BACKUP_DIR/pre_update_$TIMESTAMP"
DB_FILE="$INSTALL_DIR/data/monitor.db"

echo "===> [1/4] Creating pre-update backup snapshot at $SNAPSHOT_DIR..."
mkdir -p "$SNAPSHOT_DIR"

# Transaction-consistent SQLite snapshot (Finding 6)
if [[ -f "$DB_FILE" ]]; then
  if command -v sqlite3 &>/dev/null; then
    echo "Running atomic SQLite online backup (VACUUM INTO)..."
    sqlite3 "$DB_FILE" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
    sqlite3 "$DB_FILE" "VACUUM INTO '$SNAPSHOT_DIR/monitor.db';"
  else
    # Fallback: stop service briefly to guarantee zero in-flight writes
    echo "sqlite3 CLI not present; stopping service briefly for clean snapshot..."
    if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then
      systemctl stop vps-monitor.service || true
    fi
    cp "$DB_FILE" "$SNAPSHOT_DIR/monitor.db"
    if [[ -f "${DB_FILE}-wal" ]]; then
      cp "${DB_FILE}-wal" "$SNAPSHOT_DIR/monitor.db-wal"
    fi
  fi
fi

cp -r "$INSTALL_DIR/src" "$SNAPSHOT_DIR/"
cp "$INSTALL_DIR/package.json" "$SNAPSHOT_DIR/"
if [[ -f "$INSTALL_DIR/.env" ]]; then
  cp "$INSTALL_DIR/.env" "$SNAPSHOT_DIR/.env.bak"
fi

echo "===> [2/4] Updating codebase from Git repository..."
cd "$INSTALL_DIR"

# Finding 5: Verify .git exists
if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  echo "Error: $INSTALL_DIR is not a git repository (.git missing)!"
  echo "Please check installation or re-clone the repository."
  exit 1
fi

git fetch origin
git pull --ff-only || {
  echo "Git pull failed or has merge conflicts! Aborting update."
  exit 1
}

if id -u vpsmon &>/dev/null; then
  chown -R vpsmon:vpsmon "$INSTALL_DIR"
fi

CHECK_PORT="${PORT:-5050}"
echo "===> [3/4] Restarting systemd service..."
if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then
  systemctl restart vps-monitor.service
  echo "===> [4/4] Verifying health endpoint..."
  sleep 2
  HEALTH_RES=$(curl -s -k -o /dev/null -w "%{http_code}" "http://127.0.0.1:${CHECK_PORT}/healthz" || curl -s -k -o /dev/null -w "%{http_code}" "https://127.0.0.1:${CHECK_PORT}/healthz" || echo "000")

  if [[ "$HEALTH_RES" == "200" ]]; then
    echo "------------------------------------------------------------------"
    echo "✅ Update successful! Service is healthy (HTTP 200)."
    echo "Backup saved at: $SNAPSHOT_DIR"
    echo "------------------------------------------------------------------"
  else
    echo "------------------------------------------------------------------"
    echo "❌ Warning: Healthcheck returned HTTP $HEALTH_RES (expected 200)!"
    echo "Check logs immediately: sudo journalctl -u vps-monitor -n 50"
    echo "To rollback, run: sudo bash $INSTALL_DIR/scripts/rollback.sh $SNAPSHOT_DIR"
    echo "------------------------------------------------------------------"
    exit 1
  fi
else
  echo "Notice: systemd not active; service restart and health check deferred to supervisor."
  echo "------------------------------------------------------------------"
  echo "✅ Update files prepared successfully. Backup saved at: $SNAPSHOT_DIR"
  echo "------------------------------------------------------------------"
fi
