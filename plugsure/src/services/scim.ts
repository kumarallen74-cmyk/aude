import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * SCIM 2.0 provisioning (RFC 7643 / 7644) for the console (v1.43.0): the organisation's identity provider (Okta,
 * Microsoft Entra ID, Google Workspace, OneLogin…) creates, updates and deactivates console users, and pushes the
 * groups that decide their roles. A leaver loses access the moment IT removes them: deactivated, every session ended.
 *
 * Endpoint: {console}/scim/v2 (Users, Groups, ServiceProviderConfig, ResourceTypes, Schemas), one per organisation,
 * authenticated by the organisation's SCIM token (Authorization: Bearer pscim_…; only its hash is kept).
 *
 * The rules, and why:
 *   - a user is matched by e-mail (userName) in the organisation: an existing console user is taken over (linked);
 *     otherwise one is created, with no password — they sign in with single sign-on (SAML or Microsoft);
 *   - roles come only from groups, through the group → role map (the SCIM page's, else the SAML one), first match in
 *     the map's order; no mapped group: no role. A group never gives an administrator role (platform:* or user:write)
 *     or a site-, owner- or fleet-limited one (saml.mappableRoles);
 *   - administrators are left alone: the identity provider cannot change an administrator's roles or deactivate one
 *     (a stolen token must not be able to lock the organisation out). They are managed in the console;
 *   - DELETE deactivates (the user's history and audit trail stay); there is no hard delete.
 */

export class ScimError extends Error {
  constructor(public status: number, public detail: string, public scimType?: string) { super(detail); }
}

export const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PAGE = 200;

export interface RoleMapEntry { group: string; role: string }

// ------------------------------------------------------------------ configuration (the console)

export async function config(orgId: string) {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM scim_config WHERE org_id = $1`, [orgId]));
  const counts = await outsideRequestScope(() => one<any>(
    `SELECT (SELECT count(*)::int FROM scim_user WHERE org_id = $1) AS users, (SELECT count(*)::int FROM scim_group WHERE org_id = $1) AS groups`, [orgId]));
  return {
    enabled: r?.enabled === true, tokenHint: r?.token_hint ?? null, roleMap: (r?.role_map ?? []) as RoleMapEntry[],
    lastUsedAt: r?.last_used_at ? new Date(r.last_used_at).toISOString() : null, users: counts?.users ?? 0, groups: counts?.groups ?? 0,
  };
}

export async function saveConfig(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await config(orgId);
  const { mappableRoles } = await import('./saml.js');
  const allowed = new Set((await mappableRoles()).map((r) => r.name));
  const raw = b.roleMap === undefined ? cur.roleMap : b.roleMap;
  if (!Array.isArray(raw)) throw new ScimError(422, 'roleMap is a list of { group, role }.');
  const roleMap = raw.slice(0, 50).map((m: any, i: number) => {
    const group = String(m?.group ?? '').trim(), role = String(m?.role ?? '').trim();
    if (!group || group.length > 300) throw new ScimError(422, `roleMap[${i}]: a group name is required.`);
    if (!allowed.has(role)) throw new ScimError(422, `roleMap[${i}]: ${role.slice(0, 40)} is not a role a group may give (never an administrator or a site-limited role).`);
    return { group, role };
  });
  const enabled = b.enabled === undefined ? cur.enabled : b.enabled === true;
  await outsideRequestScope(() => query(
    `INSERT INTO scim_config (org_id, enabled, role_map, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, role_map = EXCLUDED.role_map, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, enabled, JSON.stringify(roleMap), userId]));
  // A changed map applies to everyone the identity provider manages.
  await reconcileAll(orgId).catch((e) => logger.warn({ orgId, err: (e as Error).message }, 'SCIM role reconcile failed'));
  return config(orgId);
}

