import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { refundWindowDays, refundDaysLeft } from './refund-windows.js';
import { xlsx } from './xlsx.js';

/**
 * Driver funds (v1.28.0): the money drivers paid ahead that the operator holds, as a liability, per currency.
 * A driver pays before charging (QRIS, e-wallet, card); the charge record takes what was used, and what is left is
 * the driver's until refunded. From the payments themselves:
 *
 *   in use        paid for a charge that has not ended yet
 *   unused        paid, charged less: left over, not refunded and no refund due — owed to the driver
 *   refund due    a refund approved and not paid yet
 *   breakage      unused balances older than the breakage days (default 180): unlikely to be claimed; recognising a
 *                 month's breakage moves it to revenue (once per month and currency), and it leaves the liability
 *   loyalty       points earned and not used or expired, at the programme's point value
 *
 * For a month, the movement: collected, used by charging, refunded, breakage recognised; and the gateway's view of the
 * same payments (the ledger synced in Finance) to reconcile. Test payments are left out.
 */

export class DriverFundsError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const localDay = (t: Date | number = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date(t));

export async function settings(orgId: string) {
  const r = await outsideRequestScope(() => one<{ driver_funds: any }>(`SELECT driver_funds FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  return { breakageDays: Number(r?.driver_funds?.breakageDays ?? 180) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const d = Number(b.breakageDays);
  if (!Number.isInteger(d) || d < 30 || d > 1825) throw new DriverFundsError(422, 'Breakage after 30 to 1825 days.');
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, driver_funds, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET driver_funds = EXCLUDED.driver_funds, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify({ breakageDays: d }), userId]));
  return { breakageDays: d };
}

interface Row { id: string; currency: string; captured: number; used: number; refunded: number; due: number; paidAt: Date; ended: boolean; provider: string | null; channel: string | null; month: string; recognised: boolean }

/** Every prepaid payment with its use (the charge records of its sessions), refunds and whether its charge ended. */
async function payments(orgId: string): Promise<Row[]> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT pi.id, pi.currency, pi.amount_captured_minor, COALESCE(pi.refunded_minor, 0) AS refunded,
            CASE WHEN pi.refund_state IN ('due', 'processing', 'failed') THEN COALESCE(pi.refund_due_minor, 0) ELSE 0 END AS due,
            COALESCE(pi.paid_at, pi.captured_at, pi.created_at) AS paid_at, pi.provider, pi.channel,
            to_char(COALESCE(pi.paid_at, pi.captured_at, pi.created_at) AT TIME ZONE $2, 'YYYY-MM') AS month,
            COALESCE((SELECT sum(d.total_minor) FROM charging_session cs JOIN cdr d ON d.session_id = cs.id WHERE cs.payment_intent_id = pi.id), 0)::bigint AS used,
            NOT EXISTS (SELECT 1 FROM charging_session cs WHERE cs.payment_intent_id = pi.id AND cs.ended_at IS NULL)
              AND (EXISTS (SELECT 1 FROM charging_session cs WHERE cs.payment_intent_id = pi.id) OR COALESCE(pi.paid_at, pi.created_at) < now() - interval '1 day') AS ended
       FROM payment_intent pi
      WHERE pi.org_id = $1 AND NOT COALESCE(pi.test_mode, false) AND pi.amount_captured_minor > 0 AND pi.mode = 'prepurchase'
        AND pi.state IN ('captured', 'refunded')`, [orgId, zone()]));
  const recognised = new Set((await outsideRequestScope(() => many<{ month: string; currency: string }>(`SELECT month, currency FROM driver_funds_breakage WHERE org_id = $1`, [orgId]))).map((r) => `${r.month}|${r.currency}`));
  return rows.map((r) => ({
    id: r.id, currency: r.currency, captured: Number(r.amount_captured_minor), used: Number(r.used), refunded: Number(r.refunded), due: Number(r.due),
    paidAt: new Date(r.paid_at), ended: r.ended === true, provider: r.provider, channel: r.channel, month: r.month, recognised: recognised.has(`${r.month}|${r.currency}`),
  }));
}

const unusedOf = (r: Row) => Math.max(0, r.captured - r.used - r.refunded - r.due);

