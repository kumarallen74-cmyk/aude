import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { config } from '../config.js';
import { one, many, pool, query, tx } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { seal } from '../services/secrets.js';
import { authHeaderFor, tokenHash } from '../ocpi/mapping.js';

/**
 * PlugSure Hub (WP H1) against the database: the registry (internal join, the party-key rule, the
 * registration race), agreements, the open-routing index, ClientInfo visibility, outbox ordering and
 * coalescing, row-level security, and the hub's HTTP surface in-process (a tenant behind the in-process
 * transport, external members behind unreachable or hanging URLs: 4001, 4002, 4003, 4901, 4903, 4905).
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/hub/hub.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[hub.db.test] SKIPPING (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

// Hub configuration for this file (restored afterwards).
const saved = { ...config.hub, ocpiUrl: config.ocpi.publicUrl };
Object.assign(config.hub, { enabled: true, publicUrl: 'http://hub.test', forwardTimeoutMs: 600, realtimeTimeoutMs: 600 });
(config.ocpi as { publicUrl: string }).publicUrl = 'http://ocpi.test';

const { joinInternal, upsertParties, createExternalMember, partiesProblem, getParty, getMember, setPartyStatus } = await import('./registry.js');
const { mayRoute, agreedCounterparties, createAgreement, transitionAgreement } = await import('./agreements.js');
const { learn, resolveOpen } = await import('./route-index.js');
const { visibleTo, pushAgreementChange } = await import('./clientinfo.js');
const { enqueueHub, deliverHubDue } = await import('./outbox.js');
const { registerMember } = await import('./credentials.js');
const { registerHubApi, hubBuckets } = await import('./server.js');
const { registerOcpiApi } = await import('../ocpi/server.js');
const { setInprocApp } = await import('./transport.js');
type HubParty = import('./types.js').HubParty;
type HubConnection = import('./types.js').HubConnection;

const TAG = randomBytes(3).toString('hex');
const pid = (c: string) => `${c}${randomBytes(1).toString('hex').toUpperCase().slice(0, 1)}${'0123456789'[Math.floor(Math.random() * 10)]}`;
const T = { cc: 'ID', pid: pid('T') }; // the tenant
const XC = { cc: 'MY', pid: pid('C') }; // external CPO
const XE = { cc: 'SG', pid: pid('E') }; // external eMSP
const XE2 = { cc: 'SG', pid: pid('F') }; // another external eMSP
let tenantOrg = '';
const orgs: string[] = [];
const conns: Record<string, HubConnection> = {};
const tokens: Record<string, string> = {};
const parties: Record<string, HubParty> = {};
let app: FastifyInstance;
let hang: http.Server;
let hangUrl = '';
let member: http.Server;
let memberUrl = '';

async function external(name: string, country: string, roles: Array<{ role: string; cc: string; pid: string }>, endpoints: Array<{ identifier: string; role: string; url: string }>) {
  const m = await createExternalMember({ legal_name: `Hub DB Test ${name} ${TAG}`, country_code: country });
  orgs.push(m.org_id);
  await query(`UPDATE hub_member SET status = 'active' WHERE id = $1`, [m.id]);
  const id = randomUUID();
  const t = `hubdb-${name}-${randomUUID()}`;
  tokens[name] = t;
  conns[name] = (await one<HubConnection>(
    `INSERT INTO hub_connection (id, member_id, kind, state, token_in_hash, token_in, token_out, versions_url, version, endpoints, registered_at)
     VALUES ($1,$2,'external','connected',$3,$4,$5,'http://127.0.0.1:1/versions','2.2.1',$6, now()) RETURNING *`,
    [id, m.id, tokenHash(t), seal(t, `hub_connection:${id}:in`), seal('out-' + t, `hub_connection:${id}:out`), JSON.stringify(endpoints)]))!;
  const rows = await tx(async (c) => upsertParties(c, (await getMember(m.id))!, id, roles.map((r) => ({ role: r.role, country_code: r.cc, party_id: r.pid, business_name: name }))));
  for (const r of rows) parties[`${name}:${r.role}`] = r;
}

async function cleanup() {
  const ms = (await many<{ id: string; org_id: string }>(`SELECT id, org_id FROM hub_member WHERE legal_name LIKE $1 OR org_id = $2`, [`Hub DB Test % ${TAG}`, tenantOrg || null]));
  const ids = ms.map((m) => m.id);
  if (!ids.length) return;
  const cs = (await many<{ id: string }>(`SELECT id FROM hub_connection WHERE member_id = ANY($1::uuid[])`, [ids])).map((c) => c.id);
  const ps = (await many<{ id: string }>(`SELECT id FROM hub_party WHERE member_id = ANY($1::uuid[])`, [ids])).map((p) => p.id);
  await query(`DELETE FROM hub_outbox WHERE recipient_connection_id = ANY($1::uuid[]) OR origin_party_id = ANY($2::uuid[]) OR recipient_party_id = ANY($2::uuid[])`, [cs, ps]);
  await query(`DELETE FROM hub_callback WHERE origin_party_id = ANY($1::uuid[]) OR target_party_id = ANY($1::uuid[])`, [ps]);
  await query(`DELETE FROM hub_route_index WHERE owner_party_id = ANY($1::uuid[]) OR counter_party_id = ANY($1::uuid[])`, [ps]);
  await query(`DELETE FROM hub_agreement WHERE cpo_party_id = ANY($1::uuid[]) OR emsp_party_id = ANY($1::uuid[])`, [ps]);
  await query(`DELETE FROM hub_message WHERE connection_id = ANY($1::uuid[])`, [cs]);
  await query(`DELETE FROM hub_party WHERE member_id = ANY($1::uuid[])`, [ids]);
  await query(`DELETE FROM hub_party_key WHERE member_id = ANY($1::uuid[])`, [ids]);
  await query(`DELETE FROM hub_connection WHERE member_id = ANY($1::uuid[])`, [ids]);
  await query(`DELETE FROM hub_member WHERE id = ANY($1::uuid[])`, [ids]);
}

if (DB_OK) {
  before(async () => {
    tenantOrg = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Hub DB Tenant ${TAG}`, `hub-db-tenant-${TAG}`]))!.id;
    await query(`INSERT INTO ocpi_party (org_id, country_code, party_id, business_name, is_home) VALUES ($1,$2,$3,'Hub DB Tenant', true)`, [tenantOrg, T.cc, T.pid]);
    hang = http.createServer(() => { /* never answers */ });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    hangUrl = `http://127.0.0.1:${(hang.address() as { port: number }).port}`;
    // A member platform for the registration race: versions and endpoints only.
    member = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const data = req.url === '/m/versions' ? [{ version: '2.2.1', url: `${memberUrl}/m/2.2.1` }]
        : { version: '2.2.1', endpoints: [{ identifier: 'credentials', role: 'RECEIVER', url: `${memberUrl}/m/2.2.1/credentials` }] };
      setTimeout(() => res.end(JSON.stringify({ data, status_code: 1000, timestamp: new Date().toISOString() })), 30);
    });
    await new Promise<void>((r) => member.listen(0, '127.0.0.1', () => r()));
    memberUrl = `http://127.0.0.1:${(member.address() as { port: number }).port}`;

    await external('xc', 'MY', [{ role: 'CPO', ...XC }], [
      { identifier: 'locations', role: 'SENDER', url: `${hangUrl}/locations` },
      { identifier: 'tariffs', role: 'SENDER', url: 'http://127.0.0.1:1/tariffs' },
      { identifier: 'hubclientinfo', role: 'RECEIVER', url: 'http://127.0.0.1:1/hubclientinfo' },
    ]);
    await external('xe', 'SG', [{ role: 'EMSP', ...XE }], [{ identifier: 'locations', role: 'RECEIVER', url: 'http://127.0.0.1:1/locations' }]);
    await external('xe2', 'SG', [{ role: 'EMSP', ...XE2 }, { role: 'OTHER', ...XE2 }], []);

    app = Fastify();
    await registerOcpiApi(app);
    await registerHubApi(app);
    await app.ready();
    setInprocApp(app);
  });
  after(async () => {
    setInprocApp(null);
    await app?.close();
    hang?.closeAllConnections?.(); hang?.close();
    member?.close();
    await cleanup();
    const partners = (await many<{ id: string }>(`SELECT id FROM ocpi_partner WHERE org_id = $1`, [tenantOrg])).map((p) => p.id);
    await query(`DELETE FROM ocpi_message WHERE org_id = $1`, [tenantOrg]);
    await query(`DELETE FROM ocpi_hub_client WHERE partner_id = ANY($1::uuid[])`, [partners]);
    await query(`DELETE FROM ocpi_remote_location WHERE org_id = $1`, [tenantOrg]);
    await query(`DELETE FROM ocpi_push WHERE org_id = $1`, [tenantOrg]);
    await query(`DELETE FROM ocpi_partner WHERE org_id = $1`, [tenantOrg]);
    await query(`DELETE FROM ocpi_party WHERE org_id = $1`, [tenantOrg]);
    await query(`DELETE FROM organisation WHERE id = ANY($1::uuid[])`, [[tenantOrg, ...orgs]]);
    Object.assign(config.hub, saved);
    (config.ocpi as { publicUrl: string }).publicUrl = saved.ocpiUrl;
    await pool.end();
  });
}

