'use client';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { fetcher } from '../lib/fetcher';
import { formatBps, formatBytes, formatMacShort, categoryIcon, categoryLabel, formatDuration, timeAgo } from '../lib/format';
import { IpHistoryList, type IpHistoryEntry } from './SecurityFindingDetails';

type Range = 'hour' | 'today' | 'week' | 'month' | 'year' | 'all';

const RANGES: { value: Range; label: string; shortLabel: string }[] = [
  { value: 'hour', label: 'Last hour', shortLabel: 'Hour' },
  { value: 'today', label: 'Today', shortLabel: 'Today' },
  { value: 'week', label: 'Week', shortLabel: 'Week' },
  { value: 'month', label: 'Month', shortLabel: 'Month' },
  { value: 'year', label: 'Year', shortLabel: 'Year' },
  { value: 'all', label: 'All time', shortLabel: 'All' },
];

interface Device {
  mac: string;
  ip: string | null;
  hostname: string | null;
  router_remark: string | null;
  custom_label: string | null;
  vendor: string | null;
  category: string | null;
  online: 0 | 1 | null;
  up_speed_bps?: number;
  down_speed_bps?: number;
  is_new: 0 | 1;
  first_seen: number;
  last_online_at: number | null;
  last_seen: number;
  notes: string | null;
  reserved?: 0 | 1;
  reserved_ip?: string | null;
}

interface DailyRow { day_ts: number; day_label: string; bytes_down: number; bytes_up: number; total: number; }
interface SessionRow { started_at: number; ended_at: number | null; bytes_down: number; bytes_up: number; }

