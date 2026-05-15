'use client';
import { useEffect, useState, useRef } from 'react';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { StatCard } from './StatCard';
import { LiveSpeedChart } from './LiveSpeedChart';
import { DeviceTable } from './DeviceTable';
import { AlertBanner } from './AlertBanner';
import { UpdateBanner } from './UpdateBanner';
import { TopTalkers } from './TopTalkers';
import { CategoryBreakdown } from './CategoryBreakdown';
import { ConcurrentChart } from './ConcurrentChart';
import { AnomaliesCard } from './AnomaliesCard';
import { TelemetryCard } from './TelemetryCard';
import { formatBytes, formatDuration } from '../lib/format';
import { Activity, Download, Bell, Crown, GripVertical, RotateCcw, Lock, Unlock } from 'lucide-react';

interface Status {
  connected: boolean;
  uptime_sec: number;
  online_count: number;
  total_devices: number;
  bytes_today_down: number;
  bytes_today_up: number;
  top_device: { mac: string; label: string; bytes_down: number } | null;
  alerts: number;
}

type WidgetId = 'stats' | 'live-speed' | 'telemetry' | 'top-talkers' | 'category' | 'concurrent' | 'anomalies' | 'devices';

const DEFAULT_ORDER: WidgetId[] = ['stats', 'live-speed', 'telemetry', 'top-talkers', 'category', 'concurrent', 'anomalies', 'devices'];
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
  stats: 'Status cards',
  'live-speed': 'Live speed',
  telemetry: 'Router telemetry',
  'top-talkers': 'Top talkers',
  category: 'Traffic by category',
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
      case 'stats':
        return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4">
            <StatCard
              label="Router uptime"
              value={formatDuration(status?.uptime_sec ?? 0)}
              hint={status ? `${status.online_count} online of ${status.total_devices} known` : '...'}
              icon={<Activity size={16} />}
              tone={status?.connected ? 'green' : 'red'}
            />
            <StatCard
              label="Today (download)"
              value={formatBytes(status?.bytes_today_down ?? 0)}
              hint={`↑ ${formatBytes(status?.bytes_today_up ?? 0)} (estimated)`}
              icon={<Download size={16} />}
            />
            <StatCard
              label="Top device today"
              value={status?.top_device ? status.top_device.label : '—'}
              hint={status?.top_device ? formatBytes(status.top_device.bytes_down) : 'no traffic yet'}
              icon={<Crown size={16} />}
              tone="purple"
            />
            <StatCard
              label="Active alerts"
              value={status?.alerts ?? 0}
              hint={status?.alerts ? 'see Alerts page' : 'all clear'}
              icon={<Bell size={16} />}
              tone={status && status.alerts > 0 ? 'red' : 'default'}
            />
          </div>
        );
      case 'live-speed':
        return <LiveSpeedChart />;
      case 'telemetry':
        return <TelemetryCard />;
      case 'top-talkers':
        return <TopTalkers />;
      case 'category':
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
      <AlertBanner />

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
