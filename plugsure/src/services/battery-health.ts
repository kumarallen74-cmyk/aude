import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { persistAlert } from './alerts.js';

/**
 * EV battery health (v1.48.0), Assets & energy → Battery health. For fleet vehicles (Depot charging: a vehicle with its
 * card and its battery size), from their own charging sessions:
 *
 *   per session  the state of charge at the start and the end (the car's SoC over OCPP, else the telematics reading
 *                closest to the start and to the end), the energy delivered and the peak power. With at least 20
 *                points of SoC gained, the usable capacity ≈ energy × 0.92 (charging losses) ÷ the share gained
 *   per vehicle  state of health = the median capacity of the last 90 days ÷ the battery size; the monthly medians;
 *                the degradation per year (the trend of the estimates)
 *   flags        capacity_drop (an estimate 10 % below the vehicle's recent median), slow_charging (peak power below 60 %
 *                of the vehicle's usual on fast chargers), low_health (state of health under 75 %), implausible
 *                (above 130 % of the battery size: not used). capacity_drop and slow_charging raise
 *                vehicle.battery_anomaly
 *
 * Estimates, not a battery management system's figures: the trend over many sessions is what to trust.
 */

export class BatteryError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const ANOMALY_ALERT = 'vehicle.battery_anomaly';
const S = <T>(fn: () => T) => outsideRequestScope(fn);
export const EFFICIENCY = 0.92;
const MIN_SOC_GAIN = 20;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ pure

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Usable capacity (kWh) from one session; null when it gained too little charge to say. */
export function capacityOf(kwh: number, socStart: number | null, socEnd: number | null): number | null {
  if (socStart == null || socEnd == null || !(kwh > 0)) return null;
  const gain = socEnd - socStart;
  if (gain < MIN_SOC_GAIN) return null;
  return r2((kwh * EFFICIENCY) / (gain / 100));
}

/** The trend of capacity over time: kWh per year (negative: losing capacity). Least squares; null under 3 points or 30 days. */
export function slopePerYear(points: Array<{ at: Date; capacityKwh: number }>): number | null {
  if (points.length < 3) return null;
  const xs = points.map((p) => p.at.getTime() / (365.25 * 86_400_000)), ys = points.map((p) => p.capacityKwh);
  const span = Math.max(...xs) - Math.min(...xs);
  if (span < 30 / 365.25) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0), den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den ? r2(num / den) : null;
}

/** The flags for a new estimate against the vehicle's recent ones. */
export function flagsFor(est: { capacityKwh: number | null; peakKw: number | null }, nominalKwh: number | null, recent: { capacities: number[]; peaks: number[] }): string[] {
  const f: string[] = [];
  if (est.capacityKwh != null && nominalKwh && est.capacityKwh > nominalKwh * 1.3) return ['implausible'];
  const medCap = median(recent.capacities);
  if (est.capacityKwh != null && medCap != null && recent.capacities.length >= 3 && est.capacityKwh < medCap * 0.9) f.push('capacity_drop');
  if (est.capacityKwh != null && nominalKwh && est.capacityKwh < nominalKwh * 0.75) f.push('low_health');
  const medPeak = median(recent.peaks);
  if (est.peakKw != null && medPeak != null && medPeak >= 20 && recent.peaks.length >= 3 && est.peakKw < medPeak * 0.6) f.push('slow_charging');
  return f;
}

// ------------------------------------------------------------------ estimates

async function socAt(sessionId: string, vehicleId: string, at: Date, first: boolean) {
  const mv = await S(() => one<any>(`SELECT value FROM meter_value WHERE session_id = $1 AND measurand = 'SoC' ORDER BY ts ${first ? 'ASC' : 'DESC'} LIMIT 1`, [sessionId]));
  if (mv) return { soc: Number(mv.value), source: 'meter' };
  // Telematics: the reading closest to the moment, within 30 minutes (before the start, or after the end).
  const t = await S(() => one<any>(
    `SELECT soc_pct FROM vehicle_telemetry WHERE vehicle_id = $1 AND soc_pct IS NOT NULL AND recorded_at BETWEEN $2::timestamptz - interval '30 minutes' AND $2::timestamptz + interval '30 minutes'
      ORDER BY abs(extract(epoch FROM recorded_at - $2::timestamptz)) LIMIT 1`, [vehicleId, at]));
  return t ? { soc: Number(t.soc_pct), source: 'telematics' } : null;
}

