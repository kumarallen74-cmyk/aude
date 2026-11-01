import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { markPaid } from './fleet-billing.js';
import { moneyText, currencyOr } from '../domain/money.js';

/**
 * Fleet credit limits and prepay (v1.24.0). Per fleet account (Fleet billing → Accounts → Credit):
 *
 *   none      as before: charging is invoiced monthly, nothing is checked
 *   credit    a credit limit: what the account owes — its invoices not paid and its charging not invoiced yet — against
 *             the limit
 *   prepaid   a deposit: top-ups recorded by the operator, from which issued invoices are paid (automatically, or by
 *             hand); the deposit left, less what is owed and not yet paid from it, is what the account can still use
 *
 * Every hour (and after a top-up, a payment from the deposit or a change): a warning at 80% of the limit (or deposit)
 * used and a critical alert at 100% (fleet.credit_limit, once per level until it falls back); with blocking on, the
 * account's cards are blocked while it is over (token status Blocked, marked credit_blocked_at) and unblocked when it
 * is back under — only the cards blocked for credit; a card the customer or the operator blocked stays blocked.
 *
 * Amounts in the account's credit currency; charging in other currencies is not counted.
 */

export class CreditError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND = 'fleet.credit_limit';
const zone = () => config.billing.timeZone;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date());

async function accountOf(orgId: string, id: string) {
  if (!UUID_RE.test(id)) throw new CreditError(404, 'No such fleet account.');
  const a = await outsideRequestScope(() => one<any>(`SELECT * FROM fleet_account WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!a) throw new CreditError(404, 'No such fleet account.');
  return a;
}

/** Where an account stands: owed (invoices open + charging not invoiced), deposit, available, used %. */
export async function position(orgId: string, accountId: string) {
  const a = await accountOf(orgId, accountId);
  const cur = a.credit_currency as string;
  const [inv, unbilled, dep, cards, entries] = await Promise.all([
    outsideRequestScope(() => one<{ open: string; n: number }>(
      `SELECT COALESCE(sum(GREATEST(0, total_minor - COALESCE(credited_minor, 0) - COALESCE(prior_credit_minor, 0))), 0)::bigint AS open, count(*)::int AS n
         FROM fleet_invoice WHERE org_id = $1 AND fleet_account_id = $2 AND status = 'issued' AND currency = $3`, [orgId, accountId, cur])),
    outsideRequestScope(() => one<{ amount: string; n: number }>(
      `SELECT COALESCE(sum(d.total_minor), 0)::bigint AS amount, count(*)::int AS n FROM cdr d JOIN charging_session cs ON cs.id = d.session_id
        WHERE d.org_id = $1 AND cs.fleet_account_id = $2 AND d.currency = $3 AND COALESCE(cs.payment_mode, '') <> 'prepurchase'
          AND NOT EXISTS (SELECT 1 FROM fleet_invoice_item i WHERE i.kind = 'session' AND i.ref_id = cs.id)`, [orgId, accountId, cur])),
    outsideRequestScope(() => one<{ bal: string }>(`SELECT COALESCE(sum(amount_minor), 0)::bigint AS bal FROM fleet_prepay_entry WHERE fleet_account_id = $1 AND currency = $2`, [accountId, cur])),
    outsideRequestScope(() => one<{ total: number; blocked: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE credit_blocked_at IS NOT NULL AND status = 'Blocked')::int AS blocked FROM token WHERE fleet_account_id = $1`, [accountId])),
    outsideRequestScope(() => many<any>(
      `SELECT e.*, i.number AS invoice_number, u.name AS by_name FROM fleet_prepay_entry e LEFT JOIN fleet_invoice i ON i.id = e.invoice_id LEFT JOIN app_user u ON u.id = e.created_by
        WHERE e.fleet_account_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 50`, [accountId])),
  ]);
  const openInvoices = Number(inv?.open ?? 0), notInvoiced = Number(unbilled?.amount ?? 0), deposit = Number(dep?.bal ?? 0);
  const owed = openInvoices + notInvoiced;
  const limit = a.credit_mode === 'credit' ? Number(a.credit_limit_minor) : 0;
  const room = a.credit_mode === 'none' ? null : limit + deposit;
  const available = room == null ? null : room - owed;
  const usedPct = room == null ? null : room > 0 ? Math.round((owed / room) * 1000) / 10 : owed > 0 ? 100 : 0;
  return {
    accountId, account: a.name, mode: a.credit_mode as 'none' | 'credit' | 'prepaid', currency: cur, limit, block: a.credit_block, autoApply: a.credit_auto_apply,
    openInvoices, openInvoiceCount: inv?.n ?? 0, notInvoiced, notInvoicedSessions: unbilled?.n ?? 0, deposit, owed, available, usedPct,
    over: available != null && (available < 0 || (a.credit_mode === 'prepaid' && available <= 0 && owed > 0)),
    cards: { total: cards?.total ?? 0, blockedForCredit: cards?.blocked ?? 0 },
    // (v1.33.0) A credit hold from a review blocks the cards whatever the mode.
    hold: a.credit_hold_at ? { at: new Date(a.credit_hold_at).toISOString(), reason: a.credit_hold_reason ?? null } : null,
    entries: entries.map((e) => ({ id: String(e.id), kind: e.kind, amount: Number(e.amount_minor), currency: e.currency, invoice: e.invoice_number ?? null, reference: e.reference ?? null, note: e.note ?? null, by: e.by_name ?? null, at: new Date(e.created_at).toISOString() })),
  };
}

