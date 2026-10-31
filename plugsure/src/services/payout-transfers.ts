import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { seal, unseal } from './secrets.js';
import { duitkuFor, namesMatch, TransferError } from './refund-transfers.js';
import { persistAlert } from './alerts.js';

/**
 * Owners' shares paid through Duitku Disbursement, with two people (v1.16.0).
 *
 * Since v1.14.0 an owner payout made by the operator's bank is RECORDED against the statement (services/payouts.ts).
 * With the Disbursement credentials saved on the operator's OWN Duitku account (Payments — fallback), a payout can also
 * be SENT from Finance → Payables, the same way refunds are (services/refund-transfers.ts):
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
  id: string; statementId: string; number: string | null; owner: string | null; state: string; amount: number; currency: string; bankCode: string; accountMasked: string;
  holderName: string; checkedName: string | null; namesMatch: boolean; note: string | null; requestedBy: string | null; requestedByName: string | null; requestedAt: string;
  approvedBy: string | null; approvedByName: string | null; approvedAt: string | null; reason: string | null; responseCode: string | null; error: string | null; statementPaymentId: string | null;
}
const view = (r: any): PayoutTransferView => ({
  id: String(r.id), statementId: r.statement_id, number: r.number ?? null, owner: r.owner ?? null, state: r.state, amount: Number(r.amount_minor), currency: r.currency,
  bankCode: r.bank_code, accountMasked: `••••${r.account_last4}`, holderName: r.holder_name, checkedName: r.checked_name, namesMatch: namesMatch(r.holder_name, r.checked_name),
  note: r.note, requestedBy: r.requested_by, requestedByName: r.requested_by_name ?? null, requestedAt: iso(r.requested_at)!,
  approvedBy: r.approved_by, approvedByName: r.approved_by_name ?? null, approvedAt: iso(r.approved_at), reason: r.reason, responseCode: r.response_code, error: r.error,
  statementPaymentId: r.statement_payment_id != null ? String(r.statement_payment_id) : null,
});

/** The Duitku account that pays this organisation's owners: its own, or (platform administrators) the platform's. */
async function payingAccount(orgId: string, platformAdmin: boolean) {
  const rows = await outsideRequestScope(() => many<{ id: string; org_id: string | null }>(
    `SELECT id, org_id FROM integration WHERE kind = 'payments_fallback' AND provider = 'duitku' AND enabled AND archived_at IS NULL
        AND (org_id = $1 OR ($2 AND org_id IS NULL)) ORDER BY (org_id IS NULL)`, [orgId, platformAdmin]));
  for (const r of rows) {
    const d = await duitkuFor(r.id).catch(() => null);
    if (d?.p.hasDisbursement()) return d;
  }
  return null;
}

