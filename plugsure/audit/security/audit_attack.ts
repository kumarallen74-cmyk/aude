import { createHash } from 'node:crypto';
import { writeAudit, verifyChain, canonicalJson } from '../../plugsure/src/services/audit.js';
import { query, pool } from '../../plugsure/src/db/pool.js';

const ORG_A = '26a38857-8986-4014-8b5e-31e5abc2b0bb';

function bodyFor(e: any): string { return canonicalJson(e); }

async function main() {
  // clean slate for this org
  await query(`DELETE FROM audit_log WHERE org_id = $1`, [ORG_A]);

  await writeAudit({ orgId: ORG_A, actorType: 'user', actorId: 'ceo', action: 'ocpp.Reset', targetType: 'charge_point', targetId: 'CP1', after: { type: 'Soft' } });
  await writeAudit({ orgId: ORG_A, actorType: 'user', actorId: 'ceo', action: 'tariff.update', targetType: 'tariff', targetId: 'T1', after: { rate: 2500 } });
  await writeAudit({ orgId: ORG_A, actorType: 'user', actorId: 'ceo', action: 'refund.issue', targetType: 'payment', targetId: 'P9', after: { amountIdr: 5_000_000, approvedBy: 'ceo' } });
  await writeAudit({ orgId: ORG_A, actorType: 'user', actorId: 'ceo', action: 'user.invite', targetType: 'user', targetId: 'U2', after: { role: 'finance' } });

  console.log('baseline verify:', await verifyChain(ORG_A));

  // ---- ATTACK 1: mutate a middle row, then RE-CHAIN forward (no secret key needed) ----
  const { rows } = await query<any>(
    `SELECT id, org_id, actor_type, actor_id, action, target_type, target_id,
            before_state, after_state, prev_hash, hash
       FROM audit_log WHERE org_id = $1 ORDER BY id`, [ORG_A]);

  // tamper the refund: change 5,000,000 -> 500 and forge approver
  const victim = rows[2];
  victim.after_state = { amountIdr: 500, approvedBy: 'ceo' };

  // recompute every hash from the tampered row forward, exactly as verifyChain does
  let prevHash = rows[1].hash; // hash of row before the tampered one
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    const body = bodyFor({
      orgId: r.org_id, actorType: r.actor_type, actorId: r.actor_id, action: r.action,
      targetType: r.target_type, targetId: r.target_id,
      before: r.before_state, after: r.after_state,
    });
    const newHash = createHash('sha256').update(prevHash + body).digest('hex');
    await query(`UPDATE audit_log SET after_state=$2, prev_hash=$3, hash=$4 WHERE id=$1`,
      [r.id, r.after_state ? JSON.stringify(r.after_state) : null, prevHash, newHash]);
    prevHash = newHash;
  }
  console.log('after tamper+recompute verify:', await verifyChain(ORG_A));
  const forged = await query<any>(`SELECT after_state FROM audit_log WHERE org_id=$1 AND action='refund.issue'`, [ORG_A]);
  console.log('forged refund row now reads:', JSON.stringify(forged.rows[0].after_state));

  // ---- ATTACK 2: tail truncation (delete newest entries) ----
  await query(`DELETE FROM audit_log WHERE org_id=$1 AND action='user.invite'`, [ORG_A]);
  console.log('after deleting the newest (tail) entry verify:', await verifyChain(ORG_A));

  // ---- ATTACK 3: delete the ENTIRE org chain ----
  await query(`DELETE FROM audit_log WHERE org_id=$1`, [ORG_A]);
  console.log('after deleting the whole chain verify:', await verifyChain(ORG_A));

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
