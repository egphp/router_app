import { GoogleGenAI } from '@google/genai';
import type Database from 'better-sqlite3';
import { isLocallyAdministeredMac, isAic8800FallbackMac, isLocalInfraCategory } from '../oui.js';
import { getAiSettings, resolveGeminiApiKey } from './config.js';
import {
  GEMINI_MODELS,
  cosineSimilarity,
  generateStructuredExplanation,
  summarizeNetworkDigest,
  type StructuredAiExplanation,
} from './gemini-client.js';
import { ALLOWED_READONLY_SCHEMA_SUMMARY, executeReadOnlySql } from './readonly-sql.js';
import { PiiSessionSanitizer } from './sanitizer.js';

export type LanOrWanAttribution = 'lan_only' | 'wan1' | 'wan2' | 'mixed';

export interface ProposedRouterAction {
  id: string;
  kind: 'set_qos' | 'move_wan' | 'reserve_dhcp' | 'dismiss_alert' | 'rename_device';
  labelAr: string;
  mac?: string;
  deviceLabel?: string;
  ip?: string;
  downloadLimitKbs?: number;
  uploadLimitKbs?: number;
  wanPort?: 1 | 2;
  dhcpReserved?: boolean;
  alertId?: number;
  newCustomLabel?: string;
}

export interface AiInsightRecord {
  scopeType: string;
  scopeKey: string;
  verdict: 'benign' | 'watch' | 'action_needed' | 'info';
  lanOrWan: LanOrWanAttribution | null;
  titleAr: string;
  explanationAr: string;
  recommendedAction: ProposedRouterAction | null;
  modelUsed: string;
  createdAt: number;
  cached: boolean;
}

export interface QuotaWanForecast {
  wanId: 1 | 2;
  quotaBytes: number;
  usedBytesCycle: number;
  dailyBurnBytesWeighted: number;
  projectedCycleBytes: number;
  daysUntilExhaustion: number | null;
  willExhaustBeforeRenewal: boolean;
  daysShortfall: number;
}

export interface ProactiveQuotaForecast {
  cycleStartTs: number;
  cycleEndTs: number;
  daysElapsed: number;
  daysRemainingInCycle: number;
  renewalDay: number;
  networkUsedDownBytes: number;
  networkUsedUpBytes: number;
  networkUsedTotalBytes: number;
  weightedDailyBurnBytes: number;
  projectedCycleTotalBytes: number;
  combinedQuotaBytes: number;
  daysUntilCombinedExhaustion: number | null;
  willExhaustBeforeRenewal: boolean;
  potentialHdCapSavingsBytes: number;
  wans: QuotaWanForecast[];
  topConsumers: Array<{
    mac: string;
    label: string;
    category: string | null;
    totalBytes: number;
    sharePct: number;
  }>;
  summaryAr: string;
  recommendedActions: ProposedRouterAction[];
}

export interface WanAndWifiAdvisory {
  wanFindings: Array<{
    severity: 'info' | 'warn' | 'action_needed';
    titleAr: string;
    detailAr: string;
    action?: ProposedRouterAction;
  }>;
  wifiFindings: Array<{
    severity: 'info' | 'warn' | 'action_needed';
    mac: string;
    label: string;
    band: string | null;
    rssiDbm: number | null;
    distanceM: number | null;
    adviceAr: string;
  }>;
}

export interface DataIntegrityReport {
  healthy: boolean;
  checkedAt: number;
  rawSamples48h: number;
  openSessionsCount: number;
  rollupVsRawRatio24h: number | null;
  issues: Array<{
    code: string;
    severity: 'info' | 'warn';
    messageAr: string;
  }>;
}

export interface CopilotTurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CopilotTurnResponse {
  replyAr: string;
  sqlQueriesRun: string[];
  proposedActions: ProposedRouterAction[];
  modelUsed: string;
}

/**
 * Correlates a device's traffic delta in `[startTs, endTs]` against `wan_samples` (`WAN1` + `WAN2`)
 * in the exact same time window so LAN-only transfers (Frigate cameras, SMB/NAS copies) are distinguished
 * from actual ISP quota consumption without violating `Router-Only Telemetry`.
 */
export function correlateDeviceWindowLanOrWan(
  db: Database.Database,
  deviceBytesTotal: number,
  startTs: number,
  endTs: number,
): {
  attribution: LanOrWanAttribution;
  wan1Bytes: number;
  wan2Bytes: number;
  wanCoverageRatio: number;
} {
  if (deviceBytesTotal <= 0) {
    return { attribution: 'mixed', wan1Bytes: 0, wan2Bytes: 0, wanCoverageRatio: 1 };
  }
  try {
    const wanRows = db.prepare(`
      WITH ordered AS (
        SELECT wan_id, ts, up_bytes_per_s, down_bytes_per_s,
               LAG(ts) OVER (PARTITION BY wan_id ORDER BY ts) AS prev_ts
        FROM wan_samples
        WHERE ts >= ? AND ts <= ?
      )
      SELECT wan_id,
             COALESCE(SUM(
               (up_bytes_per_s + down_bytes_per_s) *
               MIN(300.0, MAX(1.0, COALESCE((ts - prev_ts) / 1000.0, 30.0)))
             ), 0) AS total_bytes
      FROM ordered
      GROUP BY wan_id
    `).all(startTs - 60_000, endTs + 60_000) as Array<{ wan_id: number; total_bytes: number }>;

    if (wanRows.length === 0) {
      return { attribution: 'mixed', wan1Bytes: 0, wan2Bytes: 0, wanCoverageRatio: 1 };
    }

    const wan1Bytes = Number(wanRows.find((r) => r.wan_id === 1)?.total_bytes ?? 0);
    const wan2Bytes = Number(wanRows.find((r) => r.wan_id === 2)?.total_bytes ?? 0);
    const totalWan = wan1Bytes + wan2Bytes;
    const ratio = totalWan / Math.max(1, deviceBytesTotal);

    if (deviceBytesTotal >= 50 * 1024 * 1024 && ratio < 0.18) {
      return { attribution: 'lan_only', wan1Bytes, wan2Bytes, wanCoverageRatio: ratio };
    }
    if (wan1Bytes > wan2Bytes * 2.2 && wan1Bytes > 10 * 1024 * 1024) {
      return { attribution: 'wan1', wan1Bytes, wan2Bytes, wanCoverageRatio: ratio };
    }
    if (wan2Bytes > wan1Bytes * 2.2 && wan2Bytes > 10 * 1024 * 1024) {
      return { attribution: 'wan2', wan1Bytes, wan2Bytes, wanCoverageRatio: ratio };
    }
    return { attribution: 'mixed', wan1Bytes, wan2Bytes, wanCoverageRatio: ratio };
  } catch {
    return { attribution: 'mixed', wan1Bytes: 0, wan2Bytes: 0, wanCoverageRatio: 1 };
  }
}

/**
 * Computes billing cycle boundaries from configured `billingRenewalDay` (1..31).
 */
export function getBillingCycleWindow(nowTs: number, renewalDay: number): { startTs: number; endTs: number } {
  const d = new Date(nowTs);
  const year = d.getFullYear();
  const month = d.getMonth();
  const safeDayCurrent = Math.min(renewalDay, new Date(year, month + 1, 0).getDate());
  let cycleStart = new Date(year, month, safeDayCurrent, 0, 0, 0, 0);
  if (nowTs < cycleStart.getTime()) {
    const prevMonthLast = new Date(year, month, 0).getDate();
    cycleStart = new Date(year, month - 1, Math.min(renewalDay, prevMonthLast), 0, 0, 0, 0);
  }
  const nextMonthYear = cycleStart.getMonth() === 11 ? cycleStart.getFullYear() + 1 : cycleStart.getFullYear();
  const nextMonth = (cycleStart.getMonth() + 1) % 12;
  const nextMonthLast = new Date(nextMonthYear, nextMonth + 1, 0).getDate();
  const cycleEnd = new Date(nextMonthYear, nextMonth, Math.min(renewalDay, nextMonthLast), 0, 0, 0, 0);
  return { startTs: cycleStart.getTime(), endTs: cycleEnd.getTime() };
}

