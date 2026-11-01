import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { reportingCurrency, currencies } from './fx.js';
import { assertOpen } from './finance-periods.js';
import { xlsx } from './xlsx.js';

/**
 * Maintenance costs (v1.34.0).
 *
 *   work order   on a charger (or a site): corrective, preventive or warranty; open → in progress → done (or cancelled);
 *                numbered WO-00001…. Its cost: labour (hours × rate), parts issued from stock (at the average cost), and
 *                contractors' supplier bills linked to it (approved or paid, subtotal). A done order whose contractor has
 *                not billed yet carries the contractor's estimate as an accrual at the month's end.
 *   costs        per charger and per site over a period: labour, parts, contractors, warranty recovered, net, and per kWh
 *                delivered (the chargers' sessions in the period); the orders behind them
 *   warranty     a claim on the supplier for an order's cost: submitted, accepted or rejected, paid (the amount
 *                recovered reduces the net cost)
 *   ledger       a month's labour (Dr 6270 maintenance labour / Cr 2115 accrued labour), the contractor accrual (Dr 6200 /
 *                Cr 2110 accrued maintenance, reversed the next month), and warranty paid (Dr bank / Cr 6205 warranty
 *                recoveries). Parts are in the inventory journal; contractor bills in the bills journal.
 */

export class MaintenanceError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const ERR = (s: number, m: string) => new MaintenanceError(s, m);

const WO_SELECT = `SELECT w.*, to_char(w.opened_on, 'YYYY-MM-DD') AS opened_s, to_char(w.done_on, 'YYYY-MM-DD') AS done_s, s.name AS site_name, COALESCE(cp.display_name, cp.ocpp_identity) AS cp_name,
    (SELECT COALESCE(-sum(m.value_minor), 0) FROM stock_move m WHERE m.work_order_id = w.id AND m.kind = 'issue')::bigint AS parts_minor,
    (SELECT COALESCE(sum(b.subtotal_minor), 0) FROM supplier_bill b WHERE b.work_order_id = w.id AND b.status IN ('approved', 'paid'))::bigint AS contractor_minor,
    (SELECT count(*) FROM supplier_bill b WHERE b.work_order_id = w.id AND b.status <> 'void')::int AS bills,
    (SELECT COALESCE(sum(c.paid_minor), 0) FROM warranty_claim c WHERE c.work_order_id = w.id AND c.status = 'paid')::bigint AS recovered_minor
  FROM work_order w LEFT JOIN site s ON s.id = w.site_id LEFT JOIN charge_point cp ON cp.id = w.charge_point_id`;

const woView = (r: any) => {
  const labour = Math.round(Number(r.labour_hours) * Number(r.labour_rate_minor));
  const parts = Number(r.parts_minor), contractor = Number(r.contractor_minor), recovered = Number(r.recovered_minor);
  const accrual = r.status === 'done' && !Number(r.bills) ? Number(r.contractor_estimate_minor) : 0;
  return {
    id: String(r.id), number: r.number, kind: r.kind, status: r.status, title: r.title, description: r.description ?? null, currency: r.currency,
    siteId: r.site_id ?? null, site: r.site_name ?? null, chargePointId: r.charge_point_id ?? null, chargePoint: r.cp_name ?? null,
    openedOn: r.opened_s, doneOn: r.done_s ?? null, labourHours: Number(r.labour_hours), labourRate: Number(r.labour_rate_minor), contractorEstimate: Number(r.contractor_estimate_minor),
    cost: { labour, parts, contractor, accrual, recovered, total: labour + parts + contractor + accrual, net: labour + parts + contractor + accrual - recovered },
  };
};

export async function list(orgId: string, q: Record<string, unknown> = {}) {
  const status = q.status ? String(q.status) : null;
  const rows = await outsideRequestScope(() => many<any>(`${WO_SELECT} WHERE w.org_id = $1 AND ($2::text IS NULL OR w.status = $2) ORDER BY (w.status IN ('done', 'cancelled')), w.opened_on DESC, w.id DESC LIMIT 500`, [orgId, status]));
  return rows.map(woView);
}

