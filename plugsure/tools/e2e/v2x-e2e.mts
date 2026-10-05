// PlugSure v1.3 — ISO 15118-20 charging needs and bidirectional charging (V2G / V2B)
// over OCPP 2.1, end to end.
//
// A raw OCPP 2.1 station with two DC EVSEs at a site whose programme lets cars give
// energy back, capped at the site's own auxiliary load (no export to PLN):
//   - a fleet car (standing consent) reports its needs (DC_BPT) and is asked to
//     discharge; the station reports the export register and SoC;
//   - an app driver's car is offered the choice, the driver agrees (with a floor),
//     and the two cars share the site's load;
//   - the fleet car reaches its floor and goes back to charging; the driver
//     withdraws; the hours close; the fleet session is billed with its credit.
//
// Same prerequisites as driver-e2e.mts (API on 9200, gateway on 9220 with
// OCPP_VERSIONS including ocpp2.1, the seeded operator).
//     npx tsx tools/e2e/v2x-e2e.mts
// NEVER point this at production.
import WebSocket from 'ws';

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

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(API + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: res.status, data: d };
}
let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
}
class Driver {
  token = '';
  async init() { this.token = (await http('POST', '/d/v1/device')).data.deviceToken; return this; }
  get = (p: string) => http('GET', '/d' + p, undefined, { authorization: 'Bearer ' + this.token });
  post = (p: string, b: unknown = {}) => http('POST', '/d' + p, b, { authorization: 'Bearer ' + this.token });
}

// ─────────────────────────────────────────── a raw OCPP 2.1 station
interface Call { action: string; payload: any; at: number }
class Station {
  ws!: WebSocket;
  calls: Call[] = [];
  handlers: Record<string, (p: any) => any> = {};
  pending = new Map<string, (v: any) => void>();
  n = 0;
  negotiated = '';
  constructor(public id: string) {}
  async connect() {
    this.ws = new WebSocket(`${OCPP}/${this.id}`, ['ocpp2.1']);
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); this.ws.once('unexpected-response', (_q: any, r: any) => rej(new Error(`HTTP ${r.statusCode}`))); });
    this.negotiated = this.ws.protocol;
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f[0] === 2) {
        const [, uid, action, payload] = f;
        this.calls.push({ action, payload, at: Date.now() });
        const h = this.handlers[action];
        this.ws.send(JSON.stringify([3, uid, (h ? h(payload) : { status: 'Accepted' }) ?? {}]));
      } else if (f[0] === 3 || f[0] === 4) {
        this.pending.get(f[1])?.(f[0] === 3 ? f[2] : { __error: f[2], __msg: f[3] });
        this.pending.delete(f[1]);
      }
    });
  }
  call(action: string, payload: unknown): Promise<any> {
    const id = `${this.id}-${++this.n}`;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify([2, id, action, payload])); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); res({ __timeout: true }); } }, 10_000); });
  }
  seen(pred: (c: Call) => boolean, ms = 20_000) { return until(() => this.calls.find(pred), (v) => !!v, ms, 200); }
  close() { try { this.ws.close(); } catch {} }
}
const sv = (value: number, measurand: string, unit: string) => ({ value, measurand, unitOfMeasure: { unit } });
const meter = (importWh: number, exportWh: number | null, soc: number | null) => [{
  timestamp: iso(),
  sampledValue: [sv(importWh, 'Energy.Active.Import.Register', 'Wh'), ...(exportWh !== null ? [sv(exportWh, 'Energy.Active.Export.Register', 'Wh')] : []), ...(soc !== null ? [sv(soc, 'SoC', 'Percent')] : [])],
}];
/** The TxProfile period last sent to an EVSE since `after`. */
const txPeriod = (st: Station, evseId: number, after: number) => {
  const c = [...st.calls].reverse().find((x) => x.at >= after && x.action === 'SetChargingProfile' && x.payload?.evseId === evseId && x.payload?.chargingProfile?.chargingProfilePurpose === 'TxProfile');
  return c ? { period: c.payload.chargingProfile.chargingSchedule?.[0]?.chargingSchedulePeriod?.[0], profile: c.payload.chargingProfile, unit: c.payload.chargingProfile.chargingSchedule?.[0]?.chargingRateUnit } : null;
};
const needs = (evseId: number, over: Record<string, unknown> = {}) => ({
  evseId, timestamp: iso(),
  chargingNeeds: {
    requestedEnergyTransfer: 'DC_BPT', availableEnergyTransfer: ['DC', 'DC_BPT'], controlMode: 'ScheduledControl', mobilityNeedsMode: 'EVCC',
    departureTime: iso(5 * 3600),
    dcChargingParameters: { evMaxCurrent: 200, evMaxVoltage: 450, evEnergyCapacity: 64000, stateOfCharge: 80, energyAmount: 12000 },
    v2xChargingParameters: { maxChargePower: 50000, maxDischargePower: 11000, targetSoC: 90 },
    ...over,
  },
});