/** A new SCIM token: shown once; only its hash is kept. The previous token stops working at once. */
export async function rotateToken(orgId: string, userId: string | null) {
  const token = `pscim_${randomBytes(32).toString('base64url')}`;
  await outsideRequestScope(() => query(
    `INSERT INTO scim_config (org_id, token_hash, token_hint, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, token_hint = EXCLUDED.token_hint, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, sha(token), token.slice(-4), userId]));
  return { token, hint: token.slice(-4) };
}

/** The organisation a SCIM token belongs to (enabled only). */
export async function orgForToken(authorization: unknown): Promise<string> {
  const h = String(authorization ?? '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!/^pscim_[A-Za-z0-9_-]{43}$/.test(token)) throw new ScimError(401, 'A valid SCIM token is required.');
  const r = await outsideRequestScope(() => one<{ org_id: string; token_hash: string; enabled: boolean }>(`SELECT org_id, token_hash, enabled FROM scim_config WHERE token_hash = $1`, [sha(token)]));
  if (!r || !timingSafeEqual(Buffer.from(r.token_hash, 'hex'), Buffer.from(sha(token), 'hex'))) throw new ScimError(401, 'A valid SCIM token is required.');
  if (!r.enabled) throw new ScimError(403, 'SCIM provisioning is switched off for this organisation.');
  await outsideRequestScope(() => query(`UPDATE scim_config SET last_used_at = now() WHERE org_id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [r.org_id])).catch(() => {});
  return r.org_id;
}

// ------------------------------------------------------------------ roles from groups

async function roleMapOf(orgId: string): Promise<RoleMapEntry[]> {
  const own = (await outsideRequestScope(() => one<any>(`SELECT role_map FROM scim_config WHERE org_id = $1`, [orgId])))?.role_map as RoleMapEntry[] | undefined;
  if (own?.length) return own;
  const saml = await outsideRequestScope(() => one<any>(`SELECT role_map FROM org_saml_provider WHERE org_id = $1`, [orgId]));
  return (saml?.role_map ?? []) as RoleMapEntry[];
}

/** The role the groups give, by the map's order (first match), or null. */
export function roleFor(groups: string[], map: RoleMapEntry[]): string | null {
  const g = new Set(groups.map((x) => x.toLowerCase()));
  return map.find((m) => g.has(m.group.toLowerCase()))?.role ?? null;
}

async function isAdministrator(userId: string): Promise<boolean> {
  const { isAdministratorAccount } = await import('./users.js');
  return outsideRequestScope(() => isAdministratorAccount(userId));
}

/**
 * Set a provisioned user's role from their groups. Administrators are never changed. A role the map gives that is not
 * (or no longer) mappable is not granted.
 */
export async function reconcileUser(orgId: string, userId: string): Promise<string | null> {
  if (await isAdministrator(userId)) return null;
  const groups = await outsideRequestScope(() => many<{ display_name: string }>(
    `SELECT g.display_name FROM scim_group_member m JOIN scim_group g ON g.id = m.group_id WHERE m.user_id = $1 AND m.org_id = $2`, [userId, orgId]));
  const { mappableRoles } = await import('./saml.js');
  const allowed = new Set((await mappableRoles()).map((r) => r.name));
  const role = roleFor(groups.map((g) => g.display_name), (await roleMapOf(orgId)).filter((m) => allowed.has(m.role)));
  const current = await outsideRequestScope(() => many<{ name: string }>(`SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1`, [userId]));
  if (role && current.length === 1 && current[0]!.name === role) return role;
  if (!role && !current.length) return null;
  const { setUserRole } = await import('./users.js');
  await outsideRequestScope(async () => {
    if (role) await setUserRole(userId, orgId, role);
    else await query(`DELETE FROM user_role WHERE user_id = $1`, [userId]);
  });
  return role;
}

async function reconcileAll(orgId: string) {
  const us = await outsideRequestScope(() => many<{ user_id: string }>(`SELECT user_id FROM scim_user WHERE org_id = $1`, [orgId]));
  for (const u of us) await reconcileUser(orgId, u.user_id);
}

// ------------------------------------------------------------------ users

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : undefined);

