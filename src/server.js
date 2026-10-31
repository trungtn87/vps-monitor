import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from './common/config.js';
import { logger } from './common/logger.js';
import { MonitorDatabase } from './db/database.js';
import { PgMonitorDatabase } from './db/pgDatabase.js';
import { SystemCollector } from './agent/collector.js';
import { VibeContainerCollector } from './agent/vibeContainerCollector.js';
import { AppHealthChecker } from './agent/appHealth.js';
import { HeartbeatClient } from './monitor/heartbeatClient.js';
import { HeartbeatReceiver } from './monitor/heartbeatReceiver.js';
import { MonitorEvaluator } from './monitor/evaluator.js';
import { AlertEngine } from './monitor/alertEngine.js';
import { DiscordNotifier } from './discord/notifier.js';
import { DiscordCommands } from './discord/commands.js';
import { DiscordInteractionsHandler } from './discord/interactions.js';
import { AuthGuard } from './web/auth.js';
import { HttpRouter } from './web/routes.js';

export async function createServer(customEnv = null) {
  if (!customEnv && existsSync('.env') && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile('.env');
    } catch {
      // ignore parse errors
    }
  }
  const config = loadConfig(customEnv || process.env);
  const serviceStartedAt = Date.now();
  logger.info(`Starting VPS Monitor V1 on [${config.serverName}] (ID: ${config.serverId})`);

  // Vibe always uses its own dedicated Supabase PostgreSQL project.
  // VinaHost keeps its existing local SQLite implementation.
  const db = config.dbBackend === 'supabase_postgres'
    ? await new PgMonitorDatabase(config.databaseUrl).init()
    : new MonitorDatabase(config.dbPath);

  // 2. Register Local and Peer Servers
  await db.upsertServer({
    serverId: config.serverId,
    name: config.serverName,
    host: config.host,
    port: config.port,
    role: 'PRIMARY',
    expiryDate: config.expiryDate,
    isLocal: true
  });

  await db.upsertServer({
    serverId: config.peerServerId,
    name: config.peerServerName,
    host: config.peerUrl,
    port: config.port,
    role: 'PRIMARY',
    expiryDate: config.peerExpiryDate,
    isLocal: false
  });

  // 3. Register Local App Service (11Ship or AutoTrade)
  await db.upsertService({
    serviceId: config.appServiceId,
    serverId: config.serverId,
    name: config.appServiceName,
    healthUrl: config.appHealthUrl,
    status: config.appHealthUrl ? 'UNKNOWN' : 'DISABLED'
  });

  // 4. Initialize Components
  const collector = config.vibeHosting ? new VibeContainerCollector() : new SystemCollector();
  const appChecker = new AppHealthChecker(
    config.appServiceId,
    config.appServiceName,
    config.appHealthUrl
  );

  const heartbeatReceiver = new HeartbeatReceiver({
    serverId: config.serverId,
    heartbeatSecret: config.heartbeatSecret,
    db
  });

  // Finding 4: Track serviceStartedAt for boot-time grace evaluation
  const evaluator = new MonitorEvaluator({ db, config, serviceStartedAt });

  // Finding 9: Use distinct discordChannelId, not discordAppId
  const notifier = new DiscordNotifier({
    webhookUrl: config.discordWebhookUrl,
    botToken: config.discordBotToken,
    channelId: config.discordChannelId
  });

  const commands = new DiscordCommands({ db, evaluator, config });

  let discordInteractions = null;
  if (config.discordPublicKey) {
    // Finding 9 & Blocker 5: Pass allowlists and nodeEnv for fail-closed validation
    discordInteractions = new DiscordInteractionsHandler({
      publicKey: config.discordPublicKey,
      commands,
      allowedUserIds: config.discordAllowedUserIds,
      allowedGuildIds: config.discordAllowedGuildIds,
      nodeEnv: config.nodeEnv
    });
  }

  // Finding 3: AlertEngine with persistent outbox queue
  const alertEngine = new AlertEngine({ db, evaluator, notifier, config });
  await alertEngine.init();

  // 5. Function to package outgoing metrics for heartbeat
  const getMetricsPayload = async () => {
    const latestMetrics = await db.getLatestMetrics(config.serverId);
    const services = await db.getServicesByServer(config.serverId);
    const appService = services.length > 0 ? {
      serviceId: services[0].service_id,
      name: services[0].name,
      status: services[0].status,
      healthUrl: services[0].health_url,
      error: services[0].last_error
    } : null;

    if (!latestMetrics) return { appService, metricScope: config.metricScope };

    return {
      metricScope: config.metricScope,
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
      appService
    };
  };

  const heartbeatClient = new HeartbeatClient({
    serverId: config.serverId,
    peerServerId: config.peerServerId,
    peerUrl: config.peerUrl,
    heartbeatSecret: config.heartbeatSecret,
    getMetricsPayload
  });

  // 6. Router & Web Server
  const authGuard = new AuthGuard({
    user: config.dashboardUser,
    pass: config.dashboardPass,
    apiToken: config.apiToken
  });

  const router = new HttpRouter({
    db,
    evaluator,
    heartbeatReceiver,
    discordInteractions,
    authGuard,
    config
  });

  // Finding 2 & Blocker 1: Native TLS / HTTPS support with permission handling
  let server;
  const isTlsConfigured = Boolean(config.tlsCertPath && config.tlsKeyPath);

  if (isTlsConfigured) {
    if (!existsSync(config.tlsCertPath) || !existsSync(config.tlsKeyPath)) {
      const err = new Error(`[TLS CONFIG ERROR] Configured TLS certificate or key file not found: cert=${config.tlsCertPath}, key=${config.tlsKeyPath}`);
      logger.error(err.message);
      if (config.requireTls && config.nodeEnv === 'production') throw err;
    } else {
      try {
        const cert = readFileSync(config.tlsCertPath);
        const key = readFileSync(config.tlsKeyPath);
        server = https.createServer({ cert, key }, (req, res) => {
          router.handleRequest(req, res);
        });
        logger.info('TLS certificate and key loaded successfully. Starting HTTPS server.');
      } catch (err) {
        if (err.code === 'EACCES') {
          logger.error(
            `[SECURITY PERMISSION ERROR] Service user 'vpsmon' cannot read TLS key (${config.tlsKeyPath}).\n` +
            `Root-owned Let's Encrypt keys (/etc/letsencrypt/live/...) are mode 0600 root:root.\n` +
            `Remedy: Copy certs to /etc/vps-monitor/certs/ owned by vpsmon:vpsmon (chmod 600),\n` +
            `or terminate TLS via Nginx / Caddy reverse proxy on port 443/5050.`
          );
        }
        throw err;
      }
    }
  }

  if (!server) {
    if (config.requireTls && config.nodeEnv === 'production') {
      throw new Error('[SECURITY FATAL] REQUIRE_TLS is enabled but TLS certificates could not be loaded.');
    }
    server = http.createServer((req, res) => {
      router.handleRequest(req, res);
    });
  }

  // 7. Interval Loops
  let agentTimer = null;
  let heartbeatTimer = null;
  let alertTimer = null;
  let retentionTimer = null;

  // Local metric collection & app health check routine
  const runAgentCycle = async () => {
    try {
      const metrics = collector.collect(config.serverId);
      await db.insertMetrics(metrics);

      // Check app health
      const appRes = await appChecker.check();
      await db.upsertService({
        serviceId: config.appServiceId,
        serverId: config.serverId,
        name: config.appServiceName,
        healthUrl: config.appHealthUrl,
        status: appRes.status,
        lastCheck: new Date().toISOString(),
        lastError: appRes.error
      });
    } catch (err) {
      logger.error('Error during local agent collection cycle:', err);
    }
  };

  // Heartbeat sender routine
  const runHeartbeatCycle = async () => {
    try {
      await heartbeatClient.sendHeartbeat();
    } catch (err) {
      logger.error('Error during outgoing heartbeat cycle:', err);
    }
  };

  // Alert check cycle & outbox flush
  const runAlertCycle = async () => {
    try {
      await alertEngine.checkCycle();
    } catch (err) {
      logger.error('Error during alert check cycle:', err);
    }
  };

  // Retention cleanup routine
  const runRetentionCycle = async () => {
    try {
      const cleaned = await db.cleanOldData(config.retentionDays);
      logger.info(`Retention cleanup executed: ${JSON.stringify(cleaned)}`);
    } catch (err) {
      logger.error('Error running 30-day retention cleanup:', err);
    }
  };

  const startTimers = () => {
    // Immediate first runs
    runAgentCycle();
    runRetentionCycle();

    agentTimer = setInterval(runAgentCycle, config.heartbeatIntervalSec * 1000);
    heartbeatTimer = setInterval(runHeartbeatCycle, config.heartbeatIntervalSec * 1000);
    alertTimer = setInterval(runAlertCycle, 30 * 1000); // Check connectivity & alerts every 30s
    retentionTimer = setInterval(runRetentionCycle, 24 * 60 * 60 * 1000); // Daily retention
  };

  const stopTimers = () => {
    if (agentTimer) clearInterval(agentTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (alertTimer) clearInterval(alertTimer);
    if (retentionTimer) clearInterval(retentionTimer);
  };

  return {
    server,
    db,
    config,
    evaluator,
    alertEngine,
    collector,
    appChecker,
    heartbeatClient,
    heartbeatReceiver,
    notifier,
    commands,
    discordInteractions,
    runAgentCycle,
    runHeartbeatCycle,
    runAlertCycle,
    runRetentionCycle,
    startTimers,
    stopTimers,
    start: () => {
      return new Promise((resolve) => {
        const protocol = (server instanceof https.Server) ? 'https' : 'http';
        server.listen(config.port, config.host, () => {
          logger.info(`VPS Monitor running on ${protocol}://${config.host}:${config.port}`);
          startTimers();
          resolve(server);
        });
      });
    },
    stop: () => {
      return new Promise((resolve) => {
        stopTimers();
        server.close(() => {
          Promise.resolve(db.close()).then(() => 'VPS Monitor stopped cleanly.')).then(resolve).catch(resolve);
        });
      });
    }
  };
}

// Standalone execution entrypoint
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  createServer().then(instance => {
    instance.start();

    const handleSignal = async (signal) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      await instance.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => handleSignal('SIGTERM'));
    process.on('SIGINT', () => handleSignal('SIGINT'));
  }).catch(err => {
    logger.error('Fatal startup error:', err);
    process.exit(1);
  });
}
