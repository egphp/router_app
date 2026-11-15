'use client';

import { useEffect, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Gauge,
  Globe,
  Infinity as InfinityIcon,
  Loader2,
  Lock,
  ShieldAlert,
  Sliders,
  Sparkles,
  Unlock,
  X,
} from 'lucide-react';
import { fetcher } from '../lib/fetcher';
import {
  DOWNLOAD_SPEED_PRESETS,
  MAX_ROUTER_KBS,
  UPLOAD_SPEED_PRESETS,
  formatMbpsEquivalent,
  formatSpeedLimitKbs,
  kbsToMbps,
  mbpsToKbs,
  suggestIpGroupName,
} from '../lib/control-format';

export interface ControllableDevice {
  mac: string;
  ip?: string | null;
  reserved?: 0 | 1;
  reserved_ip?: string | null;
  hostname?: string | null;
  router_remark?: string | null;
  custom_label?: string | null;
  online?: 0 | 1 | null;
  is_new?: 0 | 1;
  download_limit_kbs?: number;
  upload_limit_kbs?: number;
  qos_known?: 0 | 1;
  wan_port?: string | null;
  wan_group_name?: string | null;
  wan_inherited_range?: 0 | 1;
  auto_qos_state?: 'pending' | 'applied' | 'reviewed' | 'skipped' | null;
}

interface NetworkControlData {
  ok: boolean;
  wan_ports: Array<{
    wan_id: number;
    wan_name: string;
    status: string;
    wan_ip: string | null;
    down_flux_bps: number;
    up_flux_bps: number;
    pinned_device_count: number;
  }>;
}

type SpeedUnit = 'kbs' | 'mbps';

