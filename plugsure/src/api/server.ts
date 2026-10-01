import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { routePath, underPrefix } from './route-path.js';
import { limitParam } from './paging.js';
import fastifyStatic from '@fastify/static';
import { contentSecurityPolicy } from './csp.js';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isRelaxedEnv } from '../config.js';
import { logger } from '../logger.js';
import { one, many, query, enterOrgScope, runInRequestScope, afterResponse, outsideRequestScope, type OrgScopeHandle } from '../db/pool.js';
import * as assets from '../services/assets.js';
import { closeOutage, outageFromResume } from '../services/uptime.js';
import * as commands from '../ocpp/commands.js';
import * as registry from '../ocpp/registry.js';
import { recentSessions, clearReviewAndRate, reconcileStuckSessions, PREPAID_CLAIM_WINDOW_MIN } from '../services/sessions.js';
import { complianceReport, connectorMaySellEnergy } from '../services/compliance.js';
import {
  kvaHeadroom,
  runControlLoop,
  allocate,
  loadSiteBudget,
  collectDemands,
  provisionDefaultProfile,
  reconcileProfiles,
} from '../services/smartcharging.js';
import { loadTariffForConnector, createTariff, assignTariff, listTariffs } from '../services/tariff-store.js';
import { conservativeAllowanceWh, energyAllowanceWh, rateSession, validateTariff } from '../services/tariff.js';
import { estimateQrisMdrIdr, QRIS_MAX_TRANSACTION_IDR } from '../services/payments/provider.js';
import { paymentsFor, PaymentsUnavailable, logPaymentCreated, sandboxProvider } from '../services/payments/registry.js';
import { type Permission, type Principal, assertCan, assertCanAny, assertGrantable, visibleSiteIds, can, ForbiddenError, hasPlatformAdmin } from '../services/authz.js';
import { refuseHttpsUrl } from '../services/net-guard.js';
import { validateConfigValue } from '../ocpp/config-catalog.js';
import { recordRemoteStartRequest } from '../services/operator-limits.js';
import { registerConsoleRoutes } from './console-routes.js';
import { listFleetDetailed, validateTopology, applyTopology, type EvseSpec } from '../services/chargepoints.js';
import { budgetProblem, forStrategy, subscriptionCeilingW } from '../services/smartcharging.js';
import { searchSessions, protectDriverData } from '../services/session-query.js';
import { ensureSystemRoles } from '../services/users.js';
import { providedKeyProblem } from '../services/chargepoint-keys.js';
import { commissioningBundle } from './console-routes.js';
import { fingerprintOfPem } from '../services/vault-pki.js';
import {
  authenticate,
  assertAuthConfigured,
  UnauthenticatedError,
  orgOfChargePoint,
  orgOfSite,
  orgOfSession,
  issueApiKey,
  revokeApiKey,
} from '../services/auth.js';
import { verifyChain, writeAudit } from '../services/audit.js';
import { listAttempts, pendingChargers, attemptStats, suggestMatches, identitySeenUnregistered } from '../services/connections.js';
import { issueAuthorizationKey, setSecurityProfile, setClientCertFingerprint } from '../services/chargepoint-keys.js';
import { listQuirkProfiles } from '../ocpp/quirks.js';
import { bus, eventVisibleTo } from '../services/events.js';
import { registerDriverApi } from '../driver/server.js';
import { registerOcpiApi } from '../ocpi/server.js';
import { registerRoamingRoutes } from './roaming-routes.js';
import { registerSandboxRoutes } from './sandbox-routes.js';
import { registerFleetRoutes } from './fleet-routes.js';
import { registerFleetPortalRoutes } from './fleet-portal-routes.js';
import { registerPricingRoutes } from './pricing-routes.js';
import { registerPncRoutes } from './pnc-routes.js';
import { registerOnboardingRoutes } from './onboarding-routes.js';
import { registerIntegrationRoutes } from './integration-routes.js';
import { registerBrandRoutes } from './brand-routes.js';
import { registerConsoleBrandRoutes } from './console-brand-routes.js';
import { resolve as resolveIntegration } from '../integrations/store.js';
import { isSandboxOrg } from '../sandbox/provision.js';
import { sandboxCall } from '../ocpp/bridge.js';
import { v2xView } from '../services/v2x.js';
import { signedDataFor, transparencyXml } from '../services/signed-metering.js';
import { streamMultipartFile } from './multipart-stream.js';
import { takeKeyToken, rateLimitHeaders, tooManyFailures, recordFailure, recordUsage, startUsageFlush, stopUsageFlush, flushUsage } from '../services/ratelimit.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The sandbox acquirer's simulator (development only); real acquirers come from Integrations. */
const sandboxAcquirer = sandboxProvider();

/** Attach the authenticated principal to the request. */
declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
    /** Request-scoped, org-pinned transaction. Present on /v1/ routes only. */
    orgScope?: OrgScopeHandle;
    /** The API key that made this request, for its usage counts. */
    apiKey?: { id: string; orgId: string };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A tile URL's host for the CSP, when it is not OpenStreetMap's own. */
function tileOriginOf(url: string): string {
  // A {s} subdomain template (a.tile…, b.tile…) becomes a CSP wildcard.
  const m = /^https:\/\/([a-z0-9.{}-]+)(?::\d+)?\//i.exec(url);
  if (!m) return '';
  const host = m[1]!.toLowerCase().replace(/^\{s\}\./, '*.');
  if (host === 'tile.openstreetmap.org' || /[{}]/.test(host)) return '';
  return ` https://${host}`;
}
/** The driver map's tile host (Integrations → Map tiles, else MAP_TILE_URL), refreshed in the background. */
let TILE_ORIGIN = tileOriginOf(config.driverApp.mapTileUrl);
let tileOriginAt = 0;
function refreshTileOrigin() {
  if (Date.now() - tileOriginAt < 15_000) return;
  tileOriginAt = Date.now();
  void resolveIntegration('map_tiles').then((r) => { TILE_ORIGIN = tileOriginOf(String(r?.settings.tileUrl ?? config.driverApp.mapTileUrl)); }).catch(() => {});
}
class NotFoundError extends Error {
  statusCode = 404;
}
class BadRequestError extends Error {
  statusCode = 400;
}
class ConflictError extends Error {
  statusCode = 409;
}

export const registeredRoutes: Array<{ method: string; url: string }> = [];

