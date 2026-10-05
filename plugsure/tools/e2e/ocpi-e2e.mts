// PlugSure v1.3 — roaming (OCPI 2.2.1, CPO role) end-to-end test.
//
// A mock eMSP (a local HTTP server acting as the roaming partner) registers
// with PlugSure, pulls its locations and tariffs, pushes driver tokens, and
// receives location status, sessions, CDRs and command results. A raw OCPP 1.6
// charger plays the hardware. Covers both registration directions, whitelist
// and real-time authorisation, the five commands, hub routing headers,
// suspension and withdrawal.
//
// Same prerequisites as console-e2e.mts (API on 9200, gateway on 9220, the
// seeded operator). The mock partner listens on E2E_OCPI_MOCK_PORT (9311).
//     npx tsx tools/e2e/ocpi-e2e.mts
// NEVER point this at production.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { MockEmspPartner, decodeToken as decode, type PeerGot } from './lib/ocpi-fakes.mts';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const MOCK_PORT = Number(process.env.E2E_OCPI_MOCK_PORT ?? 9311);
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000, every = 400): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const iso = (offsetS = 0) => new Date(Date.now() + offsetS * 1000).toISOString();
const b64 = (s: string) => Buffer.from(s).toString('base64');

// ─────────────────────────────────────────── the operator console
let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
}

// ─────────────────────────────────────────── calls from the mock partner to PlugSure
async function ocpi(method: string, url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      ...(token ? { authorization: `Token ${b64(token)}` } : {}),
      'x-request-id': randomUUID(), 'x-correlation-id': randomUUID(),
      'ocpi-from-country-code': 'ID', 'ocpi-from-party-id': 'EMS',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, body: d, headers: r.headers };
}

// ─────────────────────────────────────────── the mock eMSP (tools/e2e/lib/ocpi-fakes.mts)
type Got = PeerGot;
const TOKEN_B = 'mock-emsp-token-B-' + randomUUID();    // partner 1: what PlugSure presents to the mock
const TOKEN_A2 = 'mock-emsp2-token-A-' + randomUUID();  // partner 2 (we connect to it): its registration token
const TOKEN_C2 = 'mock-emsp2-token-C-' + randomUUID();  // partner 2: what PlugSure presents after registering
const mock = new MockEmspPartner({ port: MOCK_PORT, tokenB: TOKEN_B, tokenA2: TOKEN_A2, tokenC2: TOKEN_C2 });
const got = mock.got;
const realtime = mock.realtime;
await mock.start();
const received = (pred: (g: Got) => boolean, after = 0) => mock.received(pred, after);
const waitReceived = (pred: (g: Got) => boolean, after = 0, ms = 20_000) => mock.waitReceived(pred, after, ms);

