import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { seal, unseal } from './secrets.js';

/**
 * Payouts and statement payments, recorded (v1.14.0). PlugSure moves no money: the operator's bank does, and the
 * transfer is recorded here against the finalised statement it pays, so Finance shows what is due, part-paid and paid.
 *
 *   owner shares     an owner statement (commission_statement.owner_id) is due its owner_share_minor; the operator
 *                    records each transfer to the owner (kind owner_payout). The owner's bank details are kept here,
 *                    the account number sealed; a transfer list (CSV) of what is due feeds the bank's bulk transfer.
 *   platform fees    an operator's statement to PlugSure (owner_id NULL) is due its total_minor; a platform
 *                    administrator records the operator's payment (kind platform_fee).
 *
 * A payment is never deleted: a mistaken one is voided with a reason. Every change is audited by the route.
 */

export class PayoutError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const AAD = (ownerId: string) => `owner_bank_account:${ownerId}`;
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const ymd = (d: Date | string | null) => (d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)) : null);

export type PayStatus = 'due' | 'partial' | 'paid';
const statusOf = (due: number, paid: number): PayStatus => (paid <= 0 ? 'due' : paid >= due ? 'paid' : 'partial');

// ─────────────────────────────────────────── bank details

export interface BankAccountView { ownerId: string; bankName: string; bankCode: string | null; holderName: string; accountMasked: string; updatedAt: string }

export async function bankAccount(orgId: string, ownerId: string): Promise<BankAccountView | null> {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM owner_bank_account WHERE owner_id = $1 AND org_id = $2`, [ownerId, orgId]));
  return r ? { ownerId, bankName: r.bank_name, bankCode: r.bank_code, holderName: r.holder_name, accountMasked: `••••${r.account_last4}`, updatedAt: iso(r.updated_at)! } : null;
}

export async function saveBankAccount(orgId: string, ownerId: string, b: { bankName?: unknown; bankCode?: unknown; holderName?: unknown; accountNumber?: unknown }, userId: string | null): Promise<BankAccountView> {
  const owner = await outsideRequestScope(() => one<{ id: string }>(`SELECT id FROM site_owner WHERE id = $1 AND org_id = $2`, [ownerId, orgId]));
  if (!owner) throw new PayoutError(404, 'No such site owner.');
  const bankName = String(b.bankName ?? '').trim(), holder = String(b.holderName ?? '').trim(), code = String(b.bankCode ?? '').trim();
  const number = String(b.accountNumber ?? '').replace(/[\s.-]/g, '');
  if (!bankName || bankName.length > 80) throw new PayoutError(422, 'The bank name is 1 to 80 characters (e.g. BCA, Mandiri, BRI).');
  if (!holder || holder.length > 120) throw new PayoutError(422, 'The account holder\'s name is 1 to 120 characters, as the bank has it.');
  if (code && !/^[A-Za-z0-9]{2,12}$/.test(code)) throw new PayoutError(422, 'The bank code is 2 to 12 letters or digits (e.g. 014 for BCA).');
  const existing = await outsideRequestScope(() => one<{ owner_id: string }>(`SELECT owner_id FROM owner_bank_account WHERE owner_id = $1`, [ownerId]));
  if (!number && !existing) throw new PayoutError(422, 'The account number is required.');
  if (number && !/^\d{5,20}$/.test(number)) throw new PayoutError(422, 'The account number is 5 to 20 digits.');
  await outsideRequestScope(() => (number
    ? query(
      `INSERT INTO owner_bank_account (owner_id, org_id, bank_name, bank_code, holder_name, account_number_sealed, account_last4, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (owner_id) DO UPDATE SET bank_name = EXCLUDED.bank_name, bank_code = EXCLUDED.bank_code, holder_name = EXCLUDED.holder_name,
         account_number_sealed = EXCLUDED.account_number_sealed, account_last4 = EXCLUDED.account_last4, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ownerId, orgId, bankName, code || null, holder, seal(number, AAD(ownerId)), number.slice(-4), userId])
    // Only the bank name, code or holder changed: the sealed number stays.
    : query(`UPDATE owner_bank_account SET bank_name = $2, bank_code = $3, holder_name = $4, updated_by = $5, updated_at = now() WHERE owner_id = $1`,
      [ownerId, bankName, code || null, holder, userId])));
  return (await bankAccount(orgId, ownerId))!;
}

// ─────────────────────────────────────────── what is due

export interface OwnerShareRow {
  statementId: string; number: string; period: string; ownerId: string; owner: string; currency: string;
  due: number; paid: number; outstanding: number; status: PayStatus; finalisedAt: string | null; lastPaidOn: string | null;
  bank: { bankName: string; holderName: string; accountMasked: string } | null;
}

