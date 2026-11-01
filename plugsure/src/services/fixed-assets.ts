import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { assertOpen } from './finance-periods.js';
import { xlsx } from './xlsx.js';

/**
 * The fixed asset register (v1.29.0). What the operator owns — chargers, installation, grid connections, equipment,
 * vehicles, IT — each with:
 *
 *   cost and residual   what it cost (before PPN) and what it is expected to be worth at the end of its life
 *   in service          the month depreciation starts (by default the month after it was acquired)
 *   life and method     straight line: (cost − residual) ÷ life each month, the last month taking the rounding;
 *                       declining balance: the net book value × the annual rate ÷ 12 each month, never below the
 *                       residual, the last month of its life taking it down to the residual
 *   disposal            sold or scrapped on a date, for proceeds: no depreciation from that month on, and the gain or
 *                       loss (proceeds − net book value) in the month's journal
 *
 * Assets can be imported from site investments (v1.22.0) and are created from supplier bills marked to capitalise.
 * A month's depreciation is recorded per currency (the month-end journal: Dr depreciation expense, Cr accumulated
 * depreciation, by category; disposals: Dr accumulated depreciation, Dr bank for the proceeds, Cr the asset's cost,
 * and the gain or loss). Recording again replaces it; a locked month cannot be recorded, and an asset acquired or
 * disposed of in a locked month cannot be recorded, disposed of or voided.
 */

