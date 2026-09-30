import { one, many, query } from '../db/pool.js';
import * as commands from '../ocpp/commands.js';
import type { Actor } from '../ocpp/commands.js';

/**
 * RFID card inventory and access control (SPEC Module 7).
 *
 * Replaces the hard-coded whitelist scripts. A card is a `token` row (kind rfid);
 * the holder, account type and limits are operator metadata on it. The OCPP
 * authorisation path (adapter16.authorizeIdTag) reads status, expiry and the
 * cumulative limits, so a change here takes effect on the next Authorize.
 */

export const ACCOUNT_TYPES = [
  { code: 'retail', label: 'Retail Driver' },
  { code: 'fleet', label: 'Corporate Fleet' },
  { code: 'vip', label: 'VIP / Internal Testing' },
  { code: 'technician', label: 'Maintenance Technician' },
] as const;

/** OCPP 1.6 idTag is CiString20: at most 20 printable ASCII characters. */
export const ID_TAG_RE = /^[\x21-\x7e]{1,20}$/;

export interface TokenInput {
  uid?: string;
  holderName?: string | null;
  holderPhone?: string | null;
  accountType?: string;
  fleetName?: string | null;
  status?: string;
  validTo?: string | null;
  energyLimitKwh?: number | null;
  spendLimitIdr?: number | null;
  offlineAllowed?: boolean;
  notes?: string | null;
  pin?: string | null;
}

export function validateToken(t: TokenInput, creating: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (creating || t.uid !== undefined) {
    if (!t.uid || !ID_TAG_RE.test(t.uid)) e.uid = 'Card UID must be 1–20 printable characters with no spaces (OCPP idTag)';
  }
  if (t.accountType !== undefined && !ACCOUNT_TYPES.some((a) => a.code === t.accountType)) e.accountType = 'Choose an account type';
  if (t.status !== undefined && !['Accepted', 'Blocked', 'Expired'].includes(t.status)) {
    e.status = 'Status is Active (Accepted), Blocked or Expired';
  }
  if (t.holderPhone && !/^\+?[0-9 ()-]{6,20}$/.test(t.holderPhone)) e.holderPhone = 'Phone number looks wrong';
  if (t.validTo && Number.isNaN(new Date(t.validTo).getTime())) e.validTo = 'Expiry must be a date';
  if (t.energyLimitKwh != null && (!Number.isFinite(t.energyLimitKwh) || t.energyLimitKwh <= 0)) e.energyLimitKwh = 'Energy limit must be positive';
  if (t.spendLimitIdr != null && (!Number.isFinite(t.spendLimitIdr) || t.spendLimitIdr <= 0)) e.spendLimitIdr = 'Spending limit must be positive';
  if (t.pin != null && t.pin !== '' && !/^\d{4,8}$/.test(t.pin)) e.pin = 'PIN is 4–8 digits';
  return e;
}

export function normaliseUid(uid: string): string {
  const u = uid.trim();
  // Pure hex card serials are conventionally upper case; mixed identifiers are kept verbatim.
  return /^[0-9a-fA-F]+$/.test(u) ? u.toUpperCase() : u;
}

export async function listTokens(orgId: string, f: { q?: string; status?: string; accountType?: string; limit?: number } = {}) {
  return many(
    `SELECT t.id, t.uid, t.kind, t.status, t.valid_to, t.offline_allowed, t.holder_name, t.holder_phone,
            t.account_type, t.fleet_name, t.energy_limit_wh, t.spend_limit_idr, t.notes, t.created_at,
            t.updated_at, (t.pin_hash IS NOT NULL) AS has_pin,
            COALESCE(u.energy_wh, 0)::bigint AS lifetime_energy_wh,
            COALESCE(u.sessions, 0)::int AS total_sessions,
            COALESCE(u.spend_idr, 0)::bigint AS lifetime_spend_idr,
            u.last_used_at
       FROM token t
       LEFT JOIN LATERAL (
         SELECT sum(cs.energy_wh) AS energy_wh, count(*) AS sessions,
                sum(d.total_idr) AS spend_idr, max(cs.started_at) AS last_used_at
           FROM charging_session cs LEFT JOIN cdr d ON d.session_id = cs.id
          WHERE cs.token_id = t.id
       ) u ON true
      WHERE t.org_id = $1 AND t.kind <> 'prepaid'
        AND ($2::text IS NULL OR t.uid ILIKE '%' || $2 || '%' OR t.holder_name ILIKE '%' || $2 || '%'
             OR t.fleet_name ILIKE '%' || $2 || '%' OR t.holder_phone ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR t.status = $3)
        AND ($4::text IS NULL OR t.account_type = $4)
      ORDER BY t.updated_at DESC
      LIMIT $5`,
    [orgId, f.q || null, f.status || null, f.accountType || null, Math.min(f.limit ?? 500, 2000)],
  );
}

const COLS: Array<[keyof TokenInput, string, (v: any) => unknown]> = [
  ['holderName', 'holder_name', (v) => v || null],
  ['holderPhone', 'holder_phone', (v) => v || null],
  ['accountType', 'account_type', (v) => v],
  ['fleetName', 'fleet_name', (v) => v || null],
  ['status', 'status', (v) => v],
  ['validTo', 'valid_to', (v) => (v ? new Date(v) : null)],
  ['energyLimitKwh', 'energy_limit_wh', (v) => (v == null ? null : Math.round(Number(v) * 1000))],
  ['spendLimitIdr', 'spend_limit_idr', (v) => (v == null ? null : Math.round(Number(v)))],
  ['offlineAllowed', 'offline_allowed', (v) => Boolean(v)],
  ['notes', 'notes', (v) => v || null],
];

