import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import * as bills from './supplier-bills.js';

/**
 * Supplier payment runs (v1.39.0): pay many approved bills at once from one account.
 *
 *   propose     PR-00001…: from a bank account (its currency), a payment day and a due-by day: every approved bill in
 *               that currency with a balance, due by then and not in another open run (optionally only some
 *               suppliers). Each bill's balance is proposed; amounts can be lowered and bills taken out while a draft.
 *   approve     submitted, then approved by a second person with finance:approve who neither proposed nor submitted
 *               it (or sent back to draft with a note).
 *   bank file   once approved: a CSV for the bank's bulk transfer upload (generic, or laid out like BCA's or
 *               Mandiri's bulk templates: check against your bank's current template before uploading). Every
 *               supplier needs its bank account on file.
 *   paid        once the bank has paid: each bill gets its payment (bank transfer, the run's number as reference, from
 *               the run's account), so payables, the cash position and the ledger follow. A bill that cannot be paid
 *               (paid meanwhile, the month locked) is listed with the reason.
 */

export class PaymentRunError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const ERR = (s: number, m: string) => new PaymentRunError(s, m);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
export const FORMATS = ['generic', 'bca', 'mandiri'] as const;
const OPEN = ['draft', 'submitted', 'approved'];

const R_SELECT = `SELECT r.*, to_char(r.pay_on, 'YYYY-MM-DD') AS pay_s, a.name AS account_name, a.bank_name AS account_bank, a.account_hint,
  uc.name AS created_name, us.name AS submitted_name, ua.name AS approved_name
  FROM payment_run r JOIN cash_account a ON a.id = r.cash_account_id LEFT JOIN app_user uc ON uc.id = r.created_by LEFT JOIN app_user us ON us.id = r.submitted_by LEFT JOIN app_user ua ON ua.id = r.approved_by`;

const runView = (r: any) => ({
  id: String(r.id), number: r.number, currency: r.currency, cashAccountId: String(r.cash_account_id), cashAccount: r.account_name, payOn: r.pay_s, status: r.status as string, note: r.note ?? null,
  createdBy: r.created_name ?? null, submittedBy: r.submitted_name ?? null, approvedBy: r.approved_name ?? null, approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
  exportedAt: r.exported_at ? new Date(r.exported_at).toISOString() : null, exportFormat: r.export_format ?? null, paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null, cancelReason: r.cancel_reason ?? null,
});

async function runRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw ERR(404, 'No such payment run.');
  const r = await outsideRequestScope(() => one<any>(`${R_SELECT} WHERE r.id = $1 AND r.org_id = $2`, [id, orgId]));
  if (!r) throw ERR(404, 'No such payment run.');
  return r;
}

