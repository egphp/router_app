#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import {
  ALLOWED_READONLY_SCHEMA_SUMMARY,
  DAY,
  HOUR,
  analyzeWanAndWifiHealth,
  buildNetworkLiveSnapshot,
  computeProactiveQuotaForecast,
  correlateDeviceWindowLanOrWan,
  executeReadOnlySql,
  getDb,
  loadConfig,
  runDataIntegrityWatchdog,
  runMigrations,
} from '@tenda/shared';

export const CHARACTER_LIMIT = 25_000;

enum ResponseFormat {
  MARKDOWN = 'markdown',
  JSON = 'json',
}

let dbReady = false;
function ensureDb() {
  const db = getDb();
  if (!dbReady) {
    const row = db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'ai_device_profiles'`)
      .get() as { ok?: number } | undefined;
    if (!row?.ok) {
      runMigrations(db);
    }
    dbReady = true;
  }
  return db;
}

function formatBytesHuman(bytes: number): string {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = n;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx >= 2 ? 2 : 0)} ${units[idx]}`;
}

function formatBpsHuman(bytesPerSec: number): string {
  const n = Number(bytesPerSec || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 KB/s';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB/s`;
  return `${(n / 1024).toFixed(1)} KB/s`;
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, CHARACTER_LIMIT)}\n\n...[Output truncated at ${CHARACTER_LIMIT} characters. Narrow filters, reduce limit, or use pagination offset.]`,
    truncated: true,
  };
}

function resolveDeviceByMacOrQuery(query: string): {
  mac: string;
  label: string;
  ip: string | null;
  reservedIp: string | null;
} | null {
  const db = ensureDb();
  const q = query.trim();
  if (!q) return null;
  const upper = q.toUpperCase();

  const row = db
    .prepare(
      `SELECT d.mac,
              COALESCE(d.custom_label, d.router_remark, d.hostname, d.mac) AS label,
              (SELECT s.ip FROM samples_raw s WHERE s.mac = d.mac AND s.ip IS NOT NULL ORDER BY s.ts DESC LIMIT 1) AS latest_ip,
              (SELECT r.ip FROM dhcp_reservations r WHERE r.mac = d.mac LIMIT 1) AS reserved_ip
       FROM devices d
       WHERE UPPER(d.mac) = ?
          OR LOWER(COALESCE(d.custom_label, '')) = LOWER(?)
          OR LOWER(COALESCE(d.router_remark, '')) = LOWER(?)
          OR LOWER(COALESCE(d.hostname, '')) = LOWER(?)
          OR LOWER(COALESCE(d.custom_label, '')) LIKE LOWER(?)
          OR LOWER(COALESCE(d.router_remark, '')) LIKE LOWER(?)
          OR LOWER(COALESCE(d.hostname, '')) LIKE LOWER(?)
       ORDER BY CASE WHEN UPPER(d.mac) = ? THEN 0 ELSE 1 END, d.last_seen DESC
       LIMIT 1`,
    )
    .get(upper, q, q, q, `%${q}%`, `%${q}%`, `%${q}%`, upper) as
    | { mac: string; label: string; latest_ip: string | null; reserved_ip: string | null }
    | undefined;

  if (!row) return null;
  return {
    mac: row.mac,
    label: row.label,
    ip: row.latest_ip ?? row.reserved_ip ?? null,
    reservedIp: row.reserved_ip ?? null,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'tenda-mcp-server',
    version: '1.0.0',
  });

  // 1. tenda_get_network_overview
  server.registerTool(
    'tenda_get_network_overview',
    {
      title: 'Get Live Tenda Network Overview',
      description: `Returns a real-time router-only operational snapshot of the Tenda Dual-WAN network, including router uptime, online device count, WAN1/WAN2 link status and flux speeds, today's LAN+WAN consumption, top active devices, undismissed alerts, and active AI QoS schedules.

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  Live router snapshot object with WAN ports, top talkers, alert counts, and quota summary.

Examples:
  - Use when asked: "إيه حالة الراوتر والخطين دلوقتي؟" or "Who is pulling bandwidth right now?"`,
      inputSchema: z.strictObject({
        response_format: z
          .nativeEnum(ResponseFormat)
          .default(ResponseFormat.MARKDOWN)
          .describe("Output format: 'markdown' for human-readable summary or 'json' for structured fields"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => {
      try {
        const db = ensureDb();
        const snapshot = buildNetworkLiveSnapshot(db);
        const forecast = computeProactiveQuotaForecast(db);
        const payload = {
          ...snapshot,
          quotaSummary: {
            cycleUsedBytes: forecast.networkUsedTotalBytes,
            combinedQuotaBytes: forecast.combinedQuotaBytes,
            weightedDailyBurnBytes: forecast.weightedDailyBurnBytes,
            willExhaustBeforeRenewal: forecast.willExhaustBeforeRenewal,
            daysRemainingInCycle: forecast.daysRemainingInCycle,
          },
        };

        if (response_format === ResponseFormat.JSON) {
          const out = truncateText(JSON.stringify(payload, null, 2));
          return {
            content: [{ type: 'text', text: out.text }],
            structuredContent: payload,
          };
        }

        const wanPorts = Array.isArray(snapshot.wanPorts)
          ? (snapshot.wanPorts as Array<Record<string, unknown>>)
          : [];
        const activeTop = Array.isArray(snapshot.topActiveDevices)
          ? (snapshot.topActiveDevices as Array<Record<string, unknown>>)
          : [];

        const lines = [
          `# Tenda Router Live Overview`,
          `- **Online Devices**: ${snapshot.onlineCount ?? 0} / ${snapshot.totalDevices ?? 0}`,
          `- **Undismissed Alerts**: ${snapshot.undismissedAlerts ?? 0}`,
          `- **Cycle Usage**: ${formatBytesHuman(forecast.networkUsedTotalBytes)} / ${formatBytesHuman(forecast.combinedQuotaBytes)} (Daily burn: ${formatBytesHuman(forecast.weightedDailyBurnBytes)}/day)`,
          ``,
          `## Dual-WAN Status`,
          ...(wanPorts.length > 0
            ? wanPorts.map(
                (w) =>
                  `- **${w.wan_name ?? `WAN${w.wan_id}`}**: status=${w.status ?? 'unknown'} · ↓ ${formatBpsHuman(Number(w.down_flux_bps ?? 0))} · ↑ ${formatBpsHuman(Number(w.up_flux_bps ?? 0))}`,
              )
            : ['- No WAN port rows recorded yet.']),
          ``,
          `## Top Active Devices`,
          ...(activeTop.length > 0
            ? activeTop.map(
                (d) =>
                  `- **${d.label ?? d.mac}** (\`${d.mac}\`, IP \`${d.ip ?? 'n/a'}\`): ↓ ${formatBpsHuman(Number(d.down_speed_bps ?? 0))} · ↑ ${formatBpsHuman(Number(d.up_speed_bps ?? 0))} · Today ${formatBytesHuman(Number(d.bytes_today ?? 0))}`,
              )
            : ['- No active devices right now.']),
        ];

        const out = truncateText(lines.join('\n'));
        return {
          content: [{ type: 'text', text: out.text }],
          structuredContent: payload,
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error reading network overview: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // 2. tenda_list_devices
  server.registerTool(
    'tenda_list_devices',
    {
      title: 'List Tenda Network Devices',
      description: `Lists known devices on the Tenda router with pagination, search, online/category filtering, live router speeds, today's bytes, QoS speed caps, Dual-WAN bindings, DHCP reservations, and AI trust profiles.

Args:
  - online_only (boolean): Only return currently online devices (default: false).
  - category (string, optional): Filter by device category (e.g. 'phone', 'tv', 'camera', 'computer', 'iot').
  - search (string, optional): Substring match against label, hostname, vendor, IP, or MAC.
  - limit (number): Page size between 1 and 100 (default: 25).
  - offset (number): Pagination offset >= 0 (default: 0).
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  Paginated list with { total, count, offset, has_more, next_offset, devices }.`,
      inputSchema: z.strictObject({
        online_only: z.boolean().default(false).describe('Only include devices currently online on the router'),
        category: z.string().max(40).optional().describe('Optional category filter such as phone, tv, camera, server'),
        search: z.string().max(100).optional().describe('Optional search substring for label, hostname, IP, vendor, or MAC'),
        limit: z.number().int().min(1).max(100).default(25).describe('Maximum devices to return (1-100)'),
        offset: z.number().int().min(0).default(0).describe('Number of devices to skip for pagination'),
        response_format: z
          .nativeEnum(ResponseFormat)
          .default(ResponseFormat.MARKDOWN)
          .describe("Output format: 'markdown' or 'json'"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ online_only, category, search, limit, offset, response_format }) => {
      try {
        const db = ensureDb();
        const startOfDay = (() => {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          return d.getTime();
        })();
        const startOfHour = (() => {
          const d = new Date();
          d.setMinutes(0, 0, 0);
          return d.getTime();
        })();

        const rows = db
          .prepare(
            `WITH latest AS (
               SELECT mac, MAX(ts) AS ts FROM samples_raw GROUP BY mac
             ),
             today_bytes AS (
               SELECT mac, SUM(bd) AS bd, SUM(bu) AS bu FROM (
                 SELECT mac, bytes_down AS bd, bytes_up AS bu FROM traffic_hour WHERE bucket_ts >= ? AND bucket_ts < ?
                 UNION ALL
                 SELECT mac, bytes_down AS bd, bytes_up AS bu FROM traffic_5min WHERE bucket_ts >= ?
               ) GROUP BY mac
             )
             SELECT d.mac,
                    COALESCE(d.custom_label, d.router_remark, d.hostname, d.mac) AS label,
                    d.hostname,
                    d.vendor,
                    d.category,
                    d.last_seen,
                    COALESCE(s.online, 0) AS online,
                    s.ip,
                    COALESCE(s.down_speed_bps, 0) AS down_speed_bps,
                    COALESCE(s.up_speed_bps, 0) AS up_speed_bps,
                    s.wifi_band,
                    s.wifi_rssi_dbm,
                    COALESCE(tb.bd, 0) AS bytes_down_today,
                    COALESCE(tb.bu, 0) AS bytes_up_today,
                    COALESCE(q.download_limit_kbs, 0) AS download_limit_kbs,
                    COALESCE(q.upload_limit_kbs, 0) AS upload_limit_kbs,
                    wb.wan_port,
                    res.ip AS reserved_ip,
                    ap.trust_tier AS ai_trust_tier,
                    ap.suggested_label AS ai_suggested_label
             FROM devices d
             LEFT JOIN latest l ON l.mac = d.mac
             LEFT JOIN samples_raw s ON s.mac = d.mac AND s.ts = l.ts
             LEFT JOIN today_bytes tb ON tb.mac = d.mac
             LEFT JOIN router_qos_limits q ON q.mac = d.mac
             LEFT JOIN dhcp_reservations res ON res.mac = d.mac
             LEFT JOIN router_wan_bindings wb ON wb.ip = COALESCE(s.ip, res.ip) AND wb.rule_enabled = 1
             LEFT JOIN ai_device_profiles ap ON ap.mac = d.mac
             ORDER BY COALESCE(s.online, 0) DESC, (COALESCE(tb.bd, 0) + COALESCE(tb.bu, 0)) DESC, d.last_seen DESC`,
          )
          .all(startOfDay, startOfHour, startOfHour) as Array<Record<string, unknown>>;

        const q = search?.trim().toLowerCase() ?? '';
        const cat = category?.trim().toLowerCase() ?? '';

        const filtered = rows.filter((r) => {
          if (online_only && Number(r.online ?? 0) !== 1) return false;
          if (cat && String(r.category ?? '').toLowerCase() !== cat) return false;
          if (q) {
            const hay = [r.mac, r.label, r.hostname, r.vendor, r.ip, r.ai_suggested_label]
              .map((v) => String(v ?? '').toLowerCase())
              .join(' ');
            if (!hay.includes(q)) return false;
          }
          return true;
        });

        const total = filtered.length;
        const page = filtered.slice(offset, offset + limit);
        const hasMore = total > offset + page.length;
        const output = {
          total,
          count: page.length,
          offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: offset + page.length } : {}),
          devices: page,
        };

        if (response_format === ResponseFormat.JSON) {
          const out = truncateText(JSON.stringify(output, null, 2));
          return { content: [{ type: 'text', text: out.text }], structuredContent: output };
        }

        const lines = [
          `# Tenda Devices (${page.length} of ${total}, offset ${offset})`,
          ...(page.length === 0
            ? ['No devices matched your filter criteria.']
            : page.map((d) => {
                const status = Number(d.online) === 1 ? '🟢 Online' : '⚪ Offline';
                const cap =
                  Number(d.download_limit_kbs) > 0 || Number(d.upload_limit_kbs) > 0
                    ? `QoS ↓${d.download_limit_kbs}/↑${d.upload_limit_kbs} KB/s`
                    : 'Unlimited';
                return `- **${d.label}** (\`${d.mac}\`) — ${status} · IP \`${d.ip ?? d.reserved_ip ?? 'n/a'}\` · ${d.category ?? 'unknown'} · Today ${formatBytesHuman(Number(d.bytes_down_today) + Number(d.bytes_up_today))} · ${cap}${d.wan_port ? ` · ${d.wan_port}` : ''}${d.ai_trust_tier ? ` · AI:${d.ai_trust_tier}` : ''}`;
              })),
        ];
        const out = truncateText(lines.join('\n'));
        return { content: [{ type: 'text', text: out.text }], structuredContent: output };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error listing devices: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  // 3. tenda_get_device_detail
  server.registerTool(
    'tenda_get_device_detail',
    {
      title: 'Get Detailed Device Telemetry & AI Profile',
      description: `Fetches deep telemetry for a single device by MAC address or label/hostname, including OS/enrichment fingerprint, AI trust profile, randomized-MAC sibling match, DHCP reservation, QoS speed limits, Dual-WAN binding, recent sessions, and 24-hour hourly traffic with LAN-vs-WAN attribution.

Args:
  - device (string): Exact MAC address (e.g. 'AA:BB:CC:11:22:33') or device name/hostname.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').`,
      inputSchema: z.strictObject({
        device: z.string().min(2).max(120).describe('Device MAC address or label/hostname'),
        response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ device, response_format }) => {
      try {
        const resolved = resolveDeviceByMacOrQuery(device);
        if (!resolved) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Device "${device}" was not found. Call tenda_list_devices first to find the exact MAC address or label.`,
              },
            ],
          };
        }
        const db = ensureDb();
        const now = Date.now();
        const mac = resolved.mac;

        const base = db.prepare(`SELECT * FROM devices WHERE mac = ?`).get(mac) as Record<string, unknown>;
        const latestSample = db
          .prepare(`SELECT * FROM samples_raw WHERE mac = ? ORDER BY ts DESC LIMIT 1`)
          .get(mac) as Record<string, unknown> | undefined;
        const enrichment = db
          .prepare(`SELECT os_guess, reverse_dns, device_type, last_check FROM device_enrichment WHERE mac = ?`)
          .get(mac) as Record<string, unknown> | undefined;
        const aiProfile = db
          .prepare(
            `SELECT suggested_label, inferred_category, os_guess, trust_tier, recommended_qos_profile,
                    recommended_down_kbs, recommended_up_kbs, recommended_wan,
                    randomized_match_mac, randomized_similarity, rationale_ar, updated_at
             FROM ai_device_profiles WHERE mac = ?`,
          )
          .get(mac) as Record<string, unknown> | undefined;
        const qos = db.prepare(`SELECT * FROM router_qos_limits WHERE mac = ?`).get(mac) as Record<string, unknown> | undefined;
        const dhcp = db.prepare(`SELECT * FROM dhcp_reservations WHERE mac = ?`).get(mac) as Record<string, unknown> | undefined;
        const wanBinding = resolved.ip
          ? (db
              .prepare(`SELECT * FROM router_wan_bindings WHERE ip = ? AND rule_enabled = 1`)
              .get(resolved.ip) as Record<string, unknown> | undefined)
          : undefined;
        const recentHours = db
          .prepare(
            `SELECT bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps
             FROM traffic_hour
             WHERE mac = ? AND bucket_ts >= ?
             ORDER BY bucket_ts DESC LIMIT 24`,
          )
          .all(mac, now - 24 * HOUR) as Array<{
          bucket_ts: number;
          bytes_down: number;
          bytes_up: number;
          peak_down_bps: number;
          peak_up_bps: number;
        }>;

        const total24h = recentHours.reduce((s, r) => s + Number(r.bytes_down ?? 0) + Number(r.bytes_up ?? 0), 0);
        const corr24h = correlateDeviceWindowLanOrWan(db, total24h, now - 24 * HOUR, now);

        const detail = {
          mac,
          label: resolved.label,
          ip: resolved.ip,
          device: base,
          latestSample: latestSample ?? null,
          enrichment: enrichment ?? null,
          aiProfile: aiProfile ?? null,
          qos: qos ?? null,
          dhcpReservation: dhcp ?? null,
          wanBinding: wanBinding ?? null,
          last24h: {
            totalBytes: total24h,
            lanOrWanAttribution: corr24h.attribution,
            hours: recentHours,
          },
        };

        if (response_format === ResponseFormat.JSON) {
          const out = truncateText(JSON.stringify(detail, null, 2));
          return { content: [{ type: 'text', text: out.text }], structuredContent: detail };
        }

        const lines = [
          `# Device Detail: ${resolved.label} (\`${mac}\`)`,
          `- **Current IP**: \`${resolved.ip ?? 'none'}\` (DHCP Reserved: \`${resolved.reservedIp ?? 'no'}\`)`,
          `- **Vendor / Category**: ${base.vendor ?? 'unknown'} / ${base.category ?? 'unknown'}`,
          `- **Status**: ${latestSample?.online ? '🟢 Online' : '⚪ Offline'} (↓ ${formatBpsHuman(Number(latestSample?.down_speed_bps ?? 0))} / ↑ ${formatBpsHuman(Number(latestSample?.up_speed_bps ?? 0))})`,
          `- **Wi-Fi**: band=${latestSample?.wifi_band ?? 'wired/unknown'}, RSSI=${latestSample?.wifi_rssi_dbm ?? 'n/a'} dBm`,
          `- **QoS Cap**: ↓ ${qos?.download_limit_kbs ?? 0} KB/s · ↑ ${qos?.upload_limit_kbs ?? 0} KB/s`,
          `- **WAN Binding**: ${wanBinding?.wan_port ?? 'auto (load-balanced)'}`,
          `- **Last 24h Traffic**: ${formatBytesHuman(total24h)} (Attribution: \`${corr24h.attribution}\`)`,
          ...(aiProfile
            ? [
                ``,
                `## AI Device Profile`,
                `- **Trust Tier**: ${aiProfile.trust_tier ?? 'n/a'}`,
                `- **Suggested Label**: ${aiProfile.suggested_label ?? 'n/a'}`,
                `- **Recommended QoS / WAN**: ${aiProfile.recommended_qos_profile ?? 'n/a'} / ${aiProfile.recommended_wan ?? 'auto'}`,
                ...(aiProfile.randomized_match_mac
                  ? [`- **Randomized MAC Sibling**: \`${aiProfile.randomized_match_mac}\` (similarity ${Number(aiProfile.randomized_similarity ?? 0).toFixed(2)})`]
                  : []),
                `- **Rationale**: ${aiProfile.rationale_ar ?? 'n/a'}`,
              ]
            : []),
        ];
        const out = truncateText(lines.join('\n'));
        return { content: [{ type: 'text', text: out.text }], structuredContent: detail };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error fetching device detail: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  // 4. tenda_query_readonly_sql
  server.registerTool(
    'tenda_query_readonly_sql',
    {
      title: 'Execute Read-Only Analytical SQLite Query',
      description: `Runs a single strictly read-only SQLite SELECT / WITH query against the Tenda telemetry database (opened with readonly=true and PRAGMA query_only=ON). Mutating statements and auth/secret tables (settings, kv, panel_passkeys, panel_sessions, push_subscriptions) are blocked.

${ALLOWED_READONLY_SCHEMA_SUMMARY}

Args:
  - sql (string): Single SELECT or WITH SQLite query.
  - max_rows (number): Maximum rows to return between 1 and 200 (default: 80).`,
      inputSchema: z.strictObject({
        sql: z.string().min(6).max(4000).describe('Single read-only SELECT or WITH SQLite statement'),
        max_rows: z.number().int().min(1).max(200).default(80).describe('Maximum rows to return (1-200)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sql, max_rows }) => {
      ensureDb();
      const dbPath = loadConfig().dbPath;
      const res = executeReadOnlySql(sql, { dbPath, maxRows: max_rows });
      if (!res.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Read-only SQL rejected: ${res.error ?? 'invalid query'}. Provide a single SELECT/WITH statement on allowed telemetry tables.`,
            },
          ],
          structuredContent: { ...res },
        };
      }
      const out = truncateText(JSON.stringify(res, null, 2));
      return {
        content: [{ type: 'text', text: out.text }],
        structuredContent: { ...res },
      };
    },
  );

  // 5. tenda_diagnose_anomalies_and_outages
  server.registerTool(
    'tenda_diagnose_anomalies_and_outages',
    {
      title: 'Diagnose WAN/Wi-Fi Health, Outages, Syslog Clusters & Data Integrity',
      description: `Runs a full diagnostic sweep across Dual-WAN balance/DHCP drift, weak Wi-Fi RSSI/band placement, recent internet outages, semantic syslog clusters, undismissed security/traffic alerts, and SQLite rollup integrity.

Args:
  - lookback_hours (number): Hours of outages/alerts to inspect between 1 and 168 (default: 24).
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').`,
      inputSchema: z.strictObject({
        lookback_hours: z.number().int().min(1).max(168).default(24).describe('Lookback window in hours (1-168)'),
        response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ lookback_hours, response_format }) => {
      try {
        const db = ensureDb();
        const now = Date.now();
        const since = now - lookback_hours * HOUR;

        const advisory = analyzeWanAndWifiHealth(db, now);
        const integrity = runDataIntegrityWatchdog(db, now);
        const outages = db
          .prepare(`SELECT started_at, ended_at, reason, notes FROM outages WHERE started_at >= ? ORDER BY started_at DESC LIMIT 25`)
          .all(since) as Array<Record<string, unknown>>;
        const alerts = db
          .prepare(
            `SELECT id, kind, mac, payload, created_at FROM alerts
             WHERE dismissed_at IS NULL AND created_at >= ?
             ORDER BY created_at DESC LIMIT 30`,
          )
          .all(since) as Array<Record<string, unknown>>;
        const syslogClusters = db
          .prepare(
            `SELECT cluster_key, sample_message, summary_ar, severity, line_count, last_seen
             FROM ai_syslog_clusters
             ORDER BY last_seen DESC LIMIT 15`,
          )
          .all() as Array<Record<string, unknown>>;

        const report = {
          checkedAt: now,
          lookbackHours: lookback_hours,
          integrity,
          wanFindings: advisory.wanFindings,
          wifiFindings: advisory.wifiFindings,
          outages,
          openAlerts: alerts,
          syslogClusters,
        };

        if (response_format === ResponseFormat.JSON) {
          const out = truncateText(JSON.stringify(report, null, 2));
          return { content: [{ type: 'text', text: out.text }], structuredContent: report };
        }

        const lines = [
          `# Network Diagnostics (Last ${lookback_hours}h)`,
          `- **SQLite Telemetry Integrity**: ${integrity.healthy ? '✅ Healthy' : '⚠️ Issues Detected'} (48h raw samples: ${integrity.rawSamples48h}, open sessions: ${integrity.openSessionsCount})`,
          ...integrity.issues.map((i) => `  - [${i.severity}] ${i.messageAr}`),
          ``,
          `## Dual-WAN & DHCP Drift Findings (${advisory.wanFindings.length})`,
          ...(advisory.wanFindings.length > 0
            ? advisory.wanFindings.map((f) => `- **[${f.severity}] ${f.titleAr}**: ${f.detailAr}`)
            : ['- No WAN or DHCP drift issues detected.']),
          ``,
          `## Wi-Fi Placement & RSSI Findings (${advisory.wifiFindings.length})`,
          ...(advisory.wifiFindings.length > 0
            ? advisory.wifiFindings.map((w) => `- **${w.label}** (\`${w.mac}\`, ${w.band ?? 'wifi'}, ${w.rssiDbm ?? '?'} dBm): ${w.adviceAr}`)
            : ['- All wireless clients have healthy signal levels.']),
          ``,
          `## Recent Outages (${outages.length}) & Open Alerts (${alerts.length})`,
          ...outages.slice(0, 10).map((o) => `- Outage at ${new Date(Number(o.started_at)).toISOString()} (${o.reason ?? 'wan_down'})`),
          ...alerts.slice(0, 10).map((a) => `- Alert #${a.id} \`${a.kind}\` (${a.mac ?? 'network'})`),
        ];
        const out = truncateText(lines.join('\n'));
        return { content: [{ type: 'text', text: out.text }], structuredContent: report };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error running diagnostics: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  // 6. tenda_get_quota_forecast
  server.registerTool(
    'tenda_get_quota_forecast',
    {
      title: 'Get Dual-WAN Monthly Quota Burn Forecast',
      description: `Computes proactive monthly ISP quota burn-rate projections across WAN1, WAN2, and combined network traffic, including days until exhaustion before billing renewal, top cycle consumers, and estimated GB saved if Smart TVs/heavy streamers are capped at HD.

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').`,
      inputSchema: z.strictObject({
        response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => {
      try {
        const db = ensureDb();
        const forecast = computeProactiveQuotaForecast(db);

        if (response_format === ResponseFormat.JSON) {
          const out = truncateText(JSON.stringify(forecast, null, 2));
          return { content: [{ type: 'text', text: out.text }], structuredContent: { ...forecast } };
        }

        const lines = [
          `# Monthly ISP Quota Forecast`,
          `- **Summary**: ${forecast.summaryAr}`,
          `- **Cycle Progress**: ${forecast.daysElapsed.toFixed(1)} days elapsed · ${forecast.daysRemainingInCycle.toFixed(1)} days until renewal (day ${forecast.renewalDay})`,
          `- **Total Network Used**: ${formatBytesHuman(forecast.networkUsedTotalBytes)} / ${formatBytesHuman(forecast.combinedQuotaBytes)}`,
          `- **Weighted Burn Rate**: ${formatBytesHuman(forecast.weightedDailyBurnBytes)}/day`,
          `- **Projected Cycle End**: ${formatBytesHuman(forecast.projectedCycleTotalBytes)} (${forecast.willExhaustBeforeRenewal ? '⚠️ Projected to exhaust early' : '✅ Within quota'})`,
          `- **Estimated HD-Cap Savings**: ${formatBytesHuman(forecast.potentialHdCapSavingsBytes)}`,
          ``,
          `## Per-WAN Breakdown`,
          ...forecast.wans.map(
            (w) =>
              `- **WAN${w.wanId}**: Used ${formatBytesHuman(w.usedBytesCycle)} / ${formatBytesHuman(w.quotaBytes)} · Burn ${formatBytesHuman(w.dailyBurnBytesWeighted)}/day · ${w.willExhaustBeforeRenewal ? `⚠️ Shortfall ${w.daysShortfall.toFixed(1)}d` : '✅ Safe'}`,
          ),
          ``,
          `## Top Cycle Consumers`,
          ...forecast.topConsumers.map(
            (c) => `- **${c.label}** (\`${c.mac}\`, ${c.category ?? 'device'}): ${formatBytesHuman(c.totalBytes)} (${c.sharePct.toFixed(1)}%)`,
          ),
        ];
        const out = truncateText(lines.join('\n'));
        return { content: [{ type: 'text', text: out.text }], structuredContent: { ...forecast } };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error computing quota forecast: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  // 7. tenda_set_device_control
  server.registerTool(
    'tenda_set_device_control',
    {
      title: 'Apply Safe Router QoS, Dual-WAN Binding, or DHCP Reservation',
      description: `Safely applies router traffic controls for a specific device via the local Tenda poller control plane (127.0.0.1). Supports setting download/upload speed caps in KB/s (0 = unlimited, max 38400 KB/s), binding the device to WAN1/WAN2/auto, or toggling static DHCP IP reservation. Never exposes router credentials or modifies admin/SSH settings.

Args:
  - device (string): Device MAC address (preferred) or exact device label.
  - download_limit_kbs (number, optional): Download cap in KB/s (0 = unlimited, e.g. 640 for HD, 256 for SD).
  - upload_limit_kbs (number, optional): Upload cap in KB/s (0 = unlimited, e.g. 256 for HD, 64 for SD).
  - wan_port ('WAN1' | 'WAN2' | 'auto', optional): Route device traffic via WAN1, WAN2, or automatic load balancing.
  - dhcp_reserved (boolean, optional): Reserve the device's current LAN IPv4 address in router DHCP.`,
      inputSchema: z.strictObject({
        device: z.string().min(2).max(120).describe('Target device MAC address or exact device label'),
        download_limit_kbs: z
          .number()
          .int()
          .min(0)
          .max(38400)
          .optional()
          .describe('Download speed cap in KB/s (0 = unlimited, max 38400)'),
        upload_limit_kbs: z
          .number()
          .int()
          .min(0)
          .max(38400)
          .optional()
          .describe('Upload speed cap in KB/s (0 = unlimited, max 38400)'),
        wan_port: z.enum(['WAN1', 'WAN2', 'auto']).optional().describe("Bind device to 'WAN1', 'WAN2', or 'auto'"),
        dhcp_reserved: z.boolean().optional().describe('Set true to reserve current LAN IPv4 in DHCP, or false to unreserve'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ device, download_limit_kbs, upload_limit_kbs, wan_port, dhcp_reserved }) => {
      try {
        const wantsQos = download_limit_kbs !== undefined || upload_limit_kbs !== undefined;
        const wantsWan = wan_port !== undefined;
        const wantsDhcp = dhcp_reserved !== undefined;
        if (!wantsQos && !wantsWan && !wantsDhcp) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'No control parameters provided. Specify download_limit_kbs/upload_limit_kbs, wan_port, and/or dhcp_reserved.',
              },
            ],
          };
        }

        const resolved = resolveDeviceByMacOrQuery(device);
        if (!resolved) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Device "${device}" not found in SQLite. Call tenda_list_devices first to verify the MAC address.`,
              },
            ],
          };
        }

        const db = ensureDb();
        const existingQos = db
          .prepare(`SELECT download_limit_kbs, upload_limit_kbs FROM router_qos_limits WHERE mac = ?`)
          .get(resolved.mac) as { download_limit_kbs?: number; upload_limit_kbs?: number } | undefined;

        const payload: Record<string, unknown> = {
          mac: resolved.mac,
          ip: resolved.ip ?? undefined,
          labelHint: resolved.label,
          remark: resolved.label,
        };
        if (wantsQos) {
          payload.downloadLimitKBs = download_limit_kbs ?? Number(existingQos?.download_limit_kbs ?? 0);
          payload.uploadLimitKBs = upload_limit_kbs ?? Number(existingQos?.upload_limit_kbs ?? 0);
        }
        if (wantsWan) {
          if (!resolved.ip) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Cannot change WAN binding for ${resolved.label} (${resolved.mac}) because it has no known LAN IPv4 address yet.`,
                },
              ],
            };
          }
          payload.wanPort = wan_port;
        }
        if (wantsDhcp) {
          payload.dhcpReserved = dhcp_reserved;
        }

        const controlPort = Number(process.env.CONTROL_PORT || 3031);
        const resp = await fetch(`http://127.0.0.1:${controlPort}/device-control`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }))) as Record<
          string,
          unknown
        >;

        if (!resp.ok || !json.ok) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Poller rejected device control for ${resolved.label} (${resolved.mac}): ${String(json.error ?? resp.statusText)}`,
              },
            ],
            structuredContent: json,
          };
        }

        const resultObj = {
          ok: true,
          mac: resolved.mac,
          label: resolved.label,
          ip: resolved.ip,
          applied: json,
        };
        return {
          content: [
            {
              type: 'text',
              text: `Successfully updated router controls for ${resolved.label} (${resolved.mac}): ${JSON.stringify(payload)}`,
            },
          ],
          structuredContent: resultObj,
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to reach local Tenda poller control plane: ${err instanceof Error ? err.message : String(err)}. Ensure tenda-poller is running on 127.0.0.1:${process.env.CONTROL_PORT || 3031}.`,
            },
          ],
        };
      }
    },
  );

  return server;
}

async function runHttp(): Promise<void> {
  const port = Number.parseInt(process.env.MCP_PORT ?? process.env.PORT ?? '3032', 10);
  const app = createMcpExpressApp();
  const handler = createMcpHandler(createServer);
  app.all('/mcp', toNodeHandler(handler));
  app.listen(port, '127.0.0.1', () => {
    console.error(`[tenda-mcp-server] Streamable HTTP listening on http://127.0.0.1:${port}/mcp`);
  });
}

const isDirectEntry = (() => {
  try {
    if (!process.argv[1]) return false;
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectEntry) {
  (async () => {
    const transport = (process.env.TRANSPORT ?? 'stdio').toLowerCase();
    if (transport === 'http') {
      await runHttp();
    } else {
      serveStdio(createServer);
    }
  })().catch((err: unknown) => {
    console.error('[tenda-mcp-server] fatal error:', err);
    process.exit(1);
  });
}
