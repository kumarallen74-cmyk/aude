// PlugSure v1.3 — roaming smart charging and hubs end-to-end test:
// OCPI 2.2.1 ChargingProfiles (CPO role) and HubClientInfo.
//
// A mock eMSP registers, its driver charges on a raw OCPP 1.6 charger, and the
// eMSP limits the session, asks what is in force and lifts the limit again. A
// mock roaming hub registers, PlugSure pulls the parties behind it (two pages),
// and the hub may then act only for parties it reports as connected.
//
// Same prerequisites as ocpi-e2e.mts (API on 9200, gateway on 9220, the seeded
// operator). The mock partners listen on E2E_OCPI_MOCK_PORT (9313).
//     npx tsx tools/e2e/ocpi-profiles-e2e.mts
// NEVER point this at production.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const MOCK_PORT = Number(process.env.E2E_OCPI_MOCK_PORT ?? 9313);
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000, every = 300): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const iso = (offsetS = 0) => new Date(Date.now() + offsetS * 1000).toISOString();
const b64 = (s: string) => Buffer.from(s).toString('base64');
const RUN = Date.now().toString().slice(-6);

// ─────────────────────────────────────────── the operator console
let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
}

async function ocpi(method: string, url: string, token: string | null, body?: unknown) {
  const r = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      ...(token ? { authorization: `Token ${b64(token)}` } : {}),
      'x-request-id': randomUUID(), 'x-correlation-id': randomUUID(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, body: d };
}

// ─────────────────────────────────────────── the mock partners
interface Got { method: string; path: string; body: any; at: number }
const got: Got[] = [];
const TOKEN_SP = 'mock-sp-token-B-' + randomUUID();   // what PlugSure presents to the eMSP
const TOKEN_HUB = 'mock-hub-token-B-' + randomUUID(); // what PlugSure presents to the hub
const decode = (h?: string) => (h?.startsWith('Token ') ? Buffer.from(h.slice(6), 'base64').toString() : '');
const envelope = (data: unknown, status = 1000) => JSON.stringify({ ...(data === undefined ? {} : { data }), status_code: status, timestamp: new Date().toISOString() });
const HUB_LIST_AT = '2026-09-01T00:00:00Z';
let hubClients = [
  { country_code: 'NL', party_id: 'ABC', role: 'EMSP', status: 'CONNECTED', last_updated: HUB_LIST_AT },
  { country_code: 'NL', party_id: 'DEF', role: 'EMSP', status: 'SUSPENDED', last_updated: HUB_LIST_AT },
];

