import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert } from './alerts.js';
import { rules as approvalRules } from './finance-approvals.js';

/**
 * Finance anomaly review (v1.30.0). Checks over the last 90 days of the organisation's finance records, run daily and
 * on demand; what they find goes to a review queue:
 *
 *   duplicate_bill       two bills from the same supplier for the same subtotal within 14 days (different numbers)
 *   duplicate_payment    two payments on the same bill for the same amount on the same day
 *   round_amount         a supplier payment of a round amount (a multiple of 1 000 000) at or above a threshold
 *                        (default 10 000 000)
 *   new_supplier_large   a bill of at least an amount (default 50 000 000) from a supplier added within the last days
 *                        (default 30) before it
 *   split_bills          bills from one supplier on one day, each below the approvals matrix's supplier-bill amount and
 *                        together above it
 *   out_of_hours         bills, payments, transfers, balances and deposits entered on a weekend or between 22:00 and
 *                        06:00 (the billing time zone)
 *
 * A finding is open until reviewed: dismissed (with a note: it is fine) or confirmed (with a note: it needs action;
 * raises finance.anomaly_confirmed). Found again, a reviewed finding keeps its review; an open finding whose condition
 * is gone is cleared. Checks can be turned off one by one.
 */

export class CheckError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const KINDS = ['duplicate_bill', 'duplicate_payment', 'round_amount', 'new_supplier_large', 'split_bills', 'out_of_hours'] as const;
type Kind = typeof KINDS[number];
export const CONFIRMED_ALERT = 'finance.anomaly_confirmed';
const LABEL: Record<Kind, string> = {
  duplicate_bill: 'Possible duplicate bill', duplicate_payment: 'Possible duplicate payment', round_amount: 'Round-amount payment',
  new_supplier_large: 'Large bill from a new supplier', split_bills: 'Bills split below the approval amount', out_of_hours: 'Entered out of hours',
};
const zone = () => config.billing.timeZone;

export interface Settings { roundAmount: number; newSupplierAmount: number; newSupplierDays: number; disabled: Kind[] }

