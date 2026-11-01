import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { guardedFetch } from './net-guard.js';
import { seal, unseal } from './secrets.js';
import { persistAlert } from './alerts.js';

/**
 * Grid demand response (v1.43.0): the grid operator or an aggregator asks the operator's sites to cut, or cap, the
 * power they draw for a window; the load manager does it, and what it delivered is measured for the incentive claim.
 *
 * Programmes (dr_program), each covering some of the operator's sites:
 *   webhook   the grid operator or aggregator POSTs events to PlugSure with the programme's key
 *             (POST /v1/dr/programs/{id}/events, Authorization: Bearer pdr_…)
 *   openadr3  PlugSure polls an OpenADR 3 server (VTN) every few minutes for the programme's events, with OAuth 2
 *             client credentials (outbound, through net-guard: https, public addresses only, no redirects)
 *
 * An event (dr_event): a window, its sites, and either a grid limit in kW (the sites together, split by their usual
 * budget) or a reduction in % of what the load manager would otherwise allow. Several at once: the strictest wins.
 * The operator can opt a site's event out (recorded, with who); a cancelled event stops at once.
 *
 * What is measured (dr_event_site), by the load manager on every pass during the event: the power the chargers would
 * have been given without the event (the baseline: what they asked for, within the usual budget) and what they were
 * given, integrated over time. The reduction is baseline − actual, in kWh; the incentive is that at the programme's
 * rate. It is the load manager's own account, not a utility meter: the report says so.
 */

export class DrError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EVENT_MS = 24 * 3_600_000;
const MAX_SAMPLE_GAP_S = 120;
export const DR_ALERT = 'grid.demand_response';

export interface Program {
  id: string; name: string; kind: 'webhook' | 'openadr3'; enabled: boolean; siteIds: string[]; tokenHint: string | null;
  vtnUrl: string | null; programRef: string | null; clientId: string | null; hasClientSecret: boolean; tokenUrl: string | null;
  incentiveMinorPerKwh: number | null; currency: string; lastPollAt: string | null; lastError: string | null;
}
const programOf = (r: any): Program => ({
  id: String(r.id), name: r.name, kind: r.kind, enabled: r.enabled, siteIds: r.site_ids ?? [], tokenHint: r.token_hint ?? null,
  vtnUrl: r.vtn_url ?? null, programRef: r.program_ref ?? null, clientId: r.client_id ?? null, hasClientSecret: !!r.client_secret, tokenUrl: r.token_url ?? null,
  incentiveMinorPerKwh: r.incentive_minor_per_kwh == null ? null : Number(r.incentive_minor_per_kwh), currency: r.currency,
  lastPollAt: r.last_poll_at ? new Date(r.last_poll_at).toISOString() : null, lastError: r.last_error ?? null,
});

// ------------------------------------------------------------------ pure

export interface ActiveLimit { eventIds: string[]; limitW: number | null; reducePct: number | null }

/**
 * The cap an event puts on a site's grid part this pass. limitW: the site's share of the event's kW limit; reducePct:
 * the strictest reduction. Null when no event is on.
 */
export function capW(usualW: number, a: ActiveLimit | null): number {
  if (!a) return usualW;
  let w = usualW;
  if (a.limitW != null) w = Math.min(w, a.limitW);
  if (a.reducePct != null) w = Math.min(w, Math.round(usualW * (1 - a.reducePct / 100)));
  return Math.max(0, w);
}

/** Wh over a pass of `seconds` at `w`. */
export const whOver = (w: number, seconds: number) => (w * Math.max(0, Math.min(seconds, MAX_SAMPLE_GAP_S))) / 3600;

/** An ISO 8601 duration (PT2H, PT90M, P1DT2H…) in milliseconds, or null. */
export function durationMs(d: unknown): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(d ?? ''));
  if (!m || String(d) === 'P' || String(d) === 'PT') return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000 + Number(m[4] ?? 0) * 1000;
}

