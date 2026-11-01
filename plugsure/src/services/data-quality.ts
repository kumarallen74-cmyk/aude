import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';

/**
 * Finance data quality and the audit trail (v1.40.0).
 *
 *   checks    the ledger: posted entries that do not balance, lines on accounts outside the chart, entries posted
 *             into a month after it was locked, journal entries left in draft or awaiting approval over 30 days;
 *             the masters: suppliers that look like duplicates (the same name once PT/CV/Tbk and punctuation are
 *             set aside, the same NPWP, or the same bank account), suppliers billing without an NPWP or a bank
 *             account, fleet accounts invoiced without a tax id; the dimensions: energy, maintenance and rent bills
 *             without a site; cash: bank accounts without a balance in 35 days
 *   score     100 less a weight per finding, each check capped (a broken ledger costs most); kept per run with the
 *             trend; finance.data_quality_low when under 70 (resolved when back)
 *   history   every change to a record (a supplier, a bill, a card, a contract…) from the audit trail: who, when,
 *             what before and after
 */

export class DataQualityError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const LOW = 'finance.data_quality_low';
export const THRESHOLD = 70;
const zone = () => config.billing.timeZone;

/** Each check's weight per finding and cap. */
export const WEIGHTS: Record<string, { label: string; each: number; cap: number; severity: 'critical' | 'warning' | 'info' }> = {
  unbalanced_entry: { label: 'Posted entry does not balance', each: 15, cap: 30, severity: 'critical' },
  unknown_account: { label: 'Account not in the chart', each: 5, cap: 15, severity: 'warning' },
  posted_after_lock: { label: 'Posted after the month was locked', each: 10, cap: 20, severity: 'critical' },
  stale_draft_entry: { label: 'Journal entry waiting over 30 days', each: 1, cap: 5, severity: 'info' },
  duplicate_supplier: { label: 'Possible duplicate supplier', each: 3, cap: 15, severity: 'warning' },
  supplier_incomplete: { label: 'Supplier without NPWP or bank account', each: 1, cap: 10, severity: 'info' },
  fleet_no_tax_id: { label: 'Fleet account invoiced without a tax id', each: 1, cap: 5, severity: 'info' },
  bill_no_site: { label: 'Site cost without a site', each: 1, cap: 10, severity: 'info' },
  stale_cash_balance: { label: 'Bank account without a recent balance', each: 3, cap: 10, severity: 'warning' },
};

