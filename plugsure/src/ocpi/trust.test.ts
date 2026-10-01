import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { seal } from '../services/secrets.js';
import { tokenHash, type TokenIn } from './mapping.js';
import { partnerActsFor, upsertToken, getPartner, type PartnerRow } from './store.js';
import { rolesProblem, registerFromPartner, ocpiPublicBase, RegistrationError } from './registration.js';
import { cdrPlausibilityProblem, receiveCdr, authorizeForCpo, cardUsage, EmspError } from './emsp.js';
import { pullHubClients } from './hubclients.js';
import { authorizeRoaming } from './authorize.js';
import { deliverDue } from './push.js';

/**
 * OCPI trust boundaries: who a partner may act for, whose tokens it may touch,
 * which charge records reach fleet invoices, and which approval a roaming uid
 * at a charger uses.
 *
 * The pure parts always run. The database-backed parts run only against the
 * disposable test database (like the other suites):
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npx tsx --test src/ocpi/trust.test.ts
 */

describe('ocpi trust: pure rules', () => {
  test('a partner registers only with the role of the kind the operator chose', () => {
    const r = (role: string) => ({ role, country_code: 'ID', party_id: 'AAA' });
    assert.equal(rolesProblem('emsp', [r('EMSP')]), null);
    assert.equal(rolesProblem('cpo', [r('CPO')]), null);
    assert.equal(rolesProblem('hub', [r('HUB')]), null);
    assert.match(rolesProblem('emsp', [r('EMSP'), r('CPO')])!, /EMSP role only/);
    assert.match(rolesProblem('cpo', [r('HUB')])!, /CPO role only/);
    assert.match(rolesProblem('emsp', [r('HUB')])!, /not HUB/);
  });

  test('charge record plausibility: ordinary records pass, absurd ones are held', () => {
    const at = new Date('2026-09-01T10:00:00Z');
    const c = (over: Partial<Parameters<typeof cdrPlausibilityProblem>[0]> = {}) =>
      cdrPlausibilityProblem({ currency: 'IDR', excl: 40_000, incl: 44_400, energyKwh: 12.5, start: at, end: new Date(at.getTime() + 3600_000), ...over });
    assert.equal(c(), null);
    assert.equal(c({ energyKwh: 0, excl: 5_000, incl: 5_550 }), null, 'a session fee on an empty charge fits');
    assert.match(c({ energyKwh: 600 })!, /500 kWh/);
    assert.match(c({ excl: 900_000, incl: 999_000, energyKwh: 10 })!, /IDR\/kWh/);
    assert.match(c({ incl: 30_000 })!, /less than excl_vat/);
    assert.match(c({ end: new Date(at.getTime() + 8 * 24 * 3600_000) })!, /7 days/);
    assert.equal(c({ currency: 'EUR', excl: 900, incl: 1000, energyKwh: 10 }), null, 'no price ceiling for currencies we never bill');
  });

  test('our public origin: configured, else the request only in development/test', () => {
    const saved = { env: config.env, url: config.ocpi.publicUrl };
    const req = { protocol: 'https', headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } };
    try {
      (config.ocpi as any).publicUrl = 'https://ocpi.example.co.id';
      assert.equal(ocpiPublicBase(req), 'https://ocpi.example.co.id');
      (config.ocpi as any).publicUrl = '';
      (config as any).env = 'test';
      assert.equal(ocpiPublicBase(req), 'https://evil.example');
      (config as any).env = 'production';
      assert.throws(() => ocpiPublicBase(req), (e: unknown) => e instanceof RegistrationError && e.httpStatus === 503 && /OCPI_PUBLIC_URL/.test(e.message));
    } finally {
      (config as any).env = saved.env;
      (config.ocpi as any).publicUrl = saved.url;
    }
  });
});

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[ocpi trust.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'ocpi-trust-test';
const IDENT = 'OCPI-TRUST-TEST-01';
const IDENT2 = 'OCPI-TRUST-TEST-02';
const party = { country_code: 'ZZ', party_id: 'T47', business_name: 'Trust Test' };
let orgId = '';
let cpId = '';
let cp2Id = '';
let connectorId = '';
let cardId = '';
const CARD_UID = 'TRUST-CARD-1';

// A partner's side of the handshake, for registration and hub pulls.
let hubList: unknown[] = [];
let mockUrl = '';
const mock = http.createServer((req, res) => {
  const send = (data: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data, status_code: 1000, timestamp: new Date().toISOString() })); };
  req.resume();
  req.on('end', () => {
    if (req.url === '/versions') return send([{ version: '2.2.1', url: `${mockUrl}/2.2.1` }]);
    if (req.url === '/2.2.1') return send({ version: '2.2.1', endpoints: [{ identifier: 'credentials', role: 'RECEIVER', url: `${mockUrl}/2.2.1/credentials` }] });
    if (req.url?.startsWith('/hub')) return send(hubList);
    send(null);
  });
});

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  await query(`DELETE FROM ocpi_push WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_message WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_partner WHERE org_id = $1`, [org.id]); // cascades tokens, approvals, remote data
  await query(`DELETE FROM ocpi_party WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  for (const ident of [IDENT, IDENT2]) {
    await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [ident]);
    await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [ident]);
    await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [ident]);
  }
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

async function partner(name: string, kind: PartnerRow['kind'], roles: Array<{ role: string; cc: string; pid: string }>, state = 'connected', endpoints: unknown[] = []): Promise<PartnerRow> {
  const tok = `${name}-${Math.random()}`;
  const r = await one<{ id: string }>(
    `INSERT INTO ocpi_partner (org_id, name, kind, state, token_in_hash, token_in, token_out, roles, country_code, party_id, endpoints)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [orgId, name, kind, state, tokenHash(tok), seal(tok), seal('out-' + tok),
      JSON.stringify(roles.map((x) => ({ role: x.role, country_code: x.cc, party_id: x.pid }))), roles[0]?.cc ?? null, roles[0]?.pid ?? null, JSON.stringify(endpoints)],
  );
  return (await getPartner(orgId, r!.id))!;
}

