import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { getProgram } from './loyalty.js';
import { xlsx } from './xlsx.js';

/**
 * Loyalty and promotion costs (v1.37.0), the finance side of Commercial → Promotions & plans.
 *
 *   points liability   points outstanding at a month's end (earned − redeemed − expired ± adjusted, from the points
 *                      ledger) × what a point is worth (the programme's point value): the gross liability. Points that
 *                      will never be used (breakage) are taken off: the rate learned from the last twelve months
 *                      (points expired ÷ points expired or redeemed), or a fixed rate set here. Net = gross × (1 −
 *                      breakage) — the revenue deferred for points (PSAK 72 / IFRS 15: a material right).
 *   ledger             each month the change in the net liability (the 'loyalty' journal): up, Dr 4150 loyalty
 *                      points deferred (less revenue) / Cr 2250 loyalty points liability; down, the reverse. Redeemed
 *                      points already reduced the charge record's price, so releasing the liability makes up for it.
 *   promotion cost     per promotion and per site over n whole months: the discounts given, the points redeemed (their
 *                      value), the sessions and revenue they came with, the cost as a share of the site's revenue
 */

export class LoyaltyAcctError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
const addMonths = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + mo - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The breakage rate (%) from points expired and redeemed. Pure. */
export function breakageRate(expired: number, redeemed: number): number {
  const e = Math.abs(expired), r = Math.abs(redeemed);
  return e + r ? r1((e / (e + r)) * 100) : 0;
}

/** The net liability: gross × (1 − breakage). Pure. */
export function netLiability(points: number, pointValue: number, breakagePct: number): { gross: number; net: number } {
  const gross = Math.max(0, points) * pointValue;
  return { gross, net: Math.round(gross * (1 - Math.min(100, Math.max(0, breakagePct)) / 100)) };
}

