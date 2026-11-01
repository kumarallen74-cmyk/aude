import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { gate, type Approver } from './finance-approvals.js';
import { reportingCurrency, currencies } from './fx.js';
import { position, recordBalance } from './cash-position.js';
import { xlsx } from './xlsx.js';

/**
 * Expense claims and petty cash (v1.31.0).
 *
 *   claim        a staff member's claim (EX-00001…): lines with the date, category (fuel, travel, meals, parking, tools,
 *                supplies, phone, other), site, description, amount and PPN, and a receipt (an image or a PDF, up to
 *                3 MB). Submitted by the claimant; a line at or above the receipt amount (default 100 000) needs its
 *                receipt first. Approved by a second person (never the claimant) under the approvals matrix (kind
 *                expense_claim); a line above its category's limit needs a Finance Manager. Rejected with a reason
 *                (corrected and submitted again) or voided. Reimbursed from a cash account (petty cash or a bank) on a
 *                date: the cash position counts it out of that account
 *   petty cash   cash accounts of kind cash: the balance, the float (imprest) and the top-up to it (a transfer from a
 *                bank, Cash), the last count. A count records the notes and coins, their total, what the books
 *                expected that day and the difference, and becomes the account's balance for that day
 */

export class ExpenseError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const CATEGORIES = ['fuel', 'travel', 'meals', 'parking', 'tools', 'supplies', 'phone', 'other'] as const;
export const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const MAX_RECEIPT = 3 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const idOk = (id: string) => /^\d{1,18}$/.test(id);

export interface Policy { receiptAbove: number; limits: Partial<Record<typeof CATEGORIES[number], number>> }

