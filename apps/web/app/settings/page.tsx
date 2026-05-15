import { loadConfig } from '@tenda/shared';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const cfg = loadConfig();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <div className="card p-5 space-y-3 animate-fade-in">
        <Row label="Router host" value={cfg.routerHost} />
        <Row label="Router password" value="•••••• (loaded from .env)" />
        <Row label="DB path" value={cfg.dbPath} />
        <Row label="Polling interval" value={`${cfg.pollIntervalMs} ms (${(cfg.pollIntervalMs / 1000).toFixed(0)} s)`} />
        <Row label="Web port" value={String(cfg.webPort)} />
        <Row label="IPC socket" value={cfg.ipcSocket} />
        <Row label="Log level" value={cfg.logLevel} />
      </div>
      <div className="card p-5 text-sm text-slate-400 animate-fade-in">
        <p>Configuration is loaded from <code className="text-slate-200 bg-bg-elevated px-1.5 py-0.5 rounded">.env</code> at the repository root. To change a setting, edit that file and restart the poller and web server.</p>
        <p className="mt-2">Retention: raw samples 48h, 5-min buckets 14d, hourly 90d, daily 2y, monthly forever.</p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-3 gap-3 text-sm">
      <div className="text-slate-400">{label}</div>
      <div className="col-span-2 text-slate-100 font-mono break-all">{value}</div>
    </div>
  );
}
