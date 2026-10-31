#!/usr/bin/env bash
# ==============================================================================
# VPS Monitor V1 — End-to-End Lifecycle Test
# Directly executes scripts: install.sh -> backup.sh -> update.sh -> rollback.sh -> restore.sh
# Verifies operational safety on Ubuntu 24.04 / Linux runners in CI
# ==============================================================================
set -euo pipefail

echo "=================================================================="
echo "🚀 Starting VPS Monitor V1 Lifecycle E2E Verification..."
echo "=================================================================="

WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT=$(mktemp -d /tmp/vpsmon-lifecycle-XXXXXX)
TEST_INSTALL_DIR="$TEST_ROOT/opt-vps-monitor"
TEST_PORT=5599

cleanup() {
  echo "===> Cleaning up temporary test directory: $TEST_ROOT"
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

# ------------------------------------------------------------------------------
# [Step 1] Execute scripts/install.sh directly
# ------------------------------------------------------------------------------
echo "===> [Step 1] Executing scripts/install.sh vinahost..."
export VPS_MONITOR_DIR="$TEST_INSTALL_DIR"
export SKIP_ROOT_CHECK="1"
export NODE_ENV="test"
cd "$WORK_DIR"

bash scripts/install.sh vinahost

# Verify installation output
if [[ ! -d "$TEST_INSTALL_DIR" || ! -d "$TEST_INSTALL_DIR/.git" ]]; then
  echo "❌ Error: install.sh failed to set up $TEST_INSTALL_DIR with .git preserved!"
  exit 1
fi
echo "✔ install.sh completed: directory structure and .git verified."

# Configure test parameters in .env
cat <<EOF > "$TEST_INSTALL_DIR/.env"
NODE_ENV="test"
SERVER_ID="vinahost"
SERVER_NAME="VinaHost (11Ship)"
HOST="127.0.0.1"
PORT=$TEST_PORT
DB_PATH="$TEST_INSTALL_DIR/data/monitor.db"
REQUIRE_TLS="false"
HEARTBEAT_SECRET="lifecycle-test-secret-must-be-at-least-32-characters-long"
DASHBOARD_USER="admin"
DASHBOARD_PASS="testpass12345"
API_TOKEN="testtoken1234567890123456789012345"
DISCONNECT_THRESHOLD_SEC=180
STARTUP_GRACE_SEC=180
EOF
chmod 600 "$TEST_INSTALL_DIR/.env"
echo "✔ Test environment configured at $TEST_INSTALL_DIR/.env"

# ------------------------------------------------------------------------------
# [Step 2] Start service and verify /healthz
# ------------------------------------------------------------------------------
echo "===> [Step 2] Starting service and verifying HTTP /healthz endpoint..."
cd "$TEST_INSTALL_DIR"
node src/server.js &
SERVER_PID=$!
sleep 2

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "❌ Error: Server process exited unexpectedly!"
  exit 1
fi

HEALTH_RES=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$TEST_PORT/healthz" || echo "000")
if [[ "$HEALTH_RES" != "200" ]]; then
  echo "❌ Error: Healthcheck failed! HTTP response: $HEALTH_RES"
  exit 1
fi
echo "✔ Healthcheck verified (HTTP 200 OK)."

# ------------------------------------------------------------------------------
# [Step 3] Populate database with monitor metrics
# ------------------------------------------------------------------------------
echo "===> [Step 3] Populating database with active monitor data..."
node -e '
import { MonitorDatabase } from "./src/db/database.js";
const db = new MonitorDatabase("./data/monitor.db");
db.upsertServer({ serverId: "vinahost", name: "VinaHost", host: "127.0.0.1", port: 5599, role: "11ship" });
db.upsertServer({ serverId: "nhanhoa", name: "Nhân Hòa", host: "127.0.0.1", port: 5599, role: "autotrade" });
db.insertMetrics({
  serverId: "vinahost",
  cpuPct: 45.2,
  ramUsedMb: 1024,
  ramTotalMb: 4096,
  ramPct: 25.0,
  diskUsedGb: 20,
  diskTotalGb: 100,
  diskPct: 20.0,
  netRxBytes: 1000,
  netTxBytes: 2000,
  uptimeSec: 3600
});
db.recordHeartbeat({
  senderId: "nhanhoa",
  receiverId: "vinahost",
  sequence: 1,
  senderTimestamp: new Date().toISOString(),
  status: "VALID",
  latencyMs: 15
});
db.close();
'
echo "✔ Test data successfully written to SQLite."

# ------------------------------------------------------------------------------
# [Step 4] Execute scripts/backup.sh directly
# ------------------------------------------------------------------------------
echo "===> [Step 4] Executing scripts/backup.sh directly..."
bash "$TEST_INSTALL_DIR/scripts/backup.sh" "$TEST_INSTALL_DIR/backups"

BACKUP_FILE=$(ls -t "$TEST_INSTALL_DIR/backups"/monitor_backup_*.db | head -1)
if [[ ! -s "$BACKUP_FILE" ]]; then
  echo "❌ Error: Backup file not found or empty!"
  exit 1
fi
echo "✔ Backup created at $BACKUP_FILE"

if command -v sqlite3 &>/dev/null; then
  INTEGRITY=$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
  if [[ "$INTEGRITY" != "ok" ]]; then
    echo "❌ Error: Backup SQLite integrity check failed: $INTEGRITY"
    exit 1
  fi
  echo "✔ Backup SQLite PRAGMA integrity_check passed: ok."
fi

# ------------------------------------------------------------------------------
# [Step 5] Execute scripts/update.sh directly with real git pull
# ------------------------------------------------------------------------------
echo "===> [Step 5] Executing scripts/update.sh directly..."
# Create a local bare origin for isolated git pull testing
MOCK_ORIGIN="$TEST_ROOT/mock_origin.git"
git -C "$TEST_INSTALL_DIR" checkout -B main 2>/dev/null || true
git clone --bare "$TEST_INSTALL_DIR" "$MOCK_ORIGIN" 2>/dev/null
git -C "$TEST_INSTALL_DIR" remote set-url origin "$MOCK_ORIGIN"
git -C "$TEST_INSTALL_DIR" branch --set-upstream-to=origin/main main 2>/dev/null || true

# Push a test modification to mock origin
TEMP_DEV="$TEST_ROOT/temp_dev"
git clone "$MOCK_ORIGIN" "$TEMP_DEV" 2>/dev/null
git -C "$TEMP_DEV" checkout -B main 2>/dev/null || true
git -C "$TEMP_DEV" config user.name "E2E Tester"
git -C "$TEMP_DEV" config user.email "test@example.com"
echo "// Verified update at $(date)" >> "$TEMP_DEV/src/server.js"
git -C "$TEMP_DEV" commit -am "test: simulated upstream code update"
git -C "$TEMP_DEV" push origin main 2>/dev/null

# Execute the actual update.sh script
bash "$TEST_INSTALL_DIR/scripts/update.sh"

# Verify update was pulled and applied
if ! grep -q "Verified update at" "$TEST_INSTALL_DIR/src/server.js"; then
  echo "❌ Error: update.sh did not pull updated code into $TEST_INSTALL_DIR/src/server.js!"
  exit 1
fi

# Verify pre_update snapshot was created
LATEST_SNAPSHOT=$(ls -td "$TEST_INSTALL_DIR/backups"/pre_update_* | head -1)
if [[ ! -d "$LATEST_SNAPSHOT" || ! -f "$LATEST_SNAPSHOT/src/server.js" ]]; then
  echo "❌ Error: update.sh did not generate valid pre_update snapshot!"
  exit 1
fi
echo "✔ update.sh verified: git pull succeeded, pre-update snapshot created at $LATEST_SNAPSHOT."

# ------------------------------------------------------------------------------
# [Step 6] Execute scripts/rollback.sh directly
# ------------------------------------------------------------------------------
echo "===> [Step 6] Executing scripts/rollback.sh directly..."
# Stop test server
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

# Execute rollback.sh (auto-detects latest pre_update snapshot)
bash "$TEST_INSTALL_DIR/scripts/rollback.sh"

# Verify code was reverted (simulated update removed)
if grep -q "Verified update at" "$TEST_INSTALL_DIR/src/server.js"; then
  echo "❌ Error: rollback.sh did not revert src/server.js to pre-update state!"
  exit 1
fi

# Restart server and verify health
node "$TEST_INSTALL_DIR/src/server.js" &
SERVER_PID=$!
sleep 2

HEALTH_RES=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$TEST_PORT/healthz" || echo "000")
if [[ "$HEALTH_RES" != "200" ]]; then
  echo "❌ Error: Server failed to respond with 200 after rollback! Got: $HEALTH_RES"
  exit 1
fi
echo "✔ rollback.sh verified: codebase reverted cleanly and service is healthy."

# ------------------------------------------------------------------------------
# [Step 7] Execute scripts/restore.sh directly
# ------------------------------------------------------------------------------
echo "===> [Step 7] Executing scripts/restore.sh directly..."
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

bash "$TEST_INSTALL_DIR/scripts/restore.sh" "$BACKUP_FILE"

# Restart server and verify API status returns restored data
node "$TEST_INSTALL_DIR/src/server.js" &
SERVER_PID=$!
sleep 2

STATUS_RES=$(curl -s -u admin:testpass12345 "http://127.0.0.1:$TEST_PORT/api/status")
if ! echo "$STATUS_RES" | grep -q "vinahost"; then
  echo "❌ Error: Restored database did not contain expected data! Response: $STATUS_RES"
  exit 1
fi
echo "✔ restore.sh verified: database restored and verified via /api/status."

echo "=================================================================="
echo "🎉 ALL LIFECYCLE SCRIPTS (install -> backup -> update -> rollback -> restore) EXECUTED AND PASSED DIRECTLY!"
echo "=================================================================="