// ─────────────────────────────────────────── a raw OCPP 1.6 charger
class Raw {
  ws!: WebSocket;
  calls: Array<{ action: string; payload: any; at: number }> = [];
  handlers: Record<string, (p: any) => any> = {};
  pending = new Map<string, (v: any) => void>();
  n = 0;
  constructor(public id: string) {}
  async connect() {
    this.ws = new WebSocket(`${OCPP}/${this.id}`, ['ocpp1.6']);
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f[0] === 2) {
        const [, uid, action, payload] = f;
        this.calls.push({ action, payload, at: Date.now() });
        const h = this.handlers[action];
        this.ws.send(JSON.stringify([3, uid, (h ? h(payload) : { status: 'Accepted' }) ?? {}]));
      } else if (f[0] === 3 || f[0] === 4) {
        this.pending.get(f[1])?.(f[0] === 3 ? f[2] : { __error: f[2] });
        this.pending.delete(f[1]);
      }
    });
  }
  call(action: string, payload: unknown): Promise<any> {
    const id = `${this.id}-${++this.n}`;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify([2, id, action, payload])); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); res({ __timeout: true }); } }, 10_000); });
  }
  waitFor(action: string, after = 0, ms = 15_000) { return until(() => this.calls.find((c) => c.action === action && c.at >= after), (v) => !!v, ms, 200); }
  close() { try { this.ws.close(); } catch {} }
  boot() { return this.call('BootNotification', { chargePointVendor: 'RoamSim', chargePointModel: 'RS-DC-60', firmwareVersion: '1.0.0' }); }
  status(connectorId: number, status: string, errorCode = 'NoError') { return this.call('StatusNotification', { connectorId, errorCode, status, timestamp: iso() }); }
  authorize(idTag: string) { return this.call('Authorize', { idTag }); }
  start(connectorId: number, idTag: string, meterStart: number) { return this.call('StartTransaction', { connectorId, idTag, meterStart, timestamp: iso() }); }
  meter(connectorId: number, transactionId: number, wh: number) { return this.call('MeterValues', { connectorId, transactionId, meterValue: [{ timestamp: iso(), sampledValue: [{ value: String(wh), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }] }); }
  stop(transactionId: number, meterStop: number, reason = 'Local') { return this.call('StopTransaction', { transactionId, meterStop, timestamp: iso(), reason }); }
}

const token = (uid: string, over: Record<string, unknown> = {}) => ({
  country_code: 'ID', party_id: 'EMS', uid, type: 'RFID', contract_id: `ID-EMS-C${uid.slice(-6)}`, issuer: 'E2E eMobility',
  valid: true, whitelist: 'ALLOWED', last_updated: new Date().toISOString(), ...over,
});

let charger: Raw | null = null;
let partnerId = '';
let partner2Id = '';
let siteId = '';
let TOKEN_C = '';
try {
  // ─────────────────────────────────────────── setup
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  const party = await ops('PUT', '/v1/roaming/party', { countryCode: 'id', partyId: 'pls', businessName: 'Nusantara Charge', website: 'https://nusantaracharge.example' });
  check('setup: roaming identity ID*PLS saved', party.status === 200 && party.data.party?.party_id === 'PLS', party.data);
  const badParty = await ops('PUT', '/v1/roaming/party', { countryCode: 'IDN', partyId: 'PL', businessName: 'x' });
  check('setup: a malformed country code or party ID is refused', badParty.status === 400, badParty.data);
  // Leftovers from an earlier run would also receive pushes.
  for (const p of (await ops('GET', '/v1/roaming')).data?.partners ?? []) {
    if (String(p.name).startsWith('E2E eMSP')) await ops('DELETE', `/v1/roaming/partners/${p.id}`);
  }

  const site = await ops('POST', '/v1/sites', { name: 'Roaming E2E Hub', address: 'Jl. Jend. Sudirman Kav. 52-53', city: 'Jakarta Selatan', postalCode: '12190',
    lat: '-6.2254', lon: '106.8076', kabupatenKotaCode: '3174', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000' });
  siteId = site.data.id;
  const noGeo = await ops('POST', '/v1/sites', { name: 'Roaming E2E No Map', address: 'Jl. Tanpa Peta', kabupatenKotaCode: '3174', gridTariffGroup: 'L/TR', connectedKva: '50', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000' });
  const tariff = await ops('POST', '/v1/tariffs', { name: 'Roaming E2E DC', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true,
    components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }, { kind: 'session', rate: 5000, touBlock: 'ANY' }, { kind: 'idle', rate: 1000, touBlock: 'ANY', fromMinutes: 15, toMinutes: 60 }] });
  const tariffId = tariff.data.tariffId as string;
  await ops('PUT', `/v1/sites/${siteId}/tariff`, { tariffId, currentType: 'DC' });
  const ID = `ROAM-${Date.now().toString().slice(-6)}`;
  const reg = await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId, displayName: 'Roam DC', ocppVersion: 'ocpp1.6',
    evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  check('setup: site with map location and city, DC tariff, one 1.6 charger', site.status === 200 && reg.status === 200 && tariff.status === 200, { s: site.data, r: reg.data });
  charger = new Raw(ID);
  charger.handlers.UnlockConnector = () => ({ status: 'Unlocked' });
  await charger.connect(); await charger.boot(); await charger.status(1, 'Available');
  // The API learns which chargers are online from the gateway every few seconds;
  // until then an EVSE is correctly reported as UNKNOWN.
  const online = await until(() => ops('GET', '/v1/charge-points'), (r) => r.data?.find?.((x: any) => x.ocpp_identity === ID)?.online === true, 15_000, 500);
  check('setup: the charger shows online', online.data?.find?.((x: any) => x.ocpp_identity === ID)?.online === true);

  const pubNoGeo = await ops('PUT', `/v1/roaming/sites/${noGeo.data.id}`, { publish: true });
  check('publish: a site without a map location cannot be shared, with the reason', pubNoGeo.status === 422 && /map location/.test(pubNoGeo.data.error), pubNoGeo.data);
  const pub = await ops('PUT', `/v1/roaming/sites/${siteId}`, { publish: true });
  check('publish: the complete site is shared', pub.status === 200, pub.data);

  // ─────────────────────────────────────────── registration: the partner starts
  const created = await ops('POST', '/v1/roaming/partners', { name: 'E2E eMSP', kind: 'emsp' });
  partnerId = created.data.partner?.id;
  const TOKEN_A = created.data.token as string;
  check('register: the console issues token A and our versions URL', created.status === 200 && !!TOKEN_A && /\/ocpi\/versions$/.test(created.data.versionsUrl), created.data);
  const noAuth = await ocpi('GET', '/ocpi/versions', null);
  check('register: no token → 401', noAuth.status === 401, noAuth.body);
  const versions = await ocpi('GET', created.data.versionsUrl, TOKEN_A);
  check('register: versions lists 2.2.1', versions.status === 200 && versions.body.data?.[0]?.version === '2.2.1', versions.body);
  const details = await ocpi('GET', versions.body.data[0].url, TOKEN_A);
  const eps = details.body.data?.endpoints ?? [];
  const ep = (id: string, role: string) => eps.find((e: any) => e.identifier === id && e.role === role)?.url as string;
  check('register: we offer locations/tariffs/sessions/cdrs as SENDER, tokens/commands as RECEIVER',
    !!(['locations', 'tariffs', 'sessions', 'cdrs'].every((m) => ep(m, 'SENDER')) && ep('tokens', 'RECEIVER') && ep('commands', 'RECEIVER')), eps);
  const early = await ocpi('GET', ep('locations', 'SENDER'), TOKEN_A);
  check('register: token A cannot read locations before registering', early.status === 401, early.body);
  const creds = await ocpi('POST', ep('credentials', 'RECEIVER'), TOKEN_A, {
    token: TOKEN_B, url: `${MOCK}/emsp/versions`,
    roles: [{ role: 'EMSP', country_code: 'ID', party_id: 'EMS', business_details: { name: 'E2E eMobility' } }],
  });
  TOKEN_C = creds.body.data?.token;
  check('register: POST credentials returns token C and our CPO role ID*PLS',
    creds.status === 200 && !!TOKEN_C && TOKEN_C !== TOKEN_A && creds.body.data.roles?.[0]?.role === 'CPO' && creds.body.data.roles[0].party_id === 'PLS', creds.body);
  check('register: PlugSure read the partner\'s endpoints with token B', !!received((g) => g.path === '/emsp/2.2.1' && decode(g.headers.authorization as string) === TOKEN_B));
  const deadA = await ocpi('GET', created.data.versionsUrl, TOKEN_A);
  check('register: token A is dead afterwards', deadA.status === 401, deadA.body);
  const again = await ocpi('POST', ep('credentials', 'RECEIVER'), TOKEN_C, { token: TOKEN_B, url: `${MOCK}/emsp/versions`, roles: [{ role: 'EMSP', country_code: 'ID', party_id: 'EMS' }] });
  check('register: a second POST is refused (405: use PUT)', again.status === 405, again.body);
  const getCreds = await ocpi('GET', ep('credentials', 'SENDER'), TOKEN_C);
  check('register: GET credentials returns the current token C', getCreds.status === 200 && getCreds.body.data?.token === TOKEN_C, getCreds.body);

  // ─────────────────────────────────────────── pull: locations and tariffs
  const locs = await ocpi('GET', `${ep('locations', 'SENDER')}?limit=1`, TOKEN_C);
  const total = Number(locs.headers.get('x-total-count'));
  check('pull: locations are paged (X-Total-Count, X-Limit, one item at limit=1)', locs.status === 200 && total >= 1 && locs.headers.get('x-limit') === '1' && locs.body.data?.length === 1 && (total === 1 || !!locs.headers.get('link')), { total, h: [...locs.headers] });
  const loc = await ocpi('GET', `${ep('locations', 'SENDER')}/${siteId}`, TOKEN_C);
  const L = loc.body.data;
  const evse = L?.evses?.[0];
  check('pull: our location with city, IDN, string coordinates and operator name',
    loc.status === 200 && L.city === 'Jakarta Selatan' && L.country === 'IDN' && L.coordinates.latitude === '-6.225400' && L.operator?.name === 'Nusantara Charge', L);
  check('pull: the EVSE is AVAILABLE with an eMI3 id, a CCS2 DC connector and our tariff',
    evse?.status === 'AVAILABLE' && /^ID\*PLS\*E/.test(evse.evse_id) && evse.connectors[0].standard === 'IEC_62196_T2_COMBO' && evse.connectors[0].power_type === 'DC' && evse.connectors[0].tariff_ids?.[0] === tariffId, evse);
  const evseUid = evse?.uid as string;
  const one = await ocpi('GET', `${ep('locations', 'SENDER')}/${siteId}/${evseUid}/1`, TOKEN_C);
  check('pull: a single connector by location/evse/connector', one.status === 200 && one.body.data?.id === '1', one.body);
  const missing = await ocpi('GET', `${ep('locations', 'SENDER')}/${randomUUID()}`, TOKEN_C);
  check('pull: an unknown location answers 404 / 2003', missing.status === 404 && missing.body.status_code === 2003, missing.body);
  const unpublished = await ocpi('GET', `${ep('locations', 'SENDER')}/${noGeo.data.id}`, TOKEN_C);
  check('pull: a site that is not shared is invisible', unpublished.status === 404, unpublished.body);
  const tariffs = await ocpi('GET', ep('tariffs', 'SENDER'), TOKEN_C);
  const T = (tariffs.body.data ?? []).find((t: any) => t.id === tariffId);
  const pc = (type: string) => T?.elements?.flatMap((e: any) => e.price_components).find((c: any) => c.type === type);
  check('pull: the tariff has ENERGY 2400/kWh, FLAT 5000, PARKING_TIME 60000/h, PPN 11 %',
    pc('ENERGY')?.price === 2400 && pc('FLAT')?.price === 5000 && pc('PARKING_TIME')?.price === 60000 && pc('ENERGY')?.vat === 11 && T.currency === 'IDR', T);

  // ─────────────────────────────────────────── push: locations, tariffs, status
  const putLoc = await waitReceived((g) => g.method === 'PUT' && g.path === `/emsp/2.2.1/locations/ID/PLS/${siteId}`);
  check('push: the location is PUT to the partner after registering', !!putLoc && putLoc.body?.id === siteId, putLoc?.path);
  check('push: calls carry our credentials (token B) and OCPI routing headers',
    !!putLoc && decode(putLoc.headers.authorization as string) === TOKEN_B && putLoc.headers['ocpi-from-party-id'] === 'PLS' && putLoc.headers['ocpi-to-party-id'] === 'EMS' && !!putLoc.headers['x-request-id'], putLoc?.headers);
  const putTar = await waitReceived((g) => g.method === 'PUT' && g.path === `/emsp/2.2.1/tariffs/ID/PLS/${tariffId}`);
  check('push: the tariff is PUT to the partner', !!putTar, got.filter((g) => g.path.includes('tariffs')).map((g) => g.path));
  let mark = Date.now();
  await charger.status(1, 'Faulted', 'GroundFailure');
  const patchFault = await waitReceived((g) => g.method === 'PATCH' && g.path === `/emsp/2.2.1/locations/ID/PLS/${siteId}/${evseUid}`, mark);
  check('push: a fault is PATCHed as OUTOFORDER within seconds', patchFault?.body?.status === 'OUTOFORDER', patchFault?.body);
  mark = Date.now();
  await charger.status(1, 'Available');
  const patchOk = await waitReceived((g) => g.method === 'PATCH' && g.path.endsWith(`/${evseUid}`) && g.body?.status === 'AVAILABLE', mark);
  check('push: recovery is PATCHed as AVAILABLE', !!patchOk, patchOk?.body);

  // ─────────────────────────────────────────── tokens pushed by the partner
  const tokUrl = (uid: string, cc = 'ID', pid = 'EMS') => `${ep('tokens', 'RECEIVER')}/${cc}/${pid}/${uid}`;
  const UID = `RFID-E2E-${Date.now().toString().slice(-6)}`;
  const put1 = await ocpi('PUT', tokUrl(UID), TOKEN_C, token(UID));
  const get1 = await ocpi('GET', tokUrl(UID), TOKEN_C);
  check('tokens: the partner pushes a driver token and reads it back', put1.status === 200 && get1.body.data?.contract_id === token(UID).contract_id, { put1: put1.body, get1: get1.body });
  const foreign = await ocpi('PUT', tokUrl(UID, 'ID', 'XYZ'), TOKEN_C, token(UID, { party_id: 'XYZ' }));
  check('tokens: a token of a party the partner does not represent is refused', foreign.status === 403, foreign.body);
  const badTok = await ocpi('PUT', tokUrl(UID), TOKEN_C, token(UID, { whitelist: 'SOMETIMES' }));
  check('tokens: an invalid token is refused with a reason', badTok.status === 400 && /whitelist/.test(badTok.body.status_message), badTok.body);
  const BLOCKED = `${UID}-X`;
  await ocpi('PUT', tokUrl(BLOCKED), TOKEN_C, token(BLOCKED));
  const patch = await ocpi('PATCH', tokUrl(BLOCKED), TOKEN_C, { valid: false, last_updated: new Date().toISOString() });
  check('tokens: PATCH updates one field (valid → false)', patch.status === 200, patch.body);

  // ─────────────────────────────────────────── a roaming driver charges with a card
  const a1 = await charger.authorize(UID);
  check('charge: the partner\'s card is accepted at the charger (whitelist ALLOWED)', a1.idTagInfo?.status === 'Accepted', a1);
  const aBlocked = await charger.authorize(BLOCKED);
  const aUnknown = await charger.authorize('NOBODY-' + Date.now());
  check('charge: a card the partner invalidated is Blocked; an unknown card is Invalid', aBlocked.idTagInfo?.status === 'Blocked' && aUnknown.idTagInfo?.status === 'Invalid', { aBlocked, aUnknown });
  mark = Date.now();
  const s1 = await charger.start(1, UID, 1_000_000);
  await charger.status(1, 'Charging');
  const putActive = await waitReceived((g) => g.method === 'PUT' && g.path.startsWith('/emsp/2.2.1/sessions/ID/PLS/') && g.body?.status === 'ACTIVE' && g.body?.cdr_token?.uid === UID, mark);
  const sessionId = putActive?.body?.id as string;
  check('charge: the session is PUT to the partner as ACTIVE with the driver\'s contract id',
    !!putActive && putActive.body.cdr_token.contract_id === token(UID).contract_id && putActive.body.auth_method === 'WHITELIST' && putActive.body.location_id === siteId && putActive.body.evse_uid === evseUid,
    putActive?.body ?? got.filter((g) => g.path.includes('sessions')).map((g) => g.path));
  check('charge: session pushes are addressed to the token\'s party', putActive?.headers['ocpi-to-party-id'] === 'EMS');
  await charger.meter(1, s1.transactionId, 1_004_000);
  const patchKwh = await waitReceived((g) => g.method === 'PATCH' && g.path === `/emsp/2.2.1/sessions/ID/PLS/${sessionId}` && g.body?.kwh === 4, mark);
  check('charge: energy updates are PATCHed (4 kWh)', !!patchKwh, got.filter((g) => g.path.includes(sessionId ?? 'x')).map((g) => [g.method, g.body?.kwh]));
  await charger.meter(1, s1.transactionId, 1_008_000);
  await charger.stop(s1.transactionId, 1_008_000, 'EVDisconnected');
  await charger.status(1, 'Available');
  const putDone = await waitReceived((g) => g.method === 'PUT' && g.path === `/emsp/2.2.1/sessions/ID/PLS/${sessionId}` && g.body?.status === 'COMPLETED', mark);
  const cdr = await waitReceived((g) => g.method === 'POST' && g.path === '/emsp/2.2.1/cdrs' && g.body?.session_id === sessionId, mark);
  const ours = await ops('GET', `/v1/sessions/search?identity=${ID}&limit=5`);
  const row = (ours.data?.rows ?? []).find((r: any) => r.id === sessionId);
  check('charge: the final session is PUT as COMPLETED with its total cost', !!putDone && putDone.body.kwh === 8 && putDone.body.total_cost?.incl_vat === Number(row?.total_minor), { p: putDone?.body?.total_cost, t: row?.total_minor });
  check('charge: the CDR is POSTed: 8 kWh, our total incl. taxes, excl_vat = subtotal + PBJT, the tariff that priced it',
    !!cdr && cdr.body.total_energy === 8 && cdr.body.total_cost.incl_vat === Number(row?.total_minor)
      && cdr.body.total_cost.excl_vat === Number(row?.subtotal_minor) + Number(row?.local_tax_minor) && cdr.body.tariffs?.[0]?.id === tariffId && cdr.body.cdr_location?.evse_uid === evseUid,
    { cdr: cdr?.body?.total_cost, row: row && { s: row.subtotal_minor, p: row.local_tax_minor, t: row.total_minor } });
  check('charge: the order was PUT → PATCH → PUT → CDR', (() => {
    const seq = got.filter((g) => g.at >= mark && (g.path.includes(`/sessions/ID/PLS/${sessionId}`) || (g.path === '/emsp/2.2.1/cdrs' && g.body?.session_id === sessionId))).map((g) => g.method);
    return seq[0] === 'PUT' && seq.at(-1) === 'POST' && seq.indexOf('POST') === seq.length - 1;
  })());

  // ─────────────────────────────────────────── real-time authorisation (whitelist NEVER)
  const RT_OK = `${UID}-RT`; const RT_NO = `${UID}-RN`;
  realtime[RT_OK] = { allowed: 'ALLOWED', ref: 'AUTH-REF-1' };
  realtime[RT_NO] = { allowed: 'BLOCKED' };
  await ocpi('PUT', tokUrl(RT_OK), TOKEN_C, token(RT_OK, { whitelist: 'NEVER' }));
  await ocpi('PUT', tokUrl(RT_NO), TOKEN_C, token(RT_NO, { whitelist: 'NEVER' }));
  mark = Date.now();
  const aRt = await charger.authorize(RT_OK);
  const asked = received((g) => g.method === 'POST' && g.path.startsWith(`/emsp/2.2.1/tokens/${RT_OK}/authorize`), mark);
  check('realtime: a NEVER-whitelisted card is checked with the partner and accepted', aRt.idTagInfo?.status === 'Accepted' && !!asked && asked.body?.location_id === siteId, { aRt, asked: asked?.path });
  const aNo = await charger.authorize(RT_NO);
  check('realtime: the partner\'s BLOCKED answer blocks the card', aNo.idTagInfo?.status === 'Blocked', aNo);
  const s2 = await charger.start(1, RT_OK, 2_000_000);
  const putRt = await waitReceived((g) => g.method === 'PUT' && g.body?.cdr_token?.uid === RT_OK && g.body?.status === 'ACTIVE', mark);
  check('realtime: the session records AUTH_REQUEST and the partner\'s authorization_reference', putRt?.body?.auth_method === 'AUTH_REQUEST' && putRt.body.authorization_reference === 'AUTH-REF-1', putRt?.body);
  await charger.stop(s2.transactionId, 2_001_000);

  // ─────────────────────────────────────────── pull: sessions and CDRs
  const noDate = await ocpi('GET', ep('sessions', 'SENDER'), TOKEN_C);
  check('pull: sessions require date_from', noDate.status === 400 && noDate.body.status_code === 2001, noDate.body);
  const since = new Date(Date.now() - 3600_000).toISOString();
  const sessions = await ocpi('GET', `${ep('sessions', 'SENDER')}?date_from=${since}`, TOKEN_C);
  check('pull: the partner lists its drivers\' sessions', sessions.status === 200 && (sessions.body.data ?? []).some((s: any) => s.id === sessionId), (sessions.body.data ?? []).map((s: any) => s.id));
  const cdrs = await until(() => ocpi('GET', `${ep('cdrs', 'SENDER')}?date_from=${since}`, TOKEN_C), (r) => (r.body.data ?? []).some((c: any) => c.session_id === sessionId), 10_000);
  check('pull: the partner lists its CDRs', (cdrs.body.data ?? []).some((c: any) => c.session_id === sessionId && c.total_energy === 8), (cdrs.body.data ?? []).map((c: any) => c.session_id));

  // ─────────────────────────────────────────── commands
  const cmd = (name: string, body: unknown, t = TOKEN_C) => ocpi('POST', `${ep('commands', 'RECEIVER')}/${name}`, t, body);
  const CMD = `CMD-E2E-${Date.now().toString().slice(-6)}`;
  mark = Date.now();
  const startCmd = await cmd('START_SESSION', { response_url: `${MOCK}/cmd/start-1`, token: token(CMD), location_id: siteId, evse_uid: evseUid, connector_id: '1', authorization_reference: 'CMD-REF-1' });
  check('command: START_SESSION is ACCEPTED with a timeout', startCmd.status === 200 && startCmd.body.data?.result === 'ACCEPTED' && startCmd.body.data.timeout > 0, startCmd.body);
  const rst = await charger.waitFor('RemoteStartTransaction', mark);
  check('command: the charger receives RemoteStartTransaction with the driver\'s token', rst?.payload?.idTag === CMD && rst.payload.connectorId === 1, rst?.payload);
  const startResult = await waitReceived((g) => g.path === '/cmd/start-1', mark);
  check('command: the result ACCEPTED is POSTed to response_url', startResult?.body?.result === 'ACCEPTED', startResult?.body);
  const aCmd = await charger.authorize(CMD);
  const s3 = await charger.start(1, CMD, 3_000_000);
  await charger.status(1, 'Charging');
  const putCmd = await waitReceived((g) => g.method === 'PUT' && g.body?.cdr_token?.uid === CMD && g.body?.status === 'ACTIVE', mark);
  check('command: the session started by the command records COMMAND and its reference', aCmd.idTagInfo?.status === 'Accepted' && putCmd?.body?.auth_method === 'COMMAND' && putCmd.body.authorization_reference === 'CMD-REF-1', { aCmd, s: putCmd?.body });
  mark = Date.now();
  const stopCmd = await cmd('STOP_SESSION', { response_url: `${MOCK}/cmd/stop-1`, session_id: putCmd?.body?.id });
  const rstop = await charger.waitFor('RemoteStopTransaction', mark);
  const stopResult = await waitReceived((g) => g.path === '/cmd/stop-1', mark);
  check('command: STOP_SESSION stops the transaction at the charger and reports ACCEPTED', stopCmd.body.data?.result === 'ACCEPTED' && rstop?.payload?.transactionId === s3.transactionId && stopResult?.body?.result === 'ACCEPTED', { r: stopCmd.body, p: rstop?.payload, res: stopResult?.body });
  await charger.stop(s3.transactionId, 3_002_000, 'Remote');
  await charger.status(1, 'Available');
  const unknownStop = await cmd('STOP_SESSION', { response_url: `${MOCK}/cmd/stop-2`, session_id: randomUUID() });
  check('command: STOP_SESSION for an unknown session answers UNKNOWN_SESSION', unknownStop.body.data?.result === 'UNKNOWN_SESSION', unknownStop.body);
  mark = Date.now();
  await cmd('UNLOCK_CONNECTOR', { response_url: `${MOCK}/cmd/unlock-1`, location_id: siteId, evse_uid: evseUid, connector_id: '1' });
  const unl = await charger.waitFor('UnlockConnector', mark);
  const unlResult = await waitReceived((g) => g.path === '/cmd/unlock-1', mark);
  check('command: UNLOCK_CONNECTOR unlocks at the charger and reports ACCEPTED', unl?.payload?.connectorId === 1 && unlResult?.body?.result === 'ACCEPTED', { unl: unl?.payload, r: unlResult?.body });
  // A local driver (the operator's own card) charges next: the partner may no longer unlock.
  const local = await charger.start(1, 'ID-RFID-0001', 4_000_000);
  const unlockOther = await cmd('UNLOCK_CONNECTOR', { response_url: `${MOCK}/cmd/unlock-2`, location_id: siteId, evse_uid: evseUid, connector_id: '1' });
  check('command: a partner cannot unlock a connector another driver is using', unlockOther.body.data?.result === 'REJECTED', unlockOther.body);
  await charger.stop(local.transactionId, 4_000_500);
  mark = Date.now();
  const RES = `RES-${Date.now().toString().slice(-6)}`;
  await cmd('RESERVE_NOW', { response_url: `${MOCK}/cmd/reserve-1`, token: token(CMD), expiry_date: new Date(Date.now() + 15 * 60_000).toISOString(), reservation_id: RES, location_id: siteId, evse_uid: evseUid });
  const rn = await charger.waitFor('ReserveNow', mark);
  const rnResult = await waitReceived((g) => g.path === '/cmd/reserve-1', mark);
  const reservedView = await until(() => ocpi('GET', `${ep('locations', 'SENDER')}/${siteId}/${evseUid}`, TOKEN_C), (r) => r.body.data?.status === 'RESERVED', 5000);
  check('command: RESERVE_NOW reserves at the charger (integer reservation id) and the EVSE shows RESERVED',
    Number.isInteger(rn?.payload?.reservationId) && rn?.payload?.idTag === CMD && rnResult?.body?.result === 'ACCEPTED' && reservedView.body.data?.status === 'RESERVED', { rn: rn?.payload, r: rnResult?.body, st: reservedView.body.data?.status });
  mark = Date.now();
  await cmd('CANCEL_RESERVATION', { response_url: `${MOCK}/cmd/cancel-1`, reservation_id: RES });
  const cr = await charger.waitFor('CancelReservation', mark);
  const crResult = await waitReceived((g) => g.path === '/cmd/cancel-1', mark);
  check('command: CANCEL_RESERVATION cancels the same reservation id at the charger', cr?.payload?.reservationId === rn?.payload?.reservationId && crResult?.body?.result === 'ACCEPTED', { cr: cr?.payload, r: crResult?.body });
  const badLoc = await cmd('START_SESSION', { response_url: `${MOCK}/cmd/x`, token: token(CMD), location_id: randomUUID() });
  check('command: an unknown location answers 404 / 2003', badLoc.status === 404 && badLoc.body.status_code === 2003, badLoc.body);
  const otherParty = await cmd('START_SESSION', { response_url: `${MOCK}/cmd/x`, token: token(CMD, { party_id: 'XYZ' }), location_id: siteId });
  check('command: a token of another party is REJECTED', otherParty.body.data?.result === 'REJECTED', otherParty.body);

  // ─────────────────────────────────────────── routing, suspension, partner-side registration
  const misrouted = await ocpi('GET', ep('locations', 'SENDER'), TOKEN_C, undefined, { 'ocpi-to-country-code': 'ID', 'ocpi-to-party-id': 'XYZ' });
  check('routing: a message addressed to another party is refused (2001)', misrouted.status === 400 && misrouted.body.status_code === 2001, misrouted.body);
  const echo = await ocpi('GET', ep('locations', 'SENDER'), TOKEN_C);
  check('routing: our answers carry OCPI-from (PLS) and OCPI-to (the caller) headers', echo.headers.get('ocpi-from-party-id') === 'PLS' && echo.headers.get('ocpi-to-party-id') === 'EMS');
  await ops('PATCH', `/v1/roaming/partners/${partnerId}`, { state: 'suspended' });
  const suspended = await ocpi('GET', ep('locations', 'SENDER'), TOKEN_C);
  await ops('PATCH', `/v1/roaming/partners/${partnerId}`, { state: 'connected' });
  const resumed = await ocpi('GET', ep('locations', 'SENDER'), TOKEN_C);
  check('suspend: a suspended partner is locked out, and resuming restores access', suspended.status === 401 && resumed.status === 200, { s: suspended.status, r: resumed.status });

  const p2 = await ops('POST', '/v1/roaming/partners', { name: 'E2E eMSP Two' });
  partner2Id = p2.data.partner?.id;
  const conn2 = await ops('POST', `/v1/roaming/partners/${partner2Id}/connect`, { versionsUrl: `${MOCK}/emsp2/versions`, token: TOKEN_A2 });
  check('connect: PlugSure registers with a partner from its versions URL and token A (picks 2.2.1 of two versions)', conn2.status === 200 && conn2.data?.state === 'connected' && conn2.data?.party_id === 'EM2', conn2.data);
  const p2Creds = received((g) => g.method === 'POST' && g.path === '/emsp2/2.2.1/credentials');
  check('connect: our POST carried our versions URL, our token B and the CPO role', !!mock.ourTokenB2 && /\/ocpi\/versions$/.test(p2Creds?.body?.url) && p2Creds?.body?.roles?.[0]?.role === 'CPO', p2Creds?.body);
  const p2Pull = await ocpi('GET', ep('locations', 'SENDER'), mock.ourTokenB2, undefined, { 'ocpi-from-party-id': 'EM2' });
  check('connect: partner two reads our locations with the token we gave it', p2Pull.status === 200, p2Pull.body);
  const p2Push = await waitReceived((g) => g.method === 'PUT' && g.path === `/emsp2/2.2.1/locations/ID/PLS/${siteId}` && decode(g.headers.authorization as string) === TOKEN_C2);
  check('connect: partner two receives our locations, signed with its token C', !!p2Push, got.filter((g) => g.path.startsWith('/emsp2')).map((g) => [g.method, g.path]));

  // ─────────────────────────────────────────── the console view
  const view = await ops('GET', '/v1/roaming');
  const pv = (view.data?.partners ?? []).find((p: any) => p.id === partnerId);
  check('console: the partner shows as connected with its sessions and tokens', pv?.state === 'connected' && pv.sessions >= 3 && pv.tokens >= 4, pv);
  check('console: the shared site shows as published; the site without a map shows why not',
    (view.data?.sites ?? []).find((s: any) => s.id === siteId)?.publish === true && /map location/.test((view.data?.sites ?? []).find((s: any) => s.id === noGeo.data.id)?.problem ?? ''));
  const msgs = await ops('GET', `/v1/roaming/partners/${partnerId}/messages`);
  check('console: the message log shows calls in both directions', (msgs.data ?? []).some((m: any) => m.direction === 'in') && (msgs.data ?? []).some((m: any) => m.direction === 'out'), (msgs.data ?? []).length);
  const rs = await ops('GET', '/v1/roaming/sessions');
  check('console: roaming sessions list the partner and the contract id', (rs.data ?? []).some((s: any) => s.id === sessionId && s.partner_name === 'E2E eMSP' && s.contract_id === token(UID).contract_id), (rs.data ?? []).slice(0, 2));
  const pushes = await ops('GET', `/v1/roaming/partners/${partnerId}/pushes`);
  check('console: nothing failed in the outbox', !(pushes.data ?? []).some((p: any) => p.state === 'failed'), (pushes.data ?? []).filter((p: any) => p.state === 'failed'));

  // ─────────────────────────────────────────── withdrawal and disconnect
  mark = Date.now();
  await ops('PUT', `/v1/roaming/sites/${siteId}`, { publish: false });
  const withdrawn = await waitReceived((g) => g.method === 'PUT' && g.path === `/emsp/2.2.1/locations/ID/PLS/${siteId}` && g.body?.publish === false, mark);
  check('withdraw: un-sharing a site sends it with publish=false', !!withdrawn, withdrawn?.body?.publish);
  const hidden = await ocpi('GET', `${ep('locations', 'SENDER')}/${siteId}`, TOKEN_C);
  check('withdraw: the site is no longer listed', hidden.status === 404, hidden.body);
  mark = Date.now();
  const del = await ops('DELETE', `/v1/roaming/partners/${partnerId}`);
  const told = await waitReceived((g) => g.method === 'DELETE' && g.path === '/emsp/2.2.1/credentials', mark, 5000);
  const after = await ocpi('GET', ep('locations', 'SENDER'), TOKEN_C);
  check('disconnect: the partner is told (DELETE credentials) and its token stops working', del.status === 200 && !!told && after.status === 401, { del: del.data, told: !!told, after: after.status });
  partnerId = '';
} catch (e) {
  check('no unexpected exception', false, (e as Error).stack);
} finally {
  if (partnerId) await ops('DELETE', `/v1/roaming/partners/${partnerId}`).catch(() => null);
  if (partner2Id) await ops('DELETE', `/v1/roaming/partners/${partner2Id}`).catch(() => null);
  charger?.close();
  mock.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
