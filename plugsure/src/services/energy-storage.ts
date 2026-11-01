import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { exponentOf } from './fx.js';

/**
 * On-site solar and battery storage (v1.42.0).
 *
 *   assets      per site: solar (array kWp, inverter kW) and batteries (kW both ways, usable kWh, a state-of-charge band)
 *   readings    the site's energy box (inverter, EMS or a small gateway) POSTs what it measures with its site key:
 *               solar output, battery power (+ discharging into the site) and state of charge, grid import. The answer
 *               carries the battery set-point for the next interval, so a simple box can follow it.
 *   load        the load manager (smartcharging.ts) may add to the grid budget only what was MEASURED, recently
 *   manager     (max_age_s, 120 s by default) and only a share of it (trust_pct, 80 % by default): the solar the
 *               inverter is producing (solar first) and the battery's actual discharge. Never a forecast: a cloud or
 *               a battery that does not follow its set-point would otherwise push the chargers over the breaker. With
 *               peak shaving the grid part of the budget is held at the target; the battery and solar make up the rest.
 *   set-point   the battery: discharge when the chargers want more than the grid part (peak shaving), charge from solar
 *               the site does not use, and off-peak from the grid while there is room; never outside its SoC band.
 *   results     over a period: solar produced and used on site (self-consumption), the battery's throughput, grid
 *               import and export, the grid peak against the peak without the battery, and what that saved at the
 *               site's electricity tariff (Finance → Energy tariffs): the rate of the hour for solar used and battery
 *               discharge, less the rate paid to charge the battery from the grid.
 */

export class EnergyError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** A reading counts for at most this long when integrating energy (a gap in the data is not filled in). */
export const MAX_STEP_S = 15 * 60;
export const MAX_READINGS_PER_POST = 500;

export interface Asset { id: string; siteId: string; kind: 'solar' | 'battery'; name: string; capacityKw: number; peakKwp: number | null; energyKwh: number | null; minSocPct: number | null; maxSocPct: number | null; commissionedOn: string | null; costMinor: number | null; note: string | null }
export interface Settings { siteId: string; solarFirst: boolean; peakShaving: boolean; peakTargetKw: number | null; trustPct: number; maxAgeS: number; ingestKeyHint: string | null }
export interface Reading { ts: number; solarW: number | null; batteryW: number | null; batterySocPct: number | null; gridW: number | null }

const assetOf = (r: any): Asset => ({
  id: String(r.id), siteId: r.site_id, kind: r.kind, name: r.name, capacityKw: Number(r.capacity_kw), peakKwp: r.peak_kwp == null ? null : Number(r.peak_kwp),
  energyKwh: r.energy_kwh == null ? null : Number(r.energy_kwh), minSocPct: r.min_soc_pct == null ? null : Number(r.min_soc_pct), maxSocPct: r.max_soc_pct == null ? null : Number(r.max_soc_pct),
  commissionedOn: r.commissioned_on ? String(r.commissioned_on instanceof Date ? r.commissioned_on.toISOString().slice(0, 10) : r.commissioned_on).slice(0, 10) : null,
  costMinor: r.cost_minor == null ? null : Number(r.cost_minor), note: r.note ?? null,
});
const DEFAULTS = { solarFirst: true, peakShaving: false, peakTargetKw: null, trustPct: 80, maxAgeS: 120, ingestKeyHint: null };
const settingsOf = (siteId: string, r: any): Settings => (r ? {
  siteId, solarFirst: r.solar_first, peakShaving: r.peak_shaving, peakTargetKw: r.peak_target_kw == null ? null : Number(r.peak_target_kw),
  trustPct: Number(r.trust_pct), maxAgeS: Number(r.max_age_s), ingestKeyHint: r.ingest_key_hint ?? null,
} : { siteId, ...DEFAULTS });
const readingOf = (r: any): Reading => ({
  ts: new Date(r.ts).getTime(), solarW: r.solar_w == null ? null : Number(r.solar_w), batteryW: r.battery_w == null ? null : Number(r.battery_w),
  batterySocPct: r.battery_soc_pct == null ? null : Number(r.battery_soc_pct), gridW: r.grid_w == null ? null : Number(r.grid_w),
});

// ------------------------------------------------------------------ pure: what the load manager may count

