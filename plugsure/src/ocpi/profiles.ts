import { randomUUID } from 'node:crypto';
import { one, query } from '../db/pool.js';
import { config } from '../config.js';
import * as ocpp from '../ocpp/commands.js';
import * as registry from '../ocpp/registry.js';
import { runControlLoop, LOAD_MGMT_STACK } from '../services/smartcharging.js';
import { parseChargingProfile, ocpiDateTime, STATUS, type ChargingProfileIn } from './mapping.js';
import { partnerUrlProblem } from './client.js';
import { enqueuePush } from './push.js';
import type { ActingParty, PartnerRow } from './store.js';

/**
 * ChargingProfiles, CPO role (OCPI 2.2.1 § 14): a partner (the driver's eMSP,
 * or a smart-charging provider behind it) limits how fast one of its drivers'
 * sessions on our chargers may charge, asks what is in force, or lifts its
 * limit again.
 *
 * The limit never goes to the charger directly. It caps the session in site
 * load management, which remains the only thing that writes transaction
 * profiles, so a partner can slow a session down but never push it past the
 * site's power budget, the breaker or the PLN subscription. The next control
 * pass runs straight away; its result goes to the partner's response_url.
 */

export type ProfileResult = 'ACCEPTED' | 'NOT_SUPPORTED' | 'REJECTED' | 'TOO_OFTEN' | 'UNKNOWN_SESSION';

export interface ProfileOutcome {
  http: number;
  ocpiStatus: number;
  response?: { result: ProfileResult; timeout: number };
  message?: string;
  followUp?: () => Promise<void>;
}

/** A partner may change a session's profile at most this often. */
export const MIN_INTERVAL_S = 5;

