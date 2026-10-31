// Vibe Hosting does not expose runtime logs to the owner. This entrypoint
// keeps an isolated read-only diagnostic HTTP surface alive when startup fails.
// It never serves synthetic metrics or accepts heartbeats while the database
// is unavailable. Retry uses the normal app once Postgres is reachable.
import http from 'node:http';
import { createServer } from '../server.js';

export function startupFailureCode(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  if (/HEARTBEAT_SECRET/.test(msg)) return 'HEARTBEAT_SECRET_MISSING';
  if (/DATABASE_URL required|DATABASE_URL missing/.test(msg)) return 'DATABASE_URL_MISSING';
  if (/restricted|dedicated VPS-Monitor|target the dedicated/.test(msg)) return 'DATABASE_TARGET_INVALID';
  if (/DB SCHEMA ERROR/.test(msg)) return 'DATABASE_SCHEMA_MISSING';
  if (['28P01','28000'].includes(code) || /password authentication failed|tenant or user not found/i.test(msg)) return 'DATABASE_AUTH_FAILED';
  if (['ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','ECONNREFUSED'].includes(code)) return 'DATABASE_NETWORK_UNREACHABLE';
  if (['ENOTFOUND','EAI_AGAIN'].includes(code)) return 'DATABASE_HOST_UNRESOLVED';
  if (/certificate|SSL|TLS|self.signed/i.test(msg)) return 'DATABASE_TLS_ERROR';
  if (/SECURITY FATAL|DB CONFIG ERROR/.test(msg)) return 'STARTUP_CONFIGURATION_INVALID';
  return 'STARTUP_FAILED';
}

const hints = Object.freeze({
  HEARTBEAT_SECRET_MISSING: 'Set a shared HEARTBEAT_SECRET of 32+ characters in the Vibe Environment.',
  DATABASE_URL_MISSING: 'Set DATABASE_URL using the VPS-Monitor Supabase Session pooler connection string.',
  DATABASE_TARGET_INVALID: 'Use only the separate VPS-Monitor Supabase project, with the project ref in a pooler username.',
  DATABASE_SCHEMA_MISSING: 'The private vps_monitor PostgreSQL schema must exist in the selected project.',
  DATABASE_AUTH_FAILED: 'Check the custom PostgreSQL username and password in the VPS-Monitor connection string.',
  DATABASE_NETWORK_UNREACHABLE: 'The database endpoint is unreachable. Supabase Free direct connections require IPv6; use its Session pooler for IPv4 hosting.',
  DATABASE_HOST_UNRESOLVED: 'Check the exact pooler hostname copied from VPS-Monitor Supabase Connect; do not infer it from the region.',
  DATABASE_TLS_ERROR: 'Check the PostgreSQL TLS settings and the exact Supabase connection URI.',
  STARTUP_CONFIGURATION_INVALID: 'Check VIBE_HOSTING, TRUSTED_PLATFORM_PROXY, PUBLIC_DASHBOARD, HOST and REQUIRE_TLS.',
  STARTUP_FAILED: 'The app failed its startup checks; inspect the hosting Environment and database access.'
});

export function diagnosticPayload(code) {
  const safeCode = Object.prototype.hasOwnProperty.call(hints, code) ? code : 'STARTUP_FAILED';
  return { status: 'DEGRADED', service: 'vps-monitor', serverId: 'nhanhoa',
    ready: false, errorCode: safeCode, action: hints[safeCode] };
}

function diagnosticServer(handler) {
  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const data = handler();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // /healthz is a liveness check, NOT a readiness check. A 200 here is
    // accompanied by DEGRADED/ready:false; /readyz correctly fails closed.
    if (req.method === 'GET' && pathname === '/healthz') {
      res.statusCode = 200;
    } else {
      res.statusCode = 503;
      res.setHeader('Retry-After', '30');
    }
    res.end(JSON.stringify(data));
  });
}

export async function runVibeBootstrap({ retryIntervalMs = 30000 } = {}) {
  let monitor = null;
  let diagnostic = null;
  let failureCode = 'STARTUP_FAILED';
  let starting = false;
  let stopping = false;
  const port = Number(process.env.PORT || 3000);

  async function attempt() {
    if (starting || stopping || monitor) return;
    starting = true;
    try {
      const app = await createServer();
      if (stopping) {
        await app.db.close();
        return;
      }
      if (diagnostic) {
        const old = diagnostic;
        diagnostic = null;
        await new Promise(resolve => old.close(resolve));
      }
      await app.start();
      monitor = app;
      process.stdout.write('[vibe-bootstrap] READY: VPS Monitor started with PostgreSQL.\n');
    } catch (err) {
      failureCode = startupFailureCode(err);
      // Only an enumerated code is exposed; secrets, hosts and SQL are not.
      process.stderr.write(`[vibe-bootstrap] DEGRADED: ${failureCode}\n`);
      if (!diagnostic && !stopping) {
        diagnostic = diagnosticServer(() => diagnosticPayload(failureCode));
        try {
          await new Promise((resolve, reject) => {
            diagnostic.once('error', reject);
            diagnostic.listen(port, '0.0.0.0', resolve);
          });
        } catch (listenErr) {
          process.stderr.write('[vibe-bootstrap] Could not start diagnostic HTTP listener.\n');
          throw listenErr;
        }
      }
    } finally {
      starting = false;
    }
  }

  await attempt();
  const timer = setInterval(() => {
    if (!monitor && !starting && !stopping) {
      attempt().catch(() => {});
    }
  }, retryIntervalMs);
  timer.unref();

  async function stop() {
    stopping = true;
    clearInterval(timer);
    if (monitor) return monitor.stop();
    if (diagnostic) await new Promise(resolve => diagnostic.close(resolve));
  }
  return { stop, get ready() { return Boolean(monitor); }, get failureCode() { return failureCode; } };
}

if (process.argv[1] && process.argv[1].endsWith('bootstrap.js')) {
  runVibeBootstrap().then(instance => {
    const stop = async () => { await instance.stop(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch(() => process.exit(1));
}
