'use client';

import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { clsx } from 'clsx';
import { Check, Gauge, Globe, Loader2, Lock, Settings2, ShieldCheck } from 'lucide-react';
import { fetcher } from '../lib/fetcher';
import { formatBps } from '../lib/format';
import { MAX_ROUTER_KBS } from '../lib/control-format';

interface NetworkControlSummaryResponse {
  ok: boolean;
  qos_policy: number;
  wan_route_policy: string;
  wan_ports: Array<{
    wan_id: number;
    wan_name: string;
    status: string;
    wan_type: string | null;
    wan_ip: string | null;
    wan_gateway: string | null;
    up_flux_bps: number;
    down_flux_bps: number;
    pinned_device_count: number;
    updated_at: number;
  }>;
  limited_devices_count: number;
  pinned_devices_count: number;
  reserved_devices_count?: number;
  auto_qos_policy: {
    enabled: boolean;
    auto_reserve?: boolean;
    download_limit_kbs: number;
    upload_limit_kbs: number;
    quarantined_count: number;
  };
}

export function WanQosOverview() {
  const { data, mutate } = useSWR<NetworkControlSummaryResponse>('/api/network-control', fetcher, {
    refreshInterval: 10000,
    keepPreviousData: true,
  });

  const [editingGuard, setEditingGuard] = useState(false);
  const [guardEnabled, setGuardEnabled] = useState(true);
  const [guardAutoReserve, setGuardAutoReserve] = useState(true);
  const [guardDl, setGuardDl] = useState('256');
  const [guardUl, setGuardUl] = useState('64');
  const [saving, setSaving] = useState(false);

  if (!data) return null;

  const wans = data.wan_ports ?? [];
  const autoGuard = data.auto_qos_policy ?? {
    enabled: true,
    auto_reserve: true,
    download_limit_kbs: 256,
    upload_limit_kbs: 64,
    quarantined_count: 0,
  };
  const autoReserveOn = autoGuard.auto_reserve !== false;

  const openEditor = () => {
    setGuardEnabled(autoGuard.enabled);
    setGuardAutoReserve(autoReserveOn);
    setGuardDl(String(autoGuard.download_limit_kbs));
    setGuardUl(String(autoGuard.upload_limit_kbs));
    setEditingGuard((v) => !v);
  };

  const saveGuard = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const dl = Math.max(0, Math.min(MAX_ROUTER_KBS, Math.round(Number(guardDl) || 0)));
      const ul = Math.max(0, Math.min(MAX_ROUTER_KBS, Math.round(Number(guardUl) || 0)));
      await fetch('/api/network-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: guardEnabled,
          auto_reserve: guardAutoReserve,
          download_limit_kbs: dl,
          upload_limit_kbs: ul,
        }),
      });
      await mutate();
      setEditingGuard(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-3.5 sm:p-4 animate-fade-in space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 sm:gap-3">
        {/* WAN Ports */}
        {(wans.length > 0
          ? wans
          : [
              { wan_id: 1, wan_name: 'WAN1', status: 'wired', wan_ip: null, wan_gateway: null, up_flux_bps: 0, down_flux_bps: 0, pinned_device_count: 0 },
              { wan_id: 2, wan_name: 'WAN2', status: 'wired', wan_ip: null, wan_gateway: null, up_flux_bps: 0, down_flux_bps: 0, pinned_device_count: 0 },
            ]
        ).map((w) => {
          const connected = w.status === 'wired' || w.status === 'connected';
          const isWan1 = w.wan_id === 1;
          const filterKey = w.wan_name.toLowerCase();
          return (
            <Link
              key={w.wan_name}
              href={`/devices?filter=${encodeURIComponent(filterKey)}`}
              className="rounded-xl p-3 border border-[var(--border)] bg-[var(--bg)]/35 hover:border-[var(--border-strong)] transition-[border-color,background-color] flex flex-col justify-between gap-2"
            >
              <div className="flex items-center justify-between gap-2" dir="ltr">
                <span className="inline-flex items-center gap-2 text-xs font-semibold" style={{ color: isWan1 ? 'var(--mint)' : 'var(--lavender)' }}>
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: connected ? 'var(--mint)' : 'var(--coral)' }}
                  />
                  <Globe size={13} />
                  {w.wan_name}
                  <span className="font-mono text-[11px] font-normal" style={{ color: 'var(--text-3)' }}>
                    {w.wan_ip || w.status}
                  </span>
                </span>
                <span className={clsx('chip !py-0.5 !px-2 !text-[10px] tabular-nums', isWan1 ? 'chip-mint' : 'chip-lavender')}>
                  {w.pinned_device_count} pinned
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 text-xs font-mono tabular-nums" dir="ltr">
                <span style={{ color: 'var(--ice)' }}>↓ {formatBps(w.down_flux_bps)}</span>
                <span style={{ color: 'var(--peach)' }}>↑ {formatBps(w.up_flux_bps)}</span>
              </div>
            </Link>
          );
        })}

        {/* QoS Summary + Auto-SD & Auto-Reservation New-Device Guard */}
        <div
          className="rounded-xl p-3 border border-[var(--border)] bg-[var(--bg)]/35 flex flex-col justify-between gap-2"
          dir="rtl"
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2.5 flex-wrap">
              <Link
                href="/devices?filter=limited"
                className="inline-flex items-center gap-1.5 text-xs font-semibold hover:underline"
                style={{ color: 'var(--peach)' }}
              >
                <Gauge size={13} />
                <span className="tabular-nums">{data.limited_devices_count} محددة السرعة</span>
              </Link>
              {typeof data.reserved_devices_count === 'number' && data.reserved_devices_count > 0 && (
                <Link
                  href="/devices?filter=reserved"
                  className="inline-flex items-center gap-1 text-[11px] font-medium hover:underline"
                  style={{ color: 'var(--mint)' }}
                >
                  <Lock size={11} />
                  <span className="tabular-nums">{data.reserved_devices_count} مثبّت</span>
                </Link>
              )}
            </div>

            <button
              type="button"
              onClick={openEditor}
              className="btn-ghost !px-2 !py-0.5 !text-[11px] inline-flex items-center gap-1"
            >
              <Settings2 size={11} />
              <span>ضبط التلقائي</span>
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap text-[11px]">
            <div
              className="inline-flex items-center gap-1.5 flex-wrap"
              style={{ color: autoGuard.enabled || autoReserveOn ? 'var(--mint)' : 'var(--text-3)' }}
            >
              <ShieldCheck size={13} className="shrink-0" />
              <span>الجديد تلقائياً:</span>
              {autoReserveOn && (
                <span className="chip chip-mint !py-0 !px-1.5 !text-[10px]">
                  <Lock size={9} /> تثبيت IP
                </span>
              )}
              {autoGuard.enabled && (
                <bdi dir="ltr" className="font-mono tabular-nums font-semibold">
                  SD ↓ {autoGuard.download_limit_kbs} / ↑ {autoGuard.upload_limit_kbs} KB/s
                </bdi>
              )}
              {!autoGuard.enabled && !autoReserveOn && <span>متوقف</span>}
            </div>

            {autoGuard.quarantined_count > 0 && (
              <Link
                href="/devices?filter=quarantined"
                className="chip chip-sun !py-0.5 !px-2 !text-[10px] tabular-nums"
              >
                {autoGuard.quarantined_count} بانتظار المراجعة
              </Link>
            )}
          </div>
        </div>
      </div>

      {editingGuard && (
        <div
          className="rounded-xl p-3 border border-[var(--border)] bg-[var(--bg-elevated)]/40 flex flex-col gap-3"
          dir="rtl"
        >
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={guardAutoReserve}
                onChange={(e) => setGuardAutoReserve(e.target.checked)}
                className="accent-[var(--mint)] w-4 h-4"
              />
              <span className="font-medium" style={{ color: 'var(--text)' }}>
                تثبيت عنوان الـ IP تلقائياً لأي جهاز جديد (<bdi dir="ltr">Auto DHCP Reservation</bdi>)
              </span>
            </label>

            <label className="inline-flex items-center gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={guardEnabled}
                onChange={(e) => setGuardEnabled(e.target.checked)}
                className="accent-[var(--mint)] w-4 h-4"
              />
              <span className="font-medium" style={{ color: 'var(--text)' }}>
                تقييد سرعة أي جهاز جديد تلقائياً (<bdi dir="ltr">Auto SD QoS</bdi>) لحين مراجعته
              </span>
            </label>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end" dir="ltr">
            <label className="inline-flex items-center gap-1.5 text-xs">
              <span style={{ color: 'var(--ice)' }}>↓ Down (KB/s):</span>
              <input
                type="number"
                min={0}
                max={MAX_ROUTER_KBS}
                value={guardDl}
                onChange={(e) => setGuardDl(e.target.value)}
                className="input-aurora !py-1 !px-2.5 w-24 font-mono tabular-nums text-xs"
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-xs">
              <span style={{ color: 'var(--peach)' }}>↑ Up (KB/s):</span>
              <input
                type="number"
                min={0}
                max={MAX_ROUTER_KBS}
                value={guardUl}
                onChange={(e) => setGuardUl(e.target.value)}
                className="input-aurora !py-1 !px-2.5 w-20 font-mono tabular-nums text-xs"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setGuardEnabled(true);
                setGuardAutoReserve(true);
                setGuardDl('256');
                setGuardUl('64');
              }}
              className="btn-ghost !py-1 !px-2 text-[11px]"
            >
              SD + Reserve (256/64)
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={saveGuard}
              className="btn-primary !py-1.5 !px-3 !text-xs inline-flex items-center gap-1.5"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              <span>حفظ</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
