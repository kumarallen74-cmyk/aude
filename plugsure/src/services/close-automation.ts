import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { isLocked } from './finance-periods.js';
import { LABEL, STEPS, type Step } from './period-close.js';

/**
 * Finance close automation (v1.38.0). The month close (Finance → Close) has nine steps, each with a check and a
 * sign-off. This does the mechanical work and keeps the close on time:
 *
 *   run          for a month not locked: sync the ledger (every module's journal), record depreciation and the lease
 *                journal, fetch the ECB rates when a reporting currency is set and a rate is missing, run the finance
 *                checks; then record what is still blocking (each step whose check fails). Each action's result (done,
 *                skipped, or its error) is kept in the run. Nothing is signed off or locked: people do that.
 *   automatic    on, from a working day after the month's end (by default the 1st), the worker runs the previous month
 *                once a day until it is locked.
 *   owners       each step has an owner and a due working day after the month's end (by default the 3rd); the calendar
 *                shows each step's due date, its owner, and whether it is done (signed off). A step not done by its
 *                date raises finance.close_step_overdue for its owner (resolved once signed off or the month locked).
 *   trend        the days from each month's end to its lock, over the last twelve months locked.
 */

export class CloseAutomationError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERR = (s: number, m: string) => new CloseAutomationError(s, m);
const OVERDUE = 'finance.close_step_overdue';
export const DEFAULT_DUE_DAY = 3;
export const DEFAULT_RUN_DAY = 1;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const prevMonth = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const monthOk = (raw: unknown) => { const m = String(raw ?? ''); if (!MONTH_RE.test(m)) throw ERR(422, 'month is YYYY-MM.'); return m; };

/** The nth working day (Monday to Friday) after a month's end. Pure. */
export function workingDay(month: string, n: number): string {
  let d = Date.parse(`${lastDay(month)}T00:00:00Z`), k = 0;
  while (k < n) { d += 86_400_000; const w = new Date(d).getUTCDay(); if (w !== 0 && w !== 6) k++; }
  return new Date(d).toISOString().slice(0, 10);
}

/** Days from a month's end to a moment (in the operator's zone). Pure. */
export function daysToClose(month: string, lockedDay: string): number {
  return Math.round((Date.parse(`${lockedDay}T00:00:00Z`) - Date.parse(`${lastDay(month)}T00:00:00Z`)) / 86_400_000);
}

