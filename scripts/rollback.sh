#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — Rollback Script
# Restores previous snapshot created by update.sh or backup.sh
# Usage: sudo bash scripts/rollback.sh [snapshot_directory]
# ==============================================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

INSTALL_DIR="/opt/vps-monitor"
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
systemctl stop vps-monitor.service || true

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
if compgen -G "$SNAPSHOT_DIR/monitor.db*" > /dev/null; then
  cp "$SNAPSHOT_DIR/monitor.db"* "$INSTALL_DIR/data/"
fi

chown -R vpsmon:vpsmon "$INSTALL_DIR"

echo "===> [4/4] Starting service and checking status..."
systemctl start vps-monitor.service
sleep 2

HEALTH_RES=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5050/healthz || echo "000")
if [[ "$HEALTH_RES" == "200" ]]; then
  echo "✅ Rollback completed successfully! Service is UP (HTTP 200)."
else
  echo "❌ Error: Service did not recover after rollback (HTTP $HEALTH_RES)!"
  echo "Check logs: sudo journalctl -u vps-monitor -n 50"
  exit 1
fi
