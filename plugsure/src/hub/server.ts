import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../logger.js';
import { routePath, underPrefix } from '../api/route-path.js';
import { OCPI_VERSION, envelope, paging, tokenHash, tokensFromAuthHeader } from '../ocpi/mapping.js';
import { TokenBuckets } from '../services/ratelimit.js';
import { clientInfoOf, noteInbound, pushClientInfoAbout, pushClientInfoTo, visibleTo } from './clientinfo.js';
import { closeConnection, currentHubCredentials, hubVersions, registerMember } from './credentials.js';
import { HUB_STATUS, HubError } from './errors.js';
import { hubAudit } from './lifecycle.js';
import { logHub } from './log.js';
import { classify, routeFunctional, type Ctx, type HubResponse } from './router.js';
import { connectionByTokenHash, ensureSelfParties, getMember, hubBase, hubEndpoints } from './registry.js';
import type { HubConnection } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    hubCtx?: {
      conn: HubConnection;
      started: number;
      correlationId: string;
      requestIdIn: string | null;
      log: { route: string; from: string | null; to: string | null };
      module: string | null;
      ocpiStatus: number | null;
      capture: boolean;
      body?: unknown;
    };
  }
}

/**
 * The hub's OCPI surface (design D1): /hub/ocpi/versions and /hub/ocpi/2.2.1/…, served on HUB_PUBLIC_URL,
 * authenticated by hub_connection tokens (its own namespace; never a tenant's partner token). Mounted only
 * when HUB_ENABLED. The tenants' /ocpi surface is untouched: its hooks test underPrefix('/ocpi/'), which
 * /hub/ocpi/… never matches, and these hooks test '/hub/ocpi/' only.
 */

export const HUB_PREFIX = '/hub/ocpi/';
const V = `/hub/ocpi/${OCPI_VERSION}`;

// Echo only well-formed ids (a caller's header is never trusted verbatim).
const idLike = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(v) ? v : null);

/** Per-connection token buckets (design §5.2 step 2): one for all traffic, one for real-time authorisation. */
export const hubBuckets = new TokenBuckets();

const REALTIME_RE = new RegExp(`^${V}/sender/tokens/[^/]+/authorize$`);