/** Estimate the sessions not estimated yet (fleet vehicles with a card). Worker: every 15 minutes. */
export async function estimatePending(limit = 200): Promise<number> {
  const rows = await S(() => many<any>(
    `SELECT cs.id, cs.org_id, cs.started_at, cs.ended_at, COALESCE(cs.energy_wh, 0) AS wh, cs.soc_percent, v.id AS vehicle_id, v.battery_kwh, v.name
       FROM charging_session cs JOIN fleet_vehicle v ON v.token_id = cs.token_id AND v.org_id = cs.org_id
      WHERE cs.state IN ('ended', 'rated') AND cs.ended_at > now() - interval '120 days' AND COALESCE(cs.energy_wh, 0) > 0 AND v.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM vehicle_battery_estimate e WHERE e.session_id = cs.id)
      ORDER BY cs.ended_at LIMIT $1`, [limit]));
  let n = 0;
  for (const s of rows) {
    const start = await socAt(s.id, String(s.vehicle_id), new Date(s.started_at), true);
    const endMv = await socAt(s.id, String(s.vehicle_id), new Date(s.ended_at), false);
    const end = endMv ?? (s.soc_percent != null ? { soc: Number(s.soc_percent), source: 'meter' } : null);
    const peak = await S(() => one<any>(
      `SELECT max(CASE WHEN lower(COALESCE(unit, 'W')) = 'kw' THEN value ELSE value / 1000 END) AS kw FROM meter_value WHERE session_id = $1 AND measurand = 'Power.Active.Import'`, [s.id]));
    const kwh = Number(s.wh) / 1000;
    let capacity = capacityOf(kwh, start?.soc ?? null, end?.soc ?? null);
    const recent = await S(() => many<any>(`SELECT capacity_kwh, peak_kw FROM vehicle_battery_estimate WHERE vehicle_id = $1 AND NOT ('implausible' = ANY(flags)) ORDER BY at DESC LIMIT 10`, [s.vehicle_id]));
    const peakKw = peak?.kw == null ? null : r2(Number(peak.kw));
    const flags = flagsFor({ capacityKwh: capacity, peakKw }, s.battery_kwh == null ? null : Number(s.battery_kwh),
      { capacities: recent.filter((r) => r.capacity_kwh != null).map((r) => Number(r.capacity_kwh)), peaks: recent.filter((r) => r.peak_kw != null).map((r) => Number(r.peak_kw)) });
    if (flags.includes('implausible')) capacity = null;
    await S(() => query(
      `INSERT INTO vehicle_battery_estimate (org_id, vehicle_id, session_id, at, soc_start, soc_end, soc_source, kwh, capacity_kwh, peak_kw, flags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (session_id) DO NOTHING`,
      [s.org_id, s.vehicle_id, s.id, s.ended_at, start?.soc ?? null, end?.soc ?? null, start?.source === end?.source ? start?.source ?? null : [start?.source, end?.source].filter(Boolean).join('+') || null,
        kwh, capacity, peakKw, flags]));
    n++;
    const bad = flags.filter((f) => f === 'capacity_drop' || f === 'slow_charging');
    if (bad.length) {
      await S(() => persistAlert({ orgId: s.org_id, kind: ANOMALY_ALERT, severity: 'warning', targetType: 'fleet_vehicle', targetId: String(s.vehicle_id),
        message: `${s.name}: ${bad.map((f) => (f === 'capacity_drop' ? `the estimated capacity fell to ${capacity} kWh` : `charging peaked at ${peakKw} kW, well below usual`)).join('; ')}.` } as any)).catch(() => null);
    }
  }
  return n;
}

// ------------------------------------------------------------------ the console