export class AssetError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const CATEGORIES = ['chargers', 'installation', 'grid', 'equipment', 'vehicles', 'it', 'other'] as const;
export const METHODS = ['straight_line', 'declining_balance'] as const;
export const ACCOUNT_KEYS = ['cost', 'accumulated', 'expense', 'gain', 'loss', 'bank'] as const;
type AccountKey = typeof ACCOUNT_KEYS[number];
export const DEFAULT_ACCOUNTS: Record<AccountKey, { code: string; name: string }> = {
  cost: { code: '1600', name: 'Fixed assets at cost' },
  accumulated: { code: '1690', name: 'Accumulated depreciation' },
  expense: { code: '6400', name: 'Depreciation expense' },
  gain: { code: '7100', name: 'Gain on disposal of assets' },
  loss: { code: '8100', name: 'Loss on disposal of assets' },
  bank: { code: '1100', name: 'Bank' },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
export const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const monthsBetween = (a: string, b: string) => {
  const [ya, ma] = a.split('-').map(Number) as [number, number];
  const [yb, mb] = b.split('-').map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
};
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export interface AssetBasis { cost: number; residual: number; inService: string; lifeMonths: number; method: 'straight_line' | 'declining_balance'; ratePct: number | null; disposedOn: string | null }
export interface ScheduleRow { month: string; depreciation: number; accumulated: number; netBookValue: number }

/** The asset's whole schedule, month by month over its life (stopping at the disposal month). */
export function schedule(a: AssetBasis): ScheduleRow[] {
  const out: ScheduleRow[] = [];
  const base = a.cost - a.residual;
  const stop = a.disposedOn ? a.disposedOn.slice(0, 7) : null;
  let acc = 0;
  for (let k = 0; k < a.lifeMonths; k++) {
    const month = addMonths(a.inService, k);
    if (stop && month >= stop) break;
    let d: number;
    if (a.method === 'straight_line') {
      const per = Math.floor(base / a.lifeMonths);
      d = k === a.lifeMonths - 1 ? base - per * (a.lifeMonths - 1) : per;
    } else {
      const nbv = a.cost - acc;
      d = k === a.lifeMonths - 1 ? nbv - a.residual : Math.min(Math.round((nbv * (a.ratePct ?? 0)) / 100 / 12), nbv - a.residual);
    }
    d = Math.max(0, d);
    acc += d;
    out.push({ month, depreciation: d, accumulated: acc, netBookValue: a.cost - acc });
  }
  return out;
}

/** Depreciation in a month, and accumulated to the end of a month. */
export function depreciationIn(a: AssetBasis, month: string): number {
  return schedule(a).find((r) => r.month === month)?.depreciation ?? 0;
}
export function accumulatedTo(a: AssetBasis, month: string): number {
  let acc = 0;
  for (const r of schedule(a)) { if (r.month > month) break; acc = r.accumulated; }
  return acc;
}

const basisOf = (r: any): AssetBasis => ({
  cost: Number(r.cost_minor), residual: Number(r.residual_minor), inService: r.in_service, lifeMonths: Number(r.life_months),
  method: r.method, ratePct: r.rate_pct == null ? null : Number(r.rate_pct), disposedOn: r.disposed_on_s ?? null,
});

const SELECT = `SELECT a.*, to_char(a.acquired_on, 'YYYY-MM-DD') AS acquired_on_s, to_char(a.disposed_on, 'YYYY-MM-DD') AS disposed_on_s,
                       s.name AS site_name, cp.ocpp_identity AS charge_point, u.name AS recorded_by_name
                  FROM fixed_asset a LEFT JOIN site s ON s.id = a.site_id LEFT JOIN charge_point cp ON cp.id = a.charge_point_id LEFT JOIN app_user u ON u.id = a.recorded_by`;

function view(r: any, asOf: string) {
  const b = basisOf(r);
  const acc = accumulatedTo(b, asOf);
  const sch = schedule(b);
  const last = sch[sch.length - 1];
  const status = r.voided_at ? 'voided' : r.disposed_on_s && r.disposed_on_s.slice(0, 7) <= asOf ? 'disposed'
    : asOf < b.inService ? 'not_in_service' : last && asOf >= last.month && last.netBookValue === b.residual ? 'fully_depreciated' : 'in_service';
  const nbvAtDisposal = r.disposed_on_s ? b.cost - accumulatedTo(b, addMonths(r.disposed_on_s.slice(0, 7), -1)) : null;
  return {
    id: String(r.id), tag: r.tag, category: r.category, description: r.description,
    siteId: r.site_id ?? null, site: r.site_name ?? null, chargePointId: r.charge_point_id ?? null, chargePoint: r.charge_point ?? null,
    currency: r.currency, cost: b.cost, residual: b.residual, acquiredOn: r.acquired_on_s, inService: b.inService, lifeMonths: b.lifeMonths,
    method: b.method, ratePct: b.ratePct, siteInvestmentId: r.site_investment_id == null ? null : String(r.site_investment_id),
    supplierBillId: r.supplier_bill_id == null ? null : String(r.supplier_bill_id),
    depreciationThisMonth: depreciationIn(b, asOf), accumulated: acc, netBookValue: b.cost - acc, endsIn: last?.month ?? null,
    status,
    disposal: r.disposed_on_s ? { on: r.disposed_on_s, proceeds: Number(r.disposal_proceeds_minor ?? 0), note: r.disposal_note ?? null,
      netBookValue: nbvAtDisposal, gainLoss: Number(r.disposal_proceeds_minor ?? 0) - (nbvAtDisposal ?? 0) } : null,
    recordedBy: r.recorded_by_name ?? null, voidReason: r.void_reason ?? null,
  };
}

export type AssetView = ReturnType<typeof view>;

export async function register(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const asOf = q.month == null || q.month === '' ? thisMonth(now) : String(q.month);
  if (!MONTH_RE.test(asOf)) throw new AssetError(422, 'month is YYYY-MM.');
  const rows = await outsideRequestScope(() => many<any>(`${SELECT} WHERE a.org_id = $1 ORDER BY a.voided_at NULLS FIRST, a.tag`, [orgId]));
  let assets = rows.map((r) => view(r, asOf));
  if (q.category) assets = assets.filter((a) => a.category === q.category);
  if (q.siteId) assets = assets.filter((a) => a.siteId === q.siteId);
  if (q.status) assets = assets.filter((a) => a.status === q.status);
  const live = assets.filter((a) => a.status !== 'voided');
  const totals: Record<string, { cost: number; accumulated: number; netBookValue: number; depreciationThisMonth: number; count: number }> = {};
  for (const a of live.filter((x) => x.status !== 'disposed')) {
    const t = (totals[a.currency] ??= { cost: 0, accumulated: 0, netBookValue: 0, depreciationThisMonth: 0, count: 0 });
    t.cost += a.cost; t.accumulated += a.accumulated; t.netBookValue += a.netBookValue; t.depreciationThisMonth += a.depreciationThisMonth; t.count++;
  }
  const byCategory: Record<string, Record<string, { cost: number; netBookValue: number; count: number }>> = {};
  for (const a of live.filter((x) => x.status !== 'disposed')) {
    const c = ((byCategory[a.currency] ??= {})[a.category] ??= { cost: 0, netBookValue: 0, count: 0 });
    c.cost += a.cost; c.netBookValue += a.netBookValue; c.count++;
  }
  const unimported = await outsideRequestScope(() => one<{ n: string }>(
    `SELECT count(*) AS n FROM site_investment i WHERE i.org_id = $1 AND i.voided_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM fixed_asset a WHERE a.site_investment_id = i.id AND a.voided_at IS NULL)`, [orgId]));
  return { asOf, assets, totals, byCategory, investmentsNotImported: Number(unimported?.n ?? 0) };
}

async function row(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new AssetError(404, 'No such asset.');
  const r = await outsideRequestScope(() => one<any>(`${SELECT} WHERE a.id = $1 AND a.org_id = $2`, [id, orgId]));
  if (!r) throw new AssetError(404, 'No such asset.');
  return r;
}

export async function get(orgId: string, id: string, now = new Date()) {
  const r = await row(orgId, id);
  return { ...view(r, thisMonth(now)), schedule: schedule(basisOf(r)) };
}

const ERR = (st: number, msg: string) => new AssetError(st, msg);

async function currencyFor(orgId: string, siteId: string | null, raw: unknown): Promise<string> {
  if (siteId) {
    const s = await outsideRequestScope(() => one<{ currency: string }>(
      `SELECT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2`, [siteId, orgId]));
    if (!s) throw new AssetError(404, 'No such site.');
    return s.currency;
  }
  const c = String(raw ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new AssetError(422, 'currency (ISO 4217) is needed for an asset without a site.');
  return c;
}

/** Validate and insert an asset. Used by create(), the investment import and supplier bills. */
export async function insert(orgId: string, b: Record<string, unknown>, userId: string | null, links: { siteInvestmentId?: string; supplierBillId?: string } = {}) {
  const category = String(b.category ?? '');
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new AssetError(422, `category is one of ${CATEGORIES.join(', ')}.`);
  const description = String(b.description ?? '').trim();
  if (description.length < 2 || description.length > 200) throw new AssetError(422, 'Describe the asset (2 to 200 characters).');
  const siteId = b.siteId == null || b.siteId === '' ? null : String(b.siteId);
  if (siteId && !UUID_RE.test(siteId)) throw new AssetError(404, 'No such site.');
  let chargePointId = b.chargePointId == null || b.chargePointId === '' ? null : String(b.chargePointId);
  if (chargePointId) {
    if (!UUID_RE.test(chargePointId)) throw new AssetError(404, 'No such charge point.');
    const cp = await outsideRequestScope(() => one<{ site_id: string }>(`SELECT cp.site_id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.id = $1 AND s.org_id = $2`, [chargePointId, orgId]));
    if (!cp) throw new AssetError(404, 'No such charge point.');
    if (siteId && cp.site_id !== siteId) throw new AssetError(422, 'The charge point is at another site.');
  }
  const currency = await currencyFor(orgId, siteId, b.currency);
  const cost = Number(b.cost);
  if (!Number.isInteger(cost) || cost <= 0) throw new AssetError(422, 'cost is a whole number of the currency\'s minor unit, above 0.');
  const residual = b.residual == null || b.residual === '' ? 0 : Number(b.residual);
  if (!Number.isInteger(residual) || residual < 0 || residual >= cost) throw new AssetError(422, 'residual is 0 or more and below the cost.');
  const acquiredOn = String(b.acquiredOn ?? '');
  if (!validDate(acquiredOn)) throw new AssetError(422, 'acquiredOn is the date it was bought (YYYY-MM-DD).');
  const inService = b.inService == null || b.inService === '' ? addMonths(acquiredOn.slice(0, 7), 1) : String(b.inService);
  if (!MONTH_RE.test(inService) || inService < acquiredOn.slice(0, 7)) throw new AssetError(422, 'inService is the month depreciation starts (YYYY-MM), not before it was acquired.');
  const life = b.lifeMonths == null || b.lifeMonths === '' ? 96 : Number(b.lifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 360) throw new AssetError(422, 'lifeMonths is 1 to 360.');
  const method = b.method == null || b.method === '' ? 'straight_line' : String(b.method);
  if (!(METHODS as readonly string[]).includes(method)) throw new AssetError(422, 'method is straight_line or declining_balance.');
  let rate: number | null = null;
  if (method === 'declining_balance') {
    rate = b.ratePct == null || b.ratePct === '' ? Math.round((200 / (life / 12)) * 100) / 100 : Number(b.ratePct);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100) throw new AssetError(422, 'ratePct (the annual declining-balance rate) is above 0 and at most 100.');
  }
  const tag = b.tag == null || b.tag === '' ? null : String(b.tag).trim().slice(0, 40);
  await assertOpen(orgId, acquiredOn.slice(0, 7), 'An asset', ERR);
  try {
    const r = await outsideRequestScope(() => one<any>(
      `INSERT INTO fixed_asset (org_id, tag, category, description, site_id, charge_point_id, currency, cost_minor, residual_minor, acquired_on, in_service, life_months, method, rate_pct, site_investment_id, supplier_bill_id, recorded_by)
       VALUES ($1, COALESCE($2, 'new-' || gen_random_uuid()::text), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [orgId, tag, category, description, siteId, chargePointId, currency, cost, residual, acquiredOn, inService, life, method, rate, links.siteInvestmentId ?? null, links.supplierBillId ?? null, userId]));
    if (!tag) await outsideRequestScope(() => query(`UPDATE fixed_asset SET tag = 'FA-' || lpad(id::text, 5, '0') WHERE id = $1`, [r.id]));
    return String(r.id);
  } catch (e) {
    if ((e as any).code === '23505') throw new AssetError(409, (e as any).constraint === 'fixed_asset_tag_uq' ? 'Another asset has that tag.' : 'An asset was already made from it.');
    throw e;
  }
}

export async function create(orgId: string, b: Record<string, unknown>, userId: string | null) {
  return get(orgId, await insert(orgId, b, userId));
}

export async function dispose(orgId: string, id: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const r = await row(orgId, id);
  if (r.voided_at) throw new AssetError(409, 'The asset is voided.');
  if (r.disposed_on_s) throw new AssetError(409, 'The asset is already disposed of.');
  const on = String(b.disposedOn ?? '');
  if (!validDate(on) || on < r.acquired_on_s) throw new AssetError(422, 'disposedOn is a date (YYYY-MM-DD), not before it was acquired.');
  if (on.slice(0, 7) > thisMonth(now)) throw new AssetError(422, 'disposedOn is not in a future month.');
  const proceeds = b.proceeds == null || b.proceeds === '' ? 0 : Number(b.proceeds);
  if (!Number.isInteger(proceeds) || proceeds < 0) throw new AssetError(422, 'proceeds is a whole amount, 0 or more.');
  const note = String(b.note ?? '').trim();
  if (note.length < 3) throw new AssetError(422, 'Say how it was disposed of (sold to, scrapped, stolen…).');
  await assertOpen(orgId, on.slice(0, 7), 'A disposal', ERR);
  await outsideRequestScope(() => query(
    `UPDATE fixed_asset SET disposed_on = $3, disposal_proceeds_minor = $4, disposal_note = $5, disposed_by = $6 WHERE id = $1 AND org_id = $2 AND disposed_on IS NULL`,
    [id, orgId, on, proceeds, note.slice(0, 300), userId]));
  return get(orgId, id, now);
}

export async function voidAsset(orgId: string, id: string, reasonRaw: unknown, userId: string | null) {
  const r = await row(orgId, id);
  if (r.voided_at) throw new AssetError(409, 'The asset is already voided.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new AssetError(422, 'Give a reason (at least 3 characters).');
  await assertOpen(orgId, r.acquired_on_s.slice(0, 7), 'An asset', ERR);
  const months = schedule(basisOf(r)).filter((x) => x.depreciation > 0).map((x) => x.month);
  if (months.length) {
    const run = await outsideRequestScope(() => one<{ month: string }>(
      `SELECT month FROM fixed_asset_run WHERE org_id = $1 AND currency = $2 AND month = ANY($3::text[]) ORDER BY month LIMIT 1`, [orgId, r.currency, months]));
    if (run) throw new AssetError(409, `Its depreciation is in the recorded journal for ${run.month}: dispose of it instead.`);
  }
  await outsideRequestScope(() => query(`UPDATE fixed_asset SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2`, [id, orgId, userId, reason.slice(0, 300)]));
  return { id, voided: true };
}

const INV_CATEGORY: Record<string, string> = { chargers: 'chargers', installation: 'installation', grid: 'grid', other: 'other' };

/** Make an asset of every site investment not yet in the register (straight line over its months, from the month after). */
export async function importInvestments(orgId: string, userId: string | null) {
  const inv = await outsideRequestScope(() => many<any>(
    `SELECT i.*, to_char(i.invested_on, 'YYYY-MM-DD') AS on_s FROM site_investment i WHERE i.org_id = $1 AND i.voided_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM fixed_asset a WHERE a.site_investment_id = i.id AND a.voided_at IS NULL) ORDER BY i.invested_on, i.id`, [orgId]));
  const made: string[] = [], skipped: Array<{ investmentId: string; reason: string }> = [];
  for (const i of inv) {
    try {
      made.push(await insert(orgId, { category: INV_CATEGORY[i.category] ?? 'other', description: i.description, siteId: i.site_id, cost: Number(i.amount_minor),
        acquiredOn: i.on_s, lifeMonths: Number(i.life_months), method: 'straight_line' }, userId, { siteInvestmentId: String(i.id) }));
    } catch (e) {
      if (e instanceof AssetError) skipped.push({ investmentId: String(i.id), reason: e.message }); else throw e;
    }
  }
  return { imported: made.length, assetIds: made, skipped };
}

// ─────────────────────────────────────────── the month's journal

export async function accounts(orgId: string): Promise<Record<AccountKey, { code: string; name: string }>> {
  const r = await outsideRequestScope(() => one<{ fixed_assets: any }>(`SELECT fixed_assets FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const saved = r?.fixed_assets?.accounts ?? {};
  return Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, { code: String(saved[k]?.code ?? DEFAULT_ACCOUNTS[k].code), name: String(saved[k]?.name ?? DEFAULT_ACCOUNTS[k].name) }])) as Record<AccountKey, { code: string; name: string }>;
}

