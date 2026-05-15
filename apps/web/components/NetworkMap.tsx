'use client';
import { useMemo } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { formatBps, categoryIcon } from '../lib/format';

interface DeviceRow {
  mac: string;
  hostname: string | null;
  router_remark: string | null;
  custom_label: string | null;
  category: string | null;
  ip: string | null;
  online: 0 | 1;
  up_speed_bps: number;
  down_speed_bps: number;
  bytes_today: number;
  is_new: 0 | 1;
}

interface AttackRow { mac: string | null; total_attacks: number }

export function NetworkMap() {
  const { data: devData } = useSWR<{ devices: DeviceRow[] }>('/api/devices', fetcher, { refreshInterval: 10000 });
  const { data: atkData } = useSWR<{ stats: { topAttackers: AttackRow[] } }>('/api/attack-log?limit=0', fetcher, { refreshInterval: 60000 });

  const devices = useMemo(() => (devData?.devices ?? []).filter((d) => d.online === 1), [devData]);
  const attackerSet = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of atkData?.stats?.topAttackers ?? []) {
      if (a.mac) map.set(a.mac, (map.get(a.mac) ?? 0) + Number(a.total_attacks));
    }
    return map;
  }, [atkData]);

  const RADIUS = 280;
  const SIZE = 700;
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  return (
    <div className="card p-5 animate-fade-in">
      <div className="stat-label mb-3">Network map · {devices.length} online devices</div>
      <div className="text-xs text-slate-500 mb-3">
        Each node = an online device. Line thickness ∝ current down-speed.
        <span className="ml-3"><span className="inline-block w-2 h-2 rounded-full bg-accent-red mr-1" />attacker</span>
        <span className="ml-3"><span className="inline-block w-2 h-2 rounded-full bg-accent-amber mr-1" />new</span>
        <span className="ml-3"><span className="inline-block w-2 h-2 rounded-full bg-accent-green mr-1" />active</span>
      </div>
      <div className="flex justify-center overflow-x-auto">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full max-w-[700px]">
          {/* Concentric rings */}
          {[0.5, 0.75, 1].map((s) => (
            <circle key={s} cx={cx} cy={cy} r={RADIUS * s} fill="none" stroke="#1e293b" strokeDasharray="2 4" />
          ))}
          {/* Lines to devices */}
          {devices.map((d, i) => {
            const angle = (i / devices.length) * Math.PI * 2 - Math.PI / 2;
            const x = cx + Math.cos(angle) * RADIUS;
            const y = cy + Math.sin(angle) * RADIUS;
            const speed = d.down_speed_bps + d.up_speed_bps;
            const isAttacker = attackerSet.has(d.mac);
            const colorStroke = isAttacker
              ? '#ef4444'
              : d.is_new ? '#f59e0b' : speed > 0 ? '#10b981' : '#475569';
            return (
              <line key={`line-${d.mac}`} x1={cx} y1={cy} x2={x} y2={y}
                stroke={colorStroke}
                strokeWidth={speed > 0 ? Math.min(6, 1 + Math.log10(speed) * 0.6) : 0.6}
                opacity={speed > 0 ? 0.8 : 0.3} />
            );
          })}
          {/* Router center */}
          <g>
            <circle cx={cx} cy={cy} r="28" fill="#1e3a8a" stroke="#3b82f6" strokeWidth="2" />
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize="11" fill="#dbeafe" fontWeight="bold">Tenda</text>
            <text x={cx} y={cy + 16} textAnchor="middle" fontSize="9" fill="#94a3b8">W30E</text>
          </g>
          {/* Devices */}
          {devices.map((d, i) => {
            const angle = (i / devices.length) * Math.PI * 2 - Math.PI / 2;
            const x = cx + Math.cos(angle) * RADIUS;
            const y = cy + Math.sin(angle) * RADIUS;
            const speed = d.down_speed_bps + d.up_speed_bps;
            const isAttacker = attackerSet.has(d.mac);
            const ringColor = isAttacker ? '#ef4444' : d.is_new ? '#f59e0b' : speed > 0 ? '#10b981' : '#334155';
            const fill = isAttacker ? '#7f1d1d' : d.is_new ? '#78350f' : '#0f172a';
            const label = d.custom_label || d.router_remark || d.hostname || d.mac.slice(-5);
            const labelX = x + Math.cos(angle) * 30;
            const labelY = y + Math.sin(angle) * 30;
            return (
              <Link href={`/devices/${encodeURIComponent(d.mac)}`} key={d.mac}>
                <g className="cursor-pointer">
                  <circle cx={x} cy={y} r="16" fill={fill} stroke={ringColor} strokeWidth="2">
                    {speed > 0 && (
                      <animate attributeName="r" values="16;19;16" dur="2s" repeatCount="indefinite" />
                    )}
                  </circle>
                  <text x={x} y={y + 4} textAnchor="middle" fontSize="14" pointerEvents="none">{categoryIcon(d.category)}</text>
                  <text x={labelX} y={labelY} textAnchor={angle > -Math.PI / 2 && angle < Math.PI / 2 ? 'start' : 'end'}
                    fontSize="9" fill="#cbd5e1">{label.slice(0, 16)}</text>
                  {speed > 0 && (
                    <text x={labelX} y={labelY + 11} textAnchor={angle > -Math.PI / 2 && angle < Math.PI / 2 ? 'start' : 'end'}
                      fontSize="8" fill="#60a5fa">{formatBps(speed, 0)}</text>
                  )}
                </g>
              </Link>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