export async function settings(orgId: string) {
  const r = await outsideRequestScope(() => one<{ close_automation: any }>(`SELECT close_automation FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const c = r?.close_automation ?? {};
  return { enabled: c.enabled === true, runOnDay: Number.isInteger(c.runOnDay) ? (c.runOnDay as number) : DEFAULT_RUN_DAY };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await settings(orgId);
  const enabled = b.enabled === undefined ? cur.enabled : b.enabled === true || b.enabled === 'true';
  const runOnDay = b.runOnDay === undefined || b.runOnDay === null || b.runOnDay === '' ? cur.runOnDay : Number(b.runOnDay);
  if (!Number.isInteger(runOnDay) || runOnDay < 1 || runOnDay > 10) throw ERR(422, 'runOnDay is a working day after the month end, 1 to 10.');
  const v = { enabled, runOnDay };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, close_automation, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET close_automation = EXCLUDED.close_automation, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

// ─────────────────────────────────────────── owners

export async function assignments(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(`SELECT a.step, a.owner_id, a.due_day, u.name AS owner_name, u.email AS owner_email FROM close_assignment a LEFT JOIN app_user u ON u.id = a.owner_id WHERE a.org_id = $1`, [orgId]));
  return STEPS.map((step) => {
    const a = rows.find((r) => r.step === step);
    return { step, label: LABEL[step], ownerId: a?.owner_id ?? null, owner: a?.owner_name ?? null, ownerEmail: a?.owner_email ?? null, dueDay: a?.due_day ?? DEFAULT_DUE_DAY };
  });
}

/** Set steps' owners and due days: [{step, ownerId, dueDay}]. */
export async function saveAssignments(orgId: string, raw: unknown) {
  if (!Array.isArray(raw) || !raw.length) throw ERR(422, 'assignments is a list of {step, ownerId, dueDay}.');
  const rows = raw.map((x: any) => {
    const step = String(x?.step ?? '') as Step;
    if (!STEPS.includes(step)) throw ERR(422, `step is one of ${STEPS.join(', ')}.`);
    const ownerId = x.ownerId == null || x.ownerId === '' ? null : String(x.ownerId);
    if (ownerId && !UUID_RE.test(ownerId)) throw ERR(422, 'ownerId is a user of your organisation.');
    const dueDay = x.dueDay == null || x.dueDay === '' ? DEFAULT_DUE_DAY : Number(x.dueDay);
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 20) throw ERR(422, 'dueDay is a working day after the month end, 1 to 20.');
    return { step, ownerId, dueDay };
  });
  const owners = [...new Set(rows.map((r) => r.ownerId).filter((x): x is string => !!x))];
  if (owners.length) {
    const ok = await outsideRequestScope(() => many<{ id: string }>(`SELECT id::text AS id FROM app_user WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgId, owners]));
    const bad = owners.filter((o) => !ok.some((u) => u.id === o));
    if (bad.length) throw ERR(422, 'ownerId is a user of your organisation.');
  }
  for (const r of rows) await outsideRequestScope(() => query(
    `INSERT INTO close_assignment (org_id, step, owner_id, due_day) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, step) DO UPDATE SET owner_id = EXCLUDED.owner_id, due_day = EXCLUDED.due_day, updated_at = now()`, [orgId, r.step, r.ownerId, r.dueDay]));
  return assignments(orgId);
}

/** A month's calendar: each step's owner, due date, check and sign-off. */
export async function calendar(orgId: string, monthRaw: unknown, now = new Date()) {
  const month = monthOk(monthRaw);
  const [st, as] = await Promise.all([(await import('./period-close.js')).status(orgId, month), assignments(orgId)]);
  const t = today(now);
  const steps = st.steps.map((s) => {
    const a = as.find((x) => x.step === s.step)!;
    const due = workingDay(month, a.dueDay);
    return { step: s.step, label: s.label, owner: a.owner, ownerId: a.ownerId, dueDay: a.dueDay, dueOn: due, ok: s.ok, detail: s.detail, done: s.complete, overdue: !s.complete && !st.locked && t > due };
  }).sort((a, b) => a.dueOn.localeCompare(b.dueOn) || STEPS.indexOf(a.step) - STEPS.indexOf(b.step));
  return { month, locked: st.locked, monthEnd: lastDay(month), steps, done: st.done, total: st.total, overdue: steps.filter((s) => s.overdue).length, lastDue: steps.reduce((m, s) => (s.dueOn > m ? s.dueOn : m), '') };
}

// ─────────────────────────────────────────── runs

type Action = { action: string; status: 'done' | 'skipped' | 'failed'; detail: string };