async function row(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new MaintenanceError(404, 'No such work order.');
  const r = await outsideRequestScope(() => one<any>(`${WO_SELECT} WHERE w.id = $1 AND w.org_id = $2`, [id, orgId]));
  if (!r) throw new MaintenanceError(404, 'No such work order.');
  return r;
}

export async function get(orgId: string, id: string) {
  const r = await row(orgId, id);
  const [parts, bills, claims] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT m.id, to_char(m.on_date, 'YYYY-MM-DD') AS d, i.sku, i.name, -m.qty AS qty, i.unit, -m.value_minor AS value FROM stock_move m JOIN stock_item i ON i.id = m.item_id WHERE m.work_order_id = $1 AND m.kind = 'issue' ORDER BY m.id`, [r.id])),
    outsideRequestScope(() => many<any>(`SELECT b.id, b.number, b.status, b.subtotal_minor, s.name AS supplier FROM supplier_bill b JOIN supplier s ON s.id = b.supplier_id WHERE b.work_order_id = $1 AND b.status <> 'void' ORDER BY b.id`, [r.id])),
    outsideRequestScope(() => many<any>(`SELECT c.*, to_char(c.submitted_on, 'YYYY-MM-DD') AS sub_s, s.name AS supplier FROM warranty_claim c JOIN supplier s ON s.id = c.supplier_id WHERE c.work_order_id = $1 ORDER BY c.id`, [r.id])),
  ]);
  return {
    ...woView(r),
    parts: parts.map((p) => ({ id: String(p.id), date: p.d, sku: p.sku, name: p.name, qty: Number(p.qty), unit: p.unit, value: Number(p.value) })),
    bills: bills.map((b) => ({ id: String(b.id), number: b.number, supplier: b.supplier, status: b.status, subtotal: Number(b.subtotal_minor) })),
    claims: claims.map(claimView),
  };
}

const claimView = (c: any) => ({ id: String(c.id), supplier: c.supplier ?? null, amount: Number(c.amount_minor), status: c.status, reference: c.reference ?? null, note: c.note ?? null,
  submittedOn: c.sub_s ?? null, paid: c.paid_minor == null ? null : Number(c.paid_minor) });

export async function save(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await row(orgId, id) : null;
  if (cur && (cur.status === 'done' || cur.status === 'cancelled') && b.status === undefined) throw new MaintenanceError(409, `The work order is ${cur.status}.`);
  const v = (k: string, col: string) => (b[k] === undefined && cur ? cur[col] : b[k]);
  const title = String(v('title', 'title') ?? '').trim();
  if (title.length < 3 || title.length > 160) throw new MaintenanceError(422, 'title is 3 to 160 characters.');
  const kind = String(v('kind', 'kind') ?? 'corrective');
  if (!['corrective', 'preventive', 'warranty'].includes(kind)) throw new MaintenanceError(422, 'kind is corrective, preventive or warranty.');
  let cp = v('chargePointId', 'charge_point_id') == null || v('chargePointId', 'charge_point_id') === '' ? null : String(v('chargePointId', 'charge_point_id'));
  let site = v('siteId', 'site_id') == null || v('siteId', 'site_id') === '' ? null : String(v('siteId', 'site_id'));
  let currency = v('currency', 'currency') ? String(v('currency', 'currency')).toUpperCase() : null;
  if (cp) {
    if (!UUID_RE.test(cp)) throw new MaintenanceError(404, 'No such charge point.');
    const c = await outsideRequestScope(() => one<any>(`SELECT cp.site_id, co.currency FROM charge_point cp JOIN site s ON s.id = cp.site_id JOIN country co ON co.code = s.country_code WHERE cp.id = $1 AND s.org_id = $2`, [cp, orgId]));
    if (!c) throw new MaintenanceError(404, 'No such charge point.');
    site = c.site_id; currency ??= c.currency;
  } else if (site) {
    if (!UUID_RE.test(site)) throw new MaintenanceError(404, 'No such site.');
    const s = await outsideRequestScope(() => one<any>(`SELECT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2`, [site, orgId]));
    if (!s) throw new MaintenanceError(404, 'No such site.');
    currency ??= s.currency;
  }
  currency ??= (await reportingCurrency(orgId)) ?? (await currencies(orgId))[0] ?? null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new MaintenanceError(422, 'currency is an ISO code.');
  const openedOn = String(v('openedOn', 'opened_s') ?? today());
  if (!DATE_RE.test(openedOn)) throw new MaintenanceError(422, 'openedOn is YYYY-MM-DD.');
  const num = (k: string, col: string, int = false) => { const x = v(k, col); const n = x == null || x === '' ? 0 : Number(x); if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) throw new MaintenanceError(422, `${k} is ${int ? 'a whole amount' : 'a number'}, 0 or more.`); return n; };
  const hours = num('labourHours', 'labour_hours'), rate = num('labourRate', 'labour_rate_minor', true), est = num('contractorEstimate', 'contractor_estimate_minor', true);
  const status = String(v('status', 'status') ?? 'open');
  if (!['open', 'in_progress', 'done', 'cancelled'].includes(status)) throw new MaintenanceError(422, 'status is open, in_progress, done or cancelled.');
  if (cur && cur.status === 'cancelled' && status !== 'cancelled') throw new MaintenanceError(409, 'A cancelled work order is not reopened: open a new one.');
  let doneOn: string | null = cur?.done_s ?? null;
  if (status === 'done') {
    doneOn = b.doneOn == null || b.doneOn === '' ? (doneOn ?? today()) : String(b.doneOn);
    if (!DATE_RE.test(doneOn) || doneOn < openedOn) throw new MaintenanceError(422, 'doneOn is YYYY-MM-DD, not before it was opened.');
    await assertOpen(orgId, doneOn.slice(0, 7), 'A work order', ERR);
  } else doneOn = null;
  const desc = v('description', 'description') == null || v('description', 'description') === '' ? null : String(v('description', 'description')).slice(0, 2000);
  const p = [orgId, kind, status, site, cp, title, desc, currency, openedOn, doneOn, hours, rate, est];
  if (cur) {
    await outsideRequestScope(() => query(`UPDATE work_order SET kind = $2, status = $3, site_id = $4, charge_point_id = $5, title = $6, description = $7, currency = $8, opened_on = $9, done_on = $10,
      labour_hours = $11, labour_rate_minor = $12, contractor_estimate_minor = $13 WHERE org_id = $1 AND id = $14`, [...p, cur.id]));
    return get(orgId, String(cur.id));
  }
  for (let k = 0; k < 5; k++) {
    const n = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) AS n FROM work_order WHERE org_id = $1`, [orgId]));
    try {
      const r = await outsideRequestScope(() => one<{ id: string }>(
        `INSERT INTO work_order (org_id, kind, status, site_id, charge_point_id, title, description, currency, opened_on, done_on, labour_hours, labour_rate_minor, contractor_estimate_minor, number, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`, [...p, `WO-${String(Number(n?.n ?? 0) + 1 + k).padStart(5, '0')}`, userId]));
      return get(orgId, String(r!.id));
    } catch (e) { if ((e as any).code !== '23505') throw e; }
  }
  throw new MaintenanceError(409, 'Could not number the work order. Try again.');
}

