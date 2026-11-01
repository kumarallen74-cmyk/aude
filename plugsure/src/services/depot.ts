import { many, one, outsideRequestScope, query } from '../db/pool.js';

import { zonedInstant } from './on-call.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import type { Allocation, Demand } from './smartcharging.js';

/**
 * Fleet depot scheduling (v1.44.0): at a site with depot scheduling on, the load manager plans charging so every vehicle
 * is ready by its departure, using the cheaper off-peak hours when there is time, and says early when one will not be.
 *
 * Each charging session can have a departure (session_departure): when it must be ready and how much energy it needs.
 * It comes from, in order:
 *   console   set by an operator for this session;
 *   ocpp      the car itself (OCPP 2.0.1 / ISO 15118 charging needs: departure time and energy or target SoC);
 *   vehicle   the fleet vehicle whose card started the session (fleet_vehicle): its usual departure time (the next one,
 *             in the site's time zone) and its target (kWh, or a state of charge with the battery size and the SoC the
 *             charger reports).
 * A session with none is charged as before.
 *
 * Each pass (planDepot, pure), for each session with a departure:
 *   ready      the energy is delivered: held at its minimum, freeing power for the others;
 *   deferred   it is a grid peak hour (the site's energy tariff) and the off-peak hours left before the departure can
 *              still deliver the rest (at 80 % of the connector's power): held at its minimum now;
 *   on_track   its minimum is raised to what the departure needs (the energy left over the time left, +15 %), and the
 *              more urgent it is, the later it would be shed if the site ran short;
 *   at_risk    even its full power cannot deliver in time: full power, first in line, and an alert
 *              (fleet.vehicle_not_ready) once;
 *   missed     the departure has passed.
 * The usual budget, curtailment, demand response and partner caps still bound everything (smartcharging.ts).
 */

export class DepotError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const NOT_READY_ALERT = 'fleet.vehicle_not_ready';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export type PlanState = 'on_track' | 'deferred' | 'at_risk' | 'ready' | 'missed';
export interface Need { sessionId: string; connectorUuid: string; neededWh: number; deliveredWh: number; departureAt: Date }
export interface Plan { sessionId: string; state: PlanState; requiredW: number | null; remainingWh: number }

// ------------------------------------------------------------------ pure

/** Hours from `now` to `until` that are not grid peak hours (hour by hour; the partial current hour counts pro rata). */
export function offPeakHours(now: Date, until: Date, isPeak: (t: Date) => boolean): number {
  let t = now.getTime(), h = 0;
  const end = until.getTime();
  while (t < end && h < 24 * 14) {
    const next = Math.min(end, (Math.floor(t / 3_600_000) + 1) * 3_600_000);
    if (!isPeak(new Date(t))) h += (next - t) / 3_600_000;
    t = next;
  }
  return h;
}

/** The demands adjusted for departures, and each session's plan. Demands without a departure are untouched. */
export function planDepot(demands: Demand[], needs: Map<string, Need>, now: Date, isPeak: (t: Date) => boolean): { demands: Demand[]; plans: Plan[] } {
  const plans: Plan[] = [];
  const out = demands.map((d) => {
    const n = d.connectorUuid && d.active ? needs.get(d.connectorUuid) : undefined;
    if (!n) return d;
    const remainingWh = Math.max(0, n.neededWh - n.deliveredWh);
    const hoursLeft = (n.departureAt.getTime() - now.getTime()) / 3_600_000;
    if (remainingWh <= 0) { plans.push({ sessionId: n.sessionId, state: 'ready', requiredW: 0, remainingWh: 0 }); return { ...d, maxPowerW: d.minPowerW, priority: 0 }; }
    if (hoursLeft <= 0) { plans.push({ sessionId: n.sessionId, state: 'missed', requiredW: null, remainingWh }); return { ...d, priority: 100 }; }
    const requiredW = Math.ceil(remainingWh / hoursLeft);
    if (requiredW > d.maxPowerW * 0.98) {
      plans.push({ sessionId: n.sessionId, state: 'at_risk', requiredW, remainingWh });
      return { ...d, minPowerW: d.maxPowerW, priority: 100 };
    }
    if (isPeak(now) && remainingWh <= offPeakHours(now, n.departureAt, isPeak) * d.maxPowerW * 0.8) {
      plans.push({ sessionId: n.sessionId, state: 'deferred', requiredW, remainingWh });
      return { ...d, maxPowerW: d.minPowerW, priority: 0 };
    }
    plans.push({ sessionId: n.sessionId, state: 'on_track', requiredW, remainingWh });
    const min = Math.min(d.maxPowerW, Math.max(d.minPowerW, Math.ceil(requiredW * 1.15)));
    return { ...d, minPowerW: min, priority: 10 + Math.round(Math.min(89, (requiredW / d.maxPowerW) * 89)) };
  });
  return { demands: out, plans };
}

