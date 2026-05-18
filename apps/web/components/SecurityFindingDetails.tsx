'use client';
import Link from 'next/link';
import { categoryIcon, formatMacShort, timeAgo } from '../lib/format';

export interface AffectedDevice {
  mac: string;
  ip: string | null;
  hostname?: string | null;
  router_remark?: string | null;
  vendor?: string | null;
  category?: string | null;
}

function deviceLabel(d: AffectedDevice): string {
  return d.router_remark || d.hostname || d.mac;
}

/**
 * Renders a compact list of devices associated with a security finding.
 * Reused by /security and /alerts so the user can see exactly which MACs
 * triggered a rule and jump to each device's detail page.
 */
export function AffectedDeviceList({
  devices,
  emptyHint,
}: {
  devices: AffectedDevice[];
  emptyHint?: string;
}) {
  if (!devices.length) {
    return <div className="text-xs text-slate-500 italic">{emptyHint ?? 'No devices.'}</div>;
  }
  return (
    <div className="mt-2 divide-y divide-bg-border rounded-md border border-bg-border bg-bg-elevated/40 overflow-hidden">
      {devices.map((d) => (
        <Link
          key={d.mac}
          href={`/devices/${encodeURIComponent(d.mac)}`}
          className="flex items-center gap-3 px-3 py-2 text-xs hover:bg-bg-elevated transition"
        >
          <span className="text-lg shrink-0">{categoryIcon(d.category ?? null)}</span>
          <div className="flex-1 min-w-0">
            <div className="truncate text-slate-100 font-medium">{deviceLabel(d)}</div>
            <div className="text-[10px] text-slate-500 font-mono">
              {formatMacShort(d.mac)} · {d.ip || 'no IP'} · {d.vendor || 'unknown vendor'}
            </div>
          </div>
          <span className="text-[10px] text-slate-500 shrink-0">view →</span>
        </Link>
      ))}
    </div>
  );
}

export interface IpHistoryEntry {
  ip: string;
  samples: number;
  first_seen: number;
  last_seen: number;
}

/**
 * Lists every distinct IP a device has been observed on, with sample counts
 * and first/last seen timestamps. Reused inside DeviceDetailClient.
 */
export function IpHistoryList({ history }: { history: IpHistoryEntry[] }) {
  if (!history.length) {
    return <div className="text-xs text-slate-500 italic">No IP history yet.</div>;
  }
  return (
    <div className="rounded-md border border-bg-border bg-bg-elevated/40 overflow-hidden">
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wide text-slate-500 bg-bg-elevated/60">
          <tr>
            <th className="text-left px-3 py-2">IP</th>
            <th className="text-right px-3 py-2">Samples</th>
            <th className="text-right px-3 py-2">First seen</th>
            <th className="text-right px-3 py-2">Last seen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-bg-border">
          {history.map((e) => (
            <tr key={e.ip}>
              <td className="px-3 py-2 font-mono text-slate-100">{e.ip}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-300">{e.samples}</td>
              <td className="px-3 py-2 text-right text-slate-400">{timeAgo(e.first_seen)}</td>
              <td className="px-3 py-2 text-right text-slate-400">{timeAgo(e.last_seen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
