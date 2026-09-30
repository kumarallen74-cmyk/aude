// PlugSure v1.3 — the developer sandbox speaking OCPP 2.0.1 and 2.1, end to end.
//
// Virtual chargers registered in a sandbox as 2.0.1 and 2.1 connect speaking
// that protocol (TransactionEvent, RequestStart/StopTransaction, SetVariables),
// sign their meter readings (OCMF) with a meter key the sandbox registers for
// them, and on 2.1 the virtual car offers to give energy back (ISO 15118-20):
// DC_BPT on a DC charger, AC_BPT on an AC one. With the fleet's standing consent
// the CSMS asks it to discharge, the export register rises, the SoC falls, and
// the session is billed with the credit.
//
// Same prerequisites as api-sandbox-e2e.mts (stack running, OCPP_VERSIONS with
// ocpp2.0.1 and ocpp2.1).
//     npx tsx tools/e2e/sandbox-2x-e2e.mts
// NEVER point this at production.

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000, every = 700): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, text };
}
let cookie = '';
const ops = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
};
let KEY = '';
const sb = (method: string, path: string, body?: unknown) => http(method, path, body, { authorization: `Bearer ${KEY}` });
const simulate = (id: string, event: string, extra: Record<string, unknown> = {}) => sb('POST', `/v1/sandbox/chargers/${id}/simulate`, { event, ...extra });
const sessionsOf = async (id: string) => { const r = await sb('GET', `/v1/sessions?identity=${id}`); return Array.isArray(r.data) ? r.data : []; };
const RUN = Date.now().toString().slice(-5);

