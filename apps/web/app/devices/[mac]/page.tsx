import { notFound } from 'next/navigation';
import { getDevice, getDeviceStats, getDeviceSessions, getDeviceDailyUsage } from '../../../lib/queries';
import { DeviceDetailClient } from '../../../components/DeviceDetailClient';
import { requireServerBiometricAuth } from '../../../lib/server-auth-guard';

export const dynamic = 'force-dynamic';

export default async function DeviceDetailPage({ params }: { params: Promise<{ mac: string }> }) {
  const { mac } = await params;
  await requireServerBiometricAuth(`/devices/${encodeURIComponent(mac)}`);
  const macUp = decodeURIComponent(mac).toUpperCase();
  const device = getDevice(macUp);
  if (!device) notFound();
  const stats = getDeviceStats(macUp);
  const sessions = getDeviceSessions(macUp);
  const dailyUsage = getDeviceDailyUsage(macUp, 365);
  return <DeviceDetailClient device={device as any} initialStats={stats} initialSessions={sessions as any} dailyUsage={dailyUsage} />;
}