/**
 * An OpenADR 3 event as PlugSure keeps it: its window and what it asks. IMPORT_CAPACITY_LIMIT (kW) is a limit;
 * SIMPLE levels 1/2/3 are 30/60/100 % reductions (0 = no event). Anything else is not something chargers can act on.
 */
export function fromOpenAdr(ev: any): { extId: string; startsAt: Date; endsAt: Date; limitKw: number | null; reducePct: number | null; cancelled: boolean } | null {
  const extId = String(ev?.id ?? '').slice(0, 200);
  const ip = ev?.intervalPeriod ?? ev?.intervals?.[0]?.intervalPeriod;
  const start = Date.parse(String(ip?.start ?? ''));
  const dur = durationMs(ip?.duration);
  if (!extId || !Number.isFinite(start) || !dur) return null;
  const payloads: any[] = (ev?.intervals ?? []).flatMap((i: any) => i?.payloads ?? []);
  const limit = payloads.find((p) => p?.type === 'IMPORT_CAPACITY_LIMIT');
  const simple = payloads.find((p) => p?.type === 'SIMPLE');
  const limitKw = limit && Number.isFinite(Number(limit.values?.[0])) ? Math.max(0, Number(limit.values[0])) : null;
  const level = simple ? Number(simple.values?.[0]) : NaN;
  const reducePct = Number.isFinite(level) && level > 0 ? ({ 1: 30, 2: 60, 3: 100 } as Record<number, number>)[Math.min(3, Math.round(level))] ?? null : null;
  const cancelled = /cancel/i.test(String(ev?.eventName ?? '')) || ev?.cancelled === true || (simple && level === 0 && limitKw == null);
  if (limitKw == null && reducePct == null && !cancelled) return null;
  return { extId, startsAt: new Date(start), endsAt: new Date(start + dur), limitKw, reducePct, cancelled: !!cancelled };
}

// ------------------------------------------------------------------ programmes

export async function programs(orgId: string): Promise<Program[]> {
  const rows = await outsideRequestScope(() => many<any>(`SELECT * FROM dr_program WHERE org_id = $1 AND archived_at IS NULL ORDER BY id`, [orgId]));
  return rows.map(programOf);
}

async function programRow(orgId: string, id: string) {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM dr_program WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId]));
  if (!r) throw new DrError(404, 'No such programme.');
  return r;
}

