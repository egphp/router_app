'use client';

import { useEffect, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { fetcher } from '../lib/fetcher';
import { AskGeminiButton } from './AskGeminiButton';

interface AiSettingsState {
  configured: boolean;
  keySource: 'env' | 'db' | 'none';
  maskedKey: string | null;
  enabled: boolean;
  domainClassifierEnabled: boolean;
  deviceProfilerEnabled: boolean;
  securityTriageEnabled: boolean;
  morningBriefEnabled: boolean;
  morningBriefHour: number;
  wan1QuotaGb: number;
  wan2QuotaGb: number;
  billingRenewalDay: number;
}

interface DataIntegrityReport {
  healthy: boolean;
  checkedAt: number;
  rawSamples48h: number;
  openSessionsCount: number;
  rollupVsRawRatio24h: number | null;
  issues: Array<{ code: string; severity: 'info' | 'warn'; messageAr: string }>;
}

interface ScheduleRow {
  id: number;
  name: string;
  natural_prompt: string | null;
  days_mask: string;
  start_hhmm: string;
  end_hhmm: string;
  target_selector_json: string;
  download_limit_kbs: number;
  upload_limit_kbs: number;
  wan_port: string | null;
  enabled: number;
  last_applied_state: string | null;
}

export function AiSettingsAndSchedulesSection() {
  const { mutate: globalMutate } = useSWRConfig();
  const { data, mutate } = useSWR<{
    ok: boolean;
    settings: AiSettingsState;
    integrity: DataIntegrityReport;
  }>('/api/ai/settings', fetcher, { refreshInterval: 30_000 });

  const { data: schedData, mutate: mutateSched } = useSWR<{
    ok: boolean;
    schedules: ScheduleRow[];
  }>('/api/ai/schedules', fetcher, { refreshInterval: 20_000 });

  const s = data?.settings;
  const integrity = data?.integrity;
  const schedules = schedData?.schedules ?? [];

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [domainEnabled, setDomainEnabled] = useState(true);
  const [profilerEnabled, setProfilerEnabled] = useState(true);
  const [securityEnabled, setSecurityEnabled] = useState(true);
  const [briefEnabled, setBriefEnabled] = useState(true);
  const [briefHour, setBriefHour] = useState(9);
  const [wan1QuotaGb, setWan1QuotaGb] = useState(250);
  const [wan2QuotaGb, setWan2QuotaGb] = useState(250);
  const [renewalDay, setRenewalDay] = useState(1);
  const [busy, setBusy] = useState<null | 'test' | 'save' | 'clear'>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  // Schedule creator state
  const [naturalPrompt, setNaturalPrompt] = useState('');
  const [schedBusy, setSchedBusy] = useState<string | null>(null);
  const [schedFeedback, setSchedFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  useEffect(() => {
    if (!s) return;
    setEnabled(s.enabled);
    setDomainEnabled(s.domainClassifierEnabled);
    setProfilerEnabled(s.deviceProfilerEnabled);
    setSecurityEnabled(s.securityTriageEnabled);
    setBriefEnabled(s.morningBriefEnabled);
    setBriefHour(s.morningBriefHour);
    setWan1QuotaGb(s.wan1QuotaGb);
    setWan2QuotaGb(s.wan2QuotaGb);
    setRenewalDay(s.billingRenewalDay);
  }, [s]);

  const testConnection = async () => {
    setBusy('test');
    setFeedback(null);
    try {
      const r = await fetch('/api/ai/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'test',
          apiKey: apiKeyInput.trim() || undefined,
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setFeedback({ kind: 'err', msg: j?.error || 'تعذّر الاتصال بـ Gemini.' });
        return;
      }
      setFeedback({
        kind: 'ok',
        msg: `تم التحقق من الاتصال بنجاح عبر النموذج (${j.model}).`,
      });
    } catch (e) {
      setFeedback({ kind: 'err', msg: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const saveAiSettings = async (clearSavedKey = false) => {
    setBusy(clearSavedKey ? 'clear' : 'save');
    setFeedback(null);
    try {
      const r = await fetch('/api/ai/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: !clearSavedKey && apiKeyInput.trim() ? apiKeyInput.trim() : undefined,
          clearSavedKey,
          enabled,
          domainClassifierEnabled: domainEnabled,
          deviceProfilerEnabled: profilerEnabled,
          securityTriageEnabled: securityEnabled,
          morningBriefEnabled: briefEnabled,
          morningBriefHour: briefHour,
          wan1QuotaGb,
          wan2QuotaGb,
          billingRenewalDay: renewalDay,
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setFeedback({ kind: 'err', msg: j?.error || 'تعذّر حفظ إعدادات الذكاء الاصطناعي.' });
        return;
      }
      setApiKeyInput('');
      setFeedback({
        kind: 'ok',
        msg: clearSavedKey
          ? 'تم حذف المفتاح المشفّر من قاعدة البيانات.'
          : 'تم حفظ إعدادات Gemini والباقات بنجاح.',
      });
      await Promise.all([mutate(), globalMutate('/api/ai/quota-forecast')]);
    } catch (e) {
      setFeedback({ kind: 'err', msg: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const createSchedule = async () => {
    if (!naturalPrompt.trim()) return;
    setSchedBusy('create');
    setSchedFeedback(null);
    try {
      const r = await fetch('/api/ai/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ naturalPrompt: naturalPrompt.trim() }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setSchedFeedback({ kind: 'err', msg: j?.error || 'تعذّر إنشاء قاعدة الجدولة.' });
        return;
      }
      setNaturalPrompt('');
      setSchedFeedback({ kind: 'ok', msg: j.summaryAr || 'تم تفعيل قاعدة الجدولة.' });
      await mutateSched();
    } catch (e) {
      setSchedFeedback({ kind: 'err', msg: String(e) });
    } finally {
      setSchedBusy(null);
    }
  };

  const toggleSchedule = async (id: number, nextEnabled: boolean) => {
    setSchedBusy(`toggle-${id}`);
    try {
      await fetch('/api/ai/schedules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled: nextEnabled }),
      });
      await mutateSched();
    } finally {
      setSchedBusy(null);
    }
  };

  const deleteSchedule = async (id: number) => {
    setSchedBusy(`del-${id}`);
    try {
      await fetch('/api/ai/schedules', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await mutateSched();
    } finally {
      setSchedBusy(null);
    }
  };

  return (
    <div className="space-y-5" dir="rtl">
      {/* 1. Gemini AI Vault & Module Controls */}
      <div className="card p-5 animate-fade-in space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <Sparkles size={18} className="text-accent" />
            <div>
              <h2 className="font-semibold text-base" style={{ color: '#f7f8f8' }}>
                محرك الذكاء الاصطناعي (<bdi>Gemini AI &amp; Zero-PII Vault</bdi>)
              </h2>
              <p className="text-xs" style={{ color: 'rgba(180,188,208,.7)' }}>
                تعمية تلقائية كاملة لعناوين <bdi>MAC / IP / DDNS</bdi> قبل أي طلب سحابي، مع أولوية لمتغير{' '}
                <bdi className="font-mono">.env</bdi> ثم خزنة <bdi>AES-256-GCM</bdi> المشفرة محلياً.
              </p>
            </div>
          </div>

          <span
            className="rounded px-2.5 py-1 text-xs font-medium"
            style={
              s?.configured
                ? {
                    background: 'rgba(63,178,127,.12)',
                    color: '#3fb27f',
                    boxShadow: 'inset 0 0 0 1px rgba(63,178,127,.30)',
                  }
                : {
                    background: 'rgba(91,141,239,.10)',
                    color: '#8bb2ff',
                    boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.32)',
                  }
            }
          >
            {s?.configured
              ? s.keySource === 'env'
                ? 'مفعّل من ملف .env'
                : 'مفعّل من الخزنة المشفّرة'
              : 'وضع التحليل المحلي (بدون مفتاح بعد)'}
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div
            className="rounded-xl p-4 space-y-3"
            style={{ background: '#111114', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium" style={{ color: '#f7f8f8' }}>
                مفتاح <bdi className="font-mono">GEMINI_API_KEY</bdi>
              </span>
              {s?.maskedKey && (
                <bdi className="font-mono text-[11px]" style={{ color: 'rgba(180,188,208,.7)' }}>
                  {s.maskedKey}
                </bdi>
              )}
            </div>

            <div className="relative" dir="ltr">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={
                  s?.keySource === 'env'
                    ? 'Active from .env (leave blank or enter fallback DB key)'
                    : 'AIzaSy...'
                }
                className="w-full rounded-lg px-3 py-2 pr-9 text-xs font-mono focus:outline-none"
                style={{
                  background: '#17171b',
                  color: '#f7f8f8',
                  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
                }}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-1">
              <label className="block space-y-1">
                <span className="text-[11px]" style={{ color: 'rgba(180,188,208,.7)' }}>
                  باقة <bdi>WAN1 (GB)</bdi>
                </span>
                <input
                  type="number"
                  min={0}
                  max={100000}
                  value={wan1QuotaGb}
                  onChange={(e) => setWan1QuotaGb(Number(e.target.value) || 0)}
                  className="w-full rounded-lg px-2.5 py-1.5 text-xs tabular-nums font-mono"
                  style={{
                    background: '#17171b',
                    color: '#f7f8f8',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
                  }}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px]" style={{ color: 'rgba(180,188,208,.7)' }}>
                  باقة <bdi>WAN2 (GB)</bdi>
                </span>
                <input
                  type="number"
                  min={0}
                  max={100000}
                  value={wan2QuotaGb}
                  onChange={(e) => setWan2QuotaGb(Number(e.target.value) || 0)}
                  className="w-full rounded-lg px-2.5 py-1.5 text-xs tabular-nums font-mono"
                  style={{
                    background: '#17171b',
                    color: '#f7f8f8',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
                  }}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px]" style={{ color: 'rgba(180,188,208,.7)' }}>
                  يوم التجديد (1-31)
                </span>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={renewalDay}
                  onChange={(e) => setRenewalDay(Math.max(1, Math.min(31, Number(e.target.value) || 1)))}
                  className="w-full rounded-lg px-2.5 py-1.5 text-xs tabular-nums font-mono"
                  style={{
                    background: '#17171b',
                    color: '#f7f8f8',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
                  }}
                />
              </label>
            </div>
          </div>

          <div
            className="rounded-xl p-4 space-y-2.5"
            style={{ background: '#111114', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
          >
            <ToggleRow
              label="تفعيل منظومة الذكاء الاصطناعي بالكامل"
              checked={enabled}
              onChange={setEnabled}
            />
            <ToggleRow
              label="تصنيف النطاقات المجهولة والحماية العائلية (gemini-decision-1 بدون بيانات جهاز)"
              checked={domainEnabled}
              onChange={setDomainEnabled}
            />
            <ToggleRow
              label="بصمة الأجهزة وتوصية سرعة الأجهزة الجديدة ومطابقة الـ MAC العشوائي"
              checked={profilerEnabled}
              onChange={setProfilerEnabled}
            />
            <ToggleRow
              label="الفرز الذكي للتنبيهات الأمنية ودمج رسائل التليجرام"
              checked={securityEnabled}
              onChange={setSecurityEnabled}
            />
            <div className="flex items-center justify-between gap-2 pt-1">
              <ToggleRow
                label="التقرير الصباحي اليومي على تليجرام"
                checked={briefEnabled}
                onChange={setBriefEnabled}
              />
              <div className="flex items-center gap-1.5 shrink-0 text-xs">
                <span style={{ color: 'rgba(180,188,208,.65)' }}>الساعة:</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={briefHour}
                  onChange={(e) => setBriefHour(Math.max(0, Math.min(23, Number(e.target.value) || 0)))}
                  className="w-14 rounded px-2 py-1 text-xs tabular-nums font-mono text-center"
                  style={{
                    background: '#17171b',
                    color: '#f7f8f8',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {feedback && (
          <div
            className="rounded-lg p-3 text-xs flex items-start gap-2"
            style={
              feedback.kind === 'ok'
                ? {
                    background: 'rgba(63,178,127,.10)',
                    color: '#3fb27f',
                    boxShadow: 'inset 0 0 0 1px rgba(63,178,127,.30)',
                  }
                : {
                    background: 'rgba(244,103,107,.09)',
                    color: '#f4676b',
                    boxShadow: 'inset 0 0 0 1px rgba(244,103,107,.30)',
                  }
            }
          >
            {feedback.kind === 'ok' ? (
              <CheckCircle2 size={15} className="shrink-0 mt-0.5" />
            ) : (
              <AlertCircle size={15} className="shrink-0 mt-0.5" />
            )}
            <span>{feedback.msg}</span>
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void saveAiSettings(false)}
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition disabled:opacity-50"
            style={{ background: '#5b8def', color: '#0a0a0c' }}
          >
            {busy === 'save' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            <span>حفظ الإعدادات والباقات</span>
          </button>

          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void testConnection()}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition disabled:opacity-50"
            style={{
              background: '#17171b',
              color: '#f7f8f8',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
            }}
          >
            {busy === 'test' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            <span>اختبار الاتصال بـ Gemini</span>
          </button>

          {s?.keySource === 'db' && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void saveAiSettings(true)}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition disabled:opacity-50"
              style={{
                background: 'rgba(244,103,107,.09)',
                color: '#f4676b',
                boxShadow: 'inset 0 0 0 1px rgba(244,103,107,.30)',
              }}
            >
              <Trash2 size={13} />
              <span>حذف المفتاح المحفوظ</span>
            </button>
          )}
        </div>
      </div>

      {/* 2. Natural-Language QoS & Multi-WAN Scheduler */}
      <div className="card p-5 animate-fade-in space-y-4">
        <div className="flex items-center gap-2.5">
          <CalendarClock size={18} className="text-accent" />
          <div>
            <h2 className="font-semibold text-base" style={{ color: '#f7f8f8' }}>
              الجدولة الزمنية للسرعات وخطوط <bdi>WAN</bdi> باللغة الطبيعية
            </h2>
            <p className="text-xs" style={{ color: 'rgba(180,188,208,.7)' }}>
              اكتب القاعدة بالعربية وسيحولها النظام لجدول زمني يعيد السرعات الأصلية تلقائياً فور انتهاء الوقت.
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={naturalPrompt}
            onChange={(e) => setNaturalPrompt(e.target.value)}
            placeholder="مثال: حد سرعة الشاشات والألعاب بوضع SD أيام العمل من 09:00 إلى 17:00 ووجّههم على WAN2"
            className="flex-1 rounded-xl px-3.5 py-2.5 text-xs focus:outline-none"
            style={{
              background: '#111114',
              color: '#f7f8f8',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
            }}
          />
          <button
            type="button"
            disabled={!naturalPrompt.trim() || schedBusy !== null}
            onClick={() => void createSchedule()}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-semibold transition disabled:opacity-40"
            style={{ background: '#5b8def', color: '#0a0a0c' }}
          >
            {schedBusy === 'create' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            <span>إنشاء الجدولة</span>
          </button>
        </div>

        {schedFeedback && (
          <div
            className="rounded-lg px-3 py-2 text-xs"
            style={
              schedFeedback.kind === 'ok'
                ? {
                    background: 'rgba(63,178,127,.10)',
                    color: '#3fb27f',
                    boxShadow: 'inset 0 0 0 1px rgba(63,178,127,.28)',
                  }
                : {
                    background: 'rgba(244,103,107,.09)',
                    color: '#f4676b',
                    boxShadow: 'inset 0 0 0 1px rgba(244,103,107,.30)',
                  }
            }
          >
            {schedFeedback.msg}
          </div>
        )}

        {schedules.length === 0 ? (
          <div className="text-xs py-3" style={{ color: 'rgba(180,188,208,.55)' }}>
            لا توجد قواعد جدولة زمنية حالياً — أضف قاعدة بالأعلى لتطبيق حدود سرعة تلقائية بالساعات.
          </div>
        ) : (
          <div className="space-y-2">
            {schedules.map((row) => {
              let stateLabel = 'في انتظار الموعد';
              let isCurrentlyActive = false;
              try {
                if (row.last_applied_state) {
                  const st = JSON.parse(row.last_applied_state);
                  if (st?.active) {
                    isCurrentlyActive = true;
                    stateLabel = 'مطبّق الآن على الراوتر';
                  }
                }
              } catch {}
              return (
                <div
                  key={row.id}
                  className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap min-h-[56px]"
                  style={{
                    background: '#111114',
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)',
                    opacity: row.enabled ? 1 : 0.62,
                  }}
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium" style={{ color: '#f7f8f8' }}>
                        {row.name}
                      </span>
                      <span
                        className="rounded px-2 py-0.5 text-[11px] font-medium"
                        style={
                          !row.enabled
                            ? {
                                background: 'rgba(91,141,239,.10)',
                                color: '#8bb2ff',
                                boxShadow: 'inset 0 0 0 1px rgba(91,141,239,.28)',
                              }
                            : isCurrentlyActive
                            ? {
                                background: 'rgba(63,178,127,.12)',
                                color: '#3fb27f',
                                boxShadow: 'inset 0 0 0 1px rgba(63,178,127,.28)',
                              }
                            : {
                                background: 'rgba(255,255,255,.05)',
                                color: 'rgba(180,188,208,.75)',
                                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
                              }
                        }
                      >
                        {!row.enabled ? 'موقوف مؤقتاً' : stateLabel}
                      </span>
                    </div>
                    <div className="text-xs tabular-nums" style={{ color: 'rgba(180,188,208,.7)' }}>
                      التوقيت: <bdi>{row.start_hhmm} → {row.end_hhmm}</bdi> · السرعة:{' '}
                      <bdi>↓ {row.download_limit_kbs} / ↑ {row.upload_limit_kbs} KB/s</bdi>
                      {row.wan_port && (
                        <>
                          {' · '}توجيه: <bdi>{row.wan_port}</bdi>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={schedBusy !== null}
                      onClick={() => void toggleSchedule(row.id, !row.enabled)}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium transition"
                      style={{
                        background: '#17171b',
                        color: '#f7f8f8',
                        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
                      }}
                    >
                      {row.enabled ? 'إيقاف' : 'تفعيل'}
                    </button>
                    <button
                      type="button"
                      disabled={schedBusy !== null}
                      onClick={() => void deleteSchedule(row.id)}
                      className="rounded-lg p-1.5 transition"
                      style={{
                        background: 'rgba(244,103,107,.09)',
                        color: '#f4676b',
                        boxShadow: 'inset 0 0 0 1px rgba(244,103,107,.28)',
                      }}
                      title="حذف القاعدة واسترجاع السرعات"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 3. Data Integrity Watchdog */}
      {integrity && (
        <div className="card p-5 animate-fade-in space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5">
              <Database size={17} className="text-accent" />
              <div>
                <h2 className="font-semibold text-sm" style={{ color: '#f7f8f8' }}>
                  مراقب سلامة التجميعات الحسابية (<bdi>Data Integrity Watchdog</bdi>)
                </h2>
                <p className="text-xs" style={{ color: 'rgba(180,188,208,.7)' }}>
                  يقارن عينات <bdi>samples_raw</bdi> الخام مع جداول <bdi>traffic_hour</bdi> و <bdi>device_sessions</bdi>.
                </p>
              </div>
            </div>

            <span
              className="rounded px-2.5 py-1 text-xs font-medium"
              style={
                integrity.healthy
                  ? {
                      background: 'rgba(255,255,255,.05)',
                      color: 'rgba(180,188,208,.85)',
                      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.10)',
                    }
                  : {
                      background: 'rgba(227,160,8,.09)',
                      color: '#e3a008',
                      boxShadow: 'inset 0 0 0 1px rgba(227,160,8,.28)',
                    }
              }
            >
              {integrity.healthy ? 'متطابق وسليم' : 'يوجد تنبيه مطابقة'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
            <div
              className="rounded-lg p-3"
              style={{ background: '#111114', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
            >
              <div style={{ color: 'rgba(180,188,208,.65)' }}>عينات آخر ٤٨ ساعة</div>
              <div className="text-base font-semibold tabular-nums mt-0.5" style={{ color: '#f7f8f8' }}>
                {integrity.rawSamples48h.toLocaleString()}
              </div>
            </div>
            <div
              className="rounded-lg p-3"
              style={{ background: '#111114', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
            >
              <div style={{ color: 'rgba(180,188,208,.65)' }}>جلسات الأجهزة المفتوحة</div>
              <div className="text-base font-semibold tabular-nums mt-0.5" style={{ color: '#f7f8f8' }}>
                {integrity.openSessionsCount}
              </div>
            </div>
            <div
              className="rounded-lg p-3"
              style={{ background: '#111114', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06)' }}
            >
              <div style={{ color: 'rgba(180,188,208,.65)' }}>نسبة تطابق الساعات / الخام (٢٤س)</div>
              <div className="text-base font-semibold tabular-nums mt-0.5" style={{ color: '#f7f8f8' }}>
                {integrity.rollupVsRawRatio24h !== null
                  ? `${Math.round(integrity.rollupVsRawRatio24h * 100)}%`
                  : 'بيانات قيد التجميع'}
              </div>
            </div>
          </div>

          {integrity.issues.length > 0 && (
            <div className="space-y-2 pt-1">
              {integrity.issues.map((iss) => (
                <div
                  key={iss.code}
                  className="rounded-lg p-3 flex items-center justify-between gap-2 flex-wrap text-xs"
                  style={{
                    background: '#111114',
                    boxShadow: 'inset 0 0 0 1px rgba(227,160,8,.25)',
                    color: 'rgba(247,248,248,.9)',
                  }}
                >
                  <span>{iss.messageAr}</span>
                  <AskGeminiButton
                    compact
                    scopeType="integrity_watchdog"
                    scopeKey={`integrity-${iss.code}`}
                    contextPayload={{ issue: iss, integrity }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer select-none text-xs">
      <span style={{ color: 'rgba(247,248,248,.88)' }}>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded accent-blue-500 shrink-0"
      />
    </label>
  );
}
