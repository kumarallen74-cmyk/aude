import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { seal, unseal } from './secrets.js';
import { byId, resolve } from '../integrations/store.js';
import { providerFor } from './payments/registry.js';
import { DuitkuProvider } from './payments/duitku.js';
import { completeRefund } from './refunds.js';
import { persistAlert } from './alerts.js';
import { railFor } from './payout-rails.js';
import { notifyAwaiting, clearAwaiting } from './transfer-approvals.js';

/**
 * Refunds sent to the driver's bank account, with two people (v1.15.0: Duitku Disbursement; v1.17.0: also Xendit
 * Payouts — services/payout-rails.ts; the rail is the one of the account that took the payment).
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

export async function duitkuFor(integrationId: string | null): Promise<{ p: DuitkuProvider; id: string } | null> {
  if (!integrationId) return null;
  const r = await byId(integrationId);
  if (!r || r.provider !== 'duitku') return null;
  const p = providerFor(r);
  return p instanceof DuitkuProvider ? { p, id: integrationId } : null;
}

/**
 * Whether a payment's refund can be sent to a bank account, and how: a Duitku payment whose account has Disbursement, or
 * (v1.17.0) a Xendit payment whose account has payouts on. Payment id → rail.
 */
export async function disbursementAvailable(intentIds: string[]): Promise<Map<string, 'duitku' | 'xendit'>> {
  const ok = new Map<string, 'duitku' | 'xendit'>();
  if (!intentIds.length) return ok;
  const rows = await outsideRequestScope(() => many<{ id: string; integration_id: string | null }>(
    `SELECT id, integration_id FROM payment_intent WHERE id = ANY($1::uuid[]) AND provider IN ('duitku', 'xendit')`, [intentIds]));
  const cache = new Map<string, 'duitku' | 'xendit' | null>();
  for (const r of rows) {
    if (!r.integration_id) continue;
    if (!cache.has(r.integration_id)) cache.set(r.integration_id, (await railFor(r.integration_id).catch(() => null))?.kind ?? null);
    const k = cache.get(r.integration_id);
    if (k) ok.set(r.id, k);
  }
  return ok;
}