async function items(orgId: string, runId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT i.*, b.number AS bill_number, b.description, to_char(b.due_date, 'YYYY-MM-DD') AS due_s, b.supplier_id, s.name AS supplier, s.bank_name, s.account_number, s.account_name, s.email
       FROM payment_run_item i JOIN supplier_bill b ON b.id = i.bill_id JOIN supplier s ON s.id = b.supplier_id
      WHERE i.run_id = $1 AND i.org_id = $2 AND i.removed_at IS NULL ORDER BY s.name, b.due_date, i.id`, [runId, orgId]));
  return rows.map((i) => ({
    id: String(i.id), billId: String(i.bill_id), billNumber: i.bill_number, description: i.description, dueDate: i.due_s, supplierId: String(i.supplier_id), supplier: i.supplier,
    bank: i.bank_name ?? null, accountNumber: i.account_number ?? null, accountName: i.account_name ?? null, email: i.email ?? null,
    bankReady: !!(i.bank_name && i.account_number && i.account_name), amount: Number(i.amount_minor), paid: i.paid, error: i.error ?? null,
  }));
}

export async function get(orgId: string, id: string) {
  const r = await runRow(orgId, id);
  const its = await items(orgId, id);
  const bySupplier = new Map<string, { supplier: string; bills: number; amount: number; bankReady: boolean }>();
  for (const i of its) { const s = bySupplier.get(i.supplierId) ?? { supplier: i.supplier, bills: 0, amount: 0, bankReady: i.bankReady }; s.bills++; s.amount += i.amount; bySupplier.set(i.supplierId, s); }
  return { ...runView(r), items: its, total: its.reduce((a, i) => a + i.amount, 0), suppliers: bySupplier.size, missingBank: [...bySupplier.values()].filter((s) => !s.bankReady).map((s) => s.supplier), transfers: [...bySupplier.values()] };
}

export async function list(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `${R_SELECT.replace('SELECT r.*,', `SELECT r.*, (SELECT COALESCE(sum(amount_minor), 0) FROM payment_run_item i WHERE i.run_id = r.id AND i.removed_at IS NULL) AS total, (SELECT count(*)::int FROM payment_run_item i WHERE i.run_id = r.id AND i.removed_at IS NULL) AS n,`)}
      WHERE r.org_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 100`, [orgId]));
  return rows.map((r) => ({ ...runView(r), total: Number(r.total), bills: r.n }));
}

/** The approved bills a run would take, without creating it. */
async function candidates(orgId: string, currency: string, dueBy: string, supplierIds: string[] | null, now: Date) {
  const open = await bills.list(orgId, { status: 'approved' }, now);
  const busy = new Set((await outsideRequestScope(() => many<{ b: string }>(
    `SELECT i.bill_id::text AS b FROM payment_run_item i JOIN payment_run r ON r.id = i.run_id WHERE r.org_id = $1 AND r.status = ANY($2::text[]) AND i.removed_at IS NULL`, [orgId, OPEN]))).map((x) => x.b));
  return open.filter((b) => b.currency === currency && b.balance > 0 && b.dueDate <= dueBy && !busy.has(String(b.id)) && (!supplierIds || supplierIds.includes(String(b.supplierId))));
}

export async function propose(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const acct = String(b.cashAccountId ?? '');
  const a = /^\d{1,18}$/.test(acct) ? await outsideRequestScope(() => one<any>(`SELECT id, currency, kind, archived_at FROM cash_account WHERE id = $1 AND org_id = $2`, [acct, orgId])) : null;
  if (!a || a.archived_at) throw ERR(422, 'cashAccountId is one of your bank accounts.');
  if (a.kind !== 'bank') throw ERR(422, 'A payment run pays from a bank account.');
  const payOn = b.payOn == null || b.payOn === '' ? today(now) : String(b.payOn);
  const dueBy = b.dueBy == null || b.dueBy === '' ? payOn : String(b.dueBy);
  if (!DATE_RE.test(payOn) || payOn < today(now)) throw ERR(422, 'payOn is a day (YYYY-MM-DD), today or later.');
  if (!DATE_RE.test(dueBy)) throw ERR(422, 'dueBy is a day (YYYY-MM-DD).');
  const sups = Array.isArray(b.supplierIds) && b.supplierIds.length ? b.supplierIds.map(String) : null;
  const picked = await candidates(orgId, a.currency, dueBy, sups, now);
  if (!picked.length) throw ERR(422, `No approved ${a.currency} bill with a balance is due by ${dueBy} outside another open run.`);
  const n = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM payment_run WHERE org_id = $1`, [orgId]));
  const number = `PR-${String((n?.n ?? 0) + 1).padStart(5, '0')}`;
  const r = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO payment_run (org_id, number, currency, cash_account_id, pay_on, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [orgId, number, a.currency, acct, payOn, b.note == null || b.note === '' ? null : String(b.note).slice(0, 300), userId]));
  for (const x of picked) await outsideRequestScope(() => query(`INSERT INTO payment_run_item (org_id, run_id, bill_id, amount_minor) VALUES ($1, $2, $3, $4)`, [orgId, r!.id, x.id, x.balance]));
  return get(orgId, String(r!.id));
}

