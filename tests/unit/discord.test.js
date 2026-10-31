import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import { MonitorDatabase } from '../../src/db/database.js';
import { MonitorEvaluator } from '../../src/monitor/evaluator.js';
import { DiscordCommands } from '../../src/discord/commands.js';
import { DiscordInteractionsHandler } from '../../src/discord/interactions.js';

test('DiscordCommands returns rich embeds for slash commands', () => {
  const db = new MonitorDatabase(':memory:');
  const config = {
    serverId: 'vinahost',
    serverName: 'VinaHost (11Ship)',
    peerServerId: 'nhanhoa',
    peerServerName: 'Nhân Hòa (AutoTrade)',
    expiryDate: '2026-12-31',
    peerExpiryDate: '2026-11-30',
    disconnectThresholdSec: 180
  };

  db.upsertServer({ serverId: 'vinahost', name: 'VinaHost (11Ship)', host: 'localhost', port: 5050, isLocal: true });
  db.upsertServer({ serverId: 'nhanhoa', name: 'Nhân Hòa (AutoTrade)', host: 'localhost', port: 5050, isLocal: false });

  const evaluator = new MonitorEvaluator({ db, config });
  const commands = new DiscordCommands({ db, evaluator, config });

  // /status
  const statusRes = commands.dispatch('status');
  assert.strictEqual(statusRes.type, 4);
  assert.ok(statusRes.data.embeds[0].title.includes('TỔNG QUAN'));
  assert.strictEqual(statusRes.data.embeds[0].fields.length, 2);

  // /vinahost
  const vhRes = commands.dispatch('vinahost');
  assert.strictEqual(vhRes.type, 4);
  assert.ok(vhRes.data.embeds[0].title.includes('VINAHOST'));

  // /nhanhoa
  const nhRes = commands.dispatch('nhanhoa');
  assert.strictEqual(nhRes.type, 4);
  assert.ok(nhRes.data.embeds[0].title.includes('NHÂN HÒA'));

  // /expiry
  const expRes = commands.dispatch('expiry');
  assert.strictEqual(expRes.type, 4);
  assert.ok(expRes.data.embeds[0].title.includes('THỜI HẠN'));

  db.close();
});

test('DiscordInteractionsHandler processes Ping and Application Commands with Ed25519 signature', () => {
  const db = new MonitorDatabase(':memory:');
  const config = {
    serverId: 'vinahost',
    serverName: 'VinaHost',
    peerServerId: 'nhanhoa',
    peerServerName: 'Nhân Hòa',
    expiryDate: '2026-12-31',
    peerExpiryDate: '2026-11-30',
    disconnectThresholdSec: 180
  };
  const evaluator = new MonitorEvaluator({ db, config });
  const commands = new DiscordCommands({ db, evaluator, config });

  const keyPair = generateKeyPairSync('ed25519');
  const rawPub = keyPair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const publicKeyHex = rawPub.toString('hex');

  const handler = new DiscordInteractionsHandler({ publicKey: publicKeyHex, commands });

  // 1. Invalid signature -> 401
  const badRes = handler.handle('{"type":1}', 'bad-sig', '1690000000');
  assert.strictEqual(badRes.status, 401);

  // 2. Discord PING (Type 1) -> PONG (Type 1)
  const pingBody = JSON.stringify({ type: 1 });
  const pingTs = '1690000000';
  const pingSig = sign(null, Buffer.from(pingTs + pingBody), keyPair.privateKey).toString('hex');
  const pingRes = handler.handle(pingBody, pingSig, pingTs);
  assert.strictEqual(pingRes.status, 200);
  assert.strictEqual(pingRes.body.type, 1);

  // 3. Discord Application Command /status (Type 2)
  const cmdBody = JSON.stringify({ type: 2, data: { name: 'status' } });
  const cmdTs = '1690000001';
  const cmdSig = sign(null, Buffer.from(cmdTs + cmdBody), keyPair.privateKey).toString('hex');
  const cmdRes = handler.handle(cmdBody, cmdSig, cmdTs);
  assert.strictEqual(cmdRes.status, 200);
  assert.strictEqual(cmdRes.body.type, 4);
  assert.ok(cmdRes.body.data.embeds[0].title.includes('TỔNG QUAN'));

  db.close();
});
