'use client';
import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { formatBytes, categoryIcon } from '../lib/format';

interface Talker { mac: string; label: string; category: string | null; vendor: string | null; bytes_down: number; bytes_up: number }

const RANGES = [
  { value: 'hour', label: '1h' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

export function TopTalkers() {
  const [range, setRange] = useState<'hour' | 'today' | 'week' | 'month'>('today');
  const { data } = useSWR<{ data: Talker[] }>(`/api/analytics?kind=top&range=${range}&limit=10`, fetcher, { refreshInterval: 30000 });
  const list = data?.data ?? [];
  const max = Math.max(1, ...list.map((t) => t.bytes_down + t.bytes_up));

  return (
    <div className="card p-5 animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="stat-label">Top talkers</div>
          <div className="text-xs text-slate-500 mt-1">Devices ranked by total bytes</div>
        </div>
        <div className="flex bg-bg-elevated border border-bg-border rounded overflow-hidden text-xs">
          {RANGES.map((r) => (
            <button key={r.value} onClick={() => setRange(r.value as any)}
              className={`px-3 py-1 ${range === r.value ? 'bg-accent text-white' : 'text-slate-400 hover:text-slate-100'}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        {list.length === 0 && <div className="text-sm text-slate-500 text-center py-6">No traffic in this window yet.</div>}
        {list.map((t, i) => {
          const total = t.bytes_down + t.bytes_up;
          const pct = (total / max) * 100;
          return (
            <Link key={t.mac} href={`/devices/${encodeURIComponent(t.mac)}`}
              className="block group">
              <div className="flex items-center gap-3 text-sm">
                <span className="text-slate-500 text-xs tabular-nums w-5">#{i + 1}</span>
                <span className="text-lg">{categoryIcon(t.category)}</span>
                <span className="flex-1 truncate group-hover:text-accent">{t.label}</span>
                <span className="text-xs text-slate-400 tabular-nums">{formatBytes(total)}</span>
              </div>
              <div className="ml-9 mt-1 h-1.5 bg-bg-elevated rounded overflow-hidden">
                <div className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all"
                  style={{ width: `${pct}%` }} />
              </div>
              <div className="ml-9 mt-1 flex gap-3 text-[10px] text-slate-500">
                <span>↓ {formatBytes(t.bytes_down)}</span>
                <span>↑ {formatBytes(t.bytes_up)}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
