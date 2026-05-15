'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Eye, EyeOff, CheckCircle2, AlertCircle, Loader, Router, Lock, Server } from 'lucide-react';

export function SetupClient({ alreadyConfigured }: { alreadyConfigured: boolean }) {
  const router = useRouter();
  const [host, setHost] = useState('192.168.0.1');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState<null | 'test' | 'save'>(null);
  const [result, setResult] = useState<null | { kind: 'ok' | 'err'; msg: string }>(null);

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
        if (action === 'test') {
          setResult({ kind: 'ok', msg: '✓ Router reachable. Credentials valid.' });
        } else {
          setResult({ kind: 'ok', msg: 'Saved! Starting monitor…' });
          setTimeout(() => {
            window.location.href = '/';
          }, 1200);
        }
      } else {
        setResult({ kind: 'err', msg: j.error || 'Unknown error' });
      }
    } catch (e) {
      setResult({ kind: 'err', msg: 'Could not reach the monitor daemon. Is it running?' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-full max-w-md">
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-accent/15 mb-3">
          <Activity size={28} className="text-accent" />
        </div>
        <h1 className="text-2xl font-bold">Welcome to Tenda Monitor</h1>
        <p className="text-sm text-slate-400 mt-1">
          {alreadyConfigured
            ? 'Update your router credentials below.'
            : 'Enter your router credentials to start monitoring traffic.'}
        </p>
      </div>

      <div className="card p-5 sm:p-6 space-y-4">
        <label className="block">
          <span className="text-xs text-slate-400 flex items-center gap-1.5 mb-1.5">
            <Router size={12} /> Router IP or hostname
          </span>
          <input
            type="text" value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.0.1"
            autoComplete="off"
            className="block w-full bg-bg-elevated border border-bg-border rounded-md px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
          />
        </label>

        <label className="block">
          <span className="text-xs text-slate-400 flex items-center gap-1.5 mb-1.5">
            <Lock size={12} /> Router admin password
          </span>
          <div className="relative">
            <input
              type={showPwd ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter router password"
              autoComplete="off"
              className="block w-full bg-bg-elevated border border-bg-border rounded-md px-3 py-2.5 pr-10 text-sm font-mono focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
            />
            <button
              type="button"
              onClick={() => setShowPwd((s) => !s)}
              aria-label={showPwd ? 'Hide password' : 'Show password'}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 p-1"
            >
              {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mt-1.5">
            Stored only on this machine in <code className="bg-bg-elevated px-1 rounded">.env</code> — never sent anywhere.
          </p>
        </label>

        {result && (
          <div
            className={`text-sm flex items-start gap-2 p-3 rounded-md ${
              result.kind === 'ok'
                ? 'bg-accent-green/10 text-accent-green border border-accent-green/30'
                : 'bg-accent-red/10 text-accent-red border border-accent-red/30'
            }`}
          >
            {result.kind === 'ok' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
            <span>{result.msg}</span>
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row gap-2 pt-1">
          <button
            onClick={() => callApi('test')}
            disabled={!host || !password || busy !== null}
            className="px-4 py-2.5 rounded-md bg-bg-elevated border border-bg-border text-sm hover:bg-bg-border disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy === 'test' ? <Loader size={14} className="animate-spin" /> : <Server size={14} />}
            Test connection
          </button>
          <button
            onClick={() => callApi('save')}
            disabled={!host || !password || busy !== null}
            className="px-4 py-2.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50 flex items-center justify-center gap-2 flex-1"
          >
            {busy === 'save' ? <Loader size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            Save & start monitoring
          </button>
        </div>
      </div>

      <div className="text-center text-xs text-slate-500 mt-4 space-y-1">
        <p>Compatible with Tenda W30E v2.0 routers.</p>
        <p>The monitor daemon stores all data locally on this machine.</p>
      </div>
    </div>
  );
}