async function userView(orgId: string, id: string, base: string) {
  const u = await outsideRequestScope(() => one<any>(
    `SELECT u.id, u.email, u.name, u.status, u.created_at, su.external_id, su.user_name, su.updated_at
       FROM app_user u JOIN scim_user su ON su.user_id = u.id WHERE u.id = $1 AND u.org_id = $2`, [id, orgId]));
  if (!u) throw new ScimError(404, 'No such user.');
  const groups = await outsideRequestScope(() => many<any>(
    `SELECT g.id, g.display_name FROM scim_group_member m JOIN scim_group g ON g.id = m.group_id WHERE m.user_id = $1 ORDER BY g.display_name`, [id]));
  const [given, ...rest] = String(u.name ?? '').split(' ');
  return {
    schemas: [SCHEMA_USER], id: u.id, externalId: u.external_id ?? undefined, userName: u.user_name,
    name: { formatted: u.name, givenName: given || undefined, familyName: rest.join(' ') || undefined }, displayName: u.name,
    emails: u.email ? [{ value: u.email, type: 'work', primary: true }] : [], active: u.status === 'active',
    groups: groups.map((g) => ({ value: g.id, display: g.display_name, $ref: `${base}/Groups/${g.id}` })),
    meta: { resourceType: 'User', created: iso(u.created_at), lastModified: iso(u.updated_at), location: `${base}/Users/${u.id}` },
  };
}

interface UserIn { userName?: string; email?: string | null; name?: string | null; active?: boolean; externalId?: string | null }

function parseUser(b: any): UserIn {
  const email = Array.isArray(b?.emails) ? (b.emails.find((e: any) => e?.primary)?.value ?? b.emails[0]?.value) : undefined;
  const formatted = b?.name?.formatted ?? ([b?.name?.givenName, b?.name?.familyName].filter(Boolean).join(' ') || b?.displayName);
  return {
    userName: b?.userName === undefined ? undefined : String(b.userName).trim().toLowerCase(),
    email: email === undefined ? undefined : String(email).trim().toLowerCase(),
    name: formatted === undefined ? undefined : String(formatted).trim().slice(0, 120),
    active: b?.active === undefined ? undefined : b.active === true || b.active === 'true' || b.active === 'True',
    externalId: b?.externalId === undefined ? undefined : String(b.externalId).slice(0, 300),
  };
}

async function setActive(orgId: string, userId: string, active: boolean) {
  const u = await outsideRequestScope(() => one<{ status: string }>(`SELECT status FROM app_user WHERE id = $1 AND org_id = $2`, [userId, orgId]));
  if (!u || (u.status === 'active') === active) return;
  if (!active && await isAdministrator(userId)) throw new ScimError(400, 'An administrator is deactivated in the console, not by provisioning.', 'mutability');
  const { setUserStatus } = await import('./users.js');
  await outsideRequestScope(() => setUserStatus(userId, active ? 'active' : 'disabled'));
}

export async function createUser(orgId: string, b: any, base: string) {
  const x = parseUser(b);
  const userName = x.userName ?? x.email ?? '';
  if (!EMAIL_RE.test(userName)) throw new ScimError(400, 'userName must be the person\'s e-mail address.', 'invalidValue');
  const email = x.email && EMAIL_RE.test(x.email) ? x.email : userName;
  const linked = await outsideRequestScope(() => one<{ user_id: string }>(`SELECT user_id FROM scim_user WHERE org_id = $1 AND lower(user_name) = $2`, [orgId, userName]));
  if (linked) throw new ScimError(409, 'A user with this userName is already provisioned.', 'uniqueness');
  let u = await outsideRequestScope(() => one<{ id: string }>(`SELECT id FROM app_user WHERE org_id = $1 AND lower(email) = $2`, [orgId, email]));
  if (!u) {
    try {
      u = await outsideRequestScope(() => one<{ id: string }>(
        `INSERT INTO app_user (org_id, email, name, status) VALUES ($1, $2, $3, 'active') RETURNING id`, [orgId, email, x.name || email.split('@')[0]!]));
    } catch (e: any) {
      // The address belongs to a console user in another organisation (unique across the platform).
      if (e?.code === '23505') throw new ScimError(409, 'This e-mail address cannot be used.', 'uniqueness');
      throw e;
    }
  } else if (x.name) {
    await outsideRequestScope(() => query(`UPDATE app_user SET name = $2 WHERE id = $1`, [u!.id, x.name]));
  }
  await outsideRequestScope(() => query(`INSERT INTO scim_user (user_id, org_id, external_id, user_name) VALUES ($1, $2, $3, $4)`, [u!.id, orgId, x.externalId ?? null, userName]));
  if (x.active === false) await setActive(orgId, u!.id, false);
  await reconcileUser(orgId, u!.id);
  return userView(orgId, u!.id, base);
}

