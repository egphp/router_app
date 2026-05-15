export function formatBytes(bytes: number, fixed = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(fixed)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(fixed)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

export function formatBps(bps: number, fixed = 1): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0 B/s';
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(fixed)} KB/s`;
  if (bps < 1024 ** 3) return `${(bps / 1024 ** 2).toFixed(2)} MB/s`;
  return `${(bps / 1024 ** 3).toFixed(2)} GB/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatMacShort(mac: string): string {
  return mac.slice(-8);
}

export function categoryIcon(cat: string | null | undefined): string {
  switch ((cat || '').toLowerCase()) {
    case 'phone': return '📱';
    case 'tablet': return '📱';
    case 'computer': return '💻';
    case 'tv': return '📺';
    case 'watch': return '⌚';
    case 'iot': return '🔌';
    case 'printer': return '🖨️';
    case 'router': return '📡';
    default: return '❔';
  }
}

export function timeAgo(ts: number, now = Date.now()): string {
  const diffSec = Math.floor((now - ts) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
