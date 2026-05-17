const OUI_DB: Record<string, { vendor: string; category: string }> = {
  '3A:CB:5F': { vendor: 'Apple (random)', category: 'computer' },
  '2A:CB:4D': { vendor: 'Apple (random)', category: 'phone' },
  '50:DE:06': { vendor: 'Hon Hai', category: 'iot' },
  'A8:51:AB': { vendor: 'Murata', category: 'iot' },
  '66:62:8B': { vendor: 'Unknown (random)', category: 'unknown' },
  'D0:D0:03': { vendor: 'Samsung Electronics', category: 'tv' },
  'EC:81:50': { vendor: 'Apple', category: 'phone' },
  '52:A0:65': { vendor: 'Apple (random)', category: 'phone' },
  '94:D3:31': { vendor: 'Xiaomi', category: 'phone' },
  'F4:42:50': { vendor: 'Bouffalo Lab', category: 'iot' },
  '06:CA:45': { vendor: 'Apple (random)', category: 'watch' },
  '5C:AD:BA': { vendor: 'Apple', category: 'phone' },
  '5A:C2:A6': { vendor: 'Apple (random)', category: 'watch' },
  '08:A6:F7': { vendor: 'Espressif', category: 'iot' },
  '40:22:D8': { vendor: 'Espressif', category: 'iot' },
  'EC:94:CB': { vendor: 'Espressif', category: 'iot' },
  'E8:68:E7': { vendor: 'Espressif', category: 'iot' },
  'C0:5D:89': { vendor: 'Espressif', category: 'iot' },
  'C2:6B:83': { vendor: 'Apple (random)', category: 'phone' },
  'FC:3C:D7': { vendor: 'Murata', category: 'iot' },
  '6C:70:CB': { vendor: 'Samsung Electronics', category: 'phone' },
  '48:E1:5C': { vendor: 'Espressif', category: 'iot' },
  'DC:CD:2F': { vendor: 'EPSON', category: 'printer' },
  'AC:15:18': { vendor: 'Espressif', category: 'iot' },
  '42:86:79': { vendor: 'Apple (random)', category: 'phone' },
  'B6:48:C0': { vendor: 'Apple (random)', category: 'phone' },
  'B8:D4:54': { vendor: 'Tenda', category: 'router' },
  '3C:A9:AB': { vendor: 'Apple', category: 'computer' },
};

export const DEVICE_CATEGORIES = [
  'phone',
  'tablet',
  'computer',
  'tv',
  'watch',
  'camera',
  'game_console',
  'router',
  'access_point',
  'nas',
  'streaming',
  'speaker',
  'smart_home',
  'printer',
  'iot',
  'unknown',
] as const;

export interface OuiInfo {
  vendor: string;
  category: string;
}

export function lookupOui(mac: string): OuiInfo {
  if (!mac) return { vendor: 'Unknown', category: 'unknown' };
  const prefix = mac.slice(0, 8).toUpperCase();
  const hit = OUI_DB[prefix];
  if (hit) return hit;
  const firstOctet = parseInt(mac.slice(0, 2), 16);
  if (!Number.isNaN(firstOctet) && (firstOctet & 0x02)) {
    return { vendor: 'Locally administered', category: 'unknown' };
  }
  return { vendor: 'Unknown', category: 'unknown' };
}

export function categorizeByName(hostname: string | null | undefined): string | null {
  if (!hostname) return null;
  const h = normalizeName(hostname);
  if (hasAny(h, ['iphone', 'android phone', 'galaxy s', 'redmi', 'xiaomi', 'oneplus', 'oppo', 'vivo', 'huawei', 'honor', 'realme', 'pixel', 'poco', 'infinix', 'tecno'])) return 'phone';
  if (hasAny(h, ['ipad', 'tablet', 'galaxy tab', 'tab s', 'tab a', 'lenovo tab', 'mi pad', 'kindle'])) return 'tablet';
  if (hasAny(h, ['watch', 'apple watch', 'galaxy watch', 'fitbit', 'amazfit', 'mi band'])) return 'watch';
  if (hasAny(h, ['playstation', 'ps5', 'ps4', 'xbox', 'nintendo', 'switch', 'steam deck'])) return 'game_console';
  if (hasAny(h, ['camera', 'ipcam', 'ip cam', 'cctv', 'dahua', 'hikvision', 'ezviz', 'imou', 'reolink', 'tapo cam', 'yi cam', 'wyze', 'arlo', 'ring cam', 'eufycam', 'nest cam'])) return 'camera';
  if (hasAny(h, ['access point', 'access-point', 'ap ', ' ap-', 'eap', 'omada', 'unifi ap', 'ubiquiti', 'mesh', 'deco', 'repeater', 'extender', 'wap'])) return 'access_point';
  if (hasAny(h, ['router', 'gateway', 'modem', 'tenda', 'tp-link', 'tplink', 'archer', 'mikrotik', 'asusrouter', 'keenetic', 'openwrt'])) return 'router';
  if (hasAny(h, ['synology', 'qnap', 'truenas', 'freenas', 'nas', 'wdmycloud', 'wd my cloud', 'mycloud'])) return 'nas';
  if (hasAny(h, ['chromecast', 'google tv', 'fire tv', 'firetv', 'roku', 'apple tv', 'appletv', 'android tv', 'mi box', 'nvidia shield'])) return 'streaming';
  if (hasAny(h, ['sonos', 'homepod', 'echo', 'alexa', 'google home', 'nest mini', 'nest audio', 'bose', 'jbl', 'speaker', 'soundbar'])) return 'speaker';
  if (hasAny(h, ['tizen', 'webos', 'lg tv', 'lgwebostv', 'samsung tv', 'bravia', 'sony tv', 'androidtv', 'smart tv', '-tv', ' tv'])) return 'tv';
  if (hasAny(h, ['epson', 'hp printer', 'hp-', 'laserjet', 'officejet', 'canon', 'brother', 'printer', 'mfp', 'pixma'])) return 'printer';
  if (hasAny(h, ['macbook', 'imac', 'mac mini', 'macstudio', 'mac studio', 'windows', 'thinkpad', 'surface', 'laptop', 'desktop', 'pc-', 'pc ', 'workstation'])) return 'computer';
  if (h.includes('mac') && !h.includes('mac-address')) return 'computer';
  if (hasAny(h, ['smart plug', 'smartplug', 'plug', 'bulb', 'lamp', 'tuya', 'shelly', 'switchbot', 'thermostat', 'vacuum', 'roomba', 'lock', 'doorbell', 'bedroom', 'living', 'reception'])) return 'smart_home';
  if (hasAny(h, ['espressif', 'esp_', 'esp-', 'esp32', 'esp8266', 'bouffalo', 'iot'])) return 'iot';
  return null;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
