import type Database from 'better-sqlite3';

export interface SanitizedDeviceDescriptor {
  token: string;
  vendor: string | null;
  category: string | null;
  locallyAdministeredMac: boolean;
}

const MAC_REGEX = /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g;
const IPV4_REGEX = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/**
 * Zero-PII Bidirectional Sanitizer Gateway (`AGENTS.md` compliance):
 * - Replaces every real MAC address (`AA:BB:CC:DD:EE:FF` -> `DEV_01`), IPv4 address (`192.168.0.x` / public WAN IP -> `IP_01`),
 *   DDNS hostnames (`DDNS_01`), and personal device labels/hostnames (`DEV_01 (Apple · computer)`) BEFORE sending context to Gemini.
 * - Restores local labels/MACs/IPs inside server memory before returning responses to the authenticated owner UI or Telegram chat.
 */
export class PiiSessionSanitizer {
  private readonly macToToken = new Map<string, string>();
  private readonly tokenToMac = new Map<string, string>();
  private readonly tokenToDisplay = new Map<string, string>();
  private readonly ipToToken = new Map<string, string>();
  private readonly tokenToIp = new Map<string, string>();
  private readonly secretLiterals = new Map<string, string>();
  private readonly reverseLiterals = new Map<string, string>();

  private devSeq = 0;
  private ipSeq = 0;
  private hostSeq = 0;

  constructor(db?: Database.Database) {
    if (db) {
      this.preloadFromDb(db);
    }
    this.registerEnvSecrets();
  }

  private registerEnvSecrets(): void {
    for (const envKey of [
      'ROUTER_PASSWORD',
      'TENDA_PANEL_SESSION_SECRET',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'CF_API_TOKEN',
      'CLOUDFLARE_API_TOKEN',
    ]) {
      const val = (process.env[envKey] ?? '').trim();
      if (val.length >= 6) {
        this.secretLiterals.set(val, '[REDACTED_SECRET]');
      }
    }
  }

  private preloadFromDb(db: Database.Database): void {
    try {
      const devices = db.prepare(`
        SELECT mac, hostname, router_remark, custom_label, vendor, category
        FROM devices
        ORDER BY first_seen ASC
      `).all() as Array<{
        mac: string;
        hostname: string | null;
        router_remark: string | null;
        custom_label: string | null;
        vendor: string | null;
        category: string | null;
      }>;
      for (const d of devices) {
        const token = this.registerMac(d.mac, d.custom_label || d.router_remark || d.hostname || d.mac);
        for (const name of [d.custom_label, d.router_remark, d.hostname]) {
          const clean = (name ?? '').trim();
          // Only alias non-generic names (>= 3 chars) that aren't plain category words
          if (clean.length >= 3 && !/^(unknown|device|router|phone|tv|pc|ipc)$/i.test(clean)) {
            this.secretLiterals.set(clean, `${token}`);
            if (!this.reverseLiterals.has(token)) {
              this.reverseLiterals.set(token, clean);
            }
          }
        }
      }
    } catch {
      // Schema may still be initializing in isolated unit tests
    }

    try {
      const wans = db.prepare(`
        SELECT wan_id, wan_ip, public_ip, ddns_fqdn FROM router_wan_ports
      `).all() as Array<{
        wan_id: number;
        wan_ip: string | null;
        public_ip: string | null;
        ddns_fqdn: string | null;
      }>;
      for (const w of wans) {
        if (w.wan_ip) this.registerIp(w.wan_ip, `WAN${w.wan_id}_GW_IP`);
        if (w.public_ip) this.registerIp(w.public_ip, `WAN${w.wan_id}_PUB_IP`);
        if (w.ddns_fqdn && w.ddns_fqdn.trim().length > 3) {
          const fqdn = w.ddns_fqdn.trim();
          const tok = `DDNS_WAN${w.wan_id}`;
          this.secretLiterals.set(fqdn, tok);
          this.reverseLiterals.set(tok, fqdn);
        }
      }
    } catch {
      // Optional table
    }
  }

