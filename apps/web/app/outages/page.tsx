'use client';
import { useMemo } from 'react';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { formatDuration, timeAgo } from '../../lib/format';
import { useTableSort, sortNum, sortStr, SortHeader } from '../../lib/useTableSort';
import { clsx } from 'clsx';

interface Outage {
  started_at: number; ended_at: number | null; reason: string; notes: string | null;
}

type SortKey = 'started' | 'duration' | 'reason';

export default function OutagesPage() {
  const { data } = useSWR<{ outages: Outage[] }>('/api/outages', fetcher, { refreshInterval: 15000 });
  const outages = data?.outages ?? [];
  const { sort, onSort, indicator } = useTableSort<SortKey>(
    'tenda.outages.sort', { key: 'started', dir: 'desc' }
  );

  const sorted = useMemo(() => {
    const list = [...outages];
    const dir = sort.dir;
    list.sort((a, b) => {
      switch (sort.key) {
        case 'started': return sortNum(a.started_at, b.started_at, dir);
        case 'duration': {
          const da = (a.ended_at ?? Date.now()) - a.started_at;
          const db = (b.ended_at ?? Date.now()) - b.started_at;
          return sortNum(da, db, dir);
        }
        case 'reason': return sortStr(a.reason, b.reason, dir);
      }
    });
    return list;
  }, [outages, sort]);

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
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[500px]">
          <thead className="text-xs uppercase tracking-wide text-slate-500 bg-bg-elevated/40">
            <tr>
              <SortHeader label="Started" k="started" sort={sort} onSort={onSort} indicator={indicator} align="left" />
              <SortHeader label="Duration" k="duration" sort={sort} onSort={onSort} indicator={indicator} align="left" />
              <SortHeader label="Reason" k="reason" sort={sort} onSort={onSort} indicator={indicator} align="left" defaultDir="asc" />
              <th className="px-4 py-2 text-left">Notes</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((o) => (
              <tr key={o.started_at} className="border-t border-bg-border">
                <td className={clsx('px-4 py-2.5', sort.key === 'started' && 'col-sorted')}>
                  <div className="text-slate-200">{new Date(o.started_at).toLocaleString()}</div>
                  <div className="text-xs text-slate-500">{timeAgo(o.started_at)}</div>
                </td>
                <td className={clsx('px-4 py-2.5 tabular-nums', sort.key === 'duration' && 'col-sorted')}>
                  {o.ended_at ? formatDuration((o.ended_at - o.started_at) / 1000) : <span className="text-accent-red">ongoing</span>}
                </td>
                <td className={clsx('px-4 py-2.5', sort.key === 'reason' && 'col-sorted')}>
                  <span className="text-xs bg-bg-elevated rounded px-2 py-1 border border-bg-border">{o.reason}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500 max-w-md truncate">{o.notes || '—'}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">No outages recorded yet.</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

