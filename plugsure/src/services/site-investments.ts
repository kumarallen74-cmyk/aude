import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { assertOpen } from './finance-periods.js';

/**
 * Site investment and payback (v1.22.0). What a site cost to build — chargers, installation, grid connection, other —
 * each with the date it was paid and the months it is depreciated over (straight line, from the month after). With
 * the site's margin (revenue − energy cost, services/energy-margin.ts: the month's bill, else the site's cost per kWh
 * × kWh, else revenue alone, flagged), per site:
 *
 *   invested         the investments not voided
 *   depreciation     per month now, accumulated to last month, and the net book value
 *   recovered        the margin since the first investment's month, and how much of the investment it covers
 *   payback          the month the margin covered the investment, or the month it will at the last 6 full months'
 *                    average margin (none when that average is 0 or less)
 *   ROI              (the average month's margin × 12 − a year's depreciation) ÷ invested, a year
 *
 * Amounts are in the site's currency. An investment dated in a locked month cannot be recorded or voided.
 */

export class InvestmentError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const CATEGORIES = ['chargers', 'installation', 'grid', 'other'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const r1 = (n: number) => Math.round(n * 10) / 10;
const thisMonth = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const monthsBetween = (a: string, b: string) => {
  const [ya, ma] = a.split('-').map(Number) as [number, number];
  const [yb, mb] = b.split('-').map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
};

async function siteOf(orgId: string, siteId: string) {
  if (!UUID_RE.test(siteId)) throw new InvestmentError(404, 'No such site.');
  const s = await outsideRequestScope(() => one<{ id: string; name: string; currency: string }>(
    `SELECT s.id, s.name, co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2`, [siteId, orgId]));
  if (!s) throw new InvestmentError(404, 'No such site.');
  return s;
}

/** Depreciation of one investment in a month (straight line over life_months, from the month after it was paid). */
export function depreciationIn(inv: { amount: number; investedOn: string; lifeMonths: number }, month: string): number {
  const start = addMonths(inv.investedOn.slice(0, 7), 1);
  const k = monthsBetween(start, month);
  if (k < 0 || k >= inv.lifeMonths) return 0;
  // Whole minor units: the last month takes the rounding so the total is exactly the amount.
  const per = Math.floor(inv.amount / inv.lifeMonths);
  return k === inv.lifeMonths - 1 ? inv.amount - per * (inv.lifeMonths - 1) : per;
}

/** Margin per site and month, from a month on (revenue − bill, else estimate, else unknown cost). */
async function margins(orgId: string, from: string, siteId?: string) {
  const [rows, bills, rates] = await Promise.all([
    outsideRequestScope(() => many<{ site_id: string; month: string; revenue: string; wh: string }>(
      `SELECT cs.site_id, to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') AS month, COALESCE(sum(d.subtotal_minor), 0)::bigint AS revenue, COALESCE(sum(cs.energy_wh), 0)::bigint AS wh
         FROM cdr d JOIN charging_session cs ON cs.id = d.session_id
        WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND cs.site_id IS NOT NULL AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') >= $2
          AND ($4::uuid IS NULL OR cs.site_id = $4::uuid)
        GROUP BY 1, 2`, [orgId, from, zone(), siteId ?? null])),
    outsideRequestScope(() => many<{ site_id: string; month: string; amount_minor: string }>(
      `SELECT site_id, month, amount_minor FROM site_energy_cost WHERE org_id = $1 AND voided_at IS NULL AND month >= $2 AND ($3::uuid IS NULL OR site_id = $3::uuid)`, [orgId, from, siteId ?? null])),
    outsideRequestScope(() => many<{ site_id: string; rate_per_kwh: string }>(`SELECT site_id, rate_per_kwh FROM site_energy_rate WHERE org_id = $1`, [orgId])),
  ]);
  const rate = new Map(rates.map((r) => [r.site_id, Number(r.rate_per_kwh)]));
  const out = new Map<string, Map<string, { margin: number; costKnown: boolean }>>();
  const keys = new Set<string>([...rows.map((r) => `${r.site_id}|${r.month}`), ...bills.map((b) => `${b.site_id}|${b.month}`)]);
  for (const k of keys) {
    const [sid, m] = k.split('|') as [string, string];
    const r = rows.find((x) => x.site_id === sid && x.month === m);
    const b = bills.find((x) => x.site_id === sid && x.month === m);
    const revenue = Number(r?.revenue ?? 0), kwh = Number(r?.wh ?? 0) / 1000;
    const cost = b ? Number(b.amount_minor) : rate.has(sid) ? Math.round(rate.get(sid)! * kwh) : null;
    const per = out.get(sid) ?? new Map();
    per.set(m, { margin: revenue - (cost ?? 0), costKnown: cost != null || revenue === 0 });
    out.set(sid, per);
  }
  return out;
}

const view = (r: any) => ({
  id: String(r.id), siteId: r.site_id, category: r.category, description: r.description, amount: Number(r.amount_minor), currency: r.currency,
  investedOn: String(r.invested_on_s),
  lifeMonths: Number(r.life_months), reference: r.reference ?? null, recordedBy: r.recorded_by_name ?? null,
  voided: !!r.voided_at, voidReason: r.void_reason ?? null,
});

/** Every site with investments (or one site): invested, depreciation, recovered, payback, ROI. */
export async function overview(orgId: string, siteId?: string, now = new Date()) {
  if (siteId) await siteOf(orgId, siteId);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT i.*, to_char(i.invested_on, 'YYYY-MM-DD') AS invested_on_s, u.name AS recorded_by_name, s.name AS site_name FROM site_investment i JOIN site s ON s.id = i.site_id LEFT JOIN app_user u ON u.id = i.recorded_by
      WHERE i.org_id = $1 AND ($2::uuid IS NULL OR i.site_id = $2::uuid) ORDER BY s.name, i.invested_on, i.id`, [orgId, siteId ?? null]));
  const live = rows.filter((r) => !r.voided_at).map((r) => ({ ...view(r), siteName: r.site_name }));
  const cur = thisMonth(now), last = addMonths(cur, -1);
  const first = live.reduce<string | null>((a, i) => (!a || i.investedOn.slice(0, 7) < a ? i.investedOn.slice(0, 7) : a), null);
  const mg = first ? await margins(orgId, first, siteId) : new Map();
  const bySite = new Map<string, typeof live>();
  for (const i of live) bySite.set(i.siteId, [...(bySite.get(i.siteId) ?? []), i]);
  const sites = [...bySite.entries()].map(([sid, items]) => {
    const invested = items.reduce((a, i) => a + i.amount, 0);
    const start = items.reduce((a, i) => (i.investedOn.slice(0, 7) < a ? i.investedOn.slice(0, 7) : a), items[0]!.investedOn.slice(0, 7));
    let accumulated = 0;
    for (let m = addMonths(start, 1); m <= last; m = addMonths(m, 1)) for (const i of items) accumulated += depreciationIn(i, m);
    const perMonthNow = items.reduce((a, i) => a + depreciationIn(i, cur), 0);
    const yearDep = Array.from({ length: 12 }, (_, k) => addMonths(cur, k)).reduce((a, m) => a + items.reduce((b, i) => b + depreciationIn(i, m), 0), 0);
    const sm = mg.get(sid) ?? new Map<string, { margin: number; costKnown: boolean }>();
    let recovered = 0, paidBackIn: string | null = null, unknownCostMonths = 0;
    for (let m = start; m <= cur; m = addMonths(m, 1)) {
      const x = sm.get(m);
      if (!x) continue;
      recovered += x.margin;
      if (!x.costKnown) unknownCostMonths++;
      if (!paidBackIn && recovered >= invested) paidBackIn = m;
    }
    const trailing = Array.from({ length: 6 }, (_, k) => addMonths(last, -k)).filter((m) => m >= start);
    const avg = trailing.length ? trailing.reduce((a, m) => a + (sm.get(m)?.margin ?? 0), 0) / trailing.length : 0;
    let paybackMonth = paidBackIn, projected = false;
    if (!paybackMonth && avg > 0) { paybackMonth = addMonths(cur, Math.ceil((invested - recovered) / avg)); projected = true; }
    return {
      siteId: sid, siteName: items[0]!.siteName, currency: items[0]!.currency, invested, since: start,
      byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, items.filter((i) => i.category === c).reduce((a, i) => a + i.amount, 0)])),
      depreciation: { perMonth: perMonthNow, accumulated, netBookValue: invested - accumulated },
      recovered: { margin: recovered, pct: invested ? r1((recovered / invested) * 100) : null, unknownCostMonths },
      averageMonthlyMargin: Math.round(avg),
      payback: paybackMonth ? { month: paybackMonth, projected, monthsFromStart: monthsBetween(start, paybackMonth) } : null,
      roiPct: invested ? r1(((avg * 12 - yearDep) / invested) * 100) : null,
      items: items.map(({ siteName: _n, ...i }) => i),
    };
  });
  const totals: Record<string, { invested: number; netBookValue: number; recovered: number }> = {};
  for (const s of sites) {
    const t = totals[s.currency] ?? { invested: 0, netBookValue: 0, recovered: 0 };
    t.invested += s.invested; t.netBookValue += s.depreciation.netBookValue; t.recovered += s.recovered.margin;
    totals[s.currency] = t;
  }
  return { asOf: cur, sites, totals, voided: rows.filter((r) => r.voided_at).map(view) };
}

export async function record(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const s = await siteOf(orgId, String(b.siteId ?? ''));
  const category = String(b.category ?? '');
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new InvestmentError(422, `category is one of ${CATEGORIES.join(', ')}.`);
  const description = String(b.description ?? '').trim();
  if (description.length < 2 || description.length > 200) throw new InvestmentError(422, 'Describe the investment (2 to 200 characters).');
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new InvestmentError(422, 'The amount is a whole number of the currency\'s minor unit, above 0.');
  const on = String(b.investedOn ?? '');
  if (!DATE_RE.test(on) || Number.isNaN(Date.parse(`${on}T00:00:00Z`))) throw new InvestmentError(422, 'investedOn is the date it was paid (YYYY-MM-DD).');
  const life = b.lifeMonths == null || b.lifeMonths === '' ? 96 : Number(b.lifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 360) throw new InvestmentError(422, 'lifeMonths (depreciation) is 1 to 360 months.');
  await assertOpen(orgId, on.slice(0, 7), 'An investment', (st, msg) => new InvestmentError(st, msg));
  const r = await outsideRequestScope(() => one<any>(
    `INSERT INTO site_investment (org_id, site_id, category, description, amount_minor, currency, invested_on, life_months, reference, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *, to_char(invested_on, 'YYYY-MM-DD') AS invested_on_s`,
    [orgId, s.id, category, description, amount, s.currency, on, life, b.reference == null || b.reference === '' ? null : String(b.reference).slice(0, 80), userId]));
  return view(r);
}

export async function voidInvestment(orgId: string, id: string, reasonRaw: unknown, userId: string | null) {
  if (!/^\d{1,18}$/.test(id)) throw new InvestmentError(404, 'No such investment.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3 || reason.length > 300) throw new InvestmentError(422, 'Say why the investment is voided (3 to 300 characters).');
  const cur = await outsideRequestScope(() => one<{ d: string }>(`SELECT to_char(invested_on, 'YYYY-MM-DD') AS d FROM site_investment WHERE id = $1 AND org_id = $2 AND voided_at IS NULL`, [id, orgId]));
  if (!cur) throw new InvestmentError(404, 'No such investment, or already voided.');
  await assertOpen(orgId, cur.d.slice(0, 7), 'An investment', (st, msg) => new InvestmentError(st, msg));
  await outsideRequestScope(() => one(`UPDATE site_investment SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2 AND voided_at IS NULL`, [id, orgId, userId, reason]));
  return { ok: true };
}
