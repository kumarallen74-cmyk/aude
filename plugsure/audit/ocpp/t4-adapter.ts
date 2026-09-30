import { connect, boot, sleep } from './lib.js';
import pg from 'pg';

const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_a' });
const now = () => new Date().toISOString();
const p = (s: string, v: any) => console.log(`  ${s.padEnd(50)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);

async function main() {
  console.log('=== BootNotification: are Pending/Rejected reachable? ===');
  const c = await connect('AUDIT-ADAPT-01');
  p('normal boot', await boot(c));
  p('boot with NO vendor/model (both mandatory in 1.6)', await c.call('BootNotification', {}));
  // park a CP: set status to pending_adoption and re-boot
  await db.query(`UPDATE charge_point SET status='pending_adoption' WHERE ocpp_identity='AUDIT-ADAPT-01'`);
  p('boot while status=pending_adoption', await boot(c));
  const statuses = await db.query(
    `SELECT DISTINCT payload->2->>'status' AS s FROM ocpp_frame
      WHERE direction='out' AND message_type=3 AND ocpp_identity LIKE 'AUDIT%' AND payload->2 ? 'interval'`);
  p('every BootNotification.conf status ever emitted', statuses.rows.map((r) => r.s));

  console.log('\n=== Authorize / idTagInfo completeness ===');
  await db.query(`UPDATE token SET valid_to = now() + interval '30 days' WHERE uid='ID-RFID-0002'`);
  p('valid token with valid_to set', await c.call('Authorize', { idTag: 'ID-RFID-0002' }));
  p('  -> spec allows expiryDate + parentIdTag; present?', 'see above');
  p('blocked token', await c.call('Authorize', { idTag: 'ID-RFID-BLOCKED' }));
  await db.query(`UPDATE token SET status='totally-not-an-ocpp-status' WHERE uid='FLEET-GRAB-0007'`);
  p('token whose DB status is garbage (no CHECK constraint)', await c.call('Authorize', { idTag: 'FLEET-GRAB-0007' }));
  await db.query(`UPDATE token SET status='Accepted' WHERE uid='FLEET-GRAB-0007'`);

  console.log('\n=== cross-tenant token leakage ===');
  const org2 = await db.query(
    `INSERT INTO organisation (name, slug) VALUES ('Other CPO','other-cpo')
     ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
  await db.query(
    `INSERT INTO token (org_id, kind, uid, status) VALUES ($1,'rfid','FOREIGN-TOKEN-9','Accepted')
     ON CONFLICT (org_id, uid) DO NOTHING`, [org2.rows[0].id]);
  p('token belonging to a DIFFERENT org', await c.call('Authorize', { idTag: 'FOREIGN-TOKEN-9' }));

  console.log('\n=== StartTransaction: duplicates on one connector ===');
  const a = await c.call('StartTransaction', { connectorId: 1, idTag: 'ID-RFID-0001', meterStart: 1000, timestamp: now() });
  const b = await c.call('StartTransaction', { connectorId: 1, idTag: 'ID-RFID-0001', meterStart: 5000, timestamp: now() });
  p('1st StartTransaction on connector 1', a);
  p('2nd StartTransaction on the SAME connector', b);
  const act = await db.query(
    `SELECT count(*)::int n FROM charging_session cs JOIN charge_point cp ON cp.id=cs.charge_point_id
      WHERE cp.ocpp_identity='AUDIT-ADAPT-01' AND cs.state='active'`);
  p('concurrent ACTIVE sessions now on this charge point', act.rows[0].n);

  console.log('\n=== StopTransaction twice / unknown ===');
  const tx = a.transactionId;
  p('stop #1', await c.call('StopTransaction', { transactionId: tx, meterStop: 3000, timestamp: now(), reason: 'Local' }));
  p('stop #2 (duplicate)', await c.call('StopTransaction', { transactionId: tx, meterStop: 99999, timestamp: now(), reason: 'Local' }));
  const s1 = await db.query(`SELECT state, energy_wh, meter_stop_wh FROM charging_session WHERE ocpp_transaction_id=$1`, [String(tx)]);
  p('session after duplicate stop', s1.rows);
  p('stop with unknown reason string', await c.call('StopTransaction', { transactionId: b.transactionId, meterStop: 6000, timestamp: now(), reason: 'MartianAbduction' }));

  console.log('\n=== MeterValues: units & phases (energyWhFrom) ===');
  const t2 = await c.call('StartTransaction', { connectorId: 1, idTag: 'ID-RFID-0001', meterStart: 0, timestamp: now() });
  const mvTest = async (label: string, sampled: any[]) => {
    await c.call('MeterValues', { connectorId: 1, transactionId: t2.transactionId, meterValue: [{ timestamp: now(), sampledValue: sampled }] });
    await sleep(250);
    const r = await db.query(`SELECT energy_wh FROM charging_session WHERE ocpp_transaction_id=$1`, [String(t2.transactionId)]);
    p(label, `session.energy_wh = ${r.rows[0]?.energy_wh}`);
  };
  await mvTest('Wh register 5000', [{ value: '5000', measurand: 'Energy.Active.Import.Register', unit: 'Wh' }]);
  await mvTest('kWh register 7.5 (=7500 Wh)', [{ value: '7.5', measurand: 'Energy.Active.Import.Register', unit: 'kWh' }]);
  await mvTest('unit OMITTED, value 9 (kWh charger!)', [{ value: '9', measurand: 'Energy.Active.Import.Register' }]);
  await mvTest('per-phase registers L1/L2/L3 (3000 each = 9000)', [
    { value: '3000', measurand: 'Energy.Active.Import.Register', unit: 'Wh', phase: 'L1' },
    { value: '3000', measurand: 'Energy.Active.Import.Register', unit: 'Wh', phase: 'L2' },
    { value: '3000', measurand: 'Energy.Active.Import.Register', unit: 'Wh', phase: 'L3' },
  ]);
  await mvTest('Power sample AFTER the energy register', [
    { value: '12000', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
    { value: '7400', measurand: 'Power.Active.Import', unit: 'W' },
  ]);
  await mvTest('Power sample BEFORE the energy register', [
    { value: '7400', measurand: 'Power.Active.Import', unit: 'W' },
    { value: '13000', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
  ]);
  await mvTest('OUT-OF-ORDER replay: stale 4000 after 13000', [{ value: '4000', measurand: 'Energy.Active.Import.Register', unit: 'Wh' }]);
  await mvTest('Interval context (Sample.Clock, not a register)', [
    { value: '250', measurand: 'Energy.Active.Import.Interval', unit: 'Wh', context: 'Sample.Clock' },
  ]);

  console.log('\n=== StatusNotification connectorId 0 recovery ===');
  await c.call('StatusNotification', { connectorId: 0, errorCode: 'InternalError', status: 'Faulted', timestamp: now() });
  await sleep(300);
  let st = await db.query(`SELECT status FROM charge_point WHERE ocpp_identity='AUDIT-ADAPT-01'`);
  p('charge_point.status after station-level Faulted', st.rows[0].status);
  await c.call('StatusNotification', { connectorId: 0, errorCode: 'NoError', status: 'Available', timestamp: now() });
  await sleep(300);
  st = await db.query(`SELECT status FROM charge_point WHERE ocpp_identity='AUDIT-ADAPT-01'`);
  p('charge_point.status after station-level Available', st.rows[0].status + '   <-- recovered?');
  p('is the socket still open?', c.ws.readyState === 1);

  console.log('\n=== StatusNotification timestamp / vendorErrorCode ===');
  await c.call('StatusNotification', { connectorId: 1, errorCode: 'GroundFailure', vendorErrorCode: 'AUTEL-E42', status: 'Faulted', timestamp: '2020-01-01T00:00:00Z', info: 'ground fault' });
  await sleep(300);
  const cn = await db.query(
    `SELECT c.status, c.error_code, c.status_updated_at FROM connector c JOIN evse e ON e.id=c.evse_uuid
       JOIN charge_point cp ON cp.id=e.charge_point_id WHERE cp.ocpp_identity='AUDIT-ADAPT-01' AND e.evse_id=1`);
  p('connector row (charger said timestamp=2020-01-01)', cn.rows[0]);

  await db.end(); c.close(); process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
