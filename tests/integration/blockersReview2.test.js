import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../../src/db/database.js';
import { AlertEngine } from '../../src/monitor/alertEngine.js';
import { MonitorEvaluator, NodeState } from '../../src/monitor/evaluator.js';
import { DiscordInteractionsHandler } from '../../src/discord/interactions.js';
import { HttpRouter } from '../../src/web/routes.js';
import { AuthGuard } from '../../src/web/auth.js';
import { generateKeyPairSync, sign } from 'node:crypto';

test('Blocker 2: recordAlertTransition executes in a single atomic transaction', async () => {
  const db = new MonitorDatabase(':memory:');
  db.upsertServer({ serverId: 'vinahost', name: 'VinaHost', role: '11ship' });

  // 1. Successful atomic execution
  const res = db.recordAlertTransition({
    alertKey: 'nhanhoa:heartbeat',
    currentState: NodeState.DISCONNECTED,
    consecutiveCount: 1,
    details: { reason: 'timeout' },
    serverId: 'nhanhoa',
    eventType: 'HEARTBEAT_LOSS',
    severity: 'CRITICAL',
    message: 'VPS Nhân Hòa mất kết nối',
    eventDetails: { timeoutSec: 200 },
    alertPayload: { title: 'Alert', description: 'Timeout' }
  });

  assert.ok(res.eventId > 0);
  assert.ok(res.outboxId > 0);

  const state = db.getAlertState('nhanhoa:heartbeat');
  assert.equal(state.current_state, NodeState.DISCONNECTED);

  const events = db.getRecentEvents(5);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'HEARTBEAT_LOSS');

  const pending = db.getPendingAlerts(5);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].alert_key, 'nhanhoa:heartbeat');

  // 2. Rollback verification: If an error is thrown inside transaction, nothing is committed
  assert.throws(() => {
    db.transaction(() => {
      db.setAlertState('fail_test', 'BROKEN', 1);
      throw new Error('Forced crash inside transaction');
    });
  }, /Forced crash inside transaction/);

  const rolledBackState = db.getAlertState('fail_test');
  assert.equal(rolledBackState, null);

  db.close();
});

test('Blocker 4: Stale Agent & Metrics Detection (> 180s)', async () => {
  const db = new MonitorDatabase(':memory:');
  db.upsertServer({ serverId: 'vinahost', name: 'VinaHost (11Ship)', role: '11ship' });
  db.upsertServer({ serverId: 'nhanhoa', name: 'Nhân Hòa (AutoTrade)', role: 'autotrade' });

  const evaluator = new MonitorEvaluator({
    db,
    config: { serverId: 'vinahost', peerServerId: 'nhanhoa', disconnectThresholdSec: 180 },
    serviceStartedAt: Date.now() - 300_000
  });

  const sentAlerts = [];
  const fakeNotifier = {
    async sendAlert(embed) {
      sentAlerts.push(embed);
      return { ok: true, statusCode: 200 };
    }
  };

  const alertEngine = new AlertEngine({
    db,
    evaluator,
    notifier: fakeNotifier,
    config: {
      serverId: 'vinahost',
      serverName: 'VinaHost (11Ship)',
      peerServerId: 'nhanhoa',
      peerServerName: 'Nhân Hòa (AutoTrade)',
      disconnectThresholdSec: 180
    }
  });

  // Case 1: No metrics yet -> isStale = true
  await alertEngine.checkLocalAgentHealth();
  const state1 = db.getAlertState('vinahost:agent_health');
  assert.equal(state1.current_state, 'STALE');
  assert.equal(sentAlerts.length, 1);
  assert.match(sentAlerts[0].title, /MONITOR AGENT NGỪNG THU THẬP/);

  // Case 2: Fresh metrics inserted -> recovers to HEALTHY
  db.insertMetrics({
    serverId: 'vinahost',
    cpuPct: 30,
    ramUsedMb: 1000,
    ramTotalMb: 4000,
    ramPct: 25,
    diskUsedGb: 20,
    diskTotalGb: 100,
    diskPct: 20,
    netRxBytes: 0,
    netTxBytes: 0,
    uptimeSec: 5000
  });

  await alertEngine.checkLocalAgentHealth();
  const state2 = db.getAlertState('vinahost:agent_health');
  assert.equal(state2.current_state, 'HEALTHY');
  assert.equal(sentAlerts.length, 2);
  assert.match(sentAlerts[1].title, /PHỤC HỒI: MONITOR AGENT/);

  // Case 3: HTTP API /api/status marks local server STALE when agent metrics are stale
  const authGuard = new AuthGuard({ user: 'admin', pass: 'secret', apiToken: 'token' });
  const router = new HttpRouter({
    db,
    evaluator,
    heartbeatReceiver: null,
    discordInteractions: null,
    authGuard,
    config: { serverId: 'vinahost', disconnectThresholdSec: 180 }
  });

  // Inject old metrics (400 seconds ago)
  db.db.prepare(`
    INSERT INTO node_metrics (server_id, cpu_pct, ram_used_mb, ram_total_mb, ram_pct, disk_used_gb, disk_total_gb, disk_pct, net_rx_bytes, net_tx_bytes, uptime_sec, created_at)
    VALUES ('vinahost', 50, 1000, 4000, 25, 20, 100, 20, 0, 0, 5000, datetime('now', '-400 seconds'))
  `).run();

  const req = {
    method: 'GET',
    url: '/api/status',
    headers: {
      authorization: 'Basic ' + Buffer.from('admin:secret').toString('base64'),
      host: 'localhost'
    }
  };

  let resData = null;
  const res = {
    writeHead(code, headers) {},
    end(body) { resData = JSON.parse(body); }
  };

  await router.handleRequest(req, res);
  assert.ok(resData);
  const vh = resData.servers.find(s => s.serverId === 'vinahost');
  assert.equal(vh.connectionState, 'STALE');
  assert.equal(vh.agentHealth.isStale, true);
  assert.equal(vh.agentHealth.status, 'STALE');
  assert.ok(vh.agentHealth.ageSec >= 390);

  db.close();
});

