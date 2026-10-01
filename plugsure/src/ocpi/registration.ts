import { randomBytes } from 'node:crypto';
import { one, query } from '../db/pool.js';
import { config, isRelaxedEnv } from '../config.js';
import { seal, unseal } from '../services/secrets.js';
import { OCPI_VERSION, tokenHash, type Party } from './mapping.js';
import { getParty, ROLE_OF_KIND, type PartnerRow, type Endpoint, type RoleEntry } from './store.js';
import { ocpiCall, partnerUrlProblem } from './client.js';

/**
 * The OCPI credentials handshake (OCPI 2.2.1 § 7), both ways round.
 *
 *  Partner starts:  we issue token A in the console; the partner calls our
 *                   versions URL with it and POSTs its credentials (token B and
 *                   its own versions URL). We read its endpoints with B, issue
 *                   token C, and from then on A is dead.
 *  We start:        the partner gave the operator its versions URL and token A.
 *                   We read its endpoints with A, POST our credentials (our
 *                   token B), and receive its token C.
 *
 * Tokens we issue are stored hashed (for lookup) and sealed (GET /credentials
 * must return them). Tokens we hold are sealed.
 */

export const newCredentialsToken = () => randomBytes(32).toString('base64url');

export const versionsUrlOf = (base: string) => `${base}/ocpi/versions`;
export const versionDetailsUrlOf = (base: string) => `${base}/ocpi/${OCPI_VERSION}`;

/**
 * Both roles on one version: as the CPO we SEND locations, tariffs, sessions
 * and CDRs and RECEIVE tokens and commands; as the eMSP it is the other way
 * round. The eMSP modules live under /emsp so each URL serves one role.
 */
export function ourEndpoints(base: string): Endpoint[] {
  const u = (m: string) => `${versionDetailsUrlOf(base)}/${m}`;
  return [
    { identifier: 'credentials', role: 'SENDER', url: u('credentials') },
    { identifier: 'credentials', role: 'RECEIVER', url: u('credentials') },
    // CPO role
    { identifier: 'locations', role: 'SENDER', url: u('locations') },
    { identifier: 'tariffs', role: 'SENDER', url: u('tariffs') },
    { identifier: 'sessions', role: 'SENDER', url: u('sessions') },
    { identifier: 'cdrs', role: 'SENDER', url: u('cdrs') },
    { identifier: 'tokens', role: 'RECEIVER', url: u('tokens') },
    { identifier: 'commands', role: 'RECEIVER', url: u('commands') },
    { identifier: 'chargingprofiles', role: 'RECEIVER', url: u('chargingprofiles') },
    // Either role: the parties behind a hub
    { identifier: 'hubclientinfo', role: 'RECEIVER', url: u('hubclientinfo') },
    // eMSP role
    { identifier: 'locations', role: 'RECEIVER', url: u('emsp/locations') },
    { identifier: 'tariffs', role: 'RECEIVER', url: u('emsp/tariffs') },
    { identifier: 'sessions', role: 'RECEIVER', url: u('emsp/sessions') },
    { identifier: 'cdrs', role: 'RECEIVER', url: u('emsp/cdrs') },
    { identifier: 'tokens', role: 'SENDER', url: u('emsp/tokens') },
    { identifier: 'commands', role: 'SENDER', url: u('emsp/commands') },
  ];
}

export function ourCredentials(party: Party, token: string, base: string) {
  const business_details = { name: party.business_name, ...(party.website ? { website: party.website } : {}) };
  return {
    token,
    url: versionsUrlOf(base),
    roles: [
      { role: 'CPO', party_id: party.party_id, country_code: party.country_code, business_details },
      { role: 'EMSP', party_id: party.party_id, country_code: party.country_code, business_details },
    ],
  };
}

export class RegistrationError extends Error {
  constructor(public ocpiStatus: number, message: string, public httpStatus = 400) {
    super(message);
  }
}