async function linkedUser(orgId: string, id: string) {
  if (!UUID_RE.test(id)) throw new ScimError(404, 'No such user.');
  const r = await outsideRequestScope(() => one<{ user_id: string }>(`SELECT user_id FROM scim_user WHERE user_id = $1 AND org_id = $2`, [id, orgId]));
  if (!r) throw new ScimError(404, 'No such user.');
  return r.user_id;
}

export const getUser = async (orgId: string, id: string, base: string) => userView(orgId, await linkedUser(orgId, id), base);

/** PUT: replace what SCIM manages (name, e-mail, active, externalId). */
export async function replaceUser(orgId: string, id: string, b: any, base: string) {
  const uid = await linkedUser(orgId, id);
  const x = parseUser(b);
  await applyUser(orgId, uid, { ...x, active: x.active ?? true });
  return userView(orgId, uid, base);
}

async function applyUser(orgId: string, uid: string, x: UserIn) {
  if (x.userName !== undefined) {
    if (!EMAIL_RE.test(x.userName)) throw new ScimError(400, 'userName must be the person\'s e-mail address.', 'invalidValue');
    await outsideRequestScope(() => query(`UPDATE scim_user SET user_name = $2, updated_at = now() WHERE user_id = $1`, [uid, x.userName]));
  }
  const email = x.email ?? x.userName;
  if (email && EMAIL_RE.test(email)) {
    await outsideRequestScope(() => query(`UPDATE app_user SET email = $2 WHERE id = $1 AND lower(email) IS DISTINCT FROM $2`, [uid, email]))
      .catch((e: any) => { if (e?.code === '23505') throw new ScimError(409, 'This e-mail address cannot be used.', 'uniqueness'); throw e; });
  }
  if (x.name) await outsideRequestScope(() => query(`UPDATE app_user SET name = $2 WHERE id = $1`, [uid, x.name]));
  if (x.externalId !== undefined) await outsideRequestScope(() => query(`UPDATE scim_user SET external_id = $2 WHERE user_id = $1`, [uid, x.externalId]));
  if (x.active !== undefined) await setActive(orgId, uid, x.active);
  await outsideRequestScope(() => query(`UPDATE scim_user SET updated_at = now() WHERE user_id = $1`, [uid]));
}

/** PATCH (RFC 7644 §3.5.2): replace / add on active, name, emails, userName, externalId — what identity providers send. */
export async function patchUser(orgId: string, id: string, b: any, base: string) {
  const uid = await linkedUser(orgId, id);
  const ops: any[] = Array.isArray(b?.Operations) ? b.Operations : [];
  if (!ops.length) throw new ScimError(400, 'A PatchOp with Operations is required.', 'invalidSyntax');
  for (const op of ops.slice(0, 50)) {
    const kind = String(op?.op ?? '').toLowerCase();
    if (kind !== 'replace' && kind !== 'add') throw new ScimError(400, `op ${String(op?.op).slice(0, 20)} is not supported on a user.`, 'invalidValue');
    const path = op?.path ? String(op.path) : null;
    const value = op?.value;
    const one_ = (p: string, v: unknown): UserIn => {
      const key = p.toLowerCase();
      if (key === 'active') return { active: v === true || v === 'true' || v === 'True' };
      if (key === 'username') return { userName: String(v).trim().toLowerCase() };
      if (key === 'externalid') return { externalId: String(v).slice(0, 300) };
      if (key === 'displayname' || key === 'name.formatted') return { name: String(v).trim().slice(0, 120) };
      if (key.startsWith('emails')) {
        const e = Array.isArray(v) ? (v.find((x: any) => x?.primary)?.value ?? v[0]?.value) : typeof v === 'object' && v ? (v as any).value : v;
        return { email: String(e ?? '').trim().toLowerCase() };
      }
      if (key === 'name') return parseUser({ name: v });
      return {};
    };
    const changes = path ? one_(path, value) : parseUser(value);
    await applyUser(orgId, uid, changes);
  }
  return userView(orgId, uid, base);
}

