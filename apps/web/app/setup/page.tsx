import { SetupClient } from '../../components/SetupClient';

export const dynamic = 'force-dynamic';

export default function SetupPage() {
  const configured = (process.env.ROUTER_PASSWORD ?? '').trim().length > 0;
  return <SetupClient alreadyConfigured={configured} />;
}