export async function saveProgram(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null): Promise<Program | { id: string; archived: true }> {
  const cur = id ? await programRow(orgId, id) : null;
  if (cur && b.archive === true) {
    await outsideRequestScope(() => query(`UPDATE dr_program SET archived_at = now(), enabled = false WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const c = cur ? programOf(cur) : null;
  const pick = <T>(k: string, d: T): T => (b[k] === undefined ? d : (b[k] as T));
  const name = String(pick('name', c?.name ?? '')).trim().slice(0, 120);
  if (name.length < 2) throw new DrError(422, 'name is 2 to 120 characters.');
  const kind = String(pick('kind', c?.kind ?? 'webhook'));
  if (kind !== 'webhook' && kind !== 'openadr3') throw new DrError(422, 'kind is webhook or openadr3.');
  if (cur && kind !== cur.kind) throw new DrError(422, 'A programme\'s kind cannot change: add a new one.');
  const rawSites = pick<unknown>('siteIds', c?.siteIds ?? []);
  const siteIds = [...new Set((Array.isArray(rawSites) ? rawSites : []).map(String))];
  if (!siteIds.length || siteIds.some((s) => !UUID_RE.test(s))) throw new DrError(422, 'siteIds: at least one of your sites.');
  const found = await outsideRequestScope(() => many<{ id: string }>(`SELECT id FROM site WHERE id = ANY($1::uuid[]) AND org_id = $2 AND archived_at IS NULL`, [siteIds, orgId]));
  if (found.length !== siteIds.length) throw new DrError(422, 'siteIds: a site is not one of yours.');
  const rateRaw = pick<unknown>('incentiveMinorPerKwh', c?.incentiveMinorPerKwh ?? null);
  const incentive = rateRaw === null || rateRaw === '' ? null : Number(rateRaw);
  if (incentive !== null && !(Number.isSafeInteger(incentive) && incentive >= 0)) throw new DrError(422, 'incentiveMinorPerKwh is a whole amount in minor units (or empty).');
  // The incentive's currency: as given, else the programme's first site's (its country's currency).
  const siteCur = (await outsideRequestScope(() => one<{ currency: string }>(`SELECT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1`, [siteIds[0]])))?.currency;
  const currency = String(pick<unknown>('currency', null) || c?.currency || siteCur || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new DrError(422, 'currency is a three-letter code.');
  const enabled = pick('enabled', c?.enabled ?? true) === true;
  let vtnUrl: string | null = null, tokenUrl: string | null = null, programRef: string | null = null, clientId: string | null = null;
  let clientSecret: string | null = cur?.client_secret ?? null;
  if (kind === 'openadr3') {
    const url = (k: string, d: string | null) => {
      const v = String(pick(k, d ?? '')).trim();
      let u: URL | null = null;
      try { u = new URL(v); } catch { u = null; }
      if (!u || (u.protocol !== 'https:' && process.env.NODE_ENV === 'production')) throw new DrError(422, `${k} is the https address of the OpenADR 3 server.`);
      return v.replace(/\/+$/, '');
    };
    vtnUrl = url('vtnUrl', c?.vtnUrl ?? null);
    tokenUrl = url('tokenUrl', c?.tokenUrl ?? null);
    programRef = String(pick('programRef', c?.programRef ?? '')).trim().slice(0, 200) || null;
    if (!programRef) throw new DrError(422, 'programRef: the programme\'s ID on the OpenADR server.');
    clientId = String(pick('clientId', c?.clientId ?? '')).trim().slice(0, 200) || null;
    if (!clientId) throw new DrError(422, 'clientId: the client ID the OpenADR server gave you.');
    if (typeof b.clientSecret === 'string' && b.clientSecret.trim()) clientSecret = seal(b.clientSecret.trim(), `dr:${orgId}`);
    if (!clientSecret) throw new DrError(422, 'clientSecret: the client secret the OpenADR server gave you.');
  }
  const vals = [orgId, name, kind, enabled, siteIds, vtnUrl, programRef, clientId, clientSecret, tokenUrl, incentive, currency];
  const r = cur
    ? await outsideRequestScope(() => one<any>(`UPDATE dr_program SET name = $2, kind = $3, enabled = $4, site_ids = $5, vtn_url = $6, program_ref = $7, client_id = $8,
        client_secret = $9, token_url = $10, incentive_minor_per_kwh = $11, currency = $12 WHERE id = $13 AND org_id = $1 RETURNING *`, [...vals, cur.id]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO dr_program (org_id, name, kind, enabled, site_ids, vtn_url, program_ref, client_id, client_secret, token_url,
        incentive_minor_per_kwh, currency, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`, [...vals, userId]));
  return programOf(r);
}

/** A new key for a webhook programme: shown once; only its hash is kept. The previous key stops working. */
export async function rotateKey(orgId: string, id: string) {
  const cur = await programRow(orgId, id);
  if (cur.kind !== 'webhook') throw new DrError(422, 'Only a webhook programme has a key.');
  const key = `pdr_${randomBytes(24).toString('base64url')}`;
  await outsideRequestScope(() => query(`UPDATE dr_program SET token_hash = $2, token_hint = $3 WHERE id = $1`, [cur.id, sha(key), key.slice(-4)]));
  return { key, hint: key.slice(-4), url: `/v1/dr/programs/${cur.id}/events` };
}

// ------------------------------------------------------------------ events in

interface EventIn { extId: string; startsAt: Date; endsAt: Date; limitKw: number | null; reducePct: number | null; siteIds: string[]; cancelled: boolean; note?: string | null }

async function upsertEvent(p: any, e: EventIn, now = Date.now()): Promise<{ id: string; created: boolean; status: string }> {
  if (!Number.isFinite(e.startsAt.getTime()) || !Number.isFinite(e.endsAt.getTime())) throw new DrError(422, 'startsAt and endsAt are times (ISO 8601).');
  if (e.endsAt.getTime() <= e.startsAt.getTime()) throw new DrError(422, 'The event ends after it starts.');
  if (e.endsAt.getTime() - e.startsAt.getTime() > MAX_EVENT_MS) throw new DrError(422, 'An event lasts at most 24 hours.');
  if (e.endsAt.getTime() < now - 3_600_000) throw new DrError(422, 'The event is already over.');
  if (e.startsAt.getTime() > now + 30 * 86_400_000) throw new DrError(422, 'The event starts more than 30 days ahead.');
  if (!e.cancelled && e.limitKw == null && e.reducePct == null) throw new DrError(422, 'An event has limitKw (the grid limit for its sites) or reducePct (1 to 100).');
  if (e.reducePct != null && !(Number.isInteger(e.reducePct) && e.reducePct >= 1 && e.reducePct <= 100)) throw new DrError(422, 'reducePct is a whole number from 1 to 100.');
  if (e.limitKw != null && !(e.limitKw >= 0 && e.limitKw <= 100_000)) throw new DrError(422, 'limitKw is a number of kW.');
  if (e.cancelled) {
    // Calling an event off changes nothing else about it (and an event never seen is simply not kept).
    const c = await outsideRequestScope(() => one<any>(`UPDATE dr_event SET status = 'cancelled', updated_at = now() WHERE program_id = $1 AND ext_id = $2 AND status = 'scheduled' RETURNING id`, [p.id, e.extId]));
    const ex = c ?? await outsideRequestScope(() => one<any>(`SELECT id, status FROM dr_event WHERE program_id = $1 AND ext_id = $2`, [p.id, e.extId]));
    return { id: ex ? String(ex.id) : '', created: false, status: ex?.status ?? 'cancelled' };
  }
  const sites = e.siteIds.length ? e.siteIds : p.site_ids;
  if (sites.some((s: string) => !p.site_ids.includes(s))) throw new DrError(422, 'siteIds: only the programme\'s sites.');
  const r = await outsideRequestScope(() => one<any>(
    `INSERT INTO dr_event (org_id, program_id, ext_id, site_ids, starts_at, ends_at, limit_kw, reduce_pct, status, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (program_id, ext_id) DO UPDATE SET site_ids = EXCLUDED.site_ids, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
       limit_kw = EXCLUDED.limit_kw, reduce_pct = EXCLUDED.reduce_pct, note = COALESCE(EXCLUDED.note, dr_event.note), updated_at = now(),
       status = CASE WHEN dr_event.status = 'opted_out' THEN 'opted_out' ELSE EXCLUDED.status END
     RETURNING id, status, (xmax = 0) AS created`,
    [p.org_id, p.id, e.extId, sites, e.startsAt, e.endsAt, e.limitKw, e.reducePct, e.cancelled ? 'cancelled' : 'scheduled', e.note ?? null]));
  if (r.created && !e.cancelled) {
    const what = e.limitKw != null ? `a limit of ${e.limitKw} kW` : `a ${e.reducePct}% reduction`;
    await outsideRequestScope(() => persistAlert({ orgId: p.org_id, kind: DR_ALERT, severity: 'warning', targetType: 'dr_event', targetId: String(r.id),
      message: `${p.name}: ${what} on ${sites.length} site${sites.length === 1 ? '' : 's'} from ${e.startsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC to ${e.endsAt.toISOString().slice(11, 16)}. Charging is held to it automatically; opt out in Assets → Grid events.` })).catch(() => null);
  }
  return { id: String(r.id), created: r.created, status: r.status };
}

/** The webhook: an event from the grid operator or aggregator, with the programme's key. */
export async function ingestWebhook(programId: string, key: string, body: unknown): Promise<{ id: string; created: boolean; status: string }> {
  const p = /^\d{1,18}$/.test(programId) ? await outsideRequestScope(() => one<any>(`SELECT * FROM dr_program WHERE id = $1 AND archived_at IS NULL AND kind = 'webhook'`, [programId])) : null;
  const ok = !!p?.token_hash && typeof key === 'string' && key.length > 8 && timingSafeEqual(Buffer.from(sha(key), 'hex'), Buffer.from(p.token_hash, 'hex'));
  if (!ok) throw new DrError(401, 'A valid programme key is required.');
  if (!p.enabled) throw new DrError(409, 'The programme is switched off.');
  const x = (body ?? {}) as Record<string, unknown>;
  const extId = String(x.id ?? x.eventId ?? '').trim().slice(0, 200);
  if (!extId) throw new DrError(422, 'id: the event\'s own ID (a repeat with the same ID updates it).');
  const startsAt = new Date(String(x.start ?? x.startsAt ?? ''));
  const endsAt = x.end ?? x.endsAt ? new Date(String(x.end ?? x.endsAt)) : new Date(startsAt.getTime() + (Number(x.durationMinutes) || 0) * 60_000);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) throw new DrError(422, 'start (ISO 8601) and end, or durationMinutes, are required.');
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
  return upsertEvent(p, {
    extId, startsAt, endsAt, limitKw: num(x.limitKw), reducePct: num(x.reducePct), cancelled: x.status === 'cancelled' || x.cancelled === true,
    siteIds: Array.isArray(x.siteIds) ? x.siteIds.map(String) : [], note: typeof x.note === 'string' ? x.note.slice(0, 300) : null,
  });
}

