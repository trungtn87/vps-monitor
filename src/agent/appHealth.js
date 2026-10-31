export class AppHealthChecker {
  /**
   * @param {string} serviceId 
   * @param {string} serviceName 
   * @param {string} healthUrl 
   * @param {number} timeoutMs 
   */
  constructor(serviceId, serviceName, healthUrl, timeoutMs = 5000) {
    this.serviceId = serviceId;
    this.serviceName = serviceName;
    this.healthUrl = healthUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Check app health
   * @returns {Promise<{ status: string, latencyMs: number, error: string|null }>}
   */
  async check() {
    if (!this.healthUrl) {
      return {
        status: 'DISABLED',
        latencyMs: 0,
        error: null
      };
    }

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(this.healthUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'VPS-Monitor-HealthCheck/1.0' }
      });
      clearTimeout(timer);

      const latencyMs = Date.now() - start;

      if (res.ok) {
        return {
          status: 'HEALTHY',
          latencyMs,
          error: null
        };
      } else {
        return {
          status: 'UNHEALTHY',
          latencyMs,
          error: `HTTP ${res.status} ${res.statusText}`
        };
      }
    } catch (err) {
      const latencyMs = Date.now() - start;
      const isTimeout = err.name === 'AbortError';
      return {
        status: 'UNREACHABLE',
        latencyMs,
        error: isTimeout ? 'Connection timed out' : (err.message || 'Connection refused')
      };
    }
  }
}