export async function saveSettings(orgId: string, accountId: string, b: Record<string, unknown>) {
  const a = await accountOf(orgId, accountId);
  const mode = b.mode == null ? a.credit_mode : String(b.mode);
  if (!['none', 'credit', 'prepaid'].includes(mode)) throw new CreditError(422, 'mode is none, credit or prepaid.');
  const limit = b.limit == null || b.limit === '' ? Number(a.credit_limit_minor) : Number(b.limit);
  if (!Number.isInteger(limit) || limit < 0) throw new CreditError(422, 'The limit is a whole number of the minor unit, 0 or more.');
  if (mode === 'credit' && limit <= 0) throw new CreditError(422, 'Set the credit limit (above 0).');
  const currency = b.currency == null || b.currency === '' ? a.credit_currency : String(b.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new CreditError(422, 'currency is an ISO code.');
  const hasDeposit = await outsideRequestScope(() => one(`SELECT 1 FROM fleet_prepay_entry WHERE fleet_account_id = $1 AND currency <> $2 LIMIT 1`, [accountId, currency]));
  if (hasDeposit) throw new CreditError(409, 'The account has a deposit in another currency: keep that currency.');
  await outsideRequestScope(() => query(
    `UPDATE fleet_account SET credit_mode = $3, credit_limit_minor = $4, credit_currency = $5, credit_block = $6, credit_auto_apply = $7, updated_at = now() WHERE id = $1 AND org_id = $2`,
    [accountId, orgId, mode, limit, currency, b.block === undefined ? a.credit_block : b.block === true, b.autoApply === undefined ? a.credit_auto_apply : b.autoApply === true]));
  await check(orgId, accountId);
  return position(orgId, accountId);
}

export async function topUp(orgId: string, accountId: string, b: Record<string, unknown>, userId: string | null) {
  const a = await accountOf(orgId, accountId);
  if (a.credit_mode !== 'prepaid') throw new CreditError(409, 'Top-ups are for prepaid accounts: set the account to prepaid first.');
  const amount = Number(b.amount);
  const kind = b.kind === 'adjustment' ? 'adjustment' : 'topup';
  if (!Number.isInteger(amount) || amount === 0 || (kind === 'topup' && amount < 0)) throw new CreditError(422, kind === 'topup' ? 'The top-up is a whole number of the minor unit, above 0.' : 'The adjustment is a whole number, not 0.');
  const reference = b.reference == null || b.reference === '' ? null : String(b.reference).slice(0, 120);
  if (kind === 'topup' && !reference) throw new CreditError(422, 'Give the payment\'s reference (the bank transfer).');
  if (kind === 'adjustment' && (b.note == null || String(b.note).trim().length < 3)) throw new CreditError(422, 'Say why the deposit is adjusted.');
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO fleet_prepay_entry (org_id, fleet_account_id, kind, amount_minor, currency, reference, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [orgId, accountId, kind, amount, a.credit_currency, reference, b.note == null || b.note === '' ? null : String(b.note).slice(0, 300), userId]));
  await check(orgId, accountId);
  return { id: String(r!.id), kind, amount, currency: a.credit_currency };
}

