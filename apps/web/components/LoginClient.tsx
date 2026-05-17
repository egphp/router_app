'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader, Lock } from 'lucide-react';

export function LoginClient() {
  const search = useSearchParams();
  const next = safeNext(search.get('next'));
  const [csrf, setCsrf] = useState('');
  const [configured, setConfigured] = useState(true);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/csrf', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setCsrf(typeof data.token === 'string' ? data.token : '');
        setConfigured(Boolean(data.configured));
      })
      .catch(() => {
        if (!cancelled) setMessage({ kind: 'err', text: 'Could not start secure login.' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!csrf || !password || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, csrf, next }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setMessage({ kind: 'ok', text: 'Login accepted.' });
        window.location.href = safeNext(data.next);
        return;
      }
      setMessage({ kind: 'err', text: data.error || 'Login failed.' });
    } catch {
      setMessage({ kind: 'err', text: 'Login request failed.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10">
      <form onSubmit={submit} className="card w-full max-w-sm p-5 sm:p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent/15 flex items-center justify-center">
            <Lock size={20} className="text-accent" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Tenda Monitor Login</h1>
            <p className="text-xs text-slate-400 mt-0.5">Protected dashboard access</p>
          </div>
        </div>

        {!configured && (
          <div className="text-sm flex gap-2 p-3 rounded-md bg-accent-red/10 text-accent-red border border-accent-red/30">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>Remote password is not configured on this client yet. Set it from LAN first.</span>
          </div>
        )}

        <label className="block">
          <span className="text-xs text-slate-400">Remote password</span>
          <div className="relative mt-1">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="block w-full bg-bg-elevated border border-bg-border rounded-md px-3 py-2.5 pr-10 text-sm font-mono focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 p-1"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>

        {message && (
          <div className={`text-sm flex gap-2 p-3 rounded-md ${
            message.kind === 'ok'
              ? 'bg-accent-green/10 text-accent-green border border-accent-green/30'
              : 'bg-accent-red/10 text-accent-red border border-accent-red/30'
          }`}>
            {message.kind === 'ok' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
            <span>{message.text}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={!configured || !csrf || !password || busy}
          className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {busy ? <Loader size={15} className="animate-spin" /> : <Lock size={15} />}
          Login
        </button>
      </form>
    </main>
  );
}

function safeNext(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