export async function policy(orgId: string): Promise<Policy> {
  const r = await outsideRequestScope(() => one<{ expense_policy: any }>(`SELECT expense_policy FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.expense_policy ?? {};
  return { receiptAbove: Number(v.receiptAbove ?? 100_000), limits: v.limits ?? {} };
}

export async function savePolicy(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await policy(orgId);
  const receiptAbove = b.receiptAbove === undefined ? cur.receiptAbove : Number(b.receiptAbove);
  if (!Number.isInteger(receiptAbove) || receiptAbove < 0) throw new ExpenseError(422, 'receiptAbove is a whole amount, 0 or more.');
  let limits = cur.limits;
  if (b.limits !== undefined) {
    if (b.limits == null || typeof b.limits !== 'object' || Array.isArray(b.limits)) throw new ExpenseError(422, 'limits is an object by category.');
    limits = {};
    for (const [k, v] of Object.entries(b.limits as Record<string, unknown>)) {
      if (!(CATEGORIES as readonly string[]).includes(k)) throw new ExpenseError(422, `Unknown category "${k}".`);
      if (v == null || v === '') continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new ExpenseError(422, `${k}: the limit is a whole amount above 0.`);
      (limits as Record<string, number>)[k] = n;
    }
  }
  const v = { receiptAbove, limits };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, expense_policy, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET expense_policy = EXCLUDED.expense_policy, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

const SELECT = `SELECT c.*, to_char(c.reimbursed_on, 'YYYY-MM-DD') AS reimbursed_on_s, u.name AS claimant_name, fa.name AS first_approved_by_name, ap.name AS approved_by_name, a.name AS account_name
  FROM expense_claim c JOIN app_user u ON u.id = c.claimant_id LEFT JOIN app_user fa ON fa.id = c.first_approved_by LEFT JOIN app_user ap ON ap.id = c.approved_by LEFT JOIN cash_account a ON a.id = c.cash_account_id`;

async function view(r: any, pol: Policy) {
  const lines = await outsideRequestScope(() => many<any>(
    `SELECT l.*, to_char(l.spent_on, 'YYYY-MM-DD') AS spent_s, s.name AS site_name,
            (SELECT json_agg(json_build_object('id', x.id::text, 'filename', x.filename, 'mime', x.mime, 'size', x.size_bytes) ORDER BY x.id) FROM expense_receipt x WHERE x.line_id = l.id) AS receipts
       FROM expense_claim_line l LEFT JOIN site s ON s.id = l.site_id WHERE l.claim_id = $1 AND l.removed_at IS NULL ORDER BY l.seq`, [r.id]));
  const ls = lines.map((l) => {
    const amount = Number(l.amount_minor), vat = Number(l.vat_minor);
    const limit = pol.limits[l.category as typeof CATEGORIES[number]] ?? null;
    const receipts = (l.receipts ?? []) as Array<{ id: string; filename: string; mime: string; size: number }>;
    return { id: String(l.id), seq: l.seq, spentOn: l.spent_s, category: l.category, siteId: l.site_id ?? null, site: l.site_name ?? null, description: l.description, amount, vat, total: amount + vat,
      receipts, receiptNeeded: amount + vat >= pol.receiptAbove && !receipts.length, overLimit: limit != null && amount + vat > limit, limit };
  });
  return {
    id: String(r.id), number: r.number, claimantId: r.claimant_id, claimant: r.claimant_name, title: r.title, currency: r.currency, status: r.status,
    total: ls.reduce((a, l) => a + l.total, 0), lines: ls, overLimit: ls.some((l) => l.overLimit), receiptsMissing: ls.filter((l) => l.receiptNeeded).length,
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null, firstApprovedBy: r.first_approved_by_name ?? null, approvedBy: r.approved_by_name ?? null,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null, rejectReason: r.reject_reason ?? null,
    reimbursedOn: r.reimbursed_on_s ?? null, cashAccountId: r.cash_account_id == null ? null : String(r.cash_account_id), cashAccount: r.account_name ?? null, reference: r.reference ?? null,
  };
}
export type ClaimView = Awaited<ReturnType<typeof view>>;

export async function list(orgId: string, q: Record<string, unknown> = {}, userId: string | null = null) {
  const status = q.status == null || q.status === '' ? null : String(q.status);
  const mine = q.mine === 'true' || q.mine === true;
  const pol = await policy(orgId);
  const rows = await outsideRequestScope(() => many<any>(
    `${SELECT} WHERE c.org_id = $1 AND ($2::text IS NULL OR c.status = $2) AND (NOT $3 OR c.claimant_id = $4::uuid)
      ORDER BY CASE c.status WHEN 'submitted' THEN 0 WHEN 'approved' THEN 1 WHEN 'draft' THEN 2 WHEN 'rejected' THEN 3 ELSE 4 END, c.id DESC LIMIT 300`, [orgId, status, mine, userId]));
  const out = [];
  for (const r of rows) out.push(await view(r, pol));
  const toReimburse: Record<string, number> = {};
  for (const c of out.filter((x) => x.status === 'approved')) toReimburse[c.currency] = (toReimburse[c.currency] ?? 0) + c.total;
  return { claims: out, toReimburse, policy: pol };
}

async function row(orgId: string, id: string) {
  if (!idOk(id)) throw new ExpenseError(404, 'No such claim.');
  const r = await outsideRequestScope(() => one<any>(`${SELECT} WHERE c.id = $1 AND c.org_id = $2`, [id, orgId]));
  if (!r) throw new ExpenseError(404, 'No such claim.');
  return r;
}

export async function get(orgId: string, id: string) { return view(await row(orgId, id), await policy(orgId)); }

function lineOf(l: Record<string, unknown>, i: number, now: Date) {
  const spentOn = String(l.spentOn ?? '');
  if (!validDate(spentOn) || spentOn > today(now)) throw new ExpenseError(422, `Line ${i + 1}: spentOn is a date, not in the future.`);
  const category = String(l.category ?? '');
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new ExpenseError(422, `Line ${i + 1}: category is one of ${CATEGORIES.join(', ')}.`);
  const description = String(l.description ?? '').trim();
  if (description.length < 2 || description.length > 200) throw new ExpenseError(422, `Line ${i + 1}: a description (2 to 200 characters).`);
  const amount = Number(l.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new ExpenseError(422, `Line ${i + 1}: amount is a whole amount above 0.`);
  const vat = l.vat == null || l.vat === '' ? 0 : Number(l.vat);
  if (!Number.isInteger(vat) || vat < 0) throw new ExpenseError(422, `Line ${i + 1}: vat is a whole amount, 0 or more.`);
  const siteId = l.siteId == null || l.siteId === '' ? null : String(l.siteId);
  if (siteId && !UUID_RE.test(siteId)) throw new ExpenseError(404, `Line ${i + 1}: no such site.`);
  return { spentOn, category, description, amount, vat, siteId };
}

async function insertLine(orgId: string, claimId: string, l: ReturnType<typeof lineOf>) {
  if (l.siteId && !(await outsideRequestScope(() => one(`SELECT 1 FROM site WHERE id = $1 AND org_id = $2`, [l.siteId, orgId])))) throw new ExpenseError(404, 'No such site.');
  const seq = await outsideRequestScope(() => one<{ n: number }>(`SELECT COALESCE(max(seq), 0) + 1 AS n FROM expense_claim_line WHERE claim_id = $1`, [claimId]));
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO expense_claim_line (org_id, claim_id, seq, spent_on, category, site_id, description, amount_minor, vat_minor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [orgId, claimId, seq!.n, l.spentOn, l.category, l.siteId, l.description, l.amount, l.vat]));
  return String(r!.id);
}

export async function create(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  if (!userId) throw new ExpenseError(422, 'Expense claims are made by console users (not API keys).');
  const title = String(b.title ?? '').trim();
  if (title.length < 2 || title.length > 120) throw new ExpenseError(422, 'title is 2 to 120 characters.');
  let currency = b.currency == null || b.currency === '' ? null : String(b.currency).toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new ExpenseError(422, 'currency is an ISO code.');
  currency ??= (await reportingCurrency(orgId)) ?? (await currencies(orgId))[0] ?? null;
  if (!currency) throw new ExpenseError(422, 'currency is needed (the organisation has no sites to take it from).');
  const lines = (Array.isArray(b.lines) ? b.lines as Array<Record<string, unknown>> : []).map((l, i) => lineOf(l, i, now));
  if (lines.length > 50) throw new ExpenseError(422, 'At most 50 lines.');
  const n = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) + 1 AS n FROM expense_claim WHERE org_id = $1`, [orgId]));
  let id: string | null = null;
  for (let k = 0, num = Number(n?.n ?? 1); k < 5 && !id; k++, num++) {
    try {
      const r = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO expense_claim (org_id, number, claimant_id, title, currency) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orgId, `EX-${String(num).padStart(5, '0')}`, userId, title, currency]));
      id = String(r!.id);
    } catch (e) { if ((e as any).code !== '23505') throw e; }
  }
  if (!id) throw new ExpenseError(409, 'Could not number the claim. Try again.');
  for (const l of lines) await insertLine(orgId, id, l);
  return get(orgId, id);
}

