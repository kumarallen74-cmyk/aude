import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { month as energyMonth, lastMonths } from './energy-margin.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { consolidate } from './fx.js';

/**
 * Budgets vs actuals (v1.20.0). A budget is set per month for the organisation (all sites) or for one site, per
 * currency: revenue (before tax), energy cost, gateway fees and owners' share. Actuals:
 *
 *   revenue       the charge records' subtotal (services/energy-margin.ts)
 *   energy cost   bills recorded, or the cost per kWh × kWh delivered (estimate)
 *   gateway fees  the organisation's own payments accounts: fees and VAT on fees (Finance's ledger); organisation only
 *   owner share   the month's owner statements (finalised or not); organisation only
 *
 * Variance = actual − budget. The worker checks the current month to date every day from the 7th: revenue below its
 * pro-rated budget, or energy cost above it, by more than the organisation's threshold (default 15%) raises
 * finance.budget_off_track; it resolves when the month is back within it.
 */

export class BudgetError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const OFF_TRACK = 'finance.budget_off_track';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const LINES = ['revenue', 'energyCost', 'fees', 'ownerShare'] as const;
type Line = typeof LINES[number];
const COL: Record<Line, string> = { revenue: 'revenue_minor', energyCost: 'energy_cost_minor', fees: 'fees_minor', ownerShare: 'owner_share_minor' };

export async function settings(orgId: string) {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  return {
    budgetAlertPct: r?.budget_alert_pct ?? 15,
    dunning: {
      enabled: Boolean(r?.dunning_enabled), steps: (r?.dunning_steps ?? [-3, 7, 14, 30]) as number[], channels: (r?.dunning_channels ?? ['email']) as string[],
      whatsappTemplate: r?.wa_template_name ? { name: r.wa_template_name as string, lang: r.wa_template_lang as string } : null,
    },
  };
}

/** Actuals of a month for the organisation (site NULL) and each site, by currency. */
async function actuals(orgId: string, m: string) {
  const [e, fees, shares] = await Promise.all([
    energyMonth(orgId, m),
    outsideRequestScope(() => many<{ currency: string; fees: string }>(
      `SELECT g.currency, COALESCE(sum(g.fee + g.vat), 0) AS fees FROM gateway_transaction g
        WHERE g.org_id = $1 AND g.kind = 'payment' AND g.status = 'success' AND to_char(g.gateway_created_at AT TIME ZONE $3, 'YYYY-MM') = $2 GROUP BY 1`, [orgId, m, zone()])),
    outsideRequestScope(() => many<{ currency: string; share: string }>(
      `SELECT currency, COALESCE(sum(owner_share_minor), 0) AS share FROM commission_statement WHERE org_id = $1 AND owner_id IS NOT NULL AND to_char(period, 'YYYY-MM') = $2 GROUP BY 1`, [orgId, m])),
  ]);
  const site = new Map(e.sites.map((s) => [s.siteId, { currency: s.currency, revenue: s.revenue, energyCost: s.energyCost, estimated: s.source === 'estimate' }]));
  const org = new Map<string, { revenue: number; energyCost: number | null; fees: number; ownerShare: number }>();
  for (const [cur, t] of Object.entries(e.totals)) org.set(cur, { revenue: t.revenue, energyCost: t.energyCost, fees: 0, ownerShare: 0 });
  for (const f of fees) { const o = org.get(f.currency) ?? { revenue: 0, energyCost: 0, fees: 0, ownerShare: 0 }; o.fees = Math.round(Number(f.fees)); org.set(f.currency, o); }
  for (const s of shares) { const o = org.get(s.currency) ?? { revenue: 0, energyCost: 0, fees: 0, ownerShare: 0 }; o.ownerShare = Number(s.share); org.set(s.currency, o); }
  return { site, org, sites: e.sites };
}

const variance = (actual: number | null | undefined, budget: number) => (actual == null || !budget ? null : { amount: actual - budget, pct: Math.round(((actual - budget) / budget) * 1000) / 10 });