export async function settings(orgId: string) {
  const r = await outsideRequestScope(() => one<{ s: any }>(`SELECT loyalty_accounting AS s FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const b = r?.s?.breakagePct;
  return { breakagePct: b == null ? null : Number(b) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const v = b.breakagePct == null || b.breakagePct === '' ? null : Number(b.breakagePct);
  if (v != null && (!Number.isFinite(v) || v < 0 || v > 90)) throw new LoyaltyAcctError(422, 'breakagePct is 0 to 90, or empty to learn it.');
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, loyalty_accounting, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET loyalty_accounting = EXCLUDED.loyalty_accounting, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify({ breakagePct: v }), userId]));
  return settings(orgId);
}

/** The liability at the end of each of the months (per currency), with the month's movements. */
export async function liability(orgId: string, monthsRaw: string[]) {
  const months = [...monthsRaw].sort();
  if (!months.length) return [];
  const first = months[0]!, last = months.at(-1)!;
  const [prog, s] = await Promise.all([getProgram(orgId), settings(orgId)]);
  const rows = await outsideRequestScope(() => many<{ m: string; currency: string; kind: string; pts: string; val: string }>(
    `SELECT to_char(created_at AT TIME ZONE $3, 'YYYY-MM') AS m, currency, kind, sum(points)::bigint AS pts, sum(value_minor)::bigint AS val FROM loyalty_entry
      WHERE org_id = $1 AND to_char(created_at AT TIME ZONE $3, 'YYYY-MM') <= $2 GROUP BY 1, 2, 3`, [orgId, last, zone()]));
  const currencies = [...new Set(rows.map((r) => r.currency))];
  const out = [];
  for (const cur of currencies) {
    const mine = rows.filter((r) => r.currency === cur);
    const sum = (pred: (r: typeof mine[number]) => boolean) => mine.filter(pred).reduce((a, r) => a + Number(r.pts), 0);
    for (const m of months) {
      if (m < first) continue;
      const balance = sum((r) => r.m <= m);
      const lo = addMonths(m, -11);
      const learned = breakageRate(sum((r) => r.kind === 'expire' && r.m >= lo && r.m <= m), sum((r) => r.kind === 'redeem' && r.m >= lo && r.m <= m));
      const breakage = s.breakagePct ?? learned;
      const l = netLiability(balance, prog.pointValueMinor, breakage);
      const k = (kind: string) => sum((r) => r.kind === kind && r.m === m);
      out.push({ month: m, currency: cur, points: balance, pointValue: prog.pointValueMinor, breakagePct: breakage, breakageSource: s.breakagePct == null ? 'learned' : 'set', learnedPct: learned,
        gross: l.gross, net: l.net, earned: k('earn'), redeemed: -k('redeem'), expired: -k('expire'), adjusted: k('adjust'),
        redeemedValue: -mine.filter((r) => r.kind === 'redeem' && r.m === m).reduce((a, r) => a + Number(r.val), 0) });
    }
  }
  return out;
}

export async function overview(orgId: string, q: { months?: unknown } = {}, now = new Date()) {
  const n = q.months == null || q.months === '' ? 6 : Number(q.months);
  if (!Number.isInteger(n) || n < 1 || n > 24) throw new LoyaltyAcctError(400, 'months is 1 to 24.');
  const last = addMonths(thisMonth(now), -1);
  const months: string[] = [];
  for (let k = n - 1; k >= 0; k--) months.push(addMonths(last, -k));
  const [prog, s, liab, promos] = await Promise.all([getProgram(orgId), settings(orgId), liability(orgId, [addMonths(months[0]!, -1), ...months]), promotionCosts(orgId, months)]);
  const trend = liab.filter((l) => months.includes(l.month)).map((l) => ({ ...l, change: l.net - (liab.find((x) => x.currency === l.currency && x.month === addMonths(l.month, -1))?.net ?? 0) }));
  return { months, program: { enabled: prog.enabled, pointValue: prog.pointValueMinor, earnPer1000: prog.earnPer1000Minor, expiryMonths: prog.expiryMonths }, settings: s, liability: trend, ...promos };
}

/** Discounts and points redeemed per promotion and per site over the months. */
export async function promotionCosts(orgId: string, months: string[]) {
  const [promo, pts, rev] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT p.id, p.name, pr.currency, cs.site_id, count(*)::int AS n, count(DISTINCT pr.customer_key)::int AS customers, sum(pr.discount_minor)::bigint AS discount, COALESCE(sum(d.subtotal_minor), 0)::bigint AS revenue
         FROM promotion_redemption pr JOIN promotion p ON p.id = pr.promotion_id JOIN charging_session cs ON cs.id = pr.session_id LEFT JOIN cdr d ON d.session_id = pr.session_id
        WHERE pr.org_id = $1 AND to_char(pr.created_at AT TIME ZONE $3, 'YYYY-MM') = ANY($2::text[]) GROUP BY 1, 2, 3, 4`, [orgId, months, zone()])),
    outsideRequestScope(() => many<any>(
      `SELECT le.currency, cs.site_id, count(*)::int AS n, -sum(le.value_minor)::bigint AS value, -sum(le.points)::bigint AS points
         FROM loyalty_entry le JOIN charging_session cs ON cs.id = le.session_id
        WHERE le.org_id = $1 AND le.kind = 'redeem' AND to_char(le.created_at AT TIME ZONE $3, 'YYYY-MM') = ANY($2::text[]) GROUP BY 1, 2`, [orgId, months, zone()])),
    outsideRequestScope(() => many<any>(
      `SELECT cs.site_id, s.name, d.currency, sum(d.subtotal_minor)::bigint AS revenue FROM cdr d JOIN charging_session cs ON cs.id = d.session_id JOIN site s ON s.id = cs.site_id
        WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') = ANY($2::text[]) GROUP BY 1, 2, 3`, [orgId, months, zone()])),
  ]);
  const byPromo = new Map<string, any>();
  for (const r of promo) {
    const k = `${r.id}|${r.currency}`;
    const x = byPromo.get(k) ?? { id: r.id, name: r.name, currency: r.currency, redemptions: 0, discount: 0, revenue: 0, customers: 0 };
    x.redemptions += r.n; x.discount += Number(r.discount); x.revenue += Number(r.revenue); x.customers += r.customers;
    byPromo.set(k, x);
  }
  const promotions = [...byPromo.values()].map((p) => ({ ...p, discountPct: p.revenue + p.discount ? r1((p.discount / (p.revenue + p.discount)) * 100) : null })).sort((a, b) => b.discount - a.discount);
  const siteNames = new Map(rev.map((r) => [r.site_id, r.name]));
  const keys = new Set([...promo.map((r) => `${r.site_id}|${r.currency}`), ...pts.map((r) => `${r.site_id}|${r.currency}`)]);
  const sites = [...keys].map((k) => {
    const [site, cur] = k.split('|') as [string, string];
    const discount = promo.filter((r) => r.site_id === site && r.currency === cur).reduce((a, r) => a + Number(r.discount), 0);
    const points = pts.filter((r) => r.site_id === site && r.currency === cur).reduce((a, r) => a + Number(r.value), 0);
    const revenue = Number(rev.find((r) => r.site_id === site && r.currency === cur)?.revenue ?? 0);
    return { siteId: site, site: siteNames.get(site) ?? null, currency: cur, discount, pointsRedeemed: points, cost: discount + points, revenue, costPct: revenue ? r1(((discount + points) / revenue) * 100) : null };
  }).sort((a, b) => b.cost - a.cost);
  const totals: Record<string, { discount: number; pointsRedeemed: number; cost: number }> = {};
  for (const s of sites) { const t = (totals[s.currency] ??= { discount: 0, pointsRedeemed: 0, cost: 0 }); t.discount += s.discount; t.pointsRedeemed += s.pointsRedeemed; t.cost += s.cost; }
  return { promotions, sites, totals };
}

