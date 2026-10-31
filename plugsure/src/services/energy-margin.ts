import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';

/**
 * Energy cost and margin (v1.20.0), per site and month:
 *
 *   revenue     what drivers paid, before tax (the charge records' subtotal; test sessions left out)
 *   kWh         energy delivered to cars (the sessions' energy)
 *   energy cost the month's electricity bill for the site when recorded (Finance → Energy), else the site's cost per
 *               kWh × the kWh delivered (an estimate), else unknown. A bill's kWh beside the kWh delivered shows the
 *               losses and the site's own use.
 *   margin      revenue − energy cost (gross margin on energy; gateway fees and owner shares are in Budgets)
 *
 * The bill is allocated to the site's chargers by the kWh each delivered, for the margin per charger.
 */

export class EnergyError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b ? r2((a / b) * 100) : null);

export function lastMonths(n: number, from = new Date()): string[] {
  const cur = new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(from).slice(0, 7);
  let [y, m] = cur.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < n; i++) { out.push(`${y}-${String(m).padStart(2, '0')}`); m--; if (m === 0) { m = 12; y--; } }
  return out;
}

/** Revenue and kWh per site (and charger) for a set of months, from the charge records. */
async function delivered(orgId: string, months: string[], siteId?: string) {
  return outsideRequestScope(() => many<any>(
    `SELECT to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') AS month, cs.site_id, cs.charge_point_id, cp.ocpp_identity, cp.display_name, d.currency,
            count(*)::int AS sessions, COALESCE(sum(cs.energy_wh), 0)::bigint AS wh, COALESCE(sum(d.subtotal_minor), 0)::bigint AS revenue
       FROM cdr d JOIN charging_session cs ON cs.id = d.session_id LEFT JOIN charge_point cp ON cp.id = cs.charge_point_id
      WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') = ANY($2::text[])
        AND ($4::uuid IS NULL OR cs.site_id = $4::uuid) AND cs.site_id IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5, 6`, [orgId, months, zone(), siteId ?? null]));
}

async function sitesOf(orgId: string) {
  return outsideRequestScope(() => many<any>(
    `SELECT s.id, s.name, co.currency, r.rate_per_kwh FROM site s JOIN country co ON co.code = s.country_code LEFT JOIN site_energy_rate r ON r.site_id = s.id
      WHERE s.org_id = $1 AND s.archived_at IS NULL ORDER BY s.name`, [orgId]));
}

async function bills(orgId: string, months: string[]) {
  return outsideRequestScope(() => many<any>(
    `SELECT b.*, u.name AS recorded_by_name FROM site_energy_cost b LEFT JOIN app_user u ON u.id = b.recorded_by
      WHERE b.org_id = $1 AND b.voided_at IS NULL AND b.month = ANY($2::text[])`, [orgId, months]));
}

/** One month: every site with its revenue, kWh, energy cost (bill / estimate / unknown), margin; totals per currency. */
export async function month(orgId: string, monthRaw: unknown, siteId?: string) {
  const m = String(monthRaw ?? lastMonths(1)[0]);
  if (!MONTH_RE.test(m)) throw new EnergyError(400, 'month is YYYY-MM.');
  const [sites, rows, bs] = await Promise.all([sitesOf(orgId), delivered(orgId, [m], siteId), bills(orgId, [m])]);
  const out = sites.filter((s) => !siteId || s.id === siteId).map((s) => {
    const mine = rows.filter((r) => r.site_id === s.id);
    const wh = mine.reduce((a, r) => a + Number(r.wh), 0), revenue = mine.reduce((a, r) => a + Number(r.revenue), 0);
    const kwh = wh / 1000;
    const bill = bs.find((b) => b.site_id === s.id);
    const rate = s.rate_per_kwh != null ? Number(s.rate_per_kwh) : null;
    const cost = bill ? Number(bill.amount_minor) : rate != null ? Math.round(rate * kwh) : null;
    const source = bill ? 'bill' : rate != null ? 'estimate' : 'unknown';
    const billedKwh = bill?.kwh_billed != null ? Number(bill.kwh_billed) : null;
    const chargers = mine.sort((a, b) => Number(b.wh) - Number(a.wh)).map((r) => {
      const share = wh ? Number(r.wh) / wh : 0;
      const c = cost == null ? null : Math.round(cost * share);
      return { chargePointId: r.charge_point_id, identity: r.ocpp_identity, name: r.display_name, sessions: r.sessions, kwh: r2(Number(r.wh) / 1000), revenue: Number(r.revenue),
        energyCost: c, margin: c == null ? null : Number(r.revenue) - c, marginPct: c == null ? null : pct(Number(r.revenue) - c, Number(r.revenue)) };
    });
    return {
      siteId: s.id, site: s.name, currency: s.currency, sessions: mine.reduce((a, r) => a + r.sessions, 0), kwh: r2(kwh), revenue,
      energyCost: cost, source, ratePerKwh: rate, costPerKwh: cost != null && kwh ? r2(cost / kwh) : null,
      bill: bill ? { id: String(bill.id), amount: Number(bill.amount_minor), kwhBilled: billedKwh, reference: bill.reference, note: bill.note, recordedBy: bill.recorded_by_name ?? null, recordedAt: new Date(bill.created_at).toISOString() } : null,
      lossPct: billedKwh && kwh ? r2(((billedKwh - kwh) / billedKwh) * 100) : null,
      margin: cost == null ? null : revenue - cost, marginPct: cost == null ? null : pct(revenue - cost, revenue),
      chargers,
    };
  });
  const totals: Record<string, { revenue: number; energyCost: number; margin: number; kwh: number; unknownSites: number }> = {};
  for (const s of out) {
    const t = totals[s.currency] ?? { revenue: 0, energyCost: 0, margin: 0, kwh: 0, unknownSites: 0 };
    t.revenue += s.revenue; t.kwh = r2(t.kwh + s.kwh);
    if (s.energyCost == null) { if (s.kwh > 0) t.unknownSites++; } else { t.energyCost += s.energyCost; t.margin += s.revenue - s.energyCost; }
    totals[s.currency] = t;
  }
  return { month: m, sites: out, totals };
}

