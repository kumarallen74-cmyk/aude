import { randomUUID } from 'node:crypto';
import { one, query, tx } from '../db/pool.js';
import { logger } from '../logger.js';
import { seal, unseal } from '../services/secrets.js';
import { OCPI_VERSION, authHeaderFor, tokenHash } from '../ocpi/mapping.js';
import { partnerUrlProblem, requestOcpi } from '../ocpi/client.js';
import { closePartner } from '../ocpi/registration.js';
import type { Endpoint, PartnerRow } from '../ocpi/store.js';
import { config } from '../config.js';
import { HubError } from './errors.js';
import { isInprocUrl } from './transport.js';
import {
  aadIn, aadOut, getMember, hubBase, hubRoles, newHubToken, partiesOfConnection, partiesProblem, setPartyStatus, upsertParties,
  type PartyIn,
} from './registry.js';
import type { HubConnection, HubParty } from './types.js';

/**
 * The OCPI credentials handshake between the hub and an EXTERNAL member (design §4.2, §4.3), both ways round,
 * mirroring ocpi/registration.ts:
 *
 *   member starts:  a platform admin issues token A (POST /v1/hub/members/:id/connections); the member reads
 *                   our versions with A and POSTs its credentials (token B, its versions URL, its roles); we
 *                   read its endpoints with B, issue token C and answer with the hub's credentials.
 *   hub starts:     the member gave its versions URL and token A; we read its endpoints with A, POST the hub's
 *                   credentials (our token B), receive its token C.
 *
 * The hub reports itself as role HUB only (OCPI 2.2.1 credentials): one HUB role per country party. A member
 * may register several parties and roles on one connection (a platform can have the same role more than once).
 */

export const hubVersions = (base: string) => [{ version: OCPI_VERSION, url: `${base}/hub/ocpi/${OCPI_VERSION}` }];

export function hubCredentials(token: string, base: string) {
  return { token, url: `${base}/hub/ocpi/versions`, roles: hubRoles() };
}

/** The roles a member sent, as parties (validated shape; policy is registry.partiesProblem). */
export function parseMemberRoles(roles: unknown): PartyIn[] {
  if (!Array.isArray(roles) || roles.length === 0) throw new HubError(400, 2001, 'roles must list at least one role');
  if (roles.length > 50) throw new HubError(400, 2001, 'at most 50 roles per connection');
  return roles.map((r: any) => {
    const cc = String(r?.country_code ?? '').toUpperCase();
    const pid = String(r?.party_id ?? '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc) || !/^[A-Z0-9]{3}$/.test(pid) || typeof r?.role !== 'string') {
      throw new HubError(400, 2001, 'each role needs role, country_code (2 letters) and party_id (3 characters)');
    }
    const name = typeof r?.business_details?.name === 'string' && r.business_details.name.trim() ? r.business_details.name.trim() : `${cc}*${pid}`;
    const website = typeof r?.business_details?.website === 'string' ? r.business_details.website.slice(0, 300) : null;
    return { role: String(r.role).toUpperCase(), country_code: cc, party_id: pid, business_name: name.slice(0, 200), website };
  });
}

export const partyKeySet = (ps: Array<{ role: string; country_code: string; party_id: string }>) =>
  [...new Set(ps.map((p) => `${p.role}:${p.country_code}*${p.party_id}`))].sort().join(',');

/** A member URL: public HTTPS (SSRF guard) and never one of our own origins (that would loop through us). */
export function memberUrlProblem(url: string): string | null {
  if (isInprocUrl(url)) return 'a member URL cannot be on the hub\'s own address';
  return partnerUrlProblem(url);
}

async function rawCall(method: string, url: string, token: string, body?: unknown) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    authorization: authHeaderFor(token), accept: 'application/json', 'user-agent': 'PlugSure-Hub/2.2.1',
    'x-request-id': randomUUID(), 'x-correlation-id': randomUUID(),
    ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
  };
  const r = await requestOcpi({ method, url, headers, payload, timeoutMs: config.hub.forwardTimeoutMs });
  const status = r.json && typeof r.json.status_code === 'number' ? r.json.status_code : null;
  const ok = r.httpStatus != null && r.httpStatus >= 200 && r.httpStatus < 300 && !r.error && (status == null || (status >= 1000 && status < 2000));
  return { ok, data: r.json?.data, error: r.error ?? (ok ? null : `HTTP ${r.httpStatus ?? '-'}${status ? ` / OCPI ${status}` : ''}${r.json?.status_message ? `: ${r.json.status_message}` : ''}`) };
}

