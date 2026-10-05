import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { seal } from '../services/secrets.js';
import { authHeaderFor, tokenHash } from './mapping.js';
import { registerOcpiApi } from './server.js';

/**
 * WP H0 (v1.7.1): isolation of the parties behind a roaming HUB.
 *
 * A hub connection is one partner row (one credentials token) that stands for
 * many parties. Every functional module must therefore act for the party named
 * in OCPI-from-country-code / OCPI-from-party-id (one the hub announced through
 * HubClientInfo, in the right role), and only on that party's objects:
 *
 *   CPO side   sessions / CDRs (by the token's party), tokens GET/PUT/PATCH,
 *              commands (STOP_SESSION, START_SESSION, UNLOCK_CONNECTOR,
 *              RESERVE_NOW, CANCEL_RESERVATION), chargingprofiles
 *   eMSP side  locations / tariffs / sessions (URL party), CDRs (body party),
 *              GET of what was received, command results (the command's target)
 *
 * Peer (non-hub) connections keep their v1.7.0 behaviour (last block).
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/ocpi/hub-isolation.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[ocpi hub-isolation.test] SKIPPING (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'ocpi-h0-test';
const IDENT = 'OCPI-H0-TEST-01';
const V = '/ocpi/2.2.1';
const HOME = { country_code: 'ID', party_id: 'H0P' };
const A = { cc: 'ID', pid: 'EXA' }; // eMSP behind the hub
const B = { cc: 'ID', pid: 'EXB' }; // another eMSP behind the same hub
const CA = { cc: 'ID', pid: 'CPA' }; // CPO behind the hub
const CB = { cc: 'ID', pid: 'CPB' }; // another CPO behind the same hub

let app: FastifyInstance;
let orgId = '';
let siteId = '';
let cpId = '';
const connectors: string[] = [];
let cardId = '';
const CARD_UID = 'H0-CARD-1';
const tok: Record<string, string> = {};
const pid: Record<string, string> = {};
let sessA = '';
let sessB = '';
let tokA = '';
let tokB = '';

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  await query(`DELETE FROM ocpi_push WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_message WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_charging_profile WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_authorization WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM cdr WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_reservation WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_command WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_partner WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_party WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [IDENT]);
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

async function partner(name: string, kind: string, roles: Array<{ role: string; cc: string; pid: string }>): Promise<void> {
  const t = `h0-${name}-${randomUUID()}`;
  const r = await one<{ id: string }>(
    `INSERT INTO ocpi_partner (org_id, name, kind, state, token_in_hash, token_in, token_out, roles, country_code, party_id, endpoints)
     VALUES ($1,$2,$3,'connected',$4,$5,$6,$7,$8,$9,'[]') RETURNING id`,
    [orgId, name, kind, tokenHash(t), seal(t), seal('out-' + t),
      JSON.stringify(roles.map((x) => ({ role: x.role, country_code: x.cc, party_id: x.pid }))), roles[0]?.cc ?? null, roles[0]?.pid ?? null],
  );
  tok[name] = t;
  pid[name] = r!.id;
}

async function ocpiToken(partnerName: string, p: { cc: string; pid: string }, uid: string): Promise<string> {
  return (await one<{ id: string }>(
    `INSERT INTO ocpi_token (org_id, partner_id, country_code, party_id, uid, type, contract_id, issuer, valid, whitelist, last_updated)
     VALUES ($1,$2,$3,$4,$5,'RFID',$6,'Test',true,'ALLOWED', now()) RETURNING id`,
    [orgId, pid[partnerName], p.cc, p.pid, uid, `${p.cc}-${p.pid}-C${uid}`.slice(0, 36)],
  ))!.id;
}

async function session(partnerName: string, tokenId: string, withCdr: boolean, conn = 0): Promise<string> {
  const s = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, state, started_at, energy_wh,
                                   ocpi_partner_id, ocpi_token_id, ocpi_auth_method)
     VALUES ($1,$2,$3,$4,$5,$6, now() - interval '30 minutes', 5000, $7, $8, 'WHITELIST') RETURNING id`,
    [orgId, siteId, connectors[conn], cpId, `h0-${randomUUID()}`, withCdr ? 'completed' : 'active', pid[partnerName], tokenId],
  ))!.id;
  if (withCdr) {
    await query(`UPDATE charging_session SET ended_at = now() WHERE id = $1`, [s]);
    await query(
      `INSERT INTO cdr (session_id, org_id, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot)
       VALUES ($1,$2,'[]',1000,0,0,1000,1100,110,1110,'null')`, [s, orgId]);
  }
  return s;
}

const from = (p: { cc: string; pid: string }) => ({ 'ocpi-from-country-code': p.cc, 'ocpi-from-party-id': p.pid });
async function call(method: string, url: string, who: string, headers: Record<string, string> = {}, body?: unknown) {
  const r = await app.inject({
    method: method as any, url, payload: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: authHeaderFor(tok[who]!), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  });
  let json: any = null;
  try { json = r.json(); } catch { json = null; }
  return { status: r.statusCode, body: json };
}
const since = new Date(Date.now() - 24 * 3600_000).toISOString();
const tokenBody = (p: { cc: string; pid: string }, uid: string, over: Record<string, unknown> = {}) => ({
  country_code: p.cc, party_id: p.pid, uid, type: 'RFID', contract_id: `${p.cc}-${p.pid}-C${uid}`.slice(0, 36), issuer: 'Test',
  valid: true, whitelist: 'ALLOWED', last_updated: new Date().toISOString(), ...over,
});

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('OCPI H0 Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    await query(`INSERT INTO ocpi_party (org_id, country_code, party_id, business_name, is_home) VALUES ($1,$2,$3,'H0 Test', true)`, [orgId, HOME.country_code, HOME.party_id]);
    siteId = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, address, city, lat, lon, roaming_publish) VALUES ($1, 'H0 Site', 'ID', 'Jl. Test 1', 'Jakarta', -6.2, 106.8, true) RETURNING id`, [orgId]))!.id;
    cpId = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [siteId, IDENT]))!.id;
    for (const n of [1, 2]) {
      const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, $2, 22000) RETURNING id`, [cpId, n]);
      connectors.push((await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1, 1, 'Type2', 'AC', 22000) RETURNING id`, [e!.id]))!.id);
    }
    cardId = (await one<{ id: string }>(
      `INSERT INTO token (org_id, kind, uid, status, roaming_shared, contract_id) VALUES ($1, 'rfid', $2, 'Accepted', true, 'ID-H0P-CH0CARD01') RETURNING id`, [orgId, CARD_UID]))!.id;

    await partner('hub', 'hub', [{ role: 'HUB', cc: 'NL', pid: 'HUB' }]);
    for (const [p, role] of [[A, 'EMSP'], [B, 'EMSP'], [CA, 'CPO'], [CB, 'CPO']] as const) {
      await query(`INSERT INTO ocpi_hub_client (org_id, partner_id, country_code, party_id, role, status, last_updated) VALUES ($1,$2,$3,$4,$5,'CONNECTED', now())`,
        [orgId, pid.hub, p.cc, p.pid, role]);
    }
    await query(`INSERT INTO ocpi_hub_client (org_id, partner_id, country_code, party_id, role, status, last_updated) VALUES ($1,$2,'ID','SUS','EMSP','SUSPENDED', now())`, [orgId, pid.hub]);
    await partner('peer', 'emsp', [{ role: 'EMSP', cc: 'ID', pid: 'PER' }]);
    await partner('peercpo', 'cpo', [{ role: 'CPO', cc: 'ID', pid: 'PCP' }]);

    tokA = await ocpiToken('hub', A, 'H0-UID-A');
    tokB = await ocpiToken('hub', B, 'H0-UID-B');
    sessA = await session('hub', tokA, false);
    sessB = await session('hub', tokB, false, 1);
    await session('hub', tokA, true);
    await session('hub', tokB, true);

    app = Fastify();
    await registerOcpiApi(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await cleanup();
    await pool.end();
  });
}

dbDescribe('H0: a hub connection must name the acting party', () => {
  test('no OCPI-from headers on a functional module: 2001', async () => {
    const r = await call('GET', `${V}/sessions?date_from=${since}`, 'hub');
    assert.equal(r.status, 400);
    assert.equal(r.body.status_code, 2001);
    const c = await call('POST', `${V}/commands/STOP_SESSION`, 'hub', {}, { response_url: 'https://emsp.example/r', session_id: sessA });
    assert.equal(c.body.status_code, 2001);
  });

  test('a party the hub did not announce (or suspended) is refused', async () => {
    const r = await call('GET', `${V}/sessions?date_from=${since}`, 'hub', from({ cc: 'ID', pid: 'ZZZ' }));
    assert.equal(r.status, 403);
    assert.equal(r.body.status_code, 2000);
    const s = await call('GET', `${V}/sessions?date_from=${since}`, 'hub', from({ cc: 'ID', pid: 'SUS' }));
    assert.equal(s.status, 403);
  });

  test('a CPO behind the hub cannot use the CPO-side receiver modules as an eMSP', async () => {
    const r = await call('GET', `${V}/tokens/${A.cc}/${A.pid}/H0-UID-A`, 'hub', from(CA));
    assert.equal(r.status, 403);
  });

  test('configuration modules (hubclientinfo) need no routing headers', async () => {
    const r = await call('GET', `${V}/hubclientinfo/${A.cc}/${A.pid}`, 'hub');
    assert.equal(r.status, 200);
    assert.equal(r.body.data.party_id, A.pid);
  });
});

dbDescribe('H0: CPO side — what an eMSP behind the hub may see and do', () => {
  test('GET sessions: only the acting eMSP\'s drivers', async () => {
    const r = await call('GET', `${V}/sessions?date_from=${since}`, 'hub', from(A));
    assert.equal(r.status, 200);
    assert.ok(r.body.data.length >= 1);
    assert.ok(r.body.data.every((s: any) => s.cdr_token.party_id === A.pid), JSON.stringify(r.body.data.map((s: any) => s.cdr_token.party_id)));
  });

  test('GET cdrs: only the acting eMSP\'s charge records', async () => {
    const r = await call('GET', `${V}/cdrs`, 'hub', from(A));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 1);
    assert.ok(r.body.data.every((c: any) => c.cdr_token.party_id === A.pid));
  });

  test('tokens: another eMSP\'s token cannot be read, patched or pushed', async () => {
    const own = await call('GET', `${V}/tokens/${A.cc}/${A.pid}/H0-UID-A`, 'hub', from(A));
    assert.equal(own.status, 200);
    const get = await call('GET', `${V}/tokens/${B.cc}/${B.pid}/H0-UID-B`, 'hub', from(A));
    assert.equal(get.status, 404);
    const patch = await call('PATCH', `${V}/tokens/${B.cc}/${B.pid}/H0-UID-B`, 'hub', from(A), { valid: false, last_updated: new Date().toISOString() });
    assert.equal(patch.status, 404);
    const valid = await one<{ valid: boolean }>(`SELECT valid FROM ocpi_token WHERE id = $1`, [tokB]);
    assert.equal(valid!.valid, true, 'B\'s token is untouched');
    const put = await call('PUT', `${V}/tokens/${B.cc}/${B.pid}/H0-NEW`, 'hub', from(A), tokenBody(B, 'H0-NEW'));
    assert.equal(put.status, 403);
    const putOwn = await call('PUT', `${V}/tokens/${A.cc}/${A.pid}/H0-NEW`, 'hub', from(A), tokenBody(A, 'H0-NEW'));
    assert.equal(putOwn.status, 200);
  });

  test('STOP_SESSION of another eMSP\'s session: UNKNOWN_SESSION', async () => {
    const r = await call('POST', `${V}/commands/STOP_SESSION`, 'hub', from(A), { response_url: 'https://emsp.example/r', session_id: sessB });
    assert.equal(r.body.data.result, 'UNKNOWN_SESSION');
  });

  test('START_SESSION / RESERVE_NOW with another eMSP\'s token: REJECTED', async () => {
    const start = await call('POST', `${V}/commands/START_SESSION`, 'hub', from(A), {
      response_url: 'https://emsp.example/r', location_id: siteId, evse_uid: (await import('./mapping.js')).evseUid(IDENT, 1), token: tokenBody(B, 'H0-UID-B', { whitelist: 'ALWAYS' }) });
    assert.equal(start.body.data.result, 'REJECTED', JSON.stringify(start.body));
    const b = await one<{ whitelist: string }>(`SELECT whitelist FROM ocpi_token WHERE id = $1`, [tokB]);
    assert.equal(b!.whitelist, 'ALLOWED', 'B\'s token is not rewritten through A\'s command');
  });

  test('UNLOCK_CONNECTOR of another eMSP\'s driver\'s connector: REJECTED', async () => {
    // EVSE 2 carries B's active session.
    const { evseUid } = await import('./mapping.js');
    const uid = evseUid(IDENT, 2);
    const r = await call('POST', `${V}/commands/UNLOCK_CONNECTOR`, 'hub', from(A), { response_url: 'https://emsp.example/r', location_id: siteId, evse_uid: uid, connector_id: '1' });
    assert.equal(r.body.data?.result, 'REJECTED', JSON.stringify(r.body));
  });

  test('CANCEL_RESERVATION of another eMSP\'s reservation: refused', async () => {
    await query(
      `INSERT INTO ocpi_reservation (org_id, partner_id, ocpi_reservation_id, token_id, charge_point_id, connector_no, expires_at, state)
       VALUES ($1,$2,'H0-RES-B',$3,$4,1, now() + interval '1 hour','active')`, [orgId, pid.hub, tokB, cpId]);
    const r = await call('POST', `${V}/commands/CANCEL_RESERVATION`, 'hub', from(A), { response_url: 'https://emsp.example/r', reservation_id: 'H0-RES-B' });
    assert.notEqual(r.body.data.result, 'ACCEPTED');
  });

  test('chargingprofiles on another eMSP\'s session: UNKNOWN_SESSION (PUT, GET, DELETE)', async () => {
    const url = `${V}/chargingprofiles/${sessB}`;
    const put = await call('PUT', url, 'hub', from(A), { response_url: 'https://emsp.example/p', charging_profile: { charging_rate_unit: 'W', charging_profile_period: [{ start_period: 0, limit: 1000 }] } });
    assert.equal(put.body.data.result, 'UNKNOWN_SESSION');
    const get = await call('GET', `${url}?duration=600&response_url=${encodeURIComponent('https://emsp.example/p')}`, 'hub', from(A));
    assert.equal(get.body.data.result, 'UNKNOWN_SESSION');
    const del = await call('DELETE', `${url}?response_url=${encodeURIComponent('https://emsp.example/p')}`, 'hub', from(A));
    assert.equal(del.body.data.result, 'UNKNOWN_SESSION');
    const none = await one(`SELECT 1 FROM ocpi_charging_profile WHERE session_id = $1`, [sessB]);
    assert.equal(none, null);
  });

  test('results to a hub are addressed (OCPI-to) to the acting eMSP, not to the hub', async () => {
    const del = await call('DELETE', `${V}/chargingprofiles/${sessA}?response_url=${encodeURIComponent('https://emsp.example/own')}`, 'hub', from(A));
    assert.equal(del.body.data.result, 'ACCEPTED');
    const stop = await call('POST', `${V}/commands/STOP_SESSION`, 'hub', from(A), { response_url: 'https://emsp.example/stop', session_id: sessA });
    assert.equal(stop.body.data.result, 'ACCEPTED');
    const wait = async (url: string) => {
      for (let i = 0; i < 50; i++) {
        const r = await one<{ to_country_code: string; to_party_id: string }>(`SELECT to_country_code, to_party_id FROM ocpi_push WHERE partner_id = $1 AND url = $2`, [pid.hub, url]);
        if (r) return r;
        await new Promise((res) => setTimeout(res, 100));
      }
      return null;
    };
    assert.deepEqual(await wait('https://emsp.example/own'), { to_country_code: A.cc, to_party_id: A.pid });
    assert.deepEqual(await wait('https://emsp.example/stop'), { to_country_code: A.cc, to_party_id: A.pid });
  });
});

dbDescribe('H0: eMSP side — what a CPO behind the hub may publish and read', () => {
  const loc = { id: 'L-B', name: 'B site', address: 'x', coordinates: { latitude: '-6.2', longitude: '106.8' }, last_updated: new Date().toISOString() };

  test('locations / tariffs: only under the acting CPO\'s own URL party', async () => {
    const other = await call('PUT', `${V}/emsp/locations/${CB.cc}/${CB.pid}/L-B`, 'hub', from(CA), loc);
    assert.equal(other.status, 403);
    const own = await call('PUT', `${V}/emsp/locations/${CB.cc}/${CB.pid}/L-B`, 'hub', from(CB), loc);
    assert.equal(own.status, 200);
    const read = await call('GET', `${V}/emsp/locations/${CB.cc}/${CB.pid}/L-B`, 'hub', from(CA));
    assert.equal(read.status, 404);
    const tar = await call('PUT', `${V}/emsp/tariffs/${CB.cc}/${CB.pid}/T-1`, 'hub', from(CA), { currency: 'IDR', elements: [], last_updated: new Date().toISOString() });
    assert.equal(tar.status, 403);
  });

  test('sessions: a CPO cannot overwrite or read another CPO\'s session', async () => {
    const body = { id: 'S-B', start_date_time: new Date().toISOString(), kwh: 1, status: 'ACTIVE', currency: 'IDR', last_updated: new Date().toISOString(),
      cdr_token: { country_code: HOME.country_code, party_id: HOME.party_id, uid: CARD_UID, type: 'RFID', contract_id: 'ID-H0P-CH0CARD01' } };
    const own = await call('PUT', `${V}/emsp/sessions/${CB.cc}/${CB.pid}/S-B`, 'hub', from(CB), body);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    const other = await call('PUT', `${V}/emsp/sessions/${CB.cc}/${CB.pid}/S-B`, 'hub', from(CA), { ...body, kwh: 99 });
    assert.equal(other.status, 403);
    const patch = await call('PATCH', `${V}/emsp/sessions/${CB.cc}/${CB.pid}/S-B`, 'hub', from(CA), { kwh: 99, last_updated: new Date().toISOString() });
    assert.equal(patch.status, 403);
    const read = await call('GET', `${V}/emsp/sessions/${CB.cc}/${CB.pid}/S-B`, 'hub', from(CA));
    assert.equal(read.status, 404);
    const kwh = await one<{ kwh: string }>(`SELECT kwh FROM ocpi_remote_session WHERE partner_id = $1 AND party_id = $2 AND session_id = 'S-B'`, [pid.hub, CB.pid]);
    assert.equal(Number(kwh!.kwh), 1);
  });

  test('CDRs: posted only for the acting CPO; read back only by it', async () => {
    const cdr = {
      country_code: CB.cc, party_id: CB.pid, id: 'C-B', session_id: 'S-B', start_date_time: new Date(Date.now() - 3600_000).toISOString(), end_date_time: new Date().toISOString(),
      cdr_token: { country_code: HOME.country_code, party_id: HOME.party_id, uid: CARD_UID, type: 'RFID', contract_id: 'ID-H0P-CH0CARD01' },
      currency: 'IDR', total_cost: { excl_vat: 10_000, incl_vat: 11_100 }, total_energy: 1, last_updated: new Date().toISOString(),
    };
    const other = await call('POST', `${V}/emsp/cdrs`, 'hub', from(CA), cdr);
    assert.equal(other.status, 403);
    const own = await call('POST', `${V}/emsp/cdrs`, 'hub', from(CB), cdr);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    const ourId = (await one<{ id: string }>(`SELECT id FROM ocpi_remote_cdr WHERE partner_id = $1 AND party_id = $2 AND cdr_id = 'C-B'`, [pid.hub, CB.pid]))!.id;
    assert.equal((await call('GET', `${V}/emsp/cdrs/${ourId}`, 'hub', from(CA))).status, 404);
    assert.equal((await call('GET', `${V}/emsp/cdrs/${ourId}`, 'hub', from(CB))).status, 200);
  });

  test('command results: only from the party the command was sent to', async () => {
    const id = randomUUID();
    await query(`INSERT INTO ocpi_command (id, org_id, partner_id, command, request) VALUES ($1,$2,$3,'STOP_SESSION',$4)`,
      [id, orgId, pid.hub, JSON.stringify({ response_url: 'x', session_id: 'S-B', to: { country_code: CB.cc, party_id: CB.pid } })]);
    const other = await call('POST', `${V}/emsp/commands/STOP_SESSION/${id}`, 'hub', from(CA), { result: 'ACCEPTED' });
    assert.equal(other.status, 404);
    const r1 = await one<{ result: string | null }>(`SELECT result FROM ocpi_command WHERE id = $1`, [id]);
    assert.equal(r1!.result, null);
    const own = await call('POST', `${V}/emsp/commands/STOP_SESSION/${id}`, 'hub', from(CB), { result: 'ACCEPTED' });
    assert.equal(own.status, 200);
  });
});

dbDescribe('H0: peer (non-hub) connections are unchanged', () => {
  test('a peer eMSP needs no OCPI-from headers and keeps its own scope', async () => {
    const t = await call('PUT', `${V}/tokens/ID/PER/PEER-1`, 'peer', {}, tokenBody({ cc: 'ID', pid: 'PER' }, 'PEER-1'));
    assert.equal(t.status, 200);
    const g = await call('GET', `${V}/tokens/ID/PER/PEER-1`, 'peer');
    assert.equal(g.status, 200);
    const s = await call('GET', `${V}/sessions?date_from=${since}`, 'peer');
    assert.equal(s.status, 200);
    assert.equal(s.body.data.length, 0);
    const other = await call('GET', `${V}/tokens/${A.cc}/${A.pid}/H0-UID-A`, 'peer');
    assert.equal(other.status, 404);
    const stop = await call('POST', `${V}/commands/STOP_SESSION`, 'peer', {}, { response_url: 'https://peer.example/r', session_id: sessA });
    assert.equal(stop.body.data.result, 'UNKNOWN_SESSION');
  });

  test('a peer CPO publishes and posts results without OCPI-from headers', async () => {
    const r = await call('PUT', `${V}/emsp/locations/ID/PCP/L-P`, 'peercpo', {}, { id: 'L-P', name: 'Peer', address: 'x', coordinates: { latitude: '-6.2', longitude: '106.8' }, last_updated: new Date().toISOString() });
    assert.equal(r.status, 200);
    const id = randomUUID();
    await query(`INSERT INTO ocpi_command (id, org_id, partner_id, command, request) VALUES ($1,$2,$3,'STOP_SESSION','{}')`, [id, orgId, pid.peercpo]);
    assert.equal((await call('POST', `${V}/emsp/commands/STOP_SESSION/${id}`, 'peercpo', {}, { result: 'ACCEPTED' })).status, 200);
  });
});
