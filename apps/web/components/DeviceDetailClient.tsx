'use client';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { fetcher } from '../lib/fetcher';
import { formatBps, formatBytes, formatMacShort, categoryIcon, formatDuration } from '../lib/format';

type Range = 'hour' | 'today' | 'week' | 'month' | 'year' | 'all';

const RANGES: { value: Range; label: string }[] = [
  { value: 'hour', label: 'Last hour' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' },
];

interface Device {
  mac: string;
  hostname: string | null;
  router_remark: string | null;
  custom_label: string | null;
  vendor: string | null;
  category: string | null;
  is_new: 0 | 1;
  first_seen: number;
  last_seen: number;
  notes: string | null;
}

export function DeviceDetailClient({ device, initialStats }: {
  device: Device;
  initialStats: { bytes_down: number; bytes_up: number; peak_down_bps: number; peak_up_bps: number };
}) {
  const [range, setRange] = useState<Range>('today');
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(device.custom_label ?? '');
  const [category, setCategory] = useState(device.category ?? '');
  const [notes, setNotes] = useState(device.notes ?? '');

  const { data, mutate } = useSWR<{
    device: Device;
    stats: typeof initialStats;
    traffic: Array<{ bucket_ts: number; bytes_down: number; bytes_up: number; peak_down_bps?: number; peak_up_bps?: number }>;
  }>(`/api/devices/${encodeURIComponent(device.mac)}?range=${range}`, fetcher, { refreshInterval: 15000 });

  const stats = data?.stats ?? initialStats;
  const traffic = data?.traffic ?? [];

  const chartData = useMemo(() => traffic.map((p) => ({
    t: formatBucket(p.bucket_ts, range),
    down: p.bytes_down,
    up: p.bytes_up,
    peak_down: p.peak_down_bps ?? 0,
    peak_up: p.peak_up_bps ?? 0,
  })), [traffic, range]);

  const save = async () => {
    await fetch(`/api/devices/${encodeURIComponent(device.mac)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        custom_label: label.trim() || null,
        category: category.trim() || null,
        notes: notes.trim() || null,
        is_new: 0,
      }),
    });
    setEditing(false);
    mutate();
  };

  const displayName = device.custom_label || device.router_remark || device.hostname || device.mac;

  return (
    <div className="space-y-5">
      <div className="card p-5 animate-fade-in">
        <div className="flex items-start gap-4">
          <div className="text-4xl">{categoryIcon(device.category)}</div>
          <div className="flex-1">
            {!editing ? (
              <>
                <h1 className="text-2xl font-bold flex items-center gap-3">
                  {displayName}
                  {device.is_new === 1 && (
                    <span className="text-[10px] uppercase tracking-wide bg-accent-red text-white rounded px-1.5 py-0.5 font-bold">NEW</span>
                  )}
                </h1>
                <div className="text-sm text-slate-400 mt-1">
                  {device.vendor || 'Unknown vendor'} · {device.mac} · category: <span className="text-slate-300">{device.category ?? 'unknown'}</span>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  first seen {new Date(device.first_seen).toLocaleString()} · last seen {new Date(device.last_seen).toLocaleString()}
                </div>
                {device.notes && <div className="text-sm mt-2 text-slate-300 whitespace-pre-line">{device.notes}</div>}
              </>
            ) : (
              <div className="space-y-2">
                <label className="block">
                  <span className="text-xs text-slate-400">Custom label</span>
                  <input value={label} onChange={(e) => setLabel(e.target.value)}
                    className="block w-full mt-1 bg-bg-elevated border border-bg-border rounded-md px-2 py-1.5 text-sm" />
                </label>
                <label className="block">
                  <span className="text-xs text-slate-400">Category</span>
                  <select value={category} onChange={(e) => setCategory(e.target.value)}
                    className="block w-full mt-1 bg-bg-elevated border border-bg-border rounded-md px-2 py-1.5 text-sm">
                    <option value="">(auto)</option>
                    <option value="phone">📱 phone</option>
                    <option value="tablet">📱 tablet</option>
                    <option value="computer">💻 computer</option>
                    <option value="tv">📺 tv</option>
                    <option value="watch">⌚ watch</option>
                    <option value="iot">🔌 iot</option>
                    <option value="printer">🖨️ printer</option>
                    <option value="router">📡 router/AP</option>
                    <option value="unknown">❔ unknown</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-slate-400">Notes</span>
                  <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
                    className="block w-full mt-1 bg-bg-elevated border border-bg-border rounded-md px-2 py-1.5 text-sm" />
                </label>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {!editing && <button onClick={() => setEditing(true)} className="text-xs px-3 py-1.5 rounded bg-bg-elevated border border-bg-border hover:bg-bg-border">Edit</button>}
            {editing && <>
              <button onClick={save} className="text-xs px-3 py-1.5 rounded bg-accent text-white">Save</button>
              <button onClick={() => setEditing(false)} className="text-xs px-3 py-1.5 rounded bg-bg-elevated border border-bg-border">Cancel</button>
            </>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Mini label="All-time ↓" value={formatBytes(stats.bytes_down)} />
        <Mini label="All-time ↑ (est)" value={formatBytes(stats.bytes_up)} />
        <Mini label="Peak ↓" value={formatBps(stats.peak_down_bps)} />
        <Mini label="Peak ↑" value={formatBps(stats.peak_up_bps)} />
      </div>

      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="stat-label">Traffic by bucket</div>
            <div className="text-xs text-slate-500 mt-1">{RANGES.find((r) => r.value === range)?.label}</div>
          </div>
          <div className="flex bg-bg-elevated border border-bg-border rounded-md overflow-hidden text-xs">
            {RANGES.map((r) => (
              <button key={r.value} onClick={() => setRange(r.value)}
                className={`px-3 py-1.5 transition ${range === r.value ? 'bg-accent text-white' : 'text-slate-400 hover:text-slate-100'}`}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid stroke="#202842" strokeDasharray="3 3" />
              <XAxis dataKey="t" stroke="#64748b" tick={{ fontSize: 11 }} minTickGap={24} />
              <YAxis stroke="#64748b" tick={{ fontSize: 11 }} tickFormatter={(v) => formatBytes(v, 0)} width={70} />
              <Tooltip
                contentStyle={{ background: '#111726', border: '1px solid #202842', borderRadius: 8 }}
                formatter={(v: number, name: string) => [formatBytes(v), name === 'down' ? '↓ Download' : '↑ Upload']} />
              <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v: string) => v === 'down' ? '↓ Download' : '↑ Upload'} />
              <Bar dataKey="down" stackId="a" fill="#60a5fa" />
              <Bar dataKey="up"   stackId="a" fill="#fb923c" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card p-5">
        <div className="stat-label mb-3">Peak speed</div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid stroke="#202842" strokeDasharray="3 3" />
              <XAxis dataKey="t" stroke="#64748b" tick={{ fontSize: 11 }} minTickGap={24} />
              <YAxis stroke="#64748b" tick={{ fontSize: 11 }} tickFormatter={(v) => formatBps(v, 0)} width={70} />
              <Tooltip contentStyle={{ background: '#111726', border: '1px solid #202842', borderRadius: 8 }}
                formatter={(v: number) => formatBps(v)} />
              <Line type="monotone" dataKey="peak_down" stroke="#60a5fa" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="peak_up" stroke="#fb923c" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="stat-label">{label}</div>
      <div className="text-lg font-semibold text-slate-100 mt-1 tabular-nums">{value}</div>
    </div>
  );
}

function formatBucket(ts: number, range: Range): string {
  const d = new Date(ts);
  switch (range) {
    case 'hour':
    case 'today':
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    case 'week':
    case 'month':
      return d.toLocaleDateString([], { month: 'short', day: '2-digit' });
    case 'year':
    case 'all':
      return d.toLocaleDateString([], { year: '2-digit', month: 'short' });
  }
}
