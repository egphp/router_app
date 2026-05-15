'use client';
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
      <div className="flex items-center justify-between mb-4">
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
      <div className="overflow-x-auto">
        <table className="text-[10px] font-mono w-full">
          <thead>
            <tr>
              <th></th>
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="text-slate-500 font-normal pb-1">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((d, dow) => (
              <tr key={dow}>
                <td className="text-slate-500 pr-2 align-middle">{d}</td>
                {Array.from({ length: 24 }, (_, h) => {
                  const c = cells.find((x) => x.dow === dow && x.hour === h);
                  const v = c?.bytes ?? 0;
                  const ratio = v / max;
                  const opacity = v === 0 ? 0.05 : Math.max(0.15, ratio);
                  return (
                    <td key={h} style={{ background: `rgba(96, 165, 250, ${opacity})` }}
                      title={`${d} ${h}:00 — ${formatBytes(v)}`}
                      className="w-5 h-5 border border-bg-border" />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