export async function settings(orgId: string): Promise<Settings> {
  const r = await outsideRequestScope(() => one<{ finance_checks: any }>(`SELECT finance_checks FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.finance_checks ?? {};
  return { roundAmount: Number(v.roundAmount ?? 10_000_000), newSupplierAmount: Number(v.newSupplierAmount ?? 50_000_000), newSupplierDays: Number(v.newSupplierDays ?? 30),
    disabled: Array.isArray(v.disabled) ? v.disabled.filter((k: string) => (KINDS as readonly string[]).includes(k)) : [] };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await settings(orgId);
  const int = (k: 'roundAmount' | 'newSupplierAmount' | 'newSupplierDays', lo: number, hi: number) => {
    if (b[k] === undefined) return cur[k];
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new CheckError(422, `${k} is ${lo} to ${hi}.`);
    return n;
  };
  let disabled = cur.disabled;
  if (b.disabled !== undefined) {
    if (!Array.isArray(b.disabled) || b.disabled.some((k) => !(KINDS as readonly string[]).includes(String(k)))) throw new CheckError(422, `disabled lists checks: ${KINDS.join(', ')}.`);
    disabled = b.disabled.map(String) as Kind[];
  }
  const v: Settings = { roundAmount: int('roundAmount', 1, 1e15), newSupplierAmount: int('newSupplierAmount', 1, 1e15), newSupplierDays: int('newSupplierDays', 1, 365), disabled };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, finance_checks, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET finance_checks = EXCLUDED.finance_checks, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

interface Found { kind: Kind; targetType: string; targetId: string; severity: 'info' | 'warning' | 'critical'; message: string; data: Record<string, unknown> }
const fmt = (n: number, c: string) => `${n.toLocaleString('en-US')} ${c}`;

/** Every check over the last 90 days: what each finds now. */
export async function detect(orgId: string): Promise<Found[]> {
  const s = await settings(orgId);
  const on = (k: Kind) => !s.disabled.includes(k);
  const out: Found[] = [];
  const Q = (sql: string, p: unknown[]) => outsideRequestScope(() => many<any>(sql, p));

  if (on('duplicate_bill')) {
    for (const r of await Q(
      `SELECT b.id, b.number, o.id AS other_id, o.number AS other_number, b.subtotal_minor, b.currency, s.name AS supplier
         FROM supplier_bill b JOIN supplier_bill o ON o.supplier_id = b.supplier_id AND o.id < b.id AND o.subtotal_minor = b.subtotal_minor AND o.currency = b.currency
              AND abs(o.bill_date - b.bill_date) <= 14 AND o.status NOT IN ('void', 'rejected') AND lower(o.number) <> lower(b.number)
         JOIN supplier s ON s.id = b.supplier_id
        WHERE b.org_id = $1 AND b.status NOT IN ('void', 'rejected') AND b.created_at > now() - interval '90 days'`, [orgId])) {
      out.push({ kind: 'duplicate_bill', targetType: 'supplier_bill', targetId: String(r.id), severity: 'warning',
        message: `${r.supplier}: bill ${r.number} is for the same ${fmt(Number(r.subtotal_minor), r.currency)} as bill ${r.other_number} within 14 days.`, data: { billId: String(r.id), otherBillId: String(r.other_id) } });
    }
  }
  if (on('duplicate_payment')) {
    for (const r of await Q(
      `SELECT p.id, p.amount_minor, b.number, b.currency, s.name AS supplier, o.id AS other_id
         FROM supplier_payment p JOIN supplier_payment o ON o.bill_id = p.bill_id AND o.id < p.id AND o.amount_minor = p.amount_minor AND o.paid_on = p.paid_on AND o.voided_at IS NULL
         JOIN supplier_bill b ON b.id = p.bill_id JOIN supplier s ON s.id = b.supplier_id
        WHERE p.org_id = $1 AND p.voided_at IS NULL AND p.created_at > now() - interval '90 days'`, [orgId])) {
      out.push({ kind: 'duplicate_payment', targetType: 'supplier_payment', targetId: String(r.id), severity: 'critical',
        message: `${r.supplier}: two payments of ${fmt(Number(r.amount_minor), r.currency)} on bill ${r.number} on the same day.`, data: { paymentId: String(r.id), otherPaymentId: String(r.other_id) } });
    }
  }
  if (on('round_amount')) {
    for (const r of await Q(
      `SELECT p.id, p.amount_minor, b.number, b.currency, s.name AS supplier FROM supplier_payment p JOIN supplier_bill b ON b.id = p.bill_id JOIN supplier s ON s.id = b.supplier_id
        WHERE p.org_id = $1 AND p.voided_at IS NULL AND p.created_at > now() - interval '90 days' AND p.amount_minor >= $2 AND p.amount_minor % 1000000 = 0`, [orgId, s.roundAmount])) {
      out.push({ kind: 'round_amount', targetType: 'supplier_payment', targetId: String(r.id), severity: 'info',
        message: `${r.supplier}: a round payment of ${fmt(Number(r.amount_minor), r.currency)} on bill ${r.number}.`, data: { paymentId: String(r.id) } });
    }
  }
  if (on('new_supplier_large')) {
    for (const r of await Q(
      `SELECT b.id, b.number, b.currency, b.subtotal_minor + b.vat_minor - b.wht_minor AS payable, s.name AS supplier, to_char(s.created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS added
         FROM supplier_bill b JOIN supplier s ON s.id = b.supplier_id
        WHERE b.org_id = $1 AND b.status NOT IN ('void', 'rejected') AND b.created_at > now() - interval '90 days'
          AND b.subtotal_minor + b.vat_minor - b.wht_minor >= $2 AND b.created_at - s.created_at <= make_interval(days => $3)`, [orgId, s.newSupplierAmount, s.newSupplierDays, zone()])) {
      out.push({ kind: 'new_supplier_large', targetType: 'supplier_bill', targetId: String(r.id), severity: 'warning',
        message: `${r.supplier} (added ${r.added}): bill ${r.number} for ${fmt(Number(r.payable), r.currency)}.`, data: { billId: String(r.id) } });
    }
  }
  if (on('split_bills')) {
    const rule = (await approvalRules(orgId)).supplier_bill;
    if (rule && rule.above > 0) {
      for (const r of await Q(
        `SELECT b.supplier_id, to_char(b.bill_date, 'YYYY-MM-DD') AS d, b.currency, s.name AS supplier, count(*) AS n, sum(b.subtotal_minor + b.vat_minor - b.wht_minor) AS total, array_agg(b.id::text ORDER BY b.id) AS ids
           FROM supplier_bill b JOIN supplier s ON s.id = b.supplier_id
          WHERE b.org_id = $1 AND b.status NOT IN ('void', 'rejected') AND b.created_at > now() - interval '90 days' AND b.subtotal_minor + b.vat_minor - b.wht_minor <= $2
          GROUP BY 1, 2, 3, 4 HAVING count(*) >= 2 AND sum(b.subtotal_minor + b.vat_minor - b.wht_minor) > $2`, [orgId, rule.above])) {
        out.push({ kind: 'split_bills', targetType: 'supplier_day', targetId: `${r.supplier_id}:${r.d}`, severity: 'warning',
          message: `${r.supplier}: ${r.n} bills on ${r.d}, each at or below the approval amount (${fmt(rule.above, r.currency)}), ${fmt(Number(r.total), r.currency)} together.`, data: { billIds: r.ids } });
      }
    }
  }
  if (on('out_of_hours')) {
    const sources: Array<[string, string, string]> = [
      ['supplier_bill', 'supplier_bill', "'Bill ' || x.number"], ['supplier_payment', 'supplier_payment', "'Supplier payment of ' || to_char(x.amount_minor, 'FM999,999,999,999,999,990')"],
      ['cash_transfer', 'cash_transfer', "'Transfer of ' || to_char(x.amount_minor, 'FM999,999,999,999,999,990')"], ['cash_balance', 'cash_balance', "'Balance of ' || to_char(x.balance_minor, 'FM999,999,999,999,999,990')"], ['deposit', 'deposit', "'Deposit of ' || to_char(x.principal_minor, 'FM999,999,999,999,999,990')"],
    ];
    for (const [table, type, label] of sources) {
      const tcol = table === 'cash_balance' ? 'recorded_at' : 'created_at';
      for (const r of await Q(
        `SELECT x.id, ${label} AS what, to_char(x.${tcol} AT TIME ZONE $2, 'Dy YYYY-MM-DD HH24:MI') AS at
           FROM ${table} x WHERE x.org_id = $1 AND x.${tcol} > now() - interval '90 days'
            AND (EXTRACT(ISODOW FROM x.${tcol} AT TIME ZONE $2) >= 6 OR EXTRACT(HOUR FROM x.${tcol} AT TIME ZONE $2) >= 22 OR EXTRACT(HOUR FROM x.${tcol} AT TIME ZONE $2) < 6)`, [orgId, zone()])) {
        out.push({ kind: 'out_of_hours', targetType: type, targetId: String(r.id), severity: 'info', message: `${r.what} entered ${r.at}.`, data: {} });
      }
    }
  }
  return out;
}

/** Run the checks and update the queue. Returns what is new (or reopened) and what was cleared. */
export async function run(orgId: string) {
  const found = await detect(orgId);
  let added = 0, cleared = 0;
  for (const f of found) {
    const r = await outsideRequestScope(() => one<{ inserted: boolean }>(
      `INSERT INTO finance_check_finding (org_id, check_kind, target_type, target_id, severity, message, data) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, check_kind, target_type, target_id) DO UPDATE SET last_seen_at = now(), message = EXCLUDED.message, data = EXCLUDED.data, severity = EXCLUDED.severity,
         status = CASE WHEN finance_check_finding.status = 'cleared' THEN 'open' ELSE finance_check_finding.status END
       RETURNING (xmax = 0) AS inserted`, [orgId, f.kind, f.targetType, f.targetId, f.severity, f.message, JSON.stringify(f.data)]));
    if (r?.inserted) added++;
  }
  const keys = found.map((f) => `${f.kind}|${f.targetType}|${f.targetId}`);
  const gone = await outsideRequestScope(() => many<{ id: string }>(
    `UPDATE finance_check_finding SET status = 'cleared' WHERE org_id = $1 AND status = 'open' AND NOT ((check_kind || '|' || target_type || '|' || target_id) = ANY($2::text[])) RETURNING id`, [orgId, keys]));
  cleared = gone.length;
  return { found: found.length, added, cleared };
}

const view = (r: any) => ({
  id: String(r.id), kind: r.check_kind, label: LABEL[r.check_kind as Kind] ?? r.check_kind, targetType: r.target_type, targetId: r.target_id, severity: r.severity,
  message: r.message, data: r.data ?? {}, status: r.status, foundAt: new Date(r.found_at).toISOString(), lastSeenAt: new Date(r.last_seen_at).toISOString(),
  reviewedBy: r.reviewed_by_name ?? null, reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null, reviewNote: r.review_note ?? null,
});

export async function list(orgId: string, q: Record<string, unknown> = {}) {
  const status = q.status == null || q.status === '' ? 'open' : String(q.status);
  if (!['open', 'dismissed', 'confirmed', 'cleared', 'all'].includes(status)) throw new CheckError(422, 'status is open, dismissed, confirmed, cleared or all.');
  const [rows, counts, s] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT f.*, u.name AS reviewed_by_name FROM finance_check_finding f LEFT JOIN app_user u ON u.id = f.reviewed_by
        WHERE f.org_id = $1 AND ($2 = 'all' OR f.status = $2) ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, f.found_at DESC LIMIT 500`, [orgId, status])),
    outsideRequestScope(() => many<any>(`SELECT check_kind, status, count(*) AS n FROM finance_check_finding WHERE org_id = $1 GROUP BY 1, 2`, [orgId])),
    settings(orgId),
  ]);
  const summary = KINDS.map((k) => ({ kind: k, label: LABEL[k], enabled: !s.disabled.includes(k),
    open: Number(counts.find((c) => c.check_kind === k && c.status === 'open')?.n ?? 0), confirmed: Number(counts.find((c) => c.check_kind === k && c.status === 'confirmed')?.n ?? 0) }));
  return { status, findings: rows.map(view), summary, settings: s };
}

