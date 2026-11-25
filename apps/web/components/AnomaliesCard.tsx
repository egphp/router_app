'use client';
import useSWR from 'swr';
import Link from 'next/link';
import { fetcher } from '../lib/fetcher';
import { formatBytes } from '../lib/format';
import { TrendingUp } from 'lucide-react';
import { AskGeminiButton } from './AskGeminiButton';

interface Anomaly {
  mac: string;
  label: string;
  hour_ts: number;
  bytes: number;
  baseline: number;
  z: number;
  lan_or_wan?: 'lan_only' | 'wan1' | 'wan2' | 'mixed' | 'unknown';
  wan_port?: 'WAN1' | 'WAN2' | null;
}

export function AnomaliesCard() {
  const { data } = useSWR<{ data: Anomaly[] }>(
    '/api/analytics?kind=anomalies&threshold=3',
    fetcher,
    { refreshInterval: 60000 },
  );
  const list = data?.data ?? [];

  return (
    <div className="card p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-2">
        <TrendingUp size={14} className="text-accent-amber" />
        <div className="stat-label">Today&apos;s anomalies</div>
      </div>
      <div className="text-xs text-slate-500 mb-3">
        Hours where a device used &gt;3σ above its 14-day same-hour baseline (LAN vs WAN correlated)
      </div>
      <div className="space-y-2.5">
        {list.length === 0 && (
          <div className="text-sm text-slate-500 text-center py-3">
            No anomalies — everything within normal range.
          </div>
        )}
        {list.map((a) => {
          const isLanOnly = a.lan_or_wan === 'lan_only';
          const badgeLabel = isLanOnly
            ? 'LAN-Only'
            : a.wan_port
            ? a.wan_port
            : a.lan_or_wan === 'wan1'
            ? 'WAN1'
            : a.lan_or_wan === 'wan2'
            ? 'WAN2'
            : a.lan_or_wan === 'mixed'
            ? 'LAN+WAN'
            : null;
          return (
            <div
              key={`${a.mac}-${a.hour_ts}`}
              className="px-3.5 py-2.5 rounded-xl bg-bg-elevated/80 text-sm space-y-2"
              style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <Link
                  href={`/devices/${encodeURIComponent(a.mac)}`}
                  className="font-medium truncate hover:text-accent"
                >
                  <bdi>{a.label}</bdi>
                </Link>
                <div className="flex items-center gap-2 shrink-0">
                  {badgeLabel && (
                    <span
                      className="rounded px-2 py-0.5 text-[11px] font-medium"
                      style={
                        isLanOnly
                          ? {
                              background: 'rgba(91,141,239,.10)',
                              color: '#8bb2ff',
                              boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.28)',
                            }
                          : {
                              background: 'rgba(227,160,8,.09)',
                              color: '#e3a008',
                              boxShadow: 'inset 0 0 0 1px rgba(227,160,8,.28)',
                            }
                      }
                    >
                      <bdi>{badgeLabel}</bdi>
                    </span>
                  )}
                  <span className="text-xs text-accent-amber font-semibold tabular-nums">
                    <bdi>{a.z}σ</bdi>
                  </span>
                </div>
              </div>
              <div className="text-xs text-slate-400 flex items-center justify-between gap-2 flex-wrap">
                <div className="flex gap-3 tabular-nums">
                  <span>
                    {new Date(a.hour_ts).toLocaleString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  <span>
                    <bdi>{formatBytes(a.bytes)}</bdi> (baseline <bdi>{formatBytes(a.baseline)}</bdi>)
                  </span>
                </div>
                <AskGeminiButton
                  compact
                  scopeType="anomaly"
                  scopeKey={`anom-${a.mac}-${a.hour_ts}`}
                  contextPayload={{
                    mac: a.mac,
                    label: a.label,
                    hour_ts: a.hour_ts,
                    bytes: a.bytes,
                    baseline: a.baseline,
                    z: a.z,
                    lan_or_wan: a.lan_or_wan,
                    wan_port: a.wan_port,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
