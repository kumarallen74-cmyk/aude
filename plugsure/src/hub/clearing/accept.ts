import type pg from 'pg';
import { tx } from '../../db/pool.js';
import { feesFor } from './fees.js';

/**
 * A CDR becomes payable (`accepted`) when its dispute window passes with no dispute (autoAccept, every 15
 * minutes), when a dispute ends with the CDR standing (upheld, expired), or when a platform admin releases a
 * held credit. Its hub fees are computed and FROZEN at that moment (§8.4).
 */

export async function acceptRow(c: pg.PoolClient, id: string, now: Date): Promise<boolean> {
  const r = (await c.query(`SELECT * FROM hub_cdr WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!r || !['pending', 'disputed'].includes(r.status)) return false;
  const f = await feesFor(r);
  await c.query(
    `UPDATE hub_cdr SET status = 'accepted', accepted_at = $2, fee_cpo_minor = $3, fee_emsp_minor = $4, fee_cpo_plan_id = $5, fee_emsp_plan_id = $6, updated_at = now()
      WHERE id = $1`, [id, now, f.cpo, f.emsp, f.cpoPlanId, f.emspPlanId]);
  return true;
}

/** After a dispute ends without a credit: accepted when its window has passed, else back to pending. */
export async function afterDispute(c: pg.PoolClient, cdrId: string, outcome: 'upheld' | 'withdrawn', now: Date): Promise<void> {
  if (outcome === 'upheld') { await acceptRow(c, cdrId, now); return; }
  const r = (await c.query(`UPDATE hub_cdr SET status = 'pending', updated_at = now() WHERE id = $1 AND status = 'disputed' AND dispute_deadline > $2 RETURNING id`, [cdrId, now])).rows[0];
  if (!r) await acceptRow(c, cdrId, now);
}

/** Accept every pending CDR whose dispute window has passed (no live dispute: those are `disputed`). */
export async function autoAccept(now: Date = new Date(), limit = 500): Promise<number> {
  let n = 0;
  for (;;) {
    const done = await tx(async (c) => {
      const due = (await c.query<{ id: string }>(
        `SELECT id FROM hub_cdr WHERE status = 'pending' AND dispute_deadline <= $1 ORDER BY dispute_deadline LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit])).rows;
      for (const d of due) if (await acceptRow(c, d.id, now)) n++;
      return due.length;
    });
    if (done < limit) break;
  }
  return n;
}
