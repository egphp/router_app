'use client';
import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { formatBytes, categoryIcon } from '../lib/format';

interface Talker { mac: string; label: string; category: string | null; vendor: string | null; ip: string | null; bytes_down: number; bytes_up: number }

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

  // Aurora bar gradient cycles through accent hues by rank
  const BAR_GRADIENTS = [
    'linear-gradient(90deg, var(--peach), var(--coral))',
    'linear-gradient(90deg, var(--mint), var(--ice))',
    'linear-gradient(90deg, var(--lavender), var(--rose))',
    'linear-gradient(90deg, var(--sun), var(--peach))',
    'linear-gradient(90deg, var(--ice), var(--lavender))',
  ];

  return (
    <div className="card p-5 animate-fade-in">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div className="stat-label">Top talkers</div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-3)' }}>Devices ranked by total bytes</div>
        </div>
        <div className="flex rounded-pill p-0.5 text-xs" style={{ background: 'oklch(0.20 0.04 275 / 0.6)', border: '1.5px solid var(--border)' }}>
          {RANGES.map((r) => (
            <button key={r.value} onClick={() => setRange(r.value as any)}
              className="px-3 py-1 rounded-pill transition font-medium"
              style={range === r.value
                ? { background: 'linear-gradient(135deg, var(--peach), var(--sun))', color: 'oklch(0.20 0.04 275)' }
                : { color: 'var(--text-3)' }
              }>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2.5">
        {list.length === 0 && <div className="text-sm text-center py-6" style={{ color: 'var(--text-3)' }}>No traffic in this window yet.</div>}
        {list.map((t, i) => {
          const total = t.bytes_down + t.bytes_up;
          const pct = (total / max) * 100;
          const gradient = BAR_GRADIENTS[i % BAR_GRADIENTS.length];
          return (
            <Link key={t.mac} href={`/devices/${encodeURIComponent(t.mac)}`}
              className="block group">
              <div className="flex items-center gap-3 text-sm">
                <span className="text-xs tabular-nums w-5 font-display italic" style={{ color: 'var(--text-3)' }}>#{i + 1}</span>
                <span className="text-lg">{categoryIcon(t.category)}</span>
                <div className="flex-1 min-w-0">
                  <div className="truncate transition" style={{ color: 'var(--text)' }}>{t.label}</div>
                  {t.ip && <div className="text-[10px] font-mono leading-tight" style={{ color: 'var(--text-3)' }}>{t.ip}</div>}
                </div>
                <span className="text-xs tabular-nums shrink-0 font-medium" style={{ color: 'var(--text-2)' }}>{formatBytes(total)}</span>
              </div>
              <div className="ml-9 mt-1.5 h-1.5 rounded-full overflow-hidden" style={{ background: 'oklch(0.20 0.04 275 / 0.6)' }}>
                <div className="h-full transition-all rounded-full"
                  style={{ width: `${pct}%`, background: gradient, boxShadow: `0 0 12px -2px oklch(0.82 0.13 50 / ${0.3 + 0.4 * (pct / 100)})` }} />
              </div>
              <div className="ml-9 mt-1 flex gap-3 text-[10px]" style={{ color: 'var(--text-3)' }}>
                <span><span style={{ color: 'var(--ice)' }}>↓</span> {formatBytes(t.bytes_down)}</span>
                <span><span style={{ color: 'var(--peach)' }}>↑</span> {formatBytes(t.bytes_up)}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