const editable = (r: any, userId: string | null) => {
  if (r.status !== 'draft' && r.status !== 'rejected') throw new ExpenseError(409, `The claim is ${r.status}.`);
  if (r.claimant_id !== userId) throw new ExpenseError(403, 'Only the claimant changes a claim.');
};

export async function addLine(orgId: string, id: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const r = await row(orgId, id);
  editable(r, userId);
  await insertLine(orgId, id, lineOf(b, 0, now));
  return get(orgId, id);
}

export async function removeLine(orgId: string, id: string, lineId: string, userId: string | null) {
  const r = await row(orgId, id);
  editable(r, userId);
  if (!idOk(lineId)) throw new ExpenseError(404, 'No such line.');
  const done = await outsideRequestScope(() => one(`UPDATE expense_claim_line SET removed_at = now() WHERE id = $1 AND claim_id = $2 AND removed_at IS NULL RETURNING id`, [lineId, id]));
  if (!done) throw new ExpenseError(404, 'No such line.');
  return get(orgId, id);
}

export async function addReceipt(orgId: string, id: string, lineId: string, b: Record<string, unknown>, userId: string | null) {
  const r = await row(orgId, id);
  if (r.status === 'reimbursed' || r.status === 'void') throw new ExpenseError(409, `The claim is ${r.status}.`);
  if (!idOk(lineId) || !(await outsideRequestScope(() => one(`SELECT 1 FROM expense_claim_line WHERE id = $1 AND claim_id = $2 AND removed_at IS NULL`, [lineId, id])))) throw new ExpenseError(404, 'No such line.');
  const mime = String(b.mime ?? '');
  if (!(MIMES as readonly string[]).includes(mime)) throw new ExpenseError(422, `mime is one of ${MIMES.join(', ')}.`);
  const filename = String(b.filename ?? 'receipt').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'receipt';
  const data = Buffer.from(String(b.data ?? ''), 'base64');
  if (!data.length) throw new ExpenseError(422, 'data is the file, base64.');
  if (data.length > MAX_RECEIPT) throw new ExpenseError(413, 'A receipt is at most 3 MB.');
  const sniff = data.subarray(0, 4).toString('hex');
  const ok = (mime === 'image/jpeg' && sniff.startsWith('ffd8')) || (mime === 'image/png' && sniff === '89504e47') || (mime === 'application/pdf' && sniff === '25504446')
    || (mime === 'image/webp' && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP');
  if (!ok) throw new ExpenseError(422, 'The file is not the type it says.');
  await outsideRequestScope(() => query(`INSERT INTO expense_receipt (org_id, line_id, filename, mime, size_bytes, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orgId, lineId, filename, mime, data.length, data, userId]));
  return get(orgId, id);
}

export async function receipt(orgId: string, receiptId: string) {
  if (!idOk(receiptId)) throw new ExpenseError(404, 'No such receipt.');
  const r = await outsideRequestScope(() => one<{ filename: string; mime: string; data: Buffer }>(`SELECT filename, mime, data FROM expense_receipt WHERE id = $1 AND org_id = $2`, [receiptId, orgId]));
  if (!r) throw new ExpenseError(404, 'No such receipt.');
  return r;
}

export async function submit(orgId: string, id: string, userId: string | null) {
  const r = await row(orgId, id);
  editable(r, userId);
  const c = await get(orgId, id);
  if (!c.lines.length) throw new ExpenseError(422, 'Add at least one line.');
  if (c.receiptsMissing) throw new ExpenseError(422, `${c.receiptsMissing} line${c.receiptsMissing === 1 ? ' needs its receipt' : 's need their receipts'} (at or above ${c.lines.find((l) => l.receiptNeeded) ? (await policy(orgId)).receiptAbove : 0}).`);
  await outsideRequestScope(() => query(`UPDATE expense_claim SET status = 'submitted', submitted_at = now(), reject_reason = NULL, first_approved_by = NULL, first_approved_at = NULL WHERE id = $1 AND org_id = $2`, [id, orgId]));
  return get(orgId, id);
}

export async function approve(orgId: string, id: string, who: Approver) {
  const r = await row(orgId, id);
  if (r.status !== 'submitted') throw new ExpenseError(409, `The claim is ${r.status}.`);
  const c = await get(orgId, id);
  if (c.overLimit && !who.canApprove) throw new ExpenseError(403, 'A line is above its category\'s limit: a Finance Manager (finance:approve) approves it.');
  const step = await gate('expense_claim', orgId, { id: r.id, amount: c.total, requested_by: r.claimant_id, first_approved_by: r.first_approved_by }, who);
  if (step === 'first') return { ...(await get(orgId, id)), waitingForSecondApprover: true };
  const won = await outsideRequestScope(() => one(`UPDATE expense_claim SET status = 'approved', approved_by = $3, approved_at = now() WHERE id = $1 AND org_id = $2 AND status = 'submitted' RETURNING id`, [id, orgId, who.userId]));
  if (!won) throw new ExpenseError(409, 'Someone changed the claim at the same time. Reload.');
  return get(orgId, id);
}

export async function reject(orgId: string, id: string, reasonRaw: unknown, userId: string | null) {
  const r = await row(orgId, id);
  if (r.status !== 'submitted') throw new ExpenseError(409, `The claim is ${r.status}.`);
  if (r.claimant_id === userId) throw new ExpenseError(403, 'A claim is rejected by someone other than the claimant.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new ExpenseError(422, 'Give a reason (at least 3 characters).');
  await outsideRequestScope(() => query(`UPDATE expense_claim SET status = 'rejected', reject_reason = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, reason.slice(0, 300)]));
  return get(orgId, id);
}

