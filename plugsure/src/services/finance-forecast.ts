import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { receivables, payables, type Account } from './finance.js';
import { ownerShares } from './payouts.js';

/**
 * Cash-flow forecast (v1.19.0), per payments account, over the next 30, 60 or 90 days.
 *
 *   Opening    the gateway's balance (its last snapshot) plus the operator's bank balance (the last line with a balance
 *              on an uploaded bank statement, v1.18.0); either may be unknown, and is then left out and said so.
 *   In         settlements the gateway expects (Finance's ledger, by expected day; overdue ones today), fleet invoices
 *              by due date, Hub positions owed to the operator by due date, and post-pay sessions not charged yet
 *              (today). Optionally, a run rate: the average daily net collected over the last 28 days, as an estimate.
 *   Out        refunds due (today), site owners' shares not paid in full and PlugSure's statements to the operator not
 *              paid in full (finalisation + the payment terms, default 14 days; overdue ones today), Hub positions the
 *              operator owes by due date.
 *
 * Every day carries its flows and the running position; the first day the position goes below zero is the shortfall.
 * A forecast, not a ledger: committed flows are what PlugSure knows of; the run rate is labelled an estimate.
 */

export class ForecastError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export interface Flow { day: string; kind: string; label: string; amount: number; estimate?: boolean }

