import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { SystemCollector } from '../../src/agent/collector.js';
import { AppHealthChecker } from '../../src/agent/appHealth.js';

test('SystemCollector collects metrics snapshot safely', () => {
  const collector = new SystemCollector();
  const snapshot = collector.collect('vinahost');

  assert.strictEqual(snapshot.serverId, 'vinahost');
  assert.ok(typeof snapshot.cpuPct === 'number');
  assert.ok(snapshot.cpuPct >= 0 && snapshot.cpuPct <= 100);
  assert.ok(typeof snapshot.ramUsedMb === 'number');
  assert.ok(typeof snapshot.ramTotalMb === 'number');
  assert.ok(snapshot.ramTotalMb > 0);
  assert.ok(typeof snapshot.ramPct === 'number');
  assert.ok(typeof snapshot.diskTotalGb === 'number');
  assert.ok(typeof snapshot.diskPct === 'number');
  assert.ok(typeof snapshot.uptimeSec === 'number');
  assert.ok(snapshot.uptimeSec >= 0);
  assert.ok(snapshot.timestamp);
});

test('AppHealthChecker reports DISABLED when no healthUrl configured', async () => {
  const checker = new AppHealthChecker('11ship', '11Ship Backend', '');
  const res = await checker.check();
  assert.strictEqual(res.status, 'DISABLED');
  assert.strictEqual(res.error, null);
});

test('AppHealthChecker reports HEALTHY on HTTP 200', async () => {
  const mockServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  const port = mockServer.address().port;

  try {
    const checker = new AppHealthChecker('11ship', '11Ship Backend', `http://127.0.0.1:${port}/healthz`);
    const res = await checker.check();
    assert.strictEqual(res.status, 'HEALTHY');
    assert.strictEqual(res.error, null);
    assert.ok(res.latencyMs >= 0);
  } finally {
    mockServer.close();
  }
});

test('AppHealthChecker reports UNHEALTHY on HTTP 500', async () => {
  const mockServer = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  });

  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  const port = mockServer.address().port;

  try {
    const checker = new AppHealthChecker('11ship', '11Ship Backend', `http://127.0.0.1:${port}/healthz`);
    const res = await checker.check();
    assert.strictEqual(res.status, 'UNHEALTHY');
    assert.ok(res.error.includes('HTTP 500'));
  } finally {
    mockServer.close();
  }
});

test('AppHealthChecker reports UNREACHABLE on connection refused', async () => {
  // Unused random local port
  const checker = new AppHealthChecker('11ship', '11Ship Backend', 'http://127.0.0.1:49999/healthz');
  const res = await checker.check();
  assert.strictEqual(res.status, 'UNREACHABLE');
  assert.ok(res.error);
});
