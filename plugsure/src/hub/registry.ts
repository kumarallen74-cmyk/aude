import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { one, many, query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { seal } from '../services/secrets.js';
import { OCPI_VERSION, tokenHash } from '../ocpi/mapping.js';
import { ourEndpoints, versionsUrlOf } from '../ocpi/registration.js';
import type { Endpoint } from '../ocpi/store.js';
import { HubError } from './errors.js';
import type { HubConnection, HubMember, HubParty, HubRole, PartyStatus } from './types.js';

/**
 * The hub's registry (design §2, §4): members (legal entities) → connections (one credentials pairing
 * each) → parties ((country_code, party_id, role), routed by). Platform-scoped: everything here runs
 * unscoped (the hub router, /v1/hub routes, workers).
 */

export const newHubToken = () => randomBytes(32).toString('base64url');
export const aadIn = (connId: string) => `hub_connection:${connId}:in`;
export const aadOut = (connId: string) => `hub_connection:${connId}:out`;

// ─────────────────────────────────────────────── the hub's own parties (role HUB)

export interface SelfParty { country_code: string; party_id: string; business_name: string; website: string | null }

export function selfParties(): SelfParty[] {
  return config.hub.parties.map((p) => ({ ...p, business_name: config.hub.businessName, website: config.hub.website || null }));
}
export function isSelfParty(cc: string | null | undefined, pid: string | null | undefined): boolean {
  return config.hub.parties.some((p) => p.country_code === cc && p.party_id === pid);
}
/** The hub party that speaks to a member of `country` (D2): that country's, else the first. */
export function selfPartyFor(country: string | null | undefined): SelfParty {
  const all = selfParties();
  return all.find((p) => p.country_code === country) ?? all[0]!;
}
/** Mirror HUB_PARTIES into hub_self_party (configuration is the source; the table is for reporting and H2). */
export async function ensureSelfParties(): Promise<void> {
  for (const p of selfParties()) {
    await query(
      `INSERT INTO hub_self_party (country_code, party_id, business_name, website) VALUES ($1,$2,$3,$4)
       ON CONFLICT (country_code) DO UPDATE SET party_id = EXCLUDED.party_id, business_name = EXCLUDED.business_name, website = EXCLUDED.website`,
      [p.country_code, p.party_id, p.business_name, p.website],
    );
  }
  await query(`DELETE FROM hub_self_party WHERE NOT (country_code = ANY($1::text[]))`, [config.hub.parties.map((p) => p.country_code)]);
}

/** Base URL of the hub surface; refuses when unset. */
export function hubBase(): string {
  if (!config.hub.publicUrl) throw new HubError(503, 3000, 'the hub is not configured: set HUB_PUBLIC_URL');
  return config.hub.publicUrl;
}

// ─────────────────────────────────────────────── reads

export const getMember = (id: string) => one<HubMember>(`SELECT * FROM hub_member WHERE id = $1`, [id]);
export const memberOfOrg = (orgId: string) => one<HubMember>(`SELECT * FROM hub_member WHERE org_id = $1`, [orgId]);
export const getConnection = (id: string) => one<HubConnection>(`SELECT * FROM hub_connection WHERE id = $1`, [id]);
export const getParty = (id: string) => one<HubParty>(`SELECT * FROM hub_party WHERE id = $1`, [id]);
export const partiesOfConnection = (connId: string) =>
  many<HubParty>(`SELECT * FROM hub_party WHERE connection_id = $1 ORDER BY country_code, party_id, role`, [connId]);
export const partiesOfMember = (memberId: string) =>
  many<HubParty>(`SELECT * FROM hub_party WHERE member_id = $1 ORDER BY country_code, party_id, role`, [memberId]);

/** The registered party (cc, pid) in one of `roles` (any role when omitted). */
export async function partyByKey(cc: string, pid: string, roles?: readonly string[]): Promise<HubParty[]> {
  return many<HubParty>(
    `SELECT * FROM hub_party WHERE country_code = $1 AND party_id = $2 AND ($3::text[] IS NULL OR role = ANY($3::text[]))
      ORDER BY role`, [cc, pid, roles ? [...roles] : null]);
}

/**
 * The connection a credentials token belongs to: its current token, or the previous one while the
 * rotation grace period lasts. A closed connection never authenticates.
 */
export async function connectionByTokenHash(hashes: string[]): Promise<HubConnection | null> {
  if (!hashes.length) return null;
  return one<HubConnection>(
    `SELECT * FROM hub_connection
      WHERE state IN ('pending','connected','suspended')
        AND (token_in_hash = ANY($1) OR (token_prev_hash = ANY($1) AND token_prev_until > now()))
      LIMIT 1`, [hashes]);
}

// ─────────────────────────────────────────────── members and connections

function slugOf(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'member';
  return `hub-${base}-${randomBytes(3).toString('hex')}`;
}

/** An external member: a hub_only organisation (its console shows the hub views only) and the member row. */
export async function createExternalMember(input: {
  legal_name: string; country_code: string; tax_id?: string | null; billing_email?: string | null; contract_ref?: string | null;
  open_roaming?: boolean; created_by?: string | null;
}): Promise<HubMember> {
  const name = input.legal_name.trim().slice(0, 200);
  if (!name) throw new HubError(400, 2001, 'legal_name is required');
  if (!['ID', 'MY', 'SG'].includes(input.country_code)) throw new HubError(400, 2001, 'country_code: ID, MY or SG');
  return tx(async (c) => {
    const org = (await c.query<{ id: string }>(
      `INSERT INTO organisation (name, slug, home_country_code, hub_only) VALUES ($1,$2,$3,true) RETURNING id`,
      [name, slugOf(name), input.country_code])).rows[0]!;
    return (await c.query<HubMember>(
      `INSERT INTO hub_member (org_id, kind, legal_name, country_code, tax_id, billing_email, contract_ref, open_roaming, created_by)
       VALUES ($1,'external',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [org.id, name, input.country_code, input.tax_id ?? null, input.billing_email ?? null, input.contract_ref ?? null,
        input.open_roaming ?? false, input.created_by ?? null])).rows[0]!;
  });
}

/** A new external connection with token A (shown once) and the versions URL to hand over with it. */
export async function createConnection(memberId: string, opts: { rateLimitPerMin?: number; realtimeLimitPerMin?: number } = {}) {
  const m = await getMember(memberId);
  if (!m) throw new HubError(404, 2000, 'member not found');
  if (m.kind !== 'external') throw new HubError(409, 2000, 'an internal member is joined with join-tenant, not a credentials handshake');
  if (m.status === 'terminated') throw new HubError(409, 2000, 'the member is terminated');
  const id = randomUUID();
  const token = newHubToken();
  const conn = await one<HubConnection>(
    `INSERT INTO hub_connection (id, member_id, kind, state, token_in_hash, token_in, rate_limit_per_min, realtime_limit_per_min)
     VALUES ($1,$2,'external','pending',$3,$4,COALESCE($5,600),COALESCE($6,1200)) RETURNING *`,
    [id, memberId, tokenHash(token), seal(token, aadIn(id)), opts.rateLimitPerMin ?? null, opts.realtimeLimitPerMin ?? null],
  );
  return { connection: conn!, token, versionsUrl: `${hubBase()}/hub/ocpi/versions` };
}

// ─────────────────────────────────────────────── parties

export interface PartyIn { role: string; country_code: string; party_id: string; business_name: string; website?: string | null }

export const EXTERNAL_ROLES: readonly HubRole[] = ['CPO', 'EMSP', 'NSP', 'OTHER', 'SCSP'];

/** Why these roles may not be registered on the hub by this member, or null. */
export async function partiesProblem(memberId: string, orgId: string, roles: PartyIn[]): Promise<string | null> {
  const seen = new Set<string>();
  for (const r of roles) {
    if (r.role === 'HUB') return 'a hub cannot connect to PlugSure Hub as role HUB (hub-to-hub peering is not offered)';
    if (!EXTERNAL_ROLES.includes(r.role as HubRole)) return `role ${r.role} is not accepted on the hub (CPO, EMSP, NSP, OTHER, SCSP)`;
    const k = `${r.role}:${r.country_code}*${r.party_id}`;
    if (seen.has(k)) return `${r.country_code}*${r.party_id} is listed twice as ${r.role}`;
    seen.add(k);
    if (isSelfParty(r.country_code, r.party_id)) return `${r.country_code}*${r.party_id} is the hub's own party`;
    const owner = await one<{ member_id: string }>(`SELECT member_id FROM hub_party_key WHERE country_code = $1 AND party_id = $2`, [r.country_code, r.party_id]);
    if (owner && owner.member_id !== memberId) return `${r.country_code}*${r.party_id} is already registered on the hub by another member`;
    // A party id a PlugSure tenant uses is that tenant's, joined or not.
    const tenant = await one<{ org_id: string }>(`SELECT org_id FROM ocpi_party WHERE country_code = $1 AND party_id = $2`, [r.country_code, r.party_id]);
    if (tenant && tenant.org_id !== orgId) return `${r.country_code}*${r.party_id} is used by another operator on this platform`;
  }
  return null;
}

/**
 * Upsert a connection's parties (inside the registration's transaction). Status: CONNECTED when the
 * member is active, else PLANNED; an admin suspension stays. Returns the rows.
 */
export async function upsertParties(c: pg.ClientBase, member: HubMember, connId: string, roles: PartyIn[]): Promise<HubParty[]> {
  const out: HubParty[] = [];
  const status: PartyStatus = member.status === 'active' ? 'CONNECTED' : 'PLANNED';
  for (const r of roles) {
    await c.query(`INSERT INTO hub_party_key (country_code, party_id, member_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [r.country_code, r.party_id, member.id]);
    const owner = (await c.query<{ member_id: string }>(`SELECT member_id FROM hub_party_key WHERE country_code = $1 AND party_id = $2`, [r.country_code, r.party_id])).rows[0];
    if (owner?.member_id !== member.id) throw new HubError(400, 2001, `${r.country_code}*${r.party_id} is already registered on the hub by another member`);
    const row = (await c.query<HubParty>(
      `INSERT INTO hub_party (member_id, org_id, connection_id, country_code, party_id, role, business_name, website, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (country_code, party_id, role) DO UPDATE
         SET connection_id = EXCLUDED.connection_id, business_name = EXCLUDED.business_name, website = EXCLUDED.website,
             status = CASE WHEN hub_party.admin_suspended THEN 'SUSPENDED' ELSE EXCLUDED.status END,
             status_changed_at = CASE WHEN hub_party.status IS DISTINCT FROM
                                          (CASE WHEN hub_party.admin_suspended THEN 'SUSPENDED' ELSE EXCLUDED.status END)
                                      THEN now() ELSE hub_party.status_changed_at END
       WHERE hub_party.member_id = EXCLUDED.member_id
       RETURNING *`,
      [member.id, member.org_id, connId, r.country_code, r.party_id, r.role, r.business_name.slice(0, 200), r.website ?? null, status],
    )).rows[0];
    if (!row) throw new HubError(400, 2001, `${r.country_code}*${r.party_id} (${r.role}) belongs to another member`);
    out.push(row);
  }
  return out;
}

/**
 * Set the status of parties (status lifecycle §4.5). An admin suspension is sticky: only `adminResume`
 * lifts it, and liveness changes (CONNECTED ⇄ OFFLINE) never touch a suspended or planned party.
 * Returns the ids whose status changed (for the ClientInfo push).
 */
export async function setPartyStatus(
  partyIds: string[], status: PartyStatus, opts: { admin?: boolean; adminResume?: boolean; liveness?: boolean } = {},
): Promise<string[]> {
  if (!partyIds.length) return [];
  let set = `status = $2, status_changed_at = CASE WHEN status IS DISTINCT FROM $2 THEN now() ELSE status_changed_at END`;
  let where: string;
  if (opts.admin) {
    set += ', admin_suspended = true';
    where = `(status IS DISTINCT FROM $2 OR NOT admin_suspended)`;
  } else if (opts.adminResume) {
    set += ', admin_suspended = false';
    where = `(status IS DISTINCT FROM $2 OR admin_suspended)`;
  } else if (opts.liveness) {
    where = `status IS DISTINCT FROM $2 AND NOT admin_suspended AND status IN ('CONNECTED','OFFLINE')`;
  } else {
    where = `status IS DISTINCT FROM $2 AND NOT admin_suspended`;
  }
  const rows = await many<{ id: string; changed: boolean }>(
    `UPDATE hub_party SET ${set} WHERE id = ANY($1::uuid[]) AND ${where} RETURNING id`, [partyIds, status]);
  return rows.map((r) => r.id);
}

// ─────────────────────────────────────────────── internal members (PlugSure tenants)

interface TenantParty { country_code: string; party_id: string; business_name: string; website: string | null; is_home: boolean }

/** The hub parties a tenant has: a CPO role for every party, the EMSP role for the home party (§3.4). */
export function tenantRoles(parties: TenantParty[]): PartyIn[] {
  const out: PartyIn[] = [];
  for (const p of parties) {
    out.push({ role: 'CPO', country_code: p.country_code, party_id: p.party_id, business_name: p.business_name, website: p.website });
    if (p.is_home) out.push({ role: 'EMSP', country_code: p.country_code, party_id: p.party_id, business_name: p.business_name, website: p.website });
  }
  return out;
}

/** The hub as a tenant sees it: the hub endpoint list (§4.1). */
export function hubEndpoints(base: string): Endpoint[] {
  const u = (m: string) => `${base}/hub/ocpi/${OCPI_VERSION}/${m}`;
  const out: Endpoint[] = [
    { identifier: 'credentials', role: 'SENDER', url: u('credentials') },
    { identifier: 'credentials', role: 'RECEIVER', url: u('credentials') },
    { identifier: 'hubclientinfo', role: 'SENDER', url: u('hubclientinfo') },
  ];
  for (const m of ['locations', 'tariffs', 'sessions', 'cdrs', 'tokens', 'commands', 'chargingprofiles']) {
    out.push({ identifier: m, role: 'SENDER', url: u(`sender/${m}`) });
    out.push({ identifier: m, role: 'RECEIVER', url: u(`receiver/${m}`) });
  }
  return out;
}

export function hubRoles() {
  return selfParties().map((p) => ({
    role: 'HUB', country_code: p.country_code, party_id: p.party_id,
    business_details: { name: p.business_name, ...(p.website ? { website: p.website } : {}) },
  }));
}

/**
 * "Join hub" for a PlugSure tenant (§4.4), one transaction, no HTTP handshake: the hub-side connection
 * (kind internal) and the tenant-side partner (kind hub) are created as mirrors of each other with fresh
 * tokens. Idempotent: a tenant already joined gets its existing membership back.
 */
export async function joinInternal(orgId: string, actorId: string | null): Promise<{ member: HubMember; connection: HubConnection; partnerId: string; created: boolean }> {
  const base = hubBase();
  if (!config.ocpi.publicUrl) throw new HubError(503, 3000, 'roaming is not configured: set OCPI_PUBLIC_URL (or PUBLIC_BASE_URL)');
  return tx(async (c) => {
    const org = (await c.query<{ id: string; name: string; home_country_code: string; hub_only: boolean }>(
      `SELECT id, name, home_country_code, hub_only FROM organisation WHERE id = $1 FOR UPDATE`, [orgId])).rows[0];
    if (!org) throw new HubError(404, 2000, 'organisation not found');
    if (org.hub_only) throw new HubError(409, 2000, 'a hub-only organisation is an external member; it connects with a credentials handshake');
    const parties = (await c.query<TenantParty>(
      `SELECT country_code, party_id, business_name, website, is_home FROM ocpi_party WHERE org_id = $1 ORDER BY is_home DESC, country_code`, [orgId])).rows;
    if (!parties.length) throw new HubError(409, 2000, 'set up the roaming identity (OCPI party) first');
    const home = parties[0]!;
    // The member's country (it picks the PlugSure entity that invoices its hub fees) is the country of the tenant's
    // home roaming identity, not the organisation's home country: a tenant that roams as MY*ABC is a Malaysian member.
    const country = ['ID', 'MY', 'SG'].includes(home.country_code) ? home.country_code : org.home_country_code;
    let member = (await c.query<HubMember>(`SELECT * FROM hub_member WHERE org_id = $1`, [orgId])).rows[0];
    if (member && member.kind !== 'internal') throw new HubError(409, 2000, 'this organisation is an external hub member');
    if (member?.status === 'terminated') throw new HubError(409, 2000, 'this organisation\'s hub membership is terminated');
    const existing = member
      ? (await c.query<HubConnection>(`SELECT * FROM hub_connection WHERE member_id = $1 AND kind = 'internal' AND state <> 'closed'`, [member.id])).rows[0]
      : undefined;
    if (member && existing?.peer_partner_id) return { member, connection: existing, partnerId: existing.peer_partner_id, created: false };
    member ??= (await c.query<HubMember>(
      `INSERT INTO hub_member (org_id, kind, legal_name, country_code, created_by) VALUES ($1,'internal',$2,$3,$4) RETURNING *`,
      [orgId, org.name, ['ID', 'MY', 'SG'].includes(country) ? country : 'ID', actorId])).rows[0]!;
    // Re-joining after leaving: the home identity may have moved country since.
    if (member.country_code !== country && ['ID', 'MY', 'SG'].includes(country)) {
      member = (await c.query<HubMember>(`UPDATE hub_member SET country_code = $2, updated_at = now() WHERE id = $1 RETURNING *`, [member.id, country])).rows[0]!;
    }
    const problem = await partiesProblemIn(c, member.id, orgId, tenantRoles(parties));
    if (problem) throw new HubError(409, 2001, problem);

    const connId = randomUUID();
    const t1 = newHubToken(); // the tenant presents it to the hub
    const t2 = newHubToken(); // the hub presents it to the tenant
    const hubParty = selfPartyFor(home.country_code);
    const partner = (await c.query<{ id: string }>(
      `INSERT INTO ocpi_partner (org_id, name, kind, state, token_in_hash, token_in, token_out, versions_url, version, endpoints, roles,
                                 country_code, party_id, registered_at)
       VALUES ($1,'PlugSure Hub','hub','connected',$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING id`,
      [orgId, tokenHash(t2), seal(t2), seal(t1), `${base}/hub/ocpi/versions`, OCPI_VERSION, JSON.stringify(hubEndpoints(base)),
        JSON.stringify(hubRoles()), hubParty.country_code, hubParty.party_id])).rows[0]!;
    const conn = (await c.query<HubConnection>(
      `INSERT INTO hub_connection (id, member_id, kind, state, token_in_hash, token_in, token_out, versions_url, version, endpoints,
                                   peer_org_id, peer_partner_id, registered_at)
       VALUES ($1,$2,'internal','connected',$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING *`,
      [connId, member.id, tokenHash(t1), seal(t1, aadIn(connId)), seal(t2, aadOut(connId)), versionsUrlOf(config.ocpi.publicUrl), OCPI_VERSION,
        JSON.stringify(ourEndpoints(config.ocpi.publicUrl)), orgId, partner.id])).rows[0]!;
    await upsertParties(c, member, conn.id, tenantRoles(parties));
    return { member, connection: conn, partnerId: partner.id, created: true };
  });
}

async function partiesProblemIn(c: pg.ClientBase, memberId: string, orgId: string, roles: PartyIn[]): Promise<string | null> {
  for (const r of roles) {
    if (isSelfParty(r.country_code, r.party_id)) return `${r.country_code}*${r.party_id} is the hub's own party`;
    const owner = (await c.query<{ member_id: string }>(`SELECT member_id FROM hub_party_key WHERE country_code = $1 AND party_id = $2`, [r.country_code, r.party_id])).rows[0];
    if (owner && owner.member_id !== memberId) return `${r.country_code}*${r.party_id} is already registered on the hub by another member`;
  }
  void orgId;
  return null;
}

/**
 * The tenant changed its parties (PUT/DELETE /v1/roaming/parties…): add the new ones, restore ones that came
 * back, suspend ones that are gone. Returns the party ids whose status changed (for ClientInfo).
 */
export async function syncInternalParties(orgId: string): Promise<string[]> {
  const member = await memberOfOrg(orgId);
  if (!member || member.kind !== 'internal') return [];
  const conn = await one<HubConnection>(`SELECT * FROM hub_connection WHERE member_id = $1 AND kind = 'internal' AND state = 'connected'`, [member.id]);
  if (!conn) return [];
  const parties = await many<TenantParty>(`SELECT country_code, party_id, business_name, website, is_home FROM ocpi_party WHERE org_id = $1 ORDER BY is_home DESC, country_code`, [orgId]);
  const want = tenantRoles(parties);
  const before = await partiesOfMember(member.id);
  const changed: string[] = [];
  const problem = await partiesProblem(member.id, orgId, want);
  if (problem) throw new HubError(409, 2001, problem);
  const rows = await tx((c) => upsertParties(c, member, conn.id, want));
  for (const r of rows) {
    const b = before.find((x) => x.id === r.id);
    if (!b || b.status !== r.status) changed.push(r.id);
  }
  const gone = before.filter((b) => !want.some((w) => w.role === b.role && w.country_code === b.country_code && w.party_id === b.party_id));
  changed.push(...await setPartyStatus(gone.map((g) => g.id), 'SUSPENDED'));
  return changed;
}
