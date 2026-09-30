import { many, one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { sendToDevice, outcomeOf, type ApnsEnv } from './apns.js';
import { apnsCredentialsFor, markApnsRefused, brandForOrg, palette } from './brand.js';
import { runningCost } from './sessions.js';

/**
 * Live Activities: a charge in progress on the iPhone's lock screen and in the
 * Dynamic Island, in a white-label iOS app (ActivityKit; iOS 16.2+).
 *
 *   - The app starts the activity when a charge starts in it, and gives PlugSure
 *     the activity's APNs update token. On iOS 17.2+ it also gives a push-to-start
 *     token, so PlugSure can start the activity itself when a charge starts
 *     without the app (a fleet card tapped at the charger).
 *   - A pass in the gateway (every few seconds) sends updates: energy, power,
 *     battery, progress — only when something changed, at most every 30 s at
 *     low priority (priority 10 only for a change of state), with a stale date
 *     so the lock screen shows when the figures stop coming. The elapsed time
 *     counts on the phone by itself.
 *   - When the session ends it says "finished", and when the charge record is
 *     rated it ends the activity with the final cost; it stays on the lock
 *     screen for 30 minutes.
 *
 *   - While charging it carries the cost so far (estimateIdr), priced exactly as
 *     the charge record will be; idle fees show rising once the car is full.
 *
 * The content-state keys match ChargingAttributes.ContentState in the app
 * (build kit: ios/LiveActivity/ChargingAttributes.swift); times are Unix seconds.
 */

export interface ContentState {
  status: 'charging' | 'finished';
  energyWh: number;
  powerW: number | null;
  socPercent: number | null;
  progressPct: number | null;
  /** The final cost, once the charge record is rated. */
  costIdr: number | null;
  /** The cost so far (PBJT-TL and PPN included), priced as the charge record will be; null once final. */
  estimateIdr: number | null;
  startedAt: number;
  endedAt: number | null;
}

/** A change in the cost so far worth an update on its own (energy and power have their own thresholds). */
export const ESTIMATE_STEP_IDR = 500;

export interface Attributes {
  ref: string;
  site: string;
  connector: string;
  appName: string;
  accentHex: string;
}

export const MIN_INTERVAL_S = Number(process.env.LIVE_ACTIVITY_MIN_INTERVAL_S ?? 30);
/** Resend unchanged figures this often, so the stale date moves on while charging continues. */
export const HEARTBEAT_S = 150;
/** Shown as stale if no update comes within this. */
export const STALE_S = 180;
/** An ended activity stays on the lock screen this long. */
export const DISMISS_S = 30 * 60;
/** Without a rated charge record this long after the end, end with the energy only. */
export const END_WITHOUT_CDR_S = 5 * 60;

export function liveActivityPayload(
  event: 'start' | 'update' | 'end', state: ContentState, now: number,
  opts: { attributes?: Attributes; alert?: { title: string; body: string } } = {},
): Record<string, unknown> {
  const t = Math.floor(now / 1000);
  return {
    aps: {
      timestamp: t,
      event,
      'content-state': state,
      ...(event === 'end' ? { 'dismissal-date': t + DISMISS_S } : { 'stale-date': t + STALE_S }),
      'relevance-score': state.status === 'charging' ? 100 : 50,
      ...(event === 'start' ? { 'attributes-type': 'ChargingAttributes', attributes: opts.attributes, alert: opts.alert } : {}),
    },
  };
}

export interface Snapshot {
  sessionState: string;
  energyWh: number;
  powerW: number | null;
  socPercent: number | null;
  progressPct: number | null;
  startedAt: Date;
  endedAt: Date | null;
  cdrTotalIdr: number | null;
  /** The running cost (sessions.runningCost), until the charge record exists. */
  estimateIdr?: number | null;
}

export function contentOf(s: Snapshot): ContentState {
  const finished = s.sessionState !== 'active';
  return {
    status: finished ? 'finished' : 'charging',
    energyWh: Math.round(s.energyWh),
    powerW: finished || s.powerW == null ? null : Math.round(s.powerW),
    socPercent: s.socPercent == null ? null : Math.round(s.socPercent),
    progressPct: s.progressPct,
    costIdr: s.cdrTotalIdr,
    estimateIdr: s.cdrTotalIdr != null || s.estimateIdr == null ? null : Math.round(s.estimateIdr),
    startedAt: Math.floor(s.startedAt.getTime() / 1000),
    endedAt: s.endedAt ? Math.floor(s.endedAt.getTime() / 1000) : null,
  };
}

/** Enough of a change to spend an update on. */
function changed(a: ContentState | null, b: ContentState): boolean {
  if (!a) return true;
  return a.status !== b.status || Math.abs(a.energyWh - b.energyWh) >= 50 || Math.abs((a.powerW ?? 0) - (b.powerW ?? 0)) >= 1000
    || a.socPercent !== b.socPercent || a.progressPct !== b.progressPct || a.costIdr !== b.costIdr
    || (a.estimateIdr == null) !== (b.estimateIdr == null) || Math.abs((a.estimateIdr ?? 0) - (b.estimateIdr ?? 0)) >= ESTIMATE_STEP_IDR;
}

export type Plan = { action: 'none' } | { action: 'update' | 'end'; priority: 5 | 10; content: ContentState };

/** What to send to one activity now (pure; the pass does the sending). */
export function planFor(last: { content: ContentState | null; status: string | null; sentAt: Date | null }, s: Snapshot, now: Date): Plan {
  const c = contentOf(s);
  const since = last.sentAt ? (now.getTime() - last.sentAt.getTime()) / 1000 : Infinity;
  if (c.status === 'finished') {
    const endedFor = s.endedAt ? (now.getTime() - s.endedAt.getTime()) / 1000 : 0;
    if (s.cdrTotalIdr != null || endedFor >= END_WITHOUT_CDR_S) return { action: 'end', priority: 10, content: c };
    return last.status === 'finished' ? { action: 'none' } : { action: 'update', priority: 10, content: c };
  }
  if (last.status !== 'charging') return { action: 'update', priority: 10, content: c };
  if ((changed(last.content, c) && since >= MIN_INTERVAL_S) || since >= HEARTBEAT_S) return { action: 'update', priority: 5, content: c };
  return { action: 'none' };
}

// ─────────────────────────────────────────────── tokens from the app

const HEX = /^[0-9a-f]{32,400}$/;

/**
 * The app's activity for a charge (or, started by push, a session) has an update token.
 * A new token for the same activity replaces the old one.
 */
export async function registerActivity(deviceId: string, brandOrgId: string, refRaw: unknown, tokenRaw: unknown): Promise<{ ok: boolean; error?: string }> {
  const token = String(tokenRaw ?? '').trim().toLowerCase();
  const ref = String(refRaw ?? '').trim().toLowerCase();
  if (!HEX.test(token)) return { ok: false, error: 'Token Live Activity tidak valid.' };
  if (!(await apnsCredentialsFor(brandOrgId))) return { ok: false, error: 'Notifikasi belum tersedia di aplikasi ini.' };
  // The ref is a charge of this phone, or a session this phone may follow.
  const charge = await one<{ id: string; session_id: string | null }>(`SELECT id, session_id FROM driver_charge WHERE id::text = $1 AND device_id = $2 AND org_id = $3`, [ref, deviceId, brandOrgId]);
  const session = charge ? null : await one<{ id: string }>(
    `SELECT cs.id FROM charging_session cs JOIN driver_device d ON d.id = $2
      WHERE cs.id::text = $1 AND cs.org_id = $3
        AND (cs.token_id = d.fleet_token_id OR EXISTS (SELECT 1 FROM driver_charge dc WHERE dc.session_id = cs.id AND dc.device_id = $2))`,
    [ref, deviceId, brandOrgId]);
  if (!charge && !session) return { ok: false, error: 'Pengisian tidak ditemukan.' };
  const existing = await one<{ id: string }>(
    `SELECT id FROM live_activity WHERE device_id = $1 AND state = 'active' AND (charge_id = $2 OR session_id = $3) LIMIT 1`,
    [deviceId, charge?.id ?? null, session?.id ?? charge?.session_id ?? null]);
  if (existing) {
    await query(`UPDATE live_activity SET push_token = $2 WHERE id = $1`, [existing.id, token]);
  } else {
    await query(
      `INSERT INTO live_activity (device_id, brand_org_id, charge_id, session_id, push_token) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (push_token) DO NOTHING`,
      [deviceId, brandOrgId, charge?.id ?? null, session?.id ?? charge?.session_id ?? null, token]);
  }
  return { ok: true };
}

export async function registerStartToken(deviceId: string, brandOrgId: string, tokenRaw: unknown): Promise<{ ok: boolean; error?: string }> {
  const token = String(tokenRaw ?? '').trim().toLowerCase();
  if (!HEX.test(token)) return { ok: false, error: 'Token Live Activity tidak valid.' };
  if (!(await apnsCredentialsFor(brandOrgId))) return { ok: false, error: 'Notifikasi belum tersedia di aplikasi ini.' };
  await query(
    `INSERT INTO live_activity_start_token (device_id, brand_org_id, token) VALUES ($1,$2,$3)
     ON CONFLICT (device_id, brand_org_id) DO UPDATE SET token = EXCLUDED.token, apns_env = CASE WHEN live_activity_start_token.token = EXCLUDED.token THEN live_activity_start_token.apns_env END, updated_at = now()`,
    [deviceId, brandOrgId, token]);
  return { ok: true };
}

/** The driver closed the activity on the phone: stop sending to it. */
export async function endedOnPhone(deviceId: string, refRaw: unknown): Promise<void> {
  const ref = String(refRaw ?? '').trim().toLowerCase();
  await query(`UPDATE live_activity SET state = 'ended', ended_at = now() WHERE device_id = $1 AND state = 'active' AND (charge_id::text = $2 OR session_id::text = $2)`, [deviceId, ref]);
}

// ─────────────────────────────────────────────── the pass

async function snapshotOf(sessionId: string): Promise<Snapshot | null> {
  const s = await one<{ state: string; energy_wh: string | null; soc_percent: string | null; prepaid_energy_wh: string | null; started_at: Date; ended_at: Date | null; power: string | null; unit: string | null; total: string | null }>(
    `SELECT cs.state, cs.energy_wh, cs.soc_percent, cs.prepaid_energy_wh, cs.started_at, cs.ended_at,
            p.value AS power, p.unit, d.total_idr AS total
       FROM charging_session cs
       LEFT JOIN LATERAL (SELECT value, unit FROM meter_value WHERE session_id = cs.id AND measurand = 'Power.Active.Import' ORDER BY ts DESC LIMIT 1) p ON true
       LEFT JOIN cdr d ON d.session_id = cs.id
      WHERE cs.id = $1`,
    [sessionId]);
  if (!s) return null;
  const energy = Number(s.energy_wh ?? 0);
  // The cost so far, until the charge record exists. A pricing problem never holds up the update.
  const estimate = s.total == null
    ? await runningCost(sessionId).catch((e) => { logger.debug({ sessionId, err: (e as Error).message }, 'running cost unavailable'); return null; })
    : null;
  const allowance = Number(s.prepaid_energy_wh ?? 0);
  return {
    sessionState: s.state,
    energyWh: energy,
    powerW: s.power == null ? null : Number(s.power) * (/^kw$/i.test(s.unit ?? '') ? 1000 : 1),
    socPercent: s.soc_percent == null ? null : Number(s.soc_percent),
    progressPct: allowance > 0 ? Math.min(100, Math.round((energy / allowance) * 100)) : null,
    startedAt: new Date(s.started_at),
    endedAt: s.ended_at ? new Date(s.ended_at) : null,
    cdrTotalIdr: s.total == null ? null : Number(s.total),
    estimateIdr: estimate && !estimate.final ? estimate.totalIdr : null,
  };
}

/** The session behind an app-started activity (the charge's, found as liveStatus finds it). */
async function sessionFor(a: { id: string; charge_id: string | null; session_id: string | null }): Promise<string | null> {
  if (a.session_id) return a.session_id;
  const r = await one<{ id: string }>(
    `SELECT COALESCE(dc.session_id, (SELECT cs.id FROM charging_session cs WHERE cs.connector_uuid = dc.connector_uuid AND cs.token_id = dc.token_id
                                       AND cs.started_at >= dc.created_at - interval '10 minutes' ORDER BY cs.started_at DESC LIMIT 1)) AS id
       FROM driver_charge dc WHERE dc.id = $1`, [a.charge_id]);
  if (r?.id) await query(`UPDATE live_activity SET session_id = $2 WHERE id = $1`, [a.id, r.id]);
  return r?.id ?? null;
}

async function send(orgId: string, token: string, env: ApnsEnv | null, payload: Record<string, unknown>, priority: 5 | 10) {
  const creds = await apnsCredentialsFor(orgId);
  if (!creds) return null;
  const go = (c: typeof creds) => sendToDevice(token, env, c, { title: '', body: '', liveActivity: payload, priority, ttlS: priority === 10 ? 600 : 120 });
  let r = await go(creds);
  if (outcomeOf(r) === 'credentials') {
    // Marked only if these are still the brand's credentials; the cache is dropped either way.
    await markApnsRefused(orgId, `Apple refused the key while sending a Live Activity update (${r.reason}).`, creds);
    // The operator replaced the key within the cache window: send again at once with the new one.
    const fresh = await apnsCredentialsFor(orgId);
    if (fresh && (fresh.keyId !== creds.keyId || fresh.teamId !== creds.teamId)) r = await go(fresh);
  }
  return r;
}

/** One pass: push-to-start for new charges, then updates and ends. Returns what was sent. */
export async function liveActivityPass(now = new Date()): Promise<{ started: number; updated: number; ended: number; gone: number }> {
  const out = { started: 0, updated: 0, ended: 0, gone: 0 };

  // Push-to-start: a charge under way for an iPhone with the brand's app and no activity for it yet.
  // 20 s' grace: the app, if open, starts its own and registers it first.
  const starts = await many<{ session_id: string; device_id: string; brand_org_id: string; token: string; apns_env: ApnsEnv | null; charge_id: string | null; site: string; connector: string }>(
    `SELECT cs.id AS session_id, st.device_id, st.brand_org_id, st.token, st.apns_env, dc.id AS charge_id, si.name AS site,
            c.current_type || ' ' || round(c.max_power_w / 1000.0) || ' kW' AS connector
       FROM charging_session cs
       JOIN site si ON si.id = cs.site_id
       JOIN connector c ON c.id = cs.connector_uuid
       JOIN live_activity_start_token st ON st.brand_org_id = si.org_id
       JOIN driver_device d ON d.id = st.device_id
       LEFT JOIN driver_charge dc ON dc.device_id = st.device_id AND dc.connector_uuid = cs.connector_uuid AND dc.token_id = cs.token_id
                                  AND dc.created_at >= cs.started_at - interval '30 minutes'
      WHERE cs.state = 'active' AND cs.started_at < $1::timestamptz - interval '20 seconds' AND cs.started_at > $1::timestamptz - interval '12 hours'
        AND (dc.id IS NOT NULL OR d.fleet_token_id = cs.token_id)
        AND NOT EXISTS (SELECT 1 FROM live_activity la WHERE la.device_id = st.device_id AND (la.session_id = cs.id OR la.charge_id = dc.id))
        AND NOT EXISTS (SELECT 1 FROM live_activity_push_start ps WHERE ps.device_id = st.device_id AND ps.session_id = cs.id)
      LIMIT 50`,
    [now]);
  for (const s of starts) {
    const b = await brandForOrg(s.brand_org_id).catch(() => null);
    const snap = await snapshotOf(s.session_id);
    if (!b || !snap) continue;
    // Claim first: never two starts for the same phone and session, even across passes.
    const claimed = await one(`INSERT INTO live_activity_push_start (device_id, session_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1`, [s.device_id, s.session_id]);
    if (!claimed) continue;
    const lang = (await one<{ lang: string }>(`SELECT lang FROM push_subscription WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1`, [s.device_id]))?.lang ?? 'id';
    const payload = liveActivityPayload('start', contentOf(snap), now.getTime(), {
      attributes: { ref: s.charge_id ?? s.session_id, site: s.site, connector: s.connector, appName: b.appName, accentHex: palette(b.accentColor, b.badgeColor).dark.accent },
      alert: lang === 'en' ? { title: 'Charging started', body: s.site } : { title: 'Pengisian dimulai', body: s.site },
    });
    const r = await send(s.brand_org_id, s.token, s.apns_env, payload, 10);
    await query(`UPDATE live_activity_push_start SET status = $3 WHERE device_id = $1 AND session_id = $2`, [s.device_id, s.session_id, r?.status ?? null]);
    if (r && outcomeOf(r) === 'sent') {
      out.started++;
      if (r.env !== s.apns_env) await query(`UPDATE live_activity_start_token SET apns_env = $3 WHERE device_id = $1 AND brand_org_id = $2`, [s.device_id, s.brand_org_id, r.env]);
    } else if (r && outcomeOf(r) === 'gone') {
      await query(`DELETE FROM live_activity_start_token WHERE device_id = $1 AND brand_org_id = $2 AND token = $3`, [s.device_id, s.brand_org_id, s.token]);
    }
  }

  // Updates and ends.
  const active = await many<{ id: string; brand_org_id: string; charge_id: string | null; session_id: string | null; push_token: string; apns_env: ApnsEnv | null;
    last_content: ContentState | null; last_status: string | null; last_sent_at: Date | null }>(
    `SELECT id, brand_org_id, charge_id, session_id, push_token, apns_env, last_content, last_status, last_sent_at
       FROM live_activity WHERE state = 'active' AND created_at > $1::timestamptz - interval '24 hours' ORDER BY id LIMIT 500`, [now]);
  for (const a of active) {
    const sessionId = await sessionFor(a);
    if (!sessionId) continue; // paid, not started yet
    const snap = await snapshotOf(sessionId);
    if (!snap) continue;
    const plan = planFor({ content: a.last_content, status: a.last_status, sentAt: a.last_sent_at }, snap, now);
    if (plan.action === 'none') continue;
    const r = await send(a.brand_org_id, a.push_token, a.apns_env, liveActivityPayload(plan.action, plan.content, now.getTime()), plan.priority);
    if (!r) continue;
    const o = outcomeOf(r);
    if (o === 'sent') {
      const ended = plan.action === 'end';
      await query(
        `UPDATE live_activity SET last_content = $2, last_status = $3, last_sent_at = $4, sent_count = sent_count + 1, apns_env = $5, last_error = NULL,
                state = CASE WHEN $6 THEN 'ended' ELSE state END, ended_at = CASE WHEN $6 THEN $4 ELSE ended_at END
          WHERE id = $1`,
        [a.id, JSON.stringify(plan.content), plan.content.status, now, r.env, ended]);
      if (ended) out.ended++; else out.updated++;
    } else if (o === 'gone') {
      // The activity was dismissed on the phone, or the app removed.
      await query(`UPDATE live_activity SET state = 'gone', ended_at = $2, last_error = $3 WHERE id = $1`, [a.id, now, `${r.status} ${r.reason ?? ''}`.trim()]);
      out.gone++;
    } else {
      await query(`UPDATE live_activity SET last_error = $2 WHERE id = $1`, [a.id, `${r.status ?? ''} ${r.reason ?? ''}`.trim()]);
    }
  }
  if (out.started || out.updated || out.ended || out.gone) logger.debug(out, 'live activities');
  return out;
}

/** Counts for the console. */
export async function liveActivityCounts(orgId: string): Promise<{ active: number; pushToStart: number }> {
  const r = await one<{ active: number; starts: number }>(
    `SELECT (SELECT count(*)::int FROM live_activity WHERE brand_org_id = $1 AND state = 'active') AS active,
            (SELECT count(*)::int FROM live_activity_start_token WHERE brand_org_id = $1) AS starts`, [orgId]);
  return { active: r?.active ?? 0, pushToStart: r?.starts ?? 0 };
}
