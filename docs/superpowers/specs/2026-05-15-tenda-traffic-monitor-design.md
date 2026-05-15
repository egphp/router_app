# Tenda W30E Traffic Monitor — Design Spec

**Date:** 2026-05-15
**Owner:** michael.tawfikk@gmail.com
**Target device:** Tenda W30E V2.0 @ `192.168.0.1`
**Host:** macOS (Mac Studio @ 192.168.0.7) initially → portable to Linux

---

## 1. Problem Statement

The Tenda W30E web UI shows per-device bandwidth but:
- All counters reset on router reboot/restart, so historical totals are lost.
- No history at all — only the current uptime window.
- New devices joining the network are silent (no alert).
- Per-hour / per-day / per-week / per-month / per-year breakdowns do not exist.
- The UI is paginated across 4 pages; no consolidated view.

We need a local monitoring service that **continuously samples** the router via its HTTP API, **persists** the data, computes **restart-aware cumulative totals**, and exposes a **professional dashboard** with alerts.

## 2. Confirmed Discovery (Router API)

Probed live against the router and verified the following:

### Authentication
- `POST /goform/module?auth&` with body `{"auth":{"password":"<b64>","time":"<localtime>"}}`.
- Password encoding: `btoa(utf8(plaintext))` — plain Base64 of UTF-8 bytes.
- Success response: `{"auth":0}`. Cookie `sessionid` is set on response.
- The router **supports multiple concurrent sessions** — daemon and browser do not interfere (verified: old `sessionid=W30EV2.0:0.7.5:b8d454` still worked after fresh login produced `:0.7.6:e60cc5`).

### Device list (the core endpoint)
- `POST /goform/module?getQosUserList&getQosPolicy&` body `{"getQosUserList":{"type":1},"getQosPolicy":""}`.
- Returns full list of online + offline devices in one shot (36 in our case). No pagination needed.

Per-device fields (online):
| Field | Type | Notes |
|---|---|---|
| `ID` | int | Router-internal device id. **Resets on reboot.** Not a stable key. |
| `hostIP` | string | Current IP |
| `hostMAC` | string | **Use as primary identity key.** Stable across reboots. |
| `hostName` | string | Router-reported name (e.g. `iPhone`, `Mac`, `espressif`) |
| `hostRemark` | string | User-given label on router (e.g. `mac Studio`) |
| `hostUploadSpeed` | int | B/s instantaneous |
| `hostDownloadSpeed` | int | B/s instantaneous |
| `hostConnectCount` | int | Concurrent sessions |
| `hostDownloadSum` | int | **KB** cumulative — resets on router reboot. Authoritative download counter. |
| `hostConnectType` | int | 3=wifi, 4=ethernet (inferred) |
| `hostUploadLimit`, `hostDownloadLimit` | int | KB/s limits (0 = unlimited) |
| `onlineTime` | int | seconds online since session start |
| `hostOnlineStatus` | 0/1 | online flag |

Per-device offline records also include `hostOffLineTime` (formatted timestamp).

### Critical gap — no upload total

**`hostUploadSum` does not exist** in any tested endpoint. Tried `getTracfficStat`, `getHostsList`, `getDeviceList`, `getOnlineList`, `getUserList`, `getStatistics`, `getTrafficInfo`, `getHostInfo` (all return `-1` or empty). The router only exposes `hostUploadSpeed`.

**Implication:** download totals are router-counted and exact (recoverable from a single missed poll via delta). **Upload totals must be integrated by us from speed samples** — `Σ(avg(prev_speed, current_speed) × Δt)` — and have a different accuracy profile. The UI must label upload totals as **`(estimated)`**.

### System status
- `POST /goform/module?getSystemStatus&` returns `{runTime: "25d7h2m24s", onlineHostCount, onlineAPCount}` — used as our **reboot detector**.

## 3. Architecture

**Process topology: two processes** (chosen over monolithic):

```
┌─────────────────────┐    HTTP 30s     ┌──────────────────────┐
│  packages/poller    │ ───────────────▶│  Tenda W30E Router   │
│  Node.js daemon     │◀── login + auth │  192.168.0.1         │
│  launchd-managed    │                 └──────────────────────┘
└──────────┬──────────┘
           │ writes
           ▼
   ┌───────────────┐
   │   SQLite WAL  │
   │   tenda.db    │
   └───────────────┘
           ▲
           │ reads + occasional writes
           │
┌──────────┴──────────┐
│  apps/web (Next.js) │ — dashboard, charts, alerts UI
└─────────────────────┘
```

