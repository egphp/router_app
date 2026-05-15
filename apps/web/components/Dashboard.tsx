'use client';
import useSWR from 'swr';
import { fetcher } from '../lib/fetcher';
import { StatCard } from './StatCard';
import { LiveSpeedChart } from './LiveSpeedChart';
import { DeviceTable } from './DeviceTable';
import { AlertBanner } from './AlertBanner';
import { formatBytes, formatDuration } from '../lib/format';
import { Activity, Download, Users, Bell, Crown } from 'lucide-react';

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

export function Dashboard() {
  const { data: status } = useSWR<Status>('/api/status', fetcher, { refreshInterval: 5000 });

  return (
    <div className="space-y-5">
      <AlertBanner />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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

      <LiveSpeedChart />
      <DeviceTable />
    </div>
  );
}