const tokenIn = (cc: string, pid: string, uid: string, over: Partial<TokenIn> = {}): TokenIn => ({
  country_code: cc, party_id: pid, uid, type: 'RFID', contract_id: `${cc}-${pid}-C${uid}`.slice(0, 36), visual_number: null, issuer: 'Test',
  group_id: null, valid: true, whitelist: 'ALLOWED', language: null, default_profile_type: null, energy_contract: null,
  last_updated: new Date(), ...over,
} as TokenIn);

if (DB_OK) {
  before(async () => {
    await cleanup();
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
    mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('OCPI Trust Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    await query(`INSERT INTO ocpi_party (org_id, country_code, party_id, business_name) VALUES ($1,$2,$3,$4)`, [orgId, party.country_code, party.party_id, party.business_name]);
    const siteId = (await one<{ id: string }>(`INSERT INTO site (org_id, name) VALUES ($1, 'Trust Hub') RETURNING id`, [orgId]))!.id;
    for (const ident of [IDENT, IDENT2]) {
      const id = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [siteId, ident]))!.id;
      const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [id]);
      const c = await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1, 1, 'Type2', 'AC', 22000) RETURNING id`, [e!.id]);
      if (ident === IDENT) { cpId = id; connectorId = c!.id; } else cp2Id = id;
    }
    cardId = (await one<{ id: string }>(
      `INSERT INTO token (org_id, kind, uid, status, roaming_shared, contract_id) VALUES ($1, 'rfid', $2, 'Accepted', true, 'ZZ-T47-CTRUST001') RETURNING id`, [orgId, CARD_UID]))!.id;
  });
  after(async () => {
    await cleanup();
    mock.close();
    await pool.end();
  });
}

dbDescribe('ocpi trust: who a partner acts for', () => {
  test('a partner acts for its own party, in its kind\'s role only', async () => {
    const a = await partner('emsp-a', 'emsp', [{ role: 'EMSP', cc: 'ID', pid: 'AAA' }]);
    assert.equal(await partnerActsFor(a, 'ID', 'AAA'), true);
    assert.equal(await partnerActsFor(a, 'ID', 'AAA', 'EMSP'), true);
    assert.equal(await partnerActsFor(a, 'ID', 'AAA', 'CPO'), false, 'an eMSP never publishes as a CPO');
    assert.equal(await partnerActsFor(a, 'ID', 'BBB'), false);
    // A row from before the fix whose roles do not match its kind gives nothing.
    const legacy = await partner('legacy', 'emsp', [{ role: 'CPO', cc: 'ID', pid: 'LEG' }]);
    assert.equal(await partnerActsFor(legacy, 'ID', 'LEG', 'CPO'), false);
  });

  test('a hub acts for nobody but itself until it reports its clients, then only for those', async () => {
    const hub = await partner('hub', 'hub', [{ role: 'HUB', cc: 'NL', pid: 'HUB' }]);
    assert.equal(await partnerActsFor(hub, 'NL', 'HUB'), true);
    assert.equal(await partnerActsFor(hub, 'NL', 'ABC'), false, 'fail closed with no HubClientInfo');
    await query(`INSERT INTO ocpi_hub_client (org_id, partner_id, country_code, party_id, role, status, last_updated) VALUES ($1,$2,'NL','ABC','EMSP','CONNECTED', now())`, [orgId, hub.id]);
    await query(`INSERT INTO ocpi_hub_client (org_id, partner_id, country_code, party_id, role, status, last_updated) VALUES ($1,$2,'NL','DEF','EMSP','SUSPENDED', now())`, [orgId, hub.id]);
    assert.equal(await partnerActsFor(hub, 'NL', 'ABC', 'EMSP'), true);
    assert.equal(await partnerActsFor(hub, 'NL', 'ABC', 'CPO'), false, 'in the role the hub reported');
    assert.equal(await partnerActsFor(hub, 'NL', 'DEF'), false);
    assert.equal(await partnerActsFor(hub, 'NL', 'XYZ'), false);
  });

  test('an empty hub pull keeps the clients we know', async () => {
    const hub = await partner('hub-pull', 'hub', [{ role: 'HUB', cc: 'NL', pid: 'HB2' }], 'connected',
      [{ identifier: 'hubclientinfo', role: 'SENDER', url: `${mockUrl}/hub` }]);
    hubList = [{ country_code: 'NL', party_id: 'ABC', role: 'EMSP', status: 'CONNECTED', last_updated: '2026-09-01T00:00:00Z' }];
    assert.deepEqual(await pullHubClients(hub), { clients: 1 });
    hubList = [];
    assert.deepEqual(await pullHubClients(hub), { clients: 0 });
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ocpi_hub_client WHERE partner_id = $1`, [hub.id]);
    assert.equal(n!.n, 1);
    assert.equal(await partnerActsFor(hub, 'NL', 'ABC'), true);
  });

  test('a partner cannot take over (or re-validate) another partner\'s token', async () => {
    const a = await partner('tok-a', 'emsp', [{ role: 'EMSP', cc: 'ID', pid: 'TKA' }]);
    const b = await partner('tok-b', 'emsp', [{ role: 'EMSP', cc: 'ID', pid: 'TKB' }]);
    const mine = await upsertToken(a, tokenIn('ID', 'TKA', 'T-1', { valid: false }));
    assert.ok(mine);
    assert.equal(await upsertToken(b, tokenIn('ID', 'TKA', 'T-1', { valid: true })), null);
    const row = await one<{ partner_id: string; valid: boolean }>(`SELECT partner_id, valid FROM ocpi_token WHERE id = $1`, [mine.id]);
    assert.deepEqual(row, { partner_id: a.id, valid: false });
    assert.ok(await upsertToken(a, tokenIn('ID', 'TKA', 'T-1', { valid: true })), 'its owner may update it');
  });
});