/** Poll one OpenADR 3 programme: an OAuth token, then its events. */
export async function pollOpenAdr(p: any, now = Date.now()): Promise<number> {
  let n = 0;
  try {
    const secret = unseal(p.client_secret, `dr:${p.org_id}`);
    const tok = await guardedFetch(p.token_url, {
      method: 'POST', timeoutMs: 15_000, maxBytes: 64 * 1024,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: p.client_id, client_secret: secret }).toString(),
    });
    if (tok.status !== 200) throw new Error(`token endpoint answered ${tok.status}`);
    const access = JSON.parse(tok.text)?.access_token;
    if (typeof access !== 'string' || !access) throw new Error('no access_token from the token endpoint');
    const res = await guardedFetch(`${p.vtn_url}/events?programID=${encodeURIComponent(p.program_ref)}`, {
      timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
    });
    if (res.status !== 200) throw new Error(`events answered ${res.status}`);
    const list = JSON.parse(res.text);
    for (const ev of Array.isArray(list) ? list.slice(0, 200) : []) {
      const e = fromOpenAdr(ev);
      if (!e || e.endsAt.getTime() < now - 3_600_000) continue;
      await upsertEvent(p, { ...e, siteIds: [] }, now).then(() => { n++; }).catch((err) => logger.warn({ programId: p.id, extId: e.extId, err: (err as Error).message }, 'OpenADR event refused'));
    }
    await outsideRequestScope(() => query(`UPDATE dr_program SET last_poll_at = now(), last_error = NULL WHERE id = $1`, [p.id]));
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    logger.warn({ programId: p.id, err: msg }, 'OpenADR poll failed');
    await outsideRequestScope(() => query(`UPDATE dr_program SET last_poll_at = now(), last_error = $2 WHERE id = $1`, [p.id, msg])).catch(() => {});
  }
  return n;
}

