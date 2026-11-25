import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {};', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenda-ai-web-'));
process.env.DB_PATH = path.join(tmpDir, 'test-ai-web.db');
process.env.TENDA_PANEL_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;

const sharedKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const sharedCredId = crypto.randomBytes(16).toString('base64url');
const sharedPasskeyPath = path.join(tmpDir, 'owner-passkey.json');
fs.writeFileSync(
  sharedPasskeyPath,
  JSON.stringify({
    credentialId: sharedCredId,
    publicKeyPem: sharedKeyPair.publicKey.export({ type: 'spki', format: 'pem' }),
    rpId: 'tv-eg.com',
  }),
  { mode: 0o600 },
);
process.env.TENDA_SHARED_PASSKEY_FILE = sharedPasskeyPath;

let scheduleTickCount = 0;
let lastAppliedAction: Record<string, unknown> | null = null;
let mockServer: http.Server;

await new Promise<void>((resolve) => {
  mockServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ai/qos-schedules/tick') {
      scheduleTickCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, applied: 1, reverted: 0 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/ai/apply-action') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastAppliedAction = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, summaryAr: 'تم تطبيق الإجراء عبر الخادم الوهمي.' }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  mockServer.listen(0, '127.0.0.1', () => {
    const addr = mockServer.address();
    process.env.CONTROL_PORT = String(typeof addr === 'object' && addr ? addr.port : 0);
    resolve();
  });
});

const { closeDb, getDb, runMigrations, HOUR, DAY, bucket5Min } = await import('@tenda/shared');
const { createPanelSessionCookie, panelSessionCookieName } = await import('../lib/remote-auth');
const { serializeCookieEntries } = await import('../lib/server-auth-guard');
const { getAnomalies, getDevice, getLatestDevices } = await import('../lib/queries');
const { GET: getAiSettingsRoute, POST: postAiSettingsRoute } = await import('../app/api/ai/settings/route');
const { POST: postAiExplainRoute } = await import('../app/api/ai/explain/route');
const { POST: postAiCopilotRoute } = await import('../app/api/ai/copilot/route');
const { GET: getQuotaForecastRoute } = await import('../app/api/ai/quota-forecast/route');
const { POST: postSchedulesRoute, DELETE: deleteSchedulesRoute } = await import('../app/api/ai/schedules/route');
const { POST: postAiActionRoute } = await import('../app/api/ai/action/route');

let sessionCookieHeader = '';

