import { Heatmap } from '../../components/Heatmap';
import { TopTalkers } from '../../components/TopTalkers';
import { CategoryBreakdown } from '../../components/CategoryBreakdown';
import { ConcurrentChart } from '../../components/ConcurrentChart';
import { AnomaliesCard } from '../../components/AnomaliesCard';

export const dynamic = 'force-dynamic';

export default function AnalyticsPage() {
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Analytics</h1>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <TopTalkers />
        <CategoryBreakdown />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ConcurrentChart />
        <AnomaliesCard />
      </div>
      <Heatmap title="Network-wide activity heatmap" />
    </div>
  );
}
