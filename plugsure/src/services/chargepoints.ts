import { one, many, query } from '../db/pool.js';
import { meterKeyProblem } from './signed-metering.js';
import { teraStatusFor } from './compliance.js';

/**
 * Charge point lifecycle for the onboarding wizard (SPEC Module 1).
 *
 * Replaces `onboard_*.sql` scripts: identity + hardware profile, the EVSE and
 * connector topology with nameplate and metrology data, and the commissioning
 * status the wizard's final step listens on.
 *
 * TOPOLOGY RULE (unchanged from assets.ensureConnector): on OCPP 1.6 a
 * connectorId N is stored as (evse N, connector 1) — a 1.6 "gun" IS an EVSE.
 * The builder therefore allows several connectors per EVSE only for 2.0.1
 * stations, where the charger itself addresses (evseId, connectorId).
 */

export const IDENTITY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** The wizard's stricter rule for NEW identities: alphanumeric, dash, underscore. */
export const NEW_IDENTITY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const CONNECTOR_TYPES = [
  { code: 'cCCS2', label: 'CCS2 Combo', current: 'DC' },
  { code: 'sType2', label: 'Type 2 (Mennekes) socket', current: 'AC' },
  { code: 'cType2', label: 'Type 2 (Mennekes) tethered', current: 'AC' },
  { code: 'cChaDeMo', label: 'CHAdeMO', current: 'DC' },
  { code: 'cGBT', label: 'GB/T DC', current: 'DC' },
  { code: 'sGBT', label: 'GB/T AC', current: 'AC' },
] as const;

export const VENDORS = ['Autel Energy', 'Hengyi', 'Star Charger', 'Delta', 'ABB', 'Schneider Electric', 'Kempower', 'Wallbox', 'Siemens', 'Alpitronic'];

export interface ConnectorSpec {
  connectorId: number;
  connectorType: string;
  /** 'DC' | 'AC3' | 'AC1' in the wizard; stored as current_type + phases. */
  currentKind: 'DC' | 'AC3' | 'AC1';
  maxPowerW: number;
  ratedVoltageV?: number | null;
  ratedCurrentA?: number | null;
  meterSerial?: string | null;
  /** The meter's public key for signed readings (OCMF): hex, base64 or PEM. Absent keeps the current one; null or '' clears it. */
  meterPublicKey?: string | null;
  accuracyClass?: string | null;
  typeApprovalNo?: string | null;
  teraCertStatus?: 'verified' | 'pending' | 'exempt';
  teraLastAt?: string | null;
  teraDueAt?: string | null;
}

