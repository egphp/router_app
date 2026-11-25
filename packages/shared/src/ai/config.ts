import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { resolveRepoRoot } from '../config.js';

export interface AiSettingsState {
  configured: boolean;
  keySource: 'env' | 'db' | 'none';
  maskedKey: string | null;
  enabled: boolean;
  domainClassifierEnabled: boolean;
  deviceProfilerEnabled: boolean;
  securityTriageEnabled: boolean;
  morningBriefEnabled: boolean;
  morningBriefHour: number;
  wan1QuotaGb: number;
  wan2QuotaGb: number;
  billingRenewalDay: number;
}

const KEY_ENC_SETTING = 'ai.gemini_api_key_enc';
const ENABLED_SETTING = 'ai.enabled';
const DOMAIN_CLASSIFIER_SETTING = 'ai.domain_classifier_enabled';
const DEVICE_PROFILER_SETTING = 'ai.device_profiler_enabled';
const SECURITY_TRIAGE_SETTING = 'ai.security_triage_enabled';
const MORNING_BRIEF_SETTING = 'ai.morning_brief_enabled';
const MORNING_BRIEF_HOUR_SETTING = 'ai.morning_brief_hour';
const WAN1_QUOTA_GB_SETTING = 'ai.wan_quota_gb_wan1';
const WAN2_QUOTA_GB_SETTING = 'ai.wan_quota_gb_wan2';
const BILLING_RENEWAL_DAY_SETTING = 'ai.billing_renewal_day';

function readRepoEnvKey(key: string): string {
  const live = process.env[key];
  if (typeof live === 'string' && live.trim()) return live.trim();
  try {
    const content = fs.readFileSync(path.join(resolveRepoRoot(), '.env'), 'utf8');
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = content.match(new RegExp(`^${escaped}=(.*)$`, 'm'));
    return m?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

function candidateVaultKeys(): Buffer[] {
  const seeds = [
    readRepoEnvKey('TENDA_PANEL_SESSION_SECRET'),
    readRepoEnvKey('ROUTER_PASSWORD'),
    `tenda-local-ai-vault:${os.hostname()}:${os.userInfo().username}`,
  ].filter((s) => s.length > 0);
  const uniqueSeeds = [...new Set(seeds)];
  return uniqueSeeds.map((seed) => crypto.createHash('sha256').update(`tenda-ai-key-v1:${seed}`).digest());
}

export function encryptApiKeyForDb(plainKey: string): string {
  const key = candidateVaultKeys()[0]!;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
}

export function decryptApiKeyFromDb(payload: string | null | undefined): string | null {
  if (!payload || typeof payload !== 'string') return null;
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const enc = Buffer.from(parts[3], 'base64url');
  for (const key of candidateVaultKeys()) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8').trim();
      if (plain.length > 0) return plain;
    } catch {
      // Try next deterministic local vault key candidate
    }
  }
  return null;
}