/**
 * Proactive Quota & Billing Coach (Download + Upload combined, recency-weighted 7d burn rate + per-WAN forecast).
 */
export function computeProactiveQuotaForecast(db: Database.Database, nowTs = Date.now()): ProactiveQuotaForecast {
  const cfg = getAiSettings(db);
  const { startTs, endTs } = getBillingCycleWindow(nowTs, cfg.billingRenewalDay);
  const dayMs = 86_400_000;
  const daysElapsed = Math.max(0.25, (nowTs - startTs) / dayMs);
  const daysRemainingInCycle = Math.max(0, (endTs - nowTs) / dayMs);

  const todayStart = startOfLocalDay(nowTs);
  const hourStart = Math.floor(nowTs / 3_600_000) * 3_600_000;

  // Non-overlapping device usage across traffic_day (< todayStart) + traffic_hour ([todayStart, hourStart)) + traffic_5min (>= hourStart)
  const allDevTotals = db.prepare(`
    WITH unified AS (
      SELECT mac, bytes_down, bytes_up FROM traffic_day
      WHERE bucket_ts >= @startTs AND bucket_ts < @todayStart
      UNION ALL
      SELECT mac, bytes_down, bytes_up FROM traffic_hour
      WHERE bucket_ts >= MAX(@startTs, @todayStart) AND bucket_ts < @hourStart
      UNION ALL
      SELECT mac, bytes_down, bytes_up FROM traffic_5min
      WHERE bucket_ts >= MAX(@startTs, @hourStart)
    )
    SELECT u.mac,
           COALESCE(d.custom_label, d.router_remark, d.hostname, u.mac) AS label,
           d.category,
           SUM(u.bytes_down) AS down_b,
           SUM(u.bytes_up) AS up_b
    FROM unified u
    LEFT JOIN devices d ON d.mac = u.mac
    GROUP BY u.mac
    ORDER BY (SUM(u.bytes_down) + SUM(u.bytes_up)) DESC
  `).all({
    startTs,
    todayStart,
    hourStart,
  }) as Array<{ mac: string; label: string; category: string | null; down_b: number; up_b: number }>;

  // Exclude local IP cameras & Wi-Fi repeaters from internet quota consumers
  const devTotals = allDevTotals.filter((r) => !isLocalInfraCategory(r.category));

  let deviceUsedDownBytes = 0;
  let deviceUsedUpBytes = 0;
  for (const r of devTotals) {
    deviceUsedDownBytes += Number(r.down_b ?? 0);
    deviceUsedUpBytes += Number(r.up_b ?? 0);
  }

  // Prefer authoritative ISP WAN line counters (wan_traffic_day) when WAN telemetry covers the cycle
  let wanCycleRow: { down_b: number; up_b: number; days_n: number } | undefined;
  try {
    wanCycleRow = db.prepare(`
      SELECT COALESCE(SUM(bytes_down), 0) AS down_b,
             COALESCE(SUM(bytes_up), 0) AS up_b,
             COUNT(*) AS days_n
      FROM wan_traffic_day
      WHERE bucket_ts >= @startTs
    `).get({ startTs }) as { down_b: number; up_b: number; days_n: number } | undefined;
  } catch {}

  const hasAuthoritativeWanCycle = Boolean(wanCycleRow && Number(wanCycleRow.days_n ?? 0) > 0 && (Number(wanCycleRow.down_b) + Number(wanCycleRow.up_b)) > 0);
  const networkUsedDownBytes = hasAuthoritativeWanCycle ? Number(wanCycleRow!.down_b) : deviceUsedDownBytes;
  const networkUsedUpBytes = hasAuthoritativeWanCycle ? Number(wanCycleRow!.up_b) : deviceUsedUpBytes;
  const networkUsedTotalBytes = networkUsedDownBytes + networkUsedUpBytes;

  // 7-day recency-weighted burn rate (non-overlapping, WAN-authoritative when available)
  const sevenDaysAgo = Math.max(startTs, nowTs - 7 * dayMs);
  const recentWindowDays = Math.max(0.25, (nowTs - sevenDaysAgo) / dayMs);
  let recentTotalBytes = 0;
  if (hasAuthoritativeWanCycle) {
    const wanRecent = db.prepare(`
      SELECT COALESCE(SUM(bytes_down + bytes_up), 0) AS total_b
      FROM wan_traffic_day WHERE bucket_ts >= @sevenDaysAgo
    `).get({ sevenDaysAgo }) as { total_b: number };
    recentTotalBytes = Number(wanRecent?.total_b ?? 0);
  } else {
    const recentRow = db.prepare(`
      WITH recent AS (
        SELECT u.mac, (u.bytes_down + u.bytes_up) AS b FROM (
          SELECT mac, bytes_down, bytes_up FROM traffic_day WHERE bucket_ts >= @sevenDaysAgo AND bucket_ts < @todayStart
          UNION ALL
          SELECT mac, bytes_down, bytes_up FROM traffic_hour WHERE bucket_ts >= MAX(@sevenDaysAgo, @todayStart) AND bucket_ts < @hourStart
          UNION ALL
          SELECT mac, bytes_down, bytes_up FROM traffic_5min WHERE bucket_ts >= MAX(@sevenDaysAgo, @hourStart)
        ) u
        LEFT JOIN devices d ON d.mac = u.mac
        WHERE COALESCE(LOWER(d.category), '') NOT IN ('camera', 'router', 'access_point')
      )
      SELECT COALESCE(SUM(b), 0) AS total_b FROM recent
    `).get({
      sevenDaysAgo,
      todayStart,
      hourStart,
    }) as { total_b: number };
    recentTotalBytes = Number(recentRow?.total_b ?? 0);
  }

  const linearDaily = networkUsedTotalBytes / daysElapsed;
  const recentDaily = recentTotalBytes / recentWindowDays;
  const weightedDailyBurnBytes = Math.round(recentDaily > 0 ? recentDaily * 0.65 + linearDaily * 0.35 : linearDaily);

  const projectedCycleTotalBytes = Math.round(
    networkUsedTotalBytes + weightedDailyBurnBytes * daysRemainingInCycle,
  );

  // Per-WAN cycle usage integrated from wan_samples (when available) or proportional fallback
  let wanSampleRows: Array<{ wan_id: number; used_b: number; recent_b: number }> = [];
  try {
    wanSampleRows = db.prepare(`
      WITH ordered AS (
        SELECT wan_id, ts, up_bytes_per_s, down_bytes_per_s,
               LAG(ts) OVER (PARTITION BY wan_id ORDER BY ts) AS prev_ts
        FROM wan_samples
        WHERE ts >= @startTs
      )
      SELECT wan_id,
             COALESCE(SUM(
               (up_bytes_per_s + down_bytes_per_s) *
               MIN(300.0, MAX(1.0, COALESCE((ts - prev_ts) / 1000.0, 30.0)))
             ), 0) AS used_b,
             COALESCE(SUM(
               CASE WHEN ts >= @sevenDaysAgo THEN
                 (up_bytes_per_s + down_bytes_per_s) *
                 MIN(300.0, MAX(1.0, COALESCE((ts - prev_ts) / 1000.0, 30.0)))
               ELSE 0 END
             ), 0) AS recent_b
      FROM ordered
      GROUP BY wan_id
    `).all({ startTs, sevenDaysAgo }) as Array<{ wan_id: number; used_b: number; recent_b: number }>;
  } catch {}

  const wans: QuotaWanForecast[] = ([1, 2] as const).map((wanId) => {
    const quotaGb = wanId === 1 ? cfg.wan1QuotaGb : cfg.wan2QuotaGb;
    const quotaBytes = Math.round(quotaGb * 1024 ** 3);
    const sample = wanSampleRows.find((w) => w.wan_id === wanId);
    const usedBytesCycle = sample
      ? Number(sample.used_b)
      : Math.round(networkUsedTotalBytes * (wanId === 1 ? 0.55 : 0.45));
    const recentWanDaily = sample
      ? Number(sample.recent_b) / recentWindowDays
      : usedBytesCycle / daysElapsed;
    const dailyBurn = Math.max(0, Math.round(recentWanDaily * 0.65 + (usedBytesCycle / daysElapsed) * 0.35));
    const projected = Math.round(usedBytesCycle + dailyBurn * daysRemainingInCycle);
    const remainingBytes = Math.max(0, quotaBytes - usedBytesCycle);
    const daysUntilExhaustion =
      quotaBytes > 0 && dailyBurn > 0 ? Number((remainingBytes / dailyBurn).toFixed(1)) : null;
    const willExhaustBeforeRenewal =
      quotaBytes > 0 && daysUntilExhaustion !== null && daysUntilExhaustion < daysRemainingInCycle;
    const daysShortfall = willExhaustBeforeRenewal && daysUntilExhaustion !== null
      ? Number(Math.max(0, daysRemainingInCycle - daysUntilExhaustion).toFixed(1))
      : 0;
    return {
      wanId,
      quotaBytes,
      usedBytesCycle,
      dailyBurnBytesWeighted: dailyBurn,
      projectedCycleBytes: projected,
      daysUntilExhaustion,
      willExhaustBeforeRenewal,
      daysShortfall,
    };
  });

  const combinedQuotaBytes = wans[0].quotaBytes + wans[1].quotaBytes;
  const remainingCombined = Math.max(0, combinedQuotaBytes - networkUsedTotalBytes);
  const daysUntilCombinedExhaustion =
    combinedQuotaBytes > 0 && weightedDailyBurnBytes > 0
      ? Number((remainingCombined / weightedDailyBurnBytes).toFixed(1))
      : null;
  const willExhaustBeforeRenewal =
    (combinedQuotaBytes > 0 &&
      daysUntilCombinedExhaustion !== null &&
      daysUntilCombinedExhaustion < daysRemainingInCycle) ||
    wans.some((w) => w.willExhaustBeforeRenewal);

  // Estimate savings if heavy TV/streaming/console devices get capped at HD (2048 KB/s ~35% reduction on 4K bursts)
  const mediaConsumers = devTotals.filter((d) =>
    ['tv', 'streaming', 'game_console'].includes(d.category ?? ''),
  );
  const mediaShareBytes = mediaConsumers.reduce((s, d) => s + Number(d.down_b) + Number(d.up_b), 0);
  const mediaDailyBytes = mediaShareBytes / daysElapsed;
  const potentialHdCapSavingsBytes = Math.round(mediaDailyBytes * daysRemainingInCycle * 0.35);

  const topConsumers = devTotals.slice(0, 5).map((d) => {
    const tot = Number(d.down_b ?? 0) + Number(d.up_b ?? 0);
    return {
      mac: d.mac,
      label: d.label,
      category: d.category,
      totalBytes: tot,
      sharePct: networkUsedTotalBytes > 0 ? Number(((tot / networkUsedTotalBytes) * 100).toFixed(1)) : 0,
    };
  });

  const recommendedActions: ProposedRouterAction[] = [];
  if (willExhaustBeforeRenewal && mediaConsumers[0]) {
    recommendedActions.push({
      id: `quota-hd-${mediaConsumers[0].mac}`,
      kind: 'set_qos',
      labelAr: `تفعيل وضع HD (${mediaConsumers[0].label}) لتوفير الباقة`,
      mac: mediaConsumers[0].mac,
      deviceLabel: mediaConsumers[0].label,
      downloadLimitKbs: 2048,
      uploadLimitKbs: 512,
    });
  }
  if (wans[0].willExhaustBeforeRenewal && !wans[1].willExhaustBeforeRenewal && topConsumers[0]) {
    recommendedActions.push({
      id: `quota-wan2-${topConsumers[0].mac}`,
      kind: 'move_wan',
      labelAr: `نقل ${topConsumers[0].label} إلى خط WAN2 الأقل استهلاكاً`,
      mac: topConsumers[0].mac,
      deviceLabel: topConsumers[0].label,
      wanPort: 2,
    });
  }

  const fmtGb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  const summaryAr = willExhaustBeforeRenewal
    ? `تنبيه مبكر: بمعدل السحب الحالي (${fmtGb(weightedDailyBurnBytes)}/يوم شاملاً التحميل والرفع)، يُتوقع نفاد الباقة قبل موعد التجديد بـ ${Math.max(
        wans[0].daysShortfall,
        wans[1].daysShortfall,
        daysUntilCombinedExhaustion !== null ? Number((daysRemainingInCycle - daysUntilCombinedExhaustion).toFixed(1)) : 0,
      )} يوم.${
        potentialHdCapSavingsBytes > 5 * 1024 ** 3
          ? ` تفعيل وضع HD لأجهزة الشاشات يوفر نحو ${fmtGb(potentialHdCapSavingsBytes)} حتى نهاية الدورة.`
          : ''
      }`
    : `معدل استهلاك الباقة متوازن (${fmtGb(weightedDailyBurnBytes)}/يوم شاملاً التحميل والرفع) ويكفي حتى يوم التجديد (${Math.ceil(daysRemainingInCycle)} يوم متبقٍ).`;

  return {
    cycleStartTs: startTs,
    cycleEndTs: endTs,
    daysElapsed: Number(daysElapsed.toFixed(1)),
    daysRemainingInCycle: Number(daysRemainingInCycle.toFixed(1)),
    renewalDay: cfg.billingRenewalDay,
    networkUsedDownBytes,
    networkUsedUpBytes,
    networkUsedTotalBytes,
    weightedDailyBurnBytes,
    projectedCycleTotalBytes,
    combinedQuotaBytes,
    daysUntilCombinedExhaustion,
    willExhaustBeforeRenewal,
    potentialHdCapSavingsBytes,
    wans,
    topConsumers,
    summaryAr,
    recommendedActions,
  };
}

