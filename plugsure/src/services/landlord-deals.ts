import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { month as energyMonth } from './energy-margin.js';
import { create as createBill, BillError } from './supplier-bills.js';
import { PdfDoc, Flow } from './pdf.js';
import { xlsx } from './xlsx.js';

/**
 * Landlord deals (v1.36.0): what the operator pays the owner of the land or car park a site stands on. (Site owners
 * who share the platform's revenue under a commercial plan are a different thing: Owners and Statements.)
 *
 *   basis       fixed (a monthly rent), share (a % of the site's revenue before tax, or of its margin after energy),
 *               higher_of (the share, at least a minimum guarantee: the top-up is shown) or fixed_plus_share
 *   terms       escalation: the fixed rent and the minimum grow by escalation_pct each year of the deal; rent-free
 *               months at the start waive the fixed rent and the minimum (a share is still due); a part month is
 *               pro-rated by days; an energy recharge per kWh when the landlord supplies the power
 *   lease       when the fixed rent is a PSAK 73 lease (Finance → Leases), link it: the fixed part is shown but left out
 *               of the statement's total (the lease pays and accounts for it)
 *   statements  per month or quarter once it has ended (LS-00001…), refreshed while draft; issued, the total becomes the
 *               landlord's supplier bill (category rent, awaiting approval) and the landlord gets the statement (PDF)
 *   ledger      each month a deal's amount not yet billed by the month's end is accrued (Dr 6210 rent / Cr 2420 accrued
 *               rent), reversed the next month; the bill then carries it
 */

export class LandlordError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const BASES = ['fixed', 'share', 'higher_of', 'fixed_plus_share'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addMonths = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + mo - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const monthsBetween = (a: string, b: string) => { const [ya, ma] = a.split('-').map(Number) as [number, number]; const [yb, mb] = b.split('-').map(Number) as [number, number]; return (yb - ya) * 12 + (mb - ma); };
const daysIn = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const lastDay = (m: string) => `${m}-${String(daysIn(m)).padStart(2, '0')}`;

export interface DealTerms { basis: string; fixed: number; sharePct: number; minimum: number; escalationPct: number; rentFreeMonths: number; rechargePerKwh: number; startOn: string; endOn: string | null; inLease: boolean }

/** One month of a deal from the site's figures. Pure. */
export function computeMonth(d: DealTerms, month: string, f: { revenue: number; kwh: number; energyCost: number | null; shareOf: 'revenue' | 'margin' }) {
  const start = d.startOn.slice(0, 7);
  const from = month === start ? Number(d.startOn.slice(8, 10)) : 1;
  const endM = d.endOn ? d.endOn.slice(0, 7) : null; // end exclusive
  const to = endM && month === endM ? Number(d.endOn!.slice(8, 10)) - 1 : daysIn(month);
  const activeDays = month < start || (endM && (month > endM || (month === endM && to < 1))) ? 0 : Math.max(0, to - from + 1);
  const part = activeDays / daysIn(month);
  const k = monthsBetween(start, month);
  const rentFree = k < d.rentFreeMonths;
  const factor = Math.pow(1 + d.escalationPct / 100, Math.max(0, Math.floor(k / 12)));
  const fixedDue = rentFree || !activeDays ? 0 : Math.round(d.fixed * factor * part);
  const minimum = rentFree || !activeDays ? 0 : Math.round(d.minimum * factor * part);
  const base = f.shareOf === 'margin' ? (f.energyCost == null ? null : Math.max(0, f.revenue - f.energyCost)) : f.revenue;
  const share = !activeDays || base == null ? 0 : Math.round((base * d.sharePct) / 100);
  const fixed = d.basis === 'fixed' || d.basis === 'fixed_plus_share' ? fixedDue : 0;
  const shareDue = d.basis === 'share' || d.basis === 'higher_of' || d.basis === 'fixed_plus_share' ? share : 0;
  const topUp = d.basis === 'higher_of' ? Math.max(0, minimum - share) : 0;
  const recharge = activeDays ? Math.round(f.kwh * d.rechargePerKwh) : 0;
  const rent = fixed + shareDue + topUp;
  return {
    month, activeDays, rentFree, factor: Math.round(factor * 10000) / 10000, revenue: f.revenue, kwh: f.kwh, energyCost: f.energyCost, base, share: shareDue, fixed, minimum: d.basis === 'higher_of' ? minimum : 0, topUp, recharge,
    rent, inLease: d.inLease && fixed > 0, total: rent + recharge - (d.inLease ? fixed : 0), marginUnknown: f.shareOf === 'margin' && f.energyCost == null,
  };
}

const D_SELECT = `SELECT d.*, to_char(d.start_on, 'YYYY-MM-DD') AS start_s, to_char(d.end_on, 'YYYY-MM-DD') AS end_s, s.name AS site_name, su.name AS landlord, l.description AS lease_name
  FROM landlord_deal d JOIN site s ON s.id = d.site_id JOIN supplier su ON su.id = d.supplier_id LEFT JOIN lease l ON l.id = d.lease_id`;

const terms = (d: any): DealTerms => ({ basis: d.basis, fixed: Number(d.fixed_minor), sharePct: Number(d.share_pct), minimum: Number(d.minimum_minor), escalationPct: Number(d.escalation_pct), rentFreeMonths: d.rent_free_months,
  rechargePerKwh: Number(d.recharge_per_kwh), startOn: d.start_s, endOn: d.end_s ?? null, inLease: !!d.lease_id });

const dView = (d: any) => ({
  id: String(d.id), siteId: d.site_id, site: d.site_name, supplierId: String(d.supplier_id), landlord: d.landlord, reference: d.reference ?? null, currency: d.currency, basis: d.basis,
  fixed: Number(d.fixed_minor), sharePct: Number(d.share_pct), shareOf: d.share_of, minimum: Number(d.minimum_minor), escalationPct: Number(d.escalation_pct), rentFreeMonths: d.rent_free_months,
  rechargePerKwh: Number(d.recharge_per_kwh), billing: d.billing, startOn: d.start_s, endOn: d.end_s ?? null, leaseId: d.lease_id ? String(d.lease_id) : null, lease: d.lease_name ?? null, status: d.status, note: d.note ?? null,
});

async function dRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new LandlordError(404, 'No such deal.');
  const r = await outsideRequestScope(() => one<any>(`${D_SELECT} WHERE d.id = $1 AND d.org_id = $2`, [id, orgId]));
  if (!r) throw new LandlordError(404, 'No such deal.');
  return r;
}