dbDescribe('ocpi trust: registration', () => {
  const body = (roles: Array<{ role: string; cc: string; pid: string }>) =>
    ({ token: 'their-token', url: `${mockUrl}/versions`, roles: roles.map((r) => ({ role: r.role, country_code: r.cc, party_id: r.pid })) });

  test('roles that do not match the pinned kind are refused (2001), and the kind never changes', async () => {
    const p = await partner('reg-cpo', 'cpo', [], 'pending');
    await assert.rejects(registerFromPartner(p, body([{ role: 'HUB', cc: 'ID', pid: 'RGC' }]), 'https://x', false),
      (e: unknown) => e instanceof RegistrationError && e.ocpiStatus === 2001);
    await assert.rejects(registerFromPartner(p, body([{ role: 'CPO', cc: 'ID', pid: 'RGC' }, { role: 'EMSP', cc: 'ID', pid: 'RGC' }]), 'https://x', false),
      (e: unknown) => e instanceof RegistrationError && e.ocpiStatus === 2001);
    await registerFromPartner(p, body([{ role: 'CPO', cc: 'ID', pid: 'RGC' }]), 'https://x', false);
    const after = (await getPartner(orgId, p.id))!;
    assert.equal(after.state, 'connected');
    assert.equal(after.kind, 'cpo');
  });

  test('an update cannot change the registered parties', async () => {
    const p = await partner('reg-upd', 'emsp', [], 'pending');
    await registerFromPartner(p, body([{ role: 'EMSP', cc: 'ID', pid: 'UPD' }]), 'https://x', false);
    const connected = (await getPartner(orgId, p.id))!;
    await assert.rejects(registerFromPartner(connected, body([{ role: 'EMSP', cc: 'ID', pid: 'OTH' }]), 'https://x', true),
      (e: unknown) => e instanceof RegistrationError && e.ocpiStatus === 2001 && /cannot be changed/.test(e.message));
    await registerFromPartner(connected, body([{ role: 'EMSP', cc: 'ID', pid: 'UPD' }]), 'https://x', true);
  });

  test('two racing first registrations: only one wins', async () => {
    const p = await partner('reg-race', 'emsp', [], 'pending');
    const r = await Promise.allSettled([1, 2].map(() => registerFromPartner(p, body([{ role: 'EMSP', cc: 'ID', pid: 'RCE' }]), 'https://x', false)));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    assert.ok(lost.reason instanceof RegistrationError && lost.reason.httpStatus === 405);
  });
});

