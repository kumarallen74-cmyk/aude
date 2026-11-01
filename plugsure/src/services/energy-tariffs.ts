import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { LEGACY_CURRENCY } from '../domain/money.js';

/**
 * Electricity tariffs and margin simulation (v1.27.0). Per site:
 *
 *   tariff       the site's supply: the tariff class, connected power (kVA), the peak (WBP) and off-peak (LWBP)
 *                rate per kWh, the peak hours (PLN: 17:00–22:00), a fixed monthly charge
 *   load         when the site's cars charge: each session's energy spread over the hours it ran (billing zone),
 *                over the last months; the peak share is what falls in the peak hours
 *   simulation   for the site's own tariff and each class in the catalogue: the energy cost per month and per kWh,
 *                the margin against the revenue per kWh drivers paid, and the price per kWh (before tax) that
 *                reaches a target margin; and what moving part of the peak load off-peak would save
 *
 * The catalogue's rates are indicative (PLN's published tariffs as of 2026, rupiah per kWh) for comparison only:
 * the operator's own bills and PLN's current tariff decide. Losses: when bills with kWh are recorded, the cost is
 * grossed up by the bills' kWh over the kWh delivered (station consumption, charger losses).
 */

export class TariffError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface TariffClass { id: string; label: string; minKva: number; maxKva: number | null; ratePeak: number; rateOffpeak: number; fixedPerKva: number; note: string }

/** Indicative PLN classes for public charging and business supply (rupiah per kWh; WBP = K × LWBP for B-3/I-3, K = 1.4). */
export const CATALOGUE: TariffClass[] = [
  { id: 'SPKLU', label: 'Layanan khusus SPKLU (curah)', minKva: 6.6, maxKva: null, ratePeak: 714, rateOffpeak: 714, fixedPerKva: 0, note: 'Bulk tariff for public charging stations; flat all day.' },
  { id: 'B-2', label: 'B-2 Bisnis menengah (6.6–200 kVA)', minKva: 6.6, maxKva: 200, ratePeak: 1444.7, rateOffpeak: 1444.7, fixedPerKva: 0, note: 'Flat rate, low voltage.' },
  { id: 'B-3', label: 'B-3 Bisnis besar (> 200 kVA, TM)', minKva: 200, maxKva: null, ratePeak: 1450.09, rateOffpeak: 1035.78, fixedPerKva: 0, note: 'Medium voltage; peak 17:00–22:00 at K × LWBP.' },
  { id: 'I-3', label: 'I-3 Industri (> 200 kVA, TM)', minKva: 200, maxKva: null, ratePeak: 1560.64, rateOffpeak: 1114.74, fixedPerKva: 0, note: 'Medium voltage; peak 17:00–22:00 at K × LWBP.' },
  { id: 'LK', label: 'Layanan khusus', minKva: 0, maxKva: null, ratePeak: 1644.52, rateOffpeak: 1644.52, fixedPerKva: 0, note: 'Flat rate.' },
];

const viewOf = (t: any) => t && ({
  tariffClass: t.tariff_class, powerKva: Number(t.power_kva), ratePeak: Number(t.rate_peak), rateOffpeak: Number(t.rate_offpeak),
  peakFrom: t.peak_from, peakTo: t.peak_to, fixedMonthly: Number(t.capacity_charge_minor), currency: t.currency, updatedAt: t.updated_at ? new Date(t.updated_at).toISOString() : null,
});