export async function registerHubApi(app: FastifyInstance): Promise<void> {
  // WP H2: whichever process routes (the API, or a gateway's minimal in-process instance) records every routed
  // CDR in the clearing ledger (ledger-tap.ts → src/hub/clearing).
  (await import('./clearing/index.js')).registerClearingLedger();
  await ensureSelfParties().catch((e) => logger.warn({ err: (e as Error).message }, 'hub: could not mirror HUB_PARTIES into hub_self_party'));

  app.addHook('preHandler', async (req, reply) => {
    if (!underPrefix(req, HUB_PREFIX)) return;
    const started = Date.now();
    const conn = await connectionByTokenHash(tokensFromAuthHeader(req.headers.authorization).map(tokenHash));
    if (!conn) return reply.status(401).header('www-authenticate', 'Token').send(envelope(undefined, 2000, 'invalid or missing credentials token'));
    const path = routePath(req) || req.url.split('?')[0]!;
    const registrationOnly = path === '/hub/ocpi/versions' || path === V || path === `${V}/credentials`;
    if (conn.state === 'pending' && !registrationOnly) {
      return reply.status(401).send(envelope(undefined, 2000, 'register first: this token only gives access to versions and credentials'));
    }
    const member = await getMember(conn.member_id);
    if (conn.state === 'suspended' || !member || member.status === 'suspended' || member.status === 'terminated') {
      return reply.status(403).send(envelope(undefined, 2000, 'this hub connection is suspended'));
    }
    const pathOnly = req.url.split('?')[0]!;
    const realtime = REALTIME_RE.test(pathOnly);
    const d = hubBuckets.take(realtime ? `hubrt:${conn.id}` : `hub:${conn.id}`, realtime ? conn.realtime_limit_per_min : conn.rate_limit_per_min);
    if (!d.allowed) {
      return reply.status(429).header('retry-after', String(d.retryAfterS))
        .send(envelope(undefined, HUB_STATUS.RATE_LIMITED, `rate limit: this connection may send ${d.limit} ${realtime ? 'real-time authorisations' : 'requests'} a minute`));
    }
    if (conn.state === 'connected') await noteInbound(conn.id).catch(() => null);
    const capture = !!conn.capture_bodies_until && new Date(conn.capture_bodies_until) > new Date();
    req.hubCtx = {
      conn, started,
      correlationId: idLike(req.headers['x-correlation-id']) ?? randomUUID(),
      requestIdIn: idLike(req.headers['x-request-id']),
      log: { route: 'hub', from: null, to: null },
      module: null, ocpiStatus: null, capture,
      ...(capture && req.body !== undefined ? { body: req.body } : {}),
    };
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!underPrefix(req, HUB_PREFIX)) return payload;
    reply.header('x-request-id', req.hubCtx?.requestIdIn ?? idLike(req.headers['x-request-id']) ?? randomUUID());
    reply.header('x-correlation-id', req.hubCtx?.correlationId ?? idLike(req.headers['x-correlation-id']) ?? randomUUID());
    if (req.hubCtx && typeof payload === 'string' && payload.length < 2_000_000) {
      const m = /"status_code":\s*(\d{4})/.exec(payload);
      if (m) req.hubCtx.ocpiStatus = Number(m[1]);
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const h = req.hubCtx;
    if (!h || !underPrefix(req, HUB_PREFIX)) return;
    await logHub({
      correlationId: h.correlationId, requestIdIn: h.requestIdIn, leg: 'in', connectionId: h.conn.id, from: h.log.from, to: h.log.to,
      route: h.log.route, module: h.module, method: req.method, path: req.url, httpStatus: reply.statusCode, ocpiStatus: h.ocpiStatus,
      ms: Date.now() - h.started, ...(h.capture && h.body !== undefined ? { body: h.body } : {}),
    });
  });

  const send = (reply: FastifyReply, r: HubResponse) => {
    for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    return reply.status(r.status).send(r.body);
  };
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof HubError) {
      for (const [k, v] of Object.entries(e.headers)) reply.header(k, v);
      return reply.status(e.http).send(envelope(undefined, e.ocpi, e.message));
    }
    logger.error({ err: e }, 'hub handler failed');
    return reply.status(500).send(envelope(undefined, 3000, 'internal error'));
  };

  // ── versions (configuration: answered by the hub, no routing headers)
  app.get('/hub/ocpi/versions', async (_req, reply) => {
    try { return envelope(hubVersions(hubBase())); } catch (e) { return fail(reply, e); }
  });
  app.get(V, async (_req, reply) => {
    try { return envelope({ version: OCPI_VERSION, endpoints: hubEndpoints(hubBase()) }); } catch (e) { return fail(reply, e); }
  });

  // ── credentials
  const C = `${V}/credentials`;
  app.get(C, async (req, reply) => {
    const { conn } = req.hubCtx!;
    req.hubCtx!.module = 'credentials';
    if (conn.state !== 'connected') return reply.status(405).send(envelope(undefined, 2000, 'not registered yet: POST your credentials'));
    try { return envelope(currentHubCredentials(conn)); } catch (e) { return fail(reply, e); }
  });
  for (const method of ['POST', 'PUT'] as const) {
    app.route({ method, url: C, handler: async (req, reply) => {
      const { conn } = req.hubCtx!;
      req.hubCtx!.module = 'credentials';
      try {
        const r = await registerMember(conn, req.body, method === 'PUT');
        const member = await getMember(conn.member_id);
        await hubAudit({ action: method === 'POST' ? 'hub.connection_registered' : 'hub.connection_updated', targetType: 'hub_connection', targetId: conn.id, orgId: member?.org_id ?? null,
          after: { parties: r.parties.map((p) => `${p.country_code}*${p.party_id}:${p.role}:${p.status}`), versions_url: r.connection.versions_url } });
        setImmediate(() => void (async () => {
          await pushClientInfoAbout(r.parties.map((p) => p.id));
          await pushClientInfoTo(conn.id);
        })().catch((e) => logger.warn({ err: (e as Error).message }, 'hub registration follow-up failed')));
        return envelope(r.credentials);
      } catch (e) { return fail(reply, e); }
    } });
  }
  app.delete(C, async (req, reply) => {
    const { conn } = req.hubCtx!;
    req.hubCtx!.module = 'credentials';
    if (conn.state !== 'connected' || conn.kind !== 'external') return reply.status(405).send(envelope(undefined, 2000, 'not registered'));
    const changed = await closeConnection(conn, false);
    const member = await getMember(conn.member_id);
    await hubAudit({ action: 'hub.connection_closed_by_member', targetType: 'hub_connection', targetId: conn.id, orgId: member?.org_id ?? null });
    setImmediate(() => void pushClientInfoAbout(changed).catch(() => null));
    return envelope(undefined);
  });

  // ── hubclientinfo (the hub is the SENDER): GET the list (paged; "not for operational flow")
  app.get(`${V}/hubclientinfo`, async (req, reply) => {
    const { conn } = req.hubCtx!;
    req.hubCtx!.module = 'hubclientinfo';
    const p = paging(req.query as Record<string, unknown>);
    const all = (await visibleTo(conn.id)).map((q) => clientInfoOf(q))
      .filter((c) => (!p.dateFrom || new Date(c.last_updated) >= p.dateFrom) && (!p.dateTo || new Date(c.last_updated) < p.dateTo));
    reply.header('x-total-count', String(all.length));
    reply.header('x-limit', String(p.limit));
    if (p.offset + p.limit < all.length) {
      const u = new URL(req.url, 'http://x');
      u.searchParams.set('offset', String(p.offset + p.limit));
      u.searchParams.set('limit', String(p.limit));
      try { reply.header('link', `<${hubBase()}${u.pathname}${u.search}>; rel="next"`); } catch { /* no public URL */ }
    }
    return envelope(all.slice(p.offset, p.offset + p.limit));
  });

  // ── every functional module, both interfaces: the router
  const functional = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.hubCtx!;
    const rest = req.url.split('?')[0]!.slice(`${V}/`.length);
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    try {
      const cls = classify(rest, req.method);
      h.module = cls.module;
      const ctx: Ctx = {
        conn: h.conn, cls, method: req.method, query: (req.query ?? {}) as Record<string, unknown>, search, body: req.body ?? undefined,
        headers: req.headers as Record<string, unknown>, correlationId: h.correlationId, requestIdIn: h.requestIdIn, capture: h.capture, log: h.log,
      };
      return send(reply, await routeFunctional(ctx));
    } catch (e) { return fail(reply, e); }
  };
  for (const iface of ['sender', 'receiver']) {
    app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url: `${V}/${iface}/*`, handler: functional });
  }

  logger.info('PlugSure Hub (OCPI 2.2.1) mounted at /hub/ocpi');
}
