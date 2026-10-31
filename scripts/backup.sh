#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — Safe SQLite Database Backup Script
# Usage: sudo bash scripts/backup.sh [destination_dir]
# ==============================================================================
set -euo pipefail

INSTALL_DIR="${VPS_MONITOR_DIR:-/opt/vps-monitor}"
DB_FILE="$INSTALL_DIR/data/monitor.db"
BACKUP_DIR="${1:-$INSTALL_DIR/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TARGET_FILE="$BACKUP_DIR/monitor_backup_$TIMESTAMP.db"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_FILE" ]]; then
  echo "Database file $DB_FILE not found. Nothing to backup."
  exit 0
fi

echo "===> Creating transaction-consistent database backup to $TARGET_FILE..."

# Check if sqlite3 CLI is available for clean online backup (Finding 6)
if command -v sqlite3 &>/dev/null; then
  # Flush WAL and run atomic online backup
  sqlite3 "$DB_FILE" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
  sqlite3 "$DB_FILE" "VACUUM INTO '$TARGET_FILE';"
else
  echo "Notice: sqlite3 CLI not found. Stopping vps-monitor briefly to ensure clean file snapshot..."
  WAS_RUNNING=0
  if systemctl is-active --quiet vps-monitor.service 2>/dev/null; then
    WAS_RUNNING=1
    systemctl stop vps-monitor.service
  fi

  cp "$DB_FILE" "$TARGET_FILE"

  if [[ "$WAS_RUNNING" -eq 1 ]]; then
    systemctl start vps-monitor.service
  fi
fi

# Verify backup file size
if [[ ! -s "$TARGET_FILE" ]]; then
  echo "Error: Backup file is empty or failed to create!"
  exit 1
fi

echo "✅ Backup successfully created and verified at: $TARGET_FILE"
# Keep only last 14 backups
ls -t "$BACKUP_DIR"/monitor_backup_*.db 2>/dev/null | tail -n +15 | xargs -r rm -f || true
