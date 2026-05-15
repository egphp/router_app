'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { formatBytes, categoryIcon } from '../../lib/format';

interface Row {
  mac: string; label: string; category: string | null; vendor: string | null;
  today_down: number; today_up: number;
  week_down: number; week_up: number;
  month_down: number; month_up: number;
  year_down: number; year_up: number;
  total_down: number; total_up: number;
}

type Period = 'today' | 'week' | 'month' | 'year' | 'total';
const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week (7d)' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'total', label: 'All-time' },
];

export default function ConsumptionPage() {
  const { data } = useSWR<{ devices: Row[] }>('/api/consumption', fetcher, { refreshInterval: 15000 });
  const rows = data?.devices ?? [];
  const [sortPeriod, setSortPeriod] = useState<Period>('today');
  const [search, setSearch] = useState('');

  const sorted = useMemo(() => {
    let list = rows.slice();
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((r) =>
        r.label.toLowerCase().includes(q) || r.mac.toLowerCase().includes(q) ||
        (r.vendor || '').toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => (b[`${sortPeriod}_down`] + b[`${sortPeriod}_up`]) - (a[`${sortPeriod}_down`] + a[`${sortPeriod}_up`]));
    return list;
  }, [rows, sortPeriod, search]);

  // Totals row
  const totals = useMemo(() => sorted.reduce((acc, r) => ({
    today: acc.today + r.today_down + r.today_up,
    week:  acc.week  + r.week_down  + r.week_up,
    month: acc.month + r.month_down + r.month_up,
    year:  acc.year  + r.year_down  + r.year_up,
    total: acc.total + r.total_down + r.total_up,
  }), { today: 0, week: 0, month: 0, year: 0, total: 0 }), [sorted]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-semibold">Consumption per device</h1>
        <div className="flex items-center gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
            className="bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-sm w-56 focus:outline-none focus:border-accent" />
          <select value={sortPeriod} onChange={(e) => setSortPeriod(e.target.value as Period)}
            className="bg-bg-elevated border border-bg-border rounded px-2 py-1.5 text-sm">
            {PERIODS.map((p) => <option key={p.value} value={p.value}>Sort by {p.label}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3 animate-fade-in">
        {PERIODS.map((p) => {
          const v = totals[p.value as keyof typeof totals];
          const active = sortPeriod === p.value;
          return (
            <button key={p.value} onClick={() => setSortPeriod(p.value)}
              className={`card p-4 text-left transition ${active ? 'border-accent ring-1 ring-accent/40' : 'hover:border-bg-border'}`}>
              <div className="stat-label">Network · {p.label}</div>
              <div className="text-xl font-bold mt-1 tabular-nums">{formatBytes(v)}</div>
            </button>
          );
        })}
      </div>

      {/* Mobile card list */}
      <div className="lg:hidden space-y-2 animate-fade-in">
        {sorted.map((r) => (
          <Link key={r.mac} href={`/devices/${encodeURIComponent(r.mac)}`}
            className="card p-3 block hover:bg-bg-elevated/40">
            <div className="flex items-center gap-2.5">
              <span className="text-xl">{categoryIcon(r.category)}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{r.label}</div>
                <div className="text-[10px] text-slate-500 truncate">{r.mac}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] text-slate-500">{PERIODS.find((p) => p.value === sortPeriod)?.label}</div>
                <div className="text-sm font-bold tabular-nums text-slate-100">{formatBytes((r as any)[`${sortPeriod}_down`] + (r as any)[`${sortPeriod}_up`])}</div>
              </div>
            </div>
            <div className="grid grid-cols-5 gap-1 mt-2 text-[10px]">
              {(['today', 'week', 'month', 'year', 'total'] as Period[]).map((p) => (
                <div key={p} className={`rounded px-1.5 py-1 text-center ${sortPeriod === p ? 'bg-accent/20 text-accent' : 'bg-bg-elevated text-slate-400'}`}>
                  <div className="text-[8px] uppercase">{p}</div>
                  <div className="font-mono tabular-nums">{formatBytes((r as any)[`${p}_down`] + (r as any)[`${p}_up`], 0)}</div>
                </div>
              ))}
            </div>
          </Link>
        ))}
        {sorted.length === 0 && <div className="card p-8 text-center text-slate-500">No devices.</div>}
      </div>

      {/* Desktop table */}
      <div className="hidden lg:block card overflow-hidden animate-fade-in">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated/40 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left">Device</th>
                <th className="px-3 py-2 text-right">Today</th>
                <th className="px-3 py-2 text-right">Week</th>
                <th className="px-3 py-2 text-right">Month</th>
                <th className="px-3 py-2 text-right">Year</th>
                <th className="px-3 py-2 text-right">All-time</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.mac} className="border-t border-bg-border hover:bg-bg-elevated/40 transition">
                  <td className="px-4 py-2.5">
                    <Link href={`/devices/${encodeURIComponent(r.mac)}`}
                      className="flex items-center gap-2 hover:text-accent">
                      <span className="text-lg">{categoryIcon(r.category)}</span>
                      <div>
                        <div className="font-medium">{r.label}</div>
                        <div className="text-[10px] text-slate-500">{r.vendor || 'Unknown'} · {r.mac}</div>
                      </div>
                    </Link>
                  </td>
                  <ConsumptionCell down={r.today_down} up={r.today_up} highlight={sortPeriod === 'today'} />
                  <ConsumptionCell down={r.week_down} up={r.week_up} highlight={sortPeriod === 'week'} />
                  <ConsumptionCell down={r.month_down} up={r.month_up} highlight={sortPeriod === 'month'} />
                  <ConsumptionCell down={r.year_down} up={r.year_up} highlight={sortPeriod === 'year'} />
                  <ConsumptionCell down={r.total_down} up={r.total_up} highlight={sortPeriod === 'total'} />
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">No devices.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ConsumptionCell({ down, up, highlight }: { down: number; up: number; highlight?: boolean }) {
  const total = down + up;
  return (
    <td className={`px-3 py-2.5 text-right tabular-nums ${highlight ? 'font-semibold text-slate-100' : 'text-slate-300'}`}>
      <div>{formatBytes(total)}</div>
      <div className="text-[10px] text-slate-500">↓{formatBytes(down, 0)} ↑{formatBytes(up, 0)}</div>
    </td>
  );
}
