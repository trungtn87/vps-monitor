import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../../src/server.js';
import { NodeState } from '../../src/monitor/evaluator.js';

test('Cross-monitoring: VinaHost and Nhân Hòa bidirectional heartbeat exchange', async () => {
  const secret = 'shared-secret-between-both-vps-nodes';

  // 1. Create VinaHost instance
  const vhApp = await createServer({
    NODE_ENV: 'test',
    SERVER_ID: 'vinahost',
    PORT: '0',
    HOST: '127.0.0.1',
    DB_PATH: ':memory:',
    HEARTBEAT_SECRET: secret,
    DISCONNECT_THRESHOLD_SEC: 180,
    DASHBOARD_PASS: 'testpass'
  });
  await vhApp.start();
  const vhPort = vhApp.server.address().port;

  // 2. Create Nhân Hòa instance pointing to VinaHost port
  const nhApp = await createServer({
    NODE_ENV: 'test',
    SERVER_ID: 'nhanhoa',
    PORT: '0',
    HOST: '127.0.0.1',
    DB_PATH: ':memory:',
    PEER_SERVER_ID: 'vinahost',
    PEER_URL: `http://127.0.0.1:${vhPort}`,
    HEARTBEAT_SECRET: secret,
    DISCONNECT_THRESHOLD_SEC: 180,
    DASHBOARD_PASS: 'testpass'
  });
  await nhApp.start();
  const nhPort = nhApp.server.address().port;

  // Point VinaHost peerUrl to Nhân Hòa port
  vhApp.heartbeatClient.peerUrl = `http://127.0.0.1:${nhPort}`;

  try {
    // Before heartbeats, both evaluate peer as UNKNOWN
    assert.strictEqual(vhApp.await evaluator.evaluatePeerHeartbeat('nhanhoa').state, NodeState.UNKNOWN);
    assert.strictEqual(nhApp.await evaluator.evaluatePeerHeartbeat('vinahost').state, NodeState.UNKNOWN);

    // 3. VinaHost sends heartbeat to Nhân Hòa
    const vhSendRes = await vhApp.heartbeatClient.sendHeartbeat();
    assert.strictEqual(vhSendRes.success, true);

    // Nhân Hòa should now see VinaHost as ONLINE
    const nhEval = nhApp.await evaluator.evaluatePeerHeartbeat('vinahost');
    assert.strictEqual(nhEval.state, NodeState.ONLINE);

    // 4. Nhân Hòa sends heartbeat to VinaHost
    const nhSendRes = await nhApp.heartbeatClient.sendHeartbeat();
    assert.strictEqual(nhSendRes.success, true);

    // VinaHost should now see Nhân Hòa as ONLINE
    const vhEval = vhApp.await evaluator.evaluatePeerHeartbeat('nhanhoa');
    assert.strictEqual(vhEval.state, NodeState.ONLINE);

    // 5. Simulate heartbeat loss (> 180s) on VinaHost
    vhApp.db.db.prepare("UPDATE heartbeat_log SET received_at = datetime('now', '-200 seconds')").run();
    const vhDisconnectedEval = vhApp.await evaluator.evaluatePeerHeartbeat('nhanhoa');
    assert.strictEqual(vhDisconnectedEval.state, NodeState.DISCONNECTED);

    // 6. Simulate recovery: Nhân Hòa sends another heartbeat
    await vhApp.db.setAlertState('nhanhoa:heartbeat', NodeState.DISCONNECTED);
    await nhApp.heartbeatClient.sendHeartbeat();

    const vhRecoveredEval = vhApp.await evaluator.evaluatePeerHeartbeat('nhanhoa');
    assert.strictEqual(vhRecoveredEval.state, NodeState.RECOVERED);
  } finally {
    await vhApp.stop();
    await nhApp.stop();
  }
});