export interface EvseSpec {
  evseId: number;
  connectors: ConnectorSpec[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate the EVSE builder output. Returns a list of human-readable problems. */
export function validateTopology(evses: EvseSpec[], ocppVersion: string): string[] {
  const problems: string[] = [];
  if (!Array.isArray(evses) || evses.length === 0) return ['Add at least one EVSE'];
  if (evses.length > 16) problems.push('At most 16 EVSEs per charge point');
  const seen = new Set<number>();
  for (const e of evses) {
    if (!Number.isInteger(e.evseId) || e.evseId < 1 || e.evseId > 128) problems.push(`EVSE number ${e.evseId} must be 1-128`);
    if (seen.has(e.evseId)) problems.push(`EVSE ${e.evseId} is listed twice`);
    seen.add(e.evseId);
    const conns = Array.isArray(e.connectors) ? e.connectors : [];
    if (conns.length === 0) problems.push(`EVSE ${e.evseId} has no connector`);
    if (ocppVersion !== 'ocpp2.0.1' && ocppVersion !== 'ocpp2.1' && conns.length > 1) {
      problems.push(
        `EVSE ${e.evseId}: OCPP 1.6 addresses each gun as its own connectorId, so model a second gun as a second EVSE`,
      );
    }
    const cseen = new Set<number>();
    for (const c of conns) {
      const where = `EVSE ${e.evseId} connector ${c.connectorId}`;
      if (!Number.isInteger(c.connectorId) || c.connectorId < 1 || c.connectorId > 8) problems.push(`${where}: connector number must be 1-8`);
      if (cseen.has(c.connectorId)) problems.push(`${where}: listed twice`);
      cseen.add(c.connectorId);
      if (!CONNECTOR_TYPES.some((t) => t.code === c.connectorType)) problems.push(`${where}: choose a plug type`);
      if (!['DC', 'AC3', 'AC1'].includes(c.currentKind)) problems.push(`${where}: choose DC, AC 3-phase or AC single-phase`);
      const t = CONNECTOR_TYPES.find((x) => x.code === c.connectorType);
      if (t && t.current === 'DC' && c.currentKind !== 'DC') problems.push(`${where}: ${t.label} is a DC plug`);
      if (t && t.current === 'AC' && c.currentKind === 'DC') problems.push(`${where}: ${t.label} is an AC plug`);
      if (!Number.isFinite(c.maxPowerW) || c.maxPowerW < 1_000 || c.maxPowerW > 1_000_000) {
        problems.push(`${where}: nameplate power must be between 1 kW and 1000 kW`);
      }
      if (c.currentKind === 'AC1' && c.maxPowerW > 7_400) problems.push(`${where}: single-phase AC tops out at 7.4 kW`);
      if (c.currentKind === 'AC3' && c.maxPowerW > 44_000) problems.push(`${where}: three-phase AC tops out at 43 kW`);
      if (c.ratedVoltageV != null && (c.ratedVoltageV < 100 || c.ratedVoltageV > 1500)) problems.push(`${where}: rated voltage looks wrong`);
      if (c.ratedCurrentA != null && (c.ratedCurrentA < 1 || c.ratedCurrentA > 1000)) problems.push(`${where}: rated current looks wrong`);
      if (c.accuracyClass != null && c.accuracyClass !== '' && !['0.5', '1', '1.0', '2', '2.0'].includes(String(c.accuracyClass))) {
        problems.push(`${where}: accuracy class is 0.5, 1.0 or 2.0`);
      }
      if (c.teraCertStatus && !['verified', 'pending', 'exempt'].includes(c.teraCertStatus)) problems.push(`${where}: invalid tera status`);
      if (c.teraDueAt && !DATE_RE.test(c.teraDueAt)) problems.push(`${where}: tera expiry must be YYYY-MM-DD`);
      if (c.teraLastAt && !DATE_RE.test(c.teraLastAt)) problems.push(`${where}: last tera date must be YYYY-MM-DD`);
      if (c.teraCertStatus === 'verified' && !c.teraDueAt) problems.push(`${where}: a verified meter needs its tera expiry date`);
      if (c.meterPublicKey) {
        const k = meterKeyProblem(c.meterPublicKey);
        if ('error' in k) problems.push(`${where}: ${k.error}`);
      }
    }
  }
  return problems;
}

/** A meter key in its canonical form (hex DER), or null. Invalid keys never get here (validateTopology). */
function meterKeyHex(k: string | null | undefined): string | null {
  if (!k) return null;
  const r = meterKeyProblem(k);
  return 'hex' in r ? r.hex : null;
}

/** Normalise accuracy class spellings: '1.0' and '1' are the same class. */
function accuracy(a: string | null | undefined): string | null {
  if (a == null || a === '') return null;
  if (a === '1.0') return '1';
  if (a === '2.0') return '2';
  return a;
}

/**
 * Write the topology. Existing EVSEs/connectors are updated in place — never
 * deleted, because sessions reference connectors — and new ones are created.
 */
export async function applyTopology(chargePointId: string, evses: EvseSpec[]): Promise<void> {
  for (const e of evses) {
    const evseMax = Math.max(...e.connectors.map((c) => c.maxPowerW));
    await query(
      `INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1,$2,$3)
       ON CONFLICT (charge_point_id, evse_id) DO UPDATE SET max_power_w = EXCLUDED.max_power_w`,
      [chargePointId, e.evseId, evseMax],
    );
    const evse = await one<{ id: string }>(`SELECT id FROM evse WHERE charge_point_id = $1 AND evse_id = $2`, [
      chargePointId,
      e.evseId,
    ]);
    for (const c of e.connectors) {
      const current = c.currentKind === 'DC' ? 'DC' : 'AC';
      const phases = c.currentKind === 'AC1' ? 1 : 3;
      const cert = c.teraCertStatus ?? 'verified';
      const derived = teraStatusFor(c.teraDueAt ? new Date(c.teraDueAt) : null, new Date(), cert);
      await query(
        `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, phases,
                                rated_voltage_v, rated_current_a, meter_serial, meter_accuracy_class,
                                tera_type_approval_no, tera_last_at, tera_due_at, tera_status, tera_cert_status, meter_public_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (evse_uuid, connector_id) DO UPDATE SET
           connector_type = EXCLUDED.connector_type, current_type = EXCLUDED.current_type,
           max_power_w = EXCLUDED.max_power_w, phases = EXCLUDED.phases,
           rated_voltage_v = EXCLUDED.rated_voltage_v, rated_current_a = EXCLUDED.rated_current_a,
           meter_serial = EXCLUDED.meter_serial, meter_accuracy_class = EXCLUDED.meter_accuracy_class,
           tera_type_approval_no = EXCLUDED.tera_type_approval_no, tera_last_at = EXCLUDED.tera_last_at,
           tera_due_at = EXCLUDED.tera_due_at, tera_status = EXCLUDED.tera_status,
           tera_cert_status = EXCLUDED.tera_cert_status,
           meter_public_key = CASE WHEN $17 THEN EXCLUDED.meter_public_key ELSE connector.meter_public_key END`,
        [
          evse!.id,
          c.connectorId,
          c.connectorType,
          current,
          Math.round(c.maxPowerW),
          phases,
          c.ratedVoltageV ?? null,
          c.ratedCurrentA ?? null,
          c.meterSerial || null,
          accuracy(c.accuracyClass),
          c.typeApprovalNo || null,
          c.teraLastAt || null,
          c.teraDueAt || null,
          derived,
          cert,
          meterKeyHex(c.meterPublicKey),
          c.meterPublicKey !== undefined,
        ],
      );
    }
  }
}

export interface ChargePointProfile {
  displayName?: string | null;
  vendor?: string | null;
  model?: string | null;
  serial?: string | null;
  firmware?: string | null;
  ocppVersion?: 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1' | null;
  keyRotationDays?: number | null;
  siteId?: string;
}

export async function updateProfile(chargePointId: string, p: ChargePointProfile): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [chargePointId];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (p.displayName !== undefined) add('display_name', p.displayName || null);
  if (p.vendor !== undefined) add('vendor', p.vendor || null);
  if (p.model !== undefined) add('model', p.model || null);
  if (p.serial !== undefined) add('serial', p.serial || null);
  if (p.firmware !== undefined) add('firmware', p.firmware || null);
  if (p.ocppVersion !== undefined) add('ocpp_version', p.ocppVersion || null);
  if (p.keyRotationDays !== undefined) add('key_rotation_days', p.keyRotationDays ?? null);
  if (p.siteId !== undefined) {
    add('site_id', p.siteId);
    // Right-hand sides see the OLD row, so this compares against the previous site.
    sets.push(`site_assigned_at = CASE WHEN site_id IS DISTINCT FROM $${vals.length} THEN now() ELSE site_assigned_at END`);
  }
  if (!sets.length) return;
  await query(`UPDATE charge_point SET ${sets.join(', ')} WHERE id = $1`, vals);
}

/** Full detail for the charge point drawer. */
export async function chargePointDetail(identity: string) {
  const cp = await one<any>(
    `SELECT cp.id, cp.ocpp_identity, cp.display_name, cp.vendor, cp.model, cp.serial, cp.firmware,
            cp.ocpp_version, cp.security_profile, (cp.auth_key_hash IS NOT NULL) AS has_auth_key,
            cp.auth_key_rotated_at, cp.key_rotation_days, cp.client_cert_fingerprint, cp.status,
            cp.last_seen_at, cp.last_heartbeat_at, cp.offline_since, cp.boot_count, cp.adopted_at,
            cp.first_seen_at, cp.commissioned_at, cp.decommissioned_at, cp.created_at,
            s.id AS site_id, s.name AS site_name, s.org_id, s.timezone
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE cp.ocpp_identity = $1`,
    [identity],
  );
  if (!cp) return null;
  const connectors = await many<any>(
    `SELECT c.id, e.evse_id, c.connector_id, c.connector_type, c.current_type, c.phases, c.max_power_w,
            c.rated_voltage_v, c.rated_current_a, c.status, c.status_updated_at, c.error_code,
            c.vendor_error_code, c.status_info, c.meter_serial, c.meter_public_key, c.meter_accuracy_class,
            c.tera_type_approval_no, c.tera_last_at, c.tera_due_at, c.tera_status, c.tera_cert_status,
            c.priority, c.maintenance_reason, c.maintenance_since,
            cs.id AS session_id, cs.ocpp_transaction_id, cs.started_at AS session_started_at,
            cs.energy_wh AS session_energy_wh, t.uid AS session_id_tag
       FROM evse e
       JOIN connector c ON c.evse_uuid = e.id
       LEFT JOIN charging_session cs ON cs.connector_uuid = c.id AND cs.state = 'active'
       LEFT JOIN token t ON t.id = cs.token_id
      WHERE e.charge_point_id = $1
      ORDER BY e.evse_id, c.connector_id`,
    [cp.id],
  );
  return { ...cp, connectors };
}

/**
 * What the wizard's final step shows while it waits for the unit: is it on the
 * socket, has it booted, and — when it has NOT — what did the gateway say to it.
 * A refused handshake (wrong key, wrong URL, no subprotocol) is the most common
 * commissioning failure, and it is visible here without opening the log tab.
 */
export async function commissioningStatus(identity: string, online: boolean) {
  const cp = await one<any>(
    `SELECT id, status, last_seen_at, boot_count, vendor, model, firmware, ocpp_version, security_profile,
            cert_auto_upgrade, client_cert_fingerprint IS NOT NULL AS has_cert, client_cert_serial, client_cert_not_after, client_cert_source
       FROM charge_point WHERE ocpp_identity = $1`,
    [identity],
  );
  if (!cp) return null;
  const lastAttempt = await one<any>(
    `SELECT ts, outcome, detail, tls, auth_present, subprotocols, negotiated, remote_ip
       FROM connection_attempt WHERE ocpp_identity = $1 ORDER BY ts DESC LIMIT 1`,
    [identity],
  );
  const lastBoot = await one<any>(
    `SELECT ts, payload FROM ocpp_frame
      WHERE ocpp_identity = $1 AND direction = 'in' AND action = 'BootNotification'
      ORDER BY id DESC LIMIT 1`,
    [identity],
  );
  const adopted = online && cp.status !== 'pending_adoption' && lastBoot != null;
  return {
    identity,
    online,
    status: cp.status,
    bootCount: cp.boot_count,
    lastSeenAt: cp.last_seen_at,
    lastBootAt: lastBoot?.ts ?? null,
    hardware: { vendor: cp.vendor, model: cp.model, firmware: cp.firmware, ocppVersion: cp.ocpp_version },
    lastAttempt,
    adopted,
    security: {
      profile: cp.security_profile,
      certAutoUpgrade: cp.cert_auto_upgrade,
      certificate: cp.has_cert ? { serial: cp.client_cert_serial, notAfter: cp.client_cert_not_after, source: cp.client_cert_source } : null,
    },
    headline: adopted
      ? 'Hardware Connected & Adopted'
      : online && cp.status === 'pending_adoption'
        ? 'Connected — waiting for activation'
        : lastAttempt && lastAttempt.outcome !== 'accepted'
          ? `Charger reached the gateway but was refused (${lastAttempt.outcome})`
          : 'Waiting for the charger to connect…',
  };
}

export async function setConnectorPriority(connectorUuid: string, priority: number): Promise<void> {
  await query(`UPDATE connector SET priority = $2 WHERE id = $1`, [connectorUuid, Math.max(-100, Math.min(100, Math.round(priority)))]);
}

export async function connectorOwner(connectorUuid: string) {
  return one<{ org_id: string; site_id: string; charge_point_id: string; ocpp_identity: string; evse_id: number }>(
    `SELECT s.org_id, s.id AS site_id, cp.id AS charge_point_id, cp.ocpp_identity, e.evse_id
       FROM connector c JOIN evse e ON e.id = c.evse_uuid
       JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id
      WHERE c.id = $1`,
    [connectorUuid],
  );
}

/** Enhanced fleet list: the v1.2.1 shape plus live session and commissioning fields. */
export async function listFleetDetailed(orgId: string) {
  return many(
    `SELECT cp.id, cp.ocpp_identity, cp.display_name, cp.vendor, cp.model, cp.firmware, cp.serial,
            cp.ocpp_version, cp.status, cp.last_seen_at, cp.last_heartbeat_at, cp.offline_since,
            cp.security_profile, (cp.auth_key_hash IS NOT NULL) AS has_auth_key,
            (cp.client_cert_fingerprint IS NOT NULL) AS has_client_cert,
            cp.auth_key_rotated_at, cp.key_rotation_days,
            s.name AS site_name, s.id AS site_id,
            COALESCE(json_agg(json_build_object(
              'connectorUuid', c.id,
              'evseNo', e.evse_id,
              'connectorId', c.connector_id,
              'connectorType', c.connector_type,
              'status', c.status,
              'errorCode', c.error_code,
              'maxPowerW', c.max_power_w,
              'currentType', c.current_type,
              'phases', c.phases,
              'teraStatus', c.tera_status,
              'teraCertStatus', c.tera_cert_status,
              'teraDueAt', c.tera_due_at,
              'maintenanceReason', c.maintenance_reason,
              'sessionId', cs.id,
              'transactionId', cs.ocpp_transaction_id,
              'sessionStartedAt', cs.started_at,
              'sessionEnergyWh', cs.energy_wh
            ) ORDER BY e.evse_id, c.connector_id) FILTER (WHERE c.id IS NOT NULL), '[]') AS connectors
       FROM charge_point cp
       JOIN site s ON s.id = cp.site_id
       LEFT JOIN evse e ON e.charge_point_id = cp.id
       LEFT JOIN connector c ON c.evse_uuid = e.id
       LEFT JOIN charging_session cs ON cs.connector_uuid = c.id AND cs.state = 'active'
      WHERE s.org_id = $1
      GROUP BY cp.id, s.name, s.id
      ORDER BY s.name, cp.ocpp_identity`,
    [orgId],
  );
}
