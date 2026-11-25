import { NextResponse } from 'next/server';
import {
  DAY,
  MIN,
  computeProactiveQuotaForecast,
  getDb,
  getNotificationTypes,
  getThresholdConfig,
  isNotificationType,
  loadConfig,
  normalizePeriod,
  setNotificationEnabled,
  suppressAlertFuture,
  updateThresholdConfig,
} from '@tenda/shared';
import { db } from '../../../../../lib/db';
import { mbpsToKbs } from '../../../../../lib/control-format';
import { getIosV2Auth, onIosV2Revoke, type IosV2AuthService } from '../../../../../lib/ios-v2-auth';
import {
  dismissAlert,
  dismissAlertsByKind,
  dismissAllAlerts,
  getAlerts,
  getAttackLog,
  getAttackStats,
  getCategoryBreakdown,
  getConsumption,
  getDailyReport,
  getDevice,
  getDeviceAttacks,
  getDeviceDailyUsage,
  getDeviceIpHistory,
  getDeviceSessions,
  getDeviceStats,
  getDeviceTraffic,
  getLatestDevices,
  getNetworkControlSummary,
  getOutages,
  getRecentSpeedSeries,
  getRouterSnapshot,
  getWanConsumptionSummary,
  markAllDevicesKnown,
  updateDevice,
  type Bucket,
  type DeviceRow,
} from '../../../../../lib/queries';
import {
  clientRateLimitScope,
  hasSmuggledInternalHeaders,
  logSecurityEvent,
  sha256Hex,
  verifyAuthenticatedSession,
  verifySameOriginRequest,
} from '../../../../../lib/remote-auth';
import {
  getRouterLiveSnapshot,
  getRouterSysInfo,
  mergeRouterLiveDevice,
  mergeRouterLiveDevices,
  rebootRouterDirect,
  setRouterGuestWifiDirect,
} from '../../../../../lib/router-live';
import { ensureWebMigrations } from '../../../../../lib/web-migrations';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAC_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;
const APNS_TOKEN_RE = /^[0-9a-f]{64,200}$/i;
const MAX_SPEED_LIMIT_KBS = 128_000;
const VALID_RANGES: ReadonlySet<Bucket> = new Set(['hour', 'today', 'week', 'month', 'year', 'all']);

function controlBase(): string {
  return `http://127.0.0.1:${process.env.CONTROL_PORT ?? 3031}`;
}

