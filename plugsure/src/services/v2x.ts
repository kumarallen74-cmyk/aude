import type { PoolClient } from 'pg';
import { defaultTimezone } from '../domain/timezone.js';
import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import * as registry from '../ocpp/registry.js';
import { EXPORT_MEASURAND, energyWhFrom, socFrom, type CanonicalMeterValue } from '../domain/canonical.js';

/**
 * ISO 15118-20 charging needs and bidirectional charging (V2G / V2B).
 *
 * What the car says. Over ISO 15118 the car tells the charger how it can take
 * (and give) energy, when the driver leaves, how much energy it wants and its
 * state of charge; the charger passes that on (NotifyEVChargingNeeds, OCPP
 * 2.0.1 and 2.1). A car that offers bidirectional power transfer (DC_BPT,
 * AC_BPT) can be asked to discharge — on OCPP 2.1 only, which is the first
 * version that can carry a discharge setpoint.
 *
 * What the operator allows (per site). A bidirectional programme: the hours
 * cars may give energy back (typically PLN's evening peak), how much in total,
 * the battery floor, and the credit per kWh the driver earns. By default
 * NOTHING flows back to the grid: without a PLN export agreement, discharge is
 * capped at the site's own auxiliary load (the reserve set in load management),
 * so the car only covers what the building would otherwise draw (V2B).
 *
 * What the driver agrees to. Nothing discharges without consent: the driver
 * switches it on for a session in the app (with their own battery floor), or a
 * fleet gives standing consent for its cards. Consent fixes the credit rate.
 *
 * Who decides. Site load management (smartcharging.ts) asks planSite() on
 * every pass, and sends the chosen sessions a discharge setpoint instead of a
 * charging limit. Discharge stops at the floor, an hour before the driver's
 * departure, outside the programme's hours, or when consent is withdrawn.
 */

export const MIN_DISCHARGE_W = 1_000;
export const DEPARTURE_MARGIN_MIN = 60;
/** Once stopped at the floor, discharge resumes only this far above it. */
export const RESUME_MARGIN_PERCENT = 2;
const BPT = /BPT/;

/** Does this charger speak OCPP 2.1? The live connection when this process holds it, else what it booted with. */
const speaks21 = (ocppIdentity: string, storedVersion: string | null) =>
  (registry.get(ocppIdentity)?.version ?? registry.versionOf(ocppIdentity) ?? storedVersion) === 'ocpp2.1';

// ─────────────────────────────────────────────── the car's needs

export interface ChargingNeeds {
  requestedTransfer: string;
  availableTransfer: string[];
  bidirectional: boolean;
  controlMode: string | null;
  departureTime: Date | null;
  energyRequestWh: number | null;
  socPercent: number | null;
  targetSocPercent: number | null;
  evCapacityWh: number | null;
  maxChargePowerW: number | null;
  maxDischargePowerW: number | null;
  minV2xEnergyWh: number | null;
}

const num = (v: unknown): number | null => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
const intAbs = (v: unknown): number | null => { const n = num(v); return n === null ? null : Math.round(Math.abs(n)); };
const pct = (v: unknown): number | null => { const n = num(v); return n === null || n < 0 || n > 100 ? null : n; };

