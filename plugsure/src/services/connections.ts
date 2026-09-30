import { many, one, query } from '../db/pool.js';

/**
 * Connection-attempt log.
 *
 * Before this existed, a charger that failed to connect left no trace anywhere
 * except a stdout line. Four realistic commissioning failures — unknown identity,
 * no credentials, wrong password, wrong case — produced zero rows in every table.
 * On a vendor test day that is the difference between a two-hour visit and a
 * wasted one, because nobody can tell whether the charger reached the server at all.
 */

export type AttemptOutcome =
  | 'accepted'
  /**
   * The WebSocket upgrade succeeded but the charge point is still awaiting an
   * operator's approval, so BootNotification will answer `Pending` and the unit
   * cannot transact. Recording this as plain `accepted` (HTTP 101) made a unit
   * that is in fact blocked look healthy in the console, and kept it out of the
   * adoption queue — which is built from non-accepted outcomes.
   */
  | 'accepted_pending_adoption'
  | 'rejected_unknown_cp'
  | 'rejected_auth'
  | 'rejected_no_subprotocol'
  | 'rejected_no_identity'
  | 'rejected_tls_required'
  | 'rejected_malformed_path'
  | 'error';

export interface AttemptRecord {
  remoteIp?: string | null;
  forwardedFor?: string | null;
  requestPath?: string | null;
  ocppIdentity?: string | null;
  chargePointId?: string | null;
  subprotocols?: string | null;
  negotiated?: string | null;
  authPresent?: boolean;
  authScheme?: string | null;
  tls?: boolean;
  userAgent?: string | null;
  outcome: AttemptOutcome;
  httpStatus?: number | null;
  detail?: string | null;
}

export async function recordAttempt(a: AttemptRecord): Promise<void> {
  await query(
    `INSERT INTO connection_attempt
       (remote_ip, forwarded_for, request_path, ocpp_identity, charge_point_id,
        subprotocols, negotiated, auth_present, auth_scheme, tls, user_agent,
        outcome, http_status, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      a.remoteIp ?? null,
      a.forwardedFor ?? null,
      a.requestPath ?? null,
      a.ocppIdentity ?? null,
      a.chargePointId ?? null,
      a.subprotocols ?? null,
      a.negotiated ?? null,
      a.authPresent ?? false,
      a.authScheme ?? null,
      a.tls ?? false,
      a.userAgent ?? null,
      a.outcome,
      a.httpStatus ?? null,
      a.detail ?? null,
    ],
  );
}

export interface AttemptFilter {
  identity?: string;
  outcome?: AttemptOutcome;
  since?: Date;
  until?: Date;
  limit?: number;
  /**
   * Restrict to attempts whose identity resolves to this organisation.
   *
   * These endpoints were global. Every tenant with `charge_point:read` could
   * enumerate every other tenant's charge point identities, the source IPs of
   * their sites, their user agents, their firmware fingerprints and their
   * authentication failures — a complete reconnaissance surface for the whole
   * platform, handed out with the lowest-privilege read permission there is.
   */
  orgId?: string;
}

export async function listAttempts(f: AttemptFilter = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (f.identity) add('ocpp_identity = ?', f.identity);
  if (f.orgId) {
    add(
      `ocpp_identity IN (
         SELECT cp.ocpp_identity FROM charge_point cp JOIN site s ON s.id = cp.site_id
          WHERE s.org_id = ?)`,
      f.orgId,
    );
  }
  if (f.outcome) add('outcome = ?', f.outcome);
  if (f.since) add('ts >= ?', f.since);
  if (f.until) add('ts <= ?', f.until);
  params.push(Math.min(f.limit ?? 200, 1000));

  return many(
    `SELECT id, ts, remote_ip, forwarded_for, request_path, ocpp_identity, subprotocols,
            negotiated, auth_present, auth_scheme, tls, user_agent, outcome, http_status, detail
       FROM connection_attempt
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC
      LIMIT $${params.length}`,
    params,
  );
}

/**
 * The adoption queue: identities that knocked and were turned away because we do
 * not know them.
 *
 * An unknown identity belongs to NO organisation by definition, so this list
 * cannot be tenant-scoped and is a platform-operator surface. Tenants reach the
 * same outcome without seeing each other's hardware by pre-registering the
 * identity (POST /v1/charge-points creates the row in `pending_adoption`), which
 * makes the attempt resolvable and therefore visible in their own attempt log.
 */
export async function pendingChargers() {
  return many(
    `SELECT ocpp_identity,
            count(*)                          AS attempts,
            min(ts)                           AS first_seen_at,
            max(ts)                           AS last_seen_at,
            (array_agg(remote_ip ORDER BY ts DESC))[1]    AS last_remote_ip,
            (array_agg(subprotocols ORDER BY ts DESC))[1] AS last_subprotocols,
            (array_agg(tls ORDER BY ts DESC))[1]          AS last_tls,
            bool_or(auth_present)             AS ever_sent_credentials,
            (array_agg(outcome ORDER BY ts DESC))[1]      AS last_outcome
       FROM connection_attempt
      WHERE ocpp_identity IS NOT NULL
        AND outcome IN ('rejected_unknown_cp', 'rejected_auth', 'rejected_tls_required',
                        'accepted_pending_adoption')
        AND NOT EXISTS (SELECT 1 FROM charge_point cp WHERE cp.ocpp_identity = connection_attempt.ocpp_identity)
      GROUP BY ocpp_identity
      ORDER BY max(ts) DESC
      LIMIT 200`,
  );
}

/** Near-identity suggestions — a wrong-case or transposed serial is the classic failure. */
export async function suggestMatches(identity: string, orgId: string) {
  // Suggestions are drawn from the caller's OWN fleet. Unscoped, this endpoint
  // was a free identity-enumeration oracle: probe with any substring and it
  // returned matching charge point identities and site names from every tenant.
  return many<{ ocpp_identity: string; site_name: string }>(
    `SELECT cp.ocpp_identity, s.name AS site_name
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE s.org_id = $2
        AND (lower(cp.ocpp_identity) = lower($1)
             OR cp.ocpp_identity ILIKE '%' || $1 || '%'
             OR $1 ILIKE '%' || cp.ocpp_identity || '%')
      LIMIT 5`,
    [identity, orgId],
  );
}

export async function attemptStats(sinceMinutes = 60, orgId?: string) {
  return one(
    `SELECT count(*) FILTER (WHERE outcome = 'accepted')  AS accepted,
            count(*) FILTER (WHERE outcome = 'accepted_pending_adoption') AS pending_adoption,
            count(*) FILTER (WHERE outcome NOT IN ('accepted', 'accepted_pending_adoption')) AS rejected,
            count(DISTINCT ocpp_identity)                 AS identities
       FROM connection_attempt
      WHERE ts > now() - ($1 || ' minutes')::interval
        AND ($2::uuid IS NULL OR ocpp_identity IN (
              SELECT cp.ocpp_identity FROM charge_point cp JOIN site s ON s.id = cp.site_id
               WHERE s.org_id = $2))`,
    [sinceMinutes, orgId ?? null],
  );
}
