'use client';
import { Fragment } from 'react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { formatBytes } from '../lib/format';

interface Cell { dow: number; hour: number; bytes: number }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function Heatmap({ mac, days = 14, title = 'Activity heatmap' }: { mac?: string; days?: number; title?: string }) {
  const url = mac ? `/api/analytics?kind=heatmap&mac=${encodeURIComponent(mac)}&days=${days}` : `/api/analytics?kind=heatmap&days=${days}`;
  const { data } = useSWR<{ data: Cell[] }>(url, fetcher, { refreshInterval: 60000 });
  const cells = data?.data ?? [];
  const max = Math.max(1, ...cells.map((c) => c.bytes));

  return (
    <div className="card p-5 animate-fade-in">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="stat-label">{title}</div>
          <div className="text-xs text-slate-500 mt-1">Hour × day-of-week · avg bytes/hour · last {days} days</div>
        </div>
        <div className="text-xs text-slate-500">
          <span className="inline-block w-3 h-3 bg-blue-900 rounded-sm align-middle" /> low{' '}
          <span className="inline-block w-3 h-3 bg-blue-500 rounded-sm align-middle ml-2" /> mid{' '}
          <span className="inline-block w-3 h-3 bg-blue-300 rounded-sm align-middle ml-2" /> high
        </div>
      </div>
      <div className="grid w-full min-w-0 gap-px text-[8px] font-mono sm:text-[10px]"
        style={{ gridTemplateColumns: '2rem repeat(24, minmax(0, 1fr))' }}>
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="min-w-0 overflow-hidden pb-1 text-center font-normal text-slate-500">
            <span className="hidden sm:inline">{h}</span>
            <span className="sm:hidden">{h % 6 === 0 ? h : ''}</span>
          </div>
        ))}
        {DAYS.map((d, dow) => (
          <Fragment key={dow}>
            <div key={`${dow}-label`} className="min-w-0 pr-1 text-right text-slate-500">{d}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const c = cells.find((x) => x.dow === dow && x.hour === h);
              const v = c?.bytes ?? 0;
              const ratio = v / max;
              const opacity = v === 0 ? 0.05 : Math.max(0.15, ratio);
              return (
                <div key={`${dow}-${h}`} style={{ background: `rgba(96, 165, 250, ${opacity})` }}
                  title={`${d} ${h}:00 — ${formatBytes(v)}`}
                  className="aspect-square min-w-0 border border-bg-border" />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
