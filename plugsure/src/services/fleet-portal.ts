import { one, many, query } from '../db/pool.js';
import { config } from '../config.js';
import type { Principal } from './authz.js';
import { FleetBillingError, balanceOf, fmtDate, todayLocal } from './fleet-billing.js';
import { currentPeriod } from './commission.js';

/**
 * The fleet customer portal: what a company billed for fleet cards sees of its
 * own account. Every function takes the account id the route has already checked
 * with `portalAccount` and filters by it (and the organisation) in SQL.
 *
 * Shown: invoices (not voided ones) with what is still owed, credit notes,
 * this month's charging so far, and the cards with their use this month. The
 * only thing a customer can change is blocking a lost card, and unblocking a
 * card it blocked itself.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fleet account this principal may see through the portal, or 404 (never 403: other accounts do not exist for it). */
export function portalAccount(p: Principal, accountId: string): string {
  const ok = UUID_RE.test(String(accountId))
    && (p.fleetAccountIds ?? []).includes(accountId)
    && p.assignments.some((a) => a.scopeType === 'fleet' && a.scopeId === accountId && a.permissions.includes('fleet:portal'));
  if (!ok) throw new FleetBillingError(404, 'fleet account not found');
  return accountId;
}

export async function overview(orgId: string, accountIds: string[]) {
  const period = currentPeriod();
  const rows = await many<any>(
    `SELECT a.id, a.name, a.legal_name, a.billing_email, a.payment_terms_days,
            (SELECT count(*)::int FROM token t WHERE t.fleet_account_id = a.id) AS cards,
            (SELECT count(*)::int FROM token t WHERE t.fleet_account_id = a.id AND t.status = 'Blocked') AS blocked_cards
       FROM fleet_account a WHERE a.org_id = $1 AND a.id = ANY($2::uuid[]) AND a.archived_at IS NULL ORDER BY a.name`,
    [orgId, accountIds],
  );
  const today = todayLocal();
  const out = [];
  for (const a of rows) {
    const open = await many<any>(
      `SELECT status, total_idr, credited_idr, prior_credit_idr, due_date FROM fleet_invoice WHERE fleet_account_id = $1 AND org_id = $2 AND status = 'issued'`,
      [a.id, orgId]);
    const credit = await one<{ n: number; total: string }>(
      `SELECT count(*)::int AS n, COALESCE(sum(total_idr), 0) AS total FROM fleet_credit_note
        WHERE fleet_account_id = $1 AND org_id = $2 AND status = 'issued' AND settlement = 'next_invoice' AND applied_invoice_id IS NULL`, [a.id, orgId]);
    out.push({
      id: a.id, name: a.name, legalName: a.legal_name, billingEmail: a.billing_email, paymentTermsDays: a.payment_terms_days,
      cards: a.cards, blockedCards: a.blocked_cards,
      outstandingIdr: open.reduce((s, i) => s + balanceOf(i), 0),
      overdueInvoices: open.filter((i) => balanceOf(i) > 0 && fmtDate(i.due_date) < today).length,
      creditToComeIdr: Number(credit?.total ?? 0),
      period,
    });
  }
  return { accounts: out };
}

export async function invoicesOf(orgId: string, accountId: string) {
  const today = todayLocal();
  const invoices = await many<any>(
    `SELECT id, number, to_char(period, 'YYYY-MM') AS period, status, issued_at, due_date, sessions, energy_wh, ppn_idr, total_idr,
            credited_idr, prior_credit_idr, paid_at, efaktur_number
       FROM fleet_invoice WHERE org_id = $1 AND fleet_account_id = $2 AND status <> 'void' ORDER BY period DESC, issued_at DESC LIMIT 120`,
    [orgId, accountId]);
  const creditNotes = await many<any>(
    `SELECT c.id, c.number, c.settlement, c.reason, c.total_idr, c.ppn_idr, c.issued_at, c.refunded_at, i.number AS invoice_number, ai.number AS applied_invoice
       FROM fleet_credit_note c JOIN fleet_invoice i ON i.id = c.invoice_id LEFT JOIN fleet_invoice ai ON ai.id = c.applied_invoice_id
      WHERE c.org_id = $1 AND c.fleet_account_id = $2 AND c.status = 'issued' ORDER BY c.issued_at DESC LIMIT 120`,
    [orgId, accountId]);
  return {
    invoices: invoices.map((i) => ({
      id: i.id, number: i.number, period: i.period, status: i.status, issuedAt: i.issued_at, dueDate: fmtDate(i.due_date),
      sessions: i.sessions, energyWh: Number(i.energy_wh), ppnIdr: Number(i.ppn_idr), totalIdr: Number(i.total_idr),
      creditedIdr: Number(i.credited_idr) + Number(i.prior_credit_idr), balanceIdr: balanceOf(i),
      paidAt: i.paid_at ? fmtDate(i.paid_at) : null, efakturNumber: i.efaktur_number,
      overdue: i.status === 'issued' && balanceOf(i) > 0 && fmtDate(i.due_date) < today,
    })),
    creditNotes: creditNotes.map((c) => ({
      id: c.id, number: c.number, invoiceNumber: c.invoice_number, settlement: c.settlement, reason: c.reason, totalIdr: Number(c.total_idr),
      ppnIdr: Number(c.ppn_idr), issuedAt: c.issued_at, refundedAt: c.refunded_at ? fmtDate(c.refunded_at) : null, appliedInvoice: c.applied_invoice,
    })),
  };
}

