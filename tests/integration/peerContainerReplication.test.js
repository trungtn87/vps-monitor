import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../../src/db/database.js';
import { validatePeerContainerSum, HeartbeatReceiver } from '../../src/monitor/heartbeatReceiver.js';
import { signHeartbeat } from '../../src/common/crypto.js';

const sample=()=>({sampledAt:new Date().toISOString(),cpuUsedVcpu:0.023,ramUsedMb:234,
  apps:[
    {appId:'vps-monitor',name:'VPS Monitor',ramUsedMb:46,cpuVcpu:0.005},
    {appId:'autotrade',name:'AutoTrade',ramUsedMb:130,cpuVcpu:0.016},
    {appId:'11local',name:'11Local',ramUsedMb:58,cpuVcpu:0.002}
  ]});

test('peer telemetry accepts three fresh containers and rejects stale/invalid samples',()=>{
  assert.equal(validatePeerContainerSum(sample()).apps.length,3);
  assert.equal(validatePeerContainerSum({...sample(),sampledAt:'2020-01-01T00:00:00Z'}),null);
  assert.equal(validatePeerContainerSum({...sample(),apps:[...sample().apps,sample().apps[0]]}),null);
  assert.equal(validatePeerContainerSum({...sample(),ramUsedMb:Infinity}),null);
  assert.equal(validatePeerContainerSum({...sample(),apps:[]}),null);
});

test('signed Nhân Hòa heartbeat persists and exposes three peer apps in SQLite',async()=>{
  const db=new MonitorDatabase(':memory:');
  db.upsertServer({serverId:'nhanhoa',name:'Nhân Hòa'});
  db.upsertServer({serverId:'vinahost',name:'VinaHost',isLocal:true});
  const secret='test-secret-strong-enough-32-chars-long';
  const receiver=new HeartbeatReceiver({serverId:'vinahost',heartbeatSecret:secret,db});
  const payload={senderId:'nhanhoa',receiverId:'vinahost',sequence:1,
    timestamp:new Date().toISOString(),nonce:'peer-telemetry-nonce-1',
    metrics:{cpuPct:2,ramUsedMb:40,ramTotalMb:256,ramPct:15,
      vibeContainerSum:sample()}};
  const signed=signHeartbeat(payload,secret);
  assert.equal((await receiver.processHeartbeat(payload,signed)).code,200);
  const sum=db.getLatestVibeContainerSum('nhanhoa');
  assert.equal(sum.totalCount,3);
  assert.equal(sum.complete,true);
  assert.equal(sum.apps[2].appId,'11local');
  assert.equal(db.getVibeContainerSumHistory('nhanhoa',10,1,2048,3).length,1);
  const invalid={...payload,sequence:2,nonce:'peer-telemetry-nonce-2',
    metrics:{...payload.metrics,vibeContainerSum:{...sample(),ramUsedMb:-4}}};
  assert.equal((await receiver.processHeartbeat(invalid,signHeartbeat(invalid,secret))).code,200);
  assert.equal(db.getLatestVibeContainerSum('nhanhoa').ramUsedMb,234);
  db.close();
});
