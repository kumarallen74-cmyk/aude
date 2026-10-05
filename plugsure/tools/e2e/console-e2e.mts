// PlugSure v1.3 — end-to-end acceptance test (SPEC-UI-CSMS-2026-FINAL).
//
// Drives the REAL API + gateway over HTTP and OCPP: onboarding, cockpit,
// config studio, RFID + SendLocalList, DLM guardrail and curtailment, tariffs,
// sessions + tax receipt, FOTA to "Verified", diagnostics upload, OCPP 2.0.1
// command translation, and RBAC (Site Host scoping, technician test-only).
//
// Prerequisites: a migrated + seeded database, the stack running with
// OCPP_MIN_SECURITY_PROFILE=0, OCPP_AUTO_ADOPT=false, OCPP_VERSIONS=ocpp1.6,ocpp2.0.1,
// PUBLIC_BASE_URL=http://127.0.0.1:9200, and the seed run with
// SEED_ADMIN_PASSWORD (default expected: Console-Test-2026!). Then:
//
//     npx tsx tools/e2e/console-e2e.mts        (E2E_API / E2E_OCPP / E2E_PASSWORD override)
//
// NEVER point this at production: it creates sites, chargers, users and sessions.
// In all-in-one mode the "bridge feature reported engaged" check fails by design.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import WebSocket from 'ws';
// The authenticator app, for the two-step verification checks (pure RFC 6238, no database).
import { base32Decode, hotp, timeStep } from '../../src/services/totp.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const ROOT = join(import.meta.dirname, '..', '..');
const results: Array<{ ok: boolean; name: string; detail: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name, detail: typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 300) ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000, every = 500): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}

// ------------------------------------------------------------------ HTTP client with a cookie jar
class Client {
  cookie = '';
  async req(method: string, path: string, body?: unknown, opts: { csrf?: boolean; raw?: boolean; headers?: Record<string, string>; bin?: Buffer } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (opts.csrf !== false) headers['x-plugsure-csrf'] = '1';
    let payload: any;
    if (opts.bin) { payload = opts.bin; headers['content-type'] = 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const res = await fetch(API + path, { method, headers, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0]!;
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* html / csv */ }
    return { status: res.status, data, text, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  del = (p: string) => this.req('DELETE', p);
}

// ------------------------------------------------------------------ minimal raw OCPP-J charger
class RawCharger {
  ws!: WebSocket;
  calls: Array<{ action: string; payload: any }> = [];
  handlers: Record<string, (p: any) => any> = {};
  pending = new Map<string, (v: any) => void>();
  n = 0;
  constructor(public id: string, public version: 'ocpp1.6' | 'ocpp2.0.1', public password?: string) {}
  async connect() {
    const headers: Record<string, string> = {};
    if (this.password) headers.authorization = 'Basic ' + Buffer.from(`${this.id}:${this.password}`).toString('base64');
    this.ws = new WebSocket(`${OCPP}/${this.id}`, [this.version], { headers });
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); this.ws.once('unexpected-response', (_q: any, r: any) => rej(new Error(`HTTP ${r.statusCode}`))); });
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f[0] === 2) {
        const [, uid, action, payload] = f;
        this.calls.push({ action, payload });
        const h = this.handlers[action];
        const reply = h ? h(payload) : { status: 'Accepted' };
        this.ws.send(JSON.stringify([3, uid, reply ?? {}]));
      } else if (f[0] === 3 || f[0] === 4) {
        this.pending.get(f[1])?.(f[0] === 3 ? f[2] : { __error: f[2], desc: f[3] });
        this.pending.delete(f[1]);
      }
    });
  }
  call(action: string, payload: unknown): Promise<any> {
    const uid = `${this.id}-${++this.n}`;
    return new Promise((res) => { this.pending.set(uid, res); this.ws.send(JSON.stringify([2, uid, action, payload])); });
  }
  waitFor(action: string, ms = 15_000) {
    return until(async () => this.calls.find((c) => c.action === action), (v) => !!v, ms, 200);
  }
  close() { try { this.ws.close(); } catch {} }
}

