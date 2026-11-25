'use client';
import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { formatBytes, formatBps, categoryIcon } from '../../lib/format';
import { useTableSort, sortNum, type SortDir } from '../../lib/useTableSort';
import { clsx } from 'clsx';
import { QuotaForecastCard } from '../../components/QuotaForecastCard';

interface Row {
  mac: string; label: string; category: string | null; vendor: string | null;
  is_local_infra?: boolean;
  online: 0 | 1; now_down_bps: number; now_up_bps: number;
  today_down: number; today_up: number;
  week_down: number; week_up: number;
  month_down: number; month_up: number;
  year_down: number; year_up: number;
  total_down: number; total_up: number;
}

interface WanPeriodTotal {
  down: number;
  up: number;
  period_start_ts: number;
}

interface WanConsumptionSummary {
  first_wan_day_ts: number | null;
  today: WanPeriodTotal;
  week: WanPeriodTotal;
  month: WanPeriodTotal;
  year: WanPeriodTotal;
  total: WanPeriodTotal;
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
  const { data } = useSWR<{ devices: Row[]; wanTotals?: WanConsumptionSummary }>('/api/consumption', fetcher, { refreshInterval: 10000 });
  const rows = data?.devices ?? [];
  const wanTotals = data?.wanTotals;
  const { sort, onSort, setSort, indicator } = useTableSort<SortKey>(
    'tenda.consumption.sort', { key: 'today', dir: 'desc' }
  );
  const [search, setSearch] = useState('');
  const [excludeLocal, setExcludeLocal] = useState(true);

  const localInfraCount = useMemo(() => rows.filter((r) => r.is_local_infra).length, [rows]);

  const sorted = useMemo(() => {
    let list = rows.slice();
    if (excludeLocal) {
      list = list.filter((r) => !r.is_local_infra);
    }
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
  }, [rows, sort, search, excludeLocal]);

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
        <div>
          <h1 className="text-xl font-semibold">Consumption per device</h1>
          <p className="text-xs text-slate-500 mt-0.5" dir="auto">
            حساب إنترنت معاير على خطوط <bdi>WAN1 + WAN2</bdi> مع فصل البث المحلي للكاميرات والربيتر
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
          <button
            type="button"
            onClick={() => setExcludeLocal((v) => !v)}
            dir="auto"
            className={clsx(
              'px-3 py-1.5 rounded text-xs font-medium transition whitespace-nowrap',
              excludeLocal
                ? 'bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/25'
                : 'bg-bg-elevated text-slate-400 ring-1 ring-inset ring-bg-border hover:text-slate-200'
            )}
            title="استبعاد الكاميرات المحلية وربيتر الشبكة الداخلية من جدول وإجمالي الاستهلاك"
          >
            {excludeLocal ? '✓ بدون الكاميرات والربيتر المحلي' : 'إظهار الكاميرات والربيتر المحلي'}
            {localInfraCount > 0 ? <bdi className="ms-1 opacity-75">({localInfraCount})</bdi> : null}
          </button>
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

      <QuotaForecastCard />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3 animate-fade-in">
        {PERIODS.map((p) => {
          const v = totals[p.value as keyof typeof totals];
          const wanPeriod = wanTotals?.[p.value];
          const hasWan = Boolean(wanPeriod && (wanPeriod.down + wanPeriod.up) > 0);
          const wanCoversFullPeriod = Boolean(
            hasWan &&
            wanTotals?.first_wan_day_ts !== null &&
            wanTotals?.first_wan_day_ts !== undefined &&
            wanPeriod &&
            wanTotals.first_wan_day_ts <= wanPeriod.period_start_ts
          );
          const wanSinceLabel = wanTotals?.first_wan_day_ts
            ? new Date(wanTotals.first_wan_day_ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
            : null;
          const active = sortPeriod === p.value;
          return (
            <button key={p.value} onClick={() => onSort(p.value as SortKey, 'desc')}
              className={`card p-4 text-left transition ${active ? 'border-accent ring-1 ring-accent/40' : 'hover:border-bg-border'}`}>
              <div className="stat-label">Devices · {p.label}</div>
              <div className="text-xl font-bold mt-1 tabular-nums">{formatBytes(v.down + v.up)}</div>
              <div className="text-[10px] text-slate-500 tabular-nums mt-0.5">
                ↓ {formatBytes(v.down, 0)} · ↑ {formatBytes(v.up, 0)}
              </div>
              {hasWan && wanPeriod && (
                wanCoversFullPeriod ? (
                  <div className="text-[10px] text-emerald-400/90 tabular-nums mt-1.5 pt-1 border-t border-bg-border/60" dir="auto">
                    إنترنت <bdi>WAN</bdi>: <bdi>↓ {formatBytes(wanPeriod.down, 0)} · ↑ {formatBytes(wanPeriod.up, 0)}</bdi>
                  </div>
                ) : (
                  <div
                    className="text-[10px] text-slate-500 tabular-nums mt-1.5 pt-1 border-t border-bg-border/60"
                    dir="auto"
                    title="عداد WAN المباشر بدأ التسجيل من هذا التاريخ"
                  >
                    <bdi>WAN</bdi> {wanSinceLabel ? <>(منذ <bdi>{wanSinceLabel}</bdi>)</> : null}:{' '}
                    <bdi>{formatBytes(wanPeriod.down + wanPeriod.up, 0)}</bdi>
                  </div>
                )
              )}
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
                <div className="font-medium truncate flex items-center gap-1.5">
                  <span className="truncate">{r.label}</span>
                  {r.is_local_infra ? (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-500/15 text-slate-400 ring-1 ring-inset ring-slate-500/25 shrink-0">
                      محلي
                    </span>
                  ) : null}
                </div>
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
                        <div className="font-medium flex items-center gap-1.5">
                          <span>{r.label}</span>
                          {r.is_local_infra ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-500/15 text-slate-400 ring-1 ring-inset ring-slate-500/25">
                              محلي
                            </span>
                          ) : null}
                        </div>
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
