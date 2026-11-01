import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import type { Tariff } from './tariff.js';
import { profileFor } from './regulatory/index.js';

/**
 * Dynamic pricing (v1.43.0): prices that move with the time of day, the grid's peak hours, how busy a site is, or how
 * much solar it is producing — inside a band the operator sets (by default 80 % to 130 % of the tariff) and never past
 * the regulated energy ceiling (an increase is held at it: scaleTariff).
 *
 * How a price is fixed, and why:
 *   - each site's factor NOW is kept in site_price_now (refreshed every minute by the worker, and on demand). It is
 *     what the driver app shows before a charge starts;
 *   - a session takes the factor in force when it starts (charging_session.dynamic_price_bps) and keeps it to the end:
 *     a price never changes under a driver mid-charge;
 *   - a pre-purchase takes the factor when the driver pays, kept on the payment intent; its session uses that one, so
 *     the energy bought is the energy billed;
 *   - roaming partners' sessions are not scaled: they are priced on the tariffs published to the partner (OCPI).
 *
 * Only energy is scaled (and the per-minute time fee, unless switched off). Session and admin fees, idle fees and an
 * energy band at the PLN formula rate are never scaled.
 *
 * Rules (dynamic_price_rule), each for one site or every site, adding up:
 *   time        on these days, between these hours (the site's own time zone)
 *   peak        during the grid's peak hours of the site's energy tariff (Finance → Energy tariffs; 17:00–22:00 by
 *               default)
 *   occupancy   when at least this % of the site's connectors are in use
 *   solar       when the site's solar is producing at least this many kW (a fresh reading, Assets → Solar & battery)
 * factor = 100 % + the sum of the matching rules' adjustments, then held inside [floor, cap].
 */

export class PricingError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const KINDS = ['time', 'peak', 'occupancy', 'solar'] as const;
export type RuleKind = (typeof KINDS)[number];
export interface Rule {
  id: string; siteId: string | null; name: string; kind: RuleKind; dayMask: number; hourFrom: number | null; hourTo: number | null;
  threshold: number | null; adjustPct: number; enabled: boolean; sortOrder: number;
}
export interface Settings { enabled: boolean; floorPct: number; capPct: number; includeTime: boolean }
export interface Conditions { dow: number; hour: number; peak: boolean; occupancyPct: number | null; solarKw: number | null }
export interface Factor { bps: number; applied: Array<{ id: string; name: string; adjustPct: number }>; reason: string }

const FRESH_MS = 2 * 60_000;
const DEFAULTS: Settings = { enabled: false, floorPct: 80, capPct: 130, includeTime: true };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ruleOf = (r: any): Rule => ({
  id: String(r.id), siteId: r.site_id ?? null, name: r.name, kind: r.kind, dayMask: Number(r.day_mask), hourFrom: r.hour_from ?? null,
  hourTo: r.hour_to ?? null, threshold: r.threshold == null ? null : Number(r.threshold), adjustPct: Number(r.adjust_pct), enabled: r.enabled, sortOrder: Number(r.sort_order),
});

// ------------------------------------------------------------------ pure

/** Day of week (0 = Monday) and hour in a time zone. */
export function localParts(t: Date, tz: string): { dow: number; hour: number } {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(t);
  const wd = p.find((x) => x.type === 'weekday')!.value;
  return { dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd), hour: Number(p.find((x) => x.type === 'hour')!.value) };
}
const inHours = (h: number, from: number, to: number) => (from < to ? h >= from && h < to : h >= from || h < to);

/** Does a rule match these conditions? (A condition not known — no reading, no connectors — never matches.) */
export function matches(r: Rule, c: Conditions): boolean {
  if (!r.enabled || !(r.dayMask & (1 << c.dow))) return false;
  switch (r.kind) {
    case 'time': return r.hourFrom != null && r.hourTo != null && inHours(c.hour, r.hourFrom, r.hourTo);
    case 'peak': return c.peak;
    case 'occupancy': return c.occupancyPct != null && r.threshold != null && c.occupancyPct >= r.threshold;
    case 'solar': return c.solarKw != null && r.threshold != null && c.solarKw >= r.threshold;
  }
}

