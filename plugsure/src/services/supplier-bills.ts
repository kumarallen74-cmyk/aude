import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { assertOpen } from './finance-periods.js';
import { gate, type Approver } from './finance-approvals.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { reportingCurrency, currencies } from './fx.js';
import { insert as insertAsset, AssetError } from './fixed-assets.js';
import { xlsx } from './xlsx.js';

/**
 * Supplier bills and payables (v1.29.0). What the operator owes its suppliers — installers, maintenance contractors,
 * landlords, the utility, connectivity:
 *
 *   supplier   name, NPWP, contact, bank details, payment terms (days) and the PPh 23 rate it is withheld at
 *   bill       the supplier's number, date and due date (by default the date + the terms), category, site, the
 *              subtotal, PPN and PPh 23 withheld (by default the supplier's rate × the subtotal). Payable = subtotal +
 *              PPN − PPh 23. Recorded as a draft or submitted; approved by a second person (not the one who
 *              submitted it), under the approvals matrix (kind supplier_bill: a Finance Manager, or two approvers,
 *              above an amount); or rejected with a reason
 *   capitalise equipment or installation bought: on approval, an asset in the register (the subtotal, over its life)
 *   payments   recorded against an approved bill (date, amount, method, reference, the cash account); the bill is paid
 *              when they reach the payable. Supplier payments are candidates in bank reconciliation
 *   payables   approved bills not paid in full, by supplier and age (from the due date: current, 1–30, 31–60, 61–90,
 *              over 90 days), what falls due in the next 14 days, and what is awaiting approval
 *
 * An approved bill past its due date raises finance.supplier_bill_overdue (checked daily), resolved when it is paid.
 * Bills and payments dated in a locked month cannot be recorded or voided.
 */

export class BillError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const CATEGORIES = ['energy', 'maintenance', 'rent', 'installation', 'equipment', 'connectivity', 'services', 'other'] as const;
export const METHODS = ['bank_transfer', 'cash', 'card', 'other'] as const;
export const OVERDUE_ALERT = 'finance.supplier_bill_overdue';
const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const ERR = (st: number, msg: string) => new BillError(st, msg);
const text = (v: unknown, max: number) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const bucketOf = (daysLate: number) => (daysLate <= 0 ? 'current' : daysLate <= 30 ? '1-30' : daysLate <= 60 ? '31-60' : daysLate <= 90 ? '61-90' : '90+');

// ─────────────────────────────────────────── suppliers

const supplierView = (r: any) => ({
  id: String(r.id), name: r.name, taxId: r.tax_id ?? null, email: r.email ?? null, phone: r.phone ?? null,
  bank: r.bank_name ? { name: r.bank_name, accountNumber: r.account_number ?? null, accountName: r.account_name ?? null } : null,
  termsDays: Number(r.terms_days), whtPct: Number(r.wht_pct), note: r.note ?? null, archived: !!r.archived_at,
  ...(r.open_minor != null ? { open: Number(r.open_minor), bills: Number(r.bills ?? 0) } : {}),
});

