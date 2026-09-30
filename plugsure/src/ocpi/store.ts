import { one, many, query } from '../db/pool.js';
import { signedDataFor, ocpiSignedData } from '../services/signed-metering.js';
import * as registry from '../ocpp/registry.js';
import { loadTariffForConnector, loadTariffById } from '../services/tariff-store.js';
import type { Tariff, CdrLine } from '../services/tariff.js';
import {
  buildLocation, buildTariff, buildSession, buildCdr, locationProblem, evseUid,
  type Party, type SiteIn, type EvseIn, type ConnectorIn, type SessionIn, type TokenRef, type TokenIn,
} from './mapping.js';

/**
 * Database reads and writes for roaming. Every query names its organisation
 * explicitly: OCPI requests arrive outside the console's request scope (a
 * partner is not a console user), like the driver API.
 */

// ─────────────────────────────────────────────── our identity

export async function getParty(orgId: string): Promise<Party | null> {
  return one<Party>(`SELECT country_code, party_id, business_name, website FROM ocpi_party WHERE org_id = $1`, [orgId]);
}

export async function setParty(orgId: string, p: Party): Promise<Party> {
  const row = await one<Party>(
    `INSERT INTO ocpi_party (org_id, country_code, party_id, business_name, website)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (org_id) DO UPDATE SET country_code = EXCLUDED.country_code, party_id = EXCLUDED.party_id,
       business_name = EXCLUDED.business_name, website = EXCLUDED.website, updated_at = now()
     RETURNING country_code, party_id, business_name, website`,
    [orgId, p.country_code, p.party_id, p.business_name, p.website ?? null],
  );
  return row!;
}

// ─────────────────────────────────────────────── partners

export interface Endpoint { identifier: string; role: 'SENDER' | 'RECEIVER'; url: string }
export interface RoleEntry { role: string; party_id: string; country_code: string; business_details?: { name?: string; website?: string } }

export interface PartnerRow {
  id: string;
  org_id: string;
  name: string;
  kind: 'emsp' | 'cpo' | 'hub';
  state: 'pending' | 'connected' | 'suspended' | 'closed';
  token_in: string | null;
  token_in_hash: string | null;
  token_out: string | null;
  versions_url: string | null;
  version: string | null;
  endpoints: Endpoint[];
  roles: RoleEntry[];
  country_code: string | null;
  party_id: string | null;
  last_error: string | null;
  last_success_at: Date | null;
  registered_at: Date | null;
  created_at: Date;
}

export async function partnerByTokenHash(hashes: string[]): Promise<PartnerRow | null> {
  if (!hashes.length) return null;
  return one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE token_in_hash = ANY($1) AND state IN ('pending','connected') LIMIT 1`, [hashes]);
}

export async function getPartner(orgId: string, id: string): Promise<PartnerRow | null> {
  return one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE id = $1 AND org_id = $2`, [id, orgId]);
}

export function endpointUrl(p: Pick<PartnerRow, 'endpoints'>, identifier: string, role: 'SENDER' | 'RECEIVER'): string | null {
  const list = Array.isArray(p.endpoints) ? p.endpoints : [];
  return (list.find((e) => e.identifier === identifier && e.role === role) ?? list.find((e) => e.identifier === identifier && !e.role))?.url ?? null;
}

/**
 * May this partner act for (country_code, party_id)? A partner acts for the
 * roles it registered with. A hub acts for the parties behind it: once it has
 * told us who they are (HubClientInfo), only those that are CONNECTED or
 * OFFLINE; until then, anyone.
 */
export async function partnerActsFor(p: Pick<PartnerRow, 'id' | 'kind' | 'roles'>, cc: string, pid: string): Promise<boolean> {
  if ((p.roles ?? []).some((r) => r.country_code === cc && r.party_id === pid)) return true;
  if (p.kind !== 'hub') return false;
  const r = await one<{ known: boolean; allowed: boolean }>(
    `SELECT count(*) > 0 AS known,
            bool_or(country_code = $2 AND party_id = $3 AND status IN ('CONNECTED','OFFLINE')) AS allowed
       FROM ocpi_hub_client WHERE partner_id = $1`,
    [p.id, cc, pid],
  );
  return !r?.known || !!r.allowed;
}

