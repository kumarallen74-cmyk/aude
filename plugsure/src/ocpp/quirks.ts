import { one, many, query, tx } from '../db/pool.js';
import { bus } from '../services/events.js';
import { logger } from '../logger.js';

/**
 * Vendor quirk registry.
 *
 * Keyed on (vendor, model, firmware pattern) from BootNotification, this records
 * empirically discovered facts about how a given charger really behaves.
 *
 * Build this on DAY ONE, not year two. It is the difference between adding
 * vendor #2 costing a sprint and costing a rewrite. Populate it automatically
 * from the frame log wherever possible.
 */

export interface QuirkFindings {
  /** Config keys the charger returns Rejected/NotSupported for. Never fatal. */
  rejectedConfigKeys?: string[];
  /**
   * Keys the charger has accepted at least once. A key here is RETRACTED from
   * rejectedConfigKeys — findings must be able to reverse, or one bad unit
   * permanently mislabels the whole model fleet.
   */
  acceptedConfigKeys?: string[];
  /** Measurands actually observed in MeterValues, whatever we asked for. */
  emittedMeasurands?: string[];
  /**
   * 'A' for AC units, 'W' for DC — the MODEL-WIDE default, used only for a
   * charger that has not told us its own ChargingScheduleAllowedChargingRateUnit
   * (that answer is kept per charge point: charge_point.charging_rate_units),
   * and only while chargingRateUnitConfirmedBy is set. A single charger never
   * writes it; see recordChargerRateUnits.
   */
  chargingRateUnit?: 'A' | 'W';
  /**
   * Who vouches for chargingRateUnit: the seed data, an operator, or agreement
   * among chargers of at least CONSENSUS_MIN_ORGS distinct tenants. Unset means
   * the value is not trusted.
   */
  chargingRateUnitConfirmedBy?: 'seed' | 'operator' | 'consensus';
  /** GetCompositeSchedule implementations vary wildly. Never make it load-bearing. */
  compositeScheduleTrustworthy?: boolean;
  /** Whether a TxDefaultProfile sent to connector 0 actually reaches the connectors. */
  txDefaultProfileOnConnector0Propagates?: boolean;
  /** Whether OCPP UpdateFirmware from a third-party CSMS works. null = untested. */
  acceptsRemoteFirmwareUpdate?: boolean | null;
  maxLocalAuthListEntries?: number;
  /** Unrecognised DataTransfer vendorIds seen. This is how undocumented extensions get found. */
  observedDataTransferVendorIds?: string[];
  /**
   * Places this firmware deviates from OCPP 1.6 in ways we accept rather than
   * reject — e.g. Autel's 21-character chargePointModel against a CiString20
   * field, or a numeric sampledValue.value where the spec says String. Worth
   * raising with the vendor; not worth dropping the frame over.
   */
  specDeviations?: string[];
  notes?: string;
}

export interface QuirkProfile {
  id: string;
  vendor: string;
  model: string;
  firmware_pattern: string;
  findings: QuirkFindings;
}

/** Seed knowledge for hardware we expect to meet. Extend as the fleet grows. */
export const SEED_QUIRKS: Array<Omit<QuirkProfile, 'id'>> = [
  {
    vendor: 'Autel',
    model: 'MaxiCharger AC Wallbox',
    firmware_pattern: '.*',
    findings: {
      chargingRateUnit: 'A',
      compositeScheduleTrustworthy: false,
      acceptsRemoteFirmwareUpdate: null,
      rejectedConfigKeys: ['MeterValuesSampledData'],
      notes:
        'Observed rejecting MeterValuesSampledData=Energy.Active.Import.Register. Degrade gracefully — ' +
        'fall back to whatever the charger already reports. Datasheet states OCPP 1.6J only; ' +
        'treat 1.6J as the contractual baseline for Autel AC. Local DLB runs over Modbus RS485 with ' +
        'CT clamps (max 8 chargers per meter) and is the layer that actually guarantees the breaker.',
    },
  },
  {
    vendor: 'Autel',
    model: 'MaxiCharger DC Compact',
    firmware_pattern: '.*',
    findings: {
      chargingRateUnit: 'W',
      compositeScheduleTrustworthy: false,
      acceptsRemoteFirmwareUpdate: null,
      notes:
        'Datasheet: OCPP 1.6J, "upgradeable to 2.0.1", ISO 15118 listed. Dual-gun power sharing is ' +
        'internal and vendor-defined — OCPP 1.6 does not specify how a station splits its ' +
        'ChargePointMaxProfile between connectors. Do not assume fairness; measure it.',
    },
  },
  {
    vendor: 'Autel',
    model: 'MaxiCharger DH480',
    firmware_pattern: '.*',
    findings: {
      chargingRateUnit: 'W',
      compositeScheduleTrustworthy: true,
      notes: 'Documented as OCPP 1.6J AND 2.0.1, ISO 15118, MID + Eichrecht certified.',
    },
  },
];

