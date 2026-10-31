import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * The WhatsApp dashboard (v1.10.0), against the database and a fake Graph API:
 *   - the sign-in codes integration on whatsapp_cloud gets a webhook path /hooks/whatsapp-cloud/<key> and a verify
 *     token made once and kept; the WABA id is validated; payments keep /pay/notify/<key>;
 *   - the webhook: the handshake, 404 / 401 / 403, statuses into the ledger without downgrades, failures with Meta's
 *     error, alert_notification rows of the same wamid updated with the SMS fallback, template / quality events
 *     stored and raised as platform alerts (and resolved); the alert channel's own webhook still works;
 *   - whatsapp_cloud sign-in codes write the ledger (masked number, wamid);
 *   - /v1/whatsapp: overview stats (with alert rows), a Graph failure as connection.error, messages masked and
 *     filtered, the test send, platform:admin only.
 *
 * The connection is saved as the platform's sign-in codes FALLBACK: other test files resolve the main channel to the
 * development sender, which this leaves alone (the fallback is never tried after the development sender).
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/whatsapp.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const store = await import('../integrations/store.js');
const wa = await import('./whatsapp-cloud.js');
const { senderFor } = await import('../integrations/otp.js');
const { registerIntegrationRoutes } = await import('../api/integration-routes.js');
const { registerWhatsAppRoutes } = await import('../api/whatsapp-routes.js');
const { resetOpsAlertOrgCache } = await import('./worker-health.js');
const { seal } = await import('./secrets.js');

const TAG = randomBytes(3).toString('hex');
const PNID = `10${Date.now()}`;
const WABA = `20${Date.now()}`;
const APP_SECRET = `app-secret-${TAG}`;
const PHONE = `+62812${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
let org = '';
let app: FastifyInstance;
let role: 'admin' | 'none' = 'admin';
let key = '';
let verifyToken = '';
let preexisting = false;

// ── the fake Graph API: answers by exact path; records requests
let base = '';
const seen: Array<{ method: string; path: string; auth: string | undefined; body: string }> = [];
let seq = 0;
let phoneAnswer: { status: number; body: unknown } = { status: 200, body: {} };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    seen.push({ method: req.method ?? '', path, auth: req.headers.authorization, body });
    let a: { status: number; body: unknown } = { status: 404, body: { error: { message: 'no fake', code: 100 } } };
    if (path === `/v20.0/${PNID}/messages`) a = { status: 200, body: { messages: [{ id: `wamid.${TAG}.${++seq}` }] } };
    else if (path === `/v20.0/${PNID}`) a = phoneAnswer;
    else if (path === `/v20.0/${WABA}`) a = { status: 200, body: { name: 'PlugSure', currency: 'IDR', timezone_id: '1' } };
    else if (path === `/v20.0/${WABA}/message_templates`) {
      a = { status: 200, body: { data: [
        { name: 'plugsure_otp', status: 'APPROVED', category: 'AUTHENTICATION', language: 'id', quality_score: { score: 'GREEN' } },
        { name: 'promo_x', status: 'REJECTED', category: 'MARKETING', language: 'en', rejected_reason: 'PROMOTIONAL' },
      ] } };
    }
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
});

const sign = (raw: string, secret = APP_SECRET) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
const hook = (payload: unknown, opts: { secret?: string; k?: string } = {}) => {
  const raw = JSON.stringify(payload);
  return app.inject({ method: 'POST', url: `/hooks/whatsapp-cloud/${opts.k ?? key}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, opts.secret) }, payload: raw });
};
const statusEvent = (statuses: unknown[]) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses } }] }] });
const fieldEvent = (field: string, value: unknown) => ({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field, value }] }] });
const ts = (d: Date) => String(Math.floor(d.getTime() / 1000));
const ledger = (wamid: string) => one<any>(`SELECT * FROM whatsapp_message WHERE wamid = $1`, [wamid]);

const save = (settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}) => store.save('otp_fallback', null, {
  provider: 'whatsapp_cloud',
  settings: { phoneNumberId: PNID, templateName: 'plugsure_otp', language: 'id', copyCodeButton: true, wabaId: WABA, baseUrl: base, ...settings },
  secrets,
}, null);

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    preexisting = Boolean(await one(`SELECT 1 FROM integration WHERE kind = 'otp_fallback' AND org_id IS NULL AND archived_at IS NULL`));
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`WA Test ${TAG}`, `wa-test-${TAG}`]))!.id;
    // Platform alerts go to this organisation.
    process.env.OPS_ALERT_ORG_ID = org;
    resetOpsAlertOrgCache();
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: randomUUID(), orgId: org, assignments: [{ permissions: role === 'admin' ? ['platform:admin'] : ['org:read', 'org:write'], scopeType: 'org', scopeId: null }] };
    });
    await registerIntegrationRoutes(app);
    await registerWhatsAppRoutes(app);
  });
  after(async () => {
    await app?.close();
    server.close();
    await query(`DELETE FROM whatsapp_message WHERE wamid LIKE $1 OR template LIKE $2`, [`wamid.${TAG}.%`, `%${TAG}%`]);
    await query(`DELETE FROM whatsapp_event WHERE payload::text LIKE $1`, [`%${TAG}%`]);
    if (!preexisting) await query(`DELETE FROM integration WHERE kind = 'otp_fallback' AND org_id IS NULL`);
    await query(`DELETE FROM alert_notification WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert_rule WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert_contact WHERE org_id = $1`, [org]);
    await query(`DELETE FROM notification_channel WHERE org_id = $1`, [org]);
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    store.invalidate();
    await pool.end();
  });
}

