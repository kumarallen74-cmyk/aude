import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { reportingCurrency, currencies } from './fx.js';

/**
 * Month lock (v1.22.0). Once the accountant has closed a month (Finance → Month close), Finance locks it: the finance
 * entries dated in it can no longer be added, changed or voided —
 *
 *   energy bills          (Finance → Energy margin)        for the month
 *   exchange rates        (Settings → Currencies)   for the month, typed or fetched
 *   budgets               (Finance → Budgets)       for the month, saved or copied into
 *   site investments      (Finance → Site investments)   dated in the month, recorded or voided
 *
 * so the figures the accountant booked stay the ones Finance shows. Only a month that has ended can be locked.
 * Reopening it takes `finance:approve` (a Finance Manager or the owner) and a reason; the lock row keeps who closed
 * and who reopened it, and a month can be locked again afterwards.
 *
 * Before locking, the checklist shows what is still open for the month: sites whose margin uses an estimate (no bill),
 * currencies without a rate into the reporting currency, and bank statement lines not matched.
 */

export class PeriodError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);

/** The month a date (YYYY-MM-DD) falls in. */
export const monthOf = (ymd: string) => ymd.slice(0, 7);

/** Whether a month is locked for an organisation. */
export async function isLocked(orgId: string, month: string): Promise<boolean> {
  const r = await outsideRequestScope(() => one(`SELECT 1 FROM finance_period_lock WHERE org_id = $1 AND month = $2 AND reopened_at IS NULL`, [orgId, month]));
  return !!r;
}

/**
 * Refuse a change dated in a locked month: `err` builds the caller's own error (so its route answers it as usual).
 * `what` names the entry ("An energy bill", "A budget").
 */
export async function assertOpen<E extends Error>(orgId: string, month: string, what: string, err: (status: number, msg: string) => E): Promise<void> {
  if (await isLocked(orgId, month)) throw err(409, `${what} for ${month} cannot be changed: the month is locked (Finance → Month close). A Finance Manager can reopen it.`);
}

/** The locked months among a list. */
export async function lockedAmong(orgId: string, months: string[]): Promise<string[]> {
  if (!months.length) return [];
  const rows = await outsideRequestScope(() => many<{ month: string }>(
    `SELECT month FROM finance_period_lock WHERE org_id = $1 AND month = ANY($2::text[]) AND reopened_at IS NULL`, [orgId, months]));
  return rows.map((r) => r.month).sort();
}

const lastN = (n: number, now = new Date()) => {
  let [y, m] = thisMonth(now).split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < n; i++) { out.push(`${y}-${String(m).padStart(2, '0')}`); m--; if (m === 0) { m = 12; y--; } }
  return out;
};

/** The checklist of a month: what is still open before it is locked. */
export async function checklist(orgId: string, monthRaw: unknown) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new PeriodError(422, 'month is YYYY-MM.');
  const [noBill, reporting, curs, bank] = await Promise.all([
    outsideRequestScope(() => many<{ id: string; name: string }>(
      `SELECT s.id, s.name FROM site s
        WHERE s.org_id = $1 AND s.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM site_energy_cost b WHERE b.site_id = s.id AND b.month = $2 AND b.voided_at IS NULL)
          AND EXISTS (SELECT 1 FROM charging_session cs WHERE cs.site_id = s.id AND to_char(cs.started_at AT TIME ZONE $3, 'YYYY-MM') = $2)
        ORDER BY s.name`, [orgId, month, zone()])),
    reportingCurrency(orgId),
    currencies(orgId),
    outsideRequestScope(() => one<{ n: number }>(
      `SELECT count(*)::int AS n FROM bank_statement_line WHERE org_id = $1 AND matched_kind IS NULL AND to_char(line_date, 'YYYY-MM') = $2`, [orgId, month])),
  ]);
  let fxMissing: string[] = [];
  if (reporting) {
    const have = await outsideRequestScope(() => many<{ currency: string }>(`SELECT currency FROM fx_rate WHERE org_id = $1 AND month = $2 AND reporting = $3`, [orgId, month, reporting]));
    const set = new Set(have.map((h) => h.currency));
    fxMissing = curs.filter((c) => c !== reporting && !set.has(c));
  }
  const items = [
    { key: 'energy_bills', ok: noBill.length === 0, label: noBill.length ? `${noBill.length} site(s) with sessions have no energy bill (their margin is an estimate)` : 'Every site with sessions has its energy bill', sites: noBill.map((s) => ({ id: s.id, name: s.name })) },
    { key: 'fx_rates', ok: fxMissing.length === 0, label: !reporting ? 'No reporting currency (nothing to convert)' : fxMissing.length ? `No rate into ${reporting} for ${fxMissing.join(', ')}` : `Every currency has a rate into ${reporting}`, missing: fxMissing },
    { key: 'bank_lines', ok: (bank?.n ?? 0) === 0, label: bank?.n ? `${bank.n} bank statement line(s) not matched` : 'Every bank statement line is matched', count: bank?.n ?? 0 },
  ];
  return { month, items, ready: items.every((i) => i.ok) };
}

