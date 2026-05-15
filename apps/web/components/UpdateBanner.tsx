'use client';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { RefreshCw } from 'lucide-react';

interface VersionInfo {
  local: string;
  remote: string;
  updateAvailable: boolean;
  lastFetch: number | null;
  lastUpdate: string | null;
}

export function UpdateBanner() {
  const { data } = useSWR<VersionInfo>('/api/version', fetcher, { refreshInterval: 60000 });

  if (!data || !data.updateAvailable) return null;

  return (
    <div className="card mb-4 border-accent/40 bg-accent/10 px-4 py-3 flex items-center gap-3 animate-fade-in">
      <RefreshCw className="text-accent animate-spin-slow" size={18} />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-accent">Update available</div>
        <div className="text-xs text-slate-400">
          New commit on origin/main ({data.remote}). The auto-updater runs every 2 minutes — your monitor will pick it up automatically without losing data or logs.
        </div>
      </div>
      <code className="text-[10px] text-slate-500 font-mono shrink-0 hidden sm:block">
        {data.local} → {data.remote}
      </code>
    </div>
  );
}
