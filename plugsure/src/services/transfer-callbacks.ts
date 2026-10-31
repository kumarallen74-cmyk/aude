import { one, query } from '../db/pool.js';
import { askRail, settleTransfer } from './refund-transfers.js';
import { settlePayout } from './payout-transfers.js';

/**
 * Payout callbacks (v1.18.0): Xendit's payout.* and Duitku Disbursement's callback arrive at the account's notification
 * URL (/pay/notify/<key>). The callback only names the transfer; PlugSure asks the gateway where it stands at once (the
 * same question the worker asks every 5 minutes), so a result arrives in seconds and a forged or replayed callback can do
 * no more than trigger that question. Unknown ids are acknowledged (the gateway would retry for days) and left to the
 * worker: a callback can arrive before PlugSure has stored the payout's id.
 */
export async function payoutCallback(integrationId: string, ref: string): Promise<string> {
  const refund = await one<any>(`SELECT * FROM refund_transfer WHERE integration_id = $1 AND disburse_id = $2 AND state IN ('sending', 'sent')`, [integrationId, ref]);
  const payout = refund ? null : await one<any>(`SELECT * FROM payout_transfer WHERE integration_id = $1 AND disburse_id = $2 AND state IN ('sending', 'sent')`, [integrationId, ref]);
  const t = refund ?? payout;
  if (!t) return 'payout_unknown';
  const st = await askRail(t, refund ? 'ps-refund' : 'ps-payout');
  if (!st || st.outcome === 'unknown') {
    await query(`UPDATE ${refund ? 'refund_transfer' : 'payout_transfer'} SET updated_at = now() - interval '5 minutes' WHERE id = $1`, [t.id]);
    return 'payout_pending';
  }
  if (refund) await settleTransfer(t, st.outcome, st.code, st.error);
  else await settlePayout(t, st.outcome, st.code, st.error);
  return st.outcome === 'succeeded' ? 'payout_succeeded' : 'payout_failed';
}