// ─────────────────────────────────────────────── locations

interface EvseRow {
  site_id: string;
  charge_point_id: string;
  ocpp_identity: string;
  display_name: string | null;
  decommissioned: boolean;
  evse_no: number;
  connector_uuid: string;
  connector_id: number;
  connector_type: string | null;
  current_type: string;
  phases: number | null;
  max_power_w: number;
  rated_voltage_v: number | null;
  rated_current_a: number | null;
  status: string | null;
  maintenance_reason: string | null;
  meter_serial: string | null;
  status_at: Date | null;
  reserved: boolean;
}

const SITE_COLS = `s.id, s.name, s.address, s.city, s.postal_code, s.lat, s.lon, s.timezone,
                   s.roaming_publish, s.billing_model, s.archived_at`;

async function evseRows(orgId: string, siteIds: string[]): Promise<EvseRow[]> {
  if (!siteIds.length) return [];
  return many<EvseRow>(
    `SELECT cp.site_id, cp.id AS charge_point_id, cp.ocpp_identity, cp.display_name,
            (cp.status = 'decommissioned' OR cp.decommissioned_at IS NOT NULL) AS decommissioned,
            e.evse_id AS evse_no, c.id AS connector_uuid, c.connector_id, c.connector_type, c.current_type,
            c.phases, c.max_power_w, c.rated_voltage_v, c.rated_current_a, c.status, c.maintenance_reason,
            c.meter_serial,
            GREATEST(c.status_updated_at, cp.offline_since, cp.adopted_at, cp.commissioned_at) AS status_at,
            (EXISTS (SELECT 1 FROM ocpi_reservation r
                      WHERE r.charge_point_id = cp.id AND r.connector_no = e.evse_id
                        AND r.state = 'active' AND r.expires_at > now())
             OR EXISTS (SELECT 1 FROM driver_reservation dr
                         WHERE dr.connector_uuid = c.id AND dr.state = 'active' AND dr.expires_at > now())) AS reserved
       FROM charge_point cp
       JOIN site s ON s.id = cp.site_id
       JOIN evse e ON e.charge_point_id = cp.id
       JOIN connector c ON c.evse_uuid = e.id
      WHERE s.org_id = $1 AND cp.site_id = ANY($2::uuid[])
        AND cp.status NOT IN ('pending_adoption', 'suspended')
        AND e.evse_id > 0
        -- A charger decommissioned more than 30 days ago is no longer listed at all.
        AND (cp.decommissioned_at IS NULL OR cp.decommissioned_at > now() - interval '30 days')
      ORDER BY cp.ocpp_identity, e.evse_id, c.connector_id`,
    [orgId, siteIds],
  );
}

async function objectStates(orgId: string, type: 'location' | 'tariff') {
  const rows = await many<{ object_id: string; hash: string; last_updated: Date; removed_at: Date | null }>(
    `SELECT object_id, hash, last_updated, removed_at FROM ocpi_object_state WHERE org_id = $1 AND object_type = $2`,
    [orgId, type],
  );
  return new Map(rows.map((r) => [r.object_id, r]));
}

export interface RenderedLocation {
  siteId: string;
  published: boolean;
  problem: string | null;
  location: ReturnType<typeof buildLocation>;
  /** EVSE uid -> the charger and evse number behind it, for commands. */
  evses: Array<{ uid: string; chargePointId: string; ocppIdentity: string; evseNo: number; connectorUuids: string[]; online: boolean; status: string }>;
  tariffIds: string[];
}

/**
 * Locations as partners should see them. `onlyPublished` (the default) drops
 * sites that are not opted in, archived, private-billed or incomplete.
 */
