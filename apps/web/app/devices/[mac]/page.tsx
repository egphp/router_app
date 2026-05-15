import { notFound } from 'next/navigation';
import { getDevice, getDeviceStats } from '../../../lib/queries';
import { DeviceDetailClient } from '../../../components/DeviceDetailClient';

export const dynamic = 'force-dynamic';

export default async function DeviceDetailPage({ params }: { params: Promise<{ mac: string }> }) {
  const { mac } = await params;
  const macUp = decodeURIComponent(mac).toUpperCase();
  const device = getDevice(macUp);
  if (!device) notFound();
  const stats = getDeviceStats(macUp);
  return <DeviceDetailClient device={device as any} initialStats={stats} />;
}
