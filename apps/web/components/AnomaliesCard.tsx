'use client';
import useSWR from 'swr';
import Link from 'next/link';
import { fetcher } from '../lib/fetcher';
import { formatBytes } from '../lib/format';
import { TrendingUp } from 'lucide-react';

interface Anomaly { mac: string; label: string; hour_ts: number; bytes: number; baseline: number; z: number }

export function AnomaliesCard() {
  const { data } = useSWR<{ data: Anomaly[] }>('/api/analytics?kind=anomalies&threshold=3', fetcher, { refreshInterval: 60000 });
  const list = data?.data ?? [];

  return (
    <div className="card p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-2">
        <TrendingUp size={14} className="text-accent-amber" />
        <div className="stat-label">Today's anomalies</div>
      </div>
      <div className="text-xs text-slate-500 mb-3">Hours where a device used &gt;3σ above its 14-day baseline</div>
      <div className="space-y-2">
        {list.length === 0 && <div className="text-sm text-slate-500 text-center py-3">No anomalies — everything within normal range.</div>}
        {list.map((a) => (
          <Link key={`${a.mac}-${a.hour_ts}`} href={`/devices/${encodeURIComponent(a.mac)}`}
            className="block px-3 py-2 rounded bg-bg-elevated hover:bg-bg-border text-sm transition">
            <div className="flex items-center justify-between">
              <span className="font-medium truncate">{a.label}</span>
              <span className="text-xs text-accent-amber font-bold tabular-nums">{a.z}σ</span>
            </div>
            <div className="text-xs text-slate-500 mt-0.5 flex gap-3">
              <span>{new Date(a.hour_ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}</span>
              <span>{formatBytes(a.bytes)} (baseline {formatBytes(a.baseline)})</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