/** The worker (every 5 minutes): every enabled OpenADR 3 programme. */
export async function pollAll(now = Date.now()): Promise<number> {
  const ps = await outsideRequestScope(() => many<any>(`SELECT * FROM dr_program WHERE kind = 'openadr3' AND enabled AND archived_at IS NULL`));
  let n = 0;
  for (const p of ps) n += await pollOpenAdr(p, now);
  return n;
}

// ------------------------------------------------------------------ the load manager

/**
 * The events on at a site now and what they ask of it. A kW limit covering several sites is split in proportion to
 * the sites' usual budget (ceiling − reserve), so together they stay under it.
 */
export async function activeFor(siteId: string, now = new Date()): Promise<ActiveLimit | null> {
  const evs = await outsideRequestScope(() => many<any>(
    `SELECT e.id, e.limit_kw, e.reduce_pct, e.site_ids FROM dr_event e JOIN dr_program p ON p.id = e.program_id AND p.enabled
      WHERE e.status = 'scheduled' AND $1 = ANY(e.site_ids) AND e.starts_at <= $2 AND e.ends_at > $2`, [siteId, now]));
  if (!evs.length) return null;
  let limitW: number | null = null, reducePct: number | null = null;
  for (const e of evs) {
    if (e.reduce_pct != null) reducePct = Math.max(reducePct ?? 0, Number(e.reduce_pct));
    if (e.limit_kw != null) {
      let share = 1;
      if (e.site_ids.length > 1) {
        const b = await outsideRequestScope(() => many<{ site_id: string; w: number }>(
          `SELECT s.id AS site_id, GREATEST(COALESCE(b.ceiling_w, 22000) - COALESCE(b.reserve_w, 0), 0)::float8 AS w
             FROM site s LEFT JOIN site_power_budget b ON b.site_id = s.id WHERE s.id = ANY($1::uuid[])`, [e.site_ids]));
        const total = b.reduce((a, x) => a + Number(x.w), 0);
        share = total > 0 ? Number(b.find((x) => x.site_id === siteId)?.w ?? 0) / total : 1 / e.site_ids.length;
      }
      const w = Math.round(Number(e.limit_kw) * 1000 * share);
      limitW = limitW == null ? w : Math.min(limitW, w);
    }
  }
  return { eventIds: evs.map((e) => String(e.id)), limitW, reducePct };
}

