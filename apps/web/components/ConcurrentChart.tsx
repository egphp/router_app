'use client';
import useSWR from 'swr';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { fetcher } from '../lib/fetcher';

export function ConcurrentChart() {
  const { data } = useSWR<{ data: Array<{ ts: number; count: number }> }>(
    '/api/analytics?kind=concurrent&minutes=1440', fetcher, { refreshInterval: 60000 }
  );
  const rows = (data?.data ?? []).map((p) => ({
    t: new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    count: p.count,
  }));

  return (
    <div className="card p-5 animate-fade-in">
      <div className="stat-label mb-1">Concurrent devices online</div>
      <div className="text-xs text-slate-500 mb-3">Number of online devices over the last 24h</div>
      <div className="h-48">
        <ResponsiveContainer>
          <AreaChart data={rows}>
            <defs>
              <linearGradient id="gc" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#a855f7" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#a855f7" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#202842" strokeDasharray="3 3" />
            <XAxis dataKey="t" stroke="#64748b" tick={{ fontSize: 11 }} minTickGap={64} />
            <YAxis stroke="#64748b" tick={{ fontSize: 11 }} width={40} allowDecimals={false} />
            <Tooltip contentStyle={{ background: '#111726', border: '1px solid #202842', borderRadius: 8 }} />
            <Area type="stepAfter" dataKey="count" stroke="#a855f7" strokeWidth={2} fill="url(#gc)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