export async function voidClaim(orgId: string, id: string, userId: string | null, canApprove: boolean) {
  const r = await row(orgId, id);
  if (!['draft', 'rejected', 'submitted'].includes(r.status)) throw new ExpenseError(409, `The claim is ${r.status}.`);
  if (r.claimant_id !== userId && !canApprove) throw new ExpenseError(403, 'The claimant or a Finance Manager voids a claim.');
  await outsideRequestScope(() => query(`UPDATE expense_claim SET status = 'void' WHERE id = $1 AND org_id = $2`, [id, orgId]));
  return get(orgId, id);
}

export async function reimburse(orgId: string, id: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const r = await row(orgId, id);
  if (r.status !== 'approved') throw new ExpenseError(409, 'Only an approved claim is reimbursed.');
  const aid = String(b.cashAccountId ?? '');
  if (!idOk(aid)) throw new ExpenseError(404, 'No such cash account.');
  const a = await outsideRequestScope(() => one<any>(`SELECT * FROM cash_account WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [aid, orgId]));
  if (!a) throw new ExpenseError(404, 'No such cash account.');
  if (a.currency !== r.currency) throw new ExpenseError(422, `The account is in ${a.currency}; the claim is in ${r.currency}.`);
  const on = b.reimbursedOn == null || b.reimbursedOn === '' ? today(now) : String(b.reimbursedOn);
  if (!validDate(on) || on > today(now)) throw new ExpenseError(422, 'reimbursedOn is a date, not in the future.');
  const ref = b.reference == null || b.reference === '' ? null : String(b.reference).slice(0, 80);
  await outsideRequestScope(() => query(`UPDATE expense_claim SET status = 'reimbursed', reimbursed_on = $3, cash_account_id = $4, reimbursed_by = $5, reference = $6 WHERE id = $1 AND org_id = $2 AND status = 'approved'`,
    [id, orgId, on, aid, userId, ref]));
  return get(orgId, id);
}

/** Cash effects for the cash position: claims reimbursed out of an account. */
export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT c.cash_account_id::text AS a, to_char(c.reimbursed_on, 'YYYY-MM-DD') AS d,
            (SELECT COALESCE(sum(l.amount_minor + l.vat_minor), 0) FROM expense_claim_line l WHERE l.claim_id = c.id AND l.removed_at IS NULL)::bigint AS total
       FROM expense_claim c WHERE c.org_id = $1 AND c.status = 'reimbursed' AND c.reimbursed_on <= $2::date`, [orgId, upTo]));
  return rows.map((r) => ({ account_id: r.a, d: r.d, amount: -Number(r.total) }));
}