/** The liability as of now, per currency; breakage candidates by month of payment; loyalty points outstanding. */
export async function position(orgId: string, now = new Date()) {
  const st = await settings(orgId);
  const rows = await payments(orgId);
  const cutoff = now.getTime() - st.breakageDays * 86_400_000;
  const per: Record<string, { inUse: number; unused: number; refundDue: number; breakageCandidate: number; recognisedBreakage: number; payments: number; windowClosing: number }> = {};
  const byMonth: Record<string, { month: string; currency: string; amount: number; payments: number; recognised: boolean }> = {};
  for (const r of rows) {
    const p = (per[r.currency] ??= { inUse: 0, unused: 0, refundDue: 0, breakageCandidate: 0, recognisedBreakage: 0, payments: 0, windowClosing: 0 });
    p.refundDue += r.due;
    if (!r.ended) { p.inUse += Math.max(0, r.captured - r.used - r.refunded - r.due); continue; }
    const left = unusedOf(r);
    if (!left) continue;
    p.payments++;
    if (r.recognised) { p.recognisedBreakage += left; continue; }
    p.unused += left;
    const daysLeft = refundDaysLeft(refundWindowDays(r.provider, r.channel), r.paidAt, now.getTime());
    if (daysLeft != null && daysLeft >= 0 && daysLeft <= 7) p.windowClosing += left;
    if (r.paidAt.getTime() < cutoff) {
      p.breakageCandidate += left;
      const k = `${r.month}|${r.currency}`;
      const m = (byMonth[k] ??= { month: r.month, currency: r.currency, amount: 0, payments: 0, recognised: false });
      m.amount += left; m.payments++;
    }
  }
  const loyalty = await outsideRequestScope(() => many<any>(
    `SELECT e.currency, COALESCE(sum(e.remaining), 0)::bigint AS points, max(p.point_value_minor) AS value
       FROM loyalty_entry e JOIN loyalty_program p ON p.org_id = e.org_id AND p.currency = e.currency
      WHERE e.org_id = $1 AND e.remaining > 0 AND (e.expires_at IS NULL OR e.expires_at > now()) GROUP BY 1`, [orgId]).catch(() => []));
  for (const l of loyalty) per[l.currency] ??= { inUse: 0, unused: 0, refundDue: 0, breakageCandidate: 0, recognisedBreakage: 0, payments: 0, windowClosing: 0 };
  return {
    asOf: now.toISOString(), breakageDays: st.breakageDays,
    currencies: Object.entries(per).sort(([a], [b]) => a.localeCompare(b)).map(([c, p]) => {
      const l = loyalty.find((x) => x.currency === c);
      const loyaltyValue = l ? Math.round(Number(l.points) * Number(l.value ?? 0)) : 0;
      return { currency: c, ...p, loyaltyPoints: l ? Number(l.points) : 0, loyaltyValue, liability: p.inUse + p.unused + p.refundDue + loyaltyValue };
    }),
    breakage: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/** A month's movement, and the gateway's ledger for the same payments. */
export async function movement(orgId: string, monthRaw: unknown) {
  const month = monthRaw == null || monthRaw === '' ? localDay().slice(0, 7) : String(monthRaw);
  if (!MONTH_RE.test(month)) throw new DriverFundsError(422, 'month is YYYY-MM.');
  const z = zone();
  const [collected, used, refunded, breakage, gateway] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT currency, COALESCE(sum(amount_captured_minor), 0)::bigint AS n, count(*)::int AS c FROM payment_intent
        WHERE org_id = $1 AND mode = 'prepurchase' AND NOT COALESCE(test_mode, false) AND amount_captured_minor > 0
          AND to_char(COALESCE(paid_at, captured_at, created_at) AT TIME ZONE $3, 'YYYY-MM') = $2 GROUP BY 1`, [orgId, month, z])),
    outsideRequestScope(() => many<any>(
      `SELECT d.currency, COALESCE(sum(d.total_minor), 0)::bigint AS n FROM cdr d JOIN charging_session cs ON cs.id = d.session_id JOIN payment_intent pi ON pi.id = cs.payment_intent_id
        WHERE d.org_id = $1 AND pi.mode = 'prepurchase' AND NOT COALESCE(d.test_mode, false) AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') = $2 GROUP BY 1`, [orgId, month, z])),
    outsideRequestScope(() => many<any>(
      `SELECT currency, COALESCE(sum(refunded_minor), 0)::bigint AS n FROM payment_intent
        WHERE org_id = $1 AND mode = 'prepurchase' AND refunded_at IS NOT NULL AND to_char(refunded_at AT TIME ZONE $3, 'YYYY-MM') = $2 GROUP BY 1`, [orgId, month, z])),
    outsideRequestScope(() => many<any>(`SELECT currency, sum(amount_minor)::bigint AS n FROM driver_funds_breakage WHERE org_id = $1 AND to_char(recorded_at AT TIME ZONE $3, 'YYYY-MM') = $2 GROUP BY 1`, [orgId, month, z])),
    outsideRequestScope(() => many<any>(
      `SELECT g.currency, COALESCE(round(sum(g.amount)), 0)::bigint AS n, count(*)::int AS c FROM gateway_transaction g JOIN payment_intent pi ON pi.id = g.payment_intent_id
        WHERE g.org_id = $1 AND g.kind = 'payment' AND g.status = 'success' AND pi.mode = 'prepurchase' AND to_char(g.gateway_created_at AT TIME ZONE $3, 'YYYY-MM') = $2 GROUP BY 1`, [orgId, month, z])),
  ]);
  const curs = [...new Set([...collected, ...used, ...refunded, ...breakage, ...gateway].map((r) => r.currency))].sort();
  const v = (rows: any[], c: string) => Number(rows.find((r) => r.currency === c)?.n ?? 0);
  return {
    month, currencies: curs.map((c) => ({
      currency: c, collected: v(collected, c), payments: collected.find((r) => r.currency === c)?.c ?? 0, used: v(used, c), refunded: v(refunded, c), breakage: v(breakage, c),
      net: v(collected, c) - v(used, c) - v(refunded, c) - v(breakage, c),
      gateway: v(gateway, c), gatewayPayments: gateway.find((r) => r.currency === c)?.c ?? 0, difference: v(collected, c) - v(gateway, c),
    })),
  };
}