/**
 * Dual-WAN Health, ISP Brownout & WAN-DHCP Drift Guard + Wi-Fi Map Coverage Advisor.
 */
export function analyzeWanAndWifiHealth(db: Database.Database, nowTs = Date.now()): WanAndWifiAdvisory {
  const wanFindings: WanAndWifiAdvisory['wanFindings'] = [];
  const wifiFindings: WanAndWifiAdvisory['wifiFindings'] = [];

  try {
    const wanPorts = db.prepare(`
      SELECT wan_id, wan_name, status, up_flux_bps, down_flux_bps, public_ip_changed_at, ddns_last_error
      FROM router_wan_ports
      ORDER BY wan_id ASC
    `).all() as Array<{
      wan_id: number;
      wan_name: string;
      status: string;
      up_flux_bps: number;
      down_flux_bps: number;
      public_ip_changed_at: number | null;
      ddns_last_error: string | null;
    }>;

    for (const wp of wanPorts) {
      if (wp.status && !/connected|up|online|1/i.test(wp.status)) {
        wanFindings.push({
          severity: 'action_needed',
          titleAr: `خط ${wp.wan_name || `WAN${wp.wan_id}`} غير متصل حالياً`,
          detailAr: `حالة البورت المبلّغة من الراوتر هي (${wp.status}) — راجع كابل أو جلسة PPPoE الخاصة بالخط.`,
        });
      } else if (wp.public_ip_changed_at && nowTs - wp.public_ip_changed_at < 30 * 60_000) {
        wanFindings.push({
          severity: 'info',
          titleAr: `تغيّر قريب في الـ Public IP على WAN${wp.wan_id}`,
          detailAr: `أعاد مزود الخدمة تعيين عنوان خارجي جديد خلال آخر ٣٠ دقيقة (قد يدل على إعادة مزامنة خط الـ VDSL).`,
        });
      }
      if (wp.ddns_last_error) {
        wanFindings.push({
          severity: 'warn',
          titleAr: `تعذّر مزامنة DDNS على WAN${wp.wan_id}`,
          detailAr: `آخر رسالة خطأ: ${wp.ddns_last_error}`,
        });
      }
    }

    // WAN-DHCP Drift Guard: find explicit WAN IP bindings whose IP is NOT locked in dhcp_reservations!
    const unreservedBindings = db.prepare(`
      SELECT wb.ip, wb.wan_port,
             s.mac,
             COALESCE(d.custom_label, d.router_remark, d.hostname, s.mac) AS label
      FROM router_wan_bindings wb
      LEFT JOIN dhcp_reservations dr ON dr.ip = wb.ip
      LEFT JOIN (
        SELECT mac, ip, MAX(ts) AS max_ts
        FROM samples_raw
        WHERE ip IS NOT NULL AND ip != ''
        GROUP BY ip
      ) s ON s.ip = wb.ip
      LEFT JOIN devices d ON d.mac = s.mac
      WHERE wb.inherited_from_range = 0
        AND wb.rule_enabled = 1
        AND dr.ip IS NULL
    `).all() as Array<{ ip: string; wan_port: string; mac: string | null; label: string | null }>;

    for (const ub of unreservedBindings) {
      wanFindings.push({
        severity: 'warn',
        titleAr: `انجراف محتمل لتوجيه ${ub.wan_port} على العنوان ${ub.ip}`,
        detailAr: `العنوان ${ub.ip} مرتبط بقاعدة ${ub.wan_port} بدون حجز DHCP ثابت${ub.label ? ` للجهاز (${ub.label})` : ''}؛ تغيّر الـ IP قد ينقل القاعدة لجهاز آخر.`,
        action: ub.mac
          ? {
              id: `dhcp-lock-${ub.mac}`,
              kind: 'reserve_dhcp',
              labelAr: `تثبيت حجز DHCP للعنوان ${ub.ip}`,
              mac: ub.mac,
              deviceLabel: ub.label ?? ub.mac,
              ip: ub.ip,
              dhcpReserved: true,
            }
          : undefined,
      });
    }
  } catch {
    // Tables optional in partial test environments
  }

  // Wi-Fi Map Band & Signal Advisor
  try {
    const wifiRows = db.prepare(`
      SELECT s.mac,
             COALESCE(d.custom_label, d.router_remark, d.hostname, s.mac) AS label,
             d.category,
             s.wifi_band,
             s.wifi_rssi_dbm,
             s.wifi_distance_m,
             s.down_speed_bps + s.up_speed_bps AS live_bps
      FROM samples_raw s
      INNER JOIN (
        SELECT mac, MAX(ts) AS max_ts
        FROM samples_raw
        WHERE ts >= ?
        GROUP BY mac
      ) latest ON latest.mac = s.mac AND latest.max_ts = s.ts
      LEFT JOIN devices d ON d.mac = s.mac
      WHERE s.online = 1 AND s.connection_kind = 'wifi'
    `).all(nowTs - 15 * 60_000) as Array<{
      mac: string;
      label: string;
      category: string | null;
      wifi_band: string | null;
      wifi_rssi_dbm: number | null;
      wifi_distance_m: number | null;
      live_bps: number;
    }>;

    for (const w of wifiRows) {
      const highCapable = ['phone', 'tablet', 'computer', 'tv', 'streaming', 'game_console'].includes(
        w.category ?? '',
      );
      if (
        w.wifi_band === '2.4GHz' &&
        highCapable &&
        ((w.wifi_rssi_dbm !== null && w.wifi_rssi_dbm >= -62) ||
          (w.wifi_distance_m !== null && w.wifi_distance_m <= 5.5))
      ) {
        wifiFindings.push({
          severity: 'info',
          mac: w.mac,
          label: w.label,
          band: w.wifi_band,
          rssiDbm: w.wifi_rssi_dbm,
          distanceM: w.wifi_distance_m,
          adviceAr: `قريب من الراوتر لكنه عالق على تردد 2.4GHz المزدحم — تحويله إلى 5GHz يضاعف سرعته ويخفف التداخل.`,
        });
      } else if (w.wifi_rssi_dbm !== null && w.wifi_rssi_dbm <= -76) {
        wifiFindings.push({
          severity: 'warn',
          mac: w.mac,
          label: w.label,
          band: w.wifi_band,
          rssiDbm: w.wifi_rssi_dbm,
          distanceM: w.wifi_distance_m,
          adviceAr: `إشارة Wi-Fi ضعيفة (${w.wifi_rssi_dbm} dBm) تسبب إعادة إرسال الحزم وبطء زمن الاستجابة على الشبكة اللاسلكية.`,
        });
      }
    }
  } catch {}

  return { wanFindings, wifiFindings };
}

