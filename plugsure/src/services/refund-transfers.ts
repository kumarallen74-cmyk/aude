import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { seal, unseal } from './secrets.js';
import { byId, resolve } from '../integrations/store.js';
import { providerFor } from './payments/registry.js';
import { DuitkuProvider } from './payments/duitku.js';
import { completeRefund } from './refunds.js';
import { persistAlert } from './alerts.js';

/**
 * Refunds sent through Duitku Disbursement, with two people (v1.15.0).
 *
 * Duitku has no refund API. With the Disbursement credentials saved on the Duitku account that took the payment, a
 * refund can be paid to the driver's bank account from the Refunds page:
 *
 *   1. request   someone with payment:write enters the driver's bank and account; Duitku's inquiry returns the
 *                holder's name the bank has. The payment's refund goes to 'processing' (method 'disbursement'), so it
 *                cannot also be refunded another way while the transfer is open.
 *   2. approve   a SECOND person with payment:write (never the requester) checks the names and approves. Within the
 *                limits (one transfer; all transfers approved that day, platform time zone), a fresh inquiry is made
 *                (the name must not have changed) and the transfer sent, once (a conditional update).
 *   3. result    '00': the refund is recorded refunded. Refused: the refund is due again (a bank transfer, or another
 *                request). Not known (no answer, timeout): the worker asks Duitku (inquirystatus); only a confirmed
 *                payment counts. After 24 hours it is left for a person to settle, after checking Duitku's dashboard
 *                (an unknown result taken as failed could be paid twice).
 *   reject       before it is sent, by anyone with payment:write (the requester withdrawing it, or the approver
 *                refusing it), with a reason: the refund is due again.
 *
 * The account number is sealed (SECRETS_KEY) and bound to the transfer. Every step is audited by the route.
 */

export class TransferError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const AAD = (orgId: string, intentId: string) => `refund_transfer:${orgId}:${intentId}`;
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const OPEN = ['awaiting_approval', 'sending', 'sent'];

/** Names compared as the banks write them: letters and digits, upper case; equal, or one's words all in the other. */
export function namesMatch(entered: string | null | undefined, bank: string | null | undefined): boolean {
  const w = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter((x) => x.length > 1);
  const a = w(entered), b = w(bank);
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  const inB = a.every((x) => b.includes(x)), inA = b.every((x) => a.includes(x));
  return inB || inA;
}

async function duitkuFor(integrationId: string | null): Promise<{ p: DuitkuProvider; id: string } | null> {
  if (!integrationId) return null;
  const r = await byId(integrationId);
  if (!r || r.provider !== 'duitku') return null;
  const p = providerFor(r);
  return p instanceof DuitkuProvider ? { p, id: integrationId } : null;
}

/** Whether a payment's refund can be sent through Disbursement: a Duitku payment whose account has its credentials. */
export async function disbursementAvailable(intentIds: string[]): Promise<Set<string>> {
  if (!intentIds.length) return new Set();
  const rows = await outsideRequestScope(() => many<{ id: string; integration_id: string | null }>(
    `SELECT id, integration_id FROM payment_intent WHERE id = ANY($1::uuid[]) AND provider = 'duitku'`, [intentIds]));
  const ok = new Set<string>();
  const cache = new Map<string, boolean>();
  for (const r of rows) {
    if (!r.integration_id) continue;
    if (!cache.has(r.integration_id)) cache.set(r.integration_id, Boolean((await duitkuFor(r.integration_id).catch(() => null))?.p.hasDisbursement()));
    if (cache.get(r.integration_id)) ok.add(r.id);
  }
  return ok;
}

export interface TransferView {
  id: string; paymentId: string; state: string; amount: number; currency: string; bankCode: string; accountMasked: string;
  holderName: string; checkedName: string | null; namesMatch: boolean; requestedBy: string | null; requestedByName: string | null; requestedAt: string;
  approvedBy: string | null; approvedByName: string | null; approvedAt: string | null; reason: string | null; responseCode: string | null; error: string | null;
}
const view = (r: any): TransferView => ({
  id: String(r.id), paymentId: r.payment_intent_id, state: r.state, amount: Number(r.amount_minor), currency: r.currency, bankCode: r.bank_code,
  accountMasked: `••••${r.account_last4}`, holderName: r.holder_name, checkedName: r.checked_name, namesMatch: namesMatch(r.holder_name, r.checked_name),
  requestedBy: r.requested_by, requestedByName: r.requested_by_name ?? null, requestedAt: iso(r.requested_at)!,
  approvedBy: r.approved_by, approvedByName: r.approved_by_name ?? null, approvedAt: iso(r.approved_at), reason: r.reason, responseCode: r.response_code, error: r.error,
});

