import { test } from 'node:test';
import assert from 'node:assert';
import { MonitorDatabase } from '../../src/db/database.js';
import { MonitorEvaluator, NodeState } from '../../src/monitor/evaluator.js';

test('MonitorEvaluator peer heartbeat states', () => {
  const db = new MonitorDatabase(':memory:');
  const config = { disconnectThresholdSec: 180, cpuThresholdPct: 85, ramThresholdPct: 85, diskThresholdPct: 85 };
  const evaluator = new MonitorEvaluator({ db, config });

  // 1. Initial state without any heartbeat -> UNKNOWN
  let res = evaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.UNKNOWN);

  // 2. Insert valid recent heartbeat -> ONLINE
  db.recordHeartbeat({
    senderId: 'nhanhoa',
    receiverId: 'vinahost',
    sequence: 1,
    senderTimestamp: new Date().toISOString(),
    status: 'VALID'
  });

  res = evaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.ONLINE);

  // 3. Mark alert_state as DISCONNECTED in DB, then evaluate -> RECOVERED
  db.setAlertState('nhanhoa:heartbeat', NodeState.DISCONNECTED);
  res = evaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.RECOVERED);

  // 4. Over threshold (> 180s elapsed) -> DISCONNECTED
  // Overwrite received_at with an old timestamp (e.g. 200s ago)
  db.db.prepare("UPDATE heartbeat_log SET received_at = datetime('now', '-200 seconds')").run();
  res = evaluator.evaluatePeerHeartbeat('nhanhoa');
  assert.strictEqual(res.state, NodeState.DISCONNECTED);

  db.close();
});

test('MonitorEvaluator evaluateResources checks thresholds', () => {
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

  let evalRes = evaluator.evaluateResources('vinahost');
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

  evalRes = evaluator.evaluateResources('vinahost');
  assert.strictEqual(evalRes.cpuAlert, true);
  assert.strictEqual(evalRes.ramAlert, false);

  db.close();
});

test('MonitorEvaluator evaluateExpiry thresholds (30, 15, 7, 3, 1 days)', () => {
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
  assert.strictEqual(evaluator.evaluateExpiry(futureDate(2)).thresholdHit, 3);

  // 0 days away (today) -> threshold 1
  assert.strictEqual(evaluator.evaluateExpiry(futureDate(0)).thresholdHit, 1);

  db.close();
});