The poller and the web app share the SQLite file. SQLite is opened in WAL mode so concurrent reads (Next.js) do not block writes (poller). The poller emits `samples-updated` notifications to the web app via a Unix socket (or polling fallback) so the dashboard can push live updates over SSE.

### Repo layout (pnpm workspace)

```
tenda_traffic/
├─ pnpm-workspace.yaml
├─ package.json
├─ .env                      # ROUTER_HOST, ROUTER_PASSWORD, DB_PATH (gitignored)
├─ .env.example
├─ tenda.db                  # SQLite (gitignored)
├─ packages/
│  ├─ shared/                # types, db client, OUI lookup, time utils
│  │  ├─ src/db.ts
│  │  ├─ src/types.ts
│  │  ├─ src/oui.ts
│  │  └─ src/migrations/*.sql
│  └─ poller/                # daemon
│     ├─ src/index.ts
│     ├─ src/router-client.ts
│     ├─ src/sampler.ts
│     ├─ src/accumulator.ts
│     ├─ src/rollup.ts
│     ├─ src/outage.ts
│     └─ src/ipc.ts          # unix socket → web
└─ apps/
   └─ web/                   # Next.js 15 (App Router)
      ├─ app/
      │  ├─ page.tsx                  # dashboard
      │  ├─ devices/page.tsx          # device list
      │  ├─ devices/[mac]/page.tsx    # device detail
      │  ├─ alerts/page.tsx
      │  ├─ outages/page.tsx
      │  ├─ settings/page.tsx
      │  └─ api/
      │     ├─ devices/route.ts
      │     ├─ devices/[mac]/route.ts
      │     ├─ stream/route.ts        # SSE
      │     └─ alerts/dismiss/route.ts
      ├─ components/                  # shadcn/ui + custom charts
      └─ lib/                         # client helpers
```

## 4. Data Model (SQLite)

```sql
-- 4.1 Devices: identity (MAC = primary key)
CREATE TABLE devices (
  mac           TEXT PRIMARY KEY,
  router_id     INTEGER,                    -- router's ID (changes on reboot)
  hostname      TEXT,                       -- router-reported
  router_remark TEXT,                       -- router's user-given label
  custom_label  TEXT,                       -- our label (overrides hostname)
  vendor        TEXT,                       -- OUI lookup
  category      TEXT,                       -- 'phone'|'computer'|'iot'|'tv'|'unknown'
  first_seen    INTEGER NOT NULL,           -- ms epoch
  last_seen     INTEGER NOT NULL,
  is_new        INTEGER DEFAULT 1,          -- 1 until user dismisses
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 4.2 Raw samples: 30s snapshots, kept 48h
CREATE TABLE samples_raw (
  mac            TEXT NOT NULL,
  ts             INTEGER NOT NULL,          -- ms epoch
  ip             TEXT,
  online         INTEGER NOT NULL,
  up_speed_bps   INTEGER NOT NULL,          -- B/s
  down_speed_bps INTEGER NOT NULL,          -- B/s
  down_sum_kb    INTEGER NOT NULL,          -- raw router cumulative (KB)
  sessions       INTEGER,
  online_seconds INTEGER,
  PRIMARY KEY (mac, ts)
);
CREATE INDEX idx_samples_ts ON samples_raw(ts);

-- 4.3 Rollup tables (same shape, different bucket size)
CREATE TABLE traffic_5min (
  mac          TEXT NOT NULL,
  bucket_ts    INTEGER NOT NULL,            -- start of 5-min window
  bytes_down   INTEGER NOT NULL DEFAULT 0,
  bytes_up     INTEGER NOT NULL DEFAULT 0,
  avg_down_bps INTEGER,
  avg_up_bps   INTEGER,
  peak_down_bps INTEGER,
  peak_up_bps  INTEGER,
  active_sec   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mac, bucket_ts)
);
CREATE TABLE traffic_hour  (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER, bytes_up INTEGER, active_sec INTEGER, PRIMARY KEY (mac, bucket_ts));
CREATE TABLE traffic_day   (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER, bytes_up INTEGER, active_sec INTEGER, PRIMARY KEY (mac, bucket_ts));
CREATE TABLE traffic_month (mac TEXT, bucket_ts INTEGER, bytes_down INTEGER, bytes_up INTEGER, active_sec INTEGER, PRIMARY KEY (mac, bucket_ts));

-- 4.4 Router state (for reboot detection)
CREATE TABLE router_state (
  ts             INTEGER PRIMARY KEY,
  uptime_sec     INTEGER NOT NULL,
  is_reboot      INTEGER NOT NULL DEFAULT 0,
  online_count   INTEGER
);

-- 4.5 Outages: when daemon couldn't reach router
CREATE TABLE outages (
  started_at  INTEGER PRIMARY KEY,
  ended_at    INTEGER,
  reason      TEXT,                          -- 'unreachable'|'auth_fail'|'router_reboot'
  notes       TEXT
);

-- 4.6 Alerts: queued events the user hasn't acknowledged
CREATE TABLE alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                 -- 'new_device'|'outage'|'reboot'
  mac         TEXT,                          -- nullable
  payload     TEXT,                          -- JSON
  created_at  INTEGER NOT NULL,
  dismissed_at INTEGER
);
```