/** The factor from the matching rules, inside the band. */
export function factorOf(rules: Rule[], c: Conditions, s: Pick<Settings, 'floorPct' | 'capPct'>): Factor {
  const applied = rules.filter((r) => matches(r, c)).map((r) => ({ id: r.id, name: r.name, adjustPct: r.adjustPct }));
  const raw = 100 + applied.reduce((a, r) => a + r.adjustPct, 0);
  const pct = Math.min(s.capPct, Math.max(s.floorPct, raw));
  const held = pct !== raw ? ` (held at the ${pct === s.capPct ? 'cap' : 'floor'} of ${pct}%)` : '';
  return { bps: Math.round(pct * 100), applied, reason: applied.length ? `${applied.map((a) => `${a.name} ${a.adjustPct > 0 ? '+' : ''}${a.adjustPct}%`).join(', ')}${held}` : 'standard price' };
}

/**
 * The tariff with its energy (and per-minute time) rates scaled by the factor. A rate at the PLN formula, session,
 * admin and idle fees are untouched. 10000 bps (or none) returns the tariff as it is.
 */
export function scaleTariff(t: Tariff, bps: number | null | undefined, includeTime = true): Tariff {
  if (!bps || bps === 10_000) return t;
  const f = bps / 10_000;
  // The regulated energy ceiling (Indonesia: the PLN formula's maximum) is only CHECKED when a session is rated — a
  // session above it is flagged for review, not lowered. So an increase is held at the ceiling here: dynamic pricing
  // never takes a rate past it (a rate the tariff itself already has above it is left as it is, never raised).
  const ceiling = profileFor(t.countryCode ?? 'ID').energyCeiling(t);
  return {
    ...t,
    components: t.components.map((c) => {
      if (c.kind === 'energy' && !c.formulaRate && c.rate != null) {
        let rate = Math.round(c.rate * f * 100) / 100;
        if (f > 1 && ceiling != null) rate = Math.min(rate, Math.max(c.rate, ceiling));
        return { ...c, rate };
      }
      return includeTime && c.kind === 'time' ? { ...c, rate: Math.round(c.rate * f * 100) / 100 } : c;
    }),
  };
}

// ------------------------------------------------------------------ settings and rules

export async function settings(orgId: string): Promise<Settings> {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM dynamic_price_settings WHERE org_id = $1`, [orgId]));
  return r ? { enabled: r.enabled, floorPct: Number(r.floor_pct), capPct: Number(r.cap_pct), includeTime: r.include_time } : { ...DEFAULTS };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<Settings> {
  const cur = await settings(orgId);
  const int = (k: keyof Settings, min: number, max: number) => {
    if (b[k] === undefined) return cur[k] as number;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw new PricingError(422, `${k} is a whole number from ${min} to ${max}.`);
    return n;
  };
  const floorPct = int('floorPct', 50, 100), capPct = int('capPct', 100, 200);
  const enabled = b.enabled === undefined ? cur.enabled : b.enabled === true;
  const includeTime = b.includeTime === undefined ? cur.includeTime : b.includeTime === true;
  await outsideRequestScope(() => query(
    `INSERT INTO dynamic_price_settings (org_id, enabled, floor_pct, cap_pct, include_time, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, floor_pct = EXCLUDED.floor_pct, cap_pct = EXCLUDED.cap_pct,
       include_time = EXCLUDED.include_time, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, enabled, floorPct, capPct, includeTime, userId]));
  await refreshOrg(orgId).catch((e) => logger.warn({ orgId, err: (e as Error).message }, 'dynamic price refresh failed'));
  return settings(orgId);
}

export async function rules(orgId: string): Promise<Rule[]> {
  const rows = await outsideRequestScope(() => many<any>(`SELECT * FROM dynamic_price_rule WHERE org_id = $1 AND archived_at IS NULL ORDER BY sort_order, id`, [orgId]));
  return rows.map(ruleOf);
}

