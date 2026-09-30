import { createHash } from 'node:crypto';
import { writeAudit, verifyChain, canonicalJson } from '../../src/services/audit.js';
import { query, pool, one } from '../../src/db/pool.js';

async function freshOrg(): Promise<string> {
  const r = await one<{id:string}>(`INSERT INTO organisation (name,slug,licence_scheme) VALUES ('TamperCo','tamper-co-'||floor(random()*100000)::text,'POPO') RETURNING id`);
  return r!.id;
}
async function main() {
  const ORG = await freshOrg();
  // clean entries, all fields defined
  await writeAudit({ orgId: ORG, actorType:'user', actorId:'ceo', action:'tariff.update', targetType:'tariff', targetId:'T1', after:{ rate: 2500 } });
  await writeAudit({ orgId: ORG, actorType:'user', actorId:'ceo', action:'refund.issue', targetType:'payment', targetId:'P9', after:{ amountIdr: 5000000, approvedBy:'ceo' } });
  await writeAudit({ orgId: ORG, actorType:'user', actorId:'ceo', action:'user.invite', targetType:'user', targetId:'U2', after:{ role:'finance' } });
  console.log('baseline:', JSON.stringify(await verifyChain(ORG)).slice(0,120));

  // ATTACK 1: mutate refund + re-chain forward WITHOUT key
  const { rows } = await query<any>(`SELECT id,org_id,ts,actor_type,actor_id,action,target_type,target_id,before_state,after_state,ip,user_agent,seq,prev_hash,hash FROM audit_log WHERE org_id=$1 ORDER BY id`,[ORG]);
  const v = rows[1]; v.after_state = { amountIdr: 500, approvedBy:'ceo' };
  let prev = rows[0].hash;
  for (let i=1;i<rows.length;i++){
    const r=rows[i];
    const body = canonicalJson({orgKey:r.org_id, orgId:r.org_id, ts:new Date(r.ts).toISOString(), actorType:r.actor_type, actorId:r.actor_id, action:r.action, targetType:r.target_type, targetId:r.target_id, before:r.before_state??null, after:r.after_state??null, ip:r.ip, userAgent:r.user_agent});
    const newHash = createHash('sha256').update(prev+body).digest('hex'); // attacker has no HMAC key
    await query(`UPDATE audit_log SET after_state=$2, prev_hash=$3, hash=$4 WHERE id=$1`,[r.id, r.after_state?JSON.stringify(r.after_state):null, prev, newHash]);
    prev=newHash;
  }
  const a1 = await verifyChain(ORG);
  console.log('ATTACK1 mutate+rechain ->', a1.ok, a1.problems.map((p:any)=>p.kind));

  // ATTACK 2: truncate tail (delete newest)
  await query(`DELETE FROM audit_log WHERE org_id=$1 AND action='user.invite'`,[ORG]);
  const a2 = await verifyChain(ORG);
  console.log('ATTACK2 truncate tail ->', a2.ok, a2.problems.map((p:any)=>p.kind));

  // ATTACK 3: delete whole chain rows
  await query(`DELETE FROM audit_log WHERE org_id=$1`,[ORG]);
  const a3 = await verifyChain(ORG);
  console.log('ATTACK3 delete all rows ->', a3.ok, a3.problems.map((p:any)=>p.kind));

  // ATTACK 4: try to delete head row (should be blocked by trigger)
  try { await query(`DELETE FROM audit_head WHERE org_id=$1`,[ORG]); console.log('ATTACK4 head delete: SUCCEEDED (BAD)'); }
  catch(e:any){ console.log('ATTACK4 head delete blocked:', e.message.slice(0,60)); }

  // ATTACK 5: roll back head entries counter
  try { await query(`UPDATE audit_head SET entries=0 WHERE org_id=$1`,[ORG]); console.log('ATTACK5 head rollback: SUCCEEDED (BAD)'); }
  catch(e:any){ console.log('ATTACK5 head rollback blocked:', e.message.slice(0,60)); }

  await pool.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
