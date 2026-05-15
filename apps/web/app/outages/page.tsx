'use client';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { formatDuration, timeAgo } from '../../lib/format';

interface Outage {
  started_at: number; ended_at: number | null; reason: string; notes: string | null;
}

export default function OutagesPage() {
  const { data } = useSWR<{ outages: Outage[] }>('/api/outages', fetcher, { refreshInterval: 15000 });
  const outages = data?.outages ?? [];

  const last30d = Date.now() - 30 * 86400 * 1000;
  const recentOutages = outages.filter((o) => o.started_at >= last30d);
  const totalDowntime = recentOutages.reduce((sum, o) => sum + ((o.ended_at ?? Date.now()) - o.started_at), 0);
  const uptimePct = 100 - (totalDowntime / (30 * 86400 * 1000)) * 100;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Outages</h1>
      <div className="card p-5 animate-fade-in">
        <div className="stat-label">Uptime (last 30 days)</div>
        <div className="text-3xl font-bold text-accent-green mt-2 tabular-nums">{uptimePct.toFixed(3)}%</div>
        <div className="text-xs text-slate-500 mt-1">
          Total downtime: {formatDuration(totalDowntime / 1000)} across {recentOutages.length} outages
        </div>
      </div>
      <div className="card overflow-hidden animate-fade-in">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500 bg-bg-elevated/40">
            <tr>
              <th className="px-4 py-2 text-left">Started</th>
              <th className="px-4 py-2 text-left">Duration</th>
              <th className="px-4 py-2 text-left">Reason</th>
              <th className="px-4 py-2 text-left">Notes</th>
            </tr>
          </thead>
          <tbody>
            {outages.map((o) => (
              <tr key={o.started_at} className="border-t border-bg-border">
                <td className="px-4 py-2.5">
                  <div className="text-slate-200">{new Date(o.started_at).toLocaleString()}</div>
                  <div className="text-xs text-slate-500">{timeAgo(o.started_at)}</div>
                </td>
                <td className="px-4 py-2.5 tabular-nums">
                  {o.ended_at ? formatDuration((o.ended_at - o.started_at) / 1000) : <span className="text-accent-red">ongoing</span>}
                </td>
                <td className="px-4 py-2.5"><span className="text-xs bg-bg-elevated rounded px-2 py-1 border border-bg-border">{o.reason}</span></td>
                <td className="px-4 py-2.5 text-xs text-slate-500 max-w-md truncate">{o.notes || '—'}</td>
              </tr>
            ))}
            {outages.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">No outages recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
