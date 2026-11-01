import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import * as maintenance from './maintenance.js';

/**
 * Charger health and failure prediction (v1.42.0).
 *
 * Over the last WINDOW_DAYS, per charger, from what PlugSure already records:
 *   outages        charge_point_outage: how many, and the hours offline
 *   faults         StatusNotification frames reporting an error (OCPP 1.6 errorCode other than NoError, or a Faulted
 *                  status in 1.6 and 2.0.1), with their codes
 *   reboots        BootNotification frames
 *   failed starts  sessions that failed, or ended within three minutes having delivered under 50 Wh
 *   now            a connector Faulted at this moment
 *
 * The score is 100 less capped penalties for each (scoreOf). The risk:
 *   at risk   the score under 60; a connector faulted now; one fault code three times or more in the last 7 days; or
 *             faults speeding up (the last 7 days at twice the earlier daily rate, with at least three)
 *   watch     the score under 80, a fault in the last 7 days, or an outage in the window
 *   ok        otherwise
 * The reasons say which, in words a technician can act on; the prediction is that rule, not a model, so it can be
 * checked. A daily run keeps each charger's day (the trend) and raises charger.health_at_risk (resolved when it is
 * back to watch or ok). A corrective work order can be opened from the charger, carrying the reasons.
 */

export class HealthError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const WINDOW_DAYS = 30;
export const RECENT_DAYS = 7;
export const ALERT = 'charger.health_at_risk';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const r1 = (n: number) => Math.round(n * 10) / 10;

export interface Parts {
  outages: number; offlineHours: number; faults: number; recentFaults: number; codes: Record<string, number>; recentCodes: Record<string, number>;
  reboots: number; sessions: number; failedStarts: number; faultedNow: boolean; errorNow: string | null;
}
export interface Health { score: number; risk: 'ok' | 'watch' | 'at_risk'; reasons: string[]; penalties: Record<string, number> }

/** The score and the risk, from a charger's parts (pure: the rules above). */
export function scoreOf(p: Parts): Health {
  const failedRate = p.sessions ? p.failedStarts / p.sessions : 0;
  const penalties = {
    outages: Math.min(25, p.outages * 4 + Math.floor(p.offlineHours)),
    faults: Math.min(30, p.faults * 3),
    reboots: Math.min(15, p.reboots * 3),
    failedStarts: p.sessions >= 5 ? Math.min(20, Math.round(failedRate * 50)) : 0,
    faultedNow: p.faultedNow ? 15 : 0,
  };
  const score = Math.max(0, 100 - Object.values(penalties).reduce((a, b) => a + b, 0));
  const reasons: string[] = [];
  let atRisk = score < 60;
  if (p.faultedNow) { atRisk = true; reasons.push(`A connector is faulted now${p.errorNow ? ` (${p.errorNow})` : ''}.`); }
  for (const [code, n] of Object.entries(p.recentCodes).sort((a, b) => b[1] - a[1])) {
    if (n >= 3) { atRisk = true; reasons.push(`${code} ${n} times in the last ${RECENT_DAYS} days: likely to fail again.`); }
  }
  const earlierDays = WINDOW_DAYS - RECENT_DAYS;
  const earlierRate = (p.faults - p.recentFaults) / earlierDays, recentRate = p.recentFaults / RECENT_DAYS;
  if (p.recentFaults >= 3 && recentRate >= 2 * earlierRate) { atRisk = true; reasons.push(`Faults are speeding up: ${p.recentFaults} in the last ${RECENT_DAYS} days against ${p.faults - p.recentFaults} in the ${earlierDays} before.`); }
  if (p.outages) reasons.push(`${p.outages} outage${p.outages === 1 ? '' : 's'}, ${r1(p.offlineHours)} h offline in ${WINDOW_DAYS} days.`);
  if (p.reboots >= 3) reasons.push(`${p.reboots} reboots in ${WINDOW_DAYS} days.`);
  if (penalties.failedStarts >= 5) reasons.push(`${p.failedStarts} of ${p.sessions} sessions failed to start or stopped at once.`);
  if (score < 60 && !reasons.length) reasons.push('Several small problems add up.');
  const risk = atRisk ? 'at_risk' : score < 80 || p.recentFaults > 0 || p.outages > 0 ? 'watch' : 'ok';
  return { score, risk, reasons, penalties };
}

const FAULT_SQL = `(f.payload->>'errorCode' IS NOT NULL AND f.payload->>'errorCode' <> 'NoError')
                   OR f.payload->>'status' = 'Faulted' OR f.payload->>'connectorStatus' = 'Faulted'`;