/**
 * Computes a normalized 30-element behavioral vector for a device (24 active-hour slots + band + RSSI + up/down ratio + session density)
 * to match randomized-MAC phones/tablets across MAC rotations without external PII!
 */
export function computeDeviceBehaviorVector(db: Database.Database, mac: string, nowTs = Date.now()): number[] {
  const vec = new Array<number>(30).fill(0);
  const sevenDaysAgo = nowTs - 7 * 86_400_000;
  const hourly = db.prepare(`
    SELECT CAST(((bucket_ts / 3600000) % 24) AS INTEGER) AS hr,
           SUM(bytes_down) AS down_b,
           SUM(bytes_up) AS up_b,
           SUM(active_sec) AS act_s
    FROM traffic_hour
    WHERE mac = ? AND bucket_ts >= ?
    GROUP BY hr
  `).all(mac, sevenDaysAgo) as Array<{ hr: number; down_b: number; up_b: number; act_s: number }>;

  let totalDown = 0;
  let totalUp = 0;
  for (const r of hourly) {
    const h = Math.max(0, Math.min(23, Number(r.hr ?? 0)));
    vec[h] = Number(r.act_s ?? 0);
    totalDown += Number(r.down_b ?? 0);
    totalUp += Number(r.up_b ?? 0);
  }
  const radio = db.prepare(`
    SELECT AVG(CASE WHEN wifi_band = '5GHz' THEN 1.0 WHEN wifi_band = '2.4GHz' THEN 0.4 ELSE 0.0 END) AS band_score,
           AVG(COALESCE(wifi_rssi_dbm, -60)) AS avg_rssi,
           AVG(COALESCE(sessions, 0)) AS avg_conn
    FROM samples_raw
    WHERE mac = ? AND ts >= ?
  `).get(mac, nowTs - 48 * 3_600_000) as {
    band_score: number | null;
    avg_rssi: number | null;
    avg_conn: number | null;
  } | undefined;

  vec[24] = Number(radio?.band_score ?? 0) * 100;
  vec[25] = Math.max(0, 100 + Number(radio?.avg_rssi ?? -65));
  vec[26] = Math.min(100, Number(radio?.avg_conn ?? 0));
  vec[27] = totalDown + totalUp > 0 ? (totalUp / (totalDown + totalUp)) * 100 : 0;
  vec[28] = isLocallyAdministeredMac(mac) ? 50 : 0;
  vec[29] = Math.min(100, Math.log10(Math.max(1, totalDown + totalUp)) * 10);

  let norm = 0;
  for (const x of vec) norm += x * x;
  if (norm <= 0) return vec;
  const inv = 1 / Math.sqrt(norm);
  return vec.map((x) => Number((x * inv).toFixed(5)));
}

/**
 * Finds if a newly seen randomized-MAC device closely matches a recently offline randomized-MAC device (>= 0.88 similarity).
 */
