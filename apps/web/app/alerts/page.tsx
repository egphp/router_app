'use client';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { formatMacShort, timeAgo } from '../../lib/format';
import { Bell, Smartphone, WifiOff, RefreshCw } from 'lucide-react';

interface Alert {
  id: number; kind: string; mac: string | null; payload: string | null;
  created_at: number; dismissed_at: number | null; device_label: string | null;
}

export default function AlertsPage() {
  const { data, mutate } = useSWR<{ alerts: Alert[] }>('/api/alerts', fetcher, { refreshInterval: 10000 });
  const alerts = data?.alerts ?? [];

  const dismiss = async (id: number) => {
    await fetch('/api/alerts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    mutate();
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Alerts</h1>
      <div className="space-y-2">
        {alerts.length === 0 && (
          <div className="card p-8 text-center text-slate-500 animate-fade-in">No alerts.</div>
        )}
        {alerts.map((a) => {
          const payload = a.payload ? safeParse(a.payload) : null;
          const isDismissed = !!a.dismissed_at;
          return (
            <div key={a.id} className={`card p-4 flex items-start gap-3 animate-fade-in ${isDismissed ? 'opacity-50' : ''}`}>
              <div className="mt-1">
                {a.kind === 'new_device' && <Smartphone className="text-accent-red" size={18} />}
                {a.kind === 'outage' && <WifiOff className="text-accent-amber" size={18} />}
                {a.kind === 'reboot' && <RefreshCw className="text-accent-purple" size={18} />}
              </div>
              <div className="flex-1">
                <div className="font-medium">{titleFor(a, payload)}</div>
                <div className="text-xs text-slate-500 mt-1">
                  {a.mac && <span>MAC {formatMacShort(a.mac)} · </span>}
                  {timeAgo(a.created_at)}
                </div>
                {payload && <pre className="mt-2 text-[10px] text-slate-500 whitespace-pre-wrap font-mono">{JSON.stringify(payload, null, 2)}</pre>}
              </div>
              {!isDismissed && (
                <button onClick={() => dismiss(a.id)}
                  className="text-xs px-3 py-1.5 rounded bg-bg-elevated border border-bg-border hover:bg-bg-border">
                  Dismiss
                </button>
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
      return `Router unreachable (${payload?.reason ?? 'unknown'})`;
    case 'reboot':
      return 'Router rebooted';
    default:
      return a.kind;
  }
}