/** DELETE: deactivated (never removed: the history and the audit trail stay). */
export async function deleteUser(orgId: string, id: string) {
  const uid = await linkedUser(orgId, id);
  await setActive(orgId, uid, false);
  await outsideRequestScope(() => query(`DELETE FROM scim_group_member WHERE user_id = $1`, [uid]));
  await outsideRequestScope(() => query(`DELETE FROM user_role WHERE user_id = $1 AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = $1 AND status = 'active')`, [uid]));
}

/** A SCIM filter of the forms identity providers send: attr eq "value" (userName, externalId, emails.value, displayName). */
export function parseFilter(f: unknown): { attr: string; value: string } | null {
  if (f === undefined || f === null || f === '') return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(String(f));
  if (!m) throw new ScimError(400, 'Only filters of the form attribute eq "value" are supported.', 'invalidFilter');
  return { attr: m[1]!.toLowerCase(), value: m[2]!.replace(/\\(.)/g, '$1') };
}

const page = (q: any) => ({ start: Math.max(1, Number(q?.startIndex) || 1), count: Math.min(MAX_PAGE, Math.max(0, Number(q?.count ?? 100) || 0)) });

export async function listUsers(orgId: string, q: any, base: string) {
  const f = parseFilter(q?.filter);
  const { start, count } = page(q);
  const where = !f ? '' : f.attr === 'username' ? 'AND lower(su.user_name) = lower($2)' : f.attr === 'externalid' ? 'AND su.external_id = $2'
    : f.attr === 'emails.value' || f.attr === 'emails' ? 'AND lower(u.email) = lower($2)' : null;
  if (where === null) throw new ScimError(400, `Filtering on ${f!.attr} is not supported.`, 'invalidFilter');
  const params: unknown[] = [orgId, ...(f ? [f.value] : [])];
  const total = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM scim_user su JOIN app_user u ON u.id = su.user_id WHERE su.org_id = $1 ${where}`, params));
  const ids = await outsideRequestScope(() => many<{ user_id: string }>(
    `SELECT su.user_id FROM scim_user su JOIN app_user u ON u.id = su.user_id WHERE su.org_id = $1 ${where} ORDER BY su.created_at, su.user_id OFFSET ${start - 1} LIMIT ${count}`, params));
  const Resources = [];
  for (const r of ids) Resources.push(await userView(orgId, r.user_id, base));
  return { schemas: [SCHEMA_LIST], totalResults: total?.n ?? 0, startIndex: start, itemsPerPage: Resources.length, Resources };
}

// ------------------------------------------------------------------ groups

async function groupView(orgId: string, id: string, base: string, withMembers = true) {
  const g = await outsideRequestScope(() => one<any>(`SELECT * FROM scim_group WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!g) throw new ScimError(404, 'No such group.');
  const members = withMembers ? await outsideRequestScope(() => many<any>(
    `SELECT u.id, u.name FROM scim_group_member m JOIN app_user u ON u.id = m.user_id WHERE m.group_id = $1 ORDER BY u.name`, [id])) : [];
  return {
    schemas: [SCHEMA_GROUP], id: g.id, externalId: g.external_id ?? undefined, displayName: g.display_name,
    members: members.map((m) => ({ value: m.id, display: m.name, $ref: `${base}/Users/${m.id}` })),
    meta: { resourceType: 'Group', created: iso(g.created_at), lastModified: iso(g.updated_at), location: `${base}/Groups/${g.id}` },
  };
}

