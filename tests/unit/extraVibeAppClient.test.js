import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVibeExtraApps, loadConfig } from '../../src/common/config.js';
import { ExtraVibeAppClient, parseExtraVibeContainer } from '../../src/agent/extraVibeAppClient.js';
import { composeVibeContainerSum } from '../../src/agent/autoTradeContainerClient.js';

const app={id:'third-web',name:'Dự án mới',resourcesUrl:'https://example.vibe3.vnws.com/monitor/resources'};
const sample=(id,ram,cpu)=>({
  appId:id,name:id,ramUsedMb:ram,cpuVcpu:cpu,ramLimitMb:512,
  sampledAt:new Date().toISOString(),status:'MEASURED'
});
const incoming=()=>({
  schema:1,service:'third-web',sampledAt:new Date().toISOString(),
  ramUsedMb:86,cpuVcpu:0.005,ramLimitMb:512,
  sourceCpu:'CGROUP_V2',sourceRam:'CGROUP_V2'
});

test('dynamic app registration supports 3+ without unsafe provider fetch destinations',()=>{
  assert.deepEqual(parseVibeExtraApps(JSON.stringify([app])),[app]);
  assert.throws(()=>parseVibeExtraApps('{'),/INVALID/);
  assert.throws(()=>parseVibeExtraApps(JSON.stringify([app,app])),/INVALID/);
  assert.throws(()=>parseVibeExtraApps(JSON.stringify([{...app,resourcesUrl:'http://127.0.0.1/monitor/resources'}])),/NOT_ALLOWED/);
  assert.throws(()=>parseVibeExtraApps(JSON.stringify([{...app,resourcesUrl:'https://test.vnws.com.evil.example/monitor/resources'}])),/NOT_ALLOWED/);
  assert.throws(()=>parseVibeExtraApps(JSON.stringify([{...app,id:'autotrade'}])),/INVALID/);
});

test('third app sample must match configured name and be fresh',async()=>{
  const parsed=parseExtraVibeContainer(incoming(),app);
  assert.equal(parsed.appId,'third-web');
  assert.equal(parsed.ramUsedMb,86);
  assert.throws(()=>parseExtraVibeContainer({...incoming(),service:'other'},app),/INVALID/);
  assert.throws(()=>parseExtraVibeContainer({...incoming(),sampledAt:'2020-01-01T00:00:00Z'},app),/STALE/);
  const client=new ExtraVibeAppClient(app,{fetchFn:async (url,opts)=>{
    assert.equal(url,app.resourcesUrl);
    assert.equal(opts.redirect,'error');
    assert.deepEqual(Object.keys(opts.headers),['accept']);
    return {ok:true,text:async()=>JSON.stringify(incoming())};
  }});
  assert.equal((await client.read()).ramUsedMb,86);
});

test('three-app sum requires every sample; missing third project stays visible',()=>{
  const own=sample('vps-monitor',35,0.003);
  const autotrade=sample('autotrade',120,0.015);
  const extra=sample('third-web',86,0.005);
  const complete=composeVibeContainerSum(own,autotrade,Date.now(),[extra]);
  assert.equal(complete.apps.length,3);
  assert.equal(complete.measuredCount,3);
  assert.equal(complete.ramUsedMb,241);
  assert.equal(complete.cpuUsedVcpu,0.023);
  assert.equal(complete.complete,true);
  const offline={appId:'third-web',name:'Dự án mới',ramUsedMb:null,cpuVcpu:null,status:'UNAVAILABLE'};
  const partial=composeVibeContainerSum(own,autotrade,Date.now(),[offline]);
  assert.equal(partial.ramUsedMb,155);
  assert.equal(partial.cpuUsedVcpu,null);
  assert.equal(partial.measuredCount,2);
  assert.equal(partial.complete,false);
  assert.equal(partial.apps[2].name,'Dự án mới');
});

test('Nhân Hòa production roster includes 11Local by default and accepts its HTTPS metrics URL', () => {
  const env = {
    NODE_ENV:'production', SERVER_ID:'nhanhoa', VIBE_HOSTING:'true',
    TRUSTED_PLATFORM_PROXY:'true', HOST:'0.0.0.0', REQUIRE_TLS:'false',
    HEARTBEAT_SECRET:'a'.repeat(64),
    DASHBOARD_PASS:'placeholder-test',
    DB_BACKEND:'supabase_postgres',
    DATABASE_URL:'postgresql://tester@db.gmpgtwtxhjwjeincvkxn.supabase.co:5432/postgres'
  };
  const base=loadConfig(env);
  assert.deepEqual(base.vibeExtraApps,[{id:'11local',name:'11Local',resourcesUrl:''}]);
  const url='https://sample.vibe3.vnws.com/api/monitor/resources';
  const configured=loadConfig({...env,
    VIBE_EXTRA_APPS_JSON:JSON.stringify([{id:'11local',name:'11Local',resourcesUrl:url}])
  });
  assert.equal(configured.vibeExtraApps[0].resourcesUrl,url);
});