/** Every fleet vehicle with its state of health (the median of the last 90 days), the trend and the latest flags. */
export async function overview(orgId: string) {
  const vs = await S(() => many<any>(
    `SELECT v.id, v.name, v.plate, v.battery_kwh, (v.token_id IS NOT NULL) AS has_card FROM fleet_vehicle v WHERE v.org_id = $1 AND v.archived_at IS NULL ORDER BY v.name`, [orgId]));
  const ests = await S(() => many<any>(
    `SELECT vehicle_id, at, capacity_kwh, peak_kw, flags FROM vehicle_battery_estimate WHERE org_id = $1 AND at > now() - interval '400 days' ORDER BY at`, [orgId]));
  const since90 = Date.now() - 90 * 86_400_000;
  const vehicles = vs.map((v) => {
    const mine = ests.filter((e) => String(e.vehicle_id) === String(v.id));
    const caps = mine.filter((e) => e.capacity_kwh != null).map((e) => ({ at: new Date(e.at), capacityKwh: Number(e.capacity_kwh) }));
    const recent = caps.filter((c) => c.at.getTime() >= since90).map((c) => c.capacityKwh);
    const cap = median(recent);
    const nominal = v.battery_kwh == null ? null : Number(v.battery_kwh);
    const slope = slopePerYear(caps);
    const last = mine[mine.length - 1];
    return {
      id: String(v.id), name: v.name, plate: v.plate ?? null, batteryKwh: nominal, hasCard: v.has_card, sessions: mine.length, estimates: caps.length,
      capacityKwh: cap == null ? null : r1(cap), sohPct: cap != null && nominal ? r1((cap / nominal) * 100) : null,
      degradationPctPerYear: slope != null && nominal ? r1((slope / nominal) * 100) : null,
      lastAt: last ? new Date(last.at).toISOString() : null, flags: last ? [...(last.flags ?? [])] : [],
      flagged90: mine.filter((e) => new Date(e.at).getTime() >= since90 && (e.flags ?? []).some((f: string) => f !== 'implausible')).length,
    };
  });
  const withSoh = vehicles.filter((v) => v.sohPct != null);
  return {
    vehicles,
    fleet: { vehicles: vehicles.length, measured: withSoh.length, medianSohPct: withSoh.length ? r1(median(withSoh.map((v) => v.sohPct!))!) : null,
      below80: withSoh.filter((v) => v.sohPct! < 80).length, flagged: vehicles.filter((v) => v.flagged90 > 0).length },
  };
}

export async function vehicle(orgId: string, vehicleId: string) {
  const v = await S(() => one<any>(`SELECT id, name, plate, battery_kwh FROM fleet_vehicle WHERE id = $1 AND org_id = $2`, [Number(vehicleId) || 0, orgId]));
  if (!v) throw new BatteryError(404, 'No such vehicle.');
  const ests = await S(() => many<any>(
    `SELECT e.*, s.name AS site FROM vehicle_battery_estimate e JOIN charging_session cs ON cs.id = e.session_id LEFT JOIN site s ON s.id = cs.site_id
      WHERE e.vehicle_id = $1 ORDER BY e.at DESC LIMIT 300`, [v.id]));
  const months = new Map<string, number[]>();
  for (const e of ests) if (e.capacity_kwh != null) { const m = new Date(e.at).toISOString().slice(0, 7); months.set(m, [...(months.get(m) ?? []), Number(e.capacity_kwh)]); }
  const nominal = v.battery_kwh == null ? null : Number(v.battery_kwh);
  return {
    id: String(v.id), name: v.name, plate: v.plate ?? null, batteryKwh: nominal,
    monthly: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, xs]) => {
      const m = median(xs)!; return { month, capacityKwh: r1(m), sohPct: nominal ? r1((m / nominal) * 100) : null, estimates: xs.length };
    }),
    sessions: ests.map((e) => ({ sessionId: e.session_id, at: new Date(e.at).toISOString(), site: e.site ?? null, socStart: e.soc_start == null ? null : Number(e.soc_start),
      socEnd: e.soc_end == null ? null : Number(e.soc_end), socSource: e.soc_source ?? null, kwh: Number(e.kwh), capacityKwh: e.capacity_kwh == null ? null : Number(e.capacity_kwh),
      peakKw: e.peak_kw == null ? null : Number(e.peak_kw), flags: e.flags ?? [] })),
  };
}
