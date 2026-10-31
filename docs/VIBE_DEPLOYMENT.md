# Nhân Hòa Vibe Hosting — GitHub/Docker deployment

## Scope
This branch runs one **isolated** Monitor application on Vibe Hosting.
It does not alter or redeploy the existing AutoTrade service.

A Vibe deployment is containerized; unlike the VinaHost systemd agent, it
**cannot read the whole Nhân Hòa host's CPU/RAM/disk**. The Vibe dashboard labels
container/process metrics and explicitly shows disk as unavailable. Never
interpret these as full VPS values or use them for host-level capacity alerts.

## Step 1 — Create a NEW application, not the existing AutoTrade application

- Source: `trungtn87/vps-monitor`
- Branch: `deploy/vibe-nhanhoa`
- Build method: Dockerfile in repository root (`Dockerfile`).
- Context/build directory (Root Directory / Build Path): **`.`** (repository root).
- Dockerfile filename (only when there is a separate field): `Dockerfile`.
- **Do not enter `Dockerfile` as Build Path.** Otherwise Dokploy tries to `cd .../code/Dockerfile` and fails because it is a file, not a directory.
- Container internal port: `3000`.
- Start command: built into image (`node src/vibe/bootstrap.js`), no additional build script.
- Node version: 24 via the image.
- Public inbound HTTPS: provided by Vibe Hosting's reverse proxy/domain.
- **Do not publish HTTP port 3000 directly to the Internet**; only expose it
  through Vibe's authenticated HTTPS domain routing. `TRUSTED_PLATFORM_PROXY=true`
  acknowledges this platform boundary; it does not itself create encryption.

## Step 2 — Separate Supabase PostgreSQL

Use `DB_BACKEND=supabase_postgres` and the dedicated project connection string in the Vibe Environment panel. No SQLite/volume fallback. Do not use AutoTrade credentials.

## Step 3 — Environment variables

Copy the variable names from `config/vibe.env.example` into Vibe Hosting's
Environment panel, not into source control.

Required for production:
- `NODE_ENV=production`
- `VIBE_HOSTING=true`, `TRUSTED_PLATFORM_PROXY=true`
- `SERVER_ID=nhanhoa`, `HOST=0.0.0.0`, `PORT=3000`, `REQUIRE_TLS=false`
- `DB_BACKEND=supabase_postgres` + `DATABASE_URL` dedicated to project `gmpgtwtxhjwjeincvkxn`
- Shared Session pooler (IPv4) host `aws-0-ap-southeast-1.pooler.supabase.com:5432` with username `vps_monitor_app.gmpgtwtxhjwjeincvkxn`, as read from this project's Supabase Connect screen.
- Supabase SSL `require`: TLS encryption is mandatory, but the application does not verify the pooler's CA/hostname until a CA bundle is explicitly configured. This matches Supabase's documented `sslmode=require` but is **not** `verify-full`. Do not set `sslmode=disable`. Store only in the Vibe Environment.
- `HEARTBEAT_SECRET` = one unique random secret (>=32 characters), **identical
  on VinaHost**. Do not paste it into tickets or chats.
- `PUBLIC_DASHBOARD=true` permits anonymous **GET-only** access to Dashboard files,
  status, graphs and event history. No `DASHBOARD_PASS` or `API_TOKEN` is required.
  All status data becomes visible to anyone with the URL. Never publish secrets
  or private host IPs in status/event descriptions.
  This option is valid only with `VIBE_HOSTING=true` behind a verified HTTPS proxy.
- `DASHBOARD_PASS`/`API_TOKEN` are optional in public Dashboard mode; the default
  VinaHost/main configuration still requires authentication.
- `PEER_SERVER_ID=vinahost`, `PEER_URL=https://<vinahost-monitor-domain>`
  when VinaHost Dashboard is live on HTTPS. No `:5050` on the public URL.
- `APP_HEALTH_URL=https://<existing-autotrade-public-health-url>` only if
  verified; otherwise leave empty and display DISABLED.

Optional: Discord credentials, actual expiry dates, resource alert thresholds.
Set `DISCORD_WEBHOOK_URL` only when you have verified which instance is
responsible for an alert; otherwise duplicate notifications are possible.

If Vibe does not provide a persistent volume or HTTPS reverse proxy,
**do not try to bypass by enabling public insecure HTTP**.

## Vibe startup diagnostics (when Runtime Logs are unavailable)

The Vibe Docker image starts through `src/vibe/bootstrap.js`. It opens a
small diagnostic HTTP endpoint if production startup fails before the database
is ready. It retries the real Monitor startup every 30 seconds.

- `GET /healthz` returns `200` for *process liveness*, but its JSON reports
  `status: "DEGRADED", ready: false` until the database is connected.
- `GET /readyz` and `GET /api/status` return `503` while degraded.
- `GET /healthz` reports `status: "UP"` after real Monitor startup.
- The error codes contain no passwords or PostgreSQL hostnames.
- On Vibe Hosting use the actual **Session pooler** URI in Supabase
  **VPS-Monitor → Connect → Session pooler (port 5432)**, with
  `vps_monitor_app.gmpgtwtxhjwjeincvkxn` as the pooler username and the
  dedicated role password as its password.
- Do not use the earlier direct URI `db.gmpgtwtxhjwjeincvkxn.supabase.co`
  on an IPv4-only host. The pooler hostname is project-specific and must be
  copied, not computed from the region.

A `DEGRADED` status is **not an operational Monitor**. Do not enable
Discord outage alerts until `/api/status` works, real metrics reach the
Postgres database, and peer heartbeat is verified.

## Step 4 — Build and verify (no SSH)

Build and deploy the NEW application through Vibe's GitHub UI. Open the
generated HTTPS app domain:
- `GET /healthz` should return 200, with status UP.
- Opening `/` should show the read-only Dashboard **without a login prompt**.
- GET `/api/status` should respond 200 without a password; POST is not made public.
- POST `/api/heartbeat` without a valid HMAC signature must be rejected.
- `GET /api/status` after authorization should list two nodes.
- Local Nhân Hòa resource origin must be marked as `CONTAINER`, not `HOST`;
  disk must appear as `N/A`.
- Peer can be `UNKNOWN` until VinaHost is online and configured.
- Rebuild/redeploy once and confirm history remains in Supabase PostgreSQL.
- Verify new rows in Supabase project `VPS-Monitor`, schema `vps_monitor` (not AutoTrade).

If only container metrics are available, that is a platform limitation, not a
VPS failure. To obtain whole-host metrics in the future, obtain an official
host metrics API or a host-level read-only agent.

## Step 5 — Cross-monitoring & alerts

Once both Vibe and VinaHost are reachable over HTTPS:
1. Configure VinaHost `PEER_URL` to the generated HTTPS Vibe monitor URL.
2. Configure matching `HEARTBEAT_SECRET` on both sides.
3. Use 60s heartbeat, 180s disconnect threshold.
4. Check each Dashboard's receipt of partner heartbeat; don't interpret a
   network partition as proof the underlying machine is off.
5. Test loss/recovery via an isolated agent simulation, not by stopping the
   production AutoTrade or 11Ship service.
6. Only then activate Discord alerts and slash commands with allowlists.

The Discord Interaction Endpoint URL is bound to one app endpoint; it does not
automatically fail over to the other node.

## Limits
- No SSH/root access into Nhân Hòa hosting machine.
- No host-level CPU/RAM/disk/uptime from Vibe.
- Monitor relies on a distinct Supabase PostgreSQL project; uptime and Free-plan pausing limits apply.
- No automatic failover/HA or control over the production applications.
- No changes to `main` until PR review.