let sandboxId = '';
try {
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  for (const s of (await ops('GET', '/v1/sandboxes')).data.sandboxes ?? []) if (/E2E/.test(s.name)) await ops('DELETE', `/v1/sandboxes/${s.id}`);
  const created = await ops('POST', '/v1/sandboxes', { name: 'OCPP2 E2E' });
  KEY = created.data.apiKey;
  sandboxId = created.data.id;
  const siteId = created.data.siteId as string;
  check('setup: a sandbox with its key and site', created.status === 201 && !!KEY && !!siteId, created.data);

  // ─────────────────────────────────────────── virtual chargers on 2.0.1 and 2.1
  const V201 = `SBX-201-${RUN}`, V21 = `SBX-21DC-${RUN}`, V21AC = `SBX-21AC-${RUN}`;
  const dc = { connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000 };
  const ac = { connectorType: 'sType2', currentKind: 'AC3', maxPowerW: 11000 };
  const register = async (id: string, v: string, c: Record<string, unknown>) => {
    const r = await sb('POST', '/v1/charge-points', { ocppIdentity: id, siteId, displayName: `${v} ${c.currentKind}`, ocppVersion: v,
      evses: [{ evseId: 1, connectors: [{ connectorId: 1, ...c, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
    const a = await sb('POST', `/v1/charge-points/${id}/activate`);
    return r.status === 200 && a.status === 200 ? null : { r: r.data, a: a.data };
  };
  const regErr = [await register(V201, 'ocpp2.0.1', dc), await register(V21, 'ocpp2.1', dc), await register(V21AC, 'ocpp2.1', ac)].filter(Boolean);
  const up = await until(() => sb('GET', '/v1/charge-points'), (r) => [V201, V21, V21AC].every((id) => r.data?.find?.((c: any) => c.ocpp_identity === id)?.online === true), 45_000, 1000);
  const byId = (id: string) => up.data?.find?.((c: any) => c.ocpp_identity === id);
  check('sandbox: chargers registered as OCPP 2.0.1 and 2.1 come online as virtual chargers speaking that protocol',
    regErr.length === 0 && [V201, V21, V21AC].every((id) => byId(id)?.online === true)
      && byId(V201)?.ocpp_version === 'ocpp2.0.1' && byId(V21)?.ocpp_version === 'ocpp2.1' && byId(V21AC)?.ocpp_version === 'ocpp2.1',
    { regErr, fleet: up.data?.map?.((c: any) => [c.ocpp_identity, c.online, c.ocpp_version]) });
  const detail = await sb('GET', `/v1/charge-points/${V201}`);
  const conn = detail.data?.evses?.[0]?.connectors?.[0] ?? detail.data?.connectors?.[0];
  check('sandbox: the virtual charger\'s signing meter is registered on its connector (public key and serial)',
    /^3059/.test(conn?.meter_public_key ?? '') && conn?.meter_serial === `SBX-MTR-${V201}`, conn);

  // ─────────────────────────────────────────── 2.0.1: a card tap, signed readings, verified
  const tap = await simulate(V201, 'tap-card', { idTag: 'SANDBOX-RFID-0001', kwh: 1 });
  const done = await until(() => sessionsOf(V201), (l) => l.some((s: any) => s.ended_at), 45_000, 1000);
  const s1 = done.find((s: any) => s.ended_at);
  const d1 = s1 ? (await until(() => sb('GET', `/v1/sessions/${s1.id}`), (r) => r.data?.signed_status != null && r.data?.total_idr != null, 10_000)).data : null;
  check('2.0.1: a tapped card charges 1 kWh through TransactionEvents (a string transaction id) and the session is billed',
    tap.status === 200 && !!d1 && Math.abs(Number(d1.energy_wh) - 1000) <= 60 && typeof d1.ocpp_transaction_id === 'string' && !/^\d+$/.test(d1.ocpp_transaction_id) && d1.total_idr > 0,
    { tap: tap.data, d: d1 && { e: d1.energy_wh, tx: d1.ocpp_transaction_id, t: d1.total_idr } });
  check('2.0.1: the meter\'s signed start and end readings (OCMF in signedMeterValue) verify against the registered key and match the bill',
    d1?.signed_status === 'verified' && Math.abs(Number(d1.signed_energy_wh) - Number(d1.energy_wh)) <= 2, { st: d1?.signed_status, d: d1?.signed_detail });
  const sd = d1 ? await sb('GET', `/v1/sessions/${d1.id}/signed-data`) : null;
  check('2.0.1: the signed data holds the begin and end readings, each valid, with the sandbox meter\'s serial',
    sd?.data?.values?.length === 2 && sd.data.values.every((v: any) => v.verifyStatus === 'valid' && v.keySource === 'registered') && sd.data.meterSerial === `SBX-MTR-${V201}`,
    sd?.data);

  // ─────────────────────────────────────────── 2.0.1: remote start and stop through the API
  const rs = await sb('POST', `/v1/charge-points/${V201}/remote-start`, { connectorId: 1, idTag: 'SANDBOX-RFID-0001' });
  const live = await until(() => sessionsOf(V201), (l) => l.some((s: any) => !s.ended_at && s.energy_wh > 0), 40_000, 1000);
  const running = live.find((s: any) => !s.ended_at);
  const stop = await sb('POST', `/v1/charge-points/${V201}/remote-stop`, { transactionId: running?.ocpp_transaction_id });
  const ended = await until(() => sb('GET', `/v1/sessions/${running?.id}`), (r) => !!r.data?.ended_at, 30_000, 1000);
  check('2.0.1: remote start (RequestStartTransaction) and remote stop (RequestStopTransaction) run a metered session',
    rs.status === 200 && rs.data.status === 'Accepted' && !!running && stop.status === 200 && !!ended.data?.ended_at && ended.data.signed_status === 'verified',
    { rs: rs.data, stop: stop.data, st: ended.data?.signed_status });

  // ─────────────────────────────────────────── 2.0.1: switching signing off, then on (SetVariables)
  const off = await sb('POST', `/v1/charge-points/${V201}/signed-metering`, { enabled: false });
  await simulate(V201, 'tap-card', { idTag: 'SANDBOX-RFID-0001', kwh: 0.5 });
  const unsigned = await until(() => sessionsOf(V201), (l) => l.filter((s: any) => s.ended_at).length >= 3, 45_000, 1000);
  const s3 = unsigned.filter((s: any) => s.ended_at).sort((a: any, b: any) => String(b.started_at).localeCompare(String(a.started_at)))[0];
  const d3 = s3 ? (await sb('GET', `/v1/sessions/${s3.id}`)).data : null;
  const on = await sb('POST', `/v1/charge-points/${V201}/signed-metering`, { enabled: true });
  check('2.0.1: SetVariables SignReadings=false is accepted by the virtual station and it stops signing; switching it back on is accepted',
    off.status === 200 && off.data.accepted === true && d3?.signed_status == null && on.status === 200 && on.data.accepted === true,
    { off: off.data, st: d3?.signed_status, on: on.data });

  // ─────────────────────────────────────────── 2.1: V2G with the fleet's consent (DC_BPT and AC_BPT)
  const prog = await sb('PUT', `/v1/sites/${siteId}`, { v2xEnabled: true, v2xWindows: '00:00-00:00', v2xMinSocPercent: 20, v2xCreditIdrPerKwh: 2000, v2xAllowExport: true });
  const fleets = await sb('GET', '/v1/fleet-accounts');
  const fleet = (fleets.data?.accounts ?? []).find((a: any) => /Sandbox Logistik/.test(a.name));
  const consent = await sb('PUT', `/v1/fleet-accounts/${fleet?.id}`, { v2xAllowed: true, v2xMinSocPercent: 30 });
  check('2.1 setup: the sandbox site runs a bidirectional programme and the sandbox fleet gives standing consent',
    prog.status === 200 && consent.status === 200 && consent.data.v2x_allowed === true, { prog: prog.data, fleets: fleets.status, consent: consent.data });

  const v2g = async (id: string, mode: 'DC_BPT' | 'AC_BPT', expectW: number) => {
    await simulate(id, 'tap-card', { idTag: 'SANDBOX-FLEET-0002', kwh: 30, soc: 70 });
    const act = await until(() => sessionsOf(id), (l) => l.some((s: any) => !s.ended_at), 20_000, 700);
    const sid = act.find((s: any) => !s.ended_at)?.id;
    const dis = await until(() => sb('GET', `/v1/sessions/${sid}`), (r) => r.data?.v2x?.discharging === true, 30_000, 1000);
    const v = dis.data?.v2x;
    check(`2.1 ${mode}: the virtual car offers ${mode} and, with the fleet's consent, is asked to give back ${expectW / 1000} kW`,
      v?.discharging === true && v.consent === true && v.consentSource === 'fleet' && v.needs?.requestedTransfer === mode && v.needs.bidirectional === true && v.dischargeW === expectW,
      v ? { discharging: v.discharging, why: v.notDischargingBecause, w: v.dischargeW, soc: v.socPercent, needs: v.needs?.requestedTransfer } : dis.data);
    // Let it discharge for a few (simulated) minutes; the export register rises and the SoC falls.
    const first = (await simulate(id, 'status')).data?.charger;
    const flowing = await until(() => simulate(id, 'status'), (r) => r.data?.charger?.exportWh > (first?.exportWh ?? 0) + 600, 30_000, 1000);
    const ch = flowing.data?.charger;
    check(`2.1 ${mode}: energy flows back — the station's export register rises and the car's SoC falls`,
      ch?.dischargeW === expectW && ch.exportWh > (first?.exportWh ?? 0) + 600 && ch.socPercent < first?.socPercent, { first: [first?.exportWh, first?.socPercent, first?.dischargeW], now: [ch?.exportWh, ch?.socPercent, ch?.dischargeW, ch?.charging] });
    const tx = (await sb('GET', `/v1/sessions/${sid}`)).data?.ocpp_transaction_id;
    await sb('POST', `/v1/charge-points/${id}/remote-stop`, { transactionId: tx });
    const billed = await until(() => sb('GET', `/v1/sessions/${sid}`), (r) => !!r.data?.ended_at && r.data?.total_idr != null, 30_000, 1000);
    const b = billed.data;
    check(`2.1 ${mode}: the session ends and is billed with the discharge credit (2000 IDR/kWh), its signed readings verified`,
      !!b?.ended_at && b.v2x?.exportWh > 0 && b.v2x.creditIdr === Math.floor(b.v2x.exportWh * 2) && b.signed_status === 'verified',
      { st: b?.signed_status, d: b?.signed_detail, t: b?.total_idr, e: b?.v2x?.exportWh, c: b?.v2x?.creditIdr });
  };
  await v2g(V21, 'DC_BPT', 11000);
  await v2g(V21AC, 'AC_BPT', 11000);

  // 2.0.1 has no bidirectional transfer: the same fleet car is never asked to discharge there.
  await simulate(V201, 'tap-card', { idTag: 'SANDBOX-FLEET-0002', kwh: 60, soc: 70 });
  await sleep(8000);
  const s201 = (await sessionsOf(V201)).find((s: any) => !s.ended_at);
  const v201 = s201 ? (await sb('GET', `/v1/sessions/${s201.id}`)).data?.v2x : null;
  check('2.0.1: a car on a 2.0.1 station is never asked to discharge (bidirectional transfer is 2.1 only)', !!s201 && !v201?.discharging, { v201, sessions: (await sessionsOf(V201)).map((s: any) => [s.id_tag, s.ended_at]) });
  await simulate(V201, 'stop');
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  if (sandboxId) await ops('DELETE', `/v1/sandboxes/${sandboxId}`).catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