/** Pay an issued invoice of a prepaid account from its deposit (the whole balance; only when the deposit covers it). */
export async function payFromDeposit(orgId: string, invoiceId: string, userId: string | null) {
  if (!UUID_RE.test(invoiceId)) throw new CreditError(404, 'No such invoice.');
  const inv = await outsideRequestScope(() => one<any>(`SELECT * FROM fleet_invoice WHERE id = $1 AND org_id = $2`, [invoiceId, orgId]));
  if (!inv) throw new CreditError(404, 'No such invoice.');
  if (inv.status !== 'issued') throw new CreditError(409, `The invoice is ${inv.status}.`);
  const a = await accountOf(orgId, inv.fleet_account_id);
  if (a.credit_mode !== 'prepaid') throw new CreditError(409, 'The account is not prepaid.');
  if (inv.currency !== a.credit_currency) throw new CreditError(409, `The deposit is in ${a.credit_currency}, the invoice in ${inv.currency}.`);
  const due = Math.max(0, Number(inv.total_minor) - Number(inv.credited_minor ?? 0) - Number(inv.prior_credit_minor ?? 0));
  const bal = Number((await outsideRequestScope(() => one<{ b: string }>(`SELECT COALESCE(sum(amount_minor), 0)::bigint AS b FROM fleet_prepay_entry WHERE fleet_account_id = $1 AND currency = $2`, [a.id, a.credit_currency])))?.b ?? 0);
  if (bal < due) throw new CreditError(409, `The deposit (${moneyText(bal, currencyOr(a.credit_currency))}) does not cover ${moneyText(due, currencyOr(a.credit_currency))}: top it up first.`);
  try {
    await outsideRequestScope(() => query(
      `INSERT INTO fleet_prepay_entry (org_id, fleet_account_id, kind, amount_minor, currency, invoice_id, reference, created_by) VALUES ($1, $2, 'invoice', $3, $4, $5, $6, $7)`,
      [orgId, a.id, -due, a.credit_currency, invoiceId, inv.number, userId]));
  } catch (e) {
    if ((e as any).code === '23505') throw new CreditError(409, 'This invoice was already paid from the deposit.');
    throw e;
  }
  await outsideRequestScope(() => markPaid(orgId, invoiceId, { paidAt: today(), reference: 'Prepaid deposit' }));
  return { invoiceId, number: inv.number, paid: due, depositLeft: bal - due };
}