export async function list(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT s.id, s.name, co.currency, t.* FROM site s JOIN country co ON co.code = s.country_code LEFT JOIN site_tariff t ON t.site_id = s.id
      WHERE s.org_id = $1 AND s.archived_at IS NULL ORDER BY s.name`, [orgId]));
  return { sites: rows.map((r) => ({ siteId: r.id, site: r.name, currency: r.currency, tariff: r.tariff_class ? viewOf(r) : null })), catalogue: CATALOGUE };
}

export async function save(orgId: string, siteId: string, b: Record<string, unknown>, userId: string | null) {
  if (!UUID_RE.test(siteId)) throw new TariffError(404, 'No such site.');
  const site = await outsideRequestScope(() => one<{ currency: string }>(`SELECT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2`, [siteId, orgId]));
  if (!site) throw new TariffError(404, 'No such site.');
  const cls = String(b.tariffClass ?? '').trim();
  if (!cls || cls.length > 40) throw new TariffError(422, 'The tariff class is required (e.g. B-2, B-3, SPKLU).');
  const preset = CATALOGUE.find((c) => c.id === cls);
  const kva = Number(b.powerKva);
  if (!Number.isFinite(kva) || kva <= 0 || kva > 100_000) throw new TariffError(422, 'The connected power is in kVA, above 0.');
  const peak = b.ratePeak === undefined || b.ratePeak === '' ? preset?.ratePeak : Number(b.ratePeak);
  const off = b.rateOffpeak === undefined || b.rateOffpeak === '' ? preset?.rateOffpeak : Number(b.rateOffpeak);
  if (peak == null || off == null || !Number.isFinite(peak) || !Number.isFinite(off) || peak < 0 || off < 0) throw new TariffError(422, 'The peak and off-peak rates per kWh are 0 or more.');
  const from = b.peakFrom === undefined ? 17 : Number(b.peakFrom), to = b.peakTo === undefined ? 22 : Number(b.peakTo);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 23 || to < 1 || to > 24 || from >= to) throw new TariffError(422, 'Peak hours are whole hours, from 0–23 to 1–24.');
  const fixed = b.fixedMonthly === undefined || b.fixedMonthly === '' ? 0 : Number(b.fixedMonthly);
  if (!Number.isInteger(fixed) || fixed < 0) throw new TariffError(422, 'The fixed monthly charge is a whole amount, 0 or more.');
  await outsideRequestScope(() => query(
    `INSERT INTO site_tariff (site_id, org_id, tariff_class, power_kva, rate_peak, rate_offpeak, peak_from, peak_to, capacity_charge_minor, currency, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (site_id) DO UPDATE SET tariff_class = EXCLUDED.tariff_class, power_kva = EXCLUDED.power_kva, rate_peak = EXCLUDED.rate_peak, rate_offpeak = EXCLUDED.rate_offpeak,
       peak_from = EXCLUDED.peak_from, peak_to = EXCLUDED.peak_to, capacity_charge_minor = EXCLUDED.capacity_charge_minor, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [siteId, orgId, cls, kva, peak, off, from, to, fixed, site.currency, userId]));
  return viewOf(await outsideRequestScope(() => one<any>(`SELECT * FROM site_tariff WHERE site_id = $1`, [siteId])));
}

/** The site's load by hour of day (kWh), the sessions' energy spread evenly over the hours each ran. */
export async function loadProfile(orgId: string, siteId: string, months: number) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT cs.started_at, cs.ended_at, cs.energy_wh, d.subtotal_minor, d.currency FROM charging_session cs JOIN cdr d ON d.session_id = cs.id
      WHERE cs.org_id = $1 AND cs.site_id = $2 AND NOT COALESCE(d.test_mode, false) AND cs.energy_wh > 0 AND cs.started_at IS NOT NULL
        AND d.issued_at >= now() - make_interval(months => $3)`, [orgId, siteId, months]));
  const hours = new Array<number>(24).fill(0);
  const hourOf = (t: number) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone(), hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
  let wh = 0, revenue = 0;
  const currency = rows[0]?.currency ?? LEGACY_CURRENCY;
  for (const r of rows) {
    const e = Number(r.energy_wh);
    wh += e; revenue += Number(r.subtotal_minor);
    const a = new Date(r.started_at).getTime(), b = r.ended_at ? new Date(r.ended_at).getTime() : a + 3_600_000;
    const span = Math.max(b - a, 60_000);
    // Walk the session in steps of up to an hour, giving each hour its share.
    let t = a;
    while (t < a + span) {
      const next = Math.min(a + span, (Math.floor(t / 3_600_000) + 1) * 3_600_000);
      hours[hourOf(t)]! += e * ((next - t) / span) / 1000;
      t = next;
    }
  }
  return { kwh: wh / 1000, revenue, currency, sessions: rows.length, hours: hours.map(r2), months };
}

async function lossFactor(orgId: string, siteId: string): Promise<number> {
  // Bills with kWh against the kWh delivered in the same months (1 = no losses known).
  const r = await outsideRequestScope(() => one<{ billed: string | null; delivered: string | null }>(
    `WITH b AS (SELECT month, sum(kwh_billed) AS kwh FROM site_energy_cost WHERE org_id = $1 AND site_id = $2 AND voided_at IS NULL AND kwh_billed > 0 GROUP BY month)
     SELECT sum(b.kwh) AS billed, (SELECT sum(cs.energy_wh) / 1000.0 FROM charging_session cs JOIN cdr d ON d.session_id = cs.id
                                   WHERE cs.site_id = $2 AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') IN (SELECT month FROM b)) AS delivered FROM b`, [orgId, siteId, zone()]));
  const billed = Number(r?.billed ?? 0), delivered = Number(r?.delivered ?? 0);
  if (!billed || !delivered) return 1;
  return Math.min(1.5, Math.max(1, billed / delivered));
}

