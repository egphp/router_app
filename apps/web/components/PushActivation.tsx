'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Bell, CheckCircle2, Share, X } from 'lucide-react';

type BannerMode = 'install' | 'enable';
type Notice = {
  text: string;
  tone: 'success' | 'error';
  autoDismissMs?: number;
};
type EnsurePushResult = { ok: true; refreshed: boolean } | { ok: false };

const SUBSCRIBED_KEY = 'tenda_push_subscribed';
const DISMISSED_ENABLE_KEY = 'tenda_push_dismissed_enable';
const DISMISSED_INSTALL_KEY = 'tenda_push_dismissed_install';
const VAPID_KEY_STORAGE = 'tenda_push_vapid_key';
const PUSH_REFRESH_WINDOW_MS = 30 * 24 * 3600 * 1000;

export function PushActivation() {
  const [mode, setMode] = useState<BannerMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      const canUseServiceWorker = 'serviceWorker' in navigator;
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const hasPushSupport = canUseServiceWorker && 'PushManager' in window && 'Notification' in window;

      if (canUseServiceWorker) {
        try {
          const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
          void registration.update();
        } catch {
          // Registration is retried the next time the page opens.
        }
      }

      if (cancelled) return;

      if (hasPushSupport) {
        if (Notification.permission === 'granted') {
          const result = await ensurePushSubscription();
          if (!cancelled && !result.ok) {
            localStorage.removeItem(SUBSCRIBED_KEY);
            localStorage.removeItem(DISMISSED_ENABLE_KEY);
            setNotice({ text: 'اشتراك التنبيهات محتاج إعادة تفعيل.', tone: 'error' });
            setMode('enable');
          } else if (!cancelled && result.ok && result.refreshed) {
            setNotice({ text: 'تم تحديث اشتراك التنبيهات.', tone: 'success', autoDismissMs: 2800 });
          }
          return;
        }
        if (Notification.permission === 'denied') return;
        if (localStorage.getItem(SUBSCRIBED_KEY) || localStorage.getItem(DISMISSED_ENABLE_KEY)) return;
        window.setTimeout(() => {
          if (!cancelled) setMode('enable');
        }, 1200);
        return;
      }

      if (isIOS && !isStandalone && !localStorage.getItem(DISMISSED_INSTALL_KEY)) {
        window.setTimeout(() => {
          if (!cancelled) setMode('install');
        }, 1200);
      }
    };

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!notice?.autoDismissMs) return;
    const timeout = window.setTimeout(() => setNotice(null), notice.autoDismissMs);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const dismiss = () => {
    if (mode === 'enable') localStorage.setItem(DISMISSED_ENABLE_KEY, '1');
    if (mode === 'install') localStorage.setItem(DISMISSED_INSTALL_KEY, '1');
    setMode(null);
  };

  const enable = async () => {
    if (!('Notification' in window)) return;
    setBusy(true);
    setNotice(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        localStorage.setItem(DISMISSED_ENABLE_KEY, '1');
        setNotice({ text: 'تم رفض التنبيهات من المتصفح.', tone: 'error' });
        setMode(null);
        return;
      }
      const result = await ensurePushSubscription();
      if (result.ok) {
        localStorage.setItem(SUBSCRIBED_KEY, '1');
        setNotice({
          text: result.refreshed ? 'تم تحديث اشتراك التنبيهات.' : 'تم تفعيل تنبيهات الأجهزة الجديدة.',
          tone: 'success',
          autoDismissMs: 2800,
        });
        setMode(null);
      } else {
        setNotice({ text: 'تعذر حفظ اشتراك التنبيهات.', tone: 'error' });
      }
    } finally {
      setBusy(false);
    }
  };

  if (!mode && !notice) return null;

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 sm:left-auto sm:right-5 sm:w-[420px]">
      {notice ? (
        <div className={`rounded-lg border bg-bg-card shadow-lg p-3 flex items-center gap-2 text-sm ${
          notice.tone === 'success'
            ? 'border-accent-green/30 text-accent-green'
            : 'border-accent-red/30 text-accent-red'
        }`}>
          {notice.tone === 'success' ? <CheckCircle2 size={16} className="shrink-0" /> : <AlertCircle size={16} className="shrink-0" />}
          <span className="flex-1">{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="p-1 text-slate-400 hover:text-slate-100">
            <X size={16} />
          </button>
        </div>
      ) : null}

      {mode ? (
        <div className="mt-2 rounded-lg border border-bg-border bg-bg-card shadow-lg p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-accent/15 flex items-center justify-center shrink-0">
              {mode === 'install' ? <Share size={18} className="text-accent" /> : <Bell size={18} className="text-accent" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm">
                {mode === 'install' ? 'ضيف لوحة Tenda على الشاشة الرئيسية' : 'تفعيل تنبيهات الأجهزة الجديدة'}
              </div>
              <div className="text-xs leading-5 text-slate-400 mt-1">
                {mode === 'install'
                  ? 'على iPhone افتح اللوحة من Safari، اضغط زر المشاركة، ثم إضافة إلى الشاشة الرئيسية لتفعيل تنبيهات الويب.'
                  : 'هنبعت تنبيه فقط عند دخول جهاز جديد، ومعاه الاسم والـ IP والـ MAC.'}
              </div>
            </div>
            <button type="button" aria-label="Dismiss" onClick={dismiss} className="p-1 text-slate-500 hover:text-slate-200 shrink-0">
              <X size={16} />
            </button>
          </div>
          <div className="flex items-center justify-end gap-2 mt-3">
            <button type="button" onClick={dismiss} className="btn-ghost">
              لاحقاً
            </button>
            {mode === 'enable' ? (
              <button type="button" onClick={enable} disabled={busy} className="btn-primary disabled:opacity-50">
                {busy ? 'جار التفعيل...' : 'تفعيل'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

async function ensurePushSubscription(): Promise<EnsurePushResult> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { ok: false };
  try {
    const registration = await navigator.serviceWorker.ready;
    const keyResponse = await fetch('/api/push/vapid-key', { cache: 'no-store', credentials: 'include' });
    if (!keyResponse.ok) return { ok: false };
    const keyData = await keyResponse.json();
    const publicKey = typeof keyData.publicKey === 'string' ? keyData.publicKey : '';
    if (!publicKey) return { ok: false };

    let subscription = await registration.pushManager.getSubscription();
    let refreshed = false;
    if (subscription && shouldRefreshLocally(subscription, publicKey)) {
      await retireSubscription(subscription);
      subscription = null;
      refreshed = true;
    }

    if (subscription && await shouldRefreshFromServer(subscription)) {
      await retireSubscription(subscription);
      subscription = null;
      refreshed = true;
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(publicKey),
      });
      refreshed = true;
    }

    localStorage.setItem(VAPID_KEY_STORAGE, publicKey);
    const body = subscription.toJSON() as Record<string, unknown>;
    body.client_platform = navigator.platform || '';
    const saveResponse = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (saveResponse.ok) {
      localStorage.setItem(SUBSCRIBED_KEY, '1');
      return { ok: true, refreshed };
    }
    localStorage.removeItem(SUBSCRIBED_KEY);
    return { ok: false };
  } catch {
    localStorage.removeItem(SUBSCRIBED_KEY);
    return { ok: false };
  }
}

function shouldRefreshLocally(subscription: PushSubscription, publicKey: string): boolean {
  const savedKey = localStorage.getItem(VAPID_KEY_STORAGE);
  if (savedKey && savedKey !== publicKey) return true;
  return Boolean(subscription.expirationTime && subscription.expirationTime - Date.now() < PUSH_REFRESH_WINDOW_MS);
}

async function shouldRefreshFromServer(subscription: PushSubscription): Promise<boolean> {
  try {
    const response = await fetch('/api/push/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      cache: 'no-store',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    if (!response.ok) return false;
    const body = await response.json() as { needsRefresh?: unknown };
    return body.needsRefresh === true;
  } catch {
    return false;
  }
}

async function retireSubscription(subscription: PushSubscription): Promise<void> {
  const endpoint = subscription.endpoint;
  try {
    await subscription.unsubscribe();
  } catch {
    // The browser may have already dropped the push subscription.
  }
  try {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Server-side expiry is best effort; a fresh subscription will be saved below.
  }
}

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray.buffer.slice(outputArray.byteOffset, outputArray.byteOffset + outputArray.byteLength);
}
