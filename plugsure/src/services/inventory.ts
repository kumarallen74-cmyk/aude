import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { assertOpen } from './finance-periods.js';
import { reportingCurrency, currencies } from './fx.js';
import { xlsx } from './xlsx.js';

/**
 * Inventory and spare parts (v1.34.0).
 *
 *   items       spare parts, consumables and tools by SKU: unit, reorder point and quantity, the usual supplier, and the
 *               moving average cost (each receipt re-averages it: (value held + receipt value) ÷ (quantity held +
 *               received))
 *   locations   depots and site stores
 *   moves       receipt (a price; from a purchase order or by hand), issue (to a work order, or by hand), transfer between
 *               locations (out and in at the average cost), adjustment after a count (the difference at the average
 *               cost). Never below zero at a location.
 *   on hand     per item and location, with the value at the average cost; items at or below their reorder point raise
 *               finance.stock_reorder (checked daily; resolved above it)
 *   ledger      a month's receipts Dr 1700 inventory / Cr 2105 goods received not invoiced; issues Dr 6260 spare parts
 *               used / Cr 1700; adjustments against 6265; supplier bills marked as stock post to 2105 instead of expense
 */

export class InventoryError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REORDER = 'finance.stock_reorder';
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const ERR = (s: number, m: string) => new InventoryError(s, m);
const q3 = (n: number) => Math.round(n * 1000) / 1000;

const itemView = (r: any) => ({
  id: String(r.id), sku: r.sku, name: r.name, unit: r.unit, category: r.category, currency: r.currency,
  reorderPoint: Number(r.reorder_point), reorderQty: Number(r.reorder_qty), avgCost: Math.round(Number(r.avg_cost_minor) * 100) / 100,
  supplierId: r.supplier_id == null ? null : String(r.supplier_id), supplier: r.supplier_name ?? null, archived: !!r.archived_at,
  onHand: q3(Number(r.on_hand ?? 0)), value: Math.round(Number(r.on_hand ?? 0) * Number(r.avg_cost_minor)),
  ...(r.on_hand != null ? { belowReorder: Number(r.reorder_point) > 0 && Number(r.on_hand) <= Number(r.reorder_point) } : {}),
});
const ITEM_SELECT = `SELECT i.*, s.name AS supplier_name, (SELECT COALESCE(sum(m.qty), 0) FROM stock_move m WHERE m.item_id = i.id) AS on_hand FROM stock_item i LEFT JOIN supplier s ON s.id = i.supplier_id`;

export async function overview(orgId: string) {
  const [items, locs, bal] = await Promise.all([
    outsideRequestScope(() => many<any>(`${ITEM_SELECT} WHERE i.org_id = $1 ORDER BY i.archived_at NULLS FIRST, i.sku`, [orgId])),
    outsideRequestScope(() => many<any>(`SELECT l.*, s.name AS site_name FROM stock_location l LEFT JOIN site s ON s.id = l.site_id WHERE l.org_id = $1 ORDER BY l.archived_at NULLS FIRST, l.name`, [orgId])),
    outsideRequestScope(() => many<any>(`SELECT item_id, location_id, sum(qty) AS qty FROM stock_move WHERE org_id = $1 GROUP BY 1, 2 HAVING sum(qty) <> 0`, [orgId])),
  ]);
  const value: Record<string, number> = {};
  const iv = items.map(itemView);
  for (const i of iv) value[i.currency] = (value[i.currency] ?? 0) + i.value;
  return {
    items: iv, value, reorder: iv.filter((i) => i.belowReorder && !i.archived),
    locations: locs.map((l) => ({ id: String(l.id), name: l.name, siteId: l.site_id ?? null, site: l.site_name ?? null, archived: !!l.archived_at })),
    balances: bal.map((b) => ({ itemId: String(b.item_id), locationId: String(b.location_id), qty: q3(Number(b.qty)) })),
  };
}

async function itemRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new InventoryError(404, 'No such item.');
  const r = await outsideRequestScope(() => one<any>(`${ITEM_SELECT} WHERE i.id = $1 AND i.org_id = $2`, [id, orgId]));
  if (!r) throw new InventoryError(404, 'No such item.');
  return r;
}

