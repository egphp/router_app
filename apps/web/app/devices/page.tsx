import { DeviceTable } from '../../components/DeviceTable';

export const dynamic = 'force-dynamic';

export default function DevicesPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">All Devices</h1>
      <DeviceTable />
    </div>
  );
}
