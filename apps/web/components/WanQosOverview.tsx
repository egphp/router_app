'use client';

import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { clsx } from 'clsx';
import {
  Check,
  Copy,
  Gauge,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { fetcher } from '../lib/fetcher';
import { formatBps, timeAgo } from '../lib/format';
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
    public_ip?: string | null;
    public_ip_checked_at?: number | null;
    public_ip_changed_at?: number | null;
    ddns_fqdn?: string | null;
    ddns_synced_ip?: string | null;
    ddns_synced_at?: number | null;
    ddns_last_error?: string | null;
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
  ssh_access?: {
    enabled: boolean;
    target_ip: string;
    external_port: number;
    ssh_user: string;
    wan1_active: boolean;
    wan2_active: boolean;
    wan2_internal_port: number | null;
  };
}

function buildSshCommand(user: string, publicIp: string, port: number): string {
  const cleanUser = user.trim() || 'michaeltawfik';
  return port === 22 ? `ssh ${cleanUser}@${publicIp}` : `ssh -p ${port} ${cleanUser}@${publicIp}`;
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

  const [editingSsh, setEditingSsh] = useState(false);
  const [sshEnabled, setSshEnabled] = useState(true);
  const [sshTargetIp, setSshTargetIp] = useState('192.168.0.7');
  const [sshPort, setSshPort] = useState('22222');
  const [sshUser, setSshUser] = useState('michaeltawfik');
  const [savingSsh, setSavingSsh] = useState(false);
  const [sshError, setSshError] = useState<string | null>(null);

  const [refreshingIps, setRefreshingIps] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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

  const ssh = data.ssh_access ?? {
    enabled: false,
    target_ip: '192.168.0.7',
    external_port: 22222,
    ssh_user: 'michaeltawfik',
    wan1_active: false,
    wan2_active: false,
    wan2_internal_port: null,
  };

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1800);
    } catch {
      // Clipboard API unavailable in non-secure context
    }
  };

  const refreshPublicIps = async () => {
    if (refreshingIps) return;
    setRefreshingIps(true);
    try {
      await fetch('/api/network-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh_public_ips' }),
      });
      await mutate();
    } finally {
      setRefreshingIps(false);
    }
  };

  const openGuardEditor = () => {
    setGuardEnabled(autoGuard.enabled);
    setGuardAutoReserve(autoReserveOn);
    setGuardDl(String(autoGuard.download_limit_kbs));
    setGuardUl(String(autoGuard.upload_limit_kbs));
    setEditingSsh(false);
    setEditingGuard((v) => !v);
  };

  const openSshEditor = () => {
    setSshEnabled(ssh.enabled);
    setSshTargetIp(ssh.target_ip || '192.168.0.7');
    setSshPort(String(ssh.external_port || 22222));
    setSshUser(ssh.ssh_user || 'michaeltawfik');
    setSshError(null);
    setEditingGuard(false);
    setEditingSsh((v) => !v);
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

  const saveSsh = async () => {
    if (savingSsh) return;
    setSavingSsh(true);
    setSshError(null);
    try {
      const portNum = Math.round(Number(sshPort) || 0);
      const resp = await fetch('/api/network-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ssh_access: {
            enabled: sshEnabled,
            target_ip: sshTargetIp.trim(),
            external_port: portNum,
            ssh_user: sshUser.trim(),
          },
        }),
      });
      const json = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!resp.ok || !json?.ok) {
        setSshError(json?.error ?? 'تعذر حفظ إعدادات الـ SSH في الراوتر');
        return;
      }
      await mutate();
      setEditingSsh(false);
    } finally {
      setSavingSsh(false);
    }
  };

  const wanItems =
    wans.length > 0
      ? wans
      : [
          {
            wan_id: 1,
            wan_name: 'WAN1',
            status: 'wired',
            wan_type: null,
            wan_ip: null,
            wan_gateway: null,
            public_ip: null,
            public_ip_checked_at: null,
            public_ip_changed_at: null,
            up_flux_bps: 0,
            down_flux_bps: 0,
            pinned_device_count: 0,
            updated_at: 0,
          },
          {
            wan_id: 2,
            wan_name: 'WAN2',
            status: 'wired',
            wan_type: null,
            wan_ip: null,
            wan_gateway: null,
            public_ip: null,
            public_ip_checked_at: null,
            public_ip_changed_at: null,
            up_flux_bps: 0,
            down_flux_bps: 0,
            pinned_device_count: 0,
            updated_at: 0,
          },
        ];

  return (
    <div className="card p-3.5 sm:p-4 animate-fade-in space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5 sm:gap-3">
        {/* WAN1 & WAN2 Cards with Live Public IPs + 1-Click SSH Copy */}
        {wanItems.map((w) => {
          const connected = w.status === 'wired' || w.status === 'connected';
          const isWan1 = w.wan_id === 1;
          const filterKey = w.wan_name.toLowerCase();
          const publicIp = w.public_ip ?? null;
          const ddnsFqdn = w.ddns_fqdn ?? null;
          const ddnsSynced = Boolean(ddnsFqdn && publicIp && w.ddns_synced_ip === publicIp && !w.ddns_last_error);
          const sshHost = ddnsFqdn || publicIp;
          const sshActiveOnWan = ssh.enabled && (isWan1 ? ssh.wan1_active : ssh.wan2_active);
          const sshCmd = sshHost ? buildSshCommand(ssh.ssh_user, sshHost, ssh.external_port) : '';
          const dnsCopyId = `dns-${w.wan_id}`;
          const ipCopyId = `ip-${w.wan_id}`;
          const sshCopyId = `ssh-${w.wan_id}`;

          return (
            <div
              key={w.wan_name}
              className="rounded-xl p-3 border border-[var(--border)] bg-[var(--bg)]/35 hover:border-[var(--border-strong)] transition-[border-color,background-color] flex flex-col justify-between gap-2.5"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap" dir="ltr">
                <Link
                  href={`/devices?filter=${encodeURIComponent(filterKey)}`}
                  className="inline-flex items-center gap-2 text-xs font-semibold hover:opacity-85 transition-opacity"
                  style={{ color: isWan1 ? 'var(--mint)' : 'var(--lavender)' }}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: connected ? 'var(--mint)' : 'var(--coral)' }}
                  />
                  <Globe size={13} />
                  <span>{w.wan_name}</span>
                  <span className="font-mono text-[11px] font-normal tabular-nums" style={{ color: 'var(--text-3)' }}>
                    {w.wan_ip || w.status}
                  </span>
                </Link>

                <div className="inline-flex items-center gap-1.5">
                  {sshActiveOnWan && (
                    <span
                      className="font-mono text-[11px] tabular-nums px-1.5 py-0.5 rounded bg-[var(--bg-elevated)]"
                      style={{ color: 'var(--mint)', boxShadow: 'inset 0 0 0 1px rgba(63,178,127,0.28)' }}
                      title={`TCP :${ssh.external_port} -> ${ssh.target_ip}:22 (Key-Only)`}
                    >
                      SSH :{ssh.external_port}
                    </span>
                  )}
                  <Link
                    href={`/devices?filter=${encodeURIComponent(filterKey)}`}
                    className={clsx(
                      'chip !py-0.5 !px-2 !text-[10px] tabular-nums hover:opacity-90 transition-opacity',
                      isWan1 ? 'chip-mint' : 'chip-lavender',
                    )}
                  >
                    {w.pinned_device_count} pinned
                  </Link>
                </div>
              </div>

              {/* Real ISP Public IP + Private DNS-Only DDNS + 1-Click Copy Actions */}
              <div
                className="rounded-lg px-2.5 py-2 bg-[var(--bg-elevated)]/55 flex flex-col gap-1.5"
                dir="ltr"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-3)' }}>
                      Public IP {ssh.enabled ? `· Port ${ssh.external_port}` : ''}
                    </span>
                    {publicIp ? (
                      <span
                        className="font-mono text-sm sm:text-[15px] font-semibold tabular-nums tracking-tight truncate"
                        style={{ color: 'var(--text)' }}
                      >
                        {publicIp}
                      </span>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                        {connected ? 'Checking public IP...' : 'Offline'}
                      </span>
                    )}
                  </div>

                  <div className="inline-flex items-center gap-1 shrink-0">
                    {ddnsFqdn && (
                      <button
                        type="button"
                        onClick={() => copyText(dnsCopyId, ddnsFqdn)}
                        className="btn-ghost !px-2 !py-1 !text-[11px] inline-flex items-center gap-1 font-mono tabular-nums"
                        title={`Copy hostname: ${ddnsFqdn}`}
                      >
                        {copiedKey === dnsCopyId ? <Check size={12} style={{ color: 'var(--mint)' }} /> : <Copy size={12} />}
                        <span>{copiedKey === dnsCopyId ? 'Copied' : 'DNS'}</span>
                      </button>
                    )}
                    {publicIp && (
                      <button
                        type="button"
                        onClick={() => copyText(ipCopyId, publicIp)}
                        className="btn-ghost !px-2 !py-1 !text-[11px] inline-flex items-center gap-1 font-mono tabular-nums"
                        title={`Copy ${publicIp}`}
                      >
                        {copiedKey === ipCopyId ? <Check size={12} style={{ color: 'var(--mint)' }} /> : <Copy size={12} />}
                        <span>{copiedKey === ipCopyId ? 'Copied' : 'IP'}</span>
                      </button>
                    )}
                    {sshHost && (
                      <button
                        type="button"
                        onClick={() => copyText(sshCopyId, sshCmd)}
                        className="btn-ghost !px-2 !py-1 !text-[11px] inline-flex items-center gap-1 font-mono tabular-nums"
                        title={`Copy: ${sshCmd}`}
                      >
                        {copiedKey === sshCopyId ? (
                          <Check size={12} style={{ color: 'var(--mint)' }} />
                        ) : (
                          <Terminal size={12} />
                        )}
                        <span>{copiedKey === sshCopyId ? 'Copied' : 'SSH'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={refreshPublicIps}
                      disabled={refreshingIps}
                      className="btn-ghost !p-1.5 !text-[11px] inline-flex items-center justify-center"
                      title="تحديث الـ Public IP و Cloudflare DDNS الآن"
                    >
                      <RefreshCw size={12} className={clsx(refreshingIps && 'animate-spin')} />
                    </button>
                  </div>
                </div>

                {ddnsFqdn && (
                  <div className="flex items-center justify-between gap-2 pt-1 border-t border-[var(--border)]/60 text-[11px] font-mono min-w-0">
                    <span className="truncate font-medium" style={{ color: 'var(--ice)' }} title={ddnsFqdn}>
                      {ddnsFqdn}
                    </span>
                    <span
                      className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg)]/70"
                      style={{ color: ddnsSynced ? 'var(--mint)' : w.ddns_last_error ? 'var(--coral)' : 'var(--sun)' }}
                      title={
                        w.ddns_last_error
                          ? w.ddns_last_error
                          : ddnsSynced
                            ? 'Cloudflare DNS-Only A record synced (TTL 60s, no SSL CT log)'
                            : 'Syncing Cloudflare DNS...'
                      }
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: ddnsSynced ? 'var(--mint)' : w.ddns_last_error ? 'var(--coral)' : 'var(--sun)' }}
                      />
                      {ddnsSynced ? 'CF Direct' : w.ddns_last_error ? 'CF Retry' : 'Syncing'}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 text-xs font-mono tabular-nums" dir="ltr">
                <span style={{ color: 'var(--ice)' }}>↓ {formatBps(w.down_flux_bps)}</span>
                {w.public_ip_checked_at ? (
                  <span className="text-[11px] font-sans" style={{ color: 'var(--text-3)' }}>
                    {timeAgo(w.public_ip_checked_at)}
                  </span>
                ) : null}
                <span style={{ color: 'var(--peach)' }}>↑ {formatBps(w.up_flux_bps)}</span>
              </div>
            </div>
          );
        })}

        {/* QoS Summary + External SSH Access + Auto-SD & Auto-Reservation Guard */}
        <div
          className="rounded-xl p-3 border border-[var(--border)] bg-[var(--bg)]/35 flex flex-col justify-between gap-2.5"
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
                  className="inline-flex items-center gap-1 text-xs font-medium hover:underline"
                  style={{ color: 'var(--mint)' }}
                >
                  <Lock size={11} />
                  <span className="tabular-nums">{data.reserved_devices_count} مثبّت</span>
                </Link>
              )}
            </div>

            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={openSshEditor}
                className={clsx(
                  'btn-ghost !px-2 !py-0.5 !text-[11px] inline-flex items-center gap-1',
                  editingSsh && 'border-[var(--border-strong)]',
                )}
              >
                <KeyRound size={11} />
                <span>SSH خارجي</span>
              </button>
              <button
                type="button"
                onClick={openGuardEditor}
                className={clsx(
                  'btn-ghost !px-2 !py-0.5 !text-[11px] inline-flex items-center gap-1',
                  editingGuard && 'border-[var(--border-strong)]',
                )}
              >
                <Settings2 size={11} />
                <span>التلقائي</span>
              </button>
            </div>
          </div>

          {/* SSH Port Mapping Status Row */}
          <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
            <div
              className="inline-flex items-center gap-1.5 flex-wrap"
              style={{ color: ssh.enabled ? 'var(--mint)' : 'var(--text-3)' }}
            >
              <KeyRound size={13} className="shrink-0" />
              <span>دخول الماك خارجياً:</span>
              {ssh.enabled ? (
                <bdi dir="ltr" className="font-mono tabular-nums font-semibold">
                  :{ssh.external_port} → {ssh.target_ip}:22 (Key-Only)
                </bdi>
              ) : (
                <span>متوقف</span>
              )}
            </div>
          </div>

          {/* Auto-Guard Status Row */}
          <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
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

      {/* Inline External SSH Port-Forwarding Drawer */}
      {editingSsh && (
        <div
          className="rounded-xl p-3.5 border border-[var(--border)] bg-[var(--bg-elevated)]/40 flex flex-col gap-3"
          dir="rtl"
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <label className="inline-flex items-center gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={sshEnabled}
                onChange={(e) => setSshEnabled(e.target.checked)}
                className="accent-[var(--mint)] w-4 h-4"
              />
              <span className="font-medium" style={{ color: 'var(--text)' }}>
                فتح بورت <bdi dir="ltr">SSH (TCP)</bdi> فقط للماك عبر <bdi dir="ltr">WAN1 + WAN2</bdi> مع إبقاء <bdi dir="ltr">DMZ</bdi> مغلقاً ومفتاح <bdi dir="ltr">SSH Key-Only</bdi> فقط
              </span>
            </label>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap justify-end" dir="ltr">
            <label className="inline-flex items-center gap-1.5 text-xs">
              <span style={{ color: 'var(--text-2)' }}>Mac IP:</span>
              <input
                type="text"
                value={sshTargetIp}
                onChange={(e) => setSshTargetIp(e.target.value)}
                className="input-aurora !py-1 !px-2.5 w-32 font-mono tabular-nums text-xs"
              />
            </label>

            <label className="inline-flex items-center gap-1.5 text-xs">
              <span style={{ color: 'var(--mint)' }}>External Port:</span>
              <input
                type="number"
                min={22}
                max={65535}
                value={sshPort}
                onChange={(e) => setSshPort(e.target.value)}
                className="input-aurora !py-1 !px-2.5 w-24 font-mono tabular-nums text-xs"
              />
            </label>

            <label className="inline-flex items-center gap-1.5 text-xs">
              <span style={{ color: 'var(--text-2)' }}>User:</span>
              <input
                type="text"
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                className="input-aurora !py-1 !px-2.5 w-32 font-mono text-xs"
              />
            </label>

            <button
              type="button"
              onClick={() => setSshPort('22222')}
              className="btn-ghost !py-1 !px-2 text-[11px] font-mono tabular-nums"
            >
              22222
            </button>
            <button
              type="button"
              onClick={() => setSshPort('22')}
              className="btn-ghost !py-1 !px-2 text-[11px] font-mono tabular-nums"
            >
              22
            </button>

            <button
              type="button"
              disabled={savingSsh}
              onClick={saveSsh}
              className="btn-primary !py-1.5 !px-3 !text-xs inline-flex items-center gap-1.5"
            >
              {savingSsh ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              <span>حفظ وتطبيق بالراوتر</span>
            </button>
          </div>

          {sshError && (
            <div className="text-xs rounded-lg px-3 py-2 bg-[var(--coral)]/10 text-[var(--coral)]">
              {sshError}
            </div>
          )}

          {wanItems.some((w) => Boolean(w.ddns_fqdn || w.public_ip)) && (
            <div className="flex flex-col sm:flex-row gap-2 text-xs font-mono tabular-nums" dir="ltr">
              {wanItems.map((w) => {
                const targetHost = w.ddns_fqdn || w.public_ip;
                if (!targetHost) return null;
                const cmd = buildSshCommand(sshUser, targetHost, Math.round(Number(sshPort) || 22222));
                const cid = `drawer-${w.wan_id}`;
                return (
                  <button
                    key={w.wan_id}
                    type="button"
                    onClick={() => copyText(cid, cmd)}
                    className="rounded-lg px-2.5 py-1.5 bg-[var(--bg)]/60 border border-[var(--border)] hover:border-[var(--border-strong)] inline-flex items-center justify-between gap-2 text-left transition-[border-color]"
                  >
                    <span className="truncate">
                      <span style={{ color: 'var(--text-3)' }}>{w.wan_name}: </span>
                      {cmd}
                    </span>
                    {copiedKey === cid ? <Check size={12} style={{ color: 'var(--mint)' }} /> : <Copy size={12} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Inline Auto-Guard Drawer */}
      {editingGuard && (
        <div
          className="rounded-xl p-3.5 border border-[var(--border)] bg-[var(--bg-elevated)]/40 flex flex-col gap-3"
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