export interface TransferView {
  id: string; paymentId: string; rail: 'duitku' | 'xendit'; state: string; amount: number; currency: string; bankCode: string; accountMasked: string;
  holderName: string; checkedName: string | null; namesMatch: boolean; requestedBy: string | null; requestedByName: string | null; requestedAt: string;
  approvedBy: string | null; approvedByName: string | null; approvedAt: string | null; reason: string | null; responseCode: string | null; error: string | null;
}
const view = (r: any): TransferView => ({
  id: String(r.id), paymentId: r.payment_intent_id, rail: r.rail ?? 'duitku', state: r.state, amount: Number(r.amount_minor), currency: r.currency, bankCode: r.bank_code,
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
  if (!/^[0-9A-Za-z_]{2,20}$/.test(bankCode)) throw new TransferError(422, 'The bank code is 2 to 20 letters, digits or _ (e.g. 014 for BCA, or Xendit\'s ID_BCA).');
  if (!/^\d{5,20}$/.test(number)) throw new TransferError(422, 'The account number is 5 to 20 digits.');
  if (!holder || holder.length > 120) throw new TransferError(422, 'The account holder\'s name is 1 to 120 characters.');
  const pi = await one<{ id: string; provider: string; integration_id: string | null; refund_state: string | null; due: string; currency: string }>(
    `SELECT id, provider, integration_id, refund_state, refund_due_minor AS due, currency FROM payment_intent WHERE id = $1 AND org_id = $2`, [intentId, orgId]);
  if (!pi) throw new TransferError(404, 'No such payment.');
  if (!['due', 'failed'].includes(String(pi.refund_state))) throw new TransferError(409, `The refund is ${pi.refund_state ?? 'not due'}.`);
  const d = await railFor(pi.integration_id);
  if (!d) throw new TransferError(409, 'Sending refunds is not set up on the account that took this payment: Duitku Disbursement (Payments — fallback) or Xendit payouts (Payments).');
  const amount = Number(pi.due);
  const lim = d.limits('refund');
  if (amount > lim.perTransfer) throw new TransferError(422, `The refund is above the largest transfer allowed (${lim.perTransfer} rupiah): pay it by bank transfer.`);
  const q = await d.check({ bankCode, account: number, amount, purpose: 'PlugSure refund' });
  if (!q.ok) throw new TransferError(422, `${d.kind === 'duitku' ? 'Duitku could not check the account' : 'Xendit cannot pay this account'}: ${q.error}.`);
  // Hold the refund for the transfer (from due/failed only: a click elsewhere cannot overtake it).
  const held = await one(`UPDATE payment_intent SET refund_state = 'processing', refund_method = 'disbursement', refund_error = 'Awaiting approval of a Disbursement transfer.', updated_at = now()
     WHERE id = $1 AND refund_state IN ('due', 'failed') RETURNING id`, [intentId]);
  if (!held) throw new TransferError(409, 'The refund changed meanwhile. Reload.');
  try {
    const r = await one<any>(
      `INSERT INTO refund_transfer (org_id, payment_intent_id, integration_id, amount_minor, currency, bank_code, account_number_sealed, account_last4, holder_name, checked_name, state, requested_by, rail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'awaiting_approval', $11, $12) RETURNING *`,
      [orgId, intentId, d.integrationId, amount, pi.currency, bankCode, seal(number, AAD(orgId, intentId)), number.slice(-4), holder, q.accountName, userId, d.kind]);
    // (v1.18.0) The approvers are told (alert routing).
    const who = userId ? (await one<{ name: string }>(`SELECT name FROM app_user WHERE id = $1`, [userId]))?.name ?? null : null;
    await notifyAwaiting('refund', r, who, `to ${holder}, ${d.kind === 'xendit' ? 'Xendit Payouts' : 'Duitku Disbursement'}`);
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
  await clearAwaiting('refund', orgId, id);
  await release(t.payment_intent_id, `Disbursement transfer rejected: ${reason}`, 'due');
  return view(r);
}

/** Step 2: a second person approves; the transfer is sent, once. */
export async function approveTransfer(orgId: string, id: string, userId: string | null): Promise<TransferView> {
  const t = await transferRow(orgId, id);
  if (t.state !== 'awaiting_approval') throw new TransferError(409, `The transfer is ${t.state}.`);
  if (!userId || t.requested_by === userId) throw new TransferError(403, 'A transfer is approved by a second person: not the one who requested it.');
  const d = await railFor(t.integration_id);
  if (!d) throw new TransferError(409, 'Sending refunds is no longer set up on that account.');
  const lim = d.limits('refund');
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
  await clearAwaiting('refund', orgId, id);
  const number = unseal(t.account_number_sealed, AAD(orgId, t.payment_intent_id));
  const res = await d.send({ idempotencyKey: `ps-refund-${t.id}`, bankCode: t.bank_code, account: number, holderName: t.holder_name, checkedName: t.checked_name,
    amount: Number(t.amount_minor), purpose: 'PlugSure refund' });
  if (res.ref || res.cust) await query(`UPDATE refund_transfer SET disburse_id = COALESCE($2, disburse_id), cust_ref = COALESCE($3, cust_ref), updated_at = now() WHERE id = $1`, [id, res.ref, res.cust]);
  return settle(orgId, { ...t, disburse_id: res.ref ?? t.disburse_id }, res.outcome, res.code, res.error, userId);
}

/** (v1.18.0) Settle a transfer from what its rail answered (services/transfer-callbacks.ts). */
export async function settleTransfer(t: any, outcome: 'succeeded' | 'failed' | 'unknown', code: string, error: string | null): Promise<TransferView> {
  return settle(t.org_id, t, outcome, code, error, null);
}

async function settle(orgId: string, t: any, outcome: 'succeeded' | 'failed' | 'unknown', code: string, error: string | null, actor: string | null): Promise<TransferView> {
  if (outcome === 'succeeded') {
    const r = await one<any>(`UPDATE refund_transfer SET state = 'succeeded', response_code = $2, error = NULL, updated_at = now() WHERE id = $1 AND state IN ('sending', 'sent') RETURNING *`, [t.id, code]);
    await completeRefund(t.payment_intent_id, orgId, Number(t.amount_minor), 'disbursement', `${(r ?? t).rail === 'xendit' ? 'xendit-payout' : 'duitku-disb'}-${(r ?? t).disburse_id ?? t.id}`, actor, ['processing']);
    return view(r ?? t);
  }
  if (outcome === 'failed') {
    const r = await one<any>(`UPDATE refund_transfer SET state = 'failed', response_code = $2, error = $3, updated_at = now() WHERE id = $1 AND state IN ('sending', 'sent') RETURNING *`, [t.id, code, error]);
    await release(t.payment_intent_id, `The transfer was refused${code ? ` (${code})` : ''}: ${error ?? ''}. Pay it by bank transfer, or request another transfer.`.replace(': .', '.'));
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
  if (!note || note.length > 300) throw new TransferError(422, 'Note what the gateway\'s dashboard shows (up to 300 characters).');
  const t = await transferRow(orgId, id);
  if (!['sent', 'sending'].includes(t.state)) throw new TransferError(409, `The transfer is ${t.state}.`);
  if (t.state === 'sending' && Date.now() - new Date(t.updated_at).getTime() < 10 * 60_000) throw new TransferError(409, 'The transfer is being sent. Wait a few minutes.');
  await query(`UPDATE refund_transfer SET reason = $2 WHERE id = $1`, [id, `settled by hand: ${note}`]);
  return settle(orgId, t, outcome as 'succeeded' | 'failed', 'manual', outcome === 'failed' ? `not paid, per Duitku's dashboard: ${note}` : null, userId);
}

/** The worker: transfers sent without a known result are asked about (inquirystatus); after a day, a person is alerted. */
/**
 * Ask a transfer's rail where it stands. A Xendit payout whose answer was lost (no payout id) is sent again with the same
 * idempotency key: Xendit returns the first payout, never a second.
 */
export async function askRail(t: any, keyPrefix: string): Promise<{ outcome: 'succeeded' | 'failed' | 'unknown'; code: string; error: string | null; ref: string | null } | null> {
  const d = await railFor(t.integration_id).catch(() => null);
  if (!d) return null;
  try {
    if (!t.disburse_id) {
      if (d.kind !== 'xendit') return null;
      const number = unseal(t.account_number_sealed, t.payment_intent_id ? AAD(t.org_id, t.payment_intent_id) : `payout_transfer:${t.org_id}:${t.statement_id}`);
      const r = await d.send({ idempotencyKey: `${keyPrefix}-${t.id}`, bankCode: t.bank_code, account: number, holderName: t.holder_name, checkedName: t.checked_name,
        amount: Number(t.amount_minor), purpose: keyPrefix === 'ps-refund' ? 'PlugSure refund' : 'PlugSure owner share' });
      return { outcome: r.outcome, code: r.code, error: r.error, ref: r.ref };
    }
    const st = await d.status(t.disburse_id);
    return { ...st, ref: t.disburse_id };
  } catch (e) {
    return { outcome: 'unknown', code: '', error: (e as Error).message, ref: t.disburse_id ?? null };
  }
}

export async function sweepTransfers(): Promise<number> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT * FROM refund_transfer WHERE state = 'sent' AND (disburse_id IS NOT NULL OR rail = 'xendit') AND updated_at < now() - interval '5 minutes' ORDER BY updated_at LIMIT 50`));
  let n = 0;
  for (const t of rows) {
    await outsideRequestScope(async () => {
      const st = await askRail(t, 'ps-refund');
      if (st?.ref && st.ref !== t.disburse_id) { await query(`UPDATE refund_transfer SET disburse_id = $2 WHERE id = $1`, [t.id, st.ref]); t.disburse_id = st.ref; }
      if (st?.outcome === 'succeeded') { await settle(t.org_id, t, 'succeeded', st.code, null, null); n++; return; }
      // Xendit's refusal is final (FAILED / CANCELLED / REVERSED): the refund is due again. Duitku never answers 'failed' here.
      if (st?.outcome === 'failed') { await settle(t.org_id, t, 'failed', st.code, st.error, null); return; }
      const checks = Number(t.checks) + 1;
      await query(`UPDATE refund_transfer SET checks = $2, updated_at = now() WHERE id = $1 AND state = 'sent'`, [t.id, checks]);
      if (Date.now() - new Date(t.approved_at ?? t.requested_at).getTime() > 86_400_000 && checks % 24 === 1) {
        await persistAlert({
          orgId: t.org_id, kind: 'refund.disbursement_unconfirmed', severity: 'warning',
          message: `A refund transfer (${t.id}, ${t.rail === 'xendit' ? 'Xendit Payouts' : 'Duitku Disbursement'}) has had no confirmed result for over a day. Check it in the gateway's dashboard and settle it on the Refunds page.`,
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