export async function listTransfers(orgId: string, f: { open?: boolean } = {}): Promise<TransferView[]> {
  const rows = await many<any>(
    `SELECT t.*, a.name AS requested_by_name, b.name AS approved_by_name FROM refund_transfer t
       LEFT JOIN app_user a ON a.id = t.requested_by LEFT JOIN app_user b ON b.id = t.approved_by
      WHERE t.org_id = $1 AND ($2::boolean IS NOT TRUE OR t.state = ANY($3::text[]))
      ORDER BY t.requested_at DESC LIMIT 300`, [orgId, f.open ?? null, OPEN]);
  return rows.map(view);
}

async function transferRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new TransferError(404, 'No such transfer.');
  const r = await one<any>(`SELECT * FROM refund_transfer WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!r) throw new TransferError(404, 'No such transfer.');
  return r;
}

/** Step 1: request a transfer for a refund that is due (or failed): Duitku's inquiry names the account's holder. */
export async function requestTransfer(orgId: string, intentId: string, b: { bankCode?: unknown; accountNumber?: unknown; holderName?: unknown }, userId: string | null): Promise<TransferView> {
  const bankCode = String(b.bankCode ?? '').trim(), holder = String(b.holderName ?? '').trim();
  const number = String(b.accountNumber ?? '').replace(/[\s.-]/g, '');
  if (!/^[0-9A-Za-z]{2,12}$/.test(bankCode)) throw new TransferError(422, 'The bank code is 2 to 12 letters or digits (Duitku\'s bank codes, e.g. 014 for BCA).');
  if (!/^\d{5,20}$/.test(number)) throw new TransferError(422, 'The account number is 5 to 20 digits.');
  if (!holder || holder.length > 120) throw new TransferError(422, 'The account holder\'s name is 1 to 120 characters.');
  const pi = await one<{ id: string; provider: string; integration_id: string | null; refund_state: string | null; due: string; currency: string }>(
    `SELECT id, provider, integration_id, refund_state, refund_due_minor AS due, currency FROM payment_intent WHERE id = $1 AND org_id = $2`, [intentId, orgId]);
  if (!pi) throw new TransferError(404, 'No such payment.');
  if (pi.provider !== 'duitku') throw new TransferError(409, 'Only refunds of Duitku payments are sent through Disbursement.');
  if (!['due', 'failed'].includes(String(pi.refund_state))) throw new TransferError(409, `The refund is ${pi.refund_state ?? 'not due'}.`);
  const d = await duitkuFor(pi.integration_id);
  if (!d?.p.hasDisbursement()) throw new TransferError(409, 'Disbursement is not set up on the Duitku account that took this payment (Integrations → Payments — fallback).');
  const amount = Number(pi.due);
  const lim = d.p.disbursementLimits();
  if (amount > lim.perTransfer) throw new TransferError(422, `The refund is above the largest transfer allowed (${lim.perTransfer} rupiah): pay it by bank transfer.`);
  const q = await d.p.disbursementInquiry({ bankCode, bankAccount: number, amount, purpose: 'PlugSure refund' });
  if (!q.ok) throw new TransferError(422, `Duitku could not check the account: ${q.error ?? q.responseCode}.`);
  // Hold the refund for the transfer (from due/failed only: a click elsewhere cannot overtake it).
  const held = await one(`UPDATE payment_intent SET refund_state = 'processing', refund_method = 'disbursement', refund_error = 'Awaiting approval of a Disbursement transfer.', updated_at = now()
     WHERE id = $1 AND refund_state IN ('due', 'failed') RETURNING id`, [intentId]);
  if (!held) throw new TransferError(409, 'The refund changed meanwhile. Reload.');
  try {
    const r = await one<any>(
      `INSERT INTO refund_transfer (org_id, payment_intent_id, integration_id, amount_minor, currency, bank_code, account_number_sealed, account_last4, holder_name, checked_name, state, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'awaiting_approval', $11) RETURNING *`,
      [orgId, intentId, d.id, amount, pi.currency, bankCode, seal(number, AAD(orgId, intentId)), number.slice(-4), holder, q.accountName, userId]);
    return view(r);
  } catch (e) {
    await query(`UPDATE payment_intent SET refund_state = 'due', refund_method = NULL, refund_error = NULL, updated_at = now() WHERE id = $1 AND refund_state = 'processing' AND refund_method = 'disbursement'`, [intentId]);
    if ((e as any).code === '23505') throw new TransferError(409, 'A transfer for this refund is already open.');
    throw e;
  }
}

/** The refund is owed again: 'due' after a rejection (nothing was tried), 'failed' after a refused transfer. */
async function release(intentId: string, why: string, to: 'due' | 'failed' = 'failed') {
  await query(`UPDATE payment_intent SET refund_state = $3, refund_method = NULL, refund_error = $2, updated_at = now()
     WHERE id = $1 AND refund_state = 'processing' AND refund_method = 'disbursement'`, [intentId, why, to]);
}

/** Before it is sent: rejected by the approver, or withdrawn by the requester, with a reason. */
export async function rejectTransfer(orgId: string, id: string, reasonRaw: unknown, userId: string | null): Promise<TransferView> {
  const reason = String(reasonRaw ?? '').trim();
  if (!reason || reason.length > 300) throw new TransferError(422, 'Say why the transfer is rejected (up to 300 characters).');
  const t = await transferRow(orgId, id);
  const r = await one<any>(`UPDATE refund_transfer SET state = 'rejected', rejected_by = $3, reason = $4, updated_at = now() WHERE id = $1 AND org_id = $2 AND state = 'awaiting_approval' RETURNING *`,
    [id, orgId, userId, reason]);
  if (!r) throw new TransferError(409, `The transfer is ${t.state}: only one awaiting approval can be rejected.`);
  await release(t.payment_intent_id, `Disbursement transfer rejected: ${reason}`, 'due');
  return view(r);
}

/** Step 2: a second person approves; the transfer is sent, once. */
export async function approveTransfer(orgId: string, id: string, userId: string | null): Promise<TransferView> {
  const t = await transferRow(orgId, id);
  if (t.state !== 'awaiting_approval') throw new TransferError(409, `The transfer is ${t.state}.`);
  if (!userId || t.requested_by === userId) throw new TransferError(403, 'A transfer is approved by a second person: not the one who requested it.');
  const d = await duitkuFor(t.integration_id);
  if (!d?.p.hasDisbursement()) throw new TransferError(409, 'Disbursement is no longer set up on the Duitku account.');
  const lim = d.p.disbursementLimits();
  if (Number(t.amount_minor) > lim.perTransfer) throw new TransferError(422, `Above the largest transfer allowed (${lim.perTransfer} rupiah).`);
  const today = await one<{ sum: string }>(
    `SELECT COALESCE(sum(amount_minor), 0)::bigint AS sum FROM refund_transfer
      WHERE integration_id = $1 AND state IN ('sending', 'sent', 'succeeded')
        AND approved_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`, [t.integration_id, config.billing.timeZone]);
  if (Number(today?.sum ?? 0) + Number(t.amount_minor) > lim.perDay) {
    throw new TransferError(422, `Today's refund transfers would pass the daily limit (${lim.perDay} rupiah; ${today?.sum ?? 0} approved so far). Approve it tomorrow, or pay it by bank transfer.`);
  }
  // Once: awaiting_approval → sending. A second click, or a second approver, finds it taken.
  const won = await one<any>(`UPDATE refund_transfer SET state = 'sending', approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2 AND state = 'awaiting_approval' RETURNING *`,
    [id, orgId, userId]);
  if (!won) throw new TransferError(409, 'The transfer changed meanwhile. Reload.');
  const number = unseal(t.account_number_sealed, AAD(orgId, t.payment_intent_id));
  const amount = Number(t.amount_minor);
  // A fresh inquiry: Duitku's disburseId is short-lived, and the account must still be the one approved.
  const q = await d.p.disbursementInquiry({ bankCode: t.bank_code, bankAccount: number, amount, purpose: 'PlugSure refund' }).catch((e) => ({ ok: false, error: (e as Error).message, responseCode: '' } as any));
  if (!q.ok || !q.disburseId || (t.checked_name && q.accountName && !namesMatch(t.checked_name, q.accountName))) {
    const err = !q.ok ? `Duitku could not check the account again: ${q.error ?? q.responseCode}` : !q.disburseId ? 'Duitku returned no disburseId' : `the bank now names the account ${q.accountName}`;
    const r = await one<any>(`UPDATE refund_transfer SET state = 'failed', error = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, `${err}. Nothing was sent.`]);
    await release(t.payment_intent_id, `Disbursement transfer not sent: ${err}.`);
    return view(r);
  }
  await query(`UPDATE refund_transfer SET disburse_id = $2, cust_ref = $3, updated_at = now() WHERE id = $1`, [id, q.disburseId, q.custRefNumber]);
  const res = await d.p.disbursementTransfer({ bankCode: t.bank_code, bankAccount: number, amount, purpose: 'PlugSure refund', accountName: q.accountName ?? t.checked_name ?? t.holder_name,
    custRefNumber: q.custRefNumber ?? `ps-${t.id}`, disburseId: q.disburseId });
  return settle(orgId, t, res.outcome, res.responseCode, res.error, userId);
}

async function settle(orgId: string, t: any, outcome: 'succeeded' | 'failed' | 'unknown', code: string, error: string | null, actor: string | null): Promise<TransferView> {
  if (outcome === 'succeeded') {
    const r = await one<any>(`UPDATE refund_transfer SET state = 'succeeded', response_code = $2, error = NULL, updated_at = now() WHERE id = $1 AND state IN ('sending', 'sent') RETURNING *`, [t.id, code]);
    await completeRefund(t.payment_intent_id, orgId, Number(t.amount_minor), 'disbursement', `duitku-disb-${(r ?? t).disburse_id ?? t.id}`, actor, ['processing']);
    return view(r ?? t);
  }
  if (outcome === 'failed') {
    const r = await one<any>(`UPDATE refund_transfer SET state = 'failed', response_code = $2, error = $3, updated_at = now() WHERE id = $1 AND state IN ('sending', 'sent') RETURNING *`, [t.id, code, error]);
    await release(t.payment_intent_id, `Duitku refused the Disbursement transfer${code ? ` (${code})` : ''}: ${error ?? ''}. Pay it by bank transfer, or request another transfer.`.replace(': .', '.'));
    return view(r ?? t);
  }
  const r = await one<any>(`UPDATE refund_transfer SET state = 'sent', response_code = $2, error = $3, updated_at = now() WHERE id = $1 AND state IN ('sending', 'sent') RETURNING *`, [t.id, code, error]);
  await query(`UPDATE payment_intent SET refund_error = 'Disbursement transfer sent; its result is checked automatically.', updated_at = now() WHERE id = $1 AND refund_state = 'processing' AND refund_method = 'disbursement'`, [t.payment_intent_id]);
  return view(r ?? t);
}

/**
 * A transfer whose result is not known, settled by a person after checking Duitku's dashboard: paid, or not paid (the
 * refund is then due again). Only for a transfer 'sent' (or stuck 'sending') — never for one Duitku confirmed.
 */
export async function resolveTransfer(orgId: string, id: string, outcomeRaw: unknown, noteRaw: unknown, userId: string | null): Promise<TransferView> {
  const outcome = String(outcomeRaw ?? ''), note = String(noteRaw ?? '').trim();
  if (!['succeeded', 'failed'].includes(outcome)) throw new TransferError(422, 'The outcome is succeeded or failed.');
  if (!note || note.length > 300) throw new TransferError(422, 'Note what Duitku\'s dashboard shows (up to 300 characters).');
  const t = await transferRow(orgId, id);
  if (!['sent', 'sending'].includes(t.state)) throw new TransferError(409, `The transfer is ${t.state}.`);
  if (t.state === 'sending' && Date.now() - new Date(t.updated_at).getTime() < 10 * 60_000) throw new TransferError(409, 'The transfer is being sent. Wait a few minutes.');
  await query(`UPDATE refund_transfer SET reason = $2 WHERE id = $1`, [id, `settled by hand: ${note}`]);
  return settle(orgId, t, outcome as 'succeeded' | 'failed', 'manual', outcome === 'failed' ? `not paid, per Duitku's dashboard: ${note}` : null, userId);
}

/** The worker: transfers sent without a known result are asked about (inquirystatus); after a day, a person is alerted. */
export async function sweepTransfers(): Promise<number> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT * FROM refund_transfer WHERE state = 'sent' AND disburse_id IS NOT NULL AND updated_at < now() - interval '5 minutes' ORDER BY updated_at LIMIT 50`));
  let n = 0;
  for (const t of rows) {
    await outsideRequestScope(async () => {
      const d = await duitkuFor(t.integration_id).catch(() => null);
      const st = d ? await d.p.disbursementStatus(t.disburse_id).catch((e) => ({ outcome: 'unknown' as const, responseCode: '', error: (e as Error).message })) : null;
      if (st?.outcome === 'succeeded') { await settle(t.org_id, t, 'succeeded', st.responseCode, null, null); n++; return; }
      const checks = Number(t.checks) + 1;
      await query(`UPDATE refund_transfer SET checks = $2, updated_at = now() WHERE id = $1 AND state = 'sent'`, [t.id, checks]);
      if (Date.now() - new Date(t.approved_at ?? t.requested_at).getTime() > 86_400_000 && checks % 24 === 1) {
        await persistAlert({
          orgId: t.org_id, kind: 'refund.disbursement_unconfirmed', severity: 'warning',
          message: `A Duitku Disbursement refund transfer (${t.id}) has had no confirmed result for over a day. Check it in Duitku's dashboard and settle it on the Refunds page.`,
          targetType: 'payment_intent', targetId: t.payment_intent_id,
        }).catch((e: unknown) => logger.warn({ err: (e as Error).message }, 'refund transfer alert failed'));
      }
    });
  }
  return n;
}

