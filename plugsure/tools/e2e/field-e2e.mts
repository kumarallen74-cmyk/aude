// PlugSure v1.3 — field-conditions end-to-end test.
//
// The console and driver suites prove the happy paths. This one drives raw
// OCPP 1.6 chargers through what real hardware does in the field: faults
// mid-charge, dropped connections, power loss and reboot, transactions recorded
// offline and uploaded later, retried (duplicate) frames, a meter that goes
// backwards, blocked cards, two drivers racing for one connector, the prepaid
// energy cut-off, reservations, vendor DataTransfer and malformed frames.
//
// Same prerequisites as console-e2e.mts. Then:
//     npx tsx tools/e2e/field-e2e.mts        (E2E_API / E2E_OCPP / E2E_PASSWORD override)
// NEVER point this at production.
import WebSocket from 'ws';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000, every = 400): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const iso = (offsetS = 0) => new Date(Date.now() + offsetS * 1000).toISOString();

let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
}
async function drv(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(API + '/d' + path, { method, headers: { authorization: 'Bearer ' + token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
}

class Raw {
  ws!: WebSocket;
  calls: Array<{ action: string; payload: any; at: number }> = [];
  handlers: Record<string, (p: any) => any> = {};
  pending = new Map<string, (v: any) => void>();
  n = 0;
  closedCode: number | null = null;
  constructor(public id: string, public version: 'ocpp1.6' | 'ocpp2.0.1' = 'ocpp1.6') {}
  async connect() {
    this.closedCode = null;
    this.ws = new WebSocket(`${OCPP}/${this.id}`, [this.version]);
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); this.ws.once('unexpected-response', (_q: any, r: any) => rej(new Error(`HTTP ${r.statusCode}`))); });
    this.ws.on('close', (code) => { this.closedCode = code; });
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f[0] === 2) {
        const [, uid, action, payload] = f;
        this.calls.push({ action, payload, at: Date.now() });
        const h = this.handlers[action];
        this.ws.send(JSON.stringify([3, uid, (h ? h(payload) : { status: 'Accepted' }) ?? {}]));
      } else if (f[0] === 3 || f[0] === 4) {
        this.pending.get(f[1])?.(f[0] === 3 ? f[2] : { __error: f[2], desc: f[3] });
        this.pending.delete(f[1]);
      }
    });
  }
  call(action: string, payload: unknown, uid?: string): Promise<any> {
    const id = uid ?? `${this.id}-${++this.n}`;
    return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify([2, id, action, payload])); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); res({ __timeout: true }); } }, 10_000); });
  }
  raw(text: string): Promise<any> {
    return new Promise((res) => { const on = (m: any) => { this.ws.off('message', on); res(JSON.parse(m.toString())); }; this.ws.on('message', on); this.ws.send(text); setTimeout(() => { this.ws.off('message', on); res({ __timeout: true }); }, 5000); });
  }
  waitFor(action: string, after = 0, ms = 15_000) { return until(async () => this.calls.find((c) => c.action === action && c.at >= after), (v) => !!v, ms, 200); }
  close() { try { this.ws.close(); } catch {} }
  kill() { try { this.ws.terminate(); } catch {} }
  boot(reason?: string) { return this.call('BootNotification', { chargePointVendor: 'FieldSim', chargePointModel: 'FS-DC-60', firmwareVersion: '1.0.0', ...(reason ? {} : {}) }); }
  status(connectorId: number, status: string, errorCode = 'NoError', extra: Record<string, unknown> = {}) { return this.call('StatusNotification', { connectorId, errorCode, status, timestamp: iso(), ...extra }); }
  start(connectorId: number, idTag: string, meterStart: number, timestamp = iso()) { return this.call('StartTransaction', { connectorId, idTag, meterStart, timestamp }); }
  meter(connectorId: number, transactionId: number, wh: number, timestamp = iso(), powerW?: number) {
    const sv: any[] = [{ value: String(wh), measurand: 'Energy.Active.Import.Register', unit: 'Wh', context: 'Sample.Periodic' }];
    if (powerW != null) sv.push({ value: String(powerW), measurand: 'Power.Active.Import', unit: 'W', context: 'Sample.Periodic' });
    return this.call('MeterValues', { connectorId, transactionId, meterValue: [{ timestamp, sampledValue: sv }] });
  }
  stop(transactionId: number, meterStop: number, reason = 'Local', timestamp = iso()) { return this.call('StopTransaction', { transactionId, meterStop, timestamp, reason }); }
}

async function sessionByTx(identity: string, tx: number | string) {
  const r = await ops('GET', `/v1/sessions/search?identity=${encodeURIComponent(identity)}&q=${tx}&limit=5`);
  const rows = r.data?.rows ?? [];
  return rows.find((x: any) => String(x.ocpp_transaction_id) === String(tx)) ?? null;
}
async function sessionsOn(identity: string) {
  const r = await ops('GET', `/v1/sessions/search?identity=${encodeURIComponent(identity)}&limit=200`);
  return r.data?.rows ?? [];
}

