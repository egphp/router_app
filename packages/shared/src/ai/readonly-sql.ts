import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';

export interface ReadOnlySqlResult {
  ok: boolean;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  error?: string;
}

const FORBIDDEN_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|SAVEPOINT|RELEASE|BEGIN|COMMIT|ROLLBACK)\b/i;

const FORBIDDEN_TABLES = /\b(settings|kv|panel_passkeys|panel_sessions|panel_auth_challenges|panel_enrollment_windows|push_subscriptions|push_delivery_log|_migrations)\b/i;

export const ALLOWED_READONLY_SCHEMA_SUMMARY = `
Available SQLite read-only tables (timestamps 'ts' / 'bucket_ts' / 'started_at' / 'created_at' are Unix epoch milliseconds):
- devices(mac, router_id, hostname, router_remark, custom_label, vendor, category, first_seen, last_seen, is_new)
- ai_device_profiles(mac, suggested_label, inferred_category, os_guess, trust_tier, recommended_qos_profile, recommended_down_kbs, recommended_up_kbs, recommended_wan, randomized_match_mac, randomized_similarity, rationale_ar)
- samples_raw(mac, ts, ip, online, up_speed_bps, down_speed_bps, down_sum_kb, sessions, online_seconds, connection_kind, wifi_band, wifi_rssi_dbm, wifi_signal_percent, wifi_distance_m)
- traffic_5min(mac, bucket_ts, bytes_down, bytes_up, avg_down_bps, avg_up_bps, peak_down_bps, peak_up_bps, active_sec, sample_count)
- traffic_hour(mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
- traffic_day(mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
- traffic_month(mac, bucket_ts, bytes_down, bytes_up, active_sec, peak_down_bps, peak_up_bps)
- device_sessions(mac, started_at, ended_at, bytes_down, bytes_up, down_counter_base_kb)
- wan_samples(ts, wan_id, up_bytes_per_s, down_bytes_per_s)
- wan_traffic_5min(bucket_ts, bytes_up, bytes_down, sample_count)
- wan_traffic_day(bucket_ts, bytes_up, bytes_down)
- router_wan_ports(wan_id, wan_name, status, wan_type, up_flux_bps, down_flux_bps, public_ip_checked_at, public_ip_changed_at, ddns_synced_at, ddns_last_error)
- router_qos_limits(mac, router_id, ip, download_limit_kbs, upload_limit_kbs, updated_at)
- router_wan_bindings(ip, wan_port, rule_id, rule_enabled, ip_group_name, inherited_from_range)
- dhcp_reservations(mac, ip, hostname, router_id, updated_at)
- alerts(id, kind, mac, payload, created_at, dismissed_at)
- outages(started_at, ended_at, reason, notes)
- router_state(ts, uptime_sec, is_reboot, online_count)
- router_syslog(router_id, ts, log_type, message, attacker_ip, attacker_mac, attack_kind, attack_count)
- router_log(id, ts, priority, facility, severity, host, tag, message, src_ip)
- nsfw_hits(id, ts, source_mac, source_ip, domain, category)
- ai_domain_cache(domain, category, confidence, source, checked_at)
- ai_syslog_clusters(cluster_key, sample_message, summary_ar, severity, line_count, first_seen, last_seen)
`.trim();

export function validateReadOnlySql(sqlRaw: string): { ok: true; cleanedSql: string } | { ok: false; error: string } {
  if (typeof sqlRaw !== 'string') {
    return { ok: false, error: 'SQL query must be a string.' };
  }
  // Strip SQL comments and trailing semicolons
  const withoutComments = sqlRaw
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;+\s*$/, '')
    .trim();

  if (!withoutComments) {
    return { ok: false, error: 'SQL query is empty.' };
  }
  if (withoutComments.includes(';')) {
    return { ok: false, error: 'Only a single SQL statement is allowed.' };
  }
  if (!/^(SELECT|WITH)\b/i.test(withoutComments)) {
    return { ok: false, error: 'Only SELECT / WITH read-only queries are allowed.' };
  }
  if (FORBIDDEN_KEYWORDS.test(withoutComments)) {
    return { ok: false, error: 'Mutating or administrative SQL keywords are forbidden.' };
  }
  if (FORBIDDEN_TABLES.test(withoutComments)) {
    return { ok: false, error: 'Query references a restricted authentication/secrets table.' };
  }
  return { ok: true, cleanedSql: withoutComments };
}

/**
 * Executes a strictly read-only analytical query on SQLite:
 * - Uses a dedicated `readonly: true` connection when backed by disk (`PRAGMA query_only = ON` on in-memory test DBs).
 * - Blocks any secret/auth tables (`settings`, `kv`, `panel_passkeys`, `panel_sessions`, `push_subscriptions`).
 * - Caps returned rows at `maxRows` (default 80, max 200).
 */
export function executeReadOnlySql(
  sqlRaw: string,
  opts: { dbPath?: string; existingDbForMemoryTests?: Database.Database; maxRows?: number } = {},
): ReadOnlySqlResult {
  const checked = validateReadOnlySql(sqlRaw);
  if (!checked.ok) {
    return { ok: false, columns: [], rows: [], rowCount: 0, truncated: false, error: checked.error };
  }

  const maxRows = Math.max(1, Math.min(200, Math.trunc(opts.maxRows ?? 80)));
  let tempConn: Database.Database | null = null;

  try {
    let conn: Database.Database;
    if (opts.existingDbForMemoryTests) {
      conn = opts.existingDbForMemoryTests;
    } else {
      const targetPath = opts.dbPath ?? loadConfig().dbPath;
      tempConn = new Database(targetPath, { readonly: true, fileMustExist: true });
      tempConn.pragma('query_only = ON');
      tempConn.pragma('busy_timeout = 2000');
      conn = tempConn;
    }

    const wrappedSql = `SELECT * FROM (${checked.cleanedSql}) LIMIT ${maxRows + 1}`;
    const prevQueryOnly = opts.existingDbForMemoryTests ? Number(conn.pragma('query_only', { simple: true }) ?? 0) : 1;
    if (opts.existingDbForMemoryTests) {
      conn.pragma('query_only = ON');
    }
    try {
      const stmt = conn.prepare(wrappedSql);
      if (!stmt.reader) {
        return { ok: false, columns: [], rows: [], rowCount: 0, truncated: false, error: 'Statement is not read-only.' };
      }
      const columns = stmt.columns().map((c) => c.name);
      const rawRows = stmt.all() as Array<Record<string, unknown>>;
      const truncated = rawRows.length > maxRows;
      const rows = truncated ? rawRows.slice(0, maxRows) : rawRows;
      return {
        ok: true,
        columns,
        rows,
        rowCount: rows.length,
        truncated,
      };
    } finally {
      if (opts.existingDbForMemoryTests && prevQueryOnly === 0) {
        conn.pragma('query_only = OFF');
      }
    }
  } catch (err) {
    return {
      ok: false,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (tempConn) {
      try {
        tempConn.close();
      } catch {}
    }
  }
}
