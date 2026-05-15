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
  ip: string | null;
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

interface DailyRow { day_ts: number; day_label: string; bytes_down: number; bytes_up: number; total: number; }

export function DeviceDetailClient({ device, initialStats, dailyUsage }: {
  device: Device;
  initialStats: { bytes_down: number; bytes_up: number; peak_down_bps: number; peak_up_bps: number };
  dailyUsage: DailyRow[];
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
    attacks: { summary: Array<{ attack_kind: string; events: number; total: number; latest: number }>; recent: Array<{ ts: number; attack_kind: string; attack_count: number; message: string }> };
  }>(`/api/devices/${encodeURIComponent(device.mac)}?range=${range}`, fetcher, { refreshInterval: 15000 });

  const stats = data?.stats ?? initialStats;
  const traffic = data?.traffic ?? [];
  const attacks = data?.attacks;

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
      <div className="card p-4 sm:p-5 animate-fade-in">
        <div className="flex items-start gap-3 sm:gap-4">
          <div className="text-3xl sm:text-4xl shrink-0">{categoryIcon(device.category)}</div>
          <div className="flex-1 min-w-0">
            {!editing ? (
              <>
                <h1 className="text-lg sm:text-2xl font-bold flex items-center gap-2 sm:gap-3 flex-wrap">
                  {displayName}
                  {device.is_new === 1 && (
                    <span className="text-[10px] uppercase tracking-wide bg-accent-red text-white rounded px-1.5 py-0.5 font-bold">NEW</span>
                  )}
                </h1>
                <div className="text-sm text-slate-400 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{device.vendor || 'Unknown vendor'}</span>
                  <span className="text-slate-600">·</span>
                  {device.ip && (
                    <>
                      <span className="font-mono text-slate-300">{device.ip}</span>
                      <span className="text-slate-600">·</span>
                    </>
                  )}
                  <span className="font-mono">{device.mac}</span>
                  <span className="text-slate-600">·</span>
                  <span>category: <span className="text-slate-300">{device.category ?? 'unknown'}</span></span>
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
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
          <div className="flex bg-bg-elevated border border-bg-border rounded-md overflow-x-auto text-xs scrollbar-thin max-w-full">
            {RANGES.map((r) => (
              <button key={r.value} onClick={() => setRange(r.value)}
                className={`px-2 sm:px-3 py-1.5 transition whitespace-nowrap shrink-0 ${range === r.value ? 'bg-accent text-white' : 'text-slate-400 hover:text-slate-100'}`}>
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

      {attacks && (attacks.summary.length > 0 || attacks.recent.length > 0) && (
        <div className="card p-5 border-l-4 border-l-accent-red animate-fade-in">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-accent-red">⚠</span>
            <div className="stat-label">Attack history (from router log)</div>
          </div>
          {attacks.summary.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-3">
              {attacks.summary.map((s) => (
                <div key={s.attack_kind} className="px-3 py-2 bg-accent-red/10 border border-accent-red/30 rounded text-sm">
                  <div className="text-accent-red font-bold">{s.attack_kind} — {s.total}</div>
                  <div className="text-xs text-slate-400">{s.events} events · latest {new Date(s.latest).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                </div>
              ))}
            </div>
          )}
          {attacks.recent.length > 0 && (
            <details>
              <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-200">{attacks.recent.length} recent events</summary>
              <div className="mt-2 space-y-1 text-[11px] font-mono max-h-48 overflow-y-auto">
                {attacks.recent.map((r, i) => (
                  <div key={i} className="text-slate-400 border-l-2 border-accent-red/40 pl-2 py-0.5">
                    <span className="text-slate-500">{new Date(r.ts).toLocaleString()}</span> · <span className="text-accent-red">{r.attack_kind}×{r.attack_count}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

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

      <DailyComparison rows={dailyUsage} />
    </div>
  );
}

function DailyComparison({ rows }: { rows: DailyRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div className="stat-label">Day-by-day comparison</div>
        <div className="text-xs text-slate-500">{rows.length} days · click row to compare</div>
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-500 py-4">No daily data yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-2 text-left">Day</th>
                <th className="px-2 py-2 text-right">↓ Down</th>
                <th className="px-2 py-2 text-right">↑ Up</th>
                <th className="px-2 py-2 text-right">Total</th>
                <th className="px-2 py-2 text-right">vs prev</th>
                <th className="px-2 py-2 w-32">Relative</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const prev = rows[i + 1];
                const delta = prev ? r.total - prev.total : null;
                const pct = prev && prev.total > 0 ? Math.round(((r.total - prev.total) / prev.total) * 100) : null;
                const isToday = i === 0;
                const barPct = Math.round((r.total / max) * 100);
                return (
                  <tr key={r.day_ts} className={`border-t border-bg-border ${isToday ? 'bg-accent/5' : ''}`}>
                    <td className="px-2 py-2.5 whitespace-nowrap">
                      <div className={isToday ? 'font-semibold text-slate-100' : 'text-slate-300'}>{r.day_label}</div>
                      {isToday && <div className="text-[10px] text-accent">today</div>}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-blue-400">{formatBytes(r.bytes_down)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums text-orange-400">{formatBytes(r.bytes_up)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums font-semibold text-slate-100">{formatBytes(r.total)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {delta === null ? <span className="text-slate-600">—</span> : (
                        <span className={delta > 0 ? 'text-accent-red' : delta < 0 ? 'text-accent-green' : 'text-slate-500'}>
                          {delta > 0 ? '+' : ''}{formatBytes(Math.abs(delta))} {pct !== null && <span className="text-[10px]">({pct > 0 ? '+' : ''}{pct}%)</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="h-2 bg-bg-elevated rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-blue-500 to-purple-500" style={{ width: `${barPct}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