export async function suppliers(orgId: string, includeArchived = false) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT s.*, (SELECT count(*) FROM supplier_bill b WHERE b.supplier_id = s.id AND b.status <> 'void') AS bills,
            COALESCE((SELECT sum(b.subtotal_minor + b.vat_minor - b.wht_minor - COALESCE((SELECT sum(p.amount_minor) FROM supplier_payment p WHERE p.bill_id = b.id AND p.voided_at IS NULL), 0))
                        FROM supplier_bill b WHERE b.supplier_id = s.id AND b.status = 'approved'), 0) AS open_minor
       FROM supplier s WHERE s.org_id = $1 AND ($2 OR s.archived_at IS NULL) ORDER BY s.archived_at NULLS FIRST, lower(s.name)`, [orgId, includeArchived]));
  return rows.map(supplierView);
}

function supplierFields(b: Record<string, unknown>, cur?: any) {
  const name = b.name === undefined && cur ? cur.name : String(b.name ?? '').trim();
  if (name.length < 2 || name.length > 120) throw new BillError(422, 'The supplier\'s name is 2 to 120 characters.');
  const pick = (k: string, col: string, max: number) => (b[k] === undefined && cur ? cur[col] : text(b[k], max));
  const taxId = pick('taxId', 'tax_id', 40);
  if (taxId && !/^[0-9.\-\s]{8,30}$/.test(taxId)) throw new BillError(422, 'taxId (NPWP) is digits, dots and dashes.');
  const email = pick('email', 'email', 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BillError(422, 'That e-mail address does not look right.');
  const terms = b.termsDays === undefined || b.termsDays === '' ? (cur ? Number(cur.terms_days) : 30) : Number(b.termsDays);
  if (!Number.isInteger(terms) || terms < 0 || terms > 180) throw new BillError(422, 'termsDays is 0 to 180.');
  const wht = b.whtPct === undefined || b.whtPct === '' ? (cur ? Number(cur.wht_pct) : 0) : Number(b.whtPct);
  if (!Number.isFinite(wht) || wht < 0 || wht > 30) throw new BillError(422, 'whtPct (PPh 23 withheld) is 0 to 30.');
  const bank = (b.bank ?? {}) as Record<string, unknown>;
  const bankName = b.bank === undefined && cur ? cur.bank_name : text(bank.name, 80);
  const acct = b.bank === undefined && cur ? cur.account_number : text(bank.accountNumber, 40);
  if (acct && !/^[0-9\-\s]{4,40}$/.test(acct)) throw new BillError(422, 'The bank account number is digits.');
  const acctName = b.bank === undefined && cur ? cur.account_name : text(bank.accountName, 120);
  return { name, taxId, email, phone: pick('phone', 'phone', 40), bankName, acct, acctName, terms, wht, note: pick('note', 'note', 500) };
}

export async function createSupplier(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const f = supplierFields(b);
  try {
    const r = await outsideRequestScope(() => one<any>(
      `INSERT INTO supplier (org_id, name, tax_id, email, phone, bank_name, account_number, account_name, terms_days, wht_pct, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [orgId, f.name, f.taxId, f.email, f.phone, f.bankName, f.acct, f.acctName, f.terms, f.wht, f.note, userId]));
    return supplierView(r);
  } catch (e) {
    if ((e as any).code === '23505') throw new BillError(409, 'There is already a supplier with that name.');
    throw e;
  }
}

async function supplierRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new BillError(404, 'No such supplier.');
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM supplier WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!r) throw new BillError(404, 'No such supplier.');
  return r;
}