/** The month's 'loyalty' journal per currency: the change in the net liability. */
export async function journal(orgId: string, month: string) {
  if (!MONTH_RE.test(month)) return {};
  const ls = await liability(orgId, [addMonths(month, -1), month]);
  const out: Record<string, Array<{ account: string; debit: number; credit: number; description: string }>> = {};
  for (const cur of new Set(ls.map((l) => l.currency))) {
    const now = ls.find((l) => l.currency === cur && l.month === month)?.net ?? 0, before = ls.find((l) => l.currency === cur && l.month === addMonths(month, -1))?.net ?? 0;
    const d = now - before;
    if (!d) continue;
    const desc = `Loyalty points ${month}: ${d > 0 ? 'deferred' : 'released'}`;
    out[cur] = d > 0
      ? [{ account: '4150', debit: d, credit: 0, description: desc }, { account: '2250', debit: 0, credit: d, description: desc }]
      : [{ account: '2250', debit: -d, credit: 0, description: desc }, { account: '4150', debit: 0, credit: -d, description: desc }];
  }
  return out;
}

export async function reportXlsx(orgId: string, q: { months?: unknown }): Promise<Buffer> {
  const o = await overview(orgId, q);
  return xlsx([
    { name: 'Liability', rows: [['Month', 'Currency', 'Points', 'Point value', 'Gross', 'Breakage %', 'Net liability', 'Change', 'Earned', 'Redeemed', 'Expired', 'Adjusted'],
      ...o.liability.map((l) => [l.month, l.currency, l.points, l.pointValue, l.gross, l.breakagePct, l.net, l.change, l.earned, l.redeemed, l.expired, l.adjusted])],
      widths: [9, 8, 12, 10, 16, 10, 16, 14, 10, 10, 10, 10], formats: [null, null, 'int', null, 'money', null, 'money', 'money', 'int', 'int', 'int', 'int'] },
    { name: 'Promotions', rows: [['Promotion', 'Currency', 'Redemptions', 'Customers', 'Discount', 'Revenue', 'Discount %'], ...o.promotions.map((p) => [p.name, p.currency, p.redemptions, p.customers, p.discount, p.revenue, p.discountPct])],
      widths: [30, 8, 12, 10, 16, 16, 10], formats: [null, null, 'int', 'int', 'money', 'money', null] },
    { name: 'Sites', rows: [['Site', 'Currency', 'Discounts', 'Points redeemed', 'Cost', 'Revenue', 'Cost %'], ...o.sites.map((s) => [s.site ?? s.siteId, s.currency, s.discount, s.pointsRedeemed, s.cost, s.revenue, s.costPct])],
      widths: [28, 8, 16, 16, 16, 16, 8], formats: [null, null, 'money', 'money', 'money', 'money', null] },
  ]);
}