let st: Station | null = null;
try {
  // ─────────────────────────────────────────── setup
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  const site = await ops('POST', '/v1/sites', { name: `V2G Depot ${RUN}`, address: 'Jl. Raya Bekasi Km 21', city: 'Jakarta Timur', postalCode: '13920',
    lat: '-6.1800', lon: '106.9300', kabupatenKotaCode: '3175', gridTariffGroup: 'B-2/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000' });
  const siteId = site.data.id as string;
  const tariff = await ops('POST', '/v1/tariffs', { name: `V2G DC ${RUN}`, plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true,
    components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }] });
  await ops('PUT', `/v1/sites/${siteId}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  // The building's own load: 15 kW of air-conditioning and lighting the cars may cover.
  const budget = await ops('PUT', `/v1/sites/${siteId}/power/budget`, { ceilingW: 180000, reserveBreakdown: { hvac: 12000, lighting: 3000 } });
  check('setup: a 197 kVA depot, DC tariff, 15 kW of auxiliary load', site.status === 200 && tariff.status === 200 && budget.status === 200, { s: site.data, b: budget.data });

  const badHours = await ops('PUT', `/v1/sites/${siteId}`, { v2xEnabled: true, v2xWindows: '25:00-26:00' });
  const badFloor = await ops('PUT', `/v1/sites/${siteId}`, { v2xMinSocPercent: 5 });
  check('programme: impossible hours or floor are refused', badHours.status === 422 && /Discharge hours|HH:MM/.test(badHours.data.error) && badFloor.status === 422, { h: badHours.data, f: badFloor.data });
  const prog = await ops('PUT', `/v1/sites/${siteId}`, { v2xEnabled: true, v2xWindows: '00:00-00:00', v2xMinSocPercent: 40, v2xCreditMinorPerKwh: 2000, v2xAllowExport: false });
  const exportWarn = await ops('PUT', `/v1/sites/${siteId}`, { v2xAllowExport: true });
  await ops('PUT', `/v1/sites/${siteId}`, { v2xAllowExport: false });
  const siteRow = (await ops('GET', `/v1/sites/${siteId}`)).data;
  check('programme: switched on all day, floor 40 %, Rp 2,000 / kWh, no export (allowing export warns about PLN)',
    prog.status === 200 && (exportWarn.data.warnings ?? []).some((w: string) => /PLN/.test(w)) && siteRow?.v2x_enabled === true && siteRow.v2x_credit_minor_per_kwh === 2000 && siteRow.v2x_allow_export === false && siteRow.v2x_windows?.[0]?.from === '00:00',
    { p: prog.data, w: exportWarn.data, s: siteRow && { e: siteRow.v2x_enabled, w: siteRow.v2x_windows } });

  const ID = `V2G-${RUN}`;
  const reg = await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId, displayName: 'Depot bidirectional DC', ocppVersion: 'ocpp2.1',
    evses: [1, 2].map((evseId) => ({ evseId, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] })) });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  st = new Station(ID);
  st.handlers.RequestStartTransaction = () => ({ status: 'Accepted' });
  await st.connect();
  const boot = await st.call('BootNotification', { reason: 'PowerUp', chargingStation: { vendorName: 'BidiSim', model: 'BD-DC-60', firmwareVersion: '2.1.0' } });
  for (const e of [1, 2]) await st.call('StatusNotification', { timestamp: iso(), connectorStatus: 'Available', evseId: e, connectorId: 1 });
  const online = await until(() => ops('GET', `/v1/charge-points/${ID}`), (r) => r.data?.online === true || r.data?.connection?.online === true, 15_000, 500);
  check('OCPP 2.1: the station is registered and connects as 2.1, and the boot records 2.1',
    reg.status === 200 && st.negotiated === 'ocpp2.1' && boot.status === 'Accepted' && online.data?.ocpp_version === 'ocpp2.1', { reg: reg.data, neg: st.negotiated, boot, v: online.data?.ocpp_version });

  // ─────────────────────────────────────────── a fleet car with standing consent
  const fleetName = `V2G Fleet ${RUN}`;
  const UID_A = `V2GA${RUN}`;
  await ops('POST', '/v1/tokens', { uid: UID_A, holderName: 'Depot van 1', accountType: 'fleet', fleetName });
  const fleet = ((await ops('GET', '/v1/fleet-accounts')).data.accounts ?? []).find((a: any) => a.name === fleetName);
  const badFleet = await ops('PUT', `/v1/fleet-accounts/${fleet?.id}`, { v2xAllowed: true, v2xMinSocPercent: 99 });
  const fleetOk = await ops('PUT', `/v1/fleet-accounts/${fleet?.id}`, { v2xAllowed: true, v2xMinSocPercent: 50 });
  check('fleet: standing consent with its own floor (50 %); an impossible floor is refused', badFleet.status === 422 && fleetOk.status === 200 && fleetOk.data.v2x_allowed === true && fleetOk.data.v2x_min_soc_percent === 50, { bad: badFleet.data, ok: fleetOk.data });

  let mark = Date.now();
  const txA = `TXA-${RUN}`;
  const startA = await st.call('TransactionEvent', { eventType: 'Started', timestamp: iso(), triggerReason: 'Authorized', seqNo: 0,
    transactionInfo: { transactionId: txA, chargingState: 'Charging' }, evse: { id: 1, connectorId: 1 }, idToken: { idToken: UID_A, type: 'ISO14443' }, meterValue: meter(1000, 0, 80) });
  await st.call('StatusNotification', { timestamp: iso(), connectorStatus: 'Occupied', evseId: 1, connectorId: 1 });
  const needsA = await st.call('NotifyEVChargingNeeds', needs(1));
  check('needs: the car\'s ISO 15118-20 needs (DC_BPT, up to 11 kW back) are Accepted', startA.idTokenInfo?.status === 'Accepted' && needsA.status === 'Accepted', { startA, needsA });
  const disA = await until(() => txPeriod(st!, 1, mark), (p) => p?.period?.operationMode === 'CentralSetpoint', 15_000);
  check('discharge: the fleet car is asked to give back 11 kW (CentralSetpoint, setpoint −11000 W, its transaction, load-management stack)',
    disA?.period?.setpoint === -11000 && disA.period.dischargeLimit === -11000 && disA.unit === 'W' && disA.profile.transactionId === txA && disA.profile.stackLevel === 5,
    disA ?? st.calls.filter((c) => c.action === 'SetChargingProfile' && c.at >= mark).map((c) => c.payload));
  const sessions = await ops('GET', `/v1/sessions/search?identity=${ID}&limit=5`);
  const sidA = (sessions.data?.rows ?? []).find((r: any) => r.ocpp_transaction_id === txA)?.id;
  const detA = await until(() => ops('GET', `/v1/sessions/${sidA}`), (r) => r.data?.v2x?.discharging === true, 8000);
  const vA = detA.data?.v2x;
  check('console: the session shows the car\'s needs, the fleet\'s consent (floor 50 %) and 11 kW going back',
    vA?.consent === true && vA.consentSource === 'fleet' && vA.minSocPercent === 50 && vA.creditMinorPerKwh === 2000 && vA.dischargeW === 11000
      && vA.needs?.requestedTransfer === 'DC_BPT' && vA.needs.bidirectional === true && vA.needs.maxDischargePowerW === 11000 && vA.needs.evCapacityWh === 64000,
    vA);

  const updA = await st.call('TransactionEvent', { eventType: 'Updated', timestamp: iso(), triggerReason: 'OperationModeChanged', seqNo: 1,
    transactionInfo: { transactionId: txA, chargingState: 'Charging', operationMode: 'CentralSetpoint' }, evse: { id: 1, connectorId: 1 }, meterValue: meter(1000, 2000, 70) });
  const afterExport = (await ops('GET', `/v1/sessions/${sidA}`)).data;
  check('metering: a 2.1 trigger reason is accepted; the export register (2 kWh) and SoC (70 %) are recorded; energy charged is untouched',
    !updA.__error && Number(afterExport.energy_export_wh) === 2000 && Number(afterExport.soc_percent) === 70 && afterExport.operation_mode === 'CentralSetpoint' && Number(afterExport.energy_wh) === 0,
    { updA, e: afterExport.energy_export_wh, s: afterExport.soc_percent, m: afterExport.operation_mode, w: afterExport.energy_wh });

  // ─────────────────────────────────────────── an app driver decides for themselves
  const UID_B = `V2GB${RUN}`;
  await ops('POST', '/v1/tokens', { uid: UID_B, holderName: 'App driver', accountType: 'fleet', fleetName: `Plain Fleet ${RUN}`, pin: '482913' });
  const drv = await new Driver().init();
  const fl = await drv.post('/v1/fleet/login', { orgSlug: 'nusantara-charge', rfidUid: UID_B, pin: '482913' });
  const conn2 = (await drv.get(`/v1/resolve?code=${encodeURIComponent(ID + ':2')}`)).data.connectorId;
  const co = await drv.post('/v1/charge/fleet', { connectorId: conn2 });
  mark = Date.now();
  const startCmd = await drv.post(`/v1/charge/${co.data.chargeId}/start`);
  const rst = await st.seen((c) => c.at >= mark && c.action === 'RequestStartTransaction');
  const txB = `TXB-${RUN}`;
  await st.call('TransactionEvent', { eventType: 'Started', timestamp: iso(), triggerReason: 'RemoteStart', seqNo: 0,
    transactionInfo: { transactionId: txB, chargingState: 'Charging', remoteStartId: rst?.payload?.remoteStartId }, evse: { id: 2, connectorId: 1 },
    idToken: { idToken: UID_B, type: 'Central' }, meterValue: meter(500, 0, 75) });
  await st.call('StatusNotification', { timestamp: iso(), connectorStatus: 'Occupied', evseId: 2, connectorId: 1 });
  await st.call('NotifyEVChargingNeeds', needs(2, { dcChargingParameters: { stateOfCharge: 75, evEnergyCapacity: 58000 } }));
  const offered = await until(() => drv.get(`/v1/charge/${co.data.chargeId}/status`), (r) => r.data?.v2x?.canOffer === true, 10_000);
  check('app: a started 2.1 charge offers the driver to give energy back, with the credit and the site floor',
    fl.status === 200 && startCmd.status === 200 && offered.data.v2x?.canOffer === true && offered.data.v2x.consent === false && offered.data.v2x.creditMinorPerKwh === 2000 && offered.data.v2x.siteMinSocPercent === 40,
    { fl: fl.data, start: startCmd.data, v: offered.data.v2x });
  const noB = txPeriod(st, 2, mark);
  check('safety: without the driver\'s consent their car is never asked to discharge', !noB || noB.period?.operationMode !== 'CentralSetpoint', noB);
  const low = await drv.post(`/v1/charge/${co.data.chargeId}/v2x`, { enabled: true, minSocPercent: 30 });
  check('app: a floor below the site\'s is refused', low.status === 400 && /40%/.test(low.data.error), low.data);
  mark = Date.now();
  const yes = await drv.post(`/v1/charge/${co.data.chargeId}/v2x`, { enabled: true, minSocPercent: 60 });
  const allowed = await st.seen((c) => c.at >= mark && c.action === 'NotifyAllowedEnergyTransfer');
  check('app: the driver agrees with a 60 % floor; the station is told bidirectional transfer is allowed (NotifyAllowedEnergyTransfer)',
    yes.status === 200 && yes.data.v2x?.consent === true && yes.data.v2x.minSocPercent === 60 && allowed?.payload?.transactionId === txB && allowed.payload.allowedEnergyTransfer?.includes('DC_BPT'),
    { yes: yes.data, allowed: allowed?.payload });
  const shareA = await until(() => txPeriod(st!, 1, mark), (p) => p?.period?.setpoint === -7500, 15_000);
  const shareB = await until(() => txPeriod(st!, 2, mark), (p) => p?.period?.setpoint === -7500, 5_000);
  check('share: two cars split the 15 kW the building uses (7.5 kW each): nothing flows back to PLN', shareA?.period?.setpoint === -7500 && shareB?.period?.setpoint === -7500, { a: shareA?.period, b: shareB?.period });

  // ─────────────────────────────────────────── the floor, the driver's change of mind
  mark = Date.now();
  await st.call('TransactionEvent', { eventType: 'Updated', timestamp: iso(), triggerReason: 'MeterValuePeriodic', seqNo: 2,
    transactionInfo: { transactionId: txA, chargingState: 'Charging', operationMode: 'CentralSetpoint' }, evse: { id: 1, connectorId: 1 }, meterValue: meter(1000, 3000, 50) });
  const backA = await until(() => txPeriod(st!, 1, mark), (p) => !!p && p.period?.operationMode !== 'CentralSetpoint', 15_000);
  const upB = await until(() => txPeriod(st!, 2, mark), (p) => p?.period?.setpoint === -11000, 8_000);
  const whyA = (await ops('GET', `/v1/sessions/${sidA}`)).data?.v2x;
  check('floor: the fleet car reaching its 50 % floor goes straight back to charging; the other car takes up the load (11 kW)',
    !!backA && backA.period?.limit > 0 && backA.period.setpoint === undefined && upB?.period?.setpoint === -11000 && whyA?.discharging === false && /50%/.test(whyA.notDischargingBecause ?? ''),
    { a: backA?.period, b: upB?.period, why: whyA?.notDischargingBecause });
  mark = Date.now();
  const no = await drv.post(`/v1/charge/${co.data.chargeId}/v2x`, { enabled: false });
  const allowed2 = await st.seen((c) => c.at >= mark && c.action === 'NotifyAllowedEnergyTransfer');
  const backB = await until(() => txPeriod(st!, 2, mark), (p) => !!p && p.period?.operationMode !== 'CentralSetpoint', 15_000);
  check('app: withdrawing stops the discharge at once and tells the station DC only',
    no.status === 200 && no.data.v2x?.consent === false && JSON.stringify(allowed2?.payload?.allowedEnergyTransfer) === '["DC"]' && !!backB && backB.period?.limit > 0,
    { no: no.data, allowed: allowed2?.payload, b: backB?.period });

  // ─────────────────────────────────────────── hours, other smart-charging messages
  await ops('PUT', `/v1/sites/${siteId}`, { v2xMinSocPercent: 40 });
  await st.call('TransactionEvent', { eventType: 'Updated', timestamp: iso(), triggerReason: 'MeterValuePeriodic', seqNo: 3,
    transactionInfo: { transactionId: txA, chargingState: 'Charging' }, evse: { id: 1, connectorId: 1 }, meterValue: meter(1000, 3000, 70) });
  const hourNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const closed = `${String((hourNow + 2) % 24).padStart(2, '0')}:00-${String((hourNow + 3) % 24).padStart(2, '0')}:00`;
  mark = Date.now();
  const closeHours = await ops('PUT', `/v1/sites/${siteId}`, { v2xWindows: closed });
  const outside = await until(() => ops('GET', `/v1/sessions/${sidA}`), (r) => /outside/.test(r.data?.v2x?.notDischargingBecause ?? ''), 15_000);
  check('hours: outside the programme\'s hours no car discharges, and the console says why', closeHours.status === 200 && outside.data?.v2x?.discharging === false && /outside the discharge hours/.test(outside.data.v2x.notDischargingBecause), outside.data?.v2x);
  const sched = await st.call('NotifyEVChargingSchedule', { timeBase: iso(), evseId: 1, chargingSchedule: { id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 50000 }] } });
  const lim = await st.call('NotifyChargingLimit', { evseId: 1, chargingLimit: { chargingLimitSource: 'EMS', isGridCritical: true }, chargingSchedule: [] });
  const cleared = await st.call('ClearedChargingLimit', { chargingLimitSource: 'EMS', evseId: 1 });
  const rep = await st.call('ReportChargingProfiles', { requestId: 7, chargingLimitSource: 'CSO', evseId: 1, chargingProfile: [{ id: 5001, stackLevel: 5, chargingProfilePurpose: 'TxProfile', chargingProfileKind: 'Absolute', chargingSchedule: [] }] });
  const schedSeen = (await ops('GET', `/v1/sessions/${sidA}`)).data?.v2x?.needs?.evProposedSchedule;
  check('messages: NotifyEVChargingSchedule (Accepted, kept), NotifyChargingLimit, ClearedChargingLimit and ReportChargingProfiles are answered, not refused',
    sched.status === 'Accepted' && !lim.__error && !cleared.__error && !rep.__error && schedSeen === true, { sched, lim, cleared, rep, schedSeen });

  // ─────────────────────────────────────────── billing the fleet car
  await st.call('TransactionEvent', { eventType: 'Ended', timestamp: iso(), triggerReason: 'EVDeparted', seqNo: 4,
    transactionInfo: { transactionId: txA, chargingState: 'Idle', stoppedReason: 'EVDisconnected' }, evse: { id: 1, connectorId: 1 }, meterValue: meter(6000, 3000, 72) });
  const billed = await until(() => ops('GET', `/v1/sessions/${sidA}`), (r) => r.data?.total_minor != null, 15_000);
  const lines = billed.data?.lines ?? [];
  const credit = lines.filter((l: any) => l.adjustment?.source === 'v2x').reduce((a: number, l: any) => a + l.amountMinor, 0);
  const energy = lines.filter((l: any) => l.kind === 'energy' && !l.adjustment).reduce((a: number, l: any) => a + l.amountMinor, 0);
  check('billing: 5 kWh charged at Rp 2,400; 3 kWh given back credited Rp 6,000 before tax (PBJT-TL and PPN on the rest)',
    Number(billed.data?.energy_wh) === 5000 && energy === 12000 && credit === -6000 && billed.data.subtotal_minor === 6000 && billed.data.v2x?.creditMinor === 6000,
    { lines, sub: billed.data?.subtotal_minor, total: billed.data?.total_minor, v: billed.data?.v2x });
  const endedV = billed.data?.v2x;
  check('console: after the session, what it gave back stays on record', endedV?.exportWh === 3000 && endedV.discharging === false && endedV.canOffer === false, endedV);
  await st.call('TransactionEvent', { eventType: 'Ended', timestamp: iso(), triggerReason: 'EVDeparted', seqNo: 1,
    transactionInfo: { transactionId: txB, chargingState: 'Idle', stoppedReason: 'EVDisconnected' }, evse: { id: 2, connectorId: 1 }, meterValue: meter(4500, 0, 78) });
  await ops('PUT', `/v1/sites/${siteId}`, { v2xEnabled: false });
} catch (e) {
  check('no unexpected exception', false, (e as Error).stack);
} finally {
  st?.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
