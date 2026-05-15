'use client';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { Eye, EyeOff, Shield, CheckCircle2, AlertCircle, Save, Loader, ShieldAlert } from 'lucide-react';

interface Settings {
  routerHost: string;
  pollIntervalMs: number;
  webPort: number;
  ipcSocket: string;
  dbPath: string;
  logLevel: string;
  daemon: { running: boolean };
}

export function SettingsClient() {
  const { data, mutate } = useSWR<Settings>('/api/settings', fetcher, { refreshInterval: 10000 });
  const [host, setHost] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState<null | 'test' | 'save'>(null);
  const [result, setResult] = useState<null | { kind: 'ok' | 'err'; msg: string }>(null);

  useEffect(() => {
    if (data?.routerHost && !host) setHost(data.routerHost);
  }, [data]);

  const callApi = async (action: 'test' | 'save') => {
    setBusy(action);
    setResult(null);
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, host: host.trim(), password }),
      });
      const j = await r.json();
      if (j.ok) {
        setResult({ kind: 'ok', msg: action === 'test' ? 'Connection successful' : 'Saved. Poller now using new credentials.' });
        if (action === 'save') {
          setPassword('');
          mutate();
        }
      } else {
        setResult({ kind: 'err', msg: j.error || 'Unknown error' });
      }
    } catch (e) {
      setResult({ kind: 'err', msg: String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Settings</h1>

      <div className="card p-5 animate-fade-in">
        <div className="flex items-center gap-2 mb-4">
          <Shield size={16} className="text-accent" />
          <h2 className="font-semibold">Router credentials</h2>
        </div>
        <p className="text-sm text-slate-400 mb-4">
          Changing these here updates <code className="bg-bg-elevated px-1.5 py-0.5 rounded text-xs">.env</code>
          and the poller switches to the new credentials immediately. The password is never persisted in plain text in the database — only in the local <code className="bg-bg-elevated px-1.5 py-0.5 rounded text-xs">.env</code> file on this host.
        </p>

        <div className="space-y-3 max-w-xl">
          <label className="block">
            <span className="text-xs text-slate-400">Router host or IP</span>
            <input type="text" value={host} onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.0.1"
              className="block w-full mt-1 bg-bg-elevated border border-bg-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-400">Router password</span>
            <div className="relative mt-1">
              <input type={showPwd ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="enter to change"
                className="block w-full bg-bg-elevated border border-bg-border rounded-md px-3 py-2 pr-10 text-sm font-mono focus:outline-none focus:border-accent" />
              <button type="button" onClick={() => setShowPwd((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1">Leave blank and just press "Save" to keep the current password while changing host only.</p>
          </label>

          {result && (
            <div className={`text-sm flex items-start gap-2 p-3 rounded ${
              result.kind === 'ok' ? 'bg-accent-green/10 text-accent-green border border-accent-green/30' : 'bg-accent-red/10 text-accent-red border border-accent-red/30'
            }`}>
              {result.kind === 'ok' ? <CheckCircle2 size={16} className="mt-0.5" /> : <AlertCircle size={16} className="mt-0.5" />}
              <span>{result.msg}</span>
            </div>
          )}

          <div className="flex items-center gap-2 pt-2 flex-wrap">
            <button onClick={() => callApi('test')} disabled={!host || !password || busy !== null}
              className="px-4 py-2 rounded bg-bg-elevated border border-bg-border text-sm hover:bg-bg-border disabled:opacity-50 flex items-center gap-2">
              {busy === 'test' ? <Loader size={14} className="animate-spin" /> : null}
              Test connection
            </button>
            <button onClick={() => callApi('save')} disabled={!host || !password || busy !== null}
              className="px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50 flex items-center gap-2">
              {busy === 'save' ? <Loader size={14} className="animate-spin" /> : <Save size={14} />}
              Save & switch
            </button>
          </div>
        </div>
      </div>

      <NsfwToggle />

      <div className="card p-5 space-y-2 animate-fade-in">
        <h2 className="font-semibold mb-2">System</h2>
        <Row label="Daemon running" value={data?.daemon?.running ? '✓ yes' : '✗ no'} ok={data?.daemon?.running} />
        <Row label="Polling interval" value={data ? `${data.pollIntervalMs} ms (${(data.pollIntervalMs / 1000).toFixed(0)} s)` : '...'} />
        <Row label="Web port" value={data ? String(data.webPort) : '...'} />
        <Row label="IPC socket" value={data?.ipcSocket ?? '...'} />
        <Row label="DB path" value={data?.dbPath ?? '...'} />
        <Row label="Log level" value={data?.logLevel ?? '...'} />
      </div>

      <div className="card p-5 text-sm text-slate-400 animate-fade-in">
        <p>To migrate this monitor to another machine, copy <code className="text-slate-200">.env</code>, <code className="text-slate-200">tenda.db</code>, and the source tree. Run <code className="text-slate-200">pnpm install &amp;&amp; pnpm build</code> and start the poller + web app. The router host/password is the only piece you'd typically need to change.</p>
      </div>
    </div>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-3 text-sm">
      <div className="text-slate-400">{label}</div>
      <div className={`col-span-2 font-mono break-all ${ok === true ? 'text-accent-green' : ok === false ? 'text-accent-red' : 'text-slate-100'}`}>{value}</div>
    </div>
  );
}

function NsfwToggle() {
  const { data, mutate } = useSWR<{ enabled: boolean; last_24h: { hits: number; devices: number } }>(
    '/api/nsfw', fetcher, { refreshInterval: 30000 },
  );
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (!data) return;
    setBusy(true);
    try {
      await fetch('/api/nsfw', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !data.enabled }),
      });
      mutate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlert size={16} className="text-accent-red" />
        <h2 className="font-semibold">Adult-content detection</h2>
      </div>
      <p className="text-sm text-slate-400 mb-4">
        Scans router syslog for visits to known adult / webcam / hentai / dating domains and surfaces a banner on the dashboard.
        Built-in list covers ~250 hosts; runs entirely on this machine.
      </p>
      <div className="flex items-center justify-between gap-4 p-3 rounded-md bg-bg-elevated/40 border border-bg-border">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {data?.enabled ? 'Enabled' : 'Disabled'}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {data
              ? data.last_24h.hits > 0
                ? `Last 24h: ${data.last_24h.hits} hits across ${data.last_24h.devices} device${data.last_24h.devices === 1 ? '' : 's'}`
                : 'No hits detected in the last 24 hours.'
              : 'Loading…'}
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={!data || busy}
          aria-pressed={data?.enabled}
          className={`relative w-12 h-6 rounded-full transition shrink-0 ${
            data?.enabled ? 'bg-accent-red' : 'bg-bg-border'
          } disabled:opacity-50`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            data?.enabled ? 'translate-x-6' : 'translate-x-0.5'
          }`} />
        </button>
      </div>
    </div>
  );
}
