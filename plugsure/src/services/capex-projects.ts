import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { CATEGORIES as BILL_CATEGORIES } from './supplier-bills.js';
import { insert as insertAsset, AssetError, CATEGORIES as ASSET_CATEGORIES } from './fixed-assets.js';
import { reportingCurrency, currencies } from './fx.js';
import { assertOpen } from './finance-periods.js';
import { xlsx } from './xlsx.js';

/**
 * Capex projects (v1.33.0): building a site (chargers, installation, grid connection) as one project.
 *
 *   project     name, site, currency, budget by category (the supplier bills' categories), start and target dates;
 *               planned → active → completed (or cancelled)
 *   linked      purchase orders and supplier bills are linked to the project (same currency). Committed: approved
 *               orders not closed, less what has been billed on them. Actual: approved and paid bills (subtotal).
 *               Forecast at completion = actual + committed; the variance against the budget, per category and in all.
 *               The worker raises finance.capex_over_budget when the forecast is above the budget (resolved below).
 *   ledger      bills on an active project post to assets under construction (1610), not to expense
 *   complete    the actual cost (less bills already capitalised one by one) becomes one asset in the register, with its
 *               category, life and month in service; the ledger moves it from 1610 to fixed assets (1600)
 *   cancel      with a reason; the ledger writes what was spent off (8300)
 */

export class ProjectError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OVER = 'finance.capex_over_budget';
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const ERR = (s: number, m: string) => new ProjectError(s, m);

const P_SELECT = `SELECT p.*, to_char(p.start_on, 'YYYY-MM-DD') AS start_s, to_char(p.target_on, 'YYYY-MM-DD') AS target_s, to_char(p.completed_on, 'YYYY-MM-DD') AS completed_s, s.name AS site_name, fa.tag AS asset_tag
  FROM capex_project p LEFT JOIN site s ON s.id = p.site_id LEFT JOIN fixed_asset fa ON fa.id = p.asset_id`;

async function row(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new ProjectError(404, 'No such project.');
  const r = await outsideRequestScope(() => one<any>(`${P_SELECT} WHERE p.id = $1 AND p.org_id = $2`, [id, orgId]));
  if (!r) throw new ProjectError(404, 'No such project.');
  return r;
}

