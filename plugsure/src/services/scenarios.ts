import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { xlsx } from './xlsx.js';

/**
 * Scenario planning and sensitivity (v1.40.0): what-if on the next twelve months.
 *
 *   base         the rolling forecast with no growth, price or energy change: revenue and energy cost per month; the
 *                running costs at the last twelve months' monthly average (the ledger's expenses other than energy
 *                and depreciation); the cash today (Cash position); the debt service and debt (Lenders)
 *   assumptions  tariff (price, with an optional elasticity of volume to it), utilisation (volume), the energy price,
 *                running costs, and new sites: from a month, how many, capex each, revenue and running costs each a
 *                month at maturity, reached over a ramp (6 months by default)
 *   result       per month: revenue, energy, running costs, EBITDA, capex, debt service, net cash and cash; the lowest
 *                cash and when; the runway (the first month cash would go below zero); each covenant (Lenders)
 *                tested on the scenario's twelve-month EBITDA and lowest cash
 *   compare      the base and saved scenarios side by side
 *   sensitivity  the twelve-month EBITDA when each driver moves ±10 points from a scenario (a tornado)
 */

export class ScenarioError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const ERR = (s: number, m: string) => new ScenarioError(s, m);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
const addMonths = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + mo - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const monthsBetween = (a: string, b: string) => { const [ya, ma] = a.split('-').map(Number) as [number, number]; const [yb, mb] = b.split('-').map(Number) as [number, number]; return (yb - ya) * 12 + (mb - ma); };
const r = Math.round;

export interface NewSites { fromMonth: string; count: number; capexPerSite: number; revenuePerSiteMonth: number; opexPerSiteMonth: number; rampMonths: number }
export interface Assumptions { tariffPct: number; elasticity: number; utilisationPct: number; energyPricePct: number; opexPct: number; newSites: NewSites[] }
export interface Base { months: string[]; revenue: number[]; energy: number[]; opex: number; cash: number; debtService: number; interest: number; debt: number }

export const ZERO: Assumptions = { tariffPct: 0, elasticity: 0, utilisationPct: 0, energyPricePct: 0, opexPct: 0, newSites: [] };

/** Validate and fill assumptions. */
export function assumptionsOf(raw: unknown): Assumptions {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (k: string, lo: number, hi: number, d = 0) => { const v = a[k] == null || a[k] === '' ? d : Number(a[k]); if (!Number.isFinite(v) || v < lo || v > hi) throw ERR(422, `${k} is ${lo} to ${hi}.`); return v; };
  const sites = Array.isArray(a.newSites) ? a.newSites : [];
  if (sites.length > 20) throw ERR(422, 'At most 20 new-site lines.');
  return {
    tariffPct: num('tariffPct', -90, 300), elasticity: num('elasticity', -5, 0), utilisationPct: num('utilisationPct', -90, 500), energyPricePct: num('energyPricePct', -90, 500), opexPct: num('opexPct', -90, 500),
    newSites: sites.map((s: any) => {
      const fromMonth = String(s?.fromMonth ?? '');
      if (!MONTH_RE.test(fromMonth)) throw ERR(422, 'newSites[].fromMonth is YYYY-MM.');
      const n = (k: string, lo: number, hi: number, d?: number) => { const v = s?.[k] == null || s?.[k] === '' ? d : Number(s[k]); if (v == null || !Number.isFinite(v) || v < lo || v > hi) throw ERR(422, `newSites[].${k} is ${lo} to ${hi}.`); return v; };
      return { fromMonth, count: n('count', 1, 1000)!, capexPerSite: n('capexPerSite', 0, 1e15, 0)!, revenuePerSiteMonth: n('revenuePerSiteMonth', 0, 1e15, 0)!, opexPerSiteMonth: n('opexPerSiteMonth', 0, 1e15, 0)!, rampMonths: n('rampMonths', 1, 36, 6)! };
    }),
  };
}