// ─────────────────────────────────────────── owners' bank accounts checked by name

/**
 * Check an owner's saved bank account with Duitku's Disbursement inquiry (the operator's Duitku account, else the
 * platform's): the holder's name the bank has, compared with the name saved. Nothing is transferred.
 */
export async function checkOwnerAccount(orgId: string, ownerId: string): Promise<{ status: 'matched' | 'mismatch' | 'failed'; bankName: string | null; error: string | null }> {
  const a = await outsideRequestScope(() => one<any>(`SELECT * FROM owner_bank_account WHERE owner_id = $1 AND org_id = $2`, [ownerId, orgId]));
  if (!a) throw new TransferError(404, 'No bank details saved for this owner.');
  if (!a.bank_code) throw new TransferError(422, 'Save the bank code first (Duitku\'s bank codes, e.g. 014 for BCA).');
  const r = await resolve('payments_fallback', orgId);
  const p = r && r.provider === 'duitku' ? providerFor(r) : null;
  if (!(p instanceof DuitkuProvider) || !p.hasDisbursement()) throw new TransferError(409, 'A name check needs Duitku Disbursement (Integrations → Payments — fallback).');
  const number = unseal(a.account_number_sealed, `owner_bank_account:${ownerId}`);
  const q = await p.disbursementInquiry({ bankCode: a.bank_code, bankAccount: number, amount: 10_000, purpose: 'PlugSure account check' });
  const status = !q.ok ? 'failed' : namesMatch(a.holder_name, q.accountName) ? 'matched' : 'mismatch';
  await outsideRequestScope(() => query(`UPDATE owner_bank_account SET name_check_status = $2, name_check_name = $3, name_checked_at = now() WHERE owner_id = $1`,
    [ownerId, status, q.ok ? q.accountName : null]));
  return { status, bankName: q.ok ? q.accountName : null, error: q.ok ? null : (q.error ?? q.responseCode) };
}