export async function saveAccounts(orgId: string, raw: unknown, userId: string | null) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new AssetError(422, `accounts is an object by key: ${ACCOUNT_KEYS.join(', ')}.`);
  const cur = await accounts(orgId);
  for (const [k, v] of Object.entries(raw as Record<string, any>)) {
    if (!(ACCOUNT_KEYS as readonly string[]).includes(k)) throw new AssetError(422, `Unknown account "${k}" (${ACCOUNT_KEYS.join(', ')}).`);
    const code = String(v?.code ?? '').trim(), name = String(v?.name ?? '').trim();
    if (!/^[A-Za-z0-9.\-]{1,20}$/.test(code) || name.length < 2 || name.length > 80) throw new AssetError(422, `${k}: a code (up to 20 letters, digits, dots, dashes) and a name (2 to 80 characters).`);
    cur[k as AccountKey] = { code, name };
  }
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, fixed_assets, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET fixed_assets = EXCLUDED.fixed_assets, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify({ accounts: cur }), userId]));
  return cur;
}

export interface JournalLine { currency: string; account: string; code: string; debit: number; credit: number; description: string }

export async function journal(orgId: string, monthRaw: unknown, now = new Date()) {
  const month = monthRaw == null || monthRaw === '' ? addMonths(thisMonth(now), -1) : String(monthRaw);
  if (!MONTH_RE.test(month)) throw new AssetError(422, 'month is YYYY-MM.');
  const [rows, acc, runs] = await Promise.all([
    outsideRequestScope(() => many<any>(`${SELECT} WHERE a.org_id = $1 AND a.voided_at IS NULL`, [orgId])),
    accounts(orgId),
    outsideRequestScope(() => many<any>(`SELECT r.*, u.name AS by_name FROM fixed_asset_run r LEFT JOIN app_user u ON u.id = r.recorded_by WHERE r.org_id = $1 AND r.month = $2`, [orgId, month])),
  ]);
  const cur: Record<string, { depreciation: number; byCategory: Record<string, number>; disposals: Array<{ id: string; tag: string; cost: number; accumulated: number; proceeds: number; gainLoss: number }>; lines: JournalLine[] }> = {};
  for (const r of rows) {
    const b = basisOf(r);
    const c = (cur[r.currency] ??= { depreciation: 0, byCategory: {}, disposals: [], lines: [] });
    const d = depreciationIn(b, month);
    if (d) { c.depreciation += d; c.byCategory[r.category] = (c.byCategory[r.category] ?? 0) + d; }
    if (r.disposed_on_s && r.disposed_on_s.slice(0, 7) === month) {
      const accumulated = accumulatedTo(b, addMonths(month, -1));
      const proceeds = Number(r.disposal_proceeds_minor ?? 0);
      c.disposals.push({ id: String(r.id), tag: r.tag, cost: b.cost, accumulated, proceeds, gainLoss: proceeds - (b.cost - accumulated) });
    }
  }
  const currencies = Object.entries(cur).filter(([, c]) => c.depreciation || c.disposals.length).map(([currency, c]) => {
    const L = (k: AccountKey, debit: number, credit: number, description: string) => c.lines.push({ currency, account: acc[k].name, code: acc[k].code, debit, credit, description });
    for (const [cat, amt] of Object.entries(c.byCategory).sort()) {
      L('expense', amt, 0, `Depreciation ${month} · ${cat}`);
      L('accumulated', 0, amt, `Depreciation ${month} · ${cat}`);
    }
    for (const x of c.disposals) {
      if (x.accumulated) L('accumulated', x.accumulated, 0, `Disposal ${x.tag}`);
      if (x.proceeds) L('bank', x.proceeds, 0, `Disposal ${x.tag}: proceeds`);
      L('cost', 0, x.cost, `Disposal ${x.tag}`);
      if (x.gainLoss > 0) L('gain', 0, x.gainLoss, `Disposal ${x.tag}: gain`);
      if (x.gainLoss < 0) L('loss', -x.gainLoss, 0, `Disposal ${x.tag}: loss`);
    }
    const run = runs.find((r) => r.currency === currency);
    return {
      currency, depreciation: c.depreciation, byCategory: c.byCategory, disposals: c.disposals,
      gainLoss: c.disposals.reduce((s, x) => s + x.gainLoss, 0), lines: c.lines,
      debit: c.lines.reduce((s, l) => s + l.debit, 0), credit: c.lines.reduce((s, l) => s + l.credit, 0),
      recorded: run ? { at: new Date(run.recorded_at).toISOString(), by: run.by_name ?? null, depreciation: Number(run.depreciation_minor), changedSince: Number(run.depreciation_minor) !== c.depreciation || Number(run.gain_loss_minor) !== c.disposals.reduce((s, x) => s + x.gainLoss, 0) } : null,
    };
  });
  return { month, accounts: acc, currencies };
}

