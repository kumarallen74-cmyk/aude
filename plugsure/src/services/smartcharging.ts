import { many, one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import * as registry from '../ocpp/registry.js';
import { setChargingProfile, clearChargingProfile, getCompositeSchedule } from '../ocpp/commands.js';
import { resolveQuirks, pickRateUnit } from '../ocpp/quirks.js';
import { profileLimitAt, type ChargingProfileIn } from '../ocpi/mapping.js';
import { planSite, type SitePlanResult } from './v2x.js';

/**
 * Site load management.
 *
 * Three layers of defence, and only the bottom one actually guarantees the breaker:
 *
 *   Layer 3  this optimiser              cloud, seconds-to-minutes, tariff/priority aware
 *   Layer 2  OCPP SetChargingProfile     survives brief WAN loss via the charger's own copy
 *   Layer 1  charger-local DLB (RS485)   works with the WAN down  <-- the real guard
 *
 * Never build the site power budget on the assumption that OCPP smart charging
 * alone protects the incoming breaker. In Indonesia the WAN will be down.
 *
 * Why this sells here: the ROI is capacity-cost avoidance, not energy arbitrage.
 *   - rekening minimum = 40 x connected kVA x block cost, payable whether used or not
 *   - the 200 kVA TR/TM cliff: above it you buy a transformer, switchgear and MV metering
 *   - power factor can push you over the cliff on its own (168 kW = 177 kVA at PF 0.95,
 *     but 210 kVA at PF 0.80)
 */

export interface SiteBudget {
  siteId: string;
  ceilingW: number;
  reserveW: number;
  strategy: 'fair_share' | 'priority' | 'fifo';
  curtailed: boolean;
  connectedKva: number | null;
  powerFactor: number;
  phases: number;
  nominalVoltageV: number;
  /** Auxiliary loads the reserve is held for (DLM studio). */
  reserveBreakdown?: Record<string, number>;
  curtailedReason?: string | null;
  curtailedAt?: string | null;
  /** The stored ceiling before the subscription clamp, so the console can show a clamp happened. */
  configuredCeilingW?: number;
}

export interface Demand {
  ocppIdentity: string;
  chargePointId: string;
  connectorNo: number;
  /** Nameplate ceiling for this connector. */
  maxPowerW: number;
  /** Minimum useful rate. Below this, charging is better stopped than throttled. */
  minPowerW: number;
  currentType: 'AC' | 'DC';
  phases: number;
  /** Higher wins under the 'priority' strategy. */
  priority: number;
  /** Wire form (1.6 integer, 2.0.1 string) — see registry.wireTransactionId. */
  transactionId?: number | string;
  active: boolean;
  /** For the console's priority editor. Absent in unit tests. */
  connectorUuid?: string;
  connectorType?: string | null;
}

export interface Allocation extends Demand {
  allocatedW: number;
  /** AC hardware wants amps; DC wants watts. Converted at the adapter boundary. */
  unit: 'A' | 'W';
  limit: number;
}

const NOMINAL_PHASE_VOLTAGE = 230; // 230 V L-N / 400 V L-L, 50 Hz

export function wattsToAmps(w: number, phases: number): number {
  return Math.max(0, w / (phases * NOMINAL_PHASE_VOLTAGE));
}

export function ampsToWatts(a: number, phases: number): number {
  return a * phases * NOMINAL_PHASE_VOLTAGE;
}

/** kVA implied by a watt figure at the site's power factor. */
export function wattsToKva(w: number, powerFactor: number): number {
  return w / 1000 / Math.max(0.1, powerFactor);
}

/**
 * The hard real-power ceiling the site's SUBSCRIPTION supports: connected kVA x PF.
 * Drawing above this crosses the subscribed capacity — PLN over-limit / rekening
 * exposure and the 200 kVA TR->TM cliff — so it is the cap a configured ceiling
 * may never exceed. Returns Infinity when the subscribed capacity is unknown
 * (nothing to clamp against).
 */
export function subscriptionCeilingW(connectedKva: number | null | undefined, powerFactor: number): number {
  if (connectedKva == null) return Infinity;
  return Math.round(connectedKva * 1000 * Math.max(0.1, powerFactor));
}

/**
 * Clamp a configured ceiling so it can never exceed the subscribed capacity.
 *
 * A misconfigured `ceiling_w` set to (say) the full installed nameplate would let
 * the water-filling allocate past the subscription — defeating the whole point of
 * load management on an oversubscribed site. This makes the subscription the hard
 * upper bound regardless of what is stored.
 */
export function clampCeilingW(configuredW: number, connectedKva: number | null | undefined, powerFactor: number): number {
  return Math.min(configuredW, subscriptionCeilingW(connectedKva, powerFactor));
}

/**
 * Save-time guardrail for a budget change (SPEC Module 4, acceptance criterion 2).
 *
 * v1.2.1 clamped a too-high ceiling at READ time — safe, but the operator never
 * found out: the PUT answered 200 and stored the illegal value. The console now
 * rejects it at the source with the message the specification prescribes, and
 * the API refuses to store it. Returns null when the budget is acceptable.
 */
export function budgetProblem(
  b: { ceilingW: number; reserveW: number },
  connectedKva: number | null | undefined,
  powerFactor: number,
): { field: 'ceilingW' | 'reserveW'; message: string; maxW?: number } | null {
  if (!Number.isFinite(b.ceilingW) || b.ceilingW < 0) return { field: 'ceilingW', message: 'Ceiling must be a positive power in watts' };
  if (!Number.isFinite(b.reserveW) || b.reserveW < 0) return { field: 'reserveW', message: 'Reserve must be zero or more' };
  const maxW = subscriptionCeilingW(connectedKva, powerFactor);
  if (b.ceilingW > maxW) {
    return {
      field: 'ceilingW',
      maxW,
      message:
        `Exceeds ${connectedKva} kVA PLN contract limit. Clamped to prevent breaker trip. ` +
        `The maximum is ${connectedKva} kVA × ${powerFactor} PF = ${(maxW / 1000).toFixed(1)} kW.`,
    };
  }
  if (b.reserveW >= b.ceilingW && b.ceilingW > 0) {
    return { field: 'reserveW', message: 'The auxiliary reserve must be smaller than the ceiling, or no power is left for charging' };
  }
  return null;
}

/**
 * Fair-share allocation with a minimum-viable floor.
 *
 * Water-filling: give everyone an equal share, cap anyone at their nameplate,
 * redistribute the surplus. If the budget cannot give every session its minimum,
 * shed the lowest-priority sessions entirely rather than starving all of them —
 * a fleet of vehicles charging at 1 kW each is worse than half of them charging
 * properly.
 */
export function allocate(budgetW: number, demands: Demand[]): Allocation[] {
  const active = demands.filter((d) => d.active);
  const inactive = demands.filter((d) => !d.active);

  let pool = [...active].sort((a, b) => b.priority - a.priority || a.maxPowerW - b.maxPowerW);
  let shed: Demand[] = [];

  // Shed from the bottom until every survivor can get its minimum.
  while (pool.length > 0 && pool.reduce((s, d) => s + d.minPowerW, 0) > budgetW) {
    shed.push(pool.pop()!);
  }

  const result = new Map<Demand, number>();
  for (const d of shed) result.set(d, 0);

  let remaining = budgetW;
  let candidates = [...pool];
  for (const d of candidates) result.set(d, d.minPowerW);
  remaining -= candidates.reduce((s, d) => s + d.minPowerW, 0);

  // Water-fill the surplus above each session's minimum.
  let open = candidates.filter((d) => d.maxPowerW > d.minPowerW);
  while (remaining > 1 && open.length > 0) {
    const share = remaining / open.length;
    let consumed = 0;
    const stillOpen: Demand[] = [];
    for (const d of open) {
      const cur = result.get(d)!;
      const headroom = d.maxPowerW - cur;
      const give = Math.min(share, headroom);
      result.set(d, cur + give);
      consumed += give;
      if (headroom - give > 1) stillOpen.push(d);
    }
    remaining -= consumed;
    if (consumed < 1) break;
    open = stillOpen;
  }

  const toAllocation = (d: Demand): Allocation => {
    const w = Math.floor(result.get(d) ?? 0);
    const unit: 'A' | 'W' = d.currentType === 'AC' ? 'A' : 'W';
    return {
      ...d,
      allocatedW: w,
      unit,
      limit: unit === 'A' ? Math.round(wattsToAmps(w, d.phases) * 10) / 10 : w,
    };
  };

  return [...active.map(toAllocation), ...inactive.map((d) => ({ ...toAllocation(d), allocatedW: 0, limit: 0 }))];
}

// ------------------------------------------------------------------ execution

export async function loadSiteBudget(siteId: string): Promise<SiteBudget | null> {
  const row = await one<any>(
    `SELECT s.id AS site_id, s.connected_kva, s.power_factor, s.phases, s.nominal_voltage_v,
            b.ceiling_w, b.reserve_w, b.strategy, b.curtailed,
            b.reserve_breakdown, b.curtailed_reason, b.curtailed_at
       FROM site s
       LEFT JOIN site_power_budget b ON b.site_id = s.id
      WHERE s.id = $1`,
    [siteId],
  );
  if (!row) return null;

  const pf = Number(row.power_factor ?? 0.95);
  const connectedKva = row.connected_kva != null ? Number(row.connected_kva) : null;

  // Fall back to the subscribed capacity when no explicit budget is configured.
  const fallbackW = connectedKva != null ? subscriptionCeilingW(connectedKva, pf) : 22_000;

  // The subscription is the hard cap. A configured ceiling above connected_kVA x PF
  // (e.g. one accidentally set to the full installed nameplate) would let the site
  // draw past its subscribed capacity — exactly what load management must prevent —
  // so clamp it here and make the misconfiguration visible.
  const configuredW = row.ceiling_w ?? fallbackW;
  const effectiveW = clampCeilingW(configuredW, connectedKva, pf);
  if (effectiveW < configuredW) {
    logger.warn(
      { siteId: row.site_id, configuredCeilingW: configuredW, effectiveCeilingW: effectiveW, connectedKva, powerFactor: pf },
      'configured ceiling exceeds subscribed capacity (connected_kVA x PF) — clamping to protect the subscription',
    );
  }

  return {
    siteId: row.site_id,
    ceilingW: effectiveW,
    reserveW: row.reserve_w ?? 0,
    strategy: row.strategy ?? 'fair_share',
    curtailed: row.curtailed ?? false,
    connectedKva,
    powerFactor: pf,
    phases: row.phases ?? 3,
    nominalVoltageV: row.nominal_voltage_v ?? 400,
    reserveBreakdown: row.reserve_breakdown ?? {},
    curtailedReason: row.curtailed_reason ?? null,
    curtailedAt: row.curtailed_at ?? null,
    configuredCeilingW: configuredW,
  };
}

export async function collectDemands(siteId: string): Promise<Demand[]> {
  const rows = await many<any>(
    `SELECT cp.ocpp_identity, cp.id AS charge_point_id, e.evse_id AS connector_no,
            c.id AS connector_uuid, c.connector_type, c.priority,
            c.max_power_w, c.current_type, c.phases, c.status,
            cs.ocpp_transaction_id
       FROM charge_point cp
       JOIN evse e ON e.charge_point_id = cp.id
       JOIN connector c ON c.evse_uuid = e.id
       LEFT JOIN charging_session cs
              ON cs.connector_uuid = c.id AND cs.state = 'active'
      WHERE cp.site_id = $1
      ORDER BY cp.ocpp_identity, e.evse_id`,
    [siteId],
  );

  return rows.map((r) => ({
    ocppIdentity: r.ocpp_identity,
    chargePointId: r.charge_point_id,
    connectorNo: r.connector_no,
    maxPowerW: Number(r.max_power_w),
    minPowerW: r.current_type === 'AC' ? ampsToWatts(6, r.phases) : 5_000, // IEC 61851 floor is 6 A
    currentType: r.current_type,
    phases: r.phases,
    // Operator-ranked in the DLM studio (migration 009); 0 for every connector
    // nobody has ranked, which is exactly the v1.2.1 behaviour.
    priority: Number(r.priority ?? 0),
    connectorUuid: r.connector_uuid,
    connectorType: r.connector_type,
    // Wire form: 2.0.1 transaction ids are strings; Number() sent "NaN" and the
    // per-transaction limit never applied on 2.0.1 stations.
    transactionId: r.ocpp_transaction_id ? registry.wireTransactionId(r.ocpp_identity, r.ocpp_transaction_id) : undefined,
    /**
     * Active-for-allocation, which is broader than "currently drawing".
     *
     * `Preparing` was excluded, and OCPP 1.6 specifies exactly that state for
     * "plugged in, not yet energised". The result was a deadlock: an idle
     * station summed to 0 W, the loop sent a 0 A station ceiling, a charger held
     * at 0 A cannot energise, so it never reports Charging, so it is never
     * allocated any power. `Finishing` is included for the same reason — the
     * plug is still in and the connector is still committed.
     */
    active:
      r.status === 'Charging' ||
      r.status === 'SuspendedEV' ||
      r.status === 'SuspendedEVSE' ||
      r.status === 'Preparing' ||
      r.status === 'Finishing',
  }));
}

/**
 * Connector ranks only apply under the `priority` strategy. Under fair share
 * every session is equal, so a rank left over from an earlier configuration must
 * not quietly decide who is shed first.
 */
export function forStrategy(demands: Demand[], strategy: SiteBudget['strategy']): Demand[] {
  return strategy === 'priority' ? demands : demands.map((d) => ({ ...d, priority: 0 }));
}

/**
 * Roaming partners' charging limits (OCPI ChargingProfiles) for the sessions of
 * their drivers at this site, in watts, keyed by connector. A partner can only
 * lower what a session draws: the limit caps the connector's demand, and the
 * site budget still decides the rest.
 */
export async function partnerCapsW(siteId: string, now = new Date()): Promise<Map<string, number>> {
  const rows = await many<{ connector_uuid: string; started_at: Date; profile: ChargingProfileIn; phases: number | null }>(
    `SELECT cs.connector_uuid, cs.started_at, p.profile, c.phases
       FROM ocpi_charging_profile p
       JOIN charging_session cs ON cs.id = p.session_id AND cs.state = 'active'
       JOIN connector c ON c.id = cs.connector_uuid
      WHERE cs.site_id = $1`,
    [siteId],
  );
  const caps = new Map<string, number>();
  for (const r of rows) {
    const limit = profileLimitAt(r.profile, now, new Date(r.started_at));
    if (limit == null) continue;
    caps.set(r.connector_uuid, Math.floor(r.profile.charging_rate_unit === 'A' ? ampsToWatts(limit, r.phases ?? 3) : limit));
  }
  return caps;
}

/** Apply partner caps to demands: the nameplate and the minimum both come down to the cap. */
export function applyPartnerCaps(demands: Demand[], caps: Map<string, number>): Demand[] {
  if (caps.size === 0) return demands;
  return demands.map((d) => {
    const cap = d.connectorUuid ? caps.get(d.connectorUuid) : undefined;
    if (cap == null) return d;
    return { ...d, maxPowerW: Math.min(d.maxPowerW, cap), minPowerW: Math.min(d.minPowerW, cap) };
  });
}

/**
 * One control-loop pass for a site. Idempotent and safe to run on a timer.
 *
 * If the optimiser cannot reach a charger it does nothing — the charger falls back
 * to its TxDefaultProfile, which is set conservatively at commissioning. A stale
 * ceiling is worse than a conservative one, so when unhealthy this stops issuing
 * profiles rather than issuing old ones.
 */
export async function runControlLoop(siteId: string): Promise<Allocation[]> {
  const budget = await loadSiteBudget(siteId);
  if (!budget) return [];

  const usableW = budget.curtailed ? 0 : Math.max(0, budget.ceilingW - budget.reserveW);
  // Bidirectional charging (v2x.ts): which cars give energy back this pass. Without an export
  // agreement the pool is the site's own auxiliary load (the reserve), so nothing reaches PLN.
  // A discharging car takes no charging power.
  const v2x: SitePlanResult = await planSite(siteId, budget.curtailed ? 0 : budget.reserveW)
    .catch((e) => { logger.warn({ siteId, err: (e as Error).message }, 'bidirectional plan failed — charging only'); return { discharge: new Map() }; });
  const demands = applyPartnerCaps(forStrategy(await collectDemands(siteId), budget.strategy), await partnerCapsW(siteId))
    .map((d) => (d.connectorUuid && v2x.discharge.has(d.connectorUuid) ? { ...d, active: false } : d));
  const allocations = allocate(usableW, demands);

  // --- station-level ceiling: the breaker guard -------------------------
  //
  // ChargePointMaxProfile and TxDefaultProfile were previously COMPUTED AND
  // NEVER SENT — the code built a per-station total and returned without using
  // it, while a comment called it "the breaker guard". Worse, because no
  // TxDefaultProfile was ever provisioned, the "conservative fallback set at
  // commissioning" that the error path relies on did not exist either.
  const byCp = new Map<string, { identity: string; chargePointId: string; w: number; phases: number; ac: boolean }>();
  for (const a of allocations) {
    const cur =
      byCp.get(a.chargePointId) ??
      { identity: a.ocppIdentity, chargePointId: a.chargePointId, w: 0, phases: a.phases, ac: a.currentType === 'AC' };
    cur.w += a.allocatedW;
    byCp.set(a.chargePointId, cur);
  }

  for (const cp of byCp.values()) {
    if (!registry.isOnline(cp.identity)) continue;
    const unit = await unitFor(cp.chargePointId, cp.ac ? 'A' : 'W');

    /**
     * NEVER send a zero station ceiling by accident.
     *
     * `ChargePointMaxProfile` is persistent and survives a WAN outage — that is
     * the point of it — so a 0 W ceiling sent to an idle station is not a
     * momentary instruction, it is a charger bricked at zero amps until the CSMS
     * comes back and says otherwise. And an idle station sums to 0 W by
     * construction, so this fired every 30 seconds on every station with nobody
     * plugged in, which is the exact inverse of the "conservative fallback" this
     * layer is supposed to provide.
     *
     * Zero is only ever a deliberate act (an explicit curtailment), and even
     * then it is logged loudly. Otherwise the floor is the station's idle share.
     */
    // An explicit curtailment DOES mean zero; only an accidental zero is floored.
    const floorW = budget.curtailed ? 0 : idleFloorW(budget, byCp.size);
    const effectiveW = cp.w > 0 ? cp.w : floorW;
    if (effectiveW <= 0) {
      if (budget.curtailed) {
        logger.warn({ cp: cp.identity }, 'site is curtailed — sending a zero station ceiling deliberately');
      } else {
        logger.warn(
          { cp: cp.identity },
          'refusing to send a zero station ceiling — a persistent 0 A profile would strand the charger',
        );
        continue;
      }
    }
    const limit = unit === 'A' ? wattsToAmps(effectiveW, cp.phases) : effectiveW;
    try {
      await setChargingProfile(
        cp.identity,
        {
          connectorId: 0, // ChargePointMaxProfile is ONLY valid at connector 0
          purpose: 'ChargePointMaxProfile',
          stackLevel: 0,
          ocppProfileId: 1,
          limit,
          unit,
          numberPhases: cp.ac ? cp.phases : undefined,
          // Persistent: this is the ceiling that must survive a WAN outage.
        },
        { type: 'system' },
      );
    } catch (e) {
      logger.warn({ cp: cp.identity, err: (e as Error).message }, 'could not apply the station ceiling');
    }
  }

  // --- per-transaction allocation ---------------------------------------
  for (const a of allocations) {
    if (!registry.isOnline(a.ocppIdentity)) continue;
    const unit = await unitFor(a.chargePointId, a.unit);
    const limit = unit === 'A' ? wattsToAmps(a.allocatedW, a.phases) : a.allocatedW;

    try {
      const dis = a.connectorUuid ? v2x.discharge.get(a.connectorUuid) : undefined;
      if (dis && a.transactionId != null) {
        // Same profile id and stack as the charging limit, so the two replace each other.
        const durationS = 900;
        await setChargingProfile(
          a.ocppIdentity,
          {
            connectorId: a.connectorNo,
            purpose: 'TxProfile',
            stackLevel: LOAD_MGMT_STACK,
            ocppProfileId: 5_000 + a.connectorNo,
            limit: 0,
            unit: 'W',
            durationS,
            validToIso: new Date(Date.now() + durationS * 1000).toISOString(),
            transactionId: a.transactionId,
            discharge: { watts: dis.dischargeW, dynamic: dis.dynamic },
          },
          { type: 'system' },
        );
        continue;
      }
      if (a.active && a.transactionId != null) {
        // TxProfile: per-transaction, discarded when the transaction ends.
        // ALWAYS bounded, and anchored to the WALL CLOCK (Absolute) rather than
        // to transaction start — a Relative profile re-sent mid-session carried a
        // window that had already elapsed.
        const durationS = 900;
        await setChargingProfile(
          a.ocppIdentity,
          {
            connectorId: a.connectorNo,
            purpose: 'TxProfile',
            stackLevel: LOAD_MGMT_STACK,
            ocppProfileId: 5_000 + a.connectorNo,
            limit,
            unit,
            numberPhases: a.currentType === 'AC' ? a.phases : undefined,
            durationS,
            validToIso: new Date(Date.now() + durationS * 1000).toISOString(),
            transactionId: a.transactionId,
          },
          { type: 'system' },
        );
      } else {
        // Idle connector: drop any TxProfile we left behind. Profiles were never
        // cleared, so a stale limit could outlive the session that needed it.
        await clearStaleTxProfile(a.ocppIdentity, a.chargePointId, a.connectorNo);
      }
    } catch (e) {
      logger.warn(
        { cp: a.ocppIdentity, connector: a.connectorNo, err: (e as Error).message },
        'failed to apply charging profile — charger falls back to its TxDefaultProfile',
      );
    }
  }

  return allocations;
}

/**
 * The standing ceiling an idle station is allowed while nothing is plugged in.
 *
 * Small enough that every station at the site could sit at it simultaneously
 * without exceeding the budget, and large enough that a car can start charging
 * and be seen as active on the next control loop.
 */
function idleFloorW(budget: { ceilingW: number; reserveW: number } | null, stations: number): number {
  if (!budget || stations <= 0) return 0;
  const usable = Math.max(0, budget.ceilingW - budget.reserveW);
  return Math.floor(usable / stations);
}

/**
 * The rate unit this hardware actually accepts.
 *
 * THIS charger's own answer (learned during provisioning) comes first. The
 * model-wide value is a fallback only when it is confirmed (seed, operator or
 * cross-tenant consensus): it used to be whatever the last charger of the model
 * answered, on any tenant, so one charger saying "Power" sent watt profiles to
 * every amp-only unit of the model — rejected, and the station ceiling that
 * keeps the site under its PLN capacity was never applied. Last, the
 * hardware's natural unit (AC → A, DC → W).
 */
async function unitFor(chargePointId: string, fallback: 'A' | 'W'): Promise<'A' | 'W'> {
  const cp = await one<{ vendor: string; model: string; firmware: string; charging_rate_units: string | null }>(
    `SELECT vendor, model, firmware, charging_rate_units FROM charge_point WHERE id = $1`,
    [chargePointId],
  );
  if (cp?.charging_rate_units) return pickRateUnit(cp.charging_rate_units, null, fallback);
  const quirks = await resolveQuirks(cp?.vendor, cp?.model, cp?.firmware);
  return pickRateUnit(null, quirks?.findings, fallback);
}

/**
 * Install the conservative standing limit a charger falls back to when the
 * optimiser cannot reach it. Called at commissioning and after a budget change.
 */
export async function provisionDefaultProfile(siteId: string): Promise<number> {
  const budget = await loadSiteBudget(siteId);
  if (!budget) return 0;
  const demands = await collectDemands(siteId);
  if (demands.length === 0) return 0;

  const usableW = Math.max(0, budget.ceilingW - budget.reserveW);
  // Safe static share: what each connector may draw if every one of them draws
  // at once and nothing is coordinating.
  const shareW = Math.floor(usableW / demands.length);
  let applied = 0;

  for (const d of demands) {
    if (!registry.isOnline(d.ocppIdentity)) continue;
    const unit = await unitFor(d.chargePointId, d.currentType === 'AC' ? 'A' : 'W');
    const w = Math.max(d.minPowerW, Math.min(shareW, d.maxPowerW));
    const limit = unit === 'A' ? wattsToAmps(w, d.phases) : w;
    try {
      await setChargingProfile(
        d.ocppIdentity,
        {
          connectorId: d.connectorNo,
          purpose: 'TxDefaultProfile',
          stackLevel: 1,
          ocppProfileId: 2_000 + d.connectorNo,
          limit,
          unit,
          numberPhases: d.currentType === 'AC' ? d.phases : undefined,
        },
        { type: 'system' },
      );
      applied++;
    } catch (e) {
      logger.warn({ cp: d.ocppIdentity, err: (e as Error).message }, 'could not set TxDefaultProfile');
    }
  }
  logger.info({ siteId, applied, shareW }, 'default charging profiles provisioned');
  return applied;
}

/**
 * Stack levels are the contract between the two things that write TxProfiles.
 *
 * Load management owns LOAD_MGMT_STACK. Prepaid enforcement owns
 * PREPAID_STACK, deliberately higher so a paid-out allowance beats a fair-share
 * allocation. Anything that clears profiles must respect that split.
 */
export const LOAD_MGMT_STACK = 5;
export const PREPAID_STACK = 9;

async function clearStaleTxProfile(identity: string, chargePointId: string, connectorNo: number) {
  const stale = await one<{ id: string }>(
    `SELECT id FROM charging_profile
      WHERE charge_point_id = $1 AND connector_no = $2 AND purpose = 'TxProfile'
        AND stack_level = $3
        AND state = 'accepted' AND cleared_at IS NULL
      LIMIT 1`,
    [chargePointId, connectorNo, LOAD_MGMT_STACK],
  );
  if (!stale) return;

  /**
   * Scoped to THIS stack level.
   *
   * ClearChargingProfile with only a purpose clears every TxProfile on the
   * connector — including the prepaid throttle at stack level 9. The load
   * optimiser runs every 30 s, so a prepaid session whose connector it read as
   * idle had its enforcement limit silently removed by a background job, and
   * the profile row was marked `cleared` so nothing knew to re-apply it. The
   * one control standing between a QRIS pre-purchase and an uncollectable
   * overrun was being switched off by another part of the same system.
   */
  await clearChargingProfile(
    identity,
    { connectorId: connectorNo, chargingProfilePurpose: 'TxProfile', stackLevel: LOAD_MGMT_STACK },
    { type: 'system' },
  );
  await query(
    `UPDATE charging_profile SET cleared_at = now(), state = 'cleared'
      WHERE charge_point_id = $1 AND connector_no = $2 AND purpose = 'TxProfile'
        AND stack_level = $3 AND cleared_at IS NULL`,
    [chargePointId, connectorNo, LOAD_MGMT_STACK],
  );
  logger.info({ cp: identity, connector: connectorNo, stackLevel: LOAD_MGMT_STACK }, 'cleared a stale TxProfile');
}

/**
 * Reconcile what we believe the charger holds against what it actually holds.
 *
 * `charging_profile` was write-only — nothing ever read it back, and nothing
 * asked the charger. GetCompositeSchedule is only consulted where the quirk
 * registry says this model's implementation can be trusted.
 */
export async function reconcileProfiles(chargePointId: string): Promise<{ checked: number; drift: number }> {
  const cp = await one<{ ocpp_identity: string; vendor: string; model: string; firmware: string }>(
    `SELECT ocpp_identity, vendor, model, firmware FROM charge_point WHERE id = $1`,
    [chargePointId],
  );
  if (!cp || !registry.isOnline(cp.ocpp_identity)) return { checked: 0, drift: 0 };

  const quirks = await resolveQuirks(cp.vendor, cp.model, cp.firmware);
  if (quirks?.findings?.compositeScheduleTrustworthy === false) {
    logger.debug({ cp: cp.ocpp_identity }, 'GetCompositeSchedule not trusted on this model — skipping reconciliation');
    return { checked: 0, drift: 0 };
  }

  const believed = await many<{ connector_no: number; limit_w: number }>(
    `SELECT DISTINCT ON (connector_no) connector_no, limit_w
       FROM charging_profile
      WHERE charge_point_id = $1 AND cleared_at IS NULL AND state = 'accepted'
      ORDER BY connector_no, sent_at DESC`,
    [chargePointId],
  );

  let drift = 0;
  for (const b of believed) {
    try {
      const res = await getCompositeSchedule(cp.ocpp_identity, b.connector_no, 300, undefined, { type: 'system' });
      if (res?.status !== 'Accepted') continue;
      const period = (res as any)?.chargingSchedule?.chargingSchedulePeriod?.[0];
      if (!period) continue;
      const unit = (res as any)?.chargingSchedule?.chargingRateUnit;
      const actualW = unit === 'A' ? ampsToWatts(period.limit, period.numberPhases ?? 3) : period.limit;
      if (Math.abs(actualW - b.limit_w) > Math.max(500, b.limit_w * 0.05)) {
        drift++;
        logger.warn(
          { cp: cp.ocpp_identity, connector: b.connector_no, believedW: b.limit_w, actualW },
          'charging profile drift — the charger is not enforcing what we recorded',
        );
      }
    } catch {
      /* optional feature; ignore */
    }
  }
  return { checked: believed.length, drift };
}

/**
 * kVA headroom — expose this as a first-class operator metric. It maps directly
 * to money via `rekening minimum = 40 x kVA x block cost`, and it is the number
 * that tells an operator whether they can add another charger without a PLN
 * capacity upgrade (or whether they are about to cross the 200 kVA TR/TM cliff).
 */
export async function kvaHeadroom(siteId: string) {
  const budget = await loadSiteBudget(siteId);
  if (!budget) return null;
  const demands = await collectDemands(siteId);
  const activeW = demands.filter((d) => d.active).reduce((s, d) => s + d.maxPowerW, 0);
  const installedW = demands.reduce((s, d) => s + d.maxPowerW, 0);

  const subscribedKva = budget.connectedKva ?? 0;
  const activeKva = wattsToKva(activeW, budget.powerFactor);
  const installedKva = wattsToKva(installedW, budget.powerFactor);

  return {
    subscribedKva,
    activeKva: round2(activeKva),
    installedKva: round2(installedKva),
    headroomKva: round2(subscribedKva - activeKva),
    /** Uncontrolled simultaneous draw if every connector ran at nameplate. */
    unmanagedOversubscriptionKva: round2(installedKva - subscribedKva),
    /** Minimum monthly bill floor implied by the subscription. */
    rekeningMinimumKwhEquivalent: Math.round(40 * subscribedKva),
    /** Above 200 kVA the connection moves to medium voltage — a step change in cost. */
    crossesTrTmCliff: installedKva > 200,
    trTmThresholdKva: 200,
    powerFactor: budget.powerFactor,
    ceilingW: budget.ceilingW,
    curtailed: budget.curtailed,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function setCurtailed(siteId: string, curtailed: boolean) {
  await query(
    `INSERT INTO site_power_budget (site_id, ceiling_w, curtailed)
     VALUES ($1, 0, $2)
     ON CONFLICT (site_id) DO UPDATE SET curtailed = $2, updated_at = now()`,
    [siteId, curtailed],
  );
}
