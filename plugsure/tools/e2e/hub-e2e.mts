// PlugSure Hub (OCPI 2.2.1 roaming hub, WP H1) end-to-end test.
//
// Three members around the hub (docs/HUB-DESIGN.md §11.3):
//   - an EXTERNAL CPO   MY*C??  (a fake OCPI platform; registers itself with token A),
//   - an EXTERNAL eMSP  SG*E??  (a fake; the hub registers with it, hub-initiated handshake),
//   - an external eMSP  SG*N??  with NO roaming agreement (the isolation probe),
//   - the INTERNAL tenant (the seeded operator, CPO + eMSP; zero-config join; in-process transport),
// with a raw OCPP 1.6 charger at the tenant. Every forwarded leg is checked against the OCPI 2.2.1 routing
// header table (from/to, a new X-Request-ID, the same X-Correlation-ID, last_updated untouched).
//
// The stack must run with HUB_ENABLED=true and HUB_PUBLIC_URL=$E2E_HUB (default http://localhost:<API port>:
// the hub's own base URL, a different origin than the tenants' OCPI_PUBLIC_URL on 127.0.0.1).
// Needs E2E_DATABASE_URL (runtime role) for a platform administrator and for checks on the tenant side.
// The fakes listen on E2E_HUB_FAKE_PORT .. +2 (9341-9343).
//     npx tsx tools/e2e/hub-e2e.mts
// NEVER point this at production.
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import WebSocket from 'ws';
import { FakeParty, decodeToken, nowIso, type Got } from './lib/ocpi-fakes.mts';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const HUB = (process.env.E2E_HUB ?? API.replace('127.0.0.1', 'localhost')).replace(/\/+$/, '');
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const DB = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;
const FAKE_PORT = Number(process.env.E2E_HUB_FAKE_PORT ?? 9341);
if (!DB) { console.error('E2E_DATABASE_URL is required'); process.exit(2); }

const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 25_000, every = 300): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const R2 = () => Array.from({ length: 2 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
const iso = () => new Date().toISOString();

// ─────────────────────────────────────────── console sessions (the operator, the platform admin)
function session() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
    const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
    return { status: r.status, data: d };
  };
}
const ops = session();
const plat = session();

const db = new pg.Client({ connectionString: DB });