export async function review(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  if (!/^\d{1,18}$/.test(id)) throw new CheckError(404, 'No such finding.');
  const decision = String(b.decision ?? '');
  if (decision !== 'dismiss' && decision !== 'confirm') throw new CheckError(422, 'decision is dismiss or confirm.');
  const note = String(b.note ?? '').trim();
  if (note.length < 3) throw new CheckError(422, 'Add a note (at least 3 characters): what you checked.');
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM finance_check_finding WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!r) throw new CheckError(404, 'No such finding.');
  if (r.status !== 'open') throw new CheckError(409, `The finding is ${r.status}.`);
  const status = decision === 'dismiss' ? 'dismissed' : 'confirmed';
  await outsideRequestScope(() => query(`UPDATE finance_check_finding SET status = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5 WHERE id = $1 AND org_id = $2`, [id, orgId, status, userId, note.slice(0, 500)]));
  if (status === 'confirmed') {
    await outsideRequestScope(() => persistAlert({ orgId, kind: CONFIRMED_ALERT, severity: 'critical', targetType: 'finance_check_finding', targetId: id, message: `${LABEL[r.check_kind as Kind] ?? r.check_kind} confirmed: ${r.message} ${note}` })).catch(() => null);
  }
  const done = await outsideRequestScope(() => one<any>(`SELECT f.*, u.name AS reviewed_by_name FROM finance_check_finding f LEFT JOIN app_user u ON u.id = f.reviewed_by WHERE f.id = $1`, [id]));
  return view(done);
}

export async function sweep(): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM supplier_bill WHERE created_at > now() - interval '90 days' UNION SELECT DISTINCT org_id FROM cash_transfer WHERE created_at > now() - interval '90 days'`));
  let n = 0;
  for (const o of orgs) { try { n += (await run(o.org_id)).added; } catch (e) { logger.warn({ org: o.org_id, err: (e as Error).message }, 'finance checks failed'); } }
  return n;
}
