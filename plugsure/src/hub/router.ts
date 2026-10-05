import { randomUUID } from 'node:crypto';
import { one, query } from '../db/pool.js';
import { config } from '../config.js';
import { alertResponseFiltered } from './alerts.js';
import { logger } from '../logger.js';
import { seal, unseal } from '../services/secrets.js';
import { envelope, ocpiDateTime } from '../ocpi/mapping.js';
import { endpointUrl } from '../ocpi/store.js';
import { agreedCounterparties, mayRoute, type ModuleFlag } from './agreements.js';
import { hubCall, type HubCallResult } from './call.js';
import { HUB_STATUS, HubError, fromMismatch, invalid, notConnected, unknownReceiver } from './errors.js';
import { admitCdr, cdrEvent, onCdrRouted, type CdrPartyRef, type CdrRoutedEvent } from './ledger-tap.js';
import { enqueueHub, kickHubOutbox } from './outbox.js';
import { getConnection, getParty, hubBase, isSelfParty, partiesOfConnection, partyByKey, selfPartyFor } from './registry.js';
import {
  cdrLocationUrl, commandCallbackUrl, cursorUrl, filtersOf, linkNext, newCallbackId, openCursor, parseLinkNext, profileCallbackUrl,
  queryWithResponseUrl, sameOrigin, sealCursor, withQuery, withResponseUrl, type Cursor,
} from './rewrite.js';
import { learn, markData, resolveOpen } from './route-index.js';
import { memberUrlProblem } from './credentials.js';
import { inprocPathAllowed, isInprocUrl } from './transport.js';
import type { HubConnection, HubParty } from './types.js';
import { label } from './types.js';

/**
 * The hub router (design §5): classify the request, check who sends it (OCPI-from must be a party of the
 * calling connection, in a role fit for the interface) and who it is for (OCPI-to: a party → direct, the hub →
 * broadcast or GET All, none → open routing), enforce the roaming agreement, then forward it with a new
 * X-Request-ID, the same X-Correlation-ID and the body untouched (last_updated included) — except the URLs
 * the other side could not reach, which are rewritten to hub URLs (§5.6).
 */

// ─────────────────────────────────────────────── classification (pure)

export const MODULES = ['locations', 'tariffs', 'sessions', 'cdrs', 'tokens', 'commands', 'chargingprofiles'] as const;
export type HubModule = typeof MODULES[number];

const EMSP_SIDE = ['EMSP', 'OTHER', 'NSP', 'SCSP'] as const;
const CPO = ['CPO'] as const;

export type RouteKind = 'functional' | 'callback_command' | 'callback_profile' | 'cdr_location';

export interface Classified {
  iface: 'sender' | 'receiver';
  module: HubModule;
  kind: RouteKind;
  /** Path segments after the module (decoded). */
  segs: string[];
  /** Roles the caller (OCPI-from) must have. */
  callerRoles: readonly string[];
  /** Roles the receiving party must have. */
  targetRoles: readonly string[];
  /** A Broadcast Push may be made (POST/PUT/PATCH; DELETE for tariffs). */
  broadcastable: boolean;
  /** GET of a collection (GET All when to = hub or none). */
  list: boolean;
  /** Client-owned object URL: {cc}/{pid} that must be the caller. */
  urlParty: { country_code: string; party_id: string } | null;
  flag: ModuleFlag;
  realtime: boolean;
}

const methodNotAllowed = (method: string, what: string) => new HubError(405, 2000, `${method} is not supported on ${what}`);

/** Classify `/hub/ocpi/2.2.1/{iface}/{module}/…` (rest = the part after `/hub/ocpi/2.2.1/`). */
export function classify(rest: string, method: string): Classified {
  const raw = rest.split('?')[0]!.split('/').filter((s) => s !== '');
  let segs: string[];
  try { segs = raw.map((s) => decodeURIComponent(s)); } catch { throw invalid('malformed path'); }
  const [iface, module, ...tail] = segs as [string, string, ...string[]];
  if (iface !== 'sender' && iface !== 'receiver') throw new HubError(404, 2000, 'unknown hub endpoint');
  if (!(MODULES as readonly string[]).includes(module)) throw new HubError(404, 2000, `unknown module ${module ?? ''}`);
  const m = module as HubModule;
  const base = { iface, module: m, segs: tail, broadcastable: false, list: false, urlParty: null, flag: null, realtime: false, kind: 'functional' as RouteKind } as Classified;
  const party = (t: string[]) => ({ country_code: String(t[0] ?? '').toUpperCase(), party_id: String(t[1] ?? '').toUpperCase() });
  const what = `${iface}/${m}`;
  if (iface === 'receiver') {
    switch (m) {
      case 'locations':
        if (tail.length < 3 || tail.length > 5) throw new HubError(404, 2000, 'expected receiver/locations/{country_code}/{party_id}/{location_id}[/{evse_uid}[/{connector_id}]]');
        if (!['GET', 'PUT', 'PATCH'].includes(method)) throw methodNotAllowed(method, what);
        return { ...base, callerRoles: CPO, targetRoles: ['EMSP', 'NSP', 'OTHER'], broadcastable: method !== 'GET', urlParty: party(tail) };
      case 'tariffs':
        if (tail.length !== 3) throw new HubError(404, 2000, 'expected receiver/tariffs/{country_code}/{party_id}/{tariff_id}');
        if (!['GET', 'PUT', 'DELETE'].includes(method)) throw methodNotAllowed(method, what);
        return { ...base, callerRoles: CPO, targetRoles: ['EMSP', 'NSP', 'OTHER'], broadcastable: method !== 'GET', urlParty: party(tail) };
      case 'sessions':
        if (tail.length !== 3) throw new HubError(404, 2000, 'expected receiver/sessions/{country_code}/{party_id}/{session_id}');
        if (!['GET', 'PUT', 'PATCH'].includes(method)) throw methodNotAllowed(method, what);
        return { ...base, callerRoles: CPO, targetRoles: EMSP_SIDE, urlParty: party(tail) };
      case 'cdrs':
        if (tail.length === 0) {
          if (method !== 'POST') throw methodNotAllowed(method, what);
          return { ...base, callerRoles: CPO, targetRoles: EMSP_SIDE };
        }
        if (tail.length === 1 && method === 'GET') return { ...base, kind: 'cdr_location', callerRoles: CPO, targetRoles: EMSP_SIDE };
        throw new HubError(404, 2000, 'expected POST receiver/cdrs or GET receiver/cdrs/{id} (the Location the hub gave)');
      case 'tokens':
        if (tail.length !== 3) throw new HubError(404, 2000, 'expected receiver/tokens/{country_code}/{party_id}/{token_uid}[?type=]');
        if (!['GET', 'PUT', 'PATCH'].includes(method)) throw methodNotAllowed(method, what);
        return { ...base, callerRoles: ['EMSP', 'OTHER'], targetRoles: CPO, broadcastable: method !== 'GET', urlParty: party(tail) };
      case 'commands':
        if (tail.length !== 1 || method !== 'POST') throw new HubError(404, 2000, 'expected POST receiver/commands/{command}');
        return { ...base, segs: [tail[0]!.toUpperCase()], callerRoles: ['EMSP', 'OTHER'], targetRoles: CPO, flag: 'commands' };
      case 'chargingprofiles':
        if (tail.length !== 1) throw new HubError(404, 2000, 'expected receiver/chargingprofiles/{session_id}');
        if (!['GET', 'PUT', 'DELETE'].includes(method)) throw methodNotAllowed(method, what);
        return { ...base, callerRoles: ['EMSP', 'SCSP', 'OTHER'], targetRoles: CPO, flag: 'chargingprofiles' };
    }
  }
  // sender interfaces: the caller pulls (or answers a callback)
  switch (m) {
    case 'locations':
      if (method !== 'GET' || tail.length > 3) throw methodNotAllowed(method, what);
      return { ...base, callerRoles: EMSP_SIDE, targetRoles: CPO, list: tail.length === 0 };
    case 'tariffs':
    case 'cdrs':
      if (method !== 'GET' || tail.length > 0) throw methodNotAllowed(method, what);
      return { ...base, callerRoles: EMSP_SIDE, targetRoles: CPO, list: true };
    case 'sessions':
      if (method === 'GET' && tail.length === 0) return { ...base, callerRoles: EMSP_SIDE, targetRoles: CPO, list: true };
      if (method === 'PUT' && tail.length === 2 && tail[1] === 'charging_preferences') return { ...base, callerRoles: EMSP_SIDE, targetRoles: CPO, flag: 'chargingprofiles' };
      throw methodNotAllowed(method, what);
    case 'tokens':
      if (method === 'GET' && tail.length === 0) return { ...base, callerRoles: CPO, targetRoles: ['EMSP', 'OTHER'], list: true };
      if (method === 'POST' && tail.length === 2 && tail[1] === 'authorize') return { ...base, callerRoles: CPO, targetRoles: ['EMSP', 'OTHER'], flag: 'realtime', realtime: true };
      throw methodNotAllowed(method, what);
    case 'commands':
      if (method === 'POST' && tail.length === 2) return { ...base, kind: 'callback_command', segs: [tail[0]!.toUpperCase(), tail[1]!], callerRoles: CPO, targetRoles: ['EMSP', 'OTHER'] };
      throw new HubError(404, 2000, 'sender/commands only takes the results of commands, at the response_url the hub gave');
    case 'chargingprofiles':
      if (method === 'POST' && tail.length === 2 && tail[0] === 'result') return { ...base, kind: 'callback_profile', callerRoles: CPO, targetRoles: ['EMSP', 'SCSP', 'OTHER'] };
      if (method === 'PUT' && tail.length === 1) return { ...base, callerRoles: CPO, targetRoles: ['EMSP', 'SCSP', 'OTHER'], flag: 'chargingprofiles' };
      throw methodNotAllowed(method, what);
  }
  throw new HubError(404, 2000, 'unknown hub endpoint');
}