/** Actual, committed and forecast for projects (by category). */
async function figures(orgId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { actual: Record<string, number>; committed: number; bills: any[]; orders: any[] }>();
  const [bills, orders] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT b.id, b.capex_project_id::text AS p, b.number, b.category, b.subtotal_minor, b.status, b.purchase_order_id, b.capitalise, to_char(b.bill_date, 'YYYY-MM-DD') AS d, s.name AS supplier,
              (SELECT 1 FROM fixed_asset a WHERE a.supplier_bill_id = b.id AND a.voided_at IS NULL LIMIT 1) AS own_asset
         FROM supplier_bill b JOIN supplier s ON s.id = b.supplier_id WHERE b.org_id = $1 AND b.capex_project_id = ANY($2::bigint[]) AND b.status <> 'void' ORDER BY b.bill_date`, [orgId, ids])),
    outsideRequestScope(() => many<any>(
      `SELECT o.id, o.capex_project_id::text AS p, o.number, o.status, s.name AS supplier,
              (SELECT COALESCE(sum(l.quantity * l.unit_price_minor), 0) FROM purchase_order_line l WHERE l.order_id = o.id)::bigint AS total,
              (SELECT COALESCE(sum(b.subtotal_minor), 0) FROM supplier_bill b WHERE b.purchase_order_id = o.id AND b.status IN ('approved', 'paid'))::bigint AS billed
         FROM purchase_order o JOIN supplier s ON s.id = o.supplier_id WHERE o.org_id = $1 AND o.capex_project_id = ANY($2::bigint[]) AND o.status NOT IN ('cancelled', 'rejected')`, [orgId, ids])),
  ]);
  const out = new Map<string, { actual: Record<string, number>; committed: number; bills: any[]; orders: any[] }>();
  for (const id of ids) out.set(id, { actual: {}, committed: 0, bills: [], orders: [] });
  for (const b of bills) {
    const f = out.get(b.p)!;
    f.bills.push({ id: String(b.id), number: b.number, supplier: b.supplier, category: b.category, subtotal: Number(b.subtotal_minor), status: b.status, date: b.d, ownAsset: !!b.own_asset });
    if (b.status === 'approved' || b.status === 'paid') f.actual[b.category] = (f.actual[b.category] ?? 0) + Number(b.subtotal_minor);
  }
  for (const o of orders) {
    const f = out.get(o.p)!;
    const open = o.status === 'approved' ? Math.max(0, Number(o.total) - Number(o.billed)) : 0;
    f.orders.push({ id: String(o.id), number: o.number, supplier: o.supplier, status: o.status, total: Number(o.total), billed: Number(o.billed), open });
    f.committed += open;
  }
  return out;
}

function view(r: any, f: { actual: Record<string, number>; committed: number; bills: any[]; orders: any[] } | undefined) {
  const budget = (r.budget ?? {}) as Record<string, number>;
  const actualBy = f?.actual ?? {};
  const cats = [...new Set([...Object.keys(budget), ...Object.keys(actualBy)])];
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, x) => a + Number(x), 0);
  const totalBudget = sum(budget), actual = sum(actualBy), committed = f?.committed ?? 0, forecast = actual + committed;
  return {
    id: String(r.id), number: r.number, name: r.name, siteId: r.site_id ?? null, site: r.site_name ?? null, currency: r.currency, status: r.status,
    startOn: r.start_s ?? null, targetOn: r.target_s ?? null, completedOn: r.completed_s ?? null, assetCategory: r.asset_category, lifeMonths: r.life_months,
    asset: r.asset_id ? { id: String(r.asset_id), tag: r.asset_tag } : null, note: r.note ?? null,
    budget: totalBudget, actual, committed, forecast, remaining: totalBudget - forecast,
    variancePct: totalBudget ? Math.round(((forecast - totalBudget) / totalBudget) * 1000) / 10 : null, overBudget: totalBudget > 0 && forecast > totalBudget,
    spentPct: totalBudget ? Math.round((actual / totalBudget) * 1000) / 10 : null,
    categories: cats.map((c) => ({ category: c, budget: Number(budget[c] ?? 0), actual: actualBy[c] ?? 0 })),
    bills: f?.bills ?? [], orders: f?.orders ?? [],
  };
}

export async function list(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(`${P_SELECT} WHERE p.org_id = $1 ORDER BY (p.status IN ('completed', 'cancelled')), p.created_at DESC LIMIT 200`, [orgId]));
  const f = await figures(orgId, rows.map((r) => String(r.id)));
  const projects = rows.map((r) => { const v = view(r, f.get(String(r.id))); return { ...v, bills: undefined, orders: undefined, billCount: v.bills.length, orderCount: v.orders.length }; });
  const totals: Record<string, { budget: number; actual: number; committed: number }> = {};
  for (const p of projects.filter((x) => x.status === 'planned' || x.status === 'active')) {
    const t = (totals[p.currency] ??= { budget: 0, actual: 0, committed: 0 });
    t.budget += p.budget; t.actual += p.actual; t.committed += p.committed;
  }
  return { projects, totals, categories: [...BILL_CATEGORIES], assetCategories: [...ASSET_CATEGORIES] };
}

export async function get(orgId: string, id: string) {
  const r = await row(orgId, id);
  return view(r, (await figures(orgId, [String(r.id)])).get(String(r.id)));
}

function budgetOf(raw: unknown) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ProjectError(422, 'budget is { category: amount }.');
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(BILL_CATEGORIES as readonly string[]).includes(k)) throw new ProjectError(422, `budget: "${k}" is not a category (${BILL_CATEGORIES.join(', ')}).`);
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new ProjectError(422, `budget.${k} is a whole amount, 0 or more.`);
    if (n) out[k] = n;
  }
  return out;
}

export async function save(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await row(orgId, id) : null;
  if (cur && (cur.status === 'completed' || cur.status === 'cancelled')) throw new ProjectError(409, `The project is ${cur.status}.`);
  const v = (k: string, col: string) => (b[k] === undefined && cur ? cur[col] : b[k]);
  const name = String(v('name', 'name') ?? '').trim();
  if (name.length < 2 || name.length > 120) throw new ProjectError(422, 'name is 2 to 120 characters.');
  const siteId = v('siteId', 'site_id') == null || v('siteId', 'site_id') === '' ? null : String(v('siteId', 'site_id'));
  let currency = v('currency', 'currency') ? String(v('currency', 'currency')).toUpperCase() : null;
  if (siteId) {
    if (!UUID_RE.test(siteId)) throw new ProjectError(404, 'No such site.');
    const s = await outsideRequestScope(() => one<{ currency: string }>(`SELECT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2`, [siteId, orgId]));
    if (!s) throw new ProjectError(404, 'No such site.');
    currency ??= s.currency;
  }
  currency ??= (await reportingCurrency(orgId)) ?? (await currencies(orgId))[0] ?? null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new ProjectError(422, 'currency is an ISO code.');
  if (cur && currency !== cur.currency) {
    const linked = await outsideRequestScope(() => one<{ n: number }>(`SELECT (SELECT count(*) FROM supplier_bill WHERE capex_project_id = $1) + (SELECT count(*) FROM purchase_order WHERE capex_project_id = $1) AS n`, [cur.id]));
    if (Number(linked?.n ?? 0)) throw new ProjectError(409, 'The currency cannot change once bills or orders are linked.');
  }
  const budget = b.budget === undefined && cur ? cur.budget : budgetOf(b.budget);
  const d = (k: string, col: string) => { const x = v(k, col); if (x == null || x === '') return null; if (!DATE_RE.test(String(x))) throw new ProjectError(422, `${k} is YYYY-MM-DD.`); return String(x); };
  const startOn = d('startOn', 'start_s'), targetOn = d('targetOn', 'target_s');
  if (startOn && targetOn && targetOn < startOn) throw new ProjectError(422, 'targetOn is not before startOn.');
  const status = b.status === undefined ? (cur?.status ?? 'planned') : String(b.status);
  if (!['planned', 'active'].includes(status)) throw new ProjectError(422, 'status is planned or active (complete or cancel the project with its own action).');
  const assetCategory = String(v('assetCategory', 'asset_category') ?? 'chargers');
  if (!(ASSET_CATEGORIES as readonly string[]).includes(assetCategory)) throw new ProjectError(422, `assetCategory is one of ${ASSET_CATEGORIES.join(', ')}.`);
  const life = v('lifeMonths', 'life_months') == null || v('lifeMonths', 'life_months') === '' ? 96 : Number(v('lifeMonths', 'life_months'));
  if (!Number.isInteger(life) || life < 1 || life > 360) throw new ProjectError(422, 'lifeMonths is 1 to 360.');
  const note = v('note', 'note') == null || v('note', 'note') === '' ? null : String(v('note', 'note')).slice(0, 500);
  const p = [orgId, name, siteId, currency, status, JSON.stringify(budget), startOn, targetOn, assetCategory, life, note];
  if (cur) {
    await outsideRequestScope(() => query(`UPDATE capex_project SET name = $2, site_id = $3, currency = $4, status = $5, budget = $6, start_on = $7, target_on = $8, asset_category = $9, life_months = $10, note = $11
      WHERE org_id = $1 AND id = $12`, [...p, cur.id]));
    return get(orgId, String(cur.id));
  }
  for (let k = 0; k < 5; k++) {
    const n = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) AS n FROM capex_project WHERE org_id = $1`, [orgId]));
    try {
      const r = await outsideRequestScope(() => one<{ id: string }>(
        `INSERT INTO capex_project (org_id, name, site_id, currency, status, budget, start_on, target_on, asset_category, life_months, note, number, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`, [...p, `CP-${String(Number(n?.n ?? 0) + 1 + k).padStart(4, '0')}`, userId]));
      return get(orgId, String(r!.id));
    } catch (e) { if ((e as any).code !== '23505') throw e; }
  }
  throw new ProjectError(409, 'Could not number the project. Try again.');
}