/** An invoice or credit note id, only if it belongs to this account (and is not void). */
export async function ownInvoice(orgId: string, accountId: string, id: string): Promise<string> {
  const r = UUID_RE.test(String(id))
    ? await one(`SELECT id FROM fleet_invoice WHERE id = $1 AND org_id = $2 AND fleet_account_id = $3 AND status <> 'void'`, [id, orgId, accountId]) : null;
  if (!r) throw new FleetBillingError(404, 'invoice not found');
  return id;
}
export async function ownCreditNote(orgId: string, accountId: string, id: string): Promise<string> {
  const r = UUID_RE.test(String(id))
    ? await one(`SELECT id FROM fleet_credit_note WHERE id = $1 AND org_id = $2 AND fleet_account_id = $3 AND status = 'issued'`, [id, orgId, accountId]) : null;
  if (!r) throw new FleetBillingError(404, 'credit note not found');
  return id;
}

/** The statement a customer sees: the operator's own notes to itself (warnings) left out. */
export function forCustomer(st: any) {
  const { warnings: _w, ...rest } = st;
  return rest;
}

export async function cardsOf(orgId: string, accountId: string) {
  const rows = await many<any>(
    `SELECT t.id, t.uid, t.holder_name, t.status, t.customer_blocked_at, t.valid_to,
            m.sessions, m.energy_wh, m.total_idr, m.last_used
       FROM token t
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS sessions, COALESCE(sum(cs.energy_wh), 0)::bigint AS energy_wh, COALESCE(sum(d.total_idr), 0)::bigint AS total_idr,
                max(cs.started_at) AS last_used
           FROM charging_session cs LEFT JOIN cdr d ON d.session_id = cs.id
          WHERE cs.token_id = t.id AND cs.started_at >= date_trunc('month', now() AT TIME ZONE $3) AT TIME ZONE $3
       ) m ON true
      WHERE t.org_id = $1 AND t.fleet_account_id = $2
      ORDER BY t.holder_name NULLS LAST, t.uid`,
    [orgId, accountId, config.billing.timeZone]);
  return rows.map((r) => ({
    id: r.id, uid: r.uid, holder: r.holder_name, status: r.status, validTo: r.valid_to,
    blockedByYou: r.status === 'Blocked' && !!r.customer_blocked_at,
    canBlock: r.status === 'Accepted', canUnblock: r.status === 'Blocked' && !!r.customer_blocked_at,
    thisMonth: { sessions: r.sessions ?? 0, energyWh: Number(r.energy_wh ?? 0), totalIdr: Number(r.total_idr ?? 0) },
    lastUsed: r.last_used,
  }));
}

/** Block a lost card, or unblock one this customer blocked. Returns the card's previous status. */
export async function setCardBlocked(orgId: string, accountId: string, tokenId: string, blocked: boolean) {
  const t = UUID_RE.test(String(tokenId))
    ? await one<{ status: string; customer_blocked_at: Date | null; uid: string }>(
        `SELECT status, customer_blocked_at, uid FROM token WHERE id = $1 AND org_id = $2 AND fleet_account_id = $3`, [tokenId, orgId, accountId])
    : null;
  if (!t) throw new FleetBillingError(404, 'card not found');
  if (blocked) {
    if (t.status === 'Blocked') throw new FleetBillingError(409, 'The card is already blocked.');
    if (t.status !== 'Accepted') throw new FleetBillingError(409, `The card is ${t.status.toLowerCase()}; ask your charging operator.`);
    await query(`UPDATE token SET status = 'Blocked', customer_blocked_at = now(), updated_at = now() WHERE id = $1`, [tokenId]);
  } else {
    if (t.status !== 'Blocked') throw new FleetBillingError(409, 'The card is not blocked.');
    if (!t.customer_blocked_at) throw new FleetBillingError(409, 'Your charging operator blocked this card; ask them to unblock it.');
    await query(`UPDATE token SET status = 'Accepted', customer_blocked_at = NULL, updated_at = now() WHERE id = $1`, [tokenId]);
  }
  return { uid: t.uid, previous: t.status, status: blocked ? 'Blocked' : 'Accepted' };
}

export const thisPeriod = () => currentPeriod();