async function groupId(orgId: string, id: string) {
  if (!UUID_RE.test(id)) throw new ScimError(404, 'No such group.');
  const g = await outsideRequestScope(() => one<{ id: string }>(`SELECT id FROM scim_group WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!g) throw new ScimError(404, 'No such group.');
  return g.id;
}

/** Members to add: only users this identity provider manages (in scim_user). */
async function memberIds(orgId: string, raw: unknown): Promise<string[]> {
  const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((m: any) => String(m?.value ?? '')).filter((v) => UUID_RE.test(v));
  if (!ids.length) return [];
  const ok = await outsideRequestScope(() => many<{ user_id: string }>(`SELECT user_id FROM scim_user WHERE org_id = $1 AND user_id = ANY($2::uuid[])`, [orgId, ids]));
  return ok.map((r) => r.user_id);
}

async function setMembers(orgId: string, gid: string, add: string[], remove: string[] | 'all') {
  const before = await outsideRequestScope(() => many<{ user_id: string }>(`SELECT user_id FROM scim_group_member WHERE group_id = $1`, [gid]));
  if (remove === 'all') await outsideRequestScope(() => query(`DELETE FROM scim_group_member WHERE group_id = $1`, [gid]));
  else if (remove.length) await outsideRequestScope(() => query(`DELETE FROM scim_group_member WHERE group_id = $1 AND user_id = ANY($2::uuid[])`, [gid, remove]));
  for (const u of add) await outsideRequestScope(() => query(`INSERT INTO scim_group_member (group_id, user_id, org_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [gid, u, orgId]));
  await outsideRequestScope(() => query(`UPDATE scim_group SET updated_at = now() WHERE id = $1`, [gid]));
  const touched = new Set([...before.map((r) => r.user_id), ...add, ...(remove === 'all' ? [] : remove)]);
  for (const u of touched) await reconcileUser(orgId, u);
}

export async function createGroup(orgId: string, b: any, base: string) {
  const name = String(b?.displayName ?? '').trim();
  if (!name || name.length > 300) throw new ScimError(400, 'displayName is required.', 'invalidValue');
  let g: { id: string } | null;
  try {
    g = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO scim_group (org_id, display_name, external_id) VALUES ($1, $2, $3) RETURNING id`,
      [orgId, name, b?.externalId ? String(b.externalId).slice(0, 300) : null]));
  } catch (e: any) {
    if (e?.code === '23505') throw new ScimError(409, 'A group with this displayName exists.', 'uniqueness');
    throw e;
  }
  await setMembers(orgId, g!.id, await memberIds(orgId, b?.members), []);
  return groupView(orgId, g!.id, base);
}

export const getGroup = async (orgId: string, id: string, base: string, q?: any) =>
  groupView(orgId, await groupId(orgId, id), base, !String(q?.excludedAttributes ?? '').includes('members'));

export async function replaceGroup(orgId: string, id: string, b: any, base: string) {
  const gid = await groupId(orgId, id);
  const name = String(b?.displayName ?? '').trim();
  if (name) await outsideRequestScope(() => query(`UPDATE scim_group SET display_name = $2 WHERE id = $1`, [gid, name.slice(0, 300)]))
    .catch((e: any) => { if (e?.code === '23505') throw new ScimError(409, 'A group with this displayName exists.', 'uniqueness'); throw e; });
  await setMembers(orgId, gid, await memberIds(orgId, b?.members), 'all');
  return groupView(orgId, gid, base);
}

/** PATCH: members add / remove (by value, or the filter members[value eq "…"]) / replace; displayName replace. */
export async function patchGroup(orgId: string, id: string, b: any, base: string) {
  const gid = await groupId(orgId, id);
  const ops: any[] = Array.isArray(b?.Operations) ? b.Operations : [];
  if (!ops.length) throw new ScimError(400, 'A PatchOp with Operations is required.', 'invalidSyntax');
  let renamed = false;
  for (const op of ops.slice(0, 100)) {
    const kind = String(op?.op ?? '').toLowerCase();
    const path = String(op?.path ?? '');
    const filt = /^members\[value eq "([^"]+)"\]$/i.exec(path);
    if (!path && kind === 'replace' && op?.value?.displayName) {
      await outsideRequestScope(() => query(`UPDATE scim_group SET display_name = $2 WHERE id = $1`, [gid, String(op.value.displayName).trim().slice(0, 300)]));
      renamed = true;
    } else if (path.toLowerCase() === 'displayname' && kind === 'replace') {
      await outsideRequestScope(() => query(`UPDATE scim_group SET display_name = $2 WHERE id = $1`, [gid, String(op.value).trim().slice(0, 300)]));
      renamed = true;
    } else if (path.toLowerCase() === 'members' && kind === 'add') {
      await setMembers(orgId, gid, await memberIds(orgId, op.value), []);
    } else if (path.toLowerCase() === 'members' && kind === 'replace') {
      await setMembers(orgId, gid, await memberIds(orgId, op.value), 'all');
    } else if (kind === 'remove' && filt) {
      await setMembers(orgId, gid, [], [filt[1]!].filter((v) => UUID_RE.test(v)));
    } else if (kind === 'remove' && path.toLowerCase() === 'members') {
      const vals = (Array.isArray(op.value) ? op.value : []).map((m: any) => String(m?.value ?? '')).filter((v: string) => UUID_RE.test(v));
      await setMembers(orgId, gid, [], vals.length ? vals : 'all');
    } else {
      throw new ScimError(400, `This operation is not supported on a group (${kind} ${path.slice(0, 40)}).`, 'invalidPath');
    }
  }
  // A renamed group may now map to another role.
  if (renamed) {
    const ms = await outsideRequestScope(() => many<{ user_id: string }>(`SELECT user_id FROM scim_group_member WHERE group_id = $1`, [gid]));
    for (const m of ms) await reconcileUser(orgId, m.user_id);
  }
  return groupView(orgId, gid, base);
}

export async function deleteGroup(orgId: string, id: string) {
  const gid = await groupId(orgId, id);
  const ms = await outsideRequestScope(() => many<{ user_id: string }>(`SELECT user_id FROM scim_group_member WHERE group_id = $1`, [gid]));
  await outsideRequestScope(() => query(`DELETE FROM scim_group WHERE id = $1`, [gid]));
  for (const m of ms) await reconcileUser(orgId, m.user_id);
}

export async function listGroups(orgId: string, q: any, base: string) {
  const f = parseFilter(q?.filter);
  const { start, count } = page(q);
  const where = !f ? '' : f.attr === 'displayname' ? 'AND lower(display_name) = lower($2)' : f.attr === 'externalid' ? 'AND external_id = $2' : null;
  if (where === null) throw new ScimError(400, `Filtering on ${f!.attr} is not supported.`, 'invalidFilter');
  const params: unknown[] = [orgId, ...(f ? [f.value] : [])];
  const total = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM scim_group WHERE org_id = $1 ${where}`, params));
  const ids = await outsideRequestScope(() => many<{ id: string }>(`SELECT id FROM scim_group WHERE org_id = $1 ${where} ORDER BY created_at, id OFFSET ${start - 1} LIMIT ${count}`, params));
  const withMembers = !String(q?.excludedAttributes ?? '').includes('members');
  const Resources = [];
  for (const r of ids) Resources.push(await groupView(orgId, r.id, base, withMembers));
  return { schemas: [SCHEMA_LIST], totalResults: total?.n ?? 0, startIndex: start, itemsPerPage: Resources.length, Resources };
}

