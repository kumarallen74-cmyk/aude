import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { config } from '../config.js';
import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { normalisePhone } from '../driver/identity.js';
import { xlsx } from './xlsx.js';
import { CURRENCIES, type CurrencyCode } from '../domain/money.js';
import * as credit from './driver-credit.js';

/**
 * EV dealer partnerships (v1.50.0), Commercial → Dealers. Car dealers bundle charging with the cars they sell:
 *
 *   dealers     each with the welcome credit its buyers get, how long a code stays valid, who pays for the credit
 *               (dealer: billed to the dealer when a buyer redeems it; operator: the operator's promotion), and a
 *               commission on its buyers' charging (basis points of the charging before tax, for so many months
 *               after the buyer joined)
 *   sales       the dealer (from its portal, a secret link) or the operator registers each car sold: the buyer,
 *               their phone, the car and its VIN. A welcome code is made and shown once; the buyer redeems it in
 *               the app like any voucher (Akun → Kredit). With the buyer's phone recorded, only that number can
 *               redeem it. One sale per VIN
 *   statements  each month per dealer: cars sold, codes redeemed and their credit, what the dealer is billed for
 *               it, its buyers' charging and the commission, and the net (positive: the dealer pays; negative: the
 *               operator pays the dealer). Drafted for last month automatically; issued, then settled with a
 *               reference
 */

export class DealerError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const S = <T>(fn: () => T) => outsideRequestScope(fn);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const str = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
/** A DATE column as YYYY-MM-DD: node-postgres parses DATE as local midnight, so read the local parts (toISOString would shift it a day east of UTC). */
const d10 = (v: any) => (v == null ? null : typeof v === 'string' ? v.slice(0, 10) : v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);
const lastMonth = () => { const t = new Date(); t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() - 1); return t.toISOString().slice(0, 7); };
/** The commission on charging (minor units, rounded half up). */
export const commissionOf = (revenueMinor: number, bps: number) => Math.round((revenueMinor * bps) / 10_000);

// ------------------------------------------------------------------ dealers

const dOf = (r: any) => ({
  id: String(r.id), name: r.name, make: r.make ?? null, branch: r.branch ?? null, contactName: r.contact_name ?? null, email: r.email ?? null, phone: r.phone ?? null,
  currency: r.currency, welcomeMinor: Number(r.welcome_minor), codeDays: r.code_days, funding: r.funding, commissionBps: r.commission_bps, commissionMonths: r.commission_months,
  portalLinked: !!r.portal_token_hash, portalPrefix: r.portal_token_prefix ?? null, archived: !!r.archived_at,
  sales30d: Number(r.sales30 ?? 0), redeemed: Number(r.redeemed ?? 0), sales: Number(r.sales ?? 0), pendingCodes: Number(r.pending ?? 0),
});
const D_SELECT = `SELECT d.*,
    (SELECT count(*) FROM dealer_sale s WHERE s.dealer_id = d.id AND s.voided_at IS NULL AND s.sold_on > current_date - 30) AS sales30,
    (SELECT count(*) FROM dealer_sale s WHERE s.dealer_id = d.id AND s.voided_at IS NULL) AS sales,
    (SELECT count(*) FROM dealer_sale s WHERE s.dealer_id = d.id AND s.redeemed_at IS NOT NULL) AS redeemed,
    (SELECT count(*) FROM dealer_sale s WHERE s.dealer_id = d.id AND s.voided_at IS NULL AND s.redeemed_at IS NULL AND s.code_expires_on >= current_date) AS pending
  FROM dealer d`;

export async function dealers(orgId: string, all = false) {
  return (await S(() => many<any>(`${D_SELECT} WHERE d.org_id = $1 AND ($2 OR d.archived_at IS NULL) ORDER BY d.archived_at NULLS FIRST, d.name`, [orgId, all]))).map(dOf);
}

async function dRow(orgId: string, id: string) {
  const r = await S(() => one<any>(`${D_SELECT} WHERE d.id = $1 AND d.org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new DealerError(404, 'No such dealer.');
  return r;
}

export async function saveDealer(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await dRow(orgId, id) : null;
  if (cur && b.archive === true) {
    await S(() => query(`UPDATE dealer SET archived_at = now(), portal_token_hash = NULL WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  if (cur && b.rotatePortal === true) {
    const token = `dlr_${randomBytes(24).toString('base64url')}`;
    await S(() => query(`UPDATE dealer SET portal_token_hash = $2, portal_token_prefix = $3 WHERE id = $1`, [cur.id, sha(token), token.slice(0, 8)]));
    return { id: String(cur.id), token, path: `/dealer/${token}` };
  }
  const v = <T>(k: string, col: string, f: (x: unknown) => T) => (b[k] === undefined ? cur?.[col] ?? null : f(b[k]));
  const name = v('name', 'name', (x) => str(x, 120));
  if (!name) throw new DealerError(422, 'A name is required.');
  const welcome = Number(v('welcomeMinor', 'welcome_minor', Number) ?? 0);
  if (!Number.isSafeInteger(welcome) || welcome < 0) throw new DealerError(422, 'welcomeMinor is a whole amount, 0 or more.');
  const days = Number(v('codeDays', 'code_days', Number) ?? 90);
  if (!Number.isInteger(days) || days < 7 || days > 365) throw new DealerError(422, 'codeDays is 7 to 365.');
  const funding = String(v('funding', 'funding', String) ?? 'dealer');
  if (!['dealer', 'operator'].includes(funding)) throw new DealerError(422, 'funding is dealer or operator.');
  const bps = Number(v('commissionBps', 'commission_bps', Number) ?? 0);
  if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new DealerError(422, 'commissionBps is 0 to 5000 (50 %).');
  const months = Number(v('commissionMonths', 'commission_months', Number) ?? 12);
  if (!Number.isInteger(months) || months < 1 || months > 60) throw new DealerError(422, 'commissionMonths is 1 to 60.');
  const email = v('email', 'email', (x) => str(x, 200));
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DealerError(422, 'Not an e-mail address.');
  const vals = [name, v('make', 'make', (x) => str(x, 60)), v('branch', 'branch', (x) => str(x, 120)), v('contactName', 'contact_name', (x) => str(x, 120)), email,
    v('phone', 'phone', (x) => str(x, 30)), welcome, days, funding, bps, months];
  if (cur) {
    await S(() => query(`UPDATE dealer SET name = $2, make = $3, branch = $4, contact_name = $5, email = $6, phone = $7, welcome_minor = $8, code_days = $9, funding = $10,
      commission_bps = $11, commission_months = $12 WHERE id = $1`, [cur.id, ...vals]));
    return dOf(await dRow(orgId, String(cur.id)));
  }
  const { currency } = await credit.settings(orgId);
  const r = await S(() => one<any>(`INSERT INTO dealer (org_id, name, make, branch, contact_name, email, phone, welcome_minor, code_days, funding, commission_bps, commission_months, currency)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [orgId, ...vals, currency]));
  return dOf(await dRow(orgId, String(r.id)));
}

// ------------------------------------------------------------------ sales

const sOf = (r: any) => ({
  id: String(r.id), number: r.number, dealerId: String(r.dealer_id), dealer: r.dealer_name ?? null, buyerName: r.buyer_name,
  buyerPhone: r.buyer_phone ? `…${String(r.buyer_phone).slice(-4)}` : null, vehicle: r.vehicle ?? null, vin: r.vin ?? null, plate: r.plate ?? null,
  soldOn: d10(r.sold_on), codeLast4: r.code_last4, welcomeMinor: Number(r.welcome_minor), currency: r.currency, funding: r.funding, codeExpiresOn: d10(r.code_expires_on),
  status: r.voided_at ? 'void' : r.redeemed_at ? 'redeemed' : d10(r.code_expires_on)! < today() ? 'expired' : 'pending',
  redeemedAt: r.redeemed_at ? new Date(r.redeemed_at).toISOString() : null, createdVia: r.created_via,
});

export async function sales(orgId: string, q: Record<string, unknown> = {}) {
  const dealerId = q.dealerId ? Number(q.dealerId) || 0 : null;
  const month = q.month && MONTH_RE.test(String(q.month)) ? String(q.month) : null;
  const rows = await S(() => many<any>(`SELECT s.*, d.name AS dealer_name FROM dealer_sale s JOIN dealer d ON d.id = s.dealer_id
    WHERE s.org_id = $1 AND ($2::bigint IS NULL OR s.dealer_id = $2) AND ($3::text IS NULL OR to_char(s.sold_on, 'YYYY-MM') = $3)
    ORDER BY s.sold_on DESC, s.id DESC LIMIT 1000`, [orgId, dealerId, month]));
  return rows.map(sOf);
}

/** Register a car sold. Returns the sale with its welcome code (shown this once). */
export async function registerSale(orgId: string, dealerId: string, b: Record<string, unknown>, via: 'console' | 'portal') {
  const d = await dRow(orgId, dealerId);
  if (d.archived_at) throw new DealerError(409, 'This dealer is archived.');
  const buyer = str(b.buyerName, 120);
  if (!buyer) throw new DealerError(422, 'The buyer\'s name is required.');
  let phone: string | null = null;
  if (str(b.buyerPhone, 30)) {
    phone = normalisePhone(String(b.buyerPhone));
    if (!phone) throw new DealerError(422, 'Not a mobile number.');
  }
  const vin = str(b.vin, 17)?.toUpperCase() ?? null;
  if (vin && !/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin)) throw new DealerError(422, 'The VIN is 11 to 17 letters and digits (no I, O or Q).');
  const soldOn = b.soldOn ? String(b.soldOn) : today();
  if (!DATE_RE.test(soldOn) || soldOn > today()) throw new DealerError(422, 'soldOn is a date (YYYY-MM-DD), not in the future.');
  const code = credit.newCode(3, 4);
  const expires = new Date(Date.now() + d.code_days * 86_400_000).toISOString().slice(0, 10);
  try {
    const id = await S(() => tx(async (c) => {
      const n = (await c.query(`SELECT count(*) + 1 AS n FROM dealer_sale WHERE org_id = $1`, [orgId])).rows[0].n;
      const r = (await c.query(`INSERT INTO dealer_sale (org_id, dealer_id, number, buyer_name, buyer_phone, vehicle, vin, plate, sold_on, code_hash, code_last4, welcome_minor, currency, funding,
          code_expires_on, created_via) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [orgId, d.id, `DS-${String(n).padStart(5, '0')}`, buyer, phone, str(b.vehicle, 80), vin, str(b.plate, 15)?.toUpperCase() ?? null, soldOn,
        credit.hashCode(code), credit.normaliseCode(code).slice(-4), Number(d.welcome_minor), d.currency, d.funding, expires, via])).rows[0];
      return String(r.id);
    }));
    const s = (await sales(orgId, { dealerId })).find((x) => x.id === id)!;
    return { ...s, code };
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new DealerError(409, `A sale with VIN ${vin} is already registered.`);
    throw e;
  }
}

export async function voidSale(orgId: string, id: string) {
  const r = await S(() => one<any>(`UPDATE dealer_sale SET voided_at = now() WHERE id = $1 AND org_id = $2 AND voided_at IS NULL AND redeemed_at IS NULL RETURNING id`, [Number(id) || 0, orgId]));
  if (!r) throw new DealerError(409, 'Only a sale whose code has not been redeemed can be voided.');
  return { id: String(r.id), voided: true };
}

/**
 * A welcome code redeemed in the app (driver-credit redeem, when the code is no gift card): credit with the operator,
 * the driver tied to the dealer. Runs in the redeem's transaction. Null: not a dealer code.
 */
export async function redeemWelcome(c: Pick<pg.PoolClient, 'query'>, appDriverId: string, codeHash: string) {
  const s = (await c.query(`SELECT * FROM dealer_sale WHERE code_hash = $1 FOR UPDATE`, [codeHash])).rows[0];
  if (!s || s.voided_at || s.redeemed_at) return null;
  if (d10(s.code_expires_on)! < today()) throw new DealerError(410, 'Kode ini sudah kedaluwarsa.');
  if (s.buyer_phone) {
    const me = (await c.query(`SELECT phone FROM app_driver WHERE id = $1`, [appDriverId])).rows[0];
    if (!me || me.phone !== s.buyer_phone) throw new DealerError(403, 'Kode ini hanya untuk nomor HP pembeli mobil.');
  }
  const st = await credit.settings(s.org_id);
  if (!st.enabled) throw new DealerError(409, 'Operator ini belum menerima kredit.');
  const exp = new Date(); exp.setUTCMonth(exp.getUTCMonth() + st.expiryMonths);
  await c.query(`UPDATE dealer_sale SET app_driver_id = $2, redeemed_at = now() WHERE id = $1`, [s.id, appDriverId]);
  if (Number(s.welcome_minor) > 0) {
    await c.query(`INSERT INTO driver_credit_entry (org_id, app_driver_id, currency, kind, funded, amount_minor, remaining_minor, expires_at, dealer_sale_id, note)
      VALUES ($1,$2,$3,'voucher',$4,$5,$5,$6,$7,$8)`, [s.org_id, appDriverId, s.currency, s.funding === 'dealer', Number(s.welcome_minor), exp, s.id, `Welcome ${s.number}`]);
  }
  return { orgId: s.org_id as string, currency: s.currency as string, amountMinor: Number(s.welcome_minor), expiresAt: exp.toISOString(), dealerSale: s.number as string };
}

// ------------------------------------------------------------------ statements

/** A dealer's month, computed from the sales, the redemptions and its buyers' charging. */
export async function compute(orgId: string, dealerId: string, month: string) {
  if (!MONTH_RE.test(month)) throw new DealerError(422, 'month is YYYY-MM.');
  const d = await dRow(orgId, dealerId);
  const tz = config.billing.timeZone;
  const k = await S(() => one<any>(`SELECT
      count(*) FILTER (WHERE voided_at IS NULL AND to_char(sold_on, 'YYYY-MM') = $2) AS sales,
      count(*) FILTER (WHERE to_char(redeemed_at AT TIME ZONE $3, 'YYYY-MM') = $2) AS redeemed,
      COALESCE(sum(welcome_minor) FILTER (WHERE to_char(redeemed_at AT TIME ZONE $3, 'YYYY-MM') = $2), 0) AS welcome,
      COALESCE(sum(welcome_minor) FILTER (WHERE funding = 'dealer' AND to_char(redeemed_at AT TIME ZONE $3, 'YYYY-MM') = $2), 0) AS billed
    FROM dealer_sale WHERE dealer_id = $1`, [d.id, month, tz]));
  const ch = await S(() => one<any>(`SELECT count(DISTINCT s.app_driver_id) AS drivers, COALESCE(sum(cs.energy_wh), 0) / 1000.0 AS kwh, COALESCE(sum(c.subtotal_minor), 0) AS revenue
    FROM dealer_sale s JOIN driver_charge dc ON dc.app_driver_id = s.app_driver_id AND dc.org_id = s.org_id
      JOIN charging_session cs ON cs.id = dc.session_id JOIN cdr c ON c.session_id = cs.id
    WHERE s.dealer_id = $1 AND s.redeemed_at IS NOT NULL
      AND cs.ended_at >= ((($2 || '-01')::timestamp) AT TIME ZONE $3) AND cs.ended_at < ((($2 || '-01')::timestamp + interval '1 month') AT TIME ZONE $3)
      AND cs.ended_at >= s.redeemed_at AND cs.ended_at < s.redeemed_at + make_interval(months => $4)`, [d.id, month, tz, d.commission_months]));
  const revenue = Number(ch?.revenue ?? 0);
  const commission = commissionOf(revenue, d.commission_bps);
  const billed = Number(k?.billed ?? 0);
  return {
    dealerId: String(d.id), dealer: d.name, month, currency: d.currency, sales: Number(k?.sales ?? 0), redeemed: Number(k?.redeemed ?? 0),
    welcomeMinor: Number(k?.welcome ?? 0), billedMinor: billed, drivers: Number(ch?.drivers ?? 0), kwh: Math.round(Number(ch?.kwh ?? 0) * 1000) / 1000,
    revenueMinor: revenue, commissionBps: d.commission_bps, commissionMinor: commission, netMinor: billed - commission,
  };
}

const stOf = (r: any) => ({
  id: String(r.id), dealerId: String(r.dealer_id), dealer: r.dealer_name ?? null, month: r.month, currency: r.currency, sales: r.sales, redeemed: r.redeemed,
  welcomeMinor: Number(r.welcome_minor), billedMinor: Number(r.billed_minor), drivers: r.drivers, kwh: Number(r.kwh), revenueMinor: Number(r.revenue_minor),
  commissionMinor: Number(r.commission_minor), netMinor: Number(r.net_minor), status: r.status, reference: r.reference ?? null,
  issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null, settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
});

/** Draft (or refresh the draft of) a dealer's month. An issued statement is not changed. */
export async function draft(orgId: string, dealerId: string, month: string) {
  const s = await compute(orgId, dealerId, month);
  const r = await S(() => one<any>(`INSERT INTO dealer_statement (org_id, dealer_id, month, currency, sales, redeemed, welcome_minor, billed_minor, drivers, kwh, revenue_minor, commission_minor, net_minor)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (dealer_id, month) DO UPDATE SET sales = $5, redeemed = $6, welcome_minor = $7, billed_minor = $8, drivers = $9, kwh = $10, revenue_minor = $11, commission_minor = $12, net_minor = $13
      WHERE dealer_statement.status = 'draft' RETURNING *`,
  [orgId, Number(dealerId), month, s.currency, s.sales, s.redeemed, s.welcomeMinor, s.billedMinor, s.drivers, s.kwh, s.revenueMinor, s.commissionMinor, s.netMinor]));
  return r ? stOf(r) : stOf(await S(() => one<any>(`SELECT * FROM dealer_statement WHERE dealer_id = $1 AND month = $2`, [Number(dealerId), month])));
}

export async function statements(orgId: string, q: Record<string, unknown> = {}) {
  const dealerId = q.dealerId ? Number(q.dealerId) || 0 : null;
  return (await S(() => many<any>(`SELECT st.*, d.name AS dealer_name FROM dealer_statement st JOIN dealer d ON d.id = st.dealer_id
    WHERE st.org_id = $1 AND ($2::bigint IS NULL OR st.dealer_id = $2) ORDER BY st.month DESC, d.name LIMIT 500`, [orgId, dealerId]))).map(stOf);
}

/** issue (a draft, refreshed first), settle (an issued one, with a reference), or refresh (a draft). */
export async function act(orgId: string, id: string, b: Record<string, unknown>) {
  const r = await S(() => one<any>(`SELECT * FROM dealer_statement WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new DealerError(404, 'No such statement.');
  const action = String(b.action ?? '');
  if (action === 'refresh' || action === 'issue') {
    if (r.status !== 'draft') throw new DealerError(409, 'Only a draft can be refreshed or issued.');
    if (r.month >= new Date().toISOString().slice(0, 7)) throw new DealerError(409, 'A month is issued once it is over.');
    await draft(orgId, String(r.dealer_id), r.month);
    if (action === 'issue') await S(() => query(`UPDATE dealer_statement SET status = 'issued', issued_at = now() WHERE id = $1`, [r.id]));
  } else if (action === 'settle') {
    if (r.status !== 'issued') throw new DealerError(409, 'Only an issued statement can be settled.');
    const ref = str(b.reference, 80);
    if (!ref) throw new DealerError(422, 'The payment\'s reference is required.');
    await S(() => query(`UPDATE dealer_statement SET status = 'settled', settled_at = now(), reference = $2 WHERE id = $1`, [r.id, ref]));
  } else throw new DealerError(422, 'action is refresh, issue or settle.');
  return stOf(await S(() => one<any>(`SELECT st.*, d.name AS dealer_name FROM dealer_statement st JOIN dealer d ON d.id = st.dealer_id WHERE st.id = $1`, [r.id])));
}

export async function statementXlsx(orgId: string, id: string): Promise<{ name: string; data: Buffer }> {
  const r = await S(() => one<any>(`SELECT st.*, d.name AS dealer_name, d.commission_bps FROM dealer_statement st JOIN dealer d ON d.id = st.dealer_id WHERE st.id = $1 AND st.org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new DealerError(404, 'No such statement.');
  const s = stOf(r);
  const list = (await sales(orgId, { dealerId: s.dealerId })).filter((x) => x.soldOn!.slice(0, 7) === s.month || (x.redeemedAt ?? '').slice(0, 7) === s.month);
  const data = xlsx([{ name: 'Statement', rows: [
    [`${s.dealer} · ${s.month} · ${s.status}`], [],
    ['Cars sold', s.sales], ['Welcome codes redeemed', s.redeemed], [`Welcome credit redeemed (${s.currency})`, s.welcomeMinor], [`Billed to the dealer (${s.currency})`, s.billedMinor],
    ['Buyers who charged', s.drivers], ['kWh', s.kwh], [`Their charging before tax (${s.currency})`, s.revenueMinor], [`Commission at ${(r.commission_bps / 100).toFixed(2)} % (${s.currency})`, s.commissionMinor],
    [`Net: the dealer pays (+) / is paid (−) (${s.currency})`, s.netMinor],
  ] }, { name: 'Sales', rows: [
    ['Sale', 'Sold on', 'Buyer', 'Car', 'VIN', 'Code', 'Status', 'Redeemed', `Welcome (${s.currency})`],
    ...list.map((x) => [x.number, x.soldOn ?? '', x.buyerName, x.vehicle ?? '', x.vin ?? '', `…${x.codeLast4}`, x.status, x.redeemedAt?.slice(0, 10) ?? '', x.welcomeMinor]),
  ] }]);
  return { name: `dealer-${s.dealerId}-${s.month}.xlsx`, data };
}

/** The worker: draft last month's statement for every dealer (until issued, a draft is refreshed). */
export async function sweep(): Promise<number> {
  const m = lastMonth();
  const ds = await S(() => many<any>(`SELECT d.id, d.org_id FROM dealer d WHERE (d.archived_at IS NULL OR d.archived_at > now() - interval '45 days')
    AND NOT EXISTS (SELECT 1 FROM dealer_statement st WHERE st.dealer_id = d.id AND st.month = $1 AND st.status <> 'draft')`, [m]));
  for (const d of ds) await draft(d.org_id, String(d.id), m).catch(() => null);
  return ds.length;
}

// ------------------------------------------------------------------ the dealer's portal

async function byToken(token: string) {
  const d = token.startsWith('dlr_') ? await S(() => one<any>(`SELECT * FROM dealer WHERE portal_token_hash = $1 AND archived_at IS NULL`, [sha(token)])) : null;
  if (!d) throw new DealerError(404, 'This link is not valid.');
  return d;
}

export async function portal(token: string) {
  const d = await byToken(token);
  const list = (await sales(d.org_id, { dealerId: String(d.id) })).slice(0, 200).map(({ dealer, ...x }) => x);
  const sts = (await statements(d.org_id, { dealerId: String(d.id) })).filter((s) => s.status !== 'draft').slice(0, 24);
  const org = await S(() => one<any>(`SELECT name FROM organisation WHERE id = $1`, [d.org_id]));
  return {
    dealer: d.name, operator: org?.name ?? null, make: d.make ?? null, currency: d.currency, exponent: CURRENCIES[d.currency as CurrencyCode]?.exponent ?? 2, welcomeMinor: Number(d.welcome_minor), codeDays: d.code_days,
    funding: d.funding, commissionBps: d.commission_bps, commissionMonths: d.commission_months,
    thisMonth: await compute(d.org_id, String(d.id), new Date().toISOString().slice(0, 7)), sales: list, statements: sts,
  };
}

export async function portalSale(token: string, b: Record<string, unknown>) {
  const d = await byToken(token);
  return registerSale(d.org_id, String(d.id), b, 'portal');
}