const runView = (r: any) => ({
  id: String(r.id), month: r.month, startedAt: new Date(r.started_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  by: r.by_name ?? null, automatic: r.automatic, actions: (r.actions ?? []) as Action[], blocking: r.blocking as number,
});

/** Run the close's mechanical steps for a month. */
export async function run(orgId: string, monthRaw: unknown, userId: string | null, automatic = false, now = new Date()) {
  const month = monthOk(monthRaw);
  if (month >= today(now).slice(0, 7)) throw ERR(422, 'Only a month that has ended is closed.');
  if (await isLocked(orgId, month)) throw ERR(409, `${month} is locked: there is nothing to run.`);
  const r0 = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO close_run (org_id, month, run_by, automatic, started_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [orgId, month, userId, automatic, now]));
  const actions: Action[] = [];
  const step = async (action: string, fn: () => Promise<string | null>) => {
    try {
      const d = await fn();
      actions.push(d == null ? { action, status: 'skipped', detail: 'Nothing to do' } : { action, status: 'done', detail: d });
    } catch (e) {
      actions.push({ action, status: 'failed', detail: (e as Error).message.slice(0, 300) });
    }
  };
  // Rates first (the ledger and consolidation use them), then the journals the ledger picks up, then the sync.
  await step('fx_rates', async () => {
    const fx = await import('./fx.js');
    const rep = await fx.reportingCurrency(orgId);
    if (!rep) return null;
    const have = (await fx.rates(orgId, month)).rates.map((r) => r.currency);
    const need = (await fx.currencies(orgId)).filter((c) => c !== rep && !have.includes(c));
    if (!need.length) return null;
    const got = await fx.fetchEcb(orgId, month, userId, now);
    return `${got.rates.length} rate(s) fetched${got.failed.length ? `; ${got.failed.map((f) => f.currency).join(', ')} failed` : ''}`;
  });
  await step('assets_recorded', async () => {
    const fa = await import('./fixed-assets.js');
    const done = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM fixed_asset_run WHERE org_id = $1 AND month = $2`, [orgId, month]));
    if (done?.n) return null;
    const any = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM fixed_asset WHERE org_id = $1 AND voided_at IS NULL AND acquired_on <= $2::date`, [orgId, lastDay(month)]));
    if (!any?.n) return null;
    await fa.record(orgId, month, userId, now);
    return 'Depreciation recorded';
  });
  await step('leases_recorded', async () => {
    const ls = await import('./leases.js');
    const done = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM lease_run WHERE org_id = $1 AND month = $2`, [orgId, month]));
    if (done?.n) return null;
    const any = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM lease WHERE org_id = $1 AND voided_at IS NULL AND exempt IS NULL AND start_month <= $2 AND (ended_month IS NULL OR ended_month >= $2)`, [orgId, month]));
    if (!any?.n) return null;
    await ls.record(orgId, month, userId, now);
    return 'Lease journal recorded';
  });
  await step('ledger_synced', async () => {
    const r = await (await import('./general-ledger.js')).sync(orgId, month, userId, now);
    return `Ledger synced: ${r.posted} posted, ${r.unchanged} unchanged, ${r.superseded} superseded`;
  });
  await step('anomalies_reviewed', async () => {
    const r = await (await import('./finance-checks.js')).run(orgId);
    return `Checks run: ${r.found} finding(s), ${r.added} new, ${r.cleared} cleared`;
  });
  const checks = await (await import('./period-close.js')).checks(orgId, month);
  const blocking = checks.filter((c) => !c.ok);
  for (const c of blocking) actions.push({ action: `blocking:${c.step}`, status: 'failed', detail: `${LABEL[c.step]}: ${c.detail}` });
  await outsideRequestScope(() => query(`UPDATE close_run SET finished_at = now(), actions = $3, blocking = $4 WHERE id = $1 AND org_id = $2`, [r0!.id, orgId, JSON.stringify(actions), blocking.length]));
  return runView(await outsideRequestScope(() => one<any>(`SELECT r.*, u.name AS by_name FROM close_run r LEFT JOIN app_user u ON u.id = r.run_by WHERE r.id = $1`, [r0!.id])));
}

