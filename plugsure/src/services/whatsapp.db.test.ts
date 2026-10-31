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
