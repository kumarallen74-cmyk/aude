import { haversineKm, listStations, type StationView } from './stations.js';

/**
 * The trip planner (v1.46.0), driver app → Perjalanan. From where the driver is (or a place) to a destination: where to
 * stop and charge, with the car's range.
 *
 * The road distance is the straight line × 1.3 (no road map is used, so it is an estimate; the stops are real
 * stations). Stations count when they are within 15 km of the line, fit the car (its connector types, if given) and
 * reach the minimum power. Then, greedily: from where the car is, among the stations it can reach with at least the
 * reserve left, the one that takes it furthest towards the destination, preferring available, fast and cheap ones; it
 * charges to 80 %, and so on until the destination is in range. At most 8 stops.
 *
 * Each stop: the station, its distance from the start, the battery on arrival, the energy and the time to charge (at
 * the lower of the station's and the car's power, the last part slower), the price per kWh and the cost estimate,
 * and how many connectors are free now. The app links each stop to its station, to reserve or queue there.
 */

const ROAD_FACTOR = 1.3;
const CORRIDOR_KM = 15;
const CHARGE_TO = 0.8;

export interface TripInput {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  /** The battery now, % (0–100). */
  socPct: number;
  /** The car's range on a full battery, km. */
  rangeKm: number;
  /** The battery, kWh (for the energy and time); default from the range at 6 km/kWh. */
  batteryKwh?: number | null;
  /** The car's fastest charging, kW (DC); default 50. */
  carMaxKw?: number | null;
  /** Arrive anywhere with at least this, % (default 15). */
  reservePct?: number | null;
  /** Connector types the car takes (CCS2, Type2, CHAdeMO, …): only stations with one count. Empty: any. */
  connectorTypes?: string[] | null;
  minPowerKw?: number | null;
}

export interface TripStop {
  siteId: string; name: string; operator: string; lat: number; lon: number; address: string | null;
  distanceFromStartKm: number; arriveSocPct: number; leaveSocPct: number; chargeKwh: number; chargeMinutes: number;
  powerKw: number; fastest: string; available: number; total: number; priceFromMajor: number | null; currency: string; costEstimateMajor: number | null;
}

export class TripError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

/** Distance (km) from a point to the segment a→b, on a local flat projection (fine at these scales). */
export function offLineKm(p: { lat: number; lon: number }, a: { lat: number; lon: number }, b: { lat: number; lon: number }): { off: number; along: number } {
  const k = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180) * 111.32;
  const ax = a.lon * k, ay = a.lat * 110.57, bx = b.lon * k, by = b.lat * 110.57, px = p.lon * k, py = p.lat * 110.57;
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return { off: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), along: t * Math.sqrt(len2) };
}

/** Minutes to charge from one share to another at `kw`: full speed to 80 %, half speed above it. */
export function chargeMinutes(fromPct: number, toPct: number, batteryKwh: number, kw: number): number {
  if (toPct <= fromPct || kw <= 0) return 0;
  const fast = Math.max(0, Math.min(toPct, 80) - fromPct), slow = Math.max(0, toPct - Math.max(fromPct, 80));
  return Math.round(((fast / 100) * batteryKwh / kw + (slow / 100) * batteryKwh / (kw / 2)) * 60);
}

const fits = (s: StationView, types: string[], minKw: number) =>
  s.connectors.some((c) => c.maxPowerKw >= minKw && (!types.length || types.some((t) => (c.type ?? '').toLowerCase().includes(t.toLowerCase()) || (c.typeLabel ?? '').toLowerCase().includes(t.toLowerCase()))));