/** The scenario's months from the base. Pure. */
export function project(b: Base, a: Assumptions) {
  const volume = (1 + a.utilisationPct / 100) * (1 + (a.elasticity * a.tariffPct) / 100);
  const energyRatio = b.revenue.reduce((x, y) => x + y, 0) ? b.energy.reduce((x, y) => x + y, 0) / b.revenue.reduce((x, y) => x + y, 0) : 0;
  let cash = b.cash;
  const rows = b.months.map((m, k) => {
    let siteRev = 0, siteOpex = 0, capex = 0;
    for (const s of a.newSites) {
      const age = monthsBetween(s.fromMonth, m);
      if (age < 0) continue;
      if (age === 0) capex += s.count * s.capexPerSite;
      const ramp = Math.min(1, (age + 1) / s.rampMonths);
      siteRev += s.count * s.revenuePerSiteMonth * ramp; siteOpex += s.count * s.opexPerSiteMonth;
    }
    const revenue = r(b.revenue[k]! * volume * (1 + a.tariffPct / 100) + siteRev);
    const energy = r((b.energy[k]! * volume + siteRev * energyRatio) * (1 + a.energyPricePct / 100));
    const opex = r(b.opex * (1 + a.opexPct / 100) + siteOpex);
    const ebitda = revenue - energy - opex;
    const debtService = r(b.debtService);
    const net = ebitda - capex - debtService;
    cash += net;
    return { month: m, revenue, energy, opex, ebitda, capex: r(capex), debtService, net, cash: r(cash) };
  });
  const sum = (k: 'revenue' | 'energy' | 'opex' | 'ebitda' | 'capex' | 'net') => rows.reduce((x, y) => x + y[k], 0);
  const low = rows.reduce((mn, x) => (x.cash < mn.cash ? x : mn), rows[0] ?? { cash: b.cash, month: b.months[0] ?? '' });
  const neg = rows.findIndex((x) => x.cash < 0);
  return {
    rows, totals: { revenue: sum('revenue'), energy: sum('energy'), opex: sum('opex'), ebitda: sum('ebitda'), capex: sum('capex'), net: sum('net'), marginPct: sum('revenue') ? Math.round((sum('ebitda') / sum('revenue')) * 1000) / 10 : null },
    minCash: low ? low.cash : b.cash, minCashMonth: low?.month ?? null, runwayMonths: neg < 0 ? null : neg, endCash: rows.at(-1)?.cash ?? b.cash,
  };
}

/** EBITDA over the twelve months when each driver moves ±10 points. Pure. */
export function sensitivity(b: Base, a: Assumptions, step = 10) {
  const base = project(b, a).totals.ebitda;
  const drivers: Array<[keyof Assumptions, string]> = [['tariffPct', 'Tariff'], ['utilisationPct', 'Utilisation'], ['energyPricePct', 'Energy price'], ['opexPct', 'Running costs']];
  return drivers.map(([k, label]) => {
    const lo = project(b, { ...a, [k]: (a[k] as number) - step }).totals.ebitda, hi = project(b, { ...a, [k]: (a[k] as number) + step }).totals.ebitda;
    return { driver: k, label, step, down: lo - base, up: hi - base, range: Math.abs(hi - lo) };
  }).sort((x, y) => y.range - x.range);
}

async function baseOf(orgId: string, currency: string, now = new Date()): Promise<Base> {
  const [rf, gl, cp, ld] = await Promise.all([import('./rolling-forecast.js'), import('./general-ledger.js'), import('./cash-position.js'), import('./lenders.js')]);
  const f = await rf.forecast(orgId, { growthPct: 0, pricePct: 0, energyPct: 0 });
  const t = f.totals[currency];
  const months = t ? t.map((x) => x.month) : Array.from({ length: 12 }, (_, k) => addMonths(thisMonth(now), k));
  const last = addMonths(thisMonth(now), -1), from = addMonths(last, -11);
  const bal = await gl.balances(orgId, currency, from, last);
  const opex12 = bal.filter((x) => x.type === 'expense' && !x.code.startsWith('5') && !['6400', '6410'].includes(x.code)).reduce((s, x) => s + x.balance, 0);
  const pos = await cp.position(orgId, {}, now).catch(() => null);
  const m = await ld.measures(orgId, last, currency, now).catch(() => null);
  return {
    months, revenue: t ? t.map((x) => x.revenue) : months.map(() => 0), energy: t ? t.map((x) => x.energyCost) : months.map(() => 0),
    opex: r(Math.max(0, opex12) / 12), cash: pos?.totals[currency]?.total ?? 0, debtService: (m?.debtService ?? 0) / 12, interest: m?.interest ?? 0, debt: m?.debt ?? 0,
  };
}

async function covenantsFor(orgId: string, currency: string, b: Base, p: ReturnType<typeof project>) {
  const ld = await import('./lenders.js');
  const cs = (await ld.covenants(orgId)).filter((c: any) => c.enabled && c.currency === currency);
  return cs.map((c: any) => ({ id: c.id, kind: c.kind, threshold: c.threshold, lender: c.lender ?? null, ...ld.evaluate(c.kind, c.threshold, { ebitda: p.totals.ebitda, interest: b.interest, debtService: r(b.debtService * 12), debt: b.debt, cash: p.minCash }) }));
}

const sView = (s: any) => ({ id: String(s.id), name: s.name, currency: s.currency, assumptions: assumptionsOf(s.assumptions), updatedAt: new Date(s.updated_at).toISOString() });

