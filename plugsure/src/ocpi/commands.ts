import { randomUUID } from 'node:crypto';
import { one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import * as ocpp from '../ocpp/commands.js';
import * as registry from '../ocpp/registry.js';
import { parseToken, STATUS, type Party } from './mapping.js';
import { renderLocations, getParties, upsertToken, partnerActsFor, isActing, type ActingParty, type PartnerRow, type RenderedLocation } from './store.js';
import { partnerUrlProblem } from './client.js';
import { enqueuePush } from './push.js';

/**
 * Commands from a partner (OCPI 2.2.1 § 13): START_SESSION, STOP_SESSION,
 * UNLOCK_CONNECTOR, RESERVE_NOW, CANCEL_RESERVATION.
 *
 * The HTTP answer only says whether the command will be forwarded to the
 * charger. What the charger then did is POSTed to the partner's response_url
 * as a CommandResult, through the outbox, so it survives a partner outage.
 */

export type CommandResponse = { result: 'ACCEPTED' | 'REJECTED' | 'NOT_SUPPORTED' | 'UNKNOWN_SESSION'; timeout: number; message?: Array<{ language: string; text: string }> };
type ResultType = 'ACCEPTED' | 'CANCELED_RESERVATION' | 'EVSE_OCCUPIED' | 'EVSE_INOPERATIVE' | 'FAILED' | 'NOT_SUPPORTED' | 'REJECTED' | 'TIMEOUT' | 'UNKNOWN_RESERVATION';

export interface CommandOutcome {
  ocpiStatus: number;
  response: CommandResponse;
  /** Runs after the HTTP answer has been sent. */
  followUp?: () => Promise<void>;
}

const text = (t: string) => [{ language: 'en', text: t }];
const reject = (why: string, ocpiStatus: number = STATUS.OK, result: CommandResponse['result'] = 'REJECTED'): CommandOutcome =>
  ({ ocpiStatus, response: { result, timeout: 0, message: text(why) } });
const accept = (followUp: () => Promise<void>): CommandOutcome =>
  ({ ocpiStatus: STATUS.OK, response: { result: 'ACCEPTED', timeout: config.ocpi.commandTimeoutS }, followUp });

async function sendResult(partner: PartnerRow, from: { country_code: string | null; party_id: string | null }, url: string, result: ResultType, message?: string) {
  await enqueuePush({
    orgId: partner.org_id,
    partnerId: partner.id,
    module: 'commands',
    action: 'result',
    objectKey: `command:${randomUUID()}`,
    url,
    body: { result, ...(message ? { message: text(message) } : {}) },
    to: from,
    always: true,
  });
}

/** Map a charger's answer (or failure) to a CommandResult. */
async function charger(fn: () => Promise<{ status?: string } | undefined>, accepted: string[] = ['Accepted']): Promise<[ResultType, string?]> {
  try {
    const r = await fn();
    const s = String(r?.status ?? '');
    if (accepted.includes(s)) return ['ACCEPTED'];
    if (s === 'Occupied') return ['EVSE_OCCUPIED', 'the connector is in use'];
    if (s === 'Faulted' || s === 'Unavailable') return ['EVSE_INOPERATIVE', `the charger answered ${s}`];
    if (s === 'NotSupported' || s === 'UnlockFailed') return [s === 'NotSupported' ? 'NOT_SUPPORTED' : 'FAILED', `the charger answered ${s}`];
    return ['REJECTED', `the charger answered ${s || 'nothing'}`];
  } catch (e) {
    const m = (e as Error).message;
    if (/timeout|timed out/i.test(m)) return ['TIMEOUT', 'the charger did not answer'];
    if (/not connected/i.test(m)) return ['EVSE_INOPERATIVE', 'the charger is offline'];
    return ['FAILED', m.slice(0, 200)];
  }
}

function pickEvse(loc: RenderedLocation, evseUid?: string) {
  if (evseUid) return loc.evses.find((e) => e.uid === evseUid) ?? null;
  return loc.evses.find((e) => e.online && e.status === 'Available') ?? loc.evses[0] ?? null;
}

export async function handleCommand(
  partner: PartnerRow,
  party: Party,
  from: { country_code: string | null; party_id: string | null },
  command: string,
  b: any,
  /**
   * The eMSP behind a hub that sent the command (OCPI-from, checked against the hub's clients): it may act
   * only on its own drivers' sessions, reservations and tokens (v1.7.1, WP H0). null for a peer connection.
   */
  acting: ActingParty | null = null,
): Promise<CommandOutcome> {
  const known = ['START_SESSION', 'STOP_SESSION', 'UNLOCK_CONNECTOR', 'RESERVE_NOW', 'CANCEL_RESERVATION'];
  if (!known.includes(command)) return reject(`unknown command ${command}`, STATUS.OK, 'NOT_SUPPORTED');
  const responseUrl = typeof b?.response_url === 'string' ? b.response_url : '';
  const urlProblem = partnerUrlProblem(responseUrl);
  if (!responseUrl || urlProblem) return reject(`response_url ${urlProblem ?? 'is required'}`, STATUS.INVALID_PARAMS);
  const actor = { type: 'api_client' as const, id: `ocpi:${partner.name}`.slice(0, 100), orgId: partner.org_id };
  const done = (r: ResultType, m?: string) => sendResult(partner, from, responseUrl, r, m);

  // The acting party's own objects only (no acting party: every object of this connection).
  const ownToken = (col: string, n: number) =>
    `AND ($${n}::text IS NULL OR EXISTS (SELECT 1 FROM ocpi_token tk WHERE tk.id = ${col} AND tk.country_code = $${n} AND tk.party_id = $${n + 1}))`;
  const actingArgs = [acting?.country_code ?? null, acting?.party_id ?? null];

  const location = async (id: unknown) => {
    if (typeof id !== 'string' || !id) return null;
    // Every party of ours: a location is published under its own country's party only (store.ts pickParty).
    const [l] = await renderLocations(partner.org_id, await getParties(partner.org_id), { siteId: /^[0-9a-f-]{36}$/i.test(id) ? id : '00000000-0000-0000-0000-000000000000' });
    return l ?? null;
  };

  // ── STOP_SESSION
  if (command === 'STOP_SESSION') {
    const s = typeof b?.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(b.session_id)
      ? await one<{ ocpp_transaction_id: string; ocpp_identity: string }>(
          `SELECT cs.ocpp_transaction_id, cp.ocpp_identity FROM charging_session cs JOIN charge_point cp ON cp.id = cs.charge_point_id
            WHERE cs.id = $1 AND cs.org_id = $2 AND cs.ocpi_partner_id = $3 AND cs.state = 'active' ${ownToken('cs.ocpi_token_id', 4)}`,
          [b.session_id, partner.org_id, partner.id, ...actingArgs])
      : null;
    if (!s) return reject('no active session with that id for this partner', STATUS.OK, 'UNKNOWN_SESSION');
    return accept(async () => {
      const [r, m] = await charger(() => ocpp.remoteStopTransaction(s.ocpp_identity, registry.wireTransactionId(s.ocpp_identity, s.ocpp_transaction_id), actor));
      await done(r, m);
    });
  }

  // ── CANCEL_RESERVATION
  if (command === 'CANCEL_RESERVATION') {
    const res = typeof b?.reservation_id === 'string'
      ? await one<{ id: number; ocpp_identity: string }>(
          `SELECT r.id, cp.ocpp_identity FROM ocpi_reservation r JOIN charge_point cp ON cp.id = r.charge_point_id
            WHERE r.partner_id = $1 AND r.ocpi_reservation_id = $2 AND r.state IN ('requested','active') ${ownToken('r.token_id', 3)}`,
          [partner.id, b.reservation_id, ...actingArgs])
      : null;
    if (!res) return reject('unknown reservation');
    return accept(async () => {
      const [r, m] = await charger(() => ocpp.cancelReservation(res.ocpp_identity, res.id, actor));
      if (r === 'ACCEPTED') await query(`UPDATE ocpi_reservation SET state = 'cancelled' WHERE id = $1`, [res.id]);
      await done(r === 'REJECTED' ? 'UNKNOWN_RESERVATION' : r, m);
    });
  }

  // Every remaining command addresses a location.
  const loc = await location(b?.location_id);
  if (!loc) return reject('unknown location', STATUS.UNKNOWN_LOCATION);

  // ── UNLOCK_CONNECTOR
  if (command === 'UNLOCK_CONNECTOR') {
    const evse = typeof b?.evse_uid === 'string' ? pickEvse(loc, b.evse_uid) : null;
    if (!evse) return reject('evse_uid is required and must be an EVSE of this location', STATUS.INVALID_PARAMS);
    // Only the partner whose driver is (or just was) on this connector may release
    // the cable: otherwise any partner could unplug another driver mid-charge.
    // Behind a hub, the driver must also be the acting eMSP's (the hub's connection carries every eMSP's).
    const latest = await one<{ ocpi_partner_id: string | null; t_cc: string | null; t_pid: string | null }>(
      `SELECT cs.ocpi_partner_id, t.country_code AS t_cc, t.party_id AS t_pid FROM charging_session cs
         LEFT JOIN ocpi_token t ON t.id = cs.ocpi_token_id
        WHERE cs.connector_uuid = ANY($1::uuid[])
          AND (cs.state = 'active' OR cs.ended_at > now() - interval '15 minutes')
        ORDER BY cs.started_at DESC LIMIT 1`,
      [evse.connectorUuids],
    );
    if (latest?.ocpi_partner_id !== partner.id || !isActing(acting, latest.t_cc, latest.t_pid)) return reject('only the connector of a current or just-ended session of your driver can be unlocked');
    return accept(async () => {
      const [r, m] = await charger(() => ocpp.unlockConnector(evse.ocppIdentity, evse.evseNo, actor), ['Unlocked']);
      await done(r, m);
    });
  }

  // START_SESSION and RESERVE_NOW carry the driver's token.
  const token = parseToken(b?.token);
  if (typeof token === 'string') return reject(`token: ${token}`, STATUS.INVALID_PARAMS);
  if (!isActing(acting, token.country_code, token.party_id) || !(await partnerActsFor(partner, token.country_code, token.party_id, 'EMSP'))) {
    return reject(`this connection may not act for ${token.country_code}*${token.party_id}`);
  }
  if (!token.valid) return reject('the token is not valid');
  const evse = pickEvse(loc, typeof b?.evse_uid === 'string' ? b.evse_uid : undefined);
  if (!evse) return reject('unknown EVSE', STATUS.UNKNOWN_LOCATION);
  const ref = typeof b?.authorization_reference === 'string' ? b.authorization_reference.slice(0, 36) : null;
  // A token another connection pushed first is not taken over by a command.
  const stored = await upsertToken(partner, token);
  if (!stored) return reject('this token was issued through another connection');

  // ── START_SESSION
  if (command === 'START_SESSION') {
    await query(
      `INSERT INTO ocpi_authorization (org_id, token_id, auth_method, authorization_reference, connector_uuid, charge_point_id, expires_at)
       VALUES ($1,$2,'COMMAND',$3,$4,$5, now() + interval '5 minutes')`,
      [partner.org_id, stored.id, ref, evse.connectorUuids[0] ?? null, evse.chargePointId],
    );
    return accept(async () => {
      if (!evse.online) return done('EVSE_INOPERATIVE', 'the charger is offline');
      if (['Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'].includes(evse.status)) return done('EVSE_OCCUPIED', 'the connector is in use');
      if (['Faulted', 'Unavailable'].includes(evse.status)) return done('EVSE_INOPERATIVE', `the connector is ${evse.status}`);
      const [r, m] = await charger(() => ocpp.remoteStartTransaction(evse.ocppIdentity, evse.evseNo, token.uid, actor));
      await done(r, m);
    });
  }

  // ── RESERVE_NOW
  const expiry = new Date(String(b?.expiry_date ?? ''));
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) return reject('expiry_date must be in the future', STATUS.INVALID_PARAMS);
  if (typeof b?.reservation_id !== 'string' || !b.reservation_id) return reject('reservation_id is required', STATUS.INVALID_PARAMS);
  // Reservation ids are unique per connection: behind a hub, another eMSP's reservation under the same id is
  // not replaced (nor its driver's hold moved) by this one.
  if (acting) {
    const taken = await one(
      `SELECT 1 FROM ocpi_reservation r LEFT JOIN ocpi_token tk ON tk.id = r.token_id
        WHERE r.partner_id = $1 AND r.ocpi_reservation_id = $2
          AND (tk.id IS NULL OR tk.country_code <> $3 OR tk.party_id <> $4)`,
      [partner.id, b.reservation_id.slice(0, 36), acting.country_code, acting.party_id]);
    if (taken) return reject('this reservation_id is already used by another party behind this hub');
  }
  const res = await one<{ id: number }>(
    `INSERT INTO ocpi_reservation (org_id, partner_id, ocpi_reservation_id, token_id, charge_point_id, connector_no, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (partner_id, ocpi_reservation_id) DO UPDATE
       SET token_id = EXCLUDED.token_id, charge_point_id = EXCLUDED.charge_point_id, connector_no = EXCLUDED.connector_no,
           expires_at = EXCLUDED.expires_at, state = 'requested'
     RETURNING id`,
    [partner.org_id, partner.id, b.reservation_id.slice(0, 36), stored.id, evse.chargePointId, evse.evseNo, expiry],
  );
  // The reservation is the provider's approval for this driver until it expires.
  await query(
    `INSERT INTO ocpi_authorization (org_id, token_id, auth_method, authorization_reference, connector_uuid, charge_point_id, expires_at)
     VALUES ($1,$2,'COMMAND',$3,$4,$5,$6)`,
    [partner.org_id, stored.id, ref, evse.connectorUuids[0] ?? null, evse.chargePointId, expiry],
  );
  return accept(async () => {
    const [r, m] = await charger(() => ocpp.reserveNow(evse.ocppIdentity, { connectorId: evse.evseNo, expiryDate: expiry.toISOString(), idTag: token.uid, reservationId: res!.id }, actor));
    // Only while still 'requested': the charger may have been suspended meanwhile (v1.4.4).
    const set = await one<{ id: number }>(
      `UPDATE ocpi_reservation SET state = $2 WHERE id = $1 AND state = 'requested' RETURNING id`, [res!.id, r === 'ACCEPTED' ? 'active' : 'failed']);
    if (!set && r === 'ACCEPTED') {
      // Suspended during the round trip: undo the hold and tell the partner it did not stick.
      await charger(() => ocpp.cancelReservation(evse.ocppIdentity, res!.id, actor)).catch(() => undefined);
      await done('REJECTED', m);
      return;
    }
    await done(r, m);
  });
}

export function runFollowUp(o: CommandOutcome, what: string) {
  if (!o.followUp) return;
  setImmediate(() => void o.followUp!().catch((e) => logger.warn({ what, err: (e as Error).message }, 'roaming command follow-up failed')));
}
