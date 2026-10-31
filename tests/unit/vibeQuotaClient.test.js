import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVibeQuota, VibeQuotaClient } from '../../src/agent/vibeQuotaClient.js';

function fixture() {
  return {
    timestamp: new Date().toISOString(), success: true, userId: '81',
    nhanhoa_available: true, snapshot_at: new Date().toISOString(), stale: false,
    stats: {
      disk: { quota_mb: 3072, used_mb: 1.69, used_percent: 0.1 },
      ram: { quota_mb: 2048, used_mb: 146.07, used_percent: 7.1,
        nhanhoa_reported_used_mb: 1280 },
      cpu: { quota_vcpu: 1, used_vcpu: 0.0129, used_percent_total: 1.29,
        nhanhoa_reported_used_vcpu: 0.75 }
    },
    containers: { containers: [
      {displayName:'vps-monitor',cpuVcpu:0,ramMb:25.37,ramLimitMb:256},
      {displayName:'autotrade',cpuVcpu:0.0129,ramMb:120.7,ramLimitMb:1024}
    ]}
  };
}

test('parse Vibe account-level quota without mistaking provider-reported values for usage', () => {
  const q = parseVibeQuota(fixture(),'81');
  assert.equal(q.source,'VIBE_HOSTING_ACCOUNT');
  assert.equal(q.cpuUsedVcpu,0.0129);
  assert.equal(q.cpuPct,1.29);
  assert.equal(q.ramUsedMb,146.07);
  assert.equal(q.ramQuotaMb,2048);
  assert.equal(q.diskQuotaMb,3072);
  assert.equal(q.apps[1].name,'autotrade');
  assert.equal(q.apps[1].ramMb,120.7);
  assert.ok(!('nhanhoaReportedUsedMb' in q));
});

test('reject stale, mismatched and invalid Vibe metrics', () => {
  let p=fixture();p.stale=true;assert.throws(()=>parseVibeQuota(p,'81'),/UNAVAILABLE/);
  p=fixture();assert.throws(()=>parseVibeQuota(p,'82'),/MISMATCH/);
  p=fixture();p.stats.ram.used_mb=-10;assert.throws(()=>parseVibeQuota(p,'81'),/INVALID_QUOTA_RAM/);
  p=fixture();p.snapshot_at='2020-01-01T00:00:00Z';assert.throws(()=>parseVibeQuota(p,'81'),/STALE/);
});

test('Vibe client restricts destinations and does not send browser cookies', async () => {
  assert.throws(()=>new VibeQuotaClient({url:'http://vibe.nhanhoa.com/api/quota'}),/official HTTPS/);
  assert.throws(()=>new VibeQuotaClient({url:'https://evil.example.com/api/quota'}),/exact Vibe stats/);
  assert.throws(()=>new VibeQuotaClient({url:'https://vibe-api3.nhanhoa.com:8443/api/vibe/stats/poll?userId=82',expectedUserId:'81'}),/MISMATCH/);
  assert.throws(()=>new VibeQuotaClient({url:'https://vibe-api3.nhanhoa.com:8443/api/vibe/stats/poll?userId=81&redirect=http://bad.test',expectedUserId:'81'}),/official HTTPS/);
  let opts=null;
  const client = new VibeQuotaClient({
    url:'http://vibe-api3.nhanhoa.com:8443/api/vibe/stats/poll?userId=81/check-quota?userId=81',
    token:'example-read-token', expectedUserId:'81',
    fetchFn:async (_,p)=>{opts=p;return {ok:true,text:async()=>JSON.stringify(fixture())};}
  });
  const data=await client.read();
  assert.equal(data.ramUsedMb,146.07);
  assert.equal(opts.headers.authorization,'Bearer example-read-token');
  assert.ok(!('cookie' in opts.headers));
  assert.equal(opts.redirect,'error');
});
