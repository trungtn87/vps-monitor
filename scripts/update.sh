#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — Safe Update Script
# Creates a backup snapshot, updates code, restarts service, verifies /healthz
# Usage: sudo bash scripts/update.sh
# ==============================================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

INSTALL_DIR="/opt/vps-monitor"
BACKUP_DIR="$INSTALL_DIR/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SNAPSHOT_DIR="$BACKUP_DIR/pre_update_$TIMESTAMP"

echo "===> [1/4] Creating pre-update backup snapshot at $SNAPSHOT_DIR..."
mkdir -p "$SNAPSHOT_DIR"
if [[ -f "$INSTALL_DIR/data/monitor.db" ]]; then
  cp "$INSTALL_DIR/data/monitor.db"* "$SNAPSHOT_DIR/" 2>/dev/null || true
fi
cp -r "$INSTALL_DIR/src" "$SNAPSHOT_DIR/"
cp "$INSTALL_DIR/package.json" "$SNAPSHOT_DIR/"
if [[ -f "$INSTALL_DIR/.env" ]]; then
  cp "$INSTALL_DIR/.env" "$SNAPSHOT_DIR/.env.bak"
fi

echo "===> [2/4] Updating codebase from Git repository..."
cd "$INSTALL_DIR"
git fetch origin
git pull --ff-only || {
  echo "Git pull failed or has merge conflicts! Aborting update."
  exit 1
}

chown -R vpsmon:vpsmon "$INSTALL_DIR"

echo "===> [3/4] Restarting systemd service..."
systemctl restart vps-monitor.service

echo "===> [4/4] Verifying health endpoint..."
sleep 2
HEALTH_RES=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5050/healthz || echo "000")

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
