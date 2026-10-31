import { many, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { methodName, type Account, type Period } from './finance.js';
import { settingsFor, type ContractRate } from './finance-journal.js';

/**
 * Gateway fee audit (v1.19.0): every fee the gateway charged on a payment, checked against the rate the operator agreed
 * with it for the method (Finance → Settings → Contracted rates; gateway_account_settings.contract_rates):
 *
 *   expected = 0 when the amount is at most freeUpTo (QRIS's 0% MDR up to Rp 100,000), else
 *              max(min, amount × pct / 100 + fixed)                         (excluding VAT, as the ledger's fee is)
 *   over     = the fee charged − expected, when more than 1 rupiah (rounding)
 *
 * By month and method: payments, fees charged, fees expected, the overcharge and how many payments it is on. Methods
 * without an agreed rate are listed, not judged. The overcharged payments export as CSV for the gateway's account
 * manager (with the gateway's own ids). Undercharges are not counted: they are the gateway's to claim.
 */

export const TOLERANCE = 1;

export function expectedFee(amount: number, r: ContractRate): number {
  if (r.freeUpTo != null && amount <= r.freeUpTo) return 0;
  const fee = (amount * r.pct) / 100 + (r.fixed ?? 0);
  return Math.round(Math.max(r.min ?? 0, fee) * 100) / 100;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function audit(a: Account, p: Period) {
  const settings = await settingsFor(a);
  const rates = settings.contractRates;
  const zone = config.billing.timeZone;
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT id, external_id, reference_id, to_char(gateway_created_at AT TIME ZONE $4, 'YYYY-MM') AS month, gateway_created_at,
            upper(COALESCE(channel_code, channel_category, 'OTHER')) AS channel, amount, fee
       FROM gateway_transaction
      WHERE integration_id = $1 AND kind = 'payment' AND status = 'success' AND cashflow = 'in' AND gateway_created_at >= $2 AND gateway_created_at < $3
      ORDER BY gateway_created_at`, [a.id, p.from, p.to, zone]));
  type Group = { month: string; method: string; payments: number; amount: number; charged: number; expected: number; over: number; overCount: number; rated: boolean };
  const groups = new Map<string, Group>();
  const overcharged: Array<{ id: string; externalId: string; reference: string | null; at: string; method: string; amount: number; charged: number; expected: number; over: number }> = [];
  const unrated = new Set<string>();
  for (const t of rows) {
    const method = methodName(t.channel);
    const rate = rates[method];
    const amount = Number(t.amount), charged = Number(t.fee);
    const k = `${t.month}|${method}`;
    const g = groups.get(k) ?? { month: t.month, method, payments: 0, amount: 0, charged: 0, expected: 0, over: 0, overCount: 0, rated: Boolean(rate) };
    g.payments++; g.amount += amount; g.charged += charged;
    if (rate) {
      const exp = expectedFee(amount, rate);
      g.expected += exp;
      const over = charged - exp;
      if (over > TOLERANCE) {
        g.over += over; g.overCount++;
        if (overcharged.length < 5000) {
          overcharged.push({ id: String(t.id), externalId: t.external_id, reference: t.reference_id ?? null, at: new Date(t.gateway_created_at).toISOString(), method, amount, charged: r2(charged), expected: exp, over: r2(over) });
        }
      }
    } else unrated.add(method);
    groups.set(k, g);
  }
  const byMonth = [...groups.values()].sort((x, y) => y.month.localeCompare(x.month) || y.amount - x.amount).map((g) => ({
    ...g, amount: r2(g.amount), charged: r2(g.charged), expected: g.rated ? r2(g.expected) : null, over: r2(g.over),
    effectiveRate: g.amount ? g.charged / g.amount : null, agreed: rates[g.method] ?? null,
  }));
  const totalOver = r2(byMonth.reduce((s, g) => s + g.over, 0));
  return {
    account: { id: a.id, label: a.label, provider: a.provider },
    rates, tolerance: TOLERANCE,
    rated: Object.keys(rates).length > 0,
    unrated: [...unrated].sort(),
    totals: { payments: rows.length, overcharge: totalOver, overcharged: overcharged.length },
    byMonth,
    overcharged: overcharged.sort((x, y) => y.over - x.over).slice(0, 500),
    _all: overcharged,
  };
}

/** The overcharged payments as CSV, for the claim (the gateway's ids, the amount, what was charged and agreed). */
export function auditCsv(r: Awaited<ReturnType<typeof audit>>): string {
  const cell = (v: unknown) => { const s = v == null ? '' : String(v); const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
  const head = ['Date', 'Gateway transaction id', 'Reference', 'Method', 'Amount', 'Fee charged (excl. VAT)', 'Fee agreed (excl. VAT)', 'Overcharge'];
  const rows = r._all.map((x) => [x.at, x.externalId, x.reference ?? '', x.method, x.amount, x.charged, x.expected, x.over]);
  rows.push(['', '', '', 'TOTAL', '', '', '', r.totals.overcharge]);
  return '﻿' + [head, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