export async function saveRule(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null): Promise<Rule | { id: string; archived: true }> {
  const cur = id ? await outsideRequestScope(() => one<any>(`SELECT * FROM dynamic_price_rule WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new PricingError(404, 'No such rule.');
  if (cur && b.archive === true) {
    await outsideRequestScope(() => query(`UPDATE dynamic_price_rule SET archived_at = now() WHERE id = $1`, [cur.id]));
    await refreshOrg(orgId).catch(() => {});
    return { id: String(cur.id), archived: true };
  }
  const c = cur ? ruleOf(cur) : null;
  const pick = <T>(k: string, d: T): T => (b[k] === undefined ? d : (b[k] as T));
  const name = String(pick('name', c?.name ?? '')).trim().slice(0, 120);
  if (name.length < 2) throw new PricingError(422, 'name is 2 to 120 characters.');
  const kind = String(pick('kind', c?.kind ?? '')) as RuleKind;
  if (!KINDS.includes(kind)) throw new PricingError(422, `kind is one of ${KINDS.join(', ')}.`);
  const siteRaw = pick<unknown>('siteId', c?.siteId ?? null);
  const siteId = siteRaw === null || siteRaw === '' ? null : String(siteRaw);
  if (siteId) {
    if (!UUID_RE.test(siteId)) throw new PricingError(422, 'siteId is a site id (or empty for every site).');
    const s = await outsideRequestScope(() => one(`SELECT 1 FROM site WHERE id = $1 AND org_id = $2`, [siteId, orgId]));
    if (!s) throw new PricingError(422, 'No such site.');
  }
  const dayMask = Number(pick('dayMask', c?.dayMask ?? 127));
  if (!Number.isInteger(dayMask) || dayMask < 1 || dayMask > 127) throw new PricingError(422, 'dayMask: at least one day (bit 0 = Monday … bit 6 = Sunday).');
  const adjustPct = Number(pick('adjustPct', c?.adjustPct ?? 0));
  if (!Number.isInteger(adjustPct) || adjustPct === 0 || adjustPct < -50 || adjustPct > 50) throw new PricingError(422, 'adjustPct is a whole number of percent from -50 to 50 (not 0).');
  let hourFrom: number | null = null, hourTo: number | null = null, threshold: number | null = null;
  if (kind === 'time') {
    hourFrom = Number(pick('hourFrom', c?.hourFrom ?? NaN)); hourTo = Number(pick('hourTo', c?.hourTo ?? NaN));
    if (!Number.isInteger(hourFrom) || hourFrom < 0 || hourFrom > 23 || !Number.isInteger(hourTo) || hourTo < 1 || hourTo > 24 || hourFrom === hourTo) {
      throw new PricingError(422, 'A time rule needs hourFrom (0–23) and hourTo (1–24), different (22 to 6 runs overnight).');
    }
  } else if (kind === 'occupancy') {
    threshold = Number(pick('threshold', c?.threshold ?? NaN));
    if (!(threshold > 0 && threshold <= 100)) throw new PricingError(422, 'An occupancy rule needs threshold: the % of connectors in use (1 to 100).');
  } else if (kind === 'solar') {
    threshold = Number(pick('threshold', c?.threshold ?? NaN));
    if (!(threshold > 0 && threshold <= 100_000)) throw new PricingError(422, 'A solar rule needs threshold: the solar output in kW.');
  }
  const enabled = pick('enabled', c?.enabled ?? true) === true;
  const sortOrder = Number(pick('sortOrder', c?.sortOrder ?? 0)) || 0;
  const vals = [orgId, siteId, name, kind, dayMask, hourFrom, hourTo, threshold, adjustPct, enabled, sortOrder];
  const r = cur
    ? await outsideRequestScope(() => one<any>(`UPDATE dynamic_price_rule SET site_id = $2, name = $3, kind = $4, day_mask = $5, hour_from = $6, hour_to = $7, threshold = $8,
        adjust_pct = $9, enabled = $10, sort_order = $11 WHERE id = $12 AND org_id = $1 RETURNING *`, [...vals, cur.id]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO dynamic_price_rule (org_id, site_id, name, kind, day_mask, hour_from, hour_to, threshold, adjust_pct, enabled, sort_order, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`, [...vals, userId]));
  await refreshOrg(orgId).catch(() => {});
  return ruleOf(r);
}