/** One pass's measurement: what the chargers would have drawn (baseline) and what they were given, in W. */
export async function recordPass(siteId: string, a: ActiveLimit, baselineW: number, actualW: number, now = new Date()): Promise<void> {
  for (const id of a.eventIds) {
    await outsideRequestScope(() => query(
      `INSERT INTO dr_event_site (event_id, site_id, org_id, limit_w, samples, last_sample_at)
         SELECT $1, $2, e.org_id, $5, 1, $6 FROM dr_event e WHERE e.id = $1
       ON CONFLICT (event_id, site_id) DO UPDATE SET
         baseline_wh = dr_event_site.baseline_wh + $3::float8 * LEAST(GREATEST(EXTRACT(EPOCH FROM ($6 - dr_event_site.last_sample_at)), 0), ${MAX_SAMPLE_GAP_S}) / 3600,
         actual_wh   = dr_event_site.actual_wh   + $4::float8 * LEAST(GREATEST(EXTRACT(EPOCH FROM ($6 - dr_event_site.last_sample_at)), 0), ${MAX_SAMPLE_GAP_S}) / 3600,
         limit_w = $5, samples = dr_event_site.samples + 1, last_sample_at = $6`,
      [Number(id), siteId, baselineW, actualW, a.limitW, now]));
  }
}

// ------------------------------------------------------------------ the console

const stateOf = (e: any, now: number) => (e.status !== 'scheduled' ? e.status : new Date(e.ends_at).getTime() <= now ? 'completed' : new Date(e.starts_at).getTime() <= now ? 'active' : 'upcoming');

