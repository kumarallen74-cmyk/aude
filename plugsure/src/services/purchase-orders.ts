import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { gate, type Approver } from './finance-approvals.js';
import { reportingCurrency, currencies } from './fx.js';
import { xlsx } from './xlsx.js';

/**
 * Purchase orders and the three-way match (v1.30.0).
 *
 *   order     to a supplier: lines (description, quantity, unit price), site, currency, the date it is expected;
 *             saved as a draft or submitted; approved by a second person (not the one who submitted it) under the
 *             approvals matrix (kind purchase_order: a Finance Manager, or two approvers, above an amount); rejected
 *             with a reason; cancelled (nothing received) or closed (done, or nothing more is coming)
 *   receipt   goods or work received against a line: quantity, date, note; never more than was ordered
 *   bill      a supplier bill names its order (same supplier and currency; the order approved). The match compares
 *             what was ordered, what was received (quantity received × unit price) and what was billed on the order
 *             (bills not void or rejected), with a tolerance (default 2%):
 *               matched        billed ≤ received × (1 + tolerance)
 *               not_received   nothing received yet
 *               over_billed    billed above what was received
 *               over_ordered   billed above what was ordered
 *             A bill that does not match is approved only by a Finance Manager (finance:approve), who overrides it.
 *   commitments  approved orders not yet billed in full: what the operator is committed to pay, by supplier
 */

export class OrderError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const idOk = (id: string) => /^\d{1,18}$/.test(id);
const text = (v: unknown, max: number) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const qty = (v: unknown) => Math.round(Number(v) * 1000) / 1000;

export async function settings(orgId: string): Promise<{ tolerancePct: number }> {
  const r = await outsideRequestScope(() => one<{ procurement: any }>(`SELECT procurement FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  return { tolerancePct: Number(r?.procurement?.tolerancePct ?? 2) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const t = Number(b.tolerancePct);
  if (!Number.isFinite(t) || t < 0 || t > 25) throw new OrderError(422, 'tolerancePct is 0 to 25.');
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, procurement, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET procurement = EXCLUDED.procurement, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify({ tolerancePct: t }), userId]));
  return { tolerancePct: t };
}

const SELECT = `SELECT o.*, to_char(o.expected_on, 'YYYY-MM-DD') AS expected_on_s, s.name AS supplier_name, st.name AS site_name,
         su.name AS submitted_by_name, fa.name AS first_approved_by_name, ap.name AS approved_by_name,
         COALESCE((SELECT sum(round(l.quantity * l.unit_price_minor)) FROM purchase_order_line l WHERE l.order_id = o.id), 0)::bigint AS ordered_minor,
         COALESCE((SELECT sum(round(l.received_qty * l.unit_price_minor)) FROM purchase_order_line l WHERE l.order_id = o.id), 0)::bigint AS received_minor,
         COALESCE((SELECT sum(b.subtotal_minor) FROM supplier_bill b WHERE b.purchase_order_id = o.id AND b.status NOT IN ('void', 'rejected')), 0)::bigint AS billed_minor,
         (SELECT count(*) FROM supplier_bill b WHERE b.purchase_order_id = o.id AND b.status NOT IN ('void', 'rejected')) AS bills
    FROM purchase_order o JOIN supplier s ON s.id = o.supplier_id LEFT JOIN site st ON st.id = o.site_id
    LEFT JOIN app_user su ON su.id = o.submitted_by LEFT JOIN app_user fa ON fa.id = o.first_approved_by LEFT JOIN app_user ap ON ap.id = o.approved_by`;

function view(r: any) {
  const ordered = Number(r.ordered_minor), received = Number(r.received_minor), billed = Number(r.billed_minor);
  return {
    id: String(r.id), number: r.number, supplierId: String(r.supplier_id), supplier: r.supplier_name, siteId: r.site_id ?? null, site: r.site_name ?? null,
    currency: r.currency, description: r.description, expectedOn: r.expected_on_s ?? null, status: r.status,
    ordered, received, billed, toBill: Math.max(0, ordered - billed), bills: Number(r.bills),
    receivedPct: ordered ? Math.round((received / ordered) * 1000) / 10 : 0,
    submittedBy: r.submitted_by_name ?? null, firstApprovedBy: r.first_approved_by_name ?? null, approvedBy: r.approved_by_name ?? null,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null, endReason: r.end_reason ?? null,
  };
}
export type OrderView = ReturnType<typeof view>;

export async function list(orgId: string, q: Record<string, unknown> = {}) {
  const status = q.status == null || q.status === '' ? null : String(q.status);
  const rows = await outsideRequestScope(() => many<any>(
    `${SELECT} WHERE o.org_id = $1 AND ($2::text IS NULL OR o.status = $2)
      ORDER BY CASE o.status WHEN 'awaiting_approval' THEN 0 WHEN 'approved' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, o.id DESC LIMIT 500`, [orgId, status]));
  return rows.map(view);
}

async function row(orgId: string, id: string) {
  if (!idOk(id)) throw new OrderError(404, 'No such purchase order.');
  const r = await outsideRequestScope(() => one<any>(`${SELECT} WHERE o.id = $1 AND o.org_id = $2`, [id, orgId]));
  if (!r) throw new OrderError(404, 'No such purchase order.');
  return r;
}

export async function get(orgId: string, id: string) {
  const r = await row(orgId, id);
  const [lines, receipts, bills] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT * FROM purchase_order_line WHERE order_id = $1 ORDER BY seq`, [id])),
    outsideRequestScope(() => many<any>(`SELECT g.*, to_char(g.received_on, 'YYYY-MM-DD') AS on_s, l.description, u.name AS by_name FROM goods_receipt g JOIN purchase_order_line l ON l.id = g.line_id LEFT JOIN app_user u ON u.id = g.recorded_by WHERE g.order_id = $1 ORDER BY g.received_on, g.id`, [id])),
    outsideRequestScope(() => many<any>(`SELECT id, number, status, subtotal_minor, to_char(bill_date, 'YYYY-MM-DD') AS d FROM supplier_bill WHERE purchase_order_id = $1 ORDER BY bill_date, id`, [id])),
  ]);
  return {
    ...view(r),
    lines: lines.map((l) => ({ id: String(l.id), seq: l.seq, description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unit_price_minor),
      amount: Math.round(Number(l.quantity) * Number(l.unit_price_minor)), received: Number(l.received_qty), outstanding: Math.max(0, Number(l.quantity) - Number(l.received_qty)) })),
    receipts: receipts.map((g) => ({ id: String(g.id), lineId: String(g.line_id), description: g.description, quantity: Number(g.quantity), receivedOn: g.on_s, note: g.note ?? null, recordedBy: g.by_name ?? null })),
    billsOnOrder: bills.map((b) => ({ id: String(b.id), number: b.number, status: b.status, subtotal: Number(b.subtotal_minor), billDate: b.d })),
  };
}