// ------------------------------------------------------------------ a site's conditions and factor

const BUSY = ['Charging', 'Preparing', 'SuspendedEV', 'SuspendedEVSE', 'Finishing', 'Occupied', 'Reserved'];

/** What the rules look at, for a site now. */
export async function conditionsFor(siteId: string, now = new Date()): Promise<{ orgId: string; tz: string; c: Conditions } | null> {
  const s = await outsideRequestScope(() => one<any>(
    `SELECT s.org_id, s.timezone, t.peak_from, t.peak_to,
            (SELECT count(*)::int FROM connector cn JOIN evse e ON e.id = cn.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id
              WHERE cp.site_id = s.id AND cp.decommissioned_at IS NULL) AS total,
            (SELECT count(*)::int FROM connector cn JOIN evse e ON e.id = cn.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id
              WHERE cp.site_id = s.id AND cp.decommissioned_at IS NULL AND cn.status = ANY($2::text[])) AS busy,
            (SELECT r.solar_w FROM site_energy_reading r WHERE r.site_id = s.id AND r.ts > $3::timestamptz - make_interval(secs => COALESCE(st.max_age_s, 120))
              ORDER BY r.ts DESC LIMIT 1) AS solar_w
       FROM site s LEFT JOIN site_tariff t ON t.site_id = s.id LEFT JOIN site_energy_settings st ON st.site_id = s.id
      WHERE s.id = $1`, [siteId, BUSY, now]));
  if (!s) return null;
  const tz: string = s.timezone; // site.timezone is NOT NULL
  const { dow, hour } = localParts(now, tz);
  const pf = s.peak_from ?? 17, pt = s.peak_to ?? 22;
  return {
    orgId: s.org_id, tz,
    c: { dow, hour, peak: inHours(hour, pf, pt), occupancyPct: s.total > 0 ? Math.round((s.busy / s.total) * 1000) / 10 : null, solarKw: s.solar_w == null ? null : Number(s.solar_w) / 1000 },
  };
}

/** Work out a site's factor now and keep it (site_price_now). Null when dynamic pricing is off for its organisation. */
export async function refreshSite(siteId: string, now = new Date()): Promise<(Factor & { validUntil: string }) | null> {
  const cond = await conditionsFor(siteId, now);
  if (!cond) return null;
  const st = await settings(cond.orgId);
  // Off: nothing is kept or changed (a kept factor is ignored while the organisation's dynamic pricing is off).
  if (!st.enabled) return null;
  const rs = (await rules(cond.orgId)).filter((r) => !r.siteId || r.siteId === siteId);
  const f = factorOf(rs, cond.c, st);
  const validUntil = new Date(now.getTime() + FRESH_MS).toISOString();
  await outsideRequestScope(() => query(
    `INSERT INTO site_price_now (site_id, org_id, factor_bps, rules, reason, computed_at, valid_until) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (site_id) DO UPDATE SET factor_bps = EXCLUDED.factor_bps, rules = EXCLUDED.rules, reason = EXCLUDED.reason, computed_at = EXCLUDED.computed_at, valid_until = EXCLUDED.valid_until`,
    [siteId, cond.orgId, f.bps, JSON.stringify(f.applied), f.reason, now, validUntil]));
  return { ...f, validUntil };
}

/**
 * The factor a session or a pre-purchase starting now at this site is fixed at: the kept one while fresh, else worked
 * out now. Null: dynamic pricing is off (the tariff applies as it is). Never throws: a failure means the tariff as is.
 */
export async function factorNow(siteId: string, now = new Date()): Promise<{ bps: number; reason: string; includeTime: boolean } | null> {
  try {
    const kept = await outsideRequestScope(() => one<any>(
      `SELECT p.factor_bps, p.reason, ds.include_time FROM site_price_now p JOIN dynamic_price_settings ds ON ds.org_id = p.org_id AND ds.enabled
        WHERE p.site_id = $1 AND p.valid_until > $2 AND p.computed_at <= $2`, [siteId, now]));
    if (kept) return { bps: Number(kept.factor_bps), reason: kept.reason ?? '', includeTime: kept.include_time };
    const f = await refreshSite(siteId, now);
    if (!f) return null;
    const st = await settings((await conditionsFor(siteId, now))!.orgId);
    return { bps: f.bps, reason: f.reason, includeTime: st.includeTime };
  } catch (e) {
    logger.warn({ siteId, err: (e as Error).message }, 'dynamic price unavailable — the tariff applies as it is');
    return null;
  }
}

