'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { formatBytes, categoryIcon } from '../../lib/format';

interface Day { day_ts: number; bytes_down: number; bytes_up: number }
interface Row {
  mac: string; label: string; category: string | null; vendor: string | null;
  daily: Day[]; total_down: number; total_up: number;
}
interface Resp { days: number[]; devices: Row[] }

const RANGE_OPTIONS = [
  { value: 7, label: 'Last 7 days' },
  { value: 14, label: 'Last 14 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 60, label: 'Last 60 days' },
  { value: 90, label: 'Last 90 days' },
];

function dayLabel(ts: number, compact = false) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTs = today.getTime();
  const yesterday = todayTs - 86400000;
  const dayBefore = todayTs - 2 * 86400000;
  if (ts === todayTs) return compact ? 'Today' : 'Today';
  if (ts === yesterday) return compact ? 'Yest' : 'Yesterday';
  if (ts === dayBefore) return compact ? '2d' : 'Day-before';
  return new Date(ts).toLocaleDateString([], compact ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
}

export default function ReportPage() {
  const [days, setDays] = useState(30);
  const { data } = useSWR<Resp>(`/api/report?days=${days}`, fetcher, { refreshInterval: 30000 });
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let list = data?.devices ?? [];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((r) => r.label.toLowerCase().includes(q) || r.mac.toLowerCase().includes(q));
    }
    return list;
  }, [data, search]);

  const dayList = data?.days ?? [];
  const todayMax = Math.max(1, ...filtered.map((r) => Math.max(...r.daily.map((d) => d.bytes_down + d.bytes_up))));

  const dailyTotals = useMemo(() => {
    const totals = new Map<number, { bd: number; bu: number }>();
    for (const r of filtered) {
      for (const d of r.daily) {
        const e = totals.get(d.day_ts) ?? { bd: 0, bu: 0 };
        e.bd += d.bytes_down;
        e.bu += d.bytes_up;
        totals.set(d.day_ts, e);
      }
    }
    return dayList.map((t) => ({ ts: t, ...(totals.get(t) ?? { bd: 0, bu: 0 }) }));
  }, [filtered, dayList]);
  const maxDailyTotal = Math.max(1, ...dailyTotals.map((x) => x.bd + x.bu));
  const compactDailyTotals = dailyTotals.slice(-7);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold">Daily report</h1>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
            className="w-full min-w-0 bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent sm:w-56" />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="w-full min-w-0 bg-bg-elevated border border-bg-border rounded px-2 py-1.5 text-sm sm:w-auto">
            {RANGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <div className="card p-5 animate-fade-in">
        <div className="stat-label mb-2">Network-wide daily totals</div>
        <div className="grid h-36 grid-cols-7 items-end gap-1 lg:hidden">
          {compactDailyTotals.map((d) => {
            const total = d.bd + d.bu;
            const h = (total / maxDailyTotal) * 100;
            return (
              <div key={d.ts} className="flex min-w-0 flex-col items-center text-[9px] text-slate-500"
                   title={`${dayLabel(d.ts)} · total ${formatBytes(total)} (↓ ${formatBytes(d.bd)} · ↑ ${formatBytes(d.bu)})`}>
                <div className="mb-1 max-w-full truncate text-slate-400">{formatBytes(total, 0).replace(' ', '')}</div>
                <div className="w-full rounded-t bg-gradient-to-t from-blue-500 to-purple-500 transition-all"
                  style={{ height: `${Math.max(2, h)}%` }} />
                <div className="mt-1 max-w-full truncate">{dayLabel(d.ts, true)}</div>
              </div>
            );
          })}
        </div>
        <div className="hidden items-end gap-1 h-32 overflow-x-auto lg:flex">
          {dailyTotals.map((d) => {
            const total = d.bd + d.bu;
            const h = (total / maxDailyTotal) * 100;
            const label = dayLabel(d.ts);
            return (
              <div key={d.ts} className="flex flex-col items-center text-[10px] text-slate-500 min-w-[28px]"
                   title={`${label} · total ${formatBytes(total)} (↓ ${formatBytes(d.bd)} · ↑ ${formatBytes(d.bu)})`}>
                <div className="text-slate-400 mb-1">{formatBytes(total, 0).replace(' ', '')}</div>
                <div className="w-full bg-gradient-to-t from-blue-500 to-purple-500 rounded-t transition-all"
                  style={{ height: `${Math.max(2, h)}%` }} />
                <div className="mt-1 whitespace-nowrap">{label}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card overflow-hidden animate-fade-in">
        <div className="divide-y divide-bg-border min-[2700px]:hidden">
          {filtered.map((r) => {
            const recent = r.daily.slice(-7);
            return (
              <article key={r.mac} className="p-3">
                <Link href={`/devices/${encodeURIComponent(r.mac)}`}
                  className="flex min-w-0 items-start gap-2 hover:text-accent">
                  <span className="shrink-0 text-base">{categoryIcon(r.category)}</span>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{r.label}</div>
                    <div className="break-all text-[10px] text-slate-500">{r.mac}</div>
                  </div>
                </Link>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="stat-label">Total</div>
                    <div className="font-semibold text-slate-100">{formatBytes(r.total_down + r.total_up)}</div>
                  </div>
                  <div>
                    <div className="stat-label">Transfer</div>
                    <div className="text-slate-400">↓ {formatBytes(r.total_down, 0)} · ↑ {formatBytes(r.total_up, 0)}</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-7 gap-1">
                  {recent.map((d) => {
                    const total = d.bytes_down + d.bytes_up;
                    const intensity = total > 0 ? Math.min(1, total / todayMax) : 0;
                    return (
                      <div key={d.day_ts} className="min-w-0 rounded border border-bg-border bg-bg-elevated/40 p-1 text-center text-[9px]"
                        title={`${new Date(d.day_ts).toLocaleDateString()}: ↓${formatBytes(d.bytes_down)} ↑${formatBytes(d.bytes_up)}`}>
                        <div className="truncate text-slate-500">{dayLabel(d.day_ts, true)}</div>
                        <div className="mt-1 h-1 rounded"
                          style={{ backgroundColor: intensity > 0 ? `rgba(96, 165, 250, ${0.3 + intensity * 0.5})` : 'rgba(71, 85, 105, 0.4)' }} />
                        <div className="mt-1 truncate tabular-nums text-slate-300">{total > 0 ? formatBytes(total, 0).replace(' ', '') : '0'}</div>
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-slate-500">No devices.</div>
          )}
        </div>
        <div className="hidden overflow-x-auto -webkit-overflow-scrolling-touch min-[2700px]:block">
          <table className="w-full text-xs min-w-[600px]">
            <thead className="bg-bg-elevated/40 text-[10px] uppercase tracking-wide text-slate-500 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left min-w-[180px] sticky left-0 bg-bg-card z-10">Device</th>
                {dayList.map((t) => {
                  const label = dayLabel(t);
                  return <th key={t} className="px-2 py-2 text-right min-w-[60px]">{label}</th>;
                })}
                <th className="px-3 py-2 text-right min-w-[80px]">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.mac} className="border-t border-bg-border hover:bg-bg-elevated/40">
                  <td className="px-3 py-2 sticky left-0 bg-bg-card z-10">
                    <Link href={`/devices/${encodeURIComponent(r.mac)}`}
                      className="flex items-center gap-2 hover:text-accent">
                      <span className="text-base">{categoryIcon(r.category)}</span>
                      <div className="truncate max-w-[160px]">
                        <div className="font-medium truncate">{r.label}</div>
                        <div className="text-[9px] text-slate-500 truncate">{r.mac}</div>
                      </div>
                    </Link>
                  </td>
                  {r.daily.map((d) => {
                    const total = d.bytes_down + d.bytes_up;
                    const intensity = total > 0 ? Math.min(1, total / todayMax) : 0;
                    return (
                      <td key={d.day_ts} className="px-2 py-1 text-right tabular-nums text-[10px]"
                        style={{ backgroundColor: intensity > 0 ? `rgba(96, 165, 250, ${intensity * 0.5})` : 'transparent' }}
                        title={`${new Date(d.day_ts).toLocaleDateString()}: ↓${formatBytes(d.bytes_down)} ↑${formatBytes(d.bytes_up)}`}>
                        {total > 0 ? formatBytes(total, 0) : <span className="text-slate-600">—</span>}
                      </td>
                    );
                  })}
                  <td className="px-3 py-1 text-right tabular-nums font-semibold text-slate-100"
                      title={`↓ ${formatBytes(r.total_down)} · ↑ ${formatBytes(r.total_up)}`}>
                    <div>{formatBytes(r.total_down + r.total_up)}</div>
                    <div className="text-[9px] text-slate-500 font-normal">↓{formatBytes(r.total_down, 0)} ↑{formatBytes(r.total_up, 0)}</div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={dayList.length + 2} className="px-4 py-8 text-center text-slate-500">No devices.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
