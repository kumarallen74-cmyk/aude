import { connect, boot, sleep, API } from './lib.js';
import pg from 'pg';

const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_a' });
const now = () => new Date().toISOString();
const p = (s: string, v: any) => console.log(`  ${s.padEnd(46)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);

async function main() {
  const c = await connect('AUTEL-AC22-SMB-001');
  const seen: any[] = [];
  let mode: 'accept' | 'reject' | 'notsupported' = 'accept';
  c.onCall = (action, payload, id) => {
    seen.push({ action, payload });
    console.log(`  <-- CSMS sent ${action}: ${JSON.stringify(payload)}`);
    if (action === 'SetChargingProfile')
      return { status: mode === 'accept' ? 'Accepted' : mode === 'reject' ? 'Rejected' : 'NotSupported' };
    if (action === 'GetConfiguration') return { configurationKey: [{ key: 'NumberOfConnectors', value: '1', readonly: true }] };
    return { status: 'Accepted' };
  };
  await boot(c);
  await sleep(2500);
  seen.length = 0;

  await c.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Charging', timestamp: now() });
  const tx = await c.call('StartTransaction', { connectorId: 1, idTag: 'ID-RFID-0001', meterStart: 0, timestamp: now() });
  p('transactionId', tx);
  await sleep(400);

  const site = (await db.query(`SELECT id FROM site LIMIT 1`)).rows[0].id;
  await fetch(`${API}/v1/sites/${site}/power/budget`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ceilingW: 20000, reserveW: 2000 }),
  });

  console.log('\n=== control loop pass 1 (SetChargingProfile -> Accepted) ===');
  seen.length = 0;
  await fetch(`${API}/v1/sites/${site}/power/apply`, { method: 'POST' });
  await sleep(1200);
  p('messages the CSMS sent this pass', seen.map((s) => s.action));
  p('ChargePointMaxProfile ever sent?', seen.some((s) => JSON.stringify(s.payload).includes('ChargePointMaxProfile')));
  p('TxDefaultProfile ever sent?', seen.some((s) => JSON.stringify(s.payload).includes('TxDefaultProfile')));

  console.log('\n=== control loop pass 2 (charger REJECTS the profile) ===');
  mode = 'reject'; seen.length = 0;
  await fetch(`${API}/v1/sites/${site}/power/apply`, { method: 'POST' });
  await sleep(1200);
  let rows = await db.query(`SELECT state, count(*)::int n FROM charging_profile GROUP BY state ORDER BY state`);
  p('charging_profile rows by state', rows.rows);
  p('any retry / alert on Rejected?', 'check server log for a retry — see below');

  console.log('\n=== control loop pass 3 (charger says NotSupported) ===');
  mode = 'notsupported'; seen.length = 0;
  await fetch(`${API}/v1/sites/${site}/power/apply`, { method: 'POST' });
  await sleep(1200);
  rows = await db.query(`SELECT state, count(*)::int n FROM charging_profile GROUP BY state ORDER BY state`);
  p('charging_profile rows by state', rows.rows);

  console.log('\n=== end the session: is the profile CLEARED? ===');
  mode = 'accept'; seen.length = 0;
  await c.call('StopTransaction', { transactionId: tx.transactionId, meterStop: 5000, timestamp: now(), reason: 'Local' });
  await c.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: now() });
  await sleep(500);
  await fetch(`${API}/v1/sites/${site}/power/apply`, { method: 'POST' });
  await sleep(1200);
  p('messages sent after session end', seen.map((s) => s.action));
  p('ClearChargingProfile sent?', seen.some((s) => s.action === 'ClearChargingProfile'));

  console.log('\n=== budget INCREASED — is the old cap lifted? ===');
  await fetch(`${API}/v1/sites/${site}/power/budget`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ceilingW: 150000, reserveW: 0 }),
  });
  seen.length = 0;
  await fetch(`${API}/v1/sites/${site}/power/apply`, { method: 'POST' });
  await sleep(1200);
  p('messages sent after budget increase', seen.map((s) => s.action));

  console.log('\n=== profile row growth (control loop runs every 30 s) ===');
  const tot = await db.query(`SELECT count(*)::int n FROM charging_profile`);
  p('total charging_profile rows so far', tot.rows[0].n);
  const last = await db.query(`SELECT purpose, stack_level, ocpp_profile_id, limit_w, duration_s, state FROM charging_profile ORDER BY id DESC LIMIT 4`);
  console.table(last.rows);

  console.log('\n=== GetCompositeSchedule / ClearCache / ReserveNow reachable from the API? ===');
  for (const cmd of ['get-composite-schedule', 'clear-cache', 'reserve-now', 'cancel-reservation', 'get-diagnostics', 'update-firmware', 'change-availability', 'clear-charging-profile', 'data-transfer', 'get-local-list-version', 'send-local-list']) {
    const r = await fetch(`${API}/v1/charge-points/AUTEL-AC22-SMB-001/commands/${cmd}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    p(`POST commands/${cmd}`, `HTTP ${r.status} ${(await r.text()).slice(0, 70)}`);
  }

  await db.end(); c.close(); process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
