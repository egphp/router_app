export interface RouterDeviceOnline {
  ID: number;
  hostIP: string;
  hostMAC: string;
  hostName: string;
  hostRemark: string;
  hostUploadSpeed: number;
  hostDownloadSpeed: number;
  hostConnectCount: number;
  hostDownloadSum: number;
  hostConnectType: number;
  hostUploadLimit: number;
  hostDownloadLimit: number;
  onlineTime: number;
  hostAuthType: string;
  authUserName: string;
  hostOnlineStatus: 1;
}

export interface RouterDeviceOffline {
  ID: number;
  hostIP: string;
  hostMAC: string;
  hostName: string;
  hostRemark: string;
  hostDownloadSum: number;
  hostUploadLimit: number;
  hostDownloadLimit: number;
  hostOffLineTime: string;
  hostOnlineStatus: 0;
}

export type RouterDevice = RouterDeviceOnline | RouterDeviceOffline;

export interface RouterSystemStatus {
  runTime: string;
  onlineHostCount: number;
  onlineAPCount: number;
}

export interface Device {
  mac: string;
  router_id: number | null;
  hostname: string | null;
  router_remark: string | null;
  custom_label: string | null;
  vendor: string | null;
  category: string | null;
  first_seen: number;
  last_seen: number;
  is_new: 0 | 1;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface SampleRaw {
  mac: string;
  ts: number;
  ip: string | null;
  online: 0 | 1;
  up_speed_bps: number;
  down_speed_bps: number;
  down_sum_kb: number;
  sessions: number | null;
  online_seconds: number | null;
}

export interface TrafficBucket {
  mac: string;
  bucket_ts: number;
  bytes_down: number;
  bytes_up: number;
  avg_down_bps?: number | null;
  avg_up_bps?: number | null;
  peak_down_bps?: number | null;
  peak_up_bps?: number | null;
  active_sec: number;
}

export interface RouterStateRow {
  ts: number;
  uptime_sec: number;
  is_reboot: 0 | 1;
  online_count: number | null;
}

export interface Outage {
  started_at: number;
  ended_at: number | null;
  reason: 'unreachable' | 'auth_fail' | 'router_reboot';
  notes: string | null;
}

export type AlertKind = 'new_device' | 'outage' | 'reboot';

export interface Alert {
  id: number;
  kind: AlertKind;
  mac: string | null;
  payload: string | null;
  created_at: number;
  dismissed_at: number | null;
}

export type IpcMessage =
  | { type: 'samples-updated'; ts: number; deviceCount: number }
  | { type: 'alert'; alert: Alert }
  | { type: 'outage-open'; outage: Outage }
  | { type: 'outage-close'; outage: Outage }
  | { type: 'router-state'; state: RouterStateRow };
