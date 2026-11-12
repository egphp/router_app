import { NetworkMap } from '../../components/NetworkMap';
import { requireServerBiometricAuth } from '../../lib/server-auth-guard';

export const dynamic = 'force-dynamic';

export default async function MapPage() {
  await requireServerBiometricAuth('/map');
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Network Map</h1>
      <NetworkMap />
    </div>
  );
}
