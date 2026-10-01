import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { unseal } from '../services/secrets.js';
import type { IdTagInfo } from '../ocpp/adapter16.js';
import { getParty, endpointUrl, type PartnerRow, type TokenRow } from './store.js';
import { ocpiCall } from './client.js';

/**
 * A roaming driver at the charger.
 *
 * Called by the OCPP Authorize path only when the idTag is not one of the
 * operator's own cards. The token must have been pushed by a connected partner
 * (or arrive with a START_SESSION command). Its whitelist setting decides
 * whether we may accept it locally or must ask the partner first:
 *
 *   ALWAYS, ALLOWED     accept locally (fast, works if the partner is down)
 *   ALLOWED_OFFLINE     ask the partner in real time; accept locally only when
 *                       it cannot be reached (no answer, timeout, server error)
 *   NEVER               ask the partner in real time; no answer = no charge
 *
 * A charger only presents the uid, and two partners may have issued the same
 * one. The token a partner has just approved for THIS charger (START_SESSION,
 * RESERVE_NOW, a real-time "allowed") wins; otherwise a uid that any connected
 * partner has revoked is not accepted on the strength of another partner's
 * valid token with the same uid.
 */

const REALTIME_APPROVAL_MIN = 10;

type TokenWithPartner = TokenRow & { partner_state: string };
type Approval = { id: string; auth_method: string; authorization_reference: string | null };

/**
 * An unused, unexpired approval of this token for this charger (and, when the
 * connector is known, for the same EVSE as the approval's connector). Approvals
 * stored before migration 047 carry no charger: they are matched by the charger
 * of their connector.
 */
async function pendingApproval(tokenId: string, chargePointId: string, connectorUuid: string | null = null): Promise<Approval | null> {
  return one<Approval>(
    `SELECT a.id, a.auth_method, a.authorization_reference
       FROM ocpi_authorization a
       LEFT JOIN connector ac ON ac.id = a.connector_uuid
       LEFT JOIN evse ae ON ae.id = ac.evse_uuid
      WHERE a.token_id = $1 AND a.used_at IS NULL AND a.expires_at > now()
        AND COALESCE(a.charge_point_id, ae.charge_point_id) = $2
        AND ($3::uuid IS NULL OR a.connector_uuid IS NULL
             OR ac.evse_uuid = (SELECT evse_uuid FROM connector WHERE id = $3::uuid))
      ORDER BY (a.auth_method = 'COMMAND') DESC, a.created_at DESC LIMIT 1`,
    [tokenId, chargePointId, connectorUuid],
  );
}

/**
 * Which partner token a uid at this charger is. Returns null when no partner
 * issued it; `refused` when the choice is unsafe (a revoked token shares the uid
 * and no approval says which one is meant).
 */
async function pickToken(chargePointId: string, idTag: string, connectorUuid: string | null = null):
  Promise<null | { refused: true } | { refused: false; token: TokenWithPartner; approval: Approval | null }> {
  const all = await many<TokenWithPartner>(
    `SELECT t.*, p.state AS partner_state
       FROM ocpi_token t
       JOIN ocpi_partner p ON p.id = t.partner_id
       JOIN site s ON s.org_id = t.org_id
       JOIN charge_point cp ON cp.site_id = s.id
      WHERE cp.id = $1 AND t.uid = $2
      ORDER BY (p.state = 'connected') DESC, t.valid DESC, t.last_updated DESC`,
    [chargePointId, idTag],
  );
  if (!all.length) return null;
  // 1. The token whose partner approved this driver for this charger.
  for (const t of all.filter((x) => x.partner_state === 'connected' && x.valid)) {
    const approval = await pendingApproval(t.id, chargePointId, connectorUuid);
    if (approval) return { refused: false, token: t, approval };
  }
  // 2. No approval: a uid another connected partner has revoked is not let through
  //    because a different partner's token happens to carry the same uid.
  const connected = all.filter((x) => x.partner_state === 'connected');
  if (connected.length > 1 && connected.some((x) => !x.valid)) return { refused: true };
  if (connected.length > 1) logger.warn({ uid: idTag, partners: connected.length }, 'roaming uid issued by several partners; using the most recently updated token');
  return { refused: false, token: all[0]!, approval: null };
}

/** Returns null when the idTag is not a roaming token at all. */
export async function authorizeRoaming(chargePointId: string, idTag: string): Promise<IdTagInfo | null> {
  const pick = await pickToken(chargePointId, idTag).catch(() => null);
  if (!pick) return null;
  if (pick.refused) return { status: 'Blocked' };
  const t = pick.token;
  if (t.partner_state !== 'connected') return { status: 'Invalid' };
  if (!t.valid) return { status: 'Blocked' };

  // The partner already approved this driver here (START_SESSION, or a real-time answer moments ago).
  if (pick.approval) return { status: 'Accepted' };

  if (t.whitelist === 'ALWAYS' || t.whitelist === 'ALLOWED') return { status: 'Accepted' };
  // ALLOWED_OFFLINE: the partner decides when it can be reached; we decide only when it cannot.
  return realtimeAuthorize(t, chargePointId, t.whitelist === 'ALLOWED_OFFLINE');
}