/** Warnings, blocking and unblocking for one account (and paying its invoices from the deposit when automatic). */
export async function check(orgId: string, accountId: string): Promise<{ level: number; blocked: number; unblocked: number; applied: number }> {
  let applied = 0;
  const a = await accountOf(orgId, accountId);
  if (a.credit_mode === 'prepaid' && a.credit_auto_apply) {
    const open = await outsideRequestScope(() => many<{ id: string }>(
      `SELECT id FROM fleet_invoice WHERE org_id = $1 AND fleet_account_id = $2 AND status = 'issued' AND currency = $3 ORDER BY issued_at, id`, [orgId, accountId, a.credit_currency]));
    for (const i of open) {
      try { await payFromDeposit(orgId, i.id, null); applied++; } catch (e) { if (!(e instanceof CreditError)) throw e; break; }
    }
  }
  const p = await position(orgId, accountId);
  const level = p.mode === 'none' || p.usedPct == null ? 0 : p.over || p.usedPct >= 100 ? 100 : p.usedPct >= 80 ? 80 : 0;
  const prev = await outsideRequestScope(() => one<{ level: number }>(`SELECT level FROM fleet_credit_alert WHERE fleet_account_id = $1`, [accountId]));
  if (level !== (prev?.level ?? 0)) {
    await outsideRequestScope(() => query(
      `INSERT INTO fleet_credit_alert (fleet_account_id, org_id, level) VALUES ($1, $2, $3) ON CONFLICT (fleet_account_id) DO UPDATE SET level = EXCLUDED.level, updated_at = now()`, [accountId, orgId, level]));
    if (level) {
      const m = (n: number) => moneyText(n, currencyOr(p.currency));
      await outsideRequestScope(() => persistAlert({ orgId, kind: KIND, severity: level >= 100 ? 'critical' : 'warning', targetType: 'fleet_account', targetId: accountId,
        message: `${p.account}: ${p.mode === 'prepaid' ? `owes ${m(p.owed)} against a deposit of ${m(p.deposit)}` : `owes ${m(p.owed)} of a ${m(p.limit)} limit`} (${p.usedPct}%)${level >= 100 && p.block ? '; its cards are blocked until it is back under' : ''}. Fleet billing → Accounts → Credit.` })).catch(() => null);
    } else await outsideRequestScope(() => resolveAlertsFor(orgId, KIND, 'fleet_account', accountId)).catch(() => 0);
  }
  let blocked = 0, unblocked = 0;
  if ((p.mode !== 'none' && p.block && p.over) || p.hold) {
    blocked = (await outsideRequestScope(() => query(
      `UPDATE token SET status = 'Blocked', credit_blocked_at = now(), updated_at = now() WHERE fleet_account_id = $1 AND org_id = $2 AND status = 'Accepted'`, [accountId, orgId]))).rowCount ?? 0;
  } else {
    unblocked = (await outsideRequestScope(() => query(
      `UPDATE token SET status = 'Accepted', credit_blocked_at = NULL, updated_at = now() WHERE fleet_account_id = $1 AND org_id = $2 AND credit_blocked_at IS NOT NULL AND status = 'Blocked'`, [accountId, orgId]))).rowCount ?? 0;
  }
  // A card re-enabled by hand meanwhile no longer counts as blocked for credit.
  await outsideRequestScope(() => query(`UPDATE token SET credit_blocked_at = NULL WHERE fleet_account_id = $1 AND credit_blocked_at IS NOT NULL AND status <> 'Blocked'`, [accountId]));
  if (blocked || unblocked) logger.info({ accountId, blocked, unblocked }, 'fleet credit: cards blocked / unblocked');
  return { level, blocked, unblocked, applied };
}

/** The worker: every account with a credit mode, or cards still blocked for credit. */
export async function sweep(): Promise<number> {
  const accts = await outsideRequestScope(() => many<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM fleet_account a WHERE archived_at IS NULL AND (credit_mode <> 'none' OR credit_hold_at IS NOT NULL OR EXISTS (SELECT 1 FROM token t WHERE t.fleet_account_id = a.id AND t.credit_blocked_at IS NOT NULL))`));
  let n = 0;
  for (const a of accts) {
    try { const r = await check(a.org_id, a.id); n += r.blocked + r.unblocked + r.applied; } catch (e) { logger.warn({ account: a.id, err: (e as Error).message }, 'fleet credit check failed'); }
  }
  return n;
}

/** Every account with a credit mode, for the console's overview. */
export async function overview(orgId: string) {
  const accts = await outsideRequestScope(() => many<{ id: string }>(`SELECT id FROM fleet_account WHERE org_id = $1 AND archived_at IS NULL AND credit_mode <> 'none' ORDER BY name`, [orgId]));
  const out = [];
  for (const a of accts) { const p = await position(orgId, a.id); const { entries: _e, ...rest } = p; out.push(rest); }
  return { accounts: out };
}