export async function updateSupplier(orgId: string, id: string, b: Record<string, unknown>) {
  const cur = await supplierRow(orgId, id);
  const f = supplierFields(b, cur);
  const archive = b.archived === undefined ? null : b.archived === true || b.archived === 'true';
  try {
    const r = await outsideRequestScope(() => one<any>(
      `UPDATE supplier SET name = $3, tax_id = $4, email = $5, phone = $6, bank_name = $7, account_number = $8, account_name = $9, terms_days = $10, wht_pct = $11, note = $12,
              archived_at = CASE WHEN $13::boolean IS NULL THEN archived_at WHEN $13 THEN COALESCE(archived_at, now()) ELSE NULL END
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [id, orgId, f.name, f.taxId, f.email, f.phone, f.bankName, f.acct, f.acctName, f.terms, f.wht, f.note, archive]));
    return supplierView(r);
  } catch (e) {
    if ((e as any).code === '23505') throw new BillError(409, 'There is already a supplier with that name.');
    throw e;
  }
}

// ─────────────────────────────────────────── bills

const BILL_SELECT = `SELECT b.*, to_char(b.bill_date, 'YYYY-MM-DD') AS bill_date_s, to_char(b.due_date, 'YYYY-MM-DD') AS due_date_s, to_char(b.paid_at, 'YYYY-MM-DD') AS paid_at_s,
         s.name AS supplier_name, st.name AS site_name, su.name AS submitted_by_name, fa.name AS first_approved_by_name, ap.name AS approved_by_name,
         COALESCE((SELECT sum(p.amount_minor) FROM supplier_payment p WHERE p.bill_id = b.id AND p.voided_at IS NULL), 0)::bigint AS paid_minor,
         (SELECT a.id FROM fixed_asset a WHERE a.supplier_bill_id = b.id AND a.voided_at IS NULL LIMIT 1) AS asset_id
    FROM supplier_bill b JOIN supplier s ON s.id = b.supplier_id LEFT JOIN site st ON st.id = b.site_id
    LEFT JOIN app_user su ON su.id = b.submitted_by LEFT JOIN app_user fa ON fa.id = b.first_approved_by LEFT JOIN app_user ap ON ap.id = b.approved_by`;

function billView(r: any, now = new Date()) {
  const payable = Number(r.subtotal_minor) + Number(r.vat_minor) - Number(r.wht_minor);
  const paid = Number(r.paid_minor ?? 0);
  const t = today(now);
  const daysLate = r.status === 'approved' ? Math.max(0, daysBetween(r.due_date_s, t)) : 0;
  return {
    id: String(r.id), supplierId: String(r.supplier_id), supplier: r.supplier_name, number: r.number, category: r.category,
    siteId: r.site_id ?? null, site: r.site_name ?? null, description: r.description, currency: r.currency,
    subtotal: Number(r.subtotal_minor), vat: Number(r.vat_minor), wht: Number(r.wht_minor), payable, paid, balance: payable - paid,
    billDate: r.bill_date_s, dueDate: r.due_date_s, status: r.status, overdue: daysLate > 0, daysLate,
    capitalise: !!r.capitalise, lifeMonths: r.life_months == null ? null : Number(r.life_months), assetId: r.asset_id == null ? null : String(r.asset_id),
    submittedBy: r.submitted_by_name ?? null, firstApprovedBy: r.first_approved_by_name ?? null, approvedBy: r.approved_by_name ?? null,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null, rejectedReason: r.rejected_reason ?? null, voidReason: r.void_reason ?? null,
    paidAt: r.paid_at_s ?? null,
  };
}
export type BillView = ReturnType<typeof billView>;

export async function list(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const status = q.status == null || q.status === '' ? null : String(q.status);
  const supplierId = q.supplierId == null || q.supplierId === '' ? null : String(q.supplierId);
  if (supplierId && !/^\d{1,18}$/.test(supplierId)) throw new BillError(404, 'No such supplier.');
  const rows = await outsideRequestScope(() => many<any>(
    `${BILL_SELECT} WHERE b.org_id = $1 AND ($2::text IS NULL OR b.status = $2) AND ($3::bigint IS NULL OR b.supplier_id = $3::bigint)
      ORDER BY CASE b.status WHEN 'awaiting_approval' THEN 0 WHEN 'approved' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, b.due_date, b.id LIMIT 500`, [orgId, status, supplierId]));
  return rows.map((r) => billView(r, now));
}

async function billRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new BillError(404, 'No such bill.');
  const r = await outsideRequestScope(() => one<any>(`${BILL_SELECT} WHERE b.id = $1 AND b.org_id = $2`, [id, orgId]));
  if (!r) throw new BillError(404, 'No such bill.');
  return r;
}

export async function get(orgId: string, id: string, now = new Date()) {
  const r = await billRow(orgId, id);
  const pays = await outsideRequestScope(() => many<any>(
    `SELECT p.*, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on_s, c.name AS account_name, u.name AS by_name FROM supplier_payment p
       LEFT JOIN cash_account c ON c.id = p.cash_account_id LEFT JOIN app_user u ON u.id = p.recorded_by WHERE p.bill_id = $1 ORDER BY p.paid_on, p.id`, [id]));
  return { ...billView(r, now), payments: pays.map((p) => ({ id: String(p.id), paidOn: p.paid_on_s, amount: Number(p.amount_minor), method: p.method, reference: p.reference ?? null,
    cashAccountId: p.cash_account_id == null ? null : String(p.cash_account_id), cashAccount: p.account_name ?? null, recordedBy: p.by_name ?? null, voided: !!p.voided_at, voidReason: p.void_reason ?? null })) };
}

async function defaultCurrency(orgId: string, siteId: string | null, raw: unknown) {
  if (siteId) {
    const s = await outsideRequestScope(() => one<{ currency: string }>(`SELECT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2`, [siteId, orgId]));
    if (!s) throw new BillError(404, 'No such site.');
    return s.currency;
  }
  if (raw != null && raw !== '') {
    const c = String(raw).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new BillError(422, 'currency is an ISO code (IDR, MYR, SGD…).');
    return c;
  }
  const c = (await reportingCurrency(orgId)) ?? (await currencies(orgId))[0];
  if (!c) throw new BillError(422, 'currency is needed (the organisation has no sites to take it from).');
  return c;
}

export async function create(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const sup = await supplierRow(orgId, String(b.supplierId ?? ''));
  if (sup.archived_at) throw new BillError(409, 'The supplier is archived.');
  const number = String(b.number ?? '').trim();
  if (number.length < 1 || number.length > 60) throw new BillError(422, 'number is the supplier\'s invoice number (up to 60 characters).');
  const category = String(b.category ?? '');
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new BillError(422, `category is one of ${CATEGORIES.join(', ')}.`);
  const siteId = b.siteId == null || b.siteId === '' ? null : String(b.siteId);
  if (siteId && !UUID_RE.test(siteId)) throw new BillError(404, 'No such site.');
  const description = String(b.description ?? '').trim();
  if (description.length < 2 || description.length > 300) throw new BillError(422, 'Describe the bill (2 to 300 characters).');
  const currency = await defaultCurrency(orgId, siteId, b.currency);
  const subtotal = Number(b.subtotal);
  if (!Number.isInteger(subtotal) || subtotal <= 0) throw new BillError(422, 'subtotal is a whole number of the currency\'s minor unit, above 0.');
  const vat = b.vat == null || b.vat === '' ? 0 : Number(b.vat);
  if (!Number.isInteger(vat) || vat < 0) throw new BillError(422, 'vat (PPN) is a whole amount, 0 or more.');
  const wht = b.wht == null || b.wht === '' ? Math.round((subtotal * Number(sup.wht_pct)) / 100) : Number(b.wht);
  if (!Number.isInteger(wht) || wht < 0 || wht > subtotal) throw new BillError(422, 'wht (PPh 23 withheld) is 0 to the subtotal.');
  const billDate = String(b.billDate ?? '');
  if (!validDate(billDate)) throw new BillError(422, 'billDate is the bill\'s date (YYYY-MM-DD).');
  const dueDate = b.dueDate == null || b.dueDate === '' ? addDays(billDate, Number(sup.terms_days)) : String(b.dueDate);
  if (!validDate(dueDate) || dueDate < billDate) throw new BillError(422, 'dueDate is a date (YYYY-MM-DD), not before the bill\'s date.');
  const capitalise = b.capitalise === true || b.capitalise === 'true';
  const life = b.lifeMonths == null || b.lifeMonths === '' ? null : Number(b.lifeMonths);
  if (life != null && (!Number.isInteger(life) || life < 1 || life > 360)) throw new BillError(422, 'lifeMonths is 1 to 360.');
  if (capitalise && !['installation', 'equipment', 'other'].includes(category)) throw new BillError(422, 'Only installation, equipment or other bills are capitalised as assets.');
  const draft = b.draft === true || b.draft === 'true';
  await assertOpen(orgId, billDate.slice(0, 7), 'A bill', ERR);
  try {
    const r = await outsideRequestScope(() => one<any>(
      `INSERT INTO supplier_bill (org_id, supplier_id, number, category, site_id, description, currency, subtotal_minor, vat_minor, wht_minor, bill_date, due_date, capitalise, life_months, status, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CASE WHEN $15 = 'draft' THEN NULL ELSE now() END) RETURNING id`,
      [orgId, sup.id, number, category, siteId, description, currency, subtotal, vat, wht, billDate, dueDate, capitalise, life, draft ? 'draft' : 'awaiting_approval', userId]));
    return get(orgId, String(r.id), now);
  } catch (e) {
    if ((e as any).code === '23505') throw new BillError(409, `There is already a bill ${number} from ${sup.name}.`);
    throw e;
  }
}

export async function submit(orgId: string, id: string, userId: string | null, now = new Date()) {
  const r = await billRow(orgId, id);
  if (r.status !== 'draft' && r.status !== 'rejected') throw new BillError(409, `The bill is ${r.status.replace('_', ' ')}.`);
  await outsideRequestScope(() => query(
    `UPDATE supplier_bill SET status = 'awaiting_approval', submitted_by = $3, submitted_at = now(), rejected_reason = NULL, first_approved_by = NULL, first_approved_at = NULL WHERE id = $1 AND org_id = $2`, [id, orgId, userId]));
  return get(orgId, id, now);
}

/** Approve: a second person under the matrix. With two approvers, the first approval is recorded and it keeps waiting. */
export async function approve(orgId: string, id: string, who: Approver, now = new Date()) {
  const r = await billRow(orgId, id);
  if (r.status !== 'awaiting_approval') throw new BillError(409, `The bill is ${r.status.replace('_', ' ')}.`);
  const payable = Number(r.subtotal_minor) + Number(r.vat_minor) - Number(r.wht_minor);
  const step = await gate('supplier_bill', orgId, { id: r.id, amount: payable, requested_by: r.submitted_by, first_approved_by: r.first_approved_by }, who);
  if (step === 'first') return { ...(await get(orgId, id, now)), waitingForSecondApprover: true };
  const won = await outsideRequestScope(() => one(
    `UPDATE supplier_bill SET status = 'approved', approved_by = $3, approved_at = now() WHERE id = $1 AND org_id = $2 AND status = 'awaiting_approval' RETURNING id`, [id, orgId, who.userId]));
  if (!won) throw new BillError(409, 'Someone changed the bill at the same time. Reload.');
  let assetError: string | null = null;
  if (r.capitalise) {
    try {
      await insertAsset(orgId, { category: r.category === 'installation' ? 'installation' : r.category === 'equipment' ? 'equipment' : 'other', description: `${r.description} (${r.supplier_name} ${r.number})`.slice(0, 200),
        siteId: r.site_id, currency: r.currency, cost: Number(r.subtotal_minor), acquiredOn: r.bill_date_s, lifeMonths: r.life_months ?? 96 }, who.userId, { supplierBillId: String(r.id) });
    } catch (e) {
      if (!(e instanceof AssetError)) throw e;
      assetError = e.message;
    }
  }
  await resolveAlertsFor(orgId, OVERDUE_ALERT, 'supplier_bill', String(r.id)).catch(() => 0);
  return { ...(await get(orgId, id, now)), ...(assetError ? { assetError } : {}) };
}

export async function reject(orgId: string, id: string, reasonRaw: unknown, userId: string | null, now = new Date()) {
  const r = await billRow(orgId, id);
  if (r.status !== 'awaiting_approval') throw new BillError(409, `The bill is ${r.status.replace('_', ' ')}.`);
  if (r.submitted_by && r.submitted_by === userId) throw new BillError(403, 'A bill is rejected by someone other than the person who submitted it (they can void it).');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new BillError(422, 'Give a reason (at least 3 characters).');
  await outsideRequestScope(() => query(`UPDATE supplier_bill SET status = 'rejected', rejected_reason = $3, approved_by = $4 WHERE id = $1 AND org_id = $2`, [id, orgId, reason.slice(0, 300), userId]));
  return get(orgId, id, now);
}

export async function voidBill(orgId: string, id: string, reasonRaw: unknown, userId: string | null, now = new Date()) {
  const r = await billRow(orgId, id);
  if (r.status === 'void') throw new BillError(409, 'The bill is already void.');
  if (Number(r.paid_minor) > 0) throw new BillError(409, 'Payments are recorded on the bill: void them first.');
  if (r.asset_id) throw new BillError(409, `It was capitalised as an asset: void the asset first.`);
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new BillError(422, 'Give a reason (at least 3 characters).');
  await assertOpen(orgId, r.bill_date_s.slice(0, 7), 'A bill', ERR);
  await outsideRequestScope(() => query(`UPDATE supplier_bill SET status = 'void', void_reason = $3, voided_at = now(), voided_by = $4 WHERE id = $1 AND org_id = $2`, [id, orgId, reason.slice(0, 300), userId]));
  await resolveAlertsFor(orgId, OVERDUE_ALERT, 'supplier_bill', id).catch(() => 0);
  return get(orgId, id, now);
}

export async function pay(orgId: string, id: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const r = await billRow(orgId, id);
  if (r.status !== 'approved') throw new BillError(409, r.status === 'paid' ? 'The bill is paid.' : 'Only an approved bill is paid.');
  const payable = Number(r.subtotal_minor) + Number(r.vat_minor) - Number(r.wht_minor);
  const balance = payable - Number(r.paid_minor);
  const amount = b.amount == null || b.amount === '' ? balance : Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > balance) throw new BillError(422, `amount is 1 to the balance (${balance}).`);
  const paidOn = b.paidOn == null || b.paidOn === '' ? today(now) : String(b.paidOn);
  if (!validDate(paidOn) || paidOn > today(now)) throw new BillError(422, 'paidOn is a date (YYYY-MM-DD), not in the future.');
  const method = b.method == null || b.method === '' ? 'bank_transfer' : String(b.method);
  if (!(METHODS as readonly string[]).includes(method)) throw new BillError(422, `method is one of ${METHODS.join(', ')}.`);
  let accountId: string | null = b.cashAccountId == null || b.cashAccountId === '' ? null : String(b.cashAccountId);
  if (accountId) {
    if (!/^\d{1,18}$/.test(accountId)) throw new BillError(404, 'No such cash account.');
    const a = await outsideRequestScope(() => one<{ currency: string; archived_at: Date | null }>(`SELECT currency, archived_at FROM cash_account WHERE id = $1 AND org_id = $2`, [accountId, orgId]));
    if (!a) throw new BillError(404, 'No such cash account.');
    if (a.currency !== r.currency) throw new BillError(422, `The account is in ${a.currency}; the bill is in ${r.currency}.`);
  }
  await assertOpen(orgId, paidOn.slice(0, 7), 'A payment', ERR);
  await outsideRequestScope(() => query(
    `INSERT INTO supplier_payment (org_id, bill_id, paid_on, amount_minor, method, reference, cash_account_id, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [orgId, id, paidOn, amount, method, text(b.reference, 80), accountId, userId]));
  if (amount === balance) {
    await outsideRequestScope(() => query(`UPDATE supplier_bill SET status = 'paid', paid_at = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, paidOn]));
    await resolveAlertsFor(orgId, OVERDUE_ALERT, 'supplier_bill', id).catch(() => 0);
  }
  return get(orgId, id, now);
}

export async function voidPayment(orgId: string, billId: string, paymentId: string, reasonRaw: unknown, userId: string | null, now = new Date()) {
  const r = await billRow(orgId, billId);
  if (!/^\d{1,18}$/.test(paymentId)) throw new BillError(404, 'No such payment.');
  const p = await outsideRequestScope(() => one<any>(`SELECT *, to_char(paid_on, 'YYYY-MM-DD') AS paid_on_s FROM supplier_payment WHERE id = $1 AND bill_id = $2 AND org_id = $3`, [paymentId, billId, orgId]));
  if (!p) throw new BillError(404, 'No such payment.');
  if (p.voided_at) throw new BillError(409, 'The payment is already void.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new BillError(422, 'Give a reason (at least 3 characters).');
  await assertOpen(orgId, p.paid_on_s.slice(0, 7), 'A payment', ERR);
  const matched = await outsideRequestScope(() => one(`SELECT id FROM bank_statement_line WHERE org_id = $1 AND matched_kind = 'supplier_payment' AND matched_ref = $2`, [orgId, String(paymentId)]));
  if (matched) throw new BillError(409, 'The payment is matched to a bank statement line: undo the match first.');
  await outsideRequestScope(() => query(`UPDATE supplier_payment SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`, [paymentId, userId, reason.slice(0, 300)]));
  if (r.status === 'paid') await outsideRequestScope(() => query(`UPDATE supplier_bill SET status = 'approved', paid_at = NULL WHERE id = $1`, [billId]));
  return get(orgId, billId, now);
}

// ─────────────────────────────────────────── payables

export async function payables(orgId: string, now = new Date()) {
  const t = today(now), horizon = addDays(t, 14);
  const [open, waiting] = await Promise.all([list(orgId, { status: 'approved' }, now), list(orgId, { status: 'awaiting_approval' }, now)]);
  const byCurrency: Record<string, { total: number; overdue: number; buckets: Record<string, number>; suppliers: Record<string, { supplierId: string; supplier: string; total: number; buckets: Record<string, number>; bills: number }> }> = {};
  for (const b of open) {
    if (b.balance <= 0) continue;
    const c = (byCurrency[b.currency] ??= { total: 0, overdue: 0, buckets: Object.fromEntries(BUCKETS.map((k) => [k, 0])), suppliers: {} });
    const k = bucketOf(b.daysLate);
    c.total += b.balance; c.buckets[k]! += b.balance; if (b.overdue) c.overdue += b.balance;
    const s = (c.suppliers[b.supplierId] ??= { supplierId: b.supplierId, supplier: b.supplier, total: 0, buckets: Object.fromEntries(BUCKETS.map((x) => [x, 0])), bills: 0 });
    s.total += b.balance; s.buckets[k]! += b.balance; s.bills++;
  }
  return {
    asOf: t, buckets: [...BUCKETS],
    currencies: Object.entries(byCurrency).map(([currency, c]) => ({ currency, total: c.total, overdue: c.overdue, buckets: c.buckets, suppliers: Object.values(c.suppliers).sort((a, b) => b.total - a.total) })),
    dueSoon: open.filter((b) => b.balance > 0 && b.dueDate >= t && b.dueDate <= horizon).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    overdue: open.filter((b) => b.balance > 0 && b.overdue).sort((a, b) => b.daysLate - a.daysLate),
    awaitingApproval: { count: waiting.length, bills: waiting },
  };
}

/** Approved bills not paid in full, by due date (for the 13-week cash view). */
export async function dueBills(orgId: string, from: string, to: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT b.id, b.number, b.currency, to_char(b.due_date, 'YYYY-MM-DD') AS due, s.name AS supplier,
            b.subtotal_minor + b.vat_minor - b.wht_minor - COALESCE((SELECT sum(p.amount_minor) FROM supplier_payment p WHERE p.bill_id = b.id AND p.voided_at IS NULL), 0) AS balance
       FROM supplier_bill b JOIN supplier s ON s.id = b.supplier_id
      WHERE b.org_id = $1 AND b.status IN ('approved', 'awaiting_approval') AND b.due_date <= $2::date`, [orgId, to]));
  return rows.map((r) => ({ id: String(r.id), number: r.number, supplier: r.supplier, currency: r.currency, due: r.due < from ? from : r.due, overdue: r.due < from, amount: Number(r.balance) })).filter((r) => r.amount > 0);
}

export function payablesXlsx(p: Awaited<ReturnType<typeof payables>>): Buffer {
  return xlsx([
    { name: 'Ageing', rows: [['Currency', 'Supplier', 'Bills', 'Total', ...p.buckets], ...p.currencies.flatMap((c) => c.suppliers.map((s) => [c.currency, s.supplier, s.bills, s.total, ...p.buckets.map((k) => s.buckets[k] ?? 0)]))],
      widths: [8, 32, 8, 16, 14, 14, 14, 14, 14], formats: [null, null, 'int', 'int', 'int', 'int', 'int', 'int', 'int'] },
    { name: 'Open bills', rows: [['Supplier', 'Number', 'Category', 'Site', 'Currency', 'Bill date', 'Due', 'Days late', 'Payable', 'Paid', 'Balance'],
      ...[...p.overdue, ...p.dueSoon].map((b) => [b.supplier, b.number, b.category, b.site ?? '', b.currency, b.billDate, b.dueDate, b.daysLate, b.payable, b.paid, b.balance])],
      widths: [28, 16, 12, 20, 8, 12, 12, 8, 14, 14, 14], formats: [null, null, null, null, null, null, null, 'int', 'int', 'int', 'int'] },
  ]);
}

/** Daily: an alert per approved bill past due; resolved when paid (or void). */
export async function sweep(now = new Date()): Promise<number> {
  const t = today(now);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT b.id, b.org_id, b.number, b.currency, to_char(b.due_date, 'YYYY-MM-DD') AS due, s.name AS supplier,
            b.subtotal_minor + b.vat_minor - b.wht_minor - COALESCE((SELECT sum(p.amount_minor) FROM supplier_payment p WHERE p.bill_id = b.id AND p.voided_at IS NULL), 0) AS balance
       FROM supplier_bill b JOIN supplier s ON s.id = b.supplier_id WHERE b.status = 'approved' AND b.due_date < $1::date`, [t]));
  let n = 0;
  for (const r of rows) {
    if (Number(r.balance) <= 0) continue;
    try {
      await outsideRequestScope(() => persistAlert({ orgId: r.org_id, kind: OVERDUE_ALERT, severity: 'warning', targetType: 'supplier_bill', targetId: String(r.id),
        message: `Bill ${r.number} from ${r.supplier} was due ${r.due} (${daysBetween(r.due, t)} days ago): ${Number(r.balance)} ${r.currency} unpaid.` }));
      n++;
    } catch (e) { logger.warn({ bill: r.id, err: (e as Error).message }, 'supplier bill alert failed'); }
  }
  return n;
}