export async function record(orgId: string, monthRaw: unknown, userId: string | null, now = new Date()) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new AssetError(422, 'month is YYYY-MM.');
  if (month >= thisMonth(now)) throw new AssetError(422, 'Record a month once it has ended.');
  await assertOpen(orgId, month, 'The depreciation journal', ERR);
  const j = await journal(orgId, month, now);
  if (!j.currencies.length) throw new AssetError(422, `No depreciation or disposals in ${month}.`);
  for (const c of j.currencies) {
    await outsideRequestScope(() => query(
      `INSERT INTO fixed_asset_run (org_id, month, currency, depreciation_minor, disposals, gain_loss_minor, data, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (org_id, month, currency) DO UPDATE SET depreciation_minor = EXCLUDED.depreciation_minor, disposals = EXCLUDED.disposals, gain_loss_minor = EXCLUDED.gain_loss_minor,
         data = EXCLUDED.data, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
      [orgId, month, c.currency, c.depreciation, c.disposals.length, c.gainLoss, JSON.stringify({ byCategory: c.byCategory, lines: c.lines }), userId]));
  }
  return { month, recorded: j.currencies.map((c) => ({ currency: c.currency, depreciation: c.depreciation, disposals: c.disposals.length, gainLoss: c.gainLoss })) };
}

export async function runs(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT r.month, r.currency, r.depreciation_minor, r.disposals, r.gain_loss_minor, r.recorded_at, u.name AS by_name FROM fixed_asset_run r LEFT JOIN app_user u ON u.id = r.recorded_by
      WHERE r.org_id = $1 ORDER BY r.month DESC, r.currency LIMIT 36`, [orgId]));
  return rows.map((r) => ({ month: r.month, currency: r.currency, depreciation: Number(r.depreciation_minor), disposals: Number(r.disposals), gainLoss: Number(r.gain_loss_minor), recordedAt: new Date(r.recorded_at).toISOString(), recordedBy: r.by_name ?? null }));
}

