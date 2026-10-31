#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — SQLite Database Restore Script
# Usage: sudo bash scripts/restore.sh <backup_file.db>
# ==============================================================================
set -euo pipefail

if [[ $EUID -ne 0 && "${NODE_ENV:-}" != "test" && "${SKIP_ROOT_CHECK:-}" != "1" ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "Usage: sudo bash scripts/restore.sh <backup_file.db>"
  exit 1
fi

INSTALL_DIR="${VPS_MONITOR_DIR:-/opt/vps-monitor}"
DB_FILE="$INSTALL_DIR/data/monitor.db"

echo "===> Restoring database from $BACKUP_FILE..."
echo "Stopping vps-monitor service..."
if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then
  systemctl stop vps-monitor.service || true
fi

# Remove existing WAL and SHM files to ensure clean state
rm -f "${DB_FILE}" "${DB_FILE}-wal" "${DB_FILE}-shm"

# Restore database file
cp "$BACKUP_FILE" "$DB_FILE"
if id -u vpsmon &>/dev/null; then
  chown -R vpsmon:vpsmon "$INSTALL_DIR/data"
fi
chmod 600 "$DB_FILE"

# Finding 6: Verify restored database integrity
if command -v sqlite3 &>/dev/null; then
  echo "Running database integrity check..."
  INTEGRITY=$(sqlite3 "$DB_FILE" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
  if [[ "$INTEGRITY" != "ok" ]]; then
    echo "Error: Restored database integrity check failed! Result: $INTEGRITY"
    exit 1
  fi
  echo "Integrity check passed: ok"
fi

CHECK_PORT="${PORT:-5050}"
echo "Restarting vps-monitor service..."
if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then
  systemctl start vps-monitor.service
  sleep 2
  HEALTH_RES=$(curl -s -k -o /dev/null -w "%{http_code}" "http://127.0.0.1:${CHECK_PORT}/healthz" || curl -s -k -o /dev/null -w "%{http_code}" "https://127.0.0.1:${CHECK_PORT}/healthz" || echo "000")
  if [[ "$HEALTH_RES" == "200" ]]; then
    echo "✅ Database restore completed successfully! Service is UP (HTTP 200)."
  else
    echo "❌ Error: Service failed to start after restore (HTTP $HEALTH_RES)!"
    exit 1
  fi
else
  echo "Notice: systemd not active; service restart and health check deferred to supervisor."
fi
