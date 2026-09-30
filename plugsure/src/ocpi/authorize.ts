import { one, query } from '../db/pool.js';
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
 *   ALWAYS, ALLOWED, ALLOWED_OFFLINE   accept locally (fast, works if the partner is down)
 *   NEVER                              ask the partner in real time; no answer = no charge
 */

const REALTIME_APPROVAL_MIN = 10;

type TokenWithPartner = TokenRow & { partner_state: string };

async function tokenFor(chargePointId: string, idTag: string): Promise<TokenWithPartner | null> {
  // Several parties may have issued the same uid; prefer a valid one, then the newest.
  return one<TokenWithPartner>(
    `SELECT t.*, p.state AS partner_state
       FROM ocpi_token t
       JOIN ocpi_partner p ON p.id = t.partner_id
       JOIN site s ON s.org_id = t.org_id
       JOIN charge_point cp ON cp.site_id = s.id
      WHERE cp.id = $1 AND t.uid = $2
      ORDER BY (p.state = 'connected') DESC, t.valid DESC, t.last_updated DESC
      LIMIT 1`,
    [chargePointId, idTag],
  );
}

async function pendingApproval(tokenId: string, method?: 'COMMAND' | 'AUTH_REQUEST') {
  return one<{ id: string; auth_method: string; authorization_reference: string | null }>(
    `SELECT id, auth_method, authorization_reference FROM ocpi_authorization
      WHERE token_id = $1 AND used_at IS NULL AND expires_at > now() AND ($2::text IS NULL OR auth_method = $2)
      ORDER BY (auth_method = 'COMMAND') DESC, created_at DESC LIMIT 1`,
    [tokenId, method ?? null],
  );
}

/** Returns null when the idTag is not a roaming token at all. */
export async function authorizeRoaming(chargePointId: string, idTag: string): Promise<IdTagInfo | null> {
  const t = await tokenFor(chargePointId, idTag).catch(() => null);
  if (!t) return null;
  if (t.partner_state !== 'connected') return { status: 'Invalid' };
  if (!t.valid) return { status: 'Blocked' };

  // The partner already approved this driver (START_SESSION, or a real-time answer moments ago).
  if (await pendingApproval(t.id)) return { status: 'Accepted' };

  if (t.whitelist !== 'NEVER') return { status: 'Accepted' };
  return realtimeAuthorize(t, chargePointId);
}

async function realtimeAuthorize(t: TokenRow, chargePointId: string): Promise<IdTagInfo> {
  const p = await one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE id = $1`, [t.partner_id]);
  const party = await getParty(t.org_id);
  const url = p ? endpointUrl(p, 'tokens', 'SENDER') : null;
  if (!p || !party || !url || !p.token_out) {
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
  const allowed = r.ok ? String(r.data?.allowed ?? '') : '';
  if (allowed === 'ALLOWED') {
    await query(
      `INSERT INTO ocpi_authorization (org_id, token_id, auth_method, authorization_reference, expires_at)
       VALUES ($1,$2,'AUTH_REQUEST',$3, now() + make_interval(mins => $4))`,
      [t.org_id, t.id, typeof r.data?.authorization_reference === 'string' ? r.data.authorization_reference.slice(0, 36) : null, REALTIME_APPROVAL_MIN],
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
  const already = await one(`SELECT 1 FROM charging_session WHERE id = $1 AND ocpi_token_id IS NOT NULL`, [sessionId]);
  if (already) return false;
  const t = await one<TokenRow>(
    `SELECT t.* FROM ocpi_token t JOIN ocpi_partner p ON p.id = t.partner_id
      WHERE t.org_id = $1 AND t.uid = $2 AND p.state = 'connected'
      ORDER BY t.valid DESC, t.last_updated DESC LIMIT 1`,
    [orgId, idTag],
  );
  if (!t) return false;
  const approval = await pendingApproval(t.id);
  if (approval) await query(`UPDATE ocpi_authorization SET used_at = now() WHERE id = $1`, [approval.id]);
  const r = await query(
    `UPDATE charging_session
        SET ocpi_partner_id = $2, ocpi_token_id = $3, ocpi_auth_method = $4, ocpi_authorization_reference = $5
      WHERE id = $1 AND ocpi_token_id IS NULL`,
    [sessionId, t.partner_id, t.id, approval?.auth_method ?? 'WHITELIST', approval?.authorization_reference ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}
