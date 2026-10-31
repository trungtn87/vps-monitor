#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — Rollback Script
# Restores previous snapshot created by update.sh or backup.sh
# Usage: sudo bash scripts/rollback.sh [snapshot_directory]
# ==============================================================================
set -euo pipefail

if [[ $EUID -ne 0 && "${NODE_ENV:-}" != "test" && "${SKIP_ROOT_CHECK:-}" != "1" ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

INSTALL_DIR="${VPS_MONITOR_DIR:-/opt/vps-monitor}"
SNAPSHOT_DIR="${1:-}"

if [[ -z "$SNAPSHOT_DIR" || ! -d "$SNAPSHOT_DIR" ]]; then
  echo "No snapshot directory provided. Finding latest snapshot..."
  SNAPSHOT_DIR=$(ls -td "$INSTALL_DIR/backups"/pre_update_* 2>/dev/null | head -1 || true)
  if [[ -z "$SNAPSHOT_DIR" ]]; then
    echo "Error: No backup snapshots found in $INSTALL_DIR/backups!"
    exit 1
  fi
fi

echo "===> Rolling back to snapshot: $SNAPSHOT_DIR"

echo "===> [1/4] Stopping vps-monitor service..."
if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then
  systemctl stop vps-monitor.service || true
fi

echo "===> [2/4] Restoring codebase and configuration..."
if [[ -d "$SNAPSHOT_DIR/src" ]]; then
  rm -rf "$INSTALL_DIR/src"
  cp -r "$SNAPSHOT_DIR/src" "$INSTALL_DIR/"
fi
if [[ -f "$SNAPSHOT_DIR/package.json" ]]; then
  cp "$SNAPSHOT_DIR/package.json" "$INSTALL_DIR/"
fi
if [[ -f "$SNAPSHOT_DIR/.env.bak" ]]; then
  cp "$SNAPSHOT_DIR/.env.bak" "$INSTALL_DIR/.env"
fi

echo "===> [3/4] Restoring database snapshot..."
# Clean WAL / shm files before restore (Finding 6)
rm -f "$INSTALL_DIR/data/monitor.db-wal" "$INSTALL_DIR/data/monitor.db-shm"
if compgen -G "$SNAPSHOT_DIR/monitor.db*" > /dev/null; then
  cp "$SNAPSHOT_DIR/monitor.db"* "$INSTALL_DIR/data/"
fi

# Verify database integrity if sqlite3 is installed
if command -v sqlite3 &>/dev/null && [[ -f "$INSTALL_DIR/data/monitor.db" ]]; then
  sqlite3 "$INSTALL_DIR/data/monitor.db" "PRAGMA integrity_check;" 2>/dev/null || true
fi

if [[ $EUID -eq 0 ]] && id -u vpsmon &>/dev/null; then
  chown -R vpsmon:vpsmon "$INSTALL_DIR"
fi

CHECK_PORT="${PORT:-5050}"
echo "===> [4/4] Starting service and checking status..."
if command -v systemctl &>/dev/null && systemctl is-system-running &>/dev/null; then
  systemctl start vps-monitor.service
  sleep 2
  HEALTH_RES=$(curl -s -k -o /dev/null -w "%{http_code}" "http://127.0.0.1:${CHECK_PORT}/healthz" || curl -s -k -o /dev/null -w "%{http_code}" "https://127.0.0.1:${CHECK_PORT}/healthz" || echo "000")
  if [[ "$HEALTH_RES" == "200" ]]; then
    echo "✅ Rollback completed successfully! Service is UP (HTTP 200)."
  else
    echo "❌ Error: Service did not recover after rollback (HTTP $HEALTH_RES)!"
    echo "Check logs: sudo journalctl -u vps-monitor -n 50"
    exit 1
  fi
else
  echo "Notice: systemd not active; service restart and health check deferred to supervisor."
fi
