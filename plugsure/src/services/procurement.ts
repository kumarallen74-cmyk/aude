import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { xlsx } from './xlsx.js';

/**
 * Procurement analytics (v1.38.0): what is bought, from whom, at what price, and how well suppliers deliver.
 *
 *   spend        approved and paid supplier bills (before VAT) over the last 3, 6 or 12 whole months: per supplier, per
 *                category and per month, with the concentration (the top supplier's and top five's share).
 *   prices       spare parts: each item's unit cost on receipt (Inventory), first against last in the window; energy:
 *                each site's cost per kWh from its energy bills, by month. A rise over 10% is flagged.
 *   scorecards   per supplier: orders delivered by the expected date (the last goods receipt of an approved order
 *                against its expected date), the average days late, bills rejected, bills paid by their due date. The
 *                score is the average of the measures it has (0–100): A from 90, B from 75, C from 60, else D.
 *   savings      the register of negotiated savings: the price per unit before and after, the quantity expected over
 *                a period. Expected = (before − after) × quantity; to date, the share of the period passed.
 */

export class ProcurementError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ERR = (s: number, m: string) => new ProcurementError(s, m);
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addMonths = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + mo - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const endOf = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
/** A price rise above this share is flagged. */
export const PRICE_RISE_PCT = 10;

/** A scorecard's grade. Pure. */
export function grade(score: number | null): 'A' | 'B' | 'C' | 'D' | null {
  if (score == null) return null;
  return score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
}

/** The score: the average of the measures present, each 0–100 (late days cost 5 points each, up to 100). Pure. */
export function score(m: { onTimePct: number | null; avgDaysLate: number | null; rejectedPct: number | null; paidOnTimePct: number | null }): number | null {
  const parts = [m.onTimePct, m.avgDaysLate == null ? null : Math.max(0, 100 - m.avgDaysLate * 5), m.rejectedPct == null ? null : 100 - m.rejectedPct, m.paidOnTimePct].filter((x): x is number => x != null);
  return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
}

