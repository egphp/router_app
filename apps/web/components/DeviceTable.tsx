'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { formatBps, formatBytes, formatMacShort, categoryIcon, timeAgo } from '../lib/format';
import { formatDevicePolicyBadge, formatSpeedLimitKbs } from '../lib/control-format';
import { usePersistedState } from '../lib/usePersistedState';
import { useTableSort, sortNum, sortStr, type SortDir } from '../lib/useTableSort';
import { DeviceControlModal } from './DeviceControlModal';
import { clsx } from 'clsx';
import { Trash2, Lock, Sliders, Globe, Gauge } from 'lucide-react';

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
  reserved?: 0 | 1;
  reserved_ip?: string | null;
  download_limit_kbs?: number;
  upload_limit_kbs?: number;
  qos_known?: 0 | 1;
  wan_port?: string | null;
  wan_group_name?: string | null;
  wan_inherited_range?: 0 | 1;
  auto_qos_state?: 'pending' | 'applied' | 'reviewed' | 'skipped' | null;
}

type SortKey = 'name' | 'limit' | 'down' | 'up' | 'today' | 'total' | 'last_seen';
type Filter = 'all' | 'online' | 'offline' | 'limited' | 'reserved' | 'wan1' | 'wan2' | 'quarantined' | 'new';