/** Whether the per-minute time fee is scaled too, for this organisation (a session uses its organisation's setting). */
export async function includeTimeFor(orgId: string): Promise<boolean> {
  return (await settings(orgId).catch(() => DEFAULTS)).includeTime;
}

export async function refreshOrg(orgId: string, now = new Date()): Promise<number> {
  const sites = await outsideRequestScope(() => many<{ id: string }>(`SELECT id FROM site WHERE org_id = $1 AND archived_at IS NULL`, [orgId]));
  for (const s of sites) await refreshSite(s.id, now);
  return sites.length;
}

/** The worker (every minute): each site of each organisation with dynamic pricing on. */
export async function sweep(now = new Date()): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(`SELECT org_id FROM dynamic_price_settings WHERE enabled`));
  let n = 0;
  for (const o of orgs) n += await refreshOrg(o.org_id, now).catch((e) => { logger.warn({ orgId: o.org_id, err: (e as Error).message }, 'dynamic pricing sweep failed'); return 0; });
  return n;
}

// ------------------------------------------------------------------ the console

/** Every site's price now, the rules and the settings. */
export async function overview(orgId: string) {
  const st = await settings(orgId);
  const sites = await outsideRequestScope(() => many<any>(
    `SELECT s.id, s.name, p.factor_bps, p.reason, p.rules, p.computed_at FROM site s LEFT JOIN site_price_now p ON p.site_id = s.id
      WHERE s.org_id = $1 AND s.archived_at IS NULL ORDER BY s.name`, [orgId]));
  return {
    settings: st, rules: await rules(orgId),
    sites: sites.map((s) => ({ id: s.id, name: s.name, factorPct: s.factor_bps == null ? null : Number(s.factor_bps) / 100, reason: s.reason ?? null, rules: s.rules ?? [], computedAt: s.computed_at ? new Date(s.computed_at).toISOString() : null })),
  };
}

/**
 * What a site's rules would do: the factor hour by hour over the next 7 days from the time and peak rules (occupancy
 * and solar rules shown as "when …", since they depend on the moment), the factor now, a sample price per kWh at the
 * current factor (rated as a session would be, so a regulated ceiling shows), and an estimate of the last 30 days'
 * energy revenue under the time and peak rules.
 */
