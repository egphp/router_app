'use client';
import { useEffect } from 'react';

/**
 * Walks the document and replaces MAC addresses + identifiable hostnames with
 * placeholder values. Triggered when the URL hash is `#__mask__` (used by
 * `deploy/take-screenshots.sh` so screenshots never expose real device IDs).
 */
export function PrivacyMask() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash !== '#__mask__') return;

    // Full MAC (AA:BB:CC:DD:EE:FF) and short MAC (DD:EE:FF — last 3 octets) regexes
    const macFull = /\b([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g;
    const macShort = /\b([0-9A-Fa-f]{2}:){2}[0-9A-Fa-f]{2}\b/g;
    let counter = 0;
    const seen = new Map<string, string>();
    const fakeMac = (real: string): string => {
      if (seen.has(real)) return seen.get(real)!;
      counter += 1;
      const hex = counter.toString(16).padStart(2, '0').toUpperCase();
      const fake = real.length <= 8 ? `XX:XX:${hex}` : `AA:BB:CC:DD:EE:${hex}`;
      seen.set(real, fake);
      return fake;
    };

    // Hostname patterns. Anything that looks like a personal identifier becomes a generic label.
    const hostnameReplacements: Array<[RegExp, string]> = [
      [/mac Studio/gi, 'workstation'],
      [/Mac Studio/g, 'Workstation'],
      [/MacBook[A-Za-z0-9_-]*/gi, 'Laptop'],
      [/iPhone[A-Za-z0-9_-]*/gi, 'Phone'],
      [/Phone17promax/gi, 'Phone'],
      [/Phone-[a-z]+/gi, 'Phone'],
      [/iPad[A-Za-z0-9_-]*/gi, 'Tablet'],
      [/Bedroom-?\d*/gi, 'Room'],
      [/Reception-?\d*/gi, 'Room'],
      [/Bouffalolab[_-]\w+/gi, 'IoT-device'],
      [/IoT-device-\w+/gi, 'IoT-device'],
      [/ESP_[A-F0-9]+/gi, 'ESP'],
      [/ESP[A-F0-9]+/g, 'ESP'],
      [/[A-Za-z0-9]+-S\d+-Ultra/g, 'Phone-A'],
      [/[A-Za-z0-9_-]*almysht[A-Za-z0-9_-]*/gi, 'workstation-B'],
      [/ghrft[A-Za-z0-9_-]*/gi, 'workstation-C'],
      [/AA:BB:CC:DD:EE:\w+/g, 'device'],
    ];

    const apply = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const updates: Array<[Text, string]> = [];
      let node = walker.nextNode() as Text | null;
      while (node) {
        let text = node.nodeValue ?? '';
        let changed = false;
        if (macFull.test(text)) {
          text = text.replace(macFull, (m) => fakeMac(m));
          changed = true;
        }
        if (macShort.test(text)) {
          text = text.replace(macShort, (m) => fakeMac(m));
          changed = true;
        }
        for (const [re, rep] of hostnameReplacements) {
          if (re.test(text)) {
            text = text.replace(re, rep);
            changed = true;
          }
        }
        if (changed) updates.push([node, text]);
        node = walker.nextNode() as Text | null;
      }
      for (const [n, t] of updates) n.nodeValue = t;
    };

    // Apply now and again after async data loads (SWR refreshes after a tick or two)
    apply();
    const t1 = setTimeout(apply, 500);
    const t2 = setTimeout(apply, 1500);
    const t3 = setTimeout(apply, 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return null;
}