export async function seedQuirks() {
  for (const q of SEED_QUIRKS) {
    const findings: QuirkFindings = q.findings.chargingRateUnit
      ? { ...q.findings, chargingRateUnitConfirmedBy: 'seed' }
      : q.findings;
    await query(
      `INSERT INTO quirk_profile (vendor, model, firmware_pattern, findings)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (vendor, model, firmware_pattern) DO NOTHING`,
      [q.vendor, q.model, q.firmware_pattern, JSON.stringify(findings)],
    );
    // The seed's rate unit is curated knowledge: restore it if a charger's answer
    // overwrote it under the old rule (or migration 050 cleared it). An
    // operator's own confirmation is left alone.
    if (q.findings.chargingRateUnit) {
      await query(
        `UPDATE quirk_profile
            SET findings = findings || jsonb_build_object('chargingRateUnit', $4::text, 'chargingRateUnitConfirmedBy', 'seed'),
                updated_at = now()
          WHERE vendor = $1 AND model = $2 AND firmware_pattern = $3
            AND coalesce(findings->>'chargingRateUnitConfirmedBy', '') NOT IN ('operator', 'seed')`,
        [q.vendor, q.model, q.firmware_pattern, q.findings.chargingRateUnit],
      );
    }
  }
}

export async function resolveQuirks(
  vendor?: string | null,
  model?: string | null,
  firmware?: string | null,
): Promise<QuirkProfile | null> {
  if (!vendor || !model) return null;
  const rows = await one<QuirkProfile>(
    `SELECT id, vendor, model, firmware_pattern, findings
       FROM quirk_profile
      WHERE vendor = $1 AND model = $2
        AND ($3::text IS NULL OR $3 ~ firmware_pattern)
      ORDER BY length(firmware_pattern) DESC
      LIMIT 1`,
    [vendor, model, firmware ?? null],
  );
  return rows;
}

export async function ensureQuirkProfile(
  vendor: string,
  model: string,
  firmware?: string | null,
): Promise<QuirkProfile> {
  const found = await resolveQuirks(vendor, model, firmware);
  if (found) return found;
  const created = await one<QuirkProfile>(
    `INSERT INTO quirk_profile (vendor, model, firmware_pattern, findings)
     VALUES ($1,$2,'.*','{}')
     ON CONFLICT (vendor, model, firmware_pattern) DO UPDATE SET updated_at = now()
     RETURNING id, vendor, model, firmware_pattern, findings`,
    [vendor, model],
  );
  return created!;
}

/**
 * Merge a newly observed fact into the profile.
 *
 * Runs inside a transaction with a row lock. It was previously a read-modify-write
 * with no lock at all, so concurrent boots after an outage silently lost findings
 * (last writer wins). Arrays union; scalars overwrite; acceptance RETRACTS a
 * previous rejection.
 */
/** Distinct findings kept per key before a profile stops learning. */
const MAX_FINDINGS_PER_KEY = 64;
/** Longest single finding string kept; the tail is attacker-influenced. */
const MAX_FINDING_CHARS = 200;

const clampEntry = (x: unknown): string => {
  const s = String(x);
  return s.length <= MAX_FINDING_CHARS ? s : `${s.slice(0, MAX_FINDING_CHARS)}…`;
};