/** Well-formed OCPI-from / OCPI-to headers (upper-cased), or null. */
export function partyHeader(h: Record<string, unknown>, dir: 'from' | 'to'): { country_code: string; party_id: string } | null {
  const cc = h[`ocpi-${dir}-country-code`];
  const pid = h[`ocpi-${dir}-party-id`];
  if (typeof cc !== 'string' || typeof pid !== 'string' || !/^[A-Za-z]{2}$/.test(cc) || !/^[A-Za-z0-9]{3}$/.test(pid)) return null;
  return { country_code: cc.toUpperCase(), party_id: pid.toUpperCase() };
}

/**
 * The calling party (§5.2 step 6), pure: OCPI-from must be a party of THIS connection in a role fit for the
 * interface, CONNECTED or OFFLINE. Without headers it is inferred only when exactly one party fits.
 */
export function pickFrom(own: HubParty[], header: { country_code: string; party_id: string } | null, roles: readonly string[]): HubParty {
  if (header) {
    const same = own.filter((p) => p.country_code === header.country_code && p.party_id === header.party_id);
    if (!same.length) throw fromMismatch(`OCPI-from ${label(header)} does not belong to this connection`);
    const fit = same.filter((p) => roles.includes(p.role));
    if (!fit.length) throw fromMismatch(`OCPI-from ${label(header)} is not registered on this connection as ${roles.join(' or ')}`);
    const live = fit.find((p) => p.status === 'CONNECTED' || p.status === 'OFFLINE');
    if (!live) throw new HubError(403, 2000, `${label(header)} is ${fit[0]!.status} on the hub`);
    return live;
  }
  const fit = own.filter((p) => roles.includes(p.role) && (p.status === 'CONNECTED' || p.status === 'OFFLINE'));
  if (fit.length === 1) return fit[0]!;
  throw invalid(fit.length ? 'OCPI-from-country-code and OCPI-from-party-id are required: this connection has several parties' : `this connection has no active party as ${roles.join(' or ')}`);
}

// ─────────────────────────────────────────────── the request context and response

export interface HubResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface Ctx {
  conn: HubConnection;
  cls: Classified;
  method: string;
  /** Raw query (parsed). */
  query: Record<string, unknown>;
  /** Raw query string (as received, for pass-through). */
  search: string;
  body: any;
  headers: Record<string, unknown>;
  correlationId: string;
  requestIdIn: string | null;
  capture: boolean;
  /** Filled by the router, for the 'in' log row. */
  log: { route: string; from: string | null; to: string | null };
}

const routingHeaders = (from: { country_code: string; party_id: string } | null, to: { country_code: string; party_id: string } | null): Record<string, string> => ({
  ...(from ? { 'ocpi-from-country-code': from.country_code, 'ocpi-from-party-id': from.party_id } : {}),
  ...(to ? { 'ocpi-to-country-code': to.country_code, 'ocpi-to-party-id': to.party_id } : {}),
});

/** An answer from the hub itself: OCPI-from = the hub party, OCPI-to = the requester. */
export function hubAnswer(status: number, body: unknown, requester: HubParty | null, extra: Record<string, string> = {}): HubResponse {
  return { status, body, headers: { ...routingHeaders(requester ? selfPartyFor(requester.country_code) : null, requester), ...extra } };
}

const enc = (segs: string[]) => segs.map((s) => '/' + encodeURIComponent(s)).join('');

// ─────────────────────────────────────────────── entry point