function jsonWithDate(body: unknown, status = 200): NextResponse {
  const res = NextResponse.json(body, { status });
  res.headers.set('Date', new Date().toUTCString());
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

// Lightweight sliding-window limiter for unauthenticated challenge requests
const challengeHits = new Map<string, number[]>();
function isChallengeRateLimited(scope: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const maxPerMin = 60;
  const hits = (challengeHits.get(scope) ?? []).filter((ts) => now - ts < windowMs);
  if (hits.length >= maxPerMin) {
    challengeHits.set(scope, hits);
    return true;
  }
  hits.push(now);
  challengeHits.set(scope, hits);
  if (challengeHits.size > 1000) {
    for (const [k, arr] of challengeHits) {
      if (arr.every((ts) => now - ts >= windowMs)) challengeHits.delete(k);
    }
  }
  return false;
}

function parseJsonBody(raw: Buffer): Record<string, unknown> | null {
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readBlockedMacSet(): Set<string> {
  const blocked = new Set<string>();
  try {
    const rows = db()
      .prepare(`SELECT key FROM kv WHERE key LIKE 'ios.blocked.%'`)
      .all() as Array<{ key: string }>;
    for (const r of rows) {
      const mac = r.key.slice('ios.blocked.'.length).toUpperCase();
      if (MAC_RE.test(mac)) blocked.add(mac);
    }
  } catch {
    // ignore if kv table absent
  }
  return blocked;
}

function computeBlockedState(
  mac: string,
  dlKbs: number,
  ulKbs: number,
  blockedMacs: Set<string>,
): { is_blocked: boolean; is_limited: boolean } {
  const isBlocked =
    (dlKbs === 1 && ulKbs === 1) ||
    (blockedMacs.has(mac.toUpperCase()) && (dlKbs === 1 || ulKbs === 1));
  const isLimited = !isBlocked && (dlKbs > 0 || ulKbs > 0);
  return { is_blocked: isBlocked, is_limited: isLimited };
}

function formatDeviceForNative(d: DeviceRow, blockedMacs: Set<string>) {
  const label = d.custom_label || d.router_remark || d.hostname || d.mac;
  const dlKbs = Number(d.download_limit_kbs ?? 0);
  const ulKbs = Number(d.upload_limit_kbs ?? 0);
  const { is_blocked, is_limited } = computeBlockedState(d.mac, dlKbs, ulKbs, blockedMacs);
  return {
    mac: d.mac,
    label,
    hostname: d.hostname,
    custom_label: d.custom_label,
    router_remark: d.router_remark,
    vendor: d.vendor,
    category: d.category,
    ip: d.ip,
    online: d.online === 1,
    is_new: d.is_new === 1,
    down_speed_bps: Number(d.down_speed_bps ?? 0),
    up_speed_bps: Number(d.up_speed_bps ?? 0),
    bytes_today: Number(d.bytes_today ?? 0),
    bytes_up_today: Number(d.bytes_up_today ?? 0),
    bytes_total: Number(d.bytes_total ?? 0),
    bytes_up_total: Number(d.bytes_up_total ?? 0),
    download_limit_kbs: dlKbs,
    upload_limit_kbs: ulKbs,
    is_blocked,
    is_limited,
    qos_known: d.qos_known === 1,
    reserved: d.reserved === 1,
    reserved_ip: d.reserved_ip,
    wan_port: d.wan_port,
    wan_group_name: d.wan_group_name,
    connect_type: d.connect_type,
    connection_kind: d.connection_kind,
    wifi_band: d.wifi_band,
    wifi_rssi_dbm: d.wifi_rssi_dbm,
    wifi_signal_percent: d.wifi_signal_percent,
    wifi_distance_m: d.wifi_distance_m,
    last_online_at: d.last_online_at,
    last_seen: d.last_seen,
    first_seen: d.first_seen,
    auto_qos_state: d.auto_qos_state,
    os_guess: d.os_guess ?? null,
    device_type: d.device_type ?? null,
    ai_trust_tier: d.ai_trust_tier ?? null,
    ai_rationale_ar: d.ai_rationale_ar ?? null,
  };
}

function disableNativeV2ApnsTokens(devId?: string): void {
  try {
    ensureWebMigrations();
    const now = Date.now();
    if (devId) {
      getDb()
        .prepare(`UPDATE apns_devices SET disabled_at = ?, updated_at = ? WHERE credential_id = ? AND disabled_at IS NULL`)
        .run(now, now, `ios-v2:${devId}`);
      return;
    }
    getDb()
      .prepare(`UPDATE apns_devices SET disabled_at = ?, updated_at = ? WHERE credential_id LIKE 'ios-v2:%' AND disabled_at IS NULL`)
      .run(now, now);
  } catch {
    // Non-fatal
  }
}

const globalRevokeHook = globalThis as unknown as { __tendaNativeV2ApnsRevokeHook?: boolean };
if (!globalRevokeHook.__tendaNativeV2ApnsRevokeHook) {
  globalRevokeHook.__tendaNativeV2ApnsRevokeHook = true;
  onIosV2Revoke((devId) => {
    disableNativeV2ApnsTokens(devId);
  });
}

function hydrateDeviceTotals(device: DeviceRow): DeviceRow {
  const stats = getDeviceStats(device.mac);
  const todayPoints = getDeviceTraffic(device.mac, 'today');
  let todayDown = 0;
  let todayUp = 0;
  for (const pt of todayPoints) {
    todayDown += Number(pt.bytes_down ?? 0);
    todayUp += Number(pt.bytes_up ?? 0);
  }
  return {
    ...device,
    bytes_today: todayDown,
    bytes_up_today: todayUp,
    bytes_total: Number(stats.bytes_down ?? 0),
    bytes_up_total: Number(stats.bytes_up ?? 0),
  };
}

function readNsfwOverview() {
  const conn = getDb();
  const enabledRow = conn
    .prepare(`SELECT value FROM settings WHERE key = 'nsfw_detection'`)
    .get() as { value: string } | undefined;
  const enabled = enabledRow ? enabledRow.value !== 'off' : true;
  const dayAgo = Date.now() - 24 * 3600 * 1000;

  let recent = { cnt: 0, devices: 0 };
  let topDomains: Array<{ domain: string; category: string; hits: number; last_ts: number }> = [];
  let byDevice: Array<{ source_mac: string; source_ip: string | null; hits: number; last_ts: number; label: string }> = [];

  try {
    recent = conn
      .prepare(`SELECT COUNT(*) as cnt, COUNT(DISTINCT source_mac) as devices FROM nsfw_hits WHERE ts > ?`)
      .get(dayAgo) as { cnt: number; devices: number };
    topDomains = conn
      .prepare(
        `SELECT domain, category, COUNT(*) as hits, MAX(ts) as last_ts
         FROM nsfw_hits WHERE ts > ? GROUP BY domain ORDER BY hits DESC LIMIT 15`,
      )
      .all(dayAgo) as typeof topDomains;
    byDevice = conn
      .prepare(
        `SELECT nh.source_mac, nh.source_ip, COUNT(*) as hits, MAX(nh.ts) as last_ts,
                COALESCE(d.custom_label, d.hostname, d.router_remark, nh.source_mac) AS label
         FROM nsfw_hits nh
         LEFT JOIN devices d ON d.mac = nh.source_mac
         WHERE nh.ts > ? AND nh.source_mac IS NOT NULL
         GROUP BY nh.source_mac ORDER BY hits DESC LIMIT 15`,
      )
      .all(dayAgo) as typeof byDevice;
  } catch {
    // nsfw_hits table empty or unavailable
  }

  return {
    enabled,
    last_24h: { hits: Number(recent?.cnt ?? 0), devices: Number(recent?.devices ?? 0) },
    top_domains: topDomains,
    by_device: byDevice,
  };
}

function computeUptimeStats(outages: Array<{ started_at: number; ended_at: number | null; duration_sec: number | null }>) {
  const now = Date.now();
  const startOfDay = (() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const since7d = now - 7 * DAY;
  const since30d = now - 30 * DAY;

  let outagesToday = 0;
  let downtime7dMs = 0;
  let downtime30dMs = 0;

  for (const o of outages) {
    const s = Number(o.started_at ?? 0);
    const e = o.ended_at ? Number(o.ended_at) : now;
    if (s >= startOfDay) outagesToday += 1;

    const overlap7 = Math.max(0, Math.min(e, now) - Math.max(s, since7d));
    const overlap30 = Math.max(0, Math.min(e, now) - Math.max(s, since30d));
    downtime7dMs += overlap7;
    downtime30dMs += overlap30;
  }

  const pct7 = Math.max(0, Math.min(100, Number((((7 * DAY - downtime7dMs) / (7 * DAY)) * 100).toFixed(2))));
  const pct30 = Math.max(0, Math.min(100, Number((((30 * DAY - downtime30dMs) / (30 * DAY)) * 100).toFixed(2))));

  return {
    outages_today: outagesToday,
    uptime_pct_7d: pct7,
    uptime_pct_30d: pct30,
    total_downtime_sec_30d: Math.round(downtime30dMs / 1000),
  };
}

function buildDailyTotalsFromReport(days: number) {
  const report = getDailyReport(days);
  const dailyMap = new Map<number, { day_ts: number; bytes_down: number; bytes_up: number }>();
  for (const ts of report.days) {
    dailyMap.set(ts, { day_ts: ts, bytes_down: 0, bytes_up: 0 });
  }
  for (const dev of report.devices) {
    for (const pt of dev.daily) {
      const cur = dailyMap.get(pt.day_ts) ?? { day_ts: pt.day_ts, bytes_down: 0, bytes_up: 0 };
      cur.bytes_down += Number(pt.bytes_down ?? 0);
      cur.bytes_up += Number(pt.bytes_up ?? 0);
      dailyMap.set(pt.day_ts, cur);
    }
  }
  return {
    report,
    daily: [...dailyMap.values()].sort((a, b) => a.day_ts - b.day_ts),
  };
}

function formatGb(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

async function handleRoute(
  req: Request,
  slugParts: string[],
  authOverride?: IosV2AuthService,
): Promise<NextResponse> {
  if (hasSmuggledInternalHeaders(req)) {
    logSecurityEvent({
      eventType: 'bypass_attempt_blocked',
      ipHash: clientRateLimitScope(req),
      detail: 'Blocked smuggled internal header on /api/native/v2',
    });
    return jsonWithDate({ ok: false, error: 'forbidden_header' }, 403);
  }

  const auth = authOverride ?? getIosV2Auth();
  const method = req.method.toUpperCase();
  const routeKey = slugParts.join('/');
  const url = new URL(req.url);
  const rawPath = url.pathname;
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : '';
  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await req.arrayBuffer());

  // ── 1. Pairing Open (strictly web passkey session + Same-Origin CSRF) ───────────────────────
  if (routeKey === 'pair/open') {
    if (method !== 'POST') return jsonWithDate({ ok: false, error: 'method_not_allowed' }, 405);
    if (!verifySameOriginRequest(req)) {
      return jsonWithDate({ ok: false, error: 'cross_origin_blocked' }, 403);
    }
    const session = verifyAuthenticatedSession(req);
    if (!session) {
      return jsonWithDate({ ok: false, error: 'biometric_passkey_required' }, 401);
    }
    const result = auth.pairOpen(`passkey:${session.credentialId.slice(0, 12)}`);
    logSecurityEvent({
      eventType: 'ios_v2_pair_open',
      rpId: session.rpId,
      credentialId: session.credentialId,
      ipHash: clientRateLimitScope(req),
      detail: `Opened 10-min iOS v2 pairing code (replacing=${result.replacing})`,
    });
    return jsonWithDate(result, 200);
  }

  // ── 2. Device Status (signed v2 device OR web passkey session) ──────────────────────────────
  if (routeKey === 'device-status') {
    if (method !== 'GET') return jsonWithDate({ ok: false, error: 'method_not_allowed' }, 405);
    if (req.headers.has('x-dev-sig')) {
      const check = auth.verifySignedRequest({ method, path: rawPath, query: rawQuery, headers: req.headers, body: rawBody });
      if (!check.ok) return jsonWithDate({ ok: false, error: check.error }, check.status);
      return jsonWithDate(auth.status(), 200);
    }
    const session = verifyAuthenticatedSession(req);
    if (!session) {
      return jsonWithDate({ ok: false, error: 'biometric_passkey_required' }, 401);
    }
    return jsonWithDate(auth.status(), 200);
  }

  // ── 3. Device Reset (signed v2 device OR web passkey session + Same-Origin) ─────────────────
  if (routeKey === 'device-reset') {
    if (method !== 'POST') return jsonWithDate({ ok: false, error: 'method_not_allowed' }, 405);
    const body = parseJsonBody(rawBody) ?? {};
    const reason = typeof body.reason === 'string' ? body.reason : 'reset requested';

    if (req.headers.has('x-dev-sig')) {
      const check = auth.verifySignedRequest({ method, path: rawPath, query: rawQuery, headers: req.headers, body: rawBody });
      if (!check.ok) return jsonWithDate({ ok: false, error: check.error }, check.status);
      const res = auth.reset({ actor: `ios:${check.devId.slice(0, 12)}`, reason });
      disableNativeV2ApnsTokens();
      logSecurityEvent({
        eventType: 'ios_v2_device_reset',
        ipHash: clientRateLimitScope(req),
        detail: `iOS device reset by native client (${check.devId.slice(0, 12)})`,
      });
      return jsonWithDate(res, 200);
    }

    if (!verifySameOriginRequest(req)) {
      return jsonWithDate({ ok: false, error: 'cross_origin_blocked' }, 403);
    }
    const session = verifyAuthenticatedSession(req);
    if (!session) {
      return jsonWithDate({ ok: false, error: 'biometric_passkey_required' }, 401);
    }
    const res = auth.reset({ actor: `passkey:${session.credentialId.slice(0, 12)}`, reason });
    disableNativeV2ApnsTokens();
    logSecurityEvent({
      eventType: 'ios_v2_device_reset',
      rpId: session.rpId,
      credentialId: session.credentialId,
      ipHash: clientRateLimitScope(req),
      detail: `iOS device unbound from web settings panel (hadDevice=${res.hadDevice})`,
    });
    return jsonWithDate(res, 200);
  }

  // ── 4. Unauthenticated v2 Auth Ceremonies (protected by K_bio / code / rate-limit) ──────────
  if (routeKey === 'session/challenge') {
    if (method !== 'POST') return jsonWithDate({ ok: false, error: 'method_not_allowed' }, 405);
    if (isChallengeRateLimited(clientRateLimitScope(req))) {
      return jsonWithDate({ ok: false, error: 'rate_limited' }, 429);
    }
    const body = parseJsonBody(rawBody);
    if (!body) return jsonWithDate({ ok: false, error: 'invalid_request' }, 400);
    const out = auth.sessionChallenge(body.dev_id);
    if (!out.ok) return jsonWithDate({ ok: false, error: out.error }, out.status);
    return jsonWithDate(out, 200);
  }

  if (routeKey === 'pair/complete') {
    if (method !== 'POST') return jsonWithDate({ ok: false, error: 'method_not_allowed' }, 405);
    const body = parseJsonBody(rawBody);
    if (!body) return jsonWithDate({ ok: false, error: 'invalid_request' }, 400);
    const out = auth.pairComplete(body);
    if (!out.ok) {
      logSecurityEvent({
        eventType: 'ios_v2_pair_failed',
        ipHash: clientRateLimitScope(req),
        detail: `iOS v2 pair/complete failed: ${out.error}`,
      });
      return jsonWithDate({ ok: false, error: out.error }, out.status);
    }
    logSecurityEvent({
      eventType: 'ios_v2_pair_complete',
      ipHash: clientRateLimitScope(req),
      detail: `Bound iOS device ${out.deviceId.slice(0, 12)}`,
    });
    return jsonWithDate(out, 200);
  }

  if (routeKey === 'session/refresh') {
    if (method !== 'POST') return jsonWithDate({ ok: false, error: 'method_not_allowed' }, 405);
    const body = parseJsonBody(rawBody);
    if (!body) return jsonWithDate({ ok: false, error: 'invalid_request' }, 400);
    const out = auth.sessionRefresh(body);
    if (!out.ok) return jsonWithDate({ ok: false, error: out.error }, out.status);
    return jsonWithDate(out, 200);
  }

  if (routeKey === 'release') {
    if (method !== 'POST') return jsonWithDate({ ok: false, error: 'method_not_allowed' }, 405);
    const body = parseJsonBody(rawBody);
    if (!body) return jsonWithDate({ ok: false, error: 'invalid_request' }, 400);
    const out = auth.release(body);
    if (!out.ok) return jsonWithDate({ ok: false, error: out.error }, out.status);
    disableNativeV2ApnsTokens();
    logSecurityEvent({
      eventType: 'ios_v2_release',
      ipHash: clientRateLimitScope(req),
      detail: 'iOS device released via K_bio biometric signature',
    });
    return jsonWithDate(out, 200);
  }

  // ── 5. Every remaining native operator route MUST carry a valid v2 signed request ───────────
  const verified = auth.verifySignedRequest({
    method,
    path: rawPath,
    query: rawQuery,
    headers: req.headers,
    body: rawBody,
  });
  if (!verified.ok) {
    return jsonWithDate({ ok: false, error: verified.error }, verified.status);
  }

  ensureWebMigrations();

  // ── GET /bootstrap ──────────────────────────────────────────────────────────────────────────
  if (routeKey === 'bootstrap' && method === 'GET') {
    const snap = getRouterSnapshot();
    const series = getRecentSpeedSeries(60);
    const live = await getRouterLiveSnapshot().catch(() => null);
    const netCtrl = getNetworkControlSummary();
    const blockedMacs = readBlockedMacSet();
    const allDevices = mergeRouterLiveDevices(getLatestDevices(), live).map((d) =>
      formatDeviceForNative(d, blockedMacs),
    );
    const outages = getOutages(200) as Array<{ started_at: number; ended_at: number | null; duration_sec: number | null }>;
    const uptimeStats = computeUptimeStats(outages);
    const quota = computeProactiveQuotaForecast(db());
    const alerts = getAlerts(50) as Array<{
      id: number;
      kind: string;
      mac: string | null;
      payload: string | null;
      created_at: number;
      dismissed_at: number | null;
      device_label: string | null;
    }>;
    const recentAlerts = alerts.filter((a) => !a.dismissed_at).slice(0, 6);
    const attackEntries = getAttackLog({ limit: 20, logType: 2 });
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const activeAttacks24h = attackEntries.filter((a) => Number(a.ts) >= dayAgo).length;

    const since = Date.now() - 60 * MIN;
    const speeds = live
      ? [
          ...series.speeds.filter((p) => p.ts >= since && p.ts < live.ts - 500),
          { ts: live.ts, down_bps: live.best_down_bps, up_bps: live.best_up_bps },
        ]
      : series.speeds;

    const lastPt = speeds[speeds.length - 1];
    const currentDownBps = live ? live.best_down_bps : Number(lastPt?.down_bps ?? 0);
    const currentUpBps = live ? live.best_up_bps : Number(lastPt?.up_bps ?? 0);
    const connected = Boolean(live || (snap.last_sample_ts && Date.now() - snap.last_sample_ts < 2 * MIN));
    const topHogs = [...allDevices]
      .sort((a, b) => (b.bytes_today + b.bytes_up_today) - (a.bytes_today + a.bytes_up_today))
      .slice(0, 5);

    const cfg = loadConfig();

    return jsonWithDate({
      ok: true,
      ts: Date.now(),
      device_id: verified.devId,
      router: {
        connected,
        host: cfg.routerHost,
        source: live ? (live.has_active_wan ? 'wan' : 'router-direct') : series.source,
        uptime_sec: snap.uptime_sec,
        last_sample_ts: live?.ts ?? snap.last_sample_ts,
        wan_ports: netCtrl.wan_ports,
      },
      throughput: {
        down_bps: currentDownBps,
        up_bps: currentUpBps,
        wan_down_bps: live?.wan_down_bps ?? currentDownBps,
        wan_up_bps: live?.wan_up_bps ?? currentUpBps,
        all_devices_down_bps: live?.all_devices_down_bps ?? currentDownBps,
        all_devices_up_bps: live?.all_devices_up_bps ?? currentUpBps,
        bytes_today_down: snap.bytes_today_down,
        bytes_today_up: snap.bytes_today_up,
        wan_today_down: snap.wan_today_down,
        wan_today_up: snap.wan_today_up,
        speeds: speeds.slice(-48),
      },
      counts: {
        online: allDevices.length > 0 ? allDevices.filter((d) => d.online).length : snap.online_count,
        total_devices: allDevices.length > 0 ? allDevices.length : snap.total_devices,
        blocked: allDevices.filter((d) => d.is_blocked).length,
        limited: allDevices.filter((d) => d.is_limited).length,
        alerts_undismissed: snap.alerts_undismissed,
        outages_today: uptimeStats.outages_today,
        active_attacks_24h: activeAttacks24h,
      },
      quota: {
        used_bytes: quota.networkUsedTotalBytes,
        used_down_bytes: quota.networkUsedDownBytes,
        used_up_bytes: quota.networkUsedUpBytes,
        combined_quota_bytes: quota.combinedQuotaBytes,
        weighted_daily_burn_bytes: quota.weightedDailyBurnBytes,
        projected_cycle_bytes: quota.projectedCycleTotalBytes,
        days_elapsed: quota.daysElapsed,
        days_remaining_in_cycle: quota.daysRemainingInCycle,
        days_until_exhaustion: quota.daysUntilCombinedExhaustion,
        will_exhaust_before_renewal: quota.willExhaustBeforeRenewal,
        renewal_day: quota.renewalDay,
        summary_ar: quota.summaryAr,
      },
      top_hogs: topHogs,
      recent_alerts: recentAlerts,
      recent_attacks: attackEntries.slice(0, 5),
    });
  }

  // ── GET /devices ────────────────────────────────────────────────────────────────────────────
  if (routeKey === 'devices' && method === 'GET') {
    const live = await getRouterLiveSnapshot().catch(() => null);
    const blockedMacs = readBlockedMacSet();
    const devices = mergeRouterLiveDevices(getLatestDevices(), live).map((d) =>
      formatDeviceForNative(d, blockedMacs),
    );
    const netCtrl = getNetworkControlSummary();
    return jsonWithDate({
      ok: true,
      live_ts: live?.ts ?? null,
      wan_ports: netCtrl.wan_ports,
      devices,
    });
  }

  // ── POST /devices/control ───────────────────────────────────────────────────────────────────
  if (routeKey === 'devices/control' && method === 'POST') {
    const body = parseJsonBody(rawBody);
    if (!body) return jsonWithDate({ ok: false, error: 'invalid_json' }, 400);

    const rawMac = typeof body.mac === 'string' ? body.mac.trim().toUpperCase() : '';
    if (!MAC_RE.test(rawMac)) {
      return jsonWithDate({ ok: false, error: 'invalid_mac' }, 400);
    }

    const device = getDevice(rawMac) as DeviceRow | undefined;
    if (!device) {
      return jsonWithDate({ ok: false, error: 'device_not_found' }, 404);
    }

    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';
    const conn = db();

    if (action === 'rename') {
      const cleanStr = (v: unknown, max: number): string | null | undefined => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        if (typeof v !== 'string') return undefined;
        const trimmed = v.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
        return trimmed.length > 0 ? trimmed : null;
      };
      updateDevice(rawMac, {
        custom_label: cleanStr(body.custom_label ?? body.label, 120),
        category: cleanStr(body.category, 48),
        notes: cleanStr(body.notes, 1000),
      });
      const updated = getDevice(rawMac) as DeviceRow | undefined;
      return jsonWithDate({
        ok: true,
        action,
        device: updated ? formatDeviceForNative(hydrateDeviceTotals(updated), readBlockedMacSet()) : null,
      });
    }

    if (action === 'mark_known') {
      updateDevice(rawMac, { is_new: 0 });
      conn.prepare(`UPDATE alerts SET dismissed_at = ? WHERE kind = 'new_device' AND mac = ? AND dismissed_at IS NULL`).run(Date.now(), rawMac);
      const updated = getDevice(rawMac) as DeviceRow | undefined;
      return jsonWithDate({
        ok: true,
        action,
        device: updated ? formatDeviceForNative(hydrateDeviceTotals(updated), readBlockedMacSet()) : null,
      });
    }

    const targetIp = (device.ip || device.reserved_ip || '').trim();
    const labelHint = device.custom_label || device.router_remark || device.hostname || null;
    const pollerPayload: Record<string, unknown> = { mac: rawMac };

    if (action === 'block') {
      pollerPayload.downloadLimitKBs = 1;
      pollerPayload.uploadLimitKBs = 1;
    } else if (action === 'unblock') {
      pollerPayload.downloadLimitKBs = 0;
      pollerPayload.uploadLimitKBs = 0;
    } else if (action === 'speed_limit' || body.download_limit_kbs !== undefined || body.download_mbps !== undefined) {
      let dlKbs = Number(device.download_limit_kbs ?? 0);
      let ulKbs = Number(device.upload_limit_kbs ?? 0);
      if (body.download_mbps !== undefined) {
        dlKbs = mbpsToKbs(Number(body.download_mbps));
      } else if (body.download_limit_kbs !== undefined) {
        dlKbs = Math.round(Number(body.download_limit_kbs));
      }
      if (body.upload_mbps !== undefined) {
        ulKbs = mbpsToKbs(Number(body.upload_mbps));
      } else if (body.upload_limit_kbs !== undefined) {
        ulKbs = Math.round(Number(body.upload_limit_kbs));
      } else if (body.download_mbps !== undefined) {
        // Default upload cap to ~40% of download cap (or 0 if unlimited)
        ulKbs = dlKbs === 0 ? 0 : Math.max(64, Math.round(dlKbs * 0.4));
      }
      if (
        !Number.isFinite(dlKbs) || dlKbs < 0 || dlKbs > MAX_SPEED_LIMIT_KBS ||
        !Number.isFinite(ulKbs) || ulKbs < 0 || ulKbs > MAX_SPEED_LIMIT_KBS
      ) {
        return jsonWithDate({ ok: false, error: 'invalid_speed_limit' }, 400);
      }
      pollerPayload.downloadLimitKBs = dlKbs;
      pollerPayload.uploadLimitKBs = ulKbs;
    } else if (action === 'wan_bind') {
      if (typeof body.wan_port !== 'string' || !body.wan_port.trim()) {
        return jsonWithDate({ ok: false, error: 'invalid_wan_port' }, 400);
      }
      if (!targetIp) {
        return jsonWithDate({ ok: false, error: 'missing_device_ip' }, 400);
      }
      pollerPayload.ip = targetIp;
      pollerPayload.wanPort = body.wan_port.trim();
      pollerPayload.labelHint = labelHint;
      if (typeof body.wan_group_name === 'string' && body.wan_group_name.trim()) {
        pollerPayload.wanGroupName = body.wan_group_name.trim().slice(0, 32);
      }
    } else if (action === 'dhcp_reserve') {
      if (typeof body.dhcp_reserved !== 'boolean') {
        return jsonWithDate({ ok: false, error: 'dhcp_reserved_required' }, 400);
      }
      pollerPayload.dhcpReserved = body.dhcp_reserved;
      if (body.dhcp_reserved) {
        if (!targetIp) return jsonWithDate({ ok: false, error: 'missing_device_ip' }, 400);
        pollerPayload.ip = targetIp;
        pollerPayload.labelHint = labelHint;
      }
    } else {
      return jsonWithDate({ ok: false, error: 'unknown_control_action' }, 400);
    }

    try {
      const resp = await fetch(`${controlBase()}/device-control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pollerPayload),
        signal: AbortSignal.timeout(10_000),
      });
      const result = (await resp.json().catch(() => ({ ok: false, error: 'Invalid response from control daemon' }))) as {
        ok?: boolean;
        code?: string;
        error?: string;
        qos?: unknown;
        wan?: unknown;
        dhcp?: unknown;
      };
      if (!resp.ok || !result.ok) {
        return jsonWithDate(
          { ok: false, code: result.code ?? 'CONTROL_FAILED', error: result.error ?? 'Failed to apply device control' },
          resp.status >= 400 && resp.status < 600 ? resp.status : 502,
        );
      }

      if (action === 'block') {
        conn
          .prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(
            `ios.blocked.${rawMac}`,
            JSON.stringify({
              blockedAt: Date.now(),
              prevDownKbs: Number(device.download_limit_kbs ?? 0),
              prevUpKbs: Number(device.upload_limit_kbs ?? 0),
            }),
          );
      } else if (action === 'unblock' || action === 'speed_limit') {
        conn.prepare(`DELETE FROM kv WHERE key = ?`).run(`ios.blocked.${rawMac}`);
      }

      const updated = getDevice(rawMac) as DeviceRow | undefined;
      return jsonWithDate({
        ok: true,
        action,
        qos: result.qos ?? null,
        wan: result.wan ?? null,
        dhcp: result.dhcp ?? null,
        device: updated ? formatDeviceForNative(hydrateDeviceTotals(updated), readBlockedMacSet()) : null,
      });
    } catch (err) {
      return jsonWithDate({ ok: false, error: `poller_unreachable: ${String(err)}` }, 502);
    }
  }

  // ── GET /devices/:mac ───────────────────────────────────────────────────────────────────────
  if (slugParts.length === 2 && slugParts[0] === 'devices' && method === 'GET') {
    let rawSegment = slugParts[1]!;
    try {
      rawSegment = decodeURIComponent(rawSegment);
    } catch {
      return jsonWithDate({ ok: false, error: 'invalid_mac' }, 400);
    }
    const macUp = rawSegment.trim().toUpperCase().replace(/-/g, ':');
    if (!MAC_RE.test(macUp)) {
      return jsonWithDate({ ok: false, error: 'invalid_mac' }, 400);
    }
    const rawRange = (url.searchParams.get('range') ?? 'today') as Bucket;
    const range: Bucket = VALID_RANGES.has(rawRange) ? rawRange : 'today';

    const device = getDevice(macUp) as DeviceRow | undefined;
    if (!device) {
      return jsonWithDate({ ok: false, error: 'device_not_found' }, 404);
    }

    const live = await getRouterLiveSnapshot().catch(() => null);
    const merged = hydrateDeviceTotals(mergeRouterLiveDevice(device, live));
    const blockedMacs = readBlockedMacSet();
    const stats = getDeviceStats(macUp);
    const traffic = getDeviceTraffic(macUp, range);
    const dailyUsage = getDeviceDailyUsage(macUp, 30);
    const sessions = getDeviceSessions(macUp, 30);
    const attacks = getDeviceAttacks(macUp);
    const ipHistory = getDeviceIpHistory(macUp, 20);

    return jsonWithDate({
      ok: true,
      device: formatDeviceForNative(merged, blockedMacs),
      stats,
      range,
      traffic,
      daily_usage: dailyUsage,
      sessions,
      attacks,
      ip_history: ipHistory,
    });
  }

  // ── GET /alerts ─────────────────────────────────────────────────────────────────────────────
  if (routeKey === 'alerts' && method === 'GET') {
    const alerts = getAlerts(200) as Array<{ dismissed_at: number | null }>;
    const undismissed = alerts.filter((a) => !a.dismissed_at).length;
    return jsonWithDate({
      ok: true,
      undismissed_count: undismissed,
      alerts,
    });
  }

  // ── POST /alerts/ack ────────────────────────────────────────────────────────────────────────
  if (routeKey === 'alerts/ack' && method === 'POST') {
    const body = parseJsonBody(rawBody);
    if (!body) return jsonWithDate({ ok: false, error: 'invalid_json' }, 400);

    if (body.action === 'ignore_future' && typeof body.id === 'number') {
      const result = suppressAlertFuture(getDb(), body.id);
      if (!result.ok) return jsonWithDate({ ok: false, error: result.error }, 400);
      return jsonWithDate(result, 200);
    }
    if (typeof body.id === 'number') {
      dismissAlert(body.id);
      return jsonWithDate({ ok: true, id: body.id });
    }
    if (body.action === 'dismiss_all') {
      const r = dismissAllAlerts();
      return jsonWithDate({ ok: true, changes: r.changes });
    }
    if (body.action === 'mark_all_known') {
      const r1 = markAllDevicesKnown();
      const r2 = dismissAlertsByKind('new_device');
      return jsonWithDate({ ok: true, devices: r1.changes, alerts: r2.changes });
    }
    if (body.action === 'dismiss_by_kind' && typeof body.kind === 'string') {
      const r = dismissAlertsByKind(body.kind);
      return jsonWithDate({ ok: true, changes: r.changes });
    }
    return jsonWithDate({ ok: false, error: 'invalid_alert_ack' }, 400);
  }

  // ── GET /security ───────────────────────────────────────────────────────────────────────────
  if (routeKey === 'security' && method === 'GET') {
    const attackEntries = getAttackLog({ limit: 150, logType: 2 });
    const attackStats = getAttackStats();
    const nsfw = readNsfwOverview();
    const alerts = getAlerts(100);
    return jsonWithDate({
      ok: true,
      attacks: {
        entries: attackEntries,
        stats: attackStats,
      },
      nsfw,
      alerts,
    });
  }

  // ── POST /security/nsfw ─────────────────────────────────────────────────────────────────────
  if (routeKey === 'security/nsfw' && method === 'POST') {
    const body = parseJsonBody(rawBody);
    if (!body || typeof body.enabled !== 'boolean') {
      return jsonWithDate({ ok: false, error: 'enabled_boolean_required' }, 400);
    }
    getDb()
      .prepare(`INSERT INTO settings (key, value) VALUES ('nsfw_detection', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(body.enabled ? 'on' : 'off');
    return jsonWithDate({ ok: true, enabled: body.enabled });
  }

  // ── GET /consumption ────────────────────────────────────────────────────────────────────────
  if (routeKey === 'consumption' && method === 'GET') {
    const rawDevices = getConsumption();
    const internetDevices = rawDevices.filter((d) => !d.is_local_infra);
    const devices = (internetDevices.length > 0 ? internetDevices : rawDevices)
      .slice()
      .sort((a, b) => (b.month_down + b.month_up) - (a.month_down + a.month_up));
    const wanTotals = getWanConsumptionSummary();
    const quota = computeProactiveQuotaForecast(db());
    const { daily: daily30 } = buildDailyTotalsFromReport(30);
    const daily7 = daily30.slice(-7);
    const categories = getCategoryBreakdown('month');

    return jsonWithDate({
      ok: true,
      wan_totals: wanTotals,
      quota: {
        used_bytes: quota.networkUsedTotalBytes,
        combined_quota_bytes: quota.combinedQuotaBytes,
        weighted_daily_burn_bytes: quota.weightedDailyBurnBytes,
        projected_cycle_bytes: quota.projectedCycleTotalBytes,
        days_elapsed: quota.daysElapsed,
        days_remaining_in_cycle: quota.daysRemainingInCycle,
        days_until_exhaustion: quota.daysUntilCombinedExhaustion,
        will_exhaust_before_renewal: quota.willExhaustBeforeRenewal,
        renewal_day: quota.renewalDay,
        summary_ar: quota.summaryAr,
      },
      daily_7d: daily7,
      daily_30d: daily30,
      categories,
      devices,
    });
  }

  // ── GET /outages ────────────────────────────────────────────────────────────────────────────
  if (routeKey === 'outages' && method === 'GET') {
    const rawOutages = getOutages(200) as Array<{
      started_at: number;
      ended_at: number | null;
      reason: string | null;
      notes?: string | null;
    }>;
    const outages = rawOutages.map((o) => ({
      started_at: Number(o.started_at),
      ended_at: o.ended_at ? Number(o.ended_at) : null,
      duration_sec: o.ended_at ? Math.max(0, Math.round((Number(o.ended_at) - Number(o.started_at)) / 1000)) : null,
      reason: o.reason ?? 'unknown',
      notes: o.notes ?? null,
    }));
    const snap = getRouterSnapshot();
    const stats = computeUptimeStats(outages);
    return jsonWithDate({
      ok: true,
      current_uptime_sec: snap.uptime_sec,
      ...stats,
      outages,
    });
  }

  // ── GET /map ────────────────────────────────────────────────────────────────────────────────
  if (routeKey === 'map' && method === 'GET') {
    const live = await getRouterLiveSnapshot().catch(() => null);
    const blockedMacs = readBlockedMacSet();
    const devices = mergeRouterLiveDevices(getLatestDevices(), live).map((d) =>
      formatDeviceForNative(d, blockedMacs),
    );
    const netCtrl = getNetworkControlSummary();
    const snap = getRouterSnapshot();
    const attackStats = getAttackStats();
    const cfg = loadConfig();

    const groups = {
      wired: devices.filter((d) => d.online && !d.is_blocked && (d.connect_type === 2 || d.connection_kind === 'wired')),
      wifi_5g: devices.filter((d) => d.online && !d.is_blocked && (d.connect_type === 4 || d.wifi_band === '5GHz')),
      wifi_24g: devices.filter(
        (d) =>
          d.online &&
          !d.is_blocked &&
          d.connect_type !== 2 &&
          d.connection_kind !== 'wired' &&
          d.connect_type !== 4 &&
          d.wifi_band !== '5GHz',
      ),
      blocked: devices.filter((d) => d.is_blocked),
      offline: devices.filter((d) => !d.online && !d.is_blocked),
    };

    return jsonWithDate({
      ok: true,
      router: {
        host: cfg.routerHost,
        connected: Boolean(live || (snap.last_sample_ts && Date.now() - snap.last_sample_ts < 2 * MIN)),
        uptime_sec: snap.uptime_sec,
        wan_ports: netCtrl.wan_ports,
      },
      groups,
      top_attackers: attackStats.topAttackers,
      devices,
    });
  }

  // ── GET /report ─────────────────────────────────────────────────────────────────────────────
  if (routeKey === 'report' && method === 'GET') {
    const rawDays = Number(url.searchParams.get('days') ?? '7');
    const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(90, Math.floor(rawDays))) : 7;
    const { report, daily } = buildDailyTotalsFromReport(days);
    const totalDown = daily.reduce((s, d) => s + d.bytes_down, 0);
    const totalUp = daily.reduce((s, d) => s + d.bytes_up, 0);
    const totalBytes = totalDown + totalUp;
    const avgDailyBytes = Math.round(totalBytes / Math.max(1, daily.length));
    const peakDay = [...daily].sort((a, b) => (b.bytes_down + b.bytes_up) - (a.bytes_down + a.bytes_up))[0] ?? null;

    const since = Date.now() - days * DAY;
    const outages = (getOutages(200) as Array<{ started_at: number }>).filter((o) => Number(o.started_at) >= since);
    const attacks = getAttackLog({ limit: 500, logType: 2 }).filter((a) => Number(a.ts) >= since);
    const topDevices = report.devices.slice(0, 8).map((d) => ({
      mac: d.mac,
      label: d.label,
      category: d.category,
      total_down: d.total_down,
      total_up: d.total_up,
      total_bytes: d.total_down + d.total_up,
    }));

    const shareLines = [
      `تقرير شبكة تندا (آخر ${days} أيام)`,
      `إجمالي الاستهلاك: ${formatGb(totalBytes)} (تحميل ${formatGb(totalDown)} · رفع ${formatGb(totalUp)})`,
      `المتوسط اليومي: ${formatGb(avgDailyBytes)}`,
      `الانقطاعات: ${outages.length} · الهجمات المحجوبة: ${attacks.length}`,
      topDevices.length > 0
        ? `أعلى الأجهزة: ${topDevices.slice(0, 3).map((d) => `${d.label} (${formatGb(d.total_bytes)})`).join('، ')}`
        : '',
    ].filter(Boolean);

    return jsonWithDate({
      ok: true,
      days,
      generated_at: Date.now(),
      summary: {
        total_down: totalDown,
        total_up: totalUp,
        total_bytes: totalBytes,
        avg_daily_bytes: avgDailyBytes,
        peak_day: peakDay,
        outages_count: outages.length,
        attacks_count: attacks.length,
      },
      daily,
      top_devices: topDevices,
      share_text_ar: shareLines.join('\n'),
    });
  }

  // ── GET / POST /settings ────────────────────────────────────────────────────────────────────
  if (routeKey === 'settings') {
    if (method === 'GET') {
      const cfg = loadConfig();
      const snap = getRouterSnapshot();
      const netCtrl = getNetworkControlSummary();
      const sysInfo = await getRouterSysInfo().catch(() => null);
      let daemonRunning = false;
      try {
        const r = await fetch(`${controlBase()}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          const j = (await r.json()) as { ok?: boolean };
          daemonRunning = Boolean(j?.ok);
        }
      } catch {
        // daemon unreachable
      }

      const conn = getDb();
      const nsfwRow = conn.prepare(`SELECT value FROM settings WHERE key = 'nsfw_detection'`).get() as { value: string } | undefined;

      return jsonWithDate({
        ok: true,
        router: {
          host: cfg.routerHost,
          model: sysInfo?.model ?? 'Tenda W30E',
          firmware: sysInfo?.firmware ?? null,
          cpu_percent: sysInfo?.cpuPercent ?? null,
          mem_percent: sysInfo?.memPercent ?? null,
          guest_wifi_enabled: sysInfo?.guestWifiEnabled ?? null,
          uptime_sec: snap.uptime_sec,
          poll_interval_ms: cfg.pollIntervalMs,
          daemon_running: daemonRunning,
          wan_ports: netCtrl.wan_ports,
        },
        nsfw_enabled: nsfwRow ? nsfwRow.value !== 'off' : true,
        auto_qos_policy: netCtrl.auto_qos_policy,
        notification_types: getNotificationTypes(conn),
        thresholds: getThresholdConfig(conn),
        device_auth: auth.status(),
      });
    }

    if (method === 'POST') {
      const body = parseJsonBody(rawBody);
      if (!body) return jsonWithDate({ ok: false, error: 'invalid_json' }, 400);
      const conn = getDb();

      if (body.action === 'set_notification_type' && isNotificationType(body.type) && typeof body.enabled === 'boolean') {
        setNotificationEnabled(conn, body.type, body.enabled);
        return jsonWithDate({ ok: true, notification_types: getNotificationTypes(conn) });
      }
      if (body.action === 'save_thresholds') {
        const safeBytes = (v: unknown) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 1024 ** 5) : 0;
        };
        const thresholds = updateThresholdConfig(conn, {
          totalEnabled: Boolean(body.totalEnabled),
          totalLimitBytes: safeBytes(body.totalLimitBytes),
          totalPeriod: normalizePeriod(body.totalPeriod),
          deviceEnabled: Boolean(body.deviceEnabled),
          deviceDefaultLimitBytes: safeBytes(body.deviceDefaultLimitBytes),
          deviceDefaultPeriod: normalizePeriod(body.deviceDefaultPeriod),
        });
        return jsonWithDate({ ok: true, thresholds });
      }
      if (body.action === 'set_nsfw' && typeof body.enabled === 'boolean') {
        conn
          .prepare(`INSERT INTO settings (key, value) VALUES ('nsfw_detection', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(body.enabled ? 'on' : 'off');
        return jsonWithDate({ ok: true, nsfw_enabled: body.enabled });
      }
      return jsonWithDate({ ok: false, error: 'unknown_settings_action' }, 400);
    }
  }

  // ── POST /router/action ─────────────────────────────────────────────────────────────────────
  if (routeKey === 'router/action' && method === 'POST') {
    const body = parseJsonBody(rawBody);
    if (!body || typeof body.action !== 'string') {
      return jsonWithDate({ ok: false, error: 'action_required' }, 400);
    }
    const action = body.action.trim().toLowerCase();

    if (action === 'refresh_poll') {
      let pollerRefreshed = false;
      try {
        const r = await fetch(`${controlBase()}/device-control`, { signal: AbortSignal.timeout(8000) });
        pollerRefreshed = r.ok;
      } catch {
        // best-effort poller sync
      }
      const live = await getRouterLiveSnapshot().catch(() => null);
      return jsonWithDate({
        ok: true,
        action: 'refresh_poll',
        poller_refreshed: pollerRefreshed,
        live_ts: live?.ts ?? Date.now(),
        down_bps: live?.best_down_bps ?? 0,
        up_bps: live?.best_up_bps ?? 0,
      });
    }

    if (action === 'reboot') {
      const result = await rebootRouterDirect();
      logSecurityEvent({
        eventType: 'ios_v2_router_reboot',
        ipHash: clientRateLimitScope(req),
        detail: `Router reboot requested by iOS device ${verified.devId.slice(0, 12)} (ok=${result.ok})`,
      });
      if (!result.ok) {
        return jsonWithDate({ ok: false, error: result.error ?? 'reboot_failed' }, 502);
      }
      return jsonWithDate({ ok: true, action: 'reboot', message: 'تم إرسال أمر إعادة التشغيل إلى الراوتر' });
    }

    if (action === 'toggle_guest_wifi') {
      if (typeof body.enabled !== 'boolean') {
        return jsonWithDate({ ok: false, error: 'enabled_boolean_required' }, 400);
      }
      const result = await setRouterGuestWifiDirect(body.enabled);
      if (!result.ok) {
        return jsonWithDate({ ok: false, error: result.error ?? 'guest_wifi_failed' }, 502);
      }
      return jsonWithDate({ ok: true, action: 'toggle_guest_wifi', enabled: result.enabled });
    }

    return jsonWithDate({ ok: false, error: 'unknown_router_action' }, 400);
  }

  // ── POST /push/apns ─────────────────────────────────────────────────────────────────────────
  if (routeKey === 'push/apns' && method === 'POST') {
    const body = parseJsonBody(rawBody);
    if (!body) return jsonWithDate({ ok: false, error: 'invalid_json' }, 400);
    const token = typeof body.token === 'string' ? body.token.trim().toLowerCase() : '';
    if (!APNS_TOKEN_RE.test(token)) {
      return jsonWithDate({ ok: false, error: 'invalid_device_token' }, 400);
    }
    const environment = body.environment === 'sandbox' ? 'sandbox' : 'production';
    const bundleId =
      typeof body.bundleId === 'string' && /^[A-Za-z0-9.-]{3,120}$/.test(body.bundleId)
        ? body.bundleId
        : 'com.tveg.tendavault';
    const credId = `ios-v2:${verified.devId}`;
    const tokenHash = sha256Hex(token);
    const now = Date.now();
    const conn = getDb();

    if (body.action === 'disable') {
      conn
        .prepare(`UPDATE apns_devices SET disabled_at = ?, updated_at = ? WHERE token_hash = ? AND credential_id = ?`)
        .run(now, now, tokenHash, credId);
      return jsonWithDate({ ok: true, disabled: true });
    }

    conn
      .prepare(
        `INSERT INTO apns_devices (token_hash, token, credential_id, bundle_id, environment, created_at, updated_at, disabled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(token_hash) DO UPDATE SET
           token = excluded.token,
           credential_id = excluded.credential_id,
           bundle_id = excluded.bundle_id,
           environment = excluded.environment,
           updated_at = excluded.updated_at,
           disabled_at = NULL`,
      )
      .run(tokenHash, token, credId, bundleId, environment, now, now);
    return jsonWithDate({ ok: true });
  }

  return jsonWithDate({ ok: false, error: 'not_found' }, 404);
}

type RouteCtx = { params: Promise<{ slug: string[] }> };

export async function GET(req: Request, ctx: RouteCtx) {
  const { slug } = await ctx.params;
  return handleRoute(req, slug ?? []);
}

export async function POST(req: Request, ctx: RouteCtx) {
  const { slug } = await ctx.params;
  return handleRoute(req, slug ?? []);
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  const { slug } = await ctx.params;
  return handleRoute(req, slug ?? []);
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  const { slug } = await ctx.params;
  return handleRoute(req, slug ?? []);
}
