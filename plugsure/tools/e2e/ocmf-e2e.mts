// PlugSure v1.3 — signed meter values (OCMF), end to end.
//
// Raw OCPP 1.6 and 2.0.1 chargers with a "calibration-law meter": the test holds
// the meter's key and signs the start and end readings as such a meter does.
// Verified sessions, a tampered reading, readings that do not match the bill, a
// meter that is not the connector's, the "require" policy parking sessions, the
// 2.0.1 form (signedMeterValue with the key), the Transparency Software file and
// the receipt, and switching signing on at a 2.0.1 station.
//
// Same prerequisites as console-e2e.mts (API on 9200, gateway on 9220 with
// OCPP_VERSIONS including ocpp2.0.1, the seeded operator).
//     npx tsx tools/e2e/ocmf-e2e.mts
// NEVER point this at production.
import WebSocket from 'ws';
import { generateKeyPairSync } from 'node:crypto';
import { buildOcmf, formatOcmfTime } from '../../src/services/ocmf.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000, every = 300): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const iso = (offsetS = 0) => new Date(Date.now() + offsetS * 1000).toISOString();
const RUN = Date.now().toString().slice(-6);

let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d, headers: r.headers };
}

class Raw {
  ws!: WebSocket;
  calls: Array<{ action: string; payload: any; at: number }> = [];
  handlers: Record<string, (p: any) => any> = {};
  pending = new Map<string, (v: any) => void>();
  n = 0;
  constructor(public id: string, public version: 'ocpp1.6' | 'ocpp2.0.1') {}
  async connect() {
    this.ws = new WebSocket(`${OCPP}/${this.id}`, [this.version]);
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f[0] === 2) {
        const [, uid, action, payload] = f;
        this.calls.push({ action, payload, at: Date.now() });
        const h = this.handlers[action];
        this.ws.send(JSON.stringify([3, uid, (h ? h(payload) : { status: 'Accepted' }) ?? {}]));
      } else if (f[0] === 3 || f[0] === 4) { this.pending.get(f[1])?.(f[0] === 3 ? f[2] : { __error: f[2], __msg: f[3] }); this.pending.delete(f[1]); }
    });
  }
  call(action: string, payload: unknown): Promise<any> {
    const id = `${this.id}-${++this.n}`;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify([2, id, action, payload])); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); res({ __timeout: true }); } }, 10_000); });
  }
  seen(action: string, after: number, ms = 10_000) { return until(() => this.calls.find((c) => c.action === action && c.at >= after), (v) => !!v, ms, 200); }
  close() { try { this.ws.close(); } catch {} }
}

