'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { formatBytes, formatBps, categoryIcon } from '../../lib/format';
import { usePersistedState } from '../../lib/usePersistedState';

interface Row {
  mac: string; label: string; category: string | null; vendor: string | null;
  online: 0 | 1; now_down_bps: number; now_up_bps: number;
  today_down: number; today_up: number;
  week_down: number; week_up: number;
  month_down: number; month_up: number;
  year_down: number; year_up: number;
  total_down: number; total_up: number;
}

type SortKey = 'now_down' | 'now_up' | 'today' | 'week' | 'month' | 'year' | 'total';
type Period = 'today' | 'week' | 'month' | 'year' | 'total';
const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week (7d)' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'total', label: 'All-time' },
];

export default function ConsumptionPage() {
  const { data } = useSWR<{ devices: Row[] }>('/api/consumption', fetcher, { refreshInterval: 10000 });
  const rows = data?.devices ?? [];
  const [sort, setSort] = usePersistedState<SortKey>('tenda.consumption.sort', 'today');
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
    list.sort((a, b) => {
      if (sort === 'now_down') return b.now_down_bps - a.now_down_bps;
      if (sort === 'now_up') return b.now_up_bps - a.now_up_bps;
      return (b[`${sort}_down`] + b[`${sort}_up`]) - (a[`${sort}_down`] + a[`${sort}_up`]);
    });
    return list;
  }, [rows, sort, search]);

  // Totals row
  const totals = useMemo(() => sorted.reduce((acc, r) => ({
    today: acc.today + r.today_down + r.today_up,
    week:  acc.week  + r.week_down  + r.week_up,
    month: acc.month + r.month_down + r.month_up,
    year:  acc.year  + r.year_down  + r.year_up,
    total: acc.total + r.total_down + r.total_up,
  }), { today: 0, week: 0, month: 0, year: 0, total: 0 }), [sorted]);

  const sortPeriod: Period = (sort === 'now_down' || sort === 'now_up') ? 'today' : sort;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-semibold">Consumption per device</h1>
        <div className="flex items-center gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
            className="bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-sm w-56 focus:outline-none focus:border-accent" />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
            className="lg:hidden bg-bg-elevated border border-bg-border rounded px-2 py-1.5 text-sm">
            <option value="now_down">Sort: ↓ now</option>
            <option value="now_up">Sort: ↑ now</option>
            {PERIODS.map((p) => <option key={p.value} value={p.value}>Sort by {p.label}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3 animate-fade-in">
        {PERIODS.map((p) => {
          const v = totals[p.value as keyof typeof totals];
          const active = sortPeriod === p.value;
          return (
            <button key={p.value} onClick={() => setSort(p.value)}
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
                <div className="text-[10px] text-slate-500">{r.online ? 'now' : 'offline'}</div>
                <div className="text-xs tabular-nums leading-tight">
                  <span className="text-blue-400">↓ {formatBps(r.now_down_bps)}</span>{' '}
                  <span className="text-orange-400">↑ {formatBps(r.now_up_bps)}</span>
                </div>
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
                <Th label="Now" k="now_down" altK="now_up" sort={sort} setSort={setSort} hint="click: ↓ / ↑" />
                <Th label="Today" k="today" sort={sort} setSort={setSort} />
                <Th label="Week" k="week" sort={sort} setSort={setSort} />
                <Th label="Month" k="month" sort={sort} setSort={setSort} />
                <Th label="Year" k="year" sort={sort} setSort={setSort} />
                <Th label="All-time" k="total" sort={sort} setSort={setSort} />
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
                  <td className={`px-3 py-2.5 text-right tabular-nums leading-tight ${(sort==='now_down'||sort==='now_up') ? 'bg-accent/5' : ''}`}>
                    {r.online ? (
                      <>
                        <div className={r.now_down_bps > 0 ? 'text-blue-400' : 'text-slate-600'}>↓ {formatBps(r.now_down_bps)}</div>
                        <div className={`text-xs ${r.now_up_bps > 0 ? 'text-orange-400' : 'text-slate-600'}`}>↑ {formatBps(r.now_up_bps)}</div>
                      </>
                    ) : <span className="text-slate-600 text-xs">offline</span>}
                  </td>
                  <ConsumptionCell down={r.today_down} up={r.today_up} highlight={sort === 'today'} />
                  <ConsumptionCell down={r.week_down} up={r.week_up} highlight={sort === 'week'} />
                  <ConsumptionCell down={r.month_down} up={r.month_up} highlight={sort === 'month'} />
                  <ConsumptionCell down={r.year_down} up={r.year_up} highlight={sort === 'year'} />
                  <ConsumptionCell down={r.total_down} up={r.total_up} highlight={sort === 'total'} />
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No devices.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Th({ label, k, altK, sort, setSort, hint }: {
  label: string; k: SortKey; altK?: SortKey; sort: SortKey;
  setSort: (s: SortKey) => void; hint?: string;
}) {
  const active = sort === k || sort === altK;
  const arrow = sort === k ? ' ↓' : sort === altK ? ' ↑' : '';
  const onClick = () => {
    if (!altK) { setSort(k); return; }
    setSort(sort === k ? altK : k);
  };
  return (
    <th
      onClick={onClick}
      title={hint ?? `Sort by ${label}`}
      className={`px-3 py-2 text-right cursor-pointer select-none hover:text-slate-200 transition ${active ? 'text-accent' : ''}`}
    >
      {label}{arrow}
    </th>
  );
}

function ConsumptionCell({ down, up, highlight }: { down: number; up: number; highlight?: boolean }) {
  const total = down + up;
  return (
    <td className={`px-3 py-2.5 text-right tabular-nums ${highlight ? 'font-semibold text-slate-100 bg-accent/5' : 'text-slate-300'}`}>
      <div>{formatBytes(total)}</div>
      <div className="text-[10px] text-slate-500">↓{formatBytes(down, 0)} ↑{formatBytes(up, 0)}</div>
    </td>
  );
}
