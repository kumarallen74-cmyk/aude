import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { forecast } from './rolling-forecast.js';
import { review } from './site-pnl.js';
import { save as saveBudget, BudgetError } from './budgets.js';
import { xlsx } from './xlsx.js';

/**
 * Budget planning (v1.37.0): next year's budget, built and approved before it is used.
 *
 *   plans       per year and currency, versioned (v1, v2, …): draft → submitted → approved, or rejected (a new version
 *               is made from it). Approving a version supersedes the one approved before.
 *   lines       per month and category, for a site or for the organisation: revenue, energy cost, rent, maintenance,
 *               insurance (sites); staff, marketing, IT, other opex, capex (the organisation, its departments)
 *   seeding     forecast: the rolling forecast's revenue and energy cost per site by calendar month, and each site's
 *               rent, maintenance and insurance at the last twelve months' monthly average (Site P&L), grown by the
 *               growth %; copy: another version's lines; empty
 *   approval    by a second person with finance:approve (not the one who submitted it). Approved, each site's revenue
 *               and energy cost are published to Budgets for every month not yet locked, so budget vs actual and the
 *               forecast's alerts use them; the other lines stay in the plan.
 */

export class PlanError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const SITE_CATEGORIES = ['revenue', 'energy_cost', 'rent', 'maintenance', 'insurance'] as const;
export const ORG_CATEGORIES = ['staff', 'marketing', 'it', 'other_opex', 'capex'] as const;
const CATEGORIES = [...SITE_CATEGORIES, ...ORG_CATEGORIES] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const thisYear = (now = new Date()) => Number(new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 4));

/** Grow a monthly amount by a yearly % (compounded monthly from the start of the year). Pure. */
export function grown(amount: number, growthPct: number, monthIndex: number): number {
  return Math.round(amount * Math.pow(1 + growthPct / 100, monthIndex / 12));
}

const P_SELECT = `SELECT p.*, c.name AS created_by_name, s.name AS submitted_by_name, d.name AS decided_by_name FROM budget_plan p
  LEFT JOIN app_user c ON c.id = p.created_by LEFT JOIN app_user s ON s.id = p.submitted_by LEFT JOIN app_user d ON d.id = p.decided_by`;
const pView = (p: any) => ({
  id: String(p.id), year: p.year, version: p.version, name: p.name, currency: p.currency, status: p.status, seededFrom: p.seeded_from ?? null, note: p.note ?? null,
  createdBy: p.created_by_name ?? null, submittedBy: p.submitted_by_name ?? null, submittedAt: p.submitted_at ? new Date(p.submitted_at).toISOString() : null,
  decidedBy: p.decided_by_name ?? null, decidedAt: p.decided_at ? new Date(p.decided_at).toISOString() : null, decisionNote: p.decision_note ?? null,
});

async function pRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new PlanError(404, 'No such plan.');
  const r = await outsideRequestScope(() => one<any>(`${P_SELECT} WHERE p.id = $1 AND p.org_id = $2`, [id, orgId]));
  if (!r) throw new PlanError(404, 'No such plan.');
  return r;
}

export async function list(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(`${P_SELECT} WHERE p.org_id = $1 ORDER BY p.year DESC, p.currency, p.version DESC`, [orgId]));
  const totals = await outsideRequestScope(() => many<any>(`SELECT plan_id, category, sum(amount_minor)::bigint AS t FROM budget_plan_line WHERE org_id = $1 GROUP BY 1, 2`, [orgId]));
  return rows.map((r) => { const v = pView(r); const t = (c: string) => Number(totals.find((x) => String(x.plan_id) === v.id && x.category === c)?.t ?? 0); return { ...v, revenue: t('revenue'), costs: CATEGORIES.filter((c) => c !== 'revenue' && c !== 'capex').reduce((a, c) => a + t(c), 0), capex: t('capex') }; });
}