dbDescribe('the sign-in codes integration on WhatsApp', () => {
  test('preconditions: no platform fallback configured by someone else', () => {
    assert.equal(preexisting, false, 'a platform otp_fallback row exists in the test database; this file would overwrite it');
  });

  test('webhook path per kind and provider; verify token made once and kept; WABA id validated', async () => {
    assert.equal(store.webhookPathFor('payments', 'midtrans', 'k1'), '/pay/notify/k1');
    assert.equal(store.webhookPathFor('otp', 'whatsapp_cloud', 'k2'), '/hooks/whatsapp-cloud/k2');
    await assert.rejects(save({ wabaId: '+62812' }, { accessToken: 'EAAG-test', appSecret: APP_SECRET }), /numeric ID/);
    const first = (await save({}, { accessToken: 'EAAG-test', appSecret: APP_SECRET }))!;
    assert.match(first.webhookPath!, /^\/hooks\/whatsapp-cloud\/[A-Za-z0-9_-]{20,64}$/);
    assert.ok(first.webhookVerifyToken && first.webhookVerifyToken.length >= 24);
    assert.equal((first.secretHints as any).verifyToken, undefined, 'the generated token is not a typed secret');
    key = first.webhookPath!.split('/').pop()!;
    verifyToken = first.webhookVerifyToken;
    // A second save without secrets keeps the token, the key and the typed secrets.
    const again = (await save({ templateName: 'plugsure_otp' }))!;
    assert.equal(again.webhookVerifyToken, verifyToken);
    assert.equal(again.webhookPath, first.webhookPath);
    assert.ok((again.secretHints as any).appSecret);
    // Another provider has no webhook.
    assert.equal(store.webhookPathFor('otp', 'twilio', 'k'), '/pay/notify/k');
    const c = await wa.connection();
    assert.equal(c?.kind, 'otp_fallback');
    assert.equal(c?.phoneNumberId, PNID);
    assert.equal(c?.wabaId, WABA);
  });

  test('the handshake: the right token is echoed, anything else refused', async () => {
    const ok = await app.inject({ method: 'GET', url: `/hooks/whatsapp-cloud/${key}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=12345` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body, '12345');
    const bad = await app.inject({ method: 'GET', url: `/hooks/whatsapp-cloud/${key}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345` });
    assert.equal(bad.statusCode, 403);
    const mode = await app.inject({ method: 'GET', url: `/hooks/whatsapp-cloud/${key}?hub.mode=unsubscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=1` });
    assert.equal(mode.statusCode, 403);
    // The challenge is echoed only when it looks like Meta's: never arbitrary text.
    const html = await app.inject({ method: 'GET', url: `/hooks/whatsapp-cloud/${key}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${encodeURIComponent('<script>x</script>')}` });
    assert.equal(html.statusCode, 403);
  });

  test('404 unknown key, 401 bad signature', async () => {
    assert.equal((await hook(statusEvent([]), { k: 'x'.repeat(32) })).statusCode, 404);
    assert.equal((await hook(statusEvent([]), { secret: 'wrong' })).statusCode, 401);
    assert.equal((await hook(statusEvent([]))).statusCode, 200);
  });
});

dbDescribe('the ledger', () => {
  test('a whatsapp_cloud sign-in code is recorded: masked number, wamid, accepted; never the code', async () => {
    const c = await wa.connection();
    const r = await senderFor({ provider: 'whatsapp_cloud', settings: { phoneNumberId: PNID, templateName: 'plugsure_otp', language: 'id', copyCodeButton: true, baseUrl: base }, secrets: { accessToken: c!.accessToken } })
      .send(PHONE, '482913');
    assert.equal(r.ok, true);
    const row = await ledger(r.messageId!);
    assert.equal(row.purpose, 'otp');
    assert.equal(row.status, 'accepted');
    assert.equal(row.to_masked, `${PHONE.slice(0, 5)}****${PHONE.slice(-3)}`);
    assert.ok(!JSON.stringify(row).includes(PHONE.slice(1)), 'no full number');
    assert.ok(!JSON.stringify(row).includes('482913'), 'no code');
    assert.equal(seen[seen.length - 1]!.auth, `Bearer ${c!.accessToken}`);
  });

  test('statuses out of order never downgrade; pricing kept; timestamps set', async () => {
    const r = await wa.sendTemplate({ to: PHONE, template: `t_${TAG}`, language: 'id', purpose: 'test' });
    assert.equal(r.ok, true);
    const id = (r as { wamid: string }).wamid;
    const t0 = new Date(Date.now() - 60_000), t1 = new Date(Date.now() - 30_000);
    let res = await hook(statusEvent([{ id, status: 'read', timestamp: ts(t1), recipient_id: PHONE.slice(1), pricing: { category: 'utility', billable: true } }]));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().statuses, 1);
    res = await hook(statusEvent([{ id, status: 'delivered', timestamp: ts(t0) }, { id, status: 'sent', timestamp: ts(t0) }]));
    const row = await ledger(id);
    assert.equal(row.status, 'read');
    assert.equal(row.pricing_category, 'utility');
    assert.equal(row.billable, true);
    assert.equal(new Date(row.read_at).getTime(), t1.getTime() - (t1.getTime() % 1000));
    assert.equal(new Date(row.delivered_at).getTime(), t0.getTime() - (t0.getTime() % 1000), 'the earlier delivered time wins');
    assert.ok(row.sent_at && row.webhook_at);
  });

  test('a failure carries Meta\'s code and text; a refused send is recorded failed', async () => {
    const r = await wa.sendTemplate({ to: PHONE, template: `t_${TAG}`, language: 'id', purpose: 'test' });
    const id = (r as { wamid: string }).wamid;
    await hook(statusEvent([{ id, status: 'failed', timestamp: ts(new Date()), errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'no WhatsApp' } }] }]));
    const row = await ledger(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_code, '131026');
    assert.match(row.error_text, /Message undeliverable \(code 131026\): no WhatsApp/);
    assert.ok(row.failed_at);
    // Meta refuses the send itself: a ledger row without wamid, with the readable reason.
    const c = (await wa.connection())!;
    const bad = await wa.sendTemplate({ to: PHONE, template: `missing_${TAG}`, language: 'id', purpose: 'test', conn: { ...c, phoneNumberId: '999999' } });
    assert.equal(bad.ok, false);
    assert.match((bad as { error: string }).error, /code 100/);
    const f = await one<any>(`SELECT * FROM whatsapp_message WHERE template = $1`, [`missing_${TAG}`]);
    assert.equal(f.status, 'failed');
    assert.equal(f.wamid, null);
  });
});