export async function recordFinding(
  profileId: string,
  patch: QuirkFindings,
  context: { vendor: string; model: string; firmware?: string | null },
) {
  const discovered: string[] = [];

  /**
   * A charger's frames never set the model-wide rate unit. The profile is
   * shared by every tenant's chargers that CLAIM this vendor/model, so one
   * charger's ChargingScheduleAllowedChargingRateUnit answer used to decide the
   * profile unit for all of them — one unit answering "Power" put every amp-only
   * wallbox of the model on watt profiles, which they reject, and the station
   * ceiling was silently not applied. The answer is per charge point
   * (recordChargerRateUnits); the shared value comes from the seed, an operator
   * or cross-tenant consensus.
   */
  if ('chargingRateUnit' in patch || 'chargingRateUnitConfirmedBy' in patch) {
    const { chargingRateUnit: _u, chargingRateUnitConfirmedBy: _c, ...rest } = patch;
    patch = rest;
  }

  await tx(async (client) => {
    const cur = await client.query<{ findings: QuirkFindings }>(
      `SELECT findings FROM quirk_profile WHERE id = $1 FOR UPDATE`,
      [profileId],
    );
    const merged: QuirkFindings = { ...(cur.rows[0]?.findings ?? {}) };

    for (const [k, v] of Object.entries(patch) as [keyof QuirkFindings, any][]) {
      if (Array.isArray(v)) {
        const existing = (merged[k] as unknown as string[]) ?? [];
        const union = Array.from(new Set([...existing, ...v.map(clampEntry)]));
        const added = union.filter((x) => !existing.includes(x));

        /**
         * BOUNDED. A quirk profile is a fingerprint of a firmware, so it should
         * converge on a handful of findings and then stop growing. It had no
         * bound at all: a deviation message can embed the offending field name,
         * so a hostile or simply broken charger that varies that name on every
         * frame appended a new unique string forever, growing one JSONB row
         * without limit until writes to it failed — taking the whole quirk
         * registry down with it, for every tenant sharing that profile.
         *
         * Past the cap the profile stops learning and says so. A firmware that
         * produces more than this many distinct deviations is not a quirk, it
         * is a defect report.
         */
        if (union.length > MAX_FINDINGS_PER_KEY) {
          (merged as any)[k] = [
            ...union.slice(0, MAX_FINDINGS_PER_KEY),
            `[truncated: ${union.length - MAX_FINDINGS_PER_KEY} further distinct findings suppressed]`,
          ];
          if (existing.length <= MAX_FINDINGS_PER_KEY) {
            logger.warn(
              { profileId, key: String(k), distinct: union.length },
              'quirk profile hit its findings cap — the firmware is emitting unbounded distinct deviations',
            );
          }
        } else {
          (merged as any)[k] = union;
        }
        if (added.length) discovered.push(`${String(k)}: ${added.slice(0, 8).join(', ')}`);
      } else if (v !== undefined && merged[k] !== v) {
        (merged as any)[k] = v;
        discovered.push(`${String(k)} = ${String(v)}`);
      }
    }

    // Retraction: anything the charger has now accepted is no longer 'rejected'.
    if (patch.acceptedConfigKeys?.length && merged.rejectedConfigKeys?.length) {
      const accepted = new Set(patch.acceptedConfigKeys);
      const before = merged.rejectedConfigKeys.length;
      merged.rejectedConfigKeys = merged.rejectedConfigKeys.filter((k) => !accepted.has(k));
      if (merged.rejectedConfigKeys.length !== before) {
        discovered.push(
          `retracted ${before - merged.rejectedConfigKeys.length} stale rejection(s): ` +
            `${patch.acceptedConfigKeys.filter((k) => accepted.has(k)).join(', ')}`,
        );
      }
    }

    await client.query(`UPDATE quirk_profile SET findings = $2, updated_at = now() WHERE id = $1`, [
      profileId,
      JSON.stringify(merged),
    ]);
  });

  for (const d of discovered) bus.emit('quirk.discovered', { ...context, finding: d });
  logger.debug({ profileId, patch }, 'quirk finding recorded');
}

/** Read the registry, for the operator console and for a vendor conversation. */
export async function listQuirkProfiles() {
  return many<QuirkProfile & { updated_at: Date; charge_points: number }>(
    `SELECT q.id, q.vendor, q.model, q.firmware_pattern, q.findings, q.updated_at,
            (SELECT count(*) FROM charge_point cp WHERE cp.quirk_profile_id = q.id)::int AS charge_points
       FROM quirk_profile q
      ORDER BY q.vendor, q.model`,
  );
}

/** Operator repair path: clear a finding that was recorded in error. */
export async function clearFinding(profileId: string, key: keyof QuirkFindings) {
  await query(`UPDATE quirk_profile SET findings = findings - $2, updated_at = now() WHERE id = $1`, [
    profileId,
    String(key),
  ]);
}

// ================================================================== charging rate unit

/** Distinct tenants whose chargers must agree before a model-wide unit is trusted. */
export const CONSENSUS_MIN_ORGS = 3;

export type RateUnits = 'A' | 'W' | 'A,W';

/**
 * The units a charger accepts, from its ChargingScheduleAllowedChargingRateUnit
 * (1.6: "Current", "Power", "Current,Power") or SmartChargingCtrlr.RateUnit
 * (2.0.1: "A", "W", "A,W"). Null when the answer names neither.
 *
 * The previous parser called "Current,Power" watt-only (it contains a W and no
 * A), so a charger accepting both was recorded as refusing amps.
 */
