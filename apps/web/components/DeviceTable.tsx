'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { formatBps, formatBytes, formatMacShort, categoryIcon, timeAgo } from '../lib/format';
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
  last_seen: number;
  first_seen: number;
}

type SortKey = 'name' | 'down' | 'up' | 'today' | 'total' | 'last_seen';
type Filter = 'all' | 'online' | 'offline' | 'new';

export function DeviceTable() {
  const { data, mutate } = useSWR<{ devices: DeviceRow[] }>('/api/devices', fetcher, { refreshInterval: 10000 });
  const [sort, setSort] = useState<SortKey>('today');
  const [filter, setFilter] = useState<Filter>('all');
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
    list = [...list].sort((a, b) => {
      switch (sort) {
        case 'name': return (label(a) || '').localeCompare(label(b) || '');
        case 'down': return b.down_speed_bps - a.down_speed_bps;
        case 'up': return b.up_speed_bps - a.up_speed_bps;
        case 'today': return b.bytes_today - a.bytes_today;
        case 'total': return b.bytes_total - a.bytes_total;
        case 'last_seen': return b.last_seen - a.last_seen;
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

  return (
    <div className="card overflow-hidden animate-fade-in">
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-bg-border">
        <div className="font-semibold">Devices <span className="text-slate-500 text-sm">({devices.length})</span></div>
        {newCount > 0 && (
          <span className="text-xs bg-accent-red/20 text-accent-red rounded-full px-2 py-0.5 border border-accent-red/30">
            🔴 {newCount} new
          </span>
        )}
        <div className="flex-1" />
        <input
          type="text" placeholder="Search name / IP / MAC"
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="bg-bg-elevated border border-bg-border rounded-md px-3 py-1.5 text-sm w-56 focus:outline-none focus:border-accent"
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}
          className="bg-bg-elevated border border-bg-border rounded-md px-2 py-1.5 text-sm">
          <option value="all">All</option><option value="online">Online</option>
          <option value="offline">Offline</option><option value="new">New</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
          className="bg-bg-elevated border border-bg-border rounded-md px-2 py-1.5 text-sm">
          <option value="today">Sort by today</option>
          <option value="total">Sort by total</option>
          <option value="down">Sort by ↓ speed</option>
          <option value="up">Sort by ↑ speed</option>
          <option value="name">Sort by name</option>
          <option value="last_seen">Sort by last seen</option>
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500 bg-bg-elevated/40">
            <tr>
              <th className="px-4 py-2 text-left">Device</th>
              <th className="px-4 py-2 text-left">Address</th>
              <th className="px-4 py-2 text-right">↓ now</th>
              <th className="px-4 py-2 text-right">↑ now</th>
              <th className="px-4 py-2 text-right">Today</th>
              <th className="px-4 py-2 text-right">All-time</th>
              <th className="px-4 py-2 text-right">Last seen</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.mac} className={clsx(
                'border-t border-bg-border hover:bg-bg-elevated/40 transition',
                d.is_new === 1 && 'bg-accent-red/5'
              )}>
                <td className="px-4 py-2.5">
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
                <td className="px-4 py-2.5 text-right tabular-nums">
                  <span className={d.online && d.down_speed_bps > 0 ? 'text-blue-400' : 'text-slate-500'}>
                    {d.online ? formatBps(d.down_speed_bps) : <span className="text-slate-600">offline</span>}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  <span className={d.online && d.up_speed_bps > 0 ? 'text-orange-400' : 'text-slate-500'}>
                    {d.online ? formatBps(d.up_speed_bps) : '—'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{formatBytes(d.bytes_today)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-200 font-semibold">{formatBytes(d.bytes_total)}</td>
                <td className="px-4 py-2.5 text-right text-xs text-slate-500">{timeAgo(d.last_seen)}</td>
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
