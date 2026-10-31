import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeState } from '../monitor/evaluator.js';
import { logger } from '../common/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

export class HttpRouter {
  /**
   * @param {object} options
   * @param {import('../db/database.js').MonitorDatabase} options.db
   * @param {import('../monitor/evaluator.js').MonitorEvaluator} options.evaluator
   * @param {import('../monitor/heartbeatReceiver.js').HeartbeatReceiver} options.heartbeatReceiver
   * @param {import('../discord/interactions.js').DiscordInteractionsHandler} [options.discordInteractions]
   * @param {import('./auth.js').AuthGuard} options.authGuard
   * @param {object} options.config
   */
  constructor({
    db,
    evaluator,
    heartbeatReceiver,
    discordInteractions,
    authGuard,
    config
  }) {
    this.db = db;
    this.evaluator = evaluator;
    this.heartbeatReceiver = heartbeatReceiver;
    this.discordInteractions = discordInteractions;
    this.authGuard = authGuard;
    this.config = config;
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) { // 1MB limit
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  _sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(data));
  }

  _sendError(res, statusCode, message) {
    this._sendJson(res, statusCode, { error: message });
  }

  /**
   * Handle an incoming HTTP request
   * @param {import('node:http').IncomingMessage} req 
   * @param {import('node:http').ServerResponse} res 
   */
  async handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    // 1. Healthcheck for Monitor service itself (public)
    if (pathname === '/healthz' && method === 'GET') {
      return this._sendJson(res, 200, {
        status: 'UP',
        service: 'vps-monitor',
        serverId: this.config.serverId,
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      });
    }

    // 2. Cross-VPS Heartbeat (authenticated via HMAC-SHA256 signature)
    if (pathname === '/api/heartbeat' && method === 'POST') {
      const signature = req.headers['x-signature-sha256'] || '';
      try {
        const rawBody = await this._readBody(req);
        let payload;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          return this._sendError(res, 400, 'Invalid JSON payload');
        }

        const result = await this.heartbeatReceiver.processHeartbeat(payload, signature);
        return this._sendJson(res, result.code, { status: result.reason });
      } catch (err) {
        logger.error('Error handling heartbeat request:', err);
        return this._sendError(res, 500, err.message);
      }
    }

    // 3. Discord Interactions (authenticated via Ed25519 signature)
    if (pathname === '/api/discord/interactions' && method === 'POST') {
      if (!this.discordInteractions) {
        return this._sendError(res, 503, 'Discord interactions not configured');
      }

      const sig = req.headers['x-signature-ed25519'] || '';
      const ts = req.headers['x-signature-timestamp'] || '';
      try {
        const rawBody = await this._readBody(req);
        const result = await this.discordInteractions.handle(rawBody, sig, ts);
        if (typeof result.body === 'string') {
          res.writeHead(result.status, { 'Content-Type': 'text/plain' });
          return res.end(result.body);
        }
        return this._sendJson(res, result.status, result.body);
      } catch (err) {
        logger.error('Error handling Discord interaction:', err);
        return this._sendError(res, 500, err.message);
      }
    }

    // Public read-only dashboard is an explicit opt-in on Vibe Hosting.
    // Mutating endpoints (heartbeat, Discord) remain independently authenticated.
    // Public access is limited to the actual dashboard assets and read APIs.
    const publicReadPaths = new Set([
      '/', '/index.html', '/style.css', '/app.js',
      '/api/status', '/api/metrics', '/api/events'
    ]);
    const publicRead = this.config.publicDashboard && method === 'GET' && publicReadPaths.has(pathname);
    if (!publicRead && !this.authGuard.isAuthorized(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="VPS Monitor Access"',
        'Content-Type': 'application/json'
      });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    // 4. API Status Overview
    if (pathname === '/api/status' && method === 'GET') {
      const servers = await this.db.getAllServers();
      const statusList = await Promise.all(servers.map(async srv => {
        const isLocal = srv.server_id === this.config.serverId;
        let connectionState = NodeState.ONLINE;
        let elapsedSec = 0;
        let lastReceivedAt = null;

        if (!isLocal) {
          const evalRes = await this.evaluator.evaluatePeerHeartbeat(srv.server_id);
          connectionState = evalRes.state;
          elapsedSec = evalRes.elapsedSec;
          lastReceivedAt = evalRes.lastReceivedAt;
        }

        const latestMetrics = await this.db.getLatestMetrics(srv.server_id);
        const hostingQuota = isLocal && this.config.vibeHosting && this.db.getLatestHostingQuota
          ? await this.db.getLatestHostingQuota(srv.server_id) : null;
        const services = await this.db.getServicesByServer(srv.server_id);
        const expiry = isLocal ? this.config.expiryDate : this.config.peerExpiryDate;
        const expiryEval = this.evaluator.evaluateExpiry(expiry);

        // Blocker 4: Check if metrics are stale (> 180s without new samples)
        let metricsAgeSec = null;
        let isMetricsStale = false;
        if (latestMetrics && latestMetrics.created_at) {
          const rawDate = latestMetrics.created_at;
          const metricTime = new Date(rawDate.includes('T') ? rawDate : rawDate.replace(' ', 'T') + 'Z').getTime();
          metricsAgeSec = Math.max(0, Math.floor((Date.now() - metricTime) / 1000));
          if (metricsAgeSec > (this.config.disconnectThresholdSec || 180)) {
            isMetricsStale = true;
          }
        } else {
          isMetricsStale = true;
        }

        // If local agent stopped collecting, node health is STALE/DEGRADED
        if (isLocal && isMetricsStale) {
          connectionState = 'STALE';
        }

        return {
          serverId: srv.server_id,
          name: srv.name,
          isLocal,
          metricScope: isLocal ? this.config.metricScope : this.config.peerMetricScope,
          hostingQuota,
          role: srv.role,
          connectionState,
          elapsedSec,
          lastHeartbeatAt: lastReceivedAt,
          expiryDate: expiry || null,
          daysRemaining: expiryEval.daysRemaining,
          agentHealth: {
            status: isMetricsStale ? 'STALE' : 'HEALTHY',
            isStale: isMetricsStale,
            ageSec: metricsAgeSec,
            lastCollectedAt: latestMetrics ? latestMetrics.created_at : null
          },
          metrics: latestMetrics ? {
            cpuPct: latestMetrics.cpu_pct,
            ramUsedMb: latestMetrics.ram_used_mb,
            ramTotalMb: latestMetrics.ram_total_mb,
            ramPct: latestMetrics.ram_pct,
            diskUsedGb: latestMetrics.disk_used_gb,
            diskTotalGb: latestMetrics.disk_total_gb,
            diskPct: latestMetrics.disk_pct,
            netRxBytes: latestMetrics.net_rx_bytes,
            netTxBytes: latestMetrics.net_tx_bytes,
            uptimeSec: latestMetrics.uptime_sec,
            updatedAt: latestMetrics.created_at,
            ageSec: metricsAgeSec,
            isStale: isMetricsStale
          } : null,
          services: services.map(s => ({
            serviceId: s.service_id,
            name: s.name,
            status: s.status,
            lastCheck: s.last_check,
            lastError: s.last_error
          }))
        };
      }));

      return this._sendJson(res, 200, {
        localServerId: this.config.serverId,
        timestamp: new Date().toISOString(),
        servers: statusList
      });
    }

    // 5. API Metrics History (for charts)
    if (pathname === '/api/metrics' && method === 'GET') {
      const serverId = url.searchParams.get('server') || this.config.serverId;
      const limit = Math.min(300, parseInt(url.searchParams.get('limit') || '60', 10));
      // Match chart provenance to the card: when Hosting-wide data is live,
      // chart account CPU/RAM rather than mixing in container-only history.
      if (this.config.vibeHosting && serverId === this.config.serverId &&
          this.db.getLatestHostingQuota && this.db.getHostingQuotaHistory) {
        const latestQuota = await this.db.getLatestHostingQuota(serverId);
        if (latestQuota && !latestQuota.isStale) {
          const metrics = await this.db.getHostingQuotaHistory(serverId, limit);
          return this._sendJson(res, 200, { serverId, metricScope: 'VIBE_HOSTING_ACCOUNT', metrics });
        }
      }
      const metrics = await this.db.getMetricsHistory(serverId, limit);
      return this._sendJson(res, 200, { serverId, metricScope: 'CONTAINER', metrics });
    }

    // 6. API Events History
    if (pathname === '/api/events' && method === 'GET') {
      const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10));
      const events = await this.db.getRecentEvents(limit);
      return this._sendJson(res, 200, { events });
    }

    // 7. Static Dashboard Frontend
    let filePath = pathname === '/' ? join(PUBLIC_DIR, 'index.html') : join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath);
        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY'
        });
        return res.end(content);
      } catch (err) {
        return this._sendError(res, 500, 'Error reading file');
      }
    }

    // 404 Not Found
    this._sendError(res, 404, 'Endpoint Not Found');
  }
}
