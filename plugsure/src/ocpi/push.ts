import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { bus } from '../services/events.js';
import { unseal } from '../services/secrets.js';
import { contentHash, evseUid, ocpiDateTime, STATUS, type Party } from './mapping.js';
import {
  getParty, getParties, endpointUrl, renderLocations, renderTariffs, publishedTariffIds, renderSession, renderCdrForSession,
  type PartnerRow,
} from './store.js';
import { ocpiCall } from './client.js';
import { roamingCards, cardToken, type CardRow } from './emsp.js';

/**
 * Pushing to partners: the outbox, the listeners that fill it, the worker
 * that empties it, and the sync that notices location and tariff changes.
 *
 * Rows hold WHAT to send (module, action, object), not the body: the body is
 * rendered from the database when the row is sent, so a burst of meter values
 * becomes one PATCH carrying the latest energy, and a retry never sends stale
 * data. Calls about one object leave in order (a session's PUT, its PATCHes,
 * then the CDR), and an object with a call already queued is not queued twice.
 *
 * Command results are the exception: their body is fixed at the time and is
 * stored with the row.
 */

export const MAX_ATTEMPTS = 8;
/** Seconds before retry N: 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h. */
export const BACKOFF_S = [30, 120, 600, 1800, 3600, 10800, 21600];

type Module = 'locations' | 'tariffs' | 'sessions' | 'cdrs' | 'commands' | 'tokens' | 'chargingprofiles';

interface Enqueue {
  orgId: string;
  partnerId: string;
  module: Module;
  action: string;
  objectKey: string;
  url?: string;
  body?: unknown;
  to?: { country_code: string | null; party_id: string | null };
  /** Queue even when the same call is already waiting (a command result, a final session PUT). */
  always?: boolean;
}

export async function enqueuePush(e: Enqueue): Promise<void> {
  await query(
    `INSERT INTO ocpi_push (org_id, partner_id, module, action, object_key, url, body, to_country_code, to_party_id)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
      WHERE $10 OR NOT EXISTS (
        SELECT 1 FROM ocpi_push
         WHERE partner_id = $2 AND object_key = $5 AND action = $4 AND state = 'pending' AND attempts = 0)`,
    [e.orgId, e.partnerId, e.module, e.action, e.objectKey, e.url ?? null, e.body === undefined ? null : JSON.stringify(e.body),
      e.to?.country_code ?? null, e.to?.party_id ?? null, e.always ?? false],
  );
}

/** Connected partners that receive this module (a partner without a receiver endpoint is skipped). */
/**
 * An `authority` partner (Singapore's LTA, docs/MULTI-COUNTRY-DESIGN.md SG-6 / D8)
 * receives Locations and Tariffs of its own country only — and nothing else.
 */
const AUTHORITY_COUNTRY = 'SGP';
export function authorityTakes(p: Pick<PartnerRow, 'kind'>, alpha3: string): boolean {
  return p.kind !== 'authority' || alpha3 === AUTHORITY_COUNTRY;
}

async function receivers(orgId: string, module: Module) {
  // Authorities take Locations and Tariffs only (never sessions, CDRs or tokens).
  if (module !== 'locations' && module !== 'tariffs') {
    return many<PartnerRow>(
      `SELECT * FROM ocpi_partner
        WHERE org_id = $1 AND state = 'connected' AND kind <> 'authority'
          AND endpoints @> $2::jsonb`,
      [orgId, JSON.stringify([{ identifier: module, role: 'RECEIVER' }])],
    );
  }
  return many<PartnerRow>(
    `SELECT * FROM ocpi_partner
      WHERE org_id = $1 AND state = 'connected'
        AND endpoints @> $2::jsonb`,
    [orgId, JSON.stringify([{ identifier: module, role: 'RECEIVER' }])],
  );
}

// ─────────────────────────────────────────────── listeners

