import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { bus } from './events.js';
import * as registry from '../ocpp/registry.js';
import { ADMINISTRATIVE_STATES } from './assets.js';

/**
 * Charger availability: outage history, offline alerting and the uptime /
 * utilisation report.
 *
 * Offline detection used to emit an in-process event and nothing else — no
 * record, no alert, no way to report uptime, which is the first number a site
 * host, a PLN partner or an SLA asks for. Every outage is now a row, an outage
 * longer than OFFLINE_ALERT_MINUTES raises a critical alert (and a webhook), and
 * the alert resolves itself when the charger comes back.
 */

async function cpByIdentity(identity: string) {
  return one<{ id: string; org_id: string; status: string }>(
    `SELECT cp.id, s.org_id, cp.status FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.ocpp_identity = $1`,
    [identity],
  );
}

async function openOutage(identity: string, at = new Date()) {
  // A reconnect can race the old socket's close event; don't open an outage for a live charger.
  if (registry.isOnline(identity)) return;
  const cp = await cpByIdentity(identity);
  if (!cp || ADMINISTRATIVE_STATES.includes(cp.status)) return;
  await query(
    `INSERT INTO charge_point_outage (org_id, charge_point_id, went_offline_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (charge_point_id) WHERE came_online_at IS NULL DO NOTHING`,
    [cp.org_id, cp.id, at],
  );
}

export async function closeOutage(identity: string) {
  const cp = await cpByIdentity(identity);
  if (!cp) return;
  const closed = await one<{ id: string; minutes: number; alerted: boolean }>(
    `UPDATE charge_point_outage SET came_online_at = now()
      WHERE charge_point_id = $1 AND came_online_at IS NULL
      RETURNING id, EXTRACT(EPOCH FROM (now() - went_offline_at)) / 60 AS minutes, alerted_at IS NOT NULL AS alerted`,
    [cp.id],
  );
  // Its outage may have been alerted a moment ago by a sweep that read it before the charger
  // came back; that alert is written asynchronously, so resolve again shortly after as well.
  const resolveOpen = () => query(
    `UPDATE alert SET resolved_at = now()
      WHERE org_id = $1 AND kind = 'charge_point.offline' AND target_type = 'charge_point' AND target_id = $2 AND resolved_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM charge_point_outage o WHERE o.charge_point_id = $3::uuid AND o.came_online_at IS NULL)`,
    [cp.org_id, cp.id, cp.id],
  );
  const resolved = await resolveOpen();
  if (closed?.alerted) setTimeout(() => { void resolveOpen().catch(() => undefined); }, 5_000).unref?.();
  if (closed?.alerted || (resolved.rowCount ?? 0) > 0) {
    logger.info({ cp: identity, minutes: Math.round(Number(closed?.minutes ?? 0)) }, 'charger back online — offline alert resolved');
  }
}

/**
 * Take the right to alert for an outage: only while it is still open and not yet alerted.
 * A sweep works from a list read at the start of its pass, so the charger may have come
 * back (and closeOutage already run) by the time it reaches the row.
 */
export async function claimOutageAlert(outageId: string): Promise<boolean> {
  const r = await one<{ id: string }>(
    `UPDATE charge_point_outage SET alerted_at = now() WHERE id = $1 AND came_online_at IS NULL AND alerted_at IS NULL RETURNING id`,
    [outageId],
  );
  return !!r;
}

/** Where connect/disconnect events are raised (the gateway, or all-in-one). */
export function registerUptimeListeners(): void {
  bus.on('charge_point.disconnected', (e) => void openOutage(e.ocppIdentity).catch((err) => logger.warn({ err }, 'outage open failed')));
  bus.on('charge_point.connected', (e) => void closeOutage(e.ocppIdentity).catch((err) => logger.warn({ err }, 'outage close failed')));
}

/**
 * Worker pass:
 *  1. Chargers not connected with no open outage (e.g. the gateway restarted,
 *     which fires no disconnect event) get one, dated from when they were last seen.
 *  2. Open outages past the threshold raise one critical alert each.
 *  3. An open outage for a charger that is in fact connected is closed (self-heal).
 */
