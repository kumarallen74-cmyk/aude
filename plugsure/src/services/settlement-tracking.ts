import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { opsAlertOrgs } from './worker-health.js';
import type { Account } from './finance.js';
import { moneyText, currencyOr } from '../domain/money.js';

/**
 * Gateway settlement tracking (v1.23.0), per payments account, from the gateway's own ledger (Finance's sync):
 *
 *   settlements   the payments the gateway said it would settle on a day (its estimated settlement date), the net
 *                 expected (after fees, VAT and withholding), what it has marked settled and what is still pending.
 *                 A day more than the grace days past (default 2) with something still pending is LATE.
 *   withdrawals   each payout from the gateway balance to the bank, and the bank statement line it was matched to
 *                 (Finance → Bank reconciliation): in the bank; SHORT when the bank line is less than the payout; MISSING when bank
 *                 statements cover the days after it (the withdrawal days, default 3) and no line was matched;
 *                 otherwise waiting for the statement.
 *
 * The worker raises finance.settlement_late and finance.withdrawal_missing on the account (the operator's, or the
 * platform's operations organisations for PlugSure's own account) and clears them when it is put right.
 */

export class SettlementError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const zone = () => config.billing.timeZone;
const localDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface TrackingSettings { graceDays: number; withdrawalDays: number }

export async function settings(orgId: string | null): Promise<TrackingSettings> {
  const r = orgId ? await outsideRequestScope(() => one<{ settlement_tracking: any }>(`SELECT settlement_tracking FROM finance_org_settings WHERE org_id = $1`, [orgId])) : null;
  const v = r?.settlement_tracking ?? {};
  return { graceDays: Number(v.graceDays ?? 2), withdrawalDays: Number(v.withdrawalDays ?? 3) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<TrackingSettings> {
  const cur = await settings(orgId);
  const g = b.graceDays == null || b.graceDays === '' ? cur.graceDays : Number(b.graceDays);
  const w = b.withdrawalDays == null || b.withdrawalDays === '' ? cur.withdrawalDays : Number(b.withdrawalDays);
  if (!Number.isInteger(g) || g < 0 || g > 14) throw new SettlementError(422, 'Grace days are 0 to 14.');
  if (!Number.isInteger(w) || w < 1 || w > 14) throw new SettlementError(422, 'Withdrawal days are 1 to 14.');
  const v = { graceDays: g, withdrawalDays: w };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, settlement_tracking, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET settlement_tracking = EXCLUDED.settlement_tracking, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/**
 * The account's settlements (45 days back, 14 ahead) and withdrawals (45 days). `bankOrgId` is whose bank statements
 * the withdrawals are looked for in (the caller's organisation).
 */
export async function overview(a: Pick<Account, 'id' | 'orgId'>, bankOrgId: string, now = new Date()) {
  const st = await settings(a.orgId ?? bankOrgId);
  const today = localDay(now), from = addDays(today, -45), to = addDays(today, 14);
  const z = zone();
  const [days, wds, cover] = await Promise.all([
    outsideRequestScope(() => many<{ day: string; currency: string; n: number; expected: string; settled: string; pending_n: number }>(
      `SELECT to_char(estimated_settlement_at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, currency, count(*)::int AS n,
              COALESCE(sum(net_amount), 0) AS expected,
              COALESCE(sum(net_amount) FILTER (WHERE settlement_status IN ('settled', 'early_settled')), 0) AS settled,
              count(*) FILTER (WHERE settlement_status NOT IN ('settled', 'early_settled'))::int AS pending_n
         FROM gateway_transaction
        WHERE integration_id = $1 AND kind = 'payment' AND status = 'success' AND estimated_settlement_at IS NOT NULL
          AND (estimated_settlement_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        GROUP BY 1, 2 ORDER BY 1`, [a.id, from, to, z])),
    outsideRequestScope(() => many<any>(
      `SELECT g.id::text AS id, g.external_id, g.currency, round(g.amount)::bigint AS amount, to_char(g.gateway_created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day,
              l.id AS line_id, l.amount_minor AS line_amount, to_char(l.line_date, 'YYYY-MM-DD') AS line_day
         FROM gateway_transaction g
         LEFT JOIN bank_statement_line l ON l.org_id = $4 AND l.matched_kind = 'gateway_withdrawal' AND l.matched_ref = g.id::text
        WHERE g.integration_id = $1 AND g.kind = 'payout' AND g.status = 'success' AND (g.gateway_created_at AT TIME ZONE $3)::date >= $2::date
        ORDER BY g.gateway_created_at DESC LIMIT 300`, [a.id, from, z, bankOrgId])),
    outsideRequestScope(() => one<{ d: string | null }>(`SELECT to_char(max(line_date), 'YYYY-MM-DD') AS d FROM bank_statement_line WHERE org_id = $1`, [bankOrgId])),
  ]);
  const settlements = days.map((d) => {
    const expected = Math.round(Number(d.expected)), settled = Math.round(Number(d.settled));
    const pending = expected - settled;
    const late = d.pending_n > 0 && d.day < addDays(today, -st.graceDays);
    return {
      day: d.day, currency: d.currency, payments: d.n, expected, settled, pending, pendingPayments: d.pending_n,
      state: d.pending_n === 0 ? 'settled' : late ? 'late' : d.day > today ? 'upcoming' : 'due',
    };
  });
  const coveredTo = cover?.d ?? null;
  const withdrawals = wds.map((w) => {
    const amount = Number(w.amount), bank = w.line_amount == null ? null : Number(w.line_amount);
    const state = bank != null ? (bank < amount ? 'short' : 'in_bank')
      : coveredTo && coveredTo >= addDays(w.day, st.withdrawalDays) ? 'missing' : 'awaiting_statement';
    return { id: w.id, reference: w.external_id, day: w.day, currency: w.currency, amount, bankAmount: bank, bankDay: w.line_day ?? null, shortBy: bank != null && bank < amount ? amount - bank : 0, state };
  });
  const sum = (xs: Array<{ currency: string }>, k: string) => {
    const t: Record<string, number> = {};
    for (const x of xs as any[]) t[x.currency] = (t[x.currency] ?? 0) + Number(x[k]);
    return t;
  };
  const lateRows = settlements.filter((s) => s.state === 'late');
  return {
    today, settings: st, bankStatementsTo: coveredTo, settlements, withdrawals,
    summary: {
      late: { days: lateRows.length, amount: sum(lateRows, 'pending') },
      upcoming: sum(settlements.filter((s) => s.state === 'upcoming' || s.state === 'due'), 'pending'),
      missing: withdrawals.filter((w) => w.state === 'missing').length,
      short: withdrawals.filter((w) => w.state === 'short').length,
    },
  };
}

/** The worker: every account with gateway transactions; alert late settlements and missing (or short) withdrawals. */
export async function check(now = new Date()): Promise<number> {
  const accts = await outsideRequestScope(() => many<{ id: string; org_id: string | null }>(
    `SELECT i.id, i.org_id FROM integration i WHERE i.archived_at IS NULL AND EXISTS (SELECT 1 FROM gateway_transaction g WHERE g.integration_id = i.id)`));
  let n = 0;
  for (const a of accts) {
    try {
      const orgs = a.org_id ? [a.org_id] : await opsAlertOrgs();
      for (const o of orgs) {
        const v = await overview({ id: a.id, orgId: a.org_id }, o, now);
        const late = v.summary.late;
        if (late.days) {
          n++;
          await outsideRequestScope(() => persistAlert({ orgId: o, kind: 'finance.settlement_late', severity: 'warning', targetType: 'payments_account', targetId: a.id,
            message: `The gateway has not settled ${Object.entries(late.amount).map(([c, x]) => moneyText(x, currencyOr(c))).join(', ')} expected on ${late.days} day(s) (Finance → Settlements).` }));
        } else await outsideRequestScope(() => resolveAlertsFor(o, 'finance.settlement_late', 'payments_account', a.id)).catch(() => 0);
        const bad = v.withdrawals.filter((w) => w.state === 'missing' || w.state === 'short');
        if (bad.length) {
          n++;
          await outsideRequestScope(() => persistAlert({ orgId: o, kind: 'finance.withdrawal_missing', severity: 'warning', targetType: 'payments_account', targetId: a.id,
            message: `${bad.length} withdrawal(s) from the gateway to the bank ${bad.some((w) => w.state === 'short') ? 'arrived short or ' : ''}are not on the bank statement (Finance → Settlements).` }));
        } else await outsideRequestScope(() => resolveAlertsFor(o, 'finance.withdrawal_missing', 'payments_account', a.id)).catch(() => 0);
      }
    } catch (e) { logger.warn({ account: a.id, err: (e as Error).message }, 'settlement check failed'); }
  }
  return n;
}
