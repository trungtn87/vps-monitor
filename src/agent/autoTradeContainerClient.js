// AutoTrade's existing read-only HTTPS app endpoint: no sessions or API keys.
// A point-in-time sample from ONE container, not a provider hosting account.
export const AUTOTRADE_RESOURCES = 'https://vibetpmzwpxt5.vibe3.vnws.com/monitor/resources';

function numeric(v, max=1e6) {
  return typeof v==='number' && Number.isFinite(v) && v>=0 && v<=max;
}

export function parseAutoTradeContainer(body, now=Date.now()) {
  if (!body || body.schema !== 1 || body.service !== 'autotrade' ||
      !numeric(body.ramUsedMb) ||
      !(body.ramLimitMb === null || numeric(body.ramLimitMb)) ||
      !(body.cpuVcpu === null || numeric(body.cpuVcpu,64)) ||
      !['CGROUP_V2','PROCESS'].includes(body.sourceCpu) ||
      !['CGROUP_V2','PROCESS'].includes(body.sourceRam)) {
    throw new Error('AUTOTRADE_METRIC_INVALID');
  }
  const sample = Date.parse(body.sampledAt);
  if (!Number.isFinite(sample) || sample-now>30000 || now-sample>120000) {
    throw new Error('AUTOTRADE_METRIC_STALE');
  }
  return {
    name:'AutoTrade',appId:'autotrade',
    cpuVcpu:body.cpuVcpu,
    ramUsedMb:body.ramUsedMb,
    ramLimitMb:body.ramLimitMb,
    sourceCpu:body.sourceCpu,sourceRam:body.sourceRam,
    sampledAt:new Date(sample).toISOString()
  };
}

export class AutoTradeContainerClient {
  constructor({url=AUTOTRADE_RESOURCES,fetchFn=fetch}={}) {
    // Do not permit configurable redirects or URL parameters to fetch internal IPs.
    if(url!==AUTOTRADE_RESOURCES)throw new Error('AUTOTRADE_METRIC_URL_FORBIDDEN');
    this.url=url;this.fetchFn=fetchFn;
  }
  async read() {
    const response=await this.fetchFn(this.url,{
      method:'GET',redirect:'error',
      headers:{accept:'application/json'},
      signal:AbortSignal.timeout(6000)
    });
    if(!response.ok)throw new Error('AUTOTRADE_METRIC_HTTP_'+response.status);
    const data=await response.text();
    if(data.length>4000)throw new Error('AUTOTRADE_METRIC_RESPONSE_TOO_LARGE');
    return parseAutoTradeContainer(JSON.parse(data));
  }
}

export function composeVibeContainerSum(local, remote, now=Date.now(), extras=[]) {
  if(!local || !remote || !Array.isArray(extras) || extras.length>8) {
    throw new Error('VIBE_CONTAINER_SAMPLE_INCOMPLETE');
  }
  const apps=[local,remote,...extras];
  // Missing services remain visible but cannot silently contribute zero.
  const readable=apps.map(app=>{
    if(!app || typeof app.name!=='string' || typeof app.appId!=='string') {
      throw new Error('VIBE_CONTAINER_SAMPLE_INCOMPLETE');
    }
    if(app.status==='UNAVAILABLE' && app.ramUsedMb===null && app.cpuVcpu===null){
      return false;
    }
    if(!numeric(app.ramUsedMb) ||
       !(app.cpuVcpu===null || numeric(app.cpuVcpu,64)) ||
       !Number.isFinite(Date.parse(app.sampledAt)) ||
       Math.abs(now-Date.parse(app.sampledAt))>120000) {
      throw new Error('VIBE_CONTAINER_SAMPLE_INCOMPLETE');
    }
    return true;
  });
  const measured=apps.filter((app,i)=>readable[i]);
  const complete=measured.length===apps.length;
  const ramUsedMb=Math.round(measured.reduce((n,a)=>n+a.ramUsedMb,0)*100)/100;
  const cpuUsedVcpu=complete && apps.every(a=>a.cpuVcpu!==null)
    ? Math.round(apps.reduce((n,a)=>n+a.cpuVcpu,0)*100000)/100000
    : null;
  return {cpuUsedVcpu,ramUsedMb,apps,complete,measuredCount:measured.length};
}
