import { one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import type { PlugSureEvents } from './events.js';

/**
 * The alert table, written from ONE place.
 *
 * Both processes persist the alerts they raise (named bus listeners run only
 * where the event was emitted). This used to be two copies of an INSERT; it is
 * now this function, which also:
 *
 *  - folds a repeat of the same OPEN problem (same kind and target) into the
 *    existing alert (occurrences + 1) — the hourly compliance sweep re-raised a
 *    lapsed tera every hour, which with notifications on would page someone
 *    every hour;
 *  - records the site the alert belongs to, so routing rules can be scoped to
 *    sites and site-scoped users only see their own.
 */

/** Site of an alert target, in SQL. $1 = target_type, $2 = target_id. */
const SITE_OF_TARGET = `
  CASE $1::text
    WHEN 'charge_point' THEN (SELECT site_id FROM charge_point WHERE id::text = $2)
    WHEN 'connector' THEN (SELECT site_id FROM charge_point WHERE id::text = split_part($2, ':', 1))
    WHEN 'device_component' THEN (SELECT site_id FROM charge_point WHERE id::text = split_part($2, ':', 1))
    WHEN 'site' THEN (SELECT id FROM site WHERE id::text = $2)
    WHEN 'payment_intent' THEN (
      SELECT cp.site_id FROM payment_intent pi
        JOIN connector c ON c.id = pi.connector_uuid
        JOIN evse e ON e.id = c.evse_uuid
        JOIN charge_point cp ON cp.id = e.charge_point_id
       WHERE pi.id::text = $2)
    ELSE NULL
  END`;

export async function persistAlert(a: PlugSureEvents['alert.raised']): Promise<string | null> {
  const targetType = a.targetType ?? null;
  const targetId = a.targetId ?? null;
  try {
    if (targetType && targetId) {
      const again = await one<{ id: string }>(
        `UPDATE alert SET occurrences = occurrences + 1, last_raised_at = now(), message = $5,
                severity = CASE WHEN $6 = 'critical' THEN 'critical' ELSE severity END
          WHERE org_id = $3 AND kind = $4 AND target_type = $1 AND target_id = $2 AND resolved_at IS NULL
          RETURNING id`,
        [targetType, targetId, a.orgId, a.kind, a.message, a.severity],
      );
      if (again) return again.id;
    }
    const row = await one<{ id: string }>(
      `INSERT INTO alert (org_id, severity, kind, message, target_type, target_id, site_id, last_raised_at)
       VALUES ($3, $4, $5, $6, $1, $2, ${SITE_OF_TARGET}, now())
       RETURNING id`,
      [targetType, targetId, a.orgId, a.severity, a.kind, a.message],
    );
    return row?.id ?? null;
  } catch (e) {
    logger.warn({ err: (e as Error).message, kind: a.kind }, 'failed to persist alert');
    return null;
  }
}

/** Close the open alert(s) for a condition that has cleared (e.g. a connector no longer faulted). */
export async function resolveAlertsFor(orgId: string, kind: string, targetType: string, targetId: string): Promise<number> {
  const r = await query(
    `UPDATE alert SET resolved_at = now()
      WHERE org_id = $1 AND kind = $2 AND target_type = $3 AND target_id = $4 AND resolved_at IS NULL`,
    [orgId, kind, targetType, targetId],
  );
  return r.rowCount ?? 0;
}