export async function routeFunctional(ctx: Ctx): Promise<HubResponse> {
  const { cls } = ctx;
  const own = await partiesOfConnection(ctx.conn.id);
  const from = pickFrom(own, partyHeader(ctx.headers, 'from'), cls.callerRoles);
  ctx.log.from = label(from);
  try {
    if (cls.kind === 'callback_command' || cls.kind === 'callback_profile') return await routeCallback(ctx, from);
    if (cls.kind === 'cdr_location') return await routeCdrLocation(ctx, from);

    // Client-owned object URLs carry the owner: it must be the caller; a body's own party must match the URL.
    if (cls.urlParty && (cls.urlParty.country_code !== from.country_code || cls.urlParty.party_id !== from.party_id)) {
      throw invalid(`the URL names ${label(cls.urlParty)}, but the request is from ${label(from)}: a party only sends its own objects`);
    }
    if (cls.urlParty && cls.segs.length === 3 && ctx.body && typeof ctx.body === 'object' && (ctx.method === 'PUT' || ctx.method === 'PATCH')) {
      const b = ctx.body as Record<string, unknown>;
      if ((b.country_code !== undefined && b.country_code !== cls.urlParty.country_code) || (b.party_id !== undefined && b.party_id !== cls.urlParty.party_id)) {
        throw invalid('country_code and party_id in the body must match the URL');
      }
    }
    if (cls.module === 'cdrs' && cls.iface === 'receiver' && ctx.body && typeof ctx.body === 'object') {
      const b = ctx.body as Record<string, unknown>;
      if (b.country_code !== from.country_code || b.party_id !== from.party_id) throw invalid('a CDR\'s country_code and party_id must be the sending CPO\'s');
    }

    // Hub cursor (a page after the first of a direct GET or a GET All).
    if (cls.list && typeof ctx.query.hub_cursor === 'string') return await routeCursor(ctx, from, String(ctx.query.hub_cursor));

    const toH = partyHeader(ctx.headers, 'to');
    const toHub = !!toH && isSelfParty(toH.country_code, toH.party_id);
    if (toH && !toHub) {
      const candidates = (await partyByKey(toH.country_code, toH.party_id)).filter((p) => cls.targetRoles.includes(p.role));
      if (!candidates.length) throw unknownReceiver(`${label(toH)} is not on the hub as ${cls.targetRoles.join('/')}`);
      ctx.log.route = 'direct';
      ctx.log.to = label(toH);
      return await routeDirect(ctx, from, candidates[0]!);
    }
    ctx.log.to = toHub ? 'HUB' : null;
    if (cls.broadcastable) {
      ctx.log.route = 'broadcast';
      return await routeBroadcast(ctx, from);
    }
    if (cls.list) {
      if (cls.module === 'sessions' && !ctx.query.date_from) throw invalid('date_from is required');
      ctx.log.route = toHub ? 'get_all' : 'get_all_open';
      return await routeGetAll(ctx, from, null);
    }
    if (toHub && (ctx.method === 'GET')) throw invalid('GET is not broadcast (OCPI 2.2.1): address one party with OCPI-to-*');
    // to = the hub on a module that is not broadcast: treated as open routing (a PlugSure tenant addresses
    // the hub when it does not know the party, e.g. a command by location).
    ctx.log.route = 'open';
    const target = await resolveOpenTarget(ctx, from);
    ctx.log.to = label(target);
    return await routeDirect(ctx, from, target);
  } catch (e) {
    if (e instanceof HubError) {
      return hubAnswer(e.http, envelope(undefined, e.ocpi, e.message), from, e.headers);
    }
    throw e;
  }
}

// ─────────────────────────────────────────────── open routing (§5.3 "O")

async function resolveOpenTarget(ctx: Ctx, from: HubParty): Promise<HubParty> {
  const { cls } = ctx;
  const b = (ctx.body ?? {}) as Record<string, any>;
  const load = (id: string) => getParty(id);
  const byParty = async (cc: unknown, pid: unknown) => {
    if (typeof cc !== 'string' || typeof pid !== 'string') throw unknownReceiver('the body names no eMSP (cdr_token.country_code / party_id)');
    const t = (await partyByKey(cc.toUpperCase(), pid.toUpperCase())).filter((p) => cls.targetRoles.includes(p.role))[0];
    if (!t) throw unknownReceiver(`${cc}*${pid} is not on the hub`);
    return t;
  };
  if (cls.iface === 'receiver') {
    switch (cls.module) {
      case 'sessions':
        if (ctx.method === 'PUT') return byParty(b.cdr_token?.country_code, b.cdr_token?.party_id);
        if (ctx.method === 'PATCH') {
          // The session's eMSP, as learned from its PUT (owner = this CPO).
          const e = await one<{ counter_party_id: string | null }>(
            `SELECT counter_party_id FROM hub_route_index WHERE kind = 'session' AND key = $1 AND owner_party_id = $2`, [cls.segs[2], from.id]);
          const t = e?.counter_party_id ? await getParty(e.counter_party_id) : null;
          if (!t) throw unknownReceiver(`session ${cls.segs[2]} is unknown to the hub: PUT it first, or send OCPI-to-*`);
          return t;
        }
        throw unknownReceiver('GET of a session copy needs OCPI-to-*');
      case 'cdrs':
        return byParty(b.cdr_token?.country_code, b.cdr_token?.party_id);
      case 'commands': {
        const cmd = cls.segs[0];
        if (cmd === 'START_SESSION' || cmd === 'RESERVE_NOW' || cmd === 'UNLOCK_CONNECTOR') {
          return (await resolveOpen('location', typeof b.location_id === 'string' ? b.location_id : null, from, { targetRoles: CPO, flag: 'commands' }, load)).target;
        }
        if (cmd === 'STOP_SESSION') {
          return (await resolveOpen('session', typeof b.session_id === 'string' ? b.session_id : null, from, { targetRoles: CPO, flag: 'commands', requireCounter: true }, load)).target;
        }
        if (cmd === 'CANCEL_RESERVATION') {
          return (await resolveOpen('reservation', typeof b.reservation_id === 'string' ? b.reservation_id : null, from, { targetRoles: CPO, flag: 'commands', requireCounter: true }, load)).target;
        }
        throw unknownReceiver(`command ${cmd}: send OCPI-to-*`);
      }
      case 'chargingprofiles':
        return (await resolveOpen('session', cls.segs[0], from, { targetRoles: CPO, flag: 'chargingprofiles', requireCounter: true }, load)).target;
      default:
        throw unknownReceiver(`${cls.module}: send OCPI-to-*`);
    }
  }
  switch (cls.module) {
    case 'locations':
      return (await resolveOpen('location', cls.segs[0], from, { targetRoles: CPO }, load)).target;
    case 'sessions':
      return (await resolveOpen('session', cls.segs[0], from, { targetRoles: CPO, requireCounter: true, flag: 'chargingprofiles' }, load)).target;
    case 'tokens': {
      const type = typeof ctx.query.type === 'string' ? ctx.query.type : 'RFID';
      return (await resolveOpen('token', `${cls.segs[0]}:${type}`, from, { targetRoles: ['EMSP', 'OTHER'], flag: 'realtime' }, load)).target;
    }
    case 'chargingprofiles': {
      // ActiveChargingProfile from the CPO: to whoever set the profile on that session, else the session's eMSP.
      const set = await one<{ owner_party_id: string }>(
        `SELECT owner_party_id FROM hub_route_index WHERE kind = 'command_session' AND key = $1 AND counter_party_id = $2
          AND (expires_at IS NULL OR expires_at > now()) ORDER BY updated_at DESC LIMIT 1`, [cls.segs[0], from.id]);
      const sess = set ? null : await one<{ counter_party_id: string | null }>(
        `SELECT counter_party_id FROM hub_route_index WHERE kind = 'session' AND key = $1 AND owner_party_id = $2`, [cls.segs[0], from.id]);
      const id = set?.owner_party_id ?? sess?.counter_party_id;
      const t = id ? await getParty(id) : null;
      if (!t) throw unknownReceiver(`session ${cls.segs[0]}: no profile setter known; send OCPI-to-*`);
      return t;
    }
    default:
      throw unknownReceiver(`${cls.module}: send OCPI-to-*`);
  }
}