function authedRequest(urlPath: string, method = 'GET', body?: unknown): Request {
  const headers: Record<string, string> = {
    host: 'tv-eg.com:2055',
    origin: 'https://tv-eg.com:2055',
    cookie: sessionCookieHeader,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://tv-eg.com:2055${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

before(() => {
  const db = getDb();
  runMigrations(db);
  const bootstrapReq = new Request('https://tv-eg.com:2055/', {
    headers: { host: 'tv-eg.com:2055', origin: 'https://tv-eg.com:2055' },
  });
  const cookieName = panelSessionCookieName(bootstrapReq);
  const cookieValue = createPanelSessionCookie({
    credentialId: sharedCredId,
    rpId: 'tv-eg.com',
    req: bootstrapReq,
  });
  sessionCookieHeader = `${cookieName}=${encodeURIComponent(cookieValue)}`;
});

after(() => {
  mockServer.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Layer 2 — Web Bug Fixes + Guarded AI API Routes', () => {
  it('forwards both shared and local_vault hashed session cookies in serializeCookieEntries (#5)', () => {
    const header = serializeCookieEntries([
      { name: 'tenda_panel_session_a1b2c3d4', value: 'v2.tok123.999999.sig' },
      { name: 'other_cookie', value: 'abc' },
    ]);
    assert.match(header, /tenda_panel_session_a1b2c3d4=v2\.tok123\.999999\.sig/);
    assert.match(header, /other_cookie=abc/);
  });

  it('rejects unauthenticated requests on all /api/ai/* routes with 401', async () => {
    const unauthGet = new Request('http://localhost:3030/api/ai/settings', {
      method: 'GET',
      headers: { host: 'localhost:3030' },
    });
    const res1 = await getAiSettingsRoute(unauthGet);
    assert.equal(res1.status, 401);

    const unauthPost = new Request('http://localhost:3030/api/ai/copilot', {
      method: 'POST',
      headers: {
        host: 'localhost:3030',
        origin: 'http://localhost:3030',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'مين ساحب نت؟' }),
    });
    const res2 = await postAiCopilotRoute(unauthPost);
    assert.equal(res2.status, 401);
  });

  it('computes hour-of-day baseline + live traffic_5min + lan_or_wan in getAnomalies (#4) and joins AI device profiles', () => {
    const db = getDb();
    const now = Date.now();
    const currentHourStart = Math.floor(now / HOUR) * HOUR;
    const todayStart = (() => {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    const mac = 'AA:BB:CC:11:22:33';

    db.prepare(
      `INSERT INTO devices (mac, hostname, custom_label, vendor, category, first_seen, last_seen, is_new, created_at, updated_at)
       VALUES (?, 'frigate-nvr', 'Frigate Server', 'Intel', 'server', ?, ?, 0, ?, ?)`,
    ).run(mac, now - 15 * DAY, now, now, now);

    db.prepare(
      `INSERT INTO device_enrichment (mac, os_guess, reverse_dns, device_type, last_check, next_check)
       VALUES (?, 'Linux 6.x', 'frigate.lan', 'NVR Server', ?, ?)`,
    ).run(mac, now, now + DAY);

    db.prepare(
      `INSERT INTO ai_device_profiles
         (mac, suggested_label, inferred_category, trust_tier, recommended_qos_profile,
          recommended_down_kbs, recommended_up_kbs, recommended_wan, rationale_ar, updated_at)
       VALUES (?, 'خادم الكاميرات', 'server', 'trusted_personal', 'unlimited', 0, 0, 'WAN1', 'خادم محلي موثوق', ?)`,
    ).run(mac, now);

    // Seed 10 trailing days at the SAME local hour with ~20 MB +- 2 MB
    for (let d = 1; d <= 10; d++) {
      const histDayStart = todayStart - d * DAY;
      const sameHourTs = histDayStart + (currentHourStart - todayStart);
      const jitter = (d % 3) * 2 * 1024 * 1024;
      db.prepare(
        `INSERT INTO traffic_hour (mac, bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps, active_sec)
         VALUES (?, ?, ?, 0, 100000, 0, 600)`,
      ).run(mac, sameHourTs, 20 * 1024 * 1024 + jitter);
    }

    // Seed huge 500 MB spike ONLY in live `traffic_5min` for the current in-progress hour!
    const b5 = bucket5Min(now);
    db.prepare(
      `INSERT INTO traffic_5min (mac, bucket_ts, bytes_down, bytes_up, peak_down_bps, peak_up_bps, sample_count)
       VALUES (?, ?, ?, 0, 5000000, 0, 10)`,
    ).run(mac, b5, 500 * 1024 * 1024);

    // Seed near-zero WAN samples during currentHourStart so correlator identifies LAN-only!
    db.prepare(`INSERT INTO wan_samples (ts, wan_id, up_bytes_per_s, down_bytes_per_s) VALUES (?, 1, 50, 100)`).run(
      currentHourStart + 60_000,
    );
    db.prepare(`INSERT INTO wan_samples (ts, wan_id, up_bytes_per_s, down_bytes_per_s) VALUES (?, 1, 50, 100)`).run(
      currentHourStart + 180_000,
    );

    const anomalies = getAnomalies(3);
    const found = anomalies.find((a) => a.mac === mac);
    assert.ok(found, 'Expected current-hour traffic_5min anomaly to be detected');
    assert.equal(found!.lan_or_wan, 'lan_only');
    assert.ok(found!.z >= 3);

    const latest = getLatestDevices().find((d) => d.mac === mac);
    assert.ok(latest);
    assert.equal(latest!.os_guess, 'Linux 6.x');
    assert.equal(latest!.ai_trust_tier, 'trusted_personal');

    const single = getDevice(mac) as Record<string, unknown> | undefined;
    assert.ok(single);
    assert.equal(single!.ai_rationale_ar, 'خادم محلي موثوق');
  });

  it('handles authenticated AI settings, quota forecast, explain, copilot, schedules, and router actions end-to-end', async () => {
    const saveRes = await postAiSettingsRoute(
      authedRequest('/api/ai/settings', 'POST', {
        wan1QuotaGb: 300,
        wan2QuotaGb: 200,
        billingRenewalDay: 5,
      }),
    );
    assert.equal(saveRes.status, 200);
    const saveJson = await saveRes.json();
    assert.equal(saveJson.ok, true);
    assert.equal(saveJson.settings.wan1QuotaGb, 300);

    const getRes = await getAiSettingsRoute(authedRequest('/api/ai/settings'));
    const getJson = await getRes.json();
    assert.equal(getJson.ok, true);
    assert.ok(getJson.integrity);

    const qRes = await getQuotaForecastRoute(authedRequest('/api/ai/quota-forecast'));
    const qJson = await qRes.json();
    assert.equal(qJson.ok, true);
    assert.equal(qJson.forecast.wans[0].quotaBytes, 300 * 1024 ** 3);

    const expRes = await postAiExplainRoute(
      authedRequest('/api/ai/explain', 'POST', {
        scopeType: 'anomaly',
        scopeKey: 'test-anom-1',
        contextPayload: { mac: 'AA:BB:CC:11:22:33', label: 'Frigate Server', bytes: 500_000_000, z: 12.4 },
      }),
    );
    const expJson = await expRes.json();
    assert.equal(expJson.ok, true);
    assert.ok(expJson.explanation.explanationAr.length > 10);

    const copRes = await postAiCopilotRoute(
      authedRequest('/api/ai/copilot', 'POST', {
        message: 'إيه حالة الشبكة؟',
        pageContext: { pathname: '/' },
      }),
    );
    const copJson = await copRes.json();
    assert.equal(copJson.ok, true);
    assert.ok(copJson.replyAr.length > 10);

    const schedRes = await postSchedulesRoute(
      authedRequest('/api/ai/schedules', 'POST', {
        naturalPrompt: 'حد سرعة الشاشات بوضع SD أيام العمل من 09:00 إلى 17:00 على WAN2',
      }),
    );
    const schedJson = await schedRes.json();
    assert.equal(schedJson.ok, true);
    assert.equal(schedJson.schedules.length, 1);
    assert.equal(schedJson.schedules[0].wan_port, 'WAN2');
    assert.ok(scheduleTickCount >= 1);

    const delRes = await deleteSchedulesRoute(
      authedRequest('/api/ai/schedules', 'DELETE', { id: schedJson.schedules[0].id }),
    );
    const delJson = await delRes.json();
    assert.equal(delJson.ok, true);
    assert.equal(delJson.schedules.length, 0);

    const actRes = await postAiActionRoute(
      authedRequest('/api/ai/action', 'POST', {
        id: 'act-1',
        kind: 'set_qos',
        labelAr: 'تقييد SD',
        mac: 'AA:BB:CC:11:22:33',
        downloadLimitKbs: 256,
        uploadLimitKbs: 64,
      }),
    );
    const actJson = await actRes.json();
    assert.equal(actJson.ok, true);
    assert.equal(lastAppliedAction?.kind, 'set_qos');
  });
});
