// Fixed-shape application telemetry fetched from explicit Vibe Hosting HTTPS URLs.
// Reject redirects, private network targets and stale/unexpected service data.
function finite(v, upper=1_000_000) {
  return typeof v==='number' && Number.isFinite(v) && v>=0 && v<=upper;
}
export function parseExtraVibeContainer(payload, app, now=Date.now()) {
  if(!payload || payload.schema!==1 || payload.service!==app.id ||
     !finite(payload.ramUsedMb) ||
     !(payload.ramLimitMb===null || finite(payload.ramLimitMb)) ||
     !(payload.cpuVcpu===null || finite(payload.cpuVcpu,64)) ||
     !['CGROUP_V2','PROCESS'].includes(payload.sourceCpu) ||
     !['CGROUP_V2','PROCESS'].includes(payload.sourceRam)) {
    throw new Error('EXTRA_VIBE_APP_METRICS_INVALID');
  }
  const timestamp=Date.parse(payload.sampledAt);
  if(!Number.isFinite(timestamp) || now-timestamp>120000 || timestamp-now>30000){
    throw new Error('EXTRA_VIBE_APP_METRICS_STALE');
  }
  return {
    appId:app.id,name:app.name,
    cpuVcpu:payload.cpuVcpu,ramUsedMb:payload.ramUsedMb,
    ramLimitMb:payload.ramLimitMb,
    sourceCpu:payload.sourceCpu,sourceRam:payload.sourceRam,
    sampledAt:new Date(timestamp).toISOString(),status:'MEASURED'
  };
}

export class ExtraVibeAppClient {
  constructor(app,{fetchFn=fetch}={}) {
    if(!app || !app.id || !app.name || !app.resourcesUrl) {
      throw new Error('EXTRA_VIBE_APP_SOURCE_MISSING');
    }
    const u=new URL(app.resourcesUrl);
    if(u.protocol!=='https:' || !(u.hostname.endsWith('.vnws.com') || (app.id==='11local' && u.hostname==='11local.vn' && u.pathname==='/api/monitor/resources')) ||
       u.username || u.password || u.port || u.search || u.hash ||
       !['/monitor/resources','/api/monitor/resources'].includes(u.pathname)) {
      throw new Error('EXTRA_VIBE_APP_SOURCE_NOT_ALLOWED');
    }
    this.app=app;
    this.fetchFn=fetchFn;
  }
  async read() {
    const response=await this.fetchFn(this.app.resourcesUrl,{
      method:'GET',redirect:'error',headers:{accept:'application/json'},
      signal:AbortSignal.timeout(6000)
    });
    if(!response.ok)throw new Error('EXTRA_VIBE_APP_HTTP_'+response.status);
    const body=await response.text();
    if(body.length>4096)throw new Error('EXTRA_VIBE_APP_PAYLOAD_TOO_LARGE');
    return parseExtraVibeContainer(JSON.parse(body),this.app);
  }
}