test('Blocker 5: Discord interactions fail-closed in production when allowlist is empty', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

  const fakeCommands = {
    dispatch(cmd) {
      return { type: 4, data: { content: 'OK' } };
    }
  };

  // In production with empty allowlist -> MUST reject slash commands
  const prodHandler = new DiscordInteractionsHandler({
    publicKey: pubKeyHex,
    commands: fakeCommands,
    allowedUserIds: [],
    allowedGuildIds: [],
    nodeEnv: 'production'
  });

  const interactionBody = JSON.stringify({
    type: 2,
    data: { name: 'status' },
    guild_id: '999999999',
    member: { user: { id: '888888888' } }
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(timestamp + interactionBody), privateKey).toString('hex');

  const prodRes = await prodHandler.handle(interactionBody, sig, timestamp);
  assert.equal(prodRes.status, 200);
  assert.match(prodRes.body.data.content, /Chế độ production yêu cầu cấu hình danh sách được phép/);

  // In development with empty allowlist -> allowed for local testing
  const devHandler = new DiscordInteractionsHandler({
    publicKey: pubKeyHex,
    commands: fakeCommands,
    allowedUserIds: [],
    allowedGuildIds: [],
    nodeEnv: 'development'
  });

  const devRes = await devHandler.handle(interactionBody, sig, timestamp);
  assert.equal(devRes.status, 200);
  assert.equal(devRes.body.data.content, 'OK');
});

test('Blocker 5: Resource sample counter and last_metric_id persist across service restarts', async () => {
  const db = new MonitorDatabase(':memory:');
  db.upsertServer({ serverId: 'vinahost', name: 'VinaHost', role: '11ship' });

  const evaluator = new MonitorEvaluator({
    db,
    config: { serverId: 'vinahost', cpuThresholdPct: 80, ramThresholdPct: 80, diskThresholdPct: 80 }
  });

  const alerts = [];
  const fakeNotifier = {
    async sendAlert(embed) {
      alerts.push(embed);
      return { ok: true, statusCode: 200 };
    }
  };

  const config = {
    serverId: 'vinahost',
    serverName: 'VinaHost',
    cpuThresholdPct: 80,
    ramThresholdPct: 80,
    diskThresholdPct: 80,
    consecutiveThresholdCount: 2
  };

  // Cycle 1: First high CPU reading (consecutive = 1, threshold = 2, so NO alert yet)
  const engine1 = new AlertEngine({ db, evaluator, notifier: fakeNotifier, config });
  db.insertMetrics({
    serverId: 'vinahost',
    cpuPct: 92,
    ramUsedMb: 1000,
    ramTotalMb: 4000,
    ramPct: 25,
    diskUsedGb: 20,
    diskTotalGb: 100,
    diskPct: 20,
    netRxBytes: 0,
    netTxBytes: 0,
    uptimeSec: 1000
  });

  await engine1.checkResources();
  assert.equal(alerts.length, 0); // No alert yet on cycle 1
  const cpuState1 = db.getAlertState('vinahost:cpu');
  assert.equal(cpuState1.consecutive_count, 1);

  // Same metric sample evaluated again in cycle 1 -> duplicate ignored
  await engine1.checkResources();
  assert.equal(alerts.length, 0);

  // SIMULATE PROCESS RESTART: Create new AlertEngine instance with same SQLite database
  const engine2 = new AlertEngine({ db, evaluator, notifier: fakeNotifier, config });

  await engine2.init();

  // Right after restart: check that same old metric is NOT re-evaluated or double-counted
  await engine2.checkResources();
  const cpuStateAfterRestart = db.getAlertState('vinahost:cpu');
  assert.equal(cpuStateAfterRestart.consecutive_count, 1);
  assert.equal(alerts.length, 0);

  // Cycle 2: Second distinct high CPU reading arrives -> consecutive = 2 -> triggers ALERT!
  db.insertMetrics({
    serverId: 'vinahost',
    cpuPct: 95,
    ramUsedMb: 1000,
    ramTotalMb: 4000,
    ramPct: 25,
    diskUsedGb: 20,
    diskTotalGb: 100,
    diskPct: 20,
    netRxBytes: 0,
    netTxBytes: 0,
    uptimeSec: 1060
  });

  await engine2.checkResources();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /CẢNH BÁO TÀI NGUYÊN: CPU CAO/);

  const cpuState2 = db.getAlertState('vinahost:cpu');
  assert.equal(cpuState2.current_state, 'ALERTING');
  assert.equal(cpuState2.consecutive_count, 2);

  db.close();
});