/** The organisation's owner statements (finalised, with a share), newest first, with what was paid against each. */
export async function ownerShares(orgId: string, f: { status?: PayStatus | null; limit?: number } = {}): Promise<OwnerShareRow[]> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT s.id, s.number, to_char(s.period, 'YYYY-MM') AS period, s.owner_id, COALESCE(w.legal_name, w.name) AS owner, s.currency,
            s.owner_share_minor AS due, s.finalised_at,
            COALESCE((SELECT sum(amount_minor) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL), 0)::bigint AS paid,
            (SELECT max(paid_on) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL) AS last_paid_on,
            b.bank_name, b.holder_name, b.account_last4
       FROM commission_statement s JOIN site_owner w ON w.id = s.owner_id
       LEFT JOIN owner_bank_account b ON b.owner_id = s.owner_id
      WHERE s.org_id = $1 AND s.owner_id IS NOT NULL AND s.finalised_at IS NOT NULL AND s.owner_share_minor > 0
      ORDER BY s.period DESC, owner LIMIT $2`, [orgId, f.limit ?? 500]));
  const out = rows.map((r) => {
    const due = Number(r.due), paid = Number(r.paid);
    return {
      statementId: r.id, number: r.number, period: r.period, ownerId: r.owner_id, owner: r.owner, currency: r.currency,
      due, paid, outstanding: Math.max(0, due - paid), status: statusOf(due, paid), finalisedAt: iso(r.finalised_at), lastPaidOn: ymd(r.last_paid_on),
      bank: r.bank_name ? { bankName: r.bank_name, holderName: r.holder_name, accountMasked: `••••${r.account_last4}` } : null,
    };
  });
  return f.status ? out.filter((r) => r.status === f.status) : out;
}

export interface PlatformStatementRow {
  statementId: string; number: string; period: string; orgId: string; operator: string; currency: string;
  due: number; paid: number; outstanding: number; status: PayStatus; finalisedAt: string | null; lastPaidOn: string | null;
}

/** Operators' statements to PlugSure (finalised, owner_id NULL), with what each operator paid. Platform administrators. */
export async function platformStatements(f: { status?: PayStatus | null; limit?: number } = {}): Promise<PlatformStatementRow[]> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT s.id, s.number, to_char(s.period, 'YYYY-MM') AS period, s.org_id, o.name AS operator, s.currency, s.total_minor AS due, s.finalised_at,
            COALESCE((SELECT sum(amount_minor) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL), 0)::bigint AS paid,
            (SELECT max(paid_on) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL) AS last_paid_on
       FROM commission_statement s JOIN organisation o ON o.id = s.org_id
      WHERE s.owner_id IS NULL AND s.finalised_at IS NOT NULL AND s.total_minor > 0
      ORDER BY s.period DESC, o.name LIMIT $1`, [f.limit ?? 500]));
  const out = rows.map((r) => {
    const due = Number(r.due), paid = Number(r.paid);
    return {
      statementId: r.id, number: r.number, period: r.period, orgId: r.org_id, operator: r.operator, currency: r.currency,
      due, paid, outstanding: Math.max(0, due - paid), status: statusOf(due, paid), finalisedAt: iso(r.finalised_at), lastPaidOn: ymd(r.last_paid_on),
    };
  });
  return f.status ? out.filter((r) => r.status === f.status) : out;
}

// ─────────────────────────────────────────── recording

/** A statement is stored once finalised (commission_statement.finalised_at is NOT NULL): no draft can be paid. */
interface StatementRow { id: string; org_id: string; owner_id: string | null; currency: string; due: number; number: string }

/**
 * The statement a payment is recorded against, if the caller may: an owner statement of the caller's organisation, or
 * (platform administrators) an operator's statement to PlugSure.
 */
async function statementFor(id: string, orgId: string, platformAdmin: boolean): Promise<StatementRow & { kind: 'owner_payout' | 'platform_fee' }> {
  const s = await outsideRequestScope(() => one<any>(
    `SELECT id, org_id, owner_id, currency, number, CASE WHEN owner_id IS NULL THEN total_minor ELSE owner_share_minor END AS due
       FROM commission_statement WHERE id = $1`, [id]));
  if (!s) throw new PayoutError(404, 'No such statement.');
  const kind = s.owner_id ? 'owner_payout' as const : 'platform_fee' as const;
  if (kind === 'owner_payout' && s.org_id !== orgId) throw new PayoutError(404, 'No such statement.');
  if (kind === 'platform_fee' && !platformAdmin) throw new PayoutError(404, 'No such statement.');
  return { ...s, due: Number(s.due), kind };
}

