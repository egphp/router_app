'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
  connect_type: number | null;
  connection_kind: 'wired' | 'wifi' | 'unknown' | null;
  wifi_band: '2.4GHz' | '5GHz' | 'wifi' | null;
  wifi_rssi_dbm: number | null;
  wifi_signal_percent: number | null;
  wifi_distance_m: number | null;
  wifi_distance_source: 'rssi-log-distance' | 'signal-percent-proxy' | null;
  bytes_today: number;
  is_new: 0 | 1;
}

interface AttackRow { mac: string | null; total_attacks: number }

interface MapNode extends DeviceRow {
  angle: number;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  visualDistanceM: number;
  hasMeasuredDistance: boolean;
  tier: string;
}

const SIZE = 920;
const cx = SIZE / 2;
const cy = SIZE / 2;
const MAX_RADIUS = 360;
const MIN_RADIUS = 92;
const MAX_VISUAL_DISTANCE_M = 36;
const NODE_RADIUS = 17;
const MAP_PATHNAME = '/map';
const MAP_DEVICES_KEY = '/api/devices?live=1';
const MAP_ATTACK_LOG_KEY = '/api/attack-log?limit=0';

export function NetworkMap() {
  const mapPollingEnabled = useMapPollingEnabled();
  const { data: devData } = useSWR<{ devices: DeviceRow[] }>(
    mapPollingEnabled ? MAP_DEVICES_KEY : null,
    fetcher,
    {
      refreshInterval: mapPollingEnabled ? 2000 : 0,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: mapPollingEnabled,
      keepPreviousData: true,
    },
  );
  const { data: atkData } = useSWR<{ stats: { topAttackers: AttackRow[] } }>(
    mapPollingEnabled ? MAP_ATTACK_LOG_KEY : null,
    fetcher,
    {
      refreshInterval: mapPollingEnabled ? 60000 : 0,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: mapPollingEnabled,
      keepPreviousData: true,
    },
  );

  const devices = useMemo(() => (devData?.devices ?? []).filter((d) => d.online === 1), [devData]);
  const attackerSet = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of atkData?.stats?.topAttackers ?? []) {
      if (a.mac) map.set(a.mac, (map.get(a.mac) ?? 0) + Number(a.total_attacks));
    }
    return map;
  }, [atkData]);

  const nodes = useMemo<MapNode[]>(() => {
    const sorted = [...devices].sort((a, b) => stableHash(a.mac) - stableHash(b.mac));
    const groups = new Map<string, DeviceRow[]>();
    for (const device of sorted) {
      const tier = nodeTier(device);
      const group = groups.get(tier) ?? [];
      group.push(device);
      groups.set(tier, group);
    }

    return [...groups.entries()].flatMap(([tier, group]) => {
      const ordered = [...group].sort((a, b) => stableHash(`${tier}:${a.mac}`) - stableHash(`${tier}:${b.mac}`));
      const count = Math.max(1, ordered.length);
      return ordered.map((d, i) => {
        const angle = ((i + tierAngleOffset(tier)) / count) * Math.PI * 2 - Math.PI / 2;
        const baseDistanceM = d.wifi_distance_m ?? fallbackVisualDistance(d);
        const visualDistanceM = spreadDistance(baseDistanceM, i, count, tier);
        const radius = distanceToRadius(visualDistanceM);
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        const label = labelPosition(x, y, angle);
        return {
          ...d,
          tier,
          angle,
          x,
          y,
          labelX: label.x,
          labelY: label.y,
          visualDistanceM,
          hasMeasuredDistance: d.wifi_distance_m !== null && d.wifi_distance_m !== undefined,
        };
      });
    });
  }, [devices]);

  const measuredCount = nodes.filter((d) => d.hasMeasuredDistance).length;

  return (
    <div className="card p-5 animate-fade-in">
      <div className="stat-label mb-3">
        Network map · {devices.length} online devices · RSSI distance {measuredCount}/{devices.length}
      </div>
      <div className="text-xs text-slate-500 mb-3 flex flex-wrap gap-x-4 gap-y-1">
        <span>Line thickness ∝ ↓/↑ speed</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-accent-red mr-1" />attacker</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-accent-amber mr-1" />new</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-accent-green mr-1" />active</span>
        <span><span className="inline-block w-4 h-px bg-slate-500 align-middle mr-1" />rings = estimated meters</span>
      </div>
      <div className="flex justify-center overflow-x-auto rounded-xl bg-slate-950/10">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-[min(940px,calc(100vh-230px),100%)] min-w-[720px]">
          {/* Concentric rings */}
          {[6, 18, 27, 36].map((m) => (
            <g key={m}>
              <circle cx={cx} cy={cy} r={distanceToRadius(m)} fill="none" stroke="#334155" strokeDasharray="2 7" opacity="0.52" />
              <text x={cx + 10} y={cy - distanceToRadius(m) + 15} fontSize="10" fill="#64748b">{m}m</text>
            </g>
          ))}
          {/* Lines to devices */}
          {nodes.map((d) => {
            const speed = d.down_speed_bps + d.up_speed_bps;
            const isAttacker = attackerSet.has(d.mac);
            const colorStroke = isAttacker
              ? '#ef4444'
              : d.is_new ? '#f59e0b' : speed > 0 ? '#10b981' : '#475569';
            return (
              <line key={`line-${d.mac}`} x1={cx} y1={cy} x2={d.x} y2={d.y}
                stroke={colorStroke}
                strokeWidth={speed > 0 ? Math.min(7, 1.3 + Math.log10(speed + 1) * 0.72) : 0.7}
                opacity={speed > 0 ? 0.76 : 0.22} />
            );
          })}
          {/* Router center */}
          <g>
            <circle cx={cx} cy={cy} r="44" fill="#0f172a" stroke="#1d4ed8" strokeWidth="1.5" opacity="0.92" />
            <circle cx={cx} cy={cy} r="31" fill="#1e3a8a" stroke="#60a5fa" strokeWidth="2" />
            <text x={cx} y={cy + 3} textAnchor="middle" fontSize="12" fill="#dbeafe" fontWeight="bold">Tenda</text>
            <text x={cx} y={cy + 17} textAnchor="middle" fontSize="9" fill="#94a3b8">W30E</text>
          </g>
          {/* Devices */}
          {nodes.map((d) => {
            const speed = d.down_speed_bps + d.up_speed_bps;
            const isAttacker = attackerSet.has(d.mac);
            const ringColor = isAttacker ? '#ef4444' : d.is_new ? '#f59e0b' : speed > 0 ? '#10b981' : '#334155';
            const fill = isAttacker ? '#7f1d1d' : d.is_new ? '#78350f' : '#0f172a';
            const label = d.custom_label || d.router_remark || d.hostname || d.mac.slice(-5);
            const anchor = labelAnchor(d.angle);
            const distanceLabel = d.hasMeasuredDistance
              ? `${d.wifi_distance_m?.toFixed(1)}m${d.wifi_rssi_dbm !== null ? ` · ${d.wifi_rssi_dbm}dBm` : ''}`
              : connectionLabel(d);
            const currentSpeed = speedLabel(d);
            return (
              <Link href={`/devices/${encodeURIComponent(d.mac)}`} key={d.mac} prefetch={false}>
                <g className="cursor-pointer">
                  <title>{`${label} · ${distanceLabel}${currentSpeed ? ` · ${currentSpeed}` : ''}`}</title>
                  <circle cx={d.x} cy={d.y} r={NODE_RADIUS + 8} fill="none" stroke={ringColor} strokeWidth="1" opacity={speed > 0 ? 0.34 : 0.16} />
                  <circle cx={d.x} cy={d.y} r={NODE_RADIUS} fill={fill} stroke={ringColor} strokeWidth={d.hasMeasuredDistance ? 2.5 : 1.7}>
                    {speed > 0 && (
                      <animate attributeName="r" values={`${NODE_RADIUS};${NODE_RADIUS + 3};${NODE_RADIUS}`} dur="2s" repeatCount="indefinite" />
                    )}
                  </circle>
                  <text x={d.x} y={d.y + 4} textAnchor="middle" fontSize="14" pointerEvents="none">{categoryIcon(d.category)}</text>
                  <text x={d.labelX} y={d.labelY} textAnchor={anchor} paintOrder="stroke" stroke="#0f172a" strokeWidth="3"
                    fontSize="10.5" fontWeight="600" fill="#e2e8f0">{label.slice(0, 18)}</text>
                  <text x={d.labelX} y={d.labelY + 13} textAnchor={anchor} paintOrder="stroke" stroke="#0f172a" strokeWidth="3"
                    fontSize="8" fill={d.hasMeasuredDistance ? '#60a5fa' : '#64748b'}>{distanceLabel}</text>
                  {currentSpeed && (
                    <text x={d.labelX} y={d.labelY + 25} textAnchor={anchor} paintOrder="stroke" stroke="#0f172a" strokeWidth="3"
                      fontSize="8.5" fill="#93c5fd">{currentSpeed}</text>
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

function useMapPollingEnabled(): boolean {
  const pathname = usePathname();
  const [isVisible, setIsVisible] = useState(() => isDocumentVisible());

  useEffect(() => {
    const updateVisibility = () => setIsVisible(isDocumentVisible());
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  return pathname === MAP_PATHNAME && isVisible;
}

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function distanceToRadius(distanceM: number): number {
  const normalized = Math.max(0, Math.min(1, distanceM / MAX_VISUAL_DISTANCE_M));
  return MIN_RADIUS + normalized * (MAX_RADIUS - MIN_RADIUS);
}

function fallbackVisualDistance(d: DeviceRow): number {
  if (d.connection_kind === 'wired' || d.connect_type === 2) return 6;
  if (d.wifi_band === '5GHz' || d.connect_type === 4) return 18;
  if (d.wifi_band === '2.4GHz' || d.connect_type === 3) return 27;
  if (d.connection_kind === 'wifi' || d.connect_type === 1) return 24;
  return 34;
}

function connectionLabel(d: DeviceRow): string {
  if (d.connection_kind === 'wired' || d.connect_type === 2) return 'wired';
  if (d.wifi_band) return `${d.wifi_band} · no RSSI`;
  return 'unknown';
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nodeTier(d: DeviceRow): string {
  if (d.wifi_distance_m !== null && d.wifi_distance_m !== undefined) {
    return `measured-${Math.round(d.wifi_distance_m / 6) * 6}`;
  }
  if (d.connection_kind === 'wired' || d.connect_type === 2) return 'wired';
  if (d.wifi_band === '5GHz' || d.connect_type === 4) return '5g';
  if (d.wifi_band === '2.4GHz' || d.connect_type === 3) return '24g';
  if (d.connection_kind === 'wifi' || d.connect_type === 1) return 'wifi';
  return 'unknown';
}

function tierAngleOffset(tier: string): number {
  if (tier === 'wired') return 0.1;
  if (tier === '5g') return 0.18;
  if (tier === '24g') return 0.55;
  if (tier === 'wifi') return 0.34;
  if (tier === 'unknown') return 0.74;
  return (stableHash(tier) % 100) / 100;
}

function spreadDistance(baseDistanceM: number, index: number, count: number, tier: string): number {
  if (count <= 1) return baseDistanceM;
  const centered = index - (count - 1) / 2;
  const spread = tier === 'wired' ? 1.6 : 3.4;
  const offset = (centered / Math.max(1, (count - 1) / 2)) * spread;
  return Math.max(4, Math.min(MAX_VISUAL_DISTANCE_M, baseDistanceM + offset));
}

function labelPosition(x: number, y: number, angle: number): { x: number; y: number } {
  const horizontal = Math.cos(angle);
  const vertical = Math.sin(angle);
  const gap = 40;
  const yBias = vertical < -0.7 ? -10 : vertical > 0.7 ? 17 : 4;
  return {
    x: x + horizontal * gap,
    y: y + vertical * gap + yBias,
  };
}

function labelAnchor(angle: number): 'start' | 'middle' | 'end' {
  const horizontal = Math.cos(angle);
  if (Math.abs(horizontal) < 0.22) return 'middle';
  return horizontal > 0 ? 'start' : 'end';
}

function speedLabel(d: DeviceRow): string {
  const parts: string[] = [];
  if (d.down_speed_bps > 0) parts.push(`↓ ${formatBps(d.down_speed_bps, 0)}`);
  if (d.up_speed_bps > 0) parts.push(`↑ ${formatBps(d.up_speed_bps, 0)}`);
  return parts.join('  ');
}