// ─────────────────────────────────────────────── direct (one receiver)

/** The receiver must be reachable now (synchronous route): CONNECTED, on a connected connection. */
async function reachable(target: HubParty): Promise<HubConnection> {
  if (target.status === 'SUSPENDED' || target.status === 'PLANNED') throw notConnected(`${label(target)} is ${target.status} on the hub`);
  if (target.status === 'OFFLINE') throw notConnected(`${label(target)} is OFFLINE`);
  const c = target.connection_id ? await getConnection(target.connection_id) : null;
  if (!c || c.state !== 'connected') throw notConnected(`${label(target)} is not connected`);
  return c;
}

async function checkAgreement(from: HubParty, target: HubParty, flag: ModuleFlag): Promise<string | null> {
  const v = await mayRoute(from, target, flag);
  if (!v.ok) {
    if (v.code === 2001) throw invalid(v.reason!);
    throw new HubError(403, HUB_STATUS.NO_AGREEMENT, v.reason!);
  }
  return v.agreement?.id ?? null;
}

const idemp = new Map<string, { at: number; p: Promise<HubResponse> }>();
const IDEMP_MS = 10 * 60_000;

async function routeDirect(ctx: Ctx, from: HubParty, target: HubParty): Promise<HubResponse> {
  const { cls } = ctx;
  const agreementId = await checkAgreement(from, target, cls.flag);
  const conn = await reachable(target);
  // Commands: a repeated X-Request-ID from the same connection gets the first answer (§5.7).
  if (cls.module === 'commands') {
    if (!ctx.requestIdIn) return forwardCommand(ctx, from, target, conn);
    const k = `${ctx.conn.id}:${ctx.requestIdIn}`;
    const hit = idemp.get(k);
    if (hit && Date.now() - hit.at < IDEMP_MS) return hit.p;
    const p = forwardCommand(ctx, from, target, conn);
    idemp.set(k, { at: Date.now(), p });
    if (idemp.size > 10_000) for (const [key, v] of idemp) if (Date.now() - v.at > IDEMP_MS || idemp.size > 10_000) idemp.delete(key);
    return p;
  }
  if (cls.module === 'cdrs' && cls.iface === 'receiver') return forwardCdr(ctx, from, target, conn, agreementId);
  if (cls.list) return forwardList(ctx, from, target, conn, null);
  return forwardSimple(ctx, from, target, conn);
}

function endpointOf(conn: HubConnection, cls: Classified, target: HubParty): string {
  const ep = endpointUrl(conn, cls.module, cls.iface === 'receiver' ? 'RECEIVER' : 'SENDER');
  if (!ep) throw notConnected(`${label(target)} does not implement ${cls.module} ${cls.iface === 'receiver' ? 'RECEIVER' : 'SENDER'}`);
  return ep;
}

const timeoutOf = (cls: Classified) => (cls.realtime ? config.hub.realtimeTimeoutMs : config.hub.forwardTimeoutMs);

/** Map a leg's failure to the hub error the requester gets (4002 timeout, 4003 connection). */
function legFailure(r: HubCallResult, target: HubParty, requester: HubParty): HubResponse | null {
  if (r.httpStatus != null && !r.failure) return null;
  const code = r.failure === 'timeout' ? HUB_STATUS.TIMEOUT : HUB_STATUS.CONNECTION;
  const msg = r.failure === 'timeout' ? `${label(target)} did not answer in time` : `${label(target)} could not be reached (${r.error ?? 'no answer'})`;
  return hubAnswer(200, envelope(undefined, code, msg), requester);
}

/** Relay the receiver's answer: its HTTP status and envelope; OCPI-from = receiver, OCPI-to = requester. */
function relay(r: HubCallResult, target: HubParty, requester: HubParty, extra: Record<string, string> = {}): HubResponse {
  const headers: Record<string, string> = { ...routingHeaders(target, requester), ...extra };
  for (const h of ['x-total-count', 'x-limit']) {
    const v = r.headers[h];
    if (typeof v === 'string' && /^\d{1,10}$/.test(v)) headers[h] = v;
  }
  if (!r.json || typeof r.json !== 'object' || typeof r.json.status_code !== 'number') {
    return { status: 200, body: envelope(undefined, HUB_STATUS.GENERIC, `${label(target)} answered without an OCPI envelope (HTTP ${r.httpStatus})`), headers };
  }
  return { status: r.httpStatus ?? 200, body: r.json, headers };
}

async function forwardSimple(ctx: Ctx, from: HubParty, target: HubParty, conn: HubConnection): Promise<HubResponse> {
  const { cls } = ctx;
  let body = ctx.body;
  let search = ctx.search;
  // Charging profiles: the response_url goes through the hub (§5.6).
  if (cls.module === 'chargingprofiles' && cls.iface === 'receiver') {
    const original = ctx.method === 'PUT' ? body?.response_url : ctx.query.response_url;
    if (typeof original === 'string' && original) {
      const id = await createCallback('profile_result', from, target, original, null, cls.segs[0]!, null, 24 * 3600);
      const url = profileCallbackUrl(hubBase(), id);
      if (ctx.method === 'PUT') body = withResponseUrl(body ?? {}, url);
      else search = queryWithResponseUrl(ctx.query, url);
    }
  }
  const url = endpointOf(conn, cls, target) + enc(cls.segs) + (search ? `?${search}` : '');
  const r = await hubCall({
    conn, method: ctx.method, url, body: ctx.method === 'GET' || ctx.method === 'DELETE' ? undefined : body, from, to: target,
    correlationId: ctx.correlationId, requestIdIn: ctx.requestIdIn, timeoutMs: timeoutOf(cls), route: ctx.log.route, module: cls.module,
    capture: ctx.capture,
  });
  const fail = legFailure(r, target, from);
  if (fail) return fail;
  if (r.ok) await afterForward(ctx, from, target, r);
  return relay(r, target, from);
}