export async function buildApi(): Promise<FastifyInstance> {
  assertAuthConfigured();

  // Trust X-Forwarded-For only from named proxies. `trustProxy: true` trusts it
  // from anyone, which made req.ip attacker-controlled — and req.ip is both the
  // rate-limit key and the audit log's client IP.
  const app = Fastify({
    logger: false,
    bodyLimit: 1 * 1024 * 1024,
    trustProxy: config.api.trustedProxies.length > 0 ? config.api.trustedProxies : false,
  });
  // Every route as registered, for the OpenAPI coverage test (spec.test.ts).
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) registeredRoutes.push({ method: String(m).toUpperCase(), url: r.url });
  });
  if (config.api.trustedProxies.length === 0 && !isRelaxedEnv()) {
    logger.warn(
      'API_TRUSTED_PROXIES is empty: X-Forwarded-For is ignored and rate limiting keys on the ' +
        'socket peer. Correct behind a direct-facing listener; set it if you terminate TLS at an ingress.',
    );
  }

  await app.register(fastifyStatic, { root: join(here, '../web'), prefix: '/' });

  // ---------------------------------------------------------------- security

  app.addHook('onSend', async (req, reply, payload) => {
    // Settle the request transaction BEFORE the response is written, so a client
    // that gets a 2xx can immediately read its own write. (onResponse below stays
    // as the safety net; commit/rollback are idempotent.) A failed COMMIT
    // rejects here, so the error handler answers 500 instead of the 2xx the
    // handler produced for writes that were lost. A rollback re-appends the
    // request's audit entries outside it (see writeAudit), before the reply.
    if (req.orgScope) {
      if (reply.statusCode >= 400) await req.orgScope.rollback();
      else await req.orgScope.commit();
    }
    // The console is served from here, so these belong on every response.
    // The page also carries a meta CSP; a real header outperforms it because it
    // can carry a per-response nonce — see the note in src/web/index.html.
    refreshTileOrigin();
    reply.header('X-Content-Type-Options', 'nosniff');
    // The console previews a white-label driver app in a frame: /app/ may be framed by its own origin.
    const framable = req.url.startsWith('/app/');
    reply.header('X-Frame-Options', framable ? 'SAMEORIGIN' : 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', contentSecurityPolicy(req.url, TILE_ORIGIN, framable));
    return payload;
  });

  /**
   * Establish the per-request async context FIRST, before anything else runs.
   *
   * Callback form on purpose: calling `done()` inside AsyncLocalStorage.run()
   * continues Fastify's hook chain within that context, so every later hook and
   * the route handler itself see the store. The store starts empty; the
   * preHandler below fills it in once the tenant is known.
   */
  app.addHook('onRequest', (req, _reply, done) => {
    if (!underPrefix(req, '/v1/')) return done();
    runInRequestScope(done);
  });

  /**
   * End the console's live streams (Server-Sent Events) on shutdown.
   *
   * `app.close()` stops accepting connections and waits for the open ones to
   * finish — and an SSE response never finishes on its own: with one console tab
   * open, SIGTERM hung until systemd's SIGKILL (TimeoutStopSec), which also cut
   * every other in-flight request instead of draining it. The streams are tracked
   * here (/v1/stream and /v1/events/*) and ended in preClose, which runs BEFORE
   * the server waits for connections; ordinary requests still drain gracefully.
   * The browser's EventSource reconnects by itself, to another API process or to
   * this one once it is back.
   */
  const liveStreams = new Set<import('node:http').ServerResponse>();
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (url !== '/v1/stream' && !url.startsWith('/v1/events/')) return;
    const res = reply.raw;
    liveStreams.add(res);
    res.on('close', () => liveStreams.delete(res));
  });
  app.addHook('preClose', async () => {
    for (const res of liveStreams) {
      // A stream still being authenticated has written nothing yet: drop it, or it
      // would open after this point and hold the close up all the same.
      if (!res.headersSent) { res.destroy(); continue; }
      try {
        res.end();
        res.socket?.destroySoon();
      } catch {
        res.destroy();
      }
    }
    liveStreams.clear();
  });

  // Simple fixed-window limiter per client IP. There was none at all.
  // Requests with an API key are limited per key once it authenticates (below);
  // here they only count against the IP when the key does not authenticate.
  const hits = new Map<string, { n: number; resetAt: number }>();
  // Only the operator API (/v1) takes API keys: elsewhere the header buys nothing.
  const withApiKey = (req: FastifyRequest) => underPrefix(req, '/v1/') && /^Bearer\s+psk_/i.test(String(req.headers.authorization ?? ''));
  startUsageFlush();
  app.addHook('onClose', async () => { stopUsageFlush(); await flushUsage(); });
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    // An address that keeps sending keys that do not authenticate loses that exemption:
    // its key requests count here too, which bounds a flood of guesses.
    if (withApiKey(req) && !tooManyFailures(key, config.api.keyAuthFailuresPerMin, now)) return;
    const slot = hits.get(key);
    if (!slot || slot.resetAt < now) {
      hits.set(key, { n: 1, resetAt: now + 60_000 });
    } else if (++slot.n > config.api.rateLimitPerMin) {
      reply.header('Retry-After', Math.ceil((slot.resetAt - now) / 1000));
      return reply.status(429).send({ error: 'rate limit exceeded' });
    }
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  });

  /**
   * Authentication on EVERY route except the health check and the console's own
   * static assets. There is no opt-in list — a new route is protected by default,
   * which is the only arrangement that survives contact with a growing codebase.
   */
  app.addHook('preHandler', async (req, reply) => {
    // Under the prefix by the matched route OR the raw target (see underPrefix).
    const route = routePath(req);
    if (!underPrefix(req, '/v1/')) return;
    // The one unauthenticated /v1 route: you cannot present a session you do not have yet.
    if (route === '/v1/auth/login' && req.method === 'POST') return;
    try {
      const auth = await authenticate(req.headers as Record<string, unknown>);
      req.principal = auth.principal;
      // Each API key has its own limit (a token bucket; RateLimit-* headers on every answer).
      if (auth.kind === 'api_key') {
        const d = await takeKeyToken(auth.credentialId, auth.rateLimitPerMin ?? config.api.keyRateLimitPerMin);
        reply.headers(rateLimitHeaders(d));
        req.apiKey = { id: auth.credentialId, orgId: auth.principal.orgId };
        if (!d.allowed) {
          return reply.status(429).send({ error: `rate limit exceeded: this API key may make ${d.limit} requests a minute`, code: 'rate_limited' });
        }
      }
      /**
       * CSRF guard for the console's cookie session. SameSite=Strict already
       * keeps the cookie off cross-site requests; this closes the remaining gap
       * (a same-site sibling, an old browser) by requiring a custom header that a
       * cross-origin form or <img> cannot set without a CORS preflight, which
       * this API never grants. Bearer-token callers are unaffected.
       */
      if (auth.viaCookie && req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-plugsure-csrf'] !== '1') {
        return reply.status(403).send({ error: 'missing CSRF header' });
      }
      /**
       * A one-time password (issued at invitation or reset, and typically sent
       * over chat or e-mail) is good for ONE thing: choosing a real password.
       * Until the user has, the API serves only who-am-I, reference data, the
       * password change and sign-out. Before, only the console enforced this; the
       * one-time password worked indefinitely against the API itself.
       */
      if (auth.mustChangePassword) {
        const path = routePath(req);
        const allowed =
          (req.method === 'GET' && (path === '/v1/auth/me' || path === '/v1/meta')) ||
          (req.method === 'POST' && (path === '/v1/auth/change-password' || path === '/v1/auth/logout'));
        if (!allowed) {
          return reply.status(403).send({
            error: 'Choose a new password first: your administrator issued a one-time password.',
            code: 'password_change_required',
          });
        }
      }
    } catch (e) {
      if (e instanceof UnauthenticatedError) {
        if (withApiKey(req)) {
          const ip = req.ip ?? 'unknown';
          recordFailure(ip);
          const wait = tooManyFailures(ip, config.api.keyAuthFailuresPerMin);
          if (wait) {
            reply.header('Retry-After', wait);
            return reply.status(429).send({ error: 'too many requests with an API key that is not valid', code: 'rate_limited' });
          }
        }
        reply.header('WWW-Authenticate', 'Bearer');
        return reply.status(401).send({ error: e.message });
      }
      throw e;
    }
  });

  /**
   * Bind row-level security to the authenticated tenant for the whole request.
   *
   * The policies in migration 002 test `app_current_org()`, which reads a GUC
   * nothing ever set — so every policy evaluated to true and RLS was decorative
   * while the README described it as the second line of defence. Wrapping the
   * handler pins one connection with `app.current_org_id` set, inside a
   * transaction: a query that forgets its org predicate now returns nothing
   * instead of another tenant's rows, and a handler that throws rolls back.
   *
   * `/v1/stream` is excluded deliberately — it holds its connection open for the
   * life of the SSE subscription, and a pooled client cannot be lent out for
   * that long. It does its own filtering (see eventVisibleTo).
   */
  app.addHook('preHandler', async (req) => {
    const route = routePath(req);
    if (!route.startsWith('/v1/') || route.startsWith('/v1/stream') || route.startsWith('/v1/events/')) return;
    if (!req.principal?.orgId) return;
    req.orgScope = await enterOrgScope(req.principal.orgId);
  });

  /**
   * Firmware images arrive as a raw octet stream and are STREAMED to disk by the
   * route (with the size cap enforced while streaming), so the parser hands the
   * request stream through untouched rather than buffering hundreds of MB.
   * Diagnostics uploads from chargers are either raw (PUT) or multipart (POST).
   *
   * Multipart bodies used to be buffered whole (`parseAs: 'buffer'`, up to
   * MAX_DIAGNOSTICS_BYTES = 200 MB each) in a 1 GB API container. They are now
   * streamed: the parser hands the route a stream of the FILE PART's bytes only
   * (multipart-stream.ts), which the route writes to disk with saveStream() and
   * its size cap, exactly as it does a raw upload. The parser resolves once the
   * part headers are read, so a body with no file is still a 400.
   */
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  app.addContentTypeParser(/^multipart\/form-data/, (req, payload, done) => {
    // Framing on top of the file is small; the file itself is capped by saveStream.
    streamMultipartFile(payload, String(req.headers['content-type'] ?? ''), config.storage.maxDiagnosticsBytes + 1024 * 1024)
      .then((file) => {
        // The route names the stored file from `:name` (else 'diagnostics.log'); a
        // multipart upload carries its own name, which the buffered path used.
        const params = req.params as { name?: string };
        if (!params.name && file.fileName) params.name = file.fileName;
        done(null, file);
      }, (e) => done(e as Error, undefined));
  });
  // Any other type (a charger's text/plain or application/gzip log upload) is
  // handed through as a stream; JSON routes keep Fastify's own JSON parser.
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.addHook('onError', async (req) => {
    await req.orgScope?.rollback();
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.apiKey) recordUsage(req.apiKey.id, req.apiKey.orgId, reply.statusCode);
    // 4xx/5xx replies produced without throwing (an explicit reply.status(403))
    // should not persist half-finished writes either.
    if (reply.statusCode >= 400) await req.orgScope?.rollback();
    else await req.orgScope?.commit().catch((err) => {
      // The reply has already gone out as a success; all that is left is to say so.
      logger.error({ err, reqId: req.id, method: req.method, url: req.url, status: reply.statusCode }, 'request transaction failed to COMMIT after a success reply was sent; its writes were lost');
    });
  });

  app.setErrorHandler((err: any, req, reply) => {
    // A malformed id in the path or body reached Postgres as a uuid/number: the
    // caller's mistake, not ours (it used to be a bare 500).
    if (err?.code === '22P02' || err?.code === '22007' || err?.code === '22008' || err?.code === '2201W' || err?.code === '2201X') {
      return reply.status(400).send({ error: 'a value in the request is not in the expected format (e.g. a malformed id)' });
    }
    // A command for a charger that is not connected (locally or via the gateway).
    if (!err?.statusCode && /charge point \S+ is not connected/.test(String(err?.message ?? ''))) {
      return reply.status(409).send({ error: err.message, code: 'charger_offline' });
    }
    const status = err?.statusCode ?? 500;
    if (status >= 500 && err?.expose === true) {
      // Deliberately operator-facing upstream failures (e.g. Vault PKI 501/502).
      logger.warn({ err, url: req.url }, 'api upstream error');
      return reply.status(status).send({ error: err.message });
    }
    if (status >= 500) {
      logger.error({ err, url: req.url }, 'api error');
      // Never leak internal error text — a bad x-org-id used to return raw
      // Postgres type-parse errors to the caller.
      return reply.status(500).send({ error: 'internal error' });
    }
    reply.status(status).send({ error: err.message });
  });

  // ---------------------------------------------------------------- helpers

  /** Resolve a charge point and prove the caller's organisation owns it. */
  async function ownedChargePoint(req: FastifyRequest, identity: string, permission: Parameters<typeof assertCan>[1]['permission']) {
    const owner = await orgOfChargePoint(identity);
    if (!owner) throw new NotFoundError('charge point not found');
    assertCan(req.principal, { permission, orgId: owner.orgId, siteId: owner.siteId });
    return owner;
  }

  async function ownedSite(req: FastifyRequest, siteId: string, permission: Parameters<typeof assertCan>[1]['permission']) {
    const owner = await orgOfSite(siteId);
    if (!owner) throw new NotFoundError('site not found');
    assertCan(req.principal, { permission, orgId: owner.orgId, siteId });
    return owner;
  }

  const actorOf = (req: FastifyRequest) => ({
    type: 'user' as const,
    id: req.principal.userId,
    orgId: req.principal.orgId,
    ip: req.ip,
  });

  // ---------------------------------------------------------------- health

  app.get('/healthz', async () => {
    let db = true;
    try {
      await query('SELECT 1');
    } catch {
      db = false;
    }
    return { ok: db, db, connectedChargePoints: registry.all().length, time: new Date().toISOString() };
  });

  // ---------------------------------------------------------------- fleet

  app.get('/v1/charge-points', async (req) => {
    assertCanAny(req.principal, 'charge_point:read');
    // The v1.2.1 row shape plus display name, live session per connector and
    // commissioning fields. `online` is bridge-aware in the split deployment.
    const rows = await listFleetDetailed(req.principal.orgId);
    const visible = visibleSiteIds(req.principal, 'charge_point:read');
    return rows
      .filter((r: any) => visible === null || visible.includes(r.site_id))
      .map((r: any) => ({
        ...r,
        online: registry.isOnline(r.ocpp_identity),
        negotiatedVersion: registry.versionOf(r.ocpp_identity) ?? null,
      }));
  });

  /**
   * For a site-scoped principal (Site Host, Site Owner), history of a charger is
   * shown only from when it joined its current site: a charger moved from
   * another owner's site must not bring that owner's OCPP log (with RFID idTags)
   * along. Org-wide principals see everything.
   */
  /**
   * The raw OCPP log carries drivers' RFID idTags (Authorize, StartTransaction),
   * which on UID-only cards are the credential itself. It is an operator and
   * field-technician tool: org-wide readers, or anyone who may configure or
   * command this charger. A read-only site-scoped viewer (Site Owner, Site Host)
   * does not get it.
   */
  const assertFramesAccess = (req: FastifyRequest, cp: { orgId: string; siteId: string }) => {
    if (visibleSiteIds(req.principal, 'charge_point:read') === null) return;
    const at = { orgId: cp.orgId, siteId: cp.siteId };
    if (can(req.principal, { permission: 'charge_point:config', ...at }) || can(req.principal, { permission: 'charge_point:command', ...at })) return;
    throw new ForbiddenError('charge_point:config');
  };

  const historyFloor = async (req: FastifyRequest, identity: string): Promise<Date | null> => {
    if (visibleSiteIds(req.principal, 'charge_point:read') === null) return null;
    const r = await one<{ at: Date | null }>(`SELECT site_assigned_at AS at FROM charge_point WHERE ocpp_identity = $1`, [identity]);
    return r?.at ?? null;
  };

  app.get('/v1/charge-points/:identity/frames', async (req) => {
    const { identity } = req.params as { identity: string };
    assertFramesAccess(req, await ownedChargePoint(req, identity, 'charge_point:read'));

    // Filters and export, so a joint debugging session with a vendor can narrow
    // to the window that matters instead of scrolling a fixed 150-row page.
    const q = (req.query ?? {}) as Record<string, string>;
    const where: string[] = ['ocpp_identity = $1'];
    const params: unknown[] = [identity];
    const add = (clause: string, v: unknown) => {
      params.push(v);
      where.push(clause.replace('?', `$${params.length}`));
    };
    const floor = await historyFloor(req, identity);
    if (floor) add('ts >= ?', floor);
    if (q.since) add('ts >= ?', new Date(q.since));
    if (q.until) add('ts <= ?', new Date(q.until));
    if (q.action) add('action = ?', q.action);
    if (q.direction) add('direction = ?', q.direction);
    params.push(limitParam(q.limit, 200, 2000));

    return many(
      `SELECT ts, direction, message_type, action, unique_id, payload
         FROM ocpp_frame WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
  });

  app.get('/v1/charge-points/:identity/frames.ndjson', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    assertFramesAccess(req, await ownedChargePoint(req, identity, 'charge_point:read'));
    const floor = await historyFloor(req, identity);
    const rows = await many(
      `SELECT ts, direction, message_type, action, unique_id, payload
         FROM ocpp_frame WHERE ocpp_identity = $1 AND ($2::timestamptz IS NULL OR ts >= $2) ORDER BY id ASC LIMIT 50000`,
      [identity, floor],
    );
    reply.header('Content-Type', 'application/x-ndjson');
    reply.header('Content-Disposition', `attachment; filename="${identity.replace(/[^\w.-]/g, '_')}-frames.ndjson"`);
    return rows.map((r) => JSON.stringify(r)).join('\n');
  });

  /**
   * One command dispatcher behind two URL shapes: the original
   * `/commands/:command` and the spec's named routes (`/remote-start`,
   * `/unlock`, `/availability`, …). Both run the same permission, compliance and
   * audit path.
   */
  async function runCommand(req: FastifyRequest, reply: FastifyReply, identity: string, command: string) {
    // Configuration and diagnostics are also open to charge_point:config (field
    // technicians); keys issued before v1.3 carry only charge_point:command and
    // keep working.
    const configCommand = ['get-configuration', 'change-configuration', 'get-diagnostics'].includes(command);
    const found = await orgOfChargePoint(identity);
    if (!found) throw new NotFoundError('charge point not found');
    const scope = { orgId: found.orgId, siteId: found.siteId };
    if (
      !can(req.principal, { permission: 'charge_point:command', ...scope }) &&
      !(configCommand && can(req.principal, { permission: 'charge_point:config', ...scope }))
    ) {
      assertCan(req.principal, { permission: configCommand ? 'charge_point:config' : 'charge_point:command', ...scope });
    }
    const owner = found;
    const body = (req.body ?? {}) as any;
    const actor = actorOf(req);

    /**
     * The generic dispatcher must not be a way around the dedicated routes.
     *
     * `charge_point:command` (held by api_client keys, technicians and field
     * technicians) reached every command here with no further check: a firmware
     * image from any URL (the firmware routes need firmware:write, a stored
     * image and its checksum), charging profiles without smartcharging:write
     * (including clearing the station ceiling the site power budget relies on),
     * AuthorizationKey / SecurityProfile (which the config route refuses) and
     * arbitrary vendor DataTransfer payloads. Each now needs what its own route
     * needs.
     */
    const needs = (permission: Permission) => assertCan(req.principal, { permission, ...scope });
    switch (command) {
      case 'update-firmware': {
        needs('firmware:write');
        let url: URL;
        try { url = new URL(String(body.location ?? '')); } catch { throw new BadRequestError('location must be an https URL'); }
        const refused = refuseHttpsUrl(url);
        if (refused) throw new BadRequestError(`firmware URL refused: ${refused}`);
        break;
      }
      case 'set-charging-profile':
      case 'clear-charging-profile': {
        needs('smartcharging:write');
        const purpose = String(body.purpose ?? body.chargingProfilePurpose ?? '');
        if (/^(ChargePointMaxProfile|ChargingStationMaxProfile)$/.test(purpose)) {
          throw new BadRequestError('the station ceiling is managed by the site power budget (Power), not by a raw command');
        }
        if (command === 'clear-charging-profile' && body.id == null && !purpose) {
          throw new BadRequestError('scope the clear to a profile id or a TxDefaultProfile / TxProfile purpose');
        }
        break;
      }
      case 'change-configuration': {
        const key = String(body.key ?? '').trim();
        if (!/^[A-Za-z0-9_.-]{1,50}$/.test(key)) throw new BadRequestError('invalid configuration key');
        if (key === 'SecurityProfile' || key === 'AuthorizationKey') {
          throw new BadRequestError(`${key} is changed from the Security tab, which enforces the safe order of operations`);
        }
        const problem = validateConfigValue(key, String(body.value ?? ''));
        if (problem) throw new BadRequestError(problem);
        break;
      }
      case 'data-transfer':
        needs('charge_point:config');
        break;
    }

    switch (command) {
      case 'remote-start': {
        const connectorNo = Number(body.connectorId ?? 1);
        const idTag = String(body.idTag ?? '').trim();
        if (!idTag) throw new BadRequestError('choose an RFID tag or driver account to start the session for');
        // The gateway would refuse the start anyway (stationRefusal); say why here.
        const cpState = await one<{ status: string }>(`SELECT status FROM charge_point WHERE id = $1`, [owner.chargePointId]);
        if (cpState && assets.ADMINISTRATIVE_STATES.includes(cpState.status)) {
          return reply.status(409).send({ error: `this charge point is ${cpState.status === 'pending_adoption' ? 'awaiting adoption' : cpState.status} and cannot start sessions` });
        }
        // Compliance gate: a connector whose meter verification has lapsed (or is
        // awaiting calibration) may not sell energy. Enforcement, not a flag.
        const c = await assets.getConnector(owner.chargePointId, connectorNo);
        if (c) {
          const gate = connectorMaySellEnergy(c.tera_status as any);
          if (!gate.allowed) return reply.status(409).send({ error: gate.reason });
        }
        /**
         * "Remote Commands: Full (Test Only)" for field technicians — a principal
         * that cannot write sessions may only start with a technician or
         * VIP/test card, so a technician cannot hand out free public charging.
         */
        if (!can(req.principal, { permission: 'session:write', orgId: owner.orgId, siteId: owner.siteId })) {
          const tok = await one<{ account_type: string }>(
            `SELECT account_type FROM token WHERE org_id = $1 AND uid = $2`,
            [owner.orgId, idTag],
          );
          if (!tok || !['technician', 'vip'].includes(tok.account_type)) {
            return reply.status(403).send({
              error: 'Your role may only start test sessions — use a Maintenance Technician or VIP / Internal Testing card.',
            });
          }
        }
        const limitType = ['energy', 'duration', 'amount'].includes(body.limitType) ? body.limitType : 'none';
        const limit = await recordRemoteStartRequest({
          orgId: owner.orgId,
          chargePointId: owner.chargePointId,
          connectorNo,
          connectorUuid: c?.id ?? null,
          idTag,
          limitType,
          limitValue: body.limitValue != null && body.limitValue !== '' ? Number(body.limitValue) : null,
          requestedBy: req.principal.userId,
        });
        if (limit.error) throw new BadRequestError(limit.error);
        const r = await commands.remoteStartTransaction(identity, connectorNo, idTag, actor);
        return { ...r, limit: { type: limitType, energyLimitWh: limit.energyLimitWh, durationLimitS: limit.durationLimitS } };
      }
      case 'remote-stop': {
        // 1.6 ids are integers; 2.0.1 ids are the station's own strings.
        const raw = body.transactionId;
        const v = registry.versionOf(identity);
        const is201 = v === 'ocpp2.0.1' || v === 'ocpp2.1';
        const txId = is201 ? String(raw ?? '') : Number(raw);
        if (is201 ? !txId : !Number.isInteger(txId)) throw new BadRequestError('transactionId is required');
        return commands.remoteStopTransaction(identity, txId, actor);
      }
      case 'reset':
        return commands.reset(identity, body.type === 'Hard' ? 'Hard' : 'Soft', actor);
      case 'unlock':
        return commands.unlockConnector(identity, Number(body.connectorId ?? 1), actor);
      case 'change-availability': {
        const connectorNo = Number(body.connectorId ?? 0);
        const type = body.type === 'Inoperative' ? 'Inoperative' : 'Operative';
        const reason = String(body.reason ?? '').trim();
        // Taking a connector out of service is a maintenance act; the spec requires the reason.
        if (type === 'Inoperative' && reason.length < 3) {
          throw new BadRequestError('enter the maintenance reason (e.g. "gun 2 cable damaged")');
        }
        const r = await commands.changeAvailability(identity, connectorNo, type, actor);
        await query(
          `UPDATE connector c SET maintenance_reason = $3, maintenance_since = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END
             FROM evse e WHERE e.id = c.evse_uuid AND e.charge_point_id = $1 AND ($2 = 0 OR e.evse_id = $2)`,
          [owner.chargePointId, connectorNo, type === 'Inoperative' ? reason : null],
        );
        await writeAudit({
          orgId: owner.orgId,
          actorType: 'user',
          actorId: req.principal.userId,
          action: 'charge_point.availability_changed',
          targetType: 'charge_point',
          targetId: identity,
          after: { connectorId: connectorNo, type, reason: reason || null, chargerStatus: (r as any)?.status ?? null },
          ip: req.ip,
        });
        return r;
      }
      case 'trigger':
        return commands.triggerMessage(identity, String(body.requestedMessage ?? 'StatusNotification'), body.connectorId, actor);
      case 'get-configuration':
        return commands.getConfiguration(identity, body.keys, actor);
      case 'change-configuration':
        return commands.changeConfiguration(identity, String(body.key), String(body.value), actor);
      case 'clear-cache':
        return commands.clearCache(identity, actor);
      case 'set-charging-profile':
        return commands.setChargingProfile(identity, body, actor);
      case 'clear-charging-profile':
        return commands.clearChargingProfile(identity, body, actor);
      case 'get-composite-schedule':
        return commands.getCompositeSchedule(
          identity,
          Number(body.connectorId ?? 0),
          Number(body.durationS ?? 600),
          body.chargingRateUnit,
          actor,
        );
      case 'data-transfer':
        return commands.dataTransfer(identity, String(body.vendorId), body.messageId, body.data, actor);
      case 'get-diagnostics':
        return commands.getDiagnostics(identity, String(body.location), actor);
      case 'update-firmware':
        return commands.updateFirmware(identity, String(body.location), String(body.retrieveDate ?? new Date().toISOString()), actor);
      case 'reserve-now':
        return commands.reserveNow(identity, body, actor);
      case 'cancel-reservation':
        return commands.cancelReservation(identity, Number(body.reservationId), actor);
      default:
        return reply.status(400).send({ error: `unknown command: ${command}` });
    }
  }

  app.post('/v1/charge-points/:identity/commands/:command', async (req, reply) => {
    const { identity, command } = req.params as { identity: string; command: string };
    return runCommand(req, reply, identity, command);
  });

  // The route names in SPEC-UI-CSMS-2026-FINAL §4, mapped onto the same dispatcher.
  const SPEC_ROUTES: Record<string, string> = {
    'remote-start': 'remote-start',
    'remote-stop': 'remote-stop',
    unlock: 'unlock',
    reset: 'reset',
    availability: 'change-availability',
    trigger: 'trigger',
    'clear-cache': 'clear-cache',
  };
  for (const [path, command] of Object.entries(SPEC_ROUTES)) {
    app.post(`/v1/charge-points/:identity/${path}`, async (req, reply) => {
      const { identity } = req.params as { identity: string };
      return runCommand(req, reply, identity, command);
    });
  }

  // -------------------------------------------------- charge point security

  app.post('/v1/charge-points/:identity/authorization-key', async (req) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    // An installer may type a key (some commissioning apps require one they can
    // enter on a keypad); otherwise a 160-bit random key is generated.
    const provided = typeof (req.body as any)?.key === 'string' && (req.body as any).key.trim() !== ''
      ? String((req.body as any).key).trim()
      : undefined;
    if (provided) {
      const problem = providedKeyProblem(provided);
      if (problem) throw new BadRequestError(problem);
    }
    const days = (req.body as any)?.rotationDays;
    if (days != null && days !== '') {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 7 || n > 730) throw new BadRequestError('rotation reminder must be 7–730 days');
      await query(`UPDATE charge_point SET key_rotation_days = $2 WHERE id = $1`, [owner.chargePointId, n]);
    }
    const issued = await issueAuthorizationKey(owner.chargePointId, actorOf(req), provided);
    if (!issued) throw new NotFoundError('charge point not found');
    return {
      ...issued,
      // Commissioning export: the JSON and QR a field technician loads into the
      // charger's own commissioning app. Contains the key, so it is shown once too.
      commissioning: await commissioningBundle(req, identity, 2, issued.key),
      warning:
        'This key is shown once. Configure it on the charger FIRST, then raise the security profile — ' +
        'the other order leaves the unit unable to connect.',
    };
  });

  app.put('/v1/charge-points/:identity/security-profile', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    const profile = Number((req.body as any)?.profile);
    if (![0, 1, 2, 3].includes(profile)) throw new BadRequestError('profile must be 0, 1, 2 or 3');
    const res = await setSecurityProfile(owner.chargePointId, profile as 0 | 1 | 2 | 3, actorOf(req));
    if (!res.ok) return reply.status(409).send({ error: res.error });
    return { ok: true, profile };
  });

  // Bind the client-certificate fingerprint for OCPP Security Profile 3 (mutual TLS).
  // Set this BEFORE raising the unit to profile 3. Send an empty string to clear it.
  app.put('/v1/charge-points/:identity/client-certificate', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    // Accept the certificate itself (PEM) as well as a bare fingerprint: pasting
    // the .crt the charger vendor supplied is less error-prone than copying hex.
    const pem = String((req.body as any)?.certificatePem ?? '').trim();
    let fingerprint = String((req.body as any)?.fingerprint ?? '');
    if (pem) {
      const fp = fingerprintOfPem(pem);
      if (!fp) throw new BadRequestError('that is not a valid PEM certificate');
      fingerprint = fp;
    }
    const res = await setClientCertFingerprint(owner.chargePointId, fingerprint, actorOf(req));
    if (!res.ok) return reply.status(400).send({ error: res.error });
    return { ok: true, fingerprint: res.fingerprint };
  });

  // ------------------------------------------------ connections & adoption

  app.get('/v1/connection-attempts', async (req) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    const q = (req.query ?? {}) as Record<string, string>;
    return listAttempts({
      identity: q.identity,
      outcome: q.outcome as any,
      since: q.since ? new Date(q.since) : undefined,
      until: q.until ? new Date(q.until) : undefined,
      limit: limitParam(q.limit, 200, 10_000),
      orgId: req.principal.orgId,
    });
  });

  app.get('/v1/connection-attempts/stats', async (req) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    return attemptStats(Number((req.query as any)?.minutes ?? 60), req.principal.orgId);
  });

  /**
   * Identities that knocked and were turned away. They belong to no tenant by
   * definition, so this is a platform-operator surface — exposing it on
   * `charge_point:read` let every tenant enumerate every other tenant's
   * hardware, source IPs and auth failures. A tenant that wants to see its own
   * failed commissioning pre-registers the identity first; the attempt then
   * resolves and appears in GET /v1/connection-attempts.
   */
  app.get('/v1/pending-chargers', async (req) => {
    assertCan(req.principal, { permission: 'platform:admin' });
    return pendingChargers();
  });

  app.get('/v1/pending-chargers/:identity/suggestions', async (req) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    const { identity } = req.params as { identity: string };
    // A wrong-case or transposed serial is the classic commissioning failure.
    return suggestMatches(identity, req.principal.orgId);
  });

  /**
   * Pre-register a charge point BEFORE it dials in.
   *
   * This is the first step of commissioning and it did not exist — the runbook
   * documented `POST /v1/charge-points` and it answered 404, so the whole
   * documented sequence collapsed at step one. The only order that worked was to
   * let the charger be refused first and then adopt it from the rejection log,
   * which is backwards: an installer standing at a unit should not have to
   * trigger a failure to make progress.
   *
   * The row is created in `pending_adoption`. A charger that connects at this
   * point completes the WebSocket upgrade and is answered `Pending` at
   * BootNotification — visible in the console, not yet able to transact — until
   * an operator activates it.
   */
  /**
   * Identities are platform-wide and first-come. One that has already dialled in
   * unregistered is a real charger, possibly another operator's; only a platform
   * operator may register or adopt it (see identitySeenUnregistered). Null = allowed.
   */
  async function claimProblem(req: FastifyRequest, identity: string) {
    if (hasPlatformAdmin(req.principal)) return null;
    const seen = await identitySeenUnregistered(identity);
    if (seen.attempts === 0) return null;
    return {
      error:
        'A charger with this identity has already tried to connect while unregistered, so it may belong to another ' +
        'operator. Ask the platform operator to register or adopt it for you (they can confirm the unit with your installer).',
      code: 'identity_needs_platform_approval',
    };
  }

  app.post('/v1/charge-points', async (req, reply) => {
    const b = req.body as any;
    const identity = String(b.ocppIdentity ?? '').trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(identity)) {
      throw new BadRequestError('ocppIdentity must be 1-128 chars of [A-Za-z0-9._:-]');
    }
    if (!UUID_RE.test(String(b.siteId ?? ''))) throw new BadRequestError('choose the site this charger is installed at');
    await ownedSite(req, String(b.siteId ?? ''), 'charge_point:write');

    const existing = await one(`SELECT id FROM charge_point WHERE ocpp_identity = $1`, [identity]);
    if (existing) return reply.status(409).send({ error: 'that identity is already registered' });
    const claim = await claimProblem(req, identity);
    if (claim) return reply.status(409).send(claim);

    // The wizard's full hardware profile and topology. All optional, so the
    // v1.2.1 two-field call still works exactly as before.
    const ocppVersion = b.ocppVersion === 'ocpp2.0.1' || b.ocppVersion === 'ocpp2.1' || b.ocppVersion === 'ocpp1.6' ? String(b.ocppVersion) : null;
    const evses = Array.isArray(b.evses) ? (b.evses as EvseSpec[]) : null;
    if (evses) {
      const problems = validateTopology(evses, ocppVersion ?? 'ocpp1.6');
      if (problems.length) return reply.status(422).send({ error: problems[0], problems });
    }

    const row = await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, status, adopted_at, first_seen_at,
                                 display_name, vendor, model, serial, firmware, ocpp_version)
       VALUES ($1,$2,'pending_adoption', now(),
               (SELECT min(ts) FROM connection_attempt WHERE ocpp_identity = $2),
               $3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        String(b.siteId),
        identity,
        b.displayName ? String(b.displayName).slice(0, 200) : null,
        b.vendor ? String(b.vendor).slice(0, 100) : null,
        b.model ? String(b.model).slice(0, 100) : null,
        b.serial ? String(b.serial).slice(0, 100) : null,
        b.firmware ? String(b.firmware).slice(0, 100) : null,
        ocppVersion,
      ],
    );
    if (evses && row) await applyTopology(row.id, evses);
    // In a developer sandbox every charger is virtual: the gateway simulates it
    // (it answers Pending at boot until activated, like real hardware).
    if (row && (await isSandboxOrg(req.principal.orgId))) {
      await query(`UPDATE charge_point SET virtual = true, ocpp_version = COALESCE(ocpp_version, 'ocpp1.6') WHERE id = $1`, [row.id]);
      afterResponse(reply.raw, () => sandboxCall('*', 'sync'), (e) => logger.warn({ err: e.message }, 'sandbox fleet sync failed'));
    }
    await writeAudit({
      orgId: req.principal.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action: 'charge_point.registered',
      targetType: 'charge_point',
      targetId: identity,
      after: {
        siteId: b.siteId,
        vendor: b.vendor ?? null,
        model: b.model ?? null,
        ocppVersion,
        evses: evses?.length ?? 0,
      },
      ip: req.ip,
    });
    return {
      ok: true,
      chargePointId: row?.id,
      identity,
      status: 'pending_adoption',
      next: [
        `POST /v1/charge-points/${identity}/authorization-key — issue the Basic credential and set it on the unit`,
        `PUT  /v1/charge-points/${identity}/security-profile — match what the charger will offer`,
        `POST /v1/charge-points/${identity}/activate — allow it to transact`,
      ],
    };
  });

  app.post('/v1/pending-chargers/:identity/adopt', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const siteId = String((req.body as any)?.siteId ?? '');
    await ownedSite(req, siteId, 'charge_point:write');

    const existing = await one(`SELECT id FROM charge_point WHERE ocpp_identity = $1`, [identity]);
    if (existing) throw new BadRequestError('that identity is already registered');
    const claim = await claimProblem(req, identity);
    if (claim) return reply.status(409).send(claim);

    const row = await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, status, adopted_at, first_seen_at)
       VALUES ($1,$2,'pending_adoption', now(),
               (SELECT min(ts) FROM connection_attempt WHERE ocpp_identity = $2))
       RETURNING id`,
      [siteId, identity],
    );
    await writeAudit({
      orgId: req.principal.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action: 'charge_point.adopted',
      targetType: 'charge_point',
      targetId: identity,
      after: { siteId },
      ip: req.ip,
    });
    return { ok: true, chargePointId: row?.id, identity };
  });

  app.post('/v1/charge-points/:identity/activate', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    const r = await query(
      `UPDATE charge_point SET status = 'offline', commissioned_at = COALESCE(commissioned_at, now())
        WHERE id = $1 AND status = 'pending_adoption'`,
      [owner.chargePointId],
    );
    if ((r.rowCount ?? 0) > 0) {
      await writeAudit({
        orgId: owner.orgId,
        actorType: 'user',
        actorId: req.principal.userId,
        action: 'charge_point.activated',
        targetType: 'charge_point',
        targetId: identity,
        ip: req.ip,
      });
      // A connected unit waiting at Pending retries BootNotification on its own
      // interval (60 s); ask it to boot now so the wizard sees it adopt at once.
      if (registry.isOnline(identity)) {
        const actor = actorOf(req);
        afterResponse(reply.raw, () => commands.triggerMessage(identity, 'BootNotification', undefined, actor));
      }
    }
    return { ok: true, activated: (r.rowCount ?? 0) > 0 };
  });

  /**
   * Suspend: take a unit out of service without revoking its credentials. The
   * gateway answers its BootNotification Pending and refuses new authorisations
   * and starts (adapter16 stationRefusal); a session already running is left to
   * finish, and its MeterValues and stop are still accepted. Resume reverses it.
   */
  app.post('/v1/charge-points/:identity/suspend', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    const reason = String((req.body as any)?.reason ?? '').trim().slice(0, 500) || null;
    const r = await query(
      `UPDATE charge_point SET status = 'suspended'
        WHERE id = $1 AND status <> ALL($2::text[])`,
      [owner.chargePointId, assets.ADMINISTRATIVE_STATES],
    );
    if ((r.rowCount ?? 0) === 0) {
      const cur = await one<{ status: string }>(`SELECT status FROM charge_point WHERE id = $1`, [owner.chargePointId]);
      throw new ConflictError(
        cur?.status === 'suspended' ? 'this charge point is already suspended'
          : `a charge point that is ${cur?.status === 'pending_adoption' ? 'awaiting adoption' : cur?.status} cannot be suspended`,
      );
    }
    await writeAudit({
      orgId: owner.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action: 'charge_point.suspended',
      targetType: 'charge_point',
      targetId: identity,
      after: { reason },
      ip: req.ip,
    });
    // A suspension is planned downtime, not an outage: end any open outage (and its alert).
    await closeOutage(identity);
    // Drivers holding a reservation or a queue offer on it lose nothing: released,
    // fee waived or refunded, queue place kept (v1.4.4).
    // Database changes here, in this request's transaction; CancelReservation, driver
    // notices and queue re-allocation after the response (so after the commit).
    const released = await (await import('../driver/reservations.js')).releaseForSuspension(owner.chargePointId);
    if (released.count) afterResponse(reply.raw, released.after, (e) => logger.warn({ cp: identity, err: e.message }, 'post-suspension release steps failed'));
    return { ok: true, reservationsReleased: released.count };
  });

  app.post('/v1/charge-points/:identity/resume', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:write');
    // A unit still connected is online now: it stayed Accepted while suspended, and
    // some firmware ignores the BootNotification trigger below. Otherwise 'offline',
    // with any outage counted from now rather than from before the suspension.
    const connected = registry.isOnline(identity);
    const r = await query(
      `UPDATE charge_point SET status = $2,
              offline_since = CASE WHEN $2 = 'online' THEN NULL ELSE now() END
        WHERE id = $1 AND status = 'suspended'`,
      [owner.chargePointId, connected ? 'online' : 'offline'],
    );
    if ((r.rowCount ?? 0) === 0) throw new ConflictError('this charge point is not suspended');
    await writeAudit({
      orgId: owner.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action: 'charge_point.resumed',
      targetType: 'charge_point',
      targetId: identity,
      ip: req.ip,
    });
    if (!connected) await outageFromResume(identity);
    // A suspended unit re-asks at its Pending interval; ask it to boot now.
    if (registry.isOnline(identity)) {
      const actor = actorOf(req);
      afterResponse(reply.raw, () => commands.triggerMessage(identity, 'BootNotification', undefined, actor));
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------- quirks

  app.get('/v1/quirks', async (req) => {
    assertCan(req.principal, { permission: 'charge_point:read' });
    return listQuirkProfiles();
  });

  // ---------------------------------------------------------------- sessions

  /**
   * Session records. Still an array (the v1.2.1 contract), now filterable and
   * with the financial breakdown per row. The console uses /v1/sessions/search,
   * which adds totals and paging.
   */
  app.get('/v1/sessions', async (req) => {
    assertCanAny(req.principal, 'session:read');
    const q = (req.query ?? {}) as Record<string, string>;
    const limit = limitParam(q.limit, 50, 500);
    const visible = visibleSiteIds(req.principal, 'session:read');
    const hasFilter = ['from', 'to', 'siteId', 'identity', 'connectorType', 'paymentStatus', 'state', 'q'].some((k) => q[k]);
    // Site-scoped viewers get masked card numbers and no holder names (see protectDriverData).
    if (!hasFilter) {
      const rows = await recentSessions(req.principal.orgId, limit, visible);
      return visible ? rows.map((r: any) => protectDriverData(r)) : rows;
    }
    const r = await searchSessions(req.principal.orgId, { ...q, limit }, visible);
    return r.rows;
  });

  app.get('/v1/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const owner = await orgOfSession(id);
    if (!owner) throw new NotFoundError('not found');
    assertCan(req.principal, { permission: 'session:read', orgId: owner.orgId, siteId: owner.siteId });

    const s = await one(
      `SELECT cs.*, d.lines, d.subtotal_idr, d.pbjt_idr, d.pbjt_rate_bps, d.ppn_dpp_idr,
              d.ppn_idr, d.total_idr, d.tariff_snapshot, d.regulatory_flags
         FROM charging_session cs LEFT JOIN cdr d ON d.session_id = cs.id
        WHERE cs.id = $1`,
      [id],
    );
    const mv = await many(
      `SELECT ts, measurand, value, unit, phase FROM meter_value WHERE session_id = $1 ORDER BY ts`,
      [id],
    );
    // ISO 15118 needs, energy given back and the driver's consent (bidirectional charging).
    // soc_percent is NUMERIC in Postgres (a string on the wire from pg): the API documents a number.
    const soc = (s as any)?.soc_percent;
    return { ...(s as object), soc_percent: soc == null ? null : Number(soc), meterValues: mv, v2x: await v2xView(id) };
  });

  // Signed meter data (OCMF): what the meter signed for this session, and how it checked out.
  app.get('/v1/sessions/:id/signed-data', async (req) => {
    const { id } = req.params as { id: string };
    const owner = await orgOfSession(id);
    if (!owner) throw new NotFoundError('not found');
    assertCan(req.principal, { permission: 'session:read', orgId: owner.orgId, siteId: owner.siteId });
    return signedDataFor(id);
  });

  // The same, as a file for the S.A.F.E. Transparency Software (signed values with the meter's key).
  app.get('/v1/sessions/:id/signed-data.xml', async (req, reply) => {
    const { id } = req.params as { id: string };
    const owner = await orgOfSession(id);
    if (!owner) throw new NotFoundError('not found');
    assertCan(req.principal, { permission: 'session:read', orgId: owner.orgId, siteId: owner.siteId });
    const d = await signedDataFor(id);
    if (!d || !d.values.length) throw new NotFoundError('this session has no signed meter data');
    return reply
      .header('content-type', 'application/xml; charset=utf-8')
      .header('content-disposition', `attachment; filename="signed-meter-data-${id}.xml"`)
      .send(transparencyXml(d));
  });

  /**
   * Ask an OCPP 2.0.1 / 2.1 station to sign its meter readings (OCMF), and to send
   * the meter's public key with them once per transaction. OCPP 1.6 has no standard
   * setting for it: the vendor's own configuration does it there.
   */
  app.post('/v1/charge-points/:identity/signed-metering', async (req, reply) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'charge_point:config');
    const enabled = (req.body as any)?.enabled !== false;
    const version = await commands.wireVersion(identity);
    if (version !== 'ocpp2.0.1' && version !== 'ocpp2.1') {
      return reply.status(409).send({ error: 'OCPP 1.6 has no standard setting for signed readings: switch them on in the charger’s own configuration.', code: 'not_ocpp2' });
    }
    const actor = { type: 'user' as const, id: req.principal.userId, orgId: owner.orgId, ip: req.ip };
    const v = (component: string, variable: string, value: string) => ({ component: { name: component }, variable: { name: variable }, attributeValue: value });
    const r = await commands.setVariables(identity, [
      v('SampledDataCtrlr', 'SignReadings', String(enabled)),
      v('AlignedDataCtrlr', 'SignReadings', String(enabled)),
      v('OCPPCommCtrlr', 'PublicKeyWithSignedMeterValue', enabled ? 'OncePerTransaction' : 'Never'),
    ], actor);
    const results = (r?.setVariableResult ?? []).map((x) => ({ component: x.component?.name, variable: x.variable?.name, status: x.attributeStatus }));
    return { enabled, accepted: results.length > 0 && results.every((x) => x.status === 'Accepted' || x.status === 'RebootRequired'), results };
  });

  /**
   * Clear a review flag and bill.
   *
   * `force` exists because without it a session parked by a rating-level
   * violation could never be billed by anyone: re-rating hit the same violation
   * and re-parked, `force: true` had no caller anywhere in the codebase, and the
   * route answered HTTP 200 `{"ok": false}` — which a console reads as success.
   * Every session on a misconfigured connector accumulated the same permanent
   * loss, silently.
   *
   * Forcing is a deliberate operator act on a session the engine says it cannot
   * price correctly, so it is audited separately and the response says plainly
   * what happened rather than returning a bare false.
   */
  app.post('/v1/sessions/:id/rerate', async (req) => {
    const { id } = req.params as { id: string };
    const force = (req.body as any)?.force === true;
    const owner = await orgOfSession(id);
    if (!owner) throw new NotFoundError('not found');
    assertCan(req.principal, { permission: 'session:write', orgId: owner.orgId, siteId: owner.siteId });
    await writeAudit({
      orgId: owner.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action: force ? 'session.rated_under_override' : 'session.review_cleared',
      targetType: 'session',
      targetId: id,
      after: force ? { force: true } : null,
      ip: req.ip,
    });
    const cdr = await clearReviewAndRate(id, req.principal.orgId, force);
    if (cdr) return { ok: true, cdr, forced: force };

    const row = await one<{ review_reason: string | null; needs_review: boolean }>(
      `SELECT review_reason, needs_review FROM charging_session WHERE id = $1 AND org_id = $2`,
      [id, req.principal.orgId],
    );
    if (!row) throw new NotFoundError('not found');
    return {
      ok: false,
      cdr: null,
      reason: row.review_reason ?? 'the rating engine declined to price this session',
      hint:
        'The tariff assigned to this connector cannot price this session. Correct the tariff and ' +
        'retry, or POST {"force": true} to bill it as rated anyway — that is recorded in the audit log.',
    };
  });

  app.post('/v1/sessions/reconcile', async (req) => {
    assertCan(req.principal, { permission: 'session:write' });
    // Scoped to the caller's organisation. Unscoped, this route let any tenant
    // force-close and bill every other tenant's live sessions.
    return reconcileStuckSessions(req.principal.orgId);
  });

  // ---------------------------------------------------------------- tariffs

  app.get('/v1/tariffs', async (req) => {
    assertCan(req.principal, { permission: 'tariff:read' });
    return listTariffs(req.principal.orgId);
  });

  /**
   * Tariff creation. THIS is the write path the ceiling check was missing —
   * `validateTariff` previously had no caller on any write path, and there was no
   * write path at all, so an illegal tariff could be inserted straight into the
   * database and would bill at 5.5x the legal maximum.
   */
  app.post('/v1/tariffs', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    const b = req.body as any;
    // Bank Indonesia prohibits passing the QRIS MDR to the consumer as a surcharge;
    // the CPO absorbs it (and may build it into the kWh price instead).
    if (b.mdrMode && b.mdrMode !== 'absorb') {
      return reply.status(422).send({
        error:
          'The QRIS MDR cannot be surcharged to the customer — Bank Indonesia QRIS rules prohibit it. ' +
          'Absorb it, or build it into the energy price.',
        flags: [{ code: 'MDR_SURCHARGE_PROHIBITED', severity: 'violation', message: 'MDR surcharging is prohibited' }],
      });
    }
    const result = await createTariff({
      orgId: req.principal.orgId,
      name: String(b.name ?? 'Untitled'),
      plnScheme: b.plnScheme,
      plnBaseRate: b.plnBaseRate,
      plnMultiplier: b.plnMultiplier,
      activeFrom: b.activeFrom ? new Date(b.activeFrom) : undefined,
      activeTo: b.activeTo ? new Date(b.activeTo) : null,
      components: b.components ?? [],
      appliesToMaxPowerW: Number(b.appliesToMaxPowerW ?? 60_000),
      createdBy: req.principal.userId,
      description: b.description ? String(b.description).slice(0, 1000) : null,
      pricingModel: ['flat', 'tou', 'tiered'].includes(b.pricingModel) ? b.pricingModel : 'flat',
      ppnApplies: b.ppnApplies !== false,
    });
    if (!result.ok) {
      return reply.status(422).send({
        error: 'tariff violates a regulatory ceiling and was not saved',
        flags: result.flags,
      });
    }
    await writeAudit({
      orgId: req.principal.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action: 'tariff.created',
      targetType: 'tariff',
      targetId: result.tariffId!,
      after: { name: b.name, components: b.components },
      ip: req.ip,
    });
    return result;
  });

  app.post('/v1/tariffs/:id/assign', async (req, reply) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    const { id } = req.params as { id: string };
    const b = req.body as any;
    const owned = await one(`SELECT id FROM tariff WHERE id = $1 AND org_id = $2`, [id, req.principal.orgId]);
    if (!owned) throw new NotFoundError('tariff not found');
    if (b.scopeType === 'site') await ownedSite(req, String(b.scopeId), 'tariff:write');
    // An org-scoped assignment always means THIS org — never a scopeId the
    // caller supplies, which would attach a tariff outside their tenant.
    const scopeId = b.scopeType === 'org' ? req.principal.orgId : (b.scopeId ?? null);
    if (!['org', 'site', 'connector'].includes(b.scopeType)) throw new BadRequestError('scopeType must be org, site or connector');
    if (b.scopeType === 'connector') {
      const own = await one<{ org_id: string }>(
        `SELECT s.org_id FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id
           JOIN site s ON s.id = cp.site_id WHERE c.id = $1`,
        [String(scopeId)],
      );
      if (!own || own.org_id !== req.principal.orgId) throw new NotFoundError('connector not found');
    }
    const currentType = b.currentType === 'AC' || b.currentType === 'DC' ? b.currentType : null;

    // Re-validated against the connectors it will actually price: the ceiling
    // comes from nameplate power, and createTariff only saw the caller's own
    // declared figure. A tariff blessed for an ultrafast connector and attached
    // to a fast one made every session on it permanently unbillable.
    const result = await assignTariff(id, b.scopeType, scopeId, Number(b.priority ?? 0), currentType);
    if (!result.ok) {
      return reply.status(409).send({
        ok: false,
        error: 'this tariff is not legal for the connectors in that scope',
        flags: result.flags,
      });
    }
    await writeAudit({
      orgId: req.principal.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action: 'tariff.assigned',
      targetType: 'tariff',
      targetId: id,
      after: { scopeType: b.scopeType, scopeId, priority: Number(b.priority ?? 0) },
      ip: req.ip,
    });
    return { ok: true, flags: result.flags };
  });

  app.post('/v1/tariffs/preview', async (req) => {
    assertCan(req.principal, { permission: 'tariff:read' });
    const b = req.body as any;
    return rateSession(b.tariff, {
      startedAt: new Date(b.startedAt ?? Date.now() - 3600_000),
      endedAt: new Date(b.endedAt ?? Date.now()),
      energyWh: Number(b.energyWh ?? 20_000),
      connectorMaxPowerW: Number(b.connectorMaxPowerW ?? 60_000),
      pbjtRateBps: Number(b.pbjtRateBps ?? 500),
      idleMinutes: Number(b.idleMinutes ?? 0),
    });
  });

  app.post('/v1/tariffs/validate', async (req) => {
    assertCan(req.principal, { permission: 'tariff:write' });
    const b = req.body as any;
    return { flags: validateTariff(b.tariff, Number(b.connectorMaxPowerW ?? 60_000)) };
  });

  // ------------------------------------------- payments (Tier 3: QRIS prepaid)

  app.post('/v1/checkout/qris', async (req, reply) => {
    const b = req.body as any;
    const amountIdr = Number(b.amountIdr);
    if (!Number.isFinite(amountIdr) || amountIdr <= 0) throw new BadRequestError('amountIdr required');
    if (amountIdr > QRIS_MAX_TRANSACTION_IDR) {
      throw new BadRequestError(`QRIS per-transaction ceiling is Rp ${QRIS_MAX_TRANSACTION_IDR}`);
    }

    const owner = await ownedChargePoint(req, String(b.ocppIdentity), 'payment:write');
    const c = await assets.getConnector(owner.chargePointId, Number(b.connectorId ?? 1));
    if (!c) throw new NotFoundError('connector not found');

    const gate = connectorMaySellEnergy(c.tera_status as any);
    if (!gate.allowed) return reply.status(409).send({ error: gate.reason });
    // Never sell a session the charger will refuse (v1.4.4): suspended, unadopted,
    // decommissioned, or a connector on maintenance hold.
    const cpState = await one<{ status: string; on_hold: boolean }>(
      `SELECT cp.status, (SELECT maintenance_reason IS NOT NULL FROM connector WHERE id = $2) AS on_hold
         FROM charge_point cp WHERE cp.id = $1`, [owner.chargePointId, c.id]);
    if (cpState && assets.ADMINISTRATIVE_STATES.includes(cpState.status)) {
      return reply.status(409).send({ error: `this charge point is ${cpState.status === 'pending_adoption' ? 'awaiting adoption' : cpState.status} and cannot sell a session` });
    }
    if (cpState?.on_hold) return reply.status(409).send({ error: 'this connector is on maintenance hold' });

    const now = new Date();
    const { tariff } = await loadTariffForConnector(c.id, c.org_id, now);
    // A pre-purchase is a RESERVATION and must reserve the worst case — the most
    // expensive ToU block the session could reach, plus the idle fee it could
    // accrue. Quoting the best case under-collected by up to Rp 58,552 a session
    // from walk-up guests who have no card on file.
    const allowanceWh = conservativeAllowanceWh(tariff, amountIdr, {
      startedAt: now,
      endedAt: new Date(now.getTime() + 45 * 60_000),
      connectorMaxPowerW: c.max_power_w,
      pbjtRateBps: c.pbjt_rate_bps,
      timezone: c.timezone,
    });

    // Selling a tier that buys nothing is taking money for no electricity. The
    // seeded production tariff carries Rp 33,800 of fixed fees, so every tier
    // below that returned an allowance of zero — with an HTTP 200.
    if (allowanceWh <= 0) {
      return reply.status(422).send({
        error:
          `Rp ${amountIdr.toLocaleString('id-ID')} does not cover this connector's fixed fees, ` +
          'so it would buy no energy. Choose a higher amount.',
        minimumViableIdr: minimumViable(tariff, {
          startedAt: now,
          endedAt: new Date(now.getTime() + 45 * 60_000),
          connectorMaxPowerW: c.max_power_w,
          pbjtRateBps: c.pbjt_rate_bps,
          timezone: c.timezone,
        }),
      });
    }

    let acq: Awaited<ReturnType<typeof paymentsFor>>;
    try { acq = await paymentsFor(c.org_id); } catch (e) {
      if (e instanceof PaymentsUnavailable) return reply.status(409).send({ error: e.message, code: 'payments_not_configured' });
      throw e;
    }
    const charge = await acq.provider.createQrisCharge({
      referenceId: `${owner.chargePointId}:${c.id}:${Date.now()}`,
      amountIdr,
      description: `PlugSure ${b.ocppIdentity} connector ${b.connectorId ?? 1}`,
    });

    /**
     * Record WHO is buying this energy.
     *
     * Without it the intent belonged to the connector, not to a person: the
     * next transaction started on that connector took the money, whoever it
     * belonged to. A driver who paid Rp 500,000 lost all of it to someone who
     * plugged in first, and there is no refund path in the system to make them
     * whole.
     *
     * A driver with a token supplies it. A walk-up — which is the case QRIS is
     * for — gets one minted here and shown on the payment screen; they present
     * it at the reader, or the app passes it to RemoteStartTransaction. Either
     * way the charger must present this exact idTag to claim the payment.
     */
    const suppliedTag = typeof b.idToken === 'string' ? b.idToken.trim() : '';
    if (suppliedTag && !/^[\x20-\x7e]{1,20}$/.test(suppliedTag)) {
      throw new BadRequestError('idToken must be at most 20 printable ASCII characters (OCPP CiString20)');
    }
    if (suppliedTag) {
      // It must be a token this organisation actually issued, or anyone could
      // bind a payment to a token they do not hold.
      const known = await one(`SELECT id FROM token WHERE org_id = $1 AND uid = $2`, [c.org_id, suppliedTag]);
      if (!known) throw new BadRequestError('unknown idToken for this organisation');
    }
    const claimTag = suppliedTag || `PS-${randomBytes(6).toString('hex').toUpperCase()}`;
    const minted = !suppliedTag;

    if (minted) {
      // A minted token has to be authorisable, or the charger will refuse the
      // start and the driver has paid for a session that cannot begin. It is
      // single-use: bound to this intent and blocked once the session ends.
      await query(
        // valid_to = the claim window: a charger's offline local cache also expires it.
        `INSERT INTO token (org_id, kind, uid, status, valid_to)
         VALUES ($1,'prepaid',$2,'Accepted', now() + make_interval(mins => $3::int))
         ON CONFLICT (org_id, uid) DO NOTHING`,
        [c.org_id, claimTag, PREPAID_CLAIM_WINDOW_MIN],
      );
    }

    const intent = await one<{ id: string }>(
      `INSERT INTO payment_intent
         (org_id, provider, provider_ref, method, mode, state, amount_authorised_idr,
          idem_key, allowance_wh, connector_uuid, claim_id_tag, claim_token_minted, expires_at, integration_id)
       VALUES ($1,$8,$2,'qris','prepurchase','pending',$3,$2,$4,$5,$6,$7, now() + interval '30 minutes', $9)
       RETURNING id`,
      [c.org_id, charge.providerRef, amountIdr, allowanceWh, c.id, claimTag, minted, acq.provider.name, acq.resolved.integrationId],
    );

    await logPaymentCreated(acq.resolved, c.org_id, charge.providerRef, amountIdr, 'console checkout');
    return {
      paymentIntentId: intent?.id,
      provider: acq.provider.name,
      qr: charge,
      allowanceWh,
      allowanceKwh: Math.round(allowanceWh / 10) / 100,
      estimatedMdrIdr: estimateQrisMdrIdr(amountIdr),
      inZeroMdrBand: estimateQrisMdrIdr(amountIdr) === 0,
      /** Show this to the driver. Only this token can start the session they paid for. */
      startToken: claimTag,
      startTokenMinted: minted,
      expiresInMinutes: 30,
    };
  });

  app.post('/v1/checkout/qris/:providerRef/simulate-payment', async (req, reply) => {
    assertCan(req.principal, { permission: 'payment:write' });
    if (config.env !== 'development') {
      return reply.status(403).send({ error: 'the payment simulator is development-only' });
    }
    const { providerRef } = req.params as { providerRef: string };
    const charge = await sandboxAcquirer.simulatePayment(providerRef);
    if (!charge) throw new NotFoundError('unknown charge');
    await query(
      `UPDATE payment_intent
          SET state = 'captured', amount_captured_idr = amount_authorised_idr,
              captured_at = now(), updated_at = now()
        WHERE provider_ref = $1 AND org_id = $2 AND provider = 'mock'`,
      [providerRef, req.principal.orgId],
    );
    return { ok: true, charge };
  });

  // ---------------------------------------------------------- smart charging

  app.get('/v1/sites/:siteId/power', async (req) => {
    const { siteId } = req.params as { siteId: string };
    await ownedSite(req, siteId, 'smartcharging:read');
    const headroom = await kvaHeadroom(siteId);
    if (!headroom) throw new NotFoundError('site not found');
    const budget = await loadSiteBudget(siteId);
    const demands = await collectDemands(siteId);
    const usable = budget?.curtailed ? 0 : Math.max(0, (budget?.ceilingW ?? 0) - (budget?.reserveW ?? 0));
    const plan = allocate(usable, forStrategy(demands, budget?.strategy ?? 'fair_share'));
    return {
      headroom,
      budget,
      plan,
      /** The hard cap the ceiling slider may not cross: connected kVA × PF. */
      subscriptionCeilingW: budget ? subscriptionCeilingW(budget.connectedKva, budget.powerFactor) : null,
      usableW: usable,
    };
  });

  app.post('/v1/sites/:siteId/power/apply', async (req) => {
    const { siteId } = req.params as { siteId: string };
    await ownedSite(req, siteId, 'smartcharging:write');
    return { applied: await runControlLoop(siteId) };
  });

  app.post('/v1/sites/:siteId/power/provision-defaults', async (req) => {
    const { siteId } = req.params as { siteId: string };
    await ownedSite(req, siteId, 'smartcharging:write');
    return { applied: await provisionDefaultProfile(siteId) };
  });

  app.get('/v1/charge-points/:identity/profiles/reconcile', async (req) => {
    const { identity } = req.params as { identity: string };
    const owner = await ownedChargePoint(req, identity, 'smartcharging:read');
    return reconcileProfiles(owner.chargePointId);
  });

  app.put('/v1/sites/:siteId/power/budget', async (req, reply) => {
    const { siteId } = req.params as { siteId: string };
    const owner = await ownedSite(req, siteId, 'smartcharging:write');
    const b = req.body as any;
    const before = await loadSiteBudget(siteId);
    if (!before) throw new NotFoundError('site not found');

    // Auxiliary reserve: either a breakdown (lighting, POS, CCTV, HVAC, other) or a single figure.
    const breakdown: Record<string, number> = {};
    if (b.reserveBreakdown && typeof b.reserveBreakdown === 'object') {
      for (const k of ['lighting', 'pos', 'cctv', 'hvac', 'other']) {
        const v = Number(b.reserveBreakdown[k] ?? 0);
        if (!Number.isFinite(v) || v < 0) throw new BadRequestError(`reserve for ${k} must be zero or more watts`);
        if (v > 0) breakdown[k] = Math.round(v);
      }
    }
    const reserveW = b.reserveBreakdown
      ? Object.values(breakdown).reduce((a, v) => a + v, 0)
      : Math.round(Number(b.reserveW ?? before.reserveW ?? 0));
    const ceilingW = Math.round(Number(b.ceilingW ?? before.configuredCeilingW ?? before.ceilingW));
    const strategy = b.strategy ?? before.strategy ?? 'fair_share';
    if (!['fair_share', 'priority', 'fifo'].includes(strategy)) throw new BadRequestError('strategy must be fair_share, priority or fifo');
    const curtailed = b.curtailed === undefined ? before.curtailed : Boolean(b.curtailed);

    // PLUGSURE-FIX-CAP-01, enforced at the source: a ceiling above the PLN
    // subscription (connected kVA × PF) is REFUSED, not silently clamped later.
    const problem = budgetProblem({ ceilingW, reserveW }, before.connectedKva, before.powerFactor);
    if (problem) return reply.status(422).send({ error: problem.message, field: problem.field, maxW: problem.maxW });

    await query(
      `INSERT INTO site_power_budget (site_id, ceiling_w, reserve_w, strategy, curtailed, reserve_breakdown,
                                      curtailed_at, curtailed_reason)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN $7 END)
       ON CONFLICT (site_id) DO UPDATE
         SET ceiling_w = EXCLUDED.ceiling_w, reserve_w = EXCLUDED.reserve_w,
             strategy = EXCLUDED.strategy, curtailed = EXCLUDED.curtailed,
             reserve_breakdown = EXCLUDED.reserve_breakdown,
             curtailed_at = CASE WHEN EXCLUDED.curtailed AND NOT site_power_budget.curtailed THEN now()
                                 WHEN EXCLUDED.curtailed THEN site_power_budget.curtailed_at END,
             curtailed_reason = CASE WHEN EXCLUDED.curtailed THEN COALESCE(EXCLUDED.curtailed_reason, site_power_budget.curtailed_reason) END,
             updated_at = now()`,
      [siteId, ceilingW, reserveW, strategy, curtailed, JSON.stringify(breakdown), b.curtailedReason ?? null],
    );
    // Budget changes were unaudited. Only OCPP commands called writeAudit, so a
    // destructive curtailment left no trail at all.
    await writeAudit({
      orgId: owner.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action: 'site.power_budget.changed',
      targetType: 'site',
      targetId: siteId,
      before: before as unknown as Record<string, unknown>,
      after: { ceilingW, reserveW, reserveBreakdown: breakdown, strategy, curtailed, curtailedReason: b.curtailedReason ?? null },
      ip: req.ip,
    });
    // A curtailment (genset switch) must take effect NOW, not on the next 30 s
    // loop — and lifting it should restore charging just as promptly.
    if (curtailed !== before.curtailed || b.applyNow === true) {
      // After the commit, and outside the request transaction: the loop must read the NEW budget,
      // and a failure in it must not roll back the operator's change.
      afterResponse(reply.raw, () => runControlLoop(siteId), (e) => logger.warn({ err: e.message, siteId }, 'immediate control loop failed'));
    }
    return loadSiteBudget(siteId);
  });

  // ---------------------------------------------------------------- compliance

  app.get('/v1/compliance', async (req) => {
    assertCanAny(req.principal, 'compliance:read');
    const visible = visibleSiteIds(req.principal, 'compliance:read');
    return (await complianceReport(req.principal.orgId)).filter((s: any) => visible === null || visible.includes(s.id));
  });

  // ---------------------------------------------------------------- audit

  app.get('/v1/audit', async (req) => {
    assertCan(req.principal, { permission: 'audit:read' });
    const rows = await many(
      `SELECT ts, actor_type, actor_id, action, target_type, target_id, after_state
         FROM audit_log WHERE org_id = $1 ORDER BY id DESC LIMIT 200`,
      [req.principal.orgId],
    );
    return { entries: rows, chain: await verifyChain(req.principal.orgId) };
  });

  // ---------------------------------------------------------------- api keys

  /** A key's own limit from a request body: absent = unchanged, null or '' = the default. */
  const rateLimitOf = (v: unknown): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new BadRequestError('rateLimitPerMin must be a whole number of requests a minute, 1 to 100000 (or null for the default)');
    return n;
  };

  app.get('/v1/api-keys', async (req) => {
    assertCan(req.principal, { permission: 'org:read' });
    // Counts still in memory are written first, so the numbers are current.
    await outsideRequestScope(() => flushUsage());
    return many(
      `SELECT k.id, k.name, k.prefix, k.permissions, k.scope_type, k.scope_id, k.created_at, k.last_used_at, k.revoked_at,
              k.rate_limit_per_min, COALESCE(k.rate_limit_per_min, $2::int) AS effective_rate_limit_per_min,
              COALESCE(u.requests, 0)::int AS requests_24h, COALESCE(u.limited, 0)::int AS limited_24h, COALESCE(u.errors, 0)::int AS errors_24h
         FROM api_key k
         LEFT JOIN (SELECT api_key_id, sum(requests) AS requests, sum(limited) AS limited, sum(errors) AS errors
                      FROM api_key_usage WHERE org_id = $1 AND hour > now() - interval '24 hours' GROUP BY api_key_id) u
                ON u.api_key_id = k.id
        WHERE k.org_id = $1 ORDER BY k.created_at DESC`,
      [req.principal.orgId, config.api.keyRateLimitPerMin],
    );
  });

  app.patch('/v1/api-keys/:id', async (req) => {
    assertCan(req.principal, { permission: 'org:write' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('api key not found');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const limit = rateLimitOf(b.rateLimitPerMin);
    const name = b.name === undefined ? undefined : String(b.name).trim().slice(0, 120);
    if (name === '') throw new BadRequestError('The name cannot be empty');
    const before = await one<{ name: string; rate_limit_per_min: number | null }>(
      `SELECT name, rate_limit_per_min FROM api_key WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`, [id, req.principal.orgId]);
    if (!before) throw new NotFoundError('api key not found');
    const row = await one(
      `UPDATE api_key SET name = COALESCE($3, name), rate_limit_per_min = CASE WHEN $4 THEN $5::int ELSE rate_limit_per_min END
        WHERE id = $1 AND org_id = $2
        RETURNING id, name, prefix, permissions, scope_type, scope_id, created_at, last_used_at, revoked_at,
                  rate_limit_per_min, COALESCE(rate_limit_per_min, $6::int) AS effective_rate_limit_per_min`,
      [id, req.principal.orgId, name ?? null, limit !== undefined, limit ?? null, config.api.keyRateLimitPerMin],
    );
    await writeAudit({
      orgId: req.principal.orgId, actorType: 'user', actorId: req.principal.userId, action: 'api_key.updated',
      targetType: 'api_key', targetId: id, before, after: { name: name ?? before.name, rate_limit_per_min: limit === undefined ? before.rate_limit_per_min : limit }, ip: req.ip,
    });
    return row;
  });

  app.get('/v1/api-keys/:id/usage', async (req) => {
    assertCan(req.principal, { permission: 'org:read' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw new NotFoundError('api key not found');
    const key = await one(`SELECT id FROM api_key WHERE id = $1 AND org_id = $2`, [id, req.principal.orgId]);
    if (!key) throw new NotFoundError('api key not found');
    const hours = Math.min(24 * 31, Math.max(1, Math.floor(Number((req.query as any)?.hours ?? 48)) || 48));
    await outsideRequestScope(() => flushUsage());
    return many(
      `SELECT hour, requests, limited, errors FROM api_key_usage
        WHERE api_key_id = $1 AND org_id = $2 AND hour > now() - make_interval(hours => $3)
        ORDER BY hour`,
      [id, req.principal.orgId, hours],
    );
  });

  app.post('/v1/api-keys', async (req) => {
    assertCan(req.principal, { permission: 'org:write' });
    const b = req.body as any;
    // A key may never carry authority its issuer does not hold. Without this an
    // org_owner could mint a platform:admin key and take over every tenant.
    const permissions = assertGrantable(req.principal, b.permissions ?? []);
    /**
     * Scoping DOWN is fine; scoping a key at another tenant is not.
     *
     * An org-scoped key with someone else's `scopeId` was accepted and stored.
     * It was inert — `can()` requires an org-scope `scopeId` to equal the
     * principal's org — but a credential row whose scope points at a tenant that
     * does not own it is a landmine for the next person to touch that check, and
     * it makes the key list lie about who can reach what.
     */
    const scopeType = b.scopeType ?? 'org';
    if (!['org', 'site', 'fleet'].includes(scopeType)) {
      throw new BadRequestError("scopeType must be one of 'org', 'site', 'fleet'");
    }
    let scopeId: string | null = b.scopeId ?? null;
    if (scopeType === 'org') {
      // An org-scoped key always scopes to the ISSUER's org, never to a value
      // the caller supplies.
      scopeId = req.principal.orgId;
    } else {
      if (!scopeId || !UUID_RE.test(String(scopeId))) {
        throw new BadRequestError(`a ${scopeType}-scoped key requires a valid scopeId`);
      }
      if (scopeType === 'site') await ownedSite(req, String(scopeId), 'org:write');
    }
    const issued = await issueApiKey({
      orgId: req.principal.orgId,
      name: String(b.name ?? 'unnamed'),
      permissions,
      scopeType,
      scopeId,
      rateLimitPerMin: rateLimitOf(b.rateLimitPerMin) ?? null,
    });
    await writeAudit({
      orgId: req.principal.orgId,
      actorType: 'user',
      actorId: req.principal.userId,
      action: 'api_key.issued',
      targetType: 'api_key',
      targetId: issued.id,
      after: { name: b.name, prefix: issued.prefix, permissions, rate_limit_per_min: rateLimitOf(b.rateLimitPerMin) ?? null },
      ip: req.ip,
    });
    return { ...issued, warning: 'The key is shown once and cannot be retrieved later.' };
  });

  app.delete('/v1/api-keys/:id', async (req) => {
    assertCan(req.principal, { permission: 'org:write' });
    const { id } = req.params as { id: string };
    const ok = await revokeApiKey(id, req.principal.orgId);
    if (!ok) throw new NotFoundError('api key not found');
    return { ok: true };
  });

  // ---------------------------------------------------------------- alerts

  app.get('/v1/alerts', async (req) => {
    // Site-scoped users (Site Host, Site Owner) see only alerts recorded against
    // their sites; alerts with no site (webhooks, platform) are operator-only.
    assertCanAny(req.principal, 'site:read');
    const visible = visibleSiteIds(req.principal, 'site:read');
    return many(
      `SELECT id, severity, kind, message, raised_at, resolved_at, acknowledged_at, occurrences, last_raised_at, site_id
         FROM alert WHERE org_id = $1 AND ($2::uuid[] IS NULL OR site_id = ANY($2))
        ORDER BY raised_at DESC LIMIT 100`,
      [req.principal.orgId, visible],
    );
  });

  // ---------------------------------------------------------------- stream

  app.get('/v1/stream', async (req, reply: FastifyReply) => {
    assertCan(req.principal, { permission: 'site:read' });
    const orgId = req.principal.orgId;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    /**
     * Filter by tenant, failing CLOSED.
     *
     * The first fix here was `if (p?.orgId && p.orgId !== orgId) return`, which
     * only excluded events that carried an orgId — and almost none did. Every
     * connector status change, live session energy reading and charge point
     * connect on the platform still reached every authenticated tenant. An event
     * now has to prove it belongs to this organisation, or be on the explicit
     * global allowlist, to be delivered.
     */
    const send = (e: { kind: string; payload: unknown }) => {
      if (!eventVisibleTo(e, orgId)) return;
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const off = bus.onAny(send);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });

  // The enterprise operator console's API (SPEC-UI-CSMS-2026-FINAL modules 1–10).
  await registerConsoleRoutes(app, {
    ownedChargePoint,
    ownedSite,
    actorOf,
    NotFoundError,
    BadRequestError,
  });

  // The driver-facing app + API (public charging). Separate surface, no org scope.
  await registerDriverApi(app);

  // Roaming: the OCPI 2.2.1 endpoints partners call, and the console's roaming page.
  await registerOcpiApi(app);
  await registerRoamingRoutes(app);
  await registerSandboxRoutes(app);
  await registerFleetRoutes(app);
  await registerFleetPortalRoutes(app);
  await registerPricingRoutes(app);
  await registerPncRoutes(app);
  await registerOnboardingRoutes(app);
  await registerIntegrationRoutes(app);
  await registerBrandRoutes(app);
  await registerConsoleBrandRoutes(app);

  return app;
}

/** Smallest amount that buys a non-zero allowance, for the checkout error. */
function minimumViable(tariff: any, ctx: any): number {
  let lo = 0;
  let hi = 1_000_000;
  for (let i = 0; i < 32; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid === lo) break;
    if (energyAllowanceWh(tariff, mid, ctx) > 0) hi = mid;
    else lo = mid;
  }
  return hi;
}

export async function startApi() {
  // The console's five roles must exist before anyone can be granted one; a
  // deployment that never ran `npm run seed` (every production one) had none.
  await ensureSystemRoles().catch((e) => logger.warn({ err: (e as Error).message }, 'could not provision system roles'));
  const app = await buildApi();
  await app.listen({ port: config.api.port, host: config.api.host });
  logger.info(
    { port: config.api.port, auth: config.api.devNoAuth ? 'DEV BYPASS' : 'bearer' },
    'API + console listening',
  );
  return app;
}