/** The next time a local HH:MM happens after `from` (at least 30 minutes on), in tz. */
export function nextDeparture(hhmm: string, from: Date, tz: string): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(from);
  let t = zonedInstant(day, hhmm, tz);
  if (t.getTime() <= from.getTime() + 30 * 60_000) t = new Date(t.getTime() + 86_400_000);
  return t;
}

// ------------------------------------------------------------------ the load manager

/**
 * The departures of a site's active sessions, keyed by connector. A session with none yet gets one from the car's own
 * charging needs, else its fleet vehicle's defaults (kept, so the plan is stable). Null: depot scheduling is off.
 */
export async function needsFor(siteId: string, now = new Date()): Promise<{ needs: Map<string, Need>; isPeak: (t: Date) => boolean } | null> {
  const site = await outsideRequestScope(() => one<any>(
    `SELECT s.org_id, s.timezone, s.depot_scheduling, t.peak_from, t.peak_to FROM site s LEFT JOIN site_tariff t ON t.site_id = s.id WHERE s.id = $1`, [siteId]));
  if (!site?.depot_scheduling) return null;
  const tz: string = site.timezone;
  const pf = site.peak_from ?? 17, pt = site.peak_to ?? 22;
  const hourOf = (t: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(t));
  const isPeak = (t: Date) => { const h = hourOf(t); return pf <= pt ? h >= pf && h < pt : h >= pf || h < pt; };
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT cs.id, cs.connector_uuid, cs.started_at, cs.energy_wh, cs.soc_percent, cs.token_id,
            d.departure_at, d.needed_wh,
            n.departure_time AS ocpp_departure, n.energy_request_wh, n.target_soc_percent AS ocpp_target_soc, n.ev_capacity_wh,
            v.id AS vehicle_id, v.departure_time AS v_departure, v.target_kwh, v.target_soc_pct, v.battery_kwh
       FROM charging_session cs
       LEFT JOIN session_departure d ON d.session_id = cs.id
       LEFT JOIN LATERAL (SELECT * FROM ev_charging_needs e WHERE e.session_id = cs.id ORDER BY e.received_at DESC LIMIT 1) n ON true
       LEFT JOIN fleet_vehicle v ON v.token_id = cs.token_id AND v.archived_at IS NULL
      WHERE cs.site_id = $1 AND cs.state = 'active'`, [siteId]));
  const needs = new Map<string, Need>();
  for (const r of rows) {
    let departureAt: Date | null = r.departure_at ? new Date(r.departure_at) : null;
    let neededWh: number | null = r.needed_wh != null ? Number(r.needed_wh) : null;
    if (!departureAt) {
      const soc = r.soc_percent != null ? Number(r.soc_percent) : null;
      let source: 'ocpp' | 'vehicle' | null = null;
      let fromNow = false; // worked out from the SoC now: the energy still to come, so what was delivered is added below
      if (r.ocpp_departure && new Date(r.ocpp_departure).getTime() > now.getTime()) {
        const cap = r.ev_capacity_wh != null ? Number(r.ev_capacity_wh) : null;
        neededWh = r.energy_request_wh != null ? Number(r.energy_request_wh)
          : cap && soc != null && r.ocpp_target_soc != null ? Math.round(((Number(r.ocpp_target_soc) - soc) / 100) * cap) : null;
        fromNow = r.energy_request_wh == null;
        departureAt = new Date(r.ocpp_departure); source = 'ocpp';
      } else if (r.vehicle_id && r.v_departure) {
        neededWh = r.target_kwh != null ? Math.round(Number(r.target_kwh) * 1000)
          : r.battery_kwh != null && r.target_soc_pct != null && soc != null ? Math.round(((Number(r.target_soc_pct) - soc) / 100) * Number(r.battery_kwh) * 1000) : null;
        fromNow = r.target_kwh == null;
        departureAt = nextDeparture(r.v_departure, new Date(r.started_at), tz); source = 'vehicle';
      }
      if (!source || !neededWh || neededWh <= 0) continue;
      if (fromNow) neededWh += Number(r.energy_wh ?? 0);
      await outsideRequestScope(() => query(
        `INSERT INTO session_departure (session_id, org_id, site_id, vehicle_id, departure_at, needed_wh, source) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (session_id) DO NOTHING`,
        [r.id, site.org_id, siteId, r.vehicle_id ?? null, departureAt, neededWh, source]));
    }
    if (departureAt && neededWh) needs.set(r.connector_uuid, { sessionId: r.id, connectorUuid: r.connector_uuid, neededWh, deliveredWh: Number(r.energy_wh ?? 0), departureAt });
  }
  return { needs, isPeak };
}

/** Keep each session's plan and estimated ready time; an alert once when a vehicle will not be ready. */
export async function recordPlans(siteId: string, plans: Plan[], allocations: Allocation[], needs: Map<string, Need>, now = new Date()): Promise<void> {
  const byConnector = new Map(allocations.filter((a) => a.connectorUuid).map((a) => [a.connectorUuid!, a.allocatedW]));
  const conOf = new Map([...needs.values()].map((n) => [n.sessionId, n.connectorUuid]));
  for (const p of plans) {
    const w = byConnector.get(conOf.get(p.sessionId) ?? '') ?? 0;
    const eta = p.remainingWh <= 0 ? now : w > 0 ? new Date(now.getTime() + (p.remainingWh / w) * 3_600_000) : null;
    const r = await outsideRequestScope(() => one<any>(
      `UPDATE session_departure SET plan_state = $2, required_w = $3, eta_at = $4, planned_at = $5 WHERE session_id = $1
        RETURNING org_id, alerted_at, (SELECT COALESCE(v.name, 'A vehicle') FROM fleet_vehicle v WHERE v.id = session_departure.vehicle_id) AS vehicle, departure_at`,
      [p.sessionId, p.state, p.requiredW, eta, now]));
    if (!r) continue;
    if (p.state === 'at_risk' && !r.alerted_at) {
      await outsideRequestScope(() => persistAlert({ orgId: r.org_id, kind: NOT_READY_ALERT, severity: 'warning', targetType: 'charging_session', targetId: p.sessionId,
        message: `${r.vehicle} will not be ready by its departure at ${new Date(r.departure_at).toISOString().slice(11, 16)} UTC: ${(p.remainingWh / 1000).toFixed(1)} kWh still needed. Operate → Depot charging.` }));
      await outsideRequestScope(() => query(`UPDATE session_departure SET alerted_at = now() WHERE session_id = $1`, [p.sessionId]));
    } else if (p.state === 'ready' && r.alerted_at) {
      await outsideRequestScope(() => resolveAlertsFor(r.org_id, NOT_READY_ALERT, 'charging_session', p.sessionId)).catch(() => 0);
    }
  }
}

// ------------------------------------------------------------------ the console

const vehicleOf = (r: any) => ({
  id: String(r.id), name: r.name, plate: r.plate ?? null, fleetAccountId: r.fleet_account_id ?? null, fleet: r.fleet_name ?? null, batteryKwh: r.battery_kwh == null ? null : Number(r.battery_kwh),
  tokenId: r.token_id ?? null, tokenUid: r.token_uid ?? null, departureTime: r.departure_time ?? null, targetSocPct: r.target_soc_pct ?? null, targetKwh: r.target_kwh == null ? null : Number(r.target_kwh),
});

export async function vehicles(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT v.*, f.name AS fleet_name, t.uid AS token_uid FROM fleet_vehicle v LEFT JOIN fleet_account f ON f.id = v.fleet_account_id LEFT JOIN token t ON t.id = v.token_id
      WHERE v.org_id = $1 AND v.archived_at IS NULL ORDER BY v.name, v.id`, [orgId]));
  return rows.map(vehicleOf);
}