/** The last 24 months: locked or open, who locked or reopened them. */
export async function list(orgId: string, now = new Date()) {
  const months = lastN(24, now);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT l.*, lu.name AS locked_by_name, ru.name AS reopened_by_name FROM finance_period_lock l
       LEFT JOIN app_user lu ON lu.id = l.locked_by LEFT JOIN app_user ru ON ru.id = l.reopened_by
      WHERE l.org_id = $1 AND l.month = ANY($2::text[]) ORDER BY l.locked_at DESC`, [orgId, months]));
  const current = thisMonth(now);
  return {
    months: months.map((m) => {
      const hist = rows.filter((r) => r.month === m);
      const live = hist.find((r) => !r.reopened_at);
      return {
        month: m, locked: !!live, lockable: m < current,
        lockedBy: live?.locked_by_name ?? null, lockedAt: live ? new Date(live.locked_at).toISOString() : null, note: live?.note ?? null,
        history: hist.map((r) => ({
          lockedBy: r.locked_by_name ?? null, lockedAt: new Date(r.locked_at).toISOString(), note: r.note ?? null,
          reopenedBy: r.reopened_by_name ?? null, reopenedAt: r.reopened_at ? new Date(r.reopened_at).toISOString() : null, reopenReason: r.reopen_reason ?? null,
        })),
      };
    }),
  };
}

export async function lock(orgId: string, monthRaw: unknown, noteRaw: unknown, userId: string | null, now = new Date()) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new PeriodError(422, 'month is YYYY-MM.');
  if (month >= thisMonth(now)) throw new PeriodError(409, `${month} has not ended yet: only a past month can be locked.`);
  const note = noteRaw == null || noteRaw === '' ? null : String(noteRaw).trim().slice(0, 300);
  try {
    const r = await outsideRequestScope(() => one<{ id: string }>(
      `INSERT INTO finance_period_lock (org_id, month, locked_by, note) VALUES ($1, $2, $3, $4) RETURNING id`, [orgId, month, userId, note]));
    return { id: String(r!.id), month, locked: true };
  } catch (e) {
    if ((e as any).code === '23505') throw new PeriodError(409, `${month} is already locked.`);
    throw e;
  }
}

export async function reopen(orgId: string, monthRaw: unknown, reasonRaw: unknown, userId: string | null, canApprove: boolean) {
  if (!canApprove) throw new PeriodError(403, 'Only a Finance Manager (finance:approve) can reopen a locked month.');
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new PeriodError(422, 'month is YYYY-MM.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3 || reason.length > 300) throw new PeriodError(422, 'Say why the month is reopened (3 to 300 characters).');
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `UPDATE finance_period_lock SET reopened_at = now(), reopened_by = $3, reopen_reason = $4 WHERE org_id = $1 AND month = $2 AND reopened_at IS NULL RETURNING id`,
    [orgId, month, userId, reason]));
  if (!r) throw new PeriodError(409, `${month} is not locked.`);
  return { id: String(r.id), month, locked: false };
}

/** Run a change only when its month is open (helper for services without their own error class). */
export async function guard(orgId: string, month: string, what: string): Promise<void> {
  await assertOpen(orgId, month, what, (s, m) => new PeriodError(s, m));
}
