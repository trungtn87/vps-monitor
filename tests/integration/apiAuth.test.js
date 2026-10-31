import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../../src/server.js';
import { signHeartbeat, generateNonce } from '../../src/common/crypto.js';

test('HTTP API Authentication and Access Control', async () => {
  const env = {
    NODE_ENV: 'test',
    SERVER_ID: 'vinahost',
    PORT: '0', // Random free port
    HOST: '127.0.0.1',
    DB_PATH: ':memory:',
    HEARTBEAT_SECRET: 'test-secret-12345678',
    DASHBOARD_USER: 'admin',
    DASHBOARD_PASS: 'secretpassword',
    API_TOKEN: 'super-api-token'
  };

  const app = await createServer(env);
  await app.start();
  const port = app.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. /healthz is public without auth
    const healthRes = await fetch(`${baseUrl}/healthz`);
    assert.strictEqual(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'UP');
    assert.strictEqual(healthData.serverId, 'vinahost');

    // 2. /api/status requires authentication
    const unauthRes = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(unauthRes.status, 401);

    // 3. /api/status with Basic Auth succeeds
    const basicAuth = Buffer.from('admin:secretpassword').toString('base64');
    const basicRes = await fetch(`${baseUrl}/api/status`, {
      headers: { 'Authorization': `Basic ${basicAuth}` }
    });
    assert.strictEqual(basicRes.status, 200);
    const statusData = await basicRes.json();
    assert.ok(statusData.servers);

    // 4. /api/status with Bearer API token succeeds
    const bearerRes = await fetch(`${baseUrl}/api/status`, {
      headers: { 'Authorization': 'Bearer super-api-token' }
    });
    assert.strictEqual(bearerRes.status, 200);

    // 5. /api/heartbeat requires HMAC-SHA256 signature
    const hbPayload = {
      senderId: 'nhanhoa',
      receiverId: 'vinahost',
      sequence: 1,
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
      metrics: { cpuPct: 15 }
    };

    // Missing signature -> 401
    const noSigRes = await fetch(`${baseUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hbPayload)
    });
    assert.strictEqual(noSigRes.status, 401);

    // Valid signature -> 200
    const validSig = signHeartbeat(hbPayload, env.HEARTBEAT_SECRET);
    const validHbRes = await fetch(`${baseUrl}/api/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-SHA256': validSig
      },
      body: JSON.stringify(hbPayload)
    });
    assert.strictEqual(validHbRes.status, 200);
  } finally {
    await app.stop();
  }
});
