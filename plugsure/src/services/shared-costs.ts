import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { month as energyMonth } from './energy-margin.js';
import { depreciationIn } from './site-investments.js';
import { assertOpen, lockedAmong } from './finance-periods.js';

/**
 * Cost allocation by site (v1.23.0). Costs no single site carries — rent of a car park with several sites, a
 * maintenance contract, connectivity (SIM cards), insurance, staff — entered once a month (from a month, until a
 * month or ongoing) and spread over the sites of their currency (or the sites chosen) by:
 *
 *   kwh        the kWh each site delivered that month
 *   sessions   the sessions each site had
 *   revenue    each site's revenue
 *   equal      the same for each site
 *
 * (when no chosen site had any kWh, sessions or revenue that month, equally). Whole minor units; the remainder goes
 * to the largest shares so the parts add up to the cost.
 *
 * The site P&L of a month: revenue − energy cost (Margin) − shared costs by category − depreciation of the site's
 * investments (Investments) = what the site contributed. A cost whose months include a locked month cannot be
 * recorded, ended earlier or voided across it (Finance → Close).
 */

export class SharedCostError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const CATEGORIES = ['rent', 'maintenance', 'connectivity', 'insurance', 'staff', 'other'] as const;
export const BASES = ['kwh', 'sessions', 'revenue', 'equal'] as const;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const monthsIn = (from: string, to: string) => { const out: string[] = []; for (let m = from; m <= to && out.length < 600; m = addMonths(m, 1)) out.push(m); return out; };

/** Split an amount by weights into whole units adding up to it (largest remainder). Equal when every weight is 0. */
export function split(amount: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const w = weights.some((x) => x > 0) ? weights.map((x) => Math.max(0, x)) : weights.map(() => 1);
  const total = w.reduce((a, x) => a + x, 0);
  const raw = w.map((x) => (amount * x) / total);
  const out = raw.map((x) => Math.floor(x));
  let left = amount - out.reduce((a, x) => a + x, 0);
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) out[order[k]!.i]!++;
  return out;
}

const view = (r: any) => ({
  id: String(r.id), category: r.category, description: r.description, amount: Number(r.amount_minor), currency: r.currency, basis: r.basis,
  siteIds: (r.site_ids ?? null) as string[] | null, monthFrom: r.month_from, monthTo: r.month_to ?? null,
  recordedBy: r.recorded_by_name ?? null, voided: !!r.voided_at, voidReason: r.void_reason ?? null,
});

export async function list(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT c.*, u.name AS recorded_by_name FROM finance_shared_cost c LEFT JOIN app_user u ON u.id = c.recorded_by WHERE c.org_id = $1 ORDER BY c.voided_at IS NOT NULL, c.month_from DESC, c.id DESC LIMIT 500`, [orgId]));
  return { costs: rows.map(view), categories: CATEGORIES, bases: BASES };
}

async function sitesOf(orgId: string) {
  return outsideRequestScope(() => many<{ id: string; name: string; currency: string }>(
    `SELECT s.id, s.name, co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.org_id = $1 AND s.archived_at IS NULL ORDER BY s.name`, [orgId]));
}

export async function record(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const category = String(b.category ?? ''), basis = String(b.basis ?? 'kwh');
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new SharedCostError(422, `category is one of ${CATEGORIES.join(', ')}.`);
  if (!(BASES as readonly string[]).includes(basis)) throw new SharedCostError(422, `basis is one of ${BASES.join(', ')}.`);
  const description = String(b.description ?? '').trim();
  if (description.length < 2 || description.length > 200) throw new SharedCostError(422, 'Describe the cost (2 to 200 characters).');
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new SharedCostError(422, 'The amount (per month) is a whole number of the currency\'s minor unit, above 0.');
  const from = String(b.monthFrom ?? ''), to = b.monthTo == null || b.monthTo === '' ? null : String(b.monthTo);
  if (!MONTH_RE.test(from) || (to && !MONTH_RE.test(to))) throw new SharedCostError(422, 'monthFrom (and monthTo, when it ends) are YYYY-MM.');
  if (to && to < from) throw new SharedCostError(422, 'monthTo is on or after monthFrom.');
  const sites = await sitesOf(orgId);
  let siteIds: string[] | null = null, currency = String(b.currency ?? '');
  if (Array.isArray(b.siteIds) && b.siteIds.length) {
    siteIds = [...new Set(b.siteIds.map(String))];
    const mine = siteIds.map((id) => sites.find((s) => s.id === id));
    if (siteIds.some((id) => !UUID_RE.test(id)) || mine.some((s) => !s)) throw new SharedCostError(422, 'siteIds are your sites.');
    const curs = new Set(mine.map((s) => s!.currency));
    if (curs.size > 1) throw new SharedCostError(422, 'The sites of a cost share one currency.');
    currency = [...curs][0]!;
  } else if (!currency) {
    const curs = [...new Set(sites.map((s) => s.currency))];
    if (curs.length !== 1) throw new SharedCostError(422, 'Give the currency (your sites use several): the cost is spread over the sites of that currency.');
    currency = curs[0]!;
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new SharedCostError(422, 'currency is an ISO code.');
  await assertOpen(orgId, from, 'A shared cost', (st, msg) => new SharedCostError(st, msg));
  const r = await outsideRequestScope(() => one<any>(
    `INSERT INTO finance_shared_cost (org_id, category, description, amount_minor, currency, basis, site_ids, month_from, month_to, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [orgId, category, description, amount, currency, basis, siteIds, from, to, userId]));
  return view(r);
}