const call = async (who: string, method: string, path: string, o: { from?: { cc: string; pid: string } | null; to?: { cc: string; pid: string }; body?: unknown } = {}) => {
  const r = await app.inject({
    method: method as 'GET', url: path ? `/hub/ocpi/2.2.1/${path}` : '/hub/ocpi/2.2.1',
    headers: {
      authorization: authHeaderFor(tokens[who]!), host: 'hub.test',
      ...(o.from ? { 'ocpi-from-country-code': o.from.cc, 'ocpi-from-party-id': o.from.pid } : {}),
      ...(o.to ? { 'ocpi-to-country-code': o.to.cc, 'ocpi-to-party-id': o.to.pid } : {}),
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
  });
  let body: any = null;
  try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body, headers: r.headers };
};

dbDescribe('registry', () => {
  test('a tenant joins in one transaction: hub connection and "PlugSure Hub" partner mirror each other; idempotent', async () => {
    const r = await joinInternal(tenantOrg, null);
    assert.equal(r.created, true);
    const p = await one<{ kind: string; state: string; token_in_hash: string; country_code: string; party_id: string }>(`SELECT * FROM ocpi_partner WHERE id = $1`, [r.partnerId]);
    assert.equal(p?.kind, 'hub');
    assert.equal(p?.state, 'connected');
    assert.equal(p?.party_id, 'PSH');
    assert.equal(r.connection.kind, 'internal');
    assert.equal(r.connection.peer_partner_id, r.partnerId);
    assert.notEqual(p?.token_in_hash, r.connection.token_in_hash, 'two different tokens, one per direction');
    const hp = await many<HubParty>(`SELECT * FROM hub_party WHERE connection_id = $1 ORDER BY role`, [r.connection.id]);
    assert.deepEqual(hp.map((x) => `${x.role}:${x.country_code}*${x.party_id}:${x.status}`), [`CPO:${T.cc}*${T.pid}:PLANNED`, `EMSP:${T.cc}*${T.pid}:PLANNED`]);
    const again = await joinInternal(tenantOrg, null);
    assert.equal(again.created, false);
    assert.equal(again.connection.id, r.connection.id);
    conns.t = r.connection;
    await query(`UPDATE hub_member SET status = 'active' WHERE id = $1`, [r.member.id]);
    await setPartyStatus(hp.map((x) => x.id), 'CONNECTED');
    for (const x of hp) parties[`t:${x.role}`] = (await getParty(x.id))!;
  });

  test('one member per (country_code, party_id): another member cannot register the tenant\'s party or the hub\'s own', async () => {
    const xm = (await getMember(parties['xc:CPO']!.member_id))!;
    assert.match(String(await partiesProblem(xm.id, xm.org_id, [{ role: 'EMSP', country_code: T.cc, party_id: T.pid, business_name: 'x' }])), /another member|another operator/);
    assert.match(String(await partiesProblem(xm.id, xm.org_id, [{ role: 'EMSP', country_code: 'ID', party_id: 'PSH', business_name: 'x' }])), /hub's own/);
    assert.match(String(await partiesProblem(xm.id, xm.org_id, [{ role: 'HUB', country_code: 'MY', party_id: 'ZZZ', business_name: 'x' }])), /role HUB/);
    assert.equal(await partiesProblem(xm.id, xm.org_id, [{ role: 'EMSP', country_code: XC.cc, party_id: XC.pid, business_name: 'x' }]), null, 'its own (cc, pid) in another role is fine');
  });

  test('two registrations racing with the same token A: exactly one wins', async () => {
    const m = await createExternalMember({ legal_name: `Hub DB Test race ${TAG}`, country_code: 'MY' });
    orgs.push(m.org_id);
    const id = randomUUID();
    const conn = (await one<HubConnection>(`INSERT INTO hub_connection (id, member_id, kind, state, token_in_hash, token_in) VALUES ($1,$2,'external','pending',$3,$4) RETURNING *`,
      [id, m.id, tokenHash('A-' + id), seal('A-' + id, `hub_connection:${id}:in`)]))!;
    const body = (tok: string) => ({ token: tok, url: `${memberUrl}/m/versions`, roles: [{ role: 'CPO', country_code: 'MY', party_id: pid('R'), business_details: { name: 'Race' } }] });
    const b = body('B1');
    const results = await Promise.allSettled([registerMember(conn, b, false), registerMember(conn, { ...b, token: 'B2' }, false)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(lost.reason.http, 405);
    assert.equal((await one<{ state: string }>(`SELECT state FROM hub_connection WHERE id = $1`, [id]))?.state, 'connected');
  });
});

dbDescribe('agreements (D7)', () => {
  test('no agreement → 4901; active → may route; module flags; same side → 2001; same member → refused', async () => {
    const c = parties['xc:CPO']!; const e = parties['xe:EMSP']!; const t = parties['t:EMSP']!;
    assert.equal((await mayRoute(c, e)).code, 4901);
    const a = await createAgreement({ cpo: c, emsp: e, by: 'platform', activate: true, allow_commands: false });
    assert.equal((await mayRoute(e, c)).ok, true);
    assert.equal((await mayRoute(e, c, 'commands')).code, 4901);
    assert.equal((await mayRoute(e, c, 'realtime')).ok, true);
    assert.equal((await mayRoute(e, parties['xe2:EMSP']!)).code, 2001);
    assert.equal((await mayRoute(parties['t:CPO']!, t)).code, 4901);
    await assert.rejects(createAgreement({ cpo: parties['t:CPO']!, emsp: t, by: 'platform', activate: true }), /itself/);
    await assert.rejects(createAgreement({ cpo: c, emsp: e, by: 'platform', activate: true }), /already exists/);
    await transitionAgreement(a.id, 'suspend');
    assert.equal((await mayRoute(e, c)).ok, false);
    await transitionAgreement(a.id, 'resume');
    assert.equal((await mayRoute(e, c)).ok, true);
  });

  test('an agreement outside its validity window does not count', async () => {
    const c = parties['xc:CPO']!; const e2 = parties['xe2:EMSP']!;
    await createAgreement({ cpo: c, emsp: e2, by: 'platform', activate: true, valid_from: new Date(Date.now() - 86_400_000), valid_to: new Date(Date.now() - 3_600_000) });
    assert.equal((await mayRoute(c, e2)).ok, false);
  });

  test('mutual open roaming routes without an agreement; one-sided does not', async () => {
    const c = parties['xc:CPO']!; const o = parties['xe2:OTHER']!;
    assert.equal((await mayRoute(c, o)).ok, false);
    await query(`UPDATE hub_member SET open_roaming = true WHERE id = $1`, [c.member_id]);
    assert.equal((await mayRoute(c, o)).ok, false);
    await query(`UPDATE hub_member SET open_roaming = true WHERE id = $1`, [o.member_id]);
    assert.equal((await mayRoute(c, o)).open, true);
    await query(`UPDATE hub_member SET open_roaming = false WHERE id = ANY($1::uuid[])`, [[c.member_id, o.member_id]]);
  });

  test('counterparties: opposite role, other member, agreed only', async () => {
    const list = (await agreedCounterparties(parties['xc:CPO']!)).map((p) => `${p.role}:${p.party_id}`);
    assert.deepEqual(list, [`EMSP:${XE.pid}`]);
    assert.deepEqual(await agreedCounterparties(parties['t:CPO']!), []);
  });
});

dbDescribe('open-routing index', () => {
  test('none → 4001; one agreed → it; unagreed candidates are filtered BEFORE the ambiguity check; two agreed → 4904', async () => {
    const e = parties['xe:EMSP']!;
    const load = (id: string) => getParty(id);
    await assert.rejects(resolveOpen('location', `LOC-${TAG}`, e, { targetRoles: ['CPO'] }, load), (x: any) => x.ocpi === 4001);
    await learn('location', `LOC-${TAG}`, parties['xc:CPO']!);
    await learn('location', `LOC-${TAG}`, parties['t:CPO']!); // the tenant has no agreement with e
    assert.equal((await resolveOpen('location', `LOC-${TAG}`, e, { targetRoles: ['CPO'] }, load)).target.id, parties['xc:CPO']!.id);
    await createAgreement({ cpo: parties['t:CPO']!, emsp: e, by: 'platform', activate: true });
    await assert.rejects(resolveOpen('location', `LOC-${TAG}`, e, { targetRoles: ['CPO'] }, load), (x: any) => x.ocpi === 4904);
    // The module flag filters too: only the tenant's agreement allows commands (xc⇄xe has allow_commands=false).
    assert.equal((await resolveOpen('location', `LOC-${TAG}`, e, { targetRoles: ['CPO'], flag: 'commands' }, load)).target.id, parties['t:CPO']!.id);
  });
  test('sessions: only the counter party (the session\'s eMSP) may route by it; expired entries are ignored', async () => {
    const load = (id: string) => getParty(id);
    await learn('session', `S-${TAG}`, parties['xc:CPO']!, parties['xe:EMSP']!);
    assert.equal((await resolveOpen('session', `S-${TAG}`, parties['xe:EMSP']!, { targetRoles: ['CPO'], requireCounter: true }, load)).target.id, parties['xc:CPO']!.id);
    await assert.rejects(resolveOpen('session', `S-${TAG}`, parties['xe2:EMSP']!, { targetRoles: ['CPO'], requireCounter: true }, load), (x: any) => x.ocpi === 4001);
    await query(`UPDATE hub_route_index SET expires_at = now() - interval '1 second' WHERE kind = 'session' AND key = $1`, [`S-${TAG}`]);
    await assert.rejects(resolveOpen('session', `S-${TAG}`, parties['xe:EMSP']!, { targetRoles: ['CPO'], requireCounter: true }, load), (x: any) => x.ocpi === 4001);
  });
});

dbDescribe('ClientInfo visibility', () => {
  test('a connection sees its agreed counterparties, never its own member\'s parties nor unagreed ones', async () => {
    const seen = (await visibleTo(conns.xe!.id)).map((p) => `${p.role}:${p.party_id}`).sort();
    assert.deepEqual(seen, [`CPO:${T.pid}`, `CPO:${XC.pid}`].sort());
    const tenant = (await visibleTo(conns.t!.id)).map((p) => `${p.role}:${p.party_id}`);
    assert.deepEqual(tenant, [`EMSP:${XE.pid}`], 'the tenant\'s own CPO and eMSP do not see each other');
    assert.deepEqual((await visibleTo(conns.xe2!.id)).map((p) => p.party_id), []);
  });
});

dbDescribe('outbox', () => {
  test('a newer unsent PUT supersedes older unsent PUT/PATCH of the same object; ClientInfo is claimed first', async () => {
    const c = conns.xe2!.id;
    const base = { kind: 'broadcast' as const, recipientConnectionId: c, module: 'locations', objectKey: `locations:MY:X:${TAG}`, correlationId: 'k' };
    const a = await enqueueHub({ ...base, method: 'PUT', body: { n: 1 } });
    const b = await enqueueHub({ ...base, method: 'PATCH', body: { n: 2 } });
    const d = await enqueueHub({ ...base, method: 'PUT', body: { n: 3 } });
    const rows = await many<{ id: string; state: string }>(`SELECT id, state FROM hub_outbox WHERE id = ANY($1::bigint[]) ORDER BY id`, [[a, b, d]]);
    assert.deepEqual(rows.map((r) => r.state), ['dropped', 'dropped', 'pending']);
    const ci = await enqueueHub({ kind: 'clientinfo', recipientConnectionId: c, module: 'hubclientinfo', method: 'PUT', pathSuffix: '/MY/X', body: {}, objectKey: `clientinfo:${TAG}`, correlationId: 'k' });
    // xe2 has no endpoints: both rows fail, but the ClientInfo row is attempted first.
    await deliverHubDue(100);
    const after = await many<{ id: string; kind: string; state: string; attempts: number; last_error: string }>(`SELECT id, kind, state, attempts, last_error FROM hub_outbox WHERE id = ANY($1::bigint[])`, [[ci, d]]);
    const ciRow = after.find((r) => Number(r.id) === ci)!;
    assert.equal(ciRow.attempts, 1);
    assert.equal(ciRow.state, 'failed');
    assert.match(ciRow.last_error, /no hubclientinfo RECEIVER/);
  });

  test('review180: replay skips a failed message superseded by a later delivered or pending one of the same object', async () => {
    const c = conns.xe2!.id;
    const key = (k: string) => `locations:MY:R:${TAG}${k}`;
    const ins = async (k: string, state: string, n: number) => (await one<{ id: string }>(
      `INSERT INTO hub_outbox (kind, recipient_connection_id, module, method, path_suffix, body, object_key, correlation_id, state, attempts)
       VALUES ('broadcast',$1,'locations','PUT','/MY/R/L',$2,$3,'k',$4,8) RETURNING id`, [c, JSON.stringify({ n }), key(k), state]))!.id;
    const staleA = await ins('a', 'failed', 1); await ins('a', 'delivered', 2);
    const staleB = await ins('b', 'failed', 1); await ins('b', 'pending', 2);
    const lone = await ins('c', 'failed', 1);
    const { replayHub } = await import('./outbox.js');
    const n = await replayHub(c);
    const st = async (id: string) => (await one<{ state: string }>(`SELECT state FROM hub_outbox WHERE id = $1`, [id]))!.state;
    assert.equal(await st(staleA), 'dropped', 'a newer copy was delivered');
    assert.equal(await st(staleB), 'dropped', 'a newer copy is still to be delivered');
    assert.equal(await st(lone), 'pending', 'nothing newer: replayed');
    assert.ok(n >= 1);
    await query(`DELETE FROM hub_outbox WHERE object_key LIKE $1`, [`locations:MY:R:${TAG}%`]);
  });
});

dbDescribe('row-level security (§3.1)', () => {
  test('inside a tenant\'s scope: its own hub_party rows only, agreements it is party to, never connections', async () => {
    const password = process.env.POSTGRES_APP_PASSWORD;
    if (!password) return;
    const u = new URL(config.databaseUrl);
    u.username = 'plugsure_app';
    u.password = password;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.rls_bypass', 'off', true), set_config('app.current_org_id', $1, true)`, [tenantOrg]);
      const ps = (await c.query(`SELECT org_id FROM hub_party`)).rows;
      assert.ok(ps.length >= 2 && ps.every((r) => r.org_id === tenantOrg));
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM hub_connection`)).rows[0].n, 0);
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM hub_outbox`)).rows[0].n, 0);
      const ag = (await c.query(`SELECT cpo_org_id, emsp_org_id FROM hub_agreement`)).rows;
      assert.ok(ag.length >= 1 && ag.every((r) => r.cpo_org_id === tenantOrg || r.emsp_org_id === tenantOrg));
      // review180 (074): read-only in the member's scope — its own rows cannot be changed from there.
      for (const sql of [`UPDATE hub_party SET status = 'CONNECTED'`, `UPDATE hub_member SET open_roaming = true`,
        `UPDATE hub_agreement SET allow_commands = true`, `DELETE FROM hub_agreement`]) {
        assert.equal((await c.query(sql)).rowCount, 0, sql);
      }
      await c.query('SAVEPOINT s');
      await assert.rejects(c.query(`INSERT INTO hub_member (org_id, kind, legal_name, country_code) VALUES ($1,'internal','x','ID')`, [tenantOrg]), /row-level security/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});

dbDescribe('the hub surface, in-process', () => {
  test('no token → 401; a tenant partner token is not a hub token', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/hub/ocpi/versions' })).statusCode, 401);
    const v = await call('xc', 'GET', '');
    assert.equal(v.status, 200);
    assert.ok(v.body.data.endpoints.some((e: any) => e.identifier === 'locations' && e.role === 'RECEIVER' && e.url === 'http://hub.test/hub/ocpi/2.2.1/receiver/locations'));
  });

  test('a broadcast reaches the tenant in-process (ClientInfo first, then the location) — and not an unagreed member', async () => {
    await createAgreement({ cpo: parties['xc:CPO']!, emsp: parties['t:EMSP']!, by: 'platform', activate: true });
    await pushAgreementChange(parties['xc:CPO']!.id, parties['t:EMSP']!.id, true);
    const loc = { country_code: XC.cc, party_id: XC.pid, id: `L-${TAG}`, name: 'Mall', address: 'Jalan 1', city: 'KL', country: 'MYS',
      coordinates: { latitude: '3.1', longitude: '101.7' }, evses: [], last_updated: '2026-10-01T10:00:00Z' };
    const r = await call('xc', 'PUT', `receiver/locations/${XC.cc}/${XC.pid}/${loc.id}`, { from: XC, to: { cc: 'MY', pid: 'PSH' }, body: loc });
    assert.equal(r.status, 200);
    assert.equal(r.body.status_code, 1000);
    assert.equal(r.headers['ocpi-from-party-id'], 'PSH');
    // The router kicks the outbox itself; wait for that pass (or run one).
    let row: { data: any } | null = null;
    for (let i = 0; i < 30 && !row; i++) {
      await deliverHubDue(100);
      row = await one<{ data: any }>(`SELECT data FROM ocpi_remote_location WHERE org_id = $1 AND location_id = $2`, [tenantOrg, loc.id]);
      if (!row) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(row?.data?.last_updated, loc.last_updated);
    const legs = await many<{ route: string }>(`SELECT route FROM hub_message WHERE leg = 'out' AND connection_id = $1 AND route LIKE 'broadcast%'`, [conns.t!.id]);
    assert.ok(legs.some((l) => l.route === 'broadcast+inproc'));
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM hub_outbox WHERE recipient_connection_id = $1 AND object_key LIKE $2`, [conns.xe2!.id, `locations:%:${loc.id}`]))?.n, 0);
  });

  test('a spoofed OCPI-from → 403 / 4903; a party pushing under another party\'s URL → 2001', async () => {
    const r = await call('xc', 'GET', 'sender/locations', { from: XE, to: { cc: 'MY', pid: 'PSH' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.status_code, 4903);
    const u = await call('xc', 'PUT', `receiver/locations/${T.cc}/${T.pid}/X`, { from: XC, body: { last_updated: '2026-10-01T10:00:00Z' } });
    assert.equal(u.status, 400);
    assert.equal(u.body.status_code, 2001);
  });

  test('no agreement → 403 / 4901; unknown receiver → 4001', async () => {
    const r = await call('xe2', 'GET', 'sender/locations', { from: XE2, to: XC });
    assert.equal(r.status, 403);
    assert.equal(r.body.status_code, 4901);
    const u = await call('xe', 'GET', 'sender/locations', { from: XE, to: { cc: 'SG', pid: 'ZZZ' } });
    assert.equal(u.status, 200);
    assert.equal(u.body.status_code, 4001);
  });

  test('a receiver that does not answer in time → 4002; one that cannot be reached → 4003', async () => {
    const t0 = Date.now();
    const slow = await call('xe', 'GET', 'sender/locations', { from: XE, to: XC });
    assert.equal(slow.body.status_code, 4002);
    assert.ok(Date.now() - t0 < 5_000);
    const down = await call('xe', 'GET', 'sender/tariffs', { from: XE, to: XC });
    assert.equal(down.body.status_code, 4003);
    const none = await call('xe', 'GET', 'sender/cdrs', { from: XE, to: XC });
    assert.equal(none.body.status_code, 4003, 'a module the receiver does not implement');
  });

  test('the tenant answers through the hub with the routing headers swapped (from = receiver, to = requester)', async () => {
    await query(`UPDATE hub_party SET status = 'CONNECTED' WHERE id = $1`, [parties['t:CPO']!.id]);
    // The tenant accepts a party behind the hub only once ClientInfo announced it.
    await pushAgreementChange(parties['t:CPO']!.id, parties['xe:EMSP']!.id, true);
    for (let i = 0; i < 3; i++) await deliverHubDue(100);
    const r = await call('xe', 'GET', 'sender/locations', { from: XE, to: T });
    assert.equal(r.status, 200);
    assert.equal(r.headers['ocpi-from-party-id'], T.pid);
    assert.equal(r.headers['ocpi-to-party-id'], XE.pid);
    assert.ok(Array.isArray(r.body.data));
  });

  test('review180: a charging profile the CPO did not accept teaches no profile setter; an external member\'s response_url on our own origin is refused', async () => {
    const before = conns.xc!.endpoints;
    const eps = [...(before as unknown as Array<Record<string, string>>), { identifier: 'chargingprofiles', role: 'RECEIVER', url: 'http://127.0.0.1:1/cp' },
      { identifier: 'commands', role: 'RECEIVER', url: 'http://127.0.0.1:1/cmd' }];
    await query(`UPDATE hub_connection SET endpoints = $2 WHERE id = $1`, [conns.xc!.id, JSON.stringify(eps)]);
    try {
      const S = `RV180-${TAG}`;
      const cp = await call('xe', 'PUT', `receiver/chargingprofiles/${S}`, { from: XE, to: XC,
        body: { charging_profile: { charging_rate_unit: 'W', charging_profile_period: [{ start_period: 0, limit: 1000 }] }, response_url: 'http://127.0.0.1:1/result' } });
      assert.equal(cp.body.status_code, 4003, JSON.stringify(cp.body));
      assert.equal(await one(`SELECT 1 FROM hub_route_index WHERE kind = 'command_session' AND key = $1`, [S]), null,
        'a profile the CPO never accepted must not route its ActiveChargingProfile updates to the requester');
      const cmd = await call('xe', 'PUT', `receiver/chargingprofiles/${S}`, { from: XE, to: XC,
        body: { charging_profile: { charging_rate_unit: 'W', charging_profile_period: [{ start_period: 0, limit: 1000 }] }, response_url: 'http://ocpi.test/v1/auth/login' } });
      assert.equal(cmd.status, 400, JSON.stringify(cmd.body));
      assert.equal(cmd.body.status_code, 2001);
      const { inprocPathAllowed } = await import('./transport.js');
      assert.equal(inprocPathAllowed('http://ocpi.test/ocpi/2.2.1/emsp/commands/START_SESSION/x'), true);
      assert.equal(inprocPathAllowed('http://hub.test/hub/ocpi/2.2.1/sender/commands/START_SESSION/x'), true);
      assert.equal(inprocPathAllowed('http://ocpi.test/v1/auth/login'), false);
      assert.equal(inprocPathAllowed('http://ocpi.test/ocpi/../v1/auth/login'), false);
      assert.equal(inprocPathAllowed('http://ocpi.test/ocpi/%2e%2e/v1/auth/login'), false);
    } finally {
      await query(`UPDATE hub_connection SET endpoints = $2 WHERE id = $1`, [conns.xc!.id, JSON.stringify(before)]);
    }
  });

  test('review180: a broadcast cannot reuse a location id another live party published (no 4904 denial of service)', async () => {
    const taken = `RV180-LOC-${TAG}`;
    await learn('location', taken, parties['t:CPO']!);
    const loc = (id: string) => ({ country_code: XC.cc, party_id: XC.pid, id, last_updated: '2026-10-01T10:00:00Z' });
    const r = await call('xc', 'PUT', `receiver/locations/${XC.cc}/${XC.pid}/${taken}`, { from: XC, to: { cc: 'MY', pid: 'PSH' }, body: loc(taken) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.status_code, 2001);
    assert.match(r.body.status_message, /already published/);
    const ok = await call('xc', 'PUT', `receiver/locations/${XC.cc}/${XC.pid}/RV180-OWN-${TAG}`, { from: XC, to: { cc: 'MY', pid: 'PSH' }, body: loc(`RV180-OWN-${TAG}`) });
    assert.equal(ok.body.status_code, 1000, JSON.stringify(ok.body));
    const again = await call('xc', 'PUT', `receiver/locations/${XC.cc}/${XC.pid}/RV180-OWN-${TAG}`, { from: XC, to: { cc: 'MY', pid: 'PSH' }, body: loc(`RV180-OWN-${TAG}`) });
    assert.equal(again.body.status_code, 1000, 'its own id again');
  });

  test('review180: a CDR goes to the eMSP of its token — addressed to another eMSP it is refused, not forwarded', async () => {
    const cdr = (tok: { cc: string; pid: string } | null) => ({ country_code: XC.cc, party_id: XC.pid, id: `RV180-${TAG}-${tok?.pid ?? 'none'}`, currency: 'MYR',
      start_date_time: '2026-10-02T01:00:00Z', end_date_time: '2026-10-02T02:00:00Z', total_cost: { excl_vat: 1 }, total_energy: 1,
      cdr_token: tok ? { country_code: tok.cc, party_id: tok.pid, uid: 'U', type: 'RFID', contract_id: 'C' } : { uid: 'U', type: 'RFID', contract_id: 'C' },
      cdr_location: { id: 'L', country: 'MYS' }, last_updated: '2026-10-02T02:00:00Z' });
    for (const tok of [XE2, null]) {
      const r = await call('xc', 'POST', 'receiver/cdrs', { from: XC, to: XE, body: cdr(tok) });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.status_code, 2001);
      assert.match(r.body.status_message, /eMSP of its token/);
    }
  });

  test('over the connection\'s rate limit → 429 / 4905 with Retry-After', async () => {
    await query(`UPDATE hub_connection SET rate_limit_per_min = 2 WHERE id = $1`, [conns.xe2!.id]);
    hubBuckets.clear();
    const s = [];
    for (let i = 0; i < 4; i++) s.push(await call('xe2', 'GET', 'hubclientinfo'));
    const limited = s.find((x) => x.status === 429);
    assert.ok(limited, JSON.stringify(s.map((x) => x.status)));
    assert.equal(limited!.body.status_code, 4905);
    assert.ok(limited!.headers['retry-after']);
  });
});