const VALID_FILTERS = new Set<Filter>(['all', 'online', 'offline', 'limited', 'reserved', 'wan1', 'wan2', 'quarantined', 'new']);

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
  const [deletingMac, setDeletingMac] = useState<string | null>(null);
  const [editingMac, setEditingMac] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const param = new URLSearchParams(window.location.search).get('filter') as Filter | null;
    if (param && VALID_FILTERS.has(param)) {
      setFilter(param);
    }
  }, [setFilter]);

  const editingDevice = useMemo(
    () => (editingMac ? (data?.devices ?? []).find((d) => d.mac === editingMac) ?? null : null),
    [data, editingMac],
  );

  const devices = useMemo(() => {
    let list = data?.devices ?? [];
    if (filter === 'online') list = list.filter((d) => d.online === 1);
    if (filter === 'offline') list = list.filter((d) => d.online !== 1);
    if (filter === 'limited') list = list.filter((d) => (d.download_limit_kbs ?? 0) > 0 || (d.upload_limit_kbs ?? 0) > 0);
    if (filter === 'reserved') list = list.filter((d) => d.reserved === 1);
    if (filter === 'wan1') list = list.filter((d) => (d.wan_port ?? '').toUpperCase() === 'WAN1');
    if (filter === 'wan2') list = list.filter((d) => (d.wan_port ?? '').toUpperCase() === 'WAN2');
    if (filter === 'quarantined') list = list.filter((d) => d.auto_qos_state === 'applied' || d.auto_qos_state === 'pending');
    if (filter === 'new') list = list.filter((d) => d.is_new === 1);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((d) =>
        (d.custom_label || d.hostname || d.router_remark || '').toLowerCase().includes(q) ||
        (d.ip || '').includes(q) ||
        d.mac.toLowerCase().includes(q) ||
        (d.wan_port || '').toLowerCase().includes(q) ||
        (d.wan_group_name || '').toLowerCase().includes(q)
      );
    }
    const dir = sort.dir;
    list = [...list].sort((a, b) => {
      switch (sort.key) {
        case 'name': return sortStr(label(a), label(b), dir);
        case 'limit': return sortNum((a.download_limit_kbs ?? 0) + (a.upload_limit_kbs ?? 0), (b.download_limit_kbs ?? 0) + (b.upload_limit_kbs ?? 0), dir);
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

  const removeDevice = async (device: DeviceRow) => {
    const name = label(device);
    const confirmed = window.confirm(
      `Delete ${name} and its stored local traffic history?\n\nIf the router still sees this device, it can appear again on the next sample.`,
    );
    if (!confirmed) return;

    setDeletingMac(device.mac);
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(device.mac)}`, { method: 'DELETE' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        window.alert(body?.error ?? 'Delete failed');
        return;
      }
      await mutate();
    } finally {
      setDeletingMac(null);
    }
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
          <option value="all">All</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="limited">Speed limited</option>
          <option value="reserved">Reserved IP</option>
          <option value="wan1">Pinned: WAN1</option>
          <option value="wan2">Pinned: WAN2</option>
          <option value="quarantined">Auto-SD (New)</option>
          <option value="new">New</option>
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
          <option value="limit:desc">Sort: speed cap ↓</option>
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
                    <bdi>{label(d)}</bdi>
                  </Link>
                  {d.is_new === 1 && (
                    <span className="text-[9px] uppercase tracking-wide bg-accent-red text-white rounded px-1.5 py-0.5 font-bold leading-none">NEW</span>
                  )}
                  {d.reserved === 1 && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded bg-accent-green/15 text-accent-green flex items-center gap-1"
                      title={d.reserved_ip ? `Address reservation → ${d.reserved_ip}` : 'Address reserved on router'}
                    >
                      <Lock size={9} /> reserved
                    </span>
                  )}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${d.online ? 'bg-accent-green/20 text-accent-green' : 'bg-slate-700/40 text-slate-500'}`}>
                    {d.online ? 'online' : 'offline'}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 truncate" dir="ltr">
                  <span className="font-mono tabular-nums">{d.ip ?? '—'}</span> · <span className="font-mono tabular-nums">{formatMacShort(d.mac)}</span> · <span>{d.vendor || 'Unknown'}</span>
                </div>
                <div className="mt-2">
                  <DevicePolicyBadges device={d} onOpen={() => setEditingMac(d.mac)} />
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-xs tabular-nums" dir="ltr">
                  <div><span className="text-slate-500">↓ now:</span> <span className={d.online && d.down_speed_bps > 0 ? 'text-blue-400' : 'text-slate-600'}>{d.online ? formatBps(d.down_speed_bps) : '—'}</span></div>
                  <div><span className="text-slate-500">↑ now:</span> <span className={d.online && d.up_speed_bps > 0 ? 'text-orange-400' : 'text-slate-600'}>{d.online ? formatBps(d.up_speed_bps) : '—'}</span></div>
                  <div>
                    <span className="text-slate-500">Today:</span>{' '}
                    <span className="text-slate-100 font-semibold">↓ {formatBytes(d.bytes_today)}</span>
                    <div className="text-[10px] text-slate-500">↑ {formatBytes(d.bytes_up_today, 0)}</div>
                  </div>
                  <div>
                    <span className="text-slate-500">All-time:</span>{' '}
                    <span className="text-slate-100 font-semibold">↓ {formatBytes(d.bytes_total)}</span>
                    <div className="text-[10px] text-slate-500">↑ {formatBytes(d.bytes_up_total, 0)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-[10px] text-slate-500">{lastOnlineLabel(d)}</span>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingMac(d.mac)}
                      className="text-[10px] px-2 py-1 rounded bg-[var(--peach-soft)] text-[var(--peach)] border border-[var(--peach)]/35 flex items-center gap-1"
                    >
                      <Sliders size={11} /> Control
                    </button>
                    {d.is_new === 1 && (
                      <button onClick={() => dismissNew(d.mac)}
                        className="text-[10px] px-2 py-1 rounded bg-accent-green/10 text-accent-green border border-accent-green/30">
                        Mark known
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeDevice(d)}
                      disabled={deletingMac === d.mac}
                      className="text-[10px] px-2 py-1 rounded bg-accent-red/10 text-accent-red border border-accent-red/30 disabled:opacity-50 flex items-center gap-1"
                    >
                      <Trash2 size={11} /> Delete
                    </button>
                  </div>
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
              <Th label="Policy (WAN · Speed)" active={sort.key === 'limit'} indicator={indicator('limit')} onClick={() => onSort('limit', 'desc')} align="left" />
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
                        <bdi>{label(d)}</bdi>
                      </Link>
                      <div className="text-xs text-slate-500">{d.vendor || 'Unknown vendor'}</div>
                    </div>
                    {d.is_new === 1 && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide bg-accent-red text-white rounded px-1.5 py-0.5 font-bold">NEW</span>
                    )}
                    {d.reserved === 1 && (
                      <span
                        className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-accent-green/15 text-accent-green flex items-center gap-1"
                        title={d.reserved_ip ? `Address reservation → ${d.reserved_ip}` : 'Address reserved on router'}
                      >
                        <Lock size={10} /> reserved
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5 font-mono tabular-nums" dir="ltr">
                  <div className="text-slate-300">{d.ip ?? '—'}</div>
                  <div className="text-xs text-slate-500">{formatMacShort(d.mac)}</div>
                </td>
                <td className={clsx('px-4 py-2.5', sort.key === 'limit' && 'col-sorted')}>
                  <DevicePolicyBadges device={d} onOpen={() => setEditingMac(d.mac)} />
                </td>
                <td className={clsx('px-4 py-2.5 text-right tabular-nums', (sort.key === 'down' || sort.key === 'up') && 'col-sorted')} dir="ltr">
                  {d.online ? (
                    <div className="leading-tight">
                      <div className={d.down_speed_bps > 0 ? 'text-blue-400' : 'text-slate-600'}>↓ {formatBps(d.down_speed_bps)}</div>
                      <div className={d.up_speed_bps > 0 ? 'text-orange-400 text-xs' : 'text-slate-600 text-xs'}>↑ {formatBps(d.up_speed_bps)}</div>
                    </div>
                  ) : <span className="text-slate-600">offline</span>}
                </td>
                <td className={clsx('px-4 py-2.5 text-right tabular-nums text-slate-300', sort.key === 'today' && 'col-sorted font-semibold')} dir="ltr">
                  <div className="leading-tight" title="Download is matched to the router's per-device counter. Upload is integrated from instant samples and reconciled against the WAN counter.">
                    <div className="text-slate-100 font-semibold">↓ {formatBytes(d.bytes_today)}</div>
                    <div className="text-[10px] text-slate-500">↑ {formatBytes(d.bytes_up_today, 0)}</div>
                  </div>
                </td>
                <td className={clsx('px-4 py-2.5 text-right tabular-nums text-slate-200 font-semibold', sort.key === 'total' && 'col-sorted')} dir="ltr">
                  <div className="leading-tight">
                    <div className="text-slate-100">↓ {formatBytes(d.bytes_total)}</div>
                    <div className="text-[10px] text-slate-500 font-normal">↑ {formatBytes(d.bytes_up_total, 0)}</div>
                  </div>
                </td>
                <td className={clsx('px-4 py-2.5 text-right text-xs', sort.key === 'last_seen' && 'col-sorted')}>
                  <div className={d.online ? 'text-accent-green' : 'text-slate-400'}>{lastOnlineLabel(d)}</div>
                  {d.last_online_at && (
                    <div className="text-[10px] text-slate-600">{new Date(d.last_online_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingMac(d.mac)}
                      title={`Control speed & WAN for ${label(d)}`}
                      aria-label={`Control ${label(d)}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded border border-[var(--peach)]/35 bg-[var(--peach-soft)] text-[var(--peach)] hover:opacity-90"
                    >
                      <Sliders size={13} />
                    </button>
                    {d.is_new === 1 && (
                      <button onClick={() => dismissNew(d.mac)}
                        className="text-xs px-2 py-1 rounded bg-accent-green/10 text-accent-green border border-accent-green/30 hover:bg-accent-green/20">
                        Mark known
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeDevice(d)}
                      disabled={deletingMac === d.mac}
                      title="Delete device"
                      aria-label={`Delete ${label(d)}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded border border-accent-red/30 bg-accent-red/10 text-accent-red hover:bg-accent-red/20 disabled:opacity-50"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {devices.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-500">No devices match the current filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <DeviceControlModal device={editingDevice} onClose={() => setEditingMac(null)} />
    </div>
  );
}

function DevicePolicyBadges({ device, onOpen }: { device: DeviceRow; onOpen: () => void }) {
  const dl = device.download_limit_kbs ?? 0;
  const ul = device.upload_limit_kbs ?? 0;
  const hasLimit = dl > 0 || ul > 0;
  const isQuarantined = device.auto_qos_state === 'applied' || device.auto_qos_state === 'pending';
  const wan = device.wan_port ? device.wan_port.toUpperCase() : null;

  if (!wan && !hasLimit && !isQuarantined) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="btn-ghost !px-2.5 !py-1 !text-[11px] inline-flex items-center gap-1.5 opacity-80 hover:opacity-100"
      >
        <Sliders size={11} />
        <span>Auto · Unlimited</span>
      </button>
    );
  }

  const speedTooltip = `Download: ${formatSpeedLimitKbs(dl || (isQuarantined ? 256 : 0))} · Upload: ${formatSpeedLimitKbs(ul || (isQuarantined ? 64 : 0))}`;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${wan ? `WAN: ${wan}${device.wan_group_name ? ` (${device.wan_group_name})` : ''} · ` : ''}${speedTooltip} — Click to edit`}
      className="inline-flex items-center gap-1.5 flex-wrap text-left hover:opacity-90 transition-opacity"
      dir="ltr"
    >
      {wan && (
        <span
          className={clsx(
            'chip !py-0.5 !px-2 !text-[10px] font-mono tabular-nums whitespace-nowrap',
            wan === 'WAN1' ? 'chip-mint' : 'chip-lavender',
          )}
        >
          <Globe size={10} />
          {wan}
        </span>
      )}
      {isQuarantined ? (
        <span className="chip chip-sun !py-0.5 !px-2 !text-[10px] font-mono tabular-nums whitespace-nowrap">
          <Gauge size={10} />
          Auto SD · {formatDevicePolicyBadge(dl || 256, ul || 64)}
        </span>
      ) : hasLimit ? (
        <span className="chip chip-peach !py-0.5 !px-2 !text-[10px] font-mono tabular-nums whitespace-nowrap">
          <Gauge size={10} />
          {formatDevicePolicyBadge(dl, ul)}
        </span>
      ) : null}
    </button>
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
