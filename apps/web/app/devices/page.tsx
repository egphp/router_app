import { DeviceTable } from '../../components/DeviceTable';
import { requireServerBiometricAuth } from '../../lib/server-auth-guard';

export const dynamic = 'force-dynamic';

export default async function DevicesPage() {
  await requireServerBiometricAuth('/devices');
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">All Devices</h1>
      <DeviceTable />
    </div>
  );
}
