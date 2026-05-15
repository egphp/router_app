'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { Shield, AlertTriangle, RefreshCw, FileText } from 'lucide-react';
import { formatMacShort, timeAgo } from '../../lib/format';

interface Alert {
  id: number; kind: string; mac: string | null; payload: string | null;
  created_at: number; dismissed_at: number | null; device_label: string | null;
}

export default function SecurityPage() {
  const { data: alerts } = useSWR<{ alerts: Alert[] }>('/api/alerts', fetcher, { refreshInterval: 15000 });
  const { data: log, mutate: refreshLog, isValidating } = useSWR<{ ok: boolean; lines: string[]; error?: string }>(
    '/api/router-log', fetcher, { refreshInterval: 0, revalidateOnFocus: false }
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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Shield size={20} className="text-accent-purple" /> Security
        </h1>
      </div>

      <div className="card p-5 animate-fade-in">
        <h2 className="font-semibold mb-2">Detection rules</h2>
        <p className="text-sm text-slate-400 mb-4">
          The monitor watches for these suspicious patterns each cycle. They are heuristics — not a real IDS — but they catch common indicators of compromise that are visible without packet inspection.
        </p>
        <ul className="text-sm space-y-2">
          <Rule name="high_connection_count" desc="Device opens 200+ concurrent connections (possible port-scan, P2P, or torrent client; 500+ is critical)." />
          <Rule name="high_upload" desc="Device sustaining 5+ MB/s outbound (possible data exfiltration, botnet, or backup-in-progress)." />
          <Rule name="hostname_clones" desc="3+ devices broadcasting the same hostname (possible impersonation)." />
          <Rule name="out_of_subnet" desc="Device reports IP outside the LAN subnet (misconfiguration or routing attack)." />
          <Rule name="many_random_macs" desc="8+ devices with randomized MAC addresses (informational — normal for modern phones)." />
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
          <h2 className="font-semibold flex items-center gap-2"><FileText size={16} className="text-accent" /> Router system log</h2>
          <button onClick={() => refreshLog()} disabled={isValidating}
            className="text-xs px-3 py-1.5 rounded bg-bg-elevated border border-bg-border hover:bg-bg-border flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw size={12} className={isValidating ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
        {log?.error && (
          <div className="text-sm text-accent-red bg-accent-red/10 border border-accent-red/30 rounded p-3 mb-3">
            {log.error}
          </div>
        )}
        {log?.lines && log.lines.length > 0 ? (
          <pre className="text-[11px] font-mono bg-bg-elevated p-3 rounded overflow-x-auto max-h-[400px] overflow-y-auto">
            {log.lines.slice(-200).reverse().join('\n')}
          </pre>
        ) : (
          <div className="text-sm text-slate-500 text-center py-6">
            {log === undefined ? 'Click Refresh to load…' : 'Router did not expose a readable system log over the API. This is normal for many Tenda firmware versions.'}
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

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }
