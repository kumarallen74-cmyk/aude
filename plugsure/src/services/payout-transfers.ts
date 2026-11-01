import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { gate, ApprovalError } from './finance-approvals.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { seal, unseal } from './secrets.js';
import { namesMatch, TransferError, askRail } from './refund-transfers.js';
import { railFor, type Rail } from './payout-rails.js';
import { persistAlert } from './alerts.js';
import { notifyAwaiting, clearAwaiting } from './transfer-approvals.js';

/**
 * Owners' shares paid to their bank accounts, with two people (v1.16.0: Duitku Disbursement; v1.17.0: also Xendit Payouts,
 * services/payout-rails.ts — the operator's own Xendit account with payouts on).
 *
 * Since v1.14.0 an owner payout made by the operator's bank is RECORDED against the statement (services/payouts.ts).
 * With the Disbursement credentials saved on the operator's OWN Duitku account (Payments — fallback), a payout can also
 * be SENT from Finance → Refunds & shares due, the same way refunds are (services/refund-transfers.ts):
 *
 *   1. request   someone with payment:write picks an owner share that is due or part-paid, and an amount up to what is
 *                outstanding (less any open payout). The owner's saved bank account (it needs the bank code) is checked
 *                by Duitku's inquiry, and its number sealed again for this transfer.
 *   2. approve   a SECOND person with payment:write (never the requester). Within the payout limits (one payout; all
 *                payouts approved that day), the outstanding amount is checked again, a fresh inquiry made (the bank's
 *                name must not have changed), and the transfer sent once.
 *   3. result    '00': the statement payment is recorded (reference "Duitku Disbursement <disburseId>"), so the share is
 *                part-paid or paid. Refused: nothing recorded. Not known: the worker asks Duitku; only a confirmed
 *                transfer is recorded; after a day the operator is alerted and it can be settled by hand.
 *   reject       before it is sent, with a reason.
 *
 * Only the operator's own Duitku account pays its owners: never the platform's (PlugSure's money). A platform
 * administrator paying the platform organisation's own owners may use the platform's account.
 */

const AAD = (orgId: string, statementId: string) => `payout_transfer:${orgId}:${statementId}`;
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const OPEN = ['awaiting_approval', 'sending', 'sent'];

export interface PayoutTransferView {
  id: string; statementId: string; number: string | null; owner: string | null; rail: 'duitku' | 'xendit'; state: string; amount: number; currency: string; bankCode: string; accountMasked: string;
  holderName: string; checkedName: string | null; namesMatch: boolean; note: string | null; requestedBy: string | null; requestedByName: string | null; requestedAt: string;
  /** (v1.21.0) The first of two approvals, when the approvals matrix asks for two. */
  firstApprovedBy: string | null;
  approvedBy: string | null; approvedByName: string | null; approvedAt: string | null; reason: string | null; responseCode: string | null; error: string | null; statementPaymentId: string | null;
}
const view = (r: any): PayoutTransferView => ({
  id: String(r.id), statementId: r.statement_id, number: r.number ?? null, owner: r.owner ?? null, rail: r.rail ?? 'duitku', state: r.state, amount: Number(r.amount_minor), currency: r.currency,
  bankCode: r.bank_code, accountMasked: `••••${r.account_last4}`, holderName: r.holder_name, checkedName: r.checked_name, namesMatch: namesMatch(r.holder_name, r.checked_name),
  note: r.note, requestedBy: r.requested_by, requestedByName: r.requested_by_name ?? null, requestedAt: iso(r.requested_at)!,
  firstApprovedBy: r.first_approved_by ?? null,
  approvedBy: r.approved_by, approvedByName: r.approved_by_name ?? null, approvedAt: iso(r.approved_at), reason: r.reason, responseCode: r.response_code, error: r.error,
  statementPaymentId: r.statement_payment_id != null ? String(r.statement_payment_id) : null,
});

/**
 * The accounts that can pay this organisation's owners: its own Xendit account with payouts on (Xendit first: the main
 * account) and its own Duitku account with Disbursement; or (platform administrators) the platform's.
 */
async function payingAccounts(orgId: string, platformAdmin: boolean): Promise<Rail[]> {
  const rows = await outsideRequestScope(() => many<{ id: string }>(
    `SELECT id FROM integration WHERE ((kind = 'payments_fallback' AND provider = 'duitku') OR (kind = 'payments' AND provider = 'xendit')) AND enabled AND archived_at IS NULL
        AND (org_id = $1 OR ($2 AND org_id IS NULL)) ORDER BY (org_id IS NULL), (provider = 'duitku')`, [orgId, platformAdmin]));
  const out: Rail[] = [];
  for (const r of rows) {
    const d = await railFor(r.id).catch(() => null);
    if (d && !out.some((x) => x.kind === d.kind)) out.push(d);
  }
  return out;
}

/** Whether payouts can be sent for this organisation (the Payables page shows the button), and on which rails. */
export async function payoutsAvailable(orgId: string, platformAdmin: boolean): Promise<boolean> {
  return (await payingAccounts(orgId, platformAdmin)).length > 0;
}
export async function payoutRails(orgId: string, platformAdmin: boolean): Promise<Array<'duitku' | 'xendit'>> {
  return (await payingAccounts(orgId, platformAdmin)).map((r) => r.kind);
}

async function share(orgId: string, statementId: string) {
  const s = await outsideRequestScope(() => one<any>(
    `SELECT s.id, s.org_id, s.owner_id, s.number, s.currency, s.owner_share_minor AS due, COALESCE(w.legal_name, w.name) AS owner,
            COALESCE((SELECT sum(amount_minor) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL), 0)::bigint AS paid
       FROM commission_statement s JOIN site_owner w ON w.id = s.owner_id
      WHERE s.id = $1 AND s.org_id = $2 AND s.finalised_at IS NOT NULL`, [statementId, orgId]));
  if (!s) throw new TransferError(404, 'No such owner statement.');
  return { ...s, due: Number(s.due), paid: Number(s.paid), outstanding: Math.max(0, Number(s.due) - Number(s.paid)) };
}

export async function listPayoutTransfers(orgId: string, f: { open?: boolean } = {}): Promise<PayoutTransferView[]> {
  const rows = await many<any>(
    `SELECT t.*, s.number, COALESCE(w.legal_name, w.name) AS owner, a.name AS requested_by_name, b.name AS approved_by_name FROM payout_transfer t
       LEFT JOIN commission_statement s ON s.id = t.statement_id LEFT JOIN site_owner w ON w.id = t.owner_id
       LEFT JOIN app_user a ON a.id = t.requested_by LEFT JOIN app_user b ON b.id = t.approved_by
      WHERE t.org_id = $1 AND ($2::boolean IS NOT TRUE OR t.state = ANY($3::text[]))
      ORDER BY t.requested_at DESC LIMIT 300`, [orgId, f.open ?? null, OPEN]);
  return rows.map(view);
}

async function row(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new TransferError(404, 'No such payout.');
  const r = await one<any>(`SELECT * FROM payout_transfer WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!r) throw new TransferError(404, 'No such payout.');
  return r;
}

/** Step 1: request a payout of (part of) an owner's share, to the owner's saved bank account. */
export async function requestPayout(orgId: string, platformAdmin: boolean, statementId: string, b: { amount?: unknown; note?: unknown; rail?: unknown }, userId: string | null): Promise<PayoutTransferView> {
  const s = await share(orgId, statementId);
  const amount = Number(b.amount ?? s.outstanding);
  if (!Number.isInteger(amount) || amount <= 0) throw new TransferError(422, 'The amount is a whole number above zero (minor units).');
  const open = await one<{ n: string }>(`SELECT COALESCE(sum(amount_minor), 0) AS n FROM payout_transfer WHERE statement_id = $1 AND state = ANY($2::text[])`, [statementId, OPEN]);
  if (Number(open?.n ?? 0) > 0) throw new TransferError(409, 'A payout for this statement is already open.');
  if (amount > s.outstanding) throw new TransferError(422, `That is more than is outstanding on ${s.number} (${s.outstanding}).`);
  const rails = await payingAccounts(orgId, platformAdmin);
  const want = b.rail == null || b.rail === '' ? null : String(b.rail);
  if (want && !['duitku', 'xendit'].includes(want)) throw new TransferError(422, 'rail is duitku or xendit.');
  const d = want ? rails.find((r) => r.kind === want) : rails[0];
  if (!d) throw new TransferError(409, want ? `Payouts through ${want === 'xendit' ? 'Xendit' : 'Duitku'} are not set up on your own account.` : 'Owner payouts need Xendit payouts or Duitku Disbursement on your own account (Integrations).');
  const lim = d.limits('payout');
  if (amount > lim.perTransfer) throw new TransferError(422, `Above the largest payout allowed (${lim.perTransfer} rupiah): pay it by bank transfer and record it.`);
  const acct = await outsideRequestScope(() => one<any>(`SELECT * FROM owner_bank_account WHERE owner_id = $1 AND org_id = $2`, [s.owner_id, orgId]));
  if (!acct) throw new TransferError(422, 'Save the owner\'s bank details first.');
  if (!acct.bank_code) throw new TransferError(422, 'Save the owner\'s bank code first (e.g. 014 for BCA).');
  const number = unseal(acct.account_number_sealed, `owner_bank_account:${s.owner_id}`);
  const q = await d.check({ bankCode: acct.bank_code, account: number, amount, purpose: 'PlugSure owner share' });
  if (!q.ok) throw new TransferError(422, `${d.kind === 'duitku' ? 'Duitku could not check the owner\'s account' : 'Xendit cannot pay this account'}: ${q.error}.`);
  const note = b.note == null ? null : String(b.note).trim().slice(0, 300) || null;
  try {
    const r = await one<any>(
      `INSERT INTO payout_transfer (org_id, statement_id, owner_id, integration_id, amount_minor, currency, bank_code, account_number_sealed, account_last4, holder_name, checked_name, state, note, requested_by, rail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'awaiting_approval', $12, $13, $14) RETURNING *`,
      [orgId, statementId, s.owner_id, d.integrationId, amount, s.currency, acct.bank_code, seal(number, AAD(orgId, statementId)), number.slice(-4), acct.holder_name, q.accountName, note, userId, d.kind]);
    const who = userId ? (await one<{ name: string }>(`SELECT name FROM app_user WHERE id = $1`, [userId]))?.name ?? null : null;
    await notifyAwaiting('payout', r, who, `${s.owner}, ${s.number}`);
    return view({ ...r, number: s.number, owner: s.owner });
  } catch (e) {
    if ((e as any).code === '23505') throw new TransferError(409, 'A payout for this statement is already open.');
    throw e;
  }
}

export async function rejectPayout(orgId: string, id: string, reasonRaw: unknown, userId: string | null): Promise<PayoutTransferView> {
  const reason = String(reasonRaw ?? '').trim();
  if (!reason || reason.length > 300) throw new TransferError(422, 'Say why the payout is rejected (up to 300 characters).');
  const t = await row(orgId, id);
  const r = await one<any>(`UPDATE payout_transfer SET state = 'rejected', rejected_by = $3, reason = $4, updated_at = now() WHERE id = $1 AND org_id = $2 AND state = 'awaiting_approval' RETURNING *`,
    [id, orgId, userId, reason]);
  if (!r) throw new TransferError(409, `The payout is ${t.state}: only one awaiting approval can be rejected.`);
  await clearAwaiting('payout', orgId, id);
  return view(r);
}

/** Step 2: a second person approves; the transfer is sent, once. */
export async function approvePayout(orgId: string, id: string, userId: string | null, canApprove = false): Promise<PayoutTransferView> {
  const t = await row(orgId, id);
  if (t.state !== 'awaiting_approval') throw new TransferError(409, `The payout is ${t.state}.`);
  // (v1.21.0) The approvals matrix: a Finance Manager above a threshold, or two approvers (the first is recorded here).
  try {
    if (await gate('payout', orgId, { id: t.id, amount: Number(t.amount_minor), requested_by: t.requested_by, first_approved_by: t.first_approved_by }, { userId, canApprove }) === 'first') {
      return view(await one<any>(`SELECT * FROM payout_transfer WHERE id = $1`, [t.id]));
    }
  } catch (e) {
    if (e instanceof ApprovalError) throw new TransferError(e.statusCode, e.message);
    throw e;
  }
  const d = await railFor(t.integration_id);
  if (!d) throw new TransferError(409, 'Payouts are no longer set up on that account.');
  const lim = d.limits('payout');
  const amount = Number(t.amount_minor);
  if (amount > lim.perTransfer) throw new TransferError(422, `Above the largest payout allowed (${lim.perTransfer} rupiah).`);
  const s = await share(orgId, t.statement_id);
  if (amount > s.outstanding) throw new TransferError(422, `Only ${s.outstanding} is outstanding on ${s.number} now (a payment was recorded meanwhile). Reject this payout and request a new one.`);
  const today = await one<{ sum: string }>(
    `SELECT COALESCE(sum(amount_minor), 0)::bigint AS sum FROM payout_transfer
      WHERE integration_id = $1 AND state IN ('sending', 'sent', 'succeeded') AND approved_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
    [t.integration_id, config.billing.timeZone]);
  if (Number(today?.sum ?? 0) + amount > lim.perDay) {
    throw new TransferError(422, `Today's owner payouts would pass the daily limit (${lim.perDay} rupiah; ${today?.sum ?? 0} approved so far). Approve it tomorrow, or pay it by bank transfer and record it.`);
  }
  const won = await one<any>(`UPDATE payout_transfer SET state = 'sending', approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2 AND state = 'awaiting_approval' RETURNING *`,
    [id, orgId, userId]);
  if (!won) throw new TransferError(409, 'The payout changed meanwhile. Reload.');
  await clearAwaiting('payout', orgId, id);
  const number = unseal(t.account_number_sealed, AAD(orgId, t.statement_id));
  const res = await d.send({ idempotencyKey: `ps-payout-${t.id}`, bankCode: t.bank_code, account: number, holderName: t.holder_name, checkedName: t.checked_name, amount, purpose: 'PlugSure owner share' });
  if (res.ref || res.cust) await query(`UPDATE payout_transfer SET disburse_id = COALESCE($2, disburse_id), cust_ref = COALESCE($3, cust_ref), updated_at = now() WHERE id = $1`, [id, res.ref, res.cust]);
  return settle({ ...t, disburse_id: res.ref ?? t.disburse_id }, res.outcome, res.code, res.error, userId);
}

/** (v1.18.0) Settle a payout from what its rail answered (services/transfer-callbacks.ts). */
export async function settlePayout(t: any, outcome: 'succeeded' | 'failed' | 'unknown', code: string, error: string | null): Promise<PayoutTransferView> {
  return settle(t, outcome, code, error, null);
}

async function settle(t: any, outcome: 'succeeded' | 'failed' | 'unknown', code: string, error: string | null, actor: string | null): Promise<PayoutTransferView> {
  if (outcome === 'succeeded') {
    const r = await one<any>(`UPDATE payout_transfer SET state = 'succeeded', response_code = $2, error = NULL, updated_at = now() WHERE id = $1 AND state IN ('sending', 'sent') RETURNING *`, [t.id, code]);
    if (!r) return view(t);
    // The money has left: the statement payment is recorded whatever else was recorded meanwhile (never lost).
    const zone = config.billing.timeZone;
    const p = await outsideRequestScope(() => one<{ id: string }>(
      `INSERT INTO statement_payment (org_id, statement_id, kind, owner_id, amount_minor, currency, paid_on, reference, note, recorded_by)
       VALUES ($1, $2, 'owner_payout', $3, $4, $5, (now() AT TIME ZONE $6)::date, $7, $8, $9) RETURNING id`,
      [r.org_id, r.statement_id, r.owner_id, r.amount_minor, r.currency, zone, `${r.rail === 'xendit' ? 'Xendit Payouts' : 'Duitku Disbursement'} ${r.disburse_id ?? r.id}`.slice(0, 120),
        r.note ?? `Sent through ${r.rail === 'xendit' ? 'Xendit Payouts' : 'Duitku Disbursement'}`, actor ?? r.approved_by]));
    return view(await one<any>(`UPDATE payout_transfer SET statement_payment_id = $2 WHERE id = $1 RETURNING *`, [t.id, p!.id]));
  }
  if (outcome === 'failed') {
    return view((await one<any>(`UPDATE payout_transfer SET state = 'failed', response_code = $2, error = $3, updated_at = now() WHERE id = $1 AND state IN ('sending', 'sent') RETURNING *`, [t.id, code, error])) ?? t);
  }
  return view((await one<any>(`UPDATE payout_transfer SET state = 'sent', response_code = $2, error = $3, updated_at = now() WHERE id = $1 AND state IN ('sending', 'sent') RETURNING *`, [t.id, code, error])) ?? t);
}