export async function saveVehicle(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await outsideRequestScope(() => one<any>(`SELECT * FROM fleet_vehicle WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new DepotError(404, 'No such vehicle.');
  if (cur && b.archive === true) {
    await outsideRequestScope(() => query(`UPDATE fleet_vehicle SET archived_at = now() WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const pick = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const name = String(pick('name', 'name') ?? '').trim().slice(0, 80);
  if (!name) throw new DepotError(422, 'name is required (a fleet number or the plate).');
  const plateRaw = pick('plate', 'plate');
  const plate = plateRaw ? String(plateRaw).trim().toUpperCase().slice(0, 20) : null;
  const num = (v: unknown, what: string, max: number) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!(n > 0 && n <= max)) throw new DepotError(422, `${what} is a number up to ${max}.`);
    return n;
  };
  const batteryKwh = num(pick('batteryKwh', 'battery_kwh'), 'batteryKwh', 2000);
  const targetKwh = num(pick('targetKwh', 'target_kwh'), 'targetKwh', 2000);
  const socRaw = pick('targetSocPct', 'target_soc_pct');
  const targetSocPct = socRaw === undefined || socRaw === null || socRaw === '' ? null : Number(socRaw);
  if (targetSocPct !== null && !(Number.isInteger(targetSocPct) && targetSocPct >= 10 && targetSocPct <= 100)) throw new DepotError(422, 'targetSocPct is 10 to 100.');
  if (targetSocPct !== null && !batteryKwh) throw new DepotError(422, 'A target state of charge needs the battery size (batteryKwh).');
  const depRaw = pick('departureTime', 'departure_time');
  const departureTime = depRaw ? String(depRaw).trim() : null;
  if (departureTime && !TIME_RE.test(departureTime)) throw new DepotError(422, 'departureTime is HH:MM (24 h, the site\'s time).');
  if (departureTime && !targetKwh && targetSocPct === null) throw new DepotError(422, 'A usual departure needs a target: targetKwh, or targetSocPct with the battery size.');
  const fleetRaw = pick('fleetAccountId', 'fleet_account_id');
  const fleetAccountId = fleetRaw ? String(fleetRaw) : null;
  if (fleetAccountId && !(UUID_RE.test(fleetAccountId) && await outsideRequestScope(() => one(`SELECT 1 FROM fleet_account WHERE id = $1 AND org_id = $2`, [fleetAccountId, orgId])))) throw new DepotError(422, 'No such fleet account.');
  const tokenRaw = pick('tokenId', 'token_id');
  const tokenId = tokenRaw ? String(tokenRaw) : null;
  if (tokenId && !(UUID_RE.test(tokenId) && await outsideRequestScope(() => one(`SELECT 1 FROM token WHERE id = $1 AND org_id = $2`, [tokenId, orgId])))) throw new DepotError(422, 'No such card.');
  const vals = [orgId, fleetAccountId, name, plate, batteryKwh, tokenId, departureTime, targetSocPct, targetKwh];
  try {
    const r = cur
      ? await outsideRequestScope(() => one<any>(`UPDATE fleet_vehicle SET fleet_account_id = $2, name = $3, plate = $4, battery_kwh = $5, token_id = $6, departure_time = $7, target_soc_pct = $8, target_kwh = $9
          WHERE id = $10 AND org_id = $1 RETURNING *`, [...vals, cur.id]))
      : await outsideRequestScope(() => one<any>(`INSERT INTO fleet_vehicle (org_id, fleet_account_id, name, plate, battery_kwh, token_id, departure_time, target_soc_pct, target_kwh)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, vals));
    return vehicleOf(r);
  } catch (e: any) {
    if (e?.code === '23505') throw new DepotError(409, 'That card is already another vehicle\'s.');
    throw e;
  }
}

/** Set (or change) a session's departure by hand. */
export async function setDeparture(orgId: string, sessionId: string, b: Record<string, unknown>) {
  if (!UUID_RE.test(sessionId)) throw new DepotError(404, 'No such session.');
  const s = await outsideRequestScope(() => one<any>(`SELECT cs.id, cs.site_id, cs.state, cs.energy_wh FROM charging_session cs WHERE cs.id = $1 AND cs.org_id = $2`, [sessionId, orgId]));
  if (!s) throw new DepotError(404, 'No such session.');
  if (s.state !== 'active') throw new DepotError(409, 'The session has ended.');
  const at = new Date(String(b.departureAt ?? ''));
  if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() + 5 * 60_000 || at.getTime() > Date.now() + 7 * 86_400_000) throw new DepotError(422, 'departureAt is a time between 5 minutes and 7 days from now.');
  const kwh = Number(b.neededKwh);
  if (!(kwh > 0 && kwh <= 2000)) throw new DepotError(422, 'neededKwh: the energy this session must deliver in all (kWh).');
  await outsideRequestScope(() => query(
    `INSERT INTO session_departure (session_id, org_id, site_id, departure_at, needed_wh, source) VALUES ($1, $2, $3, $4, $5, 'console')
     ON CONFLICT (session_id) DO UPDATE SET departure_at = EXCLUDED.departure_at, needed_wh = EXCLUDED.needed_wh, source = 'console', alerted_at = NULL`,
    [sessionId, orgId, s.site_id, at, Math.round(kwh * 1000)]));
  return { sessionId, departureAt: at.toISOString(), neededKwh: kwh };
}

export async function setSite(orgId: string, siteId: string, enabled: unknown) {
  if (!UUID_RE.test(siteId)) throw new DepotError(404, 'No such site.');
  const r = await outsideRequestScope(() => one(`UPDATE site SET depot_scheduling = $3 WHERE id = $1 AND org_id = $2 RETURNING id`, [siteId, orgId, enabled === true]));
  if (!r) throw new DepotError(404, 'No such site.');
  return { siteId, depotScheduling: enabled === true };
}

/** Every site, its depot setting, and its active sessions with a departure and the plan. */
export async function overview(orgId: string, now = new Date()) {
  const sites = await outsideRequestScope(() => many<any>(`SELECT id, name, depot_scheduling FROM site WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`, [orgId]));
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT d.*, cs.energy_wh, cs.started_at, cs.soc_percent, v.name AS vehicle, v.plate, cp.display_name, cp.ocpp_identity
       FROM session_departure d JOIN charging_session cs ON cs.id = d.session_id
       LEFT JOIN fleet_vehicle v ON v.id = d.vehicle_id LEFT JOIN charge_point cp ON cp.id = cs.charge_point_id
      WHERE d.org_id = $1 AND cs.state = 'active' ORDER BY d.departure_at`, [orgId]));
  const active = await outsideRequestScope(() => many<any>(
    `SELECT cs.id, cs.site_id, cs.started_at, cs.energy_wh, cp.display_name, cp.ocpp_identity FROM charging_session cs JOIN charge_point cp ON cp.id = cs.charge_point_id
      JOIN site s ON s.id = cs.site_id WHERE cs.org_id = $1 AND cs.state = 'active' AND s.depot_scheduling
        AND NOT EXISTS (SELECT 1 FROM session_departure d WHERE d.session_id = cs.id) ORDER BY cs.started_at`, [orgId]));
  return {
    sites: sites.map((s) => ({ id: s.id, name: s.name, depotScheduling: s.depot_scheduling })),
    sessions: rows.map((r) => ({
      sessionId: r.session_id, siteId: r.site_id, vehicle: r.vehicle ?? null, plate: r.plate ?? null, charger: r.display_name ?? r.ocpp_identity, source: r.source,
      departureAt: new Date(r.departure_at).toISOString(), neededKwh: Number(r.needed_wh) / 1000, deliveredKwh: Number(r.energy_wh ?? 0) / 1000, socPct: r.soc_percent == null ? null : Number(r.soc_percent),
      state: r.plan_state, requiredKw: r.required_w == null ? null : Number(r.required_w) / 1000, etaAt: r.eta_at ? new Date(r.eta_at).toISOString() : null,
      late: r.eta_at ? new Date(r.eta_at).getTime() > new Date(r.departure_at).getTime() : null,
    })),
    without: active.map((a) => ({ sessionId: a.id, siteId: a.site_id, charger: a.display_name ?? a.ocpp_identity, startedAt: new Date(a.started_at).toISOString(), deliveredKwh: Number(a.energy_wh ?? 0) / 1000 })),
    vehicles: await vehicles(orgId),
    now: now.toISOString(),
  };
}




