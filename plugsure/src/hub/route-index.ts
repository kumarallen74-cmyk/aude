import { many, query } from '../db/pool.js';
import { mayRoute, type ModuleFlag } from './agreements.js';
import { HUB_STATUS, HubError } from './errors.js';
import type { HubParty } from './types.js';

/**
 * The route index (design §5.3 "idx"): what the router learned from traffic, so that a request without
 * OCPI-to headers (open routing) can be sent to the one party it concerns:
 *
 *   location        location_id                → its CPO           (broadcasts, GET All results)
 *   token           uid:type                   → its eMSP          (token broadcasts, GET All results)
 *   session         session_id                 → its CPO, counter = the eMSP (session PUTs)
 *   reservation     reservation_id             → its CPO, counter = the eMSP (RESERVE_NOW)
 *   authorization   authorization_reference    → its eMSP, counter = the CPO (START_SESSION, real-time authorize)
 *   command_session session_id                 → the profile setter (eMSP/SCSP), counter = the CPO
 *
 * Kept minimal and safe: a lookup only ever returns parties the requester has an agreement with, and more
 * than one candidate is refused (4904) rather than guessed.
 */

export type IndexKind = 'location' | 'token' | 'session' | 'reservation' | 'authorization' | 'command_session';

const EXPIRING: Record<IndexKind, boolean> = { location: false, token: false, session: true, reservation: true, authorization: true, command_session: true };
const TTL_DAYS = 90;

export async function learn(kind: IndexKind, key: string | null | undefined, owner: HubParty, counter: HubParty | null = null, data: Record<string, unknown> | null = null): Promise<void> {
  if (!key || typeof key !== 'string' || key.length > 255) return;
  await query(
    `INSERT INTO hub_route_index (kind, key, owner_party_id, counter_party_id, data, updated_at, expires_at)
     VALUES ($1,$2,$3,$4,$5, now(), CASE WHEN $6 THEN now() + make_interval(days => $7) END)
     ON CONFLICT (kind, key, owner_party_id) DO UPDATE
       SET counter_party_id = COALESCE(EXCLUDED.counter_party_id, hub_route_index.counter_party_id),
           data = COALESCE(hub_route_index.data, '{}'::jsonb) || COALESCE(EXCLUDED.data, '{}'::jsonb),
           updated_at = now(), expires_at = EXCLUDED.expires_at`,
    [kind, key, owner.id, counter?.id ?? null, data ? JSON.stringify(data) : null, EXPIRING[kind], TTL_DAYS],
  ).catch(() => {});
}

export async function markData(kind: IndexKind, key: string, ownerId: string, data: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE hub_route_index SET data = COALESCE(data, '{}'::jsonb) || $4::jsonb, updated_at = now() WHERE kind = $1 AND key = $2 AND owner_party_id = $3`,
    [kind, key, ownerId, JSON.stringify(data)]).catch(() => {});
}

interface Entry { owner_party_id: string; counter_party_id: string | null; data: Record<string, unknown> | null }

async function entries(kind: IndexKind, key: string): Promise<Entry[]> {
  return many<Entry>(
    `SELECT owner_party_id, counter_party_id, data FROM hub_route_index
      WHERE kind = $1 AND key = $2 AND (expires_at IS NULL OR expires_at > now())
      ORDER BY updated_at DESC LIMIT 20`, [kind, key]);
}

/**
 * The one party a request from `from` about (kind, key) goes to.
 * - `side: 'owner'`: the entry's owner is the target (location → CPO, token → eMSP);
 * - `side: 'counter'`: entries whose owner the request names are not known — the target is the OWNER and
 *   the requester must be the entry's counter party (session / reservation: only the eMSP of that session).
 * Candidates are filtered to parties `from` may route to (agreement + module flag) BEFORE the ambiguity
 * check. None → 4001; several → 4904.
 */
export async function resolveOpen(
  kind: IndexKind, key: string | null | undefined, from: HubParty, opts: { requireCounter?: boolean; targetRoles: readonly string[]; flag?: ModuleFlag },
  loadParty: (id: string) => Promise<HubParty | null>,
): Promise<{ target: HubParty; entry: Entry }> {
  if (!key) throw new HubError(200, HUB_STATUS.UNKNOWN_RECEIVER, `unknown receiver: the request names no ${kind} the hub can route by; send OCPI-to-* headers`);
  const found: Array<{ target: HubParty; entry: Entry }> = [];
  for (const e of await entries(kind, key)) {
    if (opts.requireCounter && e.counter_party_id !== from.id) continue;
    const t = await loadParty(e.owner_party_id);
    if (!t || !opts.targetRoles.includes(t.role)) continue;
    if (!(await mayRoute(from, t, opts.flag ?? null)).ok) continue;
    if (!found.some((f) => f.target.id === t.id)) found.push({ target: t, entry: e });
  }
  if (!found.length) throw new HubError(200, HUB_STATUS.UNKNOWN_RECEIVER, `unknown receiver: no party known for ${kind} ${key.slice(0, 40)} that you may reach; send OCPI-to-* headers`);
  if (found.length > 1) throw new HubError(400, HUB_STATUS.AMBIGUOUS, `ambiguous: ${found.length} parties hold ${kind} ${key.slice(0, 40)}; send OCPI-to-* headers`);
  return found[0]!;
}