// ─────────────────────────────────────────── petty cash

export async function pettyCash(orgId: string, now = new Date()) {
  const pos = await position(orgId, {}, now);
  const accts = pos.accounts.filter((a) => a.kind === 'cash');
  const [floats, counts] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT id::text, float_minor FROM cash_account WHERE org_id = $1 AND kind = 'cash'`, [orgId])),
    outsideRequestScope(() => many<any>(
      `SELECT DISTINCT ON (c.account_id) c.account_id::text AS a, to_char(c.counted_on, 'YYYY-MM-DD') AS d, c.total_minor, c.difference_minor, c.note, u.name AS by_name
         FROM cash_count c LEFT JOIN app_user u ON u.id = c.counted_by WHERE c.org_id = $1 ORDER BY c.account_id, c.counted_on DESC, c.id DESC`, [orgId])),
  ]);
  return accts.map((a) => {
    const f = floats.find((x) => x.id === a.id)?.float_minor;
    const flt = f == null ? null : Number(f);
    const last = counts.find((c) => c.a === a.id);
    return { id: a.id, name: a.name, currency: a.currency, balance: a.balance, float: flt, topUp: flt != null && a.balance != null && a.balance < flt ? flt - a.balance : 0,
      lastCount: last ? { on: last.d, total: Number(last.total_minor), difference: last.difference_minor == null ? null : Number(last.difference_minor), note: last.note ?? null, by: last.by_name ?? null } : null };
  });
}

export async function setFloat(orgId: string, accountId: string, b: Record<string, unknown>) {
  if (!idOk(accountId)) throw new ExpenseError(404, 'No such cash account.');
  const v = b.float == null || b.float === '' ? null : Number(b.float);
  if (v != null && (!Number.isInteger(v) || v < 0)) throw new ExpenseError(422, 'float is a whole amount, 0 or more (or empty for none).');
  const r = await outsideRequestScope(() => one(`UPDATE cash_account SET float_minor = $3 WHERE id = $1 AND org_id = $2 AND kind = 'cash' RETURNING id`, [accountId, orgId, v]));
  if (!r) throw new ExpenseError(404, 'No such petty cash account.');
  return { accountId, float: v };
}

/** Count the petty cash: notes and coins by face value; the total becomes the balance for the day. */
export async function count(orgId: string, accountId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  if (!idOk(accountId)) throw new ExpenseError(404, 'No such cash account.');
  const a = await outsideRequestScope(() => one<any>(`SELECT * FROM cash_account WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [accountId, orgId]));
  if (!a || a.kind !== 'cash') throw new ExpenseError(404, 'No such petty cash account.');
  const on = b.countedOn == null || b.countedOn === '' ? today(now) : String(b.countedOn);
  if (!validDate(on) || on > today(now)) throw new ExpenseError(422, 'countedOn is a date, not in the future.');
  const den = (b.denominations ?? {}) as Record<string, unknown>;
  if (typeof den !== 'object' || Array.isArray(den)) throw new ExpenseError(422, 'denominations is an object: face value → how many.');
  let total = 0;
  const clean: Record<string, number> = {};
  for (const [face, n] of Object.entries(den)) {
    const f = Number(face), q = Number(n);
    if (!Number.isInteger(f) || f <= 0 || !Number.isInteger(q) || q < 0) throw new ExpenseError(422, `${face}: a face value above 0 and a whole count.`);
    if (q) { clean[String(f)] = q; total += f * q; }
  }
  if (b.total != null && b.total !== '' && !Object.keys(clean).length) {
    total = Number(b.total);
    if (!Number.isInteger(total) || total < 0) throw new ExpenseError(422, 'total is a whole amount, 0 or more.');
  }
  const pos = await position(orgId, { date: on }, now);
  const expected = pos.accounts.find((x) => x.id === accountId)?.balance ?? null;
  const note = b.note == null || b.note === '' ? null : String(b.note).slice(0, 300);
  await outsideRequestScope(() => query(
    `INSERT INTO cash_count (org_id, account_id, counted_on, denominations, total_minor, expected_minor, difference_minor, note, counted_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [orgId, accountId, on, JSON.stringify(clean), total, expected, expected == null ? null : total - expected, note, userId]));
  await recordBalance(orgId, accountId, { balance: total, onDate: on, note: `Counted${note ? `: ${note}` : ''}` }, userId, now);
  return { accountId, countedOn: on, total, expected, difference: expected == null ? null : total - expected };
}

export function claimsXlsx(cs: ClaimView[]): Buffer {
  return xlsx([{ name: 'Expense claims', rows: [['Number', 'Claimant', 'Title', 'Status', 'Date', 'Category', 'Site', 'Description', 'Currency', 'Amount', 'PPN', 'Receipt'],
    ...cs.flatMap((c) => c.lines.map((l) => [c.number, c.claimant, c.title, c.status, l.spentOn, l.category, l.site ?? '', l.description, c.currency, l.amount, l.vat, l.receipts.length ? 'yes' : '']))],
    widths: [10, 18, 24, 11, 11, 10, 18, 30, 8, 14, 12, 8], formats: [null, null, null, null, null, null, null, null, null, 'int', 'int', null] }]);
}
