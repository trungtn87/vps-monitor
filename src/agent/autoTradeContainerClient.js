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

export function composeVibeContainerSum(local, remote, now=Date.now()) {
  if(!local || !remote || !numeric(local.ramUsedMb) ||
      !(local.cpuVcpu===null || numeric(local.cpuVcpu,64)) ||
      !numeric(remote.ramUsedMb) ||
      !(remote.cpuVcpu===null || numeric(remote.cpuVcpu,64)) ||
      !Number.isFinite(Date.parse(local.sampledAt)) ||
      Math.abs(now-Date.parse(local.sampledAt))>120000 ||
      Math.abs(now-Date.parse(remote.sampledAt))>120000) {
    throw new Error('VIBE_CONTAINER_SAMPLE_INCOMPLETE');
  }
  const cpuVcpu = local.cpuVcpu === null || remote.cpuVcpu === null
    ? null : Math.round((local.cpuVcpu+remote.cpuVcpu)*100000)/100000;
  return {
    cpuUsedVcpu:cpuVcpu,
    ramUsedMb:Math.round((local.ramUsedMb+remote.ramUsedMb)*100)/100,
    apps:[local,remote],
  };
}
