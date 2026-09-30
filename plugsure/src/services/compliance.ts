import { many, query } from '../db/pool.js';
import { bus } from '../services/events.js';
import { logger } from '../logger.js';
import { parseSpkluId } from '../domain/spklu.js';

/**
 * Indonesian compliance vault.
 *
 * Three certificate regimes, three expiries, per site:
 *
 *   SPKLU identity number  Ditjen Gatrik  — structured; encodes scheme + municipality
 *   SLO                    a LIT          — mandatory before commercial operation
 *   Tera / tera ulang      Kemendag       — PER CONNECTOR, since 25 May 2026
 *
 * The tera regime is the newest and the one no international CSMS models. EVSE is
 * classified as UTTP — a measuring instrument subject to mandatory verification,
 * exactly like a fuel dispenser. A lapsed connector must be blocked from
 * commercial sessions, not merely flagged.
 */

export const TERA_WARN_DAYS = [60, 30, 7];
export const SLO_WARN_DAYS = [90, 30, 7];

/**
 * `pending` and `exempt` come from the operator-declared certification state
 * (connector.tera_cert_status, migration 009): a meter awaiting calibration may
 * not sell energy whatever its dates say, and an exempt (non-trade) meter has no
 * expiry to track.
 */
export type TeraStatus = 'verified' | 'due_soon' | 'lapsed' | 'unknown' | 'pending' | 'exempt';

export function teraStatusFor(
  dueAt: Date | null | undefined,
  now = new Date(),
  certStatus: 'verified' | 'pending' | 'exempt' | null | undefined = 'verified',
): TeraStatus {
  if (certStatus === 'pending') return 'pending';
  if (certStatus === 'exempt') return 'exempt';
  if (!dueAt) return 'unknown';
  const days = daysBetween(now, dueAt);
  if (days < 0) return 'lapsed';
  if (days <= Math.max(...TERA_WARN_DAYS)) return 'due_soon';
  return 'verified';
}

/**
 * Is this connector allowed to run a commercial (billable) session?
 *
 * Selling kWh to the public from an unverified meter is trade in an unverified
 * UTTP. Blocking is the safe posture; the operator can still run free sessions.
 */
export function connectorMaySellEnergy(teraStatus: TeraStatus): { allowed: boolean; reason?: string } {
  if (teraStatus === 'lapsed') {
    return {
      allowed: false,
      reason:
        'Meter verification (tera ulang) has lapsed. Commercial sessions are blocked until re-verification — ' +
        'EVSE is classified as UTTP under Permendag 24/2024.',
    };
  }
  if (teraStatus === 'pending') {
    return {
      allowed: false,
      reason:
        'This connector\'s meter is awaiting tera calibration. Commercial sessions are blocked until it is ' +
        'verified — EVSE is classified as UTTP under Permendag 24/2024.',
    };
  }
  return { allowed: true };
}

/** Days after which an AuthorizationKey is overdue for rotation, per charge point policy. */
export async function keyRotationSweep(now = new Date()) {
  const due = await many<any>(
    `SELECT cp.id AS cp_id, cp.ocpp_identity, cp.auth_key_rotated_at, cp.key_rotation_days, s.org_id
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE cp.key_rotation_days IS NOT NULL AND cp.auth_key_hash IS NOT NULL
        AND cp.status <> 'decommissioned'
        AND COALESCE(cp.auth_key_rotated_at, cp.created_at) + (cp.key_rotation_days || ' days')::interval < $1`,
    [now],
  );
  for (const r of due) {
    // Raise once a day at most: the sweep is hourly, so only on the first hour-slot.
    if (now.getUTCHours() !== 1) continue;
    bus.emit('alert.raised', {
      orgId: r.org_id,
      kind: 'security.key_rotation_due',
      severity: 'warning',
      message:
        `${r.ocpp_identity}: the AuthorizationKey is older than the ${r.key_rotation_days}-day rotation policy ` +
        `(last issued ${r.auth_key_rotated_at ? fmtDate(r.auth_key_rotated_at) : 'at registration'}). Rotate it from the Security tab.`,
      targetType: 'charge_point',
      targetId: r.cp_id,
    });
  }
  return due.length;
}

