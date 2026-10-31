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

test('Billing dates use Vietnam calendar, including today and overdue', () => {
  const db = new MonitorDatabase(':memory:');
  const evaluator = new MonitorEvaluator({ db, config: {} });
  const clock = Date.parse('2026-10-31T17:00:00Z'); // 2026-11-01 00:00 ICT

  for (const [date, expectedHit, expectedDays, overdue] of [
    ['2026-12-16', null, 45, false],
    ['2026-12-01', 30, 30, false],
    ['2026-11-30', 30, 29, false], // Nhân Hòa Vibe payment due
    ['2026-11-16', 15, 15, false],
    ['2026-11-08', 7, 7, false],
    ['2026-11-04', 3, 3, false],
    ['2026-11-02', 1, 1, false],
    ['2026-11-01', 0, 0, false],
    ['2026-10-31', 0, -1, true],
    ['2027-01-12', null, 72, false] // VinaHost next payment
  ]) {
    const result = evaluator.evaluateExpiry(date, clock);
    assert.strictEqual(result.thresholdHit, expectedHit, date);
    assert.strictEqual(result.daysRemaining, expectedDays, date);
    assert.strictEqual(result.isOverdue, overdue, date);
  }

  // 23:59:59 local on Nov 1 is still one day before Nov 2.
  assert.strictEqual(evaluator.evaluateExpiry('2026-11-02', Date.parse('2026-11-01T16:59:59Z')).daysRemaining, 1);
  // Exactly 00:00:00 local on Nov 2 is due today, NOT overdue.
  assert.strictEqual(evaluator.evaluateExpiry('2026-11-02', Date.parse('2026-11-01T17:00:00Z')).daysRemaining, 0);
  assert.strictEqual(evaluator.evaluateExpiry('2026-11-02', Date.parse('2026-11-01T17:00:00Z')).isOverdue, false);
  // Tomorrow becomes overdue by one calendar day.
  assert.strictEqual(evaluator.evaluateExpiry('2026-11-02', Date.parse('2026-11-02T17:00:00Z')).daysRemaining, -1);

  assert.strictEqual(evaluator.evaluateExpiry('2026-02-30', clock).daysRemaining, null);
  assert.strictEqual(evaluator.evaluateExpiry('11/30/2026', clock).daysRemaining, null);
  db.close();
});