export function DeviceDetailClient({ device, initialStats, initialSessions, dailyUsage }: {
  device: Device;
  initialStats: { bytes_down: number; bytes_up: number; peak_down_bps: number; peak_up_bps: number };
  initialSessions: SessionRow[];
  dailyUsage: DailyRow[];
}) {
  const [range, setRange] = useState<Range>('today');
  const [selectedTrafficDay, setSelectedTrafficDay] = useState('');
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(device.custom_label ?? '');
  const [category, setCategory] = useState(device.category ?? '');
  const [notes, setNotes] = useState(device.notes ?? '');
  const detailUrl = `/api/devices/${encodeURIComponent(device.mac)}?range=${range}&live=1${selectedTrafficDay ? `&day=${selectedTrafficDay}` : ''}`;

  const { data, mutate } = useSWR<{
    device: Device;
    stats: typeof initialStats;
    sessions: SessionRow[];
    traffic: Array<{ bucket_ts: number; bytes_down: number; bytes_up: number; peak_down_bps?: number; peak_up_bps?: number }>;
    attacks: { summary: Array<{ attack_kind: string; events: number; total: number; latest: number }>; recent: Array<{ ts: number; attack_kind: string; attack_count: number; message: string }> };
    dailyUsage: DailyRow[];
  }>(detailUrl, fetcher, {
    refreshInterval: 2000,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    keepPreviousData: true,
  });

  const stats = data?.stats ?? initialStats;
  const traffic = data?.traffic ?? [];
  const attacks = data?.attacks;
  const currentDevice = data?.device ?? device;
  const sessions = data?.sessions ?? initialSessions;
  const dailyRows = data?.dailyUsage ?? dailyUsage;
  const chartRange = selectedTrafficDay ? 'today' : range;

  // IP history — every distinct IP this MAC was observed on, with sample counts
  // and first/last seen. Useful for randomized-MAC devices that roam IPs across
  // DHCP renewals.
  const { data: ipHistoryData } = useSWR<{ history: IpHistoryEntry[] }>(
    `/api/devices/${encodeURIComponent(device.mac)}/ip-history`,
    fetcher,
    { refreshInterval: 30000, keepPreviousData: true },
  );
  const ipHistory = ipHistoryData?.history ?? [];

  const chartData = useMemo(() => traffic.map((p) => ({
    t: formatBucket(p.bucket_ts, chartRange),
    down: p.bytes_down,
    up: p.bytes_up,
    peak_down: p.peak_down_bps ?? 0,
    peak_up: p.peak_up_bps ?? 0,
  })), [traffic, chartRange]);

  const trafficTotals = useMemo(() => traffic.reduce((acc, p) => {
    acc.down += Number(p.bytes_down ?? 0);
    acc.up += Number(p.bytes_up ?? 0);
    return acc;
  }, { down: 0, up: 0 }), [traffic]);

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

  const displayName = currentDevice.custom_label || currentDevice.router_remark || currentDevice.hostname || currentDevice.mac;

  return (
    <div className="space-y-5">
      <div className="card p-4 sm:p-5 animate-fade-in">
        <div className="flex items-start gap-3 sm:gap-4">
          <div className="text-3xl sm:text-4xl shrink-0">{categoryIcon(currentDevice.category)}</div>
          <div className="flex-1 min-w-0">
            {!editing ? (
              <>
                <h1 className="text-lg sm:text-2xl font-bold flex items-center gap-2 sm:gap-3 flex-wrap">
                  {displayName}
                  {currentDevice.is_new === 1 && (
                    <span className="text-[10px] uppercase tracking-wide bg-accent-red text-white rounded px-1.5 py-0.5 font-bold">NEW</span>
                  )}
                  {currentDevice.reserved === 1 && (
                    <span
                      className="text-[10px] uppercase tracking-wide bg-accent-green/15 text-accent-green rounded px-1.5 py-0.5 font-semibold"
                      title={currentDevice.reserved_ip ? `Address reservation → ${currentDevice.reserved_ip}` : 'Address reserved on router'}
                    >
                      🔒 reserved{currentDevice.reserved_ip ? ` · ${currentDevice.reserved_ip}` : ''}
                    </span>
                  )}
                </h1>
                <div className="text-sm text-slate-400 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{currentDevice.vendor || 'Unknown vendor'}</span>
                  <span className="text-slate-600">·</span>
                  {currentDevice.ip && (
                    <>
                      <span className="font-mono text-slate-300">{currentDevice.ip}</span>
                      <span className="text-slate-600">·</span>
                    </>
                  )}
                  <span className="font-mono">{currentDevice.mac}</span>
                  <span className="text-slate-600">·</span>
                  <span>category: <span className="text-slate-300">{categoryLabel(currentDevice.category)}</span></span>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  first seen {new Date(currentDevice.first_seen).toLocaleString()} · last sample {new Date(currentDevice.last_seen).toLocaleString()}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className={`px-2 py-1 rounded border ${currentDevice.online === 1 ? 'bg-accent-green/10 text-accent-green border-accent-green/30' : 'bg-slate-800/60 text-slate-400 border-bg-border'}`}>
                    {lastOnlineLabel(currentDevice)}
                  </span>
                  {currentDevice.last_online_at && (
                    <span className="text-slate-500">
                      last online at {new Date(currentDevice.last_online_at).toLocaleString()}
                    </span>
                  )}
                </div>
                {currentDevice.notes && <div className="text-sm mt-2 text-slate-300 whitespace-pre-line">{currentDevice.notes}</div>}
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
                    <option value="camera">📷 camera</option>
                    <option value="game_console">🎮 game console</option>
                    <option value="router">📡 router</option>
                    <option value="access_point">📶 access point / repeater</option>
                    <option value="nas">🗄️ NAS / storage</option>
                    <option value="streaming">▶️ streaming box</option>
                    <option value="speaker">🔊 speaker</option>
                    <option value="smart_home">🏠 smart home</option>
                    <option value="iot">🔌 iot</option>
                    <option value="printer">🖨️ printer</option>
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

      <div className="grid grid-cols-2 lg:grid-cols-7 gap-2 sm:gap-3">
        <Mini label="Live ↓" value={formatBps(currentDevice.down_speed_bps ?? 0)} />
        <Mini label="Live ↑" value={formatBps(currentDevice.up_speed_bps ?? 0)} />
        <Mini
          label="All-time total"
          value={formatBytes(stats.bytes_down + stats.bytes_up)}
          hint={`↓ ${formatBytes(stats.bytes_down, 0)} · ↑ ${formatBytes(stats.bytes_up, 0)}`}
        />
        <Mini label="All-time ↓" value={formatBytes(stats.bytes_down)} />
        <Mini label="All-time ↑ (est)" value={formatBytes(stats.bytes_up)} />
        <Mini label="Peak ↓" value={formatBps(stats.peak_down_bps)} />
        <Mini label="Peak ↑" value={formatBps(stats.peak_up_bps)} />
      </div>

      <div className="card p-5">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <div className="stat-label">Recent sessions</div>
          <div className="text-xs text-slate-500">{sessions.length} shown</div>
        </div>
        {sessions.length === 0 ? (
          <div className="text-sm text-slate-500 py-4">No sessions recorded yet.</div>
        ) : (
          <>
            <div className="space-y-2 sm:hidden">
              {sessions.slice(0, 10).map((session) => {
                const end = session.ended_at ?? Date.now();
                return (
                  <div key={session.started_at} className="rounded-md border border-bg-border bg-bg-elevated/35 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs text-slate-500">Started</div>
                        <div className="text-sm text-slate-200">{new Date(session.started_at).toLocaleString()}</div>
                      </div>
                      {session.ended_at === null && <span className="shrink-0 rounded-full bg-accent-green/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-accent-green">active</span>}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <InfoPill label="Duration" value={formatDuration((end - session.started_at) / 1000)} />
                      <InfoPill label="Total" value={formatBytes(session.bytes_down + session.bytes_up)} strong />
                      <InfoPill label="Download" value={formatBytes(session.bytes_down)} tone="down" />
                      <InfoPill label="Upload" value={formatBytes(session.bytes_up)} tone="up" />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Started</th>
                  <th className="px-3 py-2 text-left">Duration</th>
                  <th className="px-3 py-2 text-right">Download</th>
                  <th className="px-3 py-2 text-right">Upload</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 10).map((session) => {
                  const end = session.ended_at ?? Date.now();
                  return (
                    <tr key={session.started_at} className="border-t border-bg-border">
                      <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{new Date(session.started_at).toLocaleString()}</td>
                      <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                        {formatDuration((end - session.started_at) / 1000)}
                        {session.ended_at === null && <span className="ml-2 text-accent-green">active</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-blue-300 tabular-nums">{formatBytes(session.bytes_down)}</td>
                      <td className="px-3 py-2 text-right text-orange-300 tabular-nums">{formatBytes(session.bytes_up)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatBytes(session.bytes_down + session.bytes_up)}</td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card p-5">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <div>
            <div className="stat-label">IP history</div>
            <div className="text-xs text-slate-500 mt-1">Every distinct IP this device has been observed on.</div>
          </div>
          <div className="text-xs text-slate-500">{ipHistory.length} {ipHistory.length === 1 ? 'IP' : 'IPs'}</div>
        </div>
        <IpHistoryList history={ipHistory} />
      </div>

      <div className="card p-5">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div>
            <div className="stat-label">Traffic by bucket</div>
            <div className="text-xs text-slate-500 mt-1">
              {selectedTrafficDay ? `Selected day · ${dateLabelFromInput(selectedTrafficDay)}` : RANGES.find((r) => r.value === range)?.label}
            </div>
          </div>
          <div className="grid w-full grid-cols-2 min-[420px]:grid-cols-3 sm:w-auto sm:flex bg-bg-elevated border border-bg-border rounded-md overflow-hidden text-xs">
            {RANGES.map((r) => (
              <button key={r.value} onClick={() => { setSelectedTrafficDay(''); setRange(r.value); }}
                className={`px-2 sm:px-3 py-1.5 transition text-center ${range === r.value ? 'bg-accent text-white' : 'text-slate-400 hover:text-slate-100'}`}>
                <span className="sm:hidden">{r.shortLabel}</span>
                <span className="hidden sm:inline">{r.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="mb-4 grid gap-2 lg:grid-cols-[minmax(220px,320px)_1fr]">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={selectedTrafficDay}
              onChange={(e) => setSelectedTrafficDay(e.target.value)}
              onInput={(e) => setSelectedTrafficDay(e.currentTarget.value)}
              max={dateInputValue(Date.now())}
              className="bg-bg-elevated border border-bg-border rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:border-accent"
              aria-label="Find bucket traffic by day"
            />
            {selectedTrafficDay && (
              <button
                onClick={() => setSelectedTrafficDay('')}
                className="text-xs px-3 py-2 rounded bg-bg-elevated border border-bg-border text-slate-300 hover:bg-bg-border"
              >
                Clear
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <DayMetric label="↓ Down" value={formatBytes(trafficTotals.down)} tone="down" />
            <DayMetric label="↑ Up" value={formatBytes(trafficTotals.up)} tone="up" />
            <DayMetric label="Total" value={formatBytes(trafficTotals.down + trafficTotals.up)} tone="total" />
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

      <DailyComparison rows={dailyRows} />
    </div>
  );
}

function DailyComparison({ rows }: { rows: DailyRow[] }) {
  const [selectedDay, setSelectedDay] = useState('');
  const rowsByDay = useMemo(() => {
    const map = new Map<string, DailyRow>();
    for (const row of rows) map.set(dateInputValue(row.day_ts), row);
    return map;
  }, [rows]);
  const selectedRow = selectedDay ? rowsByDay.get(selectedDay) ?? null : null;
  const visibleRows = selectedDay ? (selectedRow ? [selectedRow] : []) : rows;
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div className="stat-label">Day-by-day comparison</div>
        <div className="text-xs text-slate-500">{rows.length} days</div>
      </div>
      <div className="mb-4 grid gap-3 lg:grid-cols-[minmax(220px,320px)_1fr]">
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={selectedDay}
            onChange={(e) => setSelectedDay(e.target.value)}
            onInput={(e) => setSelectedDay(e.currentTarget.value)}
            max={dateInputValue(Date.now())}
            className="bg-bg-elevated border border-bg-border rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:border-accent"
            aria-label="Find traffic by day"
          />
          {selectedDay && (
            <button
              onClick={() => setSelectedDay('')}
              className="text-xs px-3 py-2 rounded bg-bg-elevated border border-bg-border text-slate-300 hover:bg-bg-border"
            >
              Clear
            </button>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <DayMetric label="↓ Down" value={selectedRow ? formatBytes(selectedRow.bytes_down) : selectedDay ? '0 B' : 'choose day'} tone="down" />
          <DayMetric label="↑ Up" value={selectedRow ? formatBytes(selectedRow.bytes_up) : selectedDay ? '0 B' : 'choose day'} tone="up" />
          <DayMetric label="Total" value={selectedRow ? formatBytes(selectedRow.total) : selectedDay ? '0 B' : 'choose day'} tone="total" />
        </div>
      </div>
      {visibleRows.length === 0 ? (
        <div className="text-sm text-slate-500 py-4">{selectedDay ? 'No traffic recorded for this day.' : 'No daily data yet.'}</div>
      ) : (
        <>
          <div className="space-y-2 sm:hidden">
            {visibleRows.map((r) => {
              const sourceIndex = rows.findIndex((row) => row.day_ts === r.day_ts);
              const prev = sourceIndex >= 0 ? rows[sourceIndex + 1] : undefined;
              const delta = prev ? r.total - prev.total : null;
              const pct = prev && prev.total > 0 ? Math.round(((r.total - prev.total) / prev.total) * 100) : null;
              const isToday = dateInputValue(r.day_ts) === dateInputValue(Date.now());
              const isSelected = selectedDay === dateInputValue(r.day_ts);
              const barPct = Math.round((r.total / max) * 100);
              return (
                <div key={r.day_ts} className={`rounded-md border border-bg-border bg-bg-elevated/35 p-3 ${isToday || isSelected ? 'ring-1 ring-accent/40' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-100">{r.day_label}</div>
                      {isToday && <div className="text-[10px] text-accent">today</div>}
                      {isSelected && !isToday && <div className="text-[10px] text-accent">selected</div>}
                    </div>
                    <div className="text-right tabular-nums">
                      <div className="text-xs text-slate-500">Total</div>
                      <div className="font-semibold text-slate-100">{formatBytes(r.total)}</div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <InfoPill label="Down" value={formatBytes(r.bytes_down)} tone="down" />
                    <InfoPill label="Up" value={formatBytes(r.bytes_up)} tone="up" />
                    <InfoPill
                      label="vs prev"
                      value={delta === null ? '—' : `${delta > 0 ? '+' : ''}${formatBytes(Math.abs(delta))}${pct !== null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}`}
                      tone={delta === null ? undefined : delta > 0 ? 'err' : delta < 0 ? 'ok' : undefined}
                    />
                    <div className="rounded-md border border-bg-border bg-bg-elevated/70 px-3 py-2 min-w-0">
                      <div className="text-[10px] uppercase tracking-wide text-slate-500">Relative</div>
                      <div className="mt-2 h-2 rounded-full bg-bg-border overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-blue-500 to-purple-500" style={{ width: `${barPct}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hidden sm:block overflow-x-auto">
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
              {visibleRows.map((r) => {
                const sourceIndex = rows.findIndex((row) => row.day_ts === r.day_ts);
                const prev = sourceIndex >= 0 ? rows[sourceIndex + 1] : undefined;
                const delta = prev ? r.total - prev.total : null;
                const pct = prev && prev.total > 0 ? Math.round(((r.total - prev.total) / prev.total) * 100) : null;
                const isToday = dateInputValue(r.day_ts) === dateInputValue(Date.now());
                const isSelected = selectedDay === dateInputValue(r.day_ts);
                const barPct = Math.round((r.total / max) * 100);
                return (
                  <tr key={r.day_ts} className={`border-t border-bg-border ${isToday ? 'bg-accent/5' : ''} ${isSelected ? 'outline outline-1 outline-accent/40' : ''}`}>
                    <td className="px-2 py-2.5 whitespace-nowrap">
                      <div className={isToday || isSelected ? 'font-semibold text-slate-100' : 'text-slate-300'}>{r.day_label}</div>
                      {isToday && <div className="text-[10px] text-accent">today</div>}
                      {isSelected && !isToday && <div className="text-[10px] text-accent">selected</div>}
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
        </>
      )}
    </div>
  );
}

function InfoPill({ label, value, tone, strong }: { label: string; value: string; tone?: 'down' | 'up' | 'ok' | 'err'; strong?: boolean }) {
  const valueClass = tone === 'down'
    ? 'text-blue-400'
    : tone === 'up'
      ? 'text-orange-400'
      : tone === 'ok'
        ? 'text-accent-green'
        : tone === 'err'
          ? 'text-accent-red'
          : 'text-slate-200';
  return (
    <div className="rounded-md border border-bg-border bg-bg-elevated/70 px-3 py-2 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 tabular-nums break-words ${strong ? 'font-semibold' : ''} ${valueClass}`}>{value}</div>
    </div>
  );
}

function DayMetric({ label, value, tone }: { label: string; value: string; tone: 'down' | 'up' | 'total' }) {
  const valueClass = tone === 'down' ? 'text-blue-400' : tone === 'up' ? 'text-orange-400' : 'text-slate-100';
  return (
    <div className="rounded-md border border-bg-border bg-bg-elevated/70 px-3 py-2 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 font-semibold tabular-nums truncate ${valueClass}`}>{value}</div>
    </div>
  );
}

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="stat-label">{label}</div>
      <div className="text-lg font-semibold text-slate-100 mt-1 tabular-nums">{value}</div>
      {hint && <div className="text-[10px] tabular-nums mt-0.5" style={{ color: 'var(--text-3)' }}>{hint}</div>}
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

function lastOnlineLabel(device: Pick<Device, 'online' | 'last_online_at'>): string {
  if (device.online === 1) return 'online now';
  return device.last_online_at ? `last online ${timeAgo(device.last_online_at)}` : 'never seen online';
}

function dateInputValue(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateLabelFromInput(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Date(year, month - 1, day).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