/** What the router learns from a successful forward (§5.3 last column). */
async function afterForward(ctx: Ctx, from: HubParty, target: HubParty, r: HubCallResult): Promise<void> {
  const { cls } = ctx;
  const b = (ctx.body ?? {}) as Record<string, any>;
  if (cls.iface === 'receiver' && cls.module === 'sessions' && ctx.method === 'PUT') {
    await learn('session', cls.segs[2], from, target, { status: b.status ?? null });
  }
  // The profile setter of a session (where the CPO's ActiveChargingProfile updates go): learned only once the
  // CPO ACCEPTED the profile. Learned before forwarding, any eMSP with an agreement could name another eMSP's
  // session, be refused by the CPO, and still receive that session's ActiveChargingProfile updates.
  if (cls.iface === 'receiver' && cls.module === 'chargingprofiles' && ctx.method === 'PUT' && r.json?.data?.result === 'ACCEPTED') {
    await learn('command_session', cls.segs[0], from, target);
  }
  if (cls.iface === 'sender' && cls.module === 'tokens' && cls.realtime) {
    const ref = r.json?.data?.authorization_reference;
    if (typeof ref === 'string') {
      await learn('authorization', ref, target, from, { location_id: b.location_id ?? null, allowed: r.json?.data?.allowed ?? null, via: 'AUTH_REQUEST' });
    }
  }
}

async function forwardCommand(ctx: Ctx, from: HubParty, target: HubParty, conn: HubConnection): Promise<HubResponse> {
  const { cls } = ctx;
  const cmd = cls.segs[0]!;
  const b = (ctx.body && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, any>;
  const original = typeof b.response_url === 'string' ? b.response_url : '';
  if (!original) return hubAnswer(400, envelope(undefined, 2001, 'response_url is required'), from);
  const ref = cmd === 'STOP_SESSION' ? b.session_id : cmd === 'START_SESSION' ? b.authorization_reference : (b.reservation_id ?? null);
  const id = await createCallback('command_result', from, target, original, cmd, typeof ref === 'string' ? ref : null, 1, config.hub.callbackTtlS);
  const body = withResponseUrl(b, commandCallbackUrl(hubBase(), cmd, id));
  const url = endpointOf(conn, cls, target) + `/${encodeURIComponent(cmd)}`;
  const r = await hubCall({
    conn, method: 'POST', url, body, from, to: target, correlationId: ctx.correlationId, requestIdIn: ctx.requestIdIn,
    timeoutMs: config.hub.forwardTimeoutMs, route: ctx.log.route, module: 'commands', capture: ctx.capture,
  });
  const fail = legFailure(r, target, from);
  if (fail) return fail;
  if (r.ok) {
    if (cmd === 'START_SESSION' && typeof b.authorization_reference === 'string') {
      await learn('authorization', b.authorization_reference, from, target, { location_id: b.location_id ?? null, via: 'COMMAND', callback: id });
    }
    if (cmd === 'RESERVE_NOW' && typeof b.reservation_id === 'string') await learn('reservation', b.reservation_id, target, from);
  }
  return relay(r, target, from);
}

// ─────────────────────────────────────────────── callbacks (§5.6 "Callback inbound")

interface CallbackRow {
  id: string; kind: string; origin_party_id: string; target_party_id: string; original_url: string; command: string | null;
  ref: string | null; body: any; uses: number; max_uses: number | null; expires_at: Date;
}

export async function createCallback(
  kind: 'command_result' | 'profile_result' | 'cdr_location', origin: HubParty, target: HubParty, originalUrl: string,
  command: string | null, ref: string | null, maxUses: number | null, ttlS: number, body: unknown = null,
): Promise<string> {
  if (originalUrl) {
    // Our own origin is in-process: only for an INTERNAL member (a tenant's /ocpi), never for an external one
    // (it would make the hub call our own API on its behalf).
    const originConn = isInprocUrl(originalUrl) && origin.connection_id ? await getConnection(origin.connection_id) : null;
    const p = isInprocUrl(originalUrl)
      ? (originConn?.kind === 'internal' && inprocPathAllowed(originalUrl) ? null : 'a URL on the hub\'s own address is not accepted')
      : memberUrlProblem(originalUrl);
    if (p) throw invalid(`${kind === 'cdr_location' ? 'Location' : 'response_url'}: ${p}`);
  }
  const id = newCallbackId();
  await query(
    `INSERT INTO hub_callback (id, kind, origin_party_id, target_party_id, original_url, command, ref, body, max_uses, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(secs => $10::int))`,
    [id, kind, origin.id, target.id, originalUrl ? seal(originalUrl, `hub_callback:${id}`) : '', command, ref, body == null ? null : JSON.stringify(body), maxUses, ttlS],
  );
  return id;
}

async function loadCallback(id: string, kind: string): Promise<CallbackRow | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  return one<CallbackRow>(`SELECT * FROM hub_callback WHERE id = $1 AND kind = $2 AND expires_at > now()`, [id, kind]);
}