const mock = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const [path, qs] = (req.url ?? '').split('?') as [string, string | undefined];
    let body: any = null; try { body = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch {}
    got.push({ method: req.method!, path: req.url!, body, at: Date.now() });
    const send = (status: number, data: unknown, extra: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(envelope(data)); };
    const auth = decode(req.headers.authorization);
    if (path.startsWith('/sp/')) {
      if (auth !== TOKEN_SP) return send(401, undefined);
      if (path === '/sp/versions') return send(200, [{ version: '2.2.1', url: `${MOCK}/sp/2.2.1` }]);
      if (path === '/sp/2.2.1') return send(200, { version: '2.2.1', endpoints: [
        { identifier: 'credentials', role: 'RECEIVER', url: `${MOCK}/sp/2.2.1/credentials` },
        { identifier: 'sessions', role: 'RECEIVER', url: `${MOCK}/sp/2.2.1/sessions` },
        { identifier: 'chargingprofiles', role: 'SENDER', url: `${MOCK}/sp/2.2.1/chargingprofiles` },
      ] });
      return send(200, undefined);
    }
    if (path.startsWith('/hub/')) {
      if (auth !== TOKEN_HUB) return send(401, undefined);
      if (path === '/hub/versions') return send(200, [{ version: '2.2.1', url: `${MOCK}/hub/2.2.1` }]);
      if (path === '/hub/2.2.1') return send(200, { version: '2.2.1', endpoints: [
        { identifier: 'credentials', role: 'RECEIVER', url: `${MOCK}/hub/2.2.1/credentials` },
        { identifier: 'hubclientinfo', role: 'SENDER', url: `${MOCK}/hub/2.2.1/clientinfo` },
      ] });
      if (path === '/hub/2.2.1/clientinfo') {
        // One party per page, so PlugSure has to follow the Link header.
        const offset = Number(new URLSearchParams(qs ?? '').get('offset') ?? 0);
        const next = offset + 1 < hubClients.length ? { link: `<${MOCK}/hub/2.2.1/clientinfo?offset=${offset + 1}&limit=1>; rel="next"` } : {};
        return send(200, hubClients.slice(offset, offset + 1), { 'x-total-count': String(hubClients.length), 'x-limit': '1', ...next });
      }
      return send(200, undefined);
    }
    if (path.startsWith('/cp/')) return send(200, undefined); // charging profile results (response_url)
    send(404, undefined);
  });
});
await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r()));
const received = (pred: (g: Got) => boolean, after = 0) => got.find((g) => g.at >= after && pred(g));
const waitReceived = (pred: (g: Got) => boolean, after = 0, ms = 20_000) => until(() => received(pred, after), (v) => !!v, ms, 250);

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
  seen(pred: (c: { action: string; payload: any; at: number }) => boolean, ms = 15_000) { return until(() => this.calls.find(pred), (v) => !!v, ms, 200); }
  close() { try { this.ws.close(); } catch {} }
}
/** The TxProfile limit on connector 1 in a SetChargingProfile call, if it is one. */
const txLimit = (c: { action: string; payload: any }) =>
  c.action === 'SetChargingProfile' && c.payload?.connectorId === 1 && c.payload?.csChargingProfiles?.chargingProfilePurpose === 'TxProfile'
    ? Number(c.payload.csChargingProfiles.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit) : null;

const tokenFor = (uid: string, cc = 'ID', pid = 'EMS') => ({
  country_code: cc, party_id: pid, uid, type: 'RFID', contract_id: `${cc}-${pid}-C${uid.slice(-6)}`, issuer: 'E2E Smart',
  valid: true, whitelist: 'ALLOWED', last_updated: new Date().toISOString(),
});
const profile = (limit: number, over: Record<string, unknown> = {}) => ({ charging_rate_unit: 'W', charging_profile_period: [{ start_period: 0, limit }], ...over });