/** A supplier name without legal forms and punctuation, for comparison. Pure. */
export function normaliseName(s: string): string {
  return s.toLowerCase().replace(/\b(pt|cv|tbk|ud|persero|limited|ltd|inc)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/** The score from the findings. Pure. */
export function scoreOf(findings: Array<{ check: string }>): { score: number; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.check] = (counts[f.check] ?? 0) + 1;
  const lost = Object.entries(counts).reduce((a, [k, n]) => a + Math.min(WEIGHTS[k]?.cap ?? 0, (WEIGHTS[k]?.each ?? 0) * n), 0);
  return { score: Math.max(0, 100 - lost), counts };
}

type Finding = { check: string; severity: string; label: string; targetType: string; targetId: string; message: string };

export async function detect(orgId: string): Promise<Finding[]> {
  const Q = <T extends Record<string, any> = any>(sql: string, p: unknown[] = [orgId]) => outsideRequestScope(() => many<T>(sql, p));
  const [unbalanced, unknown, afterLock, drafts, sups, fleets, noSite, stale] = await Promise.all([
    Q(`SELECT e.id::text AS id, e.number, e.month, sum(l.debit) AS d, sum(l.credit) AS c FROM gl_entry e JOIN gl_line l ON l.entry_id = e.id WHERE e.org_id = $1 AND e.status = 'posted' GROUP BY 1, 2, 3 HAVING round(sum(l.debit) - sum(l.credit), 2) <> 0`),
    Q(`SELECT DISTINCT l.account_code AS code FROM gl_line l JOIN gl_entry e ON e.id = l.entry_id WHERE e.org_id = $1 AND e.status = 'posted'
        AND EXISTS (SELECT 1 FROM gl_account a0 WHERE a0.org_id = $1) AND NOT EXISTS (SELECT 1 FROM gl_account a WHERE a.org_id = $1 AND a.code = l.account_code)`),
    Q(`SELECT e.id::text AS id, e.number, e.month FROM gl_entry e JOIN finance_period_lock k ON k.org_id = e.org_id AND k.month = e.month AND k.reopened_at IS NULL
        WHERE e.org_id = $1 AND e.status = 'posted' AND e.posted_at > k.locked_at`),
    Q(`SELECT id::text AS id, number, status, created_at FROM gl_entry WHERE org_id = $1 AND status IN ('draft', 'awaiting_approval') AND created_at < now() - interval '30 days'`),
    Q(`SELECT s.id::text AS id, s.name, s.tax_id, s.account_number, s.bank_name,
              EXISTS (SELECT 1 FROM supplier_bill b WHERE b.supplier_id = s.id AND b.status IN ('approved', 'paid') AND b.bill_date > now() - interval '12 months') AS billing
         FROM supplier s WHERE s.org_id = $1 AND s.archived_at IS NULL`),
    Q(`SELECT f.id::text AS id, f.name FROM fleet_account f WHERE f.org_id = $1 AND f.archived_at IS NULL AND (f.tax_id IS NULL OR f.tax_id = '')
        AND EXISTS (SELECT 1 FROM fleet_invoice i WHERE i.fleet_account_id = f.id AND i.status IN ('issued', 'paid') AND i.period > now() - interval '12 months')`),
    Q(`SELECT b.id::text AS id, b.number, b.category FROM supplier_bill b WHERE b.org_id = $1 AND b.status IN ('approved', 'paid') AND b.site_id IS NULL AND b.category IN ('energy', 'maintenance', 'rent') AND b.bill_date > now() - interval '12 months'`),
    Q(`SELECT a.id::text AS id, a.name, (SELECT max(on_date) FROM cash_balance c WHERE c.account_id = a.id) AS last FROM cash_account a WHERE a.org_id = $1 AND a.archived_at IS NULL AND a.kind = 'bank'
        AND COALESCE((SELECT max(on_date) FROM cash_balance c WHERE c.account_id = a.id), a.opening_on) < (now() AT TIME ZONE $2)::date - 35`, [orgId, zone()]),
  ]);
  const out: Finding[] = [];
  const add = (check: string, targetType: string, targetId: string, message: string) => out.push({ check, severity: WEIGHTS[check]!.severity, label: WEIGHTS[check]!.label, targetType, targetId, message });
  for (const e of unbalanced) add('unbalanced_entry', 'gl_entry', e.id, `${e.number} (${e.month}): debits ${Number(e.d).toLocaleString('en-US')} against credits ${Number(e.c).toLocaleString('en-US')}.`);
  for (const a of unknown) add('unknown_account', 'gl_account', a.code, `Lines are posted to ${a.code}, which is not in the chart of accounts.`);
  for (const e of afterLock) add('posted_after_lock', 'gl_entry', e.id, `${e.number} was posted into ${e.month} after the month was locked.`);
  for (const e of drafts) add('stale_draft_entry', 'gl_entry', e.id, `${e.number} has been ${e.status.replace('_', ' ')} since ${new Date(e.created_at).toISOString().slice(0, 10)}.`);
  // Duplicates: by normalised name, NPWP digits, or bank account digits.
  const keyed = (k: (s: any) => string | null, why: string) => {
    const by = new Map<string, any[]>();
    for (const s of sups) { const v = k(s); if (v) by.set(v, [...(by.get(v) ?? []), s]); }
    for (const grp of by.values()) if (grp.length > 1) for (const s of grp.slice(1)) add('duplicate_supplier', 'supplier', s.id, `${s.name} looks like ${grp[0].name} (${why}).`);
  };
  const digits = (x: string | null) => { const d = (x ?? '').replace(/\D/g, ''); return d.length >= 8 ? d : null; };
  keyed((s) => normaliseName(s.name) || null, 'the same name');
  keyed((s) => digits(s.tax_id), 'the same NPWP');
  keyed((s) => digits(s.account_number), 'the same bank account');
  for (const s of sups.filter((x) => x.billing && (!x.tax_id || !x.account_number || !x.bank_name))) add('supplier_incomplete', 'supplier', s.id, `${s.name} bills without ${[!s.tax_id && 'an NPWP', (!s.account_number || !s.bank_name) && 'a bank account'].filter(Boolean).join(' or ')}.`);
  for (const f of fleets) add('fleet_no_tax_id', 'fleet_account', f.id, `${f.name} is invoiced without a tax id (NPWP).`);
  for (const b of noSite) add('bill_no_site', 'supplier_bill', b.id, `${b.number} (${b.category}) has no site: its cost is not in the site P&L.`);
  for (const a of stale) add('stale_cash_balance', 'cash_account', a.id, `${a.name}: ${a.last ? `the last balance is from ${new Date(a.last).toISOString().slice(0, 10)}` : 'no balance recorded'}.`);
  // One duplicate finding per supplier even if it matched on several keys.
  const seen = new Set<string>();
  return out.filter((f) => { const k = `${f.check}|${f.targetId}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function run(orgId: string, userId: string | null = null) {
  const findings = await detect(orgId);
  const { score, counts } = scoreOf(findings);
  const r = await outsideRequestScope(() => one<{ id: string; run_at: Date }>(`INSERT INTO dq_run (org_id, score, findings, counts, run_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, run_at`, [orgId, score, JSON.stringify(findings), JSON.stringify(counts), userId]));
  if (score < THRESHOLD) await outsideRequestScope(() => persistAlert({ orgId, kind: LOW, severity: score < 50 ? 'critical' : 'warning', targetType: 'organisation', targetId: orgId, message: `Finance data quality is ${score}/100: ${Object.entries(counts).map(([k, n]) => `${n} × ${WEIGHTS[k]?.label.toLowerCase() ?? k}`).join(', ')}. Finance → Data quality.` }));
  else await outsideRequestScope(() => resolveAlertsFor(orgId, LOW, 'organisation', orgId)).catch(() => 0);
  return { id: String(r!.id), runAt: new Date(r!.run_at).toISOString(), score, counts, findings };
}

export async function overview(orgId: string) {
  const runs = await outsideRequestScope(() => many<any>(`SELECT id, run_at, score, counts, findings FROM dq_run WHERE org_id = $1 ORDER BY run_at DESC LIMIT 30`, [orgId]));
  const last = runs[0];
  return {
    threshold: THRESHOLD, weights: WEIGHTS,
    last: last ? { id: String(last.id), runAt: new Date(last.run_at).toISOString(), score: last.score, counts: last.counts, findings: last.findings } : null,
    trend: runs.slice().reverse().map((r) => ({ runAt: new Date(r.run_at).toISOString(), score: r.score })),
  };
}

/** A record's change history from the audit trail. */
export async function history(orgId: string, typeRaw: unknown, idRaw: unknown) {
  const type = String(typeRaw ?? ''), id = String(idRaw ?? '');
  if (!/^[a-z_]{2,40}$/.test(type) || !id || id.length > 64) throw new DataQualityError(400, 'targetType and targetId name a record.');
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT a.ts, a.action, a.actor_type, a.actor_id, u.name AS actor_name, a.before_state, a.after_state, a.ip FROM audit_log a LEFT JOIN app_user u ON u.id::text = a.actor_id::text
      WHERE a.org_id = $1 AND a.target_type = $2 AND a.target_id = $3 ORDER BY a.ts DESC, a.seq DESC LIMIT 200`, [orgId, type, id]));
  return { targetType: type, targetId: id, changes: rows.map((r) => ({ at: new Date(r.ts).toISOString(), action: r.action, by: r.actor_name ?? (r.actor_type === 'user' ? 'a user' : r.actor_type), before: r.before_state ?? null, after: r.after_state ?? null })) };
}

/** Daily: every organisation with a ledger or suppliers. */
export async function sweep(): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ id: string }>(`SELECT DISTINCT org_id AS id FROM gl_entry UNION SELECT DISTINCT org_id FROM supplier`));
  let n = 0;
  for (const o of orgs) { try { await run(o.id); n++; } catch (e) { logger.warn({ org: o.id, err: (e as Error).message }, 'data quality run failed'); } }
  return n;
}
