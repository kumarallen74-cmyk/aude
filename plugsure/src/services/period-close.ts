import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { checklist, isLocked, lock as lockMonth, PeriodError } from './finance-periods.js';
import { drafts, reports as ledgerReports, currencies as ledgerCurrencies } from './general-ledger.js';
import { slips } from './withholding-tax.js';
import { xlsx } from './xlsx.js';

/**
 * Month close v2 (v1.32.0): the close as a list of steps, each checked from the data and signed off by a person.
 *
 *   ledger_synced        every module's entry for the month is posted in the ledger (Finance → Ledger → Sync)
 *   journals_approved    no journal entry of the month waits for approval or is a draft
 *   bank_reconciled      every bank line of the month is matched (or ignored)
 *   anomalies_reviewed   no finance check finding is open
 *   assets_recorded      the month's depreciation is recorded (when there are assets in service)
 *   leases_recorded      the month's lease journal is recorded (when there are leases)
 *   tax_slips_issued     the month's withholding slips are issued, and every bill that withholds is on one
 *   energy_bills         every site with sessions has its energy bill (v1.22.0)
 *   fx_rates             every currency has a rate into the reporting currency (v1.22.0)
 *
 * A step that checks out is signed off by anyone with payment:write; a step that does not is accepted as it is only by
 * a Finance Manager (finance:approve), with a note saying why. A sign-off can be withdrawn while the month is open.
 * With the close policy on (close_policy.enforce), a month is locked only when every step is signed off.
 *
 * The evidence pack for the auditor (Excel): the steps with their checks and sign-offs, the lock history, the trial
 * balance of each currency, and the month's finance actions from the audit log. A Financial Auditor (read-only) can
 * read the close and download the pack; nothing else.
 */

export class CloseError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const STEPS = ['ledger_synced', 'journals_approved', 'bank_reconciled', 'anomalies_reviewed', 'assets_recorded', 'leases_recorded', 'tax_slips_issued', 'energy_bills', 'fx_rates'] as const;
export type Step = typeof STEPS[number];
export const LABEL: Record<Step, string> = {
  ledger_synced: 'Ledger synced', journals_approved: 'Journal entries approved', bank_reconciled: 'Bank reconciled', anomalies_reviewed: 'Anomalies reviewed',
  assets_recorded: 'Depreciation recorded', leases_recorded: 'Leases recorded', tax_slips_issued: 'Withholding slips issued', energy_bills: 'Energy bills in', fx_rates: 'Exchange rates in',
};
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
const monthOk = (raw: unknown) => { const m = String(raw ?? ''); if (!MONTH_RE.test(m)) throw new CloseError(422, 'month is YYYY-MM.'); return m; };