/** The last n months for the organisation (or one site): revenue, kWh, energy cost, margin per month and currency. */
export async function trend(orgId: string, nRaw: unknown, siteId?: string) {
  const n = Math.min(24, Math.max(1, Number(nRaw ?? 12) || 12));
  const months = lastMonths(n);
  const [sites, rows, bs] = await Promise.all([sitesOf(orgId), delivered(orgId, months, siteId), bills(orgId, months)]);
  const out: Array<{ month: string; currency: string; kwh: number; revenue: number; energyCost: number; estimated: boolean; margin: number }> = [];
  for (const m of months) {
    const by = new Map<string, { kwh: number; revenue: number; energyCost: number; estimated: boolean }>();
    for (const s of sites.filter((x) => !siteId || x.id === siteId)) {
      const mine = rows.filter((r) => r.site_id === s.id && r.month === m);
      const kwh = mine.reduce((a, r) => a + Number(r.wh), 0) / 1000, revenue = mine.reduce((a, r) => a + Number(r.revenue), 0);
      const bill = bs.find((b) => b.site_id === s.id && b.month === m);
      const est = !bill && s.rate_per_kwh != null && kwh > 0;
      const cost = bill ? Number(bill.amount_minor) : est ? Math.round(Number(s.rate_per_kwh) * kwh) : 0;
      const t = by.get(s.currency) ?? { kwh: 0, revenue: 0, energyCost: 0, estimated: false };
      t.kwh += kwh; t.revenue += revenue; t.energyCost += cost; t.estimated ||= est;
      by.set(s.currency, t);
    }
    for (const [currency, t] of by) out.push({ month: m, currency, kwh: r2(t.kwh), revenue: t.revenue, energyCost: t.energyCost, estimated: t.estimated, margin: t.revenue - t.energyCost });
  }
  return { months: out };
}

const siteOf = async (orgId: string, siteId: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw new EnergyError(404, 'No such site.');
  const s = await outsideRequestScope(() => one<{ id: string; currency: string }>(
    `SELECT s.id, co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2`, [siteId, orgId]));
  if (!s) throw new EnergyError(404, 'No such site.');
  return s;
};

export async function setRate(orgId: string, siteId: string, rateRaw: unknown, userId: string | null) {
  const s = await siteOf(orgId, siteId);
  if (rateRaw == null || rateRaw === '') throw new EnergyError(422, 'Enter the cost per kWh (0 or more).');
  const rate = Number(rateRaw);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100_000) throw new EnergyError(422, 'The cost per kWh is a number from 0 to 100,000.');
  await outsideRequestScope(() => query(
    `INSERT INTO site_energy_rate (site_id, org_id, rate_per_kwh, currency, updated_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id) DO UPDATE SET rate_per_kwh = EXCLUDED.rate_per_kwh, currency = EXCLUDED.currency, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [siteId, orgId, rate, s.currency, userId]));
  return { siteId, ratePerKwh: rate, currency: s.currency };
}

export async function recordBill(orgId: string, siteId: string, b: Record<string, unknown>, userId: string | null) {
  const s = await siteOf(orgId, siteId);
  const m = String(b.month ?? '');
  if (!MONTH_RE.test(m)) throw new EnergyError(422, 'month is YYYY-MM.');
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount < 0) throw new EnergyError(422, 'The amount is a whole number, 0 or more (the bill\'s total, taxes included).');
  const kwh = b.kwhBilled == null || b.kwhBilled === '' ? null : Number(b.kwhBilled);
  if (kwh != null && (!Number.isFinite(kwh) || kwh < 0)) throw new EnergyError(422, 'The kWh billed is a number, 0 or more.');
  try {
    const r = await outsideRequestScope(() => one<{ id: string }>(
      `INSERT INTO site_energy_cost (org_id, site_id, month, amount_minor, kwh_billed, currency, reference, note, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [orgId, siteId, m, amount, kwh, s.currency, b.reference == null ? null : String(b.reference).slice(0, 80), b.note == null ? null : String(b.note).slice(0, 300), userId]));
    return { id: String(r!.id) };
  } catch (e) {
    if ((e as any).code === '23505') throw new EnergyError(409, `A bill for ${m} is already recorded for this site: void it first to replace it.`);
    throw e;
  }
}

export async function voidBill(orgId: string, id: string, reasonRaw: unknown, userId: string | null) {
  if (!/^\d{1,18}$/.test(id)) throw new EnergyError(404, 'No such bill.');
  const reason = String(reasonRaw ?? '').trim();
  if (!reason || reason.length > 300) throw new EnergyError(422, 'Say why the bill is voided (up to 300 characters).');
  const r = await outsideRequestScope(() => one(`UPDATE site_energy_cost SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2 AND voided_at IS NULL RETURNING id`, [id, orgId, userId, reason]));
  if (!r) throw new EnergyError(404, 'No such bill, or already voided.');
  return { ok: true };
}