/** Link (or unlink, project null) a bill or a purchase order. */
export async function link(orgId: string, id: string | null, b: Record<string, unknown>) {
  const p = id ? await row(orgId, id) : null;
  if (p && p.status !== 'planned' && p.status !== 'active') throw new ProjectError(409, `The project is ${p.status}.`);
  const kind = b.billId ? 'bill' : b.orderId ? 'order' : null;
  if (!kind) throw new ProjectError(422, 'Give billId or orderId.');
  const tid = String(kind === 'bill' ? b.billId : b.orderId);
  if (!/^\d{1,18}$/.test(tid)) throw new ProjectError(404, `No such ${kind}.`);
  const table = kind === 'bill' ? 'supplier_bill' : 'purchase_order';
  const t = await outsideRequestScope(() => one<any>(`SELECT id, currency, status, capex_project_id FROM ${table} WHERE id = $1 AND org_id = $2`, [tid, orgId]));
  if (!t) throw new ProjectError(404, `No such ${kind}.`);
  if (p && t.currency !== p.currency) throw new ProjectError(422, `The ${kind} is in ${t.currency}, the project in ${p.currency}.`);
  if (!p && t.capex_project_id) {
    const cur = await row(orgId, String(t.capex_project_id));
    if (cur.status === 'completed' || cur.status === 'cancelled') throw new ProjectError(409, `The project is ${cur.status}: its bills stay linked.`);
  }
  await outsideRequestScope(() => query(`UPDATE ${table} SET capex_project_id = $2 WHERE id = $1`, [t.id, p?.id ?? null]));
  return p ? get(orgId, String(p.id)) : { unlinked: true };
}