/** The window: the last `months` whole months up to `to` (by default the month before this one). */
export function window(q: Record<string, unknown>, now = new Date()) {
  const months = q.months == null || q.months === '' ? 12 : Number(q.months);
  if (![3, 6, 12].includes(months)) throw ERR(400, 'months is 3, 6 or 12.');
  const to = q.to == null || q.to === '' ? addMonths(today(now).slice(0, 7), -1) : String(q.to);
  if (!MONTH_RE.test(to)) throw ERR(400, 'to is YYYY-MM.');
  const from = addMonths(to, -(months - 1));
  return { months, from, to, fromDay: `${from}-01`, toDay: endOf(to), list: Array.from({ length: months }, (_, k) => addMonths(from, k)) };
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function spend(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const w = window(q, now);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT b.supplier_id::text AS sid, s.name AS supplier, b.category, b.currency, to_char(b.bill_date, 'YYYY-MM') AS m, sum(b.subtotal_minor)::bigint AS amt, count(*)::int AS n
       FROM supplier_bill b JOIN supplier s ON s.id = b.supplier_id
      WHERE b.org_id = $1 AND b.status IN ('approved', 'paid') AND b.bill_date BETWEEN $2::date AND $3::date
      GROUP BY 1, 2, 3, 4, 5`, [orgId, w.fromDay, w.toDay]));
  const cur: Record<string, { total: number; bills: number; suppliers: Record<string, { supplierId: string; supplier: string; total: number; bills: number; categories: Record<string, number> }>; categories: Record<string, number>; monthly: Record<string, number> }> = {};
  for (const r of rows) {
    const c = (cur[r.currency] ??= { total: 0, bills: 0, suppliers: {}, categories: {}, monthly: Object.fromEntries(w.list.map((m) => [m, 0])) });
    const a = Number(r.amt);
    c.total += a; c.bills += r.n;
    const s = (c.suppliers[r.sid] ??= { supplierId: r.sid, supplier: r.supplier, total: 0, bills: 0, categories: {} });
    s.total += a; s.bills += r.n; s.categories[r.category] = (s.categories[r.category] ?? 0) + a;
    c.categories[r.category] = (c.categories[r.category] ?? 0) + a;
    c.monthly[r.m] = (c.monthly[r.m] ?? 0) + a;
  }
  return {
    ...w, list: undefined,
    currencies: Object.entries(cur).map(([currency, c]) => {
      const sup = Object.values(c.suppliers).sort((a, b) => b.total - a.total).map((s) => ({ ...s, sharePct: pct(s.total, c.total) }));
      return {
        currency, total: c.total, bills: c.bills, suppliers: sup,
        categories: Object.entries(c.categories).map(([category, total]) => ({ category, total, sharePct: pct(total, c.total) })).sort((a, b) => b.total - a.total),
        monthly: w.list.map((m) => ({ month: m, total: c.monthly[m] ?? 0 })),
        topSupplierPct: sup[0]?.sharePct ?? null, topFivePct: pct(sup.slice(0, 5).reduce((a, s) => a + s.total, 0), c.total),
      };
    }),
  };
}

export async function prices(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const w = window(q, now);
  const [moves, energy] = await outsideRequestScope(() => Promise.all([
    many<any>(`SELECT m.item_id::text AS id, i.sku, i.name, i.unit, i.currency, s.name AS supplier, to_char(m.on_date, 'YYYY-MM-DD') AS d, m.qty, m.unit_cost_minor
                 FROM stock_move m JOIN stock_item i ON i.id = m.item_id LEFT JOIN supplier s ON s.id = i.supplier_id
                WHERE m.org_id = $1 AND m.kind = 'receipt' AND m.unit_cost_minor IS NOT NULL AND m.on_date BETWEEN $2::date AND $3::date ORDER BY m.on_date, m.id`, [orgId, w.fromDay, w.toDay]),
    many<any>(`SELECT e.site_id::text AS id, st.name AS site, e.month, e.currency, sum(e.amount_minor)::bigint AS amt, sum(e.kwh_billed)::numeric AS kwh
                 FROM site_energy_cost e JOIN site st ON st.id = e.site_id
                WHERE e.org_id = $1 AND e.voided_at IS NULL AND e.month BETWEEN $2 AND $3 GROUP BY 1, 2, 3, 4 ORDER BY 3`, [orgId, w.from, w.to]),
  ]));
  const items = new Map<string, any>();
  for (const m of moves) {
    const it = items.get(m.id) ?? { itemId: m.id, sku: m.sku, name: m.name, unit: m.unit, currency: m.currency, supplier: m.supplier ?? null, receipts: 0, quantity: 0, first: null, last: null, firstOn: null, lastOn: null };
    const u = Number(m.unit_cost_minor);
    it.receipts++; it.quantity += Number(m.qty);
    if (it.first == null) { it.first = u; it.firstOn = m.d; }
    it.last = u; it.lastOn = m.d;
    items.set(m.id, it);
  }
  const parts = [...items.values()].map((i) => {
    const changePct = i.first ? Math.round(((i.last - i.first) / i.first) * 1000) / 10 : null;
    return { ...i, changePct, rising: changePct != null && changePct > PRICE_RISE_PCT };
  }).sort((a, b) => (b.changePct ?? -1e9) - (a.changePct ?? -1e9));
  const sites = new Map<string, any>();
  for (const e of energy) {
    const s = sites.get(e.id) ?? { siteId: e.id, site: e.site, currency: e.currency, months: [] as Array<{ month: string; amount: number; kwh: number; perKwh: number | null }> };
    const kwh = Number(e.kwh), amt = Number(e.amt);
    s.months.push({ month: e.month, amount: amt, kwh, perKwh: kwh > 0 ? Math.round((amt / kwh) * 100) / 100 : null });
    sites.set(e.id, s);
  }
  const energyOut = [...sites.values()].map((s) => {
    const priced = s.months.filter((m: any) => m.perKwh != null);
    const first = priced[0]?.perKwh ?? null, last = priced[priced.length - 1]?.perKwh ?? null;
    const changePct = first && last != null && priced.length > 1 ? Math.round(((last - first) / first) * 1000) / 10 : null;
    return { ...s, first, last, changePct, rising: changePct != null && changePct > PRICE_RISE_PCT };
  });
  return { from: w.from, to: w.to, months: w.months, risePct: PRICE_RISE_PCT, parts, energy: energyOut };
}

export async function scorecards(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const w = window(q, now);
  const [orders, bills] = await outsideRequestScope(() => Promise.all([
    many<any>(`SELECT o.supplier_id::text AS sid, to_char(o.expected_on, 'YYYY-MM-DD') AS exp, (SELECT to_char(max(g.received_on), 'YYYY-MM-DD') FROM goods_receipt g WHERE g.order_id = o.id) AS got,
                      (SELECT COALESCE(sum(l.quantity), 0) FROM purchase_order_line l WHERE l.order_id = o.id) AS ordered, (SELECT COALESCE(sum(l.received_qty), 0) FROM purchase_order_line l WHERE l.order_id = o.id) AS received
                 FROM purchase_order o WHERE o.org_id = $1 AND o.status IN ('approved', 'closed') AND o.expected_on BETWEEN $2::date AND $3::date`, [orgId, w.fromDay, w.toDay]),
    many<any>(`SELECT b.supplier_id::text AS sid, b.status, b.rejected_reason IS NOT NULL OR b.status = 'rejected' AS rejected, to_char(b.due_date, 'YYYY-MM-DD') AS due,
                      to_char((b.paid_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS paid, b.subtotal_minor, b.currency
                 FROM supplier_bill b WHERE b.org_id = $1 AND b.status <> 'void' AND b.status <> 'draft' AND b.bill_date BETWEEN $2::date AND $3::date`, [orgId, w.fromDay, w.toDay, zone()]),
  ]));
  const sup = await outsideRequestScope(() => many<{ id: string; name: string }>(`SELECT id::text AS id, name FROM supplier WHERE org_id = $1`, [orgId]));
  const name = new Map(sup.map((s) => [s.id, s.name]));
  const t = today(now);
  const by = new Map<string, { orders: number; delivered: number; onTime: number; lateDays: number[]; open: number; bills: number; rejected: number; paid: number; paidOnTime: number; spend: Record<string, number> }>();
  const S = (id: string) => { let x = by.get(id); if (!x) { x = { orders: 0, delivered: 0, onTime: 0, lateDays: [], open: 0, bills: 0, rejected: 0, paid: 0, paidOnTime: 0, spend: {} }; by.set(id, x); } return x; };
  for (const o of orders) {
    const s = S(o.sid);
    s.orders++;
    const full = Number(o.received) >= Number(o.ordered) && Number(o.ordered) > 0;
    if (full && o.got) {
      s.delivered++;
      const late = Math.round((Date.parse(`${o.got}T00:00:00Z`) - Date.parse(`${o.exp}T00:00:00Z`)) / 86_400_000);
      if (late <= 0) s.onTime++;
      s.lateDays.push(Math.max(0, late));
    } else if (o.exp < t) {
      // Not (fully) received and past its date: late to today.
      s.delivered++;
      s.lateDays.push(Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${o.exp}T00:00:00Z`)) / 86_400_000));
    } else s.open++;
  }
  for (const b of bills) {
    const s = S(b.sid);
    s.bills++;
    if (b.rejected) s.rejected++;
    if (b.paid) { s.paid++; if (b.paid <= b.due) s.paidOnTime++; }
    if (b.status === 'approved' || b.status === 'paid') s.spend[b.currency] = (s.spend[b.currency] ?? 0) + Number(b.subtotal_minor);
  }
  const cards = [...by.entries()].map(([id, s]) => {
    const m = {
      onTimePct: s.delivered ? pct(s.onTime, s.delivered) : null,
      avgDaysLate: s.lateDays.length ? Math.round((s.lateDays.reduce((a, b) => a + b, 0) / s.lateDays.length) * 10) / 10 : null,
      rejectedPct: s.bills ? pct(s.rejected, s.bills) : null,
      paidOnTimePct: s.paid ? pct(s.paidOnTime, s.paid) : null,
    };
    const sc = score(m);
    return { supplierId: id, supplier: name.get(id) ?? id, orders: s.orders, delivered: s.delivered, openOrders: s.open, bills: s.bills, rejected: s.rejected, paid: s.paid, ...m, score: sc, grade: grade(sc), spend: s.spend };
  }).sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
  return { from: w.from, to: w.to, months: w.months, suppliers: cards };
}

