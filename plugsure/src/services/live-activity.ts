import { many, one, query } from '../db/pool.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { countryOfCurrency } from '../domain/country.js';
import { logger } from '../logger.js';
import { sendToDevice, outcomeOf, type ApnsEnv } from './apns.js';
import { apnsCredentialsFor, markApnsRefused, brandForOrg, palette, isNetworkOrg, fcmCredentialsFor, markFcmRefused } from './brand.js';
import { runningCost } from './sessions.js';
import { sendFcm, outcomeOfFcm } from './fcm.js';
import { isCurrency, toMinor, type CurrencyCode } from '../domain/money.js';

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
 *
 * v1.9 (docs/MOBILE-APP-SPEC.md G3): the same pass feeds
 *   - the PlugSure app (network brand): sessions at every operator, not only the brand's own;
 *   - charges on partner networks (driver_roaming_charge), from what the partner operator reports;
 *   - Android: an ongoing notification the app updates from FCM data messages (transport 'fcm'), at the same cadence;
 *   - content version 2 (apps that format costs by `currency`): costs in every currency, `currency` always present.
 *     Version 1 (the installed white-label widgets) gets exactly what it got before.
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
  /**
   * The currency of costIdr / estimateIdr when it is not IDR (minor units of it).
   * The key names are the installed apps' wire contract and stay; IDR sessions send
   * exactly the v1.6 content. TODO(WP2): the widget formats by this currency.
   */
  currency?: string;
}

/**
 * A change in the cost so far worth an update on its own (energy and power have
 * their own thresholds), per currency: Rp 500 / RM 0.10 / S$ 0.10.
 */
export const ESTIMATE_STEP_IDR = 500;
export const estimateStepMinor = (currency: string | null | undefined): number =>
  countryOfCurrency(currency ?? LEGACY_CURRENCY)?.estimateStepMinor ?? ESTIMATE_STEP_IDR;

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
  cdrTotalMinor: number | null;
  /** The running cost (sessions.runningCost), until the charge record exists. */
  estimateIdr?: number | null;
  /** The session's currency (absent = IDR). */
  currency?: string | null;
}

export function contentOf(s: Snapshot, version: 1 | 2 = 1): ContentState {
  const finished = s.sessionState !== 'active';
  // The installed widgets (version 1) format costIdr / estimateIdr as rupiah (brand.ts ContentState.rupiah): a ringgit or
  // Singapore-dollar cost would show as "Rp 1.234" for RM 12.34, so a non-IDR session's Live Activity carries no cost
  // for them (energy, power and progress only). Version 2 formats by `currency`: costs in every currency.
  const money = version === 2 || !s.currency || s.currency === LEGACY_CURRENCY;
  return {
    status: finished ? 'finished' : 'charging',
    energyWh: Math.round(s.energyWh),
    powerW: finished || s.powerW == null ? null : Math.round(s.powerW),
    socPercent: s.socPercent == null ? null : Math.round(s.socPercent),
    progressPct: s.progressPct,
    costIdr: money ? s.cdrTotalMinor : null,
    estimateIdr: !money || s.cdrTotalMinor != null || s.estimateIdr == null ? null : Math.round(s.estimateIdr),
    startedAt: Math.floor(s.startedAt.getTime() / 1000),
    endedAt: s.endedAt ? Math.floor(s.endedAt.getTime() / 1000) : null,
    ...(version === 2 ? { currency: s.currency || LEGACY_CURRENCY } : s.currency && s.currency !== LEGACY_CURRENCY ? { currency: s.currency } : {}),
  };
}

/** Enough of a change to spend an update on. */
function changed(a: ContentState | null, b: ContentState): boolean {
  if (!a) return true;
  return a.status !== b.status || Math.abs(a.energyWh - b.energyWh) >= 50 || Math.abs((a.powerW ?? 0) - (b.powerW ?? 0)) >= 1000
    || a.socPercent !== b.socPercent || a.progressPct !== b.progressPct || a.costIdr !== b.costIdr
    || (a.estimateIdr == null) !== (b.estimateIdr == null) || Math.abs((a.estimateIdr ?? 0) - (b.estimateIdr ?? 0)) >= estimateStepMinor(b.currency);
}