export async function create(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const sid = String(b.supplierId ?? '');
  if (!idOk(sid)) throw new OrderError(404, 'No such supplier.');
  const sup = await outsideRequestScope(() => one<any>(`SELECT * FROM supplier WHERE id = $1 AND org_id = $2`, [sid, orgId]));
  if (!sup) throw new OrderError(404, 'No such supplier.');
  if (sup.archived_at) throw new OrderError(409, 'The supplier is archived.');
  const description = String(b.description ?? '').trim();
  if (description.length < 2 || description.length > 300) throw new OrderError(422, 'Describe the order (2 to 300 characters).');
  const siteId = b.siteId == null || b.siteId === '' ? null : String(b.siteId);
  let currency: string;
  if (siteId) {
    if (!UUID_RE.test(siteId)) throw new OrderError(404, 'No such site.');
    const s = await outsideRequestScope(() => one<{ currency: string }>(`SELECT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2`, [siteId, orgId]));
    if (!s) throw new OrderError(404, 'No such site.');
    currency = s.currency;
  } else if (b.currency != null && b.currency !== '') {
    currency = String(b.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new OrderError(422, 'currency is an ISO code.');
  } else {
    const c = (await reportingCurrency(orgId)) ?? (await currencies(orgId))[0];
    if (!c) throw new OrderError(422, 'currency is needed (the organisation has no sites to take it from).');
    currency = c;
  }
  const expectedOn = b.expectedOn == null || b.expectedOn === '' ? null : String(b.expectedOn);
  if (expectedOn && !validDate(expectedOn)) throw new OrderError(422, 'expectedOn is a date (YYYY-MM-DD).');
  const lines = Array.isArray(b.lines) ? b.lines as Array<Record<string, unknown>> : [];
  if (!lines.length || lines.length > 50) throw new OrderError(422, 'lines: 1 to 50 lines (description, quantity, unitPrice).');
  const clean = lines.map((l, i) => {
    const d = String(l.description ?? '').trim();
    const q = qty(l.quantity);
    const p = Number(l.unitPrice);
    if (d.length < 1 || d.length > 200) throw new OrderError(422, `Line ${i + 1}: a description (up to 200 characters).`);
    if (!Number.isFinite(q) || q <= 0) throw new OrderError(422, `Line ${i + 1}: quantity above 0.`);
    if (!Number.isInteger(p) || p < 0) throw new OrderError(422, `Line ${i + 1}: unitPrice is a whole amount of the minor unit.`);
    return { d, q, p };
  });
  const draft = b.draft === true || b.draft === 'true';
  const n = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) + 1 AS n FROM purchase_order WHERE org_id = $1`, [orgId]));
  let number = `PO-${String(n?.n ?? 1).padStart(5, '0')}`;
  // A concurrent order may take the number: try the next.
  let id: string | null = null;
  for (let k = 0; k < 5 && !id; k++) {
    try {
      const r = await outsideRequestScope(() => one<{ id: string }>(
        `INSERT INTO purchase_order (org_id, supplier_id, number, site_id, currency, description, expected_on, status, submitted_by, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $8 = 'draft' THEN NULL ELSE now() END) RETURNING id`,
        [orgId, sid, number, siteId, currency, description, expectedOn, draft ? 'draft' : 'awaiting_approval', userId]));
      id = String(r!.id);
    } catch (e) {
      if ((e as any).code !== '23505') throw e;
      number = `PO-${String(Number(number.slice(3)) + 1).padStart(5, '0')}`;
    }
  }
  if (!id) throw new OrderError(409, 'Could not number the order. Try again.');
  for (const [i, l] of clean.entries()) {
    await outsideRequestScope(() => query(`INSERT INTO purchase_order_line (org_id, order_id, seq, description, quantity, unit_price_minor) VALUES ($1, $2, $3, $4, $5, $6)`, [orgId, id, i + 1, l.d, l.q, l.p]));
  }
  return get(orgId, id);
}

export async function submit(orgId: string, id: string, userId: string | null) {
  const r = await row(orgId, id);
  if (r.status !== 'draft' && r.status !== 'rejected') throw new OrderError(409, `The order is ${r.status.replace('_', ' ')}.`);
  await outsideRequestScope(() => query(`UPDATE purchase_order SET status = 'awaiting_approval', submitted_by = $3, submitted_at = now(), end_reason = NULL, first_approved_by = NULL, first_approved_at = NULL WHERE id = $1 AND org_id = $2`, [id, orgId, userId]));
  return get(orgId, id);
}

export async function approve(orgId: string, id: string, who: Approver) {
  const r = await row(orgId, id);
  if (r.status !== 'awaiting_approval') throw new OrderError(409, `The order is ${r.status.replace('_', ' ')}.`);
  const step = await gate('purchase_order', orgId, { id: r.id, amount: Number(r.ordered_minor), requested_by: r.submitted_by, first_approved_by: r.first_approved_by }, who);
  if (step === 'first') return { ...(await get(orgId, id)), waitingForSecondApprover: true };
  const won = await outsideRequestScope(() => one(`UPDATE purchase_order SET status = 'approved', approved_by = $3, approved_at = now() WHERE id = $1 AND org_id = $2 AND status = 'awaiting_approval' RETURNING id`, [id, orgId, who.userId]));
  if (!won) throw new OrderError(409, 'Someone changed the order at the same time. Reload.');
  return get(orgId, id);
}

/** reject (awaiting approval, someone other than the submitter), cancel (nothing received) or close (approved). */
export async function end(orgId: string, id: string, how: 'reject' | 'cancel' | 'close', reasonRaw: unknown, userId: string | null) {
  const r = await row(orgId, id);
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new OrderError(422, 'Give a reason (at least 3 characters).');
  if (how === 'reject') {
    if (r.status !== 'awaiting_approval') throw new OrderError(409, `The order is ${r.status.replace('_', ' ')}.`);
    if (r.submitted_by && r.submitted_by === userId) throw new OrderError(403, 'An order is rejected by someone other than the person who submitted it (they can cancel it).');
  } else if (how === 'cancel') {
    if (!['draft', 'awaiting_approval', 'approved', 'rejected'].includes(r.status)) throw new OrderError(409, `The order is ${r.status}.`);
    if (Number(r.received_minor) > 0 || Number(r.bills) > 0) throw new OrderError(409, 'Goods were received or bills recorded: close it instead.');
  } else if (r.status !== 'approved') throw new OrderError(409, 'Only an approved order is closed.');
  const status = how === 'reject' ? 'rejected' : how === 'cancel' ? 'cancelled' : 'closed';
  await outsideRequestScope(() => query(`UPDATE purchase_order SET status = $3, end_reason = $4, closed_at = CASE WHEN $3 IN ('closed', 'cancelled') THEN now() ELSE closed_at END WHERE id = $1 AND org_id = $2`, [id, orgId, status, reason.slice(0, 300)]));
  return get(orgId, id);
}

export async function receive(orgId: string, id: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const r = await row(orgId, id);
  if (r.status !== 'approved') throw new OrderError(409, 'Goods are received against an approved order.');
  const on = b.receivedOn == null || b.receivedOn === '' ? today(now) : String(b.receivedOn);
  if (!validDate(on) || on > today(now)) throw new OrderError(422, 'receivedOn is a date (YYYY-MM-DD), not in the future.');
  const items = Array.isArray(b.lines) ? b.lines as Array<Record<string, unknown>> : [];
  if (!items.length) throw new OrderError(422, 'lines: the lines received (lineId, quantity).');
  const lines = await outsideRequestScope(() => many<any>(`SELECT * FROM purchase_order_line WHERE order_id = $1`, [id]));
  const plan = items.map((it) => {
    const l = lines.find((x) => String(x.id) === String(it.lineId));
    if (!l) throw new OrderError(422, `No line ${String(it.lineId)} on this order.`);
    const q = qty(it.quantity);
    if (!Number.isFinite(q) || q <= 0) throw new OrderError(422, 'quantity is above 0.');
    if (Number(l.received_qty) + q > Number(l.quantity) + 1e-9) throw new OrderError(422, `"${l.description}": ${Number(l.quantity) - Number(l.received_qty)} left to receive.`);
    return { l, q };
  });
  const note = text(b.note, 300);
  for (const p of plan) {
    await outsideRequestScope(() => query(`INSERT INTO goods_receipt (org_id, order_id, line_id, quantity, received_on, note, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [orgId, id, p.l.id, p.q, on, note, userId]));
    await outsideRequestScope(() => query(`UPDATE purchase_order_line SET received_qty = received_qty + $2 WHERE id = $1`, [p.l.id, p.q]));
  }
  return get(orgId, id);
}