export async function policy(orgId: string) {
  const r = await outsideRequestScope(() => one<{ close_policy: any }>(`SELECT close_policy FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  return { enforce: r?.close_policy?.enforce === true };
}

export async function savePolicy(orgId: string, b: Record<string, unknown>, userId: string | null, canApprove: boolean) {
  if (!canApprove) throw new CloseError(403, 'Only a Finance Manager (finance:approve) sets the close policy.');
  const v = { enforce: b.enforce === true || b.enforce === 'true' };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, close_policy, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET close_policy = EXCLUDED.close_policy, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/** Each step's check for the month. */
export async function checks(orgId: string, month: string): Promise<Array<{ step: Step; ok: boolean; detail: string }>> {
  const end = lastDay(month);
  const Q = <T extends Record<string, any> = any>(sql: string, p: unknown[]) => outsideRequestScope(() => one<T>(sql, p));
  const [base, ds, posted, waiting, findings, assets, assetRun, leases, leaseRun, sl] = await Promise.all([
    checklist(orgId, month),
    drafts(orgId, month),
    outsideRequestScope(() => many<{ source_ref: string }>(`SELECT source_ref FROM gl_entry WHERE org_id = $1 AND month = $2 AND status = 'posted' AND source_ref IS NOT NULL`, [orgId, month])),
    Q<{ n: number }>(`SELECT count(*)::int AS n FROM gl_entry WHERE org_id = $1 AND month = $2 AND status IN ('draft', 'awaiting_approval')`, [orgId, month]),
    Q<{ n: number }>(`SELECT count(*)::int AS n FROM finance_check_finding WHERE org_id = $1 AND status = 'open'`, [orgId]),
    Q<{ n: number }>(`SELECT count(*)::int AS n FROM fixed_asset WHERE org_id = $1 AND voided_at IS NULL AND acquired_on <= $2 AND (disposed_on IS NULL OR disposed_on >= $3::date)`, [orgId, end, `${month}-01`]),
    Q<{ n: number }>(`SELECT count(*)::int AS n FROM fixed_asset_run WHERE org_id = $1 AND month = $2`, [orgId, month]),
    Q<{ n: number }>(`SELECT count(*)::int AS n FROM lease WHERE org_id = $1 AND voided_at IS NULL AND exempt IS NULL AND start_month <= $2 AND (ended_month IS NULL OR ended_month >= $2)`, [orgId, month]),
    Q<{ n: number }>(`SELECT count(*)::int AS n FROM lease_run WHERE org_id = $1 AND month = $2`, [orgId, month]),
    slips(orgId, month),
  ]);
  const have = new Set(posted.map((p) => p.source_ref));
  const missing = ds.filter((d) => !have.has(d.ref));
  const item = (k: string) => base.items.find((i) => i.key === k)!;
  const draftSlips = sl.slips.filter((x) => x.status === 'draft').length;
  return [
    { step: 'ledger_synced', ok: missing.length === 0, detail: missing.length ? `${missing.length} module entr${missing.length === 1 ? 'y' : 'ies'} not posted (${[...new Set(missing.map((m) => m.source))].join(', ')}): sync the month` : ds.length ? `${ds.length} module entr${ds.length === 1 ? 'y' : 'ies'} posted` : 'Nothing for the modules to post' },
    { step: 'journals_approved', ok: (waiting?.n ?? 0) === 0, detail: waiting?.n ? `${waiting.n} journal entr${waiting.n === 1 ? 'y is' : 'ies are'} draft or awaiting approval` : 'No journal entry waiting' },
    { step: 'bank_reconciled', ok: item('bank_lines').ok, detail: item('bank_lines').label },
    { step: 'anomalies_reviewed', ok: (findings?.n ?? 0) === 0, detail: findings?.n ? `${findings.n} finance check finding(s) open (Finance → Checks)` : 'No finding open' },
    { step: 'assets_recorded', ok: !(assets?.n) || (assetRun?.n ?? 0) > 0, detail: !assets?.n ? 'No asset in service' : assetRun?.n ? 'Depreciation recorded' : `${assets.n} asset(s) in service; the month's depreciation is not recorded` },
    { step: 'leases_recorded', ok: !(leases?.n) || (leaseRun?.n ?? 0) > 0, detail: !leases?.n ? 'No lease' : leaseRun?.n ? 'Lease journal recorded' : `${leases.n} lease(s); the month's journal is not recorded` },
    { step: 'tax_slips_issued', ok: draftSlips === 0 && sl.billsNotOnSlip === 0, detail: draftSlips || sl.billsNotOnSlip ? `${draftSlips} slip(s) not issued, ${sl.billsNotOnSlip} bill(s) not on a slip` : `${sl.slips.filter((x) => x.status === 'issued').length} slip(s) issued` },
    { step: 'energy_bills', ok: item('energy_bills').ok, detail: item('energy_bills').label },
    { step: 'fx_rates', ok: item('fx_rates').ok, detail: item('fx_rates').label },
  ];
}

const SIGN_SELECT = `SELECT c.*, u.name AS signed_by_name FROM close_signoff c LEFT JOIN app_user u ON u.id = c.signed_by`;

/** The month's close: each step's check and sign-off, whether it is complete, and whether the month can be locked. */
export async function status(orgId: string, monthRaw: unknown) {
  const month = monthOk(monthRaw);
  const [cs, signs, pol, locked] = await Promise.all([
    checks(orgId, month),
    outsideRequestScope(() => many<any>(`${SIGN_SELECT} WHERE c.org_id = $1 AND c.month = $2 AND c.revoked_at IS NULL`, [orgId, month])),
    policy(orgId), isLocked(orgId, month),
  ]);
  const steps = cs.map((c) => {
    const s = signs.find((x) => x.step === c.step);
    return { ...c, label: LABEL[c.step], signoff: s ? { id: String(s.id), by: s.signed_by_name ?? null, at: new Date(s.signed_at).toISOString(), accepted: s.accepted, note: s.note ?? null } : null, complete: !!s };
  });
  const done = steps.filter((s) => s.complete).length;
  return { month, locked, policy: pol, steps, done, total: steps.length, ready: done === steps.length, canLock: !locked && (!pol.enforce || done === steps.length) };
}

/** Sign a step off. A step whose check fails is accepted as it is only by a Finance Manager, with a note. */
export async function signOff(orgId: string, monthRaw: unknown, stepRaw: unknown, b: Record<string, unknown>, who: { userId: string | null; canApprove: boolean }) {
  const month = monthOk(monthRaw);
  const step = String(stepRaw ?? '') as Step;
  if (!(STEPS as readonly string[]).includes(step)) throw new CloseError(422, `step is one of ${STEPS.join(', ')}.`);
  if (await isLocked(orgId, month)) throw new CloseError(409, `${month} is locked: reopen it to change its close.`);
  const c = (await checks(orgId, month)).find((x) => x.step === step)!;
  const note = b.note == null ? null : String(b.note).trim().slice(0, 500) || null;
  if (!c.ok) {
    if (!who.canApprove) throw new CloseError(403, `${LABEL[step]} does not check out (${c.detail}): only a Finance Manager (finance:approve) accepts it as it is.`);
    if (!note || note.length < 5) throw new CloseError(422, 'Say why the step is accepted as it is (at least 5 characters).');
  }
  try {
    await outsideRequestScope(() => query(`INSERT INTO close_signoff (org_id, month, step, accepted, note, signed_by) VALUES ($1, $2, $3, $4, $5, $6)`, [orgId, month, step, !c.ok, note, who.userId]));
  } catch (e) {
    if ((e as any).code === '23505') throw new CloseError(409, `${LABEL[step]} is already signed off for ${month}.`);
    throw e;
  }
  return status(orgId, month);
}

export async function revoke(orgId: string, monthRaw: unknown, stepRaw: unknown) {
  const month = monthOk(monthRaw);
  if (await isLocked(orgId, month)) throw new CloseError(409, `${month} is locked: reopen it to change its close.`);
  const r = await outsideRequestScope(() => one(`UPDATE close_signoff SET revoked_at = now() WHERE org_id = $1 AND month = $2 AND step = $3 AND revoked_at IS NULL RETURNING id`, [orgId, month, String(stepRaw ?? '')]));
  if (!r) throw new CloseError(404, 'That step is not signed off.');
  return status(orgId, month);
}

/** Lock the month, under the close policy. */
export async function lock(orgId: string, monthRaw: unknown, note: unknown, userId: string | null, now = new Date()) {
  const month = String(monthRaw ?? '');
  if (MONTH_RE.test(month)) {
    const pol = await policy(orgId);
    if (pol.enforce) {
      const s = await status(orgId, month);
      if (!s.ready) throw new PeriodError(409, `${month} cannot be locked yet: ${s.total - s.done} close step(s) not signed off (${s.steps.filter((x) => !x.complete).map((x) => x.label).join(', ')}).`);
    }
  }
  return lockMonth(orgId, monthRaw, note, userId, now);
}

/** The auditor's evidence pack for a month. */
export async function evidence(orgId: string, monthRaw: unknown): Promise<Buffer> {
  const month = monthOk(monthRaw);
  const s = await status(orgId, month);
  const [hist, signs, actions, curs] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT l.*, lu.name AS lb, ru.name AS rb FROM finance_period_lock l LEFT JOIN app_user lu ON lu.id = l.locked_by LEFT JOIN app_user ru ON ru.id = l.reopened_by WHERE l.org_id = $1 AND l.month = $2 ORDER BY l.locked_at`, [orgId, month])),
    outsideRequestScope(() => many<any>(`${SIGN_SELECT} WHERE c.org_id = $1 AND c.month = $2 ORDER BY c.signed_at`, [orgId, month])),
    outsideRequestScope(() => many<any>(
      `SELECT a.ts, a.actor_type, a.actor_id, u.name, a.action, a.target_type, a.target_id FROM audit_log a LEFT JOIN app_user u ON a.actor_type = 'user' AND u.id::text = a.actor_id
        WHERE a.org_id = $1 AND (a.action LIKE 'finance.%' OR a.action LIKE 'payment.%') AND to_char(a.ts AT TIME ZONE $3, 'YYYY-MM') = $2 ORDER BY a.ts LIMIT 20000`, [orgId, month, zone()])),
    ledgerCurrencies(orgId),
  ]);
  const tbs = [];
  for (const c of curs) {
    const r = await ledgerReports(orgId, { month, currency: c });
    tbs.push({ name: `Trial balance ${c}`, rows: [['Code', 'Account', 'Type', 'Debits', 'Credits', 'Balance'], ...r.trialBalance.rows.map((x) => [x.code, x.name, x.type, x.debit, x.credit, x.balance]),
      ['', r.trialBalance.balanced ? 'Balances' : 'DOES NOT BALANCE', '', '', '', '']], widths: [10, 40, 10, 16, 16, 16], formats: [null, null, null, 'money', 'money', 'money'] as Array<'money' | null> });
  }
  const iso = (d: any) => (d ? new Date(d).toISOString() : '');
  return xlsx([
    { name: 'Close', rows: [['Step', 'Checks out', 'Check', 'Signed off by', 'At', 'Accepted as is', 'Note'],
      ...s.steps.map((x) => [x.label, x.ok ? 'yes' : 'no', x.detail, x.signoff?.by ?? '', x.signoff?.at ?? '', x.signoff?.accepted ? 'yes' : '', x.signoff?.note ?? '']),
      [], ['Month', month], ['Locked', s.locked ? 'yes' : 'no'], ['Close policy enforced', s.policy.enforce ? 'yes' : 'no']], widths: [26, 10, 60, 24, 24, 12, 50] },
    { name: 'Sign-off history', rows: [['Step', 'Signed by', 'At', 'Accepted as is', 'Note', 'Withdrawn'], ...signs.map((x) => [LABEL[x.step as Step] ?? x.step, x.signed_by_name ?? '', iso(x.signed_at), x.accepted ? 'yes' : '', x.note ?? '', iso(x.revoked_at)])], widths: [26, 24, 24, 12, 50, 24] },
    { name: 'Lock history', rows: [['Locked by', 'At', 'Note', 'Reopened by', 'At', 'Reason'], ...hist.map((x) => [x.lb ?? '', iso(x.locked_at), x.note ?? '', x.rb ?? '', iso(x.reopened_at), x.reopen_reason ?? ''])], widths: [24, 24, 40, 24, 24, 40] },
    ...tbs,
    { name: 'Finance actions', rows: [['When', 'Who', 'Action', 'Target', 'Id'], ...actions.map((a) => [iso(a.ts), a.name ?? `${a.actor_type}:${a.actor_id ?? ''}`, a.action, a.target_type ?? '', a.target_id ?? ''])], widths: [24, 28, 36, 24, 40] },
  ]);
}