let charger: Raw | null = null;
const partnerIds: string[] = [];
try {
  // ─────────────────────────────────────────── setup
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  await ops('PUT', '/v1/roaming/party', { countryCode: 'ID', partyId: 'PLS', businessName: 'Nusantara Charge', website: 'https://nusantaracharge.example' });
  for (const p of (await ops('GET', '/v1/roaming')).data?.partners ?? []) {
    if (String(p.name).startsWith('E2E Smart')) await ops('DELETE', `/v1/roaming/partners/${p.id}`);
  }
  const site = await ops('POST', '/v1/sites', { name: `Smart Roaming ${RUN}`, address: 'Jl. M.H. Thamrin No. 1', city: 'Jakarta Pusat', postalCode: '10310',
    lat: '-6.1950', lon: '106.8230', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', pbjtRateBps: '1000' });
  const siteId = site.data.id as string;
  const ID = `SMART-${RUN}`;
  const reg = await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId, displayName: 'Smart DC', ocppVersion: 'ocpp1.6',
    evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  charger = new Raw(ID);
  charger.handlers.GetCompositeSchedule = (p) => ({ status: 'Accepted', connectorId: p.connectorId, scheduleStart: iso(),
    chargingSchedule: { duration: p.duration, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 11000 }, { startPeriod: 600, limit: 7000 }] } });
  await charger.connect();
  await charger.call('BootNotification', { chargePointVendor: 'SmartSim', chargePointModel: 'SS-DC-60', firmwareVersion: '1.0.0' });
  await charger.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: iso() });
  const online = await until(() => ops('GET', '/v1/charge-points'), (r) => r.data?.find?.((x: any) => x.ocpp_identity === ID)?.online === true, 15_000, 500);
  check('setup: a 197 kVA site with one 60 kW DC charger, online', site.status === 200 && reg.status === 200 && online.data?.find?.((x: any) => x.ocpp_identity === ID)?.online === true, { s: site.data, r: reg.data });

  // ─────────────────────────────────────────── the eMSP registers
  const sp = await ops('POST', '/v1/roaming/partners', { name: 'E2E Smart eMSP', kind: 'emsp' });
  partnerIds.push(sp.data.partner.id);
  const versions = await ocpi('GET', sp.data.versionsUrl, sp.data.token);
  const details = await ocpi('GET', versions.body.data[0].url, sp.data.token);
  const eps = details.body.data?.endpoints ?? [];
  const ep = (id: string, role: string) => eps.find((e: any) => e.identifier === id && e.role === role)?.url as string;
  check('endpoints: we offer chargingprofiles and hubclientinfo as RECEIVER', !!ep('chargingprofiles', 'RECEIVER') && !!ep('hubclientinfo', 'RECEIVER'), eps.map((e: any) => `${e.identifier}/${e.role}`));
  const creds = await ocpi('POST', ep('credentials', 'RECEIVER'), sp.data.token, { token: TOKEN_SP, url: `${MOCK}/sp/versions`, roles: [{ role: 'EMSP', country_code: 'ID', party_id: 'EMS' }] });
  const TOKEN_C = creds.body.data?.token as string;
  check('setup: the eMSP is registered', creds.status === 200 && !!TOKEN_C, creds.body);

  // Its driver charges.
  const UID = `SMART-RFID-${RUN}`;
  await ocpi('PUT', `${ep('tokens', 'RECEIVER')}/ID/EMS/${UID}`, TOKEN_C, tokenFor(UID));
  let mark = Date.now();
  const tx = await charger.call('StartTransaction', { connectorId: 1, idTag: UID, meterStart: 5_000_000, timestamp: iso() });
  await charger.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Charging', timestamp: iso() });
  const putActive = await waitReceived((g) => g.method === 'PUT' && g.path.startsWith('/sp/2.2.1/sessions/ID/PLS/') && g.body?.status === 'ACTIVE', mark);
  const sessionId = putActive?.body?.id as string;
  check('setup: the driver\'s session is running and the eMSP knows its id', tx.idTagInfo?.status === 'Accepted' && !!sessionId, { tx, s: putActive?.body });
  const CP = (sid = sessionId) => `${ep('chargingprofiles', 'RECEIVER')}/${sid}`;

  // ─────────────────────────────────────────── set a limit
  mark = Date.now();
  const set = await ocpi('PUT', CP(), TOKEN_C, { charging_profile: profile(11000), response_url: `${MOCK}/cp/set-1` });
  check('set: the limit is ACCEPTED with a timeout', set.status === 200 && set.body.data?.result === 'ACCEPTED' && set.body.data.timeout > 0, set.body);
  const sent11 = await charger.seen((c) => c.at >= mark && txLimit(c) === 11000);
  check('set: the charger gets an 11 kW transaction profile for this transaction (load management, stack 5)',
    !!sent11 && sent11.payload.csChargingProfiles.transactionId === tx.transactionId && sent11.payload.csChargingProfiles.stackLevel === 5 && sent11.payload.csChargingProfiles.chargingSchedule.chargingRateUnit === 'W',
    sent11?.payload ?? charger.calls.filter((c) => c.action === 'SetChargingProfile' && c.at >= mark).map((c) => c.payload));
  const setResult = await waitReceived((g) => g.path === '/cp/set-1', mark);
  check('set: the result ACCEPTED is POSTed to response_url', setResult?.body?.result === 'ACCEPTED', setResult?.body);
  const often = await ocpi('PUT', CP(), TOKEN_C, { charging_profile: profile(9000), response_url: `${MOCK}/cp/set-x` });
  check('set: another change within 5 seconds answers TOO_OFTEN', often.body.data?.result === 'TOO_OFTEN', often.body);
  const listed = await until(() => ops('GET', '/v1/roaming/charging-profiles'), (r) => (r.data ?? []).some((l: any) => l.session_id === sessionId && l.last_result === 'ACCEPTED'), 5000);
  const row = (listed.data ?? []).find((l: any) => l.session_id === sessionId);
  check('console: the limit is listed with 11 kW in force, applied', row?.limitNowW === 11000 && row.last_result === 'ACCEPTED' && row.partner_name === 'E2E Smart eMSP', row);

  // ─────────────────────────────────────────── what is in force
  mark = Date.now();
  const active = await ocpi('GET', `${CP()}?duration=900&response_url=${encodeURIComponent(`${MOCK}/cp/get-1`)}`, TOKEN_C);
  const gcs = await charger.seen((c) => c.at >= mark && c.action === 'GetCompositeSchedule');
  const activeResult = await waitReceived((g) => g.path === '/cp/get-1', mark);
  const periods = activeResult?.body?.profile?.charging_profile?.charging_profile_period;
  check('active: the charger is asked for its composite schedule (900 s, connector 1)', active.body.data?.result === 'ACCEPTED' && gcs?.payload?.duration === 900 && gcs.payload.connectorId === 1, { a: active.body, g: gcs?.payload });
  check('active: the schedule the charger reports goes to response_url as an ActiveChargingProfile',
    activeResult?.body?.result === 'ACCEPTED' && periods?.length === 2 && periods[0].limit === 11000 && periods[1].start_period === 600 && !!activeResult.body.profile.start_date_time, activeResult?.body);
  const noDur = await ocpi('GET', `${CP()}?response_url=${encodeURIComponent(`${MOCK}/cp/x`)}`, TOKEN_C);
  check('active: duration is required (400 / 2001)', noDur.status === 400 && noDur.body.status_code === 2001, noDur.body);

  // ─────────────────────────────────────────── refusals
  const badUnit = await ocpi('PUT', CP(), TOKEN_C, { charging_profile: profile(1000, { charging_rate_unit: 'kW' }), response_url: `${MOCK}/cp/x` });
  check('refuse: a malformed profile is refused with the reason (400 / 2001)', badUnit.status === 400 && badUnit.body.status_code === 2001 && /W or A/.test(badUnit.body.status_message), badUnit.body);
  const noUrl = await ocpi('PUT', CP(), TOKEN_C, { charging_profile: profile(1000) });
  check('refuse: response_url is required', noUrl.status === 400 && /response_url/.test(noUrl.body.status_message), noUrl.body);
  const unknown = await ocpi('PUT', CP(randomUUID()), TOKEN_C, { charging_profile: profile(1000), response_url: `${MOCK}/cp/x` });
  check('refuse: an unknown session answers UNKNOWN_SESSION', unknown.body.data?.result === 'UNKNOWN_SESSION', unknown.body);

  // ─────────────────────────────────────────── a limit above what the site allows
  await sleep(5200);
  mark = Date.now();
  const high = await ocpi('PUT', CP(), TOKEN_C, { charging_profile: profile(150000), response_url: `${MOCK}/cp/set-2` });
  const sentHigh = await charger.seen((c) => c.at >= mark && txLimit(c) != null);
  check('cap: a limit above the charger (150 kW) does not raise the session: it gets its 60 kW nameplate', high.body.data?.result === 'ACCEPTED' && txLimit(sentHigh!) === 60000, sentHigh?.payload);

  // ─────────────────────────────────────────── a schedule that steps down (relative to charging start)
  await sleep(5200);
  mark = Date.now();
  await ocpi('PUT', CP(), TOKEN_C, { charging_profile: { charging_rate_unit: 'W', start_date_time: iso(-3600), charging_profile_period: [{ start_period: 0, limit: 30000 }, { start_period: 1800, limit: 7400 }] }, response_url: `${MOCK}/cp/set-3` });
  const sentStep = await charger.seen((c) => c.at >= mark && txLimit(c) != null);
  check('schedule: an hour into a schedule that steps down after 30 minutes, the later step (7.4 kW) applies', txLimit(sentStep!) === 7400, sentStep?.payload);

  // ─────────────────────────────────────────── lift the limit
  mark = Date.now();
  const clear = await ocpi('DELETE', `${CP()}?response_url=${encodeURIComponent(`${MOCK}/cp/clear-1`)}`, TOKEN_C);
  const sentFree = await charger.seen((c) => c.at >= mark && txLimit(c) === 60000);
  const clearResult = await waitReceived((g) => g.path === '/cp/clear-1', mark);
  check('clear: lifting the limit returns the session to its full share (60 kW) and reports ACCEPTED', clear.body.data?.result === 'ACCEPTED' && !!sentFree && clearResult?.body?.result === 'ACCEPTED', { c: clear.body, r: clearResult?.body });
  const afterClear = await ops('GET', '/v1/roaming/charging-profiles');
  check('console: the lifted limit is no longer listed', !(afterClear.data ?? []).some((l: any) => l.session_id === sessionId), afterClear.data);
  mark = Date.now();
  await ocpi('DELETE', `${CP()}?response_url=${encodeURIComponent(`${MOCK}/cp/clear-2`)}`, TOKEN_C);
  const clear2 = await waitReceived((g) => g.path === '/cp/clear-2', mark);
  check('clear: lifting it again reports UNKNOWN (no profile matched)', clear2?.body?.result === 'UNKNOWN', clear2?.body);

  // ─────────────────────────────────────────── the hub
  const hub = await ops('POST', '/v1/roaming/partners', { name: 'E2E Smart Hub', kind: 'hub' });
  partnerIds.push(hub.data.partner.id);
  const hubCreds = await ocpi('POST', ep('credentials', 'RECEIVER'), hub.data.token, { token: TOKEN_HUB, url: `${MOCK}/hub/versions`, roles: [{ role: 'HUB', country_code: 'NL', party_id: 'HUB' }] });
  const TOKEN_H = hubCreds.body.data?.token as string;
  check('hub: the hub registers', hubCreds.status === 200 && !!TOKEN_H, hubCreds.body);
  const pulled = await until(() => ops('GET', `/v1/roaming/partners/${hub.data.partner.id}/hub-clients`), (r) => (r.data ?? []).length === 2, 15_000, 500);
  const byParty = (rows: any[], pid: string) => rows.find((c) => c.party_id === pid);
  check('hub: after registering, PlugSure pulls the parties behind it, following the Link header (2 pages)',
    byParty(pulled.data ?? [], 'ABC')?.status === 'CONNECTED' && byParty(pulled.data ?? [], 'DEF')?.status === 'SUSPENDED' && got.filter((g) => g.path.startsWith('/hub/2.2.1/clientinfo')).length >= 2, pulled.data);
  const tok = (cc: string, pid: string, uid: string) => ocpi('PUT', `${ep('tokens', 'RECEIVER')}/${cc}/${pid}/${uid}`, TOKEN_H, tokenFor(uid, cc, pid));
  const tAbc = await tok('NL', 'ABC', `HUB-A-${RUN}`);
  const tDef = await tok('NL', 'DEF', `HUB-D-${RUN}`);
  const tXyz = await tok('NL', 'XYZ', `HUB-X-${RUN}`);
  check('hub: it may push tokens for a connected party behind it, not for a suspended or an unknown one', tAbc.status === 200 && tDef.status === 403 && tXyz.status === 403, { abc: tAbc.status, def: tDef.body, xyz: tXyz.status });
  const HI = (cc: string, pid: string) => `${ep('hubclientinfo', 'RECEIVER')}/${cc}/${pid}`;
  const pushNow = iso();
  const up = await ocpi('PUT', HI('NL', 'DEF'), TOKEN_H, { country_code: 'NL', party_id: 'DEF', role: 'EMSP', status: 'CONNECTED', last_updated: pushNow });
  const tDef2 = await tok('NL', 'DEF', `HUB-D2-${RUN}`);
  check('hub: the hub pushes that DEF is connected again; its tokens are then accepted', up.status === 200 && tDef2.status === 200, { up: up.body, t: tDef2.body });
  const read = await ocpi('GET', HI('NL', 'DEF'), TOKEN_H);
  check('hub: GET returns the ClientInfo as last reported', read.body.data?.status === 'CONNECTED' && read.body.data.role === 'EMSP' && read.body.data.party_id === 'DEF', read.body);
  await ocpi('PUT', HI('NL', 'DEF'), TOKEN_H, { country_code: 'NL', party_id: 'DEF', role: 'EMSP', status: 'SUSPENDED', last_updated: iso(-3600) });
  const stale = await ocpi('GET', HI('NL', 'DEF'), TOKEN_H);
  check('hub: an update older than the one we hold is ignored', stale.body.data?.status === 'CONNECTED', stale.body);
  const mismatch = await ocpi('PUT', HI('NL', 'DEF'), TOKEN_H, { country_code: 'NL', party_id: 'ABC', role: 'EMSP', status: 'OFFLINE', last_updated: iso() });
  check('hub: a body that does not match the URL is refused (400)', mismatch.status === 400 && /match the URL/.test(mismatch.body.status_message), mismatch.body);
  const notHub = await ocpi('PUT', HI('NL', 'ABC'), TOKEN_C, { country_code: 'NL', party_id: 'ABC', role: 'EMSP', status: 'OFFLINE', last_updated: iso() });
  check('hub: a partner that is not a hub cannot send client info (403)', notHub.status === 403, notHub.body);
  const hubProfile = await ocpi('PUT', CP(), TOKEN_H, { charging_profile: profile(5000), response_url: `${MOCK}/cp/x` });
  check('hub: a partner cannot limit another partner\'s session (UNKNOWN_SESSION)', hubProfile.body.data?.result === 'UNKNOWN_SESSION', hubProfile.body);

  // A fresh pull: ABC has left the hub; DEF's newer push survives the older list.
  hubClients = hubClients.filter((c) => c.party_id !== 'ABC');
  const refresh = await ops('POST', `/v1/roaming/partners/${hub.data.partner.id}/hub-clients/refresh`);
  const afterPull = await ops('GET', `/v1/roaming/partners/${hub.data.partner.id}/hub-clients`);
  check('hub: refreshing forgets a party the hub no longer lists and keeps the newer status of another',
    refresh.status === 200 && refresh.data.clients === 1 && (afterPull.data ?? []).length === 1 && byParty(afterPull.data, 'DEF')?.status === 'CONNECTED', { r: refresh.data, a: afterPull.data });
  const tAbc2 = await tok('NL', 'ABC', `HUB-A2-${RUN}`);
  check('hub: tokens for the party that left are refused', tAbc2.status === 403, tAbc2.body);
  const spRefresh = await ops('POST', `/v1/roaming/partners/${sp.data.partner.id}/hub-clients/refresh`);
  check('console: refreshing a partner that is not a hub is refused (409)', spRefresh.status === 409, spRefresh.data);
  const overview = await ops('GET', '/v1/roaming');
  check('console: the partner list counts the parties behind the hub', (overview.data?.partners ?? []).find((p: any) => p.id === hub.data.partner.id)?.hub_clients === 1);

  // ─────────────────────────────────────────── the session ends
  await charger.call('StopTransaction', { transactionId: tx.transactionId, meterStop: 5_004_000, timestamp: iso(), reason: 'EVDisconnected' });
  await charger.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: iso() });
  await sleep(5200);
  const ended = await ocpi('PUT', CP(), TOKEN_C, { charging_profile: profile(5000), response_url: `${MOCK}/cp/x` });
  check('end: once the session has ended, a limit answers UNKNOWN_SESSION', ended.body.data?.result === 'UNKNOWN_SESSION', ended.body);
  const pushes = await ops('GET', `/v1/roaming/partners/${sp.data.partner.id}/pushes`);
  check('outbox: every charging-profile result was delivered', (pushes.data ?? []).filter((p: any) => p.module === 'chargingprofiles').length >= 5 && !(pushes.data ?? []).some((p: any) => p.state === 'failed'), (pushes.data ?? []).filter((p: any) => p.module === 'chargingprofiles').map((p: any) => p.state));
} catch (e) {
  check('no unexpected exception', false, (e as Error).stack);
} finally {
  for (const id of partnerIds) await ops('DELETE', `/v1/roaming/partners/${id}`).catch(() => null);
  charger?.close();
  mock.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
