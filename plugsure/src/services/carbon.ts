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
  return {
    gridKgPerKwh: Number(s.gridKgPerKwh ?? 0.8), iceKgPerKwh: Number(s.iceKgPerKwh ?? 0.7),
    /** (v1.44.0) Grid emission factors by province (BPS code, the first two digits of a site's kabupaten/kota code). */
    provinceKgPerKwh: (s.provinceKgPerKwh && typeof s.provinceKgPerKwh === 'object' ? s.provinceKgPerKwh : {}) as Record<string, number>,
  };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await settings(orgId);
  const v = { ...cur };
  for (const k of ['gridKgPerKwh', 'iceKgPerKwh'] as const) if (b[k] !== undefined) {
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || n > 3) throw new CarbonError(422, `${k} is 0 to 3 kg CO2 per kWh.`);
    v[k] = n;
  }
  if (b.provinceKgPerKwh !== undefined) {
    const raw = b.provinceKgPerKwh;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CarbonError(422, 'provinceKgPerKwh is { "<BPS province code>": kg CO2 per kWh }.');
    const out: Record<string, number> = {};
    for (const [k, x] of Object.entries(raw as Record<string, unknown>)) {
      if (x === null || x === '') continue;
      const n = Number(x);
      if (!/^\d{2}$/.test(k) || !Number.isFinite(n) || n < 0 || n > 3) throw new CarbonError(422, `provinceKgPerKwh: ${k.slice(0, 10)} must be a two-digit province code with 0 to 3 kg CO2 per kWh.`);
      out[k] = n;
    }
    v.provinceKgPerKwh = out;
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

// ------------------------------------------------------------------ (v1.44.0) per session and per site

/**
 * Carbon per session and per site (v1.44.0), on top of the monthly figures above:
 *   grid factor   the site's own (Sites → Edit → Carbon), else its province's (Finance → Carbon; the first two digits of
 *                 the site's kabupaten/kota code), else the default. No figures are built in: enter the ones your
 *                 methodology uses (e.g. the published grid emission factor of the PLN system the site is on).
 *   solar share   measured: the site's own solar used on site over its total supply, from the energy box's readings
 *                 during the session (Assets → Solar & battery). Battery output counts as grid (conservative: the
 *                 battery may have charged from the grid). No readings: 0.
 *   REC share     the month's renewable certificates for the site (as above), applied to what is not solar.
 *   emitted       kWh × (1 − solar) × (1 − REC share) × grid factor
 *   avoided       kWh × the petrol figure − emitted
 */

export interface Reading { ts: number; solarW: number | null; gridW: number | null; batteryW: number | null }

/** The solar share of the site's supply over readings (each held until the next, at most maxStepS). Null with none. */
export function solarShareOf(readings: Reading[], maxStepS = 900): number | null {
  let solar = 0, load = 0;
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i]!, next = readings[i + 1];
    const dt = Math.min(maxStepS, next ? Math.max(0, (next.ts - r.ts) / 1000) : 60);
    const exported = Math.max(0, -(r.gridW ?? 0));
    const used = Math.max(0, (r.solarW ?? 0) - exported);
    solar += used * dt;
    load += (used + Math.max(0, r.gridW ?? 0) + Math.max(0, r.batteryW ?? 0)) * dt;
  }
  return load > 0 ? Math.min(1, solar / load) : null;
}

/** kg CO2e emitted for kWh with these shares (0–1) and factor. */
export const emittedKg = (kwh: number, solarShare: number, recShare: number, gridKgPerKwh: number) =>
  kwh * (1 - Math.min(1, Math.max(0, solarShare))) * (1 - Math.min(1, Math.max(0, recShare))) * gridKgPerKwh;

/** The grid factor a site uses, and where it came from. */
export function gridFactorFor(site: { grid_kg_per_kwh: unknown; kabupaten_kota_code: string | null; country_code: string | null }, s: Awaited<ReturnType<typeof settings>>) {
  if (site.grid_kg_per_kwh != null) return { kgPerKwh: Number(site.grid_kg_per_kwh), source: 'site' as const };
  const prov = site.kabupaten_kota_code ? String(site.kabupaten_kota_code).slice(0, 2) : null;
  if (prov && s.provinceKgPerKwh[prov] != null) return { kgPerKwh: Number(s.provinceKgPerKwh[prov]), source: 'province' as const, province: prov };
  return { kgPerKwh: s.gridKgPerKwh, source: 'default' as const };
}

