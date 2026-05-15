'use client';
import { useEffect, useState, useRef } from 'react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { StatCard } from './StatCard';
import { LiveSpeedChart } from './LiveSpeedChart';
import { DeviceTable } from './DeviceTable';
import { AlertBanner } from './AlertBanner';
import { UpdateBanner } from './UpdateBanner';
import { NsfwBanner } from './NsfwBanner';
import { TopTalkers } from './TopTalkers';
import { CategoryBreakdown } from './CategoryBreakdown';
import { ConcurrentChart } from './ConcurrentChart';
import { AnomaliesCard } from './AnomaliesCard';
import { TelemetryCard } from './TelemetryCard';
import { TelemetryBar } from './TelemetryBar';
import { formatBytes, formatDuration, categoryIcon } from '../lib/format';
import { Activity, Download, Bell, Crown, GripVertical, RotateCcw, Lock, Unlock, PieChart } from 'lucide-react';

interface TopDevice { mac: string; label: string; bytes_down: number; bytes_up: number }
interface Status {
  connected: boolean;
  uptime_sec: number;
  online_count: number;
  total_devices: number;
  bytes_today_down: number;
  bytes_today_up: number;
  top_device: TopDevice | null;
  top_device_2: TopDevice | null;
  alerts: number;
}

type WidgetId = 'top-talkers' | 'category-chart' | 'concurrent' | 'anomalies' | 'devices';

const DEFAULT_ORDER: WidgetId[] = ['top-talkers', 'category-chart', 'concurrent', 'anomalies', 'devices'];
const STORAGE_KEY = 'tenda.dashboardOrder.v1';
const EDIT_KEY = 'tenda.dashboardEdit.v1';

function loadOrder(): WidgetId[] {
  if (typeof window === 'undefined') return DEFAULT_ORDER;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ORDER;
    const parsed = JSON.parse(raw) as WidgetId[];
    if (!Array.isArray(parsed)) return DEFAULT_ORDER;
    // Backfill any new widgets that didn't exist when the user saved their order
    const seen = new Set(parsed.filter((w) => DEFAULT_ORDER.includes(w)));
    const merged = parsed.filter((w) => DEFAULT_ORDER.includes(w));
    for (const w of DEFAULT_ORDER) if (!seen.has(w)) merged.push(w);
    return merged;
  } catch {
    return DEFAULT_ORDER;
  }
}

const WIDGET_LABELS: Record<WidgetId, string> = {
  'top-talkers': 'Top talkers',
  'category-chart': 'Category breakdown chart',
  concurrent: 'Concurrent devices',
  anomalies: 'Anomalies',
  devices: 'Devices table',
};

