import { createHash } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { assertOpen } from './finance-periods.js';
import { exponentOf } from './fx.js';
import { CLAIM_ACCOUNT } from './general-ledger.js';
import { xlsx } from './xlsx.js';

/**
 * Corporate cards and spend policy (v1.39.0).
 *
 *   cards         a company card: holder (a user), bank, last four digits, currency, a single-transaction and a monthly
 *                 limit, active, frozen or closed, and the account its statement is paid from
 *   transactions  imported from the bank's CSV (date, merchant, amount in the card's currency, reference, category;
 *                 a refund is negative; a line already imported is skipped) or entered; a receipt each (an image or a
 *                 PDF, up to 3 MB)
 *   policy        flags: over the single or monthly limit, at a weekend, a blocked category or merchant, no receipt
 *                 at or above the receipt amount (100 000 by default), a likely duplicate. A transaction with a flag
 *                 is approved only by a Finance Manager; nobody approves their own card's spending. A rejected one is
 *                 personal: owed back by the holder.
 *   statements    the bank's monthly statement total per card, against the transactions (the difference shown), and
 *                 when it was paid and from which account
 *   ledger        the new cards source: each month's transactions by category (Dr the expense / Cr 2165 corporate cards
 *                 payable; rejected ones Dr 1480 receivable from employees); a statement paid, Dr 2165 / Cr bank
 */

export class CardError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const ERR = (s: number, m: string) => new CardError(s, m);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
export const CATEGORIES = ['fuel', 'travel', 'meals', 'parking', 'tools', 'supplies', 'phone', 'software', 'other'] as const;
export const FLAGS = ['over_single_limit', 'over_monthly_limit', 'weekend', 'blocked_category', 'blocked_merchant', 'no_receipt', 'duplicate'] as const;
const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
const MAX_RECEIPT = 3 * 1024 * 1024;
export const accountFor = (category: string) => (category === 'software' ? '6380' : CLAIM_ACCOUNT[category] ?? '6390');

export interface Policy { receiptAbove: number; weekendFlag: boolean; blockedCategories: string[]; blockedMerchants: string[] }

