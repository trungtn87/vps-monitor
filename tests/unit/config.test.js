import { test } from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../../src/common/config.js';

test('loadConfig defaults correctly for vinahost', () => {
  const cfg = loadConfig({ SERVER_ID: 'vinahost' });
  assert.strictEqual(cfg.serverId, 'vinahost');
  assert.strictEqual(cfg.serverName, 'VinaHost (11Ship)');
  assert.strictEqual(cfg.peerServerId, 'nhanhoa');
  assert.strictEqual(cfg.peerServerName, 'Nhân Hòa (AutoTrade)');
  assert.strictEqual(cfg.port, 5050);
  assert.strictEqual(cfg.disconnectThresholdSec, 180);
  assert.strictEqual(cfg.retentionDays, 30);
});

test('loadConfig defaults correctly for nhanhoa', () => {
  const cfg = loadConfig({ SERVER_ID: 'nhanhoa' });
  assert.strictEqual(cfg.serverId, 'nhanhoa');
  assert.strictEqual(cfg.serverName, 'Nhân Hòa (AutoTrade)');
  assert.strictEqual(cfg.peerServerId, 'vinahost');
  assert.strictEqual(cfg.peerServerName, 'VinaHost (11Ship)');
});

test('loadConfig parses custom numeric thresholds', () => {
  const cfg = loadConfig({
    PORT: '6060',
    CPU_THRESHOLD_PCT: '90',
    RAM_THRESHOLD_PCT: '80',
    DISK_THRESHOLD_PCT: '75',
    CONSECUTIVE_THRESHOLD_COUNT: '5',
    RETENTION_DAYS: '15'
  });
  assert.strictEqual(cfg.port, 6060);
  assert.strictEqual(cfg.cpuThresholdPct, 90);
  assert.strictEqual(cfg.ramThresholdPct, 80);
  assert.strictEqual(cfg.diskThresholdPct, 75);
  assert.strictEqual(cfg.consecutiveThresholdCount, 5);
  assert.strictEqual(cfg.retentionDays, 15);
});
