import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoTradeContainerClient, parseAutoTradeContainer, composeVibeContainerSum,
  AUTOTRADE_RESOURCES } from '../../src/agent/autoTradeContainerClient.js';

const payload = () => ({
  schema: 1,service:'autotrade',sampledAt:new Date().toISOString(),
  cpuVcpu:0.0129,ramUsedMb:122,ramLimitMb:1024,
  sourceCpu:'CGROUP_V2',sourceRam:'CGROUP_V2'
});
const local = () => ({
  appId:'vps-monitor',name:'VPS Monitor',sampledAt:new Date().toISOString(),
  ramUsedMb:34.7,ramLimitMb:256,cpuVcpu:0.003,sourceCpu:'PROCESS'
});

test('parse only fresh, explicitly container-scoped AutoTrade numbers', () => {
  const x=parseAutoTradeContainer(payload());
  assert.equal(x.ramUsedMb,122);
  assert.equal(x.cpuVcpu,0.0129);
  assert.equal(x.appId,'autotrade');
  assert.throws(()=>parseAutoTradeContainer({...payload(),ramUsedMb:-3}),/INVALID/);
  assert.throws(()=>parseAutoTradeContainer({...payload(),cpuVcpu:'0.8'}),/INVALID/);
  assert.throws(()=>parseAutoTradeContainer({...payload(),sampledAt:'2020-01-01T00:00:00Z'}),/STALE/);
  assert.throws(()=>parseAutoTradeContainer({...payload(),service:'x'}),/INVALID/);
});

test('compose sums two containers, not host, and requires both samples fresh', () => {
  const total=composeVibeContainerSum(local(),parseAutoTradeContainer(payload()));
  assert.equal(total.ramUsedMb,156.7);
  assert.equal(total.cpuUsedVcpu,0.0159);
  assert.equal(total.apps.length,2);
  assert.equal(composeVibeContainerSum(local(),{
    ...parseAutoTradeContainer(payload()),cpuVcpu:null
  }).cpuUsedVcpu,null);
  assert.throws(()=>composeVibeContainerSum(local(),null),/INCOMPLETE/);
  assert.throws(()=>composeVibeContainerSum({...local(),sampledAt:'2020-01-01T00:00:00Z'},parseAutoTradeContainer(payload())),/INCOMPLETE/);
});

test('secure one-host transport and strict schema', async () => {
  const client=new AutoTradeContainerClient({fetchFn:async (url,opts)=>{
    assert.equal(url,AUTOTRADE_RESOURCES);
    assert.equal(opts.redirect,'error');
    assert.equal(opts.headers.authorization,undefined);
    return {ok:true,text:async()=>JSON.stringify(payload())};
  }});
  assert.equal((await client.read()).ramUsedMb,122);
  assert.throws(()=>new AutoTradeContainerClient({
    url:'http://127.0.0.1:8000/monitor/resources'
  }),/FORBIDDEN/);
});