// ─────────────────────────────────────────── savings

const SV_SELECT = `SELECT v.*, to_char(v.period_from, 'YYYY-MM-DD') AS from_s, to_char(v.period_to, 'YYYY-MM-DD') AS to_s, s.name AS supplier_name FROM procurement_saving v LEFT JOIN supplier s ON s.id = v.supplier_id`;

/** A saving's expected amount and the share to date (by days passed in its period). Pure. */
export function savingToDate(baseline: number, negotiated: number, quantity: number, from: string, to: string, day: string) {
  const expected = Math.round((baseline - negotiated) * quantity);
  const total = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const passed = day < from ? 0 : day >= to ? total : Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return { expected, toDate: Math.round(expected * passed / total), passedPct: Math.round((passed / total) * 1000) / 10 };
}

const savingView = (v: any, day: string) => {
  const b = Number(v.baseline_unit_minor), n = Number(v.negotiated_unit_minor), q = Number(v.quantity);
  return {
    id: String(v.id), supplierId: v.supplier_id == null ? null : String(v.supplier_id), supplier: v.supplier_name ?? null, category: v.category, description: v.description, currency: v.currency,
    baselineUnit: b, negotiatedUnit: n, quantity: q, unitSavingPct: b ? Math.round(((b - n) / b) * 1000) / 10 : null, periodFrom: v.from_s, periodTo: v.to_s,
    ...savingToDate(b, n, q, v.from_s, v.to_s, day), voided: v.voided_at != null,
  };
};