/** A NotifyEVChargingNeeds payload (2.0.1 or 2.1) as one flat record. */
export function parseChargingNeeds(p: any): ChargingNeeds {
  const cn = p?.chargingNeeds ?? {};
  const ac = cn.acChargingParameters ?? {};
  const dc = cn.dcChargingParameters ?? {};
  const v2x = cn.v2xChargingParameters ?? {};
  const requested = String(cn.requestedEnergyTransfer ?? '');
  const available: string[] = Array.isArray(cn.availableEnergyTransfer) && cn.availableEnergyTransfer.length
    ? cn.availableEnergyTransfer.map(String) : [requested];
  const departure = cn.departureTime ? new Date(cn.departureTime) : null;
  return {
    requestedTransfer: requested,
    availableTransfer: [...new Set(available)],
    bidirectional: [requested, ...available].some((m) => BPT.test(m)),
    controlMode: cn.controlMode ? String(cn.controlMode) : null,
    departureTime: departure && !Number.isNaN(departure.getTime()) ? departure : null,
    energyRequestWh: intAbs(dc.energyAmount ?? ac.energyAmount ?? v2x.evTargetEnergyRequest),
    socPercent: pct(dc.stateOfCharge),
    targetSocPercent: pct(v2x.targetSoC ?? dc.fullSoC),
    evCapacityWh: intAbs(dc.evEnergyCapacity),
    maxChargePowerW: intAbs(v2x.maxChargePower ?? dc.evMaxPower),
    // Discharge figures are sometimes sent negative (power leaving the car); the magnitude is what counts.
    maxDischargePowerW: intAbs(v2x.maxDischargePower),
    minV2xEnergyWh: intAbs(v2x.evMinV2XEnergyRequest),
  };
}

// ─────────────────────────────────────────────── the operator's programme

