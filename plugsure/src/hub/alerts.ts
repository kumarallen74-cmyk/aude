import { many, one, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { bus } from '../services/events.js';

/**
 * Hub alerts on the existing alert mechanism (bus 'alert.raised' → the alert table, routing and notifications).
 * Each is raised in the org of the connection's member (alert.org_id must be a real organisation: H1 raised them
 * with NIL_ORG, which the alert table's foreign key refused, so none was ever stored) and targets the hub
 * connection, so a repeat folds into the open alert. Platform admins see them all on the Hub overview.
 *
 *   hub.connection_offline   raised by the alive checks (clientinfo.ts); resolved here once the connection's parties
 *                            are no longer OFFLINE.
 *   hub.forward_error_rate   a connection's outbound legs failing (HTTP ≥ 400, OCPI ≥ 2000 or no answer) at or above
 *                            HUB_ALERT_ERROR_RATE_PCT of at least HUB_ALERT_MIN_REQUESTS legs in 15 min; resolved
 *                            when the rate drops below it again.
 *   hub.response_filtered    a source returned sessions or CDRs that were not the requester's (the response filter,
 *                            design §5.3 D12, dropped them). Should never fire against a correct CPO.
 */

export interface LegCounts { connection_id: string; member_name: string; out_15m: number; errors_15m: number }

/** Pure: does this connection's 15-minute window cross the error-rate threshold? */
export function errorRateBreached(c: Pick<LegCounts, 'out_15m' | 'errors_15m'>, pct = config.hub.alertErrorRatePct, min = config.hub.alertMinRequests): boolean {
  if (c.out_15m < Math.max(1, min)) return false;
  return (c.errors_15m * 100) / c.out_15m >= pct;
}

/** Raise a hub alert about a connection, in its member's organisation. Never throws. */
export async function raiseHubAlert(connectionId: string, kind: string, severity: 'warning' | 'critical', message: (memberName: string) => string): Promise<void> {
  try {
    const m = await one<{ org_id: string; legal_name: string }>(
      `SELECT m.org_id, m.legal_name FROM hub_connection c JOIN hub_member m ON m.id = c.member_id WHERE c.id = $1`, [connectionId]);
    if (!m) return;
    bus.emit('alert.raised', { orgId: m.org_id, kind, severity, targetType: 'hub_connection', targetId: connectionId, message: message(m.legal_name) });
  } catch (e) {
    logger.warn({ err: (e as Error).message, kind, connectionId }, 'hub alert not raised');
  }
}

/** Resolve the open hub alerts of one kind about a connection (whatever org they were raised in). */
async function resolveHubAlert(kind: string, connectionId: string): Promise<number> {
  const r = await query(`UPDATE alert SET resolved_at = now() WHERE kind = $1 AND target_type = 'hub_connection' AND target_id = $2 AND resolved_at IS NULL`, [kind, connectionId]);
  return r.rowCount ?? 0;
}

/** Worker (every 5 min, HUB_ENABLED only): raise or resolve hub.forward_error_rate; resolve stale hub.connection_offline. */
export async function checkHubAlerts(): Promise<{ raised: number; resolved: number }> {
  const rows = await many<LegCounts>(
    `SELECT c.id AS connection_id, m.legal_name AS member_name,
            count(h.id)::int AS out_15m,
            count(h.id) FILTER (WHERE h.http_status IS NULL OR h.http_status >= 400 OR h.ocpi_status >= 2000)::int AS errors_15m
       FROM hub_connection c JOIN hub_member m ON m.id = c.member_id
       LEFT JOIN hub_message h ON h.connection_id = c.id AND h.leg = 'out' AND h.created_at > now() - interval '15 minutes'
      WHERE c.state = 'connected' GROUP BY c.id, m.legal_name`);
  let raised = 0, resolved = 0;
  for (const r of rows) {
    if (errorRateBreached(r)) {
      raised++;
      await raiseHubAlert(r.connection_id, 'hub.forward_error_rate', 'warning',
        (name) => `PlugSure Hub: ${r.errors_15m} of ${r.out_15m} calls to ${name} failed in the last 15 minutes (threshold ${config.hub.alertErrorRatePct}%).`);
    } else {
      resolved += await resolveHubAlert('hub.forward_error_rate', r.connection_id);
    }
  }
  // Offline alerts whose connection is back (no OFFLINE party left), or closed.
  const back = await many<{ target_id: string }>(
    `SELECT a.target_id FROM alert a
      WHERE a.kind = 'hub.connection_offline' AND a.resolved_at IS NULL AND a.target_type = 'hub_connection'
        AND NOT EXISTS (SELECT 1 FROM hub_party p WHERE p.connection_id::text = a.target_id AND p.status = 'OFFLINE')`);
  for (const b of back) resolved += await resolveHubAlert('hub.connection_offline', b.target_id);
  // Error-rate alerts of connections no longer connected (closed, suspended): nothing is sent to them any more.
  const gone = await many<{ target_id: string }>(
    `SELECT a.target_id FROM alert a
      WHERE a.kind = 'hub.forward_error_rate' AND a.resolved_at IS NULL AND a.target_type = 'hub_connection'
        AND NOT EXISTS (SELECT 1 FROM hub_connection c WHERE c.id::text = a.target_id AND c.state = 'connected')`);
  for (const g of gone) resolved += await resolveHubAlert('hub.forward_error_rate', g.target_id);
  return { raised, resolved };
}

/** Called by the router's response filter when it dropped objects that were not the requester's. */
export function alertResponseFiltered(o: { sourceConnectionId: string | null; source: string; requester: string; module: string; dropped: number }): void {
  if (!o.sourceConnectionId) return;
  void raiseHubAlert(o.sourceConnectionId, 'hub.response_filtered', 'warning',
    (name) => `PlugSure Hub: ${o.source} (${name}) returned ${o.dropped} ${o.module} object(s) to ${o.requester} that were not ${o.requester}'s; the hub withheld them.`);
}