/** Read a member's 2.2.1 endpoints from its versions URL. */
export async function discoverMember(versionsUrl: string, token: string): Promise<Endpoint[]> {
  const p = memberUrlProblem(versionsUrl);
  if (p) throw new HubError(400, 3001, `versions URL: ${p}`);
  const v = await rawCall('GET', versionsUrl, token);
  if (!v.ok || !Array.isArray(v.data)) throw new HubError(400, 3001, `could not read the member's versions (${v.error ?? 'unexpected answer'})`);
  const mine = v.data.find((x: any) => x?.version === OCPI_VERSION);
  if (!mine?.url) throw new HubError(400, 3002, `the member does not offer OCPI ${OCPI_VERSION}`);
  const up = memberUrlProblem(String(mine.url));
  if (up) throw new HubError(400, 3001, `version details URL: ${up}`);
  const d = await rawCall('GET', String(mine.url), token);
  const eps = d.data?.endpoints;
  if (!d.ok || !Array.isArray(eps)) throw new HubError(400, 3001, `could not read the member's ${OCPI_VERSION} endpoints (${d.error ?? 'unexpected answer'})`);
  const out: Endpoint[] = [];
  for (const e of eps.slice(0, 100)) {
    const url = String(e?.url ?? '');
    const prob = memberUrlProblem(url);
    if (prob) throw new HubError(400, 3001, `endpoint ${e?.identifier}: ${prob}`);
    out.push({ identifier: String(e.identifier), role: e.role === 'SENDER' ? 'SENDER' : 'RECEIVER', url });
  }
  return out;
}

export interface Registered { credentials: ReturnType<typeof hubCredentials>; parties: HubParty[]; connection: HubConnection }

/**
 * POST (first registration, with token A) or PUT (update, with token C) of /hub/ocpi/2.2.1/credentials.
 * An update may change the token, the URL and the endpoints, never the set of parties (a new party needs a
 * platform admin: POST /v1/hub/connections/:id/parties, then the member PUTs again).
 */
export async function registerMember(conn: HubConnection, body: any, update: boolean): Promise<Registered> {
  if (conn.kind !== 'external') throw new HubError(405, 2000, 'an internal connection does not exchange credentials');
  if (update ? conn.state !== 'connected' : conn.state !== 'pending') {
    throw new HubError(405, 2000, update ? 'not registered: use POST' : 'already registered: use PUT to update');
  }
  const member = await getMember(conn.member_id);
  if (!member || member.status === 'terminated') throw new HubError(403, 2000, 'this membership is terminated');
  const theirToken = typeof body?.token === 'string' && body.token.length >= 1 && body.token.length <= 255 ? body.token : null;
  const url = typeof body?.url === 'string' ? body.url : null;
  if (!theirToken || !url) throw new HubError(400, 2001, 'token and url are required');
  const roles = parseMemberRoles(body?.roles);
  const problem = await partiesProblem(member.id, member.org_id, roles);
  if (problem) throw new HubError(400, 2001, problem);
  if (update) {
    // The registered parties and those a platform admin approved since (PLANNED rows of this connection).
    const allowed = new Set((await partiesOfConnection(conn.id)).map((p) => `${p.role}:${p.country_code}*${p.party_id}`));
    const extra = roles.filter((r) => !allowed.has(`${r.role}:${r.country_code}*${r.party_id}`));
    if (extra.length) {
      throw new HubError(400, 2001, `new parties need a platform admin's approval first: ${extra.map((r) => `${r.country_code}*${r.party_id} (${r.role})`).join(', ')}`);
    }
  }
  const endpoints = await discoverMember(url, theirToken);
  const tokenC = newHubToken();
  const result = await tx(async (c) => {
    const row = (await c.query<HubConnection>(
      `UPDATE hub_connection
          SET state = 'connected', token_out = $2, versions_url = $3, version = $4, endpoints = $5,
              -- The member's own update replaces its token at once (the old C dies, as with any OCPI PUT
              -- /credentials); only a platform-forced rotation keeps the old one for a grace period.
              token_prev_hash = NULL, token_prev_until = NULL,
              token_in_hash = $6, token_in = $7, registered_at = COALESCE(registered_at, now()), last_error = NULL,
              alive_failures = 0, last_inbound_at = now(), updated_at = now()
        WHERE id = $1 AND state = $8 AND token_in_hash IS NOT DISTINCT FROM $9
        RETURNING *`,
      [conn.id, seal(theirToken, aadOut(conn.id)), url, OCPI_VERSION, JSON.stringify(endpoints), tokenHash(tokenC), seal(tokenC, aadIn(conn.id)),
        update ? 'connected' : 'pending', conn.token_in_hash],
    )).rows[0];
    if (!row) throw new HubError(405, 2000, update ? 'the registration changed meanwhile: try again' : 'already registered: use PUT to update');
    const parties = await upsertParties(c, member, conn.id, roles);
    if (update) {
      // Parties no longer listed by the member are suspended (cannot happen beyond approved ones; defensive).
      await c.query(`UPDATE hub_party SET status = 'SUSPENDED', status_changed_at = now()
                      WHERE connection_id = $1 AND NOT (id = ANY($2::uuid[])) AND status <> 'SUSPENDED'`, [conn.id, parties.map((p) => p.id)]);
    }
    return { connection: row, parties };
  });
  return { credentials: hubCredentials(tokenC, hubBase()), parties: result.parties, connection: result.connection };
}

