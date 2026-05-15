'use client';
import { Download, FileJson, FileSpreadsheet } from 'lucide-react';

const EXPORTS = [
  { kind: 'consumption', label: 'Consumption per device', desc: 'Each device with today/week/month/year/all-time totals' },
  { kind: 'daily', label: 'Daily report (30 days)', desc: 'Per-device daily breakdown for the last 30 days' },
  { kind: 'attacks', label: 'Attack log', desc: 'All ARP/DDoS detections from the router' },
  { kind: 'syslog', label: 'Syslog (UDP)', desc: 'Audit logs received from the router via syslog' },
  { kind: 'outages', label: 'Outages history', desc: 'Router unreachable + reboot events' },
];

export default function ExportPage() {
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold flex items-center gap-2">
        <Download size={20} className="text-accent" /> Export data
      </h1>
      <div className="text-sm text-slate-400">
        Download the monitor's data for analysis in Excel/Google Sheets (CSV) or processing with code (JSON).
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {EXPORTS.map((e) => (
          <div key={e.kind} className="card p-5 animate-fade-in">
            <div className="font-semibold">{e.label}</div>
            <div className="text-xs text-slate-400 mt-1">{e.desc}</div>
            <div className="mt-3 flex gap-2">
              <a href={`/api/export?kind=${e.kind}&format=csv`} download
                className="text-xs px-3 py-1.5 rounded bg-accent-green/10 border border-accent-green/30 text-accent-green hover:bg-accent-green/20 flex items-center gap-1.5">
                <FileSpreadsheet size={14} /> CSV
              </a>
              <a href={`/api/export?kind=${e.kind}&format=json`} download
                className="text-xs px-3 py-1.5 rounded bg-accent/10 border border-accent/30 text-accent hover:bg-accent/20 flex items-center gap-1.5">
                <FileJson size={14} /> JSON
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