export function Dashboard() {
  const { data: status } = useSWR<Status>('/api/status', fetcher, { refreshInterval: 5000 });
  const [order, setOrder] = useState<WidgetId[]>(DEFAULT_ORDER);
  const [editMode, setEditMode] = useState(false);
  const [dragId, setDragId] = useState<WidgetId | null>(null);
  const [overId, setOverId] = useState<WidgetId | null>(null);
  const hydrated = useRef(false);

  // Load on mount
  useEffect(() => {
    setOrder(loadOrder());
    try {
      const e = localStorage.getItem(EDIT_KEY);
      if (e === '1') setEditMode(true);
    } catch {}
    hydrated.current = true;
  }, []);

  // Save on change
  useEffect(() => {
    if (!hydrated.current) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); } catch {}
  }, [order]);

  useEffect(() => {
    if (!hydrated.current) return;
    try { localStorage.setItem(EDIT_KEY, editMode ? '1' : '0'); } catch {}
  }, [editMode]);

  const onDragStart = (id: WidgetId) => (e: React.DragEvent) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };

  const onDragOver = (id: WidgetId) => (e: React.DragEvent) => {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (overId !== id) setOverId(id);
  };

  const onDrop = (id: WidgetId) => (e: React.DragEvent) => {
    e.preventDefault();
    const source = dragId;
    if (!source || source === id) { setDragId(null); setOverId(null); return; }
    setOrder((prev) => {
      const next = prev.filter((w) => w !== source);
      const idx = next.indexOf(id);
      next.splice(idx === -1 ? next.length : idx, 0, source);
      return next;
    });
    setDragId(null);
    setOverId(null);
  };

  const reset = () => {
    setOrder(DEFAULT_ORDER);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  };

  const renderWidget = (id: WidgetId) => {
    switch (id) {
      case 'top-talkers':
        return <TopTalkers />;
      case 'category-chart':
        return <CategoryBreakdown />;
      case 'concurrent':
        return <ConcurrentChart />;
      case 'anomalies':
        return <AnomaliesCard />;
      case 'devices':
        return <DeviceTable />;
    }
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      <UpdateBanner />
      <NsfwBanner />
      <AlertBanner />
      <TelemetryBar />

      {/* Fixed status row — always first, not reorderable. Stats on left, Live Speed on right */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-3 sm:gap-4 items-stretch">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
          <StatCard
            label="Router uptime"
            value={formatDuration(status?.uptime_sec ?? 0)}
            hint={status ? `${status.online_count} online of ${status.total_devices} known` : '...'}
            icon={<Activity size={16} strokeWidth={2.2} />}
            tone={status?.connected ? 'mint' : 'coral'}
          />
          <StatCard
            label="Today (total)"
            value={formatBytes((status?.bytes_today_down ?? 0) + (status?.bytes_today_up ?? 0))}
            hint={`↓ ${formatBytes(status?.bytes_today_down ?? 0)} · ↑ ${formatBytes(status?.bytes_today_up ?? 0)}`}
            icon={<Download size={16} strokeWidth={2.2} />}
            tone="peach"
          />
          <TopDevicesCard top={status?.top_device ?? null} second={status?.top_device_2 ?? null} />
        </div>
        <LiveSpeedChart />
      </div>

      {/* Edit toolbar */}
      <div className="flex items-center justify-end gap-2 -mb-2">
        {editMode && (
          <button
            onClick={reset}
            className="text-xs px-2.5 py-1.5 rounded-md bg-bg-elevated border border-bg-border text-slate-400 hover:text-slate-100 flex items-center gap-1.5"
            title="Reset to default order"
          >
            <RotateCcw size={12} /> Reset
          </button>
        )}
        <button
          onClick={() => setEditMode((v) => !v)}
          className={`text-xs px-2.5 py-1.5 rounded-md border flex items-center gap-1.5 ${
            editMode
              ? 'bg-accent text-white border-accent'
              : 'bg-bg-elevated border-bg-border text-slate-400 hover:text-slate-100'
          }`}
          title={editMode ? 'Lock layout' : 'Edit layout (drag widgets to reorder)'}
        >
          {editMode ? <><Unlock size={12} /> Editing — drag to reorder</> : <><Lock size={12} /> Edit layout</>}
        </button>
      </div>

      {order.map((id) => {
        const isDragged = dragId === id;
        const isOver = overId === id && dragId !== null && dragId !== id;
        return (
          <div
            key={id}
            draggable={editMode}
            onDragStart={editMode ? onDragStart(id) : undefined}
            onDragOver={editMode ? onDragOver(id) : undefined}
            onDrop={editMode ? onDrop(id) : undefined}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
            className={`relative transition-all ${
              editMode ? 'ring-1 ring-dashed ring-bg-border rounded-lg' : ''
            } ${isDragged ? 'opacity-40' : ''} ${
              isOver ? 'ring-2 ring-accent ring-solid' : ''
            }`}
          >
            {editMode && (
              <div className="absolute -left-2 top-1/2 -translate-y-1/2 z-20 bg-accent text-white rounded-md p-1 shadow-lg cursor-grab active:cursor-grabbing pointer-events-none">
                <GripVertical size={14} />
              </div>
            )}
            {editMode && (
              <div className="absolute -top-2 left-3 z-20 bg-bg-card border border-accent/40 text-accent text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-semibold pointer-events-none">
                {WIDGET_LABELS[id]}
              </div>
            )}
            {renderWidget(id)}
          </div>
        );
      })}
    </div>
  );
}

