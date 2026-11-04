import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import { MonitorDatabase } from '../../src/db/database.js';
import { MonitorEvaluator } from '../../src/monitor/evaluator.js';
import { DiscordCommands } from '../../src/discord/commands.js';
import { DiscordInteractionsHandler } from '../../src/discord/interactions.js';

test('DiscordCommands returns rich embeds for slash commands', async () => {
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
  const statusRes = await commands.dispatch('status');
  assert.strictEqual(statusRes.type, 4);
  assert.ok(statusRes.data.embeds[0].title.includes('TỔNG QUAN'));
  assert.strictEqual(statusRes.data.embeds[0].fields.length, 2);

  // /vinahost
  const vhRes = await commands.dispatch('vinahost');
  assert.strictEqual(vhRes.type, 4);
  assert.ok(vhRes.data.embeds[0].title.includes('VINAHOST'));

  // /nhanhoa
  const nhRes = await commands.dispatch('nhanhoa');
  assert.strictEqual(nhRes.type, 4);
  assert.ok(nhRes.data.embeds[0].title.includes('NHÂN HÒA'));

  // /expiry
  const expRes = await commands.dispatch('expiry');
  assert.strictEqual(expRes.type, 4);
  assert.ok(expRes.data.embeds[0].title.includes('THỜI HẠN'));

  db.close();
});

test('DiscordInteractionsHandler processes Ping and Application Commands with Ed25519 signature', async () => {
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
  const badRes = await handler.handle('{"type":1}', 'bad-sig', '1690000000');
  assert.strictEqual(badRes.status, 401);

  // 2. Discord PING (Type 1) -> PONG (Type 1)
  const pingBody = JSON.stringify({ type: 1 });
  const pingTs = '1690000000';
  const pingSig = sign(null, Buffer.from(pingTs + pingBody), keyPair.privateKey).toString('hex');
  const pingRes = await handler.handle(pingBody, pingSig, pingTs);
  assert.strictEqual(pingRes.status, 200);
  assert.strictEqual(pingRes.body.type, 1);

  // 3. Discord Application Command /status (Type 2)
  const cmdBody = JSON.stringify({ type: 2, data: { name: 'status' } });
  const cmdTs = '1690000001';
  const cmdSig = sign(null, Buffer.from(cmdTs + cmdBody), keyPair.privateKey).toString('hex');
  const cmdRes = await handler.handle(cmdBody, cmdSig, cmdTs);
  assert.strictEqual(cmdRes.status, 200);
  assert.strictEqual(cmdRes.body.type, 4);
  assert.ok(cmdRes.body.data.embeds[0].title.includes('TỔNG QUAN'));

  db.close();
});

test('DiscordInteractionsHandler enforces user and guild allowlists (Finding 9)', async () => {
  const db = new MonitorDatabase(':memory:');
  const config = { serverId: 'vinahost', serverName: 'VinaHost', disconnectThresholdSec: 180 };
  const evaluator = new MonitorEvaluator({ db, config });
  const commands = new DiscordCommands({ db, evaluator, config });

  const keyPair = generateKeyPairSync('ed25519');
  const rawPub = keyPair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const publicKeyHex = rawPub.toString('hex');

  const handler = new DiscordInteractionsHandler({
    publicKey: publicKeyHex,
    commands,
    allowedUserIds: ['user-123'],
    allowedGuildIds: ['guild-789']
  });

  const signPayload = (payload) => {
    const ts = '1690000000';
    const body = JSON.stringify(payload);
    const sig = sign(null, Buffer.from(ts + body), keyPair.privateKey).toString('hex');
    return { body, sig, ts };
  };

  // Case 1: Wrong Guild -> Rejected
  const wrongGuild = signPayload({
    type: 2,
    guild_id: 'wrong-guild',
    user: { id: 'user-123' },
    data: { name: 'status' }
  });
  const res1 = await handler.handle(wrongGuild.body, wrongGuild.sig, wrongGuild.ts);
  assert.strictEqual(res1.status, 200);
  assert.ok(res1.body.data.content.includes('Discord Server được ủy quyền'));

  // Case 2: Wrong User in allowed Guild -> Rejected
  const wrongUser = signPayload({
    type: 2,
    guild_id: 'guild-789',
    user: { id: 'unauthorized-user' },
    data: { name: 'status' }
  });
  const res2 = await handler.handle(wrongUser.body, wrongUser.sig, wrongUser.ts);
  assert.strictEqual(res2.status, 200);
  assert.ok(res2.body.data.content.includes('không có quyền'));

  // Case 3: Allowed User in allowed Guild -> Allowed
  const allowed = signPayload({
    type: 2,
    guild_id: 'guild-789',
    user: { id: 'user-123' },
    data: { name: 'status' }
  });
  const res3 = await handler.handle(allowed.body, allowed.sig, allowed.ts);
  assert.strictEqual(res3.status, 200);
  assert.ok(res3.body.data.embeds[0].title.includes('TỔNG QUAN'));

  db.close();
});
