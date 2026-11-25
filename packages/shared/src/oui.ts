const OUI_DB: Record<string, { vendor: string; category: string }> = {
  // Existing verified local network prefixes
  '3A:CB:5F': { vendor: 'Apple (random)', category: 'computer' },
  '2A:CB:4D': { vendor: 'Apple (random)', category: 'phone' },
  '50:DE:06': { vendor: 'Hon Hai (Foxconn)', category: 'iot' },
  'A8:51:AB': { vendor: 'Murata Manufacturing', category: 'iot' },
  '66:62:8B': { vendor: 'Locally administered', category: 'unknown' },
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
  'FC:3C:D7': { vendor: 'Murata Manufacturing', category: 'iot' },
  '6C:70:CB': { vendor: 'Samsung Electronics', category: 'phone' },
  '48:E1:5C': { vendor: 'Espressif', category: 'iot' },
  'DC:CD:2F': { vendor: 'EPSON', category: 'printer' },
  'AC:15:18': { vendor: 'Espressif', category: 'iot' },
  '42:86:79': { vendor: 'Apple (random)', category: 'phone' },
  'B6:48:C0': { vendor: 'Apple (random)', category: 'phone' },
  'B8:D4:54': { vendor: 'Tenda', category: 'router' },
  '50:0F:F5': { vendor: 'Tenda', category: 'camera' },
  'B4:0F:3B': { vendor: 'Tenda', category: 'camera' },
  '88:00:33': { vendor: 'AICsemi (camera fallback)', category: 'camera' },
  '3C:A9:AB': { vendor: 'Apple', category: 'computer' },

  // Expanded Apple (Mac, iPhone, iPad, Apple TV, HomePod)
  '00:1C:B3': { vendor: 'Apple', category: 'computer' },
  '14:98:77': { vendor: 'Apple', category: 'computer' },
  '28:CF:E9': { vendor: 'Apple', category: 'computer' },
  '38:F9:D3': { vendor: 'Apple', category: 'computer' },
  '4C:20:B8': { vendor: 'Apple', category: 'phone' },
  '50:ED:3C': { vendor: 'Apple', category: 'computer' },
  '60:03:08': { vendor: 'Apple', category: 'computer' },
  '68:DB:F5': { vendor: 'Apple', category: 'phone' },
  '70:56:81': { vendor: 'Apple', category: 'computer' },
  '7C:04:D0': { vendor: 'Apple', category: 'phone' },
  '88:66:5A': { vendor: 'Apple', category: 'computer' },
  '90:9C:4A': { vendor: 'Apple', category: 'computer' },
  'A4:83:E7': { vendor: 'Apple', category: 'computer' },
  'AC:BC:32': { vendor: 'Apple', category: 'computer' },
  'B0:BE:83': { vendor: 'Apple', category: 'phone' },
  'BC:D0:74': { vendor: 'Apple', category: 'computer' },
  'C8:89:F3': { vendor: 'Apple', category: 'computer' },
  'D0:81:7A': { vendor: 'Apple', category: 'computer' },
  'DC:A9:04': { vendor: 'Apple', category: 'computer' },
  'E0:B5:5F': { vendor: 'Apple', category: 'phone' },
  'F0:18:98': { vendor: 'Apple', category: 'computer' },
  'F8:FF:C2': { vendor: 'Apple', category: 'computer' },

  // Samsung (Phones & Smart TVs)
  '00:16:32': { vendor: 'Samsung Electronics', category: 'tv' },
  '14:49:E0': { vendor: 'Samsung Electronics', category: 'phone' },
  '24:4B:03': { vendor: 'Samsung Electronics', category: 'tv' },
  '38:01:95': { vendor: 'Samsung Electronics', category: 'tv' },
  '48:44:F7': { vendor: 'Samsung Electronics', category: 'tv' },
  '50:85:69': { vendor: 'Samsung Electronics', category: 'tv' },
  '64:1C:AE': { vendor: 'Samsung Electronics', category: 'tv' },
  '78:BD:BC': { vendor: 'Samsung Electronics', category: 'tv' },
  '84:A4:66': { vendor: 'Samsung Electronics', category: 'phone' },
  '8C:79:F5': { vendor: 'Samsung Electronics', category: 'tv' },
  '98:06:3C': { vendor: 'Samsung Electronics', category: 'phone' },
  'AC:5A:FC': { vendor: 'Samsung Electronics', category: 'tv' },
  'BC:14:85': { vendor: 'Samsung Electronics', category: 'tv' },
  'CC:6E:A4': { vendor: 'Samsung Electronics', category: 'tv' },
  'E4:7D:BD': { vendor: 'Samsung Electronics', category: 'tv' },
  'FC:A6:CD': { vendor: 'Samsung Electronics', category: 'phone' },

  // LG / Sony / TCL / Hisense Smart TVs & Consoles
  '00:E0:91': { vendor: 'LG Electronics', category: 'tv' },
  '10:68:3F': { vendor: 'LG Electronics', category: 'tv' },
  '38:8C:50': { vendor: 'LG Electronics', category: 'tv' },
  '58:FD:B1': { vendor: 'LG Electronics', category: 'tv' },
  '64:BC:0C': { vendor: 'LG Electronics', category: 'tv' },
  '78:5D:C8': { vendor: 'LG Electronics', category: 'tv' },
  'A8:23:FE': { vendor: 'LG Electronics', category: 'tv' },
  'FC:F1:52': { vendor: 'Sony', category: 'tv' },
  '00:D9:D1': { vendor: 'Sony Interactive', category: 'game_console' },
  '70:9E:29': { vendor: 'Sony Interactive', category: 'game_console' },
  'BC:60:A7': { vendor: 'Sony Interactive', category: 'game_console' },
  'C8:63:F1': { vendor: 'Sony Interactive', category: 'game_console' },
  '28:18:78': { vendor: 'Microsoft Xbox', category: 'game_console' },
  '60:45:BD': { vendor: 'Microsoft', category: 'game_console' },
  '7C:BB:8A': { vendor: 'Nintendo', category: 'game_console' },
  '98:B6:E9': { vendor: 'Nintendo', category: 'game_console' },
  'D8:1F:12': { vendor: 'TCL / Tuya', category: 'smart_home' },
  '40:CD:7A': { vendor: 'Hisense', category: 'tv' },

  // Xiaomi / Oppo / Realme / Vivo / Huawei / Honor / Google
  '04:CF:8C': { vendor: 'Xiaomi', category: 'smart_home' },
  '28:6C:07': { vendor: 'Xiaomi', category: 'phone' },
  '34:CE:00': { vendor: 'Xiaomi', category: 'smart_home' },
  '50:EC:50': { vendor: 'Xiaomi', category: 'smart_home' },
  '64:90:C1': { vendor: 'Xiaomi', category: 'phone' },
  '78:11:DC': { vendor: 'Xiaomi', category: 'smart_home' },
  'B0:E2:35': { vendor: 'Xiaomi', category: 'phone' },
  'F8:A4:5F': { vendor: 'Xiaomi', category: 'phone' },
  '1C:48:CE': { vendor: 'Oppo', category: 'phone' },
  '84:9F:B5': { vendor: 'Oppo / Realme', category: 'phone' },
  'A4:50:46': { vendor: 'Xiaomi', category: 'phone' },
  '48:DB:50': { vendor: 'Huawei', category: 'phone' },
  '70:8C:B6': { vendor: 'Huawei', category: 'phone' },
  '88:CE:FA': { vendor: 'Huawei', category: 'router' },
  'F4:F5:D8': { vendor: 'Google', category: 'streaming' },
  '54:60:09': { vendor: 'Google', category: 'speaker' },
  '3C:5A:B4': { vendor: 'Google', category: 'phone' },

  // Cameras & NVR (Hikvision, Dahua, Tenda, Reolink, EZVIZ, Tapo)
  '18:68:CB': { vendor: 'Hikvision', category: 'camera' },
  '28:57:BE': { vendor: 'Hikvision', category: 'camera' },
  '44:19:B6': { vendor: 'Hikvision', category: 'camera' },
  '4C:BD:8F': { vendor: 'Hikvision', category: 'camera' },
  '54:C4:15': { vendor: 'Hikvision', category: 'camera' },
  '64:DB:8B': { vendor: 'Hikvision', category: 'camera' },
  '80:7C:62': { vendor: 'Hikvision', category: 'camera' },
  'A4:14:37': { vendor: 'Hikvision', category: 'camera' },
  'BC:AD:28': { vendor: 'Hikvision', category: 'camera' },
  'C0:56:E3': { vendor: 'Hikvision', category: 'camera' },
  'E0:50:8B': { vendor: 'Dahua', category: 'camera' },
  '3C:EF:8C': { vendor: 'Dahua', category: 'camera' },
  '90:02:A9': { vendor: 'Dahua', category: 'camera' },
  'EC:71:DB': { vendor: 'Reolink', category: 'camera' },
  'C8:3A:35': { vendor: 'Tenda', category: 'router' },
  '04:95:E6': { vendor: 'Tenda', category: 'router' },
  'D8:32:14': { vendor: 'Tenda', category: 'camera' },
  '58:D5:6E': { vendor: 'Tenda', category: 'router' },

  // IoT / ESP / Tuya / Smart Home
  '24:0A:C4': { vendor: 'Espressif', category: 'iot' },
  '24:6F:28': { vendor: 'Espressif', category: 'iot' },
  '30:AE:A4': { vendor: 'Espressif', category: 'iot' },
  '34:86:5D': { vendor: 'Espressif', category: 'iot' },
  '3C:71:BF': { vendor: 'Espressif', category: 'iot' },
  '5C:CF:7F': { vendor: 'Espressif', category: 'iot' },
  '7C:9E:BD': { vendor: 'Espressif', category: 'iot' },
  '84:CC:A8': { vendor: 'Espressif', category: 'iot' },
  '84:F3:EB': { vendor: 'Espressif', category: 'iot' },
  '94:B9:7E': { vendor: 'Espressif', category: 'iot' },
  'A0:20:A6': { vendor: 'Espressif', category: 'iot' },
  'A4:CF:12': { vendor: 'Espressif', category: 'iot' },
  'B4:E6:2D': { vendor: 'Espressif', category: 'iot' },
  'CC:50:E3': { vendor: 'Espressif', category: 'iot' },
  'DC:4F:22': { vendor: 'Espressif', category: 'iot' },
  '50:8A:06': { vendor: 'Tuya Smart', category: 'smart_home' },
  '68:57:2D': { vendor: 'Tuya Smart', category: 'smart_home' },
  '7C:F6:66': { vendor: 'Tuya Smart', category: 'smart_home' },
  '84:E3:42': { vendor: 'Tuya Smart', category: 'smart_home' },
  'A0:92:08': { vendor: 'Tuya Smart', category: 'smart_home' },
  'D4:A6:51': { vendor: 'Tuya Smart', category: 'smart_home' },

  // Printers (Epson, HP, Brother, Canon)
  '00:26:AB': { vendor: 'EPSON', category: 'printer' },
  '44:D2:44': { vendor: 'EPSON', category: 'printer' },
  '64:EB:8C': { vendor: 'EPSON', category: 'printer' },
  'A4:EE:57': { vendor: 'EPSON', category: 'printer' },
  'AC:18:26': { vendor: 'EPSON', category: 'printer' },
  'F8:D0:27': { vendor: 'EPSON', category: 'printer' },
  '30:E1:71': { vendor: 'HP', category: 'printer' },
  '68:B5:99': { vendor: 'HP', category: 'printer' },
  'A0:B3:CC': { vendor: 'HP', category: 'printer' },
  '00:80:77': { vendor: 'Brother', category: 'printer' },
  '30:05:5C': { vendor: 'Brother', category: 'printer' },
  '18:0C:AC': { vendor: 'Canon', category: 'printer' },
  '84:BA:3B': { vendor: 'Canon', category: 'printer' },

  // PCs / Servers / NAS / Networking (Intel, Realtek, Raspberry Pi, Synology, TP-Link, Ubiquiti)
  '00:11:32': { vendor: 'Synology', category: 'nas' },
  '90:09:D0': { vendor: 'Synology', category: 'nas' },
  '24:5E:BE': { vendor: 'QNAP', category: 'nas' },
  'B8:27:EB': { vendor: 'Raspberry Pi', category: 'computer' },
  'DC:A6:32': { vendor: 'Raspberry Pi', category: 'computer' },
  'E4:5F:01': { vendor: 'Raspberry Pi', category: 'computer' },
  '2C:CF:67': { vendor: 'Raspberry Pi', category: 'computer' },
  '00:E0:4C': { vendor: 'Realtek', category: 'computer' },
  '00:D8:61': { vendor: 'Micro-Star (MSI)', category: 'computer' },
  '04:D9:F5': { vendor: 'ASUS', category: 'computer' },
  '18:C0:4D': { vendor: 'Gigabyte', category: 'computer' },
  '3C:97:0E': { vendor: 'Wistron / Lenovo', category: 'computer' },
  '8C:8C:AA': { vendor: 'Intel', category: 'computer' },
  'A4:34:D9': { vendor: 'Intel', category: 'computer' },
  'DC:21:5C': { vendor: 'Intel', category: 'computer' },
  '50:C7:BF': { vendor: 'TP-Link', category: 'access_point' },
  '60:32:B1': { vendor: 'TP-Link', category: 'access_point' },
  'B0:BE:76': { vendor: 'TP-Link', category: 'access_point' },
  '24:5A:4C': { vendor: 'Ubiquiti', category: 'access_point' },
  '78:8A:20': { vendor: 'Ubiquiti', category: 'access_point' },
  'F0:9F:C2': { vendor: 'Ubiquiti', category: 'access_point' },
};

