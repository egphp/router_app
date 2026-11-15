/**
 * Tenda W30E firmware expresses per-device bandwidth limits (`hostDownloadLimit`,
 * `hostUploadLimit`) in integer KB/s (`0` = unlimited, `128_000` KB/s = `1000` Mbps).
 * `1 Mbps` on Tenda's scale equals `128 KB/s` (`128 * 1024 * 8 = 1,048,576 bps`).
 */

export const TENDA_KBS_PER_MBPS = 128;
export const MAX_ROUTER_KBS = 128_000;

export interface SpeedPreset {
  kbs: number;
  label: string;
  sublabel?: string;
}

export const DOWNLOAD_SPEED_PRESETS: SpeedPreset[] = [
  { kbs: 0, label: 'Unlimited', sublabel: 'مفتوح' },
  { kbs: 256, label: '256 KB/s', sublabel: 'SD · 2 Mbps' },
  { kbs: 512, label: '512 KB/s', sublabel: 'HD · 4 Mbps' },
  { kbs: 625, label: '625 KB/s', sublabel: '~5 Mbps' },
  { kbs: 1280, label: '10 Mbps', sublabel: '1,280 KB/s' },
  { kbs: 2560, label: '20 Mbps', sublabel: '2,560 KB/s' },
  { kbs: 6400, label: '50 Mbps', sublabel: '6,400 KB/s' },
];

export const UPLOAD_SPEED_PRESETS: SpeedPreset[] = [
  { kbs: 0, label: 'Unlimited', sublabel: 'مفتوح' },
  { kbs: 32, label: '32 KB/s', sublabel: '0.25 Mbps' },
  { kbs: 64, label: '64 KB/s', sublabel: 'SD · 0.5 Mbps' },
  { kbs: 128, label: '128 KB/s', sublabel: '1 Mbps' },
  { kbs: 256, label: '256 KB/s', sublabel: '2 Mbps' },
  { kbs: 640, label: '5 Mbps', sublabel: '640 KB/s' },
];

export function mbpsToKbs(mbps: number): number {
  if (!Number.isFinite(mbps) || mbps <= 0) return 0;
  return Math.min(MAX_ROUTER_KBS, Math.max(1, Math.round(mbps * TENDA_KBS_PER_MBPS)));
}

export function kbsToMbps(kbs: number): number {
  if (!Number.isFinite(kbs) || kbs <= 0) return 0;
  return Number((kbs / TENDA_KBS_PER_MBPS).toFixed(2));
}

export function formatMbpsEquivalent(kbs: number): string {
  if (!Number.isFinite(kbs) || kbs <= 0) return 'Unlimited';
  const mbps = kbs / TENDA_KBS_PER_MBPS;
  if (Number.isInteger(mbps)) return `${mbps} Mbps`;
  if (mbps >= 1) return `${mbps.toFixed(1).replace(/\.0$/, '')} Mbps`;
  return `${mbps.toFixed(2).replace(/0$/, '').replace(/\.$/, '')} Mbps`;
}

export function formatSpeedLimitKbs(kbs: number): string {
  if (!Number.isFinite(kbs) || kbs <= 0) return 'Unlimited';
  const clean = Math.round(kbs);
  return `${clean} KB/s (${formatMbpsEquivalent(clean)})`;
}

export function formatCompactKbs(kbs: number): string {
  if (!Number.isFinite(kbs) || kbs <= 0) return '∞';
  const clean = Math.round(kbs);
  if (clean >= 1280 && clean % 128 === 0) {
    return `${clean / 128}M`;
  }
  return `${clean}`;
}

export function formatDevicePolicyBadge(downKbs: number, upKbs: number): string {
  const dl = Number.isFinite(downKbs) && downKbs > 0 ? Math.round(downKbs) : 0;
  const ul = Number.isFinite(upKbs) && upKbs > 0 ? Math.round(upKbs) : 0;
  if (dl === 0 && ul === 0) return 'Unlimited';
  if (dl > 0 && ul > 0) return `↓ ${dl} · ↑ ${ul} KB/s`;
  if (dl > 0) return `↓ ${dl} KB/s`;
  return `↑ ${ul} KB/s`;
}

export function suggestIpGroupName(labelHint: string | null | undefined, ip: string | null | undefined): string {
  const cleaned = (labelHint ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned.length >= 2) {
    return cleaned.slice(0, 16).replace(/_+$/g, '');
  }
  const octets = (ip ?? '').trim().replace(/\./g, '_');
  if (!octets) return 'dev_host';
  return `dev_${octets}`.slice(0, 16).replace(/_+$/g, '');
}