export interface Fleet { solarKw: number; batteryKw: number; minSocPct: number | null; maxSocPct: number | null; energyKwh: number }
export function fleetOf(assets: Asset[]): Fleet {
  const sol = assets.filter((a) => a.kind === 'solar'), bat = assets.filter((a) => a.kind === 'battery');
  return {
    solarKw: sol.reduce((s, a) => s + a.capacityKw, 0), batteryKw: bat.reduce((s, a) => s + a.capacityKw, 0),
    // Several batteries are treated as one: the tightest band, the energy summed.
    minSocPct: bat.length ? Math.max(...bat.map((a) => a.minSocPct ?? 0)) : null, maxSocPct: bat.length ? Math.min(...bat.map((a) => a.maxSocPct ?? 100)) : null,
    energyKwh: bat.reduce((s, a) => s + (a.energyKwh ?? 0), 0),
  };
}

export interface Extra { extraW: number; solarW: number; batteryW: number; fresh: boolean; ageS: number | null; reason: string }
/**
 * What the load manager may add to the grid budget now: the latest reading's solar output (solar first) and the
 * battery's actual discharge, each capped at the installed power and counted at trust_pct; nothing when the reading is
 * older than max_age_s.
 */
export function liveExtra(latest: Reading | null, fleet: Fleet, s: Settings, now = Date.now()): Extra {
  if (!latest) return { extraW: 0, solarW: 0, batteryW: 0, fresh: false, ageS: null, reason: 'no reading yet' };
  const ageS = Math.round((now - latest.ts) / 1000);
  if (ageS > s.maxAgeS || ageS < -60) return { extraW: 0, solarW: 0, batteryW: 0, fresh: false, ageS, reason: `the last reading is ${ageS} s old (counted up to ${s.maxAgeS} s)` };
  const k = s.trustPct / 100;
  const solarW = s.solarFirst ? Math.floor(Math.min(Math.max(0, latest.solarW ?? 0), fleet.solarKw * 1000) * k) : 0;
  const batteryW = Math.floor(Math.min(Math.max(0, latest.batteryW ?? 0), fleet.batteryKw * 1000) * k);
  return { extraW: solarW + batteryW, solarW, batteryW, fresh: true, ageS, reason: s.solarFirst ? 'measured solar and battery discharge' : 'measured battery discharge (solar first is off)' };
}

/** The grid part of the budget: the site's usable grid power, held at the peak-shaving target when that is on. */
export function gridPartW(usableGridW: number, s: Settings): number {
  return s.peakShaving && s.peakTargetKw ? Math.min(usableGridW, Math.round(s.peakTargetKw * 1000)) : usableGridW;
}

export interface SetpointIn { demandW: number; gridPartW: number; latest: Reading | null; fleet: Fleet; s: Settings; offPeak: boolean; fresh: boolean }
export interface Setpoint { batteryW: number; mode: 'idle' | 'discharge' | 'charge_solar' | 'charge_offpeak'; reason: string }
/**
 * The battery's set-point for the next interval (+ discharge, - charge), inside its power and SoC band:
 *   discharge  the chargers want more than the grid part and the solar cover (peak shaving);
 *   charge     from solar the site does not use; otherwise off-peak from the grid while the grid part has room.
 */
export function setpoint(x: SetpointIn): Setpoint {
  const { fleet, s } = x;
  if (!fleet.batteryKw) return { batteryW: 0, mode: 'idle', reason: 'no battery' };
  if (!x.fresh || !x.latest || x.latest.batterySocPct == null) return { batteryW: 0, mode: 'idle', reason: 'no recent state of charge' };
  const soc = x.latest.batterySocPct, maxW = Math.round(fleet.batteryKw * 1000);
  const solar = s.solarFirst ? Math.max(0, Math.min(x.latest.solarW ?? 0, fleet.solarKw * 1000)) : 0;
  const shortfall = x.demandW - x.gridPartW - solar;
  if (shortfall > 0 && soc > (fleet.minSocPct ?? 0)) {
    return { batteryW: Math.min(maxW, Math.round(shortfall)), mode: 'discharge', reason: `the chargers want ${r1(x.demandW / 1000)} kW; the grid part is ${r1(x.gridPartW / 1000)} kW` };
  }
  if (soc >= (fleet.maxSocPct ?? 100)) return { batteryW: 0, mode: 'idle', reason: 'full (upper SoC limit)' };
  const surplus = solar - Math.max(0, x.demandW);
  if (surplus > 0) return { batteryW: -Math.min(maxW, Math.round(surplus)), mode: 'charge_solar', reason: 'solar the chargers do not use' };
  const room = x.gridPartW - Math.max(0, x.demandW);
  if (x.offPeak && room > 0) return { batteryW: -Math.min(maxW, Math.round(room)), mode: 'charge_offpeak', reason: 'off-peak, with room on the grid' };
  return { batteryW: 0, mode: 'idle', reason: shortfall > 0 ? 'empty (lower SoC limit)' : 'nothing to do' };
}