Retention policy:
- `samples_raw` — 48 h, then dropped.
- `traffic_5min` — 14 days.
- `traffic_hour` — 90 days.
- `traffic_day` — 2 years.
- `traffic_month` — forever.
- Vacuum job nightly at 03:00 local.

## 5. Polling + Accumulator Logic

### 5.1 Cycle (every 30 s)

```
1. systemStatus  = router.POST(getSystemStatus)
   uptime_sec    = parseUptime(systemStatus.runTime)
   is_reboot     = uptime_sec < last_seen_uptime
   record router_state row

2. qos = router.POST(getQosUserList type=1)
   if request failed:
       outage handler (5.3)
       return
   if was in outage: close outage(now)

3. for each device entry in qos.getQosUserList:
       upsert devices(mac) — if new MAC: insert alert(kind='new_device') + flag is_new=1
       update devices.last_seen = now
       insert samples_raw row

       prev = samples_raw last row for this mac before now
       Δt = (now - prev.ts)/1000  seconds  (or 30 if no prev)

       // Download: trust router counter, except on reboot
       if not prev or is_reboot:
           Δdown_bytes = down_sum_kb * 1024     // start from current as fresh baseline
       else:
           raw_delta_kb = down_sum_kb - prev.down_sum_kb
           if raw_delta_kb < 0:
               // counter rolled back without an uptime regression — treat as reboot edge
               Δdown_bytes = down_sum_kb * 1024
           else:
               Δdown_bytes = raw_delta_kb * 1024

       // Upload: integrated from speed samples
       Δup_bytes = ((prev.up_speed_bps + up_speed_bps) / 2) * Δt

       // Add to current 5-min bucket
       bucket = floor(now / 5min) * 5min
       UPSERT traffic_5min(mac, bucket) SET
           bytes_down += Δdown_bytes,
           bytes_up   += Δup_bytes,
           active_sec += (online ? Δt : 0),
           peak_down_bps = MAX(peak_down_bps, down_speed_bps),
           peak_up_bps   = MAX(peak_up_bps, up_speed_bps),
           avg_*  recomputed as running averages

4. emit IPC notification to web ('samples-updated')
```

### 5.2 Rollup jobs

- Every 5 min on the `:00` mark: roll completed 5-min windows into `traffic_5min` (already in place).
- Every hour on the `:01` mark: sum `traffic_5min` of previous hour → `traffic_hour`. Drop `samples_raw` older than 48 h.
- Every day at `00:05`: sum `traffic_hour` → `traffic_day`. Drop `traffic_5min` older than 14 d.
- Every month on day 1, `00:10`: sum `traffic_day` → `traffic_month`. Drop `traffic_hour` older than 90 d.

### 5.3 Outage handling

- If 3 consecutive polls fail (≥ 90 s without a successful sample): open `outages` row with `reason='unreachable'`, push `alerts(kind='outage')`, web shows a red banner.
- If `auth` POST returns non-zero: `reason='auth_fail'`.
- If `is_reboot=true` detected: insert `outages` row with both `started_at` and `ended_at` ≈ same time, `reason='router_reboot'`, and a `kind='reboot'` alert.
- On first successful poll after an outage: set `ended_at`.
- Uptime % = `1 - Σ(outage_duration) / total_runtime`.

## 6. UI / Pages