/** A draft's items: remove [itemId], amounts {itemId: amount} (at most the bill's balance). */
export async function setItems(orgId: string, id: string, b: Record<string, unknown>, now = new Date()) {
  const r = await runRow(orgId, id);
  if (r.status !== 'draft') throw ERR(409, `The run is ${r.status}: only a draft changes.`);
  const its = await items(orgId, id);
  const remove = Array.isArray(b.remove) ? b.remove.map(String) : [];
  const amounts = (b.amounts && typeof b.amounts === 'object' ? b.amounts : {}) as Record<string, unknown>;
  for (const k of [...remove, ...Object.keys(amounts)]) if (!its.some((i) => i.id === k)) throw ERR(422, `Item ${k} is not in this run.`);
  for (const [k, v] of Object.entries(amounts)) {
    const it = its.find((i) => i.id === k)!;
    const bill = await bills.get(orgId, it.billId, now);
    const amt = Number(v);
    if (!Number.isSafeInteger(amt) || amt <= 0 || amt > bill.balance) throw ERR(422, `The amount for ${it.billNumber} is 1 to its balance (${bill.balance}).`);
    await outsideRequestScope(() => query(`UPDATE payment_run_item SET amount_minor = $3 WHERE id = $1 AND org_id = $2`, [k, orgId, amt]));
  }
  for (const k of remove) await outsideRequestScope(() => query(`UPDATE payment_run_item SET removed_at = now() WHERE id = $1 AND org_id = $2`, [k, orgId]));
  return get(orgId, id);
}

export async function submit(orgId: string, id: string, userId: string | null) {
  const r = await runRow(orgId, id);
  if (r.status !== 'draft') throw ERR(409, `The run is ${r.status}.`);
  if (!(await items(orgId, id)).length) throw ERR(422, 'The run has no bills.');
  await outsideRequestScope(() => query(`UPDATE payment_run SET status = 'submitted', submitted_by = $3, submitted_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, userId]));
  return get(orgId, id);
}

export async function decide(orgId: string, id: string, b: Record<string, unknown>, who: { userId: string | null; canApprove: boolean }) {
  if (!who.canApprove) throw ERR(403, 'A Finance Manager (finance:approve) approves a payment run.');
  const r = await runRow(orgId, id);
  if (r.status !== 'submitted') throw ERR(409, `The run is ${r.status}: only a submitted run is approved.`);
  if (who.userId && (r.created_by === who.userId || r.submitted_by === who.userId)) throw ERR(403, 'A payment run is approved by someone other than the person who proposed or submitted it.');
  if (b.approve === true || b.approve === 'true') {
    await outsideRequestScope(() => query(`UPDATE payment_run SET status = 'approved', approved_by = $3, approved_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, who.userId]));
  } else {
    const note = String(b.note ?? '').trim();
    if (!note) throw ERR(422, 'A run sent back needs a note.');
    await outsideRequestScope(() => query(`UPDATE payment_run SET status = 'draft', submitted_by = NULL, submitted_at = NULL, note = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, note.slice(0, 300)]));
  }
  return get(orgId, id);
}

const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '');

/** The bank file: one transfer per supplier (its bills summed), for an approved run. */
export async function bankFile(orgId: string, id: string, formatRaw: unknown) {
  const format = (formatRaw == null || formatRaw === '' ? 'generic' : String(formatRaw)) as typeof FORMATS[number];
  if (!(FORMATS as readonly string[]).includes(format)) throw ERR(422, `format is one of ${FORMATS.join(', ')}.`);
  const g = await get(orgId, id);
  if (g.status !== 'approved' && g.status !== 'paid') throw ERR(409, 'The bank file is made once the run is approved.');
  if (g.missingBank.length) throw ERR(422, `No bank account on file for ${g.missingBank.join(', ')}: add it to the supplier first.`);
  const per = new Map<string, { name: string; account: string; holder: string; bank: string; email: string; amount: number; bills: string[] }>();
  for (const i of g.items) {
    const p = per.get(i.supplierId) ?? { name: i.supplier, account: digits(i.accountNumber), holder: i.accountName!, bank: i.bank!, email: i.email ?? '', amount: 0, bills: [] as string[] };
    p.amount += i.amount; p.bills.push(i.billNumber); per.set(i.supplierId, p);
  }
  const ref = (p: { bills: string[] }) => `${g.number} ${p.bills.join(' ')}`.slice(0, 36);
  const rows: unknown[][] = format === 'bca'
    ? [['No', 'Account Number', 'Account Name', 'Amount', 'Remark 1', 'Remark 2'], ...[...per.values()].map((p, k) => [k + 1, p.account, p.holder, p.amount, g.number, ref(p).slice(0, 18)])]
    : format === 'mandiri'
      ? [['Account Number', 'Account Name', 'Currency', 'Amount', 'Remark', 'Bank', 'Email'], ...[...per.values()].map((p) => [p.account, p.holder, g.currency, p.amount, ref(p), p.bank, p.email])]
      : [['reference', 'beneficiary', 'account_number', 'account_name', 'bank', 'currency', 'amount', 'bills', 'email', 'pay_on'], ...[...per.values()].map((p) => [g.number, p.name, p.account, p.holder, p.bank, g.currency, p.amount, p.bills.join(' '), p.email, g.payOn])];
  const body = Buffer.from(rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  await outsideRequestScope(() => query(`UPDATE payment_run SET exported_at = now(), export_format = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, format]));
  return { body, name: `${g.number}-${format}.csv`, transfers: per.size, total: g.total };
}

