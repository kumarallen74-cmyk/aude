import { many, one, outsideRequestScope } from '../db/pool.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';

/**
 * Approval alerts (v1.18.0): a refund or owner payout transfer waiting for a second person raises an operator alert
 * (finance.transfer_awaiting_approval), which the organisation's alert routing delivers like any other (e-mail,
 * WhatsApp, SMS; Govern → Alert routing: route this kind to the people who approve). Left waiting more than 24 hours, a
 * critical alert follows (finance.transfer_approval_overdue). Both resolve when the transfer is approved or rejected.
 * The console shows the number waiting as a badge on Refunds and Finance.
 */

export const AWAITING = 'finance.transfer_awaiting_approval';
export const OVERDUE = 'finance.transfer_approval_overdue';
export type TransferKind = 'refund' | 'payout';
const targetType = (k: TransferKind) => (k === 'refund' ? 'refund_transfer' : 'payout_transfer');
const fmt = (n: number, cur: string) => `${new Intl.NumberFormat('en-GB').format(n)} ${cur}`;

/** A transfer was requested: the approvers are told. Never fails the request. */
export async function notifyAwaiting(k: TransferKind, t: { id: string | number; org_id?: string; orgId?: string; amount_minor?: unknown; amount?: unknown; currency: string }, who: string | null, what: string) {
  const orgId = String(t.org_id ?? t.orgId);
  const amount = Number(t.amount_minor ?? t.amount ?? 0);
  await persistAlert({
    orgId, kind: AWAITING, severity: 'warning', targetType: targetType(k), targetId: String(t.id),
    message: `${k === 'refund' ? 'A refund' : 'An owner payout'} of ${fmt(amount, t.currency)} (${what}) is waiting for approval by someone other than ${who ?? 'the requester'}: ${k === 'refund' ? 'Refunds → Transfers' : 'Finance → Payables → Payouts'}.`,
  }).catch((e: unknown) => logger.warn({ err: (e as Error).message }, 'approval alert failed'));
}

/** Approved or rejected: the alerts about it resolve. */
export async function clearAwaiting(k: TransferKind, orgId: string, id: string | number) {
  for (const kind of [AWAITING, OVERDUE]) await resolveAlertsFor(orgId, kind, targetType(k), String(id)).catch(() => 0);
}

/** The worker: transfers waiting more than 24 hours get a critical alert (once; persistAlert counts repeats). */
export async function escalateWaiting(): Promise<number> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT 'refund' AS k, id, org_id, amount_minor, currency, requested_at FROM refund_transfer WHERE state = 'awaiting_approval' AND requested_at < now() - interval '24 hours'
     UNION ALL
     SELECT 'payout' AS k, id, org_id, amount_minor, currency, requested_at FROM payout_transfer WHERE state = 'awaiting_approval' AND requested_at < now() - interval '24 hours'`));
  let n = 0;
  for (const r of rows) {
    const open = await outsideRequestScope(() => one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND target_type = $3 AND target_id = $4 AND resolved_at IS NULL`,
      [r.org_id, OVERDUE, targetType(r.k), String(r.id)]));
    if (open) continue;
    await outsideRequestScope(() => persistAlert({
      orgId: r.org_id, kind: OVERDUE, severity: 'critical', targetType: targetType(r.k), targetId: String(r.id),
      message: `${r.k === 'refund' ? 'A refund' : 'An owner payout'} of ${fmt(Number(r.amount_minor), r.currency)} has waited more than 24 hours for approval. Approve or reject it (${r.k === 'refund' ? 'Refunds → Transfers' : 'Finance → Payables → Payouts'}).`,
    }));
    n++;
  }
  return n;
}

/** How many transfers wait for approval, and how many of those the caller could approve (not their own). */
export async function approvalsCount(orgId: string, userId: string | null) {
  const r = await one<{ refunds: number; payouts: number; mine: number }>(
    `SELECT (SELECT count(*) FROM refund_transfer WHERE org_id = $1 AND state = 'awaiting_approval')::int AS refunds,
            (SELECT count(*) FROM payout_transfer WHERE org_id = $1 AND state = 'awaiting_approval')::int AS payouts,
            ((SELECT count(*) FROM refund_transfer WHERE org_id = $1 AND state = 'awaiting_approval' AND requested_by IS NOT DISTINCT FROM $2::uuid)
             + (SELECT count(*) FROM payout_transfer WHERE org_id = $1 AND state = 'awaiting_approval' AND requested_by IS NOT DISTINCT FROM $2::uuid))::int AS mine`,
    [orgId, userId]);
  const refunds = r?.refunds ?? 0, payouts = r?.payouts ?? 0;
  return { refunds, payouts, total: refunds + payouts, forMe: refunds + payouts - (r?.mine ?? 0) };
}