export function findRandomizedMacMatch(
  db: Database.Database,
  mac: string,
  targetVec: number[],
  nowTs = Date.now(),
): { matchedMac: string; similarity: number } | null {
  if (!isLocallyAdministeredMac(mac) || isAic8800FallbackMac(mac)) return null;
  const candidates = db.prepare(`
    SELECT d.mac, p.behavior_vector_json
    FROM devices d
    LEFT JOIN ai_device_profiles p ON p.mac = d.mac
    WHERE d.mac != ?
      AND d.last_seen < ?
      AND d.last_seen >= ?
  `).all(mac, nowTs - 2 * 60_000, nowTs - 14 * 86_400_000) as Array<{
    mac: string;
    behavior_vector_json: string | null;
  }>;

  let best: { matchedMac: string; similarity: number } | null = null;
  for (const c of candidates) {
    if (!isLocallyAdministeredMac(c.mac)) continue;
    let cVec: number[] | null = null;
    if (c.behavior_vector_json) {
      try {
        cVec = JSON.parse(c.behavior_vector_json);
      } catch {}
    }
    if (!cVec || !Array.isArray(cVec) || cVec.length !== targetVec.length) {
      cVec = computeDeviceBehaviorVector(db, c.mac, nowTs);
    }
    const sim = cosineSimilarity(targetVec, cVec);
    if (sim >= 0.88 && (!best || sim > best.similarity)) {
      best = { matchedMac: c.mac, similarity: Number(sim.toFixed(3)) };
    }
  }
  return best;
}

/**
 * Read-Only Data Integrity Watchdog (`samples_raw` vs `device_sessions` vs `traffic_5min/hour` rollups).
 */