dbDescribe('ocpi trust: charge records from CPOs', () => {
  let cpo: PartnerRow;
  const cdr = (id: string, over: Record<string, unknown> = {}) => ({
    country_code: 'ID', party_id: 'CPX', id, start_date_time: new Date(Date.now() - 3600_000).toISOString(), end_date_time: new Date().toISOString(),
    cdr_token: { country_code: party.country_code, party_id: party.party_id, uid: CARD_UID, type: 'RFID', contract_id: 'ZZ-T47-CTRUST001' },
    currency: 'IDR', total_cost: { excl_vat: 40_000, incl_vat: 44_400 }, total_energy: 12.5, last_updated: new Date().toISOString(), ...over,
  });
  const statusOf = async (ourId: string) => (await one<{ status: string }>(`SELECT status FROM ocpi_remote_cdr WHERE id = $1`, [ourId]))!.status;

  before(async () => {
    if (!DB_OK) return;
    cpo = await partner('cpo', 'cpo', [{ role: 'CPO', cc: 'ID', pid: 'CPX' }]);
    await query(
      `INSERT INTO ocpi_remote_session (org_id, partner_id, country_code, party_id, session_id, token_id, data, status, kwh, last_updated)
       VALUES ($1,$2,'ID','CPX','S-1',$3,'{}','COMPLETED',12.5, now())`, [orgId, cpo.id, cardId]);
  });

  test('a record for a session the CPO reported for this card is accepted', async () => {
    const id = await receiveCdr(cpo, party, cdr('C-OK', { session_id: 'S-1' }));
    assert.equal(await statusOf(id), 'accepted');
  });

  test('a record with no session or approval of ours is held, and does not count against the card', async () => {
    const before = await cardUsage(cardId);
    const id = await receiveCdr(cpo, party, cdr('C-ORPHAN', { session_id: 'S-UNKNOWN' }));
    assert.equal(await statusOf(id), 'held');
    assert.deepEqual(await cardUsage(cardId), before);
  });

  test('a record quoting our real-time authorisation is accepted', async () => {
    const a = await authorizeForCpo(cpo, party, CARD_UID, 'RFID', {});
    assert.equal(a?.allowed, 'ALLOWED');
    const id = await receiveCdr(cpo, party, cdr('C-AUTH', { authorization_reference: a!.authorization_reference }));
    assert.equal(await statusOf(id), 'accepted');
  });

  test('implausible totals are held even with a session; negative ones are refused', async () => {
    const id = await receiveCdr(cpo, party, cdr('C-BIG', { session_id: 'S-1', total_cost: { excl_vat: 9_000_000, incl_vat: 9_990_000 } }));
    assert.equal(await statusOf(id), 'held');
    await assert.rejects(receiveCdr(cpo, party, cdr('C-NEG', { session_id: 'S-1', total_cost: { excl_vat: -5, incl_vat: -5 } })),
      (e: unknown) => e instanceof EmspError && e.http === 400);
  });

  test('an eMSP cannot post charge records', async () => {
    const em = await partner('emsp-cdr', 'emsp', [{ role: 'EMSP', cc: 'ID', pid: 'CPY' }]);
    await assert.rejects(receiveCdr(em, party, cdr('C-EM', { party_id: 'CPY' })), (e: unknown) => e instanceof EmspError && e.http === 403);
  });
});