export async function savings(orgId: string, now = new Date()) {
  const t = today(now);
  const rows = (await outsideRequestScope(() => many<any>(`${SV_SELECT} WHERE v.org_id = $1 ORDER BY v.voided_at IS NOT NULL, v.period_from DESC, v.id DESC`, [orgId]))).map((v) => savingView(v, t));
  const totals: Record<string, { expected: number; toDate: number; count: number }> = {};
  for (const v of rows.filter((x) => !x.voided)) { const c = (totals[v.currency] ??= { expected: 0, toDate: 0, count: 0 }); c.expected += v.expected; c.toDate += v.toDate; c.count++; }
  return { savings: rows, totals };
}

export async function createSaving(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const category = String(b.category ?? '').trim(), description = String(b.description ?? '').trim(), currency = String(b.currency ?? '').toUpperCase();
  const base = Number(b.baselineUnit), neg = Number(b.negotiatedUnit), qty = Number(b.quantity);
  const from = String(b.periodFrom ?? ''), to = String(b.periodTo ?? '');
  if (!category || category.length > 40) throw ERR(422, 'category is required (up to 40 characters).');
  if (!description || description.length > 300) throw ERR(422, 'description is required (up to 300 characters).');
  if (!/^[A-Z]{3}$/.test(currency)) throw ERR(422, 'currency is an ISO code.');
  if (!Number.isSafeInteger(base) || base < 0 || !Number.isSafeInteger(neg) || neg < 0) throw ERR(422, 'baselineUnit and negotiatedUnit are prices per unit in minor units.');
  if (neg >= base) throw ERR(422, 'The negotiated price is below the price before (that is the saving).');
  if (!Number.isFinite(qty) || qty <= 0) throw ERR(422, 'quantity is the units expected over the period.');
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) throw ERR(422, 'periodFrom and periodTo are days, the end on or after the start.');
  let sid: string | null = null;
  if (b.supplierId != null && b.supplierId !== '') {
    sid = String(b.supplierId);
    if (!/^\d{1,18}$/.test(sid) || !(await outsideRequestScope(() => one(`SELECT 1 FROM supplier WHERE id = $1 AND org_id = $2`, [sid, orgId])))) throw ERR(422, 'supplierId is not one of your suppliers.');
  }
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO procurement_saving (org_id, supplier_id, category, description, currency, baseline_unit_minor, negotiated_unit_minor, quantity, period_from, period_to, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [orgId, sid, category, description, currency, base, neg, qty, from, to, userId]));
  return savingView(await outsideRequestScope(() => one<any>(`${SV_SELECT} WHERE v.id = $1`, [r!.id])), today(now));
}

