# Tenda Monitor

Local 24/7 bandwidth + traffic monitoring for the Tenda W30E router. Polls the router's HTTP API every 30 seconds, persists per-device snapshots in SQLite, computes restart-aware cumulative totals (download from router counter, upload integrated from speed), and serves a professional dashboard with per-hour / day / week / month / year breakdowns and new-device alerts.

## Layout

```
tenda_traffic/
├── apps/web/          Next.js 15 dashboard (port 3030)
├── packages/poller/   Background daemon — samples + accumulates + rollups
├── packages/shared/   SQLite client, migrations, types, OUI lookup, time utils
├── deploy/            launchd plists + install/uninstall scripts
├── docs/              Design spec + screenshots
├── .env.example       Configuration template
└── tenda.db           SQLite database (created at runtime)
```

## Quick start

1. Copy `.env.example` to `.env` and set `ROUTER_PASSWORD`:
   ```bash
   cp .env.example .env
   # edit ROUTER_HOST, ROUTER_PASSWORD
   ```

2. Install + build:
   ```bash
   pnpm install
   pnpm build
   ```

3. Migrate the DB:
   ```bash
   pnpm migrate
   ```

4. Either run in foreground for dev:
   ```bash
   pnpm dev:poller   # in one terminal
   pnpm dev:web      # in another terminal
   ```

   Or install as background services on macOS (auto-start at login, restart on crash):
   ```bash
   bash deploy/install.sh
   ```

5. Open <http://localhost:3030>.

## Features

- **Per-device totals** for hour, day, week, month, year, all-time. Download is exact (router-counted); upload is integrated from instantaneous speed samples (labelled "est").
- **Restart-aware**: detects router reboots via `runTime` regression. Previously-counted bytes are preserved.
- **Outage tracking**: 3 consecutive failed polls open an outage entry. Uptime % computed over last 30 days.
- **New-device alerts**: any new MAC triggers a red NEW badge, a red row in the device table, and a row in /alerts.
- **Live speed chart**: last 60 minutes, 30-second granularity.
- **Per-device drilldown**: traffic-by-bucket bar chart, peak-speed line chart, editable label / category / notes.

## How the math works

Each device row from `getQosUserList` has:
- `hostDownloadSum` (KB cumulative since the last router reboot) — **router-counted**, exact.
- `hostDownloadSpeed`, `hostUploadSpeed` (B/s instantaneous).
- `hostMAC` — our **identity key** (stable across reboots; the `ID` field is not).

Every 30 s:
1. Fetch `getSystemStatus` → `uptime_sec`. If it dropped below the last seen value, **router rebooted**.
2. Fetch the device list.
3. For each device, write a `samples_raw` row.
4. **Download delta**: `(down_sum_kb_now - down_sum_kb_prev) * 1024`. If reboot detected or counter went backwards, take `down_sum_kb_now * 1024`. First sample for a brand-new MAC contributes 0 (we don't import historical pre-watch traffic).
5. **Upload delta**: `((prev_up_speed + now_up_speed) / 2) * Δt` (trapezoidal integration).
6. Add both deltas to the current 5-minute bucket (`traffic_5min`).

Rollups (run every 5 min):
- 5-min buckets older than the current hour → `traffic_hour`.
- Hour buckets older than today → `traffic_day`.
- Day buckets older than this month → `traffic_month`.

Retention:
- `samples_raw`: 48 h
- `traffic_5min`: 14 days
- `traffic_hour`: 90 days
- `traffic_day`: 2 years
- `traffic_month`: forever

## Files of interest

- `packages/poller/src/router-client.ts` — the Tenda HTTP client (login via base64-of-utf8 password, auto re-auth on 401).
- `packages/poller/src/accumulator.ts` — the delta / integration logic.
- `packages/poller/src/sampler.ts` — the polling loop + rollup scheduler.
- `packages/poller/src/outage.ts` — outage and reboot detection.
- `apps/web/lib/queries.ts` — all DB queries used by the dashboard.
- `apps/web/components/Dashboard.tsx` — main dashboard layout.
- `apps/web/components/DeviceDetailClient.tsx` — per-device detail page.
- `docs/superpowers/specs/2026-05-15-tenda-traffic-monitor-design.md` — the full design spec.

## Migration to another host (e.g. Linux server)

1. Copy the repo + `tenda.db` + `.env` over.
2. Install Node ≥ 22, run `pnpm install && pnpm build`.
3. Set `ROUTER_HOST` if the router IP changes.
4. Use `pm2 start` (or a systemd unit) instead of `launchd`.

The DB and the code are platform-agnostic. The only Mac-specific piece is `deploy/com.tenda.monitor.{poller,web}.plist`.

## Manage launchd services (macOS)

```bash
# stop
launchctl unload ~/Library/LaunchAgents/com.tenda.monitor.poller.plist
launchctl unload ~/Library/LaunchAgents/com.tenda.monitor.web.plist

# start
launchctl load -w ~/Library/LaunchAgents/com.tenda.monitor.poller.plist
launchctl load -w ~/Library/LaunchAgents/com.tenda.monitor.web.plist

# logs
tail -f ~/Library/Logs/tenda-monitor/poller.log
tail -f ~/Library/Logs/tenda-monitor/web.log

# remove
bash deploy/uninstall.sh
```
