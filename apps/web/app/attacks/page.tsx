'use client';
import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '../../lib/fetcher';
import { formatMacShort, timeAgo } from '../../lib/format';
import { ShieldAlert, AlertOctagon, RefreshCw } from 'lucide-react';

interface Entry {
  router_id: number; ts: number; log_type: number; message: string;
  attacker_ip: string | null; attacker_mac: string | null;
  attack_kind: string | null; attack_count: number | null;
  device_label: string | null;
}
interface Attacker {
  mac: string; ip: string; label: string;
  event_count: number; total_attacks: number; latest_ts: number; attack_kind: string;
}
interface Resp {
  entries: Entry[];
  stats: { totals: { total: number; attacks: number; system: number; quits: number }; topAttackers: Attacker[] };
}

const LOG_TYPES: Record<number, { label: string; color: string }> = {
  1: { label: 'system', color: 'text-slate-400 bg-slate-700/30' },
  2: { label: 'attack', color: 'text-accent-red bg-accent-red/20' },
  3: { label: 'quit', color: 'text-accent-amber bg-accent-amber/20' },
};

export default function AttacksPage() {
  const [filter, setFilter] = useState<number | null>(2);
  const url = filter === null ? '/api/attack-log?limit=500' : `/api/attack-log?limit=500&type=${filter}`;
  const { data, mutate, isValidating } = useSWR<Resp>(url, fetcher, { refreshInterval: 30000 });
  const entries = data?.entries ?? [];
  const stats = data?.stats;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <ShieldAlert size={20} className="text-accent-red" /> Attack Log
        </h1>
        <button onClick={() => mutate()} disabled={isValidating}
          className="text-xs px-3 py-1.5 rounded bg-bg-elevated border border-bg-border hover:bg-bg-border flex items-center gap-1.5 disabled:opacity-50">
          <RefreshCw size={12} className={isValidating ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-fade-in">
        <Stat label="Total entries" value={stats?.totals.total ?? 0} />
        <Stat label="Attacks (ARP/DDoS)" value={stats?.totals.attacks ?? 0} tone="red" />
        <Stat label="System events" value={stats?.totals.system ?? 0} tone="default" />
        <Stat label="Service quits" value={stats?.totals.quits ?? 0} tone="amber" />
      </div>

      {stats && stats.topAttackers.length > 0 && (
        <div className="card p-5 animate-fade-in">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <AlertOctagon size={16} className="text-accent-red" /> Top attackers (all time)
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Device</th>
                  <th className="px-3 py-2 text-left">Kind</th>
                  <th className="px-3 py-2 text-right">Events</th>
                  <th className="px-3 py-2 text-right">Total attacks</th>
                  <th className="px-3 py-2 text-right">Latest</th>
                </tr>
              </thead>
              <tbody>
                {stats.topAttackers.map((a) => (
                  <tr key={`${a.mac}-${a.attack_kind}`} className="border-t border-bg-border">
                    <td className="px-3 py-2">
                      {a.mac ? (
                        <Link href={`/devices/${encodeURIComponent(a.mac)}`}
                          className="font-medium hover:text-accent">{a.label}</Link>
                      ) : <span className="text-slate-500">unknown</span>}
                      <div className="text-[10px] text-slate-500">{a.ip} · {a.mac && formatMacShort(a.mac)}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-xs px-2 py-0.5 rounded bg-accent-red/20 text-accent-red">{a.attack_kind}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{a.event_count}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold text-accent-red">{a.total_attacks}</td>
                    <td className="px-3 py-2 text-right text-xs text-slate-400">{timeAgo(a.latest_ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card p-5 animate-fade-in">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-slate-500">Filter:</span>
          {[
            { v: 2, label: 'Attacks', tone: 'bg-accent-red/20 text-accent-red' },
            { v: 1, label: 'System', tone: 'bg-slate-700/30 text-slate-400' },
            { v: 3, label: 'Quits', tone: 'bg-accent-amber/20 text-accent-amber' },
            { v: null, label: 'All', tone: 'bg-bg-elevated text-slate-200' },
          ].map((t) => (
            <button key={String(t.v)} onClick={() => setFilter(t.v)}
              className={`px-3 py-1 rounded text-xs ${filter === t.v ? 'bg-accent text-white' : t.tone}`}>
              {t.label}
            </button>
          ))}
        </div>

        {entries.length === 0 ? (
          <div className="text-sm text-slate-500 text-center py-6">No entries.</div>
        ) : (
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="bg-bg-card/60 sticky top-0 text-slate-500">
                <tr>
                  <th className="px-3 py-1.5 text-left whitespace-nowrap">Time</th>
                  <th className="px-3 py-1.5 text-left">Type</th>
                  <th className="px-3 py-1.5 text-left">Attacker</th>
                  <th className="px-3 py-1.5 text-right">Count</th>
                  <th className="px-3 py-1.5 text-left">Message</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const t = LOG_TYPES[e.log_type] ?? { label: '?', color: 'text-slate-500' };
                  return (
                    <tr key={e.router_id} className="border-t border-bg-border/40">
                      <td className="px-3 py-1 text-slate-400 whitespace-nowrap">{new Date(e.ts).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className="px-3 py-1">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${t.color}`}>{e.attack_kind || t.label}</span>
                      </td>
                      <td className="px-3 py-1">
                        {e.attacker_mac ? (
                          <Link href={`/devices/${encodeURIComponent(e.attacker_mac)}`}
                            className="hover:text-accent text-slate-200">
                            {e.device_label || e.attacker_mac}
                            <span className="text-slate-500 ml-1">({e.attacker_ip})</span>
                          </Link>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums font-bold text-accent-red">
                        {e.attack_count ?? '-'}
                      </td>
                      <td className="px-3 py-1 text-slate-300 break-all">{e.message}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'red' | 'amber' }) {
  const cls = tone === 'red' ? 'text-accent-red' : tone === 'amber' ? 'text-accent-amber' : 'text-slate-100';
  return (
    <div className="card p-4 animate-fade-in">
      <div className="stat-label">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}