export function maskApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const clean = key.trim();
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)}••••••••${clean.slice(-4)}`;
}

function readSetting(db: Database.Database, key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value?: string } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  } catch {
    return null;
  }
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function parseBool(raw: string | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return fallback;
}

function parseNum(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Resolves the active Gemini API key:
 * 1. `process.env.GEMINI_API_KEY` (`.env` priority)
 * 2. Encrypted `settings` value `ai.gemini_api_key_enc`
 */
export function resolveGeminiApiKey(db?: Database.Database): {
  apiKey: string | null;
  source: 'env' | 'db' | 'none';
} {
  const envKey = (readRepoEnvKey('GEMINI_API_KEY') || readRepoEnvKey('GOOGLE_API_KEY')).trim();
  if (envKey.length >= 12) {
    return { apiKey: envKey, source: 'env' };
  }
  if (db) {
    const enc = readSetting(db, KEY_ENC_SETTING);
    const dbKey = decryptApiKeyFromDb(enc);
    if (dbKey && dbKey.length >= 12) {
      return { apiKey: dbKey, source: 'db' };
    }
  }
  return { apiKey: null, source: 'none' };
}

export function getAiSettings(db: Database.Database): AiSettingsState {
  const { apiKey, source } = resolveGeminiApiKey(db);
  return {
    configured: Boolean(apiKey),
    keySource: source,
    maskedKey: maskApiKey(apiKey),
    enabled: parseBool(readSetting(db, ENABLED_SETTING), true),
    domainClassifierEnabled: parseBool(readSetting(db, DOMAIN_CLASSIFIER_SETTING), true),
    deviceProfilerEnabled: parseBool(readSetting(db, DEVICE_PROFILER_SETTING), true),
    securityTriageEnabled: parseBool(readSetting(db, SECURITY_TRIAGE_SETTING), true),
    morningBriefEnabled: parseBool(readSetting(db, MORNING_BRIEF_SETTING), true),
    morningBriefHour: Math.trunc(parseNum(readSetting(db, MORNING_BRIEF_HOUR_SETTING), 9, 0, 23)),
    wan1QuotaGb: parseNum(readSetting(db, WAN1_QUOTA_GB_SETTING), 250, 0, 100_000),
    wan2QuotaGb: parseNum(readSetting(db, WAN2_QUOTA_GB_SETTING), 250, 0, 100_000),
    billingRenewalDay: Math.trunc(parseNum(readSetting(db, BILLING_RENEWAL_DAY_SETTING), 1, 1, 31)),
  };
}

export function isAiReady(db: Database.Database, moduleKey?: 'domain' | 'profiler' | 'security' | 'brief'): boolean {
  const cfg = getAiSettings(db);
  if (!cfg.configured || !cfg.enabled) return false;
  if (moduleKey === 'domain') return cfg.domainClassifierEnabled;
  if (moduleKey === 'profiler') return cfg.deviceProfilerEnabled;
  if (moduleKey === 'security') return cfg.securityTriageEnabled;
  if (moduleKey === 'brief') return cfg.morningBriefEnabled;
  return true;
}

export interface UpdateAiSettingsInput {
  apiKey?: string | null;
  clearSavedKey?: boolean;
  enabled?: boolean;
  domainClassifierEnabled?: boolean;
  deviceProfilerEnabled?: boolean;
  securityTriageEnabled?: boolean;
  morningBriefEnabled?: boolean;
  morningBriefHour?: number;
  wan1QuotaGb?: number;
  wan2QuotaGb?: number;
  billingRenewalDay?: number;
}

export function updateAiSettings(db: Database.Database, patch: UpdateAiSettingsInput): AiSettingsState {
  const txn = db.transaction(() => {
    if (patch.clearSavedKey) {
      db.prepare(`DELETE FROM settings WHERE key = ?`).run(KEY_ENC_SETTING);
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim().length >= 12) {
      writeSetting(db, KEY_ENC_SETTING, encryptApiKeyForDb(patch.apiKey.trim()));
    }
    if (typeof patch.enabled === 'boolean') writeSetting(db, ENABLED_SETTING, patch.enabled ? 'on' : 'off');
    if (typeof patch.domainClassifierEnabled === 'boolean') {
      writeSetting(db, DOMAIN_CLASSIFIER_SETTING, patch.domainClassifierEnabled ? 'on' : 'off');
    }
    if (typeof patch.deviceProfilerEnabled === 'boolean') {
      writeSetting(db, DEVICE_PROFILER_SETTING, patch.deviceProfilerEnabled ? 'on' : 'off');
    }
    if (typeof patch.securityTriageEnabled === 'boolean') {
      writeSetting(db, SECURITY_TRIAGE_SETTING, patch.securityTriageEnabled ? 'on' : 'off');
    }
    if (typeof patch.morningBriefEnabled === 'boolean') {
      writeSetting(db, MORNING_BRIEF_SETTING, patch.morningBriefEnabled ? 'on' : 'off');
    }
    if (typeof patch.morningBriefHour === 'number' && Number.isFinite(patch.morningBriefHour)) {
      writeSetting(db, MORNING_BRIEF_HOUR_SETTING, String(Math.max(0, Math.min(23, Math.trunc(patch.morningBriefHour)))));
    }
    if (typeof patch.wan1QuotaGb === 'number' && Number.isFinite(patch.wan1QuotaGb)) {
      writeSetting(db, WAN1_QUOTA_GB_SETTING, String(Math.max(0, Math.min(100_000, Math.round(patch.wan1QuotaGb)))));
    }
    if (typeof patch.wan2QuotaGb === 'number' && Number.isFinite(patch.wan2QuotaGb)) {
      writeSetting(db, WAN2_QUOTA_GB_SETTING, String(Math.max(0, Math.min(100_000, Math.round(patch.wan2QuotaGb)))));
    }
    if (typeof patch.billingRenewalDay === 'number' && Number.isFinite(patch.billingRenewalDay)) {
      writeSetting(db, BILLING_RENEWAL_DAY_SETTING, String(Math.max(1, Math.min(31, Math.trunc(patch.billingRenewalDay)))));
    }
  });
  txn();
  return getAiSettings(db);
}
