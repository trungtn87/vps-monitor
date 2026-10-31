import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine } from '../../src/monitor/alertEngine.js';
import { MonitorEvaluator } from '../../src/monitor/evaluator.js';

test('Discord billing D-1 reminder is queued once and never before, on, or after expiry', async () => {
  const saved = new Map();
  const events = [];
  const db = {
    async getAlertState(key) { return saved.get(key) || null; },
    async recordAlertTransition(row) {
      events.push(row);
      saved.set(row.alertKey, { current_state: row.currentState });
    }
  };
  const evaluator = new MonitorEvaluator({ db, config: {} });
  const real = evaluator.evaluateExpiry.bind(evaluator);
  const engine = new AlertEngine({
    db, evaluator,
    notifier: { async sendAlert() { throw new Error('Not expected in isolated test'); } },
    config: { serverId: 'nhanhoa', serverName: 'Nhân Hòa (AutoTrade)',
      expiryDate: '2026-11-30' }
  });
  engine.processOutbox = async () => {};
  const runAt = async iso => {
    const now = Date.parse(iso);
    evaluator.evaluateExpiry = date => real(date, now);
    await engine.checkExpiry();
  };

  await runAt('2026-11-01T00:00:00Z'); // far before: no alert
  await runAt('2026-11-28T16:59:59Z'); // 23:59:59 Nov 28 Vietnam, D-2
  assert.equal(events.length, 0);
  await runAt('2026-11-28T17:00:00Z'); // midnight Nov 29 Vietnam, D-1
  assert.equal(events.length, 1);
  assert.equal(events[0].alertKey, 'expiry:nhanhoa:2026-11-30:1d');
  assert.equal(events[0].eventType, 'EXPIRY_WARNING');
  assert.match(events[0].alertPayload.description, /còn 1 ngày/);
  await runAt('2026-11-29T03:00:00Z'); // again during D-1
  assert.equal(events.length, 1, 'must not queue duplicate after restart/cycle');
  await runAt('2026-11-29T17:00:00Z'); // payment day
  await runAt('2026-11-30T17:00:00Z'); // overdue
  assert.equal(events.length, 1);

  // New billing cycle should have a new event key when its D-1 arrives.
  engine.config.expiryDate = '2026-12-30';
  await runAt('2026-12-28T17:00:00Z');
  assert.equal(events.length, 2);
});