/** Link (or unlink with workOrderId null) a contractor's bill. */
export async function linkBill(orgId: string, billId: string, workOrderId: string | null) {
  if (!/^\d{1,18}$/.test(billId)) throw new MaintenanceError(404, 'No such bill.');
  const bill = await outsideRequestScope(() => one<any>(`SELECT id, currency FROM supplier_bill WHERE id = $1 AND org_id = $2`, [billId, orgId]));
  if (!bill) throw new MaintenanceError(404, 'No such bill.');
  if (workOrderId) {
    const w = await row(orgId, workOrderId);
    if (w.status === 'cancelled') throw new MaintenanceError(409, 'The work order is cancelled.');
    if (w.currency !== bill.currency) throw new MaintenanceError(422, `The bill is in ${bill.currency}, the work order in ${w.currency}.`);
  }
  await outsideRequestScope(() => query(`UPDATE supplier_bill SET work_order_id = $2 WHERE id = $1`, [bill.id, workOrderId]));
  return workOrderId ? get(orgId, workOrderId) : { unlinked: true };
}

/** A bill's links: stock (posted against goods received not invoiced) and the work order it is for. */
export async function setBillLinks(orgId: string, billId: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(billId) || !(await outsideRequestScope(() => one(`SELECT 1 FROM supplier_bill WHERE id = $1 AND org_id = $2`, [billId, orgId])))) throw new MaintenanceError(404, 'No such bill.');
  if (b.stock !== undefined) await outsideRequestScope(() => query(`UPDATE supplier_bill SET stock = $2 WHERE id = $1`, [billId, b.stock === true || b.stock === 'true']));
  if (b.workOrderId !== undefined) await linkBill(orgId, billId, b.workOrderId == null || b.workOrderId === '' ? null : String(b.workOrderId));
  const r = await outsideRequestScope(() => one<any>(`SELECT stock, work_order_id FROM supplier_bill WHERE id = $1`, [billId]));
  return { billId, stock: !!r.stock, workOrderId: r.work_order_id == null ? null : String(r.work_order_id) };
}

export async function claim(orgId: string, workOrderId: string, b: Record<string, unknown>, userId: string | null) {
  const w = await row(orgId, workOrderId);
  const sup = String(b.supplierId ?? '');
  const s = /^\d{1,18}$/.test(sup) ? await outsideRequestScope(() => one<any>(`SELECT id FROM supplier WHERE id = $1 AND org_id = $2`, [sup, orgId])) : null;
  if (!s) throw new MaintenanceError(422, 'supplierId is the supplier the claim is made on.');
  const amount = b.amount == null || b.amount === '' ? woView(w).cost.total : Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new MaintenanceError(422, 'amount is a whole amount above 0 (default the order\'s cost).');
  const on = String(b.submittedOn ?? today());
  if (!DATE_RE.test(on)) throw new MaintenanceError(422, 'submittedOn is YYYY-MM-DD.');
  await outsideRequestScope(() => query(`INSERT INTO warranty_claim (org_id, work_order_id, supplier_id, currency, amount_minor, reference, note, submitted_on, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [orgId, w.id, s.id, w.currency, amount, b.reference ? String(b.reference).slice(0, 80) : null, b.note ? String(b.note).slice(0, 300) : null, on, userId]));
  return get(orgId, workOrderId);
}

export async function decideClaim(orgId: string, claimId: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(claimId)) throw new MaintenanceError(404, 'No such claim.');
  const c = await outsideRequestScope(() => one<any>(`SELECT * FROM warranty_claim WHERE id = $1 AND org_id = $2`, [claimId, orgId]));
  if (!c) throw new MaintenanceError(404, 'No such claim.');
  const status = String(b.status ?? '');
  const on = String(b.on ?? today());
  if (!DATE_RE.test(on)) throw new MaintenanceError(422, 'on is YYYY-MM-DD.');
  if (status === 'accepted' || status === 'rejected') {
    if (c.status !== 'submitted') throw new MaintenanceError(409, `The claim is ${c.status}.`);
    await outsideRequestScope(() => query(`UPDATE warranty_claim SET status = $2, decided_on = $3, note = COALESCE($4, note) WHERE id = $1`, [c.id, status, on, b.note ? String(b.note).slice(0, 300) : null]));
  } else if (status === 'paid') {
    if (c.status !== 'accepted' && c.status !== 'submitted') throw new MaintenanceError(409, `The claim is ${c.status}.`);
    const paid = b.paid == null || b.paid === '' ? Number(c.amount_minor) : Number(b.paid);
    if (!Number.isInteger(paid) || paid <= 0) throw new MaintenanceError(422, 'paid is a whole amount above 0.');
    await assertOpen(orgId, on.slice(0, 7), 'A warranty payment', ERR);
    await outsideRequestScope(() => query(`UPDATE warranty_claim SET status = 'paid', paid_on = $2, paid_minor = $3, decided_on = COALESCE(decided_on, $2) WHERE id = $1`, [c.id, on, paid]));
  } else throw new MaintenanceError(422, 'status is accepted, rejected or paid.');
  return get(orgId, String(c.work_order_id));
}

/** Costs per charger (and site) over a period, with the energy delivered and the cost per kWh. */
export async function costs(orgId: string, q: Record<string, unknown> = {}) {
  const to = q.to ? String(q.to) : today();
  const from = q.from ? String(q.from) : `${to.slice(0, 4)}-01-01`;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) throw new MaintenanceError(422, 'from and to are YYYY-MM-DD, from not after to.');
  const rows = (await outsideRequestScope(() => many<any>(`${WO_SELECT} WHERE w.org_id = $1 AND w.status <> 'cancelled' AND COALESCE(w.done_on, w.opened_on) BETWEEN $2::date AND $3::date`, [orgId, from, to]))).map(woView);
  const energy = await outsideRequestScope(() => many<{ cp: string; wh: string }>(
    `SELECT cs.charge_point_id::text AS cp, COALESCE(sum(cs.energy_wh), 0)::bigint AS wh FROM charging_session cs JOIN site s ON s.id = cs.site_id
      WHERE s.org_id = $1 AND (cs.started_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date GROUP BY 1`, [orgId, from, to, zone()]));
  const kwh = new Map(energy.map((e) => [e.cp, Number(e.wh) / 1000]));
  const by = new Map<string, { chargePointId: string | null; chargePoint: string | null; site: string | null; currency: string; orders: number; labour: number; parts: number; contractor: number; accrual: number; recovered: number; net: number }>();
  for (const w of rows) {
    const k = `${w.chargePointId ?? `site:${w.siteId ?? '-'}`}|${w.currency}`;
    const x = by.get(k) ?? { chargePointId: w.chargePointId, chargePoint: w.chargePoint, site: w.site, currency: w.currency, orders: 0, labour: 0, parts: 0, contractor: 0, accrual: 0, recovered: 0, net: 0 };
    x.orders++; x.labour += w.cost.labour; x.parts += w.cost.parts; x.contractor += w.cost.contractor; x.accrual += w.cost.accrual; x.recovered += w.cost.recovered; x.net += w.cost.net;
    by.set(k, x);
  }
  const chargers = [...by.values()].map((x) => {
    const e = x.chargePointId ? kwh.get(x.chargePointId) ?? 0 : null;
    return { ...x, kwh: e == null ? null : Math.round(e), perKwh: e ? Math.round((x.net / e) * 100) / 100 : null };
  }).sort((a, b) => b.net - a.net);
  const totals: Record<string, { net: number; orders: number }> = {};
  for (const c of chargers) { const t = (totals[c.currency] ??= { net: 0, orders: 0 }); t.net += c.net; t.orders += c.orders; }
  return { from, to, chargers, totals, byKind: ['corrective', 'preventive', 'warranty'].map((k) => ({ kind: k, orders: rows.filter((w) => w.kind === k).length, net: rows.filter((w) => w.kind === k).reduce((s, w) => s + w.cost.net, 0) })) };
}

export async function costsXlsx(orgId: string, q: Record<string, unknown>): Promise<Buffer> {
  const c = await costs(orgId, q);
  return xlsx([{ name: 'Maintenance costs', rows: [['Charger', 'Site', 'Currency', 'Orders', 'Labour', 'Parts', 'Contractors', 'Accrued', 'Warranty recovered', 'Net', 'kWh', 'Per kWh'],
    ...c.chargers.map((x) => [x.chargePoint ?? '(site)', x.site ?? '', x.currency, x.orders, x.labour, x.parts, x.contractor, x.accrual, x.recovered, x.net, x.kwh, x.perKwh])],
    widths: [20, 24, 8, 8, 14, 14, 14, 12, 14, 14, 10, 10], formats: [null, null, null, null, 'money', 'money', 'money', 'money', 'money', 'money', 'int', 'money'] }]);
}