async function routeCallback(ctx: Ctx, from: HubParty): Promise<HubResponse> {
  const { cls } = ctx;
  const command = cls.kind === 'callback_command';
  const id = cls.segs[1]!;
  ctx.log.route = 'callback';
  const cb = await loadCallback(id, command ? 'command_result' : 'profile_result');
  if (!cb) return hubAnswer(404, envelope(undefined, 2000, 'unknown or expired callback'), from);
  const target = await getParty(cb.target_party_id);
  // Only the party the command was sent to may post its result, through its own connection.
  if (!target || target.connection_id !== ctx.conn.id) return hubAnswer(403, envelope(undefined, 2000, 'this callback is not for this connection'), from);
  if (target.id !== from.id) throw fromMismatch(`this result is expected from ${label(target)}, not ${label(from)}`);
  if (command && cb.command && cls.segs[0] !== cb.command) return hubAnswer(404, envelope(undefined, 2000, 'unknown or expired callback'), from);
  const origin = await getParty(cb.origin_party_id);
  if (!origin?.connection_id) return hubAnswer(200, envelope(undefined, HUB_STATUS.CONNECTION, 'the requester is no longer on the hub'), from);
  ctx.log.to = label(origin);
  // At most max_uses (1 for a command result): a repeat is answered 1000 and not forwarded again.
  const used = await one<{ uses: number }>(
    `UPDATE hub_callback SET uses = uses + 1 WHERE id = $1 AND (max_uses IS NULL OR uses < max_uses) RETURNING uses`, [cb.id]);
  if (!used) return { status: 200, body: envelope(undefined), headers: routingHeaders(origin, from) };
  await enqueueHub({
    kind: 'callback', originPartyId: from.id, recipientConnectionId: origin.connection_id, recipientPartyId: origin.id,
    module: command ? 'commands' : 'chargingprofiles', method: 'POST', url: unseal(cb.original_url, `hub_callback:${cb.id}`),
    body: ctx.body ?? {}, objectKey: `callback:${cb.id}:${used.uses}`, correlationId: ctx.correlationId,
  });
  if (command && cb.command === 'START_SESSION' && cb.ref && ctx.body?.result === 'ACCEPTED') {
    await markData('authorization', cb.ref, origin.id, { confirmed: true });
  }
  kickHubOutbox();
  return { status: 200, body: envelope(undefined), headers: routingHeaders(origin, from) };
}

// ─────────────────────────────────────────────── CDRs (push), Location rewrite, ledger tap

const partyRef = (p: HubParty): CdrPartyRef => ({ id: p.id, country_code: p.country_code, party_id: p.party_id, role: p.role, member_id: p.member_id, org_id: p.org_id });

function sameCdrTotals(a: any, b: any): boolean {
  const pick = (c: any) => JSON.stringify([c?.currency, c?.total_cost?.excl_vat, c?.total_cost?.incl_vat, c?.total_energy, c?.credit ?? false]);
  return pick(a) === pick(b);
}

async function forwardCdr(ctx: Ctx, from: HubParty, target: HubParty, conn: HubConnection, agreementId: string | null): Promise<HubResponse> {
  const cdr = ctx.body as Record<string, any>;
  if (!cdr || typeof cdr !== 'object' || typeof cdr.id !== 'string' || !cdr.id || cdr.id.length > 39) throw invalid('a CDR needs an id (at most 39 characters)');
  // OCPI 2.2.1 CdrToken carries the eMSP that issued the token (country_code, party_id: required). A CDR is
  // that eMSP's: sent to another eMSP it would hand one provider's driver data to a competitor and bill the
  // wrong member. Refused (2001, not forwarded, not recorded) rather than held: the receiver is wrong, so
  // forwarding it at all is the harm. The open route already addresses the token's eMSP.
  const tok = cdr.cdr_token as Record<string, unknown> | undefined;
  const tcc = typeof tok?.country_code === 'string' ? tok.country_code.toUpperCase() : null;
  const tpid = typeof tok?.party_id === 'string' ? tok.party_id.toUpperCase() : null;
  if (tcc !== target.country_code || tpid !== target.party_id) {
    throw invalid(`cdr_token names ${tcc ?? '?'}*${tpid ?? '?'}, but the CDR is addressed to ${label(target)}: a CDR goes to the eMSP of its token`);
  }
  const base = hubBase();
  // Duplicate (same CPO party, same CDR id): answered from the hub's state, not forwarded again (§5.7).
  const prev = await one<{ id: string; body: any }>(
    `SELECT id, body FROM hub_callback WHERE kind = 'cdr_location' AND target_party_id = $1 AND ref = $2 ORDER BY created_at LIMIT 1`, [from.id, cdr.id]);
  if (prev) {
    if (!sameCdrTotals(prev.body, cdr)) throw invalid('this CDR id was already used with different content: send a credit CDR (and a new CDR) instead');
    return { status: 200, body: envelope(undefined), headers: { ...routingHeaders(target, from), location: cdrLocationUrl(base, prev.id) } };
  }
  const routing: CdrRoutedEvent['routing'] = {
    correlation_id: ctx.correlationId, request_id_in: ctx.requestIdIn, request_id_out: null, route: ctx.log.route === 'open' ? 'open' : 'direct',
    from_connection_id: ctx.conn.id, to_connection_id: conn.id, hub_location: null,
  };
  const event = cdrEvent(cdr, partyRef(from), partyRef(target), routing, 'push', agreementId);
  const refused = await admitCdr(event);
  if (refused) throw invalid(refused);
  const url = endpointOf(conn, ctx.cls, target);
  const r = await hubCall({
    conn, method: 'POST', url, body: cdr, from, to: target, correlationId: ctx.correlationId, requestIdIn: ctx.requestIdIn,
    timeoutMs: config.hub.forwardTimeoutMs, route: ctx.log.route, module: 'cdrs', capture: ctx.capture,
  });
  routing.request_id_out = r.requestId;
  const emspLocation = typeof r.headers.location === 'string' ? r.headers.location : null;
  let hubLocation: string | null = null;
  if (r.ok) {
    // The eMSP's Location goes through the hub (bound to this CPO party); without one the hub serves the CDR itself.
    let original = emspLocation ?? '';
    if (original && (isInprocUrl(original) ? !(conn.kind === 'internal' && inprocPathAllowed(original)) : memberUrlProblem(original))) original = '';
    const id = await createCallback('cdr_location', target, from, original, null, cdr.id, null, 3650 * 24 * 3600, cdr);
    hubLocation = cdrLocationUrl(base, id);
    routing.hub_location = hubLocation;
  }
  void onCdrRouted(event, {
    delivered: r.ok, http_status: r.httpStatus, ocpi_status: r.ocpiStatus, error: r.error, emsp_location: emspLocation,
  });
  const fail = legFailure(r, target, from);
  if (fail) return fail;
  return relay(r, target, from, hubLocation ? { location: hubLocation } : {});
}

async function routeCdrLocation(ctx: Ctx, from: HubParty): Promise<HubResponse> {
  ctx.log.route = 'callback';
  const cb = await loadCallback(ctx.cls.segs[0]!, 'cdr_location');
  // Bound to the CPO party that posted the CDR.
  if (!cb || cb.target_party_id !== from.id) return hubAnswer(404, envelope(undefined, 2000, 'unknown CDR'), from);
  const emsp = await getParty(cb.origin_party_id);
  ctx.log.to = label(emsp);
  if (!cb.original_url || !emsp) return { status: 200, body: envelope(cb.body), headers: routingHeaders(emsp ?? selfPartyFor(from.country_code), from) };
  const conn = await reachable(emsp).catch(() => null);
  if (!conn) return { status: 200, body: envelope(cb.body), headers: routingHeaders(emsp, from) };
  const r = await hubCall({
    conn, method: 'GET', url: unseal(cb.original_url, `hub_callback:${cb.id}`), from, to: emsp, correlationId: ctx.correlationId,
    requestIdIn: ctx.requestIdIn, timeoutMs: config.hub.forwardTimeoutMs, route: 'callback', module: 'cdrs',
  });
  if (!r.ok) return { status: 200, body: envelope(cb.body), headers: routingHeaders(emsp, from) };
  return relay(r, emsp, from);
}