export type Plan = { action: 'none' } | { action: 'update' | 'end'; priority: 5 | 10; content: ContentState };

/** What to send to one activity now (pure; the pass does the sending). */
export function planFor(last: { content: ContentState | null; status: string | null; sentAt: Date | null }, s: Snapshot, now: Date, version: 1 | 2 = 1): Plan {
  const c = contentOf(s, version);
  const since = last.sentAt ? (now.getTime() - last.sentAt.getTime()) / 1000 : Infinity;
  if (c.status === 'finished') {
    const endedFor = s.endedAt ? (now.getTime() - s.endedAt.getTime()) / 1000 : 0;
    if (s.cdrTotalMinor != null || endedFor >= END_WITHOUT_CDR_S) return { action: 'end', priority: 10, content: c };
    return last.status === 'finished' ? { action: 'none' } : { action: 'update', priority: 10, content: c };
  }
  if (last.status !== 'charging') return { action: 'update', priority: 10, content: c };
  if ((changed(last.content, c) && since >= MIN_INTERVAL_S) || since >= HEARTBEAT_S) return { action: 'update', priority: 5, content: c };
  return { action: 'none' };
}

// ─────────────────────────────────────────────── tokens from the app

const HEX = /^[0-9a-f]{32,400}$/;

/** FCM registration tokens (Android). */
const FCM_TOKEN = /^[A-Za-z0-9_:\-]{64,4096}$/;

export interface RegisterOptions {
  /** 'apns' (iOS Live Activity update token, hex) or 'fcm' (the Android app's FCM registration token). */
  transport?: 'apns' | 'fcm';
  /** 2: the app formats costs by `currency` (always 2 on Android). */
  contentVersion?: 1 | 2;
}

/**
 * The app's activity for a charge (or, started by push, a session; or a charge on a partner network) has an update
 * token. A new token for the same activity replaces the old one. An operator's app follows its operator's charges;
 * the PlugSure app (network brand) follows any of this phone's charges.
 */
export async function registerActivity(deviceId: string, brandOrgId: string, refRaw: unknown, tokenRaw: unknown, opts: RegisterOptions = {}): Promise<{ ok: boolean; error?: string; kind?: 'charge' | 'session' | 'roaming' }> {
  const transport = opts.transport ?? 'apns';
  const version = transport === 'fcm' ? 2 : opts.contentVersion === 2 ? 2 : 1;
  const token = transport === 'fcm' ? String(tokenRaw ?? '').trim() : String(tokenRaw ?? '').trim().toLowerCase();
  const ref = String(refRaw ?? '').trim().toLowerCase();
  if (transport === 'fcm' ? !FCM_TOKEN.test(token) : !HEX.test(token)) return { ok: false, error: transport === 'fcm' ? 'Token notifikasi Android tidak valid.' : 'Token Live Activity tidak valid.' };
  if (!(transport === 'fcm' ? await fcmCredentialsFor(brandOrgId) : await apnsCredentialsFor(brandOrgId))) return { ok: false, error: 'Notifikasi belum tersedia di aplikasi ini.' };
  // The PlugSure app: charges at every operator.
  const org = (await isNetworkOrg(brandOrgId)) ? null : brandOrgId;
  // The ref is a charge of this phone, or a session this phone may follow.
  const charge = await one<{ id: string; session_id: string | null }>(`SELECT id, session_id FROM driver_charge WHERE id::text = $1 AND device_id = $2 AND ($3::uuid IS NULL OR org_id = $3)`, [ref, deviceId, org]);
  const session = charge ? null : await one<{ id: string }>(
    `SELECT cs.id FROM charging_session cs JOIN driver_device d ON d.id = $2
      WHERE cs.id::text = $1 AND ($3::uuid IS NULL OR cs.org_id = $3)
        AND (cs.token_id = d.fleet_token_id OR EXISTS (SELECT 1 FROM driver_charge dc WHERE dc.session_id = cs.id AND dc.device_id = $2))`,
    [ref, deviceId, org]);
  // A charge on a partner network, started by this phone's app driver (the brand's eMSP role; any for the PlugSure app).
  const roaming = charge || session ? null : await (await import('../driver/roaming.js')).roamingChargeOf(deviceId, ref);
  if (roaming && org && roaming.org_id !== org) return { ok: false, error: 'Pengisian tidak ditemukan.' };
  if (!charge && !session && !roaming) return { ok: false, error: 'Pengisian tidak ditemukan.' };
  const sessionId = session?.id ?? charge?.session_id ?? null;
  const existing = await one<{ id: string }>(
    `SELECT id FROM live_activity WHERE device_id = $1 AND state = 'active' AND transport = $5 AND (charge_id = $2 OR session_id = $3 OR roaming_charge_id = $4) LIMIT 1`,
    [deviceId, charge?.id ?? null, sessionId, roaming?.id ?? null, transport]);
  if (existing) {
    await query(`UPDATE live_activity SET push_token = $2, content_version = $3 WHERE id = $1`, [existing.id, token, version]);
  } else {
    await query(
      `INSERT INTO live_activity (device_id, brand_org_id, charge_id, session_id, roaming_charge_id, push_token, transport, content_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (push_token) DO NOTHING`,
      [deviceId, brandOrgId, charge?.id ?? null, sessionId, roaming?.id ?? null, token, transport, version]);
  }
  return { ok: true, kind: charge ? 'charge' : session ? 'session' : 'roaming' };
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
  await query(`UPDATE live_activity SET state = 'ended', ended_at = now() WHERE device_id = $1 AND state = 'active' AND (charge_id::text = $2 OR session_id::text = $2 OR roaming_charge_id::text = $2)`, [deviceId, ref]);
}

