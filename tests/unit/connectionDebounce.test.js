import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../../src/db/database.js';
import { AlertEngine } from '../../src/monitor/alertEngine.js';
import { NodeState } from '../../src/monitor/evaluator.js';

function fixture() {
  const db = new MonitorDatabase(':memory:');
  db.upsertServer({serverId:'vinahost',name:'VinaHost',host:'127.0.0.1',port:5050,isLocal:true});
  const sent=[];
  const notifier={async sendAlert(payload) {sent.push(payload);return true;}};
  const config={serverId:'vinahost',serverName:'VinaHost',peerServerId:'nhanhoa',
    peerServerName:'Nhân Hòa',connectionAlertConsecutiveCount:3};
  let connection = NodeState.DISCONNECTED;
  const evaluator={async evaluatePeerHeartbeat(){
    return {state:connection,elapsedSec:250,lastReceivedAt:'2026-11-04 10:00:00',isStartupFailure:false};
  }};
  const alertEngine=new AlertEngine({db,evaluator,notifier,config});
  return {db,sent,alertEngine,setConnection:v=>{connection=v;}};
}

test('connection fails 1, 2 times: no Discord; failure 3: one; recovery resets',async()=>{
  const {db,sent,alertEngine,setConnection}=fixture();
  try {
    await alertEngine.checkPeerHeartbeat();
    assert.equal(sent.length,0);
    assert.equal(db.getAlertState('nhanhoa:heartbeat').consecutive_count,1);
    await alertEngine.checkPeerHeartbeat();
    assert.equal(sent.length,0);
    setConnection(NodeState.ONLINE);
    await alertEngine.checkPeerHeartbeat();
    assert.equal(sent.length,0,'brief outage must not create a recovery message');
    assert.equal(db.getAlertState('nhanhoa:heartbeat').consecutive_count,0);
    setConnection(NodeState.DISCONNECTED);
    await alertEngine.checkPeerHeartbeat();
    await alertEngine.checkPeerHeartbeat();
    assert.equal(sent.length,0);
    await alertEngine.checkPeerHeartbeat();
    assert.equal(sent.length,1,'exactly three consecutive checks required');
    assert.equal(db.getAlertState('nhanhoa:heartbeat').current_state,'DISCONNECTED');
    await alertEngine.checkPeerHeartbeat();
    await alertEngine.checkPeerHeartbeat();
    assert.equal(sent.length,1,'no repeats during same prolonged incident');
    setConnection(NodeState.RECOVERED);
    await alertEngine.checkPeerHeartbeat();
    assert.equal(sent.length,2,'recovery is one message only after a confirmed alert');
    await alertEngine.checkPeerHeartbeat();
    assert.equal(sent.length,2);
    setConnection(NodeState.DISCONNECTED);
    await alertEngine.checkPeerHeartbeat();
    await alertEngine.checkPeerHeartbeat();
    await alertEngine.checkPeerHeartbeat();
    assert.equal(sent.length,3,'a new, confirmed incident may alert once');
  } finally { db.close(); }
});

test('app UNREACHABLE / UNHEALTHY is treated as one outage episode',async()=>{
  const {db,sent,alertEngine}=fixture();
  try {
    let probe=0;
    const change = status => db.upsertService({
      serviceId:'11ship',serverId:'vinahost',name:'11Ship Backend',
      healthUrl:'http://127.0.0.1:3000/v1/health/ready',status,
      lastCheck:new Date(Date.parse('2026-11-04T00:00:00Z')+probe++*60000).toISOString()
    });
    change('UNREACHABLE'); await alertEngine.checkLocalAppHealth();
    await alertEngine.checkLocalAppHealth();
    assert.equal(db.getAlertState('11ship:health').consecutive_count,1,
      'rechecking the same probe may not increase the counter');
    change('UNREACHABLE'); await alertEngine.checkLocalAppHealth();
    assert.equal(sent.length,0);
    change('HEALTHY'); await alertEngine.checkLocalAppHealth();
    assert.equal(sent.length,0,'no recovery message for short blip');
    change('UNREACHABLE'); await alertEngine.checkLocalAppHealth();
    change('UNHEALTHY'); await alertEngine.checkLocalAppHealth();
    assert.equal(sent.length,0);
    change('UNHEALTHY'); await alertEngine.checkLocalAppHealth();
    assert.equal(sent.length,1,'3 distinct failure probes required');
    assert.equal(db.getAlertState('11ship:health').current_state,'DOWN');
    change('UNREACHABLE'); await alertEngine.checkLocalAppHealth();
    assert.equal(sent.length,1,'changing failure subtype cannot flood Discord');
    change('HEALTHY'); await alertEngine.checkLocalAppHealth();
    change('HEALTHY'); await alertEngine.checkLocalAppHealth();
    assert.equal(sent.length,1,'recovery must be stable before Discord');
    change('HEALTHY'); await alertEngine.checkLocalAppHealth();
    assert.equal(sent.length,2,'one stable recovery');
    change('HEALTHY'); await alertEngine.checkLocalAppHealth();
    assert.equal(sent.length,2,'one recovery per incident');
  } finally { db.close(); }
});
