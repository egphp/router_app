export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function parseRouterUptime(s: string): number {
  let total = 0;
  const re = /(\d+)([dhms])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = Number(m[1]);
    switch (m[2]) {
      case 'd': total += n * 86400; break;
      case 'h': total += n * 3600; break;
      case 'm': total += n * 60; break;
      case 's': total += n; break;
    }
  }
  return total;
}

export function bucket5Min(ts: number): number {
  return Math.floor(ts / (5 * MIN)) * (5 * MIN);
}

export function bucketHour(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

export function bucketDay(ts: number, tzOffsetMin = new Date().getTimezoneOffset()): number {
  const off = tzOffsetMin * MIN;
  return Math.floor((ts - off) / DAY) * DAY + off;
}

export function bucketMonth(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

export function formatBps(bps: number): string {
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 ** 2).toFixed(2)} MB/s`;
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
