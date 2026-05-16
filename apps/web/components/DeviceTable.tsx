'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { formatBps, formatBytes, formatMacShort, categoryIcon, timeAgo } from '../lib/format';
import { usePersistedState } from '../lib/usePersistedState';
import { useTableSort, sortNum, sortStr, type SortDir } from '../lib/useTableSort';
import { clsx } from 'clsx';

interface DeviceRow {
  mac: string;
  hostname: string | null;
  router_remark: string | null;
  custom_label: string | null;
  vendor: string | null;
  category: string | null;
  ip: string | null;
  online: 0 | 1;
  up_speed_bps: number;
  down_speed_bps: number;
  bytes_today: number;
  bytes_up_today: number;
  bytes_total: number;
  bytes_up_total: number;
  is_new: 0 | 1;
  last_online_at: number | null;
  last_seen: number;
  first_seen: number;
}

type SortKey = 'name' | 'down' | 'up' | 'today' | 'total' | 'last_seen';
type Filter = 'all' | 'online' | 'offline' | 'new';

export function DeviceTable() {
  const { data, mutate } = useSWR<{ devices: DeviceRow[] }>('/api/devices?live=1', fetcher, {
    refreshInterval: 2000,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    keepPreviousData: true,
  });
  const { sort, onSort, setSort, indicator } = useTableSort<SortKey>(
    'tenda.devices.sort', { key: 'today', dir: 'desc' }
  );
  const [filter, setFilter] = usePersistedState<Filter>('tenda.devices.filter', 'all');
  const [search, setSearch] = useState('');

  const devices = useMemo(() => {
    let list = data?.devices ?? [];
    if (filter === 'online') list = list.filter((d) => d.online === 1);
    if (filter === 'offline') list = list.filter((d) => d.online !== 1);
    if (filter === 'new') list = list.filter((d) => d.is_new === 1);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((d) =>
        (d.custom_label || d.hostname || d.router_remark || '').toLowerCase().includes(q) ||
        (d.ip || '').includes(q) ||
        d.mac.toLowerCase().includes(q)
      );
    }
    const dir = sort.dir;
    list = [...list].sort((a, b) => {
      switch (sort.key) {
        case 'name': return sortStr(label(a), label(b), dir);
        case 'down': return sortNum(a.down_speed_bps, b.down_speed_bps, dir);
        case 'up': return sortNum(a.up_speed_bps, b.up_speed_bps, dir);
        case 'today': return sortNum(a.bytes_today + a.bytes_up_today, b.bytes_today + b.bytes_up_today, dir);
        case 'total': return sortNum(a.bytes_total + a.bytes_up_total, b.bytes_total + b.bytes_up_total, dir);
        case 'last_seen': return sortNum(lastOnlineSortValue(a), lastOnlineSortValue(b), dir);
      }
    });
    return list;
  }, [data, sort, filter, search]);

  const newCount = devices.filter((d) => d.is_new === 1).length;

  const dismissNew = async (mac: string) => {
    await fetch(`/api/devices/${encodeURIComponent(mac)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_new: 0 }),
    });
    mutate();
  };

  // The "Now" header cycles through 3 sort states: down desc → up desc → (back to today)
  // But user wants click-on-column to toggle direction, so we keep it simple:
  //   - First click on Now while not sorted by Now → sort by down desc
  //   - Click again while sorted by down → switch to up desc (the other half of "Now")
  //   - Click again while sorted by up → reverse to up asc
  //   - Click again → reverse to down asc, then desc again, etc.
  // This matches: clicking the same header repeatedly reverses direction within the active sub-column.
  const onNowClick = () => {
    if (sort.key === 'down') {
      // toggle direction OR switch to up; we choose: toggle direction first, then alt key on next cycle
      if (sort.dir === 'desc') setSort('down', 'asc');
      else setSort('up', 'desc');
    } else if (sort.key === 'up') {
      if (sort.dir === 'desc') setSort('up', 'asc');
      else setSort('down', 'desc');
    } else {
      setSort('down', 'desc');
    }
  };
  const nowIndicator = sort.key === 'down' ? `↓${sort.dir === 'asc' ? ' ↑' : ' ↓'}`
    : sort.key === 'up' ? `↑${sort.dir === 'asc' ? ' ↑' : ' ↓'}` : '';

  return (
    <div className="card overflow-hidden animate-fade-in">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 p-3 sm:p-4 border-b border-bg-border">
        <div className="font-semibold text-sm sm:text-base">Devices <span className="text-slate-500 text-xs sm:text-sm">({devices.length})</span></div>
        {newCount > 0 && (
          <span className="text-[10px] sm:text-xs bg-accent-red/20 text-accent-red rounded-full px-2 py-0.5 border border-accent-red/30">
            🔴 {newCount} new
          </span>
        )}
        <div className="flex-1 min-w-0" />
        <input
          type="text" placeholder="Search…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="bg-bg-elevated border border-bg-border rounded-md px-2 sm:px-3 py-1.5 text-sm w-full sm:w-56 max-w-full focus:outline-none focus:border-accent"
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}
          className="bg-bg-elevated border border-bg-border rounded-md px-2 py-1.5 text-xs sm:text-sm">
          <option value="all">All</option><option value="online">Online</option>
          <option value="offline">Offline</option><option value="new">New</option>
        </select>
        <select value={`${sort.key}:${sort.dir}`} onChange={(e) => {
          const [k, d] = e.target.value.split(':') as [SortKey, SortDir];
          setSort(k, d);
        }}
          className="lg:hidden bg-bg-elevated border border-bg-border rounded-md px-2 py-1.5 text-xs sm:text-sm">
          <option value="today:desc">Sort: today ↓</option>
          <option value="today:asc">Sort: today ↑</option>
          <option value="total:desc">Sort: total ↓</option>
          <option value="total:asc">Sort: total ↑</option>
          <option value="down:desc">Sort: ↓ now (max)</option>
          <option value="down:asc">Sort: ↓ now (min)</option>
          <option value="up:desc">Sort: ↑ now (max)</option>
          <option value="up:asc">Sort: ↑ now (min)</option>
          <option value="name:asc">Sort: name A→Z</option>
          <option value="name:desc">Sort: name Z→A</option>
          <option value="last_seen:desc">Sort: last online ↓</option>
          <option value="last_seen:asc">Sort: last online ↑</option>
        </select>
      </div>
      {/* Mobile card list (< lg) */}
      <div className="lg:hidden divide-y divide-bg-border">
        {devices.map((d) => (
          <div key={d.mac} className={clsx(
            'p-3 hover:bg-bg-elevated/40',
            d.is_new === 1 && 'bg-accent-red/5'
          )}>
            <div className="flex items-start gap-2.5">
              <span className="text-xl shrink-0 mt-0.5">{categoryIcon(d.category)}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link href={`/devices/${encodeURIComponent(d.mac)}`} className="font-medium text-slate-100 hover:text-accent truncate">
                    {label(d)}
                  </Link>
                  {d.is_new === 1 && (
                    <span className="text-[9px] uppercase tracking-wide bg-accent-red text-white rounded px-1.5 py-0.5 font-bold leading-none">NEW</span>
                  )}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${d.online ? 'bg-accent-green/20 text-accent-green' : 'bg-slate-700/40 text-slate-500'}`}>
                    {d.online ? 'online' : 'offline'}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 truncate">{d.ip ?? '—'} · {formatMacShort(d.mac)} · {d.vendor || 'Unknown'}</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-xs">
                  <div><span className="text-slate-500">↓ now:</span> <span className={d.online && d.down_speed_bps > 0 ? 'text-blue-400' : 'text-slate-600'}>{d.online ? formatBps(d.down_speed_bps) : '—'}</span></div>
                  <div><span className="text-slate-500">↑ now:</span> <span className={d.online && d.up_speed_bps > 0 ? 'text-orange-400' : 'text-slate-600'}>{d.online ? formatBps(d.up_speed_bps) : '—'}</span></div>
                  <div>
                    <span className="text-slate-500">Today:</span>{' '}
                    <span className="text-slate-200 font-medium">{formatBytes(d.bytes_today + d.bytes_up_today)}</span>
                    <div className="text-[10px] text-slate-500">↓ {formatBytes(d.bytes_today, 0)} · ↑ {formatBytes(d.bytes_up_today, 0)}</div>
                  </div>
                  <div>
                    <span className="text-slate-500">All-time:</span>{' '}
                    <span className="text-slate-100 font-semibold">{formatBytes(d.bytes_total + d.bytes_up_total)}</span>
                    <div className="text-[10px] text-slate-500">↓ {formatBytes(d.bytes_total, 0)} · ↑ {formatBytes(d.bytes_up_total, 0)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-[10px] text-slate-500">{lastOnlineLabel(d)}</span>
                  {d.is_new === 1 && (
                    <button onClick={() => dismissNew(d.mac)}
                      className="ml-auto text-[10px] px-2 py-1 rounded bg-accent-green/10 text-accent-green border border-accent-green/30">
                      Mark known
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
        {devices.length === 0 && <div className="p-8 text-center text-slate-500 text-sm">No devices match the current filter.</div>}
      </div>

      {/* Desktop table (≥ lg) */}
      <div className="hidden lg:block overflow-x-auto">
        <table className="table-aurora">
          <thead>
            <tr>
              <Th label="Device" active={sort.key === 'name'} indicator={indicator('name')} onClick={() => onSort('name', 'asc')} align="left" />
              <th className="text-left" style={{ padding: '12px 16px', fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-3)', fontWeight: 600 }}>Address</th>
              <Th
                label="Now"
                active={sort.key === 'down' || sort.key === 'up'}
                indicator={nowIndicator}
                onClick={onNowClick}
                hint="cycles: ↓ desc → ↓ asc → ↑ desc → ↑ asc"
              />
              <Th label="Today" active={sort.key === 'today'} indicator={indicator('today')} onClick={() => onSort('today', 'desc')} />
              <Th label="All-time" active={sort.key === 'total'} indicator={indicator('total')} onClick={() => onSort('total', 'desc')} />
              <Th label="Last online" active={sort.key === 'last_seen'} indicator={indicator('last_seen')} onClick={() => onSort('last_seen', 'desc')} />
              <th style={{ padding: '12px 16px' }}></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.mac} className={clsx(
                'border-t border-bg-border hover:bg-bg-elevated/40 transition',
                d.is_new === 1 && 'bg-accent-red/5'
              )}>
                <td className={clsx('px-4 py-2.5', sort.key === 'name' && 'col-sorted')}>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{categoryIcon(d.category)}</span>
                    <div>
                      <Link href={`/devices/${encodeURIComponent(d.mac)}`} className="font-medium text-slate-100 hover:text-accent">
                        {label(d)}
                      </Link>
                      <div className="text-xs text-slate-500">{d.vendor || 'Unknown vendor'}</div>
                    </div>
                    {d.is_new === 1 && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide bg-accent-red text-white rounded px-1.5 py-0.5 font-bold">NEW</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="text-slate-300">{d.ip ?? '—'}</div>
                  <div className="text-xs text-slate-500">{formatMacShort(d.mac)}</div>
                </td>
                <td className={clsx('px-4 py-2.5 text-right tabular-nums', (sort.key === 'down' || sort.key === 'up') && 'col-sorted')}>
                  {d.online ? (
                    <div className="leading-tight">
                      <div className={d.down_speed_bps > 0 ? 'text-blue-400' : 'text-slate-600'}>↓ {formatBps(d.down_speed_bps)}</div>
                      <div className={d.up_speed_bps > 0 ? 'text-orange-400 text-xs' : 'text-slate-600 text-xs'}>↑ {formatBps(d.up_speed_bps)}</div>
                    </div>
                  ) : <span className="text-slate-600">offline</span>}
                </td>
                <td className={clsx('px-4 py-2.5 text-right tabular-nums text-slate-300', sort.key === 'today' && 'col-sorted font-semibold')}>
                  <div className="leading-tight">
                    <div className="text-slate-200 font-semibold">{formatBytes(d.bytes_today + d.bytes_up_today)}</div>
                    <div className="text-[10px] text-slate-500">↓ {formatBytes(d.bytes_today, 0)} · ↑ {formatBytes(d.bytes_up_today, 0)}</div>
                  </div>
                </td>
                <td className={clsx('px-4 py-2.5 text-right tabular-nums text-slate-200 font-semibold', sort.key === 'total' && 'col-sorted')}>
                  <div className="leading-tight">
                    <div className="text-slate-100">{formatBytes(d.bytes_total + d.bytes_up_total)}</div>
                    <div className="text-[10px] text-slate-500 font-normal">↓ {formatBytes(d.bytes_total, 0)} · ↑ {formatBytes(d.bytes_up_total, 0)}</div>
                  </div>
                </td>
                <td className={clsx('px-4 py-2.5 text-right text-xs', sort.key === 'last_seen' && 'col-sorted')}>
                  <div className={d.online ? 'text-accent-green' : 'text-slate-400'}>{lastOnlineLabel(d)}</div>
                  {d.last_online_at && (
                    <div className="text-[10px] text-slate-600">{new Date(d.last_online_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {d.is_new === 1 && (
                    <button onClick={() => dismissNew(d.mac)}
                      className="text-xs px-2 py-1 rounded bg-accent-green/10 text-accent-green border border-accent-green/30 hover:bg-accent-green/20">
                      Mark known
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {devices.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No devices match the current filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function label(d: { custom_label: string | null; hostname: string | null; router_remark: string | null; mac: string }): string {
  return d.custom_label || d.router_remark || d.hostname || d.mac;
}

function lastOnlineLabel(d: { online: 0 | 1; last_online_at: number | null }): string {
  if (d.online === 1) return 'online now';
  return d.last_online_at ? timeAgo(d.last_online_at) : 'never online';
}

function lastOnlineSortValue(d: { online: 0 | 1; last_online_at: number | null }): number {
  if (d.online === 1) return Date.now();
  return d.last_online_at ?? 0;
}

function Th({ label, active, indicator, onClick, align = 'right', hint }: {
  label: string; active: boolean; indicator: string;
  onClick: () => void; align?: 'left' | 'right'; hint?: string;
}) {
  return (
    <th
      onClick={onClick}
      title={hint ?? `Sort by ${label}`}
      className={clsx(
        'th-sortable',
        align === 'left' ? 'text-left' : 'text-right',
        active && 'active'
      )}
    >
      {label}{indicator}
    </th>
  );
}