/** Each charger's parts (one organisation, or one charger), from the records. */
export async function partsFor(orgId: string, chargePointId: string | null = null, now = new Date()): Promise<Array<{ id: string; identity: string; name: string | null; siteId: string; siteName: string; parts: Parts }>> {
  const cps = await outsideRequestScope(() => many<any>(
    `SELECT cp.id, cp.ocpp_identity, cp.display_name, s.id AS site_id, s.name AS site_name FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE s.org_id = $1 AND cp.decommissioned_at IS NULL AND s.archived_at IS NULL AND ($2::uuid IS NULL OR cp.id = $2) ORDER BY s.name, cp.ocpp_identity`,
    [orgId, chargePointId]));
  if (!cps.length) return [];
  const ids = cps.map((c) => c.id), idents = cps.map((c) => c.ocpp_identity);
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000), recent = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
  const [outages, frames, sessions, now_] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT charge_point_id, count(*)::int AS n,
              sum(EXTRACT(EPOCH FROM (LEAST(COALESCE(came_online_at, $3), $3) - GREATEST(went_offline_at, $2)))) / 3600.0 AS hours
         FROM charge_point_outage WHERE charge_point_id = ANY($1::uuid[]) AND COALESCE(came_online_at, $3) > $2 GROUP BY 1`, [ids, since, now])),
    outsideRequestScope(() => many<any>(
      `SELECT f.ocpp_identity, f.action, f.ts >= $3 AS recent, COALESCE(NULLIF(f.payload->>'errorCode', 'NoError'), f.payload->>'vendorErrorCode', 'Faulted') AS code
         FROM ocpp_frame f WHERE f.ocpp_identity = ANY($1::text[]) AND f.ts >= $2 AND f.ts <= $4 AND f.direction = 'in' AND f.message_type = 2
          AND (f.action = 'BootNotification' OR (f.action = 'StatusNotification' AND (${FAULT_SQL})))`, [idents, since, recent, now])),
    outsideRequestScope(() => many<any>(
      `SELECT charge_point_id, count(*)::int AS n,
              count(*) FILTER (WHERE state = 'failed' OR (state = 'ended' AND COALESCE(energy_wh, 0) < 50 AND COALESCE(duration_s, 0) < 180))::int AS failed
         FROM charging_session WHERE charge_point_id = ANY($1::uuid[]) AND created_at >= $2 AND created_at <= $3 GROUP BY 1`, [ids, since, now])),
    outsideRequestScope(() => many<any>(
      `SELECT e.charge_point_id, bool_or(c.status = 'Faulted') AS faulted, max(c.error_code) FILTER (WHERE c.status = 'Faulted' AND c.error_code <> 'NoError') AS err
         FROM connector c JOIN evse e ON e.id = c.evse_uuid WHERE e.charge_point_id = ANY($1::uuid[]) GROUP BY 1`, [ids])),
  ]);
  return cps.map((c) => {
    const o = outages.find((x) => x.charge_point_id === c.id), s = sessions.find((x) => x.charge_point_id === c.id), n = now_.find((x) => x.charge_point_id === c.id);
    const fr = frames.filter((f) => f.ocpp_identity === c.ocpp_identity);
    const faults = fr.filter((f) => f.action === 'StatusNotification');
    const tally = (xs: any[]) => xs.reduce((acc: Record<string, number>, f) => { acc[f.code] = (acc[f.code] ?? 0) + 1; return acc; }, {});
    return {
      id: c.id, identity: c.ocpp_identity, name: c.display_name ?? null, siteId: c.site_id, siteName: c.site_name,
      parts: {
        outages: o?.n ?? 0, offlineHours: r1(Math.max(0, Number(o?.hours ?? 0))), faults: faults.length, recentFaults: faults.filter((f) => f.recent).length,
        codes: tally(faults), recentCodes: tally(faults.filter((f) => f.recent)), reboots: fr.filter((f) => f.action === 'BootNotification').length,
        sessions: s?.n ?? 0, failedStarts: s?.failed ?? 0, faultedNow: !!n?.faulted, errorNow: n?.err ?? null,
      },
    };
  });
}

/** Every charger, worst first, with its trend (the score 7 and 30 days ago) and its open work orders. */
export async function list(orgId: string, q: { risk?: unknown; siteId?: unknown } = {}) {
  const rows = (await partsFor(orgId)).map((c) => ({ ...c, ...scoreOf(c.parts) }));
  const ids = rows.map((r) => r.id);
  const [past, orders] = ids.length ? await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT charge_point_id, day::text AS day, score FROM charger_health WHERE org_id = $1 AND charge_point_id = ANY($2::uuid[]) AND day >= $3::date - 31`, [orgId, ids, today()])),
    outsideRequestScope(() => many<any>(`SELECT charge_point_id, id, number, title, status FROM work_order WHERE org_id = $1 AND charge_point_id = ANY($2::uuid[]) AND status IN ('open', 'in_progress') ORDER BY id`, [orgId, ids])),
  ]) : [[], []];
  const scoreOn = (id: string, daysAgo: number) => {
    const d = new Date(Date.parse(`${today()}T00:00:00Z`) - daysAgo * 86_400_000).toISOString().slice(0, 10);
    return past.find((p) => p.charge_point_id === id && p.day === d)?.score ?? null;
  };
  const RANK = { at_risk: 0, watch: 1, ok: 2 } as const;
  const out = rows
    .filter((r) => (!q.risk || r.risk === q.risk) && (!q.siteId || r.siteId === q.siteId))
    .map((r) => ({ ...r, trend: { d7: scoreOn(r.id, 7), d30: scoreOn(r.id, 30) }, workOrders: orders.filter((w) => w.charge_point_id === r.id).map((w) => ({ id: String(w.id), number: w.number, title: w.title, status: w.status })) }))
    .sort((a, b) => RANK[a.risk] - RANK[b.risk] || a.score - b.score);
  const count = (k: keyof typeof RANK) => rows.filter((r) => r.risk === k).length;
  return {
    windowDays: WINDOW_DAYS, recentDays: RECENT_DAYS, chargers: out,
    summary: { chargers: rows.length, atRisk: count('at_risk'), watch: count('watch'), ok: count('ok'), averageScore: rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : null },
  };
}