export async function voidSaving(orgId: string, id: string, now = new Date()) {
  if (!/^\d{1,18}$/.test(id)) throw ERR(404, 'No such saving.');
  const r = await outsideRequestScope(() => one<any>(`UPDATE procurement_saving SET voided_at = now() WHERE id = $1 AND org_id = $2 AND voided_at IS NULL RETURNING id`, [id, orgId]));
  if (!r) throw ERR(404, 'No such saving (or it is already voided).');
  return savingView(await outsideRequestScope(() => one<any>(`${SV_SELECT} WHERE v.id = $1`, [id])), today(now));
}

/** Everything on the tab, in one workbook. */
export async function reportXlsx(orgId: string, q: Record<string, unknown> = {}, now = new Date()): Promise<Buffer> {
  const [sp, pr, sc, sv] = await Promise.all([spend(orgId, q, now), prices(orgId, q, now), scorecards(orgId, q, now), savings(orgId, now)]);
  return xlsx([
    { name: 'Spend by supplier', rows: [['Currency', 'Supplier', 'Bills', 'Spend', 'Share %'], ...sp.currencies.flatMap((c) => c.suppliers.map((s) => [c.currency, s.supplier, s.bills, s.total, s.sharePct]))], widths: [8, 28, 8, 16, 8], formats: [null, null, null, 'money', null] },
    { name: 'Spend by category', rows: [['Currency', 'Category', 'Spend', 'Share %'], ...sp.currencies.flatMap((c) => c.categories.map((k) => [c.currency, k.category, k.total, k.sharePct]))], widths: [8, 16, 16, 8], formats: [null, null, 'money', null] },
    { name: 'Part prices', rows: [['SKU', 'Item', 'Supplier', 'Currency', 'Receipts', 'First', 'Last', 'Change %'], ...pr.parts.map((i) => [i.sku, i.name, i.supplier ?? '', i.currency, i.receipts, i.first, i.last, i.changePct])], widths: [12, 26, 20, 8, 9, 12, 12, 9], formats: [null, null, null, null, null, 'money', 'money', null] },
    { name: 'Energy per kWh', rows: [['Site', 'Currency', 'Month', 'Amount', 'kWh', 'Per kWh'], ...pr.energy.flatMap((s) => s.months.map((m: any) => [s.site, s.currency, m.month, m.amount, m.kwh, m.perKwh]))], widths: [24, 8, 9, 14, 12, 10], formats: [null, null, null, 'money', null, null] },
    { name: 'Scorecards', rows: [['Supplier', 'Orders', 'On time %', 'Avg days late', 'Bills', 'Rejected %', 'Paid on time %', 'Score', 'Grade'], ...sc.suppliers.map((s) => [s.supplier, s.orders, s.onTimePct, s.avgDaysLate, s.bills, s.rejectedPct, s.paidOnTimePct, s.score, s.grade ?? ''])], widths: [26, 8, 10, 12, 8, 10, 13, 8, 7] },
    { name: 'Savings', rows: [['Supplier', 'Category', 'Description', 'Currency', 'Before', 'After', 'Quantity', 'From', 'To', 'Expected', 'To date', 'Void'], ...sv.savings.map((v) => [v.supplier ?? '', v.category, v.description, v.currency, v.baselineUnit, v.negotiatedUnit, v.quantity, v.periodFrom, v.periodTo, v.expected, v.toDate, v.voided ? 'yes' : ''])],
      widths: [20, 14, 30, 8, 12, 12, 10, 11, 11, 14, 14, 6], formats: [null, null, null, null, 'money', 'money', null, null, null, 'money', 'money', null] },
  ]);
}