// ─────────────────────────────────────────────── the pass

async function snapshotOf(sessionId: string): Promise<Snapshot | null> {
  const s = await one<{ state: string; energy_wh: string | null; soc_percent: string | null; prepaid_energy_wh: string | null; started_at: Date; ended_at: Date | null; power: string | null; unit: string | null; total: string | null; currency: string }>(
    `SELECT cs.state, cs.currency, cs.energy_wh, cs.soc_percent, cs.prepaid_energy_wh, cs.started_at, cs.ended_at,
            p.value AS power, p.unit, d.total_minor AS total
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
    cdrTotalMinor: s.total == null ? null : Number(s.total),
    estimateIdr: estimate && !estimate.final ? estimate.totalMinor : null,
    currency: s.currency,
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

type SendResult = { outcome: 'sent' | 'gone' | 'retry' | 'credentials' | 'failed'; env: ApnsEnv | null; status: number | null; error: string };

/** A Live Activity update over APNs. */
async function send(orgId: string, token: string, env: ApnsEnv | null, payload: Record<string, unknown>, priority: 5 | 10): Promise<SendResult | null> {
  const r = await sendApns(orgId, token, env, payload, priority);
  return r ? { outcome: outcomeOf(r), env: r.env, status: r.status, error: `${r.status ?? ''} ${r.reason ?? ''}`.trim() } : null;
}

async function sendApns(orgId: string, token: string, env: ApnsEnv | null, payload: Record<string, unknown>, priority: 5 | 10) {
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
       -- The operator's own app, or the PlugSure app (network brand: every operator's sessions).
       JOIN live_activity_start_token st ON (st.brand_org_id = si.org_id
                                             OR EXISTS (SELECT 1 FROM driver_app_brand nb WHERE nb.org_id = st.brand_org_id AND nb.scope = 'network'))
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
    const payload = liveActivityPayload('start', contentOf(snap, b.scope === 'network' ? 2 : 1), now.getTime(), {
      attributes: { ref: s.charge_id ?? s.session_id, site: s.site, connector: s.connector, appName: b.appName, accentHex: palette(b.accentColor, b.badgeColor).dark.accent },
      alert: lang === 'en' ? { title: 'Charging started', body: s.site } : { title: 'Pengisian dimulai', body: s.site },
    });
    const r = await sendApns(s.brand_org_id, s.token, s.apns_env, payload, 10);
    await query(`UPDATE live_activity_push_start SET status = $3 WHERE device_id = $1 AND session_id = $2`, [s.device_id, s.session_id, r?.status ?? null]);
    if (r && outcomeOf(r) === 'sent') {
      out.started++;
      if (r.env !== s.apns_env) await query(`UPDATE live_activity_start_token SET apns_env = $3 WHERE device_id = $1 AND brand_org_id = $2`, [s.device_id, s.brand_org_id, r.env]);
    } else if (r && outcomeOf(r) === 'gone') {
      await query(`DELETE FROM live_activity_start_token WHERE device_id = $1 AND brand_org_id = $2 AND token = $3`, [s.device_id, s.brand_org_id, s.token]);
    }
  }

  // Updates and ends.
  const active = await many<{ id: string; brand_org_id: string; charge_id: string | null; session_id: string | null; roaming_charge_id: string | null;
    push_token: string; apns_env: ApnsEnv | null; transport: 'apns' | 'fcm'; content_version: number;
    last_content: ContentState | null; last_status: string | null; last_sent_at: Date | null }>(
    `SELECT id, brand_org_id, charge_id, session_id, roaming_charge_id, push_token, apns_env, transport, content_version, last_content, last_status, last_sent_at
       FROM live_activity WHERE state = 'active' AND created_at > $1::timestamptz - interval '24 hours' ORDER BY id LIMIT 500`, [now]);
  for (const a of active) {
    let snap: Snapshot | null = null;
    let title: { site: string; connector: string } | null = null;
    if (a.roaming_charge_id) {
      const r = await roamingSnapshot(a.roaming_charge_id);
      if (!r) continue; // the partner has not reported the session yet
      snap = r.snap; title = r.title;
    } else {
      const sessionId = await sessionFor(a);
      if (!sessionId) continue; // paid, not started yet
      snap = await snapshotOf(sessionId);
      if (snap && a.transport === 'fcm') title = await titleOf(sessionId);
    }
    if (!snap) continue;
    const version = a.content_version === 2 ? 2 : 1;
    const plan = planFor({ content: a.last_content, status: a.last_status, sentAt: a.last_sent_at }, snap, now, version);
    if (plan.action === 'none') continue;
    const r = a.transport === 'fcm'
      ? await sendFcmLive(a.brand_org_id, a.push_token, liveSessionMessage(plan.action, a.charge_id ?? a.roaming_charge_id ?? a.session_id!, a.roaming_charge_id ? 'roaming' : 'direct', plan.content, now.getTime(), title), plan.priority)
      : await send(a.brand_org_id, a.push_token, a.apns_env, liveActivityPayload(plan.action, plan.content, now.getTime()), plan.priority);
    if (!r) continue;
    const o = r.outcome;
    if (o === 'sent') {
      const ended = plan.action === 'end';
      await query(
        `UPDATE live_activity SET last_content = $2, last_status = $3, last_sent_at = $4, sent_count = sent_count + 1, apns_env = COALESCE($5, apns_env), last_error = NULL,
                state = CASE WHEN $6 THEN 'ended' ELSE state END, ended_at = CASE WHEN $6 THEN $4 ELSE ended_at END
          WHERE id = $1`,
        [a.id, JSON.stringify(plan.content), plan.content.status, now, r.env, ended]);
      if (ended) out.ended++; else out.updated++;
    } else if (o === 'gone') {
      // The activity was dismissed on the phone, or the app removed.
      await query(`UPDATE live_activity SET state = 'gone', ended_at = $2, last_error = $3 WHERE id = $1`, [a.id, now, r.error]);
      out.gone++;
    } else {
      await query(`UPDATE live_activity SET last_error = $2 WHERE id = $1`, [a.id, r.error]);
    }
  }
  if (out.started || out.updated || out.ended || out.gone) logger.debug(out, 'live activities');
  return out;
}

/** A partner-network charge as a snapshot (what the partner operator reported; no meter of ours). */
async function roamingSnapshot(chargeId: string): Promise<{ snap: Snapshot; title: { site: string; connector: string } } | null> {
  const r = await (await import('../driver/roaming.js')).roamingLiveSnapshot(chargeId);
  if (!r || !r.startedAt) return null;
  const cur = r.currency && isCurrency(r.currency) ? (r.currency as CurrencyCode) : null;
  const minor = (v: string | null) => (v != null && cur && Number.isFinite(Number(v)) ? toMinor(v, cur) : null);
  return {
    snap: {
      sessionState: r.active ? 'active' : 'completed',
      energyWh: r.kwh * 1000,
      powerW: null, socPercent: null, progressPct: null,
      startedAt: r.startedAt, endedAt: r.endedAt ?? (r.active ? null : new Date()),
      cdrTotalMinor: minor(r.cdrTotal),
      estimateIdr: r.cdrTotal == null ? minor(r.sessionTotal) : null,
      currency: cur,
    },
    title: { site: r.site, connector: r.connector },
  };
}

async function titleOf(sessionId: string): Promise<{ site: string; connector: string } | null> {
  return one<{ site: string; connector: string }>(
    `SELECT si.name AS site, c.current_type || ' ' || round(c.max_power_w / 1000.0) || ' kW' AS connector
       FROM charging_session cs JOIN site si ON si.id = cs.site_id JOIN connector c ON c.id = cs.connector_uuid WHERE cs.id = $1`, [sessionId]);
}

/**
 * The Android live session (FCM data message, docs/MOBILE-APP-SPEC.md §12.3 / §15): the app's messaging service
 * posts or updates one ongoing notification per `ref` — Notification.ProgressStyle on Android 16 (`progress`,
 * `progressMax`, `progressIndeterminate`), a standard progress notification before. Data values are strings (FCM).
 */
export function liveSessionMessage(event: 'update' | 'end', ref: string, path: 'direct' | 'roaming', c: ContentState, now: number,
  title: { site: string; connector: string } | null): Record<string, string> {
  const t = Math.floor(now / 1000);
  const str = (v: unknown) => (v == null ? '' : String(v));
  return {
    type: 'live_session', event, ref, path,
    status: c.status,
    energyWh: str(c.energyWh), powerW: str(c.powerW), socPercent: str(c.socPercent), progressPct: str(c.progressPct),
    costMinor: str(c.costIdr), estimateMinor: str(c.estimateIdr), currency: str(c.currency ?? LEGACY_CURRENCY),
    startedAt: str(c.startedAt), endedAt: str(c.endedAt),
    // Android 16 ProgressStyle: the battery when known, else the prepaid allowance used, else indeterminate.
    progress: str(c.socPercent ?? c.progressPct ?? ''), progressMax: '100',
    progressIndeterminate: c.status === 'charging' && c.socPercent == null && c.progressPct == null ? '1' : '0',
    ongoing: event === 'end' ? '0' : '1',
    ...(event === 'end' ? { dismissAt: str(t + DISMISS_S) } : { staleAt: str(t + STALE_S) }),
    site: title?.site ?? '', connector: title?.connector ?? '',
    contentState: JSON.stringify(c),
  };
}

/** A live session update to an Android app (data-only, high priority on a change of state, normal for progress). */
async function sendFcmLive(orgId: string, token: string, data: Record<string, string>, priority: 5 | 10): Promise<SendResult | null> {
  const creds = await fcmCredentialsFor(orgId);
  if (!creds) return null;
  const r = await sendFcm(creds, { token, data, priority: priority === 10 ? 'high' : 'normal', ttlS: priority === 10 ? 600 : 120, collapseKey: `ls-${data.ref}` });
  const o = outcomeOfFcm(r);
  if (o === 'credentials') await markFcmRefused(orgId, `Google refused the service account while sending a live session update (${r.errorCode}).`, creds);
  return { outcome: o, env: null, status: r.status, error: `${r.status ?? ''} ${r.errorCode ?? ''}`.trim() };
}

/** Counts for the console. */
export async function liveActivityCounts(orgId: string): Promise<{ active: number; pushToStart: number }> {
  const r = await one<{ active: number; starts: number }>(
    `SELECT (SELECT count(*)::int FROM live_activity WHERE brand_org_id = $1 AND state = 'active') AS active,
            (SELECT count(*)::int FROM live_activity_start_token WHERE brand_org_id = $1) AS starts`, [orgId]);
  return { active: r?.active ?? 0, pushToStart: r?.starts ?? 0 };
}