/**
 * Our public origin, as partners must call it (versions URL, endpoints, Link
 * headers, the response_url of our commands). It comes from configuration
 * (OCPI_PUBLIC_URL, else PUBLIC_BASE_URL), never from the request: Host and
 * X-Forwarded-Host are whatever the caller sent, and a URL built from them
 * would send partners (and the answers to our commands) somewhere else.
 *
 * Only in development and test, with nothing configured, does the request's
 * own origin stand in. Elsewhere an unset URL is an error that says so.
 */
export function ocpiPublicBase(req?: { protocol: string; headers: Record<string, unknown> }): string {
  if (config.ocpi.publicUrl) return config.ocpi.publicUrl;
  if (isRelaxedEnv() && req) {
    return `${req.protocol}://${String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1')}`;
  }
  throw new RegistrationError(3000, 'roaming is not configured: set OCPI_PUBLIC_URL (or PUBLIC_BASE_URL) to the public HTTPS origin partners call', 503);
}

/** Create a partner the operator will hand token A to. */
export async function createPartner(orgId: string, input: { name: string; kind?: string }) {
  const token = newCredentialsToken();
  const row = await one<PartnerRow>(
    `INSERT INTO ocpi_partner (org_id, name, kind, token_in_hash, token_in)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [orgId, input.name.trim().slice(0, 120), input.kind === 'hub' || input.kind === 'cpo' ? input.kind : 'emsp', tokenHash(token), seal(token)],
  );
  return { partner: row!, token };
}

/** Read the partner's 2.2.1 endpoints from its versions URL. */
async function discover(orgId: string, partnerId: string, versionsUrl: string, token: string, party: Party) {
  const problem = partnerUrlProblem(versionsUrl);
  if (problem) throw new RegistrationError(3001, `versions URL: ${problem}`);
  const v = await ocpiCall({ orgId, partnerId, method: 'GET', url: versionsUrl, token, from: party });
  if (!v.ok || !Array.isArray(v.data)) throw new RegistrationError(3001, `could not read the partner's versions (${v.error ?? 'unexpected answer'})`);
  const mine = v.data.find((x: any) => x?.version === OCPI_VERSION);
  if (!mine?.url) throw new RegistrationError(3002, `the partner does not offer OCPI ${OCPI_VERSION} (offers ${v.data.map((x: any) => x?.version).join(', ') || 'nothing'})`);
  const d = await ocpiCall({ orgId, partnerId, method: 'GET', url: String(mine.url), token, from: party });
  const endpoints = d.data?.endpoints;
  if (!d.ok || !Array.isArray(endpoints)) throw new RegistrationError(3001, `could not read the partner's ${OCPI_VERSION} endpoints (${d.error ?? 'unexpected answer'})`);
  for (const e of endpoints) {
    const p = partnerUrlProblem(String(e?.url ?? ''));
    if (p) throw new RegistrationError(3001, `endpoint ${e?.identifier}: ${p}`);
  }
  return endpoints.map((e: any) => ({ identifier: String(e.identifier), role: e.role === 'SENDER' ? 'SENDER' : 'RECEIVER', url: String(e.url) })) as Endpoint[];
}

function parseRoles(roles: unknown): RoleEntry[] {
  if (!Array.isArray(roles) || roles.length === 0) throw new RegistrationError(2001, 'roles must list at least one role');
  return roles.map((r: any) => {
    if (!/^[A-Z]{2}$/.test(String(r?.country_code)) || !/^[A-Z0-9]{3}$/.test(String(r?.party_id)) || !r?.role) {
      throw new RegistrationError(2001, 'each role needs role, country_code (2 letters) and party_id (3 characters)');
    }
    return { role: String(r.role), party_id: r.party_id, country_code: r.country_code, business_details: r.business_details ?? undefined };
  });
}

/**
 * The roles a partner registers with must match the kind the operator chose
 * when creating it (an eMSP registers as EMSP, a CPO as CPO, a hub as HUB).
 * The roles decide what the partner may do (push tokens, post charge records,
 * relay for others), so a partner cannot promote itself by declaring more:
 * a connection that really plays two roles is set up as two partners.
 */
export function rolesProblem(kind: PartnerRow['kind'], roles: RoleEntry[]): string | null {
  const want = ROLE_OF_KIND[kind];
  const other = roles.filter((r) => r.role !== want).map((r) => r.role);
  if (other.length) {
    return `this connection was set up by the operator as ${want}: register with the ${want} role only (not ${[...new Set(other)].join(', ')}), or ask the operator to set up the connection for that role`;
  }
  return null;
}

/** The parties (country_code*party_id) a set of roles stands for, sorted. */
export const partySet = (roles: RoleEntry[]) => [...new Set(roles.map((r) => `${r.country_code}*${r.party_id}`))].sort();

/** The party the partner is addressed as (OCPI-to headers): the first role it registered with. */
function primaryParty(roles: RoleEntry[]) {
  const r = roles[0]!;
  return { country_code: r.country_code, party_id: r.party_id };
}

/**
 * POST (first registration) or PUT (update) /credentials from the partner.
 * Returns our credentials, carrying the new token C.
 */
export async function registerFromPartner(partner: PartnerRow, body: any, base: string, update: boolean) {
  const party = await getParty(partner.org_id);
  if (!party) throw new RegistrationError(3000, 'this operator has not set its roaming identity yet', 500);
  if (update ? partner.state !== 'connected' : partner.state !== 'pending') {
    throw new RegistrationError(2000, update ? 'not registered: use POST' : 'already registered: use PUT to update', 405);
  }
  const theirToken = typeof body?.token === 'string' && body.token.length >= 1 && body.token.length <= 64 ? body.token : null;
  const url = typeof body?.url === 'string' ? body.url : null;
  if (!theirToken || !url) throw new RegistrationError(2001, 'token and url are required');
  const roles = parseRoles(body?.roles);
  // The kind (and with it what the partner may do) is the operator's choice, not the partner's.
  const problem = rolesProblem(partner.kind, roles);
  if (problem) throw new RegistrationError(2001, problem);
  // An update may change the token, the URL and the endpoints, not who the partner
  // is: a different set of parties needs the operator (disconnect, then connect anew).
  if (update && partySet(roles).join(',') !== partySet(partner.roles ?? []).join(',')) {
    throw new RegistrationError(2001, `the parties of a registered connection cannot be changed by an update (registered: ${partySet(partner.roles ?? []).join(', ') || 'none'}); ask the operator to set up the connection again`);
  }
  const endpoints = await discover(partner.org_id, partner.id, url, theirToken, party);
  const tokenC = newCredentialsToken();
  const who = primaryParty(roles);
  // Only from the state this request started from: two POSTs with token A racing
  // each other must not both register (the second would replace the first's token C).
  const done = await one<{ id: string }>(
    `UPDATE ocpi_partner
        SET state = 'connected', token_out = $2, versions_url = $3, version = $4, endpoints = $5, roles = $6,
            country_code = $7, party_id = $8, token_in_hash = $9, token_in = $10,
            registered_at = COALESCE(registered_at, now()), last_error = NULL, updated_at = now()
      WHERE id = $1 AND state = $11 AND token_in_hash IS NOT DISTINCT FROM $12
      RETURNING id`,
    [partner.id, seal(theirToken), url, OCPI_VERSION, JSON.stringify(endpoints), JSON.stringify(roles),
      who.country_code, who.party_id, tokenHash(tokenC), seal(tokenC), update ? 'connected' : 'pending', partner.token_in_hash],
  );
  if (!done) throw new RegistrationError(2000, update ? 'the registration changed meanwhile: try again' : 'already registered: use PUT to update', 405);
  return ourCredentials(party, tokenC, base);
}

/** The operator connects to a partner that gave it a versions URL and token A. */
export async function connectToPartner(orgId: string, partnerId: string, versionsUrl: string, tokenA: string, base: string) {
  const party = await getParty(orgId);
  if (!party) throw new RegistrationError(3000, 'set the roaming identity first');
  const partner = await one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE id = $1 AND org_id = $2`, [partnerId, orgId]);
  if (!partner) throw new RegistrationError(2000, 'partner not found', 404);
  if (partner.state === 'connected') throw new RegistrationError(2000, 'already connected', 409);

  const endpoints = await discover(orgId, partnerId, versionsUrl, tokenA, party);
  const credentials = endpoints.find((e) => e.identifier === 'credentials');
  if (!credentials) throw new RegistrationError(3003, 'the partner lists no credentials endpoint');
  const tokenB = newCredentialsToken();
  // Accept requests signed with B from the moment we send it: the partner may
  // call our versions URL before it answers the POST.
  await query(`UPDATE ocpi_partner SET token_in_hash = $2, token_in = $3, updated_at = now() WHERE id = $1`, [partnerId, tokenHash(tokenB), seal(tokenB)]);
  const r = await ocpiCall({ orgId, partnerId, method: 'POST', url: credentials.url, token: tokenA, body: ourCredentials(party, tokenB, base), from: party });
  if (!r.ok || typeof r.data?.token !== 'string') {
    await query(`UPDATE ocpi_partner SET last_error = $2, updated_at = now() WHERE id = $1`, [partnerId, `registration refused: ${r.error ?? 'no credentials returned'}`]);
    throw new RegistrationError(3001, `the partner refused the registration (${r.error ?? 'no credentials in the answer'})`);
  }
  const roles = parseRoles(r.data.roles);
  const problem = rolesProblem(partner.kind, roles);
  if (problem) {
    // We are registered at the partner now, but will not use the connection: tell it so.
    await ocpiCall({ orgId, partnerId, method: 'DELETE', url: credentials.url, token: String(r.data.token), from: party }).catch(() => null);
    await query(`UPDATE ocpi_partner SET last_error = $2, updated_at = now() WHERE id = $1`, [partnerId, `registration refused: ${problem}`]);
    throw new RegistrationError(2001, `the partner answered with roles that do not match this connection: ${problem}`);
  }
  const tokenC = String(r.data.token);
  // Re-read the endpoints with C: the partner may expose more to a registered party.
  const finalEndpoints = await discover(orgId, partnerId, String(r.data.url ?? versionsUrl), tokenC, party).catch(() => endpoints);
  const who = primaryParty(roles);
  await query(
    `UPDATE ocpi_partner
        SET state = 'connected', token_out = $2, versions_url = $3, version = $4, endpoints = $5, roles = $6,
            country_code = $7, party_id = $8, registered_at = COALESCE(registered_at, now()),
            last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [partnerId, seal(tokenC), String(r.data.url ?? versionsUrl), OCPI_VERSION, JSON.stringify(finalEndpoints), JSON.stringify(roles),
      who.country_code, who.party_id],
  );
}