/** Complete: capitalise the actual cost into one asset (less bills already capitalised on their own). */
export async function complete(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const p = await get(orgId, id);
  if (p.status !== 'active' && p.status !== 'planned') throw new ProjectError(409, `The project is ${p.status}.`);
  const completedOn = String(b.completedOn ?? today());
  if (!DATE_RE.test(completedOn)) throw new ProjectError(422, 'completedOn is YYYY-MM-DD.');
  await assertOpen(orgId, completedOn.slice(0, 7), 'A project completion', ERR);
  const open = p.bills.filter((x: any) => x.status === 'awaiting_approval' || x.status === 'draft');
  if (open.length) throw new ProjectError(409, `${open.length} bill(s) on the project are not approved yet.`);
  const cost = p.bills.filter((x: any) => (x.status === 'approved' || x.status === 'paid') && !x.ownAsset).reduce((s: number, x: any) => s + x.subtotal, 0);
  let assetId: string | null = null;
  if (cost > 0) {
    const inService = b.inService == null || b.inService === '' ? undefined : String(b.inService);
    if (inService && !MONTH_RE.test(inService)) throw new ProjectError(422, 'inService is YYYY-MM.');
    try {
      assetId = await insertAsset(orgId, { category: b.category ?? p.assetCategory, description: `${p.number} ${p.name}`.slice(0, 200), siteId: p.siteId, currency: p.currency, cost,
        acquiredOn: completedOn, inService, lifeMonths: b.lifeMonths ?? p.lifeMonths }, userId, { capexProjectId: p.id });
    } catch (e) { if (e instanceof AssetError) throw new ProjectError(e.statusCode, e.message); throw e; }
  }
  await outsideRequestScope(() => query(`UPDATE capex_project SET status = 'completed', completed_on = $2, asset_id = $3 WHERE id = $1`, [p.id, completedOn, assetId]));
  await outsideRequestScope(() => resolveAlertsFor(orgId, OVER, 'capex_project', p.id)).catch(() => 0);
  return { ...(await get(orgId, id)), capitalised: cost };
}