const DAY = 86_400_000;
const ymdIn = (d: Date, zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const asDay = (v: unknown, zone: string): string | null => {
  if (v == null) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : ymdIn(d, zone);
};

export async function forecast(a: Account, opts: { days?: unknown; termsDays?: unknown; runRate?: unknown } = {}, now = new Date()) {
  const days = Number(opts.days ?? 30);
  if (![30, 60, 90].includes(days)) throw new ForecastError(400, 'days is 30, 60 or 90.');
  const terms = opts.termsDays == null || opts.termsDays === '' ? 14 : Number(opts.termsDays);
  if (!Number.isInteger(terms) || terms < 0 || terms > 120) throw new ForecastError(400, 'termsDays is 0 to 120.');
  const withRunRate = opts.runRate === true || opts.runRate === 'true';
  const zone = config.billing.timeZone;
  const today = ymdIn(now, zone);
  const last = ymdIn(new Date(now.getTime() + (days - 1) * DAY), zone);
  const clamp = (d: string | null) => (!d || d < today ? today : d);
  const due = (from: unknown, plus: number) => {
    const d = from ? new Date(from as string) : now;
    return clamp(ymdIn(new Date(d.getTime() + plus * DAY), zone));
  };

  const [rec, pay, gw, bank, rate, platform] = await Promise.all([
    receivables(a.id, a.orgId),
    payables(a.id, a.orgId),
    outsideRequestScope(() => one<{ balance: string; taken_at: Date }>(
      `SELECT balance, taken_at FROM gateway_balance_snapshot WHERE integration_id = $1 ORDER BY taken_at DESC LIMIT 1`, [a.id])),
    a.orgId ? outsideRequestScope(() => one<{ balance_minor: string; d: string }>(
      `SELECT balance_minor, to_char(line_date, 'YYYY-MM-DD') AS d FROM bank_statement_line
        WHERE org_id = $1 AND balance_minor IS NOT NULL ORDER BY line_date DESC, line_no DESC, id DESC LIMIT 1`, [a.orgId])) : Promise.resolve(null),
    outsideRequestScope(() => one<{ net: string }>(
      `SELECT COALESCE(sum(COALESCE(net_amount, amount)), 0) AS net FROM gateway_transaction
        WHERE integration_id = $1 AND status = 'success' AND cashflow = 'in' AND kind = 'payment' AND gateway_created_at >= now() - interval '28 days'`, [a.id])),
    // An operator's own account: PlugSure's statements to it, not paid in full.
    a.orgId ? outsideRequestScope(() => many<any>(
      `SELECT s.number, s.total_minor, s.finalised_at,
              COALESCE((SELECT sum(amount_minor) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL), 0)::bigint AS paid
         FROM commission_statement s WHERE s.org_id = $1 AND s.owner_id IS NULL AND s.finalised_at IS NOT NULL AND s.total_minor > 0`, [a.orgId])) : Promise.resolve([]),
  ]);

  const flows: Flow[] = [];
  const add = (day: string | null, kind: string, label: string, amount: number, estimate = false) => {
    const d = clamp(day);
    if (d > last || !amount) return;
    flows.push({ day: d, kind, label, amount: Math.round(amount), ...(estimate ? { estimate: true } : {}) });
  };

  // In.
  for (const b of rec.byDay) add(b.day, 'settlement', `${a.label}: settlement of ${b.count} payment${b.count === 1 ? '' : 's'}${b.overdue ? ' (overdue)' : ''}`, b.net);
  if (!rec.byDay.length && rec.total) add(today, 'settlement', `${a.label}: settlements pending`, rec.total);
  for (const f of rec.fleetInvoices) add(asDay(f.dueDate, zone), 'fleet_invoice', `Fleet invoice ${f.number} · ${f.account ?? ''}${f.overdue ? ' (overdue)' : ''}`, f.total);
  for (const h of rec.hubPositions) add(asDay(h.dueDate, zone), 'hub_in', `Hub settlement from ${h.counterparty ?? 'a partner'}`, h.outstanding);
  if (rec.postpay.amount) add(today, 'postpay', `${rec.postpay.count} post-pay session${rec.postpay.count === 1 ? '' : 's'} to charge`, rec.postpay.amount);
  const daily = Number(rate?.net ?? 0) / 28;
  if (withRunRate && daily > 0) {
    for (let i = 1; i < days; i++) add(ymdIn(new Date(now.getTime() + i * DAY), zone), 'run_rate', 'Collections at the last 28 days\' average', daily, true);
  }

  // Out.
  for (const r of pay.refunds) add(today, 'refund', `Refund due${r.operator ? ` · ${r.operator}` : ''}${r.state === 'failed' ? ' (failed, to redo)' : ''}`, -r.amount);
  // An operator's own account pays its own owners; the platform's, the owners of the operators whose payments it took.
  const shares = a.orgId
    ? (await ownerShares(a.orgId, { limit: 500 })).map((s) => ({ owner: s.owner, period: s.period, left: s.outstanding, finalisedAt: s.finalisedAt }))
    : pay.ownerShares.map((s) => ({ owner: s.owner, period: (asDay(s.period, zone) ?? String(s.period)).slice(0, 7), left: s.amount - s.paid, finalisedAt: s.finalisedAt }));
  for (const s of shares) if (s.left > 0) add(due(s.finalisedAt, terms), 'owner_payout', `Owner share · ${s.owner} · ${s.period}`, -s.left);
  for (const p of platform) {
    const left = Number(p.total_minor) - Number(p.paid);
    if (left > 0) add(due(p.finalised_at, terms), 'platform_statement', `PlugSure statement ${p.number}`, -left);
  }
  for (const h of pay.hubPositions) add(asDay(h.dueDate, zone), 'hub_out', `Hub settlement to ${h.counterparty ?? 'a partner'}`, -h.outstanding);

  flows.sort((x, y) => x.day.localeCompare(y.day) || y.amount - x.amount);
  const gatewayBalance = gw ? Math.round(Number(gw.balance)) : null;
  const bankBalance = bank ? Number(bank.balance_minor) : null;
  const opening = (gatewayBalance ?? 0) + (bankBalance ?? 0);
  const byDay = new Map<string, { in: number; out: number; estimate: number }>();
  for (const f of flows) {
    const d = byDay.get(f.day) ?? { in: 0, out: 0, estimate: 0 };
    if (f.estimate) d.estimate += f.amount; else if (f.amount > 0) d.in += f.amount; else d.out += f.amount;
    byDay.set(f.day, d);
  }
  let pos = opening, low = opening, lowDay = today;
  let shortfall: { day: string; position: number } | null = null;
  const series: Array<{ day: string; in: number; out: number; estimate: number; position: number }> = [];
  for (let i = 0; i < days; i++) {
    const day = ymdIn(new Date(now.getTime() + i * DAY), zone);
    const d = byDay.get(day) ?? { in: 0, out: 0, estimate: 0 };
    pos += d.in + d.out + d.estimate;
    series.push({ day, in: d.in, out: d.out, estimate: d.estimate, position: pos });
    if (pos < low) { low = pos; lowDay = day; }
    if (pos < 0 && !shortfall) shortfall = { day, position: pos };
  }
  const sum = (k: (f: Flow) => boolean) => flows.filter(k).reduce((s, f) => s + f.amount, 0);
  return {
    account: { id: a.id, label: a.label }, days, termsDays: terms, runRate: withRunRate, from: today, to: last,
    opening: {
      total: opening,
      gateway: gatewayBalance, gatewayAt: gw ? new Date(gw.taken_at).toISOString() : null,
      bank: bankBalance, bankAsOf: bank?.d ?? null,
    },
    totals: { in: sum((f) => f.amount > 0 && !f.estimate), out: sum((f) => f.amount < 0), estimate: sum((f) => Boolean(f.estimate)) },
    closing: pos, lowest: { day: lowDay, position: low }, shortfall,
    dailyRunRate: Math.round(daily),
    series,
    flows: flows.filter((f) => f.kind !== 'run_rate'),
  };
}

/** The forecast's flows as CSV (day, kind, label, amount, running position). */
export function forecastCsv(f: Awaited<ReturnType<typeof forecast>>): string {
  const cell = (v: unknown) => { const s = v == null ? '' : String(v); const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
  const pos = new Map(f.series.map((d) => [d.day, d.position]));
  const rows = [['Day', 'Kind', 'Description', 'Amount', 'Position at end of day'], ['', 'opening', 'Opening position (gateway balance + bank balance)', f.opening.total, '']];
  for (const x of f.flows) rows.push([x.day, x.kind, x.label, x.amount, pos.get(x.day) ?? '']);
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
