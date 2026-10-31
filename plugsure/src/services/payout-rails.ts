import { byId } from '../integrations/store.js';
import { providerFor } from './payments/registry.js';
import { DuitkuProvider } from './payments/duitku.js';
import { XenditProvider, xenditChannelFor } from './payments/xendit.js';

/**
 * The ways PlugSure can send money to a bank account (v1.17.0): refunds (services/refund-transfers.ts) and owner payouts
 * (services/payout-transfers.ts) go through the same two-person flow on either rail:
 *
 *   duitku   Duitku Disbursement (v1.15.0), on a Duitku account with its Disbursement credentials. The bank's name for
 *            the account is checked (inquiry) when requested and again just before sending (the name must not change).
 *            Only Duitku's '00' counts as paid; anything else stays unknown for a person to settle.
 *   xendit   Xendit Payouts (v1.17.0), on a Xendit account with "payouts" on. Xendit has no free name check: the
 *            approver sees the name entered only. Sent once (idempotency key); SUCCEEDED counts as paid, FAILED /
 *            CANCELLED / REVERSED as refused (Xendit's answer is final); anything else is asked about again.
 */

export type RailKind = 'duitku' | 'xendit';
export interface RailCheck { ok: boolean; accountName: string | null; error: string | null }
export interface RailSend { outcome: 'succeeded' | 'failed' | 'unknown'; ref: string | null; cust: string | null; code: string; error: string | null }

export interface Rail {
  kind: RailKind;
  integrationId: string;
  /** Whether the bank's name for an account is returned (Duitku); Xendit's payouts do not check names. */
  checksNames: boolean;
  limits(kind: 'refund' | 'payout'): { perTransfer: number; perDay: number };
  check(a: { bankCode: string; account: string; amount: number; purpose: string }): Promise<RailCheck>;
  send(a: { idempotencyKey: string; bankCode: string; account: string; holderName: string; checkedName: string | null; amount: number; purpose: string }): Promise<RailSend>;
  status(ref: string): Promise<{ outcome: 'succeeded' | 'failed' | 'unknown'; code: string; error: string | null }>;
}

const namesMatch = (entered: string | null | undefined, bank: string | null | undefined): boolean => {
  const w = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter((x) => x.length > 1);
  const a = w(entered), b = w(bank);
  if (!a.length || !b.length) return false;
  return a.join(' ') === b.join(' ') || a.every((x) => b.includes(x)) || b.every((x) => a.includes(x));
};

function duitkuRail(p: DuitkuProvider, integrationId: string): Rail {
  return {
    kind: 'duitku', integrationId, checksNames: true,
    limits: (k) => (k === 'refund' ? p.disbursementLimits() : p.payoutLimits()),
    async check(a) {
      const q = await p.disbursementInquiry({ bankCode: a.bankCode, bankAccount: a.account, amount: a.amount, purpose: a.purpose });
      return { ok: q.ok, accountName: q.accountName, error: q.ok ? null : (q.error ?? q.responseCode) };
    },
    async send(a) {
      // A fresh inquiry: Duitku's disburseId is short-lived, and the account must still be the one approved.
      const q = await p.disbursementInquiry({ bankCode: a.bankCode, bankAccount: a.account, amount: a.amount, purpose: a.purpose })
        .catch((e) => ({ ok: false, error: (e as Error).message, responseCode: '', accountName: null, disburseId: null, custRefNumber: null }));
      if (!q.ok || !q.disburseId || (a.checkedName && q.accountName && !namesMatch(a.checkedName, q.accountName))) {
        const err = !q.ok ? `Duitku could not check the account again: ${q.error ?? q.responseCode}` : !q.disburseId ? 'Duitku returned no disburseId' : `the bank now names the account ${q.accountName}`;
        return { outcome: 'failed', ref: null, cust: null, code: '', error: `${err}. Nothing was sent.` };
      }
      const res = await p.disbursementTransfer({ bankCode: a.bankCode, bankAccount: a.account, amount: a.amount, purpose: a.purpose,
        accountName: q.accountName ?? a.checkedName ?? a.holderName, custRefNumber: q.custRefNumber ?? a.idempotencyKey.slice(0, 20), disburseId: q.disburseId });
      return { outcome: res.outcome, ref: q.disburseId, cust: q.custRefNumber, code: res.responseCode, error: res.error };
    },
    status: (ref) => p.disbursementStatus(ref).then((x) => ({ outcome: x.outcome, code: x.responseCode, error: x.error })),
  };
}

function xenditRail(p: XenditProvider, integrationId: string): Rail {
  return {
    kind: 'xendit', integrationId, checksNames: false,
    limits: (k) => p.payoutLimits(k),
    async check(a) {
      return xenditChannelFor(a.bankCode)
        ? { ok: true, accountName: null, error: null }
        : { ok: false, accountName: null, error: `Xendit has no payout channel for bank code ${a.bankCode}: use its channel code (e.g. ID_BCA) or a known bank code (014 BCA, 008 Mandiri, 002 BRI, 009 BNI)` };
    },
    async send(a) {
      const channel = xenditChannelFor(a.bankCode);
      if (!channel) return { outcome: 'failed', ref: null, cust: null, code: '', error: `No Xendit payout channel for bank code ${a.bankCode}. Nothing was sent.` };
      const r = await p.createPayout({ referenceId: a.idempotencyKey, channelCode: channel, accountNumber: a.account, holderName: a.holderName, amount: a.amount, description: a.purpose, idempotencyKey: a.idempotencyKey });
      return { outcome: r.outcome, ref: r.id, cust: a.idempotencyKey, code: r.code, error: r.error };
    },
    status: (ref) => p.getPayout(ref),
  };
}

/** The rail of a payments integration, when it can send money; null otherwise. */
export async function railFor(integrationId: string | null): Promise<Rail | null> {
  if (!integrationId) return null;
  const r = await byId(integrationId).catch(() => null);
  if (!r) return null;
  let p;
  try { p = providerFor(r); } catch { return null; }
  if (p instanceof DuitkuProvider) return p.hasDisbursement() ? duitkuRail(p, integrationId) : null;
  if (p instanceof XenditProvider) return p.payoutsEnabled() ? xenditRail(p, integrationId) : null;
  return null;
}