export async function sweepOutages(): Promise<void> {
  const quiet = await many<{ id: string; org_id: string; ocpp_identity: string; last_seen_at: Date }>(
    `SELECT cp.id, s.org_id, cp.ocpp_identity, cp.last_seen_at
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE cp.status <> ALL($1::text[]) AND cp.last_seen_at IS NOT NULL
        AND cp.last_seen_at < now() - interval '2 minutes'
        AND NOT EXISTS (SELECT 1 FROM charge_point_outage o WHERE o.charge_point_id = cp.id AND o.came_online_at IS NULL)`,
    [ADMINISTRATIVE_STATES],
  );
  for (const c of quiet) {
    if (registry.isOnline(c.ocpp_identity)) continue;
    await openOutage(c.ocpp_identity, new Date(c.last_seen_at));
  }

  const open = await many<{ id: string; org_id: string; charge_point_id: string; ocpp_identity: string; display_name: string | null; site_name: string; went_offline_at: Date; alerted: boolean; site_minutes: number | null }>(
    `SELECT o.id, o.org_id, o.charge_point_id, cp.ocpp_identity, cp.display_name, s.name AS site_name,
            o.went_offline_at, o.alerted_at IS NOT NULL AS alerted, s.offline_alert_minutes AS site_minutes
       FROM charge_point_outage o
       JOIN charge_point cp ON cp.id = o.charge_point_id
       JOIN site s ON s.id = cp.site_id
      WHERE o.came_online_at IS NULL`,
  );
  for (const o of open) {
    // The site's own threshold (a remote site may tolerate longer gaps), else the fleet default.
    const thresholdMs = (o.site_minutes ?? config.gateway.offlineAlertMinutes) * 60_000;
    if (registry.isOnline(o.ocpp_identity)) {
      await closeOutage(o.ocpp_identity);
      continue;
    }
    if (o.alerted || Date.now() - new Date(o.went_offline_at).getTime() < thresholdMs) continue;
    // The list above was read at the start of the pass: the charger may have come back since
    // (closeOutage has then already run, and would never resolve an alert raised after it).
    // Claim the alert only while the outage is still open and not yet alerted, and not for a
    // charger that is connected now.
    if (registry.isOnline(o.ocpp_identity)) continue;
    if (!(await claimOutageAlert(o.id))) continue;
    const mins = Math.round((Date.now() - new Date(o.went_offline_at).getTime()) / 60_000);
    bus.emit('alert.raised', {
      orgId: o.org_id,
      kind: 'charge_point.offline',
      severity: 'critical',
      message: `${o.display_name ? `${o.display_name} (${o.ocpp_identity})` : o.ocpp_identity} at ${o.site_name} has been offline for ${mins} minute${mins === 1 ? '' : 's'} (since ${new Date(o.went_offline_at).toISOString()}). Drivers cannot start charging there.`,
      targetType: 'charge_point',
      targetId: o.charge_point_id,
    });
  }
}

export interface AvailabilityRow {
  chargePointId: string;
  ocppIdentity: string;
  displayName: string | null;
  siteId: string;
  siteName: string;
  connectors: number;
  online: boolean;
  uptimePct: number | null;
  outages: number;
  offlineMinutes: number;
  longestOutageMin: number;
  sessions: number;
  energyKwh: number;
  revenueIdr: number;
  utilisationPct: number | null;
}

/**
 * Uptime and utilisation per charger over the last `days`.
 *
 *   uptime       = 1 − (time offline in window) / (time in window since commissioning)
 *   utilisation  = (connector-time in sessions) / (connectors × time in window)
 */