export interface Window { from: string; to: string }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validate discharge windows ("HH:MM" local time; to < from wraps midnight; "00:00"–"00:00" is all day). */
export function parseWindows(v: unknown): Window[] | string {
  if (v == null || v === '') return [];
  if (!Array.isArray(v)) return 'windows must be a list of {from, to}';
  if (v.length > 6) return 'at most 6 windows';
  const out: Window[] = [];
  for (const w of v) {
    const from = String((w as any)?.from ?? '');
    const to = String((w as any)?.to ?? '');
    if (!HHMM.test(from) || !HHMM.test(to)) return 'each window needs from and to as HH:MM (24-hour)';
    out.push({ from, to });
  }
  return out;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes past local midnight in a time zone. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

export function inWindow(windows: Window[], now: Date, timeZone: string): boolean {
  const t = localMinutes(now, timeZone || defaultTimezone('ID'));
  return windows.some((w) => {
    const a = minutes(w.from);
    const b = minutes(w.to);
    if (a === b) return true; // all day
    return a < b ? t >= a && t < b : t >= a || t < b;
  });
}

// ─────────────────────────────────────────────── who discharges, how much

export interface SiteV2x {
  enabled: boolean;
  windows: Window[];
  maxDischargeW: number | null;
  allowExport: boolean;
  timezone: string;
}

export interface Candidate {
  sessionId: string;
  connectorUuid: string;
  consent: boolean;
  /** The charger speaks OCPP 2.1 (the first version that can carry a discharge setpoint). */
  protocolOk: boolean;
  bidirectional: boolean;
  evMaxDischargeW: number | null;
  connectorMaxW: number;
  socPercent: number | null;
  floorPercent: number;
  departureTime: Date | null;
  /** Discharging on the previous pass (for the resume margin). */
  wasDischarging: boolean;
}

export type Plan = Map<string, { dischargeW: number } | { reason: string }>;

/**
 * Pure: who may discharge now and how much. The pool is the programme's cap,
 * and without export only the site's own auxiliary load; it is shared equally
 * among eligible cars, each capped by what the car and the connector can do.
 */
export function planDischarge(site: SiteV2x, candidates: Candidate[], buildingLoadW: number, now: Date): Plan {
  const plan: Plan = new Map();
  const why = (c: Candidate, reason: string) => plan.set(c.sessionId, { reason });
  const eligible: Array<{ c: Candidate; cap: number }> = [];
  const open = site.enabled && inWindow(site.windows, now, site.timezone);
  for (const c of candidates) {
    if (!c.consent) { why(c, 'no consent'); continue; }
    if (!site.enabled) { why(c, 'bidirectional charging is off at this site'); continue; }
    if (!c.bidirectional || (c.evMaxDischargeW ?? 0) < MIN_DISCHARGE_W) { why(c, 'the car did not offer to discharge'); continue; }
    if (!c.protocolOk) { why(c, 'the charger does not speak OCPP 2.1'); continue; }
    if (!open) { why(c, 'outside the discharge hours'); continue; }
    if (c.socPercent === null) { why(c, 'battery level unknown'); continue; }
    const floor = c.floorPercent + (c.wasDischarging ? 0 : RESUME_MARGIN_PERCENT);
    if (c.socPercent <= floor) { why(c, `battery at or below ${c.floorPercent}%`); continue; }
    if (c.departureTime && c.departureTime.getTime() - now.getTime() < DEPARTURE_MARGIN_MIN * 60_000) { why(c, 'the driver leaves within the hour'); continue; }
    eligible.push({ c, cap: Math.min(c.evMaxDischargeW!, c.connectorMaxW) });
  }
  let pool = site.maxDischargeW ?? Infinity;
  if (!site.allowExport) pool = Math.min(pool, Math.max(0, buildingLoadW));
  if (eligible.length && pool < MIN_DISCHARGE_W) {
    for (const e of eligible) why(e.c, site.allowExport ? 'the site discharge limit is too low' : 'no building load to cover (set the auxiliary load in load management, or allow export)');
    return plan;
  }
  // Water-fill: equal shares, capped per car; what a capped car cannot take goes to the others.
  const give = new Map<string, number>();
  let left = pool;
  let rest = [...eligible].sort((a, b) => a.cap - b.cap);
  while (rest.length && left > 0) {
    const share = left / rest.length;
    const e = rest[0]!;
    if (e.cap <= share) { give.set(e.c.sessionId, e.cap); left -= e.cap; rest = rest.slice(1); continue; }
    for (const r of rest) give.set(r.c.sessionId, share);
    left = 0;
    rest = [];
  }
  for (const e of eligible) {
    const w = Math.floor(give.get(e.c.sessionId) ?? 0);
    plan.set(e.c.sessionId, w >= MIN_DISCHARGE_W ? { dischargeW: w } : { reason: 'share of the site discharge limit below 1 kW' });
  }
  return plan;
}

/** The driver's credit for energy given back, in rupiah (whole rupiah, rounded down). */
export const creditMinor = (exportWh: number, rateIdrPerKwh: number | null | undefined) =>
  Math.max(0, Math.floor((Math.max(0, exportWh) / 1000) * Math.max(0, rateIdrPerKwh ?? 0)));

// ─────────────────────────────────────────────── recording what the charger reports

const sessionOnEvse = (chargePointId: string, evseId: number) =>
  one<{ id: string }>(
    `SELECT cs.id FROM charging_session cs
       JOIN connector c ON c.id = cs.connector_uuid
       JOIN evse e ON e.id = c.evse_uuid
      WHERE cs.charge_point_id = $1 AND e.evse_id = $2 AND cs.state = 'active'
      ORDER BY cs.started_at DESC LIMIT 1`,
    [chargePointId, evseId],
  );

/** NotifyEVChargingNeeds: store, link to the running session, apply fleet consent, re-plan the site. */
export async function recordChargingNeeds(ctx: { chargePointId: string; orgId: string }, p: any): Promise<{ sessionId: string | null; needs: ChargingNeeds }> {
  const n = parseChargingNeeds(p);
  const evseId = Number(p?.evseId ?? 0);
  const s = await sessionOnEvse(ctx.chargePointId, evseId);
  await query(
    `INSERT INTO ev_charging_needs (org_id, charge_point_id, evse_id, session_id, requested_transfer, available_transfer, bidirectional,
       control_mode, departure_time, energy_request_wh, soc_percent, target_soc_percent, ev_capacity_wh, max_charge_power_w,
       max_discharge_power_w, min_v2x_energy_wh, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [ctx.orgId, ctx.chargePointId, evseId, s?.id ?? null, n.requestedTransfer, n.availableTransfer, n.bidirectional, n.controlMode,
      n.departureTime, n.energyRequestWh, n.socPercent, n.targetSocPercent, n.evCapacityWh, n.maxChargePowerW, n.maxDischargePowerW,
      n.minV2xEnergyWh, JSON.stringify(p?.chargingNeeds ?? {})],
  );
  if (s) {
    if (n.socPercent !== null) await query(`UPDATE charging_session SET soc_percent = $2, soc_at = now() WHERE id = $1`, [s.id, n.socPercent]);
    await applyFleetConsent(s.id);
  }
  return { sessionId: s?.id ?? null, needs: n };
}

/** A session that started after the car's needs arrived takes them over (the usual ISO 15118 order is either). */
export async function attachNeeds(sessionId: string, chargePointId: string, evseId: number): Promise<void> {
  await query(
    `UPDATE ev_charging_needs SET session_id = $1
      WHERE charge_point_id = $2 AND evse_id = $3 AND session_id IS NULL AND received_at > now() - interval '30 minutes'`,
    [sessionId, chargePointId, evseId],
  );
  await query(
    `UPDATE charging_session cs SET soc_percent = n.soc_percent, soc_at = n.received_at
       FROM (SELECT soc_percent, received_at FROM ev_charging_needs WHERE session_id = $1 AND soc_percent IS NOT NULL
              ORDER BY received_at DESC LIMIT 1) n
      WHERE cs.id = $1 AND cs.soc_percent IS NULL`,
    [sessionId],
  );
}

/** NotifyEVChargingSchedule: the schedule the car chose, kept with its latest needs. */
export async function recordEvSchedule(ctx: { chargePointId: string }, p: any): Promise<void> {
  await query(
    `UPDATE ev_charging_needs SET ev_schedule = $3, ev_schedule_at = now()
      WHERE id = (SELECT id FROM ev_charging_needs WHERE charge_point_id = $1 AND evse_id = $2 ORDER BY received_at DESC LIMIT 1)`,
    [ctx.chargePointId, Number(p?.evseId ?? 0), JSON.stringify({ timeBase: p?.timeBase, chargingSchedule: p?.chargingSchedule, selectedChargingScheduleId: p?.selectedChargingScheduleId ?? null })],
  );
}

/** NotifyChargingLimit / ClearedChargingLimit: a limit someone else set on the station (null = cleared). */
export async function recordExternalLimit(chargePointId: string, limit: Record<string, unknown> | null): Promise<void> {
  await query(`UPDATE charge_point SET external_limit = $2 WHERE id = $1`, [chargePointId, limit ? JSON.stringify({ ...limit, at: new Date().toISOString() }) : null]);
}

/**
 * Exported energy and SoC from a transaction's meter values. The export
 * register is kept beside the import one and never touches what is billed for
 * charging. Returns the site to re-plan when a discharging car reached its floor.
 */
export async function trackMeter(
  sessionId: string,
  mv: CanonicalMeterValue[],
  operationMode: string | undefined,
  client?: PoolClient,
): Promise<{ replanSiteId: string | null }> {
  const exportWh = energyWhFrom(mv, EXPORT_MEASURAND);
  const soc = socFrom(mv);
  if (exportWh === null && soc === null && !operationMode) return { replanSiteId: null };
  const q = client ? client.query.bind(client) : query;
  const r = await q(
    `WITH prev AS (SELECT soc_percent FROM charging_session WHERE id = $1)
     UPDATE charging_session
        SET export_start_wh = COALESCE(export_start_wh, $2::bigint),
            energy_export_wh = GREATEST(energy_export_wh, $2::bigint - COALESCE(export_start_wh, $2::bigint)),
            soc_percent = COALESCE($3::numeric, soc_percent),
            soc_at = CASE WHEN $3::numeric IS NULL THEN soc_at ELSE now() END,
            operation_mode = COALESCE($4, operation_mode)
      WHERE id = $1
      RETURNING site_id, soc_percent, v2x_discharging, v2x_min_soc_percent, v2x_consent, (SELECT soc_percent FROM prev) AS prev_soc`,
    [sessionId, exportWh, soc, operationMode ?? null],
  );
  const row = r.rows[0] as { site_id: string; soc_percent: string | null; v2x_discharging: boolean; v2x_min_soc_percent: number | null; v2x_consent: boolean; prev_soc: string | null } | undefined;
  const atFloor = row?.v2x_discharging && row.soc_percent !== null && Number(row.soc_percent) <= Number(row.v2x_min_soc_percent ?? 100);
  // AC cars send no SoC with their charging needs: the first reading from the meter can make a consenting car eligible.
  const socNowKnown = !!row?.v2x_consent && !row.v2x_discharging && row.prev_soc === null && row.soc_percent !== null;
  return { replanSiteId: atFloor || socNowKnown ? row!.site_id : null };
}

// ─────────────────────────────────────────────── consent

/** A fleet's standing consent, for a session by one of its cards at a site with a programme. */
export async function applyFleetConsent(sessionId: string): Promise<boolean> {
  const r = await query(
    `UPDATE charging_session cs
        SET v2x_consent = true, v2x_consent_source = 'fleet',
            v2x_min_soc_percent = GREATEST(s.v2x_min_soc_percent, f.v2x_min_soc_percent),
            v2x_credit_minor_per_kwh = s.v2x_credit_minor_per_kwh
       FROM token t, fleet_account f, site s
      WHERE cs.id = $1 AND cs.state = 'active' AND NOT cs.v2x_consent
        AND t.id = cs.token_id AND f.id = t.fleet_account_id AND f.v2x_allowed
        AND s.id = cs.site_id AND s.v2x_enabled`,
    [sessionId],
  );
  return (r.rowCount ?? 0) > 0;
}

export class V2xError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * The driver switches discharge on or off for their session, with their own
 * floor (never below the site's). On: the credit rate is fixed now.
 */
export async function setDriverConsent(sessionId: string, enabled: boolean, minSocPercent?: number | null) {
  const s = await one<{ state: string; site_min: number; enabled: boolean; rate: number; bidirectional: boolean | null }>(
    `SELECT cs.state, s.v2x_min_soc_percent AS site_min, s.v2x_enabled AS enabled, s.v2x_credit_minor_per_kwh AS rate,
            (SELECT bool_or(bidirectional) FROM ev_charging_needs WHERE session_id = cs.id) AS bidirectional
       FROM charging_session cs JOIN site s ON s.id = cs.site_id WHERE cs.id = $1`,
    [sessionId],
  );
  if (!s) throw new V2xError(404, 'session not found');
  if (s.state !== 'active') throw new V2xError(409, 'the session has ended');
  if (enabled && !s.enabled) throw new V2xError(409, 'this site does not take energy back from cars');
  if (enabled && !s.bidirectional) throw new V2xError(409, 'your car has not offered to give energy back on this charger');
  const floor = minSocPercent == null ? s.site_min : Math.round(Number(minSocPercent));
  if (enabled && (!Number.isFinite(floor) || floor < s.site_min || floor > 95)) throw new V2xError(400, `the battery floor must be between ${s.site_min}% and 95%`);
  await query(
    enabled
      ? `UPDATE charging_session SET v2x_consent = true, v2x_consent_source = 'driver', v2x_min_soc_percent = $2, v2x_credit_minor_per_kwh = $3 WHERE id = $1`
      : `UPDATE charging_session SET v2x_consent = false, v2x_consent_source = NULL WHERE id = $1`,
    enabled ? [sessionId, floor, s.rate] : [sessionId],
  );
  void announceAllowedTransfer(sessionId, enabled).catch((e) => logger.warn({ sessionId, err: String(e) }, 'allowed energy transfer not sent'));
  // Load management takes the new answer into account now, not on its next tick.
  void import('./sessions.js').then((m) => m.replanSoon(sessionId)).catch(() => undefined);
  return v2xView(sessionId);
}

/** Tell a 2.1 station which transfer modes the car may use now: without the bidirectional ones unless the driver agreed. */
async function announceAllowedTransfer(sessionId: string, consent: boolean): Promise<void> {
  const r = await one<{ ocpp_identity: string; ocpp_version: string | null; ocpp_transaction_id: string | null; org_id: string; available: string[] | null }>(
    `SELECT cp.ocpp_identity, cp.ocpp_version, cs.ocpp_transaction_id, cs.org_id,
            (SELECT available_transfer FROM ev_charging_needs WHERE session_id = cs.id ORDER BY received_at DESC LIMIT 1) AS available
       FROM charging_session cs JOIN charge_point cp ON cp.id = cs.charge_point_id WHERE cs.id = $1`,
    [sessionId],
  );
  if (!r?.ocpp_transaction_id || !r.available?.length) return;
  if (!speaks21(r.ocpp_identity, r.ocpp_version)) return;
  const modes = consent ? r.available : r.available.filter((m) => !BPT.test(m));
  if (!modes.length) return;
  const { notifyAllowedEnergyTransfer } = await import('../ocpp/commands.js');
  await notifyAllowedEnergyTransfer(r.ocpp_identity, r.ocpp_transaction_id, modes, { type: 'system', orgId: r.org_id });
}

// ─────────────────────────────────────────────── the site plan (for load management)

export interface SitePlanResult {
  /** connector uuid → discharge power and the car's control mode. */
  discharge: Map<string, { sessionId: string; dischargeW: number; dynamic: boolean }>;
}

/**
 * Plan the site's discharge for this pass and record, per session, whether it
 * discharges and why not. Called by runControlLoop before charging power is
 * allocated; a discharging session takes no charging power.
 */
export async function planSite(siteId: string, buildingLoadW: number, now = new Date()): Promise<SitePlanResult> {
  const site = await one<{ v2x_enabled: boolean; v2x_windows: Window[]; v2x_max_discharge_w: number | null; v2x_allow_export: boolean; timezone: string | null }>(
    `SELECT v2x_enabled, v2x_windows, v2x_max_discharge_w, v2x_allow_export, timezone FROM site WHERE id = $1`, [siteId]);
  const result: SitePlanResult = { discharge: new Map() };
  if (!site) return result;
  const rows = await many<{
    id: string; connector_uuid: string; ocpp_identity: string; ocpp_version: string | null; max_power_w: number; soc_percent: string | null; v2x_consent: boolean;
    v2x_min_soc_percent: number | null; v2x_discharging: boolean; bidirectional: boolean | null; max_discharge_power_w: number | null;
    departure_time: Date | null; control_mode: string | null;
  }>(
    `SELECT cs.id, cs.connector_uuid, cp.ocpp_identity, cp.ocpp_version, c.max_power_w, cs.soc_percent, cs.v2x_consent, cs.v2x_min_soc_percent, cs.v2x_discharging,
            n.bidirectional, n.max_discharge_power_w, n.departure_time, n.control_mode
       FROM charging_session cs
       JOIN charge_point cp ON cp.id = cs.charge_point_id
       JOIN connector c ON c.id = cs.connector_uuid
       LEFT JOIN LATERAL (SELECT bidirectional, max_discharge_power_w, departure_time, control_mode FROM ev_charging_needs
                           WHERE session_id = cs.id ORDER BY received_at DESC LIMIT 1) n ON true
      WHERE cs.site_id = $1 AND cs.state = 'active' AND (cs.v2x_consent OR cs.v2x_discharging OR n.bidirectional)`,
    [siteId],
  );
  if (!rows.length) return result;
  const cands: Candidate[] = rows.map((r) => ({
    sessionId: r.id,
    connectorUuid: r.connector_uuid,
    consent: r.v2x_consent,
    protocolOk: speaks21(r.ocpp_identity, r.ocpp_version),
    bidirectional: !!r.bidirectional,
    evMaxDischargeW: r.max_discharge_power_w,
    connectorMaxW: Number(r.max_power_w),
    socPercent: r.soc_percent === null ? null : Number(r.soc_percent),
    floorPercent: r.v2x_min_soc_percent ?? 100,
    departureTime: r.departure_time ? new Date(r.departure_time) : null,
    wasDischarging: r.v2x_discharging,
  }));
  const plan = planDischarge(
    { enabled: site.v2x_enabled, windows: parseWindowsOr(site.v2x_windows), maxDischargeW: site.v2x_max_discharge_w, allowExport: site.v2x_allow_export, timezone: site.timezone ?? defaultTimezone('ID') },
    cands, buildingLoadW, now,
  );
  for (const r of rows) {
    const p = plan.get(r.id);
    const w = p && 'dischargeW' in p ? p.dischargeW : null;
    if (w) result.discharge.set(r.connector_uuid, { sessionId: r.id, dischargeW: w, dynamic: r.control_mode === 'DynamicControl' });
    await query(
      `UPDATE charging_session SET v2x_discharging = $2, v2x_discharge_w = $3, v2x_stop_reason = $4 WHERE id = $1`,
      [r.id, w !== null, w, p && 'reason' in p && r.v2x_consent ? p.reason : null],
    );
    if (w !== null && !r.v2x_discharging) logger.info({ sessionId: r.id, dischargeW: w }, 'bidirectional: session starts giving energy back');
    if (w === null && r.v2x_discharging) logger.info({ sessionId: r.id, reason: p && 'reason' in p ? p.reason : '' }, 'bidirectional: session stops giving energy back');
  }
  return result;
}

const parseWindowsOr = (v: unknown): Window[] => { const w = parseWindows(v); return typeof w === 'string' ? [] : w; };

// ─────────────────────────────────────────────── what the console and the app show

export async function v2xView(sessionId: string) {
  const s = await one<any>(
    `SELECT cs.id, cs.state, cs.energy_export_wh, cs.soc_percent, cs.soc_at, cs.v2x_consent, cs.v2x_consent_source, cs.v2x_min_soc_percent,
            cs.v2x_credit_minor_per_kwh, cs.v2x_discharging, cs.v2x_discharge_w, cs.v2x_stop_reason, cs.operation_mode,
            s.v2x_enabled AS site_enabled, s.v2x_min_soc_percent AS site_min_soc, s.v2x_credit_minor_per_kwh AS site_credit, s.v2x_windows AS site_windows
       FROM charging_session cs JOIN site s ON s.id = cs.site_id WHERE cs.id = $1`,
    [sessionId],
  );
  if (!s) return null;
  const n = await one<any>(
    `SELECT received_at, requested_transfer, available_transfer, bidirectional, control_mode, departure_time, energy_request_wh,
            soc_percent, target_soc_percent, ev_capacity_wh, max_charge_power_w, max_discharge_power_w, ev_schedule IS NOT NULL AS has_ev_schedule
       FROM ev_charging_needs WHERE session_id = $1 ORDER BY received_at DESC LIMIT 1`,
    [sessionId],
  );
  const exportWh = Number(s.energy_export_wh ?? 0);
  return {
    sessionId: s.id,
    siteProgramme: { enabled: s.site_enabled, minSocPercent: s.site_min_soc, creditMinorPerKwh: s.site_credit, windows: s.site_windows },
    needs: n ? {
      receivedAt: n.received_at,
      requestedTransfer: n.requested_transfer,
      availableTransfer: n.available_transfer,
      bidirectional: n.bidirectional,
      controlMode: n.control_mode,
      departureTime: n.departure_time,
      energyRequestWh: n.energy_request_wh,
      targetSocPercent: n.target_soc_percent === null ? null : Number(n.target_soc_percent),
      evCapacityWh: n.ev_capacity_wh,
      maxChargePowerW: n.max_charge_power_w,
      maxDischargePowerW: n.max_discharge_power_w,
      evProposedSchedule: n.has_ev_schedule,
    } : null,
    socPercent: s.soc_percent === null ? null : Number(s.soc_percent),
    socAt: s.soc_at,
    exportWh,
    consent: s.v2x_consent,
    consentSource: s.v2x_consent_source,
    minSocPercent: s.v2x_min_soc_percent,
    creditMinorPerKwh: s.v2x_credit_minor_per_kwh,
    creditMinor: creditMinor(exportWh, s.v2x_credit_minor_per_kwh),
    discharging: s.v2x_discharging,
    dischargeW: s.v2x_discharge_w,
    notDischargingBecause: s.v2x_stop_reason,
    operationMode: s.operation_mode,
    // The driver can be asked: the site has a programme and the car offered to discharge.
    canOffer: !!s.site_enabled && !!n?.bidirectional && s.state === 'active',
  };
}