export async function renderLocations(
  orgId: string,
  party: Party,
  opts: { siteId?: string; onlyPublished?: boolean } = {},
): Promise<RenderedLocation[]> {
  const sites = await many<SiteIn & { roaming_publish: boolean; billing_model: string; archived_at: Date | null }>(
    `SELECT ${SITE_COLS} FROM site s WHERE s.org_id = $1 AND ($2::uuid IS NULL OR s.id = $2) ORDER BY s.created_at`,
    [orgId, opts.siteId ?? null],
  );
  const states = await objectStates(orgId, 'location');
  const rows = await evseRows(orgId, sites.map((s) => s.id));
  const now = new Date();
  const out: RenderedLocation[] = [];

  for (const s of sites) {
    const problem = s.archived_at ? 'the site is archived'
      : s.billing_model === 'private' ? 'private sites (billed as a platform fee) cannot be shared'
      : locationProblem(s);
    const published = !!s.roaming_publish && !problem;
    if ((opts.onlyPublished ?? true) && !published) continue;

    const siteLast = states.get(s.id)?.last_updated ?? now;
    const byEvse = new Map<string, EvseRow[]>();
    for (const r of rows.filter((x) => x.site_id === s.id)) {
      const k = `${r.charge_point_id}:${r.evse_no}`;
      byEvse.set(k, [...(byEvse.get(k) ?? []), r]);
    }
    const tariffIds = new Set<string>();
    const evses: EvseIn[] = [];
    const refs: RenderedLocation['evses'] = [];
    for (const list of byEvse.values()) {
      const f = list[0]!;
      const online = registry.isOnline(f.ocpp_identity);
      const connectors: ConnectorIn[] = [];
      for (const r of list) {
        let tariffId: string | null = null;
        if (!r.decommissioned) {
          const t = await loadTariffForConnector(r.connector_uuid, orgId, now).catch(() => null);
          if (t && !t.fallback) { tariffId = t.tariff.id; tariffIds.add(t.tariff.id); }
        }
        connectors.push({
          connector_id: r.connector_id,
          connector_type: r.connector_type,
          current_type: r.current_type,
          phases: r.phases,
          max_power_w: Number(r.max_power_w),
          rated_voltage_v: r.rated_voltage_v,
          rated_current_a: r.rated_current_a,
          status: r.status,
          maintenance_reason: r.maintenance_reason,
          tariff_id: tariffId,
          last_updated: siteLast,
        });
      }
      const statusAt = list.map((r) => r.status_at).filter(Boolean).map((d) => new Date(d!));
      const last = [siteLast, ...statusAt].reduce((a, b) => (b > a ? b : a));
      const e: EvseIn = {
        ocpp_identity: f.ocpp_identity,
        evse_no: f.evse_no,
        display_name: f.display_name,
        decommissioned: f.decommissioned,
        online,
        reserved: f.reserved,
        connectors,
        last_updated: last,
      };
      evses.push(e);
      refs.push({
        uid: evseUid(f.ocpp_identity, f.evse_no),
        chargePointId: f.charge_point_id,
        ocppIdentity: f.ocpp_identity,
        evseNo: f.evse_no,
        connectorUuids: list.map((r) => r.connector_uuid),
        online,
        status: f.status ?? 'Unknown',
      });
    }
    out.push({
      siteId: s.id,
      published,
      problem,
      location: buildLocation(party, { ...s, last_updated: siteLast }, evses, { publish: published }),
      evses: refs,
      tariffIds: [...tariffIds],
    });
  }
  return out;
}

/** The published location and EVSE a charger's connector belongs to, if any. */
export async function locationRefOfChargePoint(orgId: string, chargePointId: string) {
  return one<{ site_id: string; ocpp_identity: string; published: boolean }>(
    `SELECT cp.site_id, cp.ocpp_identity, (s.roaming_publish AND s.archived_at IS NULL AND s.billing_model <> 'private') AS published
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE cp.id = $1 AND s.org_id = $2`,
    [chargePointId, orgId],
  );
}