/** Events (recent first) with what was measured and the incentive. */
export async function events(orgId: string, q: { programId?: unknown; days?: unknown } = {}, now = Date.now()) {
  const days = Math.min(365, Math.max(1, Number(q.days) || 90));
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT e.*, p.name AS program_name, p.incentive_minor_per_kwh, p.currency,
            COALESCE(json_agg(json_build_object('siteId', m.site_id, 'site', s.name, 'baselineWh', m.baseline_wh, 'actualWh', m.actual_wh, 'samples', m.samples, 'limitW', m.limit_w))
              FILTER (WHERE m.site_id IS NOT NULL), '[]') AS measured
       FROM dr_event e JOIN dr_program p ON p.id = e.program_id
       LEFT JOIN dr_event_site m ON m.event_id = e.id LEFT JOIN site s ON s.id = m.site_id
      WHERE e.org_id = $1 AND e.ends_at > now() - make_interval(days => $2) AND ($3::bigint IS NULL OR e.program_id = $3)
      GROUP BY e.id, p.id ORDER BY e.starts_at DESC LIMIT 500`,
    [orgId, days, q.programId ? Number(q.programId) || 0 : null]));
  const siteNames = new Map((await outsideRequestScope(() => many<any>(`SELECT id, name FROM site WHERE org_id = $1`, [orgId]))).map((s) => [s.id, s.name]));
  return {
    events: rows.map((e) => {
      const measured = (e.measured as any[]).map((m) => ({ ...m, baselineKwh: Number(m.baselineWh) / 1000, actualKwh: Number(m.actualWh) / 1000, reducedKwh: Math.max(0, (Number(m.baselineWh) - Number(m.actualWh)) / 1000) }));
      const reducedKwh = measured.reduce((a, m) => a + m.reducedKwh, 0);
      const hours = (new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 3_600_000;
      return {
        id: String(e.id), programId: String(e.program_id), program: e.program_name, extId: e.ext_id, state: stateOf(e, now),
        startsAt: new Date(e.starts_at).toISOString(), endsAt: new Date(e.ends_at).toISOString(), limitKw: e.limit_kw == null ? null : Number(e.limit_kw), reducePct: e.reduce_pct,
        sites: e.site_ids.map((id: string) => ({ id, name: siteNames.get(id) ?? id })), note: e.note ?? null,
        measured, reducedKwh: Math.round(reducedKwh * 1000) / 1000, avgReducedKw: hours > 0 ? Math.round((reducedKwh / hours) * 100) / 100 : null,
        incentiveMinor: e.incentive_minor_per_kwh == null ? null : Math.round(reducedKwh * Number(e.incentive_minor_per_kwh)), currency: e.currency,
      };
    }),
    note: 'Measured by the load manager: the power the chargers asked for within the usual budget, against what they were given.',
  };
}

/** Opt a site out of an event (or the whole event): recorded, with who. */
export async function optOut(orgId: string, eventId: string, userId: string | null, note: unknown) {
  const e = await outsideRequestScope(() => one<any>(`SELECT * FROM dr_event WHERE id = $1 AND org_id = $2`, [Number(eventId) || 0, orgId]));
  if (!e) throw new DrError(404, 'No such event.');
  if (e.status !== 'scheduled') throw new DrError(409, `The event is ${e.status.replace('_', ' ')}.`);
  if (new Date(e.ends_at).getTime() <= Date.now()) throw new DrError(409, 'The event is over.');
  await outsideRequestScope(() => query(`UPDATE dr_event SET status = 'opted_out', opted_out_by = $2, note = COALESCE($3, note), updated_at = now() WHERE id = $1`,
    [e.id, userId, typeof note === 'string' && note.trim() ? note.trim().slice(0, 300) : null]));
  return { id: String(e.id), status: 'opted_out' };
}

/** Add an event by hand (a phone call or an e-mail from the grid operator), on a programme of either kind. */
export async function addManual(orgId: string, programId: string, b: Record<string, unknown>) {
  const p = await programRow(orgId, programId);
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
  return upsertEvent(p, {
    extId: `manual-${randomBytes(6).toString('hex')}`, startsAt: new Date(String(b.startsAt ?? '')), endsAt: new Date(String(b.endsAt ?? '')),
    limitKw: num(b.limitKw), reducePct: num(b.reducePct), siteIds: Array.isArray(b.siteIds) ? b.siteIds.map(String) : [], cancelled: false,
    note: typeof b.note === 'string' ? b.note.slice(0, 300) : null,
  });
}