async function onEvseChange(orgId: string, ocppIdentity: string, evseNo: number | null) {
  const cp = await one<{ id: string; site_id: string; published: boolean }>(
    `SELECT cp.id, cp.site_id, (s.roaming_publish AND s.archived_at IS NULL AND s.billing_model <> 'private') AS published
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE cp.ocpp_identity = $1 AND s.org_id = $2`,
    [ocppIdentity, orgId],
  );
  if (!cp?.published) return;
  const evses = evseNo != null ? [evseNo]
    : (await many<{ evse_id: number }>(`SELECT evse_id FROM evse WHERE charge_point_id = $1 AND evse_id > 0`, [cp.id])).map((e) => e.evse_id);
  for (const p of await receivers(orgId, 'locations')) {
    for (const n of evses) {
      await enqueuePush({ orgId, partnerId: p.id, module: 'locations', action: 'patch_evse', objectKey: `evse:${cp.id}:${n}`,
        to: { country_code: p.country_code, party_id: p.party_id } });
    }
  }
}

async function onSession(orgId: string, sessionId: string, action: 'put' | 'patch' | 'cdr') {
  const s = await one<{ ocpi_partner_id: string | null; t_cc: string; t_pid: string }>(
    `SELECT cs.ocpi_partner_id, t.country_code AS t_cc, t.party_id AS t_pid
       FROM charging_session cs JOIN ocpi_token t ON t.id = cs.ocpi_token_id
      WHERE cs.id = $1 AND cs.org_id = $2`,
    [sessionId, orgId],
  );
  if (!s?.ocpi_partner_id) return;
  const p = await one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE id = $1 AND state = 'connected'`, [s.ocpi_partner_id]);
  if (!p) return;
  const module: Module = action === 'cdr' ? 'cdrs' : 'sessions';
  if (!endpointUrl(p, module, 'RECEIVER')) return;
  await enqueuePush({
    orgId, partnerId: p.id, module, action: action === 'cdr' ? 'post' : action, objectKey: `session:${sessionId}`,
    to: { country_code: s.t_cc, party_id: s.t_pid },
    // The final PUT and the CDR must go out even when an earlier call is still queued.
    always: action !== 'patch',
  });
}

/**
 * Register on the bus. Named listeners run only where the event is raised, so
 * registering in both processes never queues a call twice.
 */
export function registerRoamingListeners(): void {
  const guard = (what: string, fn: () => Promise<unknown>) =>
    void fn().catch((e) => logger.warn({ err: (e as Error).message, what }, 'roaming enqueue failed'));
  bus.on('connector.status_changed', (e) => guard('evse status', () => onEvseChange(e.orgId, e.ocppIdentity, e.evseId)));
  bus.on('charge_point.connected', (e) => guard('charger online', () => onEvseChange(e.orgId, e.ocppIdentity, null)));
  bus.on('charge_point.disconnected', (e) => guard('charger offline', () => onEvseChange(e.orgId, e.ocppIdentity, null)));
  bus.on('session.started', (e) => guard('session start', () => onSession(e.orgId, e.sessionId, 'put')));
  bus.on('session.updated', (e) => guard('session update', () => onSession(e.orgId, e.sessionId, 'patch')));
  bus.on('session.ended', (e) => guard('session end', () => onSession(e.orgId, e.sessionId, 'put')));
  bus.on('cdr.created', (e) => guard('cdr', () => onSession(e.orgId, e.sessionId, 'cdr')));
}

// ─────────────────────────────────────────────── sync: locations and tariffs

/**
 * Compare what partners should see with what was last published, and queue a
 * PUT for every location or tariff whose content changed (and a withdrawal for
 * anything no longer shared). Catches every change path — site edits, new
 * chargers, tariff re-assignment — without hooking each one.
 */
export async function syncOrg(orgId: string, opts: { forceAll?: boolean; partnerId?: string } = {}): Promise<{ locations: number; tariffs: number; tokens: number }> {
  // Every party of the operator: each location / tariff goes out under its country's party.
  const parties = await getParties(orgId);
  const party = parties[0];
  if (!party) return { locations: 0, tariffs: 0, tokens: 0 };
  const locPartners = (await receivers(orgId, 'locations')).filter((p) => !opts.partnerId || p.id === opts.partnerId);
  const tarPartners = (await receivers(orgId, 'tariffs')).filter((p) => !opts.partnerId || p.id === opts.partnerId);

  const states = new Map((await many<{ object_type: string; object_id: string; hash: string; removed_at: Date | null }>(
    `SELECT object_type, object_id, hash, removed_at FROM ocpi_object_state WHERE org_id = $1`, [orgId],
  )).map((r) => [`${r.object_type}:${r.object_id}`, r]));

  const setState = (type: string, id: string, hash: string, removed: boolean) => query(
    `INSERT INTO ocpi_object_state (org_id, object_type, object_id, hash, last_updated, removed_at)
     VALUES ($1,$2,$3,$4, now(), CASE WHEN $5 THEN now() END)
     ON CONFLICT (org_id, object_type, object_id) DO UPDATE
       SET hash = EXCLUDED.hash, last_updated = now(), removed_at = EXCLUDED.removed_at`,
    [orgId, type, id, hash, removed],
  );

  let locations = 0;
  const all = await renderLocations(orgId, parties, { onlyPublished: false });
  for (const l of all) {
    const prev = states.get(`location:${l.siteId}`);
    const wasShared = prev && !prev.removed_at;
    if (!l.published && !wasShared) continue;
    const hash = contentHash(l.location);
    const changed = !prev || prev.hash !== hash || (!l.published) !== !!prev.removed_at;
    if (!changed && !opts.forceAll) continue;
    if (changed) await setState('location', l.siteId, hash, !l.published);
    for (const p of locPartners.filter((x) => authorityTakes(x, l.location.country))) {
      await enqueuePush({ orgId, partnerId: p.id, module: 'locations', action: 'put', objectKey: `location:${l.siteId}`,
        to: { country_code: p.country_code, party_id: p.party_id } });
    }
    locations++;
  }

  let tariffs = 0;
  const ids = new Set(await publishedTariffIds(orgId, parties));
  const rendered = await renderTariffs(orgId, parties, [...ids]);
  for (const t of rendered) {
    const prev = states.get(`tariff:${t.id}`);
    const hash = contentHash(t.tariff);
    const changed = !prev || prev.hash !== hash || !!prev.removed_at;
    if (!changed && !opts.forceAll) continue;
    if (changed) await setState('tariff', t.id, hash, false);
    for (const p of tarPartners.filter((x) => authorityTakes(x, t.tariff.currency === 'SGD' ? 'SGP' : t.tariff.currency === 'MYR' ? 'MYS' : 'IDN'))) {
      await enqueuePush({ orgId, partnerId: p.id, module: 'tariffs', action: 'put', objectKey: `tariff:${t.id}`,
        to: { country_code: p.country_code, party_id: p.party_id } });
    }
    tariffs++;
  }
  // Tariffs no longer used on any shared connector are withdrawn.
  for (const [k, s] of states) {
    if (!k.startsWith('tariff:') || s.removed_at) continue;
    const id = k.slice('tariff:'.length);
    if (ids.has(id)) continue;
    await setState('tariff', id, s.hash, true);
    for (const p of tarPartners) {
      await enqueuePush({ orgId, partnerId: p.id, module: 'tariffs', action: 'delete', objectKey: `tariff:${id}`,
        to: { country_code: p.country_code, party_id: p.party_id } });
    }
    tariffs++;
  }

  // eMSP role: our shared cards, to every CPO that receives tokens. A card that
  // stops being shared (or is blocked) goes out once more with valid=false.
  let tokens = 0;
  const tokPartners = (await receivers(orgId, 'tokens')).filter((p) => !opts.partnerId || p.id === opts.partnerId);
  for (const c of await roamingCards(orgId)) {
    const prev = states.get(`token:${c.id}`);
    if (!prev && !c.roaming_shared) continue;
    const hash = contentHash(cardToken(party, c));
    const changed = !prev || prev.hash !== hash;
    if (!changed && !(opts.forceAll && c.roaming_shared)) continue;
    if (changed) await setState('token', c.id, hash, !c.roaming_shared);
    for (const p of tokPartners) {
      await enqueuePush({ orgId, partnerId: p.id, module: 'tokens', action: 'put', objectKey: `token:${c.id}`,
        to: { country_code: p.country_code, party_id: p.party_id } });
    }
    tokens++;
  }
  return { locations, tariffs, tokens };
}

/**
 * Singapore's LTA wants dynamic data at least every 5 minutes (SG-6), whether or not
 * a status changed: a full Location PUT of every published SG site to each connected
 * `authority` partner. Runs from the workers (`ocpi-authority-heartbeat`).
 */
export async function authorityHeartbeat(): Promise<number> {
  const partners = await many<PartnerRow>(
    `SELECT * FROM ocpi_partner WHERE state = 'connected' AND kind = 'authority'
        AND endpoints @> '[{"identifier":"locations","role":"RECEIVER"}]'::jsonb`);
  let n = 0;
  for (const p of partners) {
    const sites = await many<{ id: string }>(
      `SELECT id FROM site WHERE org_id = $1 AND country_code = 'SG' AND roaming_publish AND archived_at IS NULL AND billing_model <> 'private'`,
      [p.org_id]);
    for (const s of sites) {
      await enqueuePush({ orgId: p.org_id, partnerId: p.id, module: 'locations', action: 'put', objectKey: `location:${s.id}`,
        to: { country_code: p.country_code, party_id: p.party_id } });
      n++;
    }
  }
  return n;
}

export async function syncAll(): Promise<void> {
  const orgs = await many<{ org_id: string }>(`SELECT DISTINCT org_id FROM ocpi_partner WHERE state = 'connected'`);
  for (const o of orgs) await syncOrg(o.org_id).catch((e) => logger.warn({ orgId: o.org_id, err: (e as Error).message }, 'roaming sync failed'));
}

// ─────────────────────────────────────────────── delivery

interface DueRow {
  id: string; org_id: string; partner_id: string; module: Module; action: string; object_key: string;
  url: string | null; body: unknown; to_country_code: string | null; to_party_id: string | null; attempts: number;
}

/**
 * `from`: the party the object is published under (its country's), sent as OCPI-from-*: a hub routes the
 * receiver's answer by it. Unset: the home party (tokens: our eMSP identity; command results).
 */
type Built = { method: 'PUT' | 'PATCH' | 'POST' | 'DELETE'; url: string; body?: unknown; from?: Party } | { skip: string };
const partyOf = (o: { country_code: string; party_id: string }, parties: Party[]): Party | undefined =>
  parties.find((p) => p.country_code === o.country_code && p.party_id === o.party_id);

async function build(row: DueRow, p: PartnerRow, party: Party): Promise<Built> {
  const recv = endpointUrl(p, row.module, 'RECEIVER');
  // The object's own party (its country's), in the receiver URL; `party` is the home party.
  const ownOf = (o: { country_code: string; party_id: string }) => `${o.country_code}/${o.party_id}`;
  const own = `${party.country_code}/${party.party_id}`;
  const parties = await getParties(row.org_id);
  const [kind, a, b] = row.object_key.split(':');

  // Command and charging-profile results go to the response_url the partner gave.
  if (row.module === 'commands' || row.module === 'chargingprofiles') {
    return row.url ? { method: 'POST', url: row.url, body: row.body } : { skip: 'no response_url' };
  }
  if (!recv) return { skip: `partner has no ${row.module} receiver` };

  if (row.module === 'locations') {
    if (kind === 'location') {
      const [l] = await renderLocations(row.org_id, parties, { siteId: a!, onlyPublished: false });
      if (!l) return { skip: 'site no longer exists' };
      if (!authorityTakes(p, l.location.country)) return { skip: 'not for this authority' };
      return { method: 'PUT', url: `${recv}/${ownOf(l.location)}/${l.siteId}`, body: l.location, from: partyOf(l.location, parties) };
    }
    if (kind === 'evse') {
      const cp = await one<{ site_id: string; ocpp_identity: string }>(`SELECT site_id, ocpp_identity FROM charge_point WHERE id = $1`, [a]);
      if (!cp) return { skip: 'charger no longer exists' };
      const [l] = await renderLocations(row.org_id, parties, { siteId: cp.site_id });
      const uid = evseUid(cp.ocpp_identity, Number(b));
      const evse = l?.location.evses.find((e) => e.uid === uid);
      if (!l || !evse) return { skip: 'location or EVSE is not shared' };
      if (!authorityTakes(p, l.location.country)) return { skip: 'not for this authority' };
      return { method: 'PATCH', url: `${recv}/${ownOf(l.location)}/${l.siteId}/${uid}`, body: { status: evse.status, last_updated: ocpiDateTime(new Date()) }, from: partyOf(l.location, parties) };
    }
  }
  if (row.module === 'tariffs' && kind === 'tariff') {
    const [t] = await renderTariffs(row.org_id, parties, [a!]);
    if (row.action === 'delete') return { method: 'DELETE', url: `${recv}/${t ? ownOf(t.tariff) : own}/${a}`, ...(t ? { from: partyOf(t.tariff, parties) } : {}) };
    if (!t) return { skip: 'tariff no longer exists' };
    return { method: 'PUT', url: `${recv}/${ownOf(t.tariff)}/${a}`, body: t.tariff, from: partyOf(t.tariff, parties) };
  }
  if (row.module === 'sessions' && kind === 'session') {
    const s = await renderSession(a!);
    if (!s) return { skip: 'session no longer exists' };
    if (row.action === 'patch') {
      return { method: 'PATCH', url: `${recv}/${ownOf(s.session)}/${a}`, body: {
        kwh: s.session.kwh, status: s.session.status, ...(s.session.total_cost ? { total_cost: s.session.total_cost } : {}), last_updated: s.session.last_updated,
      }, from: partyOf(s.session, parties) };
    }
    return { method: 'PUT', url: `${recv}/${ownOf(s.session)}/${a}`, body: s.session, from: partyOf(s.session, parties) };
  }
  if (row.module === 'tokens' && kind === 'token') {
    const c = await one<CardRow>(`SELECT id, org_id, uid, status, valid_to, holder_name, fleet_name, energy_limit_wh, spend_limit_minor, roaming_shared, contract_id, updated_at
                                    FROM token WHERE id = $1 AND org_id = $2 AND contract_id IS NOT NULL`, [a, row.org_id]);
    if (!c) return { skip: 'card no longer exists' };
    return { method: 'PUT', url: `${recv}/${own}/${encodeURIComponent(c.uid)}?type=RFID`, body: cardToken(party, c) };
  }
  if (row.module === 'cdrs' && kind === 'session') {
    const c = await renderCdrForSession(a!);
    if (!c) return { skip: 'no CDR for this session yet' };
    return { method: 'POST', url: recv, body: c.cdr, from: partyOf(c.cdr, parties) };
  }
  return { skip: `unknown call ${row.module}/${row.action}` };
}

/** Worker pass: send what is due, in order per object. */
export async function deliverDue(limit = 50): Promise<number> {
  const due = await many<DueRow>(
    `WITH picked AS (
       SELECT o.id FROM ocpi_push o
         JOIN ocpi_partner p ON p.id = o.partner_id
        WHERE o.state = 'pending' AND o.next_attempt_at <= now() AND p.state = 'connected'
          AND NOT EXISTS (SELECT 1 FROM ocpi_push e
                           WHERE e.partner_id = o.partner_id AND e.object_key = o.object_key
                             AND e.state = 'pending' AND e.id < o.id)
        ORDER BY o.id
        LIMIT $1
        FOR UPDATE OF o SKIP LOCKED)
     UPDATE ocpi_push o SET attempts = o.attempts + 1, next_attempt_at = now() + interval '2 minutes'
       FROM picked WHERE o.id = picked.id
     RETURNING o.id, o.org_id, o.partner_id, o.module, o.action, o.object_key, o.url, o.body,
               o.to_country_code, o.to_party_id, o.attempts`,
    [limit],
  );
  // Different objects in parallel; calls within one object are already serialised by the query.
  await Promise.all(due.map((d) => attempt(d).catch((e) => crashed(d, e as Error))));
  return due.length;
}

/**
 * An attempt that threw (rendering the body failed, the database hiccuped...)
 * counts like a refused one: the claim above already counted it, so back off,
 * and after MAX_ATTEMPTS dead-letter the row instead of retrying it every two
 * minutes forever (and holding back every later call about the same object).
 */
async function crashed(d: DueRow, e: Error): Promise<void> {
  logger.warn({ id: d.id, attempts: d.attempts, err: e.message }, 'roaming push failed');
  const dead = d.attempts >= MAX_ATTEMPTS;
  const wait = BACKOFF_S[Math.min(Math.max(d.attempts - 1, 0), BACKOFF_S.length - 1)]!;
  await query(
    `UPDATE ocpi_push SET state = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4::int) WHERE id = $1 AND state = 'pending'`,
    [d.id, dead ? 'failed' : 'pending', `internal error: ${e.message}`.slice(0, 500), wait],
  ).catch((err) => logger.error({ id: d.id, err: (err as Error).message }, 'could not record a failed roaming push'));
}

async function attempt(d: DueRow): Promise<void> {
  const p = await one<PartnerRow>(`SELECT * FROM ocpi_partner WHERE id = $1`, [d.partner_id]);
  const party = await getParty(d.org_id);
  if (!p || !party || !p.token_out) {
    await query(`UPDATE ocpi_push SET state = 'failed', last_error = 'partner or roaming identity missing' WHERE id = $1`, [d.id]);
    return;
  }
  const b = await build(d, p, party);
  if ('skip' in b) {
    await query(`UPDATE ocpi_push SET state = 'delivered', delivered_at = now(), last_error = $2 WHERE id = $1`, [d.id, `skipped: ${b.skip}`]);
    return;
  }
  let token: string;
  try { token = unseal(p.token_out); } catch {
    await query(`UPDATE ocpi_push SET state = 'failed', last_error = 'partner token cannot be decrypted (SECRETS_KEY changed?)' WHERE id = $1`, [d.id]);
    return;
  }
  const r = await ocpiCall({
    orgId: d.org_id, partnerId: p.id, method: b.method, url: b.url, token, body: b.body, from: b.from ?? party,
    to: { country_code: d.to_country_code, party_id: d.to_party_id },
  });
  if (r.ok) {
    const loc = r.headers.location;
    await query(
      `UPDATE ocpi_push SET state = 'delivered', delivered_at = now(), last_status = $2, last_error = NULL, response_location = $3 WHERE id = $1`,
      [d.id, r.httpStatus, typeof loc === 'string' ? loc.slice(0, 500) : null],
    );
    await query(`UPDATE ocpi_partner SET last_success_at = now(), last_error = NULL WHERE id = $1`, [p.id]);
    return;
  }
  // An EVSE PATCH the partner cannot place (it does not know the location yet):
  // send the whole location instead, which carries the status.
  if (d.action === 'patch_evse' && r.ocpiStatus === STATUS.UNKNOWN_LOCATION) {
    const siteId = b.url.split('/').slice(-2, -1)[0]!;
    await enqueuePush({ orgId: d.org_id, partnerId: p.id, module: 'locations', action: 'put', objectKey: `location:${siteId}`,
      to: { country_code: d.to_country_code, party_id: d.to_party_id } });
    await query(`UPDATE ocpi_push SET state = 'delivered', delivered_at = now(), last_status = $2, last_error = 'superseded by a full location PUT' WHERE id = $1`, [d.id, r.httpStatus]);
    return;
  }
  const dead = d.attempts >= MAX_ATTEMPTS;
  const wait = BACKOFF_S[Math.min(d.attempts - 1, BACKOFF_S.length - 1)]!;
  await query(
    `UPDATE ocpi_push SET state = $2, last_status = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5::int) WHERE id = $1`,
    [d.id, dead ? 'failed' : 'pending', r.httpStatus, r.error, wait],
  );
  await query(`UPDATE ocpi_partner SET last_error = $2 WHERE id = $1`, [p.id, `${b.method} ${d.module}: ${r.error}`]);
  if (dead && (d.module === 'cdrs' || d.module === 'sessions')) {
    bus.emit('alert.raised', {
      orgId: d.org_id,
      kind: 'roaming.push_failed',
      severity: 'warning',
      message: `Roaming partner ${p.name} did not accept ${d.module === 'cdrs' ? 'a charge record' : 'a session update'} after ${d.attempts} attempts (last error: ${r.error}). Fix the connection, then replay it under Roaming.`,
      targetType: 'ocpi_partner',
      targetId: p.id,
    });
  }
}

export async function replayFailed(orgId: string, partnerId: string): Promise<number> {
  const r = await query(
    `UPDATE ocpi_push SET state = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
      WHERE org_id = $1 AND partner_id = $2 AND state = 'failed'`,
    [orgId, partnerId],
  );
  return r.rowCount ?? 0;
}

/** Keep the outbox and message log bounded. */
export async function pruneRoaming(): Promise<void> {
  await query(`DELETE FROM ocpi_push WHERE (state = 'delivered' AND created_at < now() - interval '14 days') OR (state = 'failed' AND created_at < now() - interval '60 days')`);
  await query(`DELETE FROM ocpi_message WHERE created_at < now() - interval '30 days'`);
  await query(`DELETE FROM ocpi_authorization WHERE expires_at < now() - interval '1 day'`);
  // A partner's charging limit ends with its session.
  await query(`DELETE FROM ocpi_charging_profile p USING charging_session cs
                WHERE cs.id = p.session_id AND cs.state <> 'active' AND cs.ended_at < now() - interval '1 day'`);
}