/** A payout whose result Duitku never confirmed, settled by a person after checking Duitku's dashboard. */
export async function resolvePayout(orgId: string, id: string, outcomeRaw: unknown, noteRaw: unknown, userId: string | null): Promise<PayoutTransferView> {
  const outcome = String(outcomeRaw ?? ''), note = String(noteRaw ?? '').trim();
  if (!['succeeded', 'failed'].includes(outcome)) throw new TransferError(422, 'The outcome is succeeded or failed.');
  if (!note || note.length > 300) throw new TransferError(422, 'Note what the gateway\'s dashboard shows (up to 300 characters).');
  const t = await row(orgId, id);
  if (!['sent', 'sending'].includes(t.state)) throw new TransferError(409, `The payout is ${t.state}.`);
  if (t.state === 'sending' && Date.now() - new Date(t.updated_at).getTime() < 10 * 60_000) throw new TransferError(409, 'The payout is being sent. Wait a few minutes.');
  await query(`UPDATE payout_transfer SET reason = $2 WHERE id = $1`, [id, `settled by hand: ${note}`]);
  return settle(t, outcome as 'succeeded' | 'failed', 'manual', outcome === 'failed' ? `not paid, per Duitku's dashboard: ${note}` : null, userId);
}

/** The worker: payouts sent without a known result are asked about; after a day, a person is alerted. */
export async function sweepPayouts(): Promise<number> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT * FROM payout_transfer WHERE state = 'sent' AND (disburse_id IS NOT NULL OR rail = 'xendit') AND updated_at < now() - interval '5 minutes' ORDER BY updated_at LIMIT 50`));
  let n = 0;
  for (const t of rows) {
    await outsideRequestScope(async () => {
      const st = await askRail(t, 'ps-payout');
      if (st?.ref && st.ref !== t.disburse_id) { await query(`UPDATE payout_transfer SET disburse_id = $2 WHERE id = $1`, [t.id, st.ref]); t.disburse_id = st.ref; }
      if (st?.outcome === 'succeeded') { await settle(t, 'succeeded', st.code, null, null); n++; return; }
      if (st?.outcome === 'failed') { await settle(t, 'failed', st.code, st.error, null); return; }
      const checks = Number(t.checks) + 1;
      await query(`UPDATE payout_transfer SET checks = $2, updated_at = now() WHERE id = $1 AND state = 'sent'`, [t.id, checks]);
      if (Date.now() - new Date(t.approved_at ?? t.requested_at).getTime() > 86_400_000 && checks % 24 === 1) {
        await persistAlert({
          orgId: t.org_id, kind: 'payout.disbursement_unconfirmed', severity: 'warning',
          message: `An owner payout (${t.id}, ${t.rail === 'xendit' ? 'Xendit Payouts' : 'Duitku Disbursement'}) has had no confirmed result for over a day. Check it in the gateway's dashboard and settle it in Finance → Refunds & shares due.`,
          targetType: 'commission_statement', targetId: t.statement_id,
        }).catch((e: unknown) => logger.warn({ err: (e as Error).message }, 'payout transfer alert failed'));
      }
    });
  }
  return n;
}