export async function saveItem(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await itemRow(orgId, id) : null;
  const v = (k: string, col: string) => (b[k] === undefined && cur ? cur[col] : b[k]);
  const sku = String(v('sku', 'sku') ?? '').trim();
  if (!/^[A-Za-z0-9._\-/]{1,40}$/.test(sku)) throw new InventoryError(422, 'sku is 1 to 40 letters, digits, dots, dashes or slashes.');
  const name = String(v('name', 'name') ?? '').trim();
  if (name.length < 2 || name.length > 120) throw new InventoryError(422, 'name is 2 to 120 characters.');
  const unit = String(v('unit', 'unit') ?? 'pcs').trim().slice(0, 12) || 'pcs';
  const category = String(v('category', 'category') ?? 'part');
  if (!['part', 'consumable', 'tool'].includes(category)) throw new InventoryError(422, 'category is part, consumable or tool.');
  const currency = String(v('currency', 'currency') ?? (await reportingCurrency(orgId)) ?? (await currencies(orgId))[0] ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new InventoryError(422, 'currency is an ISO code.');
  if (cur && currency !== cur.currency && Number(cur.on_hand) !== 0) throw new InventoryError(409, 'The currency cannot change while the item is in stock.');
  const num = (k: string, col: string) => { const x = v(k, col); const n = x == null || x === '' ? 0 : Number(x); if (!Number.isFinite(n) || n < 0) throw new InventoryError(422, `${k} is 0 or more.`); return n; };
  const rp = num('reorderPoint', 'reorder_point'), rq = num('reorderQty', 'reorder_qty');
  const sup = v('supplierId', 'supplier_id') == null || v('supplierId', 'supplier_id') === '' ? null : String(v('supplierId', 'supplier_id'));
  if (sup && !(await outsideRequestScope(() => one(`SELECT 1 FROM supplier WHERE id = $1 AND org_id = $2`, [sup, orgId])))) throw new InventoryError(422, 'No such supplier.');
  const archived = b.archived === undefined ? null : b.archived === true || b.archived === 'true';
  try {
    const r = cur
      ? await outsideRequestScope(() => one<any>(`UPDATE stock_item SET sku = $3, name = $4, unit = $5, category = $6, currency = $7, reorder_point = $8, reorder_qty = $9, supplier_id = $10,
          archived_at = CASE WHEN $11::boolean IS NULL THEN archived_at WHEN $11 THEN COALESCE(archived_at, now()) ELSE NULL END WHERE id = $1 AND org_id = $2 RETURNING id`,
        [cur.id, orgId, sku, name, unit, category, currency, rp, rq, sup, archived]))
      : await outsideRequestScope(() => one<any>(`INSERT INTO stock_item (org_id, sku, name, unit, category, currency, reorder_point, reorder_qty, supplier_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [orgId, sku, name, unit, category, currency, rp, rq, sup]));
    return itemView(await itemRow(orgId, String(r.id)));
  } catch (e) {
    if ((e as any).code === '23505') throw new InventoryError(409, `There is already an item ${sku}.`);
    throw e;
  }
}

export async function saveLocation(orgId: string, id: string | null, b: Record<string, unknown>) {
  const name = String(b.name ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new InventoryError(422, 'name is 2 to 80 characters.');
  const siteId = b.siteId == null || b.siteId === '' ? null : String(b.siteId);
  if (siteId && !(await outsideRequestScope(() => one(`SELECT 1 FROM site WHERE id::text = $1 AND org_id = $2`, [siteId, orgId])))) throw new InventoryError(422, 'No such site.');
  const archived = b.archived === undefined ? null : b.archived === true || b.archived === 'true';
  try {
    const r = id
      ? await outsideRequestScope(() => one<any>(`UPDATE stock_location SET name = $3, site_id = $4, archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN COALESCE(archived_at, now()) ELSE NULL END WHERE id = $1 AND org_id = $2 RETURNING *`,
        [id, orgId, name, siteId, archived]))
      : await outsideRequestScope(() => one<any>(`INSERT INTO stock_location (org_id, name, site_id) VALUES ($1, $2, $3) RETURNING *`, [orgId, name, siteId]));
    if (!r) throw new InventoryError(404, 'No such location.');
    return { id: String(r.id), name: r.name, siteId: r.site_id ?? null };
  } catch (e) {
    if ((e as any).code === '23505') throw new InventoryError(409, `There is already a location ${name}.`);
    throw e;
  }
}

async function onHandAt(itemId: string, locationId: string) {
  const r = await outsideRequestScope(() => one<{ q: string }>(`SELECT COALESCE(sum(qty), 0) AS q FROM stock_move WHERE item_id = $1 AND location_id = $2`, [itemId, locationId]));
  return Number(r?.q ?? 0);
}

async function locationOk(orgId: string, id: unknown) {
  const s = String(id ?? '');
  const r = /^\d{1,18}$/.test(s) ? await outsideRequestScope(() => one<any>(`SELECT id, archived_at FROM stock_location WHERE id = $1 AND org_id = $2`, [s, orgId])) : null;
  if (!r) throw new InventoryError(422, 'locationId is one of the stock locations.');
  if (r.archived_at) throw new InventoryError(409, 'The location is archived.');
  return String(r.id);
}

/** Record a move: receipt, issue, transfer (out of one location into another) or adjust (to a counted quantity). */
export async function move(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const it = await itemRow(orgId, String(b.itemId ?? ''));
  if (it.archived_at) throw new InventoryError(409, 'The item is archived.');
  const kind = String(b.kind ?? '');
  if (!['receipt', 'issue', 'transfer', 'adjust'].includes(kind)) throw new InventoryError(422, 'kind is receipt, issue, transfer or adjust.');
  const loc = await locationOk(orgId, b.locationId);
  const onDate = b.onDate == null || b.onDate === '' ? today() : String(b.onDate);
  if (!DATE_RE.test(onDate)) throw new InventoryError(422, 'onDate is YYYY-MM-DD.');
  await assertOpen(orgId, onDate.slice(0, 7), 'A stock move', ERR);
  const note = b.note == null || b.note === '' ? null : String(b.note).slice(0, 300);
  const avg = Number(it.avg_cost_minor);
  const held = await onHandAt(String(it.id), loc);
  const ins = (k: string, l: string, qty: number, unit: number, extra: { po?: string | null; wo?: string | null; ref?: string | null } = {}) => outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO stock_move (org_id, item_id, location_id, kind, qty, unit_cost_minor, value_minor, on_date, purchase_order_id, work_order_id, transfer_ref, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`, [orgId, it.id, l, k, q3(qty), unit, Math.round(qty * unit), onDate, extra.po ?? null, extra.wo ?? null, extra.ref ?? null, note, userId]));
  if (kind === 'adjust') {
    const counted = Number(b.countedQty);
    if (!Number.isFinite(counted) || counted < 0) throw new InventoryError(422, 'countedQty is what was counted, 0 or more.');
    const diff = q3(counted - held);
    if (!diff) return { moved: false, onHand: held };
    if (!note) throw new InventoryError(422, 'Say why the count differs (the note).');
    await ins('adjust', loc, diff, avg);
    return { moved: true, onHand: counted, difference: diff, value: Math.round(diff * avg) };
  }
  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new InventoryError(422, 'qty is above 0.');
  if (kind === 'receipt') {
    const unit = Number(b.unitCost);
    if (!Number.isFinite(unit) || unit < 0) throw new InventoryError(422, 'unitCost is the price per unit, 0 or more.');
    let po: string | null = null;
    if (b.purchaseOrderId != null && b.purchaseOrderId !== '') {
      po = String(b.purchaseOrderId);
      const o = /^\d{1,18}$/.test(po) ? await outsideRequestScope(() => one<any>(`SELECT id, status, currency FROM purchase_order WHERE id = $1 AND org_id = $2`, [po, orgId])) : null;
      if (!o || o.status !== 'approved') throw new InventoryError(422, 'purchaseOrderId is an approved purchase order.');
      if (o.currency !== it.currency) throw new InventoryError(422, `The order is in ${o.currency}, the item in ${it.currency}.`);
    }
    const total = await outsideRequestScope(() => one<{ q: string }>(`SELECT COALESCE(sum(qty), 0) AS q FROM stock_move WHERE item_id = $1`, [it.id]));
    const tq = Math.max(0, Number(total?.q ?? 0));
    const newAvg = tq + qty > 0 ? (tq * avg + qty * unit) / (tq + qty) : unit;
    await ins('receipt', loc, qty, unit, { po });
    await outsideRequestScope(() => query(`UPDATE stock_item SET avg_cost_minor = $2 WHERE id = $1`, [it.id, Math.round(newAvg * 10_000) / 10_000]));
    return { moved: true, onHand: q3(held + qty), avgCost: Math.round(newAvg * 100) / 100 };
  }
  if (qty > held + 1e-9) throw new InventoryError(422, `Only ${q3(held)} ${it.unit} at that location.`);
  if (kind === 'issue') {
    let wo: string | null = null;
    if (b.workOrderId != null && b.workOrderId !== '') {
      wo = String(b.workOrderId);
      const w = /^\d{1,18}$/.test(wo) ? await outsideRequestScope(() => one<any>(`SELECT id, status, currency FROM work_order WHERE id = $1 AND org_id = $2`, [wo, orgId])) : null;
      if (!w) throw new InventoryError(422, 'No such work order.');
      if (w.status === 'cancelled') throw new InventoryError(409, 'The work order is cancelled.');
      if (w.currency !== it.currency) throw new InventoryError(422, `The work order is in ${w.currency}, the item in ${it.currency}.`);
    }
    await ins('issue', loc, -qty, avg, { wo });
    return { moved: true, onHand: q3(held - qty), value: Math.round(qty * avg) };
  }
  const to = await locationOk(orgId, b.toLocationId);
  if (to === loc) throw new InventoryError(422, 'toLocationId is another location.');
  const out = await ins('transfer_out', loc, -qty, avg);
  await ins('transfer_in', to, qty, avg, { ref: out!.id });
  return { moved: true, onHand: q3(held - qty) };
}

export async function moves(orgId: string, q: Record<string, unknown> = {}) {
  const item = q.itemId ? String(q.itemId) : null;
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT m.*, to_char(m.on_date, 'YYYY-MM-DD') AS d, i.sku, i.name AS item_name, i.currency, l.name AS location, w.number AS wo_number, o.number AS po_number, u.name AS by_name
       FROM stock_move m JOIN stock_item i ON i.id = m.item_id JOIN stock_location l ON l.id = m.location_id LEFT JOIN work_order w ON w.id = m.work_order_id
       LEFT JOIN purchase_order o ON o.id = m.purchase_order_id LEFT JOIN app_user u ON u.id = m.created_by
      WHERE m.org_id = $1 AND ($2::bigint IS NULL OR m.item_id = $2::bigint) ORDER BY m.on_date DESC, m.id DESC LIMIT 500`, [orgId, item]));
  return rows.map((m) => ({ id: String(m.id), date: m.d, kind: m.kind, sku: m.sku, item: m.item_name, location: m.location, qty: Number(m.qty), unitCost: Number(m.unit_cost_minor), value: Number(m.value_minor),
    currency: m.currency, workOrder: m.wo_number ?? null, purchaseOrder: m.po_number ?? null, note: m.note ?? null, by: m.by_name ?? null }));
}

export async function stockXlsx(orgId: string): Promise<Buffer> {
  const o = await overview(orgId);
  const loc = new Map(o.locations.map((l) => [l.id, l.name]));
  return xlsx([
    { name: 'Items', rows: [['SKU', 'Name', 'Unit', 'Category', 'On hand', 'Average cost', 'Value', 'Currency', 'Reorder point'], ...o.items.map((i) => [i.sku, i.name, i.unit, i.category, i.onHand, i.avgCost, i.value, i.currency, i.reorderPoint])],
      widths: [14, 34, 8, 12, 10, 14, 16, 8, 12], formats: [null, null, null, null, null, 'money', 'money', null, null] },
    { name: 'By location', rows: [['SKU', 'Location', 'Quantity'], ...o.balances.map((b) => [o.items.find((i) => i.id === b.itemId)?.sku ?? b.itemId, loc.get(b.locationId) ?? b.locationId, b.qty])], widths: [14, 30, 10] },
  ]);
}

/** Daily: an alert per item at or below its reorder point; resolved above it. */
export async function sweep(): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(`SELECT DISTINCT org_id FROM stock_item WHERE archived_at IS NULL AND reorder_point > 0`));
  let n = 0;
  for (const { org_id } of orgs) {
    try {
      const o = await overview(org_id);
      for (const i of o.items.filter((x) => !x.archived && x.reorderPoint > 0)) {
        if (i.belowReorder) {
          await outsideRequestScope(() => persistAlert({ orgId: org_id, kind: REORDER, severity: i.onHand <= 0 ? 'warning' : 'info', targetType: 'stock_item', targetId: i.id,
            message: `${i.sku} ${i.name}: ${i.onHand} ${i.unit} left (reorder at ${i.reorderPoint}; order ${i.reorderQty || 'more'}${i.supplier ? ` from ${i.supplier}` : ''}). Finance → Inventory.` })).catch(() => null);
          n++;
        } else await outsideRequestScope(() => resolveAlertsFor(org_id, REORDER, 'stock_item', i.id)).catch(() => 0);
      }
    } catch (e) { logger.warn({ org: org_id, err: (e as Error).message }, 'stock reorder sweep failed'); }
  }
  return n;
}