dbDescribe('operator alerts on the same Meta app', () => {
  let alertWamid = '';
  let notificationId = '';
  test('a failed status updates the alert notification and queues the SMS fallback', async () => {
    alertWamid = `wamid.${TAG}.alert`;
    await query(`INSERT INTO notification_channel (org_id, kind, enabled, config, secret) VALUES ($1,'whatsapp',true,$2,$3)`,
      [org, JSON.stringify({ apiBase: `${base}/v20.0`, phoneNumberId: PNID, templateName: `alert_${TAG}`, templateLang: 'id' }), seal('tok')]);
    await query(`INSERT INTO notification_channel (org_id, kind, enabled, config, secret) VALUES ($1,'sms',true,$2,$3)`, [org, JSON.stringify({ provider: 'twilio', accountSid: 'AC1', from: 'X' }), seal('tok')]);
    const contact = (await one<{ id: string }>(`INSERT INTO alert_contact (org_id, name, whatsapp, sms) VALUES ($1,'Tek','6281234500001','6281234500001') RETURNING id`, [org]))!.id;
    const rule = (await one<{ id: string }>(`INSERT INTO alert_rule (org_id, name, channels, contact_ids, sms_fallback) VALUES ($1,'r',$2,$3,true) RETURNING id`, [org, ['whatsapp'], [contact]]))!.id;
    const alert = (await one<{ id: string }>(`INSERT INTO alert (org_id, severity, kind, message) VALUES ($1,'critical','charge_point.offline','x') RETURNING id`, [org]))!.id;
    notificationId = (await one<{ id: string }>(
      `INSERT INTO alert_notification (org_id, alert_id, rule_id, contact_id, channel, destination, stage, state, provider_ref, sent_at)
       VALUES ($1,$2,$3,$4,'whatsapp','6281234500001','raised','sent',$5, now()) RETURNING id`, [org, alert, rule, contact, alertWamid]))!.id;
    const res = await hook(statusEvent([{ id: alertWamid, status: 'failed', timestamp: ts(new Date()), errors: [{ code: 131049, title: 'Not delivered' }] }]));
    assert.equal(res.json().statuses, 1);
    const n = await one<any>(`SELECT * FROM alert_notification WHERE id = $1`, [notificationId]);
    assert.equal(n.delivery, 'failed');
    assert.match(n.delivery_error, /Not delivered \(code 131049\)/);
    const sms = await one<any>(`SELECT * FROM alert_notification WHERE fallback_of = $1`, [notificationId]);
    assert.equal(sms?.channel, 'sms');
  });

  test('the alert channel\'s own webhook still updates its notifications', async () => {
    const k = randomBytes(16).toString('base64url');
    await query(`UPDATE notification_channel SET webhook_key = $2, verify_token = 'vt', webhook_secret = $3 WHERE org_id = $1 AND kind = 'whatsapp'`, [org, k, seal('other-secret')]);
    const id2 = (await one<{ id: string }>(
      `INSERT INTO alert_notification (org_id, channel, destination, stage, state, provider_ref, sent_at) VALUES ($1,'whatsapp','6281234500001','test','sent',$2, now()) RETURNING id`,
      [org, `wamid.${TAG}.own`]))!.id;
    const raw = JSON.stringify(statusEvent([{ id: `wamid.${TAG}.own`, status: 'read', timestamp: ts(new Date()) }]));
    const res = await app.inject({ method: 'POST', url: `/hooks/whatsapp/${k}`, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, 'other-secret') }, payload: raw });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().statuses, 1);
    const n = await one<any>(`SELECT delivery, read_at FROM alert_notification WHERE id = $1`, [id2]);
    assert.equal(n.delivery, 'read');
    assert.ok(n.read_at);
  });

  test('template and quality events are stored and raised as platform alerts, then resolved', async () => {
    let res = await hook(fieldEvent('message_template_status_update', { event: 'PAUSED', message_template_id: 1, message_template_name: 'plugsure_otp', message_template_language: 'id', reason: `LOW_QUALITY ${TAG}` }));
    assert.equal(res.json().events, 1);
    const ev = await one<any>(`SELECT * FROM whatsapp_event WHERE payload->>'reason' = $1`, [`LOW_QUALITY ${TAG}`]);
    assert.equal(ev.field, 'message_template_status_update');
    let a = await one<any>(`SELECT * FROM alert WHERE org_id = $1 AND kind = 'platform.whatsapp_template' AND resolved_at IS NULL`, [org]);
    assert.equal(a.severity, 'critical', 'the sign-in code template');
    assert.equal(a.target_id, 'plugsure_otp:id');
    res = await hook(fieldEvent('message_template_status_update', { event: 'APPROVED', message_template_name: 'plugsure_otp', message_template_language: 'id', reason: `NONE ${TAG}` }));
    a = await one<any>(`SELECT * FROM alert WHERE org_id = $1 AND kind = 'platform.whatsapp_template' AND resolved_at IS NULL`, [org]);
    assert.equal(a, null, 'resolved');
    await hook(fieldEvent('phone_number_quality_update', { display_phone_number: `+62 ${TAG}`, event: 'FLAGGED', current_limit: 'TIER_1K' }));
    const q = await one<any>(`SELECT * FROM alert WHERE org_id = $1 AND kind = 'platform.whatsapp_quality' AND resolved_at IS NULL`, [org]);
    assert.match(q.message, /quality is low/);
    const evs = await app.inject({ method: 'GET', url: '/v1/whatsapp/events?limit=10' });
    assert.ok(evs.json().events.some((e: any) => e.field === 'phone_number_quality_update' && e.event === 'FLAGGED'));
  });
});

