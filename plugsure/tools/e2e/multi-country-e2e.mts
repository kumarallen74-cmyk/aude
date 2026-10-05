// PlugSure v1.7 — one operator in Indonesia, Malaysia and Singapore, end to end
// (docs/MULTI-COUNTRY-DESIGN.md WP1).
//
// The seeded Indonesian operator opens a Malaysian and a Singapore site through the
// console API, with tariffs in ringgit and Singapore dollars (GST-inclusive), and a
// raw OCPP 1.6 charger at each. Sessions are rated in sen / cents by the country's
// tax engine; the console API answers in the session's currency (no rupiah alias on
// a ringgit amount). A mock eMSP registers over OCPI and pulls Locations, Tariffs and
// CDRs: each site under its country's party, with its country and time zone, each
// tariff and CDR in its currency; a hub-addressed request is filtered to one party.
//
// Needs the stack with MULTI_COUNTRY=true (CI sets it), E2E_DATABASE_URL (the SG GST
// registration is written directly: its console screen is WP2), the seeded operator.
// The mock partner listens on E2E_MC_MOCK_PORT (9312).
//     npx tsx tools/e2e/multi-country-e2e.mts
// NEVER point this at production.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import pg from 'pg';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const MOCK_PORT = Number(process.env.E2E_MC_MOCK_PORT ?? 9312);
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const DB_URL = process.env.E2E_DATABASE_URL;
const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000, every = 400): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const iso = () => new Date().toISOString();
const b64 = (s: string) => Buffer.from(s).toString('base64');

let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d, headers: r.headers };
}
async function ocpi(method: string, url: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: { ...(token ? { authorization: `Token ${b64(token)}` } : {}), 'x-request-id': randomUUID(), 'x-correlation-id': randomUUID(),
      'ocpi-from-country-code': 'MY', 'ocpi-from-party-id': 'EMM', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, body: d, headers: r.headers };
}

// ─────────────────────────────────────────── a mock eMSP (registers, receives pushes)
const got: Array<{ method: string; path: string; body: any; headers: http.IncomingHttpHeaders; at: number }> = [];
const TOKEN_B = 'mc-emsp-token-B-' + randomUUID();
const decode = (h?: string) => (h?.startsWith('Token ') ? Buffer.from(h.slice(6), 'base64').toString() : '');
const env = (data: unknown, status = 1000) => JSON.stringify({ ...(data === undefined ? {} : { data }), status_code: status, timestamp: iso() });
const mock = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    let body: any = null; try { body = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch {}
    got.push({ method: req.method!, path, body, headers: req.headers, at: Date.now() });
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(env(data)); };
    if (decode(req.headers.authorization) !== TOKEN_B) return send(401, undefined);
    if (path === '/mc/versions') return send(200, [{ version: '2.2.1', url: `${MOCK}/mc/2.2.1` }]);
    if (path === '/mc/2.2.1') return send(200, { version: '2.2.1', endpoints: [
      { identifier: 'credentials', role: 'RECEIVER', url: `${MOCK}/mc/2.2.1/credentials` },
      { identifier: 'locations', role: 'RECEIVER', url: `${MOCK}/mc/2.2.1/locations` },
      { identifier: 'tariffs', role: 'RECEIVER', url: `${MOCK}/mc/2.2.1/tariffs` },
      { identifier: 'sessions', role: 'RECEIVER', url: `${MOCK}/mc/2.2.1/sessions` },
      { identifier: 'cdrs', role: 'RECEIVER', url: `${MOCK}/mc/2.2.1/cdrs` },
    ] });
    send(200, undefined);
  });
});
await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r()));

// ─────────────────────────────────────────── a raw OCPP 1.6 charger
class Raw {
  ws!: WebSocket;
  pending = new Map<string, (v: any) => void>();
  n = 0;
  constructor(public id: string) {}
  async connect() {
    this.ws = new WebSocket(`${OCPP}/${this.id}`, ['ocpp1.6']);
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f[0] === 2) this.ws.send(JSON.stringify([3, f[1], { status: 'Accepted' }]));
      else if (f[0] === 3 || f[0] === 4) { this.pending.get(f[1])?.(f[0] === 3 ? f[2] : { __error: f[2] }); this.pending.delete(f[1]); }
    });
  }
  call(action: string, payload: unknown): Promise<any> {
    const id = `${this.id}-${++this.n}`;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify([2, id, action, payload])); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); res({ __timeout: true }); } }, 10_000); });
  }
  close() { try { this.ws.close(); } catch {} }
}