const raws: Raw[] = [];
try {
  // ------------------------------------------------------------ setup
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  const site = await ops('POST', '/v1/sites', { name: 'Field E2E Hub', address: 'Jl. Sudirman', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000' });
  const siteId = site.data.id as string;
  const tariff = await ops('POST', '/v1/tariffs', { name: 'Field E2E DC', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true,
    components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }, { kind: 'session', rate: 5000, touBlock: 'ANY' }, { kind: 'idle', rate: 1000, touBlock: 'ANY', fromMinutes: 1, toMinutes: 60 }] });
  await ops('PUT', `/v1/sites/${siteId}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  const ID = `FIELD-${Date.now().toString().slice(-6)}`;
  const reg = await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId, displayName: 'Field Sim DC', ocppVersion: 'ocpp1.6',
    evses: [1, 2].map((e) => ({ evseId: e, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] })) });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  check('setup: site, tariff (with idle fee) and a 2-connector 1.6 charger', reg.status === 200 && tariff.status === 200, { reg: reg.data, t: tariff.data });

  const c = new Raw(ID); raws.push(c);
  await c.connect();
  const b = await c.boot();
  check('boot: accepted with a heartbeat interval', b.status === 'Accepted' && b.interval > 0, b);
  await c.status(1, 'Available'); await c.status(2, 'Available');

  // ------------------------------------------------------------ 1. normal session, idle fee
  {
    const s = await c.start(1, 'ID-RFID-0001', 100_000, iso(-600));
    check('1. RFID start accepted, transactionId issued', s.idTagInfo?.status === 'Accepted' && s.transactionId > 0, s);
    await c.status(1, 'Charging');
    await c.meter(1, s.transactionId, 104_000, iso(-300), 48_000);
    await c.meter(1, s.transactionId, 108_000, iso(-240), 48_000);
    await c.status(1, 'SuspendedEV');
    await c.stop(s.transactionId, 108_000, 'EVDisconnected', iso(-60));
    await c.status(1, 'Finishing'); await c.status(1, 'Available');
    const row = await until(() => sessionByTx(ID, s.transactionId), (r) => r?.total_minor != null, 20_000);
    check('1. session rated: 8.000 kWh billed from meter registers', row && Number(row.energy_wh) === 8000 && row.total_minor > 0, row && { e: row.energy_wh, t: row.total_minor, rev: row.review_reason });
  }

  // ------------------------------------------------------------ 2. fault mid-session
  {
    const s = await c.start(2, 'ID-RFID-0001', 200_000);
    await c.status(2, 'Charging');
    await c.meter(2, s.transactionId, 201_500);
    const fault = await c.status(2, 'Faulted', 'GroundFailure', { vendorErrorCode: 'E-GF-12', info: 'RCD tripped' });
    check('2. mid-charge Faulted status accepted', !fault.__error, fault);
    const alerts = await until(() => ops('GET', '/v1/alerts'), (r) => (r.data ?? []).some((a: any) => a.kind === 'connector.faulted' && a.message.includes(ID)), 8000);
    check('2. operator alert raised with the vendor error code', (alerts.data ?? []).some((a: any) => a.kind === 'connector.faulted' && a.message.includes('E-GF-12')), alerts.data?.slice?.(0, 2));
    await c.stop(s.transactionId, 201_500, 'Other');
    const row = await until(() => sessionByTx(ID, s.transactionId), (r) => r?.state && r.state !== 'active', 15_000);
    check('2. faulted session is closed and billed for the 1.5 kWh actually delivered', row && row.state !== 'active' && Number(row.energy_wh) === 1500, row && { st: row.state, e: row.energy_wh, stop: row.stop_reason });
    await c.status(2, 'Available');
  }

  // ------------------------------------------------------------ 3. connection drop mid-session, reconnect, continue
  {
    const s = await c.start(1, 'ID-RFID-0001', 300_000);
    await c.status(1, 'Charging');
    await c.meter(1, s.transactionId, 302_000);
    c.kill(); // abrupt TCP loss, no close frame
    const off = await until(() => ops('GET', '/v1/charge-points'), (r) => r.data?.find?.((x: any) => x.ocpp_identity === ID)?.online === false, 10_000, 500);
    check('3. dropped charger shows offline to the operator', off.data?.find?.((x: any) => x.ocpp_identity === ID)?.online === false);
    const liveRow = await sessionByTx(ID, s.transactionId);
    check('3. the session stays active while the charger is offline (not closed early)', liveRow?.state === 'active', liveRow?.state);
    await sleep(500);
    await c.connect(); await c.boot(); await c.status(1, 'Charging');
    await c.meter(1, s.transactionId, 305_000);
    await c.stop(s.transactionId, 306_000, 'Local');
    const row = await until(() => sessionByTx(ID, s.transactionId), (r) => r?.total_minor != null, 20_000);
    const all = (await sessionsOn(ID)).filter((x: any) => String(x.ocpp_transaction_id) === String(s.transactionId));
    check('3. after reconnect the same transaction continues: one session, 6.000 kWh', all.length === 1 && Number(row?.energy_wh) === 6000, { n: all.length, e: row?.energy_wh });
    await c.status(1, 'Available');
  }

  // ------------------------------------------------------------ 4. power loss: reboot, then StopTransaction(PowerLoss) for the old tx
  {
    const s = await c.start(2, 'ID-RFID-0001', 400_000);
    await c.status(2, 'Charging');
    await c.meter(2, s.transactionId, 402_500);
    c.kill();
    await sleep(400);
    await c.connect();
    const b2 = await c.call('BootNotification', { chargePointVendor: 'FieldSim', chargePointModel: 'FS-DC-60', firmwareVersion: '1.0.0' });
    const st = await c.stop(s.transactionId, 402_700, 'PowerLoss', iso(-5));
    check('4. after power loss the charger re-boots and uploads the interrupted stop', b2.status === 'Accepted' && !st.__error, { b2, st });
    const row = await until(() => sessionByTx(ID, s.transactionId), (r) => r?.state && r.state !== 'active', 15_000);
    check('4. interrupted session closed with reason PowerLoss and 2.700 kWh', row?.stop_reason === 'PowerLoss' && Number(row?.energy_wh) === 2700, row && { st: row.state, r: row.stop_reason, e: row.energy_wh });
    await c.status(2, 'Available');
  }

  // ------------------------------------------------------------ 5. offline transaction uploaded later (past timestamps)
  {
    const startAt = iso(-3600), stopAt = iso(-1800);
    const s = await c.start(1, 'ID-RFID-0001', 500_000, startAt);
    await c.stop(s.transactionId, 507_500, 'Local', stopAt);
    const row = await until(() => sessionByTx(ID, s.transactionId), (r) => r?.total_minor != null, 20_000);
    const durMin = row ? Math.round((new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60000) : null;
    check('5. offline session keeps the charger\'s own start/stop times (30 min) and bills 7.5 kWh', durMin === 30 && Number(row?.energy_wh) === 7500, { durMin, e: row?.energy_wh, s: row?.started_at });
  }

  // ------------------------------------------------------------ 6. duplicate frames (lost responses → retries)
  {
    const ts = iso();
    const a = await c.start(2, 'ID-RFID-0001', 600_000, ts);
    const a2 = await c.start(2, 'ID-RFID-0001', 600_000, ts);
    check('6. retried StartTransaction returns the SAME transactionId', a.transactionId > 0 && a.transactionId === a2.transactionId, { a: a.transactionId, a2: a2.transactionId });
    await c.meter(2, a.transactionId, 601_000);
    const stopTs = iso();
    await c.stop(a.transactionId, 602_000, 'Local', stopTs);
    await c.stop(a.transactionId, 602_000, 'Local', stopTs);
    await sleep(2500);
    const rows = (await sessionsOn(ID)).filter((x: any) => String(x.ocpp_transaction_id) === String(a.transactionId));
    check('6. retried StopTransaction does not double-bill (one session, one CDR, 2 kWh)', rows.length === 1 && Number(rows[0]?.energy_wh) === 2000 && rows[0]?.total_minor > 0, rows.map((r: any) => ({ e: r.energy_wh, t: r.total_minor })));
  }

  // ------------------------------------------------------------ 7. meter goes backwards (register reset / swap)
  {
    const s = await c.start(1, 'ID-RFID-0001', 700_000);
    await c.meter(1, s.transactionId, 703_000);
    await c.meter(1, s.transactionId, 1_200); // register reset mid-session
    await c.stop(s.transactionId, 2_400, 'Local');
    const row = await until(() => sessionByTx(ID, s.transactionId), (r) => r?.state && r.state !== 'active', 15_000);
    const e = Number(row?.energy_wh);
    check('7. a meter reset never bills a negative or wrapped-around amount', row && e >= 0 && e < 50_000, row && { e, rev: row.review_reason, st: row.state });
    check('7. the session is flagged for operator review', !!row?.needs_review, row && { needs: row.needs_review, rev: row.review_reason });
  }

  // ------------------------------------------------------------ 8. blocked and unknown cards
  {
    const blocked = await c.call('Authorize', { idTag: 'ID-RFID-BLOCKED' });
    const unknown = await c.call('Authorize', { idTag: 'NO-SUCH-CARD-99' });
    check('8. Authorize: blocked card → Blocked, unknown card → Invalid', blocked.idTagInfo?.status === 'Blocked' && unknown.idTagInfo?.status === 'Invalid', { blocked, unknown });
    const before = (await sessionsOn(ID)).length;
    const st = await c.start(2, 'ID-RFID-BLOCKED', 800_000);
    await sleep(800);
    const after = (await sessionsOn(ID)).length;
    check('8. StartTransaction with a blocked card is refused and opens no billable session', st.idTagInfo?.status === 'Blocked' && after === before, { st, before, after });
  }

  // ------------------------------------------------------------ 9. vendor DataTransfer + malformed frames keep the connection
  {
    const dt = await c.call('DataTransfer', { vendorId: 'com.example.vendor', messageId: 'Telemetry', data: '{"temp":41}' });
    check('9. unknown vendor DataTransfer answered UnknownVendorId', dt.status === 'UnknownVendorId', dt);
    const bad = await c.raw('[2,"bad-1","StatusNotification",{"connectorId":1,"status":"NotAStatus","errorCode":"NoError"}]');
    check('9. schema-invalid frame gets a CALLERROR, not a disconnect', Array.isArray(bad) && bad[0] === 4 && c.closedCode === null, bad);
    const garbage = await c.raw('this is not json');
    const hb = await c.call('Heartbeat', {});
    check('9. after garbage input the charger is still connected and served', !!hb.currentTime && c.closedCode === null, { garbage, hb, closed: c.closedCode });
  }

  // ------------------------------------------------------------ 10. charger clock far in the future
  {
    const future = iso(3 * 24 * 3600);
    const s = await c.start(1, 'ID-RFID-0001', 900_000, future);
    await c.stop(s.transactionId, 901_000, 'Local', iso(3 * 24 * 3600 + 600));
    const row = await until(() => sessionByTx(ID, s.transactionId), (r) => r?.state && r.state !== 'active', 15_000);
    check('10. a session stamped 3 days in the future is caught for review, not silently billed', !!row?.needs_review || (row && new Date(row.started_at).getTime() < Date.now() + 3600_000), row && { s: row.started_at, rev: row.review_reason, needs: row.needs_review });
  }

  // ------------------------------------------------------------ 11. reservation
  {
    c.handlers.ReserveNow = () => ({ status: 'Accepted' });
    const t0 = Date.now();
    const r = await ops('POST', `/v1/charge-points/${ID}/commands/reserve-now`, { connectorId: 2, idTag: 'ID-RFID-0001', expiryDate: iso(900), reservationId: 7001 });
    const got = await c.waitFor('ReserveNow', t0, 8000);
    check('11. operator reservation reaches the charger as ReserveNow', r.status === 200 && got?.payload?.reservationId === 7001 && got.payload.idTag === 'ID-RFID-0001', { r: r.data, got: got?.payload });
    c.handlers.CancelReservation = () => ({ status: 'Accepted' });
    const t1 = Date.now();
    const cr = await ops('POST', `/v1/charge-points/${ID}/commands/cancel-reservation`, { reservationId: 7001 });
    const gc = await c.waitFor('CancelReservation', t1, 8000);
    check('11. reservation can be cancelled', cr.status === 200 && gc?.payload?.reservationId === 7001, { cr: cr.data });
  }

  // ------------------------------------------------------------ 12. two drivers race for one connector; prepaid energy cut-off
  {
    const dA = await (await fetch(API + '/d/v1/device', { method: 'POST' })).json();
    const dB = await (await fetch(API + '/d/v1/device', { method: 'POST' })).json();
    const res = await (await fetch(API + `/d/v1/resolve?code=${encodeURIComponent(ID + ':1')}`)).json();
    const conn = res.connectorId as string;
    const coA = await drv('POST', '/v1/charge/prepaid', dA.deviceToken, { connectorId: conn, amountMinor: 20000 });
    const coB = await drv('POST', '/v1/charge/prepaid', dB.deviceToken, { connectorId: conn, amountMinor: 20000 });
    await drv('POST', `/v1/charge/${coA.data.chargeId}/confirm-payment`, dA.deviceToken);
    await drv('POST', `/v1/charge/${coB.data.chargeId}/confirm-payment`, dB.deviceToken);
    // Charger accepts the first remote start; the second finds the connector occupied.
    let busy = false;
    c.handlers.RemoteStartTransaction = () => { if (busy) return { status: 'Rejected' }; busy = true; return { status: 'Accepted' }; };
    const t0 = Date.now();
    const stA = await drv('POST', `/v1/charge/${coA.data.chargeId}/start`, dA.deviceToken);
    const stB = await drv('POST', `/v1/charge/${coB.data.chargeId}/start`, dB.deviceToken);
    check('12. first paid driver\'s remote start is accepted', stA.data?.status === 'Accepted', stA.data);
    check('12. second paid driver is told clearly the charger declined (not a silent hang)', stB.status === 200 && stB.data?.status !== 'Accepted', stB.data);
    const rs = await c.waitFor('RemoteStartTransaction', t0, 8000);
    const tag = rs?.payload?.idTag;
    const s = await c.start(1, tag, 1_000_000);
    await c.status(1, 'Charging');
    const allowanceWh = coA.data.allowanceWh as number;
    c.handlers.RemoteStopTransaction = () => ({ status: 'Accepted' });
    c.handlers.SetChargingProfile = () => ({ status: 'Accepted' });
    const tStop = Date.now();
    await c.meter(1, s.transactionId, 1_000_000 + Math.round(allowanceWh * 0.5));
    await c.meter(1, s.transactionId, 1_000_000 + Math.round(allowanceWh * 0.95));
    await c.meter(1, s.transactionId, 1_000_000 + allowanceWh + 50);
    const stopCmd = await c.waitFor('RemoteStopTransaction', tStop, 10_000);
    check('12. platform stops the charge itself when the prepaid energy is used up', stopCmd?.payload?.transactionId === s.transactionId, { allowanceWh, got: stopCmd?.payload });
    await c.stop(s.transactionId, 1_000_000 + allowanceWh + 50, 'Remote');
    await c.status(1, 'Available');
    // The second driver paid but never charged: that money must be visible for refund.
    const hist = await drv('GET', `/v1/charge/${coB.data.chargeId}/status`, dB.deviceToken);
    check('12. the second driver\'s unused payment is visible (paid, awaiting start), not lost', hist.status === 200 && hist.data?.state === 'awaiting_start', hist.data);
    (globalThis as any).__unusedCharge = { chargeId: coB.data.chargeId, token: dB.deviceToken };
  }

  // ------------------------------------------------------------ 14. idle (overstay) fee
  {
    // Car full after 30 s, stays plugged in until the stop 4 min later. The tariff
    // charges Rp 1,000/min idle from minute 1.
    const s = await c.start(2, 'ID-RFID-0001', 1_500_000, iso());
    await c.meter(2, s.transactionId, 1_503_000, iso(30));
    await c.meter(2, s.transactionId, 1_503_000, iso(150));
    await c.stop(s.transactionId, 1_503_000, 'EVDisconnected', iso(270));
    const row = await until(() => sessionByTx(ID, s.transactionId), (r) => r?.total_minor != null, 20_000);
    // The explorer returns the frozen CDR as a breakdown (energy / service / idle / taxes).
    check('14. overstay after the battery is full is billed as an idle fee', row && Number(row.idle_minutes) >= 3 && row.breakdown?.idleFeeMinor > 0, row && { idle: row.idle_minutes, breakdown: row.breakdown });
  }

  // ------------------------------------------------------------ 15–17. OCPP 2.0.1 field behaviour
  {
    const ID2 = `FIELD201-${Date.now().toString().slice(-6)}`;
    await ops('POST', '/v1/charge-points', { ocppIdentity: ID2, siteId, displayName: 'Field Sim 2.0.1', ocppVersion: 'ocpp2.0.1',
      evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
    await ops('POST', `/v1/charge-points/${ID2}/activate`);
    const s2 = new Raw(ID2, 'ocpp2.0.1'); raws.push(s2);
    await s2.connect();
    await s2.call('BootNotification', { reason: 'PowerUp', chargingStation: { model: 'FS-201', vendorName: 'FieldSim', firmwareVersion: '2.0.0' } });
    await s2.call('StatusNotification', { timestamp: iso(), connectorStatus: 'Available', evseId: 1, connectorId: 1 });
    const mv = (wh: number, ts: string) => [{ timestamp: ts, sampledValue: [{ value: wh, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' } }] }];
    const te = (eventType: string, seqNo: number, txId: string, wh: number, ts: string, extra: Record<string, unknown> = {}) =>
      s2.call('TransactionEvent', { eventType, timestamp: ts, triggerReason: eventType === 'Started' ? 'Authorized' : eventType === 'Ended' ? 'EVDeparted' : 'MeterValuePeriodic', seqNo,
        transactionInfo: { transactionId: txId, ...(eventType === 'Ended' ? { stoppedReason: 'EVDisconnected' } : {}) }, evse: { id: 1, connectorId: 1 }, meterValue: mv(wh, ts), ...extra });

    // 15. transaction recorded offline, uploaded after reconnect with offline:true
    const TXO = `OFF-${Date.now().toString(36)}`;
    const st = await te('Started', 0, TXO, 10_000, iso(-2400), { offline: true, idToken: { idToken: 'ID-RFID-0001', type: 'ISO14443' } });
    await te('Updated', 1, TXO, 14_000, iso(-1800), { offline: true });
    await te('Ended', 2, TXO, 16_500, iso(-1200), { offline: true });
    const r15 = await until(() => sessionByTx(ID2, TXO), (r) => r?.total_minor != null, 20_000);
    const dur15 = r15 ? Math.round((new Date(r15.ended_at).getTime() - new Date(r15.started_at).getTime()) / 60000) : null;
    check('15. 2.0.1 offline transaction (offline:true) is billed with its original 20-min window and 6.5 kWh', st?.idTokenInfo?.status === 'Accepted' && dur15 === 20 && Number(r15?.energy_wh) === 6500, { st, dur15, e: r15?.energy_wh });

    // 16. retried Started event (response lost) must not open a second session
    const TXD = `DUP-${Date.now().toString(36)}`; const tsD = iso();
    await te('Started', 0, TXD, 20_000, tsD, { idToken: { idToken: 'ID-RFID-0001', type: 'ISO14443' } });
    await te('Started', 0, TXD, 20_000, tsD, { idToken: { idToken: 'ID-RFID-0001', type: 'ISO14443' } });
    await te('Ended', 1, TXD, 21_000, iso(60));
    await sleep(1500);
    const dups = (await sessionsOn(ID2)).filter((x: any) => x.ocpp_transaction_id === TXD);
    check('16. 2.0.1 retried TransactionEvent(Started) → exactly one session, 1 kWh', dups.length === 1 && Number(dups[0]?.energy_wh) === 1000, dups.map((d: any) => ({ e: d.energy_wh, st: d.state })));

    // 17. Ended with no Started ever received (buffer lost on the station)
    const TXE = `ORPH-${Date.now().toString(36)}`;
    const e17 = await te('Ended', 3, TXE, 33_000, iso(-60), { idToken: { idToken: 'ID-RFID-0001', type: 'ISO14443' } });
    await sleep(1500);
    const r17 = await sessionByTx(ID2, TXE);
    check('17. an Ended event for an unknown transaction is answered (no crash) and surfaced for review, not billed blind', !e17?.__error && (!r17 || r17.needs_review || r17.total_minor == null), { e17, r17: r17 && { st: r17.state, rev: r17.review_reason, t: r17.total_minor } });

    // 18. prepaid energy cut-off on a 2.0.1 station (transaction ids are strings there)
    const dv = await (await fetch(API + '/d/v1/device', { method: 'POST' })).json();
    const res18 = await (await fetch(API + `/d/v1/resolve?code=${encodeURIComponent(ID2 + ':1')}`)).json();
    const co18 = await drv('POST', '/v1/charge/prepaid', dv.deviceToken, { connectorId: res18.connectorId, amountMinor: 20000 });
    await drv('POST', `/v1/charge/${co18.data.chargeId}/confirm-payment`, dv.deviceToken);
    s2.handlers.RequestStartTransaction = () => ({ status: 'Accepted' });
    s2.handlers.RequestStopTransaction = () => ({ status: 'Accepted' });
    s2.handlers.SetChargingProfile = () => ({ status: 'Accepted' });
    const t18 = Date.now();
    await drv('POST', `/v1/charge/${co18.data.chargeId}/start`, dv.deviceToken);
    const rs18 = await s2.waitFor('RequestStartTransaction', t18, 8000);
    const TXP = `PRE-${Date.now().toString(36)}`; const allow = co18.data.allowanceWh as number;
    await te('Started', 0, TXP, 50_000, iso(), { idToken: rs18?.payload?.idToken ?? { idToken: co18.data.startToken, type: 'Central' } });
    await te('Updated', 1, TXP, 50_000 + Math.round(allow * 0.95), iso(20));
    await te('Updated', 2, TXP, 50_000 + allow + 50, iso(40));
    const stop18 = await s2.waitFor('RequestStopTransaction', t18, 10_000);
    check('18. 2.0.1 prepaid: platform stops the charge at the paid allowance (string transactionId)', stop18?.payload?.transactionId === TXP, { allow, got: stop18?.payload });
    const prof18 = s2.calls.find((x) => x.action === 'SetChargingProfile' && x.at >= t18);
    check('18. 2.0.1 prepaid: the 90% ramp-down profile is addressed to the string transaction', !prof18 || prof18.payload?.chargingProfile?.transactionId === TXP, prof18?.payload);
    await te('Ended', 3, TXP, 50_000 + allow + 50, iso(60));

    // 19. messages every production 2.0.1 station sends that used to be refused as NotImplemented
    const rsu = await s2.call('ReservationStatusUpdate', { reservationId: 7002, reservationUpdateStatus: 'Expired' });
    const mvx = await s2.call('MeterValues', { evseId: 0, meterValue: mv(1_234_000, iso()) });
    const nr = await s2.call('NotifyReport', { requestId: 1, generatedAt: iso(), seqNo: 0, tbc: false, reportData: [] });
    check('19. 2.0.1 ReservationStatusUpdate / MeterValues / NotifyReport are acknowledged', !rsu.__error && !mvx.__error && !nr.__error, { rsu, mvx, nr });
    const ne = await s2.call('NotifyEvent', { generatedAt: iso(), seqNo: 0, eventData: [
      { eventId: 11, timestamp: iso(), trigger: 'Alerting', actualValue: '92', techCode: 'OVT-3', eventNotificationType: 'HardWiredMonitor', component: { name: 'PowerModule', instance: '2' }, variable: { name: 'Temperature' } },
      { eventId: 12, timestamp: iso(), trigger: 'Periodic', actualValue: '41', eventNotificationType: 'PreconfiguredMonitor', component: { name: 'EVSE' }, variable: { name: 'Temperature' } },
    ] });
    const al19 = await until(() => ops('GET', '/v1/alerts'), (r) => (r.data ?? []).some((a: any) => a.kind === 'charge_point.device_event' && a.message.includes(ID2)), 8000);
    const devAlerts = (al19.data ?? []).filter((a: any) => a.kind === 'charge_point.device_event' && a.message.includes(ID2));
    check('19. 2.0.1 NotifyEvent: a monitor in Alerting raises ONE operator alert (periodic readings do not)', !ne.__error && devAlerts.length === 1 && devAlerts[0].message.includes('OVT-3'), { ne, devAlerts });

    // 19b. the device model: report in parts, validated SetVariables, GetVariables, monitors, cleared events
    const DM = `/v1/charge-points/${encodeURIComponent(ID2)}/device-model`;
    const part0 = [
      { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' }, variableAttribute: [{ type: 'Actual', value: '300', mutability: 'ReadWrite' }], variableCharacteristics: { dataType: 'integer', unit: 's', minLimit: 30, maxLimit: 3600, supportsMonitoring: false } },
      { component: { name: 'EVSE', evse: { id: 1 } }, variable: { name: 'Power' }, variableAttribute: [{ type: 'Actual', value: '7200', mutability: 'ReadOnly' }, { type: 'MaxSet', value: '22000', mutability: 'ReadOnly' }], variableCharacteristics: { dataType: 'decimal', unit: 'W', maxLimit: 22000, supportsMonitoring: true } },
      { component: { name: 'SecurityCtrlr' }, variable: { name: 'SecurityProfile' }, variableAttribute: [{ type: 'Actual', value: '2', mutability: 'ReadWrite' }], variableCharacteristics: { dataType: 'integer', supportsMonitoring: false } },
    ];
    const part1 = [
      { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxUpdatedMeasurands' }, variableAttribute: [{ value: 'Energy.Active.Import.Register' }], variableCharacteristics: { dataType: 'MemberList', valuesList: 'Energy.Active.Import.Register,Power.Active.Import,SoC', supportsMonitoring: false } },
      { component: { name: 'Connector', evse: { id: 1, connectorId: 1 } }, variable: { name: 'ConnectorType' }, variableAttribute: [{ value: 'cCCS2', mutability: 'ReadOnly' }], variableCharacteristics: { dataType: 'OptionList', valuesList: 'cCCS2,cType2', supportsMonitoring: false } },
    ];
    // A quick station: its first part arrives before it has answered GetBaseReport.
    s2.handlers.GetBaseReport = (p: any) => {
      void s2.call('NotifyReport', { requestId: p.requestId, generatedAt: iso(), seqNo: 0, tbc: true, reportData: part0 })
        .then(() => s2.call('NotifyReport', { requestId: p.requestId, generatedAt: iso(), seqNo: 1, tbc: false, reportData: part1 }));
      return { status: 'Accepted' };
    };
    const rep = await ops('POST', `${DM}/report`, { reportBase: 'FullInventory' });
    const dm1 = await until(() => ops('GET', DM), (r) => r.data?.reports?.[0]?.status === 'complete', 8000);
    const hb = dm1.data?.components?.find((c: any) => c.name === 'OCPPCommCtrlr')?.variables?.find((v: any) => v.name === 'HeartbeatInterval');
    const sec = dm1.data?.components?.find((c: any) => c.name === 'SecurityCtrlr')?.variables?.[0];
    check('19b. GetBaseReport: the report arrives in two parts, is stored per component (EVSE and connector kept) and completes',
      rep.status === 200 && dm1.data?.supported === true && dm1.data?.variables === 5 && dm1.data.reports[0].items === 5 && hb?.attributes?.[0]?.value === '300'
      && dm1.data.components.some((c: any) => c.name === 'Connector' && c.evseId === 1 && c.connectorId === 1) && sec?.protected === true,
      { rep: rep.data, dm: dm1.data && { v: dm1.data.variables, r: dm1.data.reports?.[0], comps: dm1.data.components?.map((c: any) => c.name) } });

    const t19 = Date.now();
    s2.handlers.SetVariables = (p: any) => ({ setVariableResult: p.setVariableData.map((d: any) => ({
      attributeStatus: d.variable.name === 'TxUpdatedMeasurands' ? 'RebootRequired' : 'Accepted', attributeType: d.attributeType, component: d.component, variable: d.variable,
    })) });
    const low = await ops('PUT', `${DM}/variable`, { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', value: '10' });
    const secSet = await ops('PUT', `${DM}/variable`, { component: 'SecurityCtrlr', variable: 'SecurityProfile', value: '0' });
    const roSet = await ops('PUT', `${DM}/variable`, { component: 'EVSE', evseId: 1, variable: 'Power', value: '1000' });
    const badList = await ops('PUT', `${DM}/variable`, { component: 'SampledDataCtrlr', variable: 'TxUpdatedMeasurands', value: 'SoC,Voltage' });
    await sleep(300);
    const sentEarly = s2.calls.filter((x) => x.action === 'SetVariables' && x.at >= t19).length;
    check('19b. SetVariables is checked first: below the minimum, a security variable, a read-only one, a value outside the list → 400, nothing sent',
      low.status === 400 && /At least 30/.test(low.data?.error ?? JSON.stringify(low.data)) && secSet.status === 400 && roSet.status === 400 && badList.status === 400 && sentEarly === 0,
      { low: low.data, secSet: secSet.data, roSet: roSet.data, badList: badList.data, sentEarly });
    const setHb = await ops('PUT', `${DM}/variable`, { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', value: '600' });
    const setTx = await ops('PUT', `${DM}/variable`, { component: 'SampledDataCtrlr', variable: 'TxUpdatedMeasurands', value: 'Energy.Active.Import.Register,SoC' });
    const sv = s2.calls.find((x) => x.action === 'SetVariables' && x.at >= t19);
    const dm2 = await ops('GET', DM);
    const hb2 = dm2.data?.components?.find((c: any) => c.name === 'OCPPCommCtrlr')?.variables?.[0];
    check('19b. SetVariables: accepted values are sent in 2.0.1 form and stored; RebootRequired is reported',
      setHb.data?.ok === true && setHb.data?.status === 'Accepted' && sv?.payload?.setVariableData?.[0]?.attributeValue === '600' && sv?.payload?.setVariableData?.[0]?.component?.name === 'OCPPCommCtrlr'
      && hb2?.attributes?.find((a: any) => a.type === 'Actual')?.value === '600' && setTx.data?.rebootRequired === true,
      { setHb: setHb.data, setTx: setTx.data, sv: sv?.payload, hb2 });

    s2.handlers.GetVariables = (p: any) => ({ getVariableResult: p.getVariableData.map((d: any) => d.variable.name === 'HeartbeatInterval'
      ? { attributeStatus: 'Accepted', attributeType: 'Actual', attributeValue: '900', component: d.component, variable: d.variable }
      : { attributeStatus: 'UnknownVariable', component: d.component, variable: d.variable }) });
    const gv = await ops('POST', `${DM}/get`, { items: [{ component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval' }, { component: 'OCPPCommCtrlr', variable: 'NoSuchThing' }] });
    const dm3 = await ops('GET', DM);
    const hb3 = dm3.data?.components?.find((c: any) => c.name === 'OCPPCommCtrlr')?.variables?.find((v: any) => v.name === 'HeartbeatInterval');
    check('19b. GetVariables: the station\'s current value is shown and stored; unknown variables come back as such',
      gv.data?.results?.[0]?.value === '900' && gv.data?.results?.[1]?.status === 'UnknownVariable' && hb3?.attributes?.[0]?.value === '900' && !dm3.data?.components?.some((c: any) => c.variables.some((v: any) => v.name === 'NoSuchThing')),
      { gv: gv.data, hb3 });

    s2.handlers.SetVariableMonitoring = (p: any) => ({ setMonitoringResult: p.setMonitoringData.map((d: any) => ({ id: 17, status: 'Accepted', type: d.type, severity: d.severity, component: d.component, variable: d.variable })) });
    const monNo = await ops('POST', `${DM}/monitors`, { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', type: 'Delta', value: 10, severity: 5 });
    const monBad = await ops('POST', `${DM}/monitors`, { component: 'EVSE', evseId: 1, variable: 'Power', type: 'Periodic', value: 0, severity: 5 });
    const mon = await ops('POST', `${DM}/monitors`, { component: 'EVSE', evseId: 1, variable: 'Power', type: 'UpperThreshold', value: 22000, severity: 4 });
    const svm = s2.calls.find((x) => x.action === 'SetVariableMonitoring' && x.at >= t19);
    check('19b. SetVariableMonitoring: refused for a variable without monitoring and a zero interval; an upper threshold is set on EVSE 1',
      monNo.status === 400 && monBad.status === 400 && mon.data?.ok === true && mon.data?.id === 17 && svm?.payload?.setMonitoringData?.[0]?.component?.evse?.id === 1 && svm?.payload?.setMonitoringData?.[0]?.value === 22000,
      { monNo: monNo.data, monBad: monBad.data, mon: mon.data, svm: svm?.payload });

    s2.handlers.GetMonitoringReport = (p: any) => {
      void s2.call('NotifyMonitoringReport', { requestId: p.requestId, generatedAt: iso(), seqNo: 0, tbc: false, monitor: [
        { component: { name: 'PowerModule', instance: '2' }, variable: { name: 'Temperature' }, variableMonitoring: [{ id: 1, transaction: false, value: 85, type: 'UpperThreshold', severity: 2, eventNotificationType: 'HardWiredMonitor' }] },
        { component: { name: 'EVSE', evse: { id: 1 } }, variable: { name: 'Power' }, variableMonitoring: [{ id: 17, transaction: false, value: 22000, type: 'UpperThreshold', severity: 4, eventNotificationType: 'CustomMonitor' }] },
      ] });
      return { status: 'Accepted' };
    };
    const mrep = await ops('POST', `${DM}/monitoring-report`, {});
    const dm4 = await until(() => ops('GET', DM), (r) => r.data?.reports?.[0]?.kind === 'monitoring' && r.data.reports[0].status === 'complete', 8000);
    check('19b. GetMonitoringReport: the station\'s monitors (hard-wired and ours) are listed',
      mrep.status === 200 && JSON.stringify((dm4.data?.monitors ?? []).map((m: any) => [m.id, m.kind]).sort()) === JSON.stringify([[1, 'HardWiredMonitor'], [17, 'CustomMonitor']]),
      { mrep: mrep.data, mons: dm4.data?.monitors });
    s2.handlers.ClearVariableMonitoring = (p: any) => ({ clearMonitoringResult: p.id.map((id: number) => ({ id, status: 'Accepted' })) });
    const del = await ops('DELETE', `${DM}/monitors/17`);
    const dm5 = await ops('GET', DM);
    check('19b. ClearVariableMonitoring removes the monitor here and on the station',
      del.data?.ok === true && s2.calls.some((x) => x.action === 'ClearVariableMonitoring' && x.payload?.id?.[0] === 17) && (dm5.data?.monitors ?? []).map((m: any) => m.id).join() === '1',
      { del: del.data, mons: dm5.data?.monitors });

    // The over-temperature from 19 is over: the station reports the event cleared.
    const nec = await s2.call('NotifyEvent', { generatedAt: iso(), seqNo: 1, eventData: [
      { eventId: 13, timestamp: iso(), trigger: 'Alerting', actualValue: '70', cleared: true, eventNotificationType: 'HardWiredMonitor', component: { name: 'PowerModule', instance: '2' }, variable: { name: 'Temperature' } },
    ] });
    const al19b = await until(() => ops('GET', '/v1/alerts'), (r) => (r.data ?? []).some((a: any) => a.kind === 'charge_point.device_event' && a.message.includes(ID2) && a.resolved_at), 8000);
    const dev19b = (al19b.data ?? []).filter((a: any) => a.kind === 'charge_point.device_event' && a.message.includes(ID2));
    check('19b. NotifyEvent cleared: the device alert resolves (no new alert)', !nec.__error && dev19b.length === 1 && !!dev19b[0].resolved_at, { nec, dev19b });

    const dm16 = await ops('GET', `/v1/charge-points/${encodeURIComponent(ID)}/device-model`);
    const rep16 = await ops('POST', `/v1/charge-points/${encodeURIComponent(ID)}/device-model/report`, {});
    check('19b. a 1.6 charger has no device model: supported false, a report request is refused (409)', dm16.data?.supported === false && rep16.status === 409, { dm16: dm16.data?.supported, rep16 });
  }

  // ------------------------------------------------------------ 20. outbound webhooks (signed, retried)
  const hooks: Array<{ event: string; body: any; sigOk: boolean }> = [];
  let failNext = 0;
  let whSecret = '';
  const { createServer } = await import('node:http');
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const receiver = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const sig = String(req.headers['plugsure-signature'] ?? '');
      const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
      const expect = m ? createHmac('sha256', whSecret).update(`${m[1]}.${raw}`).digest('hex') : '';
      const sigOk = !!m && timingSafeEqual(Buffer.from(expect), Buffer.from(m[2]!)) && Math.abs(Date.now() / 1000 - Number(m[1])) < 300;
      let body: any = null; try { body = JSON.parse(raw); } catch {}
      hooks.push({ event: String(req.headers['plugsure-event'] ?? ''), body, sigOk });
      if (failNext > 0) { failNext--; res.writeHead(500).end('receiver down'); return; }
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()));
  const port = (receiver.address() as any).port;
  try {
    const bad = await ops('POST', '/v1/webhooks', { url: 'ftp://example.com/x', events: ['*'] });
    check('20. webhook: a non-http(s) URL is refused', bad.status === 400, bad.data);
    const cr = await ops('POST', '/v1/webhooks', { url: `http://127.0.0.1:${port}/hook`, description: 'Field E2E receiver', events: ['session.started', 'session.ended', 'cdr.created', 'refund.due', 'refund.completed', 'charge_point.disconnected', 'alert.raised'] });
    whSecret = cr.data?.secret ?? '';
    const whId = cr.data?.endpoint?.id;
    check('20. webhook endpoint created; signing secret shown once', cr.status === 201 && /^whsec_/.test(whSecret), cr.data);
    const list = await ops('GET', '/v1/webhooks');
    check('20. the secret is never returned again (list has no secret field)', list.status === 200 && !JSON.stringify(list.data).includes(whSecret) && !('secret' in (list.data.rows?.[0] ?? {})), list.data?.rows?.[0]);
    const ping = await ops('POST', `/v1/webhooks/${whId}/test`);
    check('20. test ping delivered and its HMAC signature verifies at the receiver', ping.data?.ok === true && hooks.some((h) => h.event === 'ping' && h.sigOk), { ping: ping.data, hooks });

    // A real session → session.started, session.ended, cdr.created, all signed.
    const s = await c.start(1, 'ID-RFID-0001', 2_000_000);
    await c.meter(1, s.transactionId, 2_002_000);
    await c.stop(s.transactionId, 2_004_000, 'Local');
    const got = await until(async () => hooks.filter((h) => h.body?.data?.sessionId), (hs) => ['session.started', 'session.ended', 'cdr.created'].every((e) => hs.some((h) => h.event === e)), 20_000, 500);
    check('20. a session delivers session.started, session.ended and cdr.created', ['session.started', 'session.ended', 'cdr.created'].every((e) => got.some((h) => h.event === e)), got.map((h) => h.event));
    check('20. every event delivery is signed correctly and carries an id + type envelope', got.length > 0 && got.every((h) => h.sigOk && h.body?.id && h.body?.type === h.event && !('orgId' in (h.body?.data ?? {}))), got.map((h) => ({ e: h.event, ok: h.sigOk })));
    const ended = got.find((h) => h.event === 'session.ended');
    check('20. session.ended payload carries the energy (4 kWh)', Number(ended?.body?.data?.energyWh) === 4000, ended?.body);

    // Receiver outage: the delivery is kept and retried, not dropped.
    failNext = 99;
    const n0 = hooks.length;
    const s2x = await c.start(2, 'ID-RFID-0001', 2_100_000);
    await until(async () => hooks.length, (n) => n > n0, 10_000, 300);
    const dl = await until(() => ops('GET', `/v1/webhooks/${whId}/deliveries?state=pending`), (r) => (r.data?.rows ?? []).some((d: any) => d.last_status === 500), 10_000, 500);
    const retry = (dl.data?.rows ?? []).find((d: any) => d.last_status === 500);
    check('20. a delivery the receiver rejects (HTTP 500) stays queued with a back-off retry', !!retry && retry.attempts === 1 && new Date(retry.next_attempt_at).getTime() > Date.now() + 10_000, retry);
    const ep = (await ops('GET', '/v1/webhooks')).data?.rows?.find((w: any) => w.id === whId);
    check('20. the endpoint shows the failure to the operator', ep?.consecutive_failures >= 1 && /500/.test(ep?.last_error ?? ''), ep);
    failNext = 0;
    await c.stop(s2x.transactionId, 2_100_500, 'Local');
    (globalThis as any).__wh = { whId };
  } finally {
    (globalThis as any).__receiver = receiver;
  }

  // ------------------------------------------------------------ 21. refunds: unused balance → refund queue → paid → driver sees it
  {
    const dv = await (await fetch(API + '/d/v1/device', { method: 'POST' })).json();
    const res = await (await fetch(API + `/d/v1/resolve?code=${encodeURIComponent(ID + ':1')}`)).json();
    const co = await drv('POST', '/v1/charge/prepaid', dv.deviceToken, { connectorId: res.connectorId, amountMinor: 50000 });
    await drv('POST', `/v1/charge/${co.data.chargeId}/confirm-payment`, dv.deviceToken);
    c.handlers.RemoteStartTransaction = () => ({ status: 'Accepted' });
    const t0 = Date.now();
    await drv('POST', `/v1/charge/${co.data.chargeId}/start`, dv.deviceToken);
    const rs = await c.waitFor('RemoteStartTransaction', t0, 8000);
    const s = await c.start(1, rs?.payload?.idTag, 3_000_000);
    await c.meter(1, s.transactionId, 3_003_000);
    await c.stop(s.transactionId, 3_003_000, 'Local'); // driver leaves early: 3 kWh of a Rp 50,000 top-up
    const rcpt = await until(() => drv('GET', `/v1/charge/${co.data.chargeId}/receipt`, dv.deviceToken), (r) => !!r.data?.settlement?.refund, 20_000, 500);
    const owed = rcpt.data?.settlement?.refundMinor;
    check('21. an under-used prepaid session puts the unused balance in the refund queue', owed > 0 && rcpt.data?.settlement?.refund?.state === 'due', rcpt.data?.settlement);
    const q = await ops('GET', '/v1/refunds?state=due');
    const row = (q.data?.rows ?? []).find((r: any) => Number(r.refund_due_minor) === Number(owed) && r.ocpp_identity === ID);
    check('21. finance sees it in Refunds with the charger and amount', q.status === 200 && !!row && q.data.summary?.due_count >= 1, { owed, rows: q.data?.rows?.slice?.(0, 2) });
    const pay = row ? await ops('POST', `/v1/refunds/${row.id}/process`) : { status: 0, data: null };
    check('21. refund paid through the payment provider (reference recorded)', pay.status === 200 && pay.data?.state === 'refunded' && !!pay.data?.refundRef, pay.data);
    const again = row ? await ops('POST', `/v1/refunds/${row.id}/process`) : { status: 0 };
    check('21. a second refund of the same payment is refused (no double refund)', again.status === 409, again);
    const after = await drv('GET', `/v1/charge/${co.data.chargeId}/receipt`, dv.deviceToken);
    check('21. the driver\'s receipt now shows the money as returned', after.data?.settlement?.refund?.state === 'refunded' && !!after.data?.settlement?.refund?.reference, after.data?.settlement?.refund);
    const wh = await until(async () => hooks.filter((h) => h.event.startsWith('refund.')).map((h) => h.event), (e) => e.includes('refund.due') && e.includes('refund.completed'), 10_000, 400);
    check('21. refund.due and refund.completed reach the webhook', wh.includes('refund.due') && wh.includes('refund.completed'), wh);
  }

  // ------------------------------------------------------------ 22. paid-but-never-started: stale claim token and refund sweep
  // Needs direct DB access to age the payment (E2E_DATABASE_URL, the runtime role).
  if (process.env.E2E_DATABASE_URL) {
    const unused = (globalThis as any).__unusedCharge as { chargeId: string; token: string };
    const pg = (await import('pg')).default;
    const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
    await db.connect();
    try {
      const pi = (await db.query(`SELECT pi.id, pi.claim_id_tag FROM driver_charge dc JOIN payment_intent pi ON pi.id = dc.payment_intent_id WHERE dc.id = $1`, [unused.chargeId])).rows[0];
      // The claim window runs from payment (paid_at, migration 049), not from checkout: age both.
      await db.query(`UPDATE payment_intent SET created_at = now() - interval '40 minutes', paid_at = now() - interval '40 minutes' WHERE id = $1`, [pi.id]);
      const late = await c.call('Authorize', { idTag: pi.claim_id_tag });
      const lateStart = await c.start(2, pi.claim_id_tag, 4_000_000);
      check('22. a prepaid claim token past its 30-min window no longer authorises a free session', late.idTagInfo?.status !== 'Accepted' && lateStart.idTagInfo?.status !== 'Accepted', { late, lateStart });
      process.env.DATABASE_URL ??= process.env.E2E_DATABASE_URL;
      const { sweepUnusedPayments } = await import('../../src/services/refunds.js');
      const n = await sweepUnusedPayments();
      const st = await drv('GET', `/v1/charge/${unused.chargeId}/status`, unused.token);
      check('22. the refund sweep queues the full amount and the driver app says "refund in progress"', n >= 1 && st.data?.state === 'refund_pending' && st.data?.refund?.amountMinor === 20000, { n, st: st.data?.state, refund: st.data?.refund });
      const tok = (await db.query(`SELECT status FROM token WHERE uid = $1 AND kind = 'prepaid'`, [pi.claim_id_tag])).rows[0];
      check('22. the claim token is retired (Expired) once its money is refundable', tok?.status === 'Expired', tok);
      const manual = await ops('POST', `/v1/refunds/${pi.id}/mark-refunded`, { reference: 'BCA-E2E-778812' });
      const st2 = await drv('GET', `/v1/charge/${unused.chargeId}/status`, unused.token);
      check('22. a bank-transfer refund recorded by finance shows as refunded to the driver', manual.status === 200 && st2.data?.state === 'refunded', { m: manual.data, st: st2.data?.state });
    } finally {
      await db.end();
      const { pool } = await import('../../src/db/pool.js').catch(() => ({ pool: null as any }));
      await pool?.end?.().catch?.(() => {});
    }
  } else {
    console.log('SKIP  22. (set E2E_DATABASE_URL to age a payment and run the unused-payment sweep)');
  }

  // ------------------------------------------------------------ 23. charger offline too long → alert, outage, auto-resolve, uptime report
  // Needs the gateway started with OFFLINE_ALERT_MINUTES=1 (takes ~2.5 min). E2E_QUICK=1 skips it.
  if (!process.env.E2E_QUICK) {
    const ID3 = `FIELDOFF-${Date.now().toString().slice(-6)}`;
    await ops('POST', '/v1/charge-points', { ocppIdentity: ID3, siteId, displayName: 'Field Sim Offline', ocppVersion: 'ocpp1.6',
      evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
    await ops('POST', `/v1/charge-points/${ID3}/activate`);
    const o = new Raw(ID3); raws.push(o);
    await o.connect(); await o.boot(); await o.status(1, 'Available');
    // A site with a weak signal tolerates a day offline: its charger drops at the same moment and must not alert.
    const patient = await ops('POST', '/v1/sites', { name: `E2E Patient site ${ID3}`, address: 'Jl. Pelan', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '53', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000', offlineAlertMinutes: 1440 });
    const badThreshold = await ops('POST', '/v1/sites', { name: 'E2E bad threshold', address: 'x', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '53', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000', offlineAlertMinutes: 0 });
    const patientRow = (await ops('GET', `/v1/sites/${patient.data?.id}`)).data;
    const pMin = (patientRow?.site ?? patientRow)?.offline_alert_minutes;
    check('23. a site can set its own offline threshold (1–1440 minutes)', patient.status === 200 && pMin === 1440 && badThreshold.status === 422, { pMin, bad: badThreshold.data });
    const ID4 = `FIELDPT-${Date.now().toString().slice(-6)}`;
    const cp4 = await ops('POST', '/v1/charge-points', { ocppIdentity: ID4, siteId: patient.data?.id, displayName: 'Field Sim Patient', ocppVersion: 'ocpp1.6',
      evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'sType2', currentKind: 'AC3', maxPowerW: 22000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
    if (cp4.status >= 300) throw new Error(`patient-site charger not created: ${JSON.stringify(cp4.data)}`);
    await ops('POST', `/v1/charge-points/${ID4}/activate`);
    const o4 = new Raw(ID4); raws.push(o4);
    await o4.connect(); await o4.boot(); await o4.status(1, 'Available');
    const hookMark = hooks.length;
    o.kill(); o4.kill();
    const disc = await until(async () => hooks.slice(hookMark).find((h) => h.event === 'charge_point.disconnected' && h.body?.data?.ocppIdentity === ID3), (v) => !!v, 15_000, 500);
    check('23. charge_point.disconnected reaches the webhook', !!disc, hooks.slice(hookMark).map((h) => h.event));
    const al = await until(() => ops('GET', '/v1/alerts'), (r) => (r.data ?? []).some((a: any) => a.kind === 'charge_point.offline' && a.message.includes(ID3) && !a.resolved_at), 190_000, 5000);
    const alert = (al.data ?? []).find((a: any) => a.kind === 'charge_point.offline' && a.message.includes(ID3));
    check('23. a charger offline past the threshold raises a critical alert', alert?.severity === 'critical', alert ?? (al.data ?? []).slice(0, 3));
    await sleep(10_000); // a few more worker rounds past the fleet threshold
    const patientAlerts = ((await ops('GET', '/v1/alerts')).data ?? []).filter((a: any) => a.kind === 'charge_point.offline' && a.message.includes(ID4));
    check('23. … but not for the charger at the site with its own 1440-minute threshold', patientAlerts.length === 0, patientAlerts);
    await o.connect(); await o.boot(); await o.status(1, 'Available');
    const res = await until(() => ops('GET', '/v1/alerts'), (r) => !(r.data ?? []).some((a: any) => a.kind === 'charge_point.offline' && a.message.includes(ID3) && !a.resolved_at), 10_000, 500);
    check('23. the offline alert resolves itself when the charger reconnects', !(res.data ?? []).some((a: any) => a.kind === 'charge_point.offline' && a.message.includes(ID3) && !a.resolved_at));
    // The split API learns liveness from the gateway's snapshot every few seconds.
    const rep = await until(() => ops('GET', `/v1/reports/availability?days=7&siteId=${siteId}`), (r) => (r.data?.rows ?? []).find((x: any) => x.ocppIdentity === ID3)?.online === true, 15_000, 1000);
    const r3 = (rep.data?.rows ?? []).find((r: any) => r.ocppIdentity === ID3);
    check('23. availability report: the outage is counted and uptime is below 100%', rep.status === 200 && r3?.outages === 1 && r3.uptimePct < 100 && r3.offlineMinutes >= 1 && r3.online === true, r3);
    const rMain = (rep.data?.rows ?? []).find((r: any) => r.ocppIdentity === ID);
    check('23. availability report: sessions, energy and revenue per charger', rMain?.sessions >= 10 && rMain.energyKwh > 0 && rMain.revenueMinor > 0 && rMain.utilisationPct != null, rMain);
    // Scenario 10 left a session stamped 3 days in the future on this charger.
    const outOfRange = (rep.data?.rows ?? []).filter((r: any) => [r.uptimePct, r.utilisationPct].some((p) => p != null && (p < 0 || p > 100)));
    check('23. availability report: every percentage is within 0–100 (a charger clock running ahead cannot skew it)', outOfRange.length === 0, outOfRange);
  } else {
    console.log('SKIP  23. (E2E_QUICK set)');
  }

  // ------------------------------------------------------------ 24. alert routing: e-mail and WhatsApp
  // A local SMTP server and a fake WhatsApp Cloud API receive what the real
  // transports (nodemailer, HTTPS template messages) send.
  {
    const net = await import('node:net');
    const mails: Array<{ to: string[]; subject: string; raw: string }> = [];
    const decodeWords = (s: string) => s.replace(/\?=\s+=\?/g, '?==?').replace(/=\?utf-8\?([QB])\?([^?]*)\?=/gi, (_m, enc: string, txt: string) =>
      enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64').toString('utf8')
      : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x: string, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
    const smtp = net.createServer((sock) => {
      let buf = ''; let inData = false; let to: string[] = [];
      sock.write('220 fake-smtp ready\r\n');
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        for (;;) {
          if (inData) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end < 0) return;
            const raw = buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
            const head = raw.split('\r\n\r\n')[0]!.replace(/\r\n[ \t]+/g, ' ');
            mails.push({ to, subject: decodeWords(/^Subject: (.*)$/im.exec(head)?.[1] ?? ''), raw });
            to = []; sock.write('250 2.0.0 queued as FAKE\r\n');
            continue;
          }
          const i = buf.indexOf('\r\n'); if (i < 0) return;
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake-smtp\r\n250 8BITMIME\r\n');
          else if (cmd === 'MAIL') sock.write('250 OK\r\n');
          else if (cmd === 'RCPT') { to.push(/<([^>]+)>/.exec(line)?.[1] ?? ''); sock.write('250 OK\r\n'); }
          else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
          else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); return; }
          else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => {});
    });
    const wa: Array<{ path: string; auth: string; to: string; template: string; params: string[] }> = [];
    const waServer = createServer((req, res) => {
      let raw = ''; req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const b = JSON.parse(raw || '{}');
        const params = (b.template?.components?.[0]?.parameters ?? []).map((p: any) => p.text);
        wa.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), to: b.to, template: b.template?.name, params });
        res.setHeader('content-type', 'application/json');
        if (b.to === '6281299990000') { res.writeHead(400).end(JSON.stringify({ error: { message: '(#131026) Message undeliverable', code: 131026 } })); return; }
        res.writeHead(200).end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.FAKE${wa.length}` }] }));
      });
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => waServer.listen(0, '127.0.0.1', () => r()));
    const smtpPort = (smtp.address() as any).port, waPort = (waServer.address() as any).port;
    const made = { rules: [] as string[], contacts: [] as string[] };
    try {
      const em = await ops('PUT', '/v1/alert-routing/channels/email', { enabled: true, config: { host: '127.0.0.1', port: smtpPort, security: 'none', fromAddress: 'alerts@plugsure.test', fromName: 'PlugSure Alerts' } });
      const bad = await ops('PUT', '/v1/alert-routing/channels/whatsapp', { enabled: true, config: { apiBase: `http://127.0.0.1:${waPort}/v21.0`, phoneNumberId: '109876543210', templateName: 'Bad Name', templateLang: 'id' }, secret: 'e2e-wa-token' });
      const wh = await ops('PUT', '/v1/alert-routing/channels/whatsapp', { enabled: true, config: { apiBase: `http://127.0.0.1:${waPort}/v21.0`, phoneNumberId: '109876543210', templateName: 'plugsure_alert', templateLang: 'id' }, secret: 'e2e-wa-token' });
      check('24. e-mail and WhatsApp channels saved; an invalid template name is refused', em.status === 200 && wh.status === 200 && bad.status === 400, { em: em.data, wh: wh.data, bad: bad.data });
      const cfg = await ops('GET', '/v1/alert-routing');
      check('24. the WhatsApp token is never returned to the console', cfg.status === 200 && !JSON.stringify(cfg.data).includes('e2e-wa-token') && cfg.data.channels.whatsapp.has_secret === true, cfg.data?.channels);

      const t1 = await ops('POST', '/v1/alert-routing/channels/email/test', { destination: 'oncall@nusantara.test' });
      const t2 = await ops('POST', '/v1/alert-routing/channels/whatsapp/test', { destination: '0812 0000 1111' });
      check('24. test e-mail delivered over SMTP', t1.data?.ok === true && mails.some((m) => m.to.includes('oncall@nusantara.test') && m.subject === '[PlugSure] Test message'), { t1: t1.data, mails: mails.map((m) => m.subject) });
      const w0 = wa[wa.length - 1];
      check('24. test WhatsApp sent as the approved template, 0812… normalised to 62812…, with the token', t2.data?.ok === true && w0?.to === '6281200001111' && w0.template === 'plugsure_alert' && w0.params.length === 3 && w0.params[0] === 'TEST' && w0.auth === 'Bearer e2e-wa-token' && w0.path === '/v21.0/109876543210/messages', { t2: t2.data, w0 });

      const badC = await ops('POST', '/v1/alert-routing/contacts', { name: 'Typo', whatsapp: '12' });
      const A = await ops('POST', '/v1/alert-routing/contacts', { name: 'E2E on-call tech', email: 'oncall@nusantara.test', whatsapp: '0812 0000 1111' });
      const B = await ops('POST', '/v1/alert-routing/contacts', { name: 'E2E ops manager', email: 'ops-manager@nusantara.test' });
      const C = await ops('POST', '/v1/alert-routing/contacts', { name: 'E2E wrong number', whatsapp: '0812 9999 0000' });
      made.contacts.push(...[A, B, C].map((x) => x.data?.contact?.id).filter(Boolean));
      check('24. contacts added; an invalid WhatsApp number is refused', A.status === 201 && B.status === 201 && C.status === 201 && badC.status === 400 && A.data.contact.whatsapp === '6281200001111', { A: A.data, badC: badC.data });
      const [aId, bId, cId] = [A.data.contact.id, B.data.contact.id, C.data.contact.id];
      const R1 = await ops('POST', '/v1/alert-routing/rules', { name: 'E2E critical at the field hub', minSeverity: 'critical', channels: ['email', 'whatsapp'], contactIds: [aId, cId], siteIds: [siteId], notifyResolved: true, escalateAfterMin: 1, escalateContactIds: [bId] });
      const R2 = await ops('POST', '/v1/alert-routing/rules', { name: 'E2E compliance to manager', minSeverity: 'warning', kinds: ['compliance.*'], channels: ['email'], contactIds: [bId] });
      const Rbad = await ops('POST', '/v1/alert-routing/rules', { name: 'no contacts', minSeverity: 'critical', channels: ['email'], contactIds: [] });
      made.rules.push(...[R1, R2].map((x) => x.data?.rule?.id).filter(Boolean));
      check('24. routing rules created; a rule with nobody to notify is refused', R1.status === 201 && R2.status === 201 && Rbad.status === 400, { R1: R1.data, Rbad: Rbad.data });

      // A connector fault at the field hub: critical, so R1 fires (R2 is compliance-only).
      // Other critical alerts can be routed meanwhile (R1 covers every critical alert at this site, e.g. a charger going
      // offline), so every check below looks at the messages about THIS fault: the e-mail subject / WhatsApp text name it.
      const isFaultMail = (m: { subject: string }) => /Connector fault/.test(m.subject);
      const isFaultWa = (w: { params: string[] }) => /Connector fault/.test(w.params[1] ?? '');
      const m0 = mails.length, w1 = wa.length;
      await c.status(1, 'Faulted', 'GroundFailure', { vendorErrorCode: 'E-GF-99', info: 'RCD tripped' });
      const gotMail = await until(async () => mails.slice(m0), (ms) => ms.some((m) => m.to.includes('oncall@nusantara.test') && isFaultMail(m)), 20_000, 500);
      const mail = gotMail.find((m) => m.to.includes('oncall@nusantara.test') && isFaultMail(m));
      check('24. connector fault → e-mail to the on-call contact with a clear subject', mail?.subject === '[CRITICAL] Connector fault — Field E2E Hub' && /E-GF-99/.test(mail.raw), { subjects: gotMail.map((m) => m.subject) });
      const gotWa = await until(async () => wa.slice(w1), (ws) => ws.some((w) => w.to === '6281200001111' && isFaultWa(w)), 15_000, 500);
      const waMsg = gotWa.find((w) => w.to === '6281200001111' && isFaultWa(w));
      check('24. … and a WhatsApp template message: CRITICAL, what and where, time in WIB', waMsg?.params[0] === 'CRITICAL' && /Connector fault at Field E2E Hub: .*E-GF-99/.test(waMsg.params[1]!) && / WIB$/.test(waMsg.params[2]!) && !/\n/.test(waMsg.params.join('')), waMsg);
      check('24. the compliance-only rule did not fire for a fault', !mails.slice(m0).some((m) => m.to.includes('ops-manager@nusantara.test')), mails.slice(m0).map((m) => m.to));
      const alerts24 = (await ops('GET', '/v1/alerts')).data ?? [];
      const al = alerts24.find((a: any) => a.kind === 'connector.faulted' && a.message.includes('E-GF-99') && !a.resolved_at);
      const log1 = await until(() => ops('GET', `/v1/alert-routing/log?alertId=${al?.id}`), (r) => (r.data?.rows ?? []).some((n: any) => n.state === 'failed'), 10_000, 500);
      const failed = (log1.data?.rows ?? []).find((n: any) => n.destination === '6281299990000');
      check('24. a number WhatsApp rejects is logged as failed with the reason (not retried forever)', failed?.state === 'failed' && /131026/.test(failed.last_error ?? '') && failed.attempts === 1, failed);

      // The same fault reported again is the same open problem: no second message.
      const mRepeat = mails.length, wRepeat = wa.length;
      await c.status(1, 'Faulted', 'GroundFailure', { vendorErrorCode: 'E-GF-99', info: 'RCD tripped' });
      await sleep(7000);
      const again = ((await ops('GET', '/v1/alerts')).data ?? []).find((a: any) => a.id === al?.id);
      const faultMailsAgain = mails.slice(mRepeat).filter(isFaultMail), faultWaAgain = wa.slice(wRepeat).filter(isFaultWa);
      check('24. a repeated fault bumps the open alert (2×) and does not message anyone again', again?.occurrences === 2 && faultMailsAgain.length === 0 && faultWaAgain.length === 0, { occ: again?.occurrences, mails: faultMailsAgain.map((m) => m.subject), wa: faultWaAgain.length });

      // Escalation: nobody acknowledged within the rule's 1 minute (aged through the DB when available).
      if (process.env.E2E_DATABASE_URL) {
        const pg = (await import('pg')).default;
        const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
        await db.connect();
        await db.query(`UPDATE alert SET raised_at = raised_at - interval '2 minutes' WHERE id = $1`, [al.id]);
        await db.end();
        const esc = await until(async () => mails.filter((m) => m.to.includes('ops-manager@nusantara.test') && isFaultMail(m)), (ms) => ms.length > 0, 20_000, 500);
        check('24. unacknowledged after the escalation time → the manager is notified', /^\[ESCALATED CRITICAL\] Connector fault/.test(esc[0]?.subject ?? ''), esc.map((m) => m.subject));
      } else {
        console.log('SKIP  24. escalation (set E2E_DATABASE_URL)');
      }
      const ack = await ops('POST', `/v1/alerts/${al.id}/acknowledge`);
      const ack2 = await ops('POST', `/v1/alerts/${al.id}/acknowledge`);
      check('24. an alert can be acknowledged once', ack.status === 200 && ack2.status === 404, { ack: ack.data, ack2: ack2.status });

      // The connector recovers: the alert resolves itself and everyone who was told hears it is over.
      const m2 = mails.length, w2 = wa.length;
      await c.status(1, 'Available');
      const res = await until(async () => mails.slice(m2), (ms) => ms.some((m) => m.to.includes('oncall@nusantara.test') && m.subject.startsWith('[RESOLVED]')), 20_000, 500);
      check('24. connector back to Available → alert auto-resolved and a [RESOLVED] e-mail sent', res.some((m) => m.to.includes('oncall@nusantara.test') && m.subject === '[RESOLVED] Connector fault — Field E2E Hub'), res.map((m) => `${m.to} ${m.subject}`));
      const resWa = await until(async () => wa.slice(w2), (ws) => ws.some((w) => w.to === '6281200001111' && w.params[0] === 'RESOLVED' && isFaultWa(w)), 10_000, 500);
      check('24. … and a RESOLVED WhatsApp, with how long it was open', resWa.some((w) => w.to === '6281200001111' && w.params[0] === 'RESOLVED' && isFaultWa(w) && /\(open \d+ (min|h)/.test(w.params[1]!)), resWa);
      check('24. the failed number is not sent a "resolved" notice', !wa.slice(w2).some((w) => w.to === '6281299990000' && w.params[0] === 'RESOLVED' && isFaultWa(w)));

      const log = await ops('GET', `/v1/alert-routing/log?alertId=${al.id}`);
      const sent = (log.data?.rows ?? []).filter((n: any) => n.state === 'sent').map((n: any) => `${n.stage}:${n.channel}`).sort();
      check('24. delivery log shows every message for the alert', log.status === 200 && sent.includes('raised:email') && sent.includes('raised:whatsapp') && sent.includes('resolved:email') && sent.includes('resolved:whatsapp'), sent);
      const retry = await ops('POST', `/v1/alert-routing/log/${failed?.id}/retry`);
      check('24. a failed message can be retried from the log (after fixing the contact)', retry.status === 200, retry.data);
    } finally {
      for (const id of made.rules) await ops('DELETE', `/v1/alert-routing/rules/${id}`).catch(() => {});
      for (const id of made.contacts) await ops('DELETE', `/v1/alert-routing/contacts/${id}`).catch(() => {});
      await ops('PUT', '/v1/alert-routing/channels/email', { enabled: false, config: { host: '127.0.0.1', port: smtpPort, security: 'none', fromAddress: 'alerts@plugsure.test' } }).catch(() => {});
      await ops('PUT', '/v1/alert-routing/channels/whatsapp', { enabled: false, config: { apiBase: `http://127.0.0.1:${waPort}/v21.0`, phoneNumberId: '109876543210', templateName: 'plugsure_alert', templateLang: 'id' } }).catch(() => {});
      await sleep(6000); // let the worker drain the retried row against the live fake servers
      smtp.close(); waServer.close();
    }
  }

  // ------------------------------------------------------------ 24b. alerting follow-ups: SMS, WhatsApp delivery status, on-call rotas
  // A fake Cloud API (one number WhatsApp refuses), a fake SMS gateway, and Meta's status webhook signed with the app secret.
  {
    const crypto = await import('node:crypto');
    const wa: Array<{ to: string; params: string[]; id: string }> = [];
    const sms: Array<{ to: string; message: string; auth: string }> = [];
    const waServer = createServer((req, res) => {
      let raw = ''; req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const b = JSON.parse(raw || '{}');
        const id = `wamid.B${wa.length + 1}${Date.now()}`;
        wa.push({ to: b.to, params: (b.template?.components?.[0]?.parameters ?? []).map((p: any) => p.text), id });
        res.setHeader('content-type', 'application/json');
        if (b.to === '6281277770000') { res.writeHead(400).end(JSON.stringify({ error: { message: '(#131026) Message undeliverable', code: 131026 } })); return; }
        res.writeHead(200).end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id }] }));
      });
    });
    const smsServer = createServer((req, res) => {
      let raw = ''; req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const b = JSON.parse(raw || '{}');
        sms.push({ to: b.to, message: b.message, auth: String(req.headers.authorization ?? '') });
        res.setHeader('content-type', 'application/json');
        res.writeHead(200).end(JSON.stringify({ id: `SMS${sms.length}` }));
      });
    });
    await new Promise<void>((r) => waServer.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => smsServer.listen(0, '127.0.0.1', () => r()));
    const waPort = (waServer.address() as any).port, smsPort = (smsServer.address() as any).port;
    const waCfg = { apiBase: `http://127.0.0.1:${waPort}/v21.0`, phoneNumberId: '109876543210', templateName: 'plugsure_alert', templateLang: 'id' };
    const smsCfg = { provider: 'http', url: `http://127.0.0.1:${smsPort}/send` };
    const APP_SECRET = 'e2e-meta-app-secret';
    const made = { rules: [] as string[], contacts: [] as string[], rotas: [] as string[] };
    try {
      const wh = await ops('PUT', '/v1/alert-routing/channels/whatsapp', { enabled: true, config: waCfg, secret: 'e2e-wa-token', webhookSecret: APP_SECRET });
      const smsBad = await ops('PUT', '/v1/alert-routing/channels/sms', { enabled: true, config: { provider: 'twilio', accountSid: 'nope' }, secret: 'x' });
      const smsOk = await ops('PUT', '/v1/alert-routing/channels/sms', { enabled: true, config: smsCfg, secret: 'e2e-sms-token' });
      check('24b. SMS channel saved (your own gateway); an invalid Twilio SID is refused', wh.status === 200 && smsOk.status === 200 && smsBad.status === 400, { wh: wh.data, sms: smsOk.data, bad: smsBad.data });
      const cfg = (await ops('GET', '/v1/alert-routing')).data;
      const hook = cfg?.channels?.whatsapp?.webhook;
      check('24b. WhatsApp shows its status webhook (path, verify token, app secret saved) and never returns the secrets',
        /^\/hooks\/whatsapp\/[A-Za-z0-9_-]{16,64}$/.test(hook?.path ?? '') && hook.url === API + hook.path && (hook?.verifyToken ?? '').length >= 16 && hook?.hasAppSecret === true
        && cfg.channels.sms.has_secret === true && !/e2e-meta-app-secret|e2e-sms-token|e2e-wa-token/.test(JSON.stringify(cfg)), hook);

      const ts = await ops('POST', '/v1/alert-routing/channels/sms/test', { destination: '0813 5555 0000' });
      check('24b. test SMS through the gateway: +62 number, bearer token, one line', ts.data?.ok === true && sms.at(-1)?.to === '+6281355550000' && sms.at(-1)?.auth === 'Bearer e2e-sms-token' && /^PlugSure TEST: /.test(sms.at(-1)?.message ?? ''), { ts: ts.data, last: sms.at(-1) });

      // Meta's subscription check, then signed status callbacks.
      const vOk = await fetch(`${API}${hook.path}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(hook.verifyToken)}&hub.challenge=8872301`);
      const vBad = await fetch(`${API}${hook.path}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=8872301`);
      check('24b. webhook verification echoes the challenge only with the right verify token', vOk.status === 200 && (await vOk.text()) === '8872301' && vBad.status === 403, { ok: vOk.status, bad: vBad.status });
      const postStatus = async (statuses: any[], secret = APP_SECRET, path = hook.path) => {
        const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses } }] }] });
        const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw });
        const txt = await r.text(); let d: any = txt; try { d = JSON.parse(txt); } catch {}
        return { status: r.status, data: d };
      };

      const D = await ops('POST', '/v1/alert-routing/contacts', { name: 'E2E rota first', whatsapp: '0812 7777 0000' });
      const E = await ops('POST', '/v1/alert-routing/contacts', { name: 'E2E rota second', whatsapp: '0812 5555 0000', sms: '0813 5555 0000' });
      made.contacts.push(...[D, E].map((x) => x.data?.contact?.id).filter(Boolean));
      const [dId, eId] = [D.data?.contact?.id, E.data?.contact?.id];
      check('24b. a contact can have a separate SMS number', E.status === 201 && E.data.contact.sms === '6281355550000', E.data);

      const today = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timeZone }).format(new Date());
      const rotaBad = await ops('POST', '/v1/alert-routing/rotas', { name: 'empty', memberIds: [], startsOn: today });
      const rota = await ops('POST', '/v1/alert-routing/rotas', { name: 'E2E Teknisi', memberIds: [dId, eId], shift: 'weekly', handoverTime: '00:00', startsOn: today });
      const rotaId = rota.data?.rota?.id; if (rotaId) made.rotas.push(rotaId);
      const r0 = (await ops('GET', '/v1/alert-routing')).data?.rotas?.find((x: any) => x.id === rotaId);
      check('24b. on-call rota created; the first member is on duty this week, the second next', rota.status === 201 && rotaBad.status === 400 && r0?.duty?.contactId === dId && r0.duty.nextContactId === eId && r0.duty.override === false, { rota: rota.data, bad: rotaBad.data, duty: r0?.duty });

      const ruleBad = await ops('POST', '/v1/alert-routing/rules', { name: 'fallback without WhatsApp', minSeverity: 'critical', channels: ['email'], rotaIds: [rotaId], smsFallback: true });
      const rule = await ops('POST', '/v1/alert-routing/rules', { name: 'E2E whoever is on duty', minSeverity: 'critical', channels: ['whatsapp'], rotaIds: [rotaId], smsFallback: true, siteIds: [siteId], notifyResolved: false });
      if (rule.data?.rule?.id) made.rules.push(rule.data.rule.id);
      check('24b. a rule can notify whoever is on duty (no named contacts); SMS fallback needs WhatsApp', rule.status === 201 && ruleBad.status === 400, { rule: rule.data, bad: ruleBad.data });

      // 1) WhatsApp refuses the on-duty person's number → SMS instead, to the same number.
      const w0 = wa.length, s0 = sms.length;
      await c.status(1, 'Faulted', 'GroundFailure', { vendorErrorCode: 'E-GF-77', info: 'RCD tripped' });
      const gotSms = await until(async () => sms.slice(s0), (xs) => xs.some((x) => /E-GF-77/.test(x.message)), 25_000, 500);
      check('24b. alert → WhatsApp to whoever is on duty (the rota\'s first member)', wa.slice(w0).some((w) => w.to === '6281277770000' && /E-GF-77/.test(w.params[1] ?? '')), wa.slice(w0));
      const fb = gotSms.find((x) => /E-GF-77/.test(x.message));
      check('24b. WhatsApp refused the number → an SMS with the alert goes to the same person', fb?.to === '+6281277770000' && /^PlugSure CRITICAL: Connector fault/.test(fb.message), gotSms);
      const al1 = ((await ops('GET', '/v1/alerts')).data ?? []).find((a: any) => a.kind === 'connector.faulted' && a.message.includes('E-GF-77'));
      const log1 = await until(() => ops('GET', `/v1/alert-routing/log?alertId=${al1?.id}`), (r) => (r.data?.rows ?? []).some((n: any) => n.channel === 'sms' && n.state === 'sent'), 10_000, 500);
      const waRow = (log1.data?.rows ?? []).find((n: any) => n.channel === 'whatsapp');
      const smsRow = (log1.data?.rows ?? []).find((n: any) => n.channel === 'sms');
      check('24b. the log links the SMS to the failed WhatsApp message', waRow?.state === 'failed' && smsRow?.fallback_of != null && String(smsRow.fallback_of) === String(waRow.id), { waRow, smsRow });

      await c.status(1, 'Available');
      await until(() => ops('GET', '/v1/alerts'), (r) => !(r.data ?? []).some((a: any) => a.id === al1?.id && !a.resolved_at), 15_000, 500);

      // 2) An override puts the second member on duty now.
      const now = Date.now();
      const ovBad = await ops('POST', `/v1/alert-routing/rotas/${rotaId}/overrides`, { contactId: eId, startsAt: new Date(now).toISOString(), endsAt: new Date(now - 1000).toISOString() });
      const ov = await ops('POST', `/v1/alert-routing/rotas/${rotaId}/overrides`, { contactId: eId, startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 3600_000).toISOString(), note: 'swap' });
      const r1 = (await ops('GET', '/v1/alert-routing')).data?.rotas?.find((x: any) => x.id === rotaId);
      check('24b. an override puts someone else on duty (an end before the start is refused)', ov.status === 201 && ovBad.status === 400 && r1?.duty?.contactId === eId && r1.duty.override === true, { ov: ov.data, duty: r1?.duty });

      const w1 = wa.length, s1 = sms.length;
      await c.status(1, 'Faulted', 'GroundFailure', { vendorErrorCode: 'E-GF-78', info: 'RCD tripped' });
      const got = await until(async () => wa.slice(w1), (ws) => ws.some((w) => /E-GF-78/.test(w.params[1] ?? '')), 25_000, 500);
      const msg = got.find((w) => /E-GF-78/.test(w.params[1] ?? ''));
      check('24b. with the override the alert goes to the covering person', msg?.to === '6281255550000' && !got.some((w) => w.to === '6281277770000' && /E-GF-78/.test(w.params[1] ?? '')), got);
      const al2 = ((await ops('GET', '/v1/alerts')).data ?? []).find((a: any) => a.kind === 'connector.faulted' && a.message.includes('E-GF-78'));
      await until(() => ops('GET', `/v1/alert-routing/log?alertId=${al2?.id}`), (r) => (r.data?.rows ?? []).some((n: any) => n.channel === 'whatsapp' && n.state === 'sent'), 10_000, 500);

      // 3) Meta reports delivery: forged and unknown calls are refused; delivered → read → (later) failed → SMS fallback.
      const tsNow = Math.floor(Date.now() / 1000);
      const forged = await postStatus([{ id: msg?.id, status: 'failed', timestamp: String(tsNow) }], 'not-the-app-secret');
      const unknown = await postStatus([{ id: msg?.id, status: 'read' }], APP_SECRET, '/hooks/whatsapp/AAAAAAAAAAAAAAAAAAAAAAAA');
      check('24b. a status callback with a forged signature is refused (401), an unknown webhook is 404', forged.status === 401 && unknown.status === 404, { forged, unknown: unknown.status });
      const dl = await postStatus([{ id: msg?.id, status: 'sent', timestamp: String(tsNow) }, { id: msg?.id, status: 'delivered', timestamp: String(tsNow + 2) }, { id: 'wamid.someone-else', status: 'delivered' }]);
      const rd = await postStatus([{ id: msg?.id, status: 'read', timestamp: String(tsNow + 30) }]);
      const lg = (await ops('GET', `/v1/alert-routing/log?alertId=${al2?.id}`)).data?.rows ?? [];
      const row2 = lg.find((n: any) => n.channel === 'whatsapp');
      check('24b. signed callbacks: delivered then read show in the log (unknown message ids are ignored)', dl.status === 200 && dl.data?.statuses === 1 && rd.data?.statuses === 1 && row2?.delivery === 'read' && !!row2.delivered_at && !!row2.read_at, { dl: dl.data, rd: rd.data, row2 });
      const fl = await postStatus([{ id: msg?.id, status: 'failed', timestamp: String(tsNow + 60), errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'More than 24 hours have passed' } }] }]);
      const gotSms2 = await until(async () => sms.slice(s1), (xs) => xs.some((x) => /E-GF-78/.test(x.message)), 20_000, 500);
      const lg2 = (await ops('GET', `/v1/alert-routing/log?alertId=${al2?.id}`)).data?.rows ?? [];
      const waRow2 = lg2.find((n: any) => n.channel === 'whatsapp');
      check('24b. Meta reports the message failed → reason logged and an SMS goes to the contact\'s SMS number', fl.status === 200 && waRow2?.delivery === 'failed' && /131047/.test(waRow2.delivery_error ?? '') && gotSms2.some((x) => /E-GF-78/.test(x.message) && x.to === '+6281355550000'), { waRow2, sms: gotSms2 });

      const delOv = await ops('DELETE', `/v1/alert-routing/rotas/${rotaId}/overrides/${ov.data?.override?.id}`);
      const r2 = (await ops('GET', '/v1/alert-routing')).data?.rotas?.find((x: any) => x.id === rotaId);
      check('24b. removing the override returns duty to the rotation', delOv.status === 200 && r2?.duty?.contactId === dId, r2?.duty);
      await c.status(1, 'Available');
      await until(() => ops('GET', '/v1/alerts'), (r) => !(r.data ?? []).some((a: any) => a.id === al2?.id && !a.resolved_at), 15_000, 500);
      const delRota = await ops('DELETE', `/v1/alert-routing/rotas/${rotaId}`);
      const ruleAfter = (await ops('GET', '/v1/alert-routing')).data?.rules?.find((x: any) => x.id === rule.data?.rule?.id);
      check('24b. deleting a rota takes it out of the rules that used it', delRota.status === 200 && Array.isArray(ruleAfter?.rota_ids) && ruleAfter.rota_ids.length === 0, ruleAfter);
      made.rotas.length = 0;
    } finally {
      for (const id of made.rules) await ops('DELETE', `/v1/alert-routing/rules/${id}`).catch(() => {});
      for (const id of made.rotas) await ops('DELETE', `/v1/alert-routing/rotas/${id}`).catch(() => {});
      for (const id of made.contacts) await ops('DELETE', `/v1/alert-routing/contacts/${id}`).catch(() => {});
      await ops('PUT', '/v1/alert-routing/channels/whatsapp', { enabled: false, config: waCfg }).catch(() => {});
      await ops('PUT', '/v1/alert-routing/channels/sms', { enabled: false, config: smsCfg }).catch(() => {});
      await sleep(3000);
      waServer.close(); smsServer.close();
    }
  }

  // ------------------------------------------------------------ 25. platform commission & fee statement
  {
    const st = (await ops('GET', '/v1/billing/statement')).data;
    const orgId = st?.org?.id;
    check('25. the customer sees this month\'s draft statement at the published rates', st?.status === 'draft' && st.plan?.tiers?.map((t: any) => t.rateBps).join() === '800,650,500' && st.plan.tierMode === 'whole', st && { status: st.status, plan: st.plan });
    const s25 = st.sites.find((s: any) => s.siteId === siteId);
    const rows = ((await ops('GET', `/v1/sessions/search?siteId=${siteId}&limit=500`)).data?.rows ?? []).filter((r: any) => r.cdr_id);
    const subtotal = rows.reduce((a: number, r: any) => a + Number(r.subtotal_minor), 0);
    const gross = rows.reduce((a: number, r: any) => a + Number(r.total_minor), 0);
    check('25. commission base = the sessions\' subtotals, excluding PBJT and PPN', !!s25 && s25.gtvMinor === subtotal && s25.grossMinor === gross && gross > subtotal && s25.localTaxMinor + s25.taxMinor === gross - subtotal, s25 && { base: s25.gtvMinor, subtotal, gross, pbjt: s25.localTaxMinor, ppn: s25.taxMinor, sessions: rows.length });
    check('25. this site is in the Standard tier: 8% commission', s25?.tier === 'Standard' && Math.abs(s25.commissionMinor - s25.gtvMinor * 0.08) <= s25.chargers.length, s25 && { tier: s25.tier, commission: s25.commissionMinor, base: s25.gtvMinor });
    const cOk = (s25?.chargers ?? []).every((c: any) => c.topUpMinor === Math.max(0, c.minimumMinor - c.commissionMinor) && c.feeMinor === c.commissionMinor + c.topUpMinor);
    const main = s25?.chargers?.find((c: any) => c.ocppIdentity === ID);
    check('25. each quiet charger is topped up to its pro-rated minimum (DC Rp 350,000 a month; AC Rp 150,000)', cOk && main?.minimumMinor > 0 && main.minimumMinor <= 350_000 && main.kind === 'DC' && st.plan.minPerChargerAcMinor === 150_000 && st.plan.minPerChargerDcMinor === 350_000, main);
    const t = st.totals;
    check('25. PPN on the fee: DPP 11/12, 12% of DPP; MDR credited (commission covers payment processing)', t.netMinor === t.feesMinor - t.mdrCreditMinor && t.taxBaseMinor === Math.round(t.netMinor * 11 / 12) && t.taxMinor === Math.round(t.taxBaseMinor * 0.12) && t.totalMinor === t.netMinor + t.taxMinor, t);

    const csv = await fetch(API + '/v1/billing/statement.csv', { headers: { cookie } });
    const csvText = await csv.text();
    const html = await fetch(API + '/v1/billing/statement.html', { headers: { cookie } });
    const htmlText = await html.text();
    check('25. CSV (one line per charger) and a printable statement', csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') ?? '') && csvText.includes('Commission base (excl. PBJT, PPN)') && csvText.trim().split('\r\n').length === 1 + st.sites.reduce((a: number, s: any) => a + s.chargers.length, 0)
      && html.status === 200 && htmlText.includes('Platform commission &amp; fee statement') && htmlText.includes('DRAFT'), { csv: csv.status, lines: csvText.trim().split('\r\n').length, html: html.status });
    const denied = await ops('PUT', `/v1/platform/billing/orgs/${orgId}/plan`, { plan: { tiers: [{ name: 'Mine', upToMinor: null, rateBps: 0 }] } });
    const deniedModel = await ops('PUT', `/v1/platform/billing/sites/${siteId}/model`, { model: 'private' });
    check('25. a customer administrator cannot change its own commission plan or billing model', denied.status === 403 && deniedModel.status === 403, { plan: denied.status, model: deniedModel.status });

    // The platform operator (a separate account, E2E_PLATFORM_EMAIL / E2E_PLATFORM_PASSWORD).
    let pcookie = '';
    const pa = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(API + path, { method, headers: { cookie: pcookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) pcookie = sc.split(';')[0]!;
      const x = await r.text(); let d: any = x; try { d = JSON.parse(x); } catch {}
      return { status: r.status, data: d };
    };
    const plogin = await pa('POST', '/v1/auth/login', { email: process.env.E2E_PLATFORM_EMAIL ?? 'platform@plugsure.test', password: process.env.E2E_PLATFORM_PASSWORD ?? 'Platform-Test-2026!' });
    if (plogin.status !== 200) {
      console.log('SKIP  25. platform operator checks (create one with: npm run create-admin -- --email platform@plugsure.test --org-slug plugsure-platform --org-name "PlugSure Platform" --password ... --platform-admin)');
    } else {
      try {
        const ov = await pa('GET', '/v1/platform/billing');
        const mine = ov.data?.orgs?.find((o: any) => o.orgId === orgId);
        check('25. platform operator sees every customer\'s month (same figures as the customer)', ov.status === 200 && mine?.totals?.netMinor === st.totals.netMinor && mine.status === 'draft', { status: ov.status, mine: mine?.totals?.netMinor, cust: st.totals.netMinor });
        const bad = await pa('PUT', `/v1/platform/billing/orgs/${orgId}/plan`, { plan: { tiers: [{ name: 'A', upToMinor: 500_000_000, rateBps: 800 }, { name: 'B', upToMinor: 150_000_000, rateBps: 650 }, { name: 'C', upToMinor: null, rateBps: 500 }] } });
        const set = await pa('PUT', `/v1/platform/billing/orgs/${orgId}/plan`, { plan: { tiers: [{ name: 'Standard', upToMinor: 150_000_000, rateBps: 1000 }, { name: 'Volume', upToMinor: 500_000_000, rateBps: 650 }, { name: 'Network', upToMinor: null, rateBps: 500 }], minPerChargerDcMinor: 400_000 } });
        const st2 = (await ops('GET', '/v1/billing/statement')).data;
        const s2 = st2.sites.find((s: any) => s.siteId === siteId);
        const m2 = s2?.chargers?.find((c: any) => c.ocppIdentity === ID);
        check('25. a custom plan (10%, DC minimum Rp 400,000) applies to the draft; an unordered plan is refused', bad.status === 400 && set.status === 200 && s2?.rateBps === 1000 && m2?.minimumMinor > main.minimumMinor, { bad: bad.status, set: set.status, rate: s2?.rateBps, min: [main?.minimumMinor, m2?.minimumMinor] });

        const priv = await pa('PUT', `/v1/platform/billing/sites/${siteId}/model`, { model: 'private' });
        const st3 = (await ops('GET', '/v1/billing/statement')).data;
        const s3 = st3.sites.find((s: any) => s.siteId === siteId);
        check('25. a private site pays the flat platform fee, no commission — and is flagged because drivers paid there', priv.status === 200 && s3?.model === 'private' && s3.commissionMinor === 0 && s3.privateFeeMinor > 0 && s3.warnings.some((w: string) => /should be public/.test(w)), s3 && { model: s3.model, commission: s3.commissionMinor, fee: s3.privateFeeMinor, warnings: s3.warnings });

        const cur = ov.data.current as string;
        const [yy, mm] = cur.split('-').map(Number);
        const prev = mm === 1 ? `${yy! - 1}-12` : `${yy}-${String(mm! - 1).padStart(2, '0')}`;
        const fNow = await pa('POST', `/v1/platform/billing/orgs/${orgId}/finalise`, { month: cur });
        const fPrev = await pa('POST', `/v1/platform/billing/orgs/${orgId}/finalise`, { month: prev });
        const fAgain = await pa('POST', `/v1/platform/billing/orgs/${orgId}/finalise`, { month: prev });
        const stPrev = (await ops('GET', `/v1/billing/statement?month=${prev}`)).data;
        check('25. only an ended month can be finalised, once; the customer then sees it frozen and numbered', fNow.status === 400 && (fPrev.status === 200 || fPrev.status === 409) && fAgain.status === 409 && stPrev?.status === 'final' && /^PSC-\d{6}-/.test(stPrev.number ?? '') && (stPrev.history ?? []).some((h: any) => h.period === prev), { now: fNow.status, prev: fPrev.status, again: fAgain.status, st: stPrev?.status, number: stPrev?.number });
        check('25. last month is billed at the rates in force last month, not the new plan set this month', stPrev?.plan?.tiers?.[0]?.rateBps === 800 && stPrev.plan.minPerChargerDcMinor === 350_000, stPrev?.plan);
        const reprice = await pa('PUT', `/v1/platform/billing/orgs/${orgId}/plan`, { plan: { tiers: [{ name: 'Flat', upToMinor: null, rateBps: 100 }] }, effectiveFrom: prev });
        check('25. a finalised month cannot be re-priced by a back-dated plan', reprice.status === 400 && /final/.test(JSON.stringify(reprice.data)), reprice);
      } finally {
        await pa('PUT', `/v1/platform/billing/sites/${siteId}/model`, { model: 'public' }).catch(() => {});
        await pa('PUT', `/v1/platform/billing/orgs/${orgId}/plan`, { plan: null }).catch(() => {});
      }
      const st4 = (await ops('GET', '/v1/billing/statement')).data;
      const ov4 = (await pa('GET', '/v1/platform/billing')).data?.orgs?.find((o: any) => o.orgId === orgId);
      check('25. reset follows the published rates (8%, AC minimum Rp 150,000; not "custom") and a public site', st4.plan.tiers[0].rateBps === 800 && st4.plan.minPerChargerAcMinor === 150_000 && st4.sites.find((s: any) => s.siteId === siteId)?.model === 'public' && ov4?.customPlan === false, { rate: st4.plan.tiers[0].rateBps, ac: st4.plan.minPerChargerAcMinor, custom: ov4?.customPlan });
    }
  }

  // ------------------------------------------------------------ 26. site owners: portal sign-in and per-owner billing
  {
    const tag = Date.now().toString(36);
    const ow = await ops('POST', '/v1/owners', { name: `E2E Hotel ${tag}`, legalName: `PT E2E Hotel ${tag}`, npwp: '01.234.567.8-901.000', contactEmail: `owner-${tag}@hotel.test` });
    const badOw = await ops('POST', '/v1/owners', { name: 'Bad', npwp: '123' });
    const ownerId = ow.data?.id;
    const assign = await ops('PUT', `/v1/owners/${ownerId}/sites`, { siteIds: [siteId] });
    check('26. operator adds a site owner and assigns the field site; a malformed NPWP is refused', ow.status === 201 && assign.status === 200 && badOw.status === 400, { ow: ow.data, assign: assign.data, bad: badOw.data });

    // A second owner cannot take a site that has charging history with the first.
    const ow2 = await ops('POST', '/v1/owners', { name: `E2E Other ${tag}` });
    const steal = await ops('PUT', `/v1/owners/${ow2.data?.id}/sites`, { siteIds: [siteId] });
    await ops('PUT', `/v1/owners/${ownerId}/sites`, { siteIds: [] });
    const viaNone = await ops('PUT', `/v1/owners/${ow2.data?.id}/sites`, { siteIds: [siteId] });
    const back = await ops('PUT', `/v1/owners/${ownerId}/sites`, { siteIds: [siteId] });
    check('26. a site with charging history cannot move to a different owner — not directly, not via "no owner"', steal.status === 409 && /history/.test(JSON.stringify(steal.data)) && viaNone.status === 409 && back.status === 200, { steal: steal.status, viaNone: viaNone.status, back: back.status });

    const email = `owner-${tag}@hotel.test`;
    const inv = await ops('POST', '/v1/users', { name: 'E2E Hotel Owner', email, role: 'site_owner', ownerId });
    const invBad = await ops('POST', '/v1/users', { name: 'No owner', email: `x-${tag}@hotel.test`, role: 'site_owner' });
    check('26. a Site Owner portal user is invited with a one-time password; the role needs an owner', inv.status === 200 && !!inv.data?.temporaryPassword && invBad.status === 400, { inv: inv.status, bad: invBad.data });

    let ocookie = '';
    const oc = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(API + path, { method, headers: { cookie: ocookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) ocookie = sc.split(';')[0]!;
      const x = await r.text(); let d: any = x; try { d = JSON.parse(x); } catch {}
      return { status: r.status, data: d, headers: r.headers };
    };
    const ol = await oc('POST', '/v1/auth/login', { email, password: inv.data.temporaryPassword });
    // With the one-time password, the API serves only what is needed to replace it.
    const blocked = await Promise.all(['/v1/charge-points', '/v1/sessions/search', '/v1/billing/statement', '/v1/dashboard'].map(async (p) => (await oc('GET', p))));
    const meTemp = await oc('GET', '/v1/auth/me');
    const metaTemp = await oc('GET', '/v1/meta');
    check('26. with the one-time password the API refuses everything except who-am-I, reference data and the password change',
      blocked.every((r) => r.status === 403 && r.data?.code === 'password_change_required') && meTemp.status === 200 && meTemp.data?.user?.mustChangePassword === true && metaTemp.status === 200,
      { blocked: blocked.map((r) => r.status), me: meTemp.status, meta: metaTemp.status });
    const newPw = `Owner-Portal-${tag}-2026!`;
    const cp = await oc('POST', '/v1/auth/change-password', { current: inv.data.temporaryPassword, next: newPw });
    const me = await oc('GET', '/v1/auth/me');
    check('26. the owner signs in with e-mail and password, sets its own password, and is in the owner portal', ol.status === 200 && ol.data?.mustChangePassword === true && cp.status === 200
      && me.data?.owners?.[0]?.id === ownerId && JSON.stringify(me.data?.visibleSites) === JSON.stringify([siteId])
      && !me.data?.permissions?.includes('charge_point:command') && !me.data?.permissions?.includes('tariff:read'), { me: me.data && { owners: me.data.owners, sites: me.data.visibleSites, perms: me.data.permissions } });

    const cps = await oc('GET', '/v1/charge-points');
    const opsCps = await ops('GET', '/v1/charge-points');
    const sess = await oc('GET', '/v1/sessions/search?limit=500');
    check('26. the owner sees only its own chargers and sessions', cps.status === 200 && cps.data.length >= 1 && cps.data.every((c: any) => c.site_id === siteId) && opsCps.data.length > cps.data.length
      && sess.status === 200 && sess.data.rows.length > 0 && sess.data.rows.every((r: any) => r.site_id === siteId), { mine: cps.data?.length, all: opsCps.data?.length, sessions: sess.data?.rows?.length });
    // Drivers' card numbers (the credential on UID-only cards) and names are not the owner's to see.
    const withCard = sess.data.rows.filter((r: any) => r.id_tag);
    const opRows = (await ops('GET', `/v1/sessions/search?siteId=${siteId}&limit=500`)).data.rows;
    const fullTag = opRows.find((r: any) => r.id_tag && r.id_tag.length > 6)?.id_tag as string;
    check('26. the owner sees drivers\' cards masked to the last 4 characters and no holder names; the operator sees them',
      withCard.length > 0 && withCard.every((r: any) => /^••••/.test(r.id_tag) && r.holder_name == null) && !!fullTag && !fullTag.startsWith('••••'),
      { sample: withCard[0]?.id_tag, op: fullTag });
    const probe = await oc('GET', `/v1/sessions/search?q=${encodeURIComponent(fullTag.slice(0, 5))}`);
    const opProbe = await ops('GET', `/v1/sessions/search?siteId=${siteId}&q=${encodeURIComponent(fullTag.slice(0, 5))}`);
    check('26. the owner cannot rebuild a card number by searching part of it (whole-value matches only)', probe.status === 200 && probe.data.rows.length === 0 && opProbe.data.rows.length > 0, { owner: probe.data?.rows?.length, op: opProbe.data?.rows?.length });
    const ocsv = await fetch(API + '/v1/sessions.csv', { headers: { cookie: ocookie } });
    const ocsvText = await ocsv.text();
    const orc = await fetch(API + `/v1/sessions/${withCard[0].id}/receipt`, { headers: { cookie: ocookie } });
    const orcText = await orc.text();
    check('26. the owner\'s session CSV and tax receipt carry the masked card too', ocsv.status === 200 && !ocsvText.includes(fullTag) && ocsvText.includes('••••') && orc.status === 200 && orcText.includes('••••') && !orcText.includes(fullTag), { csv: ocsv.status, receipt: orc.status });
    const ownFr = await oc('GET', `/v1/charge-points/${encodeURIComponent(ID)}/frames`);
    const ownFrNd = await oc('GET', `/v1/charge-points/${encodeURIComponent(ID)}/frames.ndjson`);
    const ownFrLive = await oc('GET', '/v1/events/frames');
    const opFr = await ops('GET', `/v1/charge-points/${encodeURIComponent(ID)}/frames`);
    check('26. the raw OCPP log (with idTags) is refused to the owner, even for its own charger; the operator has it', ownFr.status === 403 && ownFrNd.status === 403 && ownFrLive.status === 403 && opFr.status === 200, { owner: [ownFr.status, ownFrNd.status, ownFrLive.status], op: opFr.status });

    const other = opsCps.data.find((c: any) => c.site_id !== siteId);
    const otherDetail = other ? await oc('GET', `/v1/charge-points/${encodeURIComponent(other.ocpp_identity)}`) : { status: 0 };
    const otherFrames = other ? await oc('GET', `/v1/charge-points/${encodeURIComponent(other.ocpp_identity)}/frames`) : { status: 0 };
    const cmd = await oc('POST', `/v1/charge-points/${encodeURIComponent(ID)}/commands/reserve-now`, { connectorId: 2, idTag: 'ID-RFID-0001', expiryDate: iso(900), reservationId: 7099 });
    const denied = await Promise.all(['/v1/users', '/v1/billing/owners', '/v1/owners', '/v1/tariffs', '/v1/connection-attempts', '/v1/stream'].map(async (p) => [p, (await oc('GET', p)).status] as const));
    check('26. another owner\'s charger, commands and operator pages are refused', [403, 404].includes(otherDetail.status) && [403, 404].includes(otherFrames.status) && cmd.status === 403 && denied.every(([, s]) => s === 403),
      { other: otherDetail.status, frames: otherFrames.status, cmd: cmd.status, denied });
    const alerts = await oc('GET', '/v1/alerts');
    const dash = await oc('GET', '/v1/dashboard');
    check('26. the owner\'s dashboard shows its own revenue, and alerts only for its site', alerts.status === 200 && alerts.data.every((a: any) => a.site_id === siteId) && dash.status === 200 && dash.data.today != null && dash.data.chargers.total === cps.data.length,
      { alerts: alerts.data?.length, today: dash.data?.today, chargers: dash.data?.chargers });

    const ost = await oc('GET', '/v1/billing/statement');
    const t = ost.data?.totals;
    check('26. the owner sees its own statement: units, amounts and its share', ost.status === 200 && ost.data.owner?.id === ownerId && ost.data.sites.length === 1 && ost.data.sites[0].siteId === siteId
      && ost.data.billTo?.name === `PT E2E Hotel ${tag}` && t.energyKwh > 0 && t.ownerShareMinor + t.platformShareMinor + t.mdrEstimateMinor === t.gtvMinor, t && { base: t.gtvMinor, owner: t.ownerShareMinor, op: t.platformShareMinor, mdr: t.mdrEstimateMinor, kwh: t.energyKwh });
    const spoof = await oc('GET', `/v1/billing/statement?ownerId=${ow2.data?.id}`);
    const ohtml = await fetch(API + '/v1/billing/statement.html', { headers: { cookie: ocookie } });
    const ohtmlText = await ohtml.text();
    check('26. the owner cannot open another owner\'s statement; its printable statement shows its share', spoof.status === 404 && ohtml.status === 200 && ohtmlText.includes('Your share') && ohtmlText.includes(`PT E2E Hotel ${tag}`), { spoof: spoof.status, html: ohtml.status });
    const planTry = await oc('PUT', `/v1/billing/owners/${ownerId}/plan`, { plan: { tiers: [{ name: 'Free', upToMinor: null, rateBps: 0 }] } });
    check('26. the owner cannot change its own commission plan', planTry.status === 403, planTry.status);

    // Operator Billing: every owner with units, amounts and shares, and totals.
    const bo = await ops('GET', '/v1/billing/owners');
    const row = bo.data?.owners?.find((o: any) => o.ownerId === ownerId);
    const T = bo.data?.totals;
    const all = [...(bo.data?.owners ?? []), bo.data?.operatorOwn];
    const sumOf = (k: string) => all.reduce((a: number, r: any) => a + Number(r?.[k] ?? 0), 0);
    check('26. Billing shows the owner\'s units and amounts, matching its statement', bo.status === 200 && row?.baseMinor === t.gtvMinor && row.ownerShareMinor === t.ownerShareMinor && row.platformShareMinor === t.platformShareMinor && Math.abs(row.energyKwh - t.energyKwh) < 0.01 && row.sessions === t.sessions, { row, stmt: t && { base: t.gtvMinor, kwh: t.energyKwh } });
    check('26. Billing totals add up across owners and the operator\'s own sites', !!T && T.baseMinor === sumOf('baseMinor') && T.ownerShareMinor === sumOf('ownerShareMinor') && T.platformShareMinor === sumOf('platformShareMinor') && T.sessions === sumOf('sessions')
      && T.baseMinor === T.ownerShareMinor + T.platformShareMinor + T.mdrMinor, T);

    const op1 = await ops('PUT', `/v1/billing/owners/${ownerId}/plan`, { plan: { tiers: [{ name: 'Hotel', upToMinor: null, rateBps: 700 }] } });
    const ost2 = await oc('GET', '/v1/billing/statement');
    check('26. an owner-specific plan (7%) applies to that owner only', op1.status === 200 && ost2.data.sites[0].tier === 'Hotel' && ost2.data.plan.tiers[0].rateBps === 700, { op1: op1.status, tier: ost2.data?.sites?.[0]?.tier });

    // Receipts: operator by default; the owner once it is seller of record.
    const sid = sess.data.rows.find((r: any) => r.cdr_id)?.id;
    const rc1 = await (await fetch(API + `/v1/sessions/${sid}/receipt`, { headers: { cookie } })).text();
    await ops('PUT', `/v1/owners/${ownerId}`, { sellerOfRecord: 'owner' });
    const rc2 = await (await fetch(API + `/v1/sessions/${sid}/receipt`, { headers: { cookie } })).text();
    await ops('PUT', `/v1/owners/${ownerId}`, { sellerOfRecord: 'operator' });
    check('26. driver receipts name the operator, or the owner once it is seller of record', !rc1.includes(`PT E2E Hotel ${tag}`) && rc2.includes(`PT E2E Hotel ${tag}`) && rc2.includes('01.234.567.8-901.000'), { sid });

    // A charger moved onto the owner's site does not bring its old OCPP log (RFID idTags) along.
    const siteB = await ops('POST', '/v1/sites', { name: `E2E Other site ${tag}`, address: 'Jl. Lain', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '53', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000' });
    const IDM = `FIELDMV-${tag}`.slice(0, 20);
    const regM = await ops('POST', '/v1/charge-points', { ocppIdentity: IDM, siteId: siteB.data.id, displayName: 'Moved unit', ocppVersion: 'ocpp1.6',
      evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
    if (regM.status !== 200) console.log('setup for move check:', siteB.status, JSON.stringify(siteB.data).slice(0, 200), regM.status, JSON.stringify(regM.data).slice(0, 300));
    await ops('POST', `/v1/charge-points/${IDM}/activate`);
    const mv = new Raw(IDM); raws.push(mv);
    await mv.connect(); await mv.boot(); await mv.call('Authorize', { idTag: 'SECRET-CARD-OLD-OWNER' });
    await sleep(1200);
    const moved = await ops('PUT', `/v1/charge-points/${IDM}`, { siteId });
    await mv.call('Heartbeat', {});
    await sleep(800);
    const ownFrames = await oc('GET', `/v1/charge-points/${IDM}/frames`);
    const opFrames = await ops('GET', `/v1/charge-points/${IDM}/frames`);
    const ownDetail = await oc('GET', `/v1/charge-points/${IDM}`);
    check('26. a charger moved onto the owner\'s site: the owner sees the charger but not its OCPP log (old idTags); the operator has the full log',
      moved.status === 200 && ownDetail.status === 200 && ownFrames.status === 403 && !JSON.stringify(ownFrames.data).includes('SECRET-CARD-OLD-OWNER')
      && JSON.stringify(opFrames.data).includes('SECRET-CARD-OLD-OWNER'), { moved: moved.status, detail: ownDetail.status, own: ownFrames.status, op: opFrames.data?.length });

    // An administrator resets the owner's password: the signed-in session ends, and the new
    // one-time password — also via a bearer session token — again opens only the password change.
    const users = (await ops('GET', '/v1/users')).data ?? [];
    const ou = users.find((u: any) => u.email === email);
    const reset = await ops('POST', `/v1/users/${ou?.id}/reset-password`);
    const ended = await oc('GET', '/v1/charge-points');
    await oc('POST', '/v1/auth/login', { email, password: reset.data?.temporaryPassword });
    const heldCookie = await oc('GET', '/v1/charge-points');
    const heldBearer = await fetch(API + '/v1/charge-points', { headers: { authorization: `Bearer ${decodeURIComponent(ocookie.split('=').slice(1).join('='))}` } });
    const cp2 = await oc('POST', '/v1/auth/change-password', { current: reset.data?.temporaryPassword, next: `${newPw}x` });
    const freed = await oc('GET', '/v1/charge-points');
    check('26. after a password reset: the old session ends, and the new one-time password (cookie or bearer) opens only the password change',
      reset.status === 200 && ended.status === 401 && heldCookie.status === 403 && heldCookie.data?.code === 'password_change_required' && heldBearer.status === 403 && cp2.status === 200 && freed.status === 200,
      { reset: reset.status, ended: ended.status, cookie: heldCookie.status, bearer: heldBearer.status, change: cp2.status, after: freed.status });

    // Archiving the owner shuts its portal users out.
    await ops('PUT', `/v1/owners/${ownerId}`, { archived: true });
    const after = await oc('GET', '/v1/charge-points');
    await ops('PUT', `/v1/owners/${ownerId}`, { archived: false });
    check('26. archiving an owner removes its portal users\' access at once', after.status === 403 || (after.status === 200 && after.data.length === 0), { status: after.status, n: after.data?.length });
    await ops('PUT', `/v1/billing/owners/${ownerId}/plan`, { plan: null });
  }

  // ------------------------------------------------------------ 13. heartbeat + status for the whole station (connector 0)
  {
    const hb = await c.call('Heartbeat', {});
    const st0 = await c.status(0, 'Faulted', 'OtherError', { info: 'cabinet over-temperature' });
    const cp = await until(() => ops('GET', '/v1/charge-points'), (r) => r.data?.find?.((x: any) => x.ocpp_identity === ID)?.status === 'faulted', 6000, 400);
    check('13. station-level fault (connector 0) marks the charger faulted', !!hb.currentTime && !st0.__error && cp.data?.find?.((x: any) => x.ocpp_identity === ID)?.status === 'faulted', cp.data?.find?.((x: any) => x.ocpp_identity === ID)?.status);
    await c.status(0, 'Available');
    const cp2 = await until(() => ops('GET', '/v1/charge-points'), (r) => r.data?.find?.((x: any) => x.ocpp_identity === ID)?.status !== 'faulted', 6000, 400);
    check('13. and recovers when the station reports Available again', cp2.data?.find?.((x: any) => x.ocpp_identity === ID)?.status !== 'faulted', cp2.data?.find?.((x: any) => x.ocpp_identity === ID)?.status);
  }
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  for (const r of raws) r.close();
  (globalThis as any).__receiver?.close?.();
  const wh = (globalThis as any).__wh;
  if (wh?.whId) await ops('DELETE', `/v1/webhooks/${wh.whId}`).catch(() => {});
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
