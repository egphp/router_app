'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { RefreshCw } from 'lucide-react';

interface VersionInfo {
  local: string;
  remote: string;
  updateAvailable: boolean;
  lastFetch: number | null;
  lastUpdate: string | null;
  adminMode?: boolean;
}

export function UpdateBanner() {
  // Poll every 15s so we notice deploys quickly (auto-update tick is 2 min,
  // but the API itself is cheap).
  const { data } = useSWR<VersionInfo>('/api/version', fetcher, { refreshInterval: 15000 });
  const initialLocal = useRef<string | null>(null);
  const [reloading, setReloading] = useState(false);

  // Remember the local sha as of page load. If it ever changes, the deploy
  // landed — reload the tab so the user sees the new build.
  useEffect(() => {
    if (!data?.local) return;
    if (initialLocal.current === null) {
      initialLocal.current = data.local;
      return;
    }
    if (data.local !== initialLocal.current && !reloading) {
      setReloading(true);
      // small grace so the new bundle is fully on disk
      setTimeout(() => window.location.reload(), 800);
    }
  }, [data?.local, reloading]);

  if (reloading) {
    return (
      <div className="card mb-4 border-accent-green/40 bg-gradient-to-r from-accent-green/15 to-transparent px-4 py-3 flex items-center gap-3 animate-fade-in">
        <RefreshCw className="text-accent-green animate-spin" size={18} />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-accent-green">Update installed — reloading…</div>
          <div className="text-xs text-slate-400">Your monitor just pulled a new commit. Refreshing now.</div>
        </div>
      </div>
    );
  }

  if (!data || !data.updateAvailable) return null;

  if (data.adminMode) {
    return (
      <div className="card mb-4 border-accent-amber/40 bg-gradient-to-r from-accent-amber/15 to-transparent px-4 py-3 flex items-center gap-3 animate-fade-in">
        <RefreshCw className="text-accent-amber" size={18} />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-accent-amber">Update available (admin mode — auto-update disabled)</div>
          <div className="text-xs text-slate-400">
            New commit on origin/main. This is the development copy; pull manually when ready.
          </div>
        </div>
        <code className="text-[10px] text-slate-500 font-mono shrink-0 hidden sm:block">
          {data.local} → {data.remote}
        </code>
      </div>
    );
  }

  return (
    <div className="card mb-4 border-accent/40 bg-gradient-to-r from-accent/15 to-transparent px-4 py-3 flex items-center gap-3 animate-fade-in">
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