function sim(args: string[]): ChildProcess {
  const cli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const p = spawn(process.execPath, [cli, 'tools/simulator/autel-sim.ts', '--url', OCPP, '--api', API, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.on('data', () => {}); p.stderr!.on('data', () => {});
  return p;
}

// ================================================================== the run
const ops = new Client();
const children: ChildProcess[] = [];
try {
  // ---------------------------------------------------------------- 10 · auth
  const bad = await ops.post('/v1/auth/login', { email: 'ops@plugsure.com', password: 'wrong' });
  check('auth: wrong password is refused (401)', bad.status === 401, bad);
  const noAuth = await new Client().get('/v1/sites');
  check('auth: /v1 without a session is 401', noAuth.status === 401, noAuth.status);
  const login = await ops.post('/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('auth: operator signs in, HttpOnly cookie set', login.status === 200 && /ps_session=pss_/.test(ops.cookie), login);
  const me = await ops.get('/v1/auth/me');
  check('auth: /me returns Super Administrator with console permissions', me.status === 200 && me.data.roles?.[0]?.name === 'super_admin' && me.data.permissions.includes('charge_point:config'), me.data.roles);
  check('auth: bridge feature reported engaged', me.data.features?.bridge === true, me.data.features);
  const csrf = await ops.req('POST', '/v1/sites', { name: 'x' }, { csrf: false });
  check('auth: cookie write without CSRF header is refused (403)', csrf.status === 403, csrf);
  const meta = await ops.get('/v1/meta');
  // The five roles of the spec's permission matrix, plus the Site Owner and Fleet customer portal roles.
  const roleNames = (meta.data?.consoleRoles ?? []).map((r: any) => r.name).sort().join();
  check('meta: reference data served', meta.status === 200 && roleNames === 'cpo_operations_manager,field_technician,financial_auditor,fleet_customer,site_host_landlord,site_owner,super_admin', roleNames);

  // ---------------------------------------------------------------- 3 · sites
  const badSite = await ops.post('/v1/sites', { name: 'Bad', spkluId: '01.XXXX.20.3171.011', powerFactor: 1.4 });
  check('sites: invalid SPKLU ID / PF refused with field errors (422)', badSite.status === 422 && badSite.data.errors?.spkluId && badSite.data.errors?.powerFactor, badSite.data);
  const site = await ops.post('/v1/sites', {
    name: 'Star Charger Hub — Thamrin (E2E)', address: 'Jl. M.H. Thamrin 1', postalCode: '10310', kabupatenKotaCode: '3171',
    lat: '-6.1935', lon: '106.823', gridTariffGroup: 'L/TM', connectedKva: '250', powerFactor: '0.95', phases: '3',
    spkluId: '01.POSO.20.3171.011', spkluScheme: 'POSO', localTaxRateBps: '1000', sloNumber: 'SLO/E2E/1', sloIssuer: 'PT LIT', sloIssuedAt: '2026-01-01', sloExpiresAt: '2030-01-01',
  });
  check('sites: create site (250 kVA, TM cliff warning returned)', site.status === 200 && site.data.warnings?.length === 1, site.data);
  const siteId = site.data.id as string;
  const sites = await ops.get('/v1/sites');
  const s = sites.data.find((x: any) => x.id === siteId);
  check('sites: hub table shows computed ceiling 237.5 kW and rekening 10,000 kWh', s?.computed?.activePowerCeilingKw === 237.5 && s?.computed?.rekeningMinimumKwhPerMonth === 10000, s?.computed);
  const upd = await ops.put(`/v1/sites/${siteId}`, { address: 'Jl. M.H. Thamrin No. 1' });
  check('sites: partial update', upd.status === 200, upd.data);

  // ---------------------------------------------------------------- 4 · DLM guardrail (acceptance 2)
  const over = await ops.put(`/v1/sites/${siteId}/power/budget`, { ceilingW: 240000 });
  check('DLM: ceiling 240 kW above 250 kVA × 0.95 refused (422) with the spec message',
    over.status === 422 && /Exceeds 250 kVA PLN contract limit\. Clamped to prevent breaker trip\./.test(over.data.error) && over.data.maxW === 237500, over.data);
  const okB = await ops.put(`/v1/sites/${siteId}/power/budget`, { ceilingW: 237500, strategy: 'priority', reserveBreakdown: { lighting: 2500, pos: 1000, cctv: 1000, hvac: 3000 } });
  check('DLM: 237.5 kW with reserve breakdown accepted; reserve = 7.5 kW', okB.status === 200 && okB.data.ceilingW === 237500 && okB.data.reserveW === 7500, okB.data);

  // ---------------------------------------------------------------- 1 · onboarding (acceptance 1)
  const ID = `E2E-HY-${Date.now().toString().slice(-6)}`;
  const reg = await ops.post('/v1/charge-points', {
    ocppIdentity: ID, siteId, displayName: 'Thamrin Gun E2E', vendor: 'Autel', model: 'MaxiCharger DC Compact', serial: ID, ocppVersion: 'ocpp1.6',
    evses: [1, 2].map((e) => ({ evseId: e, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, ratedVoltageV: 1000, ratedCurrentA: 200, accuracyClass: '1.0', teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] })),
  });
  check('onboard: register charger with 2-EVSE topology', reg.status === 200 && reg.data.status === 'pending_adoption', reg.data);
  const badTopo = await ops.post('/v1/charge-points', { ocppIdentity: ID + 'X', siteId, evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'sType2', currentKind: 'DC', maxPowerW: 60000 }] }] });
  check('onboard: plug/current mismatch refused (422)', badTopo.status === 422, badTopo.data);
  const key = await ops.post(`/v1/charge-points/${ID}/keys`, { profile: 1, rotationDays: 90 });
  check('onboard: key issued with commissioning JSON + QR', key.status === 200 && /^[0-9a-f]{40}$/.test(key.data.key) && key.data.commissioning?.qrDataUrl?.startsWith('data:image/png'), { status: key.status });
  const early = await ops.put(`/v1/charge-points/${ID}/security-profile`, { profile: 3 });
  check('onboard: profile 3 refused before a certificate is bound (409)', early.status === 409, early.data);
  const prof = await ops.put(`/v1/charge-points/${ID}/security-profile`, { profile: 1 });
  check('onboard: security profile 1 enforced (key first, then profile)', prof.status === 200, prof.data);
  const act = await ops.post(`/v1/charge-points/${ID}/activate`);
  check('onboard: activate', act.status === 200 && act.data.activated === true, act.data);

  const simProc = sim(['--id', ID, '--auth-key', key.data.key, '--connectors', '2', '--dc', '--vendor', 'Autel', '--model', 'MaxiCharger DC Compact', '--kwh', '2', '--speed', '120', '--meter-interval', '5']);
  children.push(simProc);
  const comm = await until(() => ops.get(`/v1/charge-points/${ID}/commissioning`), (r) => r.data?.adopted === true, 40_000, 1000);
  check('onboard: listener reports "Hardware Connected & Adopted" (through the API↔gateway bridge)', comm.data?.adopted === true && comm.data.headline === 'Hardware Connected & Adopted', comm.data);

  const wrong = await new Promise<number>((res) => {
    const ws = new WebSocket(`${OCPP}/${ID}`, ['ocpp1.6'], { headers: { authorization: 'Basic ' + Buffer.from(`${ID}:wrongwrongwrong1`).toString('base64') } });
    ws.on('unexpected-response', (_q: any, r: any) => res(r.statusCode)); ws.on('open', () => { res(101); ws.close(); }); ws.on('error', () => res(-1));
  });
  check('security: wrong key refused at the handshake', wrong === 401 || wrong === 403, wrong);

  const fleet = await until(() => ops.get('/v1/charge-points'), (r) => r.data.find((c: any) => c.ocpp_identity === ID)?.connectors?.length === 2, 15_000);
  const cp = fleet.data.find((c: any) => c.ocpp_identity === ID);
  check('fleet: charger online via bridge, 2 connectors, negotiated ocpp1.6', cp?.online === true && cp.negotiatedVersion === 'ocpp1.6', { online: cp?.online, v: cp?.negotiatedVersion });

  // ---------------------------------------------------------------- 6 · configuration studio
  const cfg = await ops.get(`/v1/charge-points/${ID}/config`);
  check('config: live GetConfiguration via bridge', cfg.status === 200 && cfg.data.live === true && cfg.data.keys.some((k: any) => k.key === 'HeartbeatInterval' && k.reported), { live: cfg.data.live, err: cfg.data.error });
  const cset = await ops.put(`/v1/charge-points/${ID}/config`, { key: 'MeterValueSampleInterval', value: '30' });
  check('config: ChangeConfiguration accepted', cset.status === 200 && cset.data.status === 'Accepted', cset.data);
  const cbad = await ops.put(`/v1/charge-points/${ID}/config`, { key: 'HeartbeatInterval', value: 'fast' });
  check('config: non-integer value refused before sending', cbad.status === 400, cbad.data);
  const csec = await ops.put(`/v1/charge-points/${ID}/config`, { key: 'AuthorizationKey', value: 'abc' });
  check('config: AuthorizationKey blocked in the studio', csec.status === 400, csec.data);

  // ---------------------------------------------------------------- 7 · RFID
  const UID = Date.now().toString(16).slice(-12);
  const tok = await ops.post('/v1/tokens', { uid: UID.toLowerCase(), holderName: 'E2E Driver', holderPhone: '+62 812 1111', accountType: 'retail', energyLimitKwh: 100 });
  check('rfid: issue card (hex upper-cased)', tok.status === 200 && tok.data.uid === UID.toUpperCase(), tok.data);
  const dup = await ops.post('/v1/tokens', { uid: UID.toUpperCase() });
  check('rfid: duplicate card refused (409)', dup.status === 409, dup.status);
  const blk = await ops.put(`/v1/tokens/${tok.data.id}`, { status: 'Blocked' });
  check('rfid: block card', blk.status === 200, blk.data);
  const sync = await ops.post(`/v1/charge-points/${ID}/local-list/sync`);
  check('rfid: SendLocalList pushed to charger', sync.status === 200 && sync.data.ok === true && sync.data.count > 0, sync.data);
  const siteSync = await ops.post(`/v1/sites/${siteId}/local-list/sync`);
  check('rfid: site-wide push', siteSync.status === 200 && siteSync.data.results?.[0]?.ok === true, siteSync.data);

  // ---------------------------------------------------------------- 2 · cockpit
  const t0 = Date.now();
  const unl = await ops.post(`/v1/charge-points/${ID}/unlock`, { connectorId: 2 });
  const unlockMs = Date.now() - t0;
  check(`cockpit: UnlockConnector round trip ${unlockMs} ms (< 3000 ms)`, unl.status === 200 && unl.data.status === 'Unlocked' && unlockMs < 3000, unl.data);
  const avNo = await ops.post(`/v1/charge-points/${ID}/availability`, { connectorId: 2, type: 'Inoperative' });
  check('cockpit: Inoperative without a reason refused', avNo.status === 400, avNo.data);
  const av = await ops.post(`/v1/charge-points/${ID}/availability`, { connectorId: 2, type: 'Inoperative', reason: 'E2E: cable jacket damaged' });
  check('cockpit: Inoperative with reason', av.status === 200 && av.data.status === 'Accepted', av.data);
  const av2 = await ops.post(`/v1/charge-points/${ID}/availability`, { connectorId: 2, type: 'Operative' });
  check('cockpit: back to Operative', av2.status === 200, av2.data);
  const trig = await ops.post(`/v1/charge-points/${ID}/trigger`, { requestedMessage: 'StatusNotification', connectorId: 1 });
  check('cockpit: TriggerMessage', trig.status === 200 && trig.data.status === 'Accepted', trig.data);
  const cc = await ops.post(`/v1/charge-points/${ID}/clear-cache`);
  check('cockpit: ClearCache', cc.status === 200, cc.data);

  // Blocked card cannot start; active card with a 1 kWh preset can.
  const startBlocked = await ops.post(`/v1/charge-points/${ID}/remote-start`, { connectorId: 1, idTag: 'ID-RFID-BLOCKED' });
  check('cockpit: remote start is sent (charger decides on blocked card)', startBlocked.status === 200, startBlocked.data);
  await sleep(3000);
  const start = await ops.post(`/v1/charge-points/${ID}/remote-start`, { connectorId: 1, idTag: 'ID-RFID-0001', limitType: 'energy', limitValue: '1' });
  check('cockpit: remote start with 1 kWh preset accepted', start.status === 200 && start.data.status === 'Accepted' && start.data.limit?.energyLimitWh === 1000, start.data);
  const running = await until(() => ops.get('/v1/charge-points'), (r) => !!r.data.find((c: any) => c.ocpp_identity === ID)?.connectors?.find((k: any) => k.sessionId), 30_000, 1000);
  const conn1 = running.data.find((c: any) => c.ocpp_identity === ID)?.connectors?.find((k: any) => k.sessionId);
  check('cockpit: session visible live on the fleet table', !!conn1, conn1);

  // The simulator delivers ~2 kWh; the operator limit must stop it at ~1 kWh.
  const sessId = conn1?.sessionId;
  const ended = await until(() => ops.get(`/v1/sessions/${sessId}`), (r) => r.data?.state && r.data.state !== 'active', 90_000, 1500);
  check('cockpit: session ended by the platform at the energy preset', ended.data?.state !== 'active' && ended.data?.energy_wh >= 900 && ended.data?.energy_wh < 1900, { state: ended.data?.state, energy: ended.data?.energy_wh, reason: ended.data?.stop_reason });

  // ---------------------------------------------------------------- 8 · sessions, receipt (acceptance 4)
  const rated = await until(() => ops.get(`/v1/sessions/${sessId}`), (r) => r.data?.total_minor != null, 30_000, 1000);
  check('billing: session rated into a CDR', rated.data?.total_minor > 0, { total: rated.data?.total_minor, review: rated.data?.review_reason });
  const rcpt = await ops.get(`/v1/sessions/${sessId}/receipt`);
  check('billing: receipt shows DPP, PPN and PBJT-TL', rcpt.status === 200 && /DPP nilai lain/.test(rcpt.text) && /PPN 12% × DPP \(efektif 11%/.test(rcpt.text) && /PBJT-TL/.test(rcpt.text), rcpt.status);
  const search = await ops.get(`/v1/sessions/search?identity=${ID}`);
  const row = search.data.rows?.[0];
  check('sessions: explorer row with meter start/end and tax breakdown', row && row.meter_stop_wh != null && row.breakdown?.taxMinor > 0 && row.breakdown?.localTaxMinor > 0, row?.breakdown);
  const badF = await ops.get('/v1/sessions/search?from=notadate');
  check('sessions: invalid filter is a 400 not a 500', badF.status === 400, badF.status);
  const csv = await ops.get(`/v1/sessions.csv?identity=${ID}`);
  // v1.5 (legacy) column names while every site of the org is in Indonesia; the v1.7 *_minor + currency columns once
  // it has a site abroad (multi-country-e2e adds MY/SG sites to the seed org, so the suite order must not matter).
  const meCountries: Array<{ country_code: string }> = (await ops.get('/v1/auth/me')).data?.org?.countries ?? [];
  const abroad = meCountries.some((c) => c.country_code !== 'ID');
  const csvHead = csv.text.split(/\r?\n/)[0] ?? '';
  check('sessions: CSV export', csv.status === 200 && csv.text.includes(sessId)
    && (abroad ? csvHead.endsWith('gross_total_minor,currency') : csvHead.endsWith(',gross_total_idr')), { status: csv.status, abroad, csvHead }); // legacy v1.5 header for an Indonesia-only operator

  // ---------------------------------------------------------------- 5 · tariffs
  const illegal = await ops.post('/v1/tariffs', { name: 'Illegal peak', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'tou', appliesToMaxPowerW: 60000,
    components: [{ kind: 'energy', rate: 2850, touBlock: 'WBP' }, { kind: 'energy', rate: 2466, touBlock: 'LWBP' }] });
  check('tariffs: Rp 2,850 peak rate refused (above Rp 2,467.50 ceiling)', illegal.status === 422 && illegal.data.flags?.some((f: any) => f.code === 'ENERGY_CEILING_EXCEEDED'), illegal.data.flags?.map((f: any) => f.code));
  const sur = await ops.post('/v1/tariffs', { name: 'x', mdrMode: 'surcharge', components: [] });
  check('tariffs: MDR surcharge refused', sur.status === 422, sur.status);
  const legal = await ops.post('/v1/tariffs', { name: 'Public DC Ultra-Fast 2026 (E2E)', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'tou', appliesToMaxPowerW: 60000, ppnApplies: true,
    components: [{ kind: 'energy', rate: 2467.5, touBlock: 'WBP' }, { kind: 'energy', rate: 2400, touBlock: 'LWBP' }, { kind: 'session', rate: 25000, touBlock: 'ANY' }, { kind: 'idle', rate: 1000, touBlock: 'ANY', fromMinutes: 15, toMinutes: 75 }] });
  check('tariffs: legal ToU plan saved', legal.status === 200 && legal.data.ok === true, legal.data);
  const assign = await ops.put(`/v1/sites/${siteId}/tariff`, { tariffId: legal.data.tariffId, currentType: 'DC' });
  check('tariffs: assigned to the site for DC connectors', assign.status === 200, assign.data);
  const tl = await ops.get('/v1/tariffs');
  const tr = tl.data.find((t: any) => t.id === legal.data.tariffId);
  check('tariffs: master list shows assignment and status', tr?.assignments?.[0]?.currentType === 'DC' && tr.status === 'active', tr?.assignments);
  const arch = await ops.post(`/v1/tariffs/${legal.data.tariffId}/archive`);
  check('tariffs: archive', arch.status === 200, arch.data);

  // ---------------------------------------------------------------- 4 · curtailment + priorities
  const pw = await ops.get(`/v1/sites/${siteId}/power`);
  check('DLM: power view returns plan with connector uuids', pw.status === 200 && pw.data.plan.length === 2 && pw.data.subscriptionCeilingW === 237500, { n: pw.data.plan?.length });
  const pri = await ops.put(`/v1/sites/${siteId}/power/priorities`, { priorities: pw.data.plan.map((p: any, i: number) => ({ connectorUuid: p.connectorUuid, priority: 10 - i })) });
  check('DLM: priorities saved', pri.status === 200, pri.data);
  const cur = await ops.post(`/v1/sites/${siteId}/power/curtail`, { curtailed: true, reason: 'E2E genset' });
  check('DLM: genset curtailment accepted', cur.status === 200 && cur.data.curtailed === true, cur.data);
  const zero = await until(() => ops.get(`/v1/sites/${siteId}/power`), (r) => r.data.budget.curtailed === true, 10_000);
  check('DLM: site now curtailed, usable 0 W', zero.data.budget.curtailed === true && zero.data.usableW === 0, zero.data.usableW);
  const unc = await ops.post(`/v1/sites/${siteId}/power/curtail`, { curtailed: false });
  check('DLM: curtailment lifted', unc.status === 200, unc.data);

  // ---------------------------------------------------------------- 2.0.1 translation (raw charger)
  const ID2 = `E2E-201-${Date.now().toString().slice(-6)}`;
  await ops.post('/v1/charge-points', { ocppIdentity: ID2, siteId, ocppVersion: 'ocpp2.0.1', evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 120000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
  await ops.post(`/v1/charge-points/${ID2}/activate`);
  const c201 = new RawCharger(ID2, 'ocpp2.0.1');
  await c201.connect();
  const boot201 = await c201.call('BootNotification', { reason: 'PowerUp', chargingStation: { model: 'MaxiCharger AC Wallbox', vendorName: 'Autel', firmwareVersion: '1.0.5' } });
  check('2.0.1: boot with a 22-char model accepted (tolerated deviation)', boot201.status === 'Accepted', boot201);
  await c201.call('StatusNotification', { timestamp: new Date().toISOString(), connectorStatus: 'Available', evseId: 1, connectorId: 1 });
  // "Scan from live charger": an unregistered card tapped at the reader is offered for issuing.
  const SCAN_TAG = `E2ESCAN${Date.now().toString(16).slice(-8).toUpperCase()}`;
  const auth201 = await c201.call('Authorize', { idToken: { idToken: SCAN_TAG, type: 'ISO14443' } });
  const scanned = await until(() => ops.get(`/v1/tokens/unknown?identity=${ID2}`), (r) => (r.data ?? []).some((t: any) => t.id_tag === SCAN_TAG), 10_000, 300);
  check('rfid: scan from live charger offers the unregistered card just tapped', auth201?.idTokenInfo?.status !== 'Accepted' && (scanned.data ?? []).some((t: any) => t.id_tag === SCAN_TAG && t.ocpp_identity === ID2), { auth: auth201, scanned: scanned.data });
  await sleep(4000);
  c201.handlers.RequestStartTransaction = () => ({ status: 'Accepted' });
  const rs201 = await ops.post(`/v1/charge-points/${ID2}/remote-start`, { connectorId: 1, idTag: 'ID-RFID-0001' });
  const got = await c201.waitFor('RequestStartTransaction');
  check('2.0.1: console remote start arrives as RequestStartTransaction', rs201.status === 200 && got?.payload?.idToken?.idToken === 'ID-RFID-0001' && got.payload.evseId === 1, { rs: rs201.data, got });
  c201.handlers.UnlockConnector = () => ({ status: 'Unlocked' });
  const u201 = await ops.post(`/v1/charge-points/${ID2}/unlock`, { connectorId: 1 });
  const gotU = await c201.waitFor('UnlockConnector');
  check('2.0.1: unlock arrives as {evseId, connectorId}', u201.data.status === 'Unlocked' && gotU?.payload?.evseId === 1 && gotU.payload.connectorId === 1, gotU?.payload);
  c201.handlers.GetVariables = (p) => ({ getVariableResult: p.getVariableData.map((d: any) => ({ attributeStatus: 'Accepted', attributeValue: '300', component: d.component, variable: d.variable })) });
  const cfg201 = await ops.get(`/v1/charge-points/${ID2}/config`);
  check('2.0.1: config studio reads via GetVariables', cfg201.data.live === true && cfg201.data.keys.some((k: any) => k.key === 'HeartbeatInterval' && k.value === '300'), { live: cfg201.data.live, err: cfg201.data.error });

  // ---------------------------------------------------------------- 9 · FOTA (driven by the raw 2.0.1 charger)
  const fwBin = Buffer.from('PLUGSURE-FIRMWARE-E2E-' + 'x'.repeat(4096));
  const up = await ops.req('POST', `/v1/firmware/images/upload?name=E2E%20image&version=1.0.7&vendor=Autel&compatibleModels=MaxiCharger&fileName=fw-1.0.7.bin`, undefined, { bin: fwBin });
  check('FOTA: binary upload stored with SHA-256', up.status === 200 && /^[0-9a-f]{64}$/.test(up.data.sha256) && up.data.size === fwBin.length, up.data);
  const badSum = await ops.req('POST', `/v1/firmware/images/upload?name=x&version=1&sha256=${'0'.repeat(64)}`, undefined, { bin: fwBin });
  check('FOTA: checksum mismatch refused', badSum.status === 400 && /mismatch/.test(badSum.data.error), badSum.data);
  const incompat = await ops.post('/v1/firmware/campaigns', { imageId: up.data.id, name: 'wrong model', targetType: 'charge_point', targetIds: [reg.data.chargePointId] });
  check('FOTA: campaign refused for non-matching model? (DC Compact matches "MaxiCharger")', incompat.status === 200, incompat.data);
  await ops.post(`/v1/firmware/campaigns/${incompat.data.id}/cancel`);
  const cpList = await ops.get('/v1/charge-points');
  const id201 = cpList.data.find((c: any) => c.ocpp_identity === ID2).id;
  c201.handlers.UpdateFirmware = () => ({ status: 'Accepted' });
  const camp = await ops.post('/v1/firmware/campaigns', { imageId: up.data.id, name: 'E2E rollout', targetType: 'charge_point', targetIds: [id201], maxRetries: 1, retryIntervalS: 60 });
  check('FOTA: campaign created', camp.status === 200 && camp.data.targets === 1, camp.data);
  const uf = await c201.waitFor('UpdateFirmware', 45_000);
  check('FOTA: scheduler dispatched UpdateFirmware with our /fw download URL', !!uf && /\/fw\/[A-Za-z0-9_-]+\/fw-1\.0\.7\.bin$/.test(uf.payload.firmware.location), uf?.payload);
  if (uf) {
    const dl = await fetch(uf.payload.firmware.location.replace('http://127.0.0.1:9200', API));
    const bytes = Buffer.from(await dl.arrayBuffer());
    check('FOTA: charger can download the image (public token URL)', dl.status === 200 && bytes.equals(fwBin), dl.status);
    for (const st of ['Downloading', 'Downloaded', 'Installing', 'Installed']) {
      await c201.call('FirmwareStatusNotification', { status: st, requestId: uf.payload.requestId });
    }
    await c201.call('BootNotification', { reason: 'FirmwareUpdate', chargingStation: { model: 'MaxiCharger AC Wallbox', vendorName: 'Autel', firmwareVersion: '1.0.7' } });
    const jobs = await until(() => ops.get(`/v1/firmware/campaigns/${camp.data.id}`), (r) => r.data.jobs?.[0]?.state === 'Verified', 15_000, 1000);
    check('FOTA: job reaches Verified after the reboot reports 1.0.7; campaign completed', jobs.data.jobs?.[0]?.state === 'Verified' && jobs.data.campaign.status === 'completed', { job: jobs.data.jobs?.[0]?.state, c: jobs.data.campaign?.status });
  }

  // ---------------------------------------------------------------- 9.2 diagnostics
  c201.handlers.GetLog = () => ({ status: 'Accepted', filename: 'diag.log' });
  const dreq = await ops.post(`/v1/charge-points/${ID2}/diagnostics`, {});
  const gl = await c201.waitFor('GetLog');
  check('diagnostics: GetLog sent with the built-in receiver URL', dreq.status === 200 && /\/diag\/[A-Za-z0-9_-]+$/.test(gl?.payload?.log?.remoteLocation ?? ''), { d: dreq.data, gl: gl?.payload });
  if (gl) {
    const put = await fetch(gl.payload.log.remoteLocation.replace('http://127.0.0.1:9200', API) + '/diag.log', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'INFO boot\nERROR E0412 GroundFailure\n' });
    check('diagnostics: charger upload accepted (201)', put.status === 201, put.status);
    const again = await fetch(gl.payload.log.remoteLocation.replace('http://127.0.0.1:9200', API), { method: 'PUT', body: 'x' });
    check('diagnostics: upload token is single-use', again.status === 404, again.status);
    await c201.call('LogStatusNotification', { status: 'Uploaded', requestId: gl.payload.requestId });
    const list = await ops.get(`/v1/charge-points/${ID2}/diagnostics`);
    const content = await ops.get(`/v1/diagnostics/${list.data[0].id}/content`);
    check('diagnostics: log viewer returns the uploaded text', content.data.available === true && /E0412/.test(content.data.text), content.data);
    const trav = await fetch(`${API}/diag/${'a'.repeat(30)}/..%2F..%2Fx`, { method: 'PUT', body: 'x' });
    check('diagnostics: unknown token refused (404)', trav.status === 404, trav.status);
  }
  c201.close();

  // ---------------------------------------------------------------- 10 · RBAC: Site Host & Technician
  const inv = await ops.post('/v1/users', { name: 'Pak Hendra (Mall)', email: `host${Date.now()}@example.id`, role: 'site_host_landlord', siteIds: [siteId] });
  check('users: invite site-scoped Site Host, temp password returned', inv.status === 200 && typeof inv.data.temporaryPassword === 'string', inv.status);
  const host = new Client();
  const users = await ops.get('/v1/users');
  const hostEmail = users.data.find((u: any) => u.id === inv.data.id)?.email;
  const hl = await host.post('/v1/auth/login', { email: hostEmail, password: inv.data.temporaryPassword });
  check('users: Site Host signs in, must change password', hl.status === 200 && hl.data.mustChangePassword === true, hl.data);
  const cpw = await host.post('/v1/auth/change-password', { current: inv.data.temporaryPassword, next: 'HostPass-2026!x' });
  check('users: password change', cpw.status === 200, cpw.data);
  const hs = await host.get('/v1/sites');
  check('RBAC: Site Host sees ONLY the assigned site', hs.status === 200 && hs.data.length === 1 && hs.data[0].id === siteId, hs.data.map?.((x: any) => x.name));
  const hc = await host.post(`/v1/charge-points/${ID}/unlock`, { connectorId: 1 });
  check('RBAC: Site Host cannot send commands (403)', hc.status === 403, hc.status);
  const hcp = await host.get('/v1/charge-points');
  check('RBAC: Site Host fleet list limited to their site', hcp.status === 200 && hcp.data.every((c: any) => c.site_id === siteId), hcp.data.length);
  const other = await host.get('/v1/charge-points/AUTEL-AC22-SMB-001');
  check('RBAC: Site Host cannot open a charger at another site (403)', other.status === 403, other.status);
  const hsess = await host.get('/v1/sessions/search');
  check('RBAC: Site Host session search returns only their site', hsess.status === 200 && hsess.data.rows.every((r: any) => r.site_id === siteId) && hsess.data.rows.length >= 1, { s: hsess.status, n: hsess.data.rows?.length });
  const hdash = await host.get('/v1/dashboard');
  check('RBAC: Site Host dashboard counts only their chargers', hdash.status === 200 && hdash.data.chargers.total === 2, hdash.data.chargers);
  const hpow = await host.get(`/v1/sites/${siteId}/power`);
  check('RBAC: Site Host may read power for their site', hpow.status === 200, hpow.status);
  const hpw = await host.put(`/v1/sites/${siteId}/power/budget`, { ceilingW: 100000 });
  check('RBAC: Site Host cannot change the power ceiling (403)', hpw.status === 403, hpw.status);
  const hu = await host.get('/v1/users');
  check('RBAC: Site Host cannot list users (403)', hu.status === 403, hu.status);

  const tinv = await ops.post('/v1/users', { name: 'Tech Budi', email: `tech${Date.now()}@example.id`, role: 'field_technician' });
  const tech = new Client();
  const temail = (await ops.get('/v1/users')).data.find((u: any) => u.id === tinv.data.id)?.email;
  await tech.post('/v1/auth/login', { email: temail, password: tinv.data.temporaryPassword });
  // The one-time password opens nothing but the password change (enforced by the server).
  const tHeld = await tech.get('/v1/charge-points');
  check('users: a one-time password is held to the password change by the API', tHeld.status === 403 && tHeld.data?.code === 'password_change_required', tHeld.data);
  const tcpw = await tech.post('/v1/auth/change-password', { current: tinv.data.temporaryPassword, next: 'TechPass-2026!x' });
  check('users: technician sets its own password', tcpw.status === 200, tcpw.data);

  // Two-step verification (optional for a technician; required for administrators outside
  // development/test). Set up from the user menu, then a sign-in needs the code.
  const tmfa = await tech.post('/v1/auth/mfa/enrol');
  check('2FA: set-up answers an otpauth:// URI and a QR code', tmfa.status === 200 && /^otpauth:\/\/totp\//.test(tmfa.data.uri) && /^data:image\/png;base64,/.test(tmfa.data.qrDataUrl), tmfa.status);
  const tsecret = base32Decode(String(tmfa.data.secret ?? ''));
  const tstep = timeStep(Date.now());
  const tconf = await tech.post('/v1/auth/mfa/enrol/confirm', { code: hotp(tsecret, tstep) });
  check('2FA: confirmed with a code from the app; ten recovery codes, once', tconf.status === 200 && tconf.data.recoveryCodes?.length === 10, tconf.data);
  await tech.post('/v1/auth/logout');
  const t2 = await tech.post('/v1/auth/login', { email: temail, password: 'TechPass-2026!x' });
  const t2held = await tech.get('/v1/sites');
  check('2FA: the right password alone opens only the code step', t2.status === 200 && t2.data.mfaRequired === true && t2held.status === 403 && t2held.data?.code === 'mfa_required', { login: t2.data, held: t2held.data });
  const treplay = await tech.post('/v1/auth/mfa/verify', { code: hotp(tsecret, tstep) });
  check('2FA: the code used at set-up cannot be replayed', treplay.status === 400, treplay.data);
  const tver = await tech.post('/v1/auth/mfa/verify', { code: tconf.data.recoveryCodes?.[0] });
  const tme = await tech.get('/v1/auth/me');
  check('2FA: a recovery code completes the sign-in (nine left)', tver.status === 200 && tver.data.recoveryCodesLeft === 9 && tme.status === 200 && tme.data.user?.mfa?.enabled === true, { v: tver.data, me: tme.status });
  // Real permission refusals, not the password hold.
  const notHeld = (r: any) => r.data?.code !== 'password_change_required';
  const tstart = await tech.post(`/v1/charge-points/${ID}/remote-start`, { connectorId: 2, idTag: 'ID-RFID-0001' });
  check('RBAC: technician cannot start with a retail card (test-only)', tstart.status === 403 && notHeld(tstart), tstart.data);
  const ttar = await tech.get('/v1/tariffs');
  check('RBAC: technician has no tariff access', ttar.status === 403 && notHeld(ttar), ttar.status);
  const tcfg = await tech.put(`/v1/charge-points/${ID}/config`, { key: 'HeartbeatInterval', value: '300' });
  check('RBAC: technician may edit charger configuration', tcfg.status === 200, tcfg.data);
  const self = await ops.put(`/v1/users/${me.data.user.id}`, { status: 'disabled' });
  check('users: admin cannot disable themselves', self.status === 400, self.data);
  const dis = await ops.put(`/v1/users/${tinv.data.id}`, { status: 'disabled' });
  const afterDis = await tech.get('/v1/auth/me');
  check('users: disabling a user ends their session immediately', dis.status === 200 && afterDis.status === 401, afterDis.status);
  const tres = await ops.post(`/v1/users/${tinv.data.id}/reset-mfa`);
  const tlist = (await ops.get('/v1/users')).data.find((u: any) => u.id === tinv.data.id);
  check('2FA: an administrator resets a user\'s two-step verification', tres.status === 200 && tlist?.mfa_enabled === false, { r: tres.data, mfa: tlist?.mfa_enabled });
  const ownRes = await ops.post(`/v1/users/${me.data.user.id}/reset-mfa`);
  check('2FA: but never their own', ownRes.status === 400, ownRes.data);

  // ---------------------------------------------------------------- misc
  // "Sign in with Microsoft" (v1.6.0): the sign-in page asks whether to show the button.
  const signInOpts = await new Client().get('/console-sign-in.json');
  check('sign-in page: Microsoft button availability is published', signInOpts.status === 200 && typeof signInOpts.data?.microsoft === 'boolean', signInOpts.data);
  const dash = await ops.get('/v1/dashboard');
  check('dashboard: KPIs', dash.status === 200 && dash.data.chargers.total >= 3 && Array.isArray(dash.data.series) && dash.data.series.length === 14, dash.data.chargers);
  const audit = await ops.get('/v1/audit');
  check('audit: chain intact and console actions recorded', audit.data.chain?.ok === true && audit.data.entries.some((e: any) => e.action === 'site.power_budget.changed'), audit.data.chain);
  const decom = await ops.post(`/v1/charge-points/${ID2}/decommission`, {});
  check('lifecycle: decommission', decom.status === 200, decom.data);
  const logout = await ops.post('/v1/auth/logout');
  const post = await ops.get('/v1/auth/me');
  check('auth: logout revokes the session', logout.status === 200 && post.status === 401, post.status);
  // Sign-out revokes a Bearer session too (it used to revoke only the cookie's).
  const bl = await new Client().post('/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  const btok = decodeURIComponent(String(bl.headers.get('set-cookie') ?? '').split(';')[0]!.split('=')[1] ?? '');
  const bearer = new Client();
  const bOut = await bearer.req('POST', '/v1/auth/logout', {}, { csrf: false, headers: { authorization: `Bearer ${btok}` } });
  const bMe = await bearer.req('GET', '/v1/auth/me', undefined, { headers: { authorization: `Bearer ${btok}` } });
  check('auth: logout with a Bearer pss_ token revokes it', /^pss_/.test(btok) && bOut.status === 200 && bMe.status === 401, { out: bOut.status, me: bMe.status });
} catch (e) {
  check('UNEXPECTED EXCEPTION', false, String((e as Error)?.stack ?? e));
} finally {
  for (const c of children) c.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