// ------------------------------------------------------------------ pure: energy and savings

export interface Tariff { ratePeak: number; rateOffpeak: number; peakFrom: number; peakTo: number; currency: string }
export const hourIn = (t: number) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone(), hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
export const isPeak = (t: number, tf: Pick<Tariff, 'peakFrom' | 'peakTo'>) => { const h = hourIn(t); return tf.peakFrom <= tf.peakTo ? h >= tf.peakFrom && h < tf.peakTo : h >= tf.peakFrom || h < tf.peakTo; };

export interface Totals {
  solarKwh: number; solarUsedKwh: number; exportKwh: number; importKwh: number; batteryInKwh: number; batteryOutKwh: number; batteryFromGridKwh: number;
  selfConsumptionPct: number | null; peakGridKw: number; peakWithoutBatteryKw: number; peakShavedKw: number; savingsMajor: number | null; readings: number;
}
/**
 * Energy over the readings (each held until the next, at most MAX_STEP_S), and savings at the tariff:
 *   solar used on site = solar − export;  savings = Σ solar used × rate + battery out × rate − battery charged from the grid × rate.
 */
export function totals(readings: Reading[], tariff: Tariff | null): Totals {
  const rs = [...readings].sort((a, b) => a.ts - b.ts);
  let solar = 0, exp = 0, imp = 0, bIn = 0, bOut = 0, bGrid = 0, used = 0, money = 0, peak = 0, peakNo = 0;
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]!, next = rs[i + 1];
    const dtH = Math.min(next ? (next.ts - r.ts) / 1000 : 0, MAX_STEP_S) / 3600;
    const g = r.gridW ?? 0, b = r.batteryW ?? 0, sol = Math.max(0, r.solarW ?? 0);
    peak = Math.max(peak, g / 1000);
    peakNo = Math.max(peakNo, (g + Math.max(0, b)) / 1000);
    if (!dtH) continue;
    const kwh = (w: number) => (w * dtH) / 1000;
    const rate = tariff ? (isPeak(r.ts, tariff) ? tariff.ratePeak : tariff.rateOffpeak) : 0;
    const e = kwh(Math.max(0, -g)), solE = kwh(sol);
    solar += solE; exp += e; imp += kwh(Math.max(0, g));
    // Solar not exported was used on site: by the load, or charging the battery.
    const usedE = Math.max(0, solE - e); used += usedE;
    const charge = b < 0 ? kwh(-b) : 0, discharge = b > 0 ? kwh(b) : 0;
    const chargeFromSolar = Math.min(charge, usedE), chargeFromGrid = charge - chargeFromSolar;
    bIn += charge; bOut += discharge; bGrid += chargeFromGrid;
    // Solar into the battery is counted when the battery gives it back (its discharge), not twice; grid energy put into
    // the battery is a cost at the rate of its hour.
    money += (usedE - chargeFromSolar) * rate + discharge * rate - chargeFromGrid * rate;
  }
  return {
    solarKwh: r2(solar), solarUsedKwh: r2(used), exportKwh: r2(exp), importKwh: r2(imp), batteryInKwh: r2(bIn), batteryOutKwh: r2(bOut), batteryFromGridKwh: r2(bGrid),
    selfConsumptionPct: solar > 0 ? r1((used / solar) * 100) : null, peakGridKw: r2(peak), peakWithoutBatteryKw: r2(peakNo), peakShavedKw: r2(Math.max(0, peakNo - peak)),
    savingsMajor: tariff ? r2(money) : null, readings: rs.length,
  };
}

// ------------------------------------------------------------------ assets and settings

