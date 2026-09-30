import { CP, sleep } from './cp.js';
import pg from 'pg';
const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_c' });
const L = (s: string) => console.log(s);
const q = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;
const CPID = 'AUTEL-DC60-SMB-002';
const IDTAG = 'ID-RFID-0001';

async function wipe() {
  await q(`DELETE FROM cdr WHERE session_id IN (SELECT cs.id FROM charging_session cs JOIN charge_point cp ON cp.id=cs.charge_point_id WHERE cp.ocpp_identity=$1)`, [CPID]);
  await q(`DELETE FROM meter_value WHERE session_id IN (SELECT cs.id FROM charging_session cs JOIN charge_point cp ON cp.id=cs.charge_point_id WHERE cp.ocpp_identity=$1)`, [CPID]);
  await q(`DELETE FROM charging_session cs USING charge_point cp WHERE cp.id=cs.charge_point_id AND cp.ocpp_identity=$1`, [CPID]);
}

async function main() {
  const orgId = (await q(`SELECT id FROM organisation WHERE slug='nusantara-charge'`))[0].id;
  await q(`DELETE FROM tariff_assignment WHERE tariff_id IN (SELECT id FROM tariff WHERE org_id=$1 AND name LIKE 'AUDIT%')`, [orgId]);
  await q(`DELETE FROM tariff WHERE org_id=$1 AND name LIKE 'AUDIT%'`, [orgId]);
  await wipe();

  const cp = await (new CP(CPID)).connect();
  await cp.boot();
  await sleep(1200);

  // Session STARTED three days ago at the seeded tariff (energy 2467.5, 25k service, 4k admin).
  const START = '2026-08-20T02:00:00Z';
  const END = '2026-08-20T03:00:00Z';
  L('=== 6a. Is the tariff resolved AS OF SESSION START? ===');
  L(`  Session start ${START}. Seeded tariff: 2,467.5/kWh + 25,000 service + 4,000 admin.`);
  const s = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 100_000, timestamp: START });

  // Operator raises prices TODAY (after the session started).
  const t2 = (await q(
    `INSERT INTO tariff (org_id, name, pln_scheme, active_from) VALUES ($1,'AUDIT price rise','none', now()) RETURNING id`, [orgId]))[0].id;
  await q(`INSERT INTO tariff_component (tariff_id, kind, rate, tou_block, sort_order) VALUES ($1,'energy',10000,'ANY',0)`, [t2]);
  await q(`INSERT INTO tariff_component (tariff_id, kind, rate, tou_block, sort_order) VALUES ($1,'session',90000,'ANY',1)`, [t2]);
  await q(`INSERT INTO tariff_assignment (tariff_id, scope_type, scope_id, priority) VALUES ($1,'org',$2,99)`, [t2, orgId]);
  L(`  Inserted a NEW tariff effective from now(): 10,000/kWh + 90,000 service, priority 99.`);

  await cp.call('StopTransaction', { transactionId: s.transactionId, meterStop: 120_000, timestamp: END, reason: 'Local' });
  await sleep(600);
  const r = (await q(
    `SELECT d.total_idr, d.subtotal_idr, d.tariff_snapshot->>'name' tname, d.lines
       FROM cdr d JOIN charging_session cs ON cs.id=d.session_id JOIN charge_point cp ON cp.id=cs.charge_point_id
      WHERE cp.ocpp_identity=$1`, [CPID]))[0];
  L(`  CDR tariff_snapshot.name = "${r.tname}"`);
  L(`  CDR lines = ${JSON.stringify(r.lines)}`);
  L(`  CDR subtotal = Rp ${r.subtotal_idr}, total = Rp ${r.total_idr}`);
  L(`  Expected if resolved at session start (2026-08-20): 20 x 2467.5 + 25000 + 4000 = Rp 78,350 subtotal / Rp 91,317 total`);
  L(`  -> tariff resolved as of SESSION START? ${r.tname === 'Public DC — layanan khusus N=1.5' ? 'YES' : 'NO — the CURRENT tariff was used'}`);

  // ---- 6b: a tariff that expired between session start and rating vanishes entirely
  L('\n=== 6b. Tariff that expired between session start and rating (late replay) ===');
  await wipe();
  await q(`UPDATE tariff SET active_to = now() WHERE org_id=$1`, [orgId]);
  L('  All tariffs now have active_to = now() (superseded). A charger replays an old session...');
  const s2 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 200_000, timestamp: START });
  await sleep(1200);
  await cp.call('StopTransaction', { transactionId: s2.transactionId, meterStop: 220_000, timestamp: END, reason: 'Local' });
  await sleep(600);
  const r2 = (await q(
    `SELECT d.total_idr, d.subtotal_idr, d.tariff_snapshot->>'name' tname, d.lines
       FROM cdr d JOIN charging_session cs ON cs.id=d.session_id JOIN charge_point cp ON cp.id=cs.charge_point_id
      WHERE cp.ocpp_identity=$1`, [CPID]))[0];
  L(`  CDR tariff_snapshot.name = "${r2.tname}"`);
  L(`  CDR lines = ${JSON.stringify(r2.lines)}`);
  L(`  subtotal = Rp ${r2.subtotal_idr}, total = Rp ${r2.total_idr}`);
  L(`  Correct (tariff active at session start) would be Rp 78,350 / Rp 91,317. Shortfall = Rp ${91_317 - Number(r2.total_idr)}`);

  // restore
  await q(`UPDATE tariff SET active_to = NULL WHERE org_id=$1`, [orgId]);
  await q(`DELETE FROM tariff_assignment WHERE tariff_id=$1`, [t2]);
  await q(`DELETE FROM tariff WHERE id=$1`, [t2]);

  // ---- 6c: over-ceiling tariff can be seeded and WILL bill
  L('\n=== 3b. Can an over-ceiling tariff be seeded and will it bill? (validateTariff is never called on a write path) ===');
  await wipe();
  const t3 = (await q(`INSERT INTO tariff (org_id,name,pln_scheme,pln_base_rate,pln_multiplier,active_from) VALUES ($1,'AUDIT illegal','layanan_khusus',1645,3.0, now() - interval '30 days') RETURNING id`, [orgId]))[0].id;
  await q(`INSERT INTO tariff_component (tariff_id,kind,rate,tou_block,sort_order) VALUES ($1,'energy',9000,'ANY',0)`, [t3]);
  await q(`INSERT INTO tariff_component (tariff_id,kind,rate,tou_block,sort_order) VALUES ($1,'session',250000,'ANY',1)`, [t3]);
  await q(`INSERT INTO tariff_assignment (tariff_id,scope_type,scope_id,priority) VALUES ($1,'org',$2,99)`, [t3, orgId]);
  L('  Inserted, with no validation gate, a tariff at Rp 9,000/kWh (ceiling 2,467.5) and Rp 250,000 service fee (ceiling 57,000).');
  const s3 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 300_000, timestamp: START });
  await cp.call('StopTransaction', { transactionId: s3.transactionId, meterStop: 320_000, timestamp: END, reason: 'Local' });
  await sleep(700);
  const r3 = (await q(
    `SELECT d.total_idr, d.regulatory_flags, d.lines FROM cdr d JOIN charging_session cs ON cs.id=d.session_id
       JOIN charge_point cp ON cp.id=cs.charge_point_id WHERE cp.ocpp_identity=$1`, [CPID]))[0];
  L(`  CDR ISSUED. total = Rp ${Number(r3.total_idr).toLocaleString('en-US')} for 20 kWh (legal max would be ~Rp 91,317)`);
  L(`  regulatory_flags on the CDR = ${JSON.stringify(r3.regulatory_flags)}`);
  L(`  -> the customer is charged ${(Number(r3.total_idr) / 91317).toFixed(1)}x the regulated ceiling; the CDR is still issued.`);
  const alerts = await q(`SELECT kind, severity FROM alert WHERE kind LIKE 'regulatory%' ORDER BY created_at DESC LIMIT 5`);
  L(`  alerts raised: ${JSON.stringify(alerts)}`);

  await q(`DELETE FROM tariff_assignment WHERE tariff_id=$1`, [t3]);
  await q(`DELETE FROM tariff WHERE id=$1`, [t3]);
  await wipe();
  cp.close();
  await db.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
