import { test } from 'node:test';
import assert from 'node:assert';
import { MonitorDatabase } from '../../src/db/database.js';
import { MonitorEvaluator, NodeState } from '../../src/monitor/evaluator.js';

test('MonitorEvaluator peer heartbeat states', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = { disconnectThresholdSec: 180, startupGraceSec: 180, cpuThresholdPct: 85, ramThresholdPct: 85, diskThresholdPct: 85 };
  const evaluator = new MonitorEvaluator({ db, config });

  // 1. Initial state within startup grace -> UNKNOWN
  let res = await evaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.UNKNOWN);
  assert.strictEqual(res.isStartupFailure, false);

  // 2. Insert valid recent heartbeat -> ONLINE
  db.recordHeartbeat({
    senderId: 'nhanhoa',
    receiverId: 'vinahost',
    sequence: 1,
    senderTimestamp: new Date().toISOString(),
    status: 'VALID'
  });

  res = await evaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.ONLINE);

  // 3. Mark alert_state as DISCONNECTED in DB, then evaluate -> RECOVERED
  db.setAlertState('nhanhoa:heartbeat', NodeState.DISCONNECTED);
  res = await evaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.RECOVERED);

  // 4. Over threshold (> 180s elapsed) -> DISCONNECTED
  db.db.prepare("UPDATE heartbeat_log SET received_at = datetime('now', '-200 seconds')").run();
  res = await evaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.DISCONNECTED);

  db.close();
});

test('MonitorEvaluator startup grace period detects missing first heartbeat (Finding 4)', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = { disconnectThresholdSec: 180, startupGraceSec: 180 };

  // Case 1: Started 60 seconds ago (< 180s grace) -> UNKNOWN
  const recentStartedAt = Date.now() - 60 * 1000;
  const recentEvaluator = new MonitorEvaluator({ db, config, serviceStartedAt: recentStartedAt });
  let res = await recentEvaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.UNKNOWN);
  assert.strictEqual(res.isStartupFailure, false);

  // Case 2: Started 200 seconds ago (> 180s grace) with ZERO heartbeats -> DISCONNECTED
  const oldStartedAt = Date.now() - 200 * 1000;
  const oldEvaluator = new MonitorEvaluator({ db, config, serviceStartedAt: oldStartedAt });
  res = await oldEvaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.DISCONNECTED);
  assert.strictEqual(res.isStartupFailure, true);
  assert.ok(res.elapsedSec >= 200);

  db.close();
});

test('MonitorEvaluator evaluateResources checks thresholds', async () => {
  const db = new MonitorDatabase(':memory:');
  db.upsertServer({ serverId: 'vinahost', name: 'VinaHost', host: 'localhost', port: 5050, isLocal: true });

  const config = { cpuThresholdPct: 85, ramThresholdPct: 85, diskThresholdPct: 85 };
  const evaluator = new MonitorEvaluator({ db, config });

  // Normal metrics
  db.insertMetrics({
    serverId: 'vinahost',
    cpuPct: 50.0,
    ramUsedMb: 1000,
    ramTotalMb: 2000,
    ramPct: 50.0,
    diskUsedGb: 20,
    diskTotalGb: 50,
    diskPct: 40.0,
    uptimeSec: 3600
  });

  let evalRes = await evaluator.evaluateResources('vinahost');
  assert.strictEqual(evalRes.cpuAlert, false);
  assert.strictEqual(evalRes.ramAlert, false);
  assert.strictEqual(evalRes.diskAlert, false);

  // High CPU metric (88% >= 85%)
  db.insertMetrics({
    serverId: 'vinahost',
    cpuPct: 88.0,
    ramUsedMb: 1000,
    ramTotalMb: 2000,
    ramPct: 50.0,
    diskUsedGb: 20,
    diskTotalGb: 50,
    diskPct: 40.0,
    uptimeSec: 3660
  });

  evalRes = await evaluator.evaluateResources('vinahost');
  assert.strictEqual(evalRes.cpuAlert, true);
  assert.strictEqual(evalRes.ramAlert, false);

  db.close();
});

test('MonitorEvaluator evaluateExpiry thresholds (30, 15, 7, 3, 1 days & overdue)', () => {
  const db = new MonitorDatabase(':memory:');
  const evaluator = new MonitorEvaluator({ db, config: {} });

  const futureDate = (days) => {
    const d = new Date(Date.now() + days * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  };

  // 45 days away -> no threshold hit
  assert.strictEqual(evaluator.evaluateExpiry(futureDate(45)).thresholdHit, null);

  // 25 days away -> threshold 30
  assert.strictEqual(evaluator.evaluateExpiry(futureDate(25)).thresholdHit, 30);

  // 12 days away -> threshold 15
  assert.strictEqual(evaluator.evaluateExpiry(futureDate(12)).thresholdHit, 15);

  // 5 days away -> threshold 7
  assert.strictEqual(evaluator.evaluateExpiry(futureDate(5)).thresholdHit, 7);

  // 2 days away -> threshold 3
  assert.strictEqual(evaluator.evaluateExpiry(futureDate(1)).thresholdHit, 3);

  // 0 days away (today) -> threshold 1
  assert.strictEqual(evaluator.evaluateExpiry(futureDate(0)).thresholdHit, 1);

  // -2 days away (past expiry) -> threshold 0 (overdue)
  const overdueRes = evaluator.evaluateExpiry(futureDate(-2));
  assert.strictEqual(overdueRes.thresholdHit, 0);
  assert.strictEqual(overdueRes.isOverdue, true);

  db.close();
});