/**
 * AICsemi AIC8800 Wi-Fi chipset (used inside Tenda CP3 V3.0 cameras) falls back
 * to a hardcoded 4-byte prefix `88:00:33:77:XX:XX` + 2 random bytes on boot
 * whenever reading the factory EFUSE MAC times out during power-up.
 */
export function isAic8800FallbackMac(mac: string | null | undefined): boolean {
  if (!mac || typeof mac !== 'string') return false;
  return /^88:00:33:77:[0-9A-F]{2}:[0-9A-F]{2}$/i.test(mac.trim());
}

/**
 * IEEE 802 locally-administered bit (`0x02` on first octet):
 * indicates iOS/Android/macOS Wi-Fi Private Address randomization unless matched by known hardware prefix.
 */
export function isLocallyAdministeredMac(mac: string | null | undefined): boolean {
  if (!mac || typeof mac !== 'string') return false;
  const clean = mac.trim().toUpperCase();
  if (isAic8800FallbackMac(clean)) return false;
  const firstOctet = parseInt(clean.slice(0, 2), 16);
  return !Number.isNaN(firstOctet) && (firstOctet & 0x02) !== 0;
}

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
  if (prefix === 'E0:CA:3C' || prefix === '98:8B:0A') {
    return { vendor: 'Hikvision', category: 'camera' };
  }
  const hit = OUI_DB[prefix];
  if (hit) return hit;
  if (isLocallyAdministeredMac(mac)) {
    return { vendor: 'Locally administered', category: 'unknown' };
  }
  return { vendor: 'Unknown', category: 'unknown' };
}

