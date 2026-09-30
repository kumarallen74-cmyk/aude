import { connect, boot, sleep } from './lib.js';
import pg from 'pg';
const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_a' });
const p = (s: string, v: any) => console.log(`  ${s.padEnd(50)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);

async function main() {
  console.log('=== GetLocalListVersion = -1 (local list NOT supported) ===');
  const c = await connect('AUDIT-LL-01');
  let sendLocalList: any = null;
  c.onCall = (a, pl) => {
    if (a === 'GetConfiguration') return { configurationKey: [{ key: 'NumberOfConnectors', value: '1', readonly: true }] };
    if (a === 'GetLocalListVersion') return { listVersion: -1 };
    if (a === 'SendLocalList') { sendLocalList = pl; return { status: 'Accepted' }; }
    if (a === 'ChangeConfiguration') return { status: 'Rejected' };
    return { status: 'Accepted' };
  };
  await boot(c);
  await sleep(3000);
  p('SendLocalList the CSMS emitted', sendLocalList && { listVersion: sendLocalList.listVersion, updateType: sendLocalList.updateType });
  p('  -> 1.6 requires listVersion > 0 for a Full update', sendLocalList?.listVersion);

  console.log('\n=== quirk registry auto-population (README claim) ===');
  const q = await db.query(
    `SELECT vendor, model, findings FROM quirk_profile WHERE vendor='Autel' ORDER BY updated_at DESC LIMIT 2`);
  for (const row of q.rows) p(`${row.vendor}/${row.model}`, row.findings);

  console.log('\n=== is the SendLocalList re-sent on EVERY boot (flash wear)? ===');
  sendLocalList = null;
  await boot(c);
  await sleep(3000);
  p('SendLocalList re-issued on a second boot?', sendLocalList !== null);

  console.log('\n=== displaced duplicate socket: is the old one closed? ===');
  const a1 = await connect('AUDIT-EVICT-01'); await boot(a1);
  await sleep(300);
  const a2 = await connect('AUDIT-EVICT-01'); await boot(a2);
  await sleep(800);
  p('old socket readyState (1=OPEN)', a1.ws.readyState);
  p('  -> CSMS never terminates the displaced connection', a1.ws.readyState === 1);
  // the displaced socket can still WRITE billing data
  const tx = await a1.call('StartTransaction', { connectorId: 1, idTag: 'ID-RFID-0001', meterStart: 0, timestamp: new Date().toISOString() });
  p('displaced/impostor socket can still start a transaction', tx);
  a1.close(); a2.close(); c.close();

  await db.end(); process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