export function runDataIntegrityWatchdog(db: Database.Database, nowTs = Date.now()): DataIntegrityReport {
  const issues: DataIntegrityReport['issues'] = [];
  const window24h = nowTs - 24 * 3_600_000;
  const window48h = nowTs - 48 * 3_600_000;

  const rawCountRow = db.prepare(`SELECT COUNT(*) AS cnt FROM samples_raw WHERE ts >= ?`).get(window48h) as {
    cnt: number;
  };
  const openSessionsRow = db.prepare(`SELECT COUNT(*) AS cnt FROM device_sessions WHERE ended_at IS NULL`).get() as {
    cnt: number;
  };

  // Compare positive session-safe deltas in samples_raw (last 24h) vs traffic_hour + traffic_5min (last 24h)
  const rollupRow = db.prepare(`
    SELECT (
      COALESCE((SELECT SUM(bytes_down) FROM traffic_hour WHERE bucket_ts >= @w24), 0) +
      COALESCE((SELECT SUM(bytes_down) FROM traffic_5min WHERE bucket_ts >= MAX(@w24, @hourStart)), 0)
    ) AS rollup_down
  `).get({
    w24: Math.floor(window24h / 3_600_000) * 3_600_000,
    hourStart: Math.floor(nowTs / 3_600_000) * 3_600_000,
  }) as { rollup_down: number };

  const rawDeltasRow = db.prepare(`
    WITH ordered AS (
      SELECT mac, ts, online, down_sum_kb,
             LAG(down_sum_kb) OVER (PARTITION BY mac ORDER BY ts) AS prev_kb,
             LAG(ts) OVER (PARTITION BY mac ORDER BY ts) AS prev_ts
      FROM samples_raw
      WHERE ts >= ?
    )
    SELECT COALESCE(SUM(
      CASE
        WHEN prev_kb IS NOT NULL AND (ts - prev_ts) <= 300000 AND down_sum_kb >= prev_kb AND (down_sum_kb - prev_kb) <= 5242880
        THEN (down_sum_kb - prev_kb) * 1024
        ELSE 0
      END
    ), 0) AS raw_down
    FROM ordered
  `).get(Math.floor(window24h / 3_600_000) * 3_600_000) as { raw_down: number };

  let ratio: number | null = null;
  if (rawDeltasRow.raw_down > 20 * 1024 * 1024) {
    ratio = Number((rollupRow.rollup_down / rawDeltasRow.raw_down).toFixed(3));
    if (ratio < 0.7 || ratio > 1.35) {
      issues.push({
        code: 'ROLLUP_RAW_DRIFT',
        severity: 'warn',
        messageAr: `لوحظ فرق بين تجميعات الساعات (${(rollupRow.rollup_down / 1024 ** 3).toFixed(2)} GB) وعينات الراوتر الخام (${(rawDeltasRow.raw_down / 1024 ** 3).toFixed(2)} GB) خلال آخر ٢٤ ساعة.`,
      });
    }
  }

  // Check stale open sessions where device hasn't been seen online for > 3 hours
  const staleOpen = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM device_sessions ds
    JOIN devices d ON d.mac = ds.mac
    WHERE ds.ended_at IS NULL AND d.last_seen < ?
  `).get(nowTs - 3 * 3_600_000) as { cnt: number };

  if (staleOpen.cnt > 0) {
    issues.push({
      code: 'STALE_OPEN_SESSIONS',
      severity: 'info',
      messageAr: `يوجد ${staleOpen.cnt} جلسة جهاز ما زالت مفتوحة رغم عدم ظهور الجهاز خلال آخر ٣ ساعات.`,
    });
  }

  return {
    healthy: issues.every((i) => i.severity !== 'warn'),
    checkedAt: nowTs,
    rawSamples48h: Number(rawCountRow.cnt ?? 0),
    openSessionsCount: Number(openSessionsRow.cnt ?? 0),
    rollupVsRawRatio24h: ratio,
    issues,
  };
}

/**
 * Generates or retrieves a cached Arabic explanation (`Ask Gemini`) with Zero-PII tokenization,
 * gracefully falling back to accurate local router-telemetry heuristics when `GEMINI_API_KEY` is not yet configured.
 */
export async function getOrGenerateEventExplanation(
  db: Database.Database,
  params: {
    scopeType: 'alert' | 'security' | 'attack' | 'outage' | 'anomaly' | 'wan_advisor' | 'wifi_map' | 'integrity_watchdog';
    scopeKey: string;
    contextPayload: Record<string, unknown>;
    forceRefresh?: boolean;
  },
): Promise<AiInsightRecord> {
  if (!params.forceRefresh) {
    const cached = db.prepare(`
      SELECT scope_type, scope_key, verdict, lan_or_wan, title_ar, explanation_ar, recommended_action_json, model_used, created_at
      FROM ai_insights
      WHERE scope_type = ? AND scope_key = ?
    `).get(params.scopeType, params.scopeKey) as Record<string, any> | undefined;
    if (cached && Date.now() - Number(cached.created_at) < 12 * 3_600_000) {
      return {
        scopeType: cached.scope_type,
        scopeKey: cached.scope_key,
        verdict: cached.verdict,
        lanOrWan: cached.lan_or_wan ?? null,
        titleAr: cached.title_ar,
        explanationAr: cached.explanation_ar,
        recommendedAction: cached.recommended_action_json ? JSON.parse(cached.recommended_action_json) : null,
        modelUsed: cached.model_used,
        createdAt: Number(cached.created_at),
        cached: true,
      };
    }
  }

  const sanitizer = new PiiSessionSanitizer(db);
  const { apiKey } = resolveGeminiApiKey(db);
  const cfg = getAiSettings(db);

  let record: AiInsightRecord;
  if (apiKey && cfg.enabled) {
    try {
      const sanitizedJson = JSON.stringify(
        sanitizer.sanitizeValue({
          scopeType: params.scopeType,
          ...params.contextPayload,
        }),
      );
      const aiRes: StructuredAiExplanation = await generateStructuredExplanation(apiKey, sanitizedJson, {
        deepForensics: params.scopeType === 'outage',
      });
      const action = mapAiActionToLocal(aiRes.recommended_action, sanitizer, db);
      record = {
        scopeType: params.scopeType,
        scopeKey: params.scopeKey,
        verdict: aiRes.verdict,
        lanOrWan: aiRes.lan_or_wan ?? (params.contextPayload.lanOrWan as LanOrWanAttribution | null) ?? null,
        titleAr: sanitizer.detokenizeText(aiRes.title_ar),
        explanationAr: sanitizer.detokenizeText(aiRes.explanation_ar),
        recommendedAction: action,
        modelUsed: aiRes.model_used,
        createdAt: Date.now(),
        cached: false,
      };
    } catch {
      record = buildDeterministicFallbackExplanation(db, params.scopeType, params.scopeKey, params.contextPayload);
    }
  } else {
    record = buildDeterministicFallbackExplanation(db, params.scopeType, params.scopeKey, params.contextPayload);
  }

  db.prepare(`
    INSERT INTO ai_insights (
      scope_type, scope_key, verdict, lan_or_wan, title_ar, explanation_ar, recommended_action_json, model_used, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_type, scope_key) DO UPDATE SET
      verdict = excluded.verdict,
      lan_or_wan = excluded.lan_or_wan,
      title_ar = excluded.title_ar,
      explanation_ar = excluded.explanation_ar,
      recommended_action_json = excluded.recommended_action_json,
      model_used = excluded.model_used,
      created_at = excluded.created_at
  `).run(
    record.scopeType,
    record.scopeKey,
    record.verdict,
    record.lanOrWan,
    record.titleAr,
    record.explanationAr,
    record.recommendedAction ? JSON.stringify(record.recommendedAction) : null,
    record.modelUsed,
    record.createdAt,
  );

  return record;
}

function mapAiActionToLocal(
  raw: StructuredAiExplanation['recommended_action'],
  sanitizer: PiiSessionSanitizer,
  db: Database.Database,
): ProposedRouterAction | null {
  if (!raw || raw.kind === 'none') return null;
  const mac = raw.mac_token ? sanitizer.resolveMacToken(raw.mac_token) ?? undefined : undefined;
  let deviceLabel: string | undefined;
  let ip: string | undefined;
  if (mac) {
    const dev = db.prepare(`
      SELECT COALESCE(custom_label, router_remark, hostname, mac) AS label,
             (SELECT s.ip FROM samples_raw s WHERE s.mac = devices.mac AND s.ip IS NOT NULL ORDER BY s.ts DESC LIMIT 1) AS latest_ip
      FROM devices WHERE mac = ?
    `).get(mac) as { label?: string; latest_ip?: string } | undefined;
    deviceLabel = dev?.label;
    ip = dev?.latest_ip ?? undefined;
  }
  const labelAr = raw.label_ar ? sanitizer.detokenizeText(raw.label_ar) : 'تطبيق الإجراء المقترح';
  return {
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: raw.kind,
    labelAr,
    mac,
    deviceLabel,
    ip,
    downloadLimitKbs: raw.download_limit_kbs,
    uploadLimitKbs: raw.upload_limit_kbs,
    wanPort: raw.wan_port,
    dhcpReserved: raw.kind === 'reserve_dhcp' ? true : undefined,
  };
}

function buildDeterministicFallbackExplanation(
  db: Database.Database,
  scopeType: string,
  scopeKey: string,
  ctx: Record<string, unknown>,
): AiInsightRecord {
  const now = Date.now();
  if (scopeType === 'anomaly') {
    const lanOrWan = (ctx.lanOrWan as LanOrWanAttribution | undefined) ?? 'mixed';
    const label = String(ctx.label || ctx.mac || 'الجهاز');
    const ratio = Number(ctx.sigma ?? 3).toFixed(1);
    if (lanOrWan === 'lan_only') {
      return {
        scopeType,
        scopeKey,
        verdict: 'benign',
        lanOrWan: 'lan_only',
        titleAr: `نشاط نقل داخلي محلي (LAN) على ${label}`,
        explanationAr: `قفز عداد الجهاز بمقدار ${ratio}σ فوق معتاده لنفس الساعة، لكن عدادات WAN1/WAN2 لم تسجل سحباً خارجياً مماثلاً — ما يعني أنه ترافيك محلي (مثل كاميرات NVR أو نسخ ملفات داخلي) ولم يستهلك من باقة الإنترنت.`,
        recommendedAction: null,
        modelUsed: 'local-telemetry-correlator',
        createdAt: now,
        cached: false,
      };
    }
    return {
      scopeType,
      scopeKey,
      verdict: 'watch',
      lanOrWan,
      titleAr: `ارتفاع سحب خارجي (${lanOrWan.toUpperCase()}) من ${label}`,
      explanationAr: `استهلك ${label} أعلى من متوسطه المعتاد لهذه الساعة بـ ${ratio}σ مع تطابق مباشر في عداد الإنترنت الخارجي (${lanOrWan.toUpperCase()}). يمكنك تفعيل سقف سرعة مؤقت إذا كان السحب يؤثر على باقي الأجهزة.`,
      recommendedAction: typeof ctx.mac === 'string'
        ? {
            id: `anom-hd-${ctx.mac}`,
            kind: 'set_qos',
            labelAr: `تحديد سرعة ${label} بوضع HD (2 MB/s)`,
            mac: ctx.mac,
            deviceLabel: label,
            downloadLimitKbs: 2048,
            uploadLimitKbs: 512,
          }
        : null,
      modelUsed: 'local-telemetry-correlator',
      createdAt: now,
      cached: false,
    };
  }

  if (scopeType === 'outage') {
    const reason = String(ctx.reason || 'unreachable');
    const rebooted = Boolean(ctx.routerRebootNearby);
    return {
      scopeType,
      scopeKey,
      verdict: reason === 'auth_fail' ? 'action_needed' : 'info',
      lanOrWan: null,
      titleAr:
        reason === 'router_reboot' || rebooted
          ? 'إعادة تشغيل الراوتر (كهرباء أو تحديث نظام)'
          : reason === 'auth_fail'
          ? 'رفض جلسة الدخول من الراوتر'
          : 'انقطاع تواصل محلي مؤقت بين المراقب والراوتر',
      explanationAr:
        reason === 'router_reboot' || rebooted
          ? 'تصفّر عداد وقت تشغيل الراوتر (Uptime) في نفس توقيت الحدث، مما يؤكد إعادة إقلاع فعلية للراوتر وليس مجرد بطء في خط المزود.'
          : reason === 'auth_fail'
          ? 'رفض الراوتر جلسة المصادقة (ربما بسبب تسجيل دخول يدوي متزامن على واجهة الويب أو تغيّر كلمة المرور).'
          : 'لم يستجب عنوان الراوتر على الشبكة المحلية خلال مهلة الفحص ثم عاد للعمل تلقائياً.',
      recommendedAction: null,
      modelUsed: 'local-outage-forensics',
      createdAt: now,
      cached: false,
    };
  }

  if (scopeType === 'attack' || scopeType === 'security') {
    const mac = typeof ctx.mac === 'string' ? ctx.mac : typeof ctx.attacker_mac === 'string' ? ctx.attacker_mac : undefined;
    const label = String(ctx.device_label || ctx.label || mac || 'جهاز بالشبكة');
    const kind = String(ctx.rule || ctx.attack_kind || ctx.kind || 'تنبيه أمني');
    return {
      scopeType,
      scopeKey,
      verdict: 'watch',
      lanOrWan: null,
      titleAr: `تفسير حدث (${kind}) المرتبط بـ ${label}`,
      explanationAr:
        kind.toLowerCase().includes('arp')
          ? `رصدت حماية Tenda معدل طلبات ARP مرتفع من ${label}؛ غالباً ينتج عن فحص شبكة محلي أو إعادة اتصال متكررة لكرت Wi-Fi، لكن لو كان الجهاز غير موثوق يُفضّل عزله بسرعة SD.`
          : `تجاوز ${label} العتبة الاعتيادية لقاعدة (${kind}). راجع سجل الجلسات أو قيّد سرعته احترازياً إذا لم يكن جهاز عمل رئيسي.`,
      recommendedAction: mac
        ? {
            id: `sec-sd-${mac}`,
            kind: 'set_qos',
            labelAr: `تقييد ${label} بوضع SD احترازياً`,
            mac,
            deviceLabel: label,
            downloadLimitKbs: 256,
            uploadLimitKbs: 64,
          }
        : null,
      modelUsed: 'local-security-heuristics',
      createdAt: now,
      cached: false,
    };
  }

  void db;
  return {
    scopeType,
    scopeKey,
    verdict: 'info',
    lanOrWan: null,
    titleAr: 'ملخص فحص المؤشر',
    explanationAr: 'أضف مفتاح GEMINI_API_KEY في الإعدادات لتفعيل الاستدلال العميق عبر Gemini 4 مع تعمية الهوية الكاملة.',
    recommendedAction: null,
    modelUsed: 'local-fallback',
    createdAt: now,
    cached: false,
  };
}

/**
 * Builds a compact sanitized live snapshot of the network for Copilot / Telegram / Voice Brief.
 */
export function buildNetworkLiveSnapshot(db: Database.Database, nowTs = Date.now()): Record<string, unknown> {
  const routerState = db.prepare(`SELECT ts, uptime_sec, online_count FROM router_state ORDER BY ts DESC LIMIT 1`).get() as
    | Record<string, unknown>
    | undefined;

  let wanPorts: unknown[] = [];
  try {
    wanPorts = db.prepare(`
      SELECT wan_id, wan_name, status, up_flux_bps, down_flux_bps, ddns_last_error
      FROM router_wan_ports ORDER BY wan_id ASC
    `).all();
  } catch {}

  const topLive = db.prepare(`
    SELECT s.mac,
           COALESCE(d.custom_label, d.router_remark, d.hostname, s.mac) AS label,
           d.category,
           s.ip,
           s.down_speed_bps,
           s.up_speed_bps,
           s.wifi_band,
           s.wifi_rssi_dbm
    FROM samples_raw s
    INNER JOIN (
      SELECT mac, MAX(ts) AS max_ts FROM samples_raw WHERE ts >= ? GROUP BY mac
    ) l ON l.mac = s.mac AND l.max_ts = s.ts
    LEFT JOIN devices d ON d.mac = s.mac
    WHERE s.online = 1
    ORDER BY (s.down_speed_bps + s.up_speed_bps) DESC
    LIMIT 12
  `).all(nowTs - 5 * 60_000);

  const activeAlerts = db.prepare(`
    SELECT id, kind, mac, payload, created_at
    FROM alerts
    WHERE dismissed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 10
  `).all();

  const quota = computeProactiveQuotaForecast(db, nowTs);
  return {
    nowIso: new Date(nowTs).toISOString(),
    routerState: routerState ?? null,
    wanPorts,
    topOnlineDevices: topLive,
    activeAlertsCount: activeAlerts.length,
    activeAlerts,
    quotaSummary: {
      usedGb: Number((quota.networkUsedTotalBytes / 1024 ** 3).toFixed(2)),
      dailyBurnGb: Number((quota.weightedDailyBurnBytes / 1024 ** 3).toFixed(2)),
      daysRemainingInCycle: quota.daysRemainingInCycle,
      willExhaustBeforeRenewal: quota.willExhaustBeforeRenewal,
      topConsumers: quota.topConsumers.slice(0, 5).map((c) => ({
        mac: c.mac,
        label: c.label,
        gb: Number((c.totalBytes / 1024 ** 3).toFixed(2)),
      })),
    },
  };
}

/**
 * Generates a spoken-ready Arabic network summary (and optional WAV audio when `withAudio = true`).
 */
export async function buildSpokenNetworkSummary(
  db: Database.Database,
  nowTs = Date.now(),
): Promise<{ scriptAr: string; modelUsed: string }> {
  const snap = buildNetworkLiveSnapshot(db, nowTs);
  const sanitizer = new PiiSessionSanitizer(db);
  const { apiKey } = resolveGeminiApiKey(db);
  const cfg = getAiSettings(db);

  if (apiKey && cfg.enabled) {
    try {
      const raw = await summarizeNetworkDigest(
        apiKey,
        JSON.stringify(sanitizer.sanitizeValue(snap)),
        'voice_brief',
      );
      if (raw) {
        return {
          scriptAr: sanitizer.detokenizeText(raw),
          modelUsed: GEMINI_MODELS.fastLite,
        };
      }
    } catch {}
  }

  const online = (snap.routerState as any)?.online_count ?? (snap.topOnlineDevices as any[]).length;
  const top = (snap.topOnlineDevices as any[])[0];
  const q = snap.quotaSummary as any;
  const scriptAr = `الشبكة متصلة الآن وعليها ${online} جهاز نشط. ${
    top
      ? `أعلى سحب حالي من ${top.label} بسرعة ${((Number(top.down_speed_bps || 0) + Number(top.up_speed_bps || 0)) / 1024 / 1024).toFixed(1)} ميجابايت في الثانية.`
      : ''
  } استهلاك الدورة الحالية وصل إلى ${q.usedGb} جيجابايت بمعدل يومي ${q.dailyBurnGb} جيجابايت، وعدد التنبيهات غير المقروءة ${snap.activeAlertsCount}.`;
  return { scriptAr, modelUsed: 'local-summary' };
}

/**
 * Runs a full `Tenda AI Copilot` turn (`gemini-4-hydrogen` + Read-Only SQL tool + Human-in-the-Loop Action Cards)
 * used by BOTH the Dashboard `⌘K` Copilot Drawer and the Two-Way Telegram / Voice Agent!
 */
export async function runCopilotTurn(
  db: Database.Database,
  params: {
    message: string;
    history?: CopilotTurnMessage[];
    pageContext?: { pathname?: string; focusedMac?: string | null };
    dbPathForReadOnly?: string;
  },
): Promise<CopilotTurnResponse> {
  const sanitizer = new PiiSessionSanitizer(db);
  const { apiKey } = resolveGeminiApiKey(db);
  const cfg = getAiSettings(db);
  const sqlQueriesRun: string[] = [];
  const proposedActions: ProposedRouterAction[] = [];

  if (!apiKey || !cfg.enabled) {
    // Helpful local fallback when API key isn't configured yet
    const snap = buildNetworkLiveSnapshot(db);
    const q = snap.quotaSummary as any;
    const top = (snap.topOnlineDevices as any[]).slice(0, 3);
    return {
      replyAr:
        `الوضع المحلي السريع (لتفعيل الاستعلام الذكي الكامل عبر Gemini 4 Hydrogen أضف مفتاح \`GEMINI_API_KEY\` من صفحة الإعدادات):\n` +
        `• الأجهزة المتصلة الآن: ${(snap.routerState as any)?.online_count ?? top.length}\n` +
        `• أنشط الأجهزة حالياً: ${top.map((d) => `${d.label} (↓ ${(Number(d.down_speed_bps || 0) / 1024).toFixed(0)} KB/s)`).join(' ، ') || 'لا يوجد سحب نشط'}\n` +
        `• استهلاك الدورة: ${q.usedGb} GB (معدل ${q.dailyBurnGb} GB/يوم)\n` +
        `• التنبيهات المفتوحة: ${snap.activeAlertsCount}`,
      sqlQueriesRun,
      proposedActions,
      modelUsed: 'local-assistant',
    };
  }

  const ai = new GoogleGenAI({ apiKey });

  // Build compact device token directory so Gemini can query SQLite by token -> mapped cleanly
  const deviceDirectory = db.prepare(`
    SELECT mac, COALESCE(custom_label, router_remark, hostname, mac) AS label, vendor, category
    FROM devices
    ORDER BY last_seen DESC
    LIMIT 60
  `).all() as Array<{ mac: string; label: string; vendor: string | null; category: string | null }>;

  const tokenCatalog = deviceDirectory.map((d) => ({
    token: sanitizer.registerMac(d.mac, d.label),
    vendor: d.vendor,
    category: d.category,
  }));

  const liveSnapSanitized = sanitizer.sanitizeValue(buildNetworkLiveSnapshot(db));
  const focusedToken = params.pageContext?.focusedMac
    ? sanitizer.registerMac(params.pageContext.focusedMac)
    : null;

  const systemInstruction = `أنت "Tenda AI Copilot" مهندس الشبكة الذكي لمراقب راوتر Tenda W30E ثنائي خطوط الإنترنت (WAN1 / WAN2).
قواعد العمل الصارمة:
1. تحدث بالعربية الواضحة المختصرة (أو باللهجة المصرية الودودة الواضحة).
2. لديك أداة \`query_network_sqlite\` لتنفيذ أي استعلام SQL للقراءة فقط على قاعدة البيانات للإجابة بأرقام حقيقية ١٠٠٪ دون تخمين.
   ملاحظة هامة للاستعلامات: إذا أردت الاستعلام عن جهاز مثل DEV_01 فاكتب DEV_01 داخل جملة الـ SQL وسيقوم الخادم المحلي بترجمته لعنوان الـ MAC الحقيقي قبل التنفيذ ثم إعادة ترميز النتائج!
3. لا تقم بتغيير إعدادات الراوتر مباشرة؛ إذا طلب المستخدم تعديل سرعة (QoS) أو نقل جهاز بين WAN1/WAN2 أو تثبيت DHCP أو تجاهل تنبيه، استدعِ أداة \`propose_router_action\` لإصدار بطاقة تنفيذ آمنة يعتمدها المالك بضغطة زر.
4. التزم بحدود القياس من الراوتر فقط؛ تذكر أن راوتر Tenda W30E يقيس التحميل من عداد الجلسة ويقدّر الرفع من السرعات اللحظية، ولا يفصل محلياً بين LAN و WAN إلا بمقارنة التوقيت مع جدول wan_samples.
5. حافظ على الرموز المؤقتة مثل DEV_01 و IP_01 كما هي في إجابتك حتى يفكّها النظام محلياً بالأسماء الحقيقية للمالك.

${ALLOWED_READONLY_SCHEMA_SUMMARY}

دليل رموز الأجهزة الحالية:
${JSON.stringify(tokenCatalog)}

سياق الصفحة الحالية: pathname=${params.pageContext?.pathname ?? '/'}, focusedDevice=${focusedToken ?? 'none'}
لقطة الشبكة الحية:
${JSON.stringify(liveSnapSanitized)}`;

  const tools: any[] = [
    {
      type: 'function',
      name: 'query_network_sqlite',
      description:
        'Execute a single read-only SQLite SELECT/WITH query against tenda.db to answer historical or live traffic, session, WAN, alert, or outage questions.',
      parameters: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'Read-only SQLite SELECT or WITH query (max 80 rows). You may use DEV_XX tokens directly in WHERE clauses.',
          },
        },
        required: ['sql'],
      },
    },
    {
      type: 'function',
      name: 'propose_router_action',
      description:
        'Create a human-in-the-loop confirmation card to change a device QoS speed limit, switch WAN1/WAN2 routing, reserve DHCP IP, or dismiss an alert.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['set_qos', 'move_wan', 'reserve_dhcp', 'dismiss_alert'],
          },
          label_ar: { type: 'string', description: 'Short Arabic button label describing the exact change.' },
          mac_token: { type: 'string', description: 'Device token such as DEV_01.' },
          download_limit_kbs: { type: 'number', description: 'Download cap in KB/s (0=unlimited, 256=SD, 2048=HD).' },
          upload_limit_kbs: { type: 'number', description: 'Upload cap in KB/s (0=unlimited, 64=SD, 512=HD).' },
          wan_port: { type: 'number', enum: [1, 2], description: 'Target WAN port (1 or 2).' },
          alert_id: { type: 'number', description: 'Alert ID if dismissing an alert.' },
        },
        required: ['kind', 'label_ar'],
      },
    },
  ];

  const cleanUserMessage = String(params?.message ?? '').trim();
  if (!cleanUserMessage) {
    return {
      replyAr: 'اكتب سؤالك عن حالة الشبكة أو الأجهزة وسأفحص البيانات فوراً.',
      sqlQueriesRun,
      proposedActions,
      modelUsed: 'local-assistant',
    };
  }

  const steps: any[] = [];
  for (const h of (params.history ?? []).slice(-8)) {
    const hc = String(h?.content ?? '').trim();
    if (!hc) continue;
    steps.push({
      type: h.role === 'user' ? 'user_input' : 'model_output',
      content: [{ type: 'text', text: sanitizer.sanitizeText(hc) }],
    });
  }
  steps.push({
    type: 'user_input',
    content: [{ type: 'text', text: sanitizer.sanitizeText(cleanUserMessage) }],
  });

  // Up to 4 tool-call rounds
  for (let round = 0; round < 4; round++) {
    const interaction = await ai.interactions.create({
      model: GEMINI_MODELS.copilot,
      store: false,
      system_instruction: systemInstruction,
      tools,
      input: steps,
    });

    const outSteps = Array.isArray((interaction as any).steps) ? (interaction as any).steps : [];
    const fnCalls = outSteps.filter((s: any) => s?.type === 'function_call');

    if (fnCalls.length === 0) {
      const rawReply = (interaction.output_text ?? '').trim();
      return {
        replyAr: sanitizer.detokenizeText(rawReply || 'تم تنفيذ الفحص المطلوب.'),
        sqlQueriesRun,
        proposedActions,
        modelUsed: GEMINI_MODELS.copilot,
      };
    }

    // Preserve thought + function_call steps for multi-step Interactions continuity
    for (const s of outSteps) {
      if (s?.type === 'thought' || s?.type === 'function_call' || s?.type === 'model_output') {
        steps.push(s);
      }
    }

    for (const call of fnCalls) {
      const args = (call.arguments ?? {}) as Record<string, any>;
      if (call.name === 'query_network_sqlite') {
        const rawSqlFromModel = String(args.sql ?? '');
        // Translate DEV_XX / IP_XX tokens back to real MAC/IP ONLY inside local SQLite execution
        const localSql = sanitizer.detokenizeText(rawSqlFromModel, { preferLabelOverMac: false });
        sqlQueriesRun.push(rawSqlFromModel);
        const sqlRes = executeReadOnlySql(localSql, {
          dbPath: params.dbPathForReadOnly,
          existingDbForMemoryTests: params.dbPathForReadOnly ? undefined : db,
          maxRows: 60,
        });
        const sanitizedSqlRes = sanitizer.sanitizeValue(sqlRes);
        steps.push({
          type: 'function_result',
          call_id: call.id,
          name: call.name,
          is_error: !sqlRes.ok,
          result: JSON.stringify(sanitizedSqlRes),
        });
      } else if (call.name === 'propose_router_action') {
        const mapped = mapAiActionToLocal(
          {
            kind: args.kind,
            label_ar: args.label_ar,
            mac_token: args.mac_token,
            download_limit_kbs: args.download_limit_kbs,
            upload_limit_kbs: args.upload_limit_kbs,
            wan_port: args.wan_port,
          },
          sanitizer,
          db,
        );
        if (mapped) {
          if (typeof args.alert_id === 'number') mapped.alertId = args.alert_id;
          proposedActions.push(mapped);
        }
        steps.push({
          type: 'function_result',
          call_id: call.id,
          name: call.name,
          result: JSON.stringify({
            queuedForHumanConfirmation: Boolean(mapped),
            note: 'Action card rendered to owner; await owner click before mutating router.',
          }),
        });
      } else {
        steps.push({
          type: 'function_result',
          call_id: call.id,
          name: call.name,
          is_error: true,
          result: JSON.stringify({ error: `Unknown tool ${call.name}` }),
        });
      }
    }
  }

  return {
    replyAr: 'تم استخراج البيانات وإعداد الإجراءات المقترحة أعلاه.',
    sqlQueriesRun,
    proposedActions,
    modelUsed: GEMINI_MODELS.copilot,
  };
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