interface SessionRow {
  id: string;
  org_id: string;
  site_id: string;
  charge_point_id: string;
  connector_uuid: string;
  ocpp_identity: string;
  evse_no: number;
  started_at: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The partner's driver's active session. Behind a hub (`acting` = the eMSP in OCPI-from), the session's
 * token must also be that eMSP's: the hub's connection carries every eMSP behind it (v1.7.1, WP H0).
 */
async function activeSession(partner: PartnerRow, sessionId: string, acting: ActingParty | null): Promise<SessionRow | null> {
  if (!UUID_RE.test(sessionId)) return null;
  return one<SessionRow>(
    `SELECT cs.id, cs.org_id, cs.site_id, cs.charge_point_id, cs.connector_uuid, cp.ocpp_identity, e.evse_id AS evse_no, cs.started_at
       FROM charging_session cs
       JOIN charge_point cp ON cp.id = cs.charge_point_id
       JOIN connector c ON c.id = cs.connector_uuid
       JOIN evse e ON e.id = c.evse_uuid
      WHERE cs.id = $1 AND cs.org_id = $2 AND cs.ocpi_partner_id = $3 AND cs.state = 'active'
        AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM ocpi_token tk WHERE tk.id = cs.ocpi_token_id AND tk.country_code = $4 AND tk.party_id = $5))`,
    [sessionId, partner.org_id, partner.id, acting?.country_code ?? null, acting?.party_id ?? null],
  );
}

const accepted = (followUp: () => Promise<void>): ProfileOutcome =>
  ({ http: 200, ocpiStatus: STATUS.OK, response: { result: 'ACCEPTED', timeout: config.ocpi.commandTimeoutS }, followUp });
const answer = (result: ProfileResult): ProfileOutcome => ({ http: 200, ocpiStatus: STATUS.OK, response: { result, timeout: 0 } });
const invalid = (message: string): ProfileOutcome => ({ http: 400, ocpiStatus: STATUS.INVALID_PARAMS, message });

function checkResponseUrl(url: unknown): string | ProfileOutcome {
  const u = typeof url === 'string' ? url : '';
  const problem = partnerUrlProblem(u);
  return !u || problem ? invalid(`response_url ${problem ?? 'is required'}`) : u;
}

/**
 * POST a result to the partner's response_url, through the outbox (it survives a partner outage).
 * Through a hub it is addressed (OCPI-to) to the eMSP that asked, not to the hub.
 */
async function sendResult(partner: PartnerRow, url: string, body: unknown, acting: ActingParty | null) {
  await enqueuePush({
    orgId: partner.org_id, partnerId: partner.id, module: 'chargingprofiles', action: 'result',
    objectKey: `profile:${randomUUID()}`, url, body, to: acting ?? { country_code: partner.country_code, party_id: partner.party_id }, always: true,
  });
}

/**
 * Run the site's control pass now and say whether the charger took the
 * transaction profile it produced. An offline charger, or one that refused the
 * profile, is REJECTED; the limit stays recorded and applies on the next pass
 * the charger accepts.
 */
async function applyNow(s: SessionRow): Promise<'ACCEPTED' | 'REJECTED'> {
  if (!registry.isOnline(s.ocpp_identity)) return 'REJECTED';
  const since = new Date(Date.now() - 1000);
  await runControlLoop(s.site_id);
  const r = await one<{ state: string }>(
    `SELECT state FROM charging_profile
      WHERE charge_point_id = $1 AND connector_no = $2 AND purpose = 'TxProfile' AND stack_level = $3 AND sent_at >= $4
      ORDER BY sent_at DESC LIMIT 1`,
    [s.charge_point_id, s.evse_no, LOAD_MGMT_STACK, since],
  );
  return r?.state === 'accepted' ? 'ACCEPTED' : 'REJECTED';
}

/** PUT {session_id}: set (or replace) the partner's limit for this session. */
export async function setProfile(partner: PartnerRow, sessionId: string, b: any, acting: ActingParty | null = null): Promise<ProfileOutcome> {
  const url = checkResponseUrl(b?.response_url);
  if (typeof url !== 'string') return url;
  const profile = parseChargingProfile(b?.charging_profile);
  if (typeof profile === 'string') return invalid(profile);
  const s = await activeSession(partner, sessionId, acting);
  if (!s) return answer('UNKNOWN_SESSION');
  const prev = await one<{ recent: boolean }>(
    `SELECT received_at > now() - make_interval(secs => $2) AS recent FROM ocpi_charging_profile WHERE session_id = $1`,
    [s.id, MIN_INTERVAL_S],
  );
  if (prev?.recent) return answer('TOO_OFTEN');
  await query(
    `INSERT INTO ocpi_charging_profile (session_id, org_id, partner_id, profile, response_url)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (session_id) DO UPDATE
       SET profile = EXCLUDED.profile, response_url = EXCLUDED.response_url, received_at = now(), last_result = NULL, applied_at = NULL`,
    [s.id, s.org_id, partner.id, JSON.stringify(profile), url],
  );
  return accepted(async () => {
    const result = await applyNow(s);
    await query(`UPDATE ocpi_charging_profile SET last_result = $2, applied_at = CASE WHEN $2 = 'ACCEPTED' THEN now() END WHERE session_id = $1`, [s.id, result]);
    await sendResult(partner, url, { result }, acting);
  });
}

/** DELETE {session_id}: lift the partner's limit. */
export async function clearProfile(partner: PartnerRow, sessionId: string, responseUrl: unknown, acting: ActingParty | null = null): Promise<ProfileOutcome> {
  const url = checkResponseUrl(responseUrl);
  if (typeof url !== 'string') return url;
  const s = await activeSession(partner, sessionId, acting);
  if (!s) return answer('UNKNOWN_SESSION');
  const gone = await query(`DELETE FROM ocpi_charging_profile WHERE session_id = $1`, [s.id]);
  return accepted(async () => {
    // Nothing to lift: OCPI's UNKNOWN ("no profile matched the request").
    const result = (gone.rowCount ?? 0) === 0 ? 'UNKNOWN' : await applyNow(s);
    await sendResult(partner, url, { result }, acting);
  });
}

/**
 * GET {session_id}?duration=&response_url=: what is in force for the next
 * `duration` seconds. Asked of the charger (GetCompositeSchedule); a charger
 * that answers without a schedule is described by the last profile we sent it.
 */
export async function activeProfile(partner: PartnerRow, sessionId: string, q: Record<string, unknown>, acting: ActingParty | null = null): Promise<ProfileOutcome> {
  const url = checkResponseUrl(q?.response_url);
  if (typeof url !== 'string') return url;
  const duration = Number(q?.duration);
  if (!Number.isInteger(duration) || duration <= 0 || duration > 86_400) return invalid('duration must be a whole number of seconds, up to 86400');
  const s = await activeSession(partner, sessionId, acting);
  if (!s) return answer('UNKNOWN_SESSION');
  return accepted(async () => {
    const now = new Date();
    let profile: { start_date_time: string; charging_profile: ChargingProfileIn } | null = null;
    let result: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN' = 'REJECTED';
    try {
      const r = await ocpp.getCompositeSchedule(s.ocpp_identity, s.evse_no, duration, undefined, { type: 'api_client', id: `ocpi:${partner.name}`.slice(0, 100), orgId: partner.org_id });
      if (r?.status === 'Accepted') {
        const cs = (r.chargingSchedule ?? null) as any;
        const periods = Array.isArray(cs?.chargingSchedulePeriod) ? cs.chargingSchedulePeriod : [];
        if (periods.length) {
          const start = ocpiDateTime(r.scheduleStart ?? cs.startSchedule ?? now);
          profile = { start_date_time: start, charging_profile: {
            start_date_time: start,
            ...(cs.duration ? { duration: Number(cs.duration) } : { duration }),
            charging_rate_unit: cs.chargingRateUnit === 'A' ? 'A' : 'W',
            ...(cs.minChargingRate != null ? { min_charging_rate: Number(cs.minChargingRate) } : {}),
            charging_profile_period: periods.map((p: any) => ({ start_period: Number(p.startPeriod) || 0, limit: Number(p.limit) || 0 })),
          } };
        } else {
          profile = await lastSent(s, now, duration);
        }
        result = profile ? 'ACCEPTED' : 'UNKNOWN';
      }
    } catch { result = 'REJECTED'; }
    await sendResult(partner, url, { result, ...(profile ? { profile } : {}) }, acting);
  });
}

async function lastSent(s: SessionRow, now: Date, duration: number) {
  const r = await one<{ unit: 'A' | 'W'; limit_value: string }>(
    `SELECT unit, limit_value FROM charging_profile
      WHERE charge_point_id = $1 AND connector_no = $2 AND purpose = 'TxProfile' AND state = 'accepted' AND cleared_at IS NULL
        AND sent_at >= $3
      ORDER BY sent_at DESC LIMIT 1`,
    [s.charge_point_id, s.evse_no, s.started_at],
  );
  if (!r) return null;
  const start = ocpiDateTime(now);
  return { start_date_time: start, charging_profile: {
    start_date_time: start, duration, charging_rate_unit: r.unit, charging_profile_period: [{ start_period: 0, limit: Number(r.limit_value) }],
  } as ChargingProfileIn };
}
