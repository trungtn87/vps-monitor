import { test } from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../../src/common/config.js';

test('loadConfig defaults correctly for vinahost in test environment', () => {
  const cfg = loadConfig({ NODE_ENV: 'test', SERVER_ID: 'vinahost' });
  assert.strictEqual(cfg.serverId, 'vinahost');
  assert.strictEqual(cfg.serverName, 'VinaHost (11Ship)');
  assert.strictEqual(cfg.peerServerId, 'nhanhoa');
  assert.strictEqual(cfg.peerServerName, 'Nhân Hòa (AutoTrade)');
  assert.strictEqual(cfg.port, 5050);
  assert.strictEqual(cfg.disconnectThresholdSec, 180);
  assert.strictEqual(cfg.startupGraceSec, 180);
  assert.strictEqual(cfg.retentionDays, 30);
});

test('loadConfig defaults correctly for nhanhoa in test environment', () => {
  const cfg = loadConfig({ NODE_ENV: 'test', SERVER_ID: 'nhanhoa' });
  assert.strictEqual(cfg.serverId, 'nhanhoa');
  assert.strictEqual(cfg.serverName, 'Nhân Hòa (AutoTrade)');
  assert.strictEqual(cfg.peerServerId, 'vinahost');
  assert.strictEqual(cfg.peerServerName, 'VinaHost (11Ship)');
});

test('loadConfig parses custom numeric thresholds and allowlists', () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PORT: '6060',
    CPU_THRESHOLD_PCT: '90',
    RAM_THRESHOLD_PCT: '80',
    DISK_THRESHOLD_PCT: '75',
    CONSECUTIVE_THRESHOLD_COUNT: '5',
    RETENTION_DAYS: '15',
    DISCORD_CHANNEL_ID: '123456789',
    DISCORD_ALLOWED_USER_IDS: 'user1, user2',
    DISCORD_ALLOWED_GUILD_IDS: 'guild1'
  });
  assert.strictEqual(cfg.port, 6060);
  assert.strictEqual(cfg.cpuThresholdPct, 90);
  assert.strictEqual(cfg.ramThresholdPct, 80);
  assert.strictEqual(cfg.diskThresholdPct, 75);
  assert.strictEqual(cfg.consecutiveThresholdCount, 5);
  assert.strictEqual(cfg.retentionDays, 15);
  assert.strictEqual(cfg.discordChannelId, '123456789');
  assert.deepStrictEqual(cfg.discordAllowedUserIds, ['user1', 'user2']);
  assert.deepStrictEqual(cfg.discordAllowedGuildIds, ['guild1']);
});

test('loadConfig in production fails closed on weak or missing secrets (Finding 1)', () => {
  // 1. Missing or short HEARTBEAT_SECRET in production
  assert.throws(() => {
    loadConfig({
      NODE_ENV: 'production',
      HEARTBEAT_SECRET: 'short-secret',
      DASHBOARD_PASS: 'strongpassword123'
    });
  }, /HEARTBEAT_SECRET must be set and contain at least 32 characters/);

  // 2. Default dev secret in production
  assert.throws(() => {
    loadConfig({
      NODE_ENV: 'production',
      HEARTBEAT_SECRET: 'dev-secret-change-in-production',
      DASHBOARD_PASS: 'strongpassword123'
    });
  }, /HEARTBEAT_SECRET must be set and contain at least 32 characters/);

  // 3. Missing dashboard credentials in production
  assert.throws(() => {
    loadConfig({
      NODE_ENV: 'production',
      HEARTBEAT_SECRET: 'valid-secret-that-is-at-least-32-chars-long!',
      DASHBOARD_PASS: '',
      API_TOKEN: ''
    });
  }, /DASHBOARD_PASS or API_TOKEN must be configured/);

  // 4. Insecure 0.0.0.0 binding without TLS fails closed in production (Review Round 3)
  assert.throws(() => {
    loadConfig({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      REQUIRE_TLS: 'false',
      HEARTBEAT_SECRET: 'valid-secret-that-is-at-least-32-chars-long!',
      DASHBOARD_PASS: 'supersecurepassword'
    });
  }, /Binding to 0.0.0.0 with REQUIRE_TLS=false in production exposes unencrypted HTTP/);

  // 5. Valid production configuration with loopback reverse proxy succeeds
  const valid = loadConfig({
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    REQUIRE_TLS: 'false',
    HEARTBEAT_SECRET: 'valid-secret-that-is-at-least-32-chars-long!',
    DASHBOARD_PASS: 'supersecurepassword'
  });
  assert.strictEqual(valid.nodeEnv, 'production');
  assert.strictEqual(valid.host, '127.0.0.1');

  // 6. Valid production configuration with native TLS succeeds on 0.0.0.0
  const validTls = loadConfig({
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    REQUIRE_TLS: 'true',
    TLS_CERT_PATH: '/etc/vps-monitor/certs/fullchain.pem',
    TLS_KEY_PATH: '/etc/vps-monitor/certs/privkey.pem',
    HEARTBEAT_SECRET: 'valid-secret-that-is-at-least-32-chars-long!',
    DASHBOARD_PASS: 'supersecurepassword'
  });
  assert.strictEqual(validTls.requireTls, true);
});