export async function runs(orgId: string, monthRaw?: unknown) {
  const month = monthRaw == null || monthRaw === '' ? null : monthOk(monthRaw);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT r.*, u.name AS by_name FROM close_run r LEFT JOIN app_user u ON u.id = r.run_by WHERE r.org_id = $1 AND ($2::text IS NULL OR r.month = $2) ORDER BY r.started_at DESC, r.id DESC LIMIT 50`, [orgId, month]));
  return rows.map(runView);
}

/** Days from month end to lock, the last twelve months locked (a month reopened and locked again counts its last lock). */
export async function trend(orgId: string) {
  const rows = await outsideRequestScope(() => many<{ month: string; d: string }>(
    `SELECT DISTINCT ON (month) month, to_char((locked_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS d FROM finance_period_lock
      WHERE org_id = $1 AND reopened_at IS NULL ORDER BY month DESC, locked_at DESC LIMIT 12`, [orgId, zone()]));
  const months = rows.map((r) => ({ month: r.month, lockedOn: r.d, days: daysToClose(r.month, r.d) })).sort((a, b) => a.month.localeCompare(b.month));
  const avg = months.length ? Math.round((months.reduce((a, m) => a + m.days, 0) / months.length) * 10) / 10 : null;
  const recent = months.slice(-3), before = months.slice(-6, -3);
  const mean = (xs: typeof months) => (xs.length ? xs.reduce((a, m) => a + m.days, 0) / xs.length : null);
  const r = mean(recent), b = mean(before);
  return { months, averageDays: avg, best: months.length ? Math.min(...months.map((m) => m.days)) : null, improving: r != null && b != null ? r < b : null };
}

/** The tab: settings, this close's calendar (the previous month), recent runs, owners and the trend. */
export async function overview(orgId: string, monthRaw?: unknown, now = new Date()) {
  const month = monthRaw == null || monthRaw === '' ? prevMonth(today(now).slice(0, 7)) : monthOk(monthRaw);
  const [s, cal, rs, tr] = await Promise.all([settings(orgId), calendar(orgId, month, now), runs(orgId, month), trend(orgId)]);
  return { month, settings: s, nextRunOn: s.enabled && !cal.locked ? workingDay(month, s.runOnDay) : null, calendar: cal, runs: rs, trend: tr };
}

/** Daily: the automatic runs (once a day per organisation) and the overdue steps. */
export async function sweep(now = new Date()): Promise<number> {
  const t = today(now), month = prevMonth(t.slice(0, 7));
  const orgs = await outsideRequestScope(() => many<{ org_id: string; close_automation: any }>(`SELECT org_id, close_automation FROM finance_org_settings`));
  let n = 0;
  for (const o of orgs) {
    try {
      if (await isLocked(o.org_id, month)) {
        for (const s of STEPS) await outsideRequestScope(() => resolveAlertsFor(o.org_id, OVERDUE, 'close_step', `${month}:${s}`)).catch(() => 0);
        continue;
      }
      const c = o.close_automation ?? {};
      if (c.enabled === true && t >= workingDay(month, Number.isInteger(c.runOnDay) ? c.runOnDay : DEFAULT_RUN_DAY)) {
        const ran = await outsideRequestScope(() => one(`SELECT 1 FROM close_run WHERE org_id = $1 AND month = $2 AND automatic AND (started_at AT TIME ZONE $3)::date = $4::date`, [o.org_id, month, zone(), t]));
        if (!ran) { await run(o.org_id, month, null, true, now); n++; }
      }
      const as = await outsideRequestScope(() => one(`SELECT 1 FROM close_assignment WHERE org_id = $1 LIMIT 1`, [o.org_id]));
      if (!as) continue;
      const cal = await calendar(o.org_id, month, now);
      for (const s of cal.steps) {
        if (s.overdue) {
          await outsideRequestScope(() => persistAlert({ orgId: o.org_id, kind: OVERDUE, severity: 'warning', targetType: 'close_step', targetId: `${month}:${s.step}`,
            message: `Close ${month}: ${s.label} was due ${s.dueOn}${s.owner ? ` (${s.owner})` : ''} and is not signed off. ${s.detail}. Finance → Close automation.` }));
          n++;
        } else if (s.done) await outsideRequestScope(() => resolveAlertsFor(o.org_id, OVERDUE, 'close_step', `${month}:${s.step}`)).catch(() => 0);
      }
    } catch (e) { logger.warn({ org: o.org_id, err: (e as Error).message }, 'close automation sweep failed'); }
  }
  return n;
}
