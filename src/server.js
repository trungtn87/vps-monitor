import http from 'node:http';
import { loadConfig } from './common/config.js';
import { logger } from './common/logger.js';
import { MonitorDatabase } from './db/database.js';
import { SystemCollector } from './agent/collector.js';
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
  const config = loadConfig(customEnv || process.env);
  logger.info(`Starting VPS Monitor V1 on [${config.serverName}] (ID: ${config.serverId})`);

  // 1. Initialize SQLite Database
  const db = new MonitorDatabase(config.dbPath);

  // 2. Register Local and Peer Servers
  db.upsertServer({
    serverId: config.serverId,
    name: config.serverName,
    host: config.host,
    port: config.port,
    role: 'PRIMARY',
    expiryDate: config.expiryDate,
    isLocal: true
  });

  db.upsertServer({
    serverId: config.peerServerId,
    name: config.peerServerName,
    host: config.peerUrl,
    port: config.port,
    role: 'PRIMARY',
    expiryDate: config.peerExpiryDate,
    isLocal: false
  });

  // 3. Register Local App Service (11Ship or AutoTrade)
  db.upsertService({
    serviceId: config.appServiceId,
    serverId: config.serverId,
    name: config.appServiceName,
    healthUrl: config.appHealthUrl,
    status: config.appHealthUrl ? 'UNKNOWN' : 'DISABLED'
  });

  // 4. Initialize Components
  const collector = new SystemCollector();
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

  const evaluator = new MonitorEvaluator({ db, config });

  const notifier = new DiscordNotifier({
    webhookUrl: config.discordWebhookUrl,
    botToken: config.discordBotToken,
    channelId: config.discordAppId
  });

  const commands = new DiscordCommands({ db, evaluator, config });

  let discordInteractions = null;
  if (config.discordPublicKey) {
    discordInteractions = new DiscordInteractionsHandler({
      publicKey: config.discordPublicKey,
      commands
    });
  }

  const alertEngine = new AlertEngine({ db, evaluator, notifier, config });

  // 5. Function to package outgoing metrics for heartbeat
  const getMetricsPayload = () => {
    const latestMetrics = db.getLatestMetrics(config.serverId);
    const services = db.getServicesByServer(config.serverId);
    const appService = services.length > 0 ? {
      serviceId: services[0].service_id,
      name: services[0].name,
      status: services[0].status,
      healthUrl: services[0].health_url,
      error: services[0].last_error
    } : null;

    if (!latestMetrics) return { appService };

    return {
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

  const server = http.createServer((req, res) => {
    router.handleRequest(req, res);
  });

  // 7. Interval Loops
  let agentTimer = null;
  let heartbeatTimer = null;
  let alertTimer = null;
  let retentionTimer = null;

  // Local metric collection & app health check routine
  const runAgentCycle = async () => {
    try {
      const metrics = collector.collect(config.serverId);
      db.insertMetrics(metrics);

      // Check app health
      const appRes = await appChecker.check();
      db.upsertService({
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

  // Alert check cycle
  const runAlertCycle = async () => {
    try {
      await alertEngine.checkCycle();
    } catch (err) {
      logger.error('Error during alert check cycle:', err);
    }
  };

  // Retention cleanup routine
  const runRetentionCycle = () => {
    try {
      const cleaned = db.cleanOldData(config.retentionDays);
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
        server.listen(config.port, config.host, () => {
          logger.info(`VPS Monitor running on http://${config.host}:${config.port}`);
          startTimers();
          resolve(server);
        });
      });
    },
    stop: () => {
      return new Promise((resolve) => {
        stopTimers();
        server.close(() => {
          db.close();
          logger.info('VPS Monitor stopped cleanly.');
          resolve();
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