function TopDevicesCard({ top, second }: { top: TopDevice | null; second: TopDevice | null }) {
  return (
    <div className="card card-lavender p-4 sm:p-5 flex flex-col gap-3 animate-fade-in transition-all hover:-translate-y-0.5">
      <div className="flex items-start justify-between gap-2">
        <div className="stat-label truncate">Top devices today</div>
        <div className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, var(--lavender-soft), var(--rose) 0%)', border: '1.5px solid oklch(0.78 0.14 295 / 0.4)' }}>
          <Crown size={16} className="text-accent-lavender" strokeWidth={2.2} />
        </div>
      </div>
      <div className="space-y-2.5">
        {[top, second].map((d, i) =>
          d ? (
            <div key={d.mac} className="flex items-center gap-2.5">
              <span className="text-[11px] font-bold tabular-nums w-4 font-display italic"
                style={{ color: i === 0 ? 'var(--lavender)' : 'var(--text-3)' }}>#{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate" style={{ color: i === 0 ? 'var(--lavender)' : 'var(--text-2)' }}>
                  {d.label}
                </div>
                <div className="text-[11px] tabular-nums font-semibold" style={{ color: i === 0 ? 'var(--lavender)' : 'var(--text-2)' }}>
                  {formatBytes(d.bytes_down + d.bytes_up)}
                </div>
                <div className="text-[10px] tabular-nums" style={{ color: 'var(--text-3)' }}>
                  ↓ {formatBytes(d.bytes_down, 0)} · ↑ {formatBytes(d.bytes_up, 0)}
                </div>
              </div>
            </div>
          ) : (
            <div key={`empty-${i}`} className="flex items-center gap-2.5 opacity-40">
              <span className="text-[11px] font-bold tabular-nums w-4 font-display italic" style={{ color: 'var(--text-3)' }}>#{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm" style={{ color: 'var(--text-3)' }}>—</div>
                <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>no traffic</div>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

interface CategoryRow { category: string; bytes_down: number; bytes_up: number; device_count: number }

function CategoryStatCard() {
  const { data } = useSWR<{ data: CategoryRow[] }>('/api/analytics?kind=categories&range=today', fetcher, { refreshInterval: 30000 });
  const rows = data?.data ?? [];
  const total = rows.reduce((s, r) => s + r.bytes_down + r.bytes_up, 0);
  const top3 = rows.slice(0, 3);
  return (
    <div className="card card-mint p-4 sm:p-5 flex flex-col gap-3 animate-fade-in transition-all hover:-translate-y-0.5">
      <div className="flex items-start justify-between gap-2">
        <div className="stat-label truncate">Traffic by category</div>
        <div className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg, var(--mint-soft), var(--ice) 0%)', border: '1.5px solid oklch(0.85 0.13 165 / 0.4)' }}>
          <PieChart size={16} className="text-accent-mint" strokeWidth={2.2} />
        </div>
      </div>
      <div className="space-y-1.5">
        {top3.length === 0 ? (
          <div className="text-sm" style={{ color: 'var(--text-3)' }}>no data</div>
        ) : top3.map((r, i) => {
          const pct = total > 0 ? ((r.bytes_down + r.bytes_up) / total) * 100 : 0;
          const gradient = [
            'linear-gradient(90deg, var(--mint), var(--ice))',
            'linear-gradient(90deg, var(--peach), var(--sun))',
            'linear-gradient(90deg, var(--lavender), var(--rose))',
          ][i];
          return (
            <div key={r.category} className="flex items-center gap-2 text-xs">
              <span className="text-base shrink-0">{categoryIcon(r.category)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate capitalize" style={{ color: 'var(--text)' }}>{r.category}</span>
                  <span className="tabular-nums shrink-0" style={{ color: 'var(--text-2)' }}>{formatBytes(r.bytes_down + r.bytes_up, 0)}</span>
                </div>
                <div className="h-1 rounded-full mt-1 overflow-hidden" style={{ background: 'oklch(0.20 0.04 275 / 0.5)' }}>
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: gradient }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