Built with Next.js 15 App Router, shadcn/ui, Tailwind, `recharts` for charts. Bilingual-aware (English UI, Arabic-friendly labels via i18n later).

### 6.1 `/` — Live Dashboard

- **Top bar:** "Tenda Monitor", connection indicator (green/red dot), refresh icon, alerts bell with red badge count, settings cog.
- **Stat cards (4 across):**
  - Router status (uptime, online/total devices, WAN flow up/down).
  - Today's totals (↓ X GB, ↑ Y GB est).
  - Top device today (name, % share, total).
  - Active alerts (count by kind).
- **Live speed chart** (last 60 min, 30 s tick) — area chart, download blue, upload orange, with WAN1/WAN2/All toggle.
- **Device table** — 36 rows, virtualized; columns: status dot (online=green/offline=gray/new=red), name+vendor, IP, ↓ speed, ↑ speed, today total, all-time total, action menu.
- Real-time updates over SSE (`/api/stream`).

### 6.2 `/devices` — Full device list

- Filter by online/offline/new, search (name/IP/MAC), sort by total or speed.
- Bulk operations: dismiss "is_new" flag, label devices.

### 6.3 `/devices/[mac]` — Per-device detail

- Header: name, vendor, IP, MAC, online status, label editor.
- Time-range tabs: **Hour · Today · Week · Month · Year · All-time**.
- Stacked bar chart of bytes per bucket for the chosen range (e.g. for "Week" → 7 day-buckets; for "Today" → 24 hour-buckets).
- Line chart of avg/peak speed across the range.
- Stat block: total ↓, total ↑ (estimated), online %, peak speed @ timestamp, session count.
- Section: "Sessions" — list of online/offline transitions (computed from `samples_raw` + `last_seen`).

### 6.4 `/alerts`

- List of `alerts` rows. "New device" cards with [Mark known / Block (future)] actions. Outage entries with duration.

### 6.5 `/outages`

- Table of all outage entries with start, end, duration, reason. Uptime % over the last 30 days shown at the top.

### 6.6 `/settings`

- Router host + password (env-backed, read-only in UI for now; writable later).
- Polling interval (default 30 s).
- Retention overrides.
- Sound toggle for new-device alerts.

## 7. Alerts

| Kind | Trigger | Display |
|---|---|---|
| `new_device` | First time a MAC is observed | Red badge in topbar, red row in device list, browser Notification, optional beep |
| `outage` | 3 failed polls | Red banner across dashboard until recovery |
| `reboot` | `is_reboot` detected | Small toast + entry in `/outages` |

User can dismiss any alert; dismissal sets `dismissed_at` and removes from top-bar count.

## 8. Auth / Security

- Router password lives **only** in `.env` (gitignored). Loaded into the poller process. Never written to the DB. Never sent to the browser.
- The web app does not need to know the router password. It only talks to the local DB + IPC socket.
- Web app binds to `localhost` only by default; LAN exposure requires explicit env flag.

## 9. Deployment

### 9.1 macOS (current host)

- `~/Library/LaunchAgents/com.tenda.monitor.poller.plist` runs `node <repo>/packages/poller/dist/index.js` at login, `KeepAlive=true`, `RunAtLoad=true`.
- Next.js: `pnpm --filter web build && pnpm --filter web start` (port 3030) — also managed by a separate launchd plist.
- Logs to `~/Library/Logs/tenda-monitor/{poller,web}.log`.

### 9.2 Migration to Linux

- Copy repo + `.env` + `tenda.db`.
- Install Node 22+, `pnpm install`, `pnpm build`.
- Use `pm2` instead of launchd: `pm2 start ecosystem.config.js`.
- Adjust `ROUTER_HOST` if router IP differs.

## 10. Out of scope (for v1)

- PWA install + Web Push notifications (deferred — user asked for "later").
- Per-device throttling / blocking via router API.
- Mobile-native app.
- Multi-router support.
- Historical export (CSV/JSON) — easy to add later.

## 11. Success criteria

1. Daemon runs 24/7 on Mac Studio, survives reboot, recovers from network blips, auto-re-logins.
2. Dashboard at `http://localhost:3030` shows all 36 devices, live speeds, accurate totals across hour/day/week/month/year/all-time.
3. Reboot the router intentionally → totals continue without dropping previously-counted bytes; an outage entry appears.
4. Plug in a brand-new device → red alert appears within 30 s.
5. Spec doc + repo can be copied to a Linux box and run with the same data.