// ─────────────────────────────────────────────── tariffs

export async function renderTariffs(orgId: string, party: Party, ids: string[]) {
  const states = await objectStates(orgId, 'tariff');
  const out: Array<{ id: string; tariff: ReturnType<typeof buildTariff> }> = [];
  for (const id of ids) {
    const t = await loadTariffById(id);
    const row = await one<{ active_from: Date | null; active_to: Date | null; created_at: Date }>(
      `SELECT active_from, active_to, created_at FROM tariff WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (!t || !row) continue;
    out.push({
      id,
      tariff: buildTariff(party, {
        tariff: t,
        active_from: row.active_from,
        active_to: row.active_to,
        last_updated: states.get(id)?.last_updated ?? row.created_at,
      }),
    });
  }
  return out;
}

/** Tariffs in use on published connectors right now. */
export async function publishedTariffIds(orgId: string, party: Party): Promise<string[]> {
  const locs = await renderLocations(orgId, party);
  return [...new Set(locs.flatMap((l) => l.tariffIds))];
}

// ─────────────────────────────────────────────── sessions and CDRs

const SESSION_SELECT = `
  SELECT cs.id, cs.org_id, cs.state, cs.started_at, cs.ended_at, cs.energy_wh, cs.idle_minutes,
         cs.ocpi_auth_method, cs.ocpi_authorization_reference, cs.ocpi_partner_id, cs.site_id,
         cp.ocpp_identity, e.evse_id AS evse_no, c.connector_id, c.meter_serial,
         t.country_code AS t_cc, t.party_id AS t_pid, t.uid AS t_uid, t.type AS t_type, t.contract_id AS t_contract,
         d.id AS cdr_id, d.subtotal_idr, d.pbjt_idr, d.total_idr,
         GREATEST(cs.started_at, cs.last_meter_at, cs.ended_at, cs.rated_at, d.issued_at) AS last_updated
    FROM charging_session cs
    JOIN charge_point cp ON cp.id = cs.charge_point_id
    JOIN connector c ON c.id = cs.connector_uuid
    JOIN evse e ON e.id = c.evse_uuid
    JOIN ocpi_token t ON t.id = cs.ocpi_token_id
    LEFT JOIN cdr d ON d.session_id = cs.id`;

interface SessionRowOut {
  id: string; org_id: string; state: string; started_at: Date; ended_at: Date | null; energy_wh: number; idle_minutes: number;
  ocpi_auth_method: string | null; ocpi_authorization_reference: string | null; ocpi_partner_id: string; site_id: string;
  ocpp_identity: string; evse_no: number; connector_id: number; meter_serial: string | null;
  t_cc: string; t_pid: string; t_uid: string; t_type: string; t_contract: string;
  cdr_id: string | null; subtotal_idr: number | null; pbjt_idr: number | null; total_idr: number | null; last_updated: Date;
}

const tokenRefOf = (r: SessionRowOut): TokenRef => ({ country_code: r.t_cc, party_id: r.t_pid, uid: r.t_uid, type: r.t_type, contract_id: r.t_contract });

function sessionIn(r: SessionRowOut): SessionIn & { idle_minutes: number } {
  return {
    id: r.id,
    state: r.state,
    started_at: r.started_at,
    ended_at: r.ended_at,
    energy_wh: Number(r.energy_wh),
    idle_minutes: Number(r.idle_minutes ?? 0),
    auth_method: r.ocpi_auth_method,
    authorization_reference: r.ocpi_authorization_reference,
    location_id: r.site_id,
    evse_uid: evseUid(r.ocpp_identity, r.evse_no),
    connector_id: String(r.connector_id),
    meter_id: r.meter_serial,
    cost: r.total_idr != null ? { subtotal_idr: Number(r.subtotal_idr), pbjt_idr: Number(r.pbjt_idr), total_idr: Number(r.total_idr) } : null,
    last_updated: r.last_updated,
  };
}

export async function renderSession(sessionId: string) {
  const r = await one<SessionRowOut>(`${SESSION_SELECT} WHERE cs.id = $1`, [sessionId]);
  if (!r) return null;
  const party = await getParty(r.org_id);
  if (!party) return null;
  return { orgId: r.org_id, partnerId: r.ocpi_partner_id, token: tokenRefOf(r), cdrId: r.cdr_id, session: buildSession(party, sessionIn(r), tokenRefOf(r)) };
}

export async function listSessions(orgId: string, partnerId: string, party: Party, p: { dateFrom: Date | null; dateTo: Date | null; offset: number; limit: number }) {
  const where = `WHERE cs.org_id = $1 AND cs.ocpi_partner_id = $2
     AND ($3::timestamptz IS NULL OR GREATEST(cs.started_at, cs.last_meter_at, cs.ended_at, cs.rated_at, d.issued_at) >= $3)
     AND ($4::timestamptz IS NULL OR GREATEST(cs.started_at, cs.last_meter_at, cs.ended_at, cs.rated_at, d.issued_at) < $4)`;
  const total = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM charging_session cs LEFT JOIN cdr d ON d.session_id = cs.id ${where}`,
    [orgId, partnerId, p.dateFrom, p.dateTo],
  );
  const rows = await many<SessionRowOut>(`${SESSION_SELECT} ${where} ORDER BY cs.started_at, cs.id OFFSET $5 LIMIT $6`, [orgId, partnerId, p.dateFrom, p.dateTo, p.offset, p.limit]);
  return { total: total?.n ?? 0, items: rows.map((r) => buildSession(party, sessionIn(r), tokenRefOf(r))) };
}

async function cdrFromRow(r: SessionRowOut, party: Party) {
  if (!r.cdr_id) return null;
  const d = await one<{ id: string; issued_at: Date; lines: CdrLine[]; subtotal_idr: number; pbjt_idr: number; total_idr: number; tariff_snapshot: Tariff | null }>(
    `SELECT id, issued_at, lines, subtotal_idr, pbjt_idr, total_idr, tariff_snapshot FROM cdr WHERE id = $1`,
    [r.cdr_id],
  );
  if (!d) return null;
  const site = await one<SiteIn>(`SELECT s.id, s.name, s.address, s.city, s.postal_code, s.lat, s.lon, s.timezone, now() AS last_updated FROM site s WHERE s.id = $1`, [r.site_id]);
  const conn = await one<ConnectorIn & { phases: number }>(
    `SELECT c.connector_id, c.connector_type, c.current_type, c.phases, c.max_power_w, c.rated_voltage_v, c.rated_current_a,
            c.status, c.maintenance_reason, NULL::text AS tariff_id, now() AS last_updated
       FROM charging_session cs JOIN connector c ON c.id = cs.connector_uuid WHERE cs.id = $1`,
    [r.id],
  );
  if (!site || !conn) return null;
  const tariff = d.tariff_snapshot && (d.tariff_snapshot as Tariff).id && (d.tariff_snapshot as Tariff).id !== 'default' ? (d.tariff_snapshot as Tariff) : null;
  const built = buildCdr(party, {
    id: d.id,
    issued_at: d.issued_at,
    lines: d.lines ?? [],
    subtotal_idr: Number(d.subtotal_idr),
    pbjt_idr: Number(d.pbjt_idr),
    total_idr: Number(d.total_idr),
    tariff,
    session: sessionIn(r),
    site,
    evse: { ocpp_identity: r.ocpp_identity, evse_no: r.evse_no, display_name: null, decommissioned: false, online: true, connectors: [conn], last_updated: d.issued_at },
    connector: conn,
  }, tokenRefOf(r));
  // The meter's signed readings (OCMF), so the partner can pass them to its driver (OCPI SignedData).
  const signed = await signedDataFor(r.id).catch(() => null);
  const sd = signed ? ocpiSignedData(signed) : null;
  return sd ? { ...built, signed_data: sd } : built;
}

export async function renderCdrForSession(sessionId: string) {
  const r = await one<SessionRowOut>(`${SESSION_SELECT} WHERE cs.id = $1`, [sessionId]);
  if (!r) return null;
  const party = await getParty(r.org_id);
  if (!party) return null;
  const cdr = await cdrFromRow(r, party);
  return cdr ? { orgId: r.org_id, partnerId: r.ocpi_partner_id, token: tokenRefOf(r), cdr } : null;
}

export async function listCdrs(orgId: string, partnerId: string, party: Party, p: { dateFrom: Date | null; dateTo: Date | null; offset: number; limit: number }) {
  const where = `WHERE cs.org_id = $1 AND cs.ocpi_partner_id = $2 AND d.id IS NOT NULL
     AND ($3::timestamptz IS NULL OR d.issued_at >= $3) AND ($4::timestamptz IS NULL OR d.issued_at < $4)`;
  const total = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM charging_session cs LEFT JOIN cdr d ON d.session_id = cs.id ${where}`,
    [orgId, partnerId, p.dateFrom, p.dateTo],
  );
  const rows = await many<SessionRowOut>(`${SESSION_SELECT} ${where} ORDER BY d.issued_at, d.id OFFSET $5 LIMIT $6`, [orgId, partnerId, p.dateFrom, p.dateTo, p.offset, p.limit]);
  const items = [];
  for (const r of rows) {
    const c = await cdrFromRow(r, party);
    if (c) items.push(c);
  }
  return { total: total?.n ?? 0, items };
}

// ─────────────────────────────────────────────── tokens

export interface TokenRow extends TokenIn { id: string; org_id: string; partner_id: string }

export async function upsertToken(partner: Pick<PartnerRow, 'id' | 'org_id'>, t: TokenIn): Promise<TokenRow> {
  const row = await one<TokenRow>(
    `INSERT INTO ocpi_token (org_id, partner_id, country_code, party_id, uid, type, contract_id, visual_number, issuer,
                             group_id, valid, whitelist, language, default_profile_type, energy_contract, last_updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (org_id, country_code, party_id, uid, type) DO UPDATE SET
       partner_id = EXCLUDED.partner_id, contract_id = EXCLUDED.contract_id, visual_number = EXCLUDED.visual_number,
       issuer = EXCLUDED.issuer, group_id = EXCLUDED.group_id, valid = EXCLUDED.valid, whitelist = EXCLUDED.whitelist,
       language = EXCLUDED.language, default_profile_type = EXCLUDED.default_profile_type,
       energy_contract = EXCLUDED.energy_contract, last_updated = EXCLUDED.last_updated, received_at = now()
     RETURNING *`,
    [partner.org_id, partner.id, t.country_code, t.party_id, t.uid, t.type, t.contract_id, t.visual_number, t.issuer,
      t.group_id, t.valid, t.whitelist, t.language, t.default_profile_type,
      t.energy_contract ? JSON.stringify(t.energy_contract) : null, t.last_updated],
  );
  return row!;
}

export async function getToken(orgId: string, cc: string, pid: string, uid: string, type: string): Promise<TokenRow | null> {
  return one<TokenRow>(
    `SELECT * FROM ocpi_token WHERE org_id = $1 AND country_code = $2 AND party_id = $3 AND uid = $4 AND type = $5`,
    [orgId, cc, pid, uid, type],
  );
}

export async function logMessage(m: {
  orgId: string; partnerId: string | null; direction: 'in' | 'out'; method: string; url: string;
  httpStatus: number | null; ocpiStatus: number | null; ms: number; error: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO ocpi_message (org_id, partner_id, direction, method, url, http_status, ocpi_status, duration_ms, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [m.orgId, m.partnerId, m.direction, m.method, m.url.slice(0, 1000), m.httpStatus, m.ocpiStatus, Math.round(m.ms), m.error?.slice(0, 500) ?? null],
  ).catch(() => {});
}