export async function get(orgId: string, id: string) {
  const p = pView(await pRow(orgId, id));
  const lines = await outsideRequestScope(() => many<any>(`SELECT l.site_id, s.name AS site, l.month, l.category, l.amount_minor FROM budget_plan_line l LEFT JOIN site s ON s.id = l.site_id WHERE l.plan_id = $1 ORDER BY s.name NULLS FIRST, l.month, l.category`, [p.id]));
  const months = Array.from({ length: 12 }, (_, i) => `${p.year}-${String(i + 1).padStart(2, '0')}`);
  const byCat = Object.fromEntries(CATEGORIES.map((c) => [c, months.map((m) => lines.filter((l) => l.category === c && l.month === m).reduce((a, l) => a + Number(l.amount_minor), 0))]));
  const siteIds = [...new Set(lines.filter((l) => l.site_id).map((l) => l.site_id))];
  const sites = siteIds.map((sid) => {
    const mine = lines.filter((l) => l.site_id === sid);
    const sum = (c: string) => mine.filter((l) => l.category === c).reduce((a, l) => a + Number(l.amount_minor), 0);
    const t = { revenue: sum('revenue'), energy_cost: sum('energy_cost'), rent: sum('rent'), maintenance: sum('maintenance'), insurance: sum('insurance') };
    return { siteId: sid, site: mine[0]?.site ?? sid, ...t, contribution: t.revenue - t.energy_cost - t.rent - t.maintenance - t.insurance,
      months: months.map((m) => Object.fromEntries([['month', m], ...SITE_CATEGORIES.map((c) => [c, Number(mine.find((l) => l.month === m && l.category === c)?.amount_minor ?? 0)])])) };
  });
  const org = Object.fromEntries(ORG_CATEGORIES.map((c) => [c, months.map((m) => Number(lines.find((l) => !l.site_id && l.month === m && l.category === c)?.amount_minor ?? 0))]));
  const total = (c: string) => (byCat[c] as number[]).reduce((a, x) => a + x, 0);
  const opex = CATEGORIES.filter((c) => c !== 'revenue' && c !== 'capex').reduce((a, c) => a + total(c), 0);
  const prev = await outsideRequestScope(() => one<any>(`SELECT id, version FROM budget_plan WHERE org_id = $1 AND year = $2 AND currency = $3 AND status IN ('approved', 'superseded') AND id <> $4 ORDER BY version DESC LIMIT 1`, [orgId, p.year, p.currency, p.id]));
  const prevRevenue = prev ? Number((await outsideRequestScope(() => one<any>(`SELECT COALESCE(sum(amount_minor), 0)::bigint AS t FROM budget_plan_line WHERE plan_id = $1 AND category = 'revenue'`, [prev.id])))?.t ?? 0) : null;
  return { ...p, months, byCategory: byCat, sites, organisation: org,
    totals: { revenue: total('revenue'), opex, result: total('revenue') - opex, capex: total('capex') },
    previous: prev ? { id: String(prev.id), version: prev.version, revenue: prevRevenue } : null };
}

