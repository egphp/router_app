'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { Shield, AlertTriangle, RefreshCw, FileText, Wifi, ChevronDown, ChevronRight } from 'lucide-react';
import { formatMacShort, timeAgo } from '../../lib/format';
import { AffectedDeviceList, type AffectedDevice } from '../../components/SecurityFindingDetails';

interface Alert {
  id: number; kind: string; mac: string | null; payload: string | null;
  created_at: number; dismissed_at: number | null; device_label: string | null;
}
interface LogLine { id: number; ts: number; severity: number | null; host: string | null; tag: string | null; message: string; src_ip: string }

const SEVERITY_NAMES = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug'];

export default function SecurityPage() {
  const { data: alerts } = useSWR<{ alerts: Alert[] }>('/api/alerts', fetcher, { refreshInterval: 15000 });
  const { data: log, mutate: refreshLog, isValidating } = useSWR<{ lines: LogLine[] }>(
    '/api/router-log?limit=500', fetcher, { refreshInterval: 30000 }
  );

  const securityAlerts = useMemo(() =>
    (alerts?.alerts ?? []).filter((a) => a.kind === 'security' && !a.dismissed_at),
    [alerts]
  );

  interface FindingEntry {
    alertId: number;
    mac: string | null;
    deviceLabel: string | null;
    message: string;
    detail: any;
    createdAt: number;
  }
  interface FindingGroup {
    rule: string;
    severity: string;
    latest: number;
    entries: FindingEntry[];
  }
  const grouped = useMemo<FindingGroup[]>(() => {
    const g: Record<string, FindingGroup> = {};
    for (const a of securityAlerts) {
      const p = a.payload ? safeParse(a.payload) : null;
      const rule = p?.rule ?? 'unknown';
      const entry: FindingEntry = {
        alertId: a.id,
        mac: a.mac,
        deviceLabel: a.device_label,
        message: p?.message ?? rule,
        detail: p?.detail ?? null,
        createdAt: a.created_at,
      };
      const bucket = g[rule] ?? { rule, severity: p?.severity ?? 'info', latest: 0, entries: [] };
      bucket.entries.push(entry);
      bucket.latest = Math.max(bucket.latest, a.created_at);
      // promote severity if any entry is more severe
      if (p?.severity === 'critical') bucket.severity = 'critical';
      else if (p?.severity === 'warn' && bucket.severity === 'info') bucket.severity = 'warn';
      g[rule] = bucket;
    }
    return Object.values(g).sort((a, b) => b.latest - a.latest);
  }, [securityAlerts]);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (rule: string) => setExpanded((s) => ({ ...s, [rule]: !s[rule] }));

  const lines = log?.lines ?? [];

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold flex items-center gap-2">
        <Shield size={20} className="text-accent-purple" /> Security
      </h1>

      <div className="card p-5 animate-fade-in">
        <h2 className="font-semibold mb-2">Detection rules</h2>
        <p className="text-sm text-slate-400 mb-4">
          The monitor watches these patterns each cycle. They are heuristics — catching common signs of compromise without packet inspection.
        </p>
        <ul className="text-sm space-y-2">
          <Rule name="high_connection_count" desc="Device opens 200+ concurrent connections (port-scan, P2P, torrent; 500+ critical)." />
          <Rule name="high_upload" desc="Device sustaining 5+ MB/s outbound (data exfiltration, botnet, backup)." />
          <Rule name="hostname_clones" desc="3+ devices broadcasting the same hostname (impersonation)." />
          <Rule name="out_of_subnet" desc="Device reports IP outside the LAN subnet (misconfig or routing attack)." />
          <Rule name="random_mac_device" desc="Device uses a randomized/locally-administered MAC address (normal for modern phones; one info finding per device, dismiss to silence)." />
        </ul>
      </div>

      <div className="card p-5 animate-fade-in">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold flex items-center gap-2"><AlertTriangle size={16} className="text-accent-amber" /> Active findings</h2>
          <span className="text-xs text-slate-500">{securityAlerts.length} unacknowledged</span>
        </div>
        {grouped.length === 0 ? (
          <div className="text-sm text-slate-500 text-center py-6">No security findings. The network looks normal.</div>
        ) : (
          <div className="space-y-2">
            {grouped.map((g) => {
              const isOpen = !!expanded[g.rule];
              const tone =
                g.severity === 'critical' ? 'bg-accent-red/10 border-l-accent-red' :
                g.severity === 'warn' ? 'bg-accent-amber/10 border-l-accent-amber' :
                'bg-accent/10 border-l-accent';
              return (
                <div key={g.rule} className={`rounded border-l-4 ${tone}`}>
                  <button
                    type="button"
                    onClick={() => toggle(g.rule)}
                    className="w-full text-left px-3 py-2.5 hover:bg-bg-elevated/30 transition flex items-center gap-2"
                  >
                    <span className="text-slate-500">
                      {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{g.rule.replace(/_/g, ' ')}</span>
                        <span className="text-xs uppercase tracking-wide font-semibold">{g.severity}</span>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {g.entries.length} {g.entries.length > 1 ? 'devices' : 'device'} affected · latest {timeAgo(g.latest)}
                      </div>
                    </div>
                  </button>
                  {isOpen && <FindingDetails group={g} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card p-5 animate-fade-in">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <FileText size={16} className="text-accent" /> Router syslog
            <span className="text-xs text-slate-500 font-normal">({lines.length} entries)</span>
          </h2>
          <button onClick={() => refreshLog()} disabled={isValidating}
            className="text-xs px-3 py-1.5 rounded bg-bg-elevated border border-bg-border hover:bg-bg-border flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw size={12} className={isValidating ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
        {lines.length === 0 ? (
          <div className="text-sm text-slate-500 py-6 space-y-3">
            <p className="text-center">No syslog entries yet.</p>
            <div className="bg-bg-elevated rounded p-3 text-xs">
              <p className="text-slate-300 mb-1.5 font-semibold flex items-center gap-1.5">
                <Wifi size={12} /> Enable syslog forwarding:
              </p>
              <ol className="list-decimal list-inside text-slate-400 space-y-1">
                <li>Open <a href="http://192.168.0.1/index.html?v=5042#logaudit" target="_blank" className="text-accent hover:underline">router Log Audit page</a></li>
                <li>Log Settings tab → enable <code className="bg-bg-card px-1">logs</code>, <code className="bg-bg-card px-1">url</code>, <code className="bg-bg-card px-1">access</code></li>
                <li>Log Storage tab → Storage Mode = <strong>Local Storage</strong>, Host IP = <strong>this machine's IP</strong>, Save</li>
                <li>On macOS: run <code className="bg-bg-card px-1">sudo bash deploy/syslog-redirect.sh</code> once to forward 514 → 5140 (the router sends to 514; the daemon listens on 5140 since 514 requires root)</li>
              </ol>
            </div>
          </div>
        ) : (
          <div className="bg-bg-elevated rounded overflow-hidden">
            <div className="max-h-[500px] divide-y divide-bg-border/40 overflow-y-auto sm:hidden">
              {lines.map((l) => (
                <article key={l.id} className="p-3 font-mono text-xs">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-slate-400">{new Date(l.ts).toLocaleTimeString()}</div>
                      <div className="mt-1 break-all text-accent">{l.tag ?? '-'}</div>
                    </div>
                    <span className={`shrink-0 rounded border border-bg-border bg-bg-card px-2 py-1 ${severityClass(l.severity)}`}>
                      {SEVERITY_NAMES[l.severity ?? 6] ?? '?'}
                    </span>
                  </div>
                  <div className="mt-2 break-words text-slate-200">{l.message}</div>
                </article>
              ))}
            </div>
            <div className="hidden max-h-[500px] overflow-x-auto overflow-y-auto sm:block">
              <table className="w-full text-xs font-mono">
                <thead className="bg-bg-card/60 sticky top-0">
                  <tr className="text-slate-500">
                    <th className="px-3 py-1.5 text-left">Time</th>
                    <th className="px-3 py-1.5 text-left">Sev</th>
                    <th className="px-3 py-1.5 text-left">Tag</th>
                    <th className="px-3 py-1.5 text-left">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className="border-t border-bg-border/40">
                      <td className="px-3 py-1 text-slate-400 whitespace-nowrap">{new Date(l.ts).toLocaleTimeString()}</td>
                      <td className={`px-3 py-1 ${severityClass(l.severity)}`}>{SEVERITY_NAMES[l.severity ?? 6] ?? '?'}</td>
                      <td className="px-3 py-1 text-accent">{l.tag ?? '-'}</td>
                      <td className="px-3 py-1 text-slate-200 break-all">{l.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface FindingGroup {
  rule: string;
  severity: string;
  latest: number;
  entries: Array<{
    alertId: number;
    mac: string | null;
    deviceLabel: string | null;
    message: string;
    detail: any;
    createdAt: number;
  }>;
}

/**
 * Render the affected-device list for a finding group. Picks the right shape
 * based on the rule (random_mac_device is per-device, hostname_clones groups
 * many MACs under one alert).
 */
function FindingDetails({ group }: { group: FindingGroup }) {
  // hostname_clones: one alert holds many MACs in detail.devices
  if (group.rule === 'hostname_clones') {
    const devices: AffectedDevice[] = [];
    for (const e of group.entries) {
      const list: AffectedDevice[] = e.detail?.devices ?? [];
      for (const d of list) devices.push(d);
    }
    const hostname = group.entries[0]?.detail?.hostname;
    return (
      <div className="px-3 pb-3">
        {hostname && (
          <div className="text-xs text-slate-400 mb-2">
            Sharing hostname <code className="bg-bg-elevated px-1.5 py-0.5 rounded">{hostname}</code>
          </div>
        )}
        <AffectedDeviceList devices={devices} emptyHint="No device list available for this finding." />
      </div>
    );
  }

  // random_mac_device, high_connection_count, high_upload, out_of_subnet:
  // each entry IS a single device — collect them and render.
  const devices: AffectedDevice[] = group.entries.map((e) => {
    const detail = e.detail ?? {};
    return {
      mac: detail.mac ?? e.mac ?? '',
      ip: detail.ip ?? null,
      hostname: detail.hostname ?? null,
      router_remark: detail.router_remark ?? e.deviceLabel,
      vendor: detail.vendor ?? null,
      category: detail.category ?? null,
    };
  }).filter((d) => d.mac);

  // Per-entry extra context (e.g. connection count, upload speed)
  const extras: Record<string, string> = {};
  for (const e of group.entries) {
    if (!e.mac || !e.detail) continue;
    if (group.rule === 'high_connection_count' && e.detail.connections != null) {
      extras[e.mac] = `${e.detail.connections} connections`;
    } else if (group.rule === 'high_upload' && e.detail.up_human) {
      extras[e.mac] = e.detail.up_human;
    } else if (group.rule === 'out_of_subnet' && e.detail.expected_subnet) {
      extras[e.mac] = `expected ${e.detail.expected_subnet}`;
    }
  }

  return (
    <div className="px-3 pb-3">
      {devices.length === 0 ? (
        <div className="text-xs text-slate-500 italic">
          This finding has no device details (older format). Newer findings will list every MAC.
        </div>
      ) : (
        <>
          <AffectedDeviceList devices={devices} />
          {Object.keys(extras).length > 0 && (
            <div className="mt-2 text-[10px] text-slate-500">
              {Object.entries(extras).map(([mac, text]) => (
                <div key={mac} className="font-mono">
                  {formatMacShort(mac)} · {text}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Rule({ name, desc }: { name: string; desc: string }) {
  return (
    <li className="flex gap-3">
      <code className="text-xs bg-bg-elevated rounded px-2 py-0.5 text-accent-purple shrink-0 self-start mt-0.5">{name}</code>
      <span className="text-slate-300">{desc}</span>
    </li>
  );
}

function severityClass(sev: number | null): string {
  if (sev === null) return 'text-slate-500';
  if (sev <= 3) return 'text-accent-red';
  if (sev === 4) return 'text-accent-amber';
  if (sev === 5) return 'text-accent-purple';
  return 'text-slate-500';
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }
