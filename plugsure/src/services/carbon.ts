import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { assertOpen } from './finance-periods.js';
import { xlsx } from './xlsx.js';

/**
 * Carbon and green energy credits (v1.35.0).
 *
 *   RECs        renewable energy certificates (1 MWh each) bought for a site or the whole portfolio: registry, vintage,
 *               MWh, price; retired against a month. The green share of a month (per site and in all) is the MWh retired
 *               for it over the MWh charged, at most 100%.
 *   avoided     per kWh charged, the tailpipe emissions a petrol car would have made for the same distance (iceKgPerKwh,
 *               default 0.7 kg) less the grid's emissions for the share not covered by RECs (gridKgPerKwh, default 0.8 kg
 *               for the Indonesian grid). Both are settings; confirm them with your methodology.
 *   credits     carbon credits (tCO2e) for a period, estimated from the avoided emissions, then verified and issued under a
 *               standard with a serial; sold to buyers (never more than issued and unsold)
 *   ledger      RECs bought Dr 1750 green certificates / Cr bank; retired Dr 5150 green energy certificates / Cr 1750;
 *               credits sold Dr bank / Cr 4300 carbon credit revenue
 */

export class CarbonError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const ERR = (s: number, m: string) => new CarbonError(s, m);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const addMonths = (m: string, n: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + (mo - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };

export async function settings(orgId: string) {
  const r = await outsideRequestScope(() => one<{ carbon: any }>(`SELECT carbon FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const s = r?.carbon ?? {};
  return { gridKgPerKwh: Number(s.gridKgPerKwh ?? 0.8), iceKgPerKwh: Number(s.iceKgPerKwh ?? 0.7) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await settings(orgId);
  const v = { ...cur };
  for (const k of ['gridKgPerKwh', 'iceKgPerKwh'] as const) if (b[k] !== undefined) {
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || n > 3) throw new CarbonError(422, `${k} is 0 to 3 kg CO2 per kWh.`);
    v[k] = n;
  }
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, carbon, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET carbon = EXCLUDED.carbon, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/** Avoided kg CO2 for kWh charged with a green share (0–1). */
export function avoidedKg(kwh: number, greenShare: number, s: { gridKgPerKwh: number; iceKgPerKwh: number }) {
  return kwh * s.iceKgPerKwh - kwh * (1 - Math.min(1, Math.max(0, greenShare))) * s.gridKgPerKwh;
}

/** A month's charging, RECs retired, green share and avoided emissions, per site and in all. */
export async function month(orgId: string, monthRaw: unknown) {
  const m = String(monthRaw ?? '');
  if (!MONTH_RE.test(m)) throw new CarbonError(422, 'month is YYYY-MM.');
  const s = await settings(orgId);
  const [energy, recs] = await Promise.all([
    outsideRequestScope(() => many<{ site_id: string; name: string; wh: string; n: number }>(
      `SELECT s.id AS site_id, s.name, COALESCE(sum(cs.energy_wh), 0)::bigint AS wh, count(cs.id)::int AS n FROM site s
         LEFT JOIN charging_session cs ON cs.site_id = s.id AND to_char(cs.started_at AT TIME ZONE $3, 'YYYY-MM') = $2 AND cs.state IN ('ended', 'rated')
        WHERE s.org_id = $1 AND s.archived_at IS NULL GROUP BY 1, 2 ORDER BY 2`, [orgId, m, zone()])),
    outsideRequestScope(() => many<{ site_id: string | null; mwh: string }>(`SELECT site_id, sum(mwh) AS mwh FROM rec_purchase WHERE org_id = $1 AND retired_month = $2 AND voided_at IS NULL GROUP BY 1`, [orgId, m])),
  ]);
  const portfolio = Number(recs.find((r) => r.site_id == null)?.mwh ?? 0);
  const totalMwh = energy.reduce((a, e) => a + Number(e.wh) / 1e6, 0);
  const sites = energy.map((e) => {
    const mwh = Number(e.wh) / 1e6;
    const own = Number(recs.find((r) => r.site_id === e.site_id)?.mwh ?? 0);
    // The portfolio's RECs are shared by the sites in proportion to their energy.
    const shared = totalMwh ? (portfolio * mwh) / totalMwh : 0;
    const green = mwh ? Math.min(1, (own + shared) / mwh) : 0;
    const kg = avoidedKg(mwh * 1000, green, s);
    return { siteId: e.site_id, site: e.name, sessions: e.n, mwh: r3(mwh), recMwh: r3(own + shared), greenPct: Math.round(green * 1000) / 10, avoidedTonnes: r3(kg / 1000) };
  });
  const recMwh = recs.reduce((a, r) => a + Number(r.mwh), 0);
  const green = totalMwh ? Math.min(1, recMwh / totalMwh) : 0;
  return { month: m, settings: s, mwh: r3(totalMwh), recMwh: r3(recMwh), greenPct: Math.round(green * 1000) / 10, avoidedTonnes: r3(sites.reduce((a, x) => a + x.avoidedTonnes, 0)), sites };
}

export async function overview(orgId: string, now = new Date()) {
  const last = addMonths(today(now).slice(0, 7), -1);
  const trend = [];
  for (let k = 5; k >= 0; k--) { const m = await month(orgId, addMonths(last, -k)); trend.push({ month: m.month, mwh: m.mwh, greenPct: m.greenPct, avoidedTonnes: m.avoidedTonnes }); }
  const [recs, credits, sales] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT r.*, to_char(r.bought_on, 'YYYY-MM-DD') AS bought_s, s.name AS site_name FROM rec_purchase r LEFT JOIN site s ON s.id = r.site_id WHERE r.org_id = $1 AND r.voided_at IS NULL ORDER BY r.bought_on DESC, r.id DESC LIMIT 200`, [orgId])),
    outsideRequestScope(() => many<any>(`SELECT c.*, to_char(c.issued_on, 'YYYY-MM-DD') AS issued_s, (SELECT COALESCE(sum(tonnes), 0) FROM carbon_credit_sale x WHERE x.credit_id = c.id AND x.voided_at IS NULL) AS sold FROM carbon_credit c WHERE c.org_id = $1 AND c.status <> 'void' ORDER BY c.period_from DESC, c.id DESC`, [orgId])),
    outsideRequestScope(() => many<any>(`SELECT x.*, to_char(x.sold_on, 'YYYY-MM-DD') AS sold_s FROM carbon_credit_sale x WHERE x.org_id = $1 AND x.voided_at IS NULL ORDER BY x.sold_on DESC LIMIT 200`, [orgId])),
  ]);
  return {
    month: await month(orgId, last), trend,
    recs: recs.map((r) => ({ id: String(r.id), site: r.site_name ?? null, siteId: r.site_id ?? null, registry: r.registry, reference: r.reference ?? null, vintage: r.vintage, mwh: Number(r.mwh), currency: r.currency, price: Number(r.price_minor),
      boughtOn: r.bought_s, retiredMonth: r.retired_month ?? null })),
    recsHeld: r3(recs.filter((r) => !r.retired_month).reduce((a, r) => a + Number(r.mwh), 0)),
    credits: credits.map((c) => ({ id: String(c.id), periodFrom: c.period_from, periodTo: c.period_to, tonnes: Number(c.tonnes), status: c.status, standard: c.standard ?? null, serial: c.serial ?? null, issuedOn: c.issued_s ?? null,
      sold: Number(c.sold), available: c.status === 'issued' ? r3(Number(c.tonnes) - Number(c.sold)) : 0 })),
    sales: sales.map((x) => ({ id: String(x.id), creditId: String(x.credit_id), buyer: x.buyer, tonnes: Number(x.tonnes), currency: x.currency, amount: Number(x.amount_minor), soldOn: x.sold_s, reference: x.reference ?? null })),
  };
}

export async function buyRec(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const registry = String(b.registry ?? '').trim();
  if (registry.length < 2 || registry.length > 80) throw new CarbonError(422, 'registry is 2 to 80 characters (I-REC, PLN REC…).');
  const site = b.siteId == null || b.siteId === '' ? null : String(b.siteId);
  if (site && (!UUID_RE.test(site) || !(await outsideRequestScope(() => one(`SELECT 1 FROM site WHERE id = $1 AND org_id = $2`, [site, orgId]))))) throw new CarbonError(422, 'No such site.');
  const vintage = Number(b.vintage), mwh = Number(b.mwh), price = Number(b.price ?? 0);
  if (!Number.isInteger(vintage) || vintage < 2000 || vintage > 2100) throw new CarbonError(422, 'vintage is the year of generation.');
  if (!Number.isFinite(mwh) || mwh <= 0) throw new CarbonError(422, 'mwh is above 0.');
  if (!Number.isInteger(price) || price < 0) throw new CarbonError(422, 'price is a whole amount, 0 or more.');
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new CarbonError(422, 'currency is an ISO code.');
  const on = String(b.boughtOn ?? today());
  if (!DATE_RE.test(on)) throw new CarbonError(422, 'boughtOn is YYYY-MM-DD.');
  await assertOpen(orgId, on.slice(0, 7), 'A REC purchase', ERR);
  const acct = b.cashAccountId == null || b.cashAccountId === '' ? null : String(b.cashAccountId);
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO rec_purchase (org_id, site_id, registry, reference, vintage, mwh, currency, price_minor, bought_on, cash_account_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [orgId, site, registry, b.reference ? String(b.reference).slice(0, 80) : null, vintage, mwh, currency, price, on, acct, userId]));
  return { id: String(r!.id) };
}

export async function retireRec(orgId: string, id: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(id)) throw new CarbonError(404, 'No such certificate.');
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM rec_purchase WHERE id = $1 AND org_id = $2 AND voided_at IS NULL`, [id, orgId]));
  if (!r) throw new CarbonError(404, 'No such certificate.');
  if (r.retired_month) throw new CarbonError(409, `Already retired against ${r.retired_month}.`);
  const m = String(b.month ?? '');
  if (!MONTH_RE.test(m)) throw new CarbonError(422, 'month is the YYYY-MM the certificates cover.');
  await assertOpen(orgId, m, 'A REC retirement', ERR);
  await outsideRequestScope(() => query(`UPDATE rec_purchase SET retired_month = $2, retired_on = $3 WHERE id = $1`, [r.id, m, today()]));
  return month(orgId, m);
}

/** Estimate credits for a period from the avoided emissions. */
export async function estimate(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const from = String(b.from ?? ''), to = String(b.to ?? '');
  if (!MONTH_RE.test(from) || !MONTH_RE.test(to) || to < from) throw new CarbonError(422, 'from and to are YYYY-MM, from not after to.');
  let tonnes = 0;
  for (let m = from; m <= to; m = addMonths(m, 1)) tonnes += (await month(orgId, m)).avoidedTonnes;
  const r = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO carbon_credit (org_id, period_from, period_to, tonnes, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [orgId, from, to, r3(Math.max(0, tonnes)), userId]));
  return { id: String(r!.id), tonnes: r3(Math.max(0, tonnes)) };
}

export async function updateCredit(orgId: string, id: string, b: Record<string, unknown>) {
  if (!/^\d{1,18}$/.test(id)) throw new CarbonError(404, 'No such credit.');
  const c = await outsideRequestScope(() => one<any>(`SELECT * FROM carbon_credit WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!c) throw new CarbonError(404, 'No such credit.');
  const status = String(b.status ?? c.status);
  const order = ['estimated', 'verified', 'issued'];
  if (status === 'void') {
    const sold = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM carbon_credit_sale WHERE credit_id = $1 AND voided_at IS NULL`, [c.id]));
    if (sold?.n) throw new CarbonError(409, 'Credits already sold are not voided.');
  } else if (!order.includes(status) || order.indexOf(status) < order.indexOf(c.status)) throw new CarbonError(422, 'status moves estimated → verified → issued (or void).');
  const tonnes = b.tonnes === undefined ? Number(c.tonnes) : Number(b.tonnes);
  if (!Number.isFinite(tonnes) || tonnes < 0) throw new CarbonError(422, 'tonnes is 0 or more.');
  if (status === 'issued' && !(b.serial ?? c.serial)) throw new CarbonError(422, 'An issued credit has its registry serial.');
  await outsideRequestScope(() => query(`UPDATE carbon_credit SET status = $2, tonnes = $3, standard = COALESCE($4, standard), serial = COALESCE($5, serial), issued_on = CASE WHEN $2 = 'issued' THEN COALESCE(issued_on, $6::date) ELSE issued_on END, note = COALESCE($7, note) WHERE id = $1`,
    [c.id, status, r3(tonnes), b.standard ? String(b.standard).slice(0, 60) : null, b.serial ? String(b.serial).slice(0, 120) : null, today(), b.note ? String(b.note).slice(0, 300) : null]));
  return { id: String(c.id), status, tonnes: r3(tonnes) };
}

export async function sell(orgId: string, creditId: string, b: Record<string, unknown>, userId: string | null) {
  if (!/^\d{1,18}$/.test(creditId)) throw new CarbonError(404, 'No such credit.');
  const c = await outsideRequestScope(() => one<any>(`SELECT c.*, (SELECT COALESCE(sum(tonnes), 0) FROM carbon_credit_sale x WHERE x.credit_id = c.id AND x.voided_at IS NULL) AS sold FROM carbon_credit c WHERE c.id = $1 AND c.org_id = $2`, [creditId, orgId]));
  if (!c) throw new CarbonError(404, 'No such credit.');
  if (c.status !== 'issued') throw new CarbonError(409, 'Only issued credits are sold.');
  const tonnes = Number(b.tonnes), amount = Number(b.amount);
  const left = Number(c.tonnes) - Number(c.sold);
  if (!Number.isFinite(tonnes) || tonnes <= 0 || tonnes > left + 1e-9) throw new CarbonError(422, `tonnes is above 0 and at most ${r3(left)}.`);
  if (!Number.isInteger(amount) || amount < 0) throw new CarbonError(422, 'amount is a whole amount, 0 or more.');
  const buyer = String(b.buyer ?? '').trim();
  if (buyer.length < 2) throw new CarbonError(422, 'buyer is needed.');
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new CarbonError(422, 'currency is an ISO code.');
  const on = String(b.soldOn ?? today());
  if (!DATE_RE.test(on)) throw new CarbonError(422, 'soldOn is YYYY-MM-DD.');
  await assertOpen(orgId, on.slice(0, 7), 'A credit sale', ERR);
  await outsideRequestScope(() => query(`INSERT INTO carbon_credit_sale (org_id, credit_id, buyer, tonnes, currency, amount_minor, sold_on, cash_account_id, reference, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [orgId, c.id, buyer.slice(0, 120), r3(tonnes), currency, amount, on, b.cashAccountId ? String(b.cashAccountId) : null, b.reference ? String(b.reference).slice(0, 80) : null, userId]));
  return { creditId: String(c.id), sold: r3(Number(c.sold) + tonnes), available: r3(left - tonnes) };
}

/** For the cash position: RECs paid and credits sold through a cash account. */
export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT cash_account_id::text AS a, to_char(bought_on, 'YYYY-MM-DD') AS d, -price_minor AS amt FROM rec_purchase WHERE org_id = $1 AND voided_at IS NULL AND cash_account_id IS NOT NULL AND bought_on <= $2::date
     UNION ALL SELECT cash_account_id::text, to_char(sold_on, 'YYYY-MM-DD'), amount_minor FROM carbon_credit_sale WHERE org_id = $1 AND voided_at IS NULL AND cash_account_id IS NOT NULL AND sold_on <= $2::date`, [orgId, upTo]));
  return rows.map((r) => ({ account_id: r.a as string, d: r.d as string, amount: Number(r.amt) }));
}

export async function reportXlsx(orgId: string, fromRaw: unknown, toRaw: unknown): Promise<Buffer> {
  const to = toRaw ? String(toRaw) : addMonths(today().slice(0, 7), -1);
  const from = fromRaw ? String(fromRaw) : addMonths(to, -11);
  if (!MONTH_RE.test(from) || !MONTH_RE.test(to) || to < from) throw new CarbonError(422, 'from and to are YYYY-MM.');
  const months = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(await month(orgId, m));
  return xlsx([
    { name: 'By month', rows: [['Month', 'MWh charged', 'RECs retired (MWh)', 'Green %', 'Avoided tCO2e'], ...months.map((m) => [m.month, m.mwh, m.recMwh, m.greenPct, m.avoidedTonnes])], widths: [10, 14, 18, 10, 16] },
    { name: 'By site', rows: [['Month', 'Site', 'Sessions', 'MWh', 'REC MWh', 'Green %', 'Avoided tCO2e'], ...months.flatMap((m) => m.sites.map((s) => [m.month, s.site, s.sessions, s.mwh, s.recMwh, s.greenPct, s.avoidedTonnes]))], widths: [10, 30, 10, 10, 10, 10, 14] },
    { name: 'Method', rows: [['Setting', 'Value'], ['Grid kg CO2 per kWh', months[0]?.settings.gridKgPerKwh ?? ''], ['Petrol car kg CO2 per kWh charged (avoided)', months[0]?.settings.iceKgPerKwh ?? '']], widths: [44, 12] },
  ]);
}