export async function createToken(orgId: string, t: TokenInput, pinHash: string | null): Promise<string> {
  const present = COLS.filter(([k]) => t[k] !== undefined);
  const cols = ['org_id', 'kind', 'uid', 'pin_hash', ...present.map(([, c]) => c)];
  const vals = [orgId, 'rfid', normaliseUid(t.uid!), pinHash, ...present.map(([k, , conv]) => conv(t[k]))];
  const row = await one<{ id: string }>(
    `INSERT INTO token (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    vals,
  );
  return row!.id;
}

export async function updateToken(tokenId: string, t: TokenInput, pinHash?: string | null): Promise<void> {
  const present = COLS.filter(([k]) => t[k] !== undefined);
  const sets = present.map(([, c], i) => `${c} = $${i + 2}`);
  const vals: unknown[] = [tokenId, ...present.map(([k, , conv]) => conv(t[k]))];
  if (pinHash !== undefined) {
    vals.push(pinHash);
    sets.push(`pin_hash = $${vals.length}`);
    // A new PIN starts with a clean slate in the driver app (migration 010).
    sets.push('pin_failures = 0', 'pin_locked_until = NULL');
  }
  // The operator set the status: a block is now the operator's, not the fleet customer's (migration 030).
  if (t.status !== undefined) sets.push('customer_blocked_at = NULL');
  sets.push('updated_at = now()');
  await query(`UPDATE token SET ${sets.join(', ')} WHERE id = $1`, vals);
}

export async function tokenOwner(tokenId: string) {
  return one<{ org_id: string; uid: string; status: string }>(`SELECT org_id, uid, status FROM token WHERE id = $1`, [tokenId]);
}

/**
 * "Scan from live charger": idTags presented at this organisation's chargers in
 * the last half hour that are not yet registered. The installer taps the new
 * card on any reader, then picks it here instead of typing a hex serial.
 */
export async function recentUnknownTags(orgId: string, identity?: string) {
  return many(
    `WITH seen AS (
       SELECT f.ts, f.ocpp_identity,
              COALESCE(f.payload->>'idTag', f.payload->'idToken'->>'idToken') AS id_tag
         FROM ocpp_frame f
         JOIN charge_point cp ON cp.id = f.charge_point_id
         JOIN site s ON s.id = cp.site_id
        WHERE s.org_id = $1 AND f.direction = 'in'
          AND f.action IN ('Authorize', 'StartTransaction', 'TransactionEvent')
          AND f.ts > now() - interval '30 minutes'
          AND ($2::text IS NULL OR f.ocpp_identity = $2)
     )
     SELECT id_tag, max(ts) AS last_seen_at, (array_agg(ocpp_identity ORDER BY ts DESC))[1] AS ocpp_identity,
            count(*)::int AS presentations
       FROM seen
      WHERE id_tag IS NOT NULL AND id_tag <> ''
        AND NOT EXISTS (SELECT 1 FROM token t WHERE t.org_id = $1 AND t.uid = seen.id_tag)
      GROUP BY id_tag
      ORDER BY max(ts) DESC
      LIMIT 20`,
    [orgId, identity ?? null],
  );
}

/**
 * Push the organisation's card list into a charger's local authorisation list
 * (SendLocalList, full update), so registered cards keep working through a WAN
 * outage. Goes through the command surface, so it is audited, version-translated
 * and works in the split deployment.
 */
export async function pushLocalList(identity: string, chargePointId: string, actor: Actor) {
  const tokens = await many<{ uid: string; status: string; valid_to: Date | null }>(
    `SELECT t.uid, t.status, t.valid_to
       FROM token t
       JOIN site s ON s.org_id = t.org_id
       JOIN charge_point cp ON cp.site_id = s.id
      WHERE cp.id = $1 AND t.offline_allowed = true AND t.kind <> 'prepaid'
      ORDER BY t.updated_at DESC
      LIMIT 1000`,
    [chargePointId],
  );

  let current = 0;
  try {
    const v = await commands.getLocalListVersion(identity, actor);
    current = Number(v?.listVersion ?? 0);
  } catch (e) {
    return { ok: false, identity, error: (e as Error).message };
  }
  if (current < 0) {
    return { ok: false, identity, error: 'the charger reports that it does not support a local authorisation list' };
  }
  const version = Math.max(current, 0) + 1;
  try {
    const r = await commands.sendLocalList(
      identity,
      version,
      tokens.map((t) => ({
        idTag: t.uid,
        idTagInfo: {
          status: t.status === 'Accepted' || t.status === 'Blocked' || t.status === 'Expired' ? t.status : 'Invalid',
          ...(t.valid_to ? { expiryDate: new Date(t.valid_to).toISOString() } : {}),
        },
      })),
      actor,
    );
    return { ok: r?.status === 'Accepted', identity, status: r?.status, version, count: tokens.length };
  } catch (e) {
    return { ok: false, identity, error: (e as Error).message };
  }
}