export async function availabilityReport(orgId: string, days: number, siteIds: string[] | null): Promise<{ from: string; to: string; rows: AvailabilityRow[] }> {
  const d = Math.min(Math.max(Math.round(days) || 30, 1), 365);
  const rows = await many<any>(
    `WITH w AS (SELECT now() - make_interval(days => $2::int) AS ws, now() AS we),
     cps AS (
       SELECT cp.id, cp.ocpp_identity, cp.display_name, cp.status, s.id AS site_id, s.name AS site_name,
              GREATEST((SELECT ws FROM w), COALESCE(cp.commissioned_at, cp.created_at)) AS since,
              (SELECT count(*) FROM evse e JOIN connector c ON c.evse_uuid = e.id WHERE e.charge_point_id = cp.id)::int AS connectors
         FROM charge_point cp JOIN site s ON s.id = cp.site_id
        WHERE s.org_id = $1 AND cp.status <> ALL($3::text[])
          AND ($4::uuid[] IS NULL OR s.id = ANY($4::uuid[]))
     )
     SELECT cps.*,
            EXTRACT(EPOCH FROM ((SELECT we FROM w) - cps.since)) AS window_s,
            -- Each interval is clipped to the window and floored at 0: a charger whose clock
            -- ran ahead can report sessions that start after the window ends.
            COALESCE((SELECT sum(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(o.came_online_at, now()), (SELECT we FROM w)) - GREATEST(o.went_offline_at, cps.since)))))
                        FROM charge_point_outage o
                       WHERE o.charge_point_id = cps.id AND COALESCE(o.came_online_at, now()) > cps.since), 0) AS offline_s,
            (SELECT count(*) FROM charge_point_outage o WHERE o.charge_point_id = cps.id AND COALESCE(o.came_online_at, now()) > cps.since)::int AS outages,
            COALESCE((SELECT max(EXTRACT(EPOCH FROM (COALESCE(o.came_online_at, now()) - o.went_offline_at)))
                        FROM charge_point_outage o WHERE o.charge_point_id = cps.id AND COALESCE(o.came_online_at, now()) > cps.since), 0) AS longest_s,
            (SELECT count(*) FROM charging_session cs WHERE cs.charge_point_id = cps.id AND cs.site_id = cps.site_id AND cs.started_at >= cps.since)::int AS sessions,
            COALESCE((SELECT sum(cs.energy_wh) FROM charging_session cs WHERE cs.charge_point_id = cps.id AND cs.site_id = cps.site_id AND cs.started_at >= cps.since), 0) AS energy_wh,
            COALESCE((SELECT sum(d.total_idr) FROM charging_session cs JOIN cdr d ON d.session_id = cs.id WHERE cs.charge_point_id = cps.id AND cs.site_id = cps.site_id AND cs.started_at >= cps.since), 0) AS revenue_idr,
            COALESCE((SELECT sum(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(cs.ended_at, now()), (SELECT we FROM w)) - GREATEST(cs.started_at, cps.since)))))
                        FROM charging_session cs WHERE cs.charge_point_id = cps.id AND cs.site_id = cps.site_id AND COALESCE(cs.ended_at, now()) > cps.since), 0) AS busy_s
       FROM cps
      ORDER BY cps.site_name, cps.ocpp_identity`,
    [orgId, d, ADMINISTRATIVE_STATES, siteIds],
  );
  const pct = (x: number) => Math.round(x * 1000) / 10;
  return {
    from: new Date(Date.now() - d * 86_400_000).toISOString(),
    to: new Date().toISOString(),
    rows: rows.map((r) => {
      const windowS = Math.max(0, Number(r.window_s));
      const offlineS = Math.min(windowS, Math.max(0, Number(r.offline_s)));
      return {
        chargePointId: r.id,
        ocppIdentity: r.ocpp_identity,
        displayName: r.display_name,
        siteId: r.site_id,
        siteName: r.site_name,
        connectors: Number(r.connectors),
        online: registry.isOnline(r.ocpp_identity),
        uptimePct: windowS > 0 ? pct(1 - offlineS / windowS) : null,
        outages: Number(r.outages),
        offlineMinutes: Math.round(offlineS / 60),
        longestOutageMin: Math.round(Number(r.longest_s) / 60),
        sessions: Number(r.sessions),
        energyKwh: Math.round(Number(r.energy_wh) / 10) / 100,
        revenueIdr: Number(r.revenue_idr),
        utilisationPct: windowS > 0 && Number(r.connectors) > 0 ? pct(Math.min(1, Math.max(0, Number(r.busy_s)) / (windowS * Number(r.connectors)))) : null,
      };
    }),
  };
}