/** Plan the stops (pure: the stations are given). */
export function planTrip(inp: TripInput, stations: StationView[]) {
  const range = Number(inp.rangeKm), soc0 = Number(inp.socPct);
  if (!(range >= 50 && range <= 1500)) throw new TripError(422, 'Jarak tempuh mobil dengan baterai penuh harus 50 sampai 1500 km.');
  if (!(soc0 >= 1 && soc0 <= 100)) throw new TripError(422, 'Isi baterai sekarang harus 1 sampai 100 persen.');
  const reserve = Math.min(40, Math.max(5, Number(inp.reservePct ?? 15)));
  const battery = Number(inp.batteryKwh) > 0 ? Number(inp.batteryKwh) : range / 6;
  const carKw = Number(inp.carMaxKw) > 0 ? Number(inp.carMaxKw) : 50;
  const types = (inp.connectorTypes ?? []).map(String).filter(Boolean);
  const minKw = Math.max(0, Number(inp.minPowerKw ?? 0));
  const total = haversineKm(inp.from.lat, inp.from.lon, inp.to.lat, inp.to.lon) * ROAD_FACTOR;
  // Candidates along the way.
  const cands = stations
    .filter((s) => s.lat != null && s.lon != null && fits(s, types, minKw))
    .map((s) => ({ s, ...offLineKm({ lat: s.lat!, lon: s.lon! }, inp.from, inp.to) }))
    .filter((x) => x.off <= CORRIDOR_KM)
    .map((x) => ({ ...x, alongRoad: x.along * ROAD_FACTOR }));
  const stops: TripStop[] = [];
  let pos = 0, soc = soc0;
  const reach = (pct: number) => ((pct - reserve) / 100) * range;
  while (pos + reach(soc) < total) {
    if (stops.length >= 8) throw new TripError(422, 'Perjalanan ini perlu lebih dari 8 kali isi daya dengan jarak tempuh ini.');
    const ahead = cands.filter((c) => c.alongRoad > pos + 1 && c.alongRoad - pos + c.off <= reach(soc));
    if (!ahead.length) {
      return { distanceKm: Math.round(total), feasible: false, stops, reason: 'no_station_in_reach', stuckAtKm: Math.round(pos), rangeLeftKm: Math.round(reach(soc)), reservePct: reserve };
    }
    // Furthest progress, nudged by availability, power and price.
    const score = (c: typeof ahead[number]) => c.alongRoad
      + (c.s.availableCount > 0 ? 15 : -25) + Math.min(c.s.maxPowerKw, 150) / 10 - c.off;
    const best = ahead.reduce((a, b) => (score(b) > score(a) ? b : a));
    const drive = best.alongRoad - pos + best.off;
    const arrive = soc - (drive / range) * 100;
    const kw = Math.min(best.s.maxPowerKw, best.s.connectors.some((c) => c.current === 'DC') ? carKw : Math.min(carKw, 22));
    const leave = Math.max(arrive, CHARGE_TO * 100);
    const kwh = ((leave - arrive) / 100) * battery;
    stops.push({
      siteId: best.s.siteId, name: best.s.name, operator: best.s.operator, lat: best.s.lat!, lon: best.s.lon!, address: best.s.address,
      distanceFromStartKm: Math.round(best.alongRoad), arriveSocPct: Math.round(arrive), leaveSocPct: Math.round(leave), chargeKwh: Math.round(kwh * 10) / 10,
      chargeMinutes: chargeMinutes(arrive, leave, battery, kw), powerKw: Math.round(kw), fastest: best.s.fastest, available: best.s.availableCount, total: best.s.totalCount,
      priceFromMajor: best.s.priceFromMajor, currency: best.s.currency, costEstimateMajor: best.s.priceFromMajor == null ? null : Math.round(best.s.priceFromMajor * kwh * 100) / 100,
    });
    pos = best.alongRoad; soc = leave;
  }
  const arriveDest = soc - ((total - pos) / range) * 100;
  return {
    distanceKm: Math.round(total), feasible: true, stops, arriveSocPct: Math.round(arriveDest),
    chargeMinutes: stops.reduce((a, s) => a + s.chargeMinutes, 0), costEstimateMajor: stops.every((s) => s.costEstimateMajor != null) ? Math.round(stops.reduce((a, s) => a + (s.costEstimateMajor ?? 0), 0) * 100) / 100 : null,
    reason: null as string | null,
  };
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const point = (v: any, what: string) => {
  const lat = num(v?.lat), lon = num(v?.lon);
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) throw new TripError(422, what === 'from' ? 'Pilih titik awal dengan benar.' : 'Pilih tujuan dengan benar.');
  return { lat, lon };
};

/** The app's request: the stations in the box around the trip (with prices), then the plan. */
export async function plan(b: Record<string, unknown>, orgId: string | null = null) {
  const from = point(b.from, 'from'), to = point(b.to, 'to');
  if (haversineKm(from.lat, from.lon, to.lat, to.lon) > 3000) throw new TripError(422, 'Perjalanan paling jauh 3.000 km dari titik awal.');
  const pad = CORRIDOR_KM / 100 + 0.05;
  const box = [Math.min(from.lon, to.lon) - pad, Math.min(from.lat, to.lat) - pad, Math.max(from.lon, to.lon) + pad, Math.max(from.lat, to.lat) + pad] as const;
  const stations = await listStations(undefined, orgId, { bbox: box });
  return { ...planTrip({ from, to, socPct: num(b.socPct), rangeKm: num(b.rangeKm), batteryKwh: num(b.batteryKwh) || null, carMaxKw: num(b.carMaxKw) || null,
    reservePct: num(b.reservePct) || null, connectorTypes: Array.isArray(b.connectorTypes) ? (b.connectorTypes as unknown[]).map(String).slice(0, 6) : null, minPowerKw: num(b.minPowerKw) || null }, stations),
  stationsConsidered: stations.length };
}