export function parseRateUnits(value: string | null | undefined): RateUnits | null {
  if (typeof value !== 'string') return null;
  const tokens = value.split(/[,;\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const a = tokens.some((t) => t === 'a' || t === 'current' || t === 'amp' || t === 'amps');
  const w = tokens.some((t) => t === 'w' || t === 'power' || t === 'watt' || t === 'watts');
  return a && w ? 'A,W' : a ? 'A' : w ? 'W' : null;
}

/**
 * The unit to put in a charging schedule for one charger: its own answer first;
 * else the model's unit when someone has confirmed it; else the hardware's
 * natural unit (AC → A, DC → W). Pure, for smartcharging and its tests.
 */
export function pickRateUnit(
  own: string | null | undefined,
  model: Pick<QuirkFindings, 'chargingRateUnit' | 'chargingRateUnitConfirmedBy'> | null | undefined,
  fallback: 'A' | 'W',
): 'A' | 'W' {
  const mine = parseRateUnits(own);
  if (mine) return mine.includes(fallback) ? fallback : (mine as 'A' | 'W');
  if (model?.chargingRateUnit && model.chargingRateUnitConfirmedBy) return model.chargingRateUnit;
  return fallback;
}

/**
 * Record what ONE charger said about rate units, on that charger only, then
 * re-derive the model's consensus. The shared value is set by consensus only
 * when chargers of at least CONSENSUS_MIN_ORGS distinct tenants have answered
 * and every one of them accepts that unit (and not all of them accept the
 * other, in which case no model-wide restriction is needed). One charger — or
 * one tenant's whole fleet, which may share a misconfiguration — can never move
 * it, and a dissenting charger withdraws a consensus value. Seed and operator
 * values are never overridden by consensus.
 */
export async function recordChargerRateUnits(
  chargePointId: string,
  profileId: string | null | undefined,
  units: RateUnits,
  context: { vendor: string; model: string; firmware?: string | null },
): Promise<void> {
  await query(
    `UPDATE charge_point SET charging_rate_units = $2, charging_rate_units_at = now() WHERE id = $1`,
    [chargePointId, units],
  );
  if (!profileId) return;
  let changed: string | null = null;
  await tx(async (client) => {
    const cur = await client.query<{ findings: QuirkFindings }>(
      `SELECT findings FROM quirk_profile WHERE id = $1 FOR UPDATE`,
      [profileId],
    );
    const findings: QuirkFindings = { ...(cur.rows[0]?.findings ?? {}) };
    if (findings.chargingRateUnitConfirmedBy === 'seed' || findings.chargingRateUnitConfirmedBy === 'operator') return;
    const agg = (
      await client.query<{ orgs: number; all_a: boolean | null; all_w: boolean | null }>(
        `SELECT count(DISTINCT s.org_id)::int AS orgs,
                bool_and(cp.charging_rate_units LIKE '%A%') AS all_a,
                bool_and(cp.charging_rate_units LIKE '%W%') AS all_w
           FROM charge_point cp JOIN site s ON s.id = cp.site_id
          WHERE cp.quirk_profile_id = $1 AND cp.charging_rate_units IS NOT NULL`,
        [profileId],
      )
    ).rows[0];
    const agreed: 'A' | 'W' | null =
      agg && agg.orgs >= CONSENSUS_MIN_ORGS && agg.all_a !== agg.all_w ? (agg.all_a ? 'A' : 'W') : null;
    const before = findings.chargingRateUnitConfirmedBy === 'consensus' ? findings.chargingRateUnit ?? null : null;
    if (agreed === before && (agreed !== null || findings.chargingRateUnit === undefined)) return;
    if (agreed) {
      findings.chargingRateUnit = agreed;
      findings.chargingRateUnitConfirmedBy = 'consensus';
    } else {
      // No (longer any) agreement: an unconfirmed or consensus value is withdrawn.
      delete findings.chargingRateUnit;
      delete findings.chargingRateUnitConfirmedBy;
    }
    changed = agreed ? `chargingRateUnit = ${agreed} (consensus of ${agg!.orgs} tenants)` : 'chargingRateUnit withdrawn (no consensus)';
    await client.query(`UPDATE quirk_profile SET findings = $2, updated_at = now() WHERE id = $1`, [
      profileId,
      JSON.stringify(findings),
    ]);
  });
  if (changed) bus.emit('quirk.discovered', { ...context, finding: changed });
}

/** Operator: confirm a model's rate unit (or clear it with null). Overrides seed and consensus. */
export async function confirmChargingRateUnit(profileId: string, unit: 'A' | 'W' | null): Promise<void> {
  if (unit === null) {
    await query(
      `UPDATE quirk_profile SET findings = findings - 'chargingRateUnit' - 'chargingRateUnitConfirmedBy', updated_at = now() WHERE id = $1`,
      [profileId],
    );
    return;
  }
  await query(
    `UPDATE quirk_profile
        SET findings = findings || jsonb_build_object('chargingRateUnit', $2::text, 'chargingRateUnitConfirmedBy', 'operator'),
            updated_at = now()
      WHERE id = $1`,
    [profileId, unit],
  );
}
