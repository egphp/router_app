'use client';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { AlertTriangle, WifiOff } from 'lucide-react';

export function AlertBanner() {
  const { data } = useSWR<{ connected: boolean; last_sample_ts: number | null }>(
    '/api/status', fetcher, { refreshInterval: 5000 }
  );

  if (!data) return null;
  if (data.connected) return null;

  return (
    <div className="card mb-4 border-accent-red/40 bg-accent-red/10 px-4 py-3 flex items-center gap-3 animate-fade-in">
      <WifiOff className="text-accent-red" size={18} />
      <div>
        <div className="font-medium text-accent-red">Router unreachable</div>
        <div className="text-xs text-slate-400">
          {data.last_sample_ts
            ? `Last sample at ${new Date(data.last_sample_ts).toLocaleTimeString()}`
            : 'No samples received yet — is the poller running?'}
        </div>
      </div>
    </div>
  );
}