const chargers: Raw[] = [];
let db: pg.Client | null = null;
let partnerId = '';
const stamp = Date.now().toString().slice(-6);
try {
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  const me = await ops('GET', '/v1/auth/me');
  const orgId = me.data?.org?.id ?? me.data?.orgId ?? me.data?.user?.org_id;

  // ─────────────────────────────── sites per country
  const badSg = await ops('POST', '/v1/sites', { countryCode: 'SG', name: 'Bad SG', kabupatenKotaCode: '3171', postalCode: '039594' });
  check('sites: Indonesian fields are refused for a Singapore site', badSg.status === 422 && /Indonesian sites only/.test(badSg.data?.error), badSg.data);
  const badTz = await ops('POST', '/v1/sites', { countryCode: 'MY', name: 'Bad MY', timezone: 'Asia/Jakarta' });
  check('sites: a Malaysian site takes Malaysian time zones only', badTz.status === 422 && /MYT/.test(badTz.data?.error), badTz.data);
  const my = await ops('POST', '/v1/sites', { countryCode: 'MY', name: `MC KL ${stamp}`, address: 'Jalan Bukit Bintang 168', city: 'Kuala Lumpur',
    postalCode: '55100', lat: '3.149', lon: '101.7133', connectedKva: '150', powerFactor: '0.95', phases: '3' });
  const sg = await ops('POST', '/v1/sites', { countryCode: 'SG', name: `MC Marina ${stamp}`, address: '6 Raffles Boulevard', city: 'Singapore',
    postalCode: '039594', lat: '1.2913', lon: '103.8572', connectedKva: '150', powerFactor: '0.95', phases: '3' });
  check('sites: a Malaysian and a Singapore site are created (MULTI_COUNTRY=true)', my.status === 200 && sg.status === 200, { my: my.data, sg: sg.data });
  const mySite = (await ops('GET', `/v1/sites/${my.data.id}`)).data;
  const sgSite = (await ops('GET', `/v1/sites/${sg.data.id}`)).data;
  check('sites: each gets its country\'s default time zone', mySite.country_code === 'MY' && mySite.timezone === 'Asia/Kuala_Lumpur' && sgSite.country_code === 'SG' && sgSite.timezone === 'Asia/Singapore', { my: [mySite.country_code, mySite.timezone], sg: [sgSite.country_code, sgSite.timezone] });

  // ─────────────────────────────── tariffs per currency
  const badT = await ops('POST', '/v1/tariffs', { name: 'Bad SG', countryCode: 'SG', appliesToMaxPowerW: 22000, components: [{ kind: 'energy', rate: 0.6, touBlock: 'WBP' }] });
  check('tariffs: WBP/LWBP blocks are refused outside Indonesia', badT.status === 422 && badT.data?.flags?.some((f: any) => f.code === 'TOU_BLOCK_NOT_APPLICABLE'), badT.data);
  const myT = await ops('POST', '/v1/tariffs', { name: `MC MY ${stamp}`, countryCode: 'MY', appliesToMaxPowerW: 60000,
    components: [{ kind: 'energy', rate: 1.2, touBlock: 'ANY' }, { kind: 'idle', rate: 0.5, touBlock: 'ANY', fromMinutes: 15, toMinutes: 75 }] });
  const sgT = await ops('POST', '/v1/tariffs', { name: `MC SG ${stamp}`, countryCode: 'SG', appliesToMaxPowerW: 22000,
    components: [{ kind: 'energy', rate: 0.65, touBlock: 'ANY' }] });
  check('tariffs: RM 1.20/kWh and S$0.65/kWh (incl. GST) are saved', myT.status === 200 && sgT.status === 200, { my: myT.data, sg: sgT.data });
  const list = (await ops('GET', '/v1/tariffs')).data as any[];
  const lt = list.find((t: any) => t.id === sgT.data.tariffId);
  check('tariffs: listed with country, currency and inclusive prices', lt?.country_code === 'SG' && lt?.currency === 'SGD' && lt?.prices_include_tax === true, lt);
  const idTariffId = list.find((t: any) => t.currency === 'IDR' && t.status === 'active')?.id;
  const wrong = await ops('PUT', `/v1/sites/${my.data.id}/tariff`, { tariffId: idTariffId });
  check('tariffs: a rupiah tariff cannot price the Malaysian site', wrong.status === 409 && wrong.data?.flags?.[0]?.code === 'TARIFF_COUNTRY_MISMATCH', wrong.data);
  const a1 = await ops('PUT', `/v1/sites/${my.data.id}/tariff`, { tariffId: myT.data.tariffId });
  const a2 = await ops('PUT', `/v1/sites/${sg.data.id}/tariff`, { tariffId: sgT.data.tariffId });
  check('tariffs: each site gets its own country\'s tariff', a1.status === 200 && a2.status === 200, { a1: a1.data, a2: a2.data });

  // Singapore: the operator is GST-registered (the console screen for registrations is WP2).
  if (DB_URL && orgId) {
    db = new pg.Client({ connectionString: DB_URL });
    await db.connect();
    await db.query(`INSERT INTO org_tax_registration (org_id, country_code, scheme, registration_no, registered, effective_from, created_by)
                    SELECT $1, 'SG', 'SG_GST', '201912345M', true, DATE '2024-01-01', 'e2e'
                     WHERE NOT EXISTS (SELECT 1 FROM org_tax_registration WHERE org_id = $1 AND scheme = 'SG_GST' AND effective_to IS NULL)`, [orgId]);
  }
  check('setup: the SG GST registration is in place', !!db && !!orgId, { orgId, db: !!DB_URL });

  // ─────────────────────────────── roaming identities: home ID*PLS, SG*PLS; a mock eMSP registers
  await ops('PUT', '/v1/roaming/party', { countryCode: 'ID', partyId: 'PLS', businessName: 'Nusantara Charge' });
  const sgParty = await ops('PUT', '/v1/roaming/parties/SG', { partyId: 'PLS', businessName: 'Nusantara Charge Singapore' });
  const parties = await ops('GET', '/v1/roaming/parties');
  check('roaming: one party per country (home ID, SG added)', sgParty.status === 200 && parties.data?.parties?.map((p: any) => `${p.country_code}${p.is_home ? '*' : ''}`).join(',') === 'ID*,SG', parties.data);
  // v1.7.0 review fix 9: a site is shared only under its own country's party — no MY party yet, so the Malaysian
  // site is refused (not published under the Indonesian identity); the Singapore one is shared under SG*PLS.
  const pubMy = await ops('PUT', `/v1/roaming/sites/${my.data.id}`, { publish: true });
  const pubSg = await ops('PUT', `/v1/roaming/sites/${sg.data.id}`, { publish: true });
  check('roaming: the SG site is shared; the MY site is refused while there is no MY party', pubSg.status === 200 && pubMy.status === 422 && /no OCPI party for MY/.test(pubMy.data?.error), { pubMy: pubMy.data, pubSg: pubSg.data });
  for (const p of (await ops('GET', '/v1/roaming')).data?.partners ?? []) if (String(p.name).startsWith('MC eMSP')) await ops('DELETE', `/v1/roaming/partners/${p.id}`);
  const created = await ops('POST', '/v1/roaming/partners', { name: 'MC eMSP', kind: 'emsp' });
  partnerId = created.data.partner?.id;
  const versions = await ocpi('GET', created.data.versionsUrl, created.data.token);
  const details = await ocpi('GET', versions.body.data[0].url, created.data.token);
  const ep = (id: string, role: string) => (details.body.data?.endpoints ?? []).find((e: any) => e.identifier === id && e.role === role)?.url as string;
  const creds = await ocpi('POST', ep('credentials', 'RECEIVER'), created.data.token, {
    token: TOKEN_B, url: `${MOCK}/mc/versions`, roles: [{ role: 'EMSP', country_code: 'MY', party_id: 'EMM', business_details: { name: 'MC eMobility' } }],
  });
  const TOKEN_C = creds.body.data?.token as string;
  const roles = (creds.body.data?.roles ?? []).map((r: any) => `${r.role}:${r.country_code}*${r.party_id}`);
  check('roaming: our credentials list a CPO role per country party and the home eMSP role', creds.status === 200 && roles.join(',') === 'CPO:ID*PLS,EMSP:ID*PLS,CPO:SG*PLS', roles);

  // ─────────────────────────────── chargers and sessions
  const runAt = async (siteId: string, kind: 'DC' | 'AC', idTag: string) => {
    const ident = `MC-${kind}-${stamp}-${chargers.length}`;
    const reg = await ops('POST', '/v1/charge-points', { ocppIdentity: ident, siteId, displayName: ident, ocppVersion: 'ocpp1.6',
      evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: kind === 'DC' ? 'cCCS2' : 'sType2', currentKind: kind === 'DC' ? 'DC' : 'AC3', maxPowerW: kind === 'DC' ? 60000 : 22000 }] }] });
    check(`charge: ${ident} is registered at its site`, reg.status === 200, reg.data);
    await ops('POST', `/v1/charge-points/${ident}/activate`);
    const c = new Raw(ident);
    chargers.push(c);
    await c.connect();
    await c.call('BootNotification', { chargePointVendor: 'McSim', chargePointModel: kind, firmwareVersion: '1.0.0' });
    await c.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: iso() });
    const auth = await c.call('Authorize', { idTag });
    const st = await c.call('StartTransaction', { connectorId: 1, idTag, meterStart: 1_000_000, timestamp: iso() });
    await c.call('StopTransaction', { transactionId: st.transactionId, meterStop: 1_020_000, timestamp: iso(), reason: 'EVDisconnected' });
    await c.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: iso() });
    const rated = await until(() => ops('GET', `/v1/sessions?limit=50`), (r) => !!(r.data ?? []).find((x: any) => x.ocpp_identity === ident && x.total_minor != null), 20_000, 500);
    const row = (rated.data ?? []).find((x: any) => x.ocpp_identity === ident);
    return { ident, auth, row };
  };
  const mySess = await runAt(my.data.id, 'DC', 'ID-RFID-0001');
  check('charge (MY): the operator\'s card works at its Malaysian charger', mySess.auth?.idTagInfo?.status === 'Accepted', mySess.auth);
  const myFull = mySess.row ? (await ops('GET', `/v1/sessions/${mySess.row.id}`)).data : null;
  check('charge (MY): 20 kWh × RM 1.20 = 2400 sen, no service tax, currency MYR',
    myFull?.currency === 'MYR' && Number(myFull?.total_minor) === 2400 && Number(myFull?.tax_minor) === 0 && Number(myFull?.subtotal_minor) === 2400, myFull && { c: myFull.currency, t: myFull.total_minor, x: myFull.tax_minor });
  check('charge (MY): no rupiah alias on a ringgit amount (the v1.6 total_idr is absent)', myFull && !('total_idr' in myFull) && 'total_minor' in myFull, myFull && Object.keys(myFull).filter((k) => /_idr$/.test(k)));
  check('charge (MY): the lines are in sen', (myFull?.lines ?? []).map((l: any) => l.amountMinor).join(',') === '2400', myFull?.lines);

  // An OCPI token of the eMSP charges at the Singapore site: its CDR goes to the partner in SGD.
  const UID = `MC-RFID-${stamp}`;
  const tok = await ocpi('PUT', `${ep('tokens', 'RECEIVER')}/MY/EMM/${UID}`, TOKEN_C, { country_code: 'MY', party_id: 'EMM', uid: UID, type: 'RFID',
    contract_id: `MY-EMM-C${stamp}`, issuer: 'MC eMobility', valid: true, whitelist: 'ALLOWED', last_updated: iso() });
  check('roaming: the eMSP pushes a driver token', tok.status === 200, tok.body);
  const sgSess = await runAt(sg.data.id, 'AC', UID);
  check('charge (SG): the partner\'s card is accepted at the Singapore charger', sgSess.auth?.idTagInfo?.status === 'Accepted', sgSess.auth);
  const sgFull = sgSess.row ? (await ops('GET', `/v1/sessions/${sgSess.row.id}`)).data : null;
  check('charge (SG): 20 kWh × S$0.65 incl. GST = 1300 cents, GST 107, net 1193, currency SGD',
    sgFull?.currency === 'SGD' && Number(sgFull?.total_minor) === 1300 && Number(sgFull?.tax_minor) === 107 && Number(sgFull?.subtotal_minor) === 1193,
    sgFull && { c: sgFull.currency, t: sgFull.total_minor, x: sgFull.tax_minor, s: sgFull.subtotal_minor });

  // ─────────────────────────────── OCPI pulls
  const locs = (await ocpi('GET', ep('locations', 'SENDER'), TOKEN_C)).body.data ?? [];
  const L = (id: string) => locs.find((l: any) => l.id === id);
  check('ocpi: the Malaysian location is not published under the Indonesian party (no MY party yet)', !L(my.data.id), L(my.data.id));
  check('ocpi: the Singapore location is SGP, Asia/Singapore, under the SG party', L(sg.data.id)?.country === 'SGP' && L(sg.data.id)?.time_zone === 'Asia/Singapore' && L(sg.data.id)?.country_code === 'SG', L(sg.data.id));
  const hub = (await ocpi('GET', ep('locations', 'SENDER'), TOKEN_C, undefined, { 'ocpi-to-country-code': 'SG', 'ocpi-to-party-id': 'PLS' })).body.data ?? [];
  check('ocpi: addressed to SG*PLS, only that party\'s locations come back', hub.length >= 1 && hub.every((l: any) => l.country_code === 'SG') && hub.some((l: any) => l.id === sg.data.id), hub.map((l: any) => l.country_code));
  const tariffs = (await ocpi('GET', ep('tariffs', 'SENDER'), TOKEN_C)).body.data ?? [];
  const TS = tariffs.find((t: any) => t.id === sgT.data.tariffId);
  const TM = tariffs.find((t: any) => t.id === myT.data.tariffId);
  check('ocpi: the SG tariff is SGD, 9 % VAT, published excl. GST (0.65 / 1.09)',
    TS?.currency === 'SGD' && TS?.country_code === 'SG' && TS?.elements?.[0]?.price_components?.[0]?.vat === 9 && TS?.elements?.[0]?.price_components?.[0]?.price === 0.5963, TS);
  check('ocpi: the MY tariff is not published either (its site is not shared)', !TM, TM);
  const cdrs = await until(async () => (await ocpi('GET', ep('cdrs', 'SENDER'), TOKEN_C)).body.data ?? [], (v: any[]) => v.some((c) => c.cdr_token?.uid === UID), 15_000, 500);
  const C = cdrs.find((c: any) => c.cdr_token?.uid === UID);
  check('ocpi: the SG CDR is SGD in dollars (13.00 incl., 11.93 excl. GST), SGP, under SG*PLS',
    C?.currency === 'SGD' && C?.total_cost?.incl_vat === 13 && C?.total_cost?.excl_vat === 11.93 && C?.cdr_location?.country === 'SGP' && C?.country_code === 'SG' && C?.total_energy === 20, C && { cur: C.currency, cost: C.total_cost, cc: C.country_code });
  const pushed = await until(() => got.find((g) => g.method === 'POST' && g.path === '/mc/2.2.1/cdrs' && g.body?.cdr_token?.uid === UID), (v) => !!v, 15_000, 300);
  check('ocpi: the CDR is also pushed to the eMSP in SGD', pushed?.body?.currency === 'SGD' && pushed?.body?.total_cost?.incl_vat === 13, pushed?.body?.total_cost);
  const locPush = got.find((g) => g.method === 'PUT' && g.path.startsWith('/mc/2.2.1/locations/SG/PLS/'));
  check('ocpi: the SG location is pushed under /SG/PLS/', !!locPush, got.filter((g) => g.path.includes('/locations/')).map((g) => g.path));

  // ─────────────────────────────── the site's country is now fixed
  const move = await ops('PUT', `/v1/sites/${my.data.id}`, { countryCode: 'ID', timezone: 'Asia/Jakarta' });
  check('sites: a site with sessions cannot change country (409)', move.status === 409, move.data);
  // Indonesian sessions keep their v1.6 shape: rupiah names alongside the new ones.
  const idRow = ((await ops('GET', '/v1/sessions?limit=200')).data ?? []).find((x: any) => x.total_minor != null && (x.currency ?? 'IDR') === 'IDR');
  check('compat: an IDR session still carries total_idr = total_minor (deprecated alias)', !idRow || (idRow.total_idr === idRow.total_minor), idRow && { m: idRow.total_minor, i: idRow.total_idr });
} catch (e) {
  check('no unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  for (const c of chargers) c.close();
  if (partnerId) await ops('DELETE', `/v1/roaming/partners/${partnerId}`).catch(() => {});
  await db?.end().catch(() => {});
  mock.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