  registerMac(macRaw: string, displayLabel?: string | null): string {
    const mac = macRaw.trim().toUpperCase();
    const existing = this.macToToken.get(mac);
    if (existing) {
      if (displayLabel && !this.tokenToDisplay.has(existing)) {
        this.tokenToDisplay.set(existing, displayLabel);
      }
      return existing;
    }
    this.devSeq += 1;
    const token = `DEV_${String(this.devSeq).padStart(2, '0')}`;
    this.macToToken.set(mac, token);
    this.tokenToMac.set(token, mac);
    if (displayLabel && displayLabel.trim()) {
      this.tokenToDisplay.set(token, displayLabel.trim());
    }
    return token;
  }

  registerIp(ipRaw: string, customToken?: string): string {
    const ip = ipRaw.trim();
    const existing = this.ipToToken.get(ip);
    if (existing) return existing;
    const token = customToken ?? `IP_${String(++this.ipSeq).padStart(2, '0')}`;
    this.ipToToken.set(ip, token);
    this.tokenToIp.set(token, ip);
    return token;
  }

  registerHostname(hostRaw: string): string {
    const clean = hostRaw.trim();
    if (!clean) return '';
    const existing = this.secretLiterals.get(clean);
    if (existing) return existing;
    const token = `HOST_${String(++this.hostSeq).padStart(2, '0')}`;
    this.secretLiterals.set(clean, token);
    this.reverseLiterals.set(token, clean);
    return token;
  }

  resolveMacToken(tokenOrMac: string): string | null {
    const clean = tokenOrMac.trim().toUpperCase();
    if (this.tokenToMac.has(clean)) return this.tokenToMac.get(clean)!;
    if (/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(clean)) return clean;
    return null;
  }

  resolveIpToken(tokenOrIp: string): string | null {
    const clean = tokenOrIp.trim();
    if (this.tokenToIp.has(clean)) return this.tokenToIp.get(clean)!;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(clean)) return clean;
    return null;
  }

  sanitizeText(input: string): string {
    if (!input) return input;
    let out = input;

    // 1. Replace exact registered secrets / hostnames / DDNS FQDNs (longest first)
    const entries = [...this.secretLiterals.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [literal, replacement] of entries) {
      if (literal && out.includes(literal)) {
        out = out.split(literal).join(replacement);
      }
    }

    // 2. Replace any MAC addresses (case-insensitive)
    out = out.replace(MAC_REGEX, (match) => this.registerMac(match));

    // 3. Replace any IPv4 addresses
    out = out.replace(IPV4_REGEX, (match) => this.registerIp(match));

    return out;
  }

  sanitizeValue<T>(value: T): T {
    if (value == null) return value;
    if (typeof value === 'string') {
      return this.sanitizeText(value) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item)) as unknown as T;
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (/password|secret|private_key|auth_token|bot_token/i.test(k)) {
          out[k] = '[REDACTED]';
        } else {
          out[k] = this.sanitizeValue(v);
        }
      }
      return out as T;
    }
    return value;
  }

  /**
   * Restores local human-friendly device names, IPs, and MACs on incoming AI text
   * so the owner sees real names in the dashboard / Telegram without ever having sent them to the cloud.
   */
  detokenizeText(input: string, opts: { preferLabelOverMac?: boolean } = {}): string {
    if (!input) return input;
    const preferLabel = opts.preferLabelOverMac ?? true;
    let out = input;

    // Replace DEV_XX tokens (longest first to avoid DEV_1 matching DEV_10)
    const devTokens = [...this.tokenToMac.keys()].sort((a, b) => b.length - a.length);
    for (const tok of devTokens) {
      if (!out.includes(tok)) continue;
      const mac = this.tokenToMac.get(tok)!;
      const label = this.tokenToDisplay.get(tok);
      const replacement = preferLabel && label ? label : mac;
      out = out.split(tok).join(replacement);
    }

    const ipTokens = [...this.tokenToIp.keys()].sort((a, b) => b.length - a.length);
    for (const tok of ipTokens) {
      if (!out.includes(tok)) continue;
      out = out.split(tok).join(this.tokenToIp.get(tok)!);
    }

    const hostTokens = [...this.reverseLiterals.keys()].sort((a, b) => b.length - a.length);
    for (const tok of hostTokens) {
      if (!out.includes(tok)) continue;
      if (this.tokenToMac.has(tok)) continue; // Already handled above
      out = out.split(tok).join(this.reverseLiterals.get(tok)!);
    }

    return out;
  }
}
