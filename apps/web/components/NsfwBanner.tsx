'use client';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { ShieldAlert, ChevronDown } from 'lucide-react';
import { useState } from 'react';

interface NsfwResp {
  enabled: boolean;
  last_24h: { hits: number; devices: number };
  top_domains: Array<{ domain: string; category: string; hits: number; last_ts: number }>;
  by_device: Array<{ source_mac: string; source_ip: string | null; hits: number; last_ts: number; label: string }>;
}

export function NsfwBanner() {
  const { data } = useSWR<NsfwResp>('/api/nsfw', fetcher, { refreshInterval: 60000 });
  const [open, setOpen] = useState(false);

  if (!data || !data.enabled || data.last_24h.hits === 0) return null;

  const { hits, devices } = data.last_24h;

  return (
    <div className="card mb-4 border-accent-red/40 bg-gradient-to-r from-accent-red/15 via-accent-red/10 to-transparent backdrop-blur animate-fade-in">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left"
      >
        <div className="shrink-0 w-9 h-9 rounded-xl bg-accent-red/20 flex items-center justify-center">
          <ShieldAlert className="text-accent-red" size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-accent-red flex items-center gap-2">
            Adult content access detected
            <span className="text-[10px] uppercase bg-accent-red/20 text-accent-red rounded px-1.5 py-0.5 font-bold">last 24h</span>
          </div>
          <div className="text-xs text-slate-300 mt-0.5">
            <strong>{hits}</strong> hit{hits === 1 ? '' : 's'} across <strong>{devices}</strong> device{devices === 1 ? '' : 's'}. Click to view details.
          </div>
        </div>
        <ChevronDown size={16} className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-accent-red/20 px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1.5">Top devices</div>
            <ul className="space-y-1.5 text-xs">
              {data.by_device.slice(0, 5).map((d) => (
                <li key={d.source_mac} className="flex items-center justify-between gap-3 px-2 py-1 rounded bg-bg-elevated/40">
                  <span className="truncate text-slate-200">{d.label}</span>
                  <span className="tabular-nums text-accent-red font-bold shrink-0">{d.hits}</span>
                </li>
              ))}
              {data.by_device.length === 0 && (
                <li className="text-slate-500 text-[11px]">No device-level mapping available (DNS source missing).</li>
              )}
            </ul>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold mb-1.5">Top domains</div>
            <ul className="space-y-1.5 text-xs">
              {data.top_domains.slice(0, 5).map((d) => (
                <li key={d.domain} className="flex items-center justify-between gap-3 px-2 py-1 rounded bg-bg-elevated/40">
                  <span className="truncate font-mono text-slate-300">{d.domain}</span>
                  <span className="tabular-nums text-slate-400 shrink-0">{d.hits}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="md:col-span-2 text-[11px] text-slate-500">
            Disable detection from <a href="/settings" className="text-accent hover:underline">Settings</a>.
          </div>
        </div>
      )}
    </div>
  );
}