/** Mark the approved run paid: each bill gets its payment. */
export async function markPaid(orgId: string, id: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const g = await get(orgId, id);
  if (g.status !== 'approved') throw ERR(409, `The run is ${g.status}: only an approved run is marked paid.`);
  const paidOn = b.paidOn == null || b.paidOn === '' ? g.payOn : String(b.paidOn);
  if (!DATE_RE.test(paidOn) || paidOn > today(now)) throw ERR(422, 'paidOn is a day (YYYY-MM-DD), not in the future.');
  let paid = 0;
  for (const i of g.items) {
    if (i.paid) continue;
    try {
      await bills.pay(orgId, i.billId, { amount: i.amount, paidOn, method: 'bank_transfer', reference: g.number, cashAccountId: g.cashAccountId }, userId, now);
      await outsideRequestScope(() => query(`UPDATE payment_run_item SET paid = true, error = NULL WHERE id = $1 AND org_id = $2`, [i.id, orgId]));
      paid++;
    } catch (e) {
      await outsideRequestScope(() => query(`UPDATE payment_run_item SET error = $3 WHERE id = $1 AND org_id = $2`, [i.id, orgId, (e as Error).message.slice(0, 300)]));
    }
  }
  if (!paid) throw ERR(422, `No bill could be paid: ${(await items(orgId, id)).map((i) => `${i.billNumber}: ${i.error}`).join('; ')}`);
  await outsideRequestScope(() => query(`UPDATE payment_run SET status = 'paid', paid_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId]));
  return get(orgId, id);
}

export async function cancel(orgId: string, id: string, reasonRaw: unknown) {
  const r = await runRow(orgId, id);
  if (!OPEN.includes(r.status)) throw ERR(409, `The run is ${r.status}.`);
  const reason = String(reasonRaw ?? '').trim();
  if (!reason) throw ERR(422, 'reason is required.');
  await outsideRequestScope(() => query(`UPDATE payment_run SET status = 'cancelled', cancel_reason = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, reason.slice(0, 300)]));
  return get(orgId, id);
}
