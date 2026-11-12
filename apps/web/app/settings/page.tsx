import { SettingsClient } from '../../components/SettingsClient';
import { requireServerBiometricAuth } from '../../lib/server-auth-guard';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await requireServerBiometricAuth('/settings');
  return <SettingsClient />;
}