// ─────────────────────────────────────────────── lists: direct GET with Link rewrite, GET All

/** Keep only what this source may hand this requester (defence in depth, §5.3 "Response filter"). */
export function filterObjects(module: string, items: unknown[], source: { country_code: string; party_id: string }, requester: { country_code: string; party_id: string }): { kept: any[]; dropped: number } {
  const kept: any[] = [];
  let dropped = 0;
  for (const o of items as any[]) {
    if (!o || typeof o !== 'object') { dropped++; continue; }
    const ownerOk = o.country_code === source.country_code && o.party_id === source.party_id;
    const tokenOk = module !== 'sessions' && module !== 'cdrs'
      || (o.cdr_token?.country_code === requester.country_code && o.cdr_token?.party_id === requester.party_id);
    if (ownerOk && tokenOk) kept.push(o); else dropped++;
  }
  return { kept, dropped };
}

async function afterListPage(ctx: Ctx, from: HubParty, source: HubParty, items: any[], route: 'direct' | 'get_all'): Promise<void> {
  const { cls } = ctx;
  if (cls.module === 'locations') for (const l of items) await learn('location', String(l.id ?? ''), source);
  if (cls.module === 'tokens') for (const t of items) await learn('token', `${t.uid}:${t.type ?? 'RFID'}`, source, null, { whitelist: t.whitelist ?? null });
  if (cls.module === 'cdrs') {
    const agreement = await mayRoute(from, source);
    for (const c of items) {
      void onCdrRouted(cdrEvent(c, partyRef(source), partyRef(from), {
        correlation_id: ctx.correlationId, request_id_in: ctx.requestIdIn, request_id_out: null, route, from_connection_id: ctx.conn.id,
        to_connection_id: source.connection_id, hub_location: null,
      }, 'pull', agreement.agreement?.id ?? null), null);
    }
  }
}

async function fetchPage(ctx: Ctx, from: HubParty, source: HubParty, url: string): Promise<{ r: HubCallResult; items: any[]; next: string | null; total: number | null } | null> {
  const conn = source.connection_id ? await getConnection(source.connection_id) : null;
  if (!conn || conn.state !== 'connected') return null;
  const r = await hubCall({
    conn, method: 'GET', url, from, to: source, correlationId: ctx.correlationId, requestIdIn: ctx.requestIdIn,
    timeoutMs: config.hub.forwardTimeoutMs, route: ctx.log.route, module: ctx.cls.module,
  });
  if (!r.ok || !Array.isArray(r.json?.data)) return { r, items: [], next: null, total: null };
  const { kept, dropped } = filterObjects(ctx.cls.module, r.json.data, source, from);
  if (dropped) {
    logger.warn({ source: label(source), requester: label(from), module: ctx.cls.module, filtered: dropped }, 'hub.response_filtered');
    alertResponseFiltered({ sourceConnectionId: source.connection_id, source: label(source), requester: label(from), module: ctx.cls.module, dropped });
  }
  // The next page must stay on the source's own endpoint origin (it is called with the source's token).
  const ep = endpointUrl(conn, ctx.cls.module, 'SENDER');
  let next = parseLinkNext(r.headers.link);
  if (next && (!ep || !sameOrigin(next, ep))) next = null;
  const t = Number(r.headers['x-total-count']);
  return { r, items: kept, next, total: Number.isFinite(t) ? t : null };
}

async function forwardList(ctx: Ctx, from: HubParty, target: HubParty, conn: HubConnection, cursor: Cursor | null): Promise<HubResponse> {
  const { cls } = ctx;
  const ep = endpointOf(conn, cls, target);
  const { q, limit } = cursor ? { q: cursor.q, limit: cursor.limit } : filtersOf(ctx.query);
  const url = cursor?.next ?? (ctx.search ? `${ep}${enc(cls.segs)}?${ctx.search}` : `${ep}${enc(cls.segs)}`);
  const page = await fetchPage(ctx, from, target, url);
  if (!page) throw notConnected(`${label(target)} is not connected`);
  const fail = legFailure(page.r, target, from);
  if (fail) return fail;
  if (!page.r.ok) return relay(page.r, target, from);
  await afterListPage(ctx, from, target, page.items, 'direct');
  const headers: Record<string, string> = {};
  if (page.next) {
    headers.link = linkNext(cursorUrl(hubBase(), cls.module, sealCursor({
      conn: ctx.conn.id, kind: 'direct', module: cls.module, from: from.id, src: [target.id], i: 0, next: page.next, q, limit, total: null,
    })));
  }
  const res = relay(page.r, target, from, headers);
  res.body = { ...(page.r.json as object), data: page.items };
  return res;
}

async function routeCursor(ctx: Ctx, from: HubParty, token: string): Promise<HubResponse> {
  const c = openCursor(token, ctx.conn.id);
  if (c === 'other_connection') throw new HubError(403, 2000, 'this page link belongs to another connection');
  if (c === 'expired') throw invalid('this page link has expired: start the list again');
  if (c === 'malformed') throw invalid('malformed hub_cursor');
  if (c.module !== ctx.cls.module) throw invalid('this page link is for another module');
  if (c.from !== from.id) throw fromMismatch('this page link was issued to another party of this connection');
  if (c.kind === 'direct') {
    const target = await getParty(c.src[0]!);
    if (!target) throw unknownReceiver('the source of this list is no longer on the hub');
    ctx.log.route = 'direct';
    ctx.log.to = label(target);
    await checkAgreement(from, target, null);
    return forwardList(ctx, from, target, await reachable(target), c);
  }
  ctx.log.route = 'get_all';
  ctx.log.to = 'HUB';
  return routeGetAll(ctx, from, c);
}

/**
 * GET All via the hub (§5.6 "GET All composite cursor"): the agreed sources (sorted by party), probed once
 * for their totals (X-Total-Count = the sum, kept in the cursor), then served one upstream page per hub page,
 * source after source. Sources that fail are skipped (and logged).
 */
