import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config, isRelaxedEnv } from '../config.js';

export interface ChargePointRow {
  id: string;
  site_id: string;
  /** Owning tenant. Carried here so gateway-side events can be org-scoped. */
  org_id: string;
  ocpp_identity: string;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  ocpp_version: string | null;
  security_profile: number;
  /** Profile 3 (mutual TLS): expected client-cert SHA-256 fingerprint, or null. */
  client_cert_fingerprint: string | null;
  /** During a certificate change, the previous certificate (accepted until the new one is used). */
  client_cert_prev_fingerprint?: string | null;
  status: string;
  quirk_profile_id: string | null;
  /** A sandbox charger simulated inside the gateway; never accepted over the network. */
  virtual?: boolean;
}

export interface ConnectorRow {
  id: string;
  evse_uuid: string;
  connector_id: number;
  evse_no: number;
  charge_point_id: string;
  site_id: string;
  org_id: string;
  max_power_w: number;
  current_type: string;
  phases: number;
  status: string;
  tera_status: string;
  tera_due_at: string | null;
  pbjt_rate_bps: number;
  timezone: string;
}

export async function findChargePoint(ocppIdentity: string): Promise<ChargePointRow | null> {
  return one<ChargePointRow>(
    `SELECT cp.id, cp.site_id, s.org_id, cp.ocpp_identity, cp.vendor, cp.model, cp.firmware,
            cp.ocpp_version, cp.security_profile, cp.client_cert_fingerprint, cp.client_cert_prev_fingerprint, cp.status, cp.quirk_profile_id, cp.virtual
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE cp.ocpp_identity = $1`,
    [ocppIdentity],
  );
}

/**
 * An unknown charge point is PARKED, not rejected. A rejected charger retries
 * forever and the installer gets no feedback — the commissioning experience is
 * the difference between a two-hour site visit and a two-day one.
 */
export async function adoptOrPark(ocppIdentity: string): Promise<ChargePointRow | null> {
  const existing = await findChargePoint(ocppIdentity);
  if (existing) return existing;

  if (!config.gateway.autoAdopt) {
    // The rejection itself is recorded in connection_attempt by the gateway, and
    // that log IS the adoption queue — see services/connections.ts:pendingChargers.
    logger.warn({ ocppIdentity }, 'unknown charge point queued for adoption');
    return null;
  }

  // Never into a developer sandbox tenant. OCPP_AUTO_ADOPT_SITE (id or name) was
  // documented but ignored: the charger went into the oldest site on the platform,
  // whichever tenant owned it.
  const wanted = config.gateway.autoAdoptSite;
  if (!wanted && !isRelaxedEnv()) {
    logger.warn({ ocppIdentity }, 'auto-adopt has no OCPP_AUTO_ADOPT_SITE; unknown charge point queued for adoption');
    return null;
  }
  const site = await one<{ id: string }>(
    wanted
      ? `SELECT s.id FROM site s JOIN organisation o ON o.id = s.org_id
          WHERE o.sandbox_of_org_id IS NULL AND (s.id::text = $1 OR s.name = $1)
          ORDER BY s.created_at LIMIT 1`
      : `SELECT s.id FROM site s JOIN organisation o ON o.id = s.org_id WHERE o.sandbox_of_org_id IS NULL ORDER BY s.created_at LIMIT 1`,
    wanted ? [wanted] : [],
  );
  if (!site) {
    logger.error({ ocppIdentity, site: wanted || null }, wanted ? 'OCPP_AUTO_ADOPT_SITE matches no site; charge point queued for adoption' : 'no site exists to adopt charge point into — run the seed first');
    return null;
  }
  const row = await one<{ id: string }>(
    `INSERT INTO charge_point (site_id, ocpp_identity, status, adopted_at, first_seen_at)
     VALUES ($1, $2, 'provisioning', now(), now())
     ON CONFLICT (ocpp_identity) DO UPDATE SET status = charge_point.status
     RETURNING id`,
    [site.id, ocppIdentity],
  );
  logger.info({ ocppIdentity, chargePointId: row?.id }, 'auto-adopted charge point');
  // Re-read through the joined view so org_id is populated exactly as it is on
  // every other path — one source of truth for the row shape.
  return row ? findChargePoint(ocppIdentity) : null;
}

/**
 * States an operator owns. No connectivity or fault event may overwrite one:
 * a charge point walked itself out of `pending_adoption` through the station
 * fault path and started billing sessions nobody had approved.
 */
export const ADMINISTRATIVE_STATES = ['pending_adoption', 'decommissioned', 'suspended'];

export async function recordBoot(
  chargePointId: string,
  info: { vendor?: string; model?: string; serial?: string; firmware?: string; ocppVersion?: string },
) {
  await query(
    `UPDATE charge_point
        SET vendor = COALESCE($2, vendor),
            model = COALESCE($3, model),
            serial = COALESCE($4, serial),
            firmware = COALESCE($5, firmware),
            ocpp_version = COALESCE($6, ocpp_version),
            boot_count = boot_count + 1,
            last_seen_at = now(),
            status = CASE WHEN status = ANY($7::text[]) THEN status ELSE 'online' END
      WHERE id = $1`,
    [chargePointId, info.vendor, info.model, info.serial, info.firmware, info.ocppVersion, ADMINISTRATIVE_STATES],
  );
}

