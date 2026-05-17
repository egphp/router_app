'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { formatMacShort, timeAgo } from '../../lib/format';
import { Bell, Smartphone, WifiOff, RefreshCw, Shield, CheckSquare, X, Filter, Ban, ShieldAlert, Gauge } from 'lucide-react';

interface Alert {
  id: number; kind: string; mac: string | null; payload: string | null;
  created_at: number; dismissed_at: number | null; device_label: string | null;
}

const KINDS = [
  { value: 'all', label: 'All alerts' },
  { value: 'new_device', label: 'New devices' },
  { value: 'outage', label: 'Outages' },
  { value: 'reboot', label: 'Reboots' },
  { value: 'security', label: 'Security' },
  { value: 'attack', label: 'Attacks' },
  { value: 'nsfw', label: 'Adult sites' },
  { value: 'total_download_threshold', label: 'Total limit' },
  { value: 'device_download_threshold', label: 'Device limit' },
];

export default function AlertsPage() {
  const { data, mutate } = useSWR<{ alerts: Alert[] }>('/api/alerts', fetcher, { refreshInterval: 10000 });
  const [filter, setFilter] = useState<string>('all');
  const [showDismissed, setShowDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    let list = data?.alerts ?? [];
    if (!showDismissed) list = list.filter((a) => a.dismissed_at === null);
    if (filter !== 'all') list = list.filter((a) => a.kind === filter);
    return list;
  }, [data, filter, showDismissed]);

  const counts = useMemo(() => {
    const list = data?.alerts ?? [];
    const active = list.filter((a) => a.dismissed_at === null);
    const byKind: Record<string, number> = {};
    for (const a of active) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
    return { total: active.length, byKind };
  }, [data]);

  const callApi = async (action: string, extra: Record<string, any> = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch('/api/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      mutate();
    } finally {
      setBusy(false);
    }
  };

  const dismissOne = async (id: number) => {
    await fetch('/api/alerts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    mutate();
  };

  const ignoreFuture = async (id: number) => {
    await fetch('/api/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ignore_future', id }),
    });
    mutate();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-semibold">Alerts</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => callApi('mark_all_known')} disabled={busy || (counts.byKind.new_device ?? 0) === 0}
            className="px-2.5 sm:px-3 py-1.5 rounded bg-accent-green/10 border border-accent-green/30 text-accent-green text-xs sm:text-sm hover:bg-accent-green/20 disabled:opacity-40 flex items-center gap-1.5">
            <CheckSquare size={14} /> Mark all known
            {counts.byKind.new_device > 0 && <span className="text-[10px] sm:text-xs bg-accent-green/20 px-1.5 rounded">{counts.byKind.new_device}</span>}
          </button>
          <button onClick={() => callApi('dismiss_all')} disabled={busy || counts.total === 0}
            className="px-2.5 sm:px-3 py-1.5 rounded bg-bg-elevated border border-bg-border text-xs sm:text-sm hover:bg-bg-border disabled:opacity-40 flex items-center gap-1.5">
            <X size={14} /> Dismiss all
            {counts.total > 0 && <span className="text-[10px] sm:text-xs bg-bg-border px-1.5 rounded">{counts.total}</span>}
          </button>
        </div>
      </div>

      <div className="card p-3 flex items-center gap-2 animate-fade-in flex-wrap">
        <Filter size={14} className="text-slate-500 shrink-0" />
        <div className="flex gap-1 flex-wrap">
          {KINDS.map((k) => (
            <button key={k.value} onClick={() => setFilter(k.value)}
              className={`px-2.5 sm:px-3 py-1 rounded text-xs ${filter === k.value ? 'bg-accent text-white' : 'bg-bg-elevated text-slate-400 hover:text-slate-100'}`}>
              {k.label}
              {k.value !== 'all' && counts.byKind[k.value] > 0 && (
                <span className="ml-1.5 text-[10px] bg-black/30 rounded px-1">{counts.byKind[k.value]}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0" />
        <label className="text-xs text-slate-400 flex items-center gap-2 cursor-pointer shrink-0">
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)}
            className="accent-blue-500" />
          Show dismissed
        </label>
      </div>

      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="card p-8 text-center text-slate-500 animate-fade-in">No alerts match the current filter.</div>
        )}
        {filtered.map((a) => {
          const payload = a.payload ? safeParse(a.payload) : null;
          const isDismissed = !!a.dismissed_at;
          const tone = severityTone(a.kind, payload);
          return (
            <div key={a.id} className={`card p-4 flex flex-col gap-3 animate-fade-in border-l-4 sm:flex-row sm:items-start ${tone.border} ${isDismissed ? 'opacity-50' : ''}`}>
              <div className="mt-0.5">{iconFor(a.kind, tone.color)}</div>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{titleFor(a, payload)}</div>
                <div className="text-xs text-slate-500 mt-1">
                  {a.mac && <span>MAC {formatMacShort(a.mac)} · </span>}
                  {timeAgo(a.created_at)}
                  {payload?.detail?.ip && <span> · {payload.detail.ip}</span>}
                  {payload?.severity && (
                    <span className={`ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${tone.badge}`}>
                      {payload.severity}
                    </span>
                  )}
                </div>
                {payload?.message && <div className="text-sm mt-1 text-slate-300">{payload.message}</div>}
                {payload?.detail && (
                  <pre className="mt-2 text-[10px] text-slate-500 whitespace-pre-wrap font-mono">{JSON.stringify(payload.detail, null, 2)}</pre>
                )}
              </div>
              {!isDismissed && (
                <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                  <button onClick={() => ignoreFuture(a.id)}
                    className="inline-flex items-center justify-center gap-1.5 rounded border border-accent-amber/30 bg-accent-amber/10 px-3 py-1.5 text-xs text-accent-amber hover:bg-accent-amber/20">
                    <Ban size={12} /> Ignore future
                  </button>
                  <button onClick={() => dismissOne(a.id)}
                    className="rounded bg-bg-elevated border border-bg-border px-3 py-1.5 text-xs hover:bg-bg-border">
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

function titleFor(a: Alert, payload: any): string {
  switch (a.kind) {
    case 'new_device':
      return `New device: ${a.device_label || payload?.hostname || a.mac}`;
    case 'outage':
      return `Router unreachable`;
    case 'reboot':
      return 'Router rebooted';
    case 'security':
      return payload?.message || `Security: ${payload?.rule}`;
    case 'attack':
      return `Router attack: ${payload?.kind || payload?.attack_kind || payload?.rule || 'attack'}`;
    case 'nsfw':
      return `Adult-content visit: ${payload?.domain || 'unknown domain'}`;
    case 'total_download_threshold':
      return 'Total download threshold crossed';
    case 'device_download_threshold':
      return `Device threshold: ${a.device_label || payload?.label || a.mac}`;
    default:
      return a.kind;
  }
}

function iconFor(kind: string, color: string) {
  const props = { size: 18, className: color };
  switch (kind) {
    case 'new_device': return <Smartphone {...props} />;
    case 'outage': return <WifiOff {...props} />;
    case 'reboot': return <RefreshCw {...props} />;
    case 'security': return <Shield {...props} />;
    case 'attack':
    case 'nsfw': return <ShieldAlert {...props} />;
    case 'total_download_threshold':
    case 'device_download_threshold': return <Gauge {...props} />;
    default: return <Bell {...props} />;
  }
}

function severityTone(kind: string, payload: any) {
  const sev = payload?.severity;
  if (sev === 'critical' || kind === 'outage') return { border: 'border-l-accent-red', color: 'text-accent-red', badge: 'bg-accent-red/20 text-accent-red' };
  if (sev === 'warn' || kind === 'reboot') return { border: 'border-l-accent-amber', color: 'text-accent-amber', badge: 'bg-accent-amber/20 text-accent-amber' };
  if (kind === 'new_device') return { border: 'border-l-accent-red', color: 'text-accent-red', badge: 'bg-accent-red/20 text-accent-red' };
  if (kind === 'attack' || kind === 'nsfw') return { border: 'border-l-accent-red', color: 'text-accent-red', badge: 'bg-accent-red/20 text-accent-red' };
  if (kind === 'total_download_threshold' || kind === 'device_download_threshold') return { border: 'border-l-accent-amber', color: 'text-accent-amber', badge: 'bg-accent-amber/20 text-accent-amber' };
  if (kind === 'security') return { border: 'border-l-accent-purple', color: 'text-accent-purple', badge: 'bg-accent-purple/20 text-accent-purple' };
  return { border: 'border-l-accent', color: 'text-accent', badge: 'bg-accent/20 text-accent' };
}