export async function preview(orgId: string, siteId: string, now = new Date()) {
  if (!UUID_RE.test(siteId)) throw new PricingError(404, 'No such site.');
  const site = await outsideRequestScope(() => one<any>(`SELECT id, name, timezone FROM site WHERE id = $1 AND org_id = $2`, [siteId, orgId]));
  if (!site) throw new PricingError(404, 'No such site.');
  const st = await settings(orgId);
  const rs = (await rules(orgId)).filter((r) => !r.siteId || r.siteId === siteId);
  const cond = (await conditionsFor(siteId, now))!;
  const tf = await outsideRequestScope(() => one<any>(`SELECT peak_from, peak_to FROM site_tariff WHERE site_id = $1`, [siteId]));
  const pf = tf?.peak_from ?? 17, pt = tf?.peak_to ?? 22;
  const scheduled = rs.filter((r) => r.kind === 'time' || r.kind === 'peak');
  const hours: Array<{ at: string; dow: number; hour: number; factorPct: number }> = [];
  const start = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  for (let i = 0; i < 24 * 7; i++) {
    const t = new Date(start.getTime() + i * 3_600_000);
    const { dow, hour } = localParts(t, cond.tz);
    const f = factorOf(scheduled, { dow, hour, peak: inHours(hour, pf, pt), occupancyPct: null, solarKw: null }, st);
    hours.push({ at: t.toISOString(), dow, hour, factorPct: f.bps / 100 });
  }
  const nowF = factorOf(rs, cond.c, st);
  // A sample: 10 kWh over 30 minutes, rated as a session would be, at the tariff and at the factor now.
  let sample: { baseMinorPerKwh: number; dynamicMinorPerKwh: number; heldByCeiling: boolean; currency: string } | null = null;
  const cn = await outsideRequestScope(() => one<any>(
    `SELECT cn.id, cn.max_power_w FROM connector cn JOIN evse e ON e.id = cn.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id
      WHERE cp.site_id = $1 AND cp.decommissioned_at IS NULL ORDER BY cn.max_power_w DESC LIMIT 1`, [siteId]));
  if (cn) {
    try {
      const { loadTariffForConnector } = await import('./tariff-store.js');
      const { rateSession } = await import('./tariff.js');
      const { tariff } = await loadTariffForConnector(cn.id, orgId, now);
      const ctx = { startedAt: now, endedAt: new Date(now.getTime() + 30 * 60_000), energyWh: 10_000, connectorMaxPowerW: Number(cn.max_power_w), localTaxRateBps: 0, idleMinutes: 0, timezone: cond.tz };
      const energyOf = (t: Tariff) => rateSession(t, ctx as any).lines.filter((l) => l.kind === 'energy' && !l.adjustment).reduce((a, l) => a + l.amountMinor, 0) / 10;
      const base = energyOf(tariff), dyn = energyOf(scaleTariff(tariff, nowF.bps, st.includeTime));
      sample = { baseMinorPerKwh: Math.round(base), dynamicMinorPerKwh: Math.round(dyn), heldByCeiling: nowF.bps > 10_000 && dyn < base * (nowF.bps / 10_000) - 1, currency: tariff.currency };
    } catch (e) {
      logger.warn({ siteId, err: (e as Error).message }, 'dynamic price sample failed');
    }
  }
  // The last 30 days: each session's energy at the tariff, re-weighted by the time/peak factor at its start.
  const sess = await outsideRequestScope(() => many<any>(
    `SELECT started_at, energy_wh FROM charging_session WHERE site_id = $1 AND started_at >= $2::timestamptz - interval '30 days' AND started_at < $2 AND energy_wh > 0`, [siteId, now]));
  let kwh = 0, weighted = 0;
  for (const s of sess) {
    const { dow, hour } = localParts(new Date(s.started_at), cond.tz);
    const f = factorOf(scheduled, { dow, hour, peak: inHours(hour, pf, pt), occupancyPct: null, solarKw: null }, st).bps / 10_000;
    const e = Number(s.energy_wh) / 1000;
    kwh += e; weighted += e * f;
  }
  const changePct = kwh > 0 ? Math.round(((weighted - kwh) / kwh) * 1000) / 10 : null;
  return {
    site: { id: site.id, name: site.name, timezone: cond.tz }, settings: st, now: { factorPct: nowF.bps / 100, reason: nowF.reason, conditions: cond.c },
    hours, conditional: rs.filter((r) => r.kind === 'occupancy' || r.kind === 'solar').map((r) => ({ name: r.name, kind: r.kind, threshold: r.threshold, adjustPct: r.adjustPct })),
    sample, last30Days: { sessions: sess.length, kwh: Math.round(kwh * 10) / 10, energyRevenueChangePct: changePct, note: 'time and peak-hour rules only; occupancy and solar rules depend on the moment' },
  };
}

/** Many sites' kept factors at once (the driver app's map list): only fresh ones, only where dynamic pricing is on. */
export async function factorsForSites(siteIds: readonly string[], now = new Date()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!siteIds.length) return out;
  try {
    const rows = await outsideRequestScope(() => many<{ site_id: string; factor_bps: number }>(
      `SELECT p.site_id, p.factor_bps FROM site_price_now p JOIN dynamic_price_settings ds ON ds.org_id = p.org_id AND ds.enabled
        WHERE p.site_id = ANY($1::uuid[]) AND p.valid_until > $2`, [siteIds, now]));
    for (const r of rows) out.set(r.site_id, Number(r.factor_bps));
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'dynamic prices for the map unavailable');
  }
  return out;
}
