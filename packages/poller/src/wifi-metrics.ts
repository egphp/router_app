import type { RouterDevice } from '@tenda/shared';

export type ConnectionKind = 'wired' | 'wifi' | 'unknown';
export type WifiBand = '2.4GHz' | '5GHz' | 'wifi' | null;
export type WifiDistanceSource = 'rssi-log-distance' | 'signal-percent-proxy' | null;

export interface WifiMetrics {
  connectType: number | null;
  connectionKind: ConnectionKind;
  wifiBand: WifiBand;
  wifiRssiDbm: number | null;
  wifiSignalPercent: number | null;
  wifiDistanceM: number | null;
  wifiDistanceSource: WifiDistanceSource;
}

const RSSI_KEYS = [
  'rssi',
  'RSSI',
  'hostRSSI',
  'hostRssi',
  'hostSignalRssi',
  'staRssi',
  'staRSSI',
  'rssiDbm',
  'rssi_dbm',
  'rxRssi',
  'relateRssi',
  'wirelessRssi',
  'wifiRssi',
];

const SIGNAL_PERCENT_KEYS = [
  'signal',
  'signalStrength',
  'signalPercent',
  'wifiSignal',
  'wirelessSignal',
  'hostSignal',
  'relateSignal',
  'quality',
];

export function extractWifiMetrics(device: RouterDevice): WifiMetrics {
  const raw = device as unknown as Record<string, unknown>;
  const connectType = parseFiniteNumber(raw.hostConnectType);
  const connectionKind = getConnectionKind(connectType);
  const wifiBand = getWifiBand(connectType);
  const rssi = readRssiDbm(raw);
  const signalPercent = readSignalPercent(raw);
  const proxiedRssi = rssi ?? signalPercentToRssi(signalPercent);
  const distance = connectionKind === 'wifi' && proxiedRssi !== null
    ? estimateWifiDistanceMeters(proxiedRssi, wifiBand)
    : null;

  return {
    connectType,
    connectionKind,
    wifiBand,
    wifiRssiDbm: rssi,
    wifiSignalPercent: signalPercent,
    wifiDistanceM: distance,
    wifiDistanceSource: distance === null ? null : rssi !== null ? 'rssi-log-distance' : 'signal-percent-proxy',
  };
}

export function estimateWifiDistanceMeters(rssiDbm: number, band: WifiBand): number | null {
  if (!Number.isFinite(rssiDbm) || rssiDbm >= 0 || rssiDbm < -110) return null;

  // Log-distance path loss model:
  //   RSSI(d) = RSSI(d0) - 10*n*log10(d/d0), with d0 = 1m.
  // Indoor residential/office WiFi is usually lossy; n=3 is a conservative default.
  const referenceRssiAtOneMeter = band === '5GHz' ? -45 : band === '2.4GHz' ? -40 : -42;
  const indoorPathLossExponent = 3;
  const distance = 10 ** ((referenceRssiAtOneMeter - rssiDbm) / (10 * indoorPathLossExponent));
  if (!Number.isFinite(distance)) return null;
  return roundTo(distance, 1);
}

function getConnectionKind(connectType: number | null): ConnectionKind {
  if (connectType === 2) return 'wired';
  if (connectType === 1 || connectType === 3 || connectType === 4) return 'wifi';
  return 'unknown';
}

function getWifiBand(connectType: number | null): WifiBand {
  if (connectType === 3) return '2.4GHz';
  if (connectType === 4) return '5GHz';
  if (connectType === 1) return 'wifi';
  return null;
}

function readRssiDbm(raw: Record<string, unknown>): number | null {
  for (const key of RSSI_KEYS) {
    const value = parseFiniteNumber(raw[key]);
    if (value === null) continue;
    const normalized = normalizeRssi(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function readSignalPercent(raw: Record<string, unknown>): number | null {
  for (const key of SIGNAL_PERCENT_KEYS) {
    const value = parseFiniteNumber(raw[key]);
    if (value === null) continue;
    if (value >= 0 && value <= 100) return roundTo(value, 1);
  }
  return null;
}

function normalizeRssi(value: number): number | null {
  if (value <= -20 && value >= -110) return roundTo(value, 1);
  // Some firmwares store RSSI as the absolute dBm threshold/value, e.g. 67 means -67 dBm.
  if (value >= 20 && value <= 110) return roundTo(-value, 1);
  return null;
}

function signalPercentToRssi(percent: number | null): number | null {
  if (percent === null) return null;
  // Common adapter-quality approximation: quality ~= 2 * (RSSI + 100).
  return roundTo(percent / 2 - 100, 1);
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundTo(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