/** Our credentials as the partner currently holds them (GET /credentials). */
export async function currentCredentials(partner: PartnerRow, base: string) {
  const party = await getParty(partner.org_id);
  if (!party || !partner.token_in) return null;
  return ourCredentials(party, unseal(partner.token_in), base);
}

/**
 * End the connection. `notify` tells the partner (DELETE on its credentials
 * endpoint) when we are the ones ending it.
 */
export async function closePartner(partner: PartnerRow, notify: boolean) {
  if (notify && partner.state === 'connected' && partner.token_out) {
    const party = await getParty(partner.org_id);
    const url = (partner.endpoints ?? []).find((e) => e.identifier === 'credentials')?.url;
    if (party && url) {
      await ocpiCall({ orgId: partner.org_id, partnerId: partner.id, method: 'DELETE', url, token: unseal(partner.token_out), from: party }).catch(() => null);
    }
  }
  await query(
    `UPDATE ocpi_partner SET state = 'closed', token_in_hash = NULL, token_in = NULL, token_out = NULL, updated_at = now() WHERE id = $1`,
    [partner.id],
  );
  await query(`UPDATE ocpi_push SET state = 'failed', last_error = 'partner connection closed' WHERE partner_id = $1 AND state = 'pending'`, [partner.id]);
}
