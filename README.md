# Tenda Router Monitor

**Real-time, local, per-device bandwidth + security monitoring for Tenda W30E routers.**

A self-hosted dashboard that polls your Tenda W30E v2.0 router every 30 seconds, stores everything in a local SQLite database (zero cloud, zero accounts), and shows you:

- Live and historical traffic for every device on your LAN (hour / day / week / month / year)
- Router CPU, memory, dual-WAN flow, uptime, and connected-device counts
- Automatic new-device alerts, attack-log ingestion (ARP / DDoS spoofing detection), and security heuristics
- Outage history with uptime %, router reboot detection, daily reports, CSV / JSON exports
- A clean, responsive dark UI that works on phone, tablet, and 4K monitors
- Onboarding flow for new installs (asks for router IP + password in the browser)
- Auto-update from GitHub every 2 minutes — push a commit, all instances pull and rebuild without losing data or logs
- Drag-to-reorder dashboard widgets — your layout is persisted per browser

![Dashboard](docs/screenshots/dashboard.png)

---

## Table of contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Installation](#installation)
  - [Linux (Ubuntu / Debian) — recommended](#linux-ubuntu--debian--recommended)
  - [macOS](#macos)
- [First-time setup (onboarding)](#first-time-setup-onboarding)
- [Running as a service](#running-as-a-service)
- [Auto-updates](#auto-updates)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Compatibility](#compatibility)

---

## Features

### Live monitoring
- 30-second polling of `getQosUserList` (per-device down/up speeds + cumulative bytes), `getSystemStatus` (uptime, online count), `getSysInfo` (CPU / RAM / firmware), `getWanFlow` (dual-WAN counters)
- Connection-pooled HTTP keepalive against the router, with automatic re-login on session expiry
- Live speed chart (last 60 min, refreshes every 10 s), router-uptime tracker, top-talker widget
- Router telemetry card: CPU %, memory %, firmware version, model, dual-WAN bytes + speeds

### Historical analytics
- Restart-aware bandwidth accounting — survives router reboots and counter rollovers
- 5-min → hourly → daily → monthly rollups with deduplication; pruning of stale fine-grained samples after 90 days
- Per-device detail page with hour / today / week / month / year / all-time views
- Daily report grid showing every device × every day for the last 7 – 90 days
- Network-wide heatmap of activity by hour and day-of-week

### Security
- Router system log (`sysLogType=2`) ingested every 2 min — ARP / DDoS attack detections per attacker MAC
- Optional UDP syslog receiver (port 5140) for full router audit logs
- Built-in security heuristics: high concurrent-connection count, sustained high upload, hostname clones, out-of-subnet IPs, randomized-MAC clusters
- 24-hour cooldown on dismissed alerts so the same rule + MAC doesn't re-spawn the same banner

### Operations
- Outage detection (router unreachable → recorded with start / end / reason) and 30-day uptime %
- New-device alerts with bulk *mark all known* / *dismiss all*
- Telegram notifications (optional) via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
- CSV / JSON exports (consumption, daily, attacks, syslog, outages)
- Settings page lets you edit router host / password live without restarting the daemon

### UI / UX
- Dark, professional theme with Tailwind CSS, Recharts, lucide-react icons
- **Fully responsive**: hamburger drawer on phone / tablet (<1280 px), horizontal nav on desktop, mobile-first card layouts for every table
- **Drag-to-reorder widgets**: click "Edit layout" on the dashboard, drag widgets into the order you want, layout is saved in `localStorage`
- PWA manifest (installable on iOS / Android home screen)
- Update banner on the dashboard when a new commit lands on `origin/main`

---

## Screenshots

| | |
|---|---|
| ![Dashboard](docs/screenshots/dashboard.png) **Dashboard** — Live speed, top talkers, traffic categories, alerts | ![Consumption](docs/screenshots/consumption.png) **Consumption** — Today / week / month / year / all-time per device |
| ![Report](docs/screenshots/report.png) **Daily report** — Each device × each day grid | ![Analytics](docs/screenshots/analytics.png) **Analytics** — Heatmap, concurrent devices, anomalies |
| ![Security](docs/screenshots/security.png) **Security** — Detection rules + router syslog | ![Attacks](docs/screenshots/attacks.png) **Attacks** — ARP / DDoS log from router |
| ![Alerts](docs/screenshots/alerts.png) **Alerts** — New devices, outages, reboots, security | ![Outages](docs/screenshots/outages.png) **Outages** — Reboot history + uptime % |
| ![Map](docs/screenshots/map.png) **Network map** — Live SVG topology | ![Devices](docs/screenshots/devices.png) **Devices** — Full device inventory |
| ![Settings](docs/screenshots/settings.png) **Settings** — Edit credentials live | ![Setup](docs/screenshots/setup.png) **Onboarding** — First-time setup |

---

## Installation

### Linux (Ubuntu / Debian) — recommended

A single installer script handles Node + pnpm + build + systemd services. Run on the machine that will host the monitor (must be on the same LAN as the router):

```bash
git clone https://github.com/egphp/router_app.git ~/router_app
cd ~/router_app
bash deploy/install-linux.sh
```

The installer:

1. Installs Node 22 (from NodeSource) + build-essential + python3
2. Enables corepack and activates the latest pnpm
3. Runs `pnpm install` + `pnpm build` for all workspace packages
4. Copies `.env.example` → `.env` (with `ROUTER_PASSWORD=` blank — onboarding will fill it in)
5. Installs three user systemd units:
   - `tenda-poller.service` — the background daemon
   - `tenda-web.service` — Next.js on port 3030
   - `tenda-auto-update.timer` — fires `tenda-auto-update.service` every 2 minutes
6. Enables `loginctl enable-linger` so the services run even when no user is logged in
7. Prints the URL to open

When it finishes, open `http://<your-server-ip>:3030/` in any browser on your LAN.

### macOS

```bash
git clone https://github.com/egphp/router_app.git ~/router_app
cd ~/router_app
bash deploy/install.sh
```

This installs three launchd plists (`com.tenda.monitor.{poller,web,syslog-relay}`) in `~/Library/LaunchAgents/` and starts them.

---

## First-time setup (onboarding)

If `.env` is missing `ROUTER_PASSWORD`, **every page on the dashboard redirects to `/setup`**. The setup page asks for:

- Router IP (default `192.168.0.1`)
- Router admin password

Both are validated against the live router before being persisted to `.env` on the local machine. The password is never sent off-host and never persisted to the SQLite database.

![Setup page](docs/screenshots/setup.png)

After saving, the poller picks up the credentials automatically (a 3-second watcher in `packages/poller/src/index.ts` notices the env change and starts the sampler) and you're redirected to the dashboard.

---

## Running as a service

### Linux

```bash
# Check status
systemctl --user status tenda-poller tenda-web tenda-auto-update.timer

# Restart after manual config changes
systemctl --user restart tenda-poller tenda-web

# View logs
tail -f ~/router_app/logs/{poller,web,auto-update}.log
journalctl --user -u tenda-poller -f
```

### macOS

```bash
launchctl list | grep tenda
tail -f ~/Library/Logs/tenda-monitor/{poller,web}.{log,error.log}
```

Both platforms run the services as the invoking user (not root), with `Restart=always` semantics so they survive crashes and reboots.

---

## Auto-updates

Every 2 minutes, `deploy/auto-update.sh` runs via systemd timer (`tenda-auto-update.timer`). It:

1. `git fetch origin main` (silent if up to date)
2. If `origin/main` ≠ local `HEAD`:
   1. Snapshots `.env`, `tenda.db`, `tenda.db-shm`, `tenda.db-wal` to `/tmp`
   2. `git reset --hard origin/main`
   3. Restores snapshots if needed (paranoid — `.env` and `*.db*` are gitignored so `reset` shouldn't touch them)
   4. `pnpm install --frozen-lockfile=false`
   5. `pnpm -r build`
   6. Re-installs systemd units in case any of them changed
   7. `systemctl --user restart tenda-poller tenda-web`
3. Logs every step to `~/router_app/logs/auto-update.log`

The dashboard shows an *Update available* banner (`/api/version`) the moment `origin/main` advances. Within 2 minutes, the update applies itself — **no manual intervention, no data loss, no log loss**.

Disable auto-update if you want manual control:

```bash
systemctl --user disable --now tenda-auto-update.timer
```

---

## Architecture

```
                    ┌──────────────┐
                    │  Tenda W30E  │
                    │ 192.168.x.1  │
                    └──────┬───────┘
                           │ HTTP (every 30 s)
                           ▼
       ┌─────────────────────────────────────────┐
       │  poller (Node, packages/poller)         │
       │   • sampler → 5-min snapshots           │
       │   • accumulator → bytes per device      │
       │   • rollups (5min→hr→day→month)         │
       │   • outage monitor + reboot detection   │
       │   • security scanner (heuristics)       │
       │   • system-log puller (attack log)      │
       │   • syslog UDP server (port 5140)       │
       │   • control HTTP server (port 3031)     │
       └──────────────┬──────────────────────────┘
                      │ SQLite (WAL mode)
                      ▼
       ┌─────────────────────────────────────────┐
       │  tenda.db                               │
       │   devices, samples_5min, hourly_*,      │
       │   daily_*, monthly_*, alerts, outages,  │
       │   attack_log, router_state, syslog      │
       └──────────────┬──────────────────────────┘
                      │ better-sqlite3 (read-only from web)
                      ▼
       ┌─────────────────────────────────────────┐
       │  Next.js web (apps/web, port 3030)      │
       │   • /, /devices, /consumption, /report  │
       │   • /analytics, /security, /attacks     │
       │   • /alerts, /outages, /export, /map    │
       │   • /settings, /setup (onboarding)      │
       │   • /api/* (status, telemetry, etc.)    │
       │   • Middleware → /setup if not config'd │
       └──────────────┬──────────────────────────┘
                      │ HTTP (browser)
                      ▼
                  ┌───────┐
                  │  You  │
                  └───────┘
```

- **Two processes**, deliberately decoupled: the poller owns writes; the web app reads. Crashing one doesn't take the other down.
- **All data local** — SQLite file on disk. No external services required.
- **Restart-aware** — every reboot of the router is detected (uptime regression) and the accumulator resets cleanly.

---

## Configuration

`.env` (created automatically on first install from `.env.example`):

```bash
ROUTER_HOST=192.168.0.1           # router IP
ROUTER_PASSWORD=                  # blank → onboarding UI prompts you
DB_PATH=./tenda.db                # SQLite file (relative to repo root)
POLL_INTERVAL_MS=30000            # 30 seconds
WEB_PORT=3030                     # Next.js port
IPC_SOCKET=/tmp/tenda-monitor.sock
LOG_LEVEL=info
SYSLOG_PORT=5140                  # UDP port the router forwards syslog to

# Optional Telegram alerts
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

Edit `.env` directly **or** use the Settings page in the dashboard — both work. Settings writes back to `.env` via the control-server API and hot-swaps credentials in the running poller (no restart needed).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Dashboard says *Offline* | Poller can't reach the router. Check `~/router_app/logs/poller.err`. Most common: wrong password, wrong IP, or router web UI is disabled. |
| Stuck on `/setup` after entering credentials | The credentials didn't validate against the router. Check the error banner under the form. |
| `address already in use :::3030` | Another process holds port 3030: `lsof -iTCP:3030 -sTCP:LISTEN`. Stop it or change `WEB_PORT`. |
| No syslog entries on the Security page | Enable Log Audit on the router (Log Settings + Log Storage = Local, Host IP = this machine). On macOS the router sends to 514 → forward to 5140 with `sudo bash deploy/syslog-redirect.sh`. |
| Auto-update reports `fetch failed` | Network was down at that tick. The next 2-minute tick retries. |
| Attack log empty | The router doesn't always populate it. Check `http://<router>/index.html?v=5042#sysmanage/sysLog` directly. |
| Dashboard layout looks wrong after update | Click "Edit layout" → "Reset" to restore the default order. |

---

## Compatibility

- **Tenda W30E v2.0** — fully tested. Other Tenda models (W30, W18E, AC18, etc.) that share the `/goform/module` JSON API likely work; firmware-specific field names (e.g. `cpuUsePercent`, `FlowDownstream`) may need parser updates.
- **Node 22+** (poller uses native ES modules + `node:` imports)
- **Linux**: Ubuntu 22.04 / 24.04, Debian 12+, anything with systemd ≥ 252
- **macOS**: 13+ (Ventura) with launchd

---

## License

MIT. See [LICENSE](LICENSE) if present, otherwise treat as MIT.

## Acknowledgements

Built by reverse-engineering the Tenda W30E web UI's XHR calls. Cross-referenced with a separate PHP-based monitor on the same network to confirm field names (`getWanFlow`, `getSysInfo`).