async function costOf(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new SharedCostError(404, 'No such cost.');
  const c = await outsideRequestScope(() => one<any>(`SELECT * FROM finance_shared_cost WHERE id = $1 AND org_id = $2 AND voided_at IS NULL`, [id, orgId]));
  if (!c) throw new SharedCostError(404, 'No such cost, or voided.');
  return c;
}

/** End an ongoing cost (or end it earlier): the months it leaves must be open. */
export async function end(orgId: string, id: string, monthToRaw: unknown, now = new Date()) {
  const c = await costOf(orgId, id);
  const to = String(monthToRaw ?? '');
  if (!MONTH_RE.test(to) || to < c.month_from) throw new SharedCostError(422, `monthTo is YYYY-MM, on or after ${c.month_from}.`);
  const oldEnd = c.month_to ?? thisMonth(now);
  if (to < oldEnd) {
    const locked = await lockedAmong(orgId, monthsIn(addMonths(to, 1), oldEnd));
    if (locked.length) throw new SharedCostError(409, `${locked.join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked: end it on or after ${locked[locked.length - 1]}.`);
  }
  await outsideRequestScope(() => one(`UPDATE finance_shared_cost SET month_to = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, to]));
  return { id, monthTo: to };
}

export async function voidCost(orgId: string, id: string, reasonRaw: unknown, userId: string | null, now = new Date()) {
  const c = await costOf(orgId, id);
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3 || reason.length > 300) throw new SharedCostError(422, 'Say why it is voided (3 to 300 characters).');
  const locked = await lockedAmong(orgId, monthsIn(c.month_from, c.month_to ?? thisMonth(now)));
  if (locked.length) throw new SharedCostError(409, `It counts in locked months (${locked.join(', ')}): end it instead.`);
  await outsideRequestScope(() => one(`UPDATE finance_shared_cost SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2`, [id, orgId, userId, reason]));
  return { ok: true };
}

/** A month's P&L per site (default last month): revenue, energy cost, shared costs (by category), depreciation, contribution. */
export async function pnl(orgId: string, monthRaw: unknown) {
  // Last month when none is given (as Margin and Budgets).
  const m = monthRaw == null || monthRaw === '' ? addMonths(thisMonth(), -1) : String(monthRaw);
  if (!MONTH_RE.test(m)) throw new SharedCostError(422, 'month is YYYY-MM.');
  const [e, sites, costs, invs] = await Promise.all([
    energyMonth(orgId, m),
    sitesOf(orgId),
    outsideRequestScope(() => many<any>(
      `SELECT * FROM finance_shared_cost WHERE org_id = $1 AND voided_at IS NULL AND month_from <= $2 AND (month_to IS NULL OR month_to >= $2)`, [orgId, m])),
    outsideRequestScope(() => many<any>(
      `SELECT site_id, amount_minor, to_char(invested_on, 'YYYY-MM-DD') AS d, life_months FROM site_investment WHERE org_id = $1 AND voided_at IS NULL`, [orgId])),
  ]);
  const es = new Map<string, any>((e.sites as any[]).map((x) => [x.siteId, x]));
  const rows = new Map(sites.map((s) => {
    const x = es.get(s.id);
    return [s.id, {
      siteId: s.id, site: s.name, currency: s.currency, kwh: Number(x?.kwh ?? 0), sessions: Number(x?.sessions ?? 0), revenue: Number(x?.revenue ?? 0),
      energyCost: x?.energyCost == null ? null : Number(x.energyCost), energySource: x?.source ?? null,
      shared: Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<string, number>, sharedTotal: 0,
      depreciation: invs.filter((i) => i.site_id === s.id).reduce((a, i) => a + depreciationIn({ amount: Number(i.amount_minor), investedOn: i.d, lifeMonths: Number(i.life_months) }, m), 0),
      contribution: 0,
    }];
  }));
  const unallocated: Array<{ id: string; description: string; amount: number; currency: string }> = [];
  for (const c of costs) {
    const eligible = sites.filter((s) => s.currency === c.currency && (!c.site_ids?.length || c.site_ids.includes(s.id)));
    if (!eligible.length) { unallocated.push({ id: String(c.id), description: c.description, amount: Number(c.amount_minor), currency: c.currency }); continue; }
    const w = eligible.map((s) => {
      const r = rows.get(s.id)!;
      return c.basis === 'kwh' ? r.kwh : c.basis === 'sessions' ? r.sessions : c.basis === 'revenue' ? r.revenue : 1;
    });
    split(Number(c.amount_minor), w).forEach((part, i) => {
      const r = rows.get(eligible[i]!.id)!;
      r.shared[c.category] = (r.shared[c.category] ?? 0) + part;
      r.sharedTotal += part;
    });
  }
  const out = [...rows.values()].map((r) => ({ ...r, contribution: r.revenue - (r.energyCost ?? 0) - r.sharedTotal - r.depreciation }));
  const totals: Record<string, { revenue: number; energyCost: number; shared: number; depreciation: number; contribution: number }> = {};
  for (const r of out) {
    const t = totals[r.currency] ?? { revenue: 0, energyCost: 0, shared: 0, depreciation: 0, contribution: 0 };
    t.revenue += r.revenue; t.energyCost += r.energyCost ?? 0; t.shared += r.sharedTotal; t.depreciation += r.depreciation; t.contribution += r.contribution;
    totals[r.currency] = t;
  }
  return { month: m, sites: out, totals, unallocated, costs: costs.length };
}