/**
 * Returns true for LAN infrastructure / IP cameras (`camera`, `router`, `access_point`)
 * whose local RTSP streams or Layer-2.5 repeater proxy traffic should be excluded from
 * user internet quota & headline network totals.
 */
export function isLocalInfraCategory(category: string | null | undefined): boolean {
  if (!category) return false;
  const c = category.trim().toLowerCase();
  return c === 'camera' || c === 'router' || c === 'access_point';
}

export function categorizeByName(hostname: string | null | undefined): string | null {
  if (!hostname) return null;
  const h = normalizeName(hostname);
  if (hasAny(h, ['iphone', 'android phone', 'galaxy s', 'galaxy a', 'redmi', 'xiaomi', 'oneplus', 'oppo', 'vivo', 'huawei', 'honor', 'realme', 'pixel', 'poco', 'infinix', 'tecno'])) return 'phone';
  if (hasAny(h, ['ipad', 'tablet', 'galaxy tab', 'tab s', 'tab a', 'lenovo tab', 'mi pad', 'kindle'])) return 'tablet';
  if (hasAny(h, ['watch', 'apple watch', 'galaxy watch', 'fitbit', 'amazfit', 'mi band'])) return 'watch';
  if (hasAny(h, ['playstation', 'ps5', 'ps4', 'xbox', 'nintendo', 'switch', 'steam deck'])) return 'game_console';
  if (h === 'ipc' || h.startsWith('ipc ') || h.startsWith('ipc-')) return 'camera';
  if (hasAny(h, ['camera', 'ipcam', 'ip cam', 'cctv', 'dahua', 'hikvision', 'ezviz', 'imou', 'reolink', 'tapo cam', 'yi cam', 'wyze', 'arlo', 'ring cam', 'eufycam', 'nest cam', 'cp3', 'frigate'])) return 'camera';
  if (hasAny(h, ['access point', 'access-point', 'ap ', ' ap-', 'eap', 'omada', 'unifi ap', 'ubiquiti', 'mesh', 'deco', 'repeater', 'extender', 'wap'])) return 'access_point';
  if (hasAny(h, ['router', 'gateway', 'modem', 'tenda', 'tp-link', 'tplink', 'archer', 'mikrotik', 'asusrouter', 'keenetic', 'openwrt'])) return 'router';
  if (hasAny(h, ['synology', 'qnap', 'truenas', 'freenas', 'nas', 'wdmycloud', 'wd my cloud', 'mycloud', 'ppeto'])) return 'nas';
  if (hasAny(h, ['chromecast', 'google tv', 'fire tv', 'firetv', 'roku', 'apple tv', 'appletv', 'android tv', 'mi box', 'nvidia shield'])) return 'streaming';
  if (hasAny(h, ['sonos', 'homepod', 'echo', 'alexa', 'google home', 'nest mini', 'nest audio', 'bose', 'jbl', 'speaker', 'soundbar'])) return 'speaker';
  if (hasAny(h, ['tizen', 'webos', 'lg tv', 'lgwebostv', 'samsung tv', 'bravia', 'sony tv', 'androidtv', 'smart tv', '-tv', ' tv', 'hisense', 'tcl'])) return 'tv';
  if (hasAny(h, ['epson', 'hp printer', 'hp-', 'laserjet', 'officejet', 'canon', 'brother', 'printer', 'mfp', 'pixma'])) return 'printer';
  if (hasAny(h, ['macbook', 'imac', 'mac mini', 'macstudio', 'mac studio', 'windows', 'thinkpad', 'surface', 'laptop', 'desktop', 'pc-', 'pc ', 'workstation', 'ubuntu'])) return 'computer';
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