export function registerXlsx(reg: Awaited<ReturnType<typeof register>>, j: Awaited<ReturnType<typeof journal>>): Buffer {
  return xlsx([
    { name: 'Register', rows: [['Tag', 'Category', 'Description', 'Site', 'Currency', 'Cost', 'Residual', 'Acquired', 'In service', 'Life (months)', 'Method', 'Rate %', `Depreciation ${reg.asOf}`, 'Accumulated', 'Net book value', 'Status'],
      ...reg.assets.filter((a) => a.status !== 'voided').map((a) => [a.tag, a.category, a.description, a.site ?? '', a.currency, a.cost, a.residual, a.acquiredOn, a.inService, a.lifeMonths, a.method, a.ratePct, a.depreciationThisMonth, a.accumulated, a.netBookValue, a.status])],
      widths: [12, 12, 36, 20, 8, 14, 12, 12, 10, 8, 16, 8, 14, 14, 14, 16], formats: [null, null, null, null, null, 'int', 'int', null, null, 'int', null, null, 'int', 'int', 'int', null] },
    { name: `Journal ${j.month}`, rows: [['Currency', 'Code', 'Account', 'Debit', 'Credit', 'Description'], ...j.currencies.flatMap((c) => c.lines.map((l) => [l.currency, l.code, l.account, l.debit, l.credit, l.description]))],
      widths: [8, 10, 32, 14, 14, 40], formats: [null, null, null, 'int', 'int', null] },
  ]);
}
