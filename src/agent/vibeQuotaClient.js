// Optional read-only Nhân Hòa Vibe Hosting account quota source.
// This endpoint belongs to the hosting control plane and is NOT Linux host metrics.
// Never send Vibe cookies or credentials to the public Dashboard.
const ORIGIN = 'https://vibe-api3.nhanhoa.com:8443';
const ENDPOINT_PATH = '/api/vibe/stats/poll';

function finitePositive(n, name, allowZero = true) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new Error(`INVALID_QUOTA_${name}`);
  }
  return n;
}

export function parseVibeQuota(payload, expectedUserId = '') {
  if (!payload || payload.success !== true || payload.nhanhoa_available !== true || payload.stale === true) {
    throw new Error('VIBE_QUOTA_UNAVAILABLE');
  }
  if (expectedUserId && String(payload.userId) !== String(expectedUserId)) {
    throw new Error('VIBE_QUOTA_ACCOUNT_MISMATCH');
  }
  const { cpu, ram, disk } = payload.stats || {};
  if (!cpu || !ram || !disk) throw new Error('VIBE_QUOTA_STATS_MISSING');
  const snapshotAt = new Date(payload.snapshot_at).getTime();
  const age = Date.now() - snapshotAt;
  if (!Number.isFinite(snapshotAt) || age < -120000 || age > 180000) {
    throw new Error('VIBE_QUOTA_STALE');
  }
  const apps = Array.isArray(payload.containers?.containers)
    ? payload.containers.containers.slice(0, 30).map(c => ({
      name: String(c.displayName || '').slice(0, 80),
      cpuVcpu: finitePositive(c.cpuVcpu, 'APP_CPU'),
      ramMb: finitePositive(c.ramMb, 'APP_RAM'),
      ramLimitMb: c.ramLimitMb != null ? finitePositive(c.ramLimitMb, 'APP_RAM_LIMIT') : null
    })) : [];
  return {
    source: 'VIBE_HOSTING_ACCOUNT',
    snapshotAt: new Date(snapshotAt).toISOString(),
    cpuUsedVcpu: finitePositive(cpu.used_vcpu, 'CPU'),
    cpuQuotaVcpu: finitePositive(cpu.quota_vcpu, 'CPU_QUOTA', false),
    cpuPct: finitePositive(cpu.used_percent_total, 'CPU_PCT'),
    ramUsedMb: finitePositive(ram.used_mb, 'RAM'),
    ramQuotaMb: finitePositive(ram.quota_mb, 'RAM_QUOTA', false),
    ramPct: finitePositive(ram.used_percent, 'RAM_PCT'),
    diskUsedMb: finitePositive(disk.used_mb, 'DISK'),
    diskQuotaMb: finitePositive(disk.quota_mb, 'DISK_QUOTA', false),
    diskPct: finitePositive(disk.used_percent, 'DISK_PCT'),
    apps
  };
}

export class VibeQuotaClient {
  constructor({ url, token, expectedUserId = '', fetchFn = fetch }) {
    if (!url) throw new Error('VIBE_QUOTA_URL is required');
    const parsed = new URL(url);
    if (parsed.origin !== ORIGIN || parsed.protocol !== 'https:' ||
        parsed.pathname !== ENDPOINT_PATH || parsed.username ||
        parsed.password || parsed.hash ||
        parsed.searchParams.size !== 1 || !/^\\d+$/.test(parsed.searchParams.get('userId') || '')) {
      throw new Error('VIBE_QUOTA_URL must use the exact Vibe stats/poll HTTPS endpoint with only userId');
    }
    if (String(parsed.searchParams.get('userId')) !== String(expectedUserId)) {
      throw new Error('VIBE_QUOTA_ACCOUNT_MISMATCH');
    }
    this.url = parsed.href;
    this.token = token || '';
    this.expectedUserId = expectedUserId;
    this.fetchFn = fetchFn;
  }
  async read() {
    const headers = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.fetchFn(this.url, {
      method: 'GET', redirect: 'error', headers,
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403
        ? 'VIBE_QUOTA_AUTH_REQUIRED'
        : 'VIBE_QUOTA_HTTP_UNAVAILABLE');
    }
    const body = await response.text();
    if (body.length > 256000) throw new Error('VIBE_QUOTA_RESPONSE_TOO_LARGE');
    return parseVibeQuota(JSON.parse(body), this.expectedUserId);
  }
}