const monthOfZone = (t: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: zone(), year: 'numeric', month: '2-digit' }).format(t).slice(0, 7);

/** The REC (green) share per site for each month, memoised for one report. */
function recShares(orgId: string) {
  const cache = new Map<string, Promise<Map<string, number>>>();
  return async (siteId: string, m: string) => {
    if (!cache.has(m)) cache.set(m, month(orgId, m).then((x) => new Map(x.sites.map((y) => [y.siteId, y.greenPct / 100]))).catch(() => new Map()));
    return (await cache.get(m)!).get(siteId) ?? 0;
  };
}

async function readingsFor(siteId: string, from: Date, to: Date): Promise<Reading[]> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT ts, solar_w, grid_w, battery_w FROM site_energy_reading WHERE site_id = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts`, [siteId, from, to]));
  return rows.map((r) => ({ ts: new Date(r.ts).getTime(), solarW: r.solar_w == null ? null : Number(r.solar_w), gridW: r.grid_w == null ? null : Number(r.grid_w), batteryW: r.battery_w == null ? null : Number(r.battery_w) }));
}

/** One session's carbon (the driver's receipt; the console). Null for a session with no energy. */
export async function sessionCarbon(orgId: string, sessionId: string) {
  if (!UUID_RE.test(sessionId)) throw ERR(404, 'No such session.');
  const r = await outsideRequestScope(() => one<any>(
    `SELECT cs.id, cs.site_id, cs.started_at, COALESCE(cs.ended_at, now()) AS ended_at, cs.energy_wh, s.grid_kg_per_kwh, s.kabupaten_kota_code, s.country_code
       FROM charging_session cs JOIN site s ON s.id = cs.site_id WHERE cs.id = $1 AND cs.org_id = $2`, [sessionId, orgId]));
  if (!r) throw ERR(404, 'No such session.');
  const kwh = Number(r.energy_wh ?? 0) / 1000;
  if (kwh <= 0) return null;
  const s = await settings(orgId);
  const g = gridFactorFor(r, s);
  const solar = solarShareOf(await readingsFor(r.site_id, new Date(r.started_at), new Date(r.ended_at))) ?? 0;
  const rec = await recShares(orgId)(r.site_id, monthOfZone(new Date(r.started_at)));
  const emitted = emittedKg(kwh, solar, rec, g.kgPerKwh);
  return {
    sessionId, kwh: r3(kwh), gridKgPerKwh: g.kgPerKwh, gridFactorSource: g.source, solarSharePct: Math.round(solar * 1000) / 10, recSharePct: Math.round(rec * 1000) / 10,
    emittedKg: Math.round(emitted * 100) / 100, petrolKg: Math.round(kwh * s.iceKgPerKwh * 100) / 100, avoidedKg: Math.round((kwh * s.iceKgPerKwh - emitted) * 100) / 100,
  };
}

/** Per site over a period (at most 92 days; without one, the last 30 days): sessions, energy, the factor, solar and REC shares, emitted and avoided. */
export async function siteReport(orgId: string, fromRaw: unknown, toRaw: unknown) {
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  const to = empty(toRaw) ? today() : String(toRaw);
  const from = empty(fromRaw) ? (DATE_RE.test(to) ? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10) : '') : String(fromRaw);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) throw ERR(422, 'from and to are dates (YYYY-MM-DD), to on or after from.');
  const fromT = new Date(`${from}T00:00:00Z`), toT = new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000);
  if ((toT.getTime() - fromT.getTime()) / 86_400_000 > 92) throw ERR(422, 'At most 92 days at a time.');
  const s = await settings(orgId);
  const recOf = recShares(orgId);
  const sites = await outsideRequestScope(() => many<any>(`SELECT id, name, grid_kg_per_kwh, kabupaten_kota_code, country_code FROM site WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`, [orgId]));
  const out = [];
  for (const site of sites) {
    const sess = await outsideRequestScope(() => many<any>(
      `SELECT started_at, COALESCE(ended_at, started_at) AS ended_at, energy_wh FROM charging_session
        WHERE site_id = $1 AND started_at >= $2 AND started_at < $3 AND state IN ('ended', 'rated') AND energy_wh > 0 ORDER BY started_at`, [site.id, fromT, toT]));
    const g = gridFactorFor(site, s);
    const readings = sess.length ? await readingsFor(site.id, fromT, toT) : [];
    let kwh = 0, solarKwh = 0, emitted = 0;
    for (const x of sess) {
      const a = new Date(x.started_at).getTime(), b = new Date(x.ended_at).getTime();
      const share = readings.length ? solarShareOf(readings.filter((r) => r.ts >= a - 900_000 && r.ts <= b)) ?? 0 : 0;
      const k = Number(x.energy_wh) / 1000;
      kwh += k; solarKwh += k * share;
      emitted += emittedKg(k, share, await recOf(site.id, monthOfZone(new Date(x.started_at))), g.kgPerKwh);
    }
    out.push({
      siteId: site.id, site: site.name, sessions: sess.length, kwh: r3(kwh), gridKgPerKwh: g.kgPerKwh, gridFactorSource: g.source,
      solarSharePct: kwh ? Math.round((solarKwh / kwh) * 1000) / 10 : null, emittedKg: Math.round(emitted * 10) / 10,
      avoidedKg: Math.round((kwh * s.iceKgPerKwh - emitted) * 10) / 10,
    });
  }
  const tot = out.reduce((a, x) => ({ kwh: a.kwh + x.kwh, emitted: a.emitted + x.emittedKg, avoided: a.avoided + x.avoidedKg, sessions: a.sessions + x.sessions }), { kwh: 0, emitted: 0, avoided: 0, sessions: 0 });
  return { from, to, settings: s, sites: out, totals: { sessions: tot.sessions, kwh: r3(tot.kwh), emittedTonnes: r3(tot.emitted / 1000), avoidedTonnes: r3(tot.avoided / 1000) } };
}

/** The ESG report in Excel: summary, per site, and how it was worked out. */
export async function esgWorkbook(orgId: string, from: unknown, to: unknown): Promise<Buffer> {
  const r = await siteReport(orgId, from, to);
  const prov = Object.entries(r.settings.provinceKgPerKwh);
  return xlsx([
    { name: 'Summary', rows: [['Charging emissions report', `${r.from} to ${r.to}`], [], ['Sessions', r.totals.sessions], ['Energy (kWh)', r.totals.kwh],
      ['Emitted (t CO2e)', r.totals.emittedTonnes], ['Avoided against petrol (t CO2e)', r.totals.avoidedTonnes]] },
    { name: 'Sites', rows: [['Site', 'Sessions', 'kWh', 'Grid factor (kg/kWh)', 'Factor from', 'Solar share %', 'Emitted (kg CO2e)', 'Avoided (kg CO2e)'],
      ...r.sites.map((x) => [x.site, x.sessions, x.kwh, x.gridKgPerKwh, x.gridFactorSource, x.solarSharePct, x.emittedKg, x.avoidedKg])] },
    { name: 'Methodology', rows: [
      ['Emitted', 'kWh × (1 − solar share) × (1 − REC share) × grid factor'],
      ['Avoided', 'kWh × petrol figure − emitted'],
      ['Petrol figure (kg CO2 per kWh charged)', r.settings.iceKgPerKwh],
      ['Default grid factor (kg CO2e per kWh)', r.settings.gridKgPerKwh],
      ['Grid factor', 'The site’s own if set; else its province’s (BPS code = the first two digits of the site’s kabupaten/kota code); else the default'],
      ...prov.map(([k, v]) => [`Province ${k}`, v]),
      ['Solar share', 'Measured from the site’s energy readings during each session: solar used on site over the site’s supply; battery output counted as grid'],
      ['REC share', 'Renewable energy certificates retired for the site’s month (the portfolio’s shared by energy)'],
      ['Sessions', 'Ended sessions with energy, by start time'],
    ] },
  ]);
}