/**
 * Ask the token's provider (OCPI real-time authorisation). With `offlineFallback`
 * (ALLOWED_OFFLINE) a provider that cannot be reached — no endpoint to ask, no
 * answer in time, a server error — leaves the decision to us and the token is
 * accepted locally; an actual answer (allowed or not) is always followed.
 */
async function realtimeAuthorize(t: TokenRow, chargePointId: string, offlineFallback = false): Promise<IdTagInfo> {
  const p = await one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE id = $1`, [t.partner_id]);
  const party = await getParty(t.org_id);
  const url = p ? endpointUrl(p, 'tokens', 'SENDER') : null;
  if (!p || !party || !url || !p.token_out) {
    if (offlineFallback) return { status: 'Accepted' };
    logger.warn({ partner: p?.name, uid: t.uid }, 'roaming token needs real-time authorisation but the partner offers no tokens endpoint');
    return { status: 'Invalid' };
  }
  const loc = await one<{ site_id: string }>(`SELECT site_id FROM charge_point WHERE id = $1`, [chargePointId]);
  const r = await ocpiCall({
    orgId: t.org_id,
    partnerId: p.id,
    method: 'POST',
    url: `${url}/${encodeURIComponent(t.uid)}/authorize?type=${t.type}`,
    token: unseal(p.token_out),
    body: loc ? { location_id: loc.site_id } : undefined,
    from: party,
    to: { country_code: t.country_code, party_id: t.party_id },
    timeoutMs: config.ocpi.realtimeAuthTimeoutMs,
  });
  if (!r.ok && offlineFallback && (r.httpStatus == null || r.httpStatus >= 500)) {
    logger.info({ uid: t.uid, err: r.error }, 'roaming provider unreachable; ALLOWED_OFFLINE token accepted locally');
    return { status: 'Accepted' };
  }
  const allowed = r.ok ? String(r.data?.allowed ?? '') : '';
  if (allowed === 'ALLOWED') {
    // The approval holds at this charger only.
    await query(
      `INSERT INTO ocpi_authorization (org_id, token_id, auth_method, authorization_reference, charge_point_id, expires_at)
       VALUES ($1,$2,'AUTH_REQUEST',$3,$4, now() + make_interval(mins => $5))`,
      [t.org_id, t.id, typeof r.data?.authorization_reference === 'string' ? r.data.authorization_reference.slice(0, 36) : null, chargePointId, REALTIME_APPROVAL_MIN],
    );
    return { status: 'Accepted' };
  }
  logger.info({ uid: t.uid, allowed: allowed || r.error }, 'roaming token refused by its provider');
  if (allowed === 'EXPIRED') return { status: 'Expired' };
  if (allowed === 'BLOCKED' || allowed === 'NO_CREDIT' || allowed === 'NOT_ALLOWED') return { status: 'Blocked' };
  return { status: 'Invalid' };
}

/**
 * Mark a new session as a roaming session: which partner, which token, and how
 * it was authorised (COMMAND, AUTH_REQUEST or WHITELIST). Called when a
 * session starts with an idTag that is not one of the operator's own cards.
 */
export async function linkRoamingSession(sessionId: string, orgId: string, idTag: string): Promise<boolean> {
  // A replayed StartTransaction returns the same session: never consume a second approval.
  const s = await one<{ linked: boolean; charge_point_id: string; connector_uuid: string | null }>(
    `SELECT ocpi_token_id IS NOT NULL AS linked, charge_point_id, connector_uuid FROM charging_session WHERE id = $1 AND org_id = $2`,
    [sessionId, orgId],
  );
  if (!s || s.linked) return false;
  // The same choice as at Authorize: the token approved for this charger (and
  // EVSE) first; never a revoked uid on the strength of another partner's token.
  const pick = await pickToken(s.charge_point_id, idTag, s.connector_uuid);
  if (!pick || pick.refused || pick.token.partner_state !== 'connected') return false;
  const { token: t, approval } = pick;
  if (approval) await query(`UPDATE ocpi_authorization SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [approval.id]);
  const r = await query(
    `UPDATE charging_session
        SET ocpi_partner_id = $2, ocpi_token_id = $3, ocpi_auth_method = $4, ocpi_authorization_reference = $5
      WHERE id = $1 AND ocpi_token_id IS NULL`,
    [sessionId, t.partner_id, t.id, approval?.auth_method ?? 'WHITELIST', approval?.authorization_reference ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}
