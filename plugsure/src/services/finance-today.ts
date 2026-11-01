import { many, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { summary } from './finance-summary.js';

/**
 * Finance today (v1.26.0): what a finance person needs on the phone. Today's and the month's revenue, cash, what is
 * owed and overdue, and everything waiting for an approval — each with whether the person asking may decide it
 * (not the person who asked for it, not the first approver again). Decisions use the existing routes, so the
 * approvals matrix and two-person rules apply unchanged.
 */

const zone = () => config.billing.timeZone;

export interface Approval {
  kind: 'payout_transfer' | 'refund_transfer' | 'write_off' | 'bank_change' | 'driver_refund';
  id: string; title: string; detail: string; amount: number | null; currency: string | null; at: string;
  requestedBy: string | null; firstApprovedBy: string | null; mine: boolean; canDecide: boolean;
  approve: string; reject: string; automatic?: boolean;
}

export async function today(orgId: string, userId: string | null, now = new Date()) {
  const z = zone();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: z }).format(now);
  const [sum, rev, payouts, refunds, writeOffs, bank, driver] = await Promise.all([
    summary(orgId, now),
    outsideRequestScope(() => many<any>(
      `SELECT d.currency, COALESCE(sum(d.subtotal_minor), 0)::bigint AS revenue, count(*)::int AS sessions, COALESCE(sum(cs.energy_wh), 0)::bigint AS wh
         FROM cdr d JOIN charging_session cs ON cs.id = d.session_id
        WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND (d.issued_at AT TIME ZONE $3)::date = $2::date GROUP BY 1`, [orgId, day, z])),
    outsideRequestScope(() => many<any>(
      `SELECT t.id, t.amount_minor, t.currency, t.requested_at, t.requested_by, t.first_approved_by, t.automatic, s.number, COALESCE(w.legal_name, w.name) AS owner,
              a.name AS req_name, f.name AS first_name
         FROM payout_transfer t LEFT JOIN commission_statement s ON s.id = t.statement_id LEFT JOIN site_owner w ON w.id = t.owner_id
         LEFT JOIN app_user a ON a.id = t.requested_by LEFT JOIN app_user f ON f.id = t.first_approved_by
        WHERE t.org_id = $1 AND t.state = 'awaiting_approval' ORDER BY t.requested_at`, [orgId])),
    outsideRequestScope(() => many<any>(
      `SELECT t.id, t.amount_minor, t.currency, t.requested_at, t.requested_by, t.first_approved_by, t.holder_name, a.name AS req_name, f.name AS first_name
         FROM refund_transfer t LEFT JOIN app_user a ON a.id = t.requested_by LEFT JOIN app_user f ON f.id = t.first_approved_by
        WHERE t.org_id = $1 AND t.state = 'awaiting_approval' ORDER BY t.requested_at`, [orgId])),
    outsideRequestScope(() => many<any>(
      `SELECT w.id, w.kind, w.ref, w.amount_minor, w.currency, w.reason, w.requested_at, w.requested_by, w.first_approved_by, a.name AS req_name, f.name AS first_name
         FROM receivable_write_off w LEFT JOIN app_user a ON a.id = w.requested_by LEFT JOIN app_user f ON f.id = w.first_approved_by
        WHERE w.org_id = $1 AND w.state = 'pending' ORDER BY w.requested_at`, [orgId])),
    outsideRequestScope(() => many<any>(
      `SELECT c.id, c.requested_at, c.requested_by, c.first_approved_by, c.bank_name, c.account_last4, COALESCE(w.legal_name, w.name) AS owner, a.name AS req_name, f.name AS first_name
         FROM owner_bank_change_request c JOIN site_owner w ON w.id = c.owner_id
         LEFT JOIN app_user a ON a.id = c.requested_by LEFT JOIN app_user f ON f.id = c.first_approved_by
        WHERE c.org_id = $1 AND c.state = 'pending' ORDER BY c.requested_at`, [orgId])),
    outsideRequestScope(() => many<any>(
      `SELECT r.id, r.amount_minor, r.currency, r.reason, r.message, r.created_at FROM driver_refund_request r WHERE r.org_id = $1 AND r.state = 'pending' ORDER BY r.created_at`, [orgId])),
  ]);
  const iso = (d: Date) => new Date(d).toISOString();
  const may = (req: string | null, first: string | null) => !userId || (req !== userId && first !== userId);
  const approvals: Approval[] = [
    ...payouts.map((t) => ({
      kind: 'payout_transfer' as const, id: String(t.id), title: `Owner payout · ${t.owner ?? ''}`, detail: `${t.number ?? ''}${t.automatic ? ' · requested automatically' : ''}`,
      amount: Number(t.amount_minor), currency: t.currency, at: iso(t.requested_at), requestedBy: t.req_name ?? (t.requested_by ? null : 'automatic'), firstApprovedBy: t.first_name ?? null,
      mine: t.requested_by === userId, canDecide: may(t.requested_by, t.first_approved_by), automatic: t.automatic === true,
      approve: `/v1/finance/payout-transfers/${t.id}/approve`, reject: `/v1/finance/payout-transfers/${t.id}/reject`,
    })),
    ...refunds.map((t) => ({
      kind: 'refund_transfer' as const, id: String(t.id), title: `Refund transfer · ${t.holder_name ?? ''}`, detail: 'Bank transfer to the driver',
      amount: Number(t.amount_minor), currency: t.currency, at: iso(t.requested_at), requestedBy: t.req_name ?? null, firstApprovedBy: t.first_name ?? null,
      mine: t.requested_by === userId, canDecide: may(t.requested_by, t.first_approved_by),
      approve: `/v1/refund-transfers/${t.id}/approve`, reject: `/v1/refund-transfers/${t.id}/reject`,
    })),
    ...writeOffs.map((w) => ({
      kind: 'write_off' as const, id: String(w.id), title: `Write-off · ${String(w.kind).replace(/_/g, ' ')}`, detail: String(w.reason ?? '').slice(0, 120),
      amount: Number(w.amount_minor), currency: w.currency, at: iso(w.requested_at), requestedBy: w.req_name ?? null, firstApprovedBy: w.first_name ?? null,
      mine: w.requested_by === userId, canDecide: may(w.requested_by, w.first_approved_by),
      approve: `/v1/finance/write-offs/${w.id}/approve`, reject: `/v1/finance/write-offs/${w.id}/reject`,
    })),
    ...bank.map((c) => ({
      kind: 'bank_change' as const, id: String(c.id), title: `New bank details · ${c.owner}`, detail: `${c.bank_name ?? ''} ····${c.account_last4 ?? ''}`,
      amount: null, currency: null, at: iso(c.requested_at), requestedBy: c.req_name ?? 'the owner', firstApprovedBy: c.first_name ?? null,
      mine: c.requested_by === userId, canDecide: may(c.requested_by, c.first_approved_by),
      approve: `/v1/finance/owner-bank-requests/${c.id}/approve`, reject: `/v1/finance/owner-bank-requests/${c.id}/reject`,
    })),
    ...driver.map((r) => ({
      kind: 'driver_refund' as const, id: String(r.id), title: `Driver refund request · ${String(r.reason).replace(/_/g, ' ')}`, detail: String(r.message ?? '').slice(0, 120),
      amount: Number(r.amount_minor), currency: r.currency, at: iso(r.created_at), requestedBy: 'a driver', firstApprovedBy: null, mine: false, canDecide: true,
      approve: `/v1/finance/driver-refunds/${r.id}/approve`, reject: `/v1/finance/driver-refunds/${r.id}/reject`,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    asOf: now.toISOString(), day,
    today: rev.map((r) => ({ currency: r.currency, revenue: Number(r.revenue), sessions: r.sessions, kwh: Math.round(Number(r.wh) / 100) / 10 })),
    month: sum.perCurrency.map((c) => ({ currency: c.currency, revenue: c.revenue.mtd, vsLastMonthPct: c.revenue.vsLastMonthPct, margin: c.margin?.mtd ?? null, receivables: c.receivables, dso: c.dso, cash: c.cash })),
    approvals, waiting: approvals.filter((a) => a.canDecide).length,
  };
}