dbDescribe('/v1/whatsapp', () => {
  test('overview: the connection, the webhook, templates, stats with alert rows', async () => {
    wa.clearCache();
    phoneAnswer = { status: 200, body: { display_phone_number: '+62 811-0000-000', verified_name: 'PlugSure', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K', name_status: 'APPROVED' } };
    // Twenty days ago, so other files' messages (today) cannot be in that day's bucket.
    const when = `now() - interval '20 days'`;
    for (const [st, purpose] of [['read', 'otp'], ['delivered', 'otp'], ['failed', 'test'], ['accepted', 'otp']]) {
      await query(`INSERT INTO whatsapp_message (purpose, template, language, to_masked, status, created_at) VALUES ($1,$2,'id','+6281****001',$3, ${when})`, [purpose, `seed_${TAG}`, st]);
    }
    await query(`INSERT INTO alert_notification (org_id, channel, destination, stage, state, delivery, provider_ref, created_at, sent_at) VALUES ($1,'whatsapp','6281234500001','test','sent','read',$2, ${when}, ${when})`, [org, `wamid.${TAG}.old`]);
    const day = (await one<{ d: string }>(`SELECT to_char(((${when}) AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [config.alerts.timeZone]))!.d;
    const r = await app.inject({ method: 'GET', url: '/v1/whatsapp/overview?days=30' });
    assert.equal(r.statusCode, 200, r.body);
    const o = r.json();
    assert.equal(o.configured, true);
    assert.equal(o.connection.displayPhoneNumber, '+62 811-0000-000');
    assert.equal(o.connection.qualityRating, 'GREEN');
    assert.equal(o.connection.error, null);
    assert.equal(o.webhook.url.endsWith(`/hooks/whatsapp-cloud/${key}`), true);
    assert.equal(o.webhook.verifyToken, verifyToken);
    assert.equal(o.webhook.hasAppSecret, true);
    assert.ok(o.webhook.lastStatusAt && o.webhook.lastEventAt);
    assert.deepEqual(o.requiredTemplates.find((t: any) => t.purpose === 'otp'), { name: 'plugsure_otp', language: 'id', purpose: 'otp', inUse: true, status: 'APPROVED', category: 'AUTHENTICATION' });
    assert.equal(o.requiredTemplates.find((t: any) => t.name === `alert_${TAG}`)?.status, 'MISSING');
    assert.equal(o.stats.days, 30);
    assert.equal(o.stats.daily.length, 30);
    assert.deepEqual(o.stats.daily.find((d: any) => d.day === day), { day, sent: 1, delivered: 1, read: 2, failed: 1 });
    assert.ok(o.stats.byPurpose.alert >= 2, 'alert rows are counted');
    assert.ok(o.stats.total >= 6);
    // 7 days: the old rows drop out.
    const week = (await app.inject({ method: 'GET', url: '/v1/whatsapp/overview?days=7' })).json();
    assert.equal(week.stats.daily.length, 7);
    assert.ok(!week.stats.daily.some((d: any) => d.day === day));
    assert.ok(o.recentFailures.every((m: any) => m.status === 'failed' && /\*\*\*\*/.test(m.to)));
    assert.equal((await app.inject({ method: 'GET', url: '/v1/whatsapp/overview?days=9' })).statusCode, 400);
  });

  test('a Graph API failure is connection.error, not a 500', async () => {
    wa.clearCache();
    phoneAnswer = { status: 401, body: { error: { message: 'Error validating access token', code: 190 } } };
    const r = await app.inject({ method: 'GET', url: '/v1/whatsapp/overview' });
    assert.equal(r.statusCode, 200);
    assert.match(r.json().connection.error, /code 190.*permanent System User token/);
    phoneAnswer = { status: 200, body: {} };
  });

  test('templates: listed, the required ones marked', async () => {
    wa.clearCache();
    const r = await app.inject({ method: 'GET', url: '/v1/whatsapp/templates' });
    assert.equal(r.statusCode, 200, r.body);
    const t = r.json();
    assert.equal(t.templates.find((x: any) => x.name === 'plugsure_otp').required, true);
    assert.equal(t.templates.find((x: any) => x.name === 'promo_x').rejectedReason, 'PROMOTIONAL');
    assert.match(t.managerUrl, new RegExp(`waba_id=${WABA}`));
  });

  test('messages: masked, merged with alerts, filtered, paged', async () => {
    const all = (await app.inject({ method: 'GET', url: '/v1/whatsapp/messages?limit=200' })).json();
    assert.ok(all.messages.some((m: any) => m.purpose === 'alert' && m.template === `alert_${TAG}`));
    assert.ok(all.messages.every((m: any) => !m.to.includes(PHONE.slice(3)) && !m.to.includes('6281234500001')), 'masked');
    const tests = (await app.inject({ method: 'GET', url: '/v1/whatsapp/messages?purpose=test&status=failed' })).json();
    assert.ok(tests.messages.length >= 2);
    assert.ok(tests.messages.every((m: any) => m.purpose === 'test' && m.status === 'failed'));
    const page = (await app.inject({ method: 'GET', url: '/v1/whatsapp/messages?limit=1' })).json();
    assert.equal(page.messages.length, 1);
    assert.ok(page.nextBefore);
    const next = (await app.inject({ method: 'GET', url: `/v1/whatsapp/messages?limit=1&before=${encodeURIComponent(page.nextBefore)}` })).json();
    assert.ok(new Date(next.messages[0].at) <= new Date(page.nextBefore));
    assert.equal((await app.inject({ method: 'GET', url: '/v1/whatsapp/messages?status=bogus' })).statusCode, 400);
  });

  test('test send: through the connection, recorded as a test, audited; bad input refused', async () => {
    const before0 = seen.length;
    const r = await app.inject({ method: 'POST', url: '/v1/whatsapp/test', payload: { phone: `0${PHONE.slice(3)}`, template: `t_${TAG}`, language: 'id', params: ['123456'], copyCodeButton: true } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().ok, true);
    assert.match(r.json().to, /\*\*\*\*/);
    const sent = JSON.parse(seen.slice(before0).find((x) => x.path.endsWith('/messages'))!.body);
    assert.equal(sent.to, PHONE.slice(1));
    assert.equal(sent.template.components[1].sub_type, 'url');
    const row = await ledger(r.json().messageId);
    assert.equal(row.purpose, 'test');
    const audit = await one<any>(`SELECT * FROM audit_log WHERE org_id = $1 AND action = 'whatsapp.test_sent' ORDER BY ts DESC LIMIT 1`, [org]);
    assert.ok(audit);
    assert.ok(!JSON.stringify(audit).includes(PHONE.slice(3)), 'the audit entry has the masked number');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/whatsapp/test', payload: { phone: '12', template: 't', language: 'id' } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/whatsapp/test', payload: { phone: PHONE, template: 'Bad Name', language: 'id' } })).statusCode, 422);
  });

  test('platform:admin only', async () => {
    role = 'none';
    try {
      for (const [method, url] of [['GET', '/v1/whatsapp/overview'], ['GET', '/v1/whatsapp/templates'], ['GET', '/v1/whatsapp/messages'], ['GET', '/v1/whatsapp/events'], ['POST', '/v1/whatsapp/test']] as const) {
        const r = await app.inject({ method, url, ...(method === 'POST' ? { payload: { phone: PHONE, template: 'x', language: 'id' } } : {}) });
        assert.equal(r.statusCode, 403, `${method} ${url}`);
      }
    } finally { role = 'admin'; }
  });

  test('no app secret saved: Meta\'s calls are refused with 403; no WABA id: templates 409', async () => {
    const row = (await one<{ id: string }>(`SELECT id FROM integration WHERE kind = 'otp_fallback' AND org_id IS NULL`))!;
    await query(`UPDATE integration SET secrets_sealed = $2, settings = settings - 'wabaId' WHERE id = $1`, [row.id, seal(JSON.stringify({ accessToken: 'EAAG-test', verifyToken }))]);
    store.invalidate();
    assert.equal((await hook(statusEvent([]))).statusCode, 403);
    const t = await app.inject({ method: 'GET', url: '/v1/whatsapp/templates' });
    assert.equal(t.statusCode, 409);
    assert.match(t.json().error, /WhatsApp Business Account ID/);
    const o = (await app.inject({ method: 'GET', url: '/v1/whatsapp/overview' })).json();
    assert.equal(o.connection.wabaId, null);
    assert.equal(o.connection.error, null, 'a missing WABA id is not a Graph error');
    assert.equal(o.webhook.hasAppSecret, false);
  });

  test('retention keeps the ledger to 180 days', async () => {
    await query(`INSERT INTO whatsapp_message (purpose, template, to_masked, status, created_at) VALUES ('test', $1, '+6281****001', 'read', now() - interval '181 days')`, [`old_${TAG}`]);
    const { runRetention } = await import('./retention.js');
    const out = await runRetention({ ocppFrameDays: 0, connectionAttemptDays: 0 });
    assert.ok(out.whatsappMessages >= 1);
    assert.equal(await one(`SELECT 1 FROM whatsapp_message WHERE template = $1`, [`old_${TAG}`]), null);
    void many;
  });
});

// ─────────────────────────────────────────── (v1.11.0) the support inbox and its AI assistant

/**
 * Customers' messages through the same webhook, answered by Claude against a fake Anthropic API (scripted answers,
 * requests recorded): replies in auto mode, drafts in draft mode, tool calls (stations, the customer's own sessions),
 * the handover (tool, refusal, reply cap) with its platform alert, API failures as notes, staff replies inside
 * Meta's 24-hour window only, the handler switches, the connection test, retention.
 */
const support = await import('./whatsapp-support.js');
const CUSTOMER = `62813${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const claudeSeen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }> = [];
let claudeScript: Array<{ status?: number; body: any }> = [];
const claudeMsg = (content: unknown[], stop = 'end_turn'): { status?: number; body: any } => ({
  body: { id: `msg_${TAG}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30 } },
});
const claude = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body: any = null;
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    claudeSeen.push({ path: req.url ?? '', headers: req.headers, body });
    const a = claudeScript.shift() ?? claudeMsg([{ type: 'text', text: 'Fallback answer.' }]);
    res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
});
let claudeBase = '';
let wamidSeq = 0;
const customerSays = (text: string, extra: Record<string, unknown> = {}) => hook({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: CUSTOMER, profile: { name: `Budi ${TAG}` } }],
    messages: [{ from: CUSTOMER, id: `wamid.in.${TAG}.${++wamidSeq}`, timestamp: ts(new Date()), type: 'text', text: { body: text }, ...extra }],
  } }] }],
});
const saveSupport = (settings: Record<string, unknown> = {}, secrets: Record<string, string> = { apiKey: `sk-ant-api03-${TAG}abcdefghij` }) => store.save('ai_support', null, {
  provider: 'anthropic',
  settings: { mode: 'auto', model: 'claude-opus-5-5', effort: 'low', knowledge: `Refunds within 3 working days. Code ${TAG}.`, maxRepliesPerHour: 15, maxRepliesPerDay: 1000, baseUrl: claudeBase, ...settings },
  secrets,
}, null);
const theConv = () => one<any>(`SELECT * FROM whatsapp_conversation WHERE phone_hash = $1`, [support.phoneHash(CUSTOMER)]);
const sentTexts = () => seen.filter((r) => r.path === `/v20.0/${PNID}/messages` && r.body.includes('"type":"text"')).map((r) => JSON.parse(r.body));

dbDescribe('WhatsApp support: the inbox and the AI assistant', () => {
  let preexistingSupport = false;
  before(async () => {
    preexistingSupport = Boolean(await one(`SELECT 1 FROM integration WHERE kind = 'ai_support' AND archived_at IS NULL`));
    await new Promise<void>((r) => claude.listen(0, '127.0.0.1', () => r()));
    claudeBase = `http://127.0.0.1:${(claude.address() as any).port}`;
    support.setSettleMs(0);
    // The test above removed the app secret: the webhook needs it back.
    await save({}, { accessToken: 'EAAG-test', appSecret: APP_SECRET });
    store.invalidate();
  });
  after(async () => {
    await support.idle();
    claude.close();
    await query(`DELETE FROM whatsapp_conversation WHERE phone_hash = $1`, [support.phoneHash(CUSTOMER)]);
    if (!preexistingSupport) await query(`DELETE FROM integration WHERE kind = 'ai_support' AND org_id IS NULL`);
  });

  test('preconditions: no AI support configured by someone else', () => assert.equal(preexistingSupport, false));

  test('the integration: key format, bounds; the connection test asks Claude once', async () => {
    await assert.rejects(saveSupport({}, { apiKey: 'not-a-key' }), /sk-ant-/);
    await assert.rejects(saveSupport({ knowledge: 'x'.repeat(20_001) }), /20,000/);
    await assert.rejects(saveSupport({ maxRepliesPerHour: 0 }), /whole number/);
    const saved = (await saveSupport())!;
    assert.ok((saved.secretHints as any).apiKey, 'the key is a sealed secret, shown as a hint');
    claudeScript = [claudeMsg([{ type: 'text', text: 'OK' }])];
    const t = (await app.inject({ method: 'POST', url: '/v1/integrations/ai_support/test', payload: {} })).json();
    assert.equal(t.ok, true, t.message);
    assert.match(t.message, /Claude answered/);
    const req = claudeSeen.pop()!;
    // The saved key, and only it (SDK 1.x sends it as a bearer token; never the server's environment credentials).
    const key = `sk-ant-api03-${TAG}abcdefghij`;
    assert.ok(req.headers['x-api-key'] === key || req.headers.authorization === `Bearer ${key}`, JSON.stringify(req.headers));
  });

  test('a customer message: stored (number sealed, masked), answered by Claude, the reply sent and tracked', async () => {
    claudeSeen.length = 0;
    claudeScript = [claudeMsg([{ type: 'text', text: `Halo Budi! Refund diproses dalam 3 hari kerja.` }])];
    const before = sentTexts().length;
    const r = await customerSays('Halo, kapan refund saya?');
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().messages, 1);
    await support.idle();
    const c = await theConv();
    assert.equal(c.phone_masked.includes(CUSTOMER.slice(4, 9)), false, 'masked');
    assert.equal(c.phone_sealed.includes(CUSTOMER), false, 'sealed');
    assert.equal(c.profile_name, `Budi ${TAG}`);
    assert.equal(c.handler, 'ai');
    // Claude got the instructions, the knowledge (cached), the tools, the conversation, and the fallback opt-in.
    const req = claudeSeen[0]!;
    assert.match(req.path, /^\/v1\/messages/);
    assert.equal(req.body.model, 'claude-opus-5-5');
    assert.equal(req.body.output_config.effort, 'low');
    assert.equal(req.body.fallbacks, 'default');
    assert.match(String(req.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.match(req.body.system[0].text, new RegExp(`Code ${TAG}`));
    assert.deepEqual(req.body.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(req.body.tools.map((t: any) => t.name), ['find_stations', 'charger_status', 'my_recent_sessions', 'hand_off_to_staff']);
    assert.deepEqual(req.body.messages, [{ role: 'user', content: 'Halo, kapan refund saya?' }]);
    assert.equal(req.body.thinking, undefined, 'thinking is left to the model (always on for Opus 5.5)');
    // Sent as free-form text to the customer; in the conversation with Meta's id and in the ledger as support.
    const sent = sentTexts().slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, CUSTOMER);
    assert.match(sent[0].text.body, /Refund diproses/);
    const out = await one<any>(`SELECT * FROM whatsapp_chat_message WHERE conversation_id = $1 AND author = 'ai' ORDER BY id DESC LIMIT 1`, [c.id]);
    assert.ok(out.wamid);
    assert.equal(out.model, 'claude-opus-5-5');
    assert.equal(out.input_tokens, 120);
    assert.equal((await ledger(out.wamid)).purpose, 'support');
    // The read receipt for the customer's message.
    assert.ok(seen.some((x) => x.body.includes('"status":"read"')));
    // Meta's retry of the same message is not taken twice, nor answered again.
    const dup = await hook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: { contacts: [], messages: [{ from: CUSTOMER, id: `wamid.in.${TAG}.${wamidSeq}`, timestamp: ts(new Date()), type: 'text', text: { body: 'Halo, kapan refund saya?' } }] } }] }] });
    assert.equal(dup.json().messages, 0);
  });

  test('tools: the assistant looks up stations and the customer\'s own sessions, then answers', async () => {
    claudeSeen.length = 0;
    claudeScript = [
      claudeMsg([{ type: 'tool_use', id: 'tu_1', name: 'find_stations', input: { query: `nowhere-${TAG}`, near_latitude: null, near_longitude: null, only_available: true } },
        { type: 'tool_use', id: 'tu_2', name: 'my_recent_sessions', input: {} }], 'tool_use'),
      claudeMsg([{ type: 'text', text: 'Tidak ada stasiun dengan nama itu.' }]),
    ];
    await customerSays(`Ada SPKLU di nowhere-${TAG}?`);
    await support.idle();
    assert.equal(claudeSeen.length, 2);
    const second = claudeSeen[1]!.body.messages;
    const results = second[second.length - 1].content;
    assert.deepEqual(results.map((x: any) => x.tool_use_id), ['tu_1', 'tu_2'], 'both results in one user message');
    assert.deepEqual(JSON.parse(results[0].content).stations, []);
    assert.equal(JSON.parse(results[1].content).account, false, 'no PlugSure account on this number');
    // The assistant's turn with its tool calls is replayed as it came back.
    assert.equal(second[second.length - 2].role, 'assistant');
    assert.equal(second[second.length - 2].content[0].type, 'tool_use');
    assert.match(sentTexts().pop()!.text.body, /Tidak ada stasiun/);
  });

  test('handover by the tool: staff\'s conversation, the handover message, a platform alert; the assistant then stays quiet', async () => {
    claudeScript = [claudeMsg([{ type: 'text', text: 'Saya teruskan ke tim kami.' }, { type: 'tool_use', id: 'tu_3', name: 'hand_off_to_staff', input: { reason: 'wants a refund for a failed session' } }], 'tool_use')];
    await customerSays('Saya mau refund sekarang!');
    await support.idle();
    const c = await theConv();
    assert.equal(c.handler, 'human');
    assert.equal(c.handoff_reason, 'wants a refund for a failed session');
    assert.match(sentTexts().pop()!.text.body, /Saya teruskan ke tim kami\.\n\nTerima kasih, tim PlugSure/);
    const alert = await one<any>(`SELECT * FROM alert WHERE org_id = $1 AND kind = 'platform.whatsapp_support' AND target_id = $2 AND resolved_at IS NULL`, [org, c.id]);
    assert.ok(alert);
    assert.match(alert.message, /waiting for staff/);
    const calls = claudeSeen.length;
    await customerSays('Halo?');
    await support.idle();
    assert.equal(claudeSeen.length, calls, 'a conversation with staff is not answered by the assistant');
  });

  test('the inbox: list, open, staff reply (takes over, resolves the alert), 24-hour window, handler switches; platform:admin only', async () => {
    const list = (await app.inject({ method: 'GET', url: '/v1/whatsapp/conversations?handler=human' })).json();
    const mine = list.conversations.find((x: any) => x.name === `Budi ${TAG}`);
    assert.ok(mine);
    assert.equal(mine.phone.includes(CUSTOMER.slice(4, 9)), false);
    assert.equal(mine.windowOpen, true);
    assert.ok(mine.unread >= 1);
    const one1 = (await app.inject({ method: 'GET', url: `/v1/whatsapp/conversations/${mine.id}` })).json();
    assert.ok(one1.messages.some((m: any) => m.author === 'system' && /Handed to staff/.test(m.body)));
    assert.ok(one1.messages.some((m: any) => m.author === 'ai' && m.status === 'accepted'));
    assert.equal((await theConv()).unread, 0, 'opening it marks it read');
    const r = await app.inject({ method: 'POST', url: `/v1/whatsapp/conversations/${mine.id}/reply`, payload: { text: 'Refund Anda sudah kami proses.' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.match(sentTexts().pop()!.text.body, /sudah kami proses/);
    assert.equal(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'platform.whatsapp_support' AND target_id = $2 AND resolved_at IS NULL`, [org, mine.id]), null, 'answered: the alert is resolved');
    assert.equal((await app.inject({ method: 'POST', url: `/v1/whatsapp/conversations/${mine.id}/reply`, payload: { text: '  ' } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/whatsapp/conversations/${randomUUID()}/reply`, payload: { text: 'x' } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/whatsapp/conversations/not-a-uuid' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/whatsapp/conversations/${mine.id}/handler`, payload: { handler: 'robot' } })).statusCode, 400);
    // Outside the window: refused, as Meta would.
    await query(`UPDATE whatsapp_conversation SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [mine.id]);
    const late = await app.inject({ method: 'POST', url: `/v1/whatsapp/conversations/${mine.id}/reply`, payload: { text: 'Halo' } });
    assert.equal(late.statusCode, 409);
    assert.match(late.json().error, /24 hours/);
    await query(`UPDATE whatsapp_conversation SET last_inbound_at = now() WHERE id = $1`, [mine.id]);
    // Closed, then the customer writes: back with the assistant.
    const closed = (await app.inject({ method: 'POST', url: `/v1/whatsapp/conversations/${mine.id}/handler`, payload: { handler: 'closed' } })).json();
    assert.equal(closed.conversation.handler, 'closed');
    claudeScript = [claudeMsg([{ type: 'text', text: 'Sama-sama!' }])];
    await customerSays('Terima kasih');
    await support.idle();
    assert.equal((await theConv()).handler, 'ai');
    assert.match(sentTexts().pop()!.text.body, /Sama-sama/);
    const audit = await one(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'whatsapp.support_reply'`, [org]);
    assert.ok(audit);
    role = 'none';
    try {
      for (const [method, url] of [['GET', '/v1/whatsapp/conversations'], ['GET', `/v1/whatsapp/conversations/${mine.id}`], ['POST', `/v1/whatsapp/conversations/${mine.id}/reply`], ['POST', `/v1/whatsapp/conversations/${mine.id}/handler`], ['POST', `/v1/whatsapp/conversations/${mine.id}/suggest`]] as const) {
        assert.equal((await app.inject({ method, url, ...(method === 'POST' ? { payload: { text: 'x', handler: 'ai' } } : {}) })).statusCode, 403, `${method} ${url}`);
      }
    } finally { role = 'admin'; }
  });

  test('draft mode: Claude\'s reply waits for staff; suggest asks for one on demand', async () => {
    await saveSupport({ mode: 'draft' });
    store.invalidate();
    claudeScript = [claudeMsg([{ type: 'text', text: `Draf jawaban ${TAG}` }])];
    const sent = sentTexts().length;
    await customerSays('Bagaimana cara bayar?');
    await support.idle();
    assert.equal(sentTexts().length, sent, 'nothing sent in draft mode');
    const c = await theConv();
    assert.equal(c.draft, `Draf jawaban ${TAG}`);
    claudeScript = [claudeMsg([{ type: 'text', text: 'Saran kedua' }])];
    const s = (await app.inject({ method: 'POST', url: `/v1/whatsapp/conversations/${c.id}/suggest` })).json();
    assert.deepEqual(s, { draft: 'Saran kedua', handoff: null });
    assert.equal(sentTexts().length, sent);
    // A draft is waiting: staff are told.
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'platform.whatsapp_support' AND target_id = $2 AND resolved_at IS NULL AND message LIKE '%drafted%'`, [org, c.id]));
    // Staff send the draft: the assistant keeps the conversation (it drafts the next one too).
    assert.equal((await app.inject({ method: 'POST', url: `/v1/whatsapp/conversations/${c.id}/reply`, payload: { text: 'Saran kedua' } })).statusCode, 200);
    assert.equal((await theConv()).handler, 'ai');
    assert.equal((await theConv()).draft, null);
    // Nothing to answer after a reply: no request with a final assistant turn.
    const calls = claudeSeen.length;
    assert.equal((await app.inject({ method: 'POST', url: `/v1/whatsapp/conversations/${c.id}/suggest` })).statusCode, 409);
    assert.equal(claudeSeen.length, calls);
  });

  test('a refusal, a reply cap and an API failure: handed to staff, or a note, never a broken reply', async () => {
    await saveSupport({ mode: 'auto', maxRepliesPerHour: 100 });
    store.invalidate();
    let c = await theConv();
    await query(`UPDATE whatsapp_conversation SET handler = 'ai' WHERE id = $1`, [c.id]);
    claudeScript = [claudeMsg([], 'refusal')];
    await customerSays('…');
    await support.idle();
    c = await theConv();
    assert.equal(c.handler, 'human');
    assert.match(c.handoff_reason, /declined/);
    // A cap of 1 an hour, already reached: no request at all.
    await saveSupport({ mode: 'auto', maxRepliesPerHour: 1 });
    store.invalidate();
    await query(`UPDATE whatsapp_conversation SET handler = 'ai' WHERE id = $1`, [c.id]);
    const calls = claudeSeen.length;
    await customerSays('Halo lagi');
    await support.idle();
    assert.equal(claudeSeen.length, calls);
    assert.match((await theConv()).handoff_reason, /more than 1 AI replies/);
    // A bad key: a note in the conversation, nothing sent, the conversation stays with the assistant.
    await saveSupport({ mode: 'auto', maxRepliesPerHour: 100 });
    store.invalidate();
    await query(`UPDATE whatsapp_conversation SET handler = 'ai' WHERE id = $1`, [c.id]);
    claudeScript = [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }];
    const sent = sentTexts().length;
    await customerSays('Tes');
    await support.idle();
    assert.equal(sentTexts().length, sent);
    const note = await one<any>(`SELECT body FROM whatsapp_chat_message WHERE conversation_id = $1 AND author = 'system' ORDER BY id DESC LIMIT 1`, [c.id]);
    assert.match(note.body, /API key is invalid/);
    assert.equal((await theConv()).handler, 'ai');
  });

  test('message bodies: text, location, media named with its caption, reactions skipped', () => {
    assert.equal(support.bodyOf({ type: 'text', text: { body: 'hi' } }), 'hi');
    assert.equal(support.bodyOf({ type: 'location', location: { latitude: -6.2, longitude: 106.8166667, name: 'GBK' } }), '[location -6.20000, 106.81667 — GBK]');
    assert.equal(support.bodyOf({ type: 'image', image: { caption: 'error on screen' } }), '[image: error on screen]');
    assert.equal(support.bodyOf({ type: 'audio', audio: { voice: true } }), '[voice message]');
    assert.equal(support.bodyOf({ type: 'reaction', reaction: { emoji: '👍' } }), '');
  });

  test('overview counts the inbox; retention keeps messages 90 days', async () => {
    const o = (await app.inject({ method: 'GET', url: '/v1/whatsapp/overview' })).json();
    assert.equal(o.support.configured, true);
    assert.ok(o.support.aiReplies >= 3);
    assert.ok(o.support.handoffs >= 1);
    const c = await theConv();
    await query(`INSERT INTO whatsapp_chat_message (conversation_id, direction, author, body, created_at) VALUES ($1, 'in', 'customer', $2, now() - interval '91 days')`, [c.id, `old ${TAG}`]);
    const { runRetention } = await import('./retention.js');
    const out = await runRetention({ ocppFrameDays: 0, connectionAttemptDays: 0 });
    assert.ok(out.whatsappChat >= 1);
    assert.equal(await one(`SELECT 1 FROM whatsapp_chat_message WHERE body = $1`, [`old ${TAG}`]), null);
  });
});
