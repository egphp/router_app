'use client';
import { useMemo, useRef } from 'react';
import useSWR from 'swr';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { fetcher } from '../lib/fetcher';
import { formatBps } from '../lib/format';

interface SpeedPoint { ts: number; down_bps: number; up_bps: number }

export function LiveSpeedChart() {
  const lastGood = useRef<SpeedPoint[]>([]);
  const { data, error } = useSWR<{ speeds: SpeedPoint[] }>('/api/live?minutes=60', fetcher, {
    refreshInterval: 10000,
    keepPreviousData: true,
    revalidateOnFocus: false,
    shouldRetryOnError: true,
    errorRetryInterval: 5000,
    errorRetryCount: 10,
  });

  // Cache the last successful series so transient errors don't blank the chart.
  if (data?.speeds && data.speeds.length > 0) {
    lastGood.current = data.speeds;
  }
  const speeds = data?.speeds && data.speeds.length > 0 ? data.speeds : lastGood.current;

  const rows = useMemo(() => speeds.map((p) => ({
    t: new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    down: p.down_bps,
    up: p.up_bps,
  })), [speeds]);

  const isStale = data?.speeds.length === 0 && lastGood.current.length === 0;
  const errored = !!error && rows.length === 0;

  return (
    <div className="card p-5 animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="stat-label flex items-center gap-2">
            Live Speed
            {data === undefined && <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse" />}
            {data !== undefined && !error && <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />}
            {error && <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse" title="last fetch failed; showing cached data" />}
          </div>
          <div className="text-xs text-slate-500 mt-1">Last 60 minutes · all devices · refresh 10s</div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-400"></span>Download</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400"></span>Upload</span>
        </div>
      </div>
      <div className="h-64">
        {errored ? (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            Could not load speed data. Will retry automatically.
          </div>
        ) : isStale ? (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            Waiting for first sample…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <defs>
                <linearGradient id="gd" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gu" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#fb923c" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#fb923c" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#202842" strokeDasharray="3 3" />
              <XAxis dataKey="t" stroke="#64748b" tick={{ fontSize: 11 }} minTickGap={64} />
              <YAxis stroke="#64748b" tick={{ fontSize: 11 }} tickFormatter={(v) => formatBps(v, 0)} width={70} />
              <Tooltip
                contentStyle={{ background: '#111726', border: '1px solid #202842', borderRadius: 8 }}
                labelStyle={{ color: '#cbd5e1', fontSize: 12 }}
                formatter={(v: number, name: string) => [formatBps(v), name === 'down' ? '↓ Download' : '↑ Upload']}
              />
              <Area type="monotone" dataKey="down" stroke="#60a5fa" strokeWidth={2} fill="url(#gd)" isAnimationActive={false} />
              <Area type="monotone" dataKey="up" stroke="#fb923c" strokeWidth={2} fill="url(#gu)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