/** One charger: today's parts and the daily history (up to 90 days). */
export async function detail(orgId: string, chargePointId: string) {
  if (!UUID_RE.test(chargePointId)) throw new HealthError(404, 'No such charge point.');
  const [c] = await partsFor(orgId, chargePointId);
  if (!c) throw new HealthError(404, 'No such charge point.');
  const history = await outsideRequestScope(() => many<any>(`SELECT day::text AS day, score, risk FROM charger_health WHERE org_id = $1 AND charge_point_id = $2 ORDER BY day DESC LIMIT 90`, [orgId, chargePointId]));
  return { ...c, ...scoreOf(c.parts), history: history.reverse() };
}

/** Open a corrective work order for the charger, carrying its health reasons. */
export async function openWorkOrder(orgId: string, chargePointId: string, userId: string | null) {
  const d = await detail(orgId, chargePointId);
  const label = d.name ?? d.identity;
  return maintenance.save(orgId, null, {
    kind: 'corrective', chargePointId, title: `Health ${d.score}/100: ${label}`.slice(0, 160),
    description: [`Opened from Charger health (${d.risk.replace('_', ' ')}).`, ...d.reasons].join('\n').slice(0, 2000),
  }, userId);
}

/** One organisation's day: keep each charger's score, raise or resolve charger.health_at_risk. */
export async function sweepOrg(orgId: string, now = new Date()): Promise<{ chargers: number; alerts: number }> {
  let chargers = 0, alerts = 0;
  const day = today(now);
  const o = { org_id: orgId };
  for (const c of await partsFor(o.org_id, null, now)) {
        const h = scoreOf(c.parts);
        await outsideRequestScope(() => query(
          `INSERT INTO charger_health (org_id, charge_point_id, day, score, risk, parts, reasons) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (charge_point_id, day) DO UPDATE SET score = EXCLUDED.score, risk = EXCLUDED.risk, parts = EXCLUDED.parts, reasons = EXCLUDED.reasons, computed_at = now()`,
          [o.org_id, c.id, day, h.score, h.risk, JSON.stringify(c.parts), h.reasons]));
        chargers++;
        if (h.risk === 'at_risk') {
          await outsideRequestScope(() => persistAlert({ orgId: o.org_id, kind: ALERT, severity: h.score < 40 || c.parts.faultedNow ? 'critical' : 'warning', targetType: 'charge_point', targetId: c.id,
            message: `${c.name ?? c.identity} (${c.siteName}): health ${h.score}/100. ${h.reasons.slice(0, 2).join(' ')} Maintenance → Charger health.` }));
          alerts++;
        } else await outsideRequestScope(() => resolveAlertsFor(o.org_id, ALERT, 'charge_point', c.id)).catch(() => 0);
  }
  return { chargers, alerts };
}

/** Daily, every organisation with chargers. */
export async function sweep(now = new Date()): Promise<{ orgs: number; chargers: number; alerts: number }> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(
    `SELECT DISTINCT s.org_id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.decommissioned_at IS NULL AND s.archived_at IS NULL`));
  let chargers = 0, alerts = 0;
  for (const o of orgs) {
    try { const r = await sweepOrg(o.org_id, now); chargers += r.chargers; alerts += r.alerts; }
    catch (e) { logger.warn({ orgId: o.org_id, err: (e as Error).message }, 'charger health sweep failed for an organisation'); }
  }
  return { orgs: orgs.length, chargers, alerts };
}
