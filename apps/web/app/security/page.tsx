'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { Shield, AlertTriangle, RefreshCw, FileText, Wifi } from 'lucide-react';
import { formatMacShort, timeAgo } from '../../lib/format';

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
  const grouped = useMemo(() => {
    const g: Record<string, { count: number; severity: string; latest: number; example: any }> = {};
    for (const a of securityAlerts) {
      const p = a.payload ? safeParse(a.payload) : null;
      const rule = p?.rule ?? 'unknown';
      const e = g[rule] ?? { count: 0, severity: p?.severity ?? 'info', latest: 0, example: p };
      e.count++;
      e.latest = Math.max(e.latest, a.created_at);
      g[rule] = e;
    }
    return Object.entries(g).map(([rule, info]) => ({ rule, ...info }));
  }, [securityAlerts]);

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
          <Rule name="many_random_macs" desc="8+ devices with randomized MACs (normal for modern phones)." />
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
            {grouped.map((g) => (
              <div key={g.rule} className={`px-3 py-2.5 rounded border-l-4 ${
                g.severity === 'critical' ? 'bg-accent-red/10 border-l-accent-red' :
                g.severity === 'warn' ? 'bg-accent-amber/10 border-l-accent-amber' :
                'bg-accent/10 border-l-accent'
              }`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{g.rule.replace(/_/g, ' ')}</span>
                  <span className="text-xs uppercase tracking-wide font-semibold">{g.severity}</span>
                </div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {g.count} occurrence{g.count > 1 ? 's' : ''} · latest {timeAgo(g.latest)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card p-5 animate-fade-in">
        <div className="flex items-center justify-between mb-3">
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
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
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