export async function policy(orgId: string): Promise<Policy> {
  const r = await outsideRequestScope(() => one<{ card_policy: any }>(`SELECT card_policy FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const p = r?.card_policy ?? {};
  return { receiptAbove: Number.isInteger(p.receiptAbove) ? p.receiptAbove : 100_000, weekendFlag: p.weekendFlag !== false, blockedCategories: p.blockedCategories ?? [], blockedMerchants: p.blockedMerchants ?? [] };
}

export async function savePolicy(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await policy(orgId);
  const receiptAbove = b.receiptAbove === undefined ? cur.receiptAbove : Number(b.receiptAbove);
  if (!Number.isSafeInteger(receiptAbove) || receiptAbove < 0) throw ERR(422, 'receiptAbove is a whole amount, 0 or more.');
  const cats = b.blockedCategories === undefined ? cur.blockedCategories : (Array.isArray(b.blockedCategories) ? b.blockedCategories.map(String) : []);
  for (const c of cats) if (!(CATEGORIES as readonly string[]).includes(c)) throw ERR(422, `blockedCategories are among ${CATEGORIES.join(', ')}.`);
  const merchants = b.blockedMerchants === undefined ? cur.blockedMerchants : (Array.isArray(b.blockedMerchants) ? b.blockedMerchants.map((m) => String(m).trim().toLowerCase()).filter(Boolean).slice(0, 50) : []);
  const v: Policy = { receiptAbove, weekendFlag: b.weekendFlag === undefined ? cur.weekendFlag : b.weekendFlag === true || b.weekendFlag === 'true', blockedCategories: cats, blockedMerchants: merchants };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, card_policy, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET card_policy = EXCLUDED.card_policy, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

type Txn = { id: string; cardId: string; txnOn: string; merchant: string; category: string; amount: number; hasReceipt: boolean };
type CardLimits = { singleLimit: number | null; monthlyLimit: number | null };

/** The policy flags of a card's transactions (chronological; the monthly limit flags from the one that crosses it). Pure. */
export function flagsFor(txns: Txn[], card: CardLimits, p: Policy): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const sorted = [...txns].sort((a, b) => a.txnOn.localeCompare(b.txnOn) || Number(a.id) - Number(b.id));
  const month: Record<string, number> = {}, seen = new Set<string>();
  for (const t of sorted) {
    const f: string[] = [];
    if (t.amount > 0) {
      if (card.singleLimit != null && t.amount > card.singleLimit) f.push('over_single_limit');
      const m = t.txnOn.slice(0, 7);
      month[m] = (month[m] ?? 0) + t.amount;
      if (card.monthlyLimit != null && month[m]! > card.monthlyLimit) f.push('over_monthly_limit');
      const dow = new Date(`${t.txnOn}T00:00:00Z`).getUTCDay();
      if (p.weekendFlag && (dow === 0 || dow === 6)) f.push('weekend');
      if (p.blockedCategories.includes(t.category)) f.push('blocked_category');
      if (p.blockedMerchants.some((x) => t.merchant.toLowerCase().includes(x))) f.push('blocked_merchant');
      if (t.amount >= p.receiptAbove && !t.hasReceipt) f.push('no_receipt');
    }
    const key = `${t.txnOn}|${t.amount}|${t.merchant.trim().toLowerCase()}`;
    if (seen.has(key)) f.push('duplicate');
    seen.add(key);
    out.set(t.id, f);
  }
  return out;
}

const C_SELECT = `SELECT c.*, u.name AS holder_user, a.name AS account_name FROM corp_card c LEFT JOIN app_user u ON u.id = c.holder_id LEFT JOIN cash_account a ON a.id = c.cash_account_id`;
const cardView = (c: any) => ({
  id: String(c.id), holderId: c.holder_id ?? null, holder: c.holder_name, bank: c.bank, last4: c.last4, masked: `•••• ${c.last4}`, currency: c.currency,
  singleLimit: c.single_limit_minor == null ? null : Number(c.single_limit_minor), monthlyLimit: c.monthly_limit_minor == null ? null : Number(c.monthly_limit_minor),
  status: c.status as string, cashAccountId: c.cash_account_id == null ? null : String(c.cash_account_id), cashAccount: c.account_name ?? null,
});

async function cardRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw ERR(404, 'No such card.');
  const c = await outsideRequestScope(() => one<any>(`${C_SELECT} WHERE c.id = $1 AND c.org_id = $2`, [id, orgId]));
  if (!c) throw ERR(404, 'No such card.');
  return c;
}

async function cardFields(orgId: string, b: Record<string, unknown>, cur: any | null) {
  const pick = <T>(k: string, f: () => T, dflt: T) => (b[k] === undefined ? dflt : f());
  const holderId = pick('holderId', () => (b.holderId == null || b.holderId === '' ? null : String(b.holderId)), cur?.holder_id ?? null);
  if (holderId && (!UUID_RE.test(holderId) || !(await outsideRequestScope(() => one(`SELECT 1 FROM app_user WHERE id = $1 AND org_id = $2`, [holderId, orgId]))))) throw ERR(422, 'holderId is a user of your organisation.');
  const holder = pick('holderName', () => String(b.holderName ?? '').trim(), cur?.holder_name ?? '');
  const bank = pick('bank', () => String(b.bank ?? '').trim(), cur?.bank ?? '');
  const last4 = pick('last4', () => String(b.last4 ?? ''), cur?.last4 ?? '');
  const currency = cur ? cur.currency : String(b.currency ?? '').toUpperCase();
  if (!holder || holder.length > 120) throw ERR(422, 'holderName is required (up to 120 characters).');
  if (!bank || bank.length > 80) throw ERR(422, 'bank is required.');
  if (!/^\d{4}$/.test(last4)) throw ERR(422, 'last4 is the card\'s last four digits (never the full number).');
  if (!/^[A-Z]{3}$/.test(currency)) throw ERR(422, 'currency is an ISO code.');
  const lim = (k: string, d: unknown) => { const v = b[k] === undefined ? d : b[k]; if (v == null || v === '') return null; const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw ERR(422, `${k} is a positive amount in minor units, or empty.`); return n; };
  const single = lim('singleLimit', cur?.single_limit_minor), monthly = lim('monthlyLimit', cur?.monthly_limit_minor);
  const status = pick('status', () => String(b.status), cur?.status ?? 'active');
  if (!['active', 'frozen', 'closed'].includes(status)) throw ERR(422, 'status is active, frozen or closed.');
  const acct = pick('cashAccountId', () => (b.cashAccountId == null || b.cashAccountId === '' ? null : String(b.cashAccountId)), cur?.cash_account_id == null ? null : String(cur.cash_account_id));
  if (acct) {
    const a = /^\d{1,18}$/.test(acct) ? await outsideRequestScope(() => one<{ currency: string }>(`SELECT currency FROM cash_account WHERE id = $1 AND org_id = $2`, [acct, orgId])) : null;
    if (!a) throw ERR(422, 'cashAccountId is not one of your cash accounts.');
    if (a.currency !== currency) throw ERR(422, `The account is in ${a.currency}; the card in ${currency}.`);
  }
  return { holderId, holder, bank, last4, currency, single, monthly, status, acct };
}

export async function createCard(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const f = await cardFields(orgId, b, null);
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO corp_card (org_id, holder_id, holder_name, bank, last4, currency, single_limit_minor, monthly_limit_minor, status, cash_account_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [orgId, f.holderId, f.holder, f.bank, f.last4, f.currency, f.single, f.monthly, f.status, f.acct, userId]));
  return cardView(await cardRow(orgId, String(r!.id)));
}

export async function updateCard(orgId: string, id: string, b: Record<string, unknown>) {
  const c = await cardRow(orgId, id);
  const f = await cardFields(orgId, b, c);
  await outsideRequestScope(() => query(`UPDATE corp_card SET holder_id = $3, holder_name = $4, bank = $5, last4 = $6, single_limit_minor = $7, monthly_limit_minor = $8, status = $9, cash_account_id = $10 WHERE id = $1 AND org_id = $2`,
    [id, orgId, f.holderId, f.holder, f.bank, f.last4, f.single, f.monthly, f.status, f.acct]));
  return cardView(await cardRow(orgId, id));
}

const T_SELECT = `SELECT t.id, t.card_id, to_char(t.txn_on, 'YYYY-MM-DD') AS txn_s, t.merchant, t.category, t.amount_minor, t.reference, t.receipt_name, t.receipt_type, t.receipt_data IS NOT NULL AS has_receipt,
  t.status, t.note, t.reviewed_at, u.name AS reviewed_name FROM card_txn t LEFT JOIN app_user u ON u.id = t.reviewed_by`;

async function cardTxns(orgId: string, cardId: string) {
  return outsideRequestScope(() => many<any>(`${T_SELECT} WHERE t.org_id = $1 AND t.card_id = $2 ORDER BY t.txn_on, t.id`, [orgId, cardId]));
}

const txnView = (t: any, flags: string[], c: any) => ({
  id: String(t.id), cardId: String(t.card_id), card: `${c.holder_name} •••• ${c.last4}`, currency: c.currency, txnOn: t.txn_s, merchant: t.merchant, category: t.category, amount: Number(t.amount_minor),
  reference: t.reference ?? null, receipt: t.has_receipt ? { name: t.receipt_name, type: t.receipt_type } : null, status: t.status as string, note: t.note ?? null,
  reviewedBy: t.reviewed_name ?? null, reviewedAt: t.reviewed_at ? new Date(t.reviewed_at).toISOString() : null, flags,
});

/** Transactions with their flags: by card, month, status or flagged. */
export async function transactions(orgId: string, q: Record<string, unknown> = {}) {
  const month = q.month == null || q.month === '' ? null : String(q.month);
  if (month && !MONTH_RE.test(month)) throw ERR(400, 'month is YYYY-MM.');
  const cards = await outsideRequestScope(() => many<any>(`${C_SELECT} WHERE c.org_id = $1 ${q.cardId ? 'AND c.id = $2' : ''} ORDER BY c.holder_name`, q.cardId ? [orgId, String(q.cardId)] : [orgId]));
  const p = await policy(orgId);
  const out: Array<ReturnType<typeof txnView>> = [];
  for (const c of cards) {
    const ts = await cardTxns(orgId, String(c.id));
    const fl = flagsFor(ts.map((t) => ({ id: String(t.id), cardId: String(c.id), txnOn: t.txn_s, merchant: t.merchant, category: t.category, amount: Number(t.amount_minor), hasReceipt: t.has_receipt })), { singleLimit: c.single_limit_minor == null ? null : Number(c.single_limit_minor), monthlyLimit: c.monthly_limit_minor == null ? null : Number(c.monthly_limit_minor) }, p);
    for (const t of ts) out.push(txnView(t, t.status === 'open' ? fl.get(String(t.id)) ?? [] : [], c));
  }
  return out.filter((t) => (!month || t.txnOn.startsWith(month)) && (!q.status || t.status === q.status) && (q.flagged !== 'true' || t.flags.length)).sort((a, b) => b.txnOn.localeCompare(a.txnOn) || Number(b.id) - Number(a.id));
}

/** Cards with the month's spend against their limits, open and flagged transactions, statements. */
export async function overview(orgId: string, monthRaw?: unknown, now = new Date()) {
  const month = monthRaw == null || monthRaw === '' ? today(now).slice(0, 7) : String(monthRaw);
  if (!MONTH_RE.test(month)) throw ERR(400, 'month is YYYY-MM.');
  const [cards, txns, stmts, pol] = await Promise.all([
    outsideRequestScope(() => many<any>(`${C_SELECT} WHERE c.org_id = $1 ORDER BY c.status, c.holder_name`, [orgId])),
    transactions(orgId, {}),
    outsideRequestScope(() => many<any>(`SELECT s.*, to_char(s.paid_on, 'YYYY-MM-DD') AS paid_s FROM card_statement s WHERE s.org_id = $1 ORDER BY s.month DESC`, [orgId])),
    policy(orgId),
  ]);
  const list = cards.map((c) => {
    const mine = txns.filter((t) => t.cardId === String(c.id));
    const inMonth = mine.filter((t) => t.txnOn.startsWith(month));
    const spent = inMonth.reduce((a, t) => a + t.amount, 0);
    const v = cardView(c);
    return { ...v, spent, usedPct: v.monthlyLimit ? Math.round((spent / v.monthlyLimit) * 1000) / 10 : null, open: mine.filter((t) => t.status === 'open').length, flagged: mine.filter((t) => t.flags.length).length,
      owedByHolder: mine.filter((t) => t.status === 'rejected').reduce((a, t) => a + t.amount, 0) };
  });
  const statements = stmts.map((s) => {
    const c = cards.find((x) => String(x.id) === String(s.card_id));
    const txTotal = txns.filter((t) => t.cardId === String(s.card_id) && t.txnOn.startsWith(s.month)).reduce((a, t) => a + t.amount, 0);
    return { id: String(s.id), cardId: String(s.card_id), card: c ? `${c.holder_name} •••• ${c.last4}` : '', currency: c?.currency ?? null, month: s.month, total: Number(s.total_minor), transactions: txTotal, difference: Number(s.total_minor) - txTotal, paidOn: s.paid_s ?? null, cashAccountId: s.cash_account_id == null ? null : String(s.cash_account_id) };
  });
  return { month, policy: pol, cards: list, statements, open: txns.filter((t) => t.status === 'open').length, flagged: txns.filter((t) => t.flags.length).length };
}

const parseAmount = (s: string, currency: string): number | null => {
  const clean = s.replace(/[^\d.,\-]/g, '');
  if (!clean) return null;
  // "1.234.567" or "1,234,567" (thousands) with no decimals for a zero-decimal currency; else the last . or , is decimal.
  const exp = exponentOf(currency);
  let n: number;
  if (exp === 0) n = Number(clean.replace(/[.,]/g, ''));
  else { const k = Math.max(clean.lastIndexOf('.'), clean.lastIndexOf(',')); n = k < 0 ? Number(clean) : Number(clean.slice(0, k).replace(/[.,]/g, '') + '.' + clean.slice(k + 1)); }
  return Number.isFinite(n) ? Math.round(n * 10 ** exp) : null;
};

/** Import a CSV (date, merchant, amount, reference, category) for a card; lines already imported are skipped. */
export async function importCsv(orgId: string, cardId: string, csvRaw: unknown, userId: string | null) {
  const c = await cardRow(orgId, cardId);
  const text = String(csvRaw ?? '');
  if (!text.trim()) throw ERR(422, 'csv is the bank\'s export: date, merchant, amount, reference, category.');
  if (text.length > 2_000_000) throw ERR(413, 'The file is at most 2 MB.');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const split = (l: string) => { const out: string[] = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if ((ch === ',' || ch === ';') && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };
  let added = 0, skipped = 0;
  const errors: string[] = [];
  const counts = new Map<string, number>();
  for (const [k, l] of lines.entries()) {
    const [d = '', merchant = '', amt = '', reference = '', category = ''] = split(l);
    if (k === 0 && !DATE_RE.test(d)) continue; // a header
    const amount = parseAmount(amt, c.currency);
    if (!DATE_RE.test(d) || !merchant || amount == null || amount === 0) { errors.push(`line ${k + 1}: date (YYYY-MM-DD), merchant and a non-zero amount are needed`); continue; }
    const cat = (CATEGORIES as readonly string[]).includes(category.toLowerCase()) ? category.toLowerCase() : 'other';
    const base = `${d}|${merchant.toLowerCase()}|${amount}`;
    const n = (counts.get(base) ?? 0) + 1; counts.set(base, n);
    const key = reference ? `ref:${reference}` : `h:${createHash('sha1').update(`${base}|${n}`).digest('hex').slice(0, 20)}`;
    const r = await outsideRequestScope(() => one<{ id: string }>(
      `INSERT INTO card_txn (org_id, card_id, txn_on, merchant, category, amount_minor, reference, import_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (card_id, import_key) DO NOTHING RETURNING id`, [orgId, cardId, d, merchant.slice(0, 120), cat, amount, reference ? reference.slice(0, 80) : null, key, userId]));
    if (r) added++; else skipped++;
  }
  if (!added && !skipped) throw ERR(422, `Nothing imported: ${errors.slice(0, 5).join('; ')}`);
  return { added, skipped, errors };
}

export async function addTransaction(orgId: string, cardId: string, b: Record<string, unknown>, userId: string | null) {
  const c = await cardRow(orgId, cardId);
  const d = String(b.txnOn ?? ''), merchant = String(b.merchant ?? '').trim(), amount = Number(b.amount), category = String(b.category ?? 'other');
  if (!DATE_RE.test(d)) throw ERR(422, 'txnOn is a day (YYYY-MM-DD).');
  if (!merchant) throw ERR(422, 'merchant is required.');
  if (!Number.isSafeInteger(amount) || amount === 0) throw ERR(422, 'amount is a non-zero amount in minor units (a refund negative).');
  if (!(CATEGORIES as readonly string[]).includes(category)) throw ERR(422, `category is one of ${CATEGORIES.join(', ')}.`);
  await assertOpen(orgId, d.slice(0, 7), 'A card transaction', ERR);
  const r = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO card_txn (org_id, card_id, txn_on, merchant, category, amount_minor, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [orgId, cardId, d, merchant.slice(0, 120), category, amount, b.reference == null || b.reference === '' ? null : String(b.reference).slice(0, 80), userId]));
  return (await transactions(orgId, { cardId: String(c.id) })).find((t) => t.id === String(r!.id))!;
}

async function txnRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw ERR(404, 'No such transaction.');
  const t = await outsideRequestScope(() => one<any>(`SELECT t.*, to_char(t.txn_on, 'YYYY-MM') AS m FROM card_txn t WHERE t.id = $1 AND t.org_id = $2`, [id, orgId]));
  if (!t) throw ERR(404, 'No such transaction.');
  return t;
}

export async function addReceipt(orgId: string, id: string, b: Record<string, unknown>) {
  const t = await txnRow(orgId, id);
  if (t.status !== 'open') throw ERR(409, `The transaction is ${t.status}.`);
  const mime = String(b.mime ?? '');
  if (!(MIMES as readonly string[]).includes(mime)) throw ERR(422, `mime is one of ${MIMES.join(', ')}.`);
  const data = Buffer.from(String(b.data ?? ''), 'base64');
  if (!data.length) throw ERR(422, 'data is the file, base64.');
  if (data.length > MAX_RECEIPT) throw ERR(413, 'A receipt is at most 3 MB.');
  const sniff = data.subarray(0, 4).toString('hex');
  const ok = (mime === 'image/jpeg' && sniff.startsWith('ffd8')) || (mime === 'image/png' && sniff === '89504e47') || (mime === 'application/pdf' && sniff === '25504446')
    || (mime === 'image/webp' && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP');
  if (!ok) throw ERR(422, 'The file is not the type it says.');
  const name = String(b.filename ?? 'receipt').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'receipt';
  await outsideRequestScope(() => query(`UPDATE card_txn SET receipt_name = $3, receipt_type = $4, receipt_data = $5 WHERE id = $1 AND org_id = $2`, [id, orgId, name, mime, data]));
  return { id, receipt: { name, type: mime } };
}

export async function receipt(orgId: string, id: string) {
  const t = await txnRow(orgId, id);
  if (!t.receipt_data) throw ERR(404, 'No receipt.');
  return { name: t.receipt_name as string, type: t.receipt_type as string, data: t.receipt_data as Buffer };
}

/** Approve or reject (personal) a transaction; the category and a note may change with it. */
export async function review(orgId: string, id: string, b: Record<string, unknown>, who: { userId: string | null; canApprove: boolean }) {
  const t = await txnRow(orgId, id);
  if (t.status !== 'open') throw ERR(409, `The transaction is ${t.status}.`);
  const c = await cardRow(orgId, String(t.card_id));
  if (who.userId && c.holder_id === who.userId) throw ERR(403, 'Spending on your own card is reviewed by someone else.');
  const action = String(b.action ?? '');
  const category = b.category == null || b.category === '' ? t.category : String(b.category);
  if (!(CATEGORIES as readonly string[]).includes(category)) throw ERR(422, `category is one of ${CATEGORIES.join(', ')}.`);
  const note = b.note == null ? null : String(b.note).trim().slice(0, 300) || null;
  await assertOpen(orgId, t.m, 'A card transaction', ERR);
  if (action === 'approve') {
    const flags = (await transactions(orgId, { cardId: String(c.id) })).find((x) => x.id === id)?.flags ?? [];
    if (flags.length && !who.canApprove) throw ERR(403, `Flagged (${flags.join(', ')}): a Finance Manager (finance:approve) approves it.`);
    if (flags.length && !note) throw ERR(422, 'A flagged transaction is approved with a note.');
  } else if (action === 'reject') {
    if (!note) throw ERR(422, 'A rejection (personal spending, owed back) needs a note.');
  } else throw ERR(422, 'action is approve or reject.');
  await outsideRequestScope(() => query(`UPDATE card_txn SET status = $3, category = $4, note = $5, reviewed_by = $6, reviewed_at = now() WHERE id = $1 AND org_id = $2`,
    [id, orgId, action === 'approve' ? 'approved' : 'rejected', category, note, who.userId]));
  return (await transactions(orgId, { cardId: String(c.id) })).find((x) => x.id === id)!;
}

/** Record (or update) a card's monthly statement total and its payment. */
export async function saveStatement(orgId: string, cardId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const c = await cardRow(orgId, cardId);
  const month = String(b.month ?? ''), total = Number(b.total);
  if (!MONTH_RE.test(month)) throw ERR(422, 'month is YYYY-MM.');
  if (!Number.isSafeInteger(total)) throw ERR(422, 'total is the statement\'s total in minor units.');
  const paidOn = b.paidOn == null || b.paidOn === '' ? null : String(b.paidOn);
  if (paidOn && (!DATE_RE.test(paidOn) || paidOn > today(now))) throw ERR(422, 'paidOn is a day, not in the future.');
  const acct = b.cashAccountId == null || b.cashAccountId === '' ? (c.cash_account_id == null ? null : String(c.cash_account_id)) : String(b.cashAccountId);
  if (paidOn && !acct) throw ERR(422, 'A paid statement names the account it was paid from (cashAccountId, or the card\'s).');
  if (acct) {
    const a = /^\d{1,18}$/.test(acct) ? await outsideRequestScope(() => one<{ currency: string }>(`SELECT currency FROM cash_account WHERE id = $1 AND org_id = $2`, [acct, orgId])) : null;
    if (!a || a.currency !== c.currency) throw ERR(422, 'cashAccountId is one of your accounts in the card\'s currency.');
  }
  if (paidOn) await assertOpen(orgId, paidOn.slice(0, 7), 'A card statement payment', ERR);
  await outsideRequestScope(() => query(
    `INSERT INTO card_statement (org_id, card_id, month, total_minor, paid_on, cash_account_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (card_id, month) DO UPDATE SET total_minor = EXCLUDED.total_minor, paid_on = EXCLUDED.paid_on, cash_account_id = EXCLUDED.cash_account_id`, [orgId, cardId, month, total, paidOn, paidOn ? acct : null, userId]));
  return (await overview(orgId, month, now)).statements.find((s) => s.cardId === cardId && s.month === month)!;
}

/** The ledger's cards journal for a month. */
export async function journal(orgId: string, month: string) {
  const out: Record<string, Array<{ account: string; debit: number; credit: number; description: string }>> = {};
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT t.category, t.status, t.amount_minor, c.currency, c.holder_name, c.last4 FROM card_txn t JOIN corp_card c ON c.id = t.card_id WHERE t.org_id = $1 AND to_char(t.txn_on, 'YYYY-MM') = $2`, [orgId, month]));
  const agg = new Map<string, { currency: string; account: string; amount: number; label: string }>();
  for (const t of rows) {
    const account = t.status === 'rejected' ? '1480' : accountFor(t.category);
    const k = `${t.currency}|${account}|${t.last4}`;
    const a = agg.get(k) ?? { currency: t.currency, account, amount: 0, label: `Card ${t.holder_name} •••• ${t.last4}${t.status === 'rejected' ? ', personal' : ''}` };
    a.amount += Number(t.amount_minor); agg.set(k, a);
  }
  for (const a of agg.values()) {
    if (!a.amount) continue;
    const L = (out[a.currency] ??= []);
    if (a.amount > 0) L.push({ account: a.account, debit: a.amount, credit: 0, description: a.label }, { account: '2165', debit: 0, credit: a.amount, description: a.label });
    else L.push({ account: '2165', debit: -a.amount, credit: 0, description: `${a.label}, refunds` }, { account: a.account, debit: 0, credit: -a.amount, description: `${a.label}, refunds` });
  }
  const paid = await outsideRequestScope(() => many<any>(
    `SELECT s.total_minor, s.month, c.currency, c.last4, a.kind FROM card_statement s JOIN corp_card c ON c.id = s.card_id LEFT JOIN cash_account a ON a.id = s.cash_account_id
      WHERE s.org_id = $1 AND s.paid_on IS NOT NULL AND to_char(s.paid_on, 'YYYY-MM') = $2`, [orgId, month]));
  for (const s of paid) {
    const amt = Number(s.total_minor);
    if (!amt) continue;
    const L = (out[s.currency] ??= []), d = `Card •••• ${s.last4} statement ${s.month} paid`, bank = s.kind === 'cash' ? '1050' : '1100';
    if (amt > 0) L.push({ account: '2165', debit: amt, credit: 0, description: d }, { account: bank, debit: 0, credit: amt, description: d });
    else L.push({ account: bank, debit: -amt, credit: 0, description: d }, { account: '2165', debit: 0, credit: -amt, description: d });
  }
  return out;
}

export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(`SELECT cash_account_id::text AS a, to_char(paid_on, 'YYYY-MM-DD') AS d, total_minor FROM card_statement WHERE org_id = $1 AND paid_on IS NOT NULL AND cash_account_id IS NOT NULL AND paid_on <= $2::date`, [orgId, upTo]));
  return rows.map((x) => ({ account_id: x.a as string, d: x.d as string, amount: -Number(x.total_minor) }));
}

export async function transactionsXlsx(orgId: string, q: Record<string, unknown> = {}): Promise<Buffer> {
  const ts = await transactions(orgId, q);
  return xlsx([{ name: 'Card transactions', rows: [['Date', 'Card', 'Merchant', 'Category', 'Currency', 'Amount', 'Reference', 'Receipt', 'Status', 'Flags', 'Note', 'Reviewed by'],
    ...ts.map((t) => [t.txnOn, t.card, t.merchant, t.category, t.currency, t.amount, t.reference ?? '', t.receipt ? 'yes' : '', t.status, t.flags.join(', '), t.note ?? '', t.reviewedBy ?? ''])],
    widths: [11, 24, 28, 10, 8, 14, 16, 8, 10, 30, 30, 16], formats: [null, null, null, null, null, 'money', null, null, null, null, null, null] }]);
}