/** Create the next version for a year and currency, seeded. */
export async function create(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const year = Number(b.year ?? thisYear(now) + 1);
  if (!Number.isInteger(year) || year < thisYear(now) || year > thisYear(now) + 5) throw new PlanError(422, 'year is this year to five years ahead.');
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new PlanError(422, 'currency is an ISO code.');
  const seed = String(b.seed ?? 'forecast');
  if (!['forecast', 'copy', 'empty'].includes(seed)) throw new PlanError(422, 'seed is forecast, copy or empty.');
  const growth = b.growthPct == null || b.growthPct === '' ? 0 : Number(b.growthPct);
  if (!Number.isFinite(growth) || growth < -50 || growth > 200) throw new PlanError(422, 'growthPct is −50 to 200.');
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const lines: Array<{ siteId: string | null; month: string; category: string; amount: number }> = [];
  if (seed === 'copy') {
    const src = await pRow(orgId, String(b.fromPlanId ?? ''));
    if (src.currency !== currency) throw new PlanError(422, `The plan copied is in ${src.currency}.`);
    const ls = await outsideRequestScope(() => many<any>(`SELECT site_id, month, category, amount_minor FROM budget_plan_line WHERE plan_id = $1`, [src.id]));
    for (const l of ls) lines.push({ siteId: l.site_id ?? null, month: `${year}${String(l.month).slice(4)}`, category: l.category, amount: grown(Number(l.amount_minor), growth, Number(String(l.month).slice(5)) - 1) });
  } else if (seed === 'forecast') {
    const [fc, past] = await Promise.all([forecast(orgId), review(orgId, { months: 12 }, now)]);
    for (const s of fc.sites.filter((x) => x.currency === currency)) {
      const pr = past.sites.find((x) => x.siteId === s.siteId);
      months.forEach((m, i) => {
        const f = s.forecast.find((x) => x.month.slice(5) === m.slice(5));
        if (f) { lines.push({ siteId: s.siteId, month: m, category: 'revenue', amount: grown(Math.max(0, Math.round(f.revenue)), growth, i) }, { siteId: s.siteId, month: m, category: 'energy_cost', amount: grown(Math.max(0, Math.round(f.energyCost)), growth, i) }); }
        if (pr) for (const [c, v] of [['rent', pr.rent], ['maintenance', pr.maintenance], ['insurance', pr.insurance]] as const) if (v > 0) lines.push({ siteId: s.siteId, month: m, category: c, amount: grown(Math.round(v / 12), growth, i) });
      });
    }
  }
  const planId = await outsideRequestScope(() => tx(async (client) => {
    const v = await client.query<{ n: number }>(`SELECT COALESCE(max(version), 0)::int + 1 AS n FROM budget_plan WHERE org_id = $1 AND year = $2 AND currency = $3`, [orgId, year, currency]);
    const version = v.rows[0]!.n;
    const name = String(b.name ?? '').trim() || `Budget ${year} v${version}`;
    const p = await client.query<{ id: string }>(`INSERT INTO budget_plan (org_id, year, version, name, currency, seeded_from, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [orgId, year, version, name.slice(0, 120), currency, seed === 'copy' ? `copy of plan ${b.fromPlanId}${growth ? ` +${growth}%` : ''}` : seed === 'forecast' ? `rolling forecast${growth ? ` +${growth}%` : ''}` : 'empty', b.note ? String(b.note).slice(0, 1000) : null, userId]);
    for (const l of lines) await client.query(`INSERT INTO budget_plan_line (org_id, plan_id, site_id, month, category, amount_minor) VALUES ($1, $2, $3, $4, $5, $6)`, [orgId, p.rows[0]!.id, l.siteId, l.month, l.category, l.amount]);
    return String(p.rows[0]!.id);
  }));
  return get(orgId, planId);
}

/** Set lines of a draft: [{ siteId (none: the organisation), month, category, amount }]. */
export async function setLines(orgId: string, id: string, b: Record<string, unknown>) {
  const p = await pRow(orgId, id);
  if (p.status !== 'draft') throw new PlanError(409, `The plan is ${p.status}: make a new version to change it.`);
  const ls = Array.isArray(b.lines) ? b.lines as Array<Record<string, unknown>> : [];
  if (!ls.length || ls.length > 2000) throw new PlanError(422, 'lines is a list of 1 to 2000 lines.');
  const sites = new Set((await outsideRequestScope(() => many<{ id: string }>(`SELECT id FROM site WHERE org_id = $1`, [orgId]))).map((s) => s.id));
  for (const l of ls) {
    const site = l.siteId == null || l.siteId === '' ? null : String(l.siteId), month = String(l.month ?? ''), cat = String(l.category ?? ''), amt = Number(l.amount);
    if (site && (!UUID_RE.test(site) || !sites.has(site))) throw new PlanError(422, 'No such site.');
    if (!new RegExp(`^${p.year}-(0[1-9]|1[0-2])$`).test(month)) throw new PlanError(422, `month is a month of ${p.year}.`);
    if (!(CATEGORIES as readonly string[]).includes(cat)) throw new PlanError(422, `category is one of ${CATEGORIES.join(', ')}.`);
    if (site ? !(SITE_CATEGORIES as readonly string[]).includes(cat) : !(ORG_CATEGORIES as readonly string[]).includes(cat)) throw new PlanError(422, `${cat} is budgeted for ${site ? 'the organisation' : 'a site'}.`);
    if (!Number.isInteger(amt) || amt < 0) throw new PlanError(422, 'amount is a whole amount, 0 or more.');
  }
  for (const l of ls) {
    await outsideRequestScope(() => query(
      `INSERT INTO budget_plan_line (org_id, plan_id, site_id, month, category, amount_minor) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (plan_id, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid), month, category) DO UPDATE SET amount_minor = EXCLUDED.amount_minor`,
      [orgId, p.id, l.siteId == null || l.siteId === '' ? null : String(l.siteId), String(l.month), String(l.category), Number(l.amount)]));
  }
  return get(orgId, String(p.id));
}

export async function submit(orgId: string, id: string, userId: string | null) {
  const p = await pRow(orgId, id);
  if (p.status !== 'draft') throw new PlanError(409, `The plan is ${p.status}.`);
  await outsideRequestScope(() => query(`UPDATE budget_plan SET status = 'submitted', submitted_by = $2, submitted_at = now() WHERE id = $1`, [p.id, userId]));
  return get(orgId, String(p.id));
}

export async function decide(orgId: string, id: string, b: Record<string, unknown>, who: { userId: string | null; canApprove: boolean }) {
  const p = await pRow(orgId, id);
  if (p.status !== 'submitted') throw new PlanError(409, `The plan is ${p.status}: submit it first.`);
  if (!who.canApprove) throw new PlanError(403, 'Approving a budget needs finance:approve.');
  if (who.userId && p.submitted_by === who.userId) throw new PlanError(403, 'A second person approves the budget, not the one who submitted it.');
  const approve = b.approve === true || b.approve === 'true';
  const note = b.note ? String(b.note).slice(0, 1000) : null;
  if (!approve && !note) throw new PlanError(422, 'Say why the budget is rejected (note).');
  if (!approve) {
    await outsideRequestScope(() => query(`UPDATE budget_plan SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [p.id, who.userId, note]));
    return { ...(await get(orgId, String(p.id))), published: 0, skipped: [] as string[] };
  }
  // Publish each site's revenue and energy cost to Budgets, month by month (locked months are left as they are).
  const lines = await outsideRequestScope(() => many<any>(`SELECT site_id, month, category, amount_minor FROM budget_plan_line WHERE plan_id = $1 AND site_id IS NOT NULL AND category IN ('revenue', 'energy_cost')`, [p.id]));
  const keys = [...new Set(lines.map((l) => `${l.site_id}|${l.month}`))];
  let published = 0;
  const skipped = new Set<string>();
  for (const k of keys) {
    const [site, month] = k.split('|') as [string, string];
    const v = (c: string) => Number(lines.find((l) => l.site_id === site && l.month === month && l.category === c)?.amount_minor ?? 0);
    try { await saveBudget(orgId, { siteId: site, month, revenue: v('revenue'), energyCost: v('energy_cost') }, who.userId); published++; } catch (e) { if (e instanceof BudgetError) { skipped.add(month); continue; } throw e; }
  }
  await outsideRequestScope(() => query(`UPDATE budget_plan SET status = 'superseded' WHERE org_id = $1 AND year = $2 AND currency = $3 AND status = 'approved' AND id <> $4`, [orgId, p.year, p.currency, p.id]));
  await outsideRequestScope(() => query(`UPDATE budget_plan SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [p.id, who.userId, note]));
  return { ...(await get(orgId, String(p.id))), published, skipped: [...skipped].sort() };
}

const LABEL: Record<string, string> = { revenue: 'Revenue', energy_cost: 'Energy cost', rent: 'Rent', maintenance: 'Maintenance', insurance: 'Insurance', staff: 'Staff', marketing: 'Marketing', it: 'IT', other_opex: 'Other opex', capex: 'Capex' };

export async function planXlsx(orgId: string, id: string): Promise<Buffer> {
  const p = await get(orgId, id);
  return xlsx([
    { name: 'Summary', rows: [['Category', ...p.months, 'Year'], ...CATEGORIES.map((c) => [LABEL[c]!, ...(p.byCategory[c] as number[]), (p.byCategory[c] as number[]).reduce((a, x) => a + x, 0)]),
      [], ['Result (revenue − opex)', ...p.months.map((_, i) => (p.byCategory.revenue as number[])[i]! - CATEGORIES.filter((c) => c !== 'revenue' && c !== 'capex').reduce((a, c) => a + (p.byCategory[c] as number[])[i]!, 0)), p.totals.result]],
      widths: [24, ...p.months.map(() => 13), 15], formats: [null, ...p.months.map(() => 'money' as const), 'money'] },
    { name: 'Sites', rows: [['Site', 'Revenue', 'Energy', 'Rent', 'Maintenance', 'Insurance', 'Contribution'], ...p.sites.map((s) => [s.site, s.revenue, s.energy_cost, s.rent, s.maintenance, s.insurance, s.contribution])],
      widths: [28, 15, 14, 13, 13, 13, 15], formats: [null, 'money', 'money', 'money', 'money', 'money', 'money'] },
  ]);
}