/** Recognise a month's breakage (payments made in that month, older than the breakage days, unused). Once. */
export async function recogniseBreakage(orgId: string, b: { month?: unknown; currency?: unknown }, userId: string | null) {
  const month = String(b.month ?? ''), currency = String(b.currency ?? '');
  if (!MONTH_RE.test(month)) throw new DriverFundsError(422, 'month is YYYY-MM.');
  const done = await outsideRequestScope(() => one(`SELECT 1 FROM driver_funds_breakage WHERE org_id = $1 AND month = $2 AND currency = $3`, [orgId, month, currency]));
  if (done) throw new DriverFundsError(409, `${month} breakage in ${currency} is already recognised.`);
  const p = await position(orgId);
  const m = p.breakage.find((x) => x.month === month && x.currency === currency);
  if (!m || m.amount <= 0) throw new DriverFundsError(422, `No breakage for ${month} in ${currency || 'that currency'}: only unused balances older than ${p.breakageDays} days.`);
  const rows = (await payments(orgId)).filter((r) => r.month === month && r.currency === currency && r.ended && unusedOf(r) > 0);
  try {
    await outsideRequestScope(() => query(
      `INSERT INTO driver_funds_breakage (org_id, month, currency, amount_minor, payments, data, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, month, currency, m.amount, m.payments, JSON.stringify({ breakageDays: p.breakageDays, paymentIds: rows.map((r) => r.id).slice(0, 5000) }), userId]));
  } catch (e) {
    if ((e as any).code === '23505') throw new DriverFundsError(409, `${month} breakage in ${currency} is already recognised.`);
    throw e;
  }
  return { month, currency, amount: m.amount, payments: m.payments };
}

export async function recognised(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT b.*, u.name AS by_name FROM driver_funds_breakage b LEFT JOIN app_user u ON u.id = b.recorded_by WHERE b.org_id = $1 ORDER BY b.month DESC LIMIT 60`, [orgId]));
  return rows.map((r) => ({ month: r.month, currency: r.currency, amount: Number(r.amount_minor), payments: r.payments, by: r.by_name ?? null, at: new Date(r.recorded_at).toISOString() }));
}

export function reportXlsx(p: Awaited<ReturnType<typeof position>>, m: Awaited<ReturnType<typeof movement>>): Buffer {
  return xlsx([
    { name: 'Position', rows: [['Currency', 'In use', 'Unused (owed)', 'Refund due', 'Loyalty value', 'Liability', 'Breakage candidates', 'Recognised breakage'],
      ...p.currencies.map((c) => [c.currency, c.inUse, c.unused, c.refundDue, c.loyaltyValue, c.liability, c.breakageCandidate, c.recognisedBreakage])],
      widths: [10, 14, 16, 14, 14, 16, 18, 18], formats: [null, 'int', 'int', 'int', 'int', 'int', 'int', 'int'] },
    { name: `Movement ${m.month}`, rows: [['Currency', 'Collected', 'Payments', 'Used', 'Refunded', 'Breakage', 'Net', 'Gateway', 'Difference'],
      ...m.currencies.map((c) => [c.currency, c.collected, c.payments, c.used, c.refunded, c.breakage, c.net, c.gateway, c.difference])],
      widths: [10, 14, 10, 14, 14, 14, 14, 14, 14], formats: [null, 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int'] },
    { name: 'Breakage', rows: [['Month paid', 'Currency', 'Unused', 'Payments', 'Recognised'], ...p.breakage.map((b) => [b.month, b.currency, b.amount, b.payments, b.recognised ? 'yes' : 'no'])],
      widths: [12, 10, 14, 10, 12], formats: [null, null, 'int', 'int', null] },
  ]);
}