/** Whether payouts can be sent for this organisation (the Payables page shows the button). */
export async function payoutsAvailable(orgId: string, platformAdmin: boolean): Promise<boolean> {
  return Boolean(await payingAccount(orgId, platformAdmin));
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
export async function requestPayout(orgId: string, platformAdmin: boolean, statementId: string, b: { amount?: unknown; note?: unknown }, userId: string | null): Promise<PayoutTransferView> {
  const s = await share(orgId, statementId);
  const amount = Number(b.amount ?? s.outstanding);
  if (!Number.isInteger(amount) || amount <= 0) throw new TransferError(422, 'The amount is a whole number above zero (minor units).');
  const open = await one<{ n: string }>(`SELECT COALESCE(sum(amount_minor), 0) AS n FROM payout_transfer WHERE statement_id = $1 AND state = ANY($2::text[])`, [statementId, OPEN]);
  if (Number(open?.n ?? 0) > 0) throw new TransferError(409, 'A payout for this statement is already open.');
  if (amount > s.outstanding) throw new TransferError(422, `That is more than is outstanding on ${s.number} (${s.outstanding}).`);
  const d = await payingAccount(orgId, platformAdmin);
  if (!d) throw new TransferError(409, 'Owner payouts need Disbursement on your own Duitku account (Integrations → Payments — fallback).');
  const lim = d.p.payoutLimits();
  if (amount > lim.perTransfer) throw new TransferError(422, `Above the largest payout allowed (${lim.perTransfer} rupiah): pay it by bank transfer and record it.`);
  const acct = await outsideRequestScope(() => one<any>(`SELECT * FROM owner_bank_account WHERE owner_id = $1 AND org_id = $2`, [s.owner_id, orgId]));
  if (!acct) throw new TransferError(422, 'Save the owner\'s bank details first.');
  if (!acct.bank_code) throw new TransferError(422, 'Save the owner\'s bank code first (Duitku\'s bank codes, e.g. 014 for BCA).');
  const number = unseal(acct.account_number_sealed, `owner_bank_account:${s.owner_id}`);
  const q = await d.p.disbursementInquiry({ bankCode: acct.bank_code, bankAccount: number, amount, purpose: 'PlugSure owner share' });
  if (!q.ok) throw new TransferError(422, `Duitku could not check the owner's account: ${q.error ?? q.responseCode}.`);
  const note = b.note == null ? null : String(b.note).trim().slice(0, 300) || null;
  try {
    const r = await one<any>(
      `INSERT INTO payout_transfer (org_id, statement_id, owner_id, integration_id, amount_minor, currency, bank_code, account_number_sealed, account_last4, holder_name, checked_name, state, note, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'awaiting_approval', $12, $13) RETURNING *`,
      [orgId, statementId, s.owner_id, d.id, amount, s.currency, acct.bank_code, seal(number, AAD(orgId, statementId)), number.slice(-4), acct.holder_name, q.accountName, note, userId]);
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
  return view(r);
}

/** Step 2: a second person approves; the transfer is sent, once. */
export async function approvePayout(orgId: string, id: string, userId: string | null): Promise<PayoutTransferView> {
  const t = await row(orgId, id);
  if (t.state !== 'awaiting_approval') throw new TransferError(409, `The payout is ${t.state}.`);
  if (!userId || t.requested_by === userId) throw new TransferError(403, 'A payout is approved by a second person: not the one who requested it.');
  const d = await duitkuFor(t.integration_id);
  if (!d?.p.hasDisbursement()) throw new TransferError(409, 'Disbursement is no longer set up on the Duitku account.');
  const lim = d.p.payoutLimits();
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
  const number = unseal(t.account_number_sealed, AAD(orgId, t.statement_id));
  const q = await d.p.disbursementInquiry({ bankCode: t.bank_code, bankAccount: number, amount, purpose: 'PlugSure owner share' }).catch((e) => ({ ok: false, error: (e as Error).message, responseCode: '' } as any));
  if (!q.ok || !q.disburseId || (t.checked_name && q.accountName && !namesMatch(t.checked_name, q.accountName))) {
    const err = !q.ok ? `Duitku could not check the account again: ${q.error ?? q.responseCode}` : !q.disburseId ? 'Duitku returned no disburseId' : `the bank now names the account ${q.accountName}`;
    return view(await one<any>(`UPDATE payout_transfer SET state = 'failed', error = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, `${err}. Nothing was sent.`]));
  }
  await query(`UPDATE payout_transfer SET disburse_id = $2, cust_ref = $3, updated_at = now() WHERE id = $1`, [id, q.disburseId, q.custRefNumber]);
  const res = await d.p.disbursementTransfer({ bankCode: t.bank_code, bankAccount: number, amount, purpose: 'PlugSure owner share', accountName: q.accountName ?? t.checked_name ?? t.holder_name,
    custRefNumber: q.custRefNumber ?? `ps-p${t.id}`, disburseId: q.disburseId });
  return settle({ ...t, disburse_id: q.disburseId }, res.outcome, res.responseCode, res.error, userId);
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
      [r.org_id, r.statement_id, r.owner_id, r.amount_minor, r.currency, zone, `Duitku Disbursement ${r.disburse_id ?? r.id}`.slice(0, 120), r.note ?? 'Sent through Duitku Disbursement', actor ?? r.approved_by]));
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
  if (!note || note.length > 300) throw new TransferError(422, 'Note what Duitku\'s dashboard shows (up to 300 characters).');
  const t = await row(orgId, id);
  if (!['sent', 'sending'].includes(t.state)) throw new TransferError(409, `The payout is ${t.state}.`);
  if (t.state === 'sending' && Date.now() - new Date(t.updated_at).getTime() < 10 * 60_000) throw new TransferError(409, 'The payout is being sent. Wait a few minutes.');
  await query(`UPDATE payout_transfer SET reason = $2 WHERE id = $1`, [id, `settled by hand: ${note}`]);
  return settle(t, outcome as 'succeeded' | 'failed', 'manual', outcome === 'failed' ? `not paid, per Duitku's dashboard: ${note}` : null, userId);
}

/** The worker: payouts sent without a known result are asked about; after a day, a person is alerted. */
export async function sweepPayouts(): Promise<number> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT * FROM payout_transfer WHERE state = 'sent' AND disburse_id IS NOT NULL AND updated_at < now() - interval '5 minutes' ORDER BY updated_at LIMIT 50`));
  let n = 0;
  for (const t of rows) {
    await outsideRequestScope(async () => {
      const d = await duitkuFor(t.integration_id).catch(() => null);
      const st = d ? await d.p.disbursementStatus(t.disburse_id).catch((e) => ({ outcome: 'unknown' as const, responseCode: '', error: (e as Error).message })) : null;
      if (st?.outcome === 'succeeded') { await settle(t, 'succeeded', st.responseCode, null, null); n++; return; }
      const checks = Number(t.checks) + 1;
      await query(`UPDATE payout_transfer SET checks = $2, updated_at = now() WHERE id = $1 AND state = 'sent'`, [t.id, checks]);
      if (Date.now() - new Date(t.approved_at ?? t.requested_at).getTime() > 86_400_000 && checks % 24 === 1) {
        await persistAlert({
          orgId: t.org_id, kind: 'payout.disbursement_unconfirmed', severity: 'warning',
          message: `A Duitku Disbursement owner payout (${t.id}) has had no confirmed result for over a day. Check it in Duitku's dashboard and settle it in Finance → Payables.`,
          targetType: 'commission_statement', targetId: t.statement_id,
        }).catch((e: unknown) => logger.warn({ err: (e as Error).message }, 'payout transfer alert failed'));
      }
    });
  }
  return n;
}