/** Compare tariffs for a site, and the price per kWh that reaches a target margin. */
export async function simulate(orgId: string, siteId: string, q: { months?: unknown; targetMarginPct?: unknown; shiftPct?: unknown } = {}) {
  if (!UUID_RE.test(siteId)) throw new TariffError(404, 'No such site.');
  const site = await outsideRequestScope(() => one<any>(`SELECT s.id, s.name, t.* FROM site s LEFT JOIN site_tariff t ON t.site_id = s.id WHERE s.id = $1 AND s.org_id = $2`, [siteId, orgId]));
  if (!site) throw new TariffError(404, 'No such site.');
  const months = Math.min(12, Math.max(1, Number(q.months ?? 3) || 3));
  const target = q.targetMarginPct === undefined || q.targetMarginPct === '' ? 30 : Number(q.targetMarginPct);
  if (!Number.isFinite(target) || target < 0 || target >= 95) throw new TariffError(422, 'The target margin is 0 to 95 (%).');
  const shift = q.shiftPct === undefined || q.shiftPct === '' ? 20 : Number(q.shiftPct);
  if (!Number.isFinite(shift) || shift < 0 || shift > 100) throw new TariffError(422, 'The shift is 0 to 100 (% of the peak load).');
  const load = await loadProfile(orgId, siteId, months);
  const loss = await lossFactor(orgId, siteId);
  const own = site.tariff_class ? viewOf(site) : null;
  const from = own?.peakFrom ?? 17, to = own?.peakTo ?? 22;
  const peakKwh = load.hours.slice(from, to).reduce((a, x) => a + x, 0);
  const peakShare = load.kwh ? peakKwh / load.kwh : 0;
  const perMonth = load.kwh / months;
  const revenuePerKwh = load.kwh ? load.revenue / load.kwh : 0;
  const option = (id: string, label: string, ratePeak: number, rateOff: number, fixedMonthly: number, share = peakShare) => {
    const energyPerKwh = (share * ratePeak + (1 - share) * rateOff) * loss;
    const monthly = perMonth * energyPerKwh + fixedMonthly;
    const costPerKwh = perMonth ? monthly / perMonth : energyPerKwh;
    const marginPct = revenuePerKwh ? r2(((revenuePerKwh - costPerKwh) / revenuePerKwh) * 100) : null;
    return {
      id, label, ratePeak, rateOffpeak: rateOff, monthlyCost: Math.round(monthly), costPerKwh: r2(costPerKwh), marginPerKwh: r2(revenuePerKwh - costPerKwh), marginPct,
      priceForTarget: r2(costPerKwh / (1 - target / 100)),
    };
  };
  const options = [
    ...(own ? [{ ...option('current', `Current: ${own.tariffClass}`, own.ratePeak, own.rateOffpeak, own.fixedMonthly), current: true }] : []),
    ...CATALOGUE.filter((c) => !own || c.id !== own.tariffClass).filter((c) => !own || (own.powerKva >= c.minKva && (c.maxKva == null || own.powerKva <= c.maxKva)))
      .map((c) => ({ ...option(c.id, c.label, c.ratePeak, c.rateOffpeak, own ? Math.round(c.fixedPerKva * own.powerKva) : 0), current: false, note: c.note })),
  ].sort((a, b) => a.monthlyCost - b.monthlyCost);
  const base = options.find((o) => o.current) ?? options[0];
  const shifted = own && own.ratePeak !== own.rateOffpeak
    ? (() => { const o = option('shift', `Move ${shift}% of the peak load off-peak`, own.ratePeak, own.rateOffpeak, own.fixedMonthly, peakShare * (1 - shift / 100)); return { ...o, savingPerMonth: base ? base.monthlyCost - o.monthlyCost : 0 }; })()
    : null;
  return {
    site: { id: site.id, name: site.name }, months, currency: load.currency, tariff: own,
    load: { kwh: r2(load.kwh), kwhPerMonth: r2(perMonth), sessions: load.sessions, hours: load.hours, peakFrom: from, peakTo: to, peakSharePct: r2(peakShare * 100), lossFactor: r2(loss) },
    revenuePerKwh: r2(revenuePerKwh), targetMarginPct: target, options, cheapest: options[0]?.id ?? null,
    savingVsCurrent: own && options[0] && !options[0].current ? (base!.monthlyCost - options[0].monthlyCost) : 0,
    shift: shifted,
    recommendation: base ? (revenuePerKwh && base.marginPct != null && base.marginPct < target
      ? `At ${base.label}, a price of ${base.priceForTarget} per kWh before tax (now ${r2(revenuePerKwh)}) reaches a ${target}% margin.`
      : `The margin on energy is ${base.marginPct ?? '—'}%: at or above the ${target}% target.`) : null,
  };
}
