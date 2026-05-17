'use client';
import { useEffect, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { Eye, EyeOff, Shield, CheckCircle2, AlertCircle, Save, Loader, ShieldAlert, KeyRound, BellRing, X, Gauge, Trash2 } from 'lucide-react';

interface Settings {
  routerHost: string;
  pollIntervalMs: number;
  webPort: number;
  ipcSocket: string;
  dbPath: string;
  logLevel: string;
  daemon: { running: boolean };
}

interface PushDeliveryOverview {
  tag: string | null;
  status: string;
  error: string | null;
  createdAt: number;
}

interface PushSubscriptionOverview {
  id: number;
  endpointHash: string;
  endpointHost: string;
  endpointPreview: string;
  status: string;
  expirationTime: number | null;
  createdAt: number;
  updatedAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  clientPlatform: string | null;
  clientUserAgent: string | null;
  needsRefresh: boolean;
  refreshReason: string | null;
  recentDeliveries: PushDeliveryOverview[];
}

interface PushSubscriptionsResponse {
  ok: boolean;
  total: number;
  active: number;
  expired: number;
  needsRefresh: number;
  failing: number;
  subscriptions: PushSubscriptionOverview[];
}

interface NotificationTypeState {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
}

interface ThresholdConfig {
  totalEnabled: boolean;
  totalLimitBytes: number;
  totalPeriod: string;
  deviceEnabled: boolean;
  deviceDefaultLimitBytes: number;
  deviceDefaultPeriod: string;
}

interface DeviceThreshold {
  mac: string;
  label: string;
  enabled: boolean;
  limitBytes: number;
  period: string;
  updatedAt: number;
}

interface NotificationSettingsResponse {
  ok: boolean;
  types: NotificationTypeState[];
  thresholds: ThresholdConfig;
  deviceThresholds: DeviceThreshold[];
  devices: Array<{ mac: string; label: string; category: string | null }>;
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

      <RemotePanelAccessCard />
      <PushTestCard />
      <NotificationSettingsCard />
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

function RemotePanelAccessCard() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | { kind: 'ok' | 'err'; msg: string }>(null);

  const save = async () => {
    setResult(null);
    if (password.length < 10) {
      setResult({ kind: 'err', msg: 'Use at least 10 characters.' });
      return;
    }
    if (password !== confirm) {
      setResult({ kind: 'err', msg: 'Passwords do not match.' });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setResult({ kind: 'err', msg: j.error || 'Could not save panel password.' });
        return;
      }
      setPassword('');
      setConfirm('');
      setResult({ kind: 'ok', msg: 'Remote password saved. Remote login sessions last 30 days.' });
    } catch (e) {
      setResult({ kind: 'err', msg: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-4">
        <KeyRound size={16} className="text-accent" />
        <h2 className="font-semibold">Remote panel password</h2>
      </div>
      <p className="text-sm text-slate-400 mb-4">
        Applies only when the dashboard is opened through a remote domain. Localhost and LAN access stay open.
      </p>
      <div className="space-y-3 max-w-xl">
        <label className="block">
          <span className="text-xs text-slate-400">New remote password</span>
          <div className="relative mt-1">
            <input
              type={showPwd ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="block w-full bg-bg-elevated border border-bg-border rounded-md px-3 py-2 pr-10 text-sm font-mono focus:outline-none focus:border-accent"
            />
            <button type="button" onClick={() => setShowPwd((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
              {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Confirm password</span>
          <input
            type={showPwd ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className="block w-full mt-1 bg-bg-elevated border border-bg-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
          />
        </label>

        {result && (
          <div className={`text-sm flex items-start gap-2 p-3 rounded ${
            result.kind === 'ok' ? 'bg-accent-green/10 text-accent-green border border-accent-green/30' : 'bg-accent-red/10 text-accent-red border border-accent-red/30'
          }`}>
            {result.kind === 'ok' ? <CheckCircle2 size={16} className="mt-0.5" /> : <AlertCircle size={16} className="mt-0.5" />}
            <span>{result.msg}</span>
          </div>
        )}

        <button
          onClick={save}
          disabled={!password || !confirm || busy}
          className="px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50 flex items-center gap-2"
        >
          {busy ? <Loader size={14} className="animate-spin" /> : <Save size={14} />}
          Save panel password
        </button>
      </div>
    </div>
  );
}

function PushTestCard() {
  const { data, mutate } = useSWR<PushSubscriptionsResponse>('/api/push/subscriptions', fetcher, { refreshInterval: 15000 });
  const [busy, setBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [result, setResult] = useState<null | { kind: 'ok' | 'err'; msg: string }>(null);

  const sendTest = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/push/test', { method: 'POST' });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setResult({ kind: 'err', msg: j.error || 'Could not send test notification.' });
        return;
      }
      setResult({ kind: 'ok', msg: `Test sent: ${j.sent ?? 0}, failed: ${j.failed ?? 0}.` });
      mutate();
    } catch (e) {
      setResult({ kind: 'err', msg: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-4">
        <BellRing size={16} className="text-accent" />
        <h2 className="font-semibold">Push notifications</h2>
      </div>
      <div className="space-y-3 max-w-xl">
        <p className="text-sm text-slate-400">
          The iPhone activation banner appears on supported browsers and stores Web Push subscriptions locally in SQLite.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <PushMetric label="Stored" value={data?.total ?? 0} />
          <PushMetric label="Active" value={data?.active ?? 0} tone="ok" />
          <PushMetric label="Expired" value={data?.expired ?? 0} tone={(data?.expired ?? 0) > 0 ? 'warn' : undefined} />
          <PushMetric label="Needs refresh" value={data?.needsRefresh ?? 0} tone={(data?.needsRefresh ?? 0) > 0 ? 'warn' : 'ok'} />
          <PushMetric label="Failed" value={data?.failing ?? 0} tone={(data?.failing ?? 0) > 0 ? 'err' : 'ok'} />
        </div>
        {result && (
          <div className={`text-sm flex items-start gap-2 p-3 rounded ${
            result.kind === 'ok' ? 'bg-accent-green/10 text-accent-green border border-accent-green/30' : 'bg-accent-red/10 text-accent-red border border-accent-red/30'
          }`}>
            {result.kind === 'ok' ? <CheckCircle2 size={16} className="mt-0.5" /> : <AlertCircle size={16} className="mt-0.5" />}
            <span>{result.msg}</span>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={sendTest}
            disabled={busy}
            className="px-4 py-2 rounded bg-bg-elevated border border-bg-border text-sm hover:bg-bg-border disabled:opacity-50 flex items-center gap-2"
          >
            {busy ? <Loader size={14} className="animate-spin" /> : <BellRing size={14} />}
            Send test notification
          </button>
          <button
            onClick={() => setDetailsOpen(true)}
            className="px-4 py-2 rounded bg-bg-elevated border border-bg-border text-sm hover:bg-bg-border"
          >
            Details
          </button>
        </div>
      </div>
      {detailsOpen && (
        <PushDetailsModal
          data={data}
          onClose={() => setDetailsOpen(false)}
          onRefresh={() => mutate()}
        />
      )}
    </div>
  );
}

function NotificationSettingsCard() {
  const { data, mutate } = useSWR<NotificationSettingsResponse>('/api/notification-settings', fetcher, { refreshInterval: 20000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [totalEnabled, setTotalEnabled] = useState(false);
  const [totalLimitGb, setTotalLimitGb] = useState('');
  const [totalPeriod, setTotalPeriod] = useState('today');
  const [deviceEnabled, setDeviceEnabled] = useState(false);
  const [deviceDefaultGb, setDeviceDefaultGb] = useState('');
  const [deviceDefaultPeriod, setDeviceDefaultPeriod] = useState('today');
  const [selectedMac, setSelectedMac] = useState('');
  const [deviceLimitGb, setDeviceLimitGb] = useState('');
  const [devicePeriod, setDevicePeriod] = useState('today');
  const [deviceThresholdEnabled, setDeviceThresholdEnabled] = useState(true);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!data?.thresholds || initialized) return;
    setTotalEnabled(data.thresholds.totalEnabled);
    setTotalLimitGb(bytesToGbInput(data.thresholds.totalLimitBytes));
    setTotalPeriod(data.thresholds.totalPeriod);
    setDeviceEnabled(data.thresholds.deviceEnabled);
    setDeviceDefaultGb(bytesToGbInput(data.thresholds.deviceDefaultLimitBytes));
    setDeviceDefaultPeriod(data.thresholds.deviceDefaultPeriod);
    if (!selectedMac && data.devices.length > 0) setSelectedMac(data.devices[0].mac);
    setInitialized(true);
  }, [data, initialized, selectedMac]);

  const patch = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      await fetch('/api/notification-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      mutate();
    } finally {
      setBusy(null);
    }
  };

  const saveThresholds = () => patch({
    action: 'save_thresholds',
    totalEnabled,
    totalLimitBytes: gbToBytes(totalLimitGb),
    totalPeriod,
    deviceEnabled,
    deviceDefaultLimitBytes: gbToBytes(deviceDefaultGb),
    deviceDefaultPeriod,
  }, 'thresholds');

  const saveDeviceThreshold = () => {
    if (!selectedMac) return;
    patch({
      action: 'upsert_device_threshold',
      mac: selectedMac,
      enabled: deviceThresholdEnabled,
      limitBytes: gbToBytes(deviceLimitGb),
      period: devicePeriod,
    }, 'device-threshold');
  };

  return (
    <div className="card p-5 animate-fade-in">
      <div className="flex items-center gap-2 mb-4">
        <Gauge size={16} className="text-accent" />
        <h2 className="font-semibold">Notification controls</h2>
      </div>
      <div className="space-y-5">
        <div>
          <div className="stat-label mb-2">Types</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {data?.types.map((type) => (
              <div key={type.key} className="rounded-md border border-bg-border bg-bg-elevated/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{type.label}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{type.description}</div>
                  </div>
                  <button
                    onClick={() => patch({ action: 'set_type', type: type.key, enabled: !type.enabled }, `type-${type.key}`)}
                    disabled={busy !== null}
                    aria-pressed={type.enabled}
                    className={`relative h-6 w-12 shrink-0 rounded-full transition ${type.enabled ? 'bg-accent-green' : 'bg-bg-border'} disabled:opacity-50`}
                  >
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${type.enabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              </div>
            ))}
            {!data && <div className="text-sm text-slate-500">Loading notification controls...</div>}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ThresholdBox
            title="Total download"
            enabled={totalEnabled}
            setEnabled={setTotalEnabled}
            limitGb={totalLimitGb}
            setLimitGb={setTotalLimitGb}
            period={totalPeriod}
            setPeriod={setTotalPeriod}
            helper="Alert when all devices combined cross this download amount."
          />
          <ThresholdBox
            title="Default per-device download"
            enabled={deviceEnabled}
            setEnabled={setDeviceEnabled}
            limitGb={deviceDefaultGb}
            setLimitGb={setDeviceDefaultGb}
            period={deviceDefaultPeriod}
            setPeriod={setDeviceDefaultPeriod}
            helper="Applies to every device unless a device-specific limit exists below."
          />
        </div>
        <button
          onClick={saveThresholds}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
        >
          {busy === 'thresholds' ? <Loader size={14} className="animate-spin" /> : <Save size={14} />}
          Save threshold alerts
        </button>

        <div className="rounded-md border border-bg-border bg-bg-elevated/35 p-3">
          <div className="mb-3 text-sm font-medium">Specific device threshold</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_120px_130px_92px_auto]">
            <select value={selectedMac} onChange={(e) => setSelectedMac(e.target.value)}
              className="min-w-0 rounded border border-bg-border bg-bg-card px-2 py-2 text-sm">
              {data?.devices.map((device) => (
                <option key={device.mac} value={device.mac}>{device.label} · {device.mac}</option>
              ))}
            </select>
            <input value={deviceLimitGb} onChange={(e) => setDeviceLimitGb(e.target.value)}
              inputMode="decimal" placeholder="GB"
              className="min-w-0 rounded border border-bg-border bg-bg-card px-2 py-2 text-sm" />
            <PeriodSelect value={devicePeriod} onChange={setDevicePeriod} />
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input type="checkbox" checked={deviceThresholdEnabled} onChange={(e) => setDeviceThresholdEnabled(e.target.checked)} className="accent-blue-500" />
              Enabled
            </label>
            <button onClick={saveDeviceThreshold} disabled={!selectedMac || busy !== null}
              className="rounded bg-bg-card px-3 py-2 text-sm border border-bg-border hover:bg-bg-border disabled:opacity-50">
              Save
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {data?.deviceThresholds.map((row) => (
              <div key={row.mac} className="grid grid-cols-1 gap-2 rounded border border-bg-border bg-bg-card/60 p-2 text-xs sm:grid-cols-[minmax(0,1fr)_110px_80px_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-200">{row.label}</div>
                  <div className="break-all text-slate-500">{row.mac}</div>
                </div>
                <div className="tabular-nums text-slate-300">{bytesToGbInput(row.limitBytes) || '0'} GB / {row.period}</div>
                <Badge tone={row.enabled ? 'ok' : 'warn'}>{row.enabled ? 'on' : 'off'}</Badge>
                <button onClick={() => patch({ action: 'delete_device_threshold', mac: row.mac }, `delete-${row.mac}`)}
                  className="inline-flex items-center justify-center gap-1 rounded border border-accent-red/30 bg-accent-red/10 px-2 py-1 text-accent-red hover:bg-accent-red/20">
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            ))}
            {data?.deviceThresholds.length === 0 && (
              <div className="text-xs text-slate-500">No specific device limits yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ThresholdBox({ title, enabled, setEnabled, limitGb, setLimitGb, period, setPeriod, helper }: {
  title: string;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  limitGb: string;
  setLimitGb: (value: string) => void;
  period: string;
  setPeriod: (value: string) => void;
  helper: string;
}) {
  return (
    <div className="rounded-md border border-bg-border bg-bg-elevated/35 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="mt-0.5 text-xs text-slate-500">{helper}</div>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-blue-500" />
          On
        </label>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_130px]">
        <label className="block">
          <span className="text-xs text-slate-400">Limit in GB</span>
          <input value={limitGb} onChange={(e) => setLimitGb(e.target.value)}
            inputMode="decimal" placeholder="Example: 100"
            className="mt-1 block w-full rounded border border-bg-border bg-bg-card px-2 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Period</span>
          <PeriodSelect value={period} onChange={setPeriod} className="mt-1" />
        </label>
      </div>
    </div>
  );
}

function PeriodSelect({ value, onChange, className = '' }: { value: string; onChange: (value: string) => void; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className={`block w-full min-w-0 rounded border border-bg-border bg-bg-card px-2 py-2 text-sm ${className}`}>
      <option value="today">Today</option>
      <option value="week">Last 7 days</option>
      <option value="month">Last 30 days</option>
      <option value="all">All-time</option>
    </select>
  );
}

function gbToBytes(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1024 ** 3);
}

function bytesToGbInput(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  const gb = n / 1024 ** 3;
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(2);
}

function PushMetric({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'err' }) {
  const color = tone === 'ok' ? 'text-accent-green' : tone === 'warn' ? 'text-yellow-300' : tone === 'err' ? 'text-accent-red' : 'text-slate-100';
  return (
    <div className="rounded-md bg-bg-elevated/50 border border-bg-border p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function PushDetailsModal({ data, onClose, onRefresh }: {
  data: PushSubscriptionsResponse | undefined;
  onClose: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3">
      <div className="w-full max-w-5xl max-h-[86vh] overflow-hidden rounded-lg border border-bg-border bg-bg-card shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-bg-border p-4">
          <div>
            <div className="font-semibold">Push notification subscriptions</div>
            <div className="text-xs text-slate-500">
              {data ? `${data.active} active of ${data.total} total` : 'Loading...'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onRefresh} className="px-3 py-1.5 rounded bg-bg-elevated border border-bg-border text-xs hover:bg-bg-border">
              Refresh
            </button>
            <button onClick={onClose} aria-label="Close" className="p-1 text-slate-400 hover:text-slate-100">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto max-h-[calc(86vh-72px)] p-4 space-y-3">
          {!data && <div className="text-sm text-slate-500">Loading...</div>}
          {data?.subscriptions.length === 0 && <div className="text-sm text-slate-500">No subscriptions stored yet.</div>}
          {data?.subscriptions.map((sub) => (
            <div key={sub.id} className="rounded-md border border-bg-border bg-bg-elevated/35 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-xs text-slate-200 break-all">{sub.endpointPreview}</div>
                  <div className="mt-1 text-[10px] text-slate-500 break-all">hash: {sub.endpointHash}</div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={sub.status === 'active' ? 'ok' : 'err'}>{sub.status}</Badge>
                  {sub.needsRefresh && <Badge tone="warn">refresh: {sub.refreshReason ?? 'needed'}</Badge>}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 mt-3 text-xs">
                <Info label="Platform" value={sub.clientPlatform ?? '-'} />
                <Info label="Host" value={sub.endpointHost} />
                <Info label="Last success" value={formatTs(sub.lastSuccessAt)} tone="ok" />
                <Info label="Last failure" value={formatTs(sub.lastFailureAt)} tone={sub.lastFailureAt ? 'err' : undefined} />
                <Info label="Updated" value={formatTs(sub.updatedAt)} />
                <Info label="Expires" value={sub.expirationTime ? formatTs(sub.expirationTime) : 'browser did not set expiry'} />
                <Info label="Last error" value={sub.lastError ?? '-'} tone={sub.lastError ? 'err' : undefined} wide />
                <Info label="User agent" value={sub.clientUserAgent ?? '-'} wide />
              </div>
              <div className="mt-3">
                <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Recent sends</div>
                <div className="space-y-1">
                  {sub.recentDeliveries.length === 0 && <div className="text-xs text-slate-500">No sends logged.</div>}
                  {sub.recentDeliveries.map((delivery, index) => (
                    <div key={`${delivery.createdAt}-${index}`} className="grid grid-cols-1 md:grid-cols-[140px_90px_minmax(0,1fr)_minmax(0,1fr)] gap-1 md:gap-3 text-xs">
                      <span className="text-slate-500">{formatTs(delivery.createdAt)}</span>
                      <span className={delivery.status === 'sent' ? 'text-accent-green' : 'text-accent-red'}>{delivery.status}</span>
                      <span className="text-slate-400">{delivery.tag ?? '-'}</span>
                      <span className="text-accent-red break-all">{delivery.error ?? ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone: 'ok' | 'warn' | 'err' }) {
  const cls = tone === 'ok'
    ? 'border-accent-green/30 bg-accent-green/10 text-accent-green'
    : tone === 'warn'
      ? 'border-yellow-300/30 bg-yellow-300/10 text-yellow-300'
      : 'border-accent-red/30 bg-accent-red/10 text-accent-red';
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}>{children}</span>;
}

function Info({ label, value, tone, wide }: { label: string; value: string; tone?: 'ok' | 'err'; wide?: boolean }) {
  return (
    <div className={wide ? 'md:col-span-2' : ''}>
      <span className="text-slate-500">{label}: </span>
      <span className={`${tone === 'ok' ? 'text-accent-green' : tone === 'err' ? 'text-accent-red' : 'text-slate-300'} break-all`}>{value}</span>
    </div>
  );
}

function formatTs(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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
