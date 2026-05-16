'use client';

import { useEffect, useRef } from 'react';

interface VersionInfo {
  local?: string;
}

const RELOAD_MARK_KEY = 'tenda.updateReloadAt';
const RELOAD_COOLDOWN_MS = 30_000;

export function AutoReloadOnUpdate() {
  const initialLocal = useRef<string | null>(null);
  const reloading = useRef(false);

  useEffect(() => {
    let stopped = false;

    const reloadOnce = () => {
      if (reloading.current) return;
      const now = Date.now();
      const lastReload = readLastReloadAt();
      if (now - lastReload < RELOAD_COOLDOWN_MS) return;
      reloading.current = true;
      try { window.sessionStorage.setItem(RELOAD_MARK_KEY, String(now)); } catch {}
      window.location.reload();
    };

    const checkVersion = async () => {
      try {
        const res = await fetch('/api/version?reload-check=1', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as VersionInfo;
        if (!data.local) return;
        if (initialLocal.current === null) {
          initialLocal.current = data.local;
          return;
        }
        if (data.local !== initialLocal.current) reloadOnce();
      } catch {
        // The updater may be restarting the app right now. The next tick retries.
      }
    };

    const onError = (event: ErrorEvent) => {
      const message = `${event.message ?? ''} ${event.error?.name ?? ''} ${event.error?.message ?? ''}`;
      if (isChunkMismatchError(message)) reloadOnce();
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = typeof reason === 'string'
        ? reason
        : `${reason?.name ?? ''} ${reason?.message ?? ''}`;
      if (isChunkMismatchError(message)) reloadOnce();
    };

    const onVisibleOrFocused = () => {
      if (document.visibilityState === 'visible') void checkVersion();
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('focus', onVisibleOrFocused);
    document.addEventListener('visibilitychange', onVisibleOrFocused);

    void checkVersion();
    const timer = window.setInterval(() => {
      if (!stopped) void checkVersion();
    }, 15_000);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.removeEventListener('focus', onVisibleOrFocused);
      document.removeEventListener('visibilitychange', onVisibleOrFocused);
    };
  }, []);

  return null;
}

function isChunkMismatchError(message: string): boolean {
  return /ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch dynamically|CSS_CHUNK_LOAD_FAILED/i.test(message);
}

function readLastReloadAt(): number {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_MARK_KEY);
    const parsed = Number(raw ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}