/** The order a bill names: same supplier and currency, approved (or closed). Used when a bill is recorded. */
export async function assertBillable(orgId: string, orderId: string, supplierId: string, currency: string) {
  if (!idOk(orderId)) throw new OrderError(404, 'No such purchase order.');
  const r = await outsideRequestScope(() => one<any>(`SELECT supplier_id, currency, status, number FROM purchase_order WHERE id = $1 AND org_id = $2`, [orderId, orgId]));
  if (!r) throw new OrderError(404, 'No such purchase order.');
  if (String(r.supplier_id) !== String(supplierId)) throw new OrderError(422, `${r.number} is to another supplier.`);
  if (r.currency !== currency) throw new OrderError(422, `${r.number} is in ${r.currency}.`);
  if (r.status !== 'approved' && r.status !== 'closed') throw new OrderError(409, `${r.number} is ${r.status.replace('_', ' ')}: bills are recorded against an approved order.`);
}

export type MatchStatus = 'matched' | 'not_received' | 'over_billed' | 'over_ordered';

/** The three-way match of an order (its bills not void or rejected). */
export async function match(orgId: string, orderId: string) {
  const r = await row(orgId, orderId);
  const { tolerancePct } = await settings(orgId);
  const ordered = Number(r.ordered_minor), received = Number(r.received_minor), billed = Number(r.billed_minor);
  const tol = 1 + tolerancePct / 100;
  const status: MatchStatus = billed > Math.round(ordered * tol) ? 'over_ordered' : received === 0 ? 'not_received' : billed > Math.round(received * tol) ? 'over_billed' : 'matched';
  return { orderId: String(r.id), number: r.number, ordered, received, billed, tolerancePct, status };
}

