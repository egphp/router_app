'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  KeyRound,
  Loader,
  ShieldCheck,
  Smartphone,
  Unlink,
} from 'lucide-react';
import { fetcher } from '../lib/fetcher';

interface IosDeviceStatus {
  ok: boolean;
  state: 'unbound' | 'active' | 'released' | 'reset';
  bound: boolean;
  deviceId: string;
  boundAt: number;
  lastSeenAt: number;
  attested: boolean;
  sessionActive: boolean;
  pairing: {
    open: boolean;
    expiresAt: number;
  };
}

function formatCode(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  return `${digits.slice(0, 4)} ${digits.slice(4)}`;
}

function formatDateTime(ts: number): string {
  if (!ts || ts <= 0) return '—';
  try {
    return new Date(ts).toLocaleString('ar-EG', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  }
}

function formatCountdown(msRemaining: number): string {
  const totalSec = Math.max(0, Math.ceil(msRemaining / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function IosPairingCard() {
  const { data, mutate } = useSWR<IosDeviceStatus>('/api/native/v2/device-status', fetcher, {
    refreshInterval: 8000,
  });

  const [issued, setIssued] = useState<{
    code: string;
    expiresAt: number;
    replacing: boolean;
    previousBoundAt: number;
    previousDeviceId: string;
  } | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState<null | 'open' | 'reset'>(null);
  const [feedback, setFeedback] = useState<null | { kind: 'ok' | 'err'; msg: string }>(null);

  useEffect(() => {
    if (!issued) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now >= issued.expiresAt) {
        setIssued(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [issued]);

  // Auto-clear displayed pairing code ONLY once a NEW binding completed after this code was opened
  useEffect(() => {
    if (!issued || !data) return;
    const bindingChanged =
      data.bound &&
      !data.pairing.open &&
      (data.boundAt > issued.previousBoundAt ||
        (Boolean(data.deviceId) && data.deviceId !== issued.previousDeviceId));
    if (bindingChanged) {
      setIssued(null);
      setFeedback({ kind: 'ok', msg: 'تم ربط تطبيق تندا على الآيفون بنجاح وتفعيل الحماية البيومترية.' });
    }
  }, [data, issued]);

  const openPairing = async () => {
    setBusy('open');
    setFeedback(null);
    setConfirmReset(false);
    const previousBoundAt = data?.boundAt ?? 0;
    const previousDeviceId = data?.deviceId ?? '';
    try {
      const resp = await fetch('/api/native/v2/pair/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        code?: string;
        expiresAt?: number;
        replacing?: boolean;
        error?: string;
      };
      if (!resp.ok || !json.ok || !json.code || !json.expiresAt) {
        setFeedback({ kind: 'err', msg: json.error || 'تعذّر إنشاء كود الربط.' });
        return;
      }
      setNowMs(Date.now());
      setIssued({
        code: json.code,
        expiresAt: json.expiresAt,
        replacing: Boolean(json.replacing),
        previousBoundAt,
        previousDeviceId,
      });
      await mutate(
        (prev) =>
          prev
            ? { ...prev, pairing: { open: true, expiresAt: json.expiresAt! } }
            : prev,
        { revalidate: true },
      );
    } catch (err) {
      setFeedback({ kind: 'err', msg: `خطأ في الاتصال: ${String(err)}` });
    } finally {
      setBusy(null);
    }
  };

  const resetDevice = async () => {
    setBusy('reset');
    setFeedback(null);
    try {
      const resp = await fetch('/api/native/v2/device-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'unbound from web settings' }),
      });
      const json = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!resp.ok || !json.ok) {
        setFeedback({ kind: 'err', msg: json.error || 'تعذّر فك ربط الآيفون.' });
        return;
      }
      setIssued(null);
      setConfirmReset(false);
      setFeedback({ kind: 'ok', msg: 'تم فك ربط الآيفون وإلغاء جميع الجلسات النشطة فوراً.' });
      await mutate();
    } catch (err) {
      setFeedback({ kind: 'err', msg: `خطأ في الاتصال: ${String(err)}` });
    } finally {
      setBusy(null);
    }
  };

  const copyCode = () => {
    if (!issued) return;
    navigator.clipboard
      .writeText(issued.code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  const remainingMs = issued ? Math.max(0, issued.expiresAt - nowMs) : 0;
  const isBound = Boolean(data?.bound);
  const fingerprint = data?.deviceId ? `${data.deviceId.slice(0, 10)}…${data.deviceId.slice(-6)}` : '';

  return (
    <div className="card card-lavender p-5 animate-fade-in space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'linear-gradient(135deg, rgba(255,107,74,0.22), rgba(139,92,246,0.25))',
              border: '1.5px solid rgba(139,92,246,0.40)',
            }}
          >
            <Smartphone size={19} style={{ color: '#2DD4BF' }} />
          </div>
          <div>
            <h2 className="font-semibold text-base" style={{ fontFamily: 'var(--font-sans)', letterSpacing: 'normal' }}>
              📱 ربط تطبيق تندا (<bdi dir="ltr">iOS</bdi>)
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
              ربط آيفون واحد حصرياً عبر مفاتيح <bdi dir="ltr">Secure Enclave</bdi> وبصمة <bdi dir="ltr">Face ID</bdi>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className={isBound ? 'chip chip-mint' : 'chip'} style={!isBound ? { color: 'var(--text-2)', background: 'rgba(255,255,255,0.05)', borderColor: 'rgba(255,255,255,0.12)' } : undefined}>
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: isBound ? '#2DD4BF' : 'rgba(180,188,208,0.45)' }}
            />
            {isBound ? 'الآيفون مربوط' : 'غير مربوط'}
          </span>
          <span className="chip chip-lavender">
            <ShieldCheck size={12} />
            <bdi dir="ltr">OwnerDeviceAuth v2</bdi>
          </span>
        </div>
      </div>

      {/* Bound Device Details */}
      {isBound && data ? (
        <div
          className="rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs"
          style={{
            background: 'rgba(10, 9, 24, 0.55)',
            boxShadow: 'inset 0 0 0 1px rgba(45, 212, 191, 0.24)',
          }}
        >
          <div className="space-y-1 min-w-0">
            <div style={{ color: 'var(--text-3)' }}>بصمة الجهاز المربوط</div>
            <div className="font-mono text-sm font-semibold truncate" style={{ color: 'var(--text)' }}>
              <bdi dir="ltr">{fingerprint}</bdi>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
              {data.attested && (
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(45,212,191,0.12)', color: '#2DD4BF' }}>
                  <bdi dir="ltr">App Attest ✓</bdi>
                </span>
              )}
              {data.sessionActive && (
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'rgba(139,92,246,0.16)', color: '#C4B5FD' }}>
                  جلسة نشطة
                </span>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <div style={{ color: 'var(--text-3)' }}>تاريخ الربط</div>
            <div className="text-sm font-medium tabular-nums" style={{ color: 'var(--text)' }}>
              {formatDateTime(data.boundAt)}
            </div>
          </div>

          <div className="space-y-1">
            <div style={{ color: 'var(--text-3)' }}>آخر نشاط من التطبيق</div>
            <div className="text-sm font-medium tabular-nums" style={{ color: '#2DD4BF' }}>
              {formatDateTime(data.lastSeenAt)}
            </div>
          </div>
        </div>
      ) : (
        <div
          className="rounded-xl p-3.5 text-xs leading-relaxed"
          style={{
            background: 'rgba(10, 9, 24, 0.45)',
            boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.08)',
            color: 'var(--text-2)',
          }}
        >
          لا يوجد آيفون مربوط حالياً. اضغط على الزر أدناه لإنشاء كود من <bdi dir="ltr">8</bdi> أرقام صالح لمدة <bdi dir="ltr">10</bdi> دقائق لمرة واحدة، ثم أدخله في تطبيق تندا على الآيفون.
        </div>
      )}

      {/* Issued 8-Digit Pairing Code Display */}
      {issued && remainingMs > 0 && (
        <div
          className="rounded-2xl p-5 space-y-4 text-center"
          style={{
            background: 'linear-gradient(135deg, rgba(255,107,74,0.14), rgba(139,92,246,0.16) 55%, rgba(45,212,191,0.10))',
            boxShadow: 'inset 0 0 0 1.5px rgba(255, 107, 74, 0.40)',
          }}
        >
          <div className="flex items-center justify-between gap-2 text-xs flex-wrap">
            <span className="font-semibold" style={{ color: 'var(--text)' }}>
              كود الربط لمرة واحدة
            </span>
            <span
              className="inline-flex items-center gap-1.5 font-mono tabular-nums px-2.5 py-1 rounded-full"
              style={{
                background: 'rgba(10, 9, 24, 0.65)',
                color: '#2DD4BF',
                boxShadow: 'inset 0 0 0 1px rgba(45, 212, 191, 0.30)',
              }}
            >
              <Clock size={12} />
              <bdi dir="ltr">{formatCountdown(remainingMs)}</bdi>
            </span>
          </div>

          <div
            className="font-mono tabular-nums font-bold select-all py-2"
            dir="ltr"
            style={{
              fontSize: 'clamp(2rem, 5vw, 2.75rem)',
              letterSpacing: '0.18em',
              color: '#F8FAFC',
            }}
          >
            {formatCode(issued.code)}
          </div>

          {issued.replacing && (
            <p className="text-xs" style={{ color: '#FBBF24' }}>
              تنبيه: إتمام الربط بهذا الكود سيفك ارتباط الآيفون السابق تلقائياً.
            </p>
          )}

          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={copyCode}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold transition"
              style={{
                background: 'rgba(45, 212, 191, 0.16)',
                color: '#2DD4BF',
                boxShadow: 'inset 0 0 0 1px rgba(45, 212, 191, 0.40)',
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'تم نسخ الكود' : 'نسخ الكود'}
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div
          className={`text-sm flex items-start gap-2 p-3 rounded-xl ${
            feedback.kind === 'ok'
              ? 'bg-accent-green/10 text-accent-green border border-accent-green/30'
              : 'bg-accent-red/10 text-accent-red border border-accent-red/30'
          }`}
        >
          {feedback.kind === 'ok' ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          ) : (
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
          )}
          <span>{feedback.msg}</span>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          onClick={openPairing}
          disabled={busy !== null}
          className="btn-primary inline-flex items-center gap-2 disabled:opacity-50"
        >
          {busy === 'open' ? <Loader size={15} className="animate-spin" /> : <KeyRound size={15} />}
          <span>إنشاء كود ربط (10 دقائق)</span>
        </button>

        {isBound && !confirmReset && (
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold transition disabled:opacity-50"
            style={{
              background: 'rgba(255, 107, 74, 0.12)',
              color: '#FF6B4A',
              boxShadow: 'inset 0 0 0 1px rgba(255, 107, 74, 0.35)',
            }}
          >
            <Unlink size={14} />
            <span>فك ربط الآيفون</span>
          </button>
        )}

        {isBound && confirmReset && (
          <div className="inline-flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium" style={{ color: '#FF6B4A' }}>
              تأكيد فك الربط وإلغاء الجلسة؟
            </span>
            <button
              type="button"
              onClick={resetDevice}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: '#EF4444' }}
            >
              {busy === 'reset' ? <Loader size={13} className="animate-spin" /> : <Unlink size={13} />}
              نعم، فك الربط
            </button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              disabled={busy !== null}
              className="btn-ghost text-xs"
            >
              إلغاء
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