/** A platform admin approves an additional party for a connection (§4.2): a PLANNED row the member's next PUT confirms. */
export async function approveParty(connId: string, p: PartyIn): Promise<HubParty> {
  const conn = await one<HubConnection>(`SELECT * FROM hub_connection WHERE id = $1`, [connId]);
  if (!conn || conn.state === 'closed') throw new HubError(404, 2000, 'connection not found');
  const member = await getMember(conn.member_id);
  if (!member) throw new HubError(404, 2000, 'member not found');
  const [role] = parseMemberRoles([{ role: p.role, country_code: p.country_code, party_id: p.party_id, business_details: { name: p.business_name, website: p.website } }]);
  const problem = await partiesProblem(member.id, member.org_id, [role!]);
  if (problem) throw new HubError(400, 2001, problem);
  const [row] = await tx((c) => upsertParties(c, { ...member, status: 'onboarding' }, conn.id, [role!]));
  return row!;
}

/** The hub starts: the member gave its versions URL and token A (§4.3). */
export async function connectToMember(connId: string, versionsUrl: string, tokenA: string): Promise<Registered> {
  const conn = await one<HubConnection>(`SELECT * FROM hub_connection WHERE id = $1`, [connId]);
  if (!conn) throw new HubError(404, 2000, 'connection not found');
  if (conn.kind !== 'external') throw new HubError(409, 2000, 'an internal connection needs no handshake');
  if (conn.state !== 'pending') throw new HubError(409, 2000, `the connection is ${conn.state}`);
  const member = await getMember(conn.member_id);
  if (!member || member.status === 'terminated') throw new HubError(409, 2000, 'the member is terminated');
  const endpoints = await discoverMember(versionsUrl, tokenA);
  const credUrl = endpoints.find((e) => e.identifier === 'credentials')?.url;
  if (!credUrl) throw new HubError(400, 3003, 'the member lists no credentials endpoint');
  const tokenB = newHubToken();
  // Accept requests signed with B from the moment we send it: the member may call our versions first.
  await query(`UPDATE hub_connection SET token_in_hash = $2, token_in = $3, updated_at = now() WHERE id = $1`, [conn.id, tokenHash(tokenB), seal(tokenB, aadIn(conn.id))]);
  const base = hubBase();
  const r = await rawCall('POST', credUrl, tokenA, hubCredentials(tokenB, base));
  if (!r.ok || typeof r.data?.token !== 'string') {
    await query(`UPDATE hub_connection SET last_error = $2, updated_at = now() WHERE id = $1`, [conn.id, `registration refused: ${r.error ?? 'no credentials returned'}`.slice(0, 500)]);
    throw new HubError(502, 3001, `the member refused the registration (${r.error ?? 'no credentials in the answer'})`);
  }
  const tokenC = String(r.data.token);
  let roles: PartyIn[];
  try {
    roles = parseMemberRoles(r.data.roles);
    const problem = await partiesProblem(member.id, member.org_id, roles);
    if (problem) throw new HubError(400, 2001, problem);
  } catch (e) {
    // We are registered at the member now, but will not use the connection: tell it so.
    await rawCall('DELETE', credUrl, tokenC).catch(() => null);
    await query(`UPDATE hub_connection SET last_error = $2, updated_at = now() WHERE id = $1`, [conn.id, `registration refused: ${(e as Error).message}`.slice(0, 500)]);
    throw e;
  }
  const finalUrl = typeof r.data.url === 'string' ? r.data.url : versionsUrl;
  const finalEndpoints = await discoverMember(finalUrl, tokenC).catch(() => endpoints);
  const result = await tx(async (c) => {
    const row = (await c.query<HubConnection>(
      `UPDATE hub_connection SET state = 'connected', token_out = $2, versions_url = $3, version = $4, endpoints = $5,
              registered_at = COALESCE(registered_at, now()), last_error = NULL, alive_failures = 0, last_inbound_at = now(), updated_at = now()
        WHERE id = $1 AND state = 'pending' RETURNING *`,
      [conn.id, seal(tokenC, aadOut(conn.id)), finalUrl, OCPI_VERSION, JSON.stringify(finalEndpoints)])).rows[0];
    if (!row) throw new HubError(409, 2000, 'the connection changed meanwhile');
    return { connection: row, parties: await upsertParties(c, member, conn.id, roles) };
  });
  return { credentials: hubCredentials(tokenB, base), parties: result.parties, connection: result.connection };
}