export async function commitments(orgId: string) {
  const open = (await list(orgId, { status: 'approved' })).filter((o) => o.toBill > 0);
  const by: Record<string, { currency: string; total: number; suppliers: Record<string, { supplier: string; total: number; orders: number }> }> = {};
  for (const o of open) {
    const c = (by[o.currency] ??= { currency: o.currency, total: 0, suppliers: {} });
    c.total += o.toBill;
    const s = (c.suppliers[o.supplierId] ??= { supplier: o.supplier, total: 0, orders: 0 });
    s.total += o.toBill; s.orders++;
  }
  return { currencies: Object.values(by).map((c) => ({ currency: c.currency, total: c.total, suppliers: Object.values(c.suppliers).sort((a, b) => b.total - a.total) })), orders: open };
}

export function ordersXlsx(orders: OrderView[]): Buffer {
  return xlsx([{ name: 'Purchase orders', rows: [['Number', 'Supplier', 'Site', 'Currency', 'Status', 'Ordered', 'Received', 'Billed', 'To bill', 'Expected'],
    ...orders.map((o) => [o.number, o.supplier, o.site ?? '', o.currency, o.status, o.ordered, o.received, o.billed, o.toBill, o.expectedOn ?? ''])],
    widths: [12, 30, 20, 8, 18, 14, 14, 14, 14, 12], formats: [null, null, null, null, null, 'int', 'int', 'int', 'int', null] }]);
}
