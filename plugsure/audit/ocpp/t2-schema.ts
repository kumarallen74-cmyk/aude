import { connect, boot, sleep, j } from './lib.js';
import pg from 'pg';

const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_a' });

async function main() {
  const c = await connect('AUDIT-SCHEMA-01');
  await boot(c);
  await sleep(600);

  const t = async (name: string, action: string, payload: any) => {
    try {
      const r = await c.call(action, payload);
      console.log(`${name.padEnd(52)} => ACCEPTED ${j(r)}`);
    } catch (e: any) {
      console.log(`${name.padEnd(52)} => ${e.callError ? 'CALLERROR ' + j(e.callError) : 'ERR ' + e.message}`);
    }
  };

  console.log('--- StartTransaction fuzzing (no Ajv?) ---');
  await t('StartTransaction missing connectorId', 'StartTransaction', {
    idTag: 'ID-RFID-0001', meterStart: 0, timestamp: new Date().toISOString(),
  });
  await t('StartTransaction connectorId as string "1"', 'StartTransaction', {
    connectorId: '1', idTag: 'ID-RFID-0001', meterStart: 0, timestamp: new Date().toISOString(),
  });
  await t('StartTransaction meterStart = null', 'StartTransaction', {
    connectorId: 1, idTag: 'ID-RFID-0001', meterStart: null, timestamp: new Date().toISOString(),
  });
  await t('StartTransaction meterStart = "abc"', 'StartTransaction', {
    connectorId: 1, idTag: 'ID-RFID-0001', meterStart: 'abc', timestamp: new Date().toISOString(),
  });
  await t('StartTransaction bogus timestamp', 'StartTransaction', {
    connectorId: 1, idTag: 'ID-RFID-0001', meterStart: 0, timestamp: 'not-a-date',
  });
  await t('StartTransaction no idTag at all', 'StartTransaction', {
    connectorId: 1, meterStart: 0, timestamp: new Date().toISOString(),
  });
  await t('StartTransaction connectorId 99 (nonexistent)', 'StartTransaction', {
    connectorId: 99, idTag: 'ID-RFID-0001', meterStart: 0, timestamp: new Date().toISOString(),
  });
  await t('StartTransaction connectorId 0 (station)', 'StartTransaction', {
    connectorId: 0, idTag: 'ID-RFID-0001', meterStart: 0, timestamp: new Date().toISOString(),
  });
  await t('StartTransaction connectorId -1', 'StartTransaction', {
    connectorId: -1, idTag: 'ID-RFID-0001', meterStart: 0, timestamp: new Date().toISOString(),
  });
  await t('StartTransaction reservationId 7', 'StartTransaction', {
    connectorId: 1, idTag: 'ID-RFID-0001', meterStart: 0, timestamp: new Date().toISOString(), reservationId: 7,
  });

  console.log('\n--- StatusNotification fuzzing ---');
  await t('StatusNotification bogus status', 'StatusNotification', {
    connectorId: 1, errorCode: 'NoError', status: 'ChargingFuriously',
  });
  await t('StatusNotification bogus errorCode', 'StatusNotification', {
    connectorId: 1, errorCode: 'MyOwnErrorCode', status: 'Faulted', vendorErrorCode: 'AUTEL-77',
  });
  await t('StatusNotification no status field', 'StatusNotification', { connectorId: 1, errorCode: 'NoError' });

  console.log('\n--- StopTransaction fuzzing ---');
  await t('StopTransaction unknown txId 999999', 'StopTransaction', {
    transactionId: 999999, meterStop: 100, timestamp: new Date().toISOString(),
  });
  await t('StopTransaction transactionId 0', 'StopTransaction', {
    transactionId: 0, meterStop: 100, timestamp: new Date().toISOString(),
  });
  await t('StopTransaction missing transactionId', 'StopTransaction', {
    meterStop: 100, timestamp: new Date().toISOString(),
  });

  console.log('\n--- Authorize fuzzing ---');
  await t('Authorize missing idTag', 'Authorize', {});
  await t('Authorize idTag = object', 'Authorize', { idTag: { evil: 1 } });
  await t('Authorize idTag 400 chars', 'Authorize', { idTag: 'Z'.repeat(400) });
  await t('Authorize SQL-ish idTag', 'Authorize', { idTag: "' OR 1=1 --" });

  console.log('\n--- DataTransfer ---');
  await t('DataTransfer no vendorId', 'DataTransfer', { messageId: 'x' });
  await t('DataTransfer known pnc vendorId', 'DataTransfer', { vendorId: 'org.openchargealliance.iso15118pnc', messageId: 'Authorize' });

  console.log('\n--- MeterValues ---');
  await t('MeterValues value non-numeric', 'MeterValues', {
    connectorId: 1, transactionId: 999999,
    meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [{ value: 'NaN-ish', measurand: 'Energy.Active.Import.Register' }] }],
  });
  await t('MeterValues meterValue not an array', 'MeterValues', { connectorId: 1, meterValue: 'nope' });

  await sleep(1500);

  console.log('\n--- DB state written by the above ---');
  const s = await db.query(
    `SELECT cs.ocpp_transaction_id, cs.state, cs.started_at, cs.meter_start_wh, cs.energy_wh, e.evse_id
       FROM charging_session cs JOIN connector c ON c.id=cs.connector_uuid JOIN evse e ON e.id=c.evse_uuid
       JOIN charge_point cp ON cp.id=cs.charge_point_id WHERE cp.ocpp_identity='AUDIT-SCHEMA-01' ORDER BY cs.created_at`);
  console.table(s.rows);
  const ev = await db.query(
    `SELECT e.evse_id, c.status, c.error_code, c.max_power_w FROM evse e JOIN connector c ON c.evse_uuid=e.id
       JOIN charge_point cp ON cp.id=e.charge_point_id WHERE cp.ocpp_identity='AUDIT-SCHEMA-01' ORDER BY e.evse_id`);
  console.table(ev.rows);
  await db.end();
  c.close();
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