async function routeGetAll(ctx: Ctx, from: HubParty, cursor: Cursor | null): Promise<HubResponse> {
  const { cls } = ctx;
  const { q, limit } = cursor ? { q: cursor.q, limit: cursor.limit } : filtersOf(ctx.query);
  let src: HubParty[];
  let total: number;
  if (cursor) {
    src = (await Promise.all(cursor.src.map((id) => getParty(id)))).filter((p): p is HubParty => !!p);
    total = cursor.total ?? 0;
  } else {
    const all = await agreedCounterparties(from, { statuses: ['CONNECTED'] });
    src = [];
    for (const p of all.filter((x) => cls.targetRoles.includes(x.role))) {
      const c = p.connection_id ? await getConnection(p.connection_id) : null;
      if (c && c.state === 'connected' && endpointUrl(c, cls.module, 'SENDER')) src.push(p);
    }
    src = src.slice(0, 200);
    // Probe every source for its total (limit=1), 8 at a time, with the real-time deadline.
    total = 0;
    for (let k = 0; k < src.length; k += 8) {
      const probes = await Promise.all(src.slice(k, k + 8).map(async (p) => {
        const conn = (await getConnection(p.connection_id!))!;
        const r = await hubCall({
          conn, method: 'GET', url: withQuery(endpointUrl(conn, cls.module, 'SENDER')!, q, 1, 0), from, to: p, correlationId: ctx.correlationId,
          requestIdIn: ctx.requestIdIn, timeoutMs: config.hub.realtimeTimeoutMs, route: 'get_all_probe', module: cls.module,
        });
        const n = Number(r.headers['x-total-count']);
        return r.ok && Number.isFinite(n) ? n : r.ok && Array.isArray(r.json?.data) ? r.json.data.length : 0;
      }));
      total += probes.reduce((a, b) => a + b, 0);
    }
  }
  let i = cursor?.i ?? 0;
  let next: string | null = cursor?.next ?? null;
  let items: any[] = [];
  let calls = 0;
  while (i < src.length && calls < 10) {
    const source = src[i]!;
    // Agreements are checked again on every page: one ended meanwhile stops that source.
    if (!(await mayRoute(from, source)).ok) { i++; next = null; continue; }
    const conn = source.connection_id ? await getConnection(source.connection_id) : null;
    const ep = conn ? endpointUrl(conn, cls.module, 'SENDER') : null;
    if (!conn || !ep) { i++; next = null; continue; }
    calls++;
    const page = await fetchPage(ctx, from, source, next ?? withQuery(ep, q, limit, 0));
    if (!page || !page.r.ok) { i++; next = null; continue; }
    await afterListPage(ctx, from, source, page.items, 'get_all');
    if (page.next) next = page.next; else { i++; next = null; }
    if (page.items.length) { items = page.items; break; }
  }
  const headers: Record<string, string> = { 'x-total-count': String(total), 'x-limit': String(limit) };
  if (i < src.length) {
    headers.link = linkNext(cursorUrl(hubBase(), cls.module, sealCursor({
      conn: ctx.conn.id, kind: 'all', module: cls.module, from: from.id, src: src.map((s) => s.id), i, next, q, limit, total,
    })));
  }
  return hubAnswer(200, envelope(items), from, headers);
}

// ─────────────────────────────────────────────── broadcast (§5.5)

export const FANOUT_CAP = 1000;

async function routeBroadcast(ctx: Ctx, from: HubParty): Promise<HubResponse> {
  const { cls } = ctx;
  if (ctx.method !== 'DELETE') {
    if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw invalid('a JSON object body is required');
    if (!ctx.body.last_updated) throw invalid('last_updated is required');
  }
  // The open-routing index keys locations by id and tokens by uid:type. A party broadcasting an id another live
  // party already holds would make every open-routed request about it ambiguous (4904) — a denial of service on
  // the other party's commands and real-time authorisations. First holder wins; the newcomer is refused and may
  // still address each counterparty directly (OCPI-to), which the index does not learn from.
  const tokenKey = cls.module === 'tokens' ? `${cls.segs[2]}:${typeof ctx.query.type === 'string' ? ctx.query.type : (ctx.body?.type ?? 'RFID')}` : null;
  const indexKey = cls.module === 'locations' ? ['location', cls.segs[2]] : tokenKey && ctx.method !== 'DELETE' ? ['token', tokenKey] : null;
  if (indexKey) {
    const held = await one<{ cc: string; pid: string }>(
      `SELECT p.country_code AS cc, p.party_id AS pid FROM hub_route_index i JOIN hub_party p ON p.id = i.owner_party_id JOIN hub_member m ON m.id = p.member_id
        WHERE i.kind = $1 AND i.key = $2 AND i.owner_party_id <> $3 AND (i.expires_at IS NULL OR i.expires_at > now())
          AND p.status <> 'SUSPENDED' AND m.status <> 'terminated' LIMIT 1`, [indexKey[0], indexKey[1], from.id]);
    if (held) {
      throw invalid(`${indexKey[0]} ${String(indexKey[1]).slice(0, 40)} is already published through the hub by ${held.cc}*${held.pid}: `
        + 'a broadcast cannot reuse it (send it to each counterparty with OCPI-to-*, or use another id)');
    }
  }
  const recipientRoles = cls.module === 'tokens' ? ['CPO'] : ['EMSP', 'NSP', 'OTHER'];
  const peers = (await agreedCounterparties(from, { statuses: ['CONNECTED'] })).filter((p) => recipientRoles.includes(p.role));
  const pathSuffix = enc(cls.segs) + (ctx.search ? `?${ctx.search}` : '');
  const objectKey = `${cls.module}:${cls.segs[0]}:${cls.segs[1]}:${cls.segs[2]}`.slice(0, 300);
  let n = 0;
  for (const p of peers.slice(0, FANOUT_CAP)) {
    const c = p.connection_id ? await getConnection(p.connection_id) : null;
    if (!c || c.state !== 'connected' || !endpointUrl(c, cls.module, 'RECEIVER')) continue;
    const id = await enqueueHub({
      kind: 'broadcast', originPartyId: from.id, recipientConnectionId: c.id, recipientPartyId: p.id, module: cls.module,
      method: ctx.method as 'PUT', pathSuffix, body: ctx.method === 'DELETE' ? undefined : ctx.body, objectKey, correlationId: ctx.correlationId,
    });
    if (id) n++;
  }
  if (peers.length > FANOUT_CAP) logger.warn({ from: label(from), recipients: peers.length }, 'hub broadcast fan-out capped');
  // Learn: where locations and tokens live, for open routing later.
  if (cls.module === 'locations') await learn('location', cls.segs[2], from);
  if (cls.module === 'tokens' && ctx.method !== 'DELETE') {
    await learn('token', `${cls.segs[2]}:${typeof ctx.query.type === 'string' ? ctx.query.type : (ctx.body?.type ?? 'RFID')}`, from, null, { whitelist: ctx.body?.whitelist ?? null });
  }
  ctx.log.to = `HUB (${n})`;
  if (n) kickHubOutbox();
  // The hub answers the broadcaster at once (spec), then fans out.
  return hubAnswer(200, envelope(undefined), from);
}