// ─────────────────────────────────────────── a raw OCPP 1.6 charger at the tenant
class Raw {
  ws!: WebSocket;
  calls: Array<{ action: string; payload: any; at: number }> = [];
  pending = new Map<string, (v: any) => void>();
  n = 0;
  constructor(public id: string) {}
  async connect() {
    this.ws = new WebSocket(`${OCPP}/${this.id}`, ['ocpp1.6']);
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f[0] === 2) { this.calls.push({ action: f[2], payload: f[3], at: Date.now() }); this.ws.send(JSON.stringify([3, f[1], { status: 'Accepted' }])); }
      else if (f[0] === 3 || f[0] === 4) { this.pending.get(f[1])?.(f[0] === 3 ? f[2] : { __error: f[2] }); this.pending.delete(f[1]); }
    });
  }
  call(action: string, payload: unknown): Promise<any> {
    const id = `${this.id}-${++this.n}`;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify([2, id, action, payload])); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); res({ __timeout: true }); } }, 15_000); });
  }
  close() { try { this.ws.close(); } catch {} }
  boot() { return this.call('BootNotification', { chargePointVendor: 'HubSim', chargePointModel: 'HS-DC-60', firmwareVersion: '1.0.0' }); }
  status(c: number, status: string) { return this.call('StatusNotification', { connectorId: c, errorCode: 'NoError', status, timestamp: iso() }); }
  authorize(idTag: string) { return this.call('Authorize', { idTag }); }
  start(c: number, idTag: string, meterStart: number) { return this.call('StartTransaction', { connectorId: c, idTag, meterStart, timestamp: iso() }); }
  meter(c: number, tx: number, wh: number) { return this.call('MeterValues', { connectorId: c, transactionId: tx, meterValue: [{ timestamp: iso(), sampledValue: [{ value: String(wh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }] }); }
  stop(tx: number, meterStop: number) { return this.call('StopTransaction', { transactionId: tx, meterStop, timestamp: iso(), reason: 'EVDisconnected' }); }
}

// ─────────────────────────────────────────── the fakes
const CPO_ID = `C${R2()}`;
const EMSP_ID = `E${R2()}`;
const NOA_ID = `N${R2()}`;
const XCP = new FakeParty({ name: 'XCP', port: FAKE_PORT, prefix: '/xcp', roles: [{ role: 'CPO', country_code: 'MY', party_id: CPO_ID, name: 'E2E Hub CPO Sdn Bhd' }],
  modules: [['locations', 'SENDER'], ['tariffs', 'SENDER'], ['sessions', 'SENDER'], ['cdrs', 'SENDER'], ['tokens', 'RECEIVER'], ['commands', 'RECEIVER'], ['chargingprofiles', 'RECEIVER'], ['hubclientinfo', 'RECEIVER']] });
const XEM = new FakeParty({ name: 'XEM', port: FAKE_PORT + 1, prefix: '/xem', roles: [{ role: 'EMSP', country_code: 'SG', party_id: EMSP_ID, name: 'E2E Hub eMSP Pte Ltd' }],
  modules: [['locations', 'RECEIVER'], ['tariffs', 'RECEIVER'], ['sessions', 'RECEIVER'], ['cdrs', 'RECEIVER'], ['tokens', 'SENDER'], ['commands', 'SENDER'], ['hubclientinfo', 'RECEIVER']] });
const NOA = new FakeParty({ name: 'NOA', port: FAKE_PORT + 2, prefix: '/noa', roles: [{ role: 'EMSP', country_code: 'SG', party_id: NOA_ID, name: 'E2E Hub No-Agreement eMSP' }],
  modules: [['locations', 'RECEIVER'], ['tokens', 'SENDER'], ['sessions', 'RECEIVER'], ['cdrs', 'RECEIVER'], ['hubclientinfo', 'RECEIVER']] });
const pCPO = { country_code: 'MY', party_id: CPO_ID };
const pEMSP = { country_code: 'SG', party_id: EMSP_ID };
const pNOA = { country_code: 'SG', party_id: NOA_ID };
const HUB_MY = { country_code: 'MY', party_id: 'PSH' };
const HUB_SG = { country_code: 'SG', party_id: 'PSH' };
const V = `${HUB}/hub/ocpi/2.2.1`;

const loc = (n: number) => ({
  country_code: 'MY', party_id: CPO_ID, id: `HUBLOC-${RUN}-${n}`, publish: true, name: `Hub Mall ${n}`, address: `Jalan Ampang ${n}`, city: 'Kuala Lumpur',
  country: 'MYS', coordinates: { latitude: '3.158000', longitude: '101.711000' }, time_zone: 'Asia/Kuala_Lumpur',
  evses: [{ uid: `HUBEVSE-${RUN}-${n}`, evse_id: `MY*${CPO_ID}*E${RUN}${n}`, status: 'AVAILABLE', connectors: [{ id: '1', standard: 'IEC_62196_T2_COMBO', format: 'CABLE', power_type: 'DC', max_voltage: 500, max_amperage: 200, max_electric_power: 100000, last_updated: '2026-10-01T10:00:00Z' }], last_updated: '2026-10-01T10:00:00Z' }],
  operator: { name: 'E2E Hub CPO' }, last_updated: '2026-10-01T10:00:00Z',
});

/** The OCPI routing-header table on a forwarded leg: to/from, a NEW request id, the SAME correlation id. */
function legOk(g: Got | undefined, from: { country_code: string; party_id: string } | null, to: { country_code: string; party_id: string } | null, sent?: { requestId: string; correlationId: string }) {
  if (!g) return false;
  const h = g.headers;
  const f = from ? h['ocpi-from-country-code'] === from.country_code && h['ocpi-from-party-id'] === from.party_id : !h['ocpi-from-country-code'];
  const t = to ? h['ocpi-to-country-code'] === to.country_code && h['ocpi-to-party-id'] === to.party_id : !h['ocpi-to-country-code'];
  const ids = !sent || (h['x-request-id'] !== sent.requestId && h['x-correlation-id'] === sent.correlationId);
  return f && t && ids && typeof h['x-request-id'] === 'string';
}
const respHeaders = (r: { headers: Headers }, from: { country_code: string; party_id: string }, to: { country_code: string; party_id: string }) =>
  r.headers.get('ocpi-from-country-code') === from.country_code && r.headers.get('ocpi-from-party-id') === from.party_id
  && r.headers.get('ocpi-to-country-code') === to.country_code && r.headers.get('ocpi-to-party-id') === to.party_id;

let charger: Raw | null = null;
let siteId = '';
try {
  await db.connect();
  await db.query(`SET app.rls_bypass = 'on'`);
  for (const f of [XCP, XEM, NOA]) await f.start();

  // ═══════════════════════════════════════════ setup
  check('setup: the hub surface is mounted on its own base URL (no token → 401)', (await fetch(`${HUB}/hub/ocpi/versions`)).status === 401);
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: the operator signs in', login.status === 200, login.data);
  let parties = (await ops('GET', '/v1/roaming/parties')).data?.parties ?? [];
  if (!parties.length) {
    await ops('PUT', '/v1/roaming/party', { countryCode: 'ID', partyId: 'PLS', businessName: 'Nusantara Charge' });
    parties = (await ops('GET', '/v1/roaming/parties')).data?.parties ?? [];
  }
  const HOME = { country_code: parties[0].country_code as string, party_id: parties[0].party_id as string };
  check('setup: the tenant has a roaming identity (its home party)', !!HOME.party_id, parties);
  const orgId = (await db.query(`SELECT org_id FROM ocpi_party WHERE country_code = $1 AND party_id = $2`, [HOME.country_code, HOME.party_id])).rows[0]?.org_id as string;

  const emailP = `hub-platform-${RUN.toLowerCase()}@plugsure.test`;
  const pwP = `Hub-Platform-${RUN}-2026!`;
  execSync(`npx tsx src/db/create-admin.ts --email ${emailP} --name "Hub Platform ${RUN}" --org-slug hub-platform-${RUN.toLowerCase()} --org-name "Hub Platform ${RUN}" --password '${pwP}' --platform-admin`,
    { env: { ...process.env, DATABASE_URL: DB, MIGRATION_DATABASE_URL: DB }, stdio: 'pipe' });
  await db.query(`UPDATE app_user SET must_change_password = false WHERE email = $1`, [emailP]);
  check('setup: the platform administrator signs in', (await plat('POST', '/v1/auth/login', { email: emailP, password: pwP })).status === 200);
  check('setup: an operator (not platform admin) cannot use the hub admin API', (await ops('GET', '/v1/hub/overview')).status === 403);
  // Earlier runs' external members are terminated (their fakes are gone).
  for (const m of (await plat('GET', '/v1/hub/members?kind=external')).data?.members ?? []) {
    if (String(m.legal_name).startsWith('E2E Hub') && m.status !== 'terminated') await plat('PATCH', `/v1/hub/members/${m.id}`, { action: 'terminate' });
  }

  // The tenant's site, tariff and charger (its CPO side), and one of its cards shared for roaming (its eMSP side).
  const site = await ops('POST', '/v1/sites', { name: `Hub E2E Site ${RUN}`, address: 'Jl. M.H. Thamrin No. 1', city: 'Jakarta Pusat', postalCode: '10310',
    lat: '-6.1950', lon: '106.8230', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000' });
  siteId = site.data.id;
  const tariff = await ops('POST', '/v1/tariffs', { name: `Hub E2E DC ${RUN}`, plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true,
    components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }] });
  await ops('PUT', `/v1/sites/${siteId}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  const CP = `HUB-${RUN}`;
  const reg = await ops('POST', '/v1/charge-points', { ocppIdentity: CP, siteId, displayName: 'Hub DC', ocppVersion: 'ocpp1.6',
    evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
  await ops('POST', `/v1/charge-points/${CP}/activate`);
  charger = new Raw(CP);
  await charger.connect(); await charger.boot(); await charger.status(1, 'Available');
  const card = (await ops('POST', '/v1/tokens', { uid: `HUBCARD-${RUN}`, holderName: 'Hub Driver', accountType: 'fleet', fleetName: 'Hub Fleet' })).data;
  check('setup: tenant site, DC tariff, OCPP 1.6 charger and a fleet card', site.status === 200 && reg.status === 200 && !!card?.id, { s: site.data, r: reg.data, c: card });

  // ═══════════════════════════════════════════ 1. onboarding
  const mCpo = (await plat('POST', '/v1/hub/members', { legal_name: 'E2E Hub CPO Sdn Bhd', country_code: 'MY' })).data.member;
  const cCpo = await plat('POST', `/v1/hub/members/${mCpo.id}/connections`, {});
  const tokenA = cCpo.data.token as string;
  check('onboard: the platform creates an external CPO member; the hub issues token A once, with its versions URL on the hub host',
    cCpo.status === 201 && !!tokenA && cCpo.data.versionsUrl === `${HUB}/hub/ocpi/versions` && !JSON.stringify(cCpo.data.connection).includes(tokenA), cCpo.data);
  const regCpo = await XCP.registerWithHub(cCpo.data.versionsUrl, tokenA);
  const hubRoles = regCpo.credentials.body?.data?.roles ?? [];
  check('onboard: the CPO registers (POST credentials with token A) and gets token C',
    regCpo.credentials.status === 200 && !!XCP.tokenToHub && XCP.tokenToHub !== tokenA, regCpo.credentials.body);
  check('onboard: the hub reports itself as role HUB only, one party per country (ID*PSH, MY*PSH, SG*PSH)',
    hubRoles.length >= 3 && hubRoles.every((r: any) => r.role === 'HUB') && ['ID', 'MY', 'SG'].every((c) => hubRoles.some((r: any) => r.country_code === c && r.party_id === 'PSH')), hubRoles);
  check('onboard: the hub read the CPO\'s endpoints with token B', XCP.received((g) => g.path === '/xcp/2.2.1' && decodeToken(g.headers.authorization).startsWith('XCP-B-')).length > 0);
  check('onboard: the hub\'s endpoints are on the hub host, both roles per module',
    ['locations', 'tokens', 'commands', 'cdrs'].every((m) => XCP.hubEp(m, 'SENDER').startsWith(`${HUB}/hub/ocpi/2.2.1/sender/`) && XCP.hubEp(m, 'RECEIVER').startsWith(`${HUB}/hub/ocpi/2.2.1/receiver/`)));
  check('onboard: token A is dead after registration (replay → 401)', (await XCP.call('GET', cCpo.data.versionsUrl, undefined, { token: tokenA, from: null })).status === 401);
  check('onboard: a second POST credentials is refused (405: use PUT)', (await XCP.call('POST', XCP.hubEp('credentials', 'RECEIVER'), XCP.credentials('again'), { from: null })).status === 405);
  check('onboard: a hub token is not a tenant OCPI token (/ocpi/versions → 401)', (await XCP.call('GET', `${API}/ocpi/versions`, undefined, { from: null })).status === 401);
  const planned = (await plat('GET', `/v1/hub/members/${mCpo.id}`)).data;
  check('onboard: before activation the CPO\'s party is PLANNED', planned.parties?.length === 1 && planned.parties[0].status === 'PLANNED' && planned.parties[0].role === 'CPO', planned.parties);
  const early = await XCP.call('PUT', `${XCP.hubEp('locations', 'RECEIVER')}/MY/${CPO_ID}/${loc(1).id}`, loc(1), { to: HUB_MY });
  check('onboard: a PLANNED party cannot route yet (403)', early.status === 403, early.body);

  // The eMSP: the hub starts the handshake with the eMSP's token A.
  const mEmsp = (await plat('POST', '/v1/hub/members', { legal_name: 'E2E Hub eMSP Pte Ltd', country_code: 'SG' })).data.member;
  const cEmsp = (await plat('POST', `/v1/hub/members/${mEmsp.id}/connections`, {})).data;
  const xemA = `XEM-A-${randomUUID()}`;
  XEM.accept.add(xemA);
  const conn = await plat('POST', `/v1/hub/connections/${cEmsp.connection.id}/connect`, { versions_url: XEM.versionsUrl, token: xemA });
  check('onboard: hub-initiated handshake with the eMSP (its token A → our credentials → its token C)',
    conn.status === 200 && conn.data.connection?.state === 'connected' && !!XEM.tokenToHub && XEM.received((g) => g.method === 'POST' && g.path === '/xem/2.2.1/credentials').length === 1, conn.data);
  await XEM.loadHubEndpoints();
  check('onboard: the eMSP reads the hub\'s endpoints with the token the hub gave it', XEM.hubEndpoints.length > 10, XEM.hubEndpoints.length);
  const mNoa = (await plat('POST', '/v1/hub/members', { legal_name: 'E2E Hub No-Agreement eMSP', country_code: 'SG' })).data.member;
  const cNoa = (await plat('POST', `/v1/hub/members/${mNoa.id}/connections`, {})).data;
  check('onboard: a third member (eMSP, no agreements) registers', (await NOA.registerWithHub(cNoa.versionsUrl, cNoa.token)).credentials.status === 200);

  const join = await plat('POST', '/v1/hub/members/join-tenant', { org_id: orgId });
  const join2 = await plat('POST', '/v1/hub/members/join-tenant', { org_id: orgId });
  const hubPartnerId = join.data.partnerId as string;
  check('onboard: the tenant joins with zero configuration (a "PlugSure Hub" partner in its org; idempotent)',
    join.status === 200 && !!hubPartnerId && join2.status === 200 && join2.data.created === false && join2.data.partnerId === hubPartnerId, { join: join.data, join2: join2.data });
  const partnerRow = (await db.query(`SELECT kind, state, name, country_code, party_id, endpoints FROM ocpi_partner WHERE id = $1`, [hubPartnerId])).rows[0];
  check('onboard: the tenant\'s hub partner is connected, kind hub, addressed as the hub party of its home country, endpoints on the hub host',
    partnerRow?.kind === 'hub' && partnerRow.state === 'connected' && partnerRow.party_id === 'PSH' && partnerRow.endpoints.every((e: any) => e.url.startsWith(`${HUB}/hub/ocpi/`)), partnerRow);
  for (const m of [mCpo.id, mEmsp.id, mNoa.id, join.data.member.id]) await plat('PATCH', `/v1/hub/members/${m}`, { action: 'activate' });
  const all = (await plat('GET', '/v1/hub/parties')).data.parties as any[];
  const P = (cc: string, pid: string, role: string) => all.find((p) => p.country_code === cc && p.party_id === pid && p.role === role);
  const XCPp = P('MY', CPO_ID, 'CPO'); const XEMp = P('SG', EMSP_ID, 'EMSP'); const NOAp = P('SG', NOA_ID, 'EMSP');
  const PLTc = P(HOME.country_code, HOME.party_id, 'CPO'); const PLTe = P(HOME.country_code, HOME.party_id, 'EMSP');
  check('onboard: after activation every party is CONNECTED (tenant: CPO and eMSP roles of its home party)',
    [XCPp, XEMp, NOAp, PLTc, PLTe].every((p) => p?.status === 'CONNECTED'), [XCPp, XEMp, NOAp, PLTc, PLTe].map((p) => p?.status));

  // ═══════════════════════════════════════════ 2. agreements and ClientInfo
  const agr = async (cpo: any, emsp: any, extra: Record<string, unknown> = {}) => plat('POST', '/v1/hub/agreements', { cpo_party_id: cpo.id, emsp_party_id: emsp.id, ...extra });
  const a1 = await agr(XCPp, XEMp);
  const a2 = await agr(XCPp, PLTe);
  const a3 = await agr(PLTc, XEMp, { allow_commands: false });
  const self = await agr(PLTc, PLTe);
  check('agreements: CPO⇄eMSP agreements are created active by the platform', [a1, a2, a3].every((a) => a.status === 201 && a.data.agreement.status === 'active'), [a1.data, a2.data, a3.data]);
  check('agreements: a member cannot roam with itself (tenant CPO ⇄ tenant eMSP refused)', self.status === 400, self.data);
  await until(() => XCP.store.clientInfo.size, (n) => n >= 2);
  await until(() => XEM.store.clientInfo.size, (n) => n >= 2);
  check('ClientInfo: the CPO learns of its agreed eMSPs (SG eMSP, tenant eMSP), never of the unagreed one',
    XCP.store.clientInfo.get(`SG*${EMSP_ID}*EMSP`)?.status === 'CONNECTED' && XCP.store.clientInfo.get(`${HOME.country_code}*${HOME.party_id}*EMSP`)?.status === 'CONNECTED'
      && ![...XCP.store.clientInfo.keys()].some((k) => k.includes(NOA_ID)), [...XCP.store.clientInfo.keys()]);
  check('ClientInfo: the eMSP learns of its agreed CPOs (MY CPO, tenant CPO)',
    XEM.store.clientInfo.has(`MY*${CPO_ID}*CPO`) && XEM.store.clientInfo.has(`${HOME.country_code}*${HOME.party_id}*CPO`), [...XEM.store.clientInfo.keys()]);
  await sleep(500);
  check('ClientInfo: the member without agreements is told about nobody', NOA.store.clientInfo.size === 0, [...NOA.store.clientInfo.keys()]);
  const ciLeg = XCP.received((g) => g.method === 'PUT' && g.path.startsWith('/xcp/2.2.1/r/hubclientinfo/'))[0];
  check('ClientInfo: pushed as a configuration module (no routing headers)', legOk(ciLeg, null, null), ciLeg?.headers);
  const hc = await until(() => db.query(`SELECT country_code, party_id, role, status FROM ocpi_hub_client WHERE partner_id = $1`, [hubPartnerId]),
    (r) => r.rows.some((x) => x.party_id === CPO_ID) && r.rows.some((x) => x.party_id === EMSP_ID));
  check('ClientInfo: the tenant (in-process) stores the MY CPO and the SG eMSP as hub clients, nothing else of this run',
    hc.rows.some((x) => x.party_id === CPO_ID && x.role === 'CPO' && x.status === 'CONNECTED') && hc.rows.some((x) => x.party_id === EMSP_ID && x.role === 'EMSP') && !hc.rows.some((x) => x.party_id === NOA_ID), hc.rows);
  const pull = await XCP.call('GET', XCP.hubEp('hubclientinfo', 'SENDER'), undefined, { from: null });
  check('ClientInfo: GET hubclientinfo lists the caller\'s agreed counterparties', pull.status === 200 && pull.body.data.some((c: any) => c.party_id === EMSP_ID) && !pull.body.data.some((c: any) => c.party_id === NOA_ID), pull.body);

  // ═══════════════════════════════════════════ 3. location broadcast (external CPO → hub → agreed eMSPs)
  XCP.own.locations.push(loc(1), loc(2));
  const L1 = loc(1);
  const mark3 = Date.now();
  const put = await XCP.call('PUT', `${XCP.hubEp('locations', 'RECEIVER')}/MY/${CPO_ID}/${L1.id}`, L1, { to: HUB_MY });
  check('broadcast: the hub answers the broadcaster at once (1000), from the hub to the CPO', put.status === 200 && put.body.status_code === 1000 && respHeaders(put, HUB_MY, pCPO), { b: put.body, h: [...put.headers] });
  const xemPut = (await until(() => XEM.received((g) => g.method === 'PUT' && g.path === `/xem/2.2.1/r/locations/MY/${CPO_ID}/${L1.id}`, mark3), (v) => v.length > 0))[0];
  check('broadcast: the eMSP receives it FROM the hub (SG*PSH), TO itself, new X-Request-ID, same X-Correlation-ID',
    legOk(xemPut, HUB_SG, pEMSP, put), xemPut?.headers);
  check('broadcast: URL keeps the owner (MY/CPO), body untouched (last_updated as sent), signed with the eMSP\'s token',
    xemPut?.body?.last_updated === L1.last_updated && JSON.stringify(xemPut?.body) === JSON.stringify(L1) && XEM.accept.has(decodeToken(xemPut?.headers.authorization)), xemPut?.body);
  const remote = await until(() => db.query(`SELECT data FROM ocpi_remote_location WHERE partner_id = $1 AND country_code = 'MY' AND party_id = $2 AND location_id = $3`, [hubPartnerId, CPO_ID, L1.id]), (r) => r.rows.length > 0);
  check('broadcast: the tenant (agreed eMSP, in-process) stores the location, last_updated untouched', remote.rows[0]?.data?.last_updated === L1.last_updated, remote.rows[0]);
  const patch = await XCP.call('PATCH', `${XCP.hubEp('locations', 'RECEIVER')}/MY/${CPO_ID}/${L1.id}/${L1.evses[0]!.uid}`, { status: 'CHARGING', last_updated: '2026-10-01T10:05:00Z' }, { to: HUB_MY });
  const xemPatch = (await until(() => XEM.received((g) => g.method === 'PATCH' && g.path.endsWith(`/${L1.evses[0]!.uid}`), mark3), (v) => v.length > 0))[0];
  check('broadcast: an EVSE PATCH follows, after the PUT (order per object)', patch.status === 200 && !!xemPatch && xemPatch.at >= xemPut!.at && XEM.store.locations.get(`MY/${CPO_ID}/${L1.id}`)?.evses?.[0]?.status === 'CHARGING');
  await XCP.call('PUT', `${XCP.hubEp('locations', 'RECEIVER')}/MY/${CPO_ID}/${loc(2).id}`, loc(2));
  await sleep(1500);
  check('broadcast: open routing of a location (no OCPI-to) is a broadcast too', XEM.received((g) => g.path.endsWith(`/${loc(2).id}`)).length === 1);
  check('broadcast: the member without an agreement never receives a location', NOA.received((g) => g.path.includes('/locations/')).length === 0);
  const trace = (await plat('GET', `/v1/hub/messages/trace/${put.correlationId}`)).data.legs as any[];
  const outs = trace?.filter((l) => l.leg === 'out') ?? [];
  check('log: the trace has the inbound leg and one outbound leg per recipient (tenant leg in-process), distinct request ids',
    trace?.some((l) => l.leg === 'in' && l.route === 'broadcast') && outs.length >= 2 && new Set(outs.map((l) => l.request_id_out)).size === outs.length
      && outs.some((l) => l.route === 'broadcast+inproc') && outs.some((l) => l.route === 'broadcast'), trace);

  // ═══════════════════════════════════════════ 4. tenant broadcast (internal CPO → hub → agreed eMSPs)
  const mark4 = Date.now();
  const pub = await ops('PUT', `/v1/roaming/sites/${siteId}`, { publish: true });
  const xemSite = (await until(() => XEM.received((g) => g.method === 'PUT' && g.path === `/xem/2.2.1/r/locations/${HOME.country_code}/${HOME.party_id}/${siteId}`, mark4), (v) => v.length > 0, 30_000))[0];
  check('tenant broadcast: the tenant\'s published site reaches the agreed SG eMSP from the hub', pub.status === 200 && legOk(xemSite, HUB_SG, pEMSP) && xemSite?.body?.id === siteId, xemSite?.headers ?? pub.data);
  await sleep(1000);
  check('tenant broadcast: a CPO (opposite role only) never receives it', XCP.received((g) => g.path.includes(siteId)).length === 0);

  // ═══════════════════════════════════════════ 5. the eMSP pulls locations through the hub
  const ga = await XEM.call('GET', `${XEM.hubEp('locations', 'SENDER')}?limit=1`, undefined, { to: HUB_SG });
  const total = Number(ga.headers.get('x-total-count'));
  const link = ga.headers.get('link') ?? '';
  check('GET All: one page of one, X-Total-Count = the sum of the sources, Link rewritten to a hub cursor on the hub host',
    ga.status === 200 && ga.body.data?.length === 1 && total >= 3 && link.startsWith(`<${HUB}/hub/ocpi/2.2.1/sender/locations?hub_cursor=`) && respHeaders(ga, HUB_SG, pEMSP), { total, link, h: [...ga.headers] });
  const ids: string[] = ga.body.data.map((l: any) => l.id);
  let next = /<([^>]+)>/.exec(link)?.[1];
  const firstCursor = next;
  for (let i = 0; next && i < 400; i++) {
    const p = await XEM.call('GET', next);
    ids.push(...(p.body.data ?? []).map((l: any) => l.id));
    next = /<([^>]+)>/.exec(p.headers.get('link') ?? '')?.[1];
  }
  check('GET All: walking the pages yields the CPO\'s and the tenant\'s locations, as many as X-Total-Count',
    ids.includes(L1.id) && ids.includes(loc(2).id) && ids.includes(siteId) && ids.length === total, { n: ids.length, total });
  const stolen = await NOA.call('GET', firstCursor!);
  check('GET All: a cursor replayed with another member\'s token is refused (403)', stolen.status === 403, stolen.body);
  const direct = await XEM.call('GET', `${XEM.hubEp('locations', 'SENDER')}?limit=1`, undefined, { to: pCPO });
  const dLink = /<([^>]+)>/.exec(direct.headers.get('link') ?? '')?.[1];
  const direct2 = dLink ? await XEM.call('GET', dLink) : null;
  const xcpLeg = XCP.received((g) => g.method === 'GET' && g.path === '/xcp/2.2.1/s/locations').pop();
  check('GET (addressed): only the CPO\'s locations; its Link rewritten to the hub; from = CPO, to = eMSP',
    direct.body.data?.[0]?.party_id === CPO_ID && dLink?.startsWith(`${HUB}/hub/`) && direct2?.body.data?.[0]?.id === loc(2).id && respHeaders(direct, pCPO, pEMSP) && legOk(xcpLeg, pEMSP, pCPO),
    { d: direct.body, l: dLink, d2: direct2?.body });
  const openGet = await XEM.call('GET', `${XEM.hubEp('locations', 'SENDER')}/${L1.id}`);
  check('open routing: GET one location without OCPI-to is routed by the location index', openGet.status === 200 && openGet.body.data?.id === L1.id, openGet.body);

  // ═══════════════════════════════════════════ 6. tokens and real-time authorisation
  const UID = `HUBNEVER${RUN}`;
  const tok = { country_code: 'SG', party_id: EMSP_ID, uid: UID, type: 'RFID', contract_id: `SG-${EMSP_ID}-C${RUN}`, issuer: 'E2E Hub eMSP', valid: true, whitelist: 'NEVER', last_updated: nowIso() };
  const mark6 = Date.now();
  const tput = await XEM.call('PUT', `${XEM.hubEp('tokens', 'RECEIVER')}/SG/${EMSP_ID}/${UID}?type=RFID`, tok, { to: HUB_SG });
  const xcpTok = (await until(() => XCP.received((g) => g.method === 'PUT' && g.path === `/xcp/2.2.1/r/tokens/SG/${EMSP_ID}/${UID}`, mark6), (v) => v.length > 0))[0];
  check('tokens: a NEVER-whitelist token broadcast reaches the agreed CPO (with ?type=), from the hub (MY*PSH)',
    tput.status === 200 && legOk(xcpTok, HUB_MY, pCPO, tput) && xcpTok?.url.searchParams.get('type') === 'RFID', xcpTok?.headers);
  const tTok = await until(() => db.query(`SELECT whitelist FROM ocpi_token WHERE partner_id = $1 AND uid = $2`, [hubPartnerId, UID]), (r) => r.rows.length > 0);
  check('tokens: the tenant (agreed CPO) stores it', tTok.rows[0]?.whitelist === 'NEVER', tTok.rows);
  const auth = await XCP.call('POST', `${XCP.hubEp('tokens', 'SENDER')}/${UID}/authorize?type=RFID`, { location_id: L1.id });
  const xemAuth = XEM.received((g) => g.method === 'POST' && g.path === `/xem/2.2.1/s/tokens/${UID}/authorize`).pop();
  check('real-time auth (external CPO): routed by the token index to the eMSP and back (ALLOWED, reference)',
    auth.body.data?.allowed === 'ALLOWED' && !!auth.body.data.authorization_reference && respHeaders(auth, pEMSP, pCPO) && legOk(xemAuth, pCPO, pEMSP, auth), { b: auth.body, h: xemAuth?.headers });
  const a = await charger.authorize(UID);
  const xemAuth2 = XEM.received((g) => g.method === 'POST' && g.path === `/xem/2.2.1/s/tokens/${UID}/authorize` && g.headers['ocpi-from-party-id'] === HOME.party_id).pop();
  check('real-time auth (tenant CPO): the charger\'s Authorize goes tenant → hub → eMSP; Accepted', a.idTagInfo?.status === 'Accepted' && legOk(xemAuth2, HOME, pEMSP), { a, h: xemAuth2?.headers });

  // ═══════════════════════════════════════════ 7. START_SESSION (tenant eMSP → external CPO), result routed back
  const mark7 = Date.now();
  await ops('PUT', '/v1/roaming/cards', { ids: [card.id], shared: true });
  const cardTok = (await until(() => XCP.received((g) => g.method === 'PUT' && g.path.startsWith(`/xcp/2.2.1/r/tokens/${HOME.country_code}/${HOME.party_id}/HUBCARD-${RUN}`), mark7), (v) => v.length > 0, 30_000))[0];
  check('tokens: the tenant\'s shared card reaches the agreed CPO through the hub', !!cardTok && cardTok.body?.whitelist !== undefined, XCP.got.slice(-3).map((g) => g.path));
  const cmd = await ops('POST', '/v1/roaming/commands', { command: 'START_SESSION', partnerId: hubPartnerId, tokenId: card.id, locationId: L1.id, evseUid: L1.evses[0]!.uid });
  const xcpCmd = XCP.received((g) => g.method === 'POST' && g.path === '/xcp/2.2.1/r/commands/START_SESSION', mark7).pop();
  const rurl = String(xcpCmd?.body?.response_url ?? '');
  check('commands: START_SESSION without a party is routed by the location index to the CPO (from = tenant eMSP, to = CPO)',
    cmd.status === 200 && cmd.data.response === 'ACCEPTED' && legOk(xcpCmd, HOME, pCPO), { cmd: cmd.data, h: xcpCmd?.headers });
  check('commands: the response_url is rewritten to a hub callback', rurl.startsWith(`${HUB}/hub/ocpi/2.2.1/sender/commands/START_SESSION/`) && !rurl.includes('/ocpi/2.2.1/emsp/'), rurl);
  const stranger = await NOA.call('POST', rurl, { result: 'REJECTED' });
  check('isolation (f): another member cannot post a command result to the callback (403)', stranger.status === 403, stranger.body);
  const res1 = await XCP.call('POST', rurl, { result: 'ACCEPTED' });
  const done = await until(() => ops('GET', '/v1/roaming/commands'), (r) => r.data?.find?.((c: any) => c.id === cmd.data.id)?.result === 'ACCEPTED');
  check('commands: the CPO\'s result goes through the hub back to the tenant (ACCEPTED)', res1.status === 200 && res1.body.status_code === 1000 && done.data.find((c: any) => c.id === cmd.data.id)?.result === 'ACCEPTED', res1.body);
  const res2 = await XCP.call('POST', rurl, { result: 'FAILED' });
  await sleep(1000);
  const cbRows = (await db.query(`SELECT count(*)::int AS n FROM hub_outbox WHERE kind = 'callback' AND object_key LIKE $1`, [`callback:${rurl.split('/').pop()}:%`])).rows[0].n;
  const after = (await ops('GET', '/v1/roaming/commands')).data.find((c: any) => c.id === cmd.data.id);
  check('commands: a repeated result is acknowledged (1000) and not forwarded again', res2.body.status_code === 1000 && cbRows === 1 && after?.result === 'ACCEPTED', { res2: res2.body, cbRows, r: after?.result });

  // ═══════════════════════════════════════════ 8. session + CDR: external CPO → hub → tenant eMSP
  const SID = `HUBSESS-${RUN}`;
  const cdrToken = { country_code: HOME.country_code, party_id: HOME.party_id, uid: `HUBCARD-${RUN}`, type: 'RFID', contract_id: cardTok?.body?.contract_id };
  const sess = { country_code: 'MY', party_id: CPO_ID, id: SID, start_date_time: '2026-10-01T10:00:00Z', kwh: 0, cdr_token: cdrToken, auth_method: 'COMMAND',
    authorization_reference: xcpCmd?.body?.authorization_reference, location_id: L1.id, evse_uid: L1.evses[0]!.uid, connector_id: '1', currency: 'MYR', status: 'ACTIVE', last_updated: '2026-10-01T10:00:05Z' };
  const sput = await XCP.call('PUT', `${XCP.hubEp('sessions', 'RECEIVER')}/MY/${CPO_ID}/${SID}`, sess);
  const spatch = await XCP.call('PATCH', `${XCP.hubEp('sessions', 'RECEIVER')}/MY/${CPO_ID}/${SID}`, { kwh: 12.5, status: 'COMPLETED', last_updated: '2026-10-01T10:40:00Z' });
  const rs = (await db.query(`SELECT data FROM ocpi_remote_session WHERE partner_id = $1 AND session_id = $2`, [hubPartnerId, SID])).rows[0];
  check('sessions: PUT (routed by cdr_token) and PATCH (routed by the session index) reach the tenant eMSP; from = tenant, to = CPO in the answer',
    sput.status === 200 && spatch.status === 200 && rs?.data?.kwh === 12.5 && respHeaders(sput, HOME, pCPO), { sput: sput.body, spatch: spatch.body, rs });
  const CDR_ID = `HUBCDR-${RUN}`;
  const cdr = { country_code: 'MY', party_id: CPO_ID, id: CDR_ID, start_date_time: '2026-10-01T10:00:00Z', end_date_time: '2026-10-01T10:40:00Z', session_id: SID,
    cdr_token: cdrToken, auth_method: 'COMMAND', authorization_reference: sess.authorization_reference,
    cdr_location: { id: L1.id, name: L1.name, address: L1.address, city: L1.city, country: 'MYS', coordinates: L1.coordinates, evse_uid: L1.evses[0]!.uid, evse_id: L1.evses[0]!.evse_id, connector_id: '1', connector_standard: 'IEC_62196_T2_COMBO', connector_format: 'CABLE', connector_power_type: 'DC' },
    currency: 'MYR', charging_periods: [{ start_date_time: '2026-10-01T10:00:00Z', dimensions: [{ type: 'ENERGY', volume: 12.5 }] }],
    total_cost: { excl_vat: 15, incl_vat: 16.2 }, total_energy: 12.5, total_time: 0.667, last_updated: '2026-10-01T10:41:00Z' };
  const cpost = await XCP.call('POST', XCP.hubEp('cdrs', 'RECEIVER'), cdr);
  const hubLoc = cpost.headers.get('location') ?? '';
  const rc = (await db.query(`SELECT status, hold_reason, data FROM ocpi_remote_cdr WHERE partner_id = $1 AND cdr_id = $2`, [hubPartnerId, CDR_ID])).rows[0];
  check('CDRs: POSTed without a party, routed by cdr_token to the tenant eMSP, accepted there (linked to the session)',
    cpost.status === 200 && rc?.status === 'accepted' && rc.data.last_updated === cdr.last_updated, { b: cpost.body, rc });
  check('CDRs: the CPO gets a hub Location (the tenant\'s own URL is never shown)', hubLoc.startsWith(`${HUB}/hub/ocpi/2.2.1/receiver/cdrs/`), hubLoc);
  const cget = await XCP.call('GET', hubLoc);
  check('CDRs: the CPO GETs the CDR back through its hub Location', cget.status === 200 && cget.body.data?.id === CDR_ID, cget.body);
  check('CDRs: another member cannot read it through that Location', (await NOA.call('GET', hubLoc)).status === 403);
  const dup = await XCP.call('POST', XCP.hubEp('cdrs', 'RECEIVER'), cdr);
  const changed = await XCP.call('POST', XCP.hubEp('cdrs', 'RECEIVER'), { ...cdr, total_cost: { excl_vat: 99, incl_vat: 99 } });
  check('CDRs: the same CDR again → 1000 with the same Location, not forwarded twice; changed totals → 2001',
    dup.status === 200 && dup.headers.get('location') === hubLoc && changed.body.status_code === 2001, { dup: dup.body, changed: changed.body });

  // ═══════════════════════════════════════════ 9. reverse: tenant CPO → hub → external eMSP (the driver authorised in step 6)
  const mark9 = Date.now();
  const s1 = await charger.start(1, UID, 2_000_000);
  await charger.status(1, 'Charging');
  const xemSess = (await until(() => XEM.received((g) => g.method === 'PUT' && g.path.startsWith(`/xem/2.2.1/r/sessions/${HOME.country_code}/${HOME.party_id}/`), mark9), (v) => v.length > 0, 30_000))[0];
  const tSid = xemSess?.body?.id as string;
  check('reverse: the tenant\'s session for the SG driver reaches the eMSP (from = tenant CPO, to = eMSP), AUTH_REQUEST',
    legOk(xemSess, HOME, pEMSP) && xemSess?.body?.cdr_token?.uid === UID && xemSess.body.auth_method === 'AUTH_REQUEST', xemSess?.body ?? s1);
  // Smart charging through the hub: the eMSP limits its driver's session at the tenant; the result comes back via a hub callback.
  const markP = Date.now();
  const profUrl = `${XEM.base}/2.2.1/s/chargingprofiles/result/P-${RUN}`;
  const prof = await XEM.call('PUT', `${XEM.hubEp('chargingprofiles', 'RECEIVER')}/${tSid}`,
    { response_url: profUrl, charging_profile: { charging_rate_unit: 'W', charging_profile_period: [{ start_period: 0, limit: 11000 }] } }, { to: HOME });
  const stored = (await db.query(`SELECT response_url FROM ocpi_charging_profile WHERE session_id = $1`, [tSid])).rows[0];
  check('charging profiles: the eMSP\'s PUT reaches the tenant CPO (ACCEPTED); the tenant only sees a hub response_url',
    prof.body.data?.result === 'ACCEPTED' && String(stored?.response_url ?? '').startsWith(`${HUB}/hub/ocpi/2.2.1/sender/chargingprofiles/result/`), { p: prof.body, stored });
  const profRes = (await until(() => XEM.received((g) => g.method === 'POST' && g.path === `/xem/2.2.1/s/chargingprofiles/result/P-${RUN}`, markP), (v) => v.length > 0, 30_000))[0];
  check('charging profiles: the result is routed back through the hub to the eMSP\'s own response_url (from = tenant CPO, to = eMSP)',
    legOk(profRes, HOME, pEMSP) && ['ACCEPTED', 'REJECTED'].includes(profRes?.body?.result), profRes?.body);
  await charger.meter(1, s1.transactionId, 2_006_000);
  await charger.stop(s1.transactionId, 2_006_000);
  await charger.status(1, 'Available');
  const xemCdr = (await until(() => XEM.received((g) => g.method === 'POST' && g.path === '/xem/2.2.1/r/cdrs' && g.body?.session_id === tSid, mark9), (v) => v.length > 0, 40_000))[0];
  check('reverse: the tenant\'s CDR reaches the eMSP through the hub (from = tenant CPO, to = eMSP)', legOk(xemCdr, HOME, pEMSP) && xemCdr?.body?.total_energy === 6, xemCdr?.body);
  const pushLoc = await until(() => db.query(`SELECT response_location FROM ocpi_push WHERE partner_id = $1 AND module = 'cdrs' AND object_key = $2 AND state = 'delivered'`, [hubPartnerId, `session:${tSid}`]), (r) => r.rows.length > 0);
  check('reverse: the tenant keeps the hub Location of its CDR', String(pushLoc.rows[0]?.response_location ?? '').startsWith(`${HUB}/hub/ocpi/2.2.1/receiver/cdrs/`), pushLoc.rows);
  const inproc = (await db.query(`SELECT count(*)::int AS n FROM hub_message WHERE leg = 'out' AND route LIKE '%+inproc' AND created_at > now() - interval '10 minutes'`)).rows[0].n;
  check('in-process: legs to and from the tenant are in-process (no network I/O)', inproc > 0, inproc);
  // WP H2: the clearing ledger records every routed CDR exactly once (the duplicate POST in step 8 included).
  const led = (await until(() => db.query(`SELECT cdr_id, count(*)::int AS n FROM hub_cdr WHERE cdr_id = ANY($1) GROUP BY 1`, [[CDR_ID, xemCdr?.body?.id]]), (r) => r.rows.length === 2)).rows;
  check('ledger (H2): both routed CDRs (external CPO → tenant eMSP, tenant CPO → external eMSP) are in the clearing ledger exactly once',
    led.length === 2 && led.every((r) => r.n === 1), led);

  // ═══════════════════════════════════════════ 13. isolation attacks
  const spoof = await XEM.call('GET', `${XEM.hubEp('locations', 'SENDER')}?limit=1`, undefined, { from: pCPO, to: HUB_SG });
  check('isolation (a): a member sending as another member\'s party → 403 / 4903', spoof.status === 403 && spoof.body.status_code === 4903, spoof.body);
  const noCmd = await XEM.call('POST', `${XEM.hubEp('commands', 'RECEIVER')}/START_SESSION`, { response_url: `${XEM.base}/2.2.1/s/commands/START_SESSION/x1`, token: tok, location_id: siteId, authorization_reference: 'x1' }, { to: HOME });
  check('isolation (b): commands to a CPO whose agreement does not allow them → 403 / 4901', noCmd.status === 403 && noCmd.body.status_code === 4901, noCmd.body);
  const noaGa = await NOA.call('GET', `${NOA.hubEp('locations', 'SENDER')}?limit=10`, undefined, { to: HUB_SG });
  check('isolation (c): a member without agreements gets an empty GET All', noaGa.status === 200 && noaGa.body.data?.length === 0 && noaGa.headers.get('x-total-count') === '0', noaGa.body);
  const noaSess = await NOA.call('GET', `${NOA.hubEp('sessions', 'SENDER')}?date_from=2026-01-01T00:00:00Z`, undefined, { to: pCPO });
  check('isolation (d): an addressed request without an agreement → 403 / 4901', noaSess.status === 403 && noaSess.body.status_code === 4901, noaSess.body);
  const foreign = await XCP.call('PUT', `${XCP.hubEp('locations', 'RECEIVER')}/${HOME.country_code}/${HOME.party_id}/HIJACK`, { ...loc(9), country_code: HOME.country_code, party_id: HOME.party_id, id: 'HIJACK' }, { to: HUB_MY });
  check('isolation (e): a CPO pushing under another party\'s URL → 400 / 2001', foreign.status === 400 && foreign.body.status_code === 2001, foreign.body);
  const notOnConn = await XCP.call('GET', `${XCP.hubEp('tokens', 'SENDER')}`, undefined, { from: HOME });
  check('isolation: OCPI-from naming a party that is not on the connection → 403 / 4903', notOnConn.status === 403 && notOnConn.body.status_code === 4903, notOnConn.body);
  const pulled = await XEM.call('GET', `${XEM.hubEp('sessions', 'SENDER')}?date_from=${encodeURIComponent(new Date(mark9 - 60_000).toISOString())}`, undefined, { to: HOME });
  check('isolation (g): the eMSP pulling the tenant\'s sessions through the hub gets its own drivers\' only',
    pulled.status === 200 && pulled.body.data?.some((s: any) => s.id === tSid) && pulled.body.data.every((s: any) => s.cdr_token?.party_id === EMSP_ID), pulled.body.data?.map((s: any) => s.cdr_token?.party_id));
  const unknown = await XEM.call('GET', `${XEM.hubEp('locations', 'SENDER')}/x`, undefined, { to: { country_code: 'SG', party_id: 'ZZZ' } });
  check('isolation (h): an unknown receiver → 4001', unknown.status === 200 && unknown.body.status_code === 4001, unknown.body);
  await plat('PATCH', `/v1/hub/parties/${XEMp.id}`, { action: 'suspend' });
  const susp = await XCP.call('POST', `${XCP.hubEp('tokens', 'SENDER')}/${UID}/authorize?type=RFID`, {}, { to: pEMSP });
  const mark13 = Date.now();
  await XCP.call('PUT', `${XCP.hubEp('locations', 'RECEIVER')}/MY/${CPO_ID}/${L1.id}`, { ...L1, last_updated: '2026-10-01T11:00:00Z' }, { to: HUB_MY });
  await sleep(1500);
  const dropped = (await db.query(`SELECT count(*)::int AS n FROM hub_outbox WHERE recipient_party_id = $1 AND kind = 'broadcast' AND created_at >= to_timestamp($2 / 1000.0) AND state IN ('dropped','pending')`, [XEMp.id, mark13])).rows[0].n;
  check('isolation (h): a SUSPENDED receiver → 4003 for synchronous calls; broadcasts to it are not delivered',
    susp.body.status_code === 4003 && XEM.received((g) => g.method === 'PUT' && g.path.endsWith(L1.id), mark13).length === 0, { susp: susp.body, dropped });
  await plat('PATCH', `/v1/hub/parties/${XEMp.id}`, { action: 'resume' });
  await plat('PATCH', `/v1/hub/connections/${cNoa.connection.id}`, { rate_limit_per_min: 3 });
  const burst = await Promise.all(Array.from({ length: 6 }, () => NOA.call('GET', NOA.hubEp('hubclientinfo', 'SENDER'), undefined, { from: null })));
  const limited = burst.find((r) => r.status === 429);
  check('isolation (i): over its rate limit a connection gets 429 / 4905 with Retry-After', !!limited && limited.body.status_code === 4905 && !!limited.headers.get('retry-after'), burst.map((r) => r.status));
  await plat('PATCH', `/v1/hub/connections/${cNoa.connection.id}`, { rate_limit_per_min: 600 });

  // ═══════════════════════════════════════════ 14. liveness and token rotation
  await XEM.stop();
  await plat('POST', `/v1/hub/connections/${cEmsp.connection.id}/alive-check`);
  const off = await plat('POST', `/v1/hub/connections/${cEmsp.connection.id}/alive-check`);
  const xcpOff = await until(() => XCP.store.clientInfo.get(`SG*${EMSP_ID}*EMSP`)?.status, (s) => s === 'OFFLINE');
  const tOff = await until(() => db.query(`SELECT status FROM ocpi_hub_client WHERE partner_id = $1 AND party_id = $2`, [hubPartnerId, EMSP_ID]), (r) => r.rows[0]?.status === 'OFFLINE');
  check('liveness: two failed alive checks → the eMSP is OFFLINE, and its counterparties are told (CPO and tenant)',
    off.data?.checks?.[0]?.offline === true && xcpOff === 'OFFLINE' && tOff.rows[0]?.status === 'OFFLINE', { off: off.data, xcpOff, t: tOff.rows });
  const offCall = await XCP.call('POST', `${XCP.hubEp('tokens', 'SENDER')}/${UID}/authorize?type=RFID`, {}, { to: pEMSP });
  check('liveness: a synchronous call to an OFFLINE party → 4003', offCall.body.status_code === 4003, offCall.body);
  await XEM.start();
  const on = await plat('POST', `/v1/hub/connections/${cEmsp.connection.id}/alive-check`);
  const xcpOn = await until(() => XCP.store.clientInfo.get(`SG*${EMSP_ID}*EMSP`)?.status, (s) => s === 'CONNECTED');
  check('liveness: back → CONNECTED, and the counterparties are told', on.data?.checks?.[0]?.ok === true && xcpOn === 'CONNECTED', { on: on.data, xcpOn });
  const oldHubToken = XEM.tokenToHub;
  const rot = await plat('POST', `/v1/hub/connections/${cEmsp.connection.id}/rotate`);
  const rotLeg = XEM.received((g) => g.method === 'PUT' && g.path === '/xem/2.2.1/credentials').pop();
  const newOk = await XEM.call('GET', XEM.hubEp('hubclientinfo', 'SENDER'), undefined, { from: null });
  const oldOk = await XEM.call('GET', XEM.hubEp('hubclientinfo', 'SENDER'), undefined, { from: null, token: oldHubToken });
  check('rotation: the hub PUTs new credentials to the member; the new token works, the old one during the grace period',
    rot.status === 200 && !!rotLeg && XEM.tokenToHub !== oldHubToken && newOk.status === 200 && oldOk.status === 200, { rot: rot.data, n: newOk.status, o: oldOk.status });
  const mark14 = Date.now();
  await XCP.call('PATCH', `${XCP.hubEp('locations', 'RECEIVER')}/MY/${CPO_ID}/${L1.id}/${L1.evses[0]!.uid}`, { status: 'AVAILABLE', last_updated: '2026-10-01T12:00:00Z' }, { to: HUB_MY });
  const afterRot = (await until(() => XEM.received((g) => g.method === 'PATCH' && g.path.endsWith(L1.evses[0]!.uid), mark14), (v) => v.length > 0))[0];
  check('rotation: the hub calls the member with its new token', !!afterRot && XEM.accept.has(decodeToken(afterRot.headers.authorization)) && afterRot.headers.authorization !== xemPut?.headers.authorization, afterRot?.headers.authorization);

  // The member updates its own credentials (PUT): a new token for each side; its old one dies at once.
  const oldC = XCP.tokenToHub;
  const extra = await XCP.call('PUT', XCP.hubEp('credentials', 'RECEIVER'), { ...XCP.credentials(`XCP-B2-${randomUUID()}`), roles: [...XCP.credentials('x').roles, { role: 'EMSP', country_code: 'MY', party_id: CPO_ID, business_details: { name: 'x' } }] }, { from: null });
  check('credentials update: a new party in a PUT needs a platform admin first (400 / 2001)', extra.status === 400 && extra.body.status_code === 2001, extra.body);
  const newB = `XCP-B2-${randomUUID()}`;
  XCP.accept.add(newB);
  const upd = await XCP.call('PUT', XCP.hubEp('credentials', 'RECEIVER'), XCP.credentials(newB), { from: null });
  const newC = upd.body?.data?.token as string;
  const withNew = await XCP.call('GET', XCP.hubEp('hubclientinfo', 'SENDER'), undefined, { from: null, token: newC });
  const withOld = await XCP.call('GET', XCP.hubEp('hubclientinfo', 'SENDER'), undefined, { from: null, token: oldC });
  check('credentials update: the member PUTs new credentials; the new token works, the old one is dead at once',
    upd.status === 200 && !!newC && newC !== oldC && withNew.status === 200 && withOld.status === 401, { u: upd.body, n: withNew.status, o: withOld.status });
  XCP.tokenToHub = newC;

  // ═══════════════════════════════════════════ platform views
  const health = await plat('GET', '/v1/hub/health');
  const hx = health.data?.connections?.find((c: any) => c.id === cCpo.data.connection.id);
  check('admin: health lists the connections with traffic, latency and outbox counts', health.status === 200 && hx?.in_15m > 0 && typeof hx?.outbox_pending === 'number', hx);
  const msgs = await plat('GET', `/v1/hub/messages?connection=${cCpo.data.connection.id}&limit=50`);
  check('admin: the message log masks token uids in paths', msgs.status === 200 && msgs.data.messages.some((m: any) => m.path.includes('/tokens/') && m.path.includes('…')) && !msgs.data.messages.some((m: any) => m.path.includes(UID)), msgs.data.messages?.map((m: any) => m.path).slice(0, 8));
  const ov = await plat('GET', '/v1/hub/overview');
  check('admin: overview counts members, parties, agreements and traffic', ov.status === 200 && ov.data.members.length > 0 && ov.data.traffic24h.length > 0, ov.data);
} catch (e) {
  check('suite ran without crashing', false, (e as Error).stack ?? String(e));
} finally {
  charger?.close();
  if (siteId) await ops('PUT', `/v1/roaming/sites/${siteId}`, { publish: false }).catch(() => null);
  for (const f of [XCP, XEM, NOA]) await f.stop().catch(() => null);
  await db.end().catch(() => null);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
