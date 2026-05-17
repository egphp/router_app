'use client';
import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { formatBytes, formatBps, categoryIcon } from '../../lib/format';
import { useTableSort, sortNum, type SortDir } from '../../lib/useTableSort';
import { clsx } from 'clsx';

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
  const { sort, onSort, setSort, indicator } = useTableSort<SortKey>(
    'tenda.consumption.sort', { key: 'today', dir: 'desc' }
  );
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
    const dir = sort.dir;
    list.sort((a, b) => {
      if (sort.key === 'now_down') return sortNum(a.now_down_bps, b.now_down_bps, dir);
      if (sort.key === 'now_up') return sortNum(a.now_up_bps, b.now_up_bps, dir);
      const at = (a[`${sort.key}_down`] + a[`${sort.key}_up`]);
      const bt = (b[`${sort.key}_down`] + b[`${sort.key}_up`]);
      return sortNum(at, bt, dir);
    });
    return list;
  }, [rows, sort, search]);

  // Totals row (separate down + up so the cards can show the breakdown)
  const totals = useMemo(() => sorted.reduce((acc, r) => ({
    today: { down: acc.today.down + r.today_down, up: acc.today.up + r.today_up },
    week:  { down: acc.week.down  + r.week_down,  up: acc.week.up  + r.week_up  },
    month: { down: acc.month.down + r.month_down, up: acc.month.up + r.month_up },
    year:  { down: acc.year.down  + r.year_down,  up: acc.year.up  + r.year_up  },
    total: { down: acc.total.down + r.total_down, up: acc.total.up + r.total_up },
  }), {
    today: { down: 0, up: 0 }, week: { down: 0, up: 0 }, month: { down: 0, up: 0 },
    year: { down: 0, up: 0 }, total: { down: 0, up: 0 },
  }), [sorted]);

  const sortPeriod: Period = (sort.key === 'now_down' || sort.key === 'now_up') ? 'today' : sort.key;

  // "Now" header cycles: down desc → down asc → up desc → up asc → down desc ...
  const onNowClick = () => {
    if (sort.key === 'now_down') {
      if (sort.dir === 'desc') setSort('now_down', 'asc');
      else setSort('now_up', 'desc');
    } else if (sort.key === 'now_up') {
      if (sort.dir === 'desc') setSort('now_up', 'asc');
      else setSort('now_down', 'desc');
    } else {
      setSort('now_down', 'desc');
    }
  };
  const nowIndicator = sort.key === 'now_down' ? `↓${sort.dir === 'asc' ? ' ↑' : ' ↓'}`
    : sort.key === 'now_up' ? `↑${sort.dir === 'asc' ? ' ↑' : ' ↓'}` : '';

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold">Consumption per device</h1>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
            className="w-full min-w-0 bg-bg-elevated border border-bg-border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-accent sm:w-56" />
          <select value={`${sort.key}:${sort.dir}`} onChange={(e) => {
            const [k, d] = e.target.value.split(':') as [SortKey, SortDir];
            setSort(k, d);
          }}
            className="w-full min-w-0 bg-bg-elevated border border-bg-border rounded px-2 py-1.5 text-sm lg:hidden">
            <option value="now_down:desc">Sort: ↓ now (max)</option>
            <option value="now_down:asc">Sort: ↓ now (min)</option>
            <option value="now_up:desc">Sort: ↑ now (max)</option>
            <option value="now_up:asc">Sort: ↑ now (min)</option>
            {PERIODS.map((p) => (
              <Fragment key={p.value}>
                <option key={`${p.value}:desc`} value={`${p.value}:desc`}>Sort: {p.label} ↓</option>
                <option key={`${p.value}:asc`} value={`${p.value}:asc`}>Sort: {p.label} ↑</option>
              </Fragment>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3 animate-fade-in">
        {PERIODS.map((p) => {
          const v = totals[p.value as keyof typeof totals];
          const active = sortPeriod === p.value;
          return (
            <button key={p.value} onClick={() => onSort(p.value as SortKey, 'desc')}
              className={`card p-4 text-left transition ${active ? 'border-accent ring-1 ring-accent/40' : 'hover:border-bg-border'}`}>
              <div className="stat-label">Network · {p.label}</div>
              <div className="text-xl font-bold mt-1 tabular-nums">{formatBytes(v.down + v.up)}</div>
              <div className="text-[10px] text-slate-500 tabular-nums mt-0.5">
                ↓ {formatBytes(v.down, 0)} · ↑ {formatBytes(v.up, 0)}
              </div>
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
                <Th label="Now" active={sort.key === 'now_down' || sort.key === 'now_up'} indicator={nowIndicator} onClick={onNowClick} hint="cycles: ↓desc → ↓asc → ↑desc → ↑asc" />
                <Th label="Today" active={sort.key === 'today'} indicator={indicator('today')} onClick={() => onSort('today', 'desc')} />
                <Th label="Week" active={sort.key === 'week'} indicator={indicator('week')} onClick={() => onSort('week', 'desc')} />
                <Th label="Month" active={sort.key === 'month'} indicator={indicator('month')} onClick={() => onSort('month', 'desc')} />
                <Th label="Year" active={sort.key === 'year'} indicator={indicator('year')} onClick={() => onSort('year', 'desc')} />
                <Th label="All-time" active={sort.key === 'total'} indicator={indicator('total')} onClick={() => onSort('total', 'desc')} />
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
                  <td className={clsx('px-3 py-2.5 text-right tabular-nums leading-tight', (sort.key === 'now_down' || sort.key === 'now_up') && 'col-sorted')}>
                    {r.online ? (
                      <>
                        <div className={r.now_down_bps > 0 ? 'text-blue-400' : 'text-slate-600'}>↓ {formatBps(r.now_down_bps)}</div>
                        <div className={`text-xs ${r.now_up_bps > 0 ? 'text-orange-400' : 'text-slate-600'}`}>↑ {formatBps(r.now_up_bps)}</div>
                      </>
                    ) : <span className="text-slate-600 text-xs">offline</span>}
                  </td>
                  <ConsumptionCell down={r.today_down} up={r.today_up} highlight={sort.key === 'today'} />
                  <ConsumptionCell down={r.week_down} up={r.week_up} highlight={sort.key === 'week'} />
                  <ConsumptionCell down={r.month_down} up={r.month_up} highlight={sort.key === 'month'} />
                  <ConsumptionCell down={r.year_down} up={r.year_up} highlight={sort.key === 'year'} />
                  <ConsumptionCell down={r.total_down} up={r.total_up} highlight={sort.key === 'total'} />
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

function Th({ label, active, indicator, onClick, hint }: {
  label: string; active: boolean; indicator: string; onClick: () => void; hint?: string;
}) {
  return (
    <th
      onClick={onClick}
      title={hint ?? `Sort by ${label}`}
      className={`px-3 py-2 text-right cursor-pointer select-none hover:text-slate-200 transition ${active ? 'text-accent' : ''}`}
    >
      {label}{indicator}
    </th>
  );
}

function ConsumptionCell({ down, up, highlight }: { down: number; up: number; highlight?: boolean }) {
  const total = down + up;
  return (
    <td className={`px-3 py-2.5 text-right tabular-nums ${highlight ? 'font-semibold col-sorted' : 'text-slate-300'}`}>
      <div>{formatBytes(total)}</div>
      <div className="text-[10px] text-slate-500">↓{formatBytes(down, 0)} ↑{formatBytes(up, 0)}</div>
    </td>
  );
}
