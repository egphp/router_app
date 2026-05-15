'use client';
import useSWR from 'swr';
import { useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { fetcher } from '../lib/fetcher';
import { formatBytes, categoryIcon } from '../lib/format';

interface Cat { category: string; bytes_down: number; bytes_up: number; device_count: number }

const COLORS = ['#60a5fa', '#fb923c', '#10b981', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6'];

export function CategoryBreakdown() {
  const [range, setRange] = useState<'today' | 'week' | 'month'>('today');
  const { data } = useSWR<{ data: Cat[] }>(`/api/analytics?kind=categories&range=${range}`, fetcher, { refreshInterval: 60000 });
  const cats = data?.data ?? [];
  const chartData = cats.map((c) => ({ name: c.category, value: c.bytes_down + c.bytes_up }));

  return (
    <div className="card p-5 animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="stat-label">Traffic by category</div>
          <div className="text-xs text-slate-500 mt-1">Bytes grouped by device class</div>
        </div>
        <div className="flex bg-bg-elevated border border-bg-border rounded overflow-hidden text-xs">
          {(['today', 'week', 'month'] as const).map((r) => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-3 py-1 ${range === r ? 'bg-accent text-white' : 'text-slate-400 hover:text-slate-100'}`}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <div className="h-48 w-48">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={chartData} dataKey="value" innerRadius={45} outerRadius={75} paddingAngle={2}>
                {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip
                contentStyle={{ background: '#111726', border: '1px solid #202842', borderRadius: 8 }}
                formatter={(v: number) => formatBytes(v)}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex-1 space-y-1.5 text-sm w-full">
          {cats.map((c, i) => (
            <div key={c.category} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                <span className="text-lg">{categoryIcon(c.category)}</span>
                <span className="truncate">{c.category}</span>
                <span className="text-xs text-slate-500">({c.device_count})</span>
              </div>
              <div className="text-right shrink-0 leading-tight">
                <div className="text-xs tabular-nums text-slate-200 font-semibold">{formatBytes(c.bytes_down + c.bytes_up)}</div>
                <div className="text-[10px] tabular-nums text-slate-500">↓ {formatBytes(c.bytes_down, 0)} · ↑ {formatBytes(c.bytes_up, 0)}</div>
              </div>
            </div>
          ))}
          {cats.length === 0 && <div className="text-sm text-slate-500 text-center">No data.</div>}
        </div>
      </div>
    </div>
  );
}