export async function payments(statementId: string, orgId: string, platformAdmin: boolean) {
  const s = await statementFor(statementId, orgId, platformAdmin);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT p.*, u.name AS recorded_by_name, v.name AS voided_by_name FROM statement_payment p
       LEFT JOIN app_user u ON u.id = p.recorded_by LEFT JOIN app_user v ON v.id = p.voided_by
      WHERE p.statement_id = $1 ORDER BY p.paid_on DESC, p.id DESC`, [s.id]));
  const paid = rows.filter((r) => !r.voided_at).reduce((a, r) => a + Number(r.amount_minor), 0);
  return {
    statement: { id: s.id, number: s.number, kind: s.kind, currency: s.currency, due: s.due, paid, outstanding: Math.max(0, s.due - paid), status: statusOf(s.due, paid) },
    payments: rows.map((r) => ({
      id: String(r.id), amount: Number(r.amount_minor), currency: r.currency, paidOn: ymd(r.paid_on), reference: r.reference, note: r.note,
      recordedBy: r.recorded_by_name ?? null, recordedAt: iso(r.created_at),
      voided: Boolean(r.voided_at), voidedAt: iso(r.voided_at), voidedBy: r.voided_by_name ?? null, voidReason: r.void_reason,
    })),
  };
}

/** Record a transfer against a statement. Over-payment beyond what is outstanding is refused (a typo, most likely). */
export async function recordPayment(statementId: string, orgId: string, platformAdmin: boolean,
  b: { amount?: unknown; paidOn?: unknown; reference?: unknown; note?: unknown }, userId: string | null) {
  const s = await statementFor(statementId, orgId, platformAdmin);
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new PayoutError(422, 'The amount is a whole number above zero, in the statement\'s currency (minor units).');
  const paidOn = String(b.paidOn ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`))) throw new PayoutError(422, 'The payment date is YYYY-MM-DD.');
  if (Date.parse(`${paidOn}T00:00:00Z`) > Date.now() + 86_400_000) throw new PayoutError(422, 'The payment date is in the future.');
  const reference = String(b.reference ?? '').trim();
  if (!reference || reference.length > 120) throw new PayoutError(422, 'The bank reference of the transfer is required (up to 120 characters).');
  const note = b.note == null ? null : String(b.note).trim().slice(0, 500) || null;
  const paid = Number((await outsideRequestScope(() => one<{ n: string }>(
    `SELECT COALESCE(sum(amount_minor), 0) AS n FROM statement_payment WHERE statement_id = $1 AND voided_at IS NULL`, [s.id])))?.n ?? 0);
  if (paid + amount > s.due) throw new PayoutError(422, `That is more than is outstanding on ${s.number} (${s.due - paid} ${s.currency} in minor units).`);
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO statement_payment (org_id, statement_id, kind, owner_id, amount_minor, currency, paid_on, reference, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [s.org_id, s.id, s.kind, s.owner_id, amount, s.currency, paidOn, reference, note, userId]));
  return { paymentId: String(r!.id), orgId: s.org_id, statement: (await payments(s.id, orgId, platformAdmin)).statement };
}

export async function voidPayment(paymentId: string, orgId: string, platformAdmin: boolean, reasonRaw: unknown, userId: string | null) {
  const reason = String(reasonRaw ?? '').trim();
  if (!reason || reason.length > 300) throw new PayoutError(422, 'Say why the payment is voided (up to 300 characters).');
  const p = await outsideRequestScope(() => one<{ statement_id: string; voided_at: Date | null }>(`SELECT statement_id, voided_at FROM statement_payment WHERE id = $1`, [paymentId]));
  if (!p) throw new PayoutError(404, 'No such payment.');
  await statementFor(p.statement_id, orgId, platformAdmin);
  if (p.voided_at) throw new PayoutError(409, 'This payment is already voided.');
  await outsideRequestScope(() => query(`UPDATE statement_payment SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [paymentId, userId, reason]));
  return { statementId: p.statement_id };
}

// ─────────────────────────────────────────── the transfer list

/**
 * What is still owed to site owners, one line per statement, with the owner's bank details (the full account number:
 * this is what the bank's bulk transfer needs). Owners without bank details are listed with the column empty.
 */
export async function transferList(orgId: string): Promise<string> {
  const due = (await ownerShares(orgId)).filter((r) => r.status !== 'paid');
  const accounts = await outsideRequestScope(() => many<any>(`SELECT * FROM owner_bank_account WHERE org_id = $1`, [orgId]));
  const byOwner = new Map(accounts.map((a) => [a.owner_id, a]));
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [['Owner', 'Bank', 'Bank code', 'Account holder', 'Account number', 'Amount', 'Currency', 'Statement', 'Period', 'Description']];
  for (const r of due) {
    const a = byOwner.get(r.ownerId);
    let number = '';
    if (a) { try { number = unseal(a.account_number_sealed, AAD(r.ownerId)); } catch { number = ''; } }
    lines.push([r.owner, a?.bank_name ?? '', a?.bank_code ?? '', a?.holder_name ?? '', number, String(r.outstanding), r.currency, r.number, r.period, `PlugSure ${r.number}`]);
  }
  return '﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n';
}