/** The base and the saved scenarios (or the ids given), computed side by side, with the sensitivity of the first. */
export async function compare(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const currency = q.currency == null || q.currency === '' ? LEGACY_CURRENCY : String(q.currency).toUpperCase();
  const ids = q.ids == null || q.ids === '' ? null : String(q.ids).split(',').filter((x) => /^\d{1,18}$/.test(x));
  const saved = await outsideRequestScope(() => many<any>(`SELECT * FROM finance_scenario WHERE org_id = $1 AND currency = $2 AND archived_at IS NULL ${ids ? 'AND id = ANY($3::bigint[])' : ''} ORDER BY id`, ids ? [orgId, currency, ids] : [orgId, currency]));
  const b = await baseOf(orgId, currency, now);
  const items = [{ id: null as string | null, name: 'Base', currency, assumptions: ZERO, updatedAt: null as string | null }, ...saved.map(sView)];
  const out = [];
  for (const s of items) { const p = project(b, s.assumptions); out.push({ ...s, ...p, covenants: await covenantsFor(orgId, currency, b, p) }); }
  const focus = out.find((s) => s.id === (q.sensitivityOf ? String(q.sensitivityOf) : null)) ?? out[0]!;
  return { currency, base: { months: b.months, opexPerMonth: b.opex, cash: b.cash, debtServicePerMonth: r(b.debtService), debt: b.debt }, scenarios: out, sensitivity: { of: focus.name, drivers: sensitivity(b, focus.assumptions as Assumptions) } };
}

export async function create(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 80) throw ERR(422, 'name is required (up to 80 characters).');
  const currency = b.currency == null || b.currency === '' ? LEGACY_CURRENCY : String(b.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw ERR(422, 'currency is an ISO code.');
  const a = assumptionsOf(b.assumptions);
  const r0 = await outsideRequestScope(() => one<any>(`INSERT INTO finance_scenario (org_id, name, currency, assumptions, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [orgId, name, currency, JSON.stringify(a), userId]));
  return sView(r0);
}

export async function update(orgId: string, id: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(id)) throw ERR(404, 'No such scenario.');
  const cur = await outsideRequestScope(() => one<any>(`SELECT * FROM finance_scenario WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [id, orgId]));
  if (!cur) throw ERR(404, 'No such scenario.');
  if (b.archive === true) { await outsideRequestScope(() => query(`UPDATE finance_scenario SET archived_at = now() WHERE id = $1`, [id])); return { id, archived: true }; }
  const name = b.name == null || b.name === '' ? cur.name : String(b.name).trim().slice(0, 80);
  const a = b.assumptions === undefined ? assumptionsOf(cur.assumptions) : assumptionsOf(b.assumptions);
  const r0 = await outsideRequestScope(() => one<any>(`UPDATE finance_scenario SET name = $3, assumptions = $4, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`, [id, orgId, name, JSON.stringify(a)]));
  return sView(r0);
}

export async function compareXlsx(orgId: string, q: Record<string, unknown> = {}): Promise<Buffer> {
  const c = await compare(orgId, q);
  return xlsx([
    { name: 'Compare', rows: [['Scenario', 'Revenue', 'Energy', 'Running costs', 'EBITDA', 'Margin %', 'Capex', 'Net cash', 'Lowest cash', 'In', 'Runway (months)', 'Covenants failing'],
      ...c.scenarios.map((s) => [s.name, s.totals.revenue, s.totals.energy, s.totals.opex, s.totals.ebitda, s.totals.marginPct, s.totals.capex, s.totals.net, s.minCash, s.minCashMonth ?? '', s.runwayMonths ?? '12+', s.covenants.filter((x: any) => x.passed === false).length])],
      widths: [24, 16, 16, 16, 16, 9, 16, 16, 16, 9, 10, 10], formats: [null, 'money', 'money', 'money', 'money', null, 'money', 'money', 'money', null, null, null] },
    ...c.scenarios.map((s) => ({ name: s.name.slice(0, 28).replace(/[\\/?*[\]:]/g, ' ') || 'Scenario', rows: [['Month', 'Revenue', 'Energy', 'Running costs', 'EBITDA', 'Capex', 'Debt service', 'Net cash', 'Cash'], ...s.rows.map((x) => [x.month, x.revenue, x.energy, x.opex, x.ebitda, x.capex, x.debtService, x.net, x.cash])],
      widths: [9, 16, 16, 16, 16, 16, 16, 16, 16], formats: [null, 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money'] as Array<'money' | null> })),
    { name: 'Sensitivity', rows: [['Driver', `−${c.sensitivity.drivers[0]?.step ?? 10} points`, `+${c.sensitivity.drivers[0]?.step ?? 10} points`], ...c.sensitivity.drivers.map((d) => [d.label, d.down, d.up])], widths: [18, 18, 18], formats: [null, 'money', 'money'] },
  ]);
}