/** The hub's credentials as the member holds them (GET /credentials). */
export function currentHubCredentials(conn: HubConnection) {
  if (!conn.token_in) return null;
  return hubCredentials(unseal(conn.token_in, aadIn(conn.id)), hubBase());
}

/**
 * Close a connection (member DELETE /credentials, platform close, tenant leaves): tokens die at once, its
 * parties become SUSPENDED (returned, for ClientInfo), pending outbox rows to it are dropped. `notify` tells
 * an external member (DELETE on its credentials endpoint). An internal connection also closes the tenant's
 * 'PlugSure Hub' partner.
 */
export async function closeConnection(conn: HubConnection, notify: boolean): Promise<string[]> {
  if (notify && conn.kind === 'external' && conn.state === 'connected' && conn.token_out) {
    const url = (conn.endpoints ?? []).find((e) => e.identifier === 'credentials')?.url;
    if (url) await rawCall('DELETE', url, unseal(conn.token_out, aadOut(conn.id))).catch(() => null);
  }
  await query(
    `UPDATE hub_connection SET state = 'closed', token_in_hash = NULL, token_in = NULL, token_prev_hash = NULL, token_prev_until = NULL,
            token_out = NULL, updated_at = now() WHERE id = $1`, [conn.id]);
  await query(`UPDATE hub_outbox SET state = 'dropped', last_error = 'connection closed' WHERE recipient_connection_id = $1 AND state = 'pending'`, [conn.id]);
  if (conn.kind === 'internal' && conn.peer_partner_id) {
    const partner = await one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE id = $1`, [conn.peer_partner_id]);
    if (partner && partner.state !== 'closed') await closePartner(partner, false);
  }
  const ids = (await partiesOfConnection(conn.id)).map((p) => p.id);
  return setPartyStatus(ids, 'SUSPENDED');
}

/**
 * Rotate a connection's tokens (§4.5). External: the hub PUTs its credentials with a new token to the member
 * (its old one stays valid for HUB_TOKEN_GRACE_MIN) and takes the member's new token from the answer.
 * Internal: both mirrors are regenerated in one transaction.
 */
export async function rotateConnectionToken(conn: HubConnection): Promise<void> {
  if (conn.state !== 'connected') throw new HubError(409, 2000, `the connection is ${conn.state}`);
  const grace = Math.max(0, Math.round(config.hub.tokenGraceMin));
  const t = newHubToken();
  if (conn.kind === 'internal') {
    const t2 = newHubToken();
    await tx(async (c) => {
      await c.query(
        `UPDATE hub_connection SET token_prev_hash = token_in_hash, token_prev_until = now() + make_interval(mins => $5::int),
                token_in_hash = $2, token_in = $3, token_out = $4, updated_at = now() WHERE id = $1`,
        [conn.id, tokenHash(t), seal(t, aadIn(conn.id)), seal(t2, aadOut(conn.id)), grace]);
      await c.query(`UPDATE ocpi_partner SET token_out = $2, token_in_hash = $3, token_in = $4, updated_at = now() WHERE id = $1`,
        [conn.peer_partner_id, seal(t), tokenHash(t2), seal(t2)]);
    });
    return;
  }
  const url = (conn.endpoints ?? []).find((e) => e.identifier === 'credentials')?.url;
  if (!url || !conn.token_out) throw new HubError(409, 3003, 'the member lists no credentials endpoint');
  // Accept the new token from now on, and the old one for the grace period.
  await query(
    `UPDATE hub_connection SET token_prev_hash = token_in_hash, token_prev_until = now() + make_interval(mins => $4::int),
            token_in_hash = $2, token_in = $3, updated_at = now() WHERE id = $1`,
    [conn.id, tokenHash(t), seal(t, aadIn(conn.id)), grace]);
  const r = await rawCall('PUT', url, unseal(conn.token_out, aadOut(conn.id)), hubCredentials(t, hubBase()));
  if (!r.ok || typeof r.data?.token !== 'string') {
    logger.warn({ conn: conn.id, err: r.error }, 'hub token rotation: the member did not answer with new credentials');
    throw new HubError(502, 3001, `the member did not accept the new credentials (${r.error ?? 'no token in the answer'}); the new hub token is active, the old one stays valid for ${grace} min`);
  }
  await query(`UPDATE hub_connection SET token_out = $2, updated_at = now() WHERE id = $1`, [conn.id, seal(String(r.data.token), aadOut(conn.id))]);
}
