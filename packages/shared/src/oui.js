const OUI_DB = {
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
    'DC:CD:2F': { vendor: 'EPSON', category: 'iot' },
    'AC:15:18': { vendor: 'Espressif', category: 'iot' },
    '42:86:79': { vendor: 'Apple (random)', category: 'phone' },
    'B6:48:C0': { vendor: 'Apple (random)', category: 'phone' },
    'B8:D4:54': { vendor: 'Tenda', category: 'router' },
    '3C:A9:AB': { vendor: 'Apple', category: 'computer' },
};
export function lookupOui(mac) {
    if (!mac)
        return { vendor: 'Unknown', category: 'unknown' };
    const prefix = mac.slice(0, 8).toUpperCase();
    const hit = OUI_DB[prefix];
    if (hit)
        return hit;
    const firstOctet = parseInt(mac.slice(0, 2), 16);
    if (!Number.isNaN(firstOctet) && (firstOctet & 0x02)) {
        return { vendor: 'Locally administered', category: 'unknown' };
    }
    return { vendor: 'Unknown', category: 'unknown' };
}
export function categorizeByName(hostname) {
    if (!hostname)
        return null;
    const h = hostname.toLowerCase();
    if (h.includes('iphone'))
        return 'phone';
    if (h.includes('ipad'))
        return 'tablet';
    if (h.includes('watch'))
        return 'watch';
    if (h.includes('mac') && !h.includes('mac-address'))
        return 'computer';
    if (h.includes('redmi') || h.includes('samsung') || h.includes('xiaomi') || h.includes('oneplus'))
        return 'phone';
    if (h.includes('tizen') || h.includes('-tv'))
        return 'tv';
    if (h.includes('espressif') || h.includes('esp_') || h.includes('bouffalo'))
        return 'iot';
    if (h.includes('epson') || h.includes('hp-') || h.includes('canon'))
        return 'printer';
    if (h.includes('bedroom') || h.includes('living') || h.includes('reception'))
        return 'iot';
    return null;
}
//# sourceMappingURL=oui.js.map