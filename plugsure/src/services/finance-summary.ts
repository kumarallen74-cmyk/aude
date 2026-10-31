import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { month as energyMonth, trend, lastMonths } from './energy-margin.js';
import { list as collectionsList } from './collections.js';
import { consolidate, reportingCurrency } from './fx.js';

/**
 * Finance → Summary (v1.21.0): an organisation's key figures, per currency (and in the reporting currency when set).
 *
 *   revenue      month to date, before tax; against last month to the same day and the same month last year
 *   margin       month to date: revenue − energy cost (bills or estimates, services/energy-margin.ts)
 *   DSO          days sales outstanding: what customers owe (Collections) ÷ the last 90 days' revenue per day
 *   cash         the gateways' last balances + the last uploaded bank statement's balance
 *   fee rate     the last 30 days' gateway fees and VAT on fees ÷ what was collected
 *   refund rate  the last 30 days' refunds ÷ what was collected
 *   trend        12 months of revenue and margin (sparklines)
 */

const zone = () => config.billing.timeZone;
const r1 = (n: number) => Math.round(n * 10) / 10;

async function revenueBetween(orgId: string, from: string, toExcl: string) {
  return outsideRequestScope(() => many<{ currency: string; revenue: string; kwh: string; sessions: number }>(
    `SELECT d.currency, COALESCE(sum(d.subtotal_minor), 0) AS revenue, COALESCE(sum(cs.energy_wh), 0) / 1000.0 AS kwh, count(*)::int AS sessions
       FROM cdr d JOIN charging_session cs ON cs.id = d.session_id
      WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND (d.issued_at AT TIME ZONE $4)::date >= $2::date AND (d.issued_at AT TIME ZONE $4)::date < $3::date
      GROUP BY 1`, [orgId, from, toExcl, zone()]));
}

const shift = (ymd: string, months: number) => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function summary(orgId: string, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
  const month = today.slice(0, 7), first = `${month}-01`, tomorrow = addDays(today, 1);
  const [mtd, lastMtd, lastYear, e, coll, tr, gw, bank, flows30, rev90, reporting] = await Promise.all([
    revenueBetween(orgId, first, tomorrow),
    revenueBetween(orgId, shift(first, -1), shift(tomorrow, -1) > shift(first, 0) ? shift(first, 0) : shift(tomorrow, -1)),
    revenueBetween(orgId, shift(first, -12), shift(tomorrow, -12)),
    energyMonth(orgId, month),
    collectionsList(orgId, false, now),
    trend(orgId, 12),
    outsideRequestScope(() => many<{ currency: string; balance: string }>(
      `SELECT DISTINCT ON (s.integration_id) s.currency, s.balance FROM gateway_balance_snapshot s JOIN integration i ON i.id = s.integration_id
        WHERE i.org_id = $1 ORDER BY s.integration_id, s.taken_at DESC`, [orgId])),
    outsideRequestScope(() => one<{ balance_minor: string; d: string }>(
      `SELECT balance_minor, to_char(line_date, 'YYYY-MM-DD') AS d FROM bank_statement_line WHERE org_id = $1 AND balance_minor IS NOT NULL ORDER BY line_date DESC, line_no DESC, id DESC LIMIT 1`, [orgId])),
    outsideRequestScope(() => many<{ currency: string; collected: string; fees: string; refunds: string }>(
      `SELECT currency,
              COALESCE(sum(amount) FILTER (WHERE kind = 'payment' AND cashflow = 'in'), 0) AS collected,
              COALESCE(sum(fee + vat) FILTER (WHERE kind = 'payment'), 0) AS fees,
              COALESCE(sum(amount) FILTER (WHERE kind = 'refund'), 0) AS refunds
         FROM gateway_transaction WHERE org_id = $1 AND status = 'success' AND gateway_created_at >= now() - interval '30 days' GROUP BY 1`, [orgId])),
    revenueBetween(orgId, addDays(today, -89), tomorrow),
    reportingCurrency(orgId),
  ]);
  const by = <T extends { currency: string }>(rows: T[], k: keyof T) => Object.fromEntries(rows.map((r) => [r.currency, Number(r[k])]));
  const curs = new Set<string>([...mtd, ...lastMtd, ...rev90].map((r) => r.currency));
  for (const c of Object.keys(e.totals)) curs.add(c);
  for (const r of coll.receivables) curs.add(r.currency);
  const owed: Record<string, number> = {};
  for (const r of coll.receivables) owed[r.currency] = (owed[r.currency] ?? 0) + r.outstanding;
  const rMtd = by(mtd, 'revenue'), rLast = by(lastMtd, 'revenue'), rYear = by(lastYear, 'revenue'), r90 = by(rev90, 'revenue');
  const kwhMtd = by(mtd, 'kwh');
  const change = (a: number, b: number) => (b ? r1(((a - b) / b) * 100) : null);
  // The bank statement carries no currency: it is counted once, in the gateway's currency (else the first one).
  const bankCurrency = gw[0]?.currency ?? [...curs].sort()[0];
  const perCurrency = [...curs].sort().map((c) => {
    const f = flows30.find((x) => x.currency === c);
    const collected = Number(f?.collected ?? 0);
    const t = e.totals[c];
    return {
      currency: c,
      revenue: { mtd: rMtd[c] ?? 0, lastMonthToDate: rLast[c] ?? 0, vsLastMonthPct: change(rMtd[c] ?? 0, rLast[c] ?? 0), sameMonthLastYear: rYear[c] ?? 0, vsLastYearPct: change(rMtd[c] ?? 0, rYear[c] ?? 0) },
      kwhMtd: r1(kwhMtd[c] ?? 0),
      margin: t ? { mtd: t.margin, energyCost: t.energyCost, pct: t.revenue ? r1((t.margin / t.revenue) * 100) : null, unknownSites: t.unknownSites } : null,
      receivables: owed[c] ?? 0,
      dso: (r90[c] ?? 0) > 0 ? Math.round((owed[c] ?? 0) / ((r90[c] ?? 0) / 90)) : null,
      cash: { gateways: gw.filter((g) => g.currency === c).reduce((a, g) => a + Number(g.balance), 0), bank: bank && c === bankCurrency ? Number(bank.balance_minor) : null, bankAsOf: bank?.d ?? null },
      feeRatePct: collected ? r1((Number(f!.fees) / collected) * 100) : null,
      refundRatePct: collected ? r1((Number(f!.refunds) / collected) * 100) : null,
      trend: tr.months.filter((x) => x.currency === c).sort((a, b) => a.month.localeCompare(b.month)).map((x) => ({ month: x.month, revenue: x.revenue, margin: x.margin, estimated: x.estimated })),
    };
  });
  const consolidated = reporting ? {
    currency: reporting,
    revenueMtd: await consolidate(orgId, month, rMtd),
    marginMtd: await consolidate(orgId, month, Object.fromEntries(perCurrency.map((p) => [p.currency, p.margin?.mtd ?? 0]))),
    receivables: await consolidate(orgId, month, owed),
  } : null;
  return { asOf: today, month, months: lastMonths(12).reverse(), perCurrency, consolidated };
}