/** A month's budget lines (organisation and sites) beside the actuals, with the variance. */
export async function compare(orgId: string, mRaw: unknown) {
  const m = String(mRaw ?? lastMonths(1)[0]);
  if (!MONTH_RE.test(m)) throw new BudgetError(400, 'month is YYYY-MM.');
  const [rows, act, st] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT b.*, s.name AS site_name FROM finance_budget b LEFT JOIN site s ON s.id = b.site_id WHERE b.org_id = $1 AND b.month = $2`, [orgId, m])),
    actuals(orgId, m), settings(orgId),
  ]);
  const line = (b: any, a: Partial<Record<Line, number | null>>, siteLevel: boolean) => Object.fromEntries(LINES.map((k) => {
    const budget = b ? Number(b[COL[k]]) : 0;
    const actual = siteLevel && (k === 'fees' || k === 'ownerShare') ? null : a[k] ?? null;
    return [k, { budget, actual, variance: variance(actual, budget) }];
  }));
  const currencies = new Set<string>([...act.org.keys(), ...rows.filter((r) => !r.site_id).map((r) => r.currency)]);
  const organisation = [...currencies].map((cur) => {
    const b = rows.find((r) => !r.site_id && r.currency === cur);
    return { currency: cur, budgeted: Boolean(b), lines: line(b, act.org.get(cur) ?? {}, false) };
  });
  const sites = act.sites.map((s) => {
    const b = rows.find((r) => r.site_id === s.siteId);
    return { siteId: s.siteId, site: s.site, currency: s.currency, budgeted: Boolean(b), estimated: s.source === 'estimate', lines: line(b, { revenue: s.revenue, energyCost: s.energyCost }, true) };
  });
  // (v1.21.0) The organisation's lines consolidated into the reporting currency, when one is set.
  let consolidated: null | { currency: string; missing: string[]; lines: Record<string, { budget: number; actual: number | null }> } = null;
  if (organisation.length) {
    const lines: Record<string, { budget: number; actual: number | null }> = {};
    let cur = '';
    const missing = new Set<string>();
    for (const k of LINES) {
      const b = await consolidate(orgId, m, Object.fromEntries(organisation.map((o) => [o.currency, (o.lines as any)[k].budget])));
      const a = await consolidate(orgId, m, Object.fromEntries(organisation.map((o) => [o.currency, (o.lines as any)[k].actual ?? 0])));
      if (!b || !a) break;
      cur = b.currency; [...b.missing, ...a.missing].forEach((x) => missing.add(x));
      lines[k] = { budget: b.amount, actual: a.amount };
    }
    if (cur) consolidated = { currency: cur, missing: [...missing], lines };
  }
  return { month: m, alertPct: st.budgetAlertPct, organisation, sites, consolidated };
}

/** Set (or replace) a budget line set for a month, organisation-wide (siteId null) or for a site. */
export async function save(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const m = String(b.month ?? '');
  if (!MONTH_RE.test(m)) throw new BudgetError(422, 'month is YYYY-MM.');
  let siteId: string | null = null, currency = String(b.currency ?? '');
  if (b.siteId) {
    const s = await outsideRequestScope(() => one<{ id: string; currency: string }>(
      `SELECT s.id, co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2`, [String(b.siteId), orgId]).catch(() => null));
    if (!s) throw new BudgetError(422, 'No such site.');
    siteId = s.id; currency = s.currency;
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new BudgetError(422, 'currency is the ISO code of the budget (e.g. the organisation\'s sites\' currency).');
  const v: Record<Line, number> = { revenue: 0, energyCost: 0, fees: 0, ownerShare: 0 };
  for (const k of LINES) {
    const x = b[k] == null || b[k] === '' ? 0 : Number(b[k]);
    if (!Number.isInteger(x) || x < 0) throw new BudgetError(422, `${k} is a whole number of the currency's minor unit, 0 or more.`);
    if (siteId && (k === 'fees' || k === 'ownerShare') && x) throw new BudgetError(422, 'A site\'s budget has revenue and energy cost only (fees and owner shares are budgeted for the organisation).');
    v[k] = x;
  }
  await outsideRequestScope(() => query(
    `INSERT INTO finance_budget (org_id, site_id, month, currency, revenue_minor, energy_cost_minor, fees_minor, owner_share_minor, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid), month, currency)
     DO UPDATE SET revenue_minor = EXCLUDED.revenue_minor, energy_cost_minor = EXCLUDED.energy_cost_minor, fees_minor = EXCLUDED.fees_minor,
                   owner_share_minor = EXCLUDED.owner_share_minor, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, siteId, m, currency, v.revenue, v.energyCost, v.fees, v.ownerShare, userId]));
  return { month: m, siteId, currency, ...v };
}

/** Copy every budget line of a month to the following months (e.g. a year ahead), replacing what is there. */
export async function copyForward(orgId: string, fromRaw: unknown, monthsRaw: unknown, userId: string | null) {
  const from = String(fromRaw ?? '');
  const n = Number(monthsRaw ?? 1);
  if (!MONTH_RE.test(from)) throw new BudgetError(422, 'from is YYYY-MM.');
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new BudgetError(422, 'months is 1 to 12.');
  const rows = await outsideRequestScope(() => many<any>(`SELECT * FROM finance_budget WHERE org_id = $1 AND month = $2`, [orgId, from]));
  if (!rows.length) throw new BudgetError(409, `No budget for ${from} to copy.`);
  let [y, m] = from.split('-').map(Number) as [number, number];
  let copied = 0;
  for (let i = 0; i < n; i++) {
    m++; if (m === 13) { m = 1; y++; }
    const to = `${y}-${String(m).padStart(2, '0')}`;
    for (const r of rows) {
      await save(orgId, { month: to, siteId: r.site_id, currency: r.currency, revenue: Number(r.revenue_minor), energyCost: Number(r.energy_cost_minor), fees: Number(r.fees_minor), ownerShare: Number(r.owner_share_minor) }, userId);
      copied++;
    }
  }
  return { copied };
}

export async function saveAlertPct(orgId: string, pctRaw: unknown, userId: string | null) {
  const p = Number(pctRaw);
  if (!Number.isInteger(p) || p < 1 || p > 100) throw new BudgetError(422, 'The alert threshold is 1 to 100 (%).');
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, budget_alert_pct, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET budget_alert_pct = EXCLUDED.budget_alert_pct, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, p, userId]));
  return { budgetAlertPct: p };
}

/**
 * The worker (daily): the current month to date against its pro-rated budget, from the 7th of the month. Returns the
 * number of lines off track.
 */
export async function checkOffTrack(now = new Date()): Promise<number> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
  const m = today.slice(0, 7), day = Number(today.slice(8, 10));
  const days = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  if (day < 7) return 0;
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(`SELECT DISTINCT org_id FROM finance_budget WHERE month = $1`, [m]));
  let off = 0;
  for (const { org_id: orgId } of orgs) {
    const c = await compare(orgId, m);
    const f = day / days, tol = c.alertPct / 100;
    const check = async (target: string, label: string, lines: any, currency: string) => {
      const problems: string[] = [];
      const rev = lines.revenue, en = lines.energyCost;
      if (rev.budget && rev.actual != null && rev.actual < rev.budget * f * (1 - tol)) problems.push(`revenue ${Math.round((rev.actual / (rev.budget * f)) * 100)}% of the budget so far`);
      if (en.budget && en.actual != null && en.actual > en.budget * f * (1 + tol)) problems.push(`energy cost ${Math.round((en.actual / (en.budget * f)) * 100)}% of the budget so far`);
      if (problems.length) {
        off++;
        await outsideRequestScope(() => persistAlert({ orgId, kind: OFF_TRACK, severity: 'warning', targetType: 'finance_budget', targetId: `${m}:${target}:${currency}`,
          message: `${label} is off budget for ${m} (day ${day} of ${days}): ${problems.join('; ')}. Finance → Budgets.` }));
      } else {
        await outsideRequestScope(() => resolveAlertsFor(orgId, OFF_TRACK, 'finance_budget', `${m}:${target}:${currency}`)).catch(() => 0);
      }
    };
    for (const o of c.organisation.filter((x) => x.budgeted)) await check('org', 'The organisation', o.lines, o.currency);
    for (const s of c.sites.filter((x) => x.budgeted)) await check(s.siteId, s.site, s.lines, s.currency);
  }
  return off;
}