/** The site's revenue, kWh and energy cost for a month (Finance → Energy). */
async function siteFigures(orgId: string, siteId: string, m: string) {
  const e = await energyMonth(orgId, m, siteId);
  const s = e.sites.find((x) => x.siteId === siteId);
  return { revenue: s?.revenue ?? 0, kwh: s?.kwh ?? 0, energyCost: s?.energyCost ?? null };
}

export async function lines(orgId: string, d: any, months: string[]) {
  const out = [];
  for (const m of months) out.push(computeMonth(terms(d), m, { ...(await siteFigures(orgId, d.site_id, m)), shareOf: d.share_of }));
  return out;
}

export async function overview(orgId: string, now = new Date()) {
  const ds = await outsideRequestScope(() => many<any>(`${D_SELECT} WHERE d.org_id = $1 ORDER BY (d.status = 'active') DESC, s.name`, [orgId]));
  const last = addMonths(today(now).slice(0, 7), -1);
  const sts = await outsideRequestScope(() => many<any>(
    `SELECT st.*, b.status AS bill_status, b.number AS bill_number FROM landlord_statement st LEFT JOIN supplier_bill b ON b.id = st.bill_id WHERE st.org_id = $1 ORDER BY st.month_from DESC, st.id DESC LIMIT 300`, [orgId]));
  const deals = [];
  for (const d of ds) {
    const v = dView(d);
    const lm = d.status === 'active' && d.start_s.slice(0, 7) <= last ? (await lines(orgId, d, [last]))[0]! : null;
    deals.push({ ...v, lastMonth: lm, statements: sts.filter((s) => String(s.deal_id) === v.id).length, unissued: dueMonths(d, sts, now).length });
  }
  const totals: Record<string, { lastMonth: number; deals: number }> = {};
  for (const d of deals.filter((x) => x.status === 'active')) { const t = (totals[d.currency] ??= { lastMonth: 0, deals: 0 }); t.deals++; t.lastMonth += d.lastMonth?.total ?? 0; }
  return { month: last, deals, totals, statements: sts.map(sView) };
}

const sView = (s: any) => ({ id: String(s.id), dealId: String(s.deal_id), number: s.number, monthFrom: s.month_from, monthTo: s.month_to, total: Number(s.total_minor), status: s.status,
  billId: s.bill_id ? String(s.bill_id) : null, billStatus: s.bill_status ?? null, issuedAt: s.issued_at ? new Date(s.issued_at).toISOString() : null, lines: s.lines });

/** Periods (first month) that have ended and have no live statement. */
function dueMonths(d: any, sts: any[], now = new Date()) {
  if (d.status !== 'active') return [];
  const last = addMonths(today(now).slice(0, 7), -1), start = d.start_s.slice(0, 7);
  const out: string[] = [];
  for (let m = start; m <= last; m = addMonths(m, 1)) {
    const first = d.billing === 'quarterly' ? `${m.slice(0, 4)}-${String(Math.floor((Number(m.slice(5)) - 1) / 3) * 3 + 1).padStart(2, '0')}` : m;
    if (first !== m && m !== start) continue;
    const periodFrom = first < start ? start : first;
    const periodTo = d.billing === 'quarterly' ? addMonths(first, 2) : first;
    if (periodTo > last) continue;
    if (d.end_s && periodFrom >= d.end_s.slice(0, 7) && d.end_s.slice(8) === '01') continue;
    if (!sts.some((s) => String(s.deal_id) === String(d.id) && s.month_from === periodFrom && s.status !== 'void')) out.push(periodFrom);
  }
  return out;
}

export async function get(orgId: string, id: string) {
  const d = await dRow(orgId, id);
  const sts = await outsideRequestScope(() => many<any>(`SELECT st.*, b.status AS bill_status FROM landlord_statement st LEFT JOIN supplier_bill b ON b.id = st.bill_id WHERE st.deal_id = $1 ORDER BY st.month_from DESC, st.id DESC`, [d.id]));
  const last = addMonths(today().slice(0, 7), -1);
  const recent = [];
  for (let k = 5; k >= 0; k--) { const m = addMonths(last, -k); if (m >= d.start_s.slice(0, 7)) recent.push(m); }
  return { ...dView(d), months: await lines(orgId, d, recent), statements: sts.map(sView), due: dueMonths(d, sts) };
}

export async function save(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await dRow(orgId, id) : null;
  const v = (k: string, col: string) => (b[k] === undefined && cur ? cur[col] : b[k]);
  const site = String(v('siteId', 'site_id') ?? '');
  if (!UUID_RE.test(site) || !(await outsideRequestScope(() => one(`SELECT 1 FROM site WHERE id = $1 AND org_id = $2`, [site, orgId])))) throw new LandlordError(422, 'No such site.');
  const sup = String(v('supplierId', 'supplier_id') ?? '');
  if (!/^\d{1,18}$/.test(sup) || !(await outsideRequestScope(() => one(`SELECT 1 FROM supplier WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [sup, orgId])))) throw new LandlordError(422, 'The landlord is a supplier (Finance → Bills → Suppliers).');
  const basis = String(v('basis', 'basis') ?? '');
  if (!(BASES as readonly string[]).includes(basis)) throw new LandlordError(422, `basis is one of ${BASES.join(', ')}.`);
  const currency = String(v('currency', 'currency') ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new LandlordError(422, 'currency is an ISO code.');
  const int = (k: string, col: string) => { const x = Number(v(k, col) ?? 0); if (!Number.isInteger(x) || x < 0) throw new LandlordError(422, `${k} is a whole amount, 0 or more.`); return x; };
  const num = (k: string, col: string, max: number) => { const x = Number(v(k, col) ?? 0); if (!Number.isFinite(x) || x < 0 || x > max) throw new LandlordError(422, `${k} is 0 to ${max}.`); return x; };
  const fixed = int('fixed', 'fixed_minor'), minimum = int('minimum', 'minimum_minor'), sharePct = num('sharePct', 'share_pct', 100), esc = num('escalationPct', 'escalation_pct', 50), recharge = num('rechargePerKwh', 'recharge_per_kwh', 1e9);
  const free = Number(v('rentFreeMonths', 'rent_free_months') ?? 0);
  if (!Number.isInteger(free) || free < 0 || free > 60) throw new LandlordError(422, 'rentFreeMonths is 0 to 60.');
  if ((basis === 'fixed' || basis === 'fixed_plus_share') && !fixed) throw new LandlordError(422, 'A fixed rent needs its amount (fixed).');
  if ((basis === 'share' || basis === 'higher_of' || basis === 'fixed_plus_share') && !sharePct) throw new LandlordError(422, 'A share needs its sharePct.');
  if (basis === 'higher_of' && !minimum) throw new LandlordError(422, 'higher_of needs the minimum guarantee (minimum).');
  const shareOf = String(v('shareOf', 'share_of') ?? 'revenue');
  if (!['revenue', 'margin'].includes(shareOf)) throw new LandlordError(422, 'shareOf is revenue or margin.');
  const billing = String(v('billing', 'billing') ?? 'monthly');
  if (!['monthly', 'quarterly'].includes(billing)) throw new LandlordError(422, 'billing is monthly or quarterly.');
  const start = String(v('startOn', 'start_s') ?? ''), end = v('endOn', 'end_s') == null || v('endOn', 'end_s') === '' ? null : String(v('endOn', 'end_s'));
  if (!DATE_RE.test(start) || (end && (!DATE_RE.test(end) || end <= start))) throw new LandlordError(422, 'startOn and endOn are YYYY-MM-DD, the end after the start.');
  const lease = v('leaseId', 'lease_id') == null || v('leaseId', 'lease_id') === '' ? null : String(v('leaseId', 'lease_id'));
  if (lease && (!/^\d{1,18}$/.test(lease) || !(await outsideRequestScope(() => one(`SELECT 1 FROM lease WHERE id = $1 AND org_id = $2`, [lease, orgId]))))) throw new LandlordError(422, 'No such lease.');
  const status = String(v('status', 'status') ?? 'active');
  if (!['active', 'ended'].includes(status)) throw new LandlordError(422, 'status is active or ended.');
  if (cur && (await outsideRequestScope(() => one(`SELECT 1 FROM landlord_statement WHERE deal_id = $1 AND status = 'issued'`, [cur.id])))
    && (basis !== cur.basis || fixed !== Number(cur.fixed_minor) || sharePct !== Number(cur.share_pct) || minimum !== Number(cur.minimum_minor) || start !== cur.start_s || currency !== cur.currency))
    throw new LandlordError(409, 'Statements were issued under these terms: end this deal and add a new one from the change.');
  const p = [orgId, site, sup, v('reference', 'reference') ? String(v('reference', 'reference')).slice(0, 80) : null, currency, basis, fixed, sharePct, shareOf, minimum, esc, free, recharge, billing, start, end, lease, status,
    v('note', 'note') ? String(v('note', 'note')).slice(0, 1000) : null];
  const r = cur
    ? await outsideRequestScope(() => one<any>(`UPDATE landlord_deal SET site_id = $2, supplier_id = $3, reference = $4, currency = $5, basis = $6, fixed_minor = $7, share_pct = $8, share_of = $9, minimum_minor = $10, escalation_pct = $11,
        rent_free_months = $12, recharge_per_kwh = $13, billing = $14, start_on = $15, end_on = $16, lease_id = $17, status = $18, note = $19 WHERE org_id = $1 AND id = $20 RETURNING id`, [...p, cur.id]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO landlord_deal (org_id, site_id, supplier_id, reference, currency, basis, fixed_minor, share_pct, share_of, minimum_minor, escalation_pct, rent_free_months, recharge_per_kwh, billing, start_on, end_on, lease_id, status, note, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`, [...p, userId]));
  return get(orgId, String(r.id));
}

/** Draft (or refresh the draft of) a statement for a period that has ended. */
export async function draftStatement(orgId: string, dealId: string, b: Record<string, unknown>, now = new Date()) {
  const d = await dRow(orgId, dealId);
  const from = String(b.month ?? '');
  if (!MONTH_RE.test(from)) throw new LandlordError(422, 'month is the YYYY-MM the statement starts.');
  const to = d.billing === 'quarterly' ? (from === d.start_s.slice(0, 7) ? `${from.slice(0, 4)}-${String(Math.floor((Number(from.slice(5)) - 1) / 3) * 3 + 3).padStart(2, '0')}` : addMonths(from, 2)) : from;
  if (d.billing === 'quarterly' && from !== d.start_s.slice(0, 7) && (Number(from.slice(5)) - 1) % 3 !== 0) throw new LandlordError(422, 'A quarterly deal\'s statement starts a quarter (or the deal\'s first month).');
  if (to >= today(now).slice(0, 7)) throw new LandlordError(422, 'The period has not ended yet.');
  if (from < d.start_s.slice(0, 7)) throw new LandlordError(422, `The deal starts on ${d.start_s}.`);
  const ms: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) ms.push(m);
  const ls = await lines(orgId, d, ms);
  const total = ls.reduce((a, l) => a + l.total, 0);
  const ex = await outsideRequestScope(() => one<any>(`SELECT * FROM landlord_statement WHERE deal_id = $1 AND month_from = $2 AND status <> 'void'`, [d.id, from]));
  if (ex && ex.status !== 'draft') throw new LandlordError(409, `${ex.number} is issued; void it to restate the period.`);
  if (ex) {
    await outsideRequestScope(() => query(`UPDATE landlord_statement SET month_to = $2, lines = $3, total_minor = $4 WHERE id = $1`, [ex.id, to, JSON.stringify(ls), total]));
    return statement(orgId, String(ex.id));
  }
  for (let k = 0; k < 5; k++) {
    const n = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) AS n FROM landlord_statement WHERE org_id = $1`, [orgId]));
    try {
      const r = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO landlord_statement (org_id, deal_id, number, month_from, month_to, lines, total_minor) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [orgId, d.id, `LS-${String(Number(n?.n ?? 0) + 1 + k).padStart(5, '0')}`, from, to, JSON.stringify(ls), total]));
      return statement(orgId, String(r!.id));
    } catch (e) { if ((e as any).code !== '23505') throw e; }
  }
  throw new LandlordError(409, 'Could not number the statement. Try again.');
}

async function stRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new LandlordError(404, 'No such statement.');
  const r = await outsideRequestScope(() => one<any>(`SELECT st.*, b.status AS bill_status FROM landlord_statement st LEFT JOIN supplier_bill b ON b.id = st.bill_id WHERE st.id = $1 AND st.org_id = $2`, [id, orgId]));
  if (!r) throw new LandlordError(404, 'No such statement.');
  return r;
}

export async function statement(orgId: string, id: string) {
  const s = await stRow(orgId, id);
  const d = await dRow(orgId, String(s.deal_id));
  return { ...sView(s), deal: dView(d) };
}

/** Issue: the landlord's supplier bill (rent, awaiting approval) for the total. */
export async function issue(orgId: string, id: string, userId: string | null) {
  const s = await statement(orgId, id);
  if (s.status !== 'draft') throw new LandlordError(409, `${s.number} is ${s.status}.`);
  let billId: string | null = null;
  if (s.total > 0) {
    try {
      const bill = await createBill(orgId, { supplierId: s.deal.supplierId, number: s.number, category: 'rent', siteId: s.deal.siteId, currency: s.deal.currency, subtotal: s.total,
        description: `${s.deal.site}: ${s.deal.basis.replace(/_/g, ' ')} rent ${s.monthFrom}${s.monthTo !== s.monthFrom ? ` to ${s.monthTo}` : ''}`, billDate: today() }, userId);
      billId = String((bill as any).id);
    } catch (e) { if (e instanceof BillError) throw new LandlordError(e.statusCode, e.message); throw e; }
  }
  await outsideRequestScope(() => query(`UPDATE landlord_statement SET status = 'issued', bill_id = $2, issued_at = now(), issued_by = $3 WHERE id = $1`, [s.id, billId, userId]));
  return statement(orgId, s.id);
}

export async function voidStatement(orgId: string, id: string) {
  const s = await stRow(orgId, id);
  if (s.status === 'void') throw new LandlordError(409, 'Already void.');
  if (s.bill_id && !['draft', 'rejected', 'void'].includes(s.bill_status)) throw new LandlordError(409, `Its bill is ${String(s.bill_status).replace('_', ' ')}: void the bill (Finance → Bills) first.`);
  await outsideRequestScope(() => query(`UPDATE landlord_statement SET status = 'void' WHERE id = $1`, [s.id]));
  return statement(orgId, String(s.id));
}

const money = (n: number, c: string) => `${c} ${Math.round(n).toLocaleString('en-US')}`;

export async function statementPdf(orgId: string, id: string): Promise<Buffer> {
  const s = await statement(orgId, id);
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const doc = new PdfDoc({ title: `${s.number} ${s.deal.landlord}`, author: org?.name ?? 'PlugSure CSMS', subject: 'Landlord statement', created: new Date() });
  const f = new Flow(doc);
  const c = s.deal.currency;
  f.para(`${org?.name ?? ''}: rent statement ${s.number}`, { size: 16, bold: true });
  f.para(`To ${s.deal.landlord} · ${s.deal.site} · ${s.monthFrom}${s.monthTo !== s.monthFrom ? ` to ${s.monthTo}` : ''}${s.status === 'draft' ? ' · DRAFT' : s.status === 'void' ? ' · VOID' : ''}`, { size: 10, color: [0.36, 0.39, 0.44] });
  f.heading('Terms');
  const basis = s.deal.basis === 'fixed' ? `Fixed rent ${money(s.deal.fixed, c)} a month` : s.deal.basis === 'share' ? `${s.deal.sharePct}% of the site's ${s.deal.shareOf}` : s.deal.basis === 'higher_of' ? `${s.deal.sharePct}% of the site's ${s.deal.shareOf}, at least ${money(s.deal.minimum, c)} a month` : `Fixed rent ${money(s.deal.fixed, c)} a month plus ${s.deal.sharePct}% of the site's ${s.deal.shareOf}`;
  f.row('Basis', basis);
  if (s.deal.escalationPct) f.row('Escalation', `${s.deal.escalationPct}% a year from ${s.deal.startOn}`);
  if (s.deal.rentFreeMonths) f.row('Rent-free', s.deal.rentFreeMonths === 1 ? 'the first month' : `the first ${s.deal.rentFreeMonths} months`);
  if (s.deal.rechargePerKwh) f.row('Energy recharge', `${c} ${s.deal.rechargePerKwh} per kWh`);
  if (s.deal.leaseId) f.row('Fixed rent', 'paid under the lease, not in this statement');
  f.heading('Months');
  const ls = s.lines as ReturnType<typeof computeMonth>[];
  f.table([{ label: 'Month', width: 1.1 }, { label: 'Revenue', width: 1.7, align: 'right' }, { label: 'kWh', width: 1.1, align: 'right' }, { label: 'Share', width: 1.5, align: 'right' }, { label: 'Fixed', width: 1.5, align: 'right' },
    { label: 'Top-up', width: 1.4, align: 'right' }, { label: 'Recharge', width: 1.4, align: 'right' }, { label: 'Due', width: 1.7, align: 'right' }],
  [...ls.map((l) => ({ cells: [`${l.month}${l.rentFree ? ' (free)' : ''}`, money(l.revenue, c), String(Math.round(l.kwh)), money(l.share, c), l.inLease ? 'lease' : money(l.fixed, c), money(l.topUp, c), money(l.recharge, c), money(l.total, c)] })),
    { cells: ['Total', '', '', '', '', '', '', money(s.total, c)], bold: true }], { size: 8 });
  f.gap(10);
  f.para('Revenue is what drivers paid before tax; the margin, where the share is of the margin, is the revenue less the site\'s energy cost.', { size: 8.5, color: [0.36, 0.39, 0.44] });
  return doc.toBuffer();
}

/** The month's accruals per currency (the ledger's 'landlords' source): this month's amount not billed by its end, and last month's reversed. */
export async function journal(orgId: string, month: string) {
  const ds = await outsideRequestScope(() => many<any>(`${D_SELECT} WHERE d.org_id = $1 AND d.start_on <= $2::date`, [orgId, lastDay(month)]));
  const prev = addMonths(month, -1);
  const out: Record<string, Array<{ account: string; debit: number; credit: number; description: string }>> = {};
  const unbilled = async (d: any, m: string) => {
    if (m < d.start_s.slice(0, 7)) return 0;
    const billed = await outsideRequestScope(() => one(`SELECT 1 FROM landlord_statement st JOIN supplier_bill b ON b.id = st.bill_id WHERE st.deal_id = $1 AND st.status = 'issued' AND $2 BETWEEN st.month_from AND st.month_to
      AND b.status NOT IN ('void', 'rejected') AND b.bill_date <= $3::date`, [d.id, m, lastDay(m)]));
    if (billed) return 0;
    return (await lines(orgId, d, [m]))[0]!.total;
  };
  for (const d of ds) {
    const L = (out[d.currency] ??= []), name = `${d.site_name} ${d.landlord}`.slice(0, 80);
    const now = await unbilled(d, month);
    if (now > 0) L.push({ account: '6210', debit: now, credit: 0, description: `${name} ${month} accrued` }, { account: '2420', debit: 0, credit: now, description: `${name} ${month} accrued` });
    const before = await unbilled(d, prev);
    if (before > 0) L.push({ account: '2420', debit: before, credit: 0, description: `${name} ${prev} accrual reversed` }, { account: '6210', debit: 0, credit: before, description: `${name} ${prev} accrual reversed` });
  }
  return out;
}

export async function dealsXlsx(orgId: string): Promise<Buffer> {
  const o = await overview(orgId);
  return xlsx([
    { name: 'Deals', rows: [['Site', 'Landlord', 'Reference', 'Basis', 'Currency', 'Fixed', 'Share %', 'Of', 'Minimum', 'Escalation %', 'Rent-free', 'Recharge/kWh', 'Billing', 'Start', 'End', 'Lease', 'Status', `Due ${o.month}`],
      ...o.deals.map((d) => [d.site, d.landlord, d.reference ?? '', d.basis, d.currency, d.fixed, d.sharePct, d.shareOf, d.minimum, d.escalationPct, d.rentFreeMonths, d.rechargePerKwh, d.billing, d.startOn, d.endOn ?? '', d.lease ?? '', d.status, d.lastMonth?.total ?? null])],
      widths: [22, 22, 12, 14, 8, 14, 8, 8, 14, 10, 8, 10, 9, 11, 11, 18, 8, 16], formats: [null, null, null, null, null, 'money', null, null, 'money', null, null, null, null, null, null, null, null, 'money'] },
    { name: 'Statements', rows: [['Number', 'Deal', 'From', 'To', 'Total', 'Status', 'Bill'], ...o.statements.map((s) => [s.number, o.deals.find((d) => d.id === s.dealId)?.site ?? s.dealId, s.monthFrom, s.monthTo, s.total, s.status, s.billStatus ?? ''])],
      widths: [10, 24, 9, 9, 16, 8, 16], formats: [null, null, null, null, 'money', null, null] },
  ]);
}

/** Monthly (the 2nd onwards): draft the statements of periods that have ended. */
export async function sweep(now = new Date()): Promise<number> {
  const ds = await outsideRequestScope(() => many<any>(`${D_SELECT} WHERE d.status = 'active'`, []));
  const sts = ds.length ? await outsideRequestScope(() => many<any>(`SELECT deal_id, month_from, status FROM landlord_statement WHERE deal_id = ANY($1::bigint[])`, [ds.map((d) => d.id)])) : [];
  let n = 0;
  for (const d of ds) {
    for (const m of dueMonths(d, sts, now).slice(-3)) {
      try { await draftStatement(d.org_id, String(d.id), { month: m }, now); n++; } catch (e) { logger.warn({ deal: d.id, month: m, err: (e as Error).message }, 'landlord statement draft failed'); }
    }
  }
  return n;
}
