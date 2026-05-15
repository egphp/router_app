import { NetworkMap } from '../../components/NetworkMap';

export const dynamic = 'force-dynamic';

export default function MapPage() {
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Network Map</h1>
      <NetworkMap />
    </div>
  );
}