dbDescribe('ocpi trust: a roaming uid at our charger', () => {
  test('a revoked token is not accepted because another partner has a valid one with the same uid', async () => {
    const a = await partner('uid-a', 'emsp', [{ role: 'EMSP', cc: 'ID', pid: 'UDA' }]);
    const b = await partner('uid-b', 'emsp', [{ role: 'EMSP', cc: 'ID', pid: 'UDB' }]);
    await upsertToken(a, tokenIn('ID', 'UDA', 'SHARED-UID', { valid: false }));
    const tb = (await upsertToken(b, tokenIn('ID', 'UDB', 'SHARED-UID', { valid: true })))!;
    assert.equal((await authorizeRoaming(cpId, 'SHARED-UID'))?.status, 'Blocked');
    // An approval of B's token for ANOTHER charger does not help here...
    await query(`INSERT INTO ocpi_authorization (org_id, token_id, auth_method, charge_point_id, expires_at) VALUES ($1,$2,'COMMAND',$3, now() + interval '5 minutes')`, [orgId, tb.id, cp2Id]);
    assert.equal((await authorizeRoaming(cpId, 'SHARED-UID'))?.status, 'Blocked');
    // ...one for THIS charger (bound by its connector) says which driver it is.
    await query(`INSERT INTO ocpi_authorization (org_id, token_id, auth_method, connector_uuid, expires_at) VALUES ($1,$2,'COMMAND',$3, now() + interval '5 minutes')`, [orgId, tb.id, connectorId]);
    assert.equal((await authorizeRoaming(cpId, 'SHARED-UID'))?.status, 'Accepted');
  });

  test('ALLOWED_OFFLINE: accepted locally when the provider cannot be asked', async () => {
    const p = await partner('offline', 'emsp', [{ role: 'EMSP', cc: 'ID', pid: 'OFL' }]); // no tokens endpoint
    await upsertToken(p, tokenIn('ID', 'OFL', 'OFFLINE-UID', { whitelist: 'ALLOWED_OFFLINE' }));
    assert.equal((await authorizeRoaming(cpId, 'OFFLINE-UID'))?.status, 'Accepted');
    const q = await partner('never', 'emsp', [{ role: 'EMSP', cc: 'ID', pid: 'NVR' }]);
    await upsertToken(q, tokenIn('ID', 'NVR', 'NEVER-UID', { whitelist: 'NEVER' }));
    assert.equal((await authorizeRoaming(cpId, 'NEVER-UID'))?.status, 'Invalid', 'NEVER still needs an answer');
  });
});

dbDescribe('ocpi trust: the outbox', () => {
  test('a push whose attempt throws is dead-lettered after the last attempt', async () => {
    const p = await partner('push', 'emsp', [{ role: 'EMSP', cc: 'ID', pid: 'PSH' }], 'connected',
      [{ identifier: 'locations', role: 'RECEIVER', url: `${mockUrl}/locations` }]);
    // A location key that is not a site id makes rendering the body throw.
    const row = await one<{ id: string }>(
      `INSERT INTO ocpi_push (org_id, partner_id, module, action, object_key, attempts) VALUES ($1,$2,'locations','put','location:not-a-uuid', 7) RETURNING id`,
      [orgId, p.id],
    );
    await deliverDue(500);
    const r = await one<{ state: string; attempts: number; last_error: string }>(`SELECT state, attempts, last_error FROM ocpi_push WHERE id = $1`, [row!.id]);
    assert.equal(r!.attempts, 8);
    assert.equal(r!.state, 'failed');
    assert.match(r!.last_error, /internal error/);
  });
});