export async function touchSeen(chargePointId: string, heartbeat = false) {
  await query(
    `UPDATE charge_point
        SET last_seen_at = now()${heartbeat ? ', last_heartbeat_at = now()' : ''}
      WHERE id = $1`,
    [chargePointId],
  );
}

/**
 * Connectivity status.
 *
 * `pending_adoption` is an ADMINISTRATIVE state, not a connectivity state: it
 * means an operator has not yet accepted this unit into a site. The gateway
 * wrote 'online' unconditionally on every connect, so the first reconnect of an
 * un-adopted charger silently erased its pending status — it vanished from the
 * adoption queue in the console and appeared in the fleet as a normal unit
 * nobody had approved. Liveness is tracked separately by `last_seen_at`, which
 * is still updated here.
 */

export async function setChargePointStatus(chargePointId: string, status: string) {
  await query(
    `UPDATE charge_point
        SET status = CASE WHEN status = ANY($3::text[]) THEN status ELSE $2 END,
            last_seen_at   = CASE WHEN $2 = 'online' THEN now() ELSE last_seen_at END,
            offline_since  = CASE WHEN $2 = 'offline' THEN COALESCE(offline_since, now()) ELSE NULL END
      WHERE id = $1`,
    [chargePointId, status, ADMINISTRATIVE_STATES],
  );
}

/** Explicitly move a charge point out of an administrative state (adoption). */
export async function setAdministrativeStatus(chargePointId: string, status: string) {
  await query(`UPDATE charge_point SET status = $2 WHERE id = $1`, [chargePointId, status]);
}

/**
 * Resolve an OCPP 1.6 connectorId to the canonical (evse, connector) pair,
 * creating the rows on first sight.
 *
 * Mapping rule: 1.6 connectorId = N  ->  (evse_id = N, connector_id = 1).
 * Lossless for every single-plug-per-EVSE unit, which covers all Autel AC units
 * and most DC units. Where a dual-gun DC unit shares a power stack the quirk
 * registry records it and the topology is corrected during commissioning.
 */
export async function ensureConnector(
  chargePointId: string,
  connectorNo: number,
  defaults: { maxPowerW?: number; currentType?: string; phases?: number } = {},
): Promise<ConnectorRow | null> {
  if (connectorNo === 0) return null; // connectorId 0 addresses the station itself

  await query(
    `INSERT INTO evse (charge_point_id, evse_id, max_power_w)
     VALUES ($1, $2, $3) ON CONFLICT (charge_point_id, evse_id) DO NOTHING`,
    [chargePointId, connectorNo, defaults.maxPowerW ?? null],
  );
  const evse = await one<{ id: string }>(
    `SELECT id FROM evse WHERE charge_point_id = $1 AND evse_id = $2`,
    [chargePointId, connectorNo],
  );
  if (!evse) return null;

  await query(
    `INSERT INTO connector (evse_uuid, connector_id, max_power_w, current_type, phases)
     VALUES ($1, 1, $2, $3, $4) ON CONFLICT (evse_uuid, connector_id) DO NOTHING`,
    [evse.id, defaults.maxPowerW ?? 22_000, defaults.currentType ?? 'AC', defaults.phases ?? 3],
  );

  return getConnector(chargePointId, connectorNo);
}

export async function getConnector(chargePointId: string, connectorNo: number): Promise<ConnectorRow | null> {
  return one<ConnectorRow>(
    `SELECT c.id, c.evse_uuid, c.connector_id, e.evse_id AS evse_no,
            cp.id AS charge_point_id, s.id AS site_id, s.org_id,
            c.max_power_w, c.current_type, c.phases, c.status,
            c.tera_status, c.tera_due_at, s.pbjt_rate_bps, s.timezone
       FROM connector c
       JOIN evse e ON e.id = c.evse_uuid
       JOIN charge_point cp ON cp.id = e.charge_point_id
       JOIN site s ON s.id = cp.site_id
      WHERE cp.id = $1 AND e.evse_id = $2`,
    [chargePointId, connectorNo],
  );
}

export async function setConnectorStatus(
  connectorUuid: string,
  status: string,
  errorCode?: string,
) {
  await query(
    `UPDATE connector SET status = $2, error_code = $3, status_updated_at = now() WHERE id = $1`,
    [connectorUuid, status, errorCode ?? null],
  );
}

export async function listFleet(orgId: string) {
  return many(
    `SELECT cp.id, cp.ocpp_identity, cp.vendor, cp.model, cp.firmware, cp.status,
            cp.last_seen_at, cp.last_heartbeat_at, cp.offline_since, cp.security_profile,
            (cp.auth_key_hash IS NOT NULL) AS has_auth_key,
            s.name AS site_name, s.id AS site_id,
            COALESCE(json_agg(json_build_object(
              'connectorUuid', c.id,
              'evseNo', e.evse_id,
              'status', c.status,
              'errorCode', c.error_code,
              'maxPowerW', c.max_power_w,
              'currentType', c.current_type,
              'teraStatus', c.tera_status,
              'teraDueAt', c.tera_due_at
            ) ORDER BY e.evse_id) FILTER (WHERE c.id IS NOT NULL), '[]') AS connectors
       FROM charge_point cp
       JOIN site s ON s.id = cp.site_id
       LEFT JOIN evse e ON e.charge_point_id = cp.id
       LEFT JOIN connector c ON c.evse_uuid = e.id
      WHERE s.org_id = $1
      GROUP BY cp.id, s.name, s.id
      ORDER BY s.name, cp.ocpp_identity`,
    [orgId],
  );
}