/** Sweep run on a timer. Refreshes derived statuses and raises alerts. */
export async function runComplianceSweep(now = new Date()) {
  const connectors = await many<any>(
    `SELECT c.id, c.tera_due_at, c.tera_status, c.tera_cert_status, s.org_id, cp.id AS cp_id, cp.ocpp_identity, e.evse_id
       FROM connector c
       JOIN evse e ON e.id = c.evse_uuid
       JOIN charge_point cp ON cp.id = e.charge_point_id
       JOIN site s ON s.id = cp.site_id`,
  );

  for (const c of connectors) {
    const status = teraStatusFor(c.tera_due_at ? new Date(c.tera_due_at) : null, now, c.tera_cert_status);
    if (status !== c.tera_status) {
      await query(`UPDATE connector SET tera_status = $2 WHERE id = $1`, [c.id, status]);
    }
    if (status === 'lapsed') {
      bus.emit('alert.raised', {
        orgId: c.org_id,
        kind: 'compliance.tera_lapsed',
        severity: 'critical',
        message: `${c.ocpp_identity} connector ${c.evse_id}: tera ulang lapsed on ${fmtDate(c.tera_due_at)}. Commercial sessions blocked.`,
        targetType: 'connector',
        targetId: `${c.cp_id}:${c.evse_id}`,
      });
    } else if (status === 'due_soon') {
      const days = daysBetween(now, new Date(c.tera_due_at));
      if (TERA_WARN_DAYS.includes(days)) {
        bus.emit('alert.raised', {
          orgId: c.org_id,
          kind: 'compliance.tera_due_soon',
          severity: 'warning',
          message: `${c.ocpp_identity} connector ${c.evse_id}: tera ulang due in ${days} days (${fmtDate(c.tera_due_at)}).`,
          targetType: 'connector',
          targetId: `${c.cp_id}:${c.evse_id}`,
        });
      }
    }
  }

  const sites = await many<any>(
    `SELECT id, org_id, name, slo_expires_at, spklu_id FROM site WHERE slo_expires_at IS NOT NULL`,
  );
  for (const s of sites) {
    const days = daysBetween(now, new Date(s.slo_expires_at));
    if (days < 0) {
      bus.emit('alert.raised', {
        orgId: s.org_id,
        kind: 'compliance.slo_expired',
        severity: 'critical',
        message: `Site ${s.name}: SLO expired on ${fmtDate(s.slo_expires_at)}. Operating without a valid SLO carries sanctions.`,
        targetType: 'site',
        targetId: s.id,
      });
    } else if (SLO_WARN_DAYS.includes(days)) {
      bus.emit('alert.raised', {
        orgId: s.org_id,
        kind: 'compliance.slo_due_soon',
        severity: 'warning',
        message: `Site ${s.name}: SLO expires in ${days} days (${fmtDate(s.slo_expires_at)}).`,
        targetType: 'site',
        targetId: s.id,
      });
    }
  }

  logger.debug({ connectors: connectors.length, sites: sites.length }, 'compliance sweep complete');
}

/** Compliance snapshot for the console and for a metrology inspection export. */
export async function complianceReport(orgId: string) {
  const sites = await many<any>(
    `SELECT s.id, s.name, s.spklu_id, s.spklu_scheme, s.slo_number, s.slo_issued_at,
            s.slo_expires_at, s.kabupaten_kota_code, s.pbjt_rate_bps,
            COALESCE(json_agg(json_build_object(
              'chargePoint', cp.ocpp_identity,
              'evseNo', e.evse_id,
              'meterSerial', c.meter_serial,
              'accuracyClass', c.meter_accuracy_class,
              'typeApprovalNo', c.tera_type_approval_no,
              'teraLastAt', c.tera_last_at,
              'teraDueAt', c.tera_due_at,
              'teraStatus', c.tera_status,
              'teraCertStatus', c.tera_cert_status
            ) ORDER BY cp.ocpp_identity, e.evse_id)
            FILTER (WHERE c.id IS NOT NULL), '[]') AS meters
       FROM site s
       LEFT JOIN charge_point cp ON cp.site_id = s.id
       LEFT JOIN evse e ON e.charge_point_id = cp.id
       LEFT JOIN connector c ON c.evse_uuid = e.id
      WHERE s.org_id = $1
      GROUP BY s.id
      ORDER BY s.name`,
    [orgId],
  );

  return sites.map((s) => {
    const parsed = s.spklu_id ? parseSpkluId(s.spklu_id) : null;
    return {
      ...s,
      spkluParsed: parsed,
      spkluIdValid: s.spklu_id ? parsed !== null : null,
      /** The SPKLU ID's municipality code should agree with the site's tax geography. */
      municipalityMatchesSpklu:
        parsed && s.kabupaten_kota_code ? parsed.kabupatenKotaCode === s.kabupaten_kota_code : null,
      sloDaysRemaining: s.slo_expires_at ? daysBetween(new Date(), new Date(s.slo_expires_at)) : null,
    };
  });
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

function fmtDate(d: string | Date): string {
  return new Date(d).toISOString().slice(0, 10);
}