export function DeviceControlPanel({
  device,
  onSaved,
  compact = false,
}: {
  device: ControllableDevice;
  onSaved?: () => void;
  compact?: boolean;
}) {
  const { mutate: globalMutate } = useSWRConfig();
  const { data: netCtrl } = useSWR<NetworkControlData>('/api/network-control', fetcher, {
    refreshInterval: 15000,
    keepPreviousData: true,
  });

  const currentDlKbs = Math.max(0, Math.round(Number(device.download_limit_kbs ?? 0)));
  const currentUlKbs = Math.max(0, Math.round(Number(device.upload_limit_kbs ?? 0)));
  const currentWan = device.wan_port ? device.wan_port.toUpperCase() : 'auto';
  const currentReserved = device.reserved === 1;
  const effectiveIp = (device.ip || device.reserved_ip || '').trim() || null;
  const defaultGroupName =
    device.wan_group_name ||
    suggestIpGroupName(device.custom_label || device.router_remark || device.hostname, effectiveIp);

  const [dlKbs, setDlKbs] = useState<number>(currentDlKbs);
  const [ulKbs, setUlKbs] = useState<number>(currentUlKbs);
  const [wanPort, setWanPort] = useState<string>(currentWan);
  const [wanGroupName, setWanGroupName] = useState<string>(defaultGroupName);
  const [dhcpReserved, setDhcpReserved] = useState<boolean>(currentReserved);
  const [unit, setUnit] = useState<SpeedUnit>('kbs');
  const [dlInput, setDlInput] = useState<string>(currentDlKbs > 0 ? String(currentDlKbs) : '');
  const [ulInput, setUlInput] = useState<string>(currentUlKbs > 0 ? String(currentUlKbs) : '');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Sync external device changes when user isn't mid-save
  useEffect(() => {
    setDlKbs(currentDlKbs);
    setUlKbs(currentUlKbs);
    setWanPort(currentWan);
    setWanGroupName(
      device.wan_group_name ||
      suggestIpGroupName(device.custom_label || device.router_remark || device.hostname, effectiveIp),
    );
    setDhcpReserved(currentReserved);
    setDlInput(formatForUnit(currentDlKbs, unit));
    setUlInput(formatForUnit(currentUlKbs, unit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.mac, currentDlKbs, currentUlKbs, currentWan, currentReserved, device.wan_group_name]);

  const switchUnit = (nextUnit: SpeedUnit) => {
    setUnit(nextUnit);
    setDlInput(formatForUnit(dlKbs, nextUnit));
    setUlInput(formatForUnit(ulKbs, nextUnit));
  };

  const onDlTextChange = (raw: string) => {
    setDlInput(raw);
    const trimmed = raw.trim();
    if (!trimmed || Number(trimmed) <= 0) {
      setDlKbs(0);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    setDlKbs(unit === 'mbps' ? mbpsToKbs(n) : Math.min(MAX_ROUTER_KBS, Math.round(n)));
  };

  const onUlTextChange = (raw: string) => {
    setUlInput(raw);
    const trimmed = raw.trim();
    if (!trimmed || Number(trimmed) <= 0) {
      setUlKbs(0);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    setUlKbs(unit === 'mbps' ? mbpsToKbs(n) : Math.min(MAX_ROUTER_KBS, Math.round(n)));
  };

  const pickDlPreset = (kbs: number) => {
    setDlKbs(kbs);
    setDlInput(formatForUnit(kbs, unit));
  };

  const pickUlPreset = (kbs: number) => {
    setUlKbs(kbs);
    setUlInput(formatForUnit(kbs, unit));
  };

  const applyQuickProfile = (nextDl: number, nextUl: number) => {
    pickDlPreset(nextDl);
    pickUlPreset(nextUl);
  };

  const wanOptions = useMemo(() => {
    const ports = netCtrl?.wan_ports && netCtrl.wan_ports.length > 0
      ? netCtrl.wan_ports
      : [
          { wan_id: 1, wan_name: 'WAN1', status: 'wired', wan_ip: null, down_flux_bps: 0, up_flux_bps: 0, pinned_device_count: 0 },
          { wan_id: 2, wan_name: 'WAN2', status: 'wired', wan_ip: null, down_flux_bps: 0, up_flux_bps: 0, pinned_device_count: 0 },
        ];
    return ports;
  }, [netCtrl]);

  const wanRangeLocked = device.wan_inherited_range === 1;
  const canEditWan = Boolean(effectiveIp) && !wanRangeLocked;
  const canEditDhcp = Boolean(effectiveIp) || currentReserved;
  const qosUnavailableOffline = device.qos_known === 0 && device.online !== 1;
  const isAutoQuarantined = device.auto_qos_state === 'applied' || device.auto_qos_state === 'pending';

  const cleanedGroupName = wanGroupName.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16);
  const groupNameChanged =
    canEditWan &&
    wanPort !== 'auto' &&
    Boolean(cleanedGroupName) &&
    cleanedGroupName !== (device.wan_group_name || '');

  const hasChanges =
    dlKbs !== currentDlKbs ||
    ulKbs !== currentUlKbs ||
    (canEditWan && wanPort !== currentWan) ||
    groupNameChanged ||
    (canEditDhcp && dhcpReserved !== currentReserved) ||
    isAutoQuarantined;

  const submitControl = async (override?: { dl: number; ul: number; wan?: string }) => {
    if (saving) return;
    setSaving(true);
    setFeedback(null);

    const targetDl = override ? override.dl : dlKbs;
    const targetUl = override ? override.ul : ulKbs;
    const targetWan = override?.wan ?? wanPort;

    const payload: Record<string, unknown> = {};
    if (canEditDhcp && dhcpReserved !== currentReserved && !override) {
      payload.dhcp_reserved = dhcpReserved;
    }
    if (!qosUnavailableOffline && (targetDl !== currentDlKbs || targetUl !== currentUlKbs || override || isAutoQuarantined)) {
      payload.download_limit_kbs = targetDl;
      payload.upload_limit_kbs = targetUl;
    }
    if (canEditWan && (targetWan !== currentWan || groupNameChanged || override?.wan !== undefined)) {
      payload.wan_port = targetWan;
      if (targetWan !== 'auto' && cleanedGroupName) {
        payload.wan_group_name = cleanedGroupName;
      }
    }
    if (Object.keys(payload).length === 0) {
      payload.download_limit_kbs = targetDl;
      payload.upload_limit_kbs = targetUl;
    }

    try {
      const resp = await fetch(`/api/devices/${encodeURIComponent(device.mac)}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: 'Request failed' }));
      if (!resp.ok || !json.ok) {
        setFeedback({ kind: 'err', text: json.error || 'تعذر تطبيق الإعدادات على الراوتر' });
        return;
      }

      if (override) {
        pickDlPreset(override.dl);
        pickUlPreset(override.ul);
      }

      await Promise.all([
        globalMutate('/api/devices?live=1'),
        globalMutate('/api/network-control'),
        globalMutate('/api/status'),
        globalMutate((key) => typeof key === 'string' && key.startsWith(`/api/devices/${encodeURIComponent(device.mac)}`)),
      ]);

      setFeedback({
        kind: 'ok',
        text:
          targetDl === 0 && targetUl === 0 && targetWan === 'auto'
            ? 'تم فتح السرعة بالكامل والتوزيع التلقائي على الراوتر'
            : 'تم حفظ إعدادات السرعة والـ WAN على الراوتر مباشرة',
      });
      onSaved?.();
    } catch (err) {
      setFeedback({ kind: 'err', text: `خطأ في الاتصال: ${String(err)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={clsx('space-y-4', !compact && 'card p-4 sm:p-5 animate-fade-in')}>
      {!compact && (
        <div className="flex items-center justify-between gap-3 flex-wrap border-b border-[var(--border)]/60 pb-3">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: 'linear-gradient(135deg, var(--peach-soft), var(--lavender-soft))',
                border: '1.5px solid oklch(0.82 0.13 50 / 0.35)',
              }}
            >
              <Sliders size={15} style={{ color: 'var(--peach)' }} />
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                Router Speed &amp; Multi-WAN Control
              </div>
              <div className="text-xs" style={{ color: 'var(--text-3)' }}>
                تحكم مباشر في سرعة التحميل/الرفع وتوجيه خط الإنترنت (<span dir="ltr">WAN1 / WAN2</span>) على الراوتر
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap" dir="ltr">
            <span className={clsx('chip tabular-nums', wanPort === 'WAN1' ? 'chip-mint' : wanPort === 'WAN2' ? 'chip-lavender' : 'chip-muted')}>
              <Globe size={11} />
              {wanPort === 'auto' ? 'WAN: Auto' : wanPort}
            </span>
            <span className={clsx('chip tabular-nums', dlKbs > 0 || ulKbs > 0 ? 'chip-peach' : 'chip-muted')}>
              <Gauge size={11} />
              {dlKbs === 0 && ulKbs === 0 ? 'Unlimited' : `↓ ${dlKbs || '∞'} · ↑ ${ulKbs || '∞'} KB/s`}
            </span>
          </div>
        </div>
      )}

      {/* Auto-SD Quarantine Notice for New Devices */}
      {isAutoQuarantined && (
        <div
          className="rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          style={{
            background: 'linear-gradient(135deg, oklch(0.88 0.14 90 / 0.14), oklch(0.82 0.13 50 / 0.08))',
            border: '1.5px solid oklch(0.88 0.14 90 / 0.45)',
          }}
        >
          <div className="flex items-start gap-2.5">
            <ShieldAlert size={18} className="shrink-0 mt-0.5" style={{ color: 'var(--sun)' }} />
            <div className="text-xs leading-relaxed" dir="rtl">
              <div className="font-semibold" style={{ color: 'var(--sun)' }}>
                حماية تلقائية لجهاز جديد (وضع SD)
              </div>
              <div style={{ color: 'var(--text-2)' }}>
                تم تقييد هذا الجهاز تلقائياً بسرعة <bdi dir="ltr" className="font-mono tabular-nums">↓ 256 KB/s · ↑ 64 KB/s</bdi> فور دخوله الشبكة لحين مراجعتك. يمكنك فتح سرعته الآن أو تخصيصها بالأسفل.
              </div>
            </div>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => submitControl({ dl: 0, ul: 0 })}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-[transform,opacity,background-color] hover:-translate-y-0.5 disabled:opacity-50"
            style={{
              background: 'var(--mint)',
              color: 'oklch(0.20 0.04 275)',
            }}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Unlock size={13} />}
            <span>فك القيد وتأكيد الجهاز</span>
          </button>
        </div>
      )}

      {/* DHCP Static Reservation Control */}
      <div
        className="rounded-xl p-3 border border-[var(--border)] bg-[var(--bg)]/40 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
        dir="rtl"
      >
        <div className="flex items-start gap-2.5 min-w-0">
          <Lock size={15} className="shrink-0 mt-0.5" style={{ color: dhcpReserved ? 'var(--mint)' : 'var(--text-3)' }} />
          <div className="min-w-0">
            <div className="text-xs font-semibold flex items-center gap-2 flex-wrap" style={{ color: 'var(--text)' }}>
              <span>تثبيت عنوان الـ IP على الراوتر (<bdi dir="ltr">DHCP Reservation</bdi>)</span>
              {effectiveIp && (
                <bdi dir="ltr" className="font-mono tabular-nums text-[11px] px-1.5 py-0.5 rounded bg-white/5" style={{ color: 'var(--ice)' }}>
                  {effectiveIp}
                </bdi>
              )}
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
              يحفظ ربط <bdi dir="ltr" className="font-mono">MAC → IP</bdi> داخل جدول <bdi dir="ltr" className="font-mono">Static Bind</bdi> في الراوتر لمنع تغير عنوان الجهاز.
            </div>
          </div>
        </div>

        <button
          type="button"
          disabled={!canEditDhcp || saving}
          onClick={() => setDhcpReserved((v) => !v)}
          className={clsx(
            'shrink-0 inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold border transition-[background-color,border-color,color] disabled:opacity-40',
            dhcpReserved
              ? 'border-[var(--mint)] bg-[var(--mint-soft)] text-[var(--mint)]'
              : 'border-[var(--border)] bg-[var(--bg-elevated)]/50 text-[var(--text-2)] hover:border-[var(--border-strong)]',
          )}
        >
          {dhcpReserved ? <Lock size={12} /> : <Unlock size={12} />}
          <span>{dhcpReserved ? 'مثبّت (Reserved)' : 'تثبيت الـ IP الآن'}</span>
        </button>
      </div>

      {/* Multi-WAN Routing Selector (2-Stage: IP Group -> Multi-WAN Rule) */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="stat-label flex items-center gap-1.5">
            <Globe size={12} /> WAN Line Assignment · توجيه خط الإنترنت
          </div>
          {effectiveIp && (
            <span className="text-[11px] font-mono tabular-nums" dir="ltr" style={{ color: 'var(--text-3)' }}>
              Target IP: {effectiveIp}
              {dhcpReserved ? ' (Reserved)' : ''}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button
            type="button"
            disabled={!canEditWan || saving}
            onClick={() => setWanPort('auto')}
            className={clsx(
              'rounded-xl px-3 py-2.5 text-left border transition-[background-color,border-color,color] disabled:opacity-50',
              wanPort === 'auto'
                ? 'border-[var(--peach)] bg-[var(--peach-soft)]'
                : 'border-[var(--border)] bg-[var(--bg-elevated)]/45 hover:border-[var(--border-strong)]',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold" style={{ color: wanPort === 'auto' ? 'var(--peach)' : 'var(--text)' }}>
                Auto · تلقائي
              </span>
              {wanPort === 'auto' && <Check size={13} style={{ color: 'var(--peach)' }} />}
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
              Load balance across active WANs
            </div>
          </button>

          {wanOptions.map((w) => {
            const code = w.wan_name.toUpperCase();
            const active = wanPort === code;
            const connected = w.status === 'wired' || w.status === 'connected';
            const accentVar = w.wan_id === 1 ? 'var(--mint)' : 'var(--lavender)';
            const softVar = w.wan_id === 1 ? 'var(--mint-soft)' : 'var(--lavender-soft)';
            return (
              <button
                key={code}
                type="button"
                disabled={!canEditWan || saving}
                onClick={() => setWanPort(code)}
                className={clsx(
                  'rounded-xl px-3 py-2.5 text-left border transition-[background-color,border-color,color] disabled:opacity-50',
                  !active && 'border-[var(--border)] bg-[var(--bg-elevated)]/45 hover:border-[var(--border-strong)]',
                )}
                style={active ? { borderColor: accentVar, background: softVar } : undefined}
              >
                <div className="flex items-center justify-between gap-2" dir="ltr">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: active ? accentVar : 'var(--text)' }}>
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ background: connected ? 'var(--mint)' : 'var(--coral)' }}
                    />
                    {code}
                  </span>
                  {active && <Check size={13} style={{ color: accentVar }} />}
                </div>
                <div className="text-[11px] font-mono tabular-nums mt-0.5 truncate" dir="ltr" style={{ color: 'var(--text-3)' }}>
                  {w.wan_ip || w.status} · {w.pinned_device_count} pinned
                </div>
              </button>
            );
          })}
        </div>

        {/* 2-Stage Router Multi-WAN Preview & IP Group Name */}
        {canEditWan && wanPort !== 'auto' && (
          <div
            className="rounded-xl p-3 border border-[var(--border)] bg-[var(--bg)]/45 space-y-2"
            dir="rtl"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="text-xs font-semibold" style={{ color: 'var(--text-2)' }}>
                خطوات الربط المرحلي داخل الراوتر (<bdi dir="ltr">2-Stage Multi-WAN</bdi>):
              </div>
              <div className="flex items-center gap-1.5 text-[11px]" dir="ltr">
                <span className="chip chip-muted !py-0.5 !px-2 !text-[10px] font-mono">1. IP Group</span>
                <span style={{ color: 'var(--text-3)' }}>→</span>
                <span className={clsx('chip !py-0.5 !px-2 !text-[10px] font-mono', wanPort === 'WAN1' ? 'chip-mint' : 'chip-lavender')}>
                  2. Multi-WAN → {wanPort}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 items-center pt-0.5">
              <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
                <div>
                  <strong style={{ color: 'var(--text-2)' }}>المرحلة ١:</strong> إنشاء/تحديث جروب بالـ IP (<bdi dir="ltr" className="font-mono">{effectiveIp}</bdi>)
                </div>
                <div>
                  <strong style={{ color: 'var(--text-2)' }}>المرحلة ٢:</strong> تفعيل <bdi dir="ltr" className="font-mono">Multi-WAN Custom</bdi> وتوجيه الاسم لـ <bdi dir="ltr" className="font-mono">{wanPort}</bdi>
                </div>
              </div>

              <div dir="ltr" className="space-y-1">
                <label className="block text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-3)' }}>
                  IP Group Name (A-Z, 0-9, _ · max 16)
                </label>
                <input
                  type="text"
                  maxLength={16}
                  disabled={saving}
                  value={wanGroupName}
                  onChange={(e) => setWanGroupName(e.target.value.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16))}
                  placeholder="e.g. living_tv"
                  className="input-aurora w-full !py-1.5 !px-2.5 font-mono text-xs"
                />
              </div>
            </div>
          </div>
        )}

        {!effectiveIp && (
          <div className="text-[11px] flex items-center gap-1.5" dir="rtl" style={{ color: 'var(--text-3)' }}>
            <AlertTriangle size={12} className="shrink-0" style={{ color: 'var(--sun)' }} />
            <span>لا يوجد عنوان IP مسجّل لهذا الجهاز حالياً؛ ربط WAN محدد يتطلب اتصال الجهاز أو تثبيت IP له.</span>
          </div>
        )}
        {wanRangeLocked && (
          <div className="text-[11px] flex items-center gap-1.5" dir="rtl" style={{ color: 'var(--sun)' }}>
            <Lock size={12} className="shrink-0" />
            <span>
              هذا الجهاز يتبع مجموعة نطاق IP مشترك (<bdi dir="ltr" className="font-mono">{device.wan_group_name}</bdi>) على الراوتر. تم قفل التعديل الفردي لحماية باقي أجهزة النطاق.
            </span>
          </div>
        )}
        {canEditWan && wanPort !== 'auto' && !dhcpReserved && (
          <div className="text-[11px] flex items-center justify-between gap-2 flex-wrap" dir="rtl" style={{ color: 'var(--sun)' }}>
            <div className="flex items-center gap-1.5">
              <AlertTriangle size={12} className="shrink-0" />
              <span>
                ملاحظة: يُفضّل تفعيل تثبيت الـ IP (<bdi dir="ltr" className="font-mono">{effectiveIp}</bdi>) لضمان بقاء الجهاز على <bdi dir="ltr">{wanPort}</bdi>.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setDhcpReserved(true)}
              className="underline font-semibold hover:opacity-80"
            >
              تثبيت مع الحفظ
            </button>
          </div>
        )}
      </div>

      {/* Per-Device Bandwidth Limits (Download + Upload) */}
      <div className="space-y-3 pt-1">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="stat-label flex items-center gap-1.5">
            <Gauge size={12} /> Speed Limits · تحديد السرعة (QoS)
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => applyQuickProfile(256, 64)}
              className="btn-ghost !px-2.5 !py-1 text-[11px] inline-flex items-center gap-1"
              title="تطبيق وضع SD القياسي (تحميل 256 / رفع 64 KB/s)"
            >
              <Sparkles size={11} style={{ color: 'var(--sun)' }} />
              <span dir="ltr">SD (256/64)</span>
            </button>
            <button
              type="button"
              onClick={() => applyQuickProfile(0, 0)}
              className="btn-ghost !px-2.5 !py-1 text-[11px] inline-flex items-center gap-1"
              title="فتح السرعة بدون حد أقصى"
            >
              <InfinityIcon size={12} style={{ color: 'var(--mint)' }} />
              <span>Unlimited</span>
            </button>
            <div
              className="inline-flex rounded-lg p-0.5 border border-[var(--border)] bg-[var(--bg)]/60 text-[11px]"
              dir="ltr"
            >
              <button
                type="button"
                onClick={() => switchUnit('kbs')}
                className={clsx(
                  'px-2 py-0.5 rounded-md font-medium transition-[background-color,color]',
                  unit === 'kbs' ? 'bg-[var(--peach)] text-[#181628]' : 'text-[var(--text-3)] hover:text-[var(--text)]',
                )}
              >
                KB/s
              </button>
              <button
                type="button"
                onClick={() => switchUnit('mbps')}
                className={clsx(
                  'px-2 py-0.5 rounded-md font-medium transition-[background-color,color]',
                  unit === 'mbps' ? 'bg-[var(--peach)] text-[#181628]' : 'text-[var(--text-3)] hover:text-[var(--text)]',
                )}
              >
                Mbps
              </button>
            </div>
          </div>
        </div>

        {qosUnavailableOffline && (
          <div
            className="rounded-xl px-3 py-2 text-xs flex items-center gap-2"
            style={{
              background: 'oklch(0.88 0.14 90 / 0.10)',
              border: '1px solid oklch(0.88 0.14 90 / 0.30)',
              color: 'var(--sun)',
            }}
          >
            <AlertTriangle size={14} className="shrink-0" />
            <span>هذا الجهاز غير موجود حالياً في جدول QoS النشط على الراوتر؛ سيتاح تعديل سرعته بمجرد ظهوره متصلاً.</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Download Box */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)]/40 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold inline-flex items-center gap-1.5" style={{ color: 'var(--ice)' }}>
                <ArrowDown size={13} /> Download · التحميل
              </span>
              <span className="text-[11px] font-mono tabular-nums" dir="ltr" style={{ color: 'var(--text-2)' }}>
                {formatSpeedLimitKbs(dlKbs)}
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5" dir="ltr">
              {DOWNLOAD_SPEED_PRESETS.map((p) => {
                const active = dlKbs === p.kbs;
                return (
                  <button
                    key={p.kbs}
                    type="button"
                    disabled={qosUnavailableOffline || saving}
                    onClick={() => pickDlPreset(p.kbs)}
                    className={clsx(
                      'px-2.5 py-1 rounded-lg text-[11px] tabular-nums border transition-[background-color,border-color,color] disabled:opacity-40',
                      active
                        ? 'border-[var(--ice)] bg-[oklch(0.88_0.10_230_/_0.18)] text-[var(--ice)] font-semibold'
                        : 'border-[var(--border)] bg-[var(--bg-elevated)]/40 text-[var(--text-2)] hover:border-[var(--border-strong)]',
                    )}
                    title={p.sublabel}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            <div className="relative" dir="ltr">
              <input
                type="number"
                min={0}
                max={unit === 'mbps' ? 1000 : MAX_ROUTER_KBS}
                step={unit === 'mbps' ? '0.5' : '1'}
                disabled={qosUnavailableOffline || saving}
                value={dlInput}
                onChange={(e) => onDlTextChange(e.target.value)}
                placeholder={`0 = Unlimited (${unit === 'mbps' ? 'Mbps' : 'KB/s'})`}
                className="input-aurora w-full pr-24 tabular-nums font-mono text-xs sm:text-sm disabled:opacity-40"
              />
              <span
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-mono tabular-nums pointer-events-none"
                style={{ color: 'var(--text-3)' }}
              >
                {dlKbs > 0
                  ? unit === 'kbs'
                    ? `≈ ${formatMbpsEquivalent(dlKbs)}`
                    : `= ${dlKbs} KB/s`
                  : unit === 'kbs'
                  ? 'KB/s'
                  : 'Mbps'}
              </span>
            </div>
          </div>

          {/* Upload Box */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)]/40 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold inline-flex items-center gap-1.5" style={{ color: 'var(--peach)' }}>
                <ArrowUp size={13} /> Upload · الرفع
              </span>
              <span className="text-[11px] font-mono tabular-nums" dir="ltr" style={{ color: 'var(--text-2)' }}>
                {formatSpeedLimitKbs(ulKbs)}
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5" dir="ltr">
              {UPLOAD_SPEED_PRESETS.map((p) => {
                const active = ulKbs === p.kbs;
                return (
                  <button
                    key={p.kbs}
                    type="button"
                    disabled={qosUnavailableOffline || saving}
                    onClick={() => pickUlPreset(p.kbs)}
                    className={clsx(
                      'px-2.5 py-1 rounded-lg text-[11px] tabular-nums border transition-[background-color,border-color,color] disabled:opacity-40',
                      active
                        ? 'border-[var(--peach)] bg-[var(--peach-soft)] text-[var(--peach)] font-semibold'
                        : 'border-[var(--border)] bg-[var(--bg-elevated)]/40 text-[var(--text-2)] hover:border-[var(--border-strong)]',
                    )}
                    title={p.sublabel}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            <div className="relative" dir="ltr">
              <input
                type="number"
                min={0}
                max={unit === 'mbps' ? 1000 : MAX_ROUTER_KBS}
                step={unit === 'mbps' ? '0.25' : '1'}
                disabled={qosUnavailableOffline || saving}
                value={ulInput}
                onChange={(e) => onUlTextChange(e.target.value)}
                placeholder={`0 = Unlimited (${unit === 'mbps' ? 'Mbps' : 'KB/s'})`}
                className="input-aurora w-full pr-24 tabular-nums font-mono text-xs sm:text-sm disabled:opacity-40"
              />
              <span
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-mono tabular-nums pointer-events-none"
                style={{ color: 'var(--text-3)' }}
              >
                {ulKbs > 0
                  ? unit === 'kbs'
                    ? `≈ ${formatMbpsEquivalent(ulKbs)}`
                    : `= ${ulKbs} KB/s`
                  : unit === 'kbs'
                  ? 'KB/s'
                  : 'Mbps'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Footer / Save Bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
        <div className="min-w-0 flex-1">
          {feedback ? (
            <div
              className="text-xs font-medium flex items-center gap-1.5"
              dir="rtl"
              style={{ color: feedback.kind === 'ok' ? 'var(--mint)' : 'var(--coral)' }}
            >
              {feedback.kind === 'ok' ? <Check size={14} className="shrink-0" /> : <AlertTriangle size={14} className="shrink-0" />}
              <span>{feedback.text}</span>
            </div>
          ) : (
            <div className="text-[11px]" dir="rtl" style={{ color: 'var(--text-3)' }}>
              تُحفظ الإعدادات مباشرة في الراوتر (<bdi dir="ltr">Tenda W30E</bdi>) وتنعكس فوراً في قاعدة البيانات.
            </div>
          )}
        </div>

        <button
          type="button"
          disabled={saving || (!hasChanges && !feedback)}
          onClick={() => submitControl()}
          className="btn-primary inline-flex items-center gap-2 disabled:opacity-45 disabled:pointer-events-none"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          <span>{isAutoQuarantined ? 'حفظ وتأكيد الجهاز' : 'تطبيق على الراوتر'}</span>
        </button>
      </div>
    </div>
  );
}

export function DeviceControlModal({
  device,
  onClose,
}: {
  device: ControllableDevice | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!device) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [device, onClose]);

  if (!device) return null;
  const title = device.custom_label || device.router_remark || device.hostname || device.mac;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{ background: 'oklch(0.12 0.03 275 / 0.78)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Control ${title}`}
    >
      <div
        className="card w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-b-none sm:rounded-[18px] p-4 sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)]/60 pb-3 mb-4">
          <div className="min-w-0">
            <div className="text-base sm:text-lg font-semibold truncate" style={{ color: 'var(--text)' }}>
              <bdi>{title}</bdi>
            </div>
            <div className="text-xs font-mono tabular-nums mt-0.5 flex items-center gap-2 flex-wrap" dir="ltr" style={{ color: 'var(--text-3)' }}>
              <span>{device.ip || device.reserved_ip || 'No IP'}</span>
              <span>·</span>
              <span>{device.mac}</span>
              <span
                className={clsx(
                  'px-1.5 py-0.5 rounded text-[10px] font-sans',
                  device.online === 1 ? 'bg-[var(--mint-soft)] text-[var(--mint)]' : 'bg-white/5 text-[var(--text-3)]',
                )}
              >
                {device.online === 1 ? 'online' : 'offline'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn-ghost !p-2 rounded-xl shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <DeviceControlPanel device={device} compact />
      </div>
    </div>
  );
}

function formatForUnit(kbs: number, unit: SpeedUnit): string {
  if (!Number.isFinite(kbs) || kbs <= 0) return '';
  return unit === 'mbps' ? String(kbsToMbps(kbs)) : String(Math.round(kbs));
}