export async function cancel(orgId: string, id: string, b: Record<string, unknown>) {
  const p = await row(orgId, id);
  if (p.status === 'completed' || p.status === 'cancelled') throw new ProjectError(409, `The project is ${p.status}.`);
  const reason = String(b.reason ?? '').trim();
  if (reason.length < 3) throw new ProjectError(422, 'Give a reason (at least 3 characters).');
  const on = String(b.cancelledOn ?? today());
  if (!DATE_RE.test(on)) throw new ProjectError(422, 'cancelledOn is YYYY-MM-DD.');
  await assertOpen(orgId, on.slice(0, 7), 'A project cancellation', ERR);
  await outsideRequestScope(() => query(`UPDATE capex_project SET status = 'cancelled', completed_on = $2, note = trim(concat_ws(' · ', note, $3::text)) WHERE id = $1`, [p.id, on, `Cancelled: ${reason.slice(0, 300)}`]));
  await outsideRequestScope(() => resolveAlertsFor(orgId, OVER, 'capex_project', String(p.id))).catch(() => 0);
  return get(orgId, id);
}

export async function listXlsx(orgId: string): Promise<Buffer> {
  const l = await list(orgId);
  return xlsx([{ name: 'Projects', rows: [['Number', 'Name', 'Site', 'Status', 'Currency', 'Budget', 'Actual', 'Committed', 'Forecast', 'Variance %', 'Target'],
    ...l.projects.map((p) => [p.number, p.name, p.site ?? '', p.status, p.currency, p.budget, p.actual, p.committed, p.forecast, p.variancePct, p.targetOn ?? ''])],
    widths: [10, 30, 22, 10, 8, 16, 16, 16, 16, 10, 12], formats: [null, null, null, null, null, 'money', 'money', 'money', 'money', null, null] }]);
}

/** For the cash forecast: open projects' committed spend and remaining budget, spread evenly to the target date. */
export async function remainingSpend(orgId: string, from: string, to: string) {
  const l = await list(orgId);
  const out: Array<{ day: string; currency: string; label: string; amount: number }> = [];
  for (const p of l.projects.filter((x) => x.status === 'planned' || x.status === 'active')) {
    const left = Math.max(p.committed, p.budget - p.actual);
    if (left <= 0) continue;
    const end = p.targetOn && p.targetOn > from ? (p.targetOn < to ? p.targetOn : to) : to;
    const days = Math.max(1, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
    const weeks = Math.max(1, Math.ceil(days / 7));
    const per = Math.round(left / weeks);
    for (let k = 0; k < weeks; k++) out.push({ day: new Date(Date.parse(`${from}T00:00:00Z`) + Math.min(days, (k + 1) * 7) * 86_400_000).toISOString().slice(0, 10), currency: p.currency, label: `${p.number} ${p.name}`, amount: -per });
  }
  return out;
}

/** Daily: an alert per open project whose forecast is above its budget; resolved when it is not. */
export async function sweep(): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(`SELECT DISTINCT org_id FROM capex_project WHERE status IN ('planned', 'active')`));
  let n = 0;
  for (const { org_id } of orgs) {
    try {
      for (const p of (await list(org_id)).projects.filter((x) => x.status === 'planned' || x.status === 'active')) {
        if (p.overBudget) {
          await outsideRequestScope(() => persistAlert({ orgId: org_id, kind: OVER, severity: 'warning', targetType: 'capex_project', targetId: p.id,
            message: `${p.number} ${p.name}: forecast ${p.forecast} is ${p.variancePct}% over the budget of ${p.budget} ${p.currency}. Finance → Capex projects.` })).catch(() => null);
          n++;
        } else await outsideRequestScope(() => resolveAlertsFor(org_id, OVER, 'capex_project', p.id)).catch(() => 0);
      }
    } catch (e) { logger.warn({ org: org_id, err: (e as Error).message }, 'capex sweep failed'); }
  }
  return n;
}
