'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from '@simplewebauthn/browser';
import {
  AlertCircle,
  CheckCircle2,
  Fingerprint,
  Loader,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from 'lucide-react';

interface PasskeyStatusResponse {
  ok: boolean;
  mode?: 'shared' | 'local_vault';
  token: string;
  rpID: string;
  hostWithPort?: string;
  origin: string;
  isSecureOrigin: boolean;
  isWebAuthnDomain: boolean;
  isLocalOrLan: boolean;
  authenticated: boolean;
  domainPasskeyCount: number;
  totalPasskeyCount: number;
  firstTimeSetup: boolean;
  canRegister?: boolean;
  canLogin?: boolean;
  sharedPasskeyReady?: boolean;
  enrollPreview?: {
    valid: boolean;
    labelHint?: string | null;
    expiresAt?: number;
  } | null;
}

export function LoginClient() {
  const search = useSearchParams();
  const next = safeNext(search.get('next'));
  const reason = search.get('reason');
  const initialEnrollFromUrl = search.get('enroll') ?? '';

  const [status, setStatus] = useState<PasskeyStatusResponse | null>(null);
  const [csrf, setCsrf] = useState('');
  const [enrollToken, setEnrollToken] = useState(initialEnrollFromUrl);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [clientHost, setClientHost] = useState('');
  const [webAuthnSupported, setWebAuthnSupported] = useState(true);
  const [busy, setBusy] = useState<null | 'login' | 'register'>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(
    reason === 'no_biometric'
      ? { kind: 'err', text: 'تم تسجيل الخروج تلقائياً لأن هذا المتصفح لا يدعم WebAuthn.' }
      : null,
  );

  useEffect(() => {
    let cancelled = false;

    if (typeof window !== 'undefined') {
      setClientHost(window.location.host);
    }

    // No platform-sensor gate: a browser without Touch ID / Face ID signs in or registers through the phone (QR / hybrid).
    setWebAuthnSupported(browserSupportsWebAuthn());

    if (initialEnrollFromUrl && typeof window !== 'undefined') {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('enroll');
      window.history.replaceState({}, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    }

    const qs = initialEnrollFromUrl ? `?enroll=${encodeURIComponent(initialEnrollFromUrl)}` : '';
    fetch(`/api/auth/passkey/status${qs}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: PasskeyStatusResponse) => {
        if (cancelled) return;
        if (data.authenticated && !initialEnrollFromUrl) {
          window.location.replace(next);
          return;
        }
        setStatus(data);
        setCsrf(typeof data.token === 'string' ? data.token : '');
        if (data.enrollPreview?.labelHint) {
          setDeviceLabel(data.enrollPreview.labelHint);
        }
        if (initialEnrollFromUrl && data.enrollPreview && !data.enrollPreview.valid) {
          setMessage({
            kind: 'err',
            text: 'رابط التفعيل منتهي الصلاحية أو تم استخدامه مسبقاً.',
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMessage({ kind: 'err', text: 'تعذّر الاتصال بخدمة التحقق البيومتري.' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [initialEnrollFromUrl, next]);

  const handleBiometricLogin = async () => {
    if (!csrf || busy) return;
    setBusy('login');
    setMessage(null);
    try {
      const optRes = await fetch('/api/auth/passkey/login/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrf }),
      });
      const optJson = await optRes.json();
      if (!optRes.ok || !optJson.ok) {
        setMessage({ kind: 'err', text: optJson.message || optJson.error || 'تعذّر بدء التحقق بالبصمة.' });
        return;
      }

      const assertion = await startAuthentication({ optionsJSON: optJson.options });

      const verRes = await fetch('/api/auth/passkey/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: assertion, next }),
      });
      const verJson = await verRes.json();
      if (verRes.ok && verJson.ok) {
        setMessage({ kind: 'ok', text: `تم التحقق من البصمة بنجاح (${verJson.label || 'Passkey'}). جاري الدخول...` });
        window.location.replace(safeNext(verJson.next));
        return;
      }
      setMessage({ kind: 'err', text: verJson.message || verJson.error || 'فشل التحقق من البصمة.' });
    } catch (err) {
      setMessage({ kind: 'err', text: friendlyWebAuthnError(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleBiometricEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !csrf || !status) return;

    const isFirstTime = status.mode === 'local_vault' && status.firstTimeSetup;
    const hasValidOneTimeLink = Boolean(status.mode === 'local_vault' && status.enrollPreview?.valid && enrollToken.trim());

    if (!isFirstTime && !hasValidOneTimeLink) {
      setMessage({ kind: 'err', text: 'تسجيل البصمات مغلق من الخارج — الإضافة متاحة من داخل الإعدادات فقط.' });
      return;
    }

    setBusy('register');
    setMessage(null);
    try {
      const optRes = await fetch('/api/auth/passkey/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csrf,
          enrollToken: isFirstTime ? undefined : enrollToken.trim(),
          label: deviceLabel.trim() || undefined,
        }),
      });
      const optJson = await optRes.json();
      if (!optRes.ok || !optJson.ok) {
        setMessage({ kind: 'err', text: optJson.message || optJson.error || 'تعذّر بدء تسجيل البصمة.' });
        return;
      }

      const attestation = await startRegistration({ optionsJSON: optJson.options });

      const verRes = await fetch('/api/auth/passkey/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response: attestation,
          label: deviceLabel.trim() || undefined,
          next,
        }),
      });
      const verJson = await verRes.json();
      if (verRes.ok && verJson.ok) {
        setEnrollToken('');
        setMessage({
          kind: 'ok',
          text: `تم تسجيل بصمتك بنجاح (${verJson.label}) وقفل التسجيل الخارجي. جاري فتح اللوحة...`,
        });
        window.location.replace(safeNext(verJson.next));
        return;
      }
      setMessage({ kind: 'err', text: verJson.message || verJson.error || 'فشل التحقق من تسجيل البصمة.' });
    } catch (err) {
      setMessage({ kind: 'err', text: friendlyWebAuthnError(err) });
    } finally {
      setBusy(null);
    }
  };

  const isLocalVault = status?.mode === 'local_vault';
  const isFirstTimeBootstrap = Boolean(isLocalVault && status?.firstTimeSetup);
  const isAuthorizedOneTimeLink = Boolean(isLocalVault && status?.enrollPreview?.valid && enrollToken);
  const showRegistrationForm = isFirstTimeBootstrap || isAuthorizedOneTimeLink;
  const displayHost = clientHost || status?.hostWithPort || status?.rpID || '';

  return (
    <main className="min-h-[85vh] flex items-center justify-center px-4 py-10">
      <div className="card w-full max-w-md p-6 sm:p-7 space-y-5 border border-bg-border">
        {/* Header */}
        <div className="flex items-start gap-3.5">
          <img
            src="/icon-64.png"
            alt="Tenda Vault"
            width={48}
            height={48}
            className="w-12 h-12 rounded-2xl shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg sm:text-xl font-semibold">Tenda Biometric Vault</h1>
              <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent-green/15 text-accent-green border border-accent-green/30 font-semibold">
                {isFirstTimeBootstrap ? 'First-Time Setup' : 'Biometric Only'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              {isFirstTimeBootstrap
                ? 'مرحباً بك لأول مرة — سجّل بصمتك الخاصة الآن لتفعيل الحماية المشفّرة لهذه اللوحة.'
                : 'الدخول محمي حصرياً بالبصمة المشفّرة للعتاد (Touch ID / Face ID) بدون اسم مستخدم أو كلمة مرور.'}
            </p>
          </div>
        </div>

        {/* Origin / Domain Binding Pill */}
        {status && (
          <div className="flex items-center justify-between gap-2 text-xs rounded-lg bg-bg-elevated/60 border border-bg-border px-3 py-2">
            <span className="text-slate-400 flex items-center gap-1.5">
              <ShieldCheck size={14} className="text-accent-green shrink-0" />
              اللوحة المحمية
            </span>
            <code className="font-mono text-slate-200 truncate" dir="ltr">
              {displayHost}
            </code>
          </div>
        )}

        {/* Insecure Origin Warning */}
        {status && !status.isSecureOrigin && (
          <div className="text-xs space-y-2 p-3.5 rounded-lg bg-amber-500/10 text-amber-200 border border-amber-400/30">
            <div className="flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-300" />
              <div>
                {status.mode === 'shared' ? (
                  <>
                    البصمة المشتركة تعمل فقط من الرابط <code>https://tv-eg.com</code>. افتح اللوحة من هذا الرابط.
                  </>
                ) : (
                  <>
                    معيار البصمة المشفّرة <strong>WebAuthn</strong> يتطلب اتصالاً مشفّراً <code>https://</code> أو{' '}
                    <code>http://localhost</code>.
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Unsupported Browser Notice */}
        {!webAuthnSupported && (
          <div className="text-xs flex items-start gap-2 p-3.5 rounded-lg bg-accent-red/10 text-accent-red border border-accent-red/30">
            <ShieldOff size={16} className="mt-0.5 shrink-0" />
            <span>
              هذا المتصفح لا يدعم WebAuthn Passkeys. افتح اللوحة عبر Safari أو Chrome الحديث.
            </span>
          </div>
        )}

        {/* Status / Feedback Message */}
        {message && (
          <div
            className={`text-xs sm:text-sm flex items-start gap-2.5 p-3.5 rounded-lg border leading-relaxed ${
              message.kind === 'ok'
                ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
                : message.kind === 'warn'
                  ? 'bg-amber-500/10 text-amber-200 border-amber-400/30'
                  : 'bg-accent-red/10 text-accent-red border border-accent-red/30'
            }`}
          >
            {message.kind === 'ok' ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            ) : (
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
            )}
            <span>{message.text}</span>
          </div>
        )}

        {/* Loading skeleton before status resolves */}
        {!status && !message && (
          <div className="py-6 flex items-center justify-center gap-2 text-xs text-slate-400">
            <Loader size={16} className="animate-spin text-accent" />
            <span>جاري فحص حالة الحماية البيومترية...</span>
          </div>
        )}

        {/* Shared-mode missing file error (only on owner shared panel) */}
        {status && status.mode === 'shared' && status.canLogin === false && (
          <div className="text-xs flex items-start gap-2 p-3.5 rounded-lg bg-accent-red/10 text-accent-red border border-accent-red/30">
            <ShieldOff size={16} className="mt-0.5 shrink-0" />
            <span>ملف البصمة المشتركة غير موجود أو غير مقروء على هذا الجهاز — الدخول متوقف لحين إعادته.</span>
          </div>
        )}

        {/* FIRST-TIME REGISTRATION OR ONE-TIME PAIRING LINK (Standalone Local Vault Only) */}
        {status && showRegistrationForm && (
          <form onSubmit={handleBiometricEnroll} className="space-y-3.5 pt-2 border-t border-bg-border/70">
            <div className="flex items-start gap-2 text-xs font-medium text-slate-200 bg-accent/10 border border-accent/25 rounded-lg p-3 leading-relaxed">
              <Smartphone size={16} className="text-accent mt-0.5 shrink-0" />
              <span>
                {isFirstTimeBootstrap
                  ? 'التسجيل الأول للبصمة: لا توجد أي بصمة مسجّلة على هذه اللوحة بعد. سجّل بصمتك الخاصة الآن (من هذا الجهاز أو عبر QR بهاتفك) وسيُقفل التسجيل الخارجي تلقائياً فور التفعيل.'
                  : 'رابط التفعيل صالح لمرة واحدة — اضغط لتسجيل بصمة هذا الجهاز الآن.'}
              </span>
            </div>

            <label className="block" htmlFor="biometric-device-label">
              <span className="text-xs text-slate-400">اسم الجهاز (اختياري)</span>
              <input
                id="biometric-device-label"
                name="deviceLabel"
                type="text"
                value={deviceLabel}
                onChange={(e) => setDeviceLabel(e.target.value)}
                placeholder="مثال: iPhone Face ID أو هاتفي الشخصي"
                maxLength={64}
                className="mt-1 block w-full bg-bg-elevated border border-bg-border rounded-md px-3 py-2 text-xs focus:outline-none focus:border-accent"
              />
            </label>

            <button
              type="submit"
              disabled={!webAuthnSupported || !status.isSecureOrigin || !csrf || busy !== null}
              className="btn-primary w-full py-3.5 text-sm font-semibold flex items-center justify-center gap-2.5 disabled:opacity-50"
            >
              {busy === 'register' ? <Loader size={18} className="animate-spin" /> : <Fingerprint size={20} />}
              {isFirstTimeBootstrap ? 'تسجيل البصمة الأولى والدخول الآن' : 'تأكيد تسجيل البصمة والدخول'}
            </button>
          </form>
        )}

        {/* LOGIN MODE */}
        {status && !showRegistrationForm && (
          <div className="space-y-3 pt-1">
            <button
              type="button"
              onClick={handleBiometricLogin}
              disabled={!webAuthnSupported || !status.isSecureOrigin || status.canLogin === false || !csrf || busy !== null}
              className="btn-primary w-full py-3.5 text-sm font-semibold flex items-center justify-center gap-2.5 disabled:opacity-50"
            >
              {busy === 'login' ? <Loader size={18} className="animate-spin" /> : <Fingerprint size={20} />}
              الدخول بالبصمة (Touch ID / Face ID)
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

function friendlyWebAuthnError(err: unknown): string {
  if (err instanceof WebAuthnError) {
    if (err.code === 'ERROR_CEREMONY_ABORTED' || err.name === 'NotAllowedError') {
      return 'تم إلغاء نافذة البصمة أو لم يتم العثور على البصمة المعتمدة. استخدم تليفونك (QR) لو المتصفح ده مفيهوش البصمة.';
    }
    if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
      return 'هذه البصمة مسجّلة بالفعل — اضغط «الدخول بالبصمة» مباشرة.';
    }
  }
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError') {
      return 'تم إلغاء التحقق من البصمة أو أن هذا المتصفح لا يحمل البصمة المعتمدة.';
    }
    if (err.name === 'SecurityError') {
      return 'رفض المتصفح العملية لأن الصفحة ليست عبر اتصال HTTPS مشفّر.';
    }
    return err.message;
  }
  return 'حدث خطأ غير متوقع أثناء التحقق البيومتري.';
}

function safeNext(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (value === '/login' || value.startsWith('/login?')) return '/';
  return value;
}