// The meter: its key, and how it signs a register reading.
const meterKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const meterHex = (meterKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('hex');
const SERIAL = `MTR-${RUN}`;
const sign = (tx: 'B' | 'E', wh: number, idTag: string, serial = SERIAL, key = meterKeys.privateKey) => buildOcmf({
  FV: '1.0', GI: 'E2E', GS: 'CP', GV: '1.0', PG: `T${tx === 'B' ? 1 : 2}`, MV: 'E2E Meters', MM: 'EM-1', MS: serial, MF: '1.0',
  IS: true, IT: 'ISO14443', ID: idTag,
  RD: [{ TM: formatOcmfTime(new Date()), TX: tx, RV: Number((wh / 1000).toFixed(3)), RI: '1-b:1.8.0', RU: 'kWh', RT: 'DC', EF: '', ST: 'G' }],
}, key);
const signed16 = (data: string, context: string) => ({ value: data, format: 'SignedData', context });

let c16: Raw | null = null;
let c201: Raw | null = null;
try {
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  const site = await ops('POST', '/v1/sites', { name: `Eichrecht Hub ${RUN}`, address: 'Jl. Gatot Subroto 1', city: 'Jakarta Selatan', postalCode: '12930',
    lat: '-6.2300', lon: '106.8200', kabupatenKotaCode: '3174', gridTariffGroup: 'B-2/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', pbjtRateBps: '1000' });
  const siteId = site.data.id as string;
  const tariff = await ops('POST', '/v1/tariffs', { name: `OCMF DC ${RUN}`, plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true, components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }] });
  await ops('PUT', `/v1/sites/${siteId}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  const UID = `OCMF${RUN}`;
  await ops('POST', '/v1/tokens', { uid: UID, holderName: 'OCMF Driver', accountType: 'retail' });

  const conn = (over: Record<string, unknown> = {}) => ({ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31', meterSerial: SERIAL, ...over });
  const badKey = await ops('POST', '/v1/charge-points', { ocppIdentity: `OCMF-BAD-${RUN}`, siteId, ocppVersion: 'ocpp1.6', evses: [{ evseId: 1, connectors: [conn({ meterPublicKey: 'not-a-key' })] }] });
  check('keys: a malformed meter public key is refused when registering', badKey.status === 422 && /Meter public key/.test(badKey.data.error), badKey.data);
  const ID = `OCMF16-${RUN}`;
  // Registered as the raw point, the form printed on many meter labels.
  const der = Buffer.from(meterHex, 'hex');
  const reg = await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId, ocppVersion: 'ocpp1.6', evses: [{ evseId: 1, connectors: [conn({ meterPublicKey: der.subarray(der.length - 65).toString('hex') })] }] });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  const detail = await ops('GET', `/v1/charge-points/${ID}`);
  const stored = detail.data?.evses?.[0]?.connectors?.[0]?.meter_public_key ?? detail.data?.connectors?.[0]?.meter_public_key;
  check('keys: the meter key is stored in its canonical form (hex DER)', reg.status === 200 && stored === meterHex, { reg: reg.data, stored });

  c16 = new Raw(ID, 'ocpp1.6');
  await c16.connect();
  await c16.call('BootNotification', { chargePointVendor: 'EichSim', chargePointModel: 'ES-DC-60' });
  await c16.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: iso() });

  /** One 1.6 session: Start, then Stop carrying the signed readings in transactionData, as Eichrecht firmware does. */
  const session16 = async (startWh: number, stopWh: number, signedData: unknown[], meterStop = stopWh) => {
    const st = await c16!.call('StartTransaction', { connectorId: 1, idTag: UID, meterStart: startWh, timestamp: iso() });
    const stop = await c16!.call('StopTransaction', { transactionId: st.transactionId, idTag: UID, meterStop, timestamp: iso(), reason: 'EVDisconnected',
      ...(signedData.length ? { transactionData: [{ timestamp: iso(), sampledValue: signedData }] } : {}) });
    if (stop.__error) throw new Error(`StopTransaction refused: ${stop.__error} ${stop.__msg}`);
    const rows = (await ops('GET', `/v1/sessions/search?identity=${ID}&limit=10`)).data?.rows ?? [];
    const sid = rows.find((r: any) => String(r.ocpp_transaction_id) === String(st.transactionId))?.id;
    const s = await until(() => ops('GET', `/v1/sessions/${sid}`), (r) => !!r.data?.ended_at, 8000);
    return { sid, s: s.data, tx: st.transactionId };
  };

  // ─────────────────────────────────────────── verified
  const good = await session16(1_000_000, 1_006_000, [signed16(sign('B', 1_000_000, UID), 'Transaction.Begin'), signed16(sign('E', 1_006_000, UID), 'Transaction.End')]);
  check('1.6: signed start and end readings verify against the registered key and match the bill (6 kWh); the session is billed',
    good.s.signed_status === 'verified' && Number(good.s.signed_energy_wh) === 6000 && Number(good.s.energy_wh) === 6000 && good.s.total_idr != null,
    { st: good.s.signed_status, d: good.s.signed_detail, e: good.s.energy_wh, t: good.s.total_idr });
  const sd = await ops('GET', `/v1/sessions/${good.sid}/signed-data`);
  check('api: the signed data lists both readings, each valid against the registered key, with the meter and its key',
    sd.data.values?.length === 2 && sd.data.values.every((v: any) => v.verifyStatus === 'valid' && v.keySource === 'registered') && sd.data.meterSerial === SERIAL && sd.data.meterPublicKey === meterHex
      && sd.data.values.some((v: any) => v.readings?.[0]?.tx === 'B' && v.readings[0].wh === 1_000_000),
    sd.data);
  const xml = await fetch(`${API}/v1/sessions/${good.sid}/signed-data.xml`, { headers: { cookie } });
  const xmlText = await xml.text();
  check('api: a file for the Transparency Software with both signed values and the meter key',
    xml.status === 200 && /application\/xml/.test(xml.headers.get('content-type') ?? '') && (xmlText.match(/<signedData format="OCMF"/g) ?? []).length === 2 && xmlText.includes(meterHex) && xmlText.includes('context="Transaction.End"'),
    xmlText.slice(0, 300));
  const receipt = await fetch(`${API}/v1/sessions/${good.sid}/receipt`, { headers: { cookie } });
  const rt = await receipt.text();
  check('receipt: the tax receipt shows the signed data, its status and the meter key', /Signed meter data \(OCMF\)/.test(rt) && /verified/.test(rt) && rt.includes(meterHex) && rt.includes('OCMF|'), rt.slice(rt.indexOf('Signed meter'), rt.indexOf('Signed meter') + 200));

  // ─────────────────────────────────────────── problems, under the default policy
  const endText = sign('E', 1_012_000, UID);
  const tampered = await session16(1_006_000, 1_012_000, [signed16(sign('B', 1_006_000, UID), 'Transaction.Begin'), signed16(endText.replace('"RV":1012', '"RV":1013'), 'Transaction.End')]);
  check('tamper: a reading changed after signing is "invalid" and flagged, the session still billed (record policy)',
    tampered.s.signed_status === 'invalid' && /does not match the data/.test(tampered.s.signed_detail) && (tampered.s.flags ?? []).some((f: any) => f.code === 'SIGNED_METER_INVALID' && f.severity === 'warning') && tampered.s.total_idr != null,
    { st: tampered.s.signed_status, d: tampered.s.signed_detail, f: tampered.s.flags });
  const mismatch = await session16(1_012_000, 1_018_000, [signed16(sign('B', 1_012_000, UID), 'Transaction.Begin'), signed16(sign('E', 1_019_000, UID), 'Transaction.End')]);
  check('mismatch: signed readings that say 7 kWh against a 6 kWh bill are "mismatch", with both figures',
    mismatch.s.signed_status === 'mismatch' && Number(mismatch.s.signed_energy_wh) === 7000 && /7000 Wh/.test(mismatch.s.signed_detail) && /6000 Wh/.test(mismatch.s.signed_detail), { st: mismatch.s.signed_status, d: mismatch.s.signed_detail });
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const wrongMeter = await session16(1_018_000, 1_020_000, [signed16(sign('B', 1_018_000, UID, 'MTR-OTHER', other.privateKey), 'Transaction.Begin'), signed16(sign('E', 1_020_000, UID, 'MTR-OTHER', other.privateKey), 'Transaction.End')]);
  check('another meter: readings signed by a different meter do not verify against this connector\'s key', wrongMeter.s.signed_status === 'invalid', { st: wrongMeter.s.signed_status, d: wrongMeter.s.signed_detail });
  const onlyEnd = await session16(1_020_000, 1_021_000, [signed16(sign('E', 1_021_000, UID), 'Transaction.End')]);
  check('incomplete: without the signed start reading the session is "incomplete"', onlyEnd.s.signed_status === 'incomplete' && /the start/.test(onlyEnd.s.signed_detail), { st: onlyEnd.s.signed_status, d: onlyEnd.s.signed_detail });
  const plain = await session16(1_021_000, 1_022_000, []);
  check('no signing: a session without signed readings is not assessed under the default policy, and billed', plain.s.signed_status === null && plain.s.total_idr != null, { st: plain.s.signed_status });

  // ─────────────────────────────────────────── require
  const pol = await ops('PUT', `/v1/sites/${siteId}`, { signedMeterPolicy: 'require' });
  const badPol = await ops('PUT', `/v1/sites/${siteId}`, { signedMeterPolicy: 'sometimes' });
  check('policy: the site requires verified signed readings (an unknown policy is refused)', pol.status === 200 && badPol.status === 422, { p: pol.data, b: badPol.data });
  const missing = await session16(1_022_000, 1_023_000, []);
  check('require: a session without signed readings is parked for review, with no invoice',
    missing.s.signed_status === 'missing' && missing.s.needs_review === true && missing.s.review_reason === 'SIGNED_METER_MISSING' && missing.s.total_idr == null,
    { st: missing.s.signed_status, r: missing.s.review_reason, t: missing.s.total_idr });
  const mm2 = await session16(1_023_000, 1_025_000, [signed16(sign('B', 1_023_000, UID), 'Transaction.Begin'), signed16(sign('E', 1_026_000, UID), 'Transaction.End')]);
  check('require: signed readings that do not match are parked too', mm2.s.needs_review === true && mm2.s.review_reason === 'SIGNED_METER_MISMATCH' && mm2.s.total_idr == null, { r: mm2.s.review_reason });
  const ok2 = await session16(1_025_000, 1_027_000, [signed16(sign('B', 1_025_000, UID), 'Transaction.Begin'), signed16(sign('E', 1_027_000, UID), 'Transaction.End')]);
  check('require: a verified session is billed as usual', ok2.s.signed_status === 'verified' && ok2.s.needs_review === false && ok2.s.total_idr != null, { st: ok2.s.signed_status });
  await ops('PUT', `/v1/sites/${siteId}`, { signedMeterPolicy: 'record' });

  // ─────────────────────────────────────────── OCPP 2.0.1: signedMeterValue, with the key the station sends
  const ID2 = `OCMF201-${RUN}`;
  await ops('POST', '/v1/charge-points', { ocppIdentity: ID2, siteId, ocppVersion: 'ocpp2.0.1', evses: [{ evseId: 1, connectors: [conn({ meterSerial: SERIAL })] }] });
  await ops('POST', `/v1/charge-points/${ID2}/activate`);
  c201 = new Raw(ID2, 'ocpp2.0.1');
  c201.handlers.SetVariables = (p: any) => ({ setVariableResult: p.setVariableData.map((s: any) => ({ component: s.component, variable: s.variable, attributeStatus: 'Accepted' })) });
  await c201.connect();
  await c201.call('BootNotification', { reason: 'PowerUp', chargingStation: { vendorName: 'EichSim', model: 'ES-201' } });
  await c201.call('StatusNotification', { timestamp: iso(), connectorStatus: 'Available', evseId: 1, connectorId: 1 });
  const smv = (wh: number, tx: 'B' | 'E', context: string) => ({
    value: wh, measurand: 'Energy.Active.Import.Register', context, unitOfMeasure: { unit: 'Wh' },
    signedMeterValue: { signedMeterData: Buffer.from(sign(tx, wh, UID)).toString('base64'), signingMethod: '', encodingMethod: 'OCMF', publicKey: Buffer.from(meterHex).toString('base64') },
  });
  const tx201 = `T201-${RUN}`;
  await c201.call('TransactionEvent', { eventType: 'Started', timestamp: iso(), triggerReason: 'Authorized', seqNo: 0, transactionInfo: { transactionId: tx201, chargingState: 'Charging' },
    evse: { id: 1, connectorId: 1 }, idToken: { idToken: UID, type: 'ISO14443' }, meterValue: [{ timestamp: iso(), sampledValue: [smv(500_000, 'B', 'Transaction.Begin')] }] });
  const endEv = await c201.call('TransactionEvent', { eventType: 'Ended', timestamp: iso(), triggerReason: 'EVDeparted', seqNo: 1, transactionInfo: { transactionId: tx201, chargingState: 'Idle', stoppedReason: 'EVDisconnected' },
    evse: { id: 1, connectorId: 1 }, meterValue: [{ timestamp: iso(), sampledValue: [smv(504_000, 'E', 'Transaction.End')] }] });
  const rows2 = (await ops('GET', `/v1/sessions/search?identity=${ID2}&limit=5`)).data?.rows ?? [];
  const s2 = (await until(() => ops('GET', `/v1/sessions/${rows2[0]?.id}`), (r) => !!r.data?.ended_at, 8000)).data;
  check('2.0.1: signedMeterValue (base64 OCMF, with the station\'s key) is read; with no registered key the result is "unverified_key", never "verified"',
    !endEv.__error && Number(s2.energy_wh) === 4000 && s2.signed_status === 'unverified_key' && /only against the key the charger sent/.test(s2.signed_detail),
    { e: s2.energy_wh, st: s2.signed_status, d: s2.signed_detail });
  const sd2 = await ops('GET', `/v1/sessions/${s2.id}/signed-data`);
  check('2.0.1: both readings are valid against the key the charger sent, and the key is shown', sd2.data.values?.length === 2 && sd2.data.values.every((v: any) => v.verifyStatus === 'valid' && v.keySource === 'charger' && v.chargerKey === meterHex), sd2.data.values);

  let mark = Date.now();
  const on = await ops('POST', `/v1/charge-points/${ID2}/signed-metering`, { enabled: true });
  const sv = await c201.seen('SetVariables', mark);
  const names = (sv?.payload?.setVariableData ?? []).map((x: any) => `${x.component.name}.${x.variable.name}=${x.attributeValue}`).sort();
  check('command: signing is switched on at a 2.0.1 station with SetVariables (SignReadings, and the key once per transaction)',
    on.status === 200 && on.data.accepted === true && JSON.stringify(names) === JSON.stringify(['AlignedDataCtrlr.SignReadings=true', 'OCPPCommCtrlr.PublicKeyWithSignedMeterValue=OncePerTransaction', 'SampledDataCtrlr.SignReadings=true']),
    { on: on.data, names });
  const on16 = await ops('POST', `/v1/charge-points/${ID}/signed-metering`, { enabled: true });
  check('command: OCPP 1.6 has no standard setting, and says so (409)', on16.status === 409 && on16.data.code === 'not_ocpp2', on16.data);
} catch (e) {
  check('no unexpected exception', false, (e as Error).stack);
} finally {
  c16?.close();
  c201?.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