async function siteOf(orgId: string, siteId: string) {
  if (!UUID_RE.test(siteId)) throw new EnergyError(404, 'No such site.');
  const s = await outsideRequestScope(() => one<{ id: string; name: string }>(`SELECT id, name FROM site WHERE id = $1 AND org_id = $2`, [siteId, orgId]));
  if (!s) throw new EnergyError(404, 'No such site.');
  return s;
}

export async function assets(orgId: string, siteId?: string): Promise<Asset[]> {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT * FROM site_energy_asset WHERE org_id = $1 AND archived_at IS NULL AND ($2::uuid IS NULL OR site_id = $2) ORDER BY site_id, kind DESC, id`,
    [orgId, siteId && UUID_RE.test(siteId) ? siteId : null]));
  return rows.map(assetOf);
}

const num = (v: unknown, name: string, { min = 0, max = 1e7, optional = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (optional) return null; throw new EnergyError(422, `${name} is required.`); }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new EnergyError(422, `${name} is a number from ${min} to ${max}.`);
  return n;
};

export async function saveAsset(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await outsideRequestScope(() => one<any>(`SELECT * FROM site_energy_asset WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new EnergyError(404, 'No such asset.');
  if (cur && b.archive === true) {
    await outsideRequestScope(() => query(`UPDATE site_energy_asset SET archived_at = now() WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const siteId = String(b.siteId ?? cur?.site_id ?? '');
  await siteOf(orgId, siteId);
  const kind = String(b.kind ?? cur?.kind ?? '');
  if (kind !== 'solar' && kind !== 'battery') throw new EnergyError(422, 'kind is solar or battery.');
  const name = String(b.name ?? cur?.name ?? '').trim().slice(0, 120);
  if (!name) throw new EnergyError(422, 'name is required.');
  const pick = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const capacityKw = num(pick('capacityKw', 'capacity_kw'), kind === 'solar' ? 'capacityKw (the inverter, kW)' : 'capacityKw (kW)', { min: 0.1, max: 100_000 })!;
  const peakKwp = kind === 'solar' ? num(pick('peakKwp', 'peak_kwp'), 'peakKwp', { min: 0.1, max: 100_000, optional: true }) : null;
  const energyKwh = kind === 'battery' ? num(pick('energyKwh', 'energy_kwh'), 'energyKwh (usable kWh)', { min: 0.1, max: 1_000_000 }) : null;
  const minSoc = kind === 'battery' ? num(pick('minSocPct', 'min_soc_pct') ?? 10, 'minSocPct', { max: 100 }) : null;
  const maxSoc = kind === 'battery' ? num(pick('maxSocPct', 'max_soc_pct') ?? 95, 'maxSocPct', { max: 100 }) : null;
  if (kind === 'battery' && !(minSoc! < maxSoc!)) throw new EnergyError(422, 'minSocPct must be below maxSocPct.');
  const commissioned = pick('commissionedOn', 'commissioned_on');
  const commissionedOn = commissioned ? String(commissioned instanceof Date ? commissioned.toISOString() : commissioned).slice(0, 10) : null;
  if (commissionedOn && !DATE_RE.test(commissionedOn)) throw new EnergyError(422, 'commissionedOn is YYYY-MM-DD.');
  const costMinor = num(pick('costMinor', 'cost_minor'), 'costMinor', { max: 1e15, optional: true });
  const note = (pick('note', 'note') as string | null | undefined) ? String(pick('note', 'note')).slice(0, 500) : null;
  const vals = [orgId, siteId, kind, name, capacityKw, peakKwp, energyKwh, minSoc, maxSoc, commissionedOn, costMinor == null ? null : Math.round(costMinor), note];
  const r = cur
    ? await outsideRequestScope(() => one<any>(
      `UPDATE site_energy_asset SET site_id = $2, kind = $3, name = $4, capacity_kw = $5, peak_kwp = $6, energy_kwh = $7, min_soc_pct = $8, max_soc_pct = $9,
              commissioned_on = $10, cost_minor = $11, note = $12 WHERE id = $13 AND org_id = $1 RETURNING *`, [...vals, cur.id]))
    : await outsideRequestScope(() => one<any>(
      `INSERT INTO site_energy_asset (org_id, site_id, kind, name, capacity_kw, peak_kwp, energy_kwh, min_soc_pct, max_soc_pct, commissioned_on, cost_minor, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`, vals));
  return assetOf(r);
}

export async function settings(orgId: string, siteId: string): Promise<Settings> {
  await siteOf(orgId, siteId);
  return settingsOf(siteId, await outsideRequestScope(() => one<any>(`SELECT * FROM site_energy_settings WHERE site_id = $1 AND org_id = $2`, [siteId, orgId])));
}

export async function saveSettings(orgId: string, siteId: string, b: Record<string, unknown>, userId: string | null): Promise<Settings> {
  const cur = await settings(orgId, siteId);
  const bool = (k: keyof Settings) => (b[k] === undefined ? cur[k] : b[k] === true || b[k] === 'true');
  const peakShaving = bool('peakShaving') as boolean;
  const peakTargetKw = b.peakTargetKw === undefined ? cur.peakTargetKw : num(b.peakTargetKw, 'peakTargetKw', { min: 0.1, max: 100_000, optional: true });
  if (peakShaving && !peakTargetKw) throw new EnergyError(422, 'Peak shaving needs a target (peakTargetKw): the grid power to keep under.');
  const trustPct = b.trustPct === undefined ? cur.trustPct : num(b.trustPct, 'trustPct', { max: 100 })!;
  const maxAgeS = b.maxAgeS === undefined ? cur.maxAgeS : num(b.maxAgeS, 'maxAgeS', { min: 15, max: 900 })!;
  await outsideRequestScope(() => query(
    `INSERT INTO site_energy_settings (site_id, org_id, solar_first, peak_shaving, peak_target_kw, trust_pct, max_age_s, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (site_id) DO UPDATE SET solar_first = EXCLUDED.solar_first, peak_shaving = EXCLUDED.peak_shaving, peak_target_kw = EXCLUDED.peak_target_kw,
       trust_pct = EXCLUDED.trust_pct, max_age_s = EXCLUDED.max_age_s, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [siteId, orgId, bool('solarFirst'), peakShaving, peakTargetKw, Math.round(trustPct), Math.round(maxAgeS), userId]));
  return settings(orgId, siteId);
}

/** A new key for the site's energy box: shown once; only its hash is kept. The previous key stops working. */
export async function rotateKey(orgId: string, siteId: string, userId: string | null) {
  await settings(orgId, siteId);
  const key = `pse_${randomBytes(24).toString('base64url')}`;
  await outsideRequestScope(() => query(
    `INSERT INTO site_energy_settings (site_id, org_id, ingest_key_hash, ingest_key_hint, updated_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id) DO UPDATE SET ingest_key_hash = EXCLUDED.ingest_key_hash, ingest_key_hint = EXCLUDED.ingest_key_hint, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [siteId, orgId, sha(key), `…${key.slice(-4)}`, userId]));
  return { key, hint: `…${key.slice(-4)}` };
}

// ------------------------------------------------------------------ readings from the site

async function latestReading(siteId: string): Promise<Reading | null> {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM site_energy_reading WHERE site_id = $1 ORDER BY ts DESC LIMIT 1`, [siteId]));
  return r ? readingOf(r) : null;
}

async function siteState(siteId: string) {
  const org = await outsideRequestScope(() => one<{ org_id: string }>(`SELECT org_id FROM site WHERE id = $1`, [siteId]));
  if (!org) return null;
  const [as, st, latest] = await Promise.all([assets(org.org_id, siteId), outsideRequestScope(() => one<any>(`SELECT * FROM site_energy_settings WHERE site_id = $1`, [siteId])), latestReading(siteId)]);
  return { orgId: org.org_id, fleet: fleetOf(as), s: settingsOf(siteId, st), latest, hasAssets: as.length > 0 };
}

/**
 * For the load manager: what it may add to the grid budget and the grid part itself. A site without assets is
 * unchanged (no extra, the grid budget as configured).
 */
export async function forLoadManager(siteId: string, usableGridW: number, now = Date.now()): Promise<{ gridW: number; extra: Extra; active: boolean }> {
  const st = await siteState(siteId);
  if (!st || !st.hasAssets) return { gridW: usableGridW, extra: liveExtra(null, fleetOf([]), settingsOf(siteId, null), now), active: false };
  return { gridW: gridPartW(usableGridW, st.s), extra: liveExtra(st.latest, st.fleet, st.s, now), active: true };
}

/** The site's energy box posts readings with its key; the answer is the battery's set-point. */
export async function ingest(siteId: string, key: string, body: unknown, now = Date.now()) {
  if (!UUID_RE.test(siteId) || typeof key !== 'string' || !key) throw new EnergyError(401, 'A valid site key is required.');
  const st = await outsideRequestScope(() => one<{ org_id: string; ingest_key_hash: string | null }>(`SELECT org_id, ingest_key_hash FROM site_energy_settings WHERE site_id = $1`, [siteId]));
  const ok = !!st?.ingest_key_hash && timingSafeEqual(Buffer.from(sha(key), 'hex'), Buffer.from(st.ingest_key_hash, 'hex'));
  if (!ok) throw new EnergyError(401, 'A valid site key is required.');
  const list = Array.isArray((body as any)?.readings) ? (body as any).readings : [body];
  if (!list.length || list.length > MAX_READINGS_PER_POST) throw new EnergyError(422, `readings: 1 to ${MAX_READINGS_PER_POST} per request.`);
  const rows: Array<[string, number | null, number | null, number | null, number | null]> = [];
  for (const x of list) {
    const ts = Date.parse(String(x?.ts ?? ''));
    if (!Number.isFinite(ts) || ts > now + 5 * 60_000 || ts < now - 7 * 86_400_000) throw new EnergyError(422, 'Each reading has ts (ISO 8601) within the last 7 days.');
    const w = (v: unknown, name: string, min = -1e8) => { if (v === undefined || v === null) return null; const n = Number(v); if (!Number.isFinite(n) || n < min || n > 1e8) throw new EnergyError(422, `${name} is a number of watts.`); return Math.round(n); };
    const soc = x.batterySocPct === undefined || x.batterySocPct === null ? null : Number(x.batterySocPct);
    if (soc !== null && !(soc >= 0 && soc <= 100)) throw new EnergyError(422, 'batterySocPct is from 0 to 100.');
    rows.push([new Date(ts).toISOString(), w(x.solarW, 'solarW', 0), w(x.batteryW, 'batteryW'), soc, w(x.gridW, 'gridW')]);
  }
  let accepted = 0;
  for (const [ts, sol, bat, soc, grid] of rows) {
    const r = await outsideRequestScope(() => query(
      `INSERT INTO site_energy_reading (org_id, site_id, ts, solar_w, battery_w, battery_soc_pct, grid_w) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (site_id, ts) DO NOTHING`,
      [st!.org_id, siteId, ts, sol, bat, soc, grid]));
    accepted += r.rowCount ?? 0;
  }
  return { accepted, duplicates: rows.length - accepted, setpoint: await currentSetpoint(siteId, now) };
}

/** The battery's set-point now, from the chargers' demand and the site's budget (smartcharging.ts). */
export async function currentSetpoint(siteId: string, now = Date.now()): Promise<Setpoint & { gridPartW: number; demandW: number }> {
  const st = await siteState(siteId);
  if (!st) return { batteryW: 0, mode: 'idle', reason: 'no such site', gridPartW: 0, demandW: 0 };
  const sc = await import('./smartcharging.js');
  const budget = await sc.loadSiteBudget(siteId);
  const usable = budget && !budget.curtailed ? Math.max(0, budget.ceilingW - budget.reserveW) : 0;
  const demandW = (await sc.collectDemands(siteId)).filter((d) => d.active).reduce((s, d) => s + d.maxPowerW, 0);
  const tf = await outsideRequestScope(() => one<any>(`SELECT peak_from, peak_to FROM site_tariff WHERE site_id = $1`, [siteId]));
  const offPeak = !isPeak(now, { peakFrom: tf?.peak_from ?? 17, peakTo: tf?.peak_to ?? 22 });
  const gp = gridPartW(usable, st.s);
  const fresh = !!st.latest && (now - st.latest.ts) / 1000 <= st.s.maxAgeS;
  return { ...setpoint({ demandW, gridPartW: gp, latest: st.latest, fleet: st.fleet, s: st.s, offPeak, fresh }), gridPartW: gp, demandW };
}

// ------------------------------------------------------------------ the console

/** Per site with assets: the assets, settings, the latest reading and what the load manager counts, the set-point. */
export async function overview(orgId: string) {
  const all = await assets(orgId);
  const siteIds = [...new Set(all.map((a) => a.siteId))];
  const sites = siteIds.length ? await outsideRequestScope(() => many<{ id: string; name: string }>(`SELECT id, name FROM site WHERE id = ANY($1::uuid[]) AND org_id = $2 ORDER BY name`, [siteIds, orgId])) : [];
  const now = Date.now();
  const out = [];
  for (const s of sites) {
    const st = (await siteState(s.id))!;
    const sc = await import('./smartcharging.js');
    const budget = await sc.loadSiteBudget(s.id);
    const usable = budget && !budget.curtailed ? Math.max(0, budget.ceilingW - budget.reserveW) : 0;
    const lm = await forLoadManager(s.id, usable, now);
    out.push({
      siteId: s.id, siteName: s.name, assets: all.filter((a) => a.siteId === s.id), settings: st.s, fleet: st.fleet,
      latest: st.latest ? { ...st.latest, ts: new Date(st.latest.ts).toISOString() } : null,
      loadManager: { gridBudgetW: usable, gridPartW: lm.gridW, extra: lm.extra, totalW: lm.gridW + lm.extra.extraW },
      setpoint: await currentSetpoint(s.id, now),
    });
  }
  return { sites: out, ingestPath: '/v1/energy/sites/{siteId}/readings' };
}

/** A site's results over a period (days, default 30): energy, peak and savings, and the day-by-day series. */
export async function results(orgId: string, siteId: string, q: { from?: unknown; to?: unknown } = {}) {
  const site = await siteOf(orgId, siteId);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date());
  const to = typeof q.to === 'string' && DATE_RE.test(q.to) ? q.to : today;
  const from = typeof q.from === 'string' && DATE_RE.test(q.from) ? q.from : new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (from > to) throw new EnergyError(422, 'from is on or before to.');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) throw new EnergyError(422, 'At most 400 days.');
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT ts, solar_w, battery_w, battery_soc_pct, grid_w, (ts AT TIME ZONE $4)::date::text AS day FROM site_energy_reading
      WHERE site_id = $1 AND org_id = $2 AND ts >= ($3::date - 0)::timestamp AT TIME ZONE $4 AND ts < ($5::date + 1)::timestamp AT TIME ZONE $4 ORDER BY ts`,
    [siteId, orgId, from, zone(), to]));
  const tf = await outsideRequestScope(() => one<any>(`SELECT * FROM site_tariff WHERE site_id = $1 AND org_id = $2`, [siteId, orgId]));
  const tariff: Tariff | null = tf ? { ratePeak: Number(tf.rate_peak), rateOffpeak: Number(tf.rate_offpeak), peakFrom: tf.peak_from, peakTo: tf.peak_to, currency: tf.currency } : null;
  const byDay = new Map<string, Reading[]>();
  for (const r of rows) { const d = r.day; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(readingOf(r)); }
  const all = totals(rows.map(readingOf), tariff);
  const cur = tariff?.currency ?? null;
  const toMinor = (major: number | null) => (major == null || !cur ? null : Math.round(major * 10 ** exponentOf(cur)));
  const as = await assets(orgId, siteId);
  const fleet = fleetOf(as);
  const days = [...byDay.entries()].map(([day, rs]) => { const t = totals(rs, tariff); return { day, ...t, savingsMinor: toMinor(t.savingsMajor) }; });
  return {
    site: { id: site.id, name: site.name }, from, to, currency: cur, tariff: tariff ? { ratePeak: tariff.ratePeak, rateOffpeak: tariff.rateOffpeak, peakFrom: tariff.peakFrom, peakTo: tariff.peakTo } : null,
    totals: { ...all, savingsMinor: toMinor(all.savingsMajor) }, days,
    // The solar array's yield: kWh per kWp installed per day.
    solarYieldKwhPerKwp: fleet.solarKw && days.length ? r2(all.solarKwh / (as.filter((a) => a.kind === 'solar').reduce((s, a) => s + (a.peakKwp ?? a.capacityKw), 0) || 1) / days.length) : null,
    batteryCycles: fleet.energyKwh ? r1(all.batteryOutKwh / fleet.energyKwh) : null,
  };
}
