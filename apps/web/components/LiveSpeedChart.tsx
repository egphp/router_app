'use client';
import { useMemo, useRef } from 'react';
import useSWR from 'swr';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { fetcher } from '../lib/fetcher';
import { formatBps } from '../lib/format';

interface SpeedPoint { ts: number; down_bps: number; up_bps: number }
interface WanLineLive { id: number; status: string; down_bps: number; up_bps: number }
interface LiveSpeedResponse {
  speeds: SpeedPoint[];
  source?: 'router-best' | 'router-direct' | 'wan' | 'devices';
  latest_ts?: number | null;
  direct?: {
    wan_lines?: WanLineLive[];
    wan_down_bps?: number;
    wan_up_bps?: number;
    lan_local_down_bps?: number;
    lan_local_up_bps?: number;
  };
}

function formatMbps(bytesPerSec: number): string {
  const mbps = (Math.max(0, Number(bytesPerSec || 0)) * 8) / 1_000_000;
  return mbps >= 10 ? `${mbps.toFixed(1)} Mbps` : `${mbps.toFixed(2)} Mbps`;
}

export function LiveSpeedChart() {
  const lastGood = useRef<SpeedPoint[]>([]);
  const { data, error } = useSWR<LiveSpeedResponse>('/api/live?minutes=60', fetcher, {
    refreshInterval: 1000,
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
    t: new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    down: p.down_bps,
    up: p.up_bps,
  })), [speeds]);

  const latest = speeds[speeds.length - 1] ?? null;
  const latestAgeSec = latest ? Math.max(0, Math.round((Date.now() - latest.ts) / 1000)) : null;
  const sourceLabel = data?.source === 'wan'
    ? 'WAN1+WAN2 (إنترنت حقيقي)'
    : data?.source === 'router-direct'
    ? 'Router live'
    : data?.source === 'devices'
    ? 'Devices'
    : 'Router best';
  const wanLines = data?.direct?.wan_lines ?? [];
  const lanLocalBps = Math.max(data?.direct?.lan_local_down_bps ?? 0, data?.direct?.lan_local_up_bps ?? 0);
  const isFresh = latestAgeSec !== null && latestAgeSec <= 25;
  const isStale = data?.speeds.length === 0 && lastGood.current.length === 0;
  const errored = !!error && rows.length === 0;

  return (
    <div className="card p-4 sm:p-5 animate-fade-in flex flex-col h-full">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="min-w-0">
          <div className="stat-label flex items-center gap-2">
            Live Speed
            {data === undefined && <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse" />}
            {data !== undefined && !error && <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />}
            {error && <span className="w-1.5 h-1.5 rounded-full bg-accent-amber animate-pulse" title="last fetch failed; showing cached data" />}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 text-[10px] sm:text-[11px] shrink-0 flex-wrap">
          {latest && (
            <>
              <span className="font-semibold text-blue-300 tabular-nums" title={formatMbps(latest.down_bps)}>
                <bdi>↓ {formatBps(latest.down_bps, 0)} ({formatMbps(latest.down_bps)})</bdi>
              </span>
              <span className="font-semibold text-orange-300 tabular-nums" title={formatMbps(latest.up_bps)}>
                <bdi>↑ {formatBps(latest.up_bps, 0)} ({formatMbps(latest.up_bps)})</bdi>
              </span>
              <span className={isFresh ? 'text-accent-green' : 'text-accent-amber'}>
                <bdi>{sourceLabel} · {latestAgeSec}s</bdi>
              </span>
            </>
          )}
          {!latest && <span className="text-slate-500">{sourceLabel}</span>}
        </div>
      </div>
      {(wanLines.length > 0 || lanLocalBps > 32 * 1024) && (
        <div className="flex items-center gap-2 flex-wrap mb-2 text-[11px] text-slate-400 tabular-nums">
          {wanLines.map((w) => (
            <span
              key={w.id}
              className="rounded px-2 py-0.5 bg-bg-elevated/80"
              style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
            >
              <bdi>
                WAN{w.id}: ↓ {formatBps(w.down_bps, 0)} · ↑ {formatBps(w.up_bps, 0)}
              </bdi>
            </span>
          ))}
          {lanLocalBps > 32 * 1024 && (
            <span
              className="rounded px-2 py-0.5 text-slate-300"
              style={{
                background: 'rgba(91,141,239,.09)',
                boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.25)',
              }}
              title="حركة داخلية بين الأجهزة والكاميرات لا تُخصم من باقة الإنترنت"
            >
              <bdi>حركة داخلية (LAN / كاميرات): {formatBps(lanLocalBps, 0)}</bdi>
            </span>
          )}
        </div>
      )}
      <div className="flex-1 min-h-[80px]">
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