// ------------------------------------------------------------------ discovery

export function serviceProviderConfig(base: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: `${base.replace(/\/scim\/v2$/, '')}/api-docs.html`,
    patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'The organisation\'s SCIM token (Users & Roles → Provisioning (SCIM)).', primary: true }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  };
}

export function resourceTypes(base: string) {
  const rt = (id: string, schema: string) => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id, name: id, endpoint: `/${id}s`, schema, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/${id}` } });
  return { schemas: [SCHEMA_LIST], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [rt('User', SCHEMA_USER), rt('Group', SCHEMA_GROUP)] };
}

export function schemas() {
  const attr = (name: string, type = 'string', extra: Record<string, unknown> = {}) => ({ name, type, multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra });
  const user = { id: SCHEMA_USER, name: 'User', description: 'A console user', attributes: [attr('userName', 'string', { required: true, uniqueness: 'server' }), attr('name', 'complex'), attr('displayName'), attr('emails', 'complex', { multiValued: true }), attr('active', 'boolean'), attr('externalId'), attr('groups', 'complex', { multiValued: true, mutability: 'readOnly' })] };
  const group = { id: SCHEMA_GROUP, name: 'Group', description: 'A group; its members\' role comes from the group → role map', attributes: [attr('displayName', 'string', { required: true }), attr('members', 'complex', { multiValued: true }), attr('externalId')] };
  return { schemas: [SCHEMA_LIST], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [user, group] };
}

/** The SCIM error body (RFC 7644 §3.12). */
export const errorBody = (e: ScimError) => ({ schemas: [SCHEMA_ERROR], status: String(e.status), detail: e.detail, ...(e.scimType ? { scimType: e.scimType } : {}) });

