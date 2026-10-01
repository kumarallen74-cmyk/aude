import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { config, isRelaxedEnv } from '../config.js';
import { logger } from '../logger.js';
import { query } from '../db/pool.js';
import { bus } from '../services/events.js';
import * as assets from '../services/assets.js';
import * as registry from './registry.js';
import { recordAttempt, type AttemptOutcome } from '../services/connections.js';
import { verifyAuthorizationKey, retirePreviousKey } from '../services/chargepoint-keys.js';
import { OcppRpcConnection } from './rpc.js';
import { handle16Call, ensureTxSequence, type AdapterContext } from './adapter16.js';
import { handle201Call } from './adapter201.js';
import { checkClientCert } from './client-cert.js';
import { chargerCa } from '../services/charger-ca.js';
import { ensureQuirkProfile, seedQuirks, recordFinding } from './quirks.js';
import { makeProxyMatcher } from './trusted-proxy.js';
import { provisionChargePoint } from './provisioning.js';
import { handleInternalRequest } from './bridge.js';
import { socketPair, type MemorySocket } from '../sandbox/memory-socket.js';
import type { OcppVersion } from '../domain/canonical.js';

/** Identity sanity. Autel serials are long alphanumerics; nothing legitimate carries a slash. */
const MAX_IDENTITY_LEN = 128;
const IDENTITY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface GatewayHandle {
  http: Server;
  wss: WebSocketServer;
  close(): Promise<void>;
}

export async function startGateway(): Promise<GatewayHandle> {
  await ensureTxSequence();
  await seedQuirks();

  const supported = config.gateway.supportedVersions as OcppVersion[];
  const tlsEnabled = Boolean(config.gateway.tlsKeyPath && config.gateway.tlsCertPath);

  const requestListener = (req: IncomingMessage, res: any) => {
    // API <-> gateway bridge (split deployment). Inert without INTERNAL_API_TOKEN.
    if (handleInternalRequest(req, res)) return;
    // A health endpoint on the gateway itself. Without one, a load balancer's only
    // liveness signal is the 426 below, which says nothing about the database.
    if (req.url === '/healthz' || req.url === '/health') {
      void gatewayHealth()
        .then((h) => {
          res.writeHead(h.ok ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(h));
        })
        .catch(() => {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end('{"ok":false}');
        });
      return;
    }
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade required: this endpoint speaks OCPP-J over WebSocket.\n');
  };

  const http = tlsEnabled
    ? createHttpsServer(
        {
          key: readFileSync(config.gateway.tlsKeyPath),
          cert: readFileSync(config.gateway.tlsCertPath),
          // Security Profile 3 with TLS terminated here: ask every charger for a client
          // certificate, verified against PlugSure's charging-station CA (and
          // OCPP_TLS_CA_PATH). Not required at the handshake — Profile 1/2 chargers
          // have none — the upgrade then checks the one presented against the
          // charger's binding.
          ca: [...(config.gateway.tlsCaPath ? [readFileSync(config.gateway.tlsCaPath, 'utf8')] : []), (await chargerCa()).pem],
          requestCert: true,
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
        },
        requestListener,
      )
    : createHttpServer(requestListener);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.gateway.maxPayloadBytes,
    // Echo exactly ONE negotiated subprotocol, and only one we can actually speak.
    handleProtocols: (protocols) => {
      const offered = new Map([...protocols].map((p) => [p.trim().toLowerCase(), p]));
      for (const v of supported) {
        const hit = offered.get(v);
        if (hit) return hit;
      }
      return false;
    },
  });

  http.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket as Duplex, head, wss, supported).catch((e) => {
      logger.error({ err: e }, 'upgrade handler failed');
      try {
        socket.destroy();
      } catch {}
    });
  });

  await new Promise<void>((res) => http.listen(config.gateway.port, config.gateway.host, res));
  logger.info(
    {
      port: config.gateway.port,
      tls: tlsEnabled ? 'terminated here' : config.gateway.trustProxyProto ? 'expected at proxy' : 'none',
      versions: supported,
      minSecurityProfile: config.gateway.minSecurityProfile,
      autoAdopt: config.gateway.autoAdopt,
    },
    'OCPP gateway listening',
  );

  if (config.gateway.minSecurityProfile === 0) {
    logger.warn(
      'OCPP_MIN_SECURITY_PROFILE=0 — unauthenticated chargers are accepted. Bench use only; production requires 2.',
    );
  }

  /**
   * Profile 2 requires TLS, and TLS has to come from SOMEWHERE.
   *
   * The documented production configuration set OCPP_MIN_SECURITY_PROFILE=2 and
   * terminated TLS at Caddy — but never mentioned OCPP_TRUST_PROXY_PROTO, which
   * defaults to false. `isTls()` then ignored Caddy's X-Forwarded-Proto, so the
   * gateway saw plaintext and refused 100% of connections with "Security
   * profile 2 requires TLS", while logging a cheerful "listening" line. A
   * misconfiguration that rejects every charger must fail at startup, where an
   * operator sees it once, not at every handshake forever.
   *
   * setSecurityProfile() already applies exactly this guard per charge point;
   * it was simply missing for the global setting.
   */
  if (config.gateway.minSecurityProfile >= 2 && !tlsEnabled && !config.gateway.trustProxyProto) {
    await new Promise<void>((res) => http.close(() => res()));
    throw new Error(
      'OCPP_MIN_SECURITY_PROFILE=2 requires TLS, and this gateway has neither its own certificate ' +
        'nor a trusted proxy to learn it from — every charger would be refused with 403. Either set ' +
        'OCPP_TLS_KEY_PATH/OCPP_TLS_CERT_PATH to terminate TLS here, or set OCPP_TRUST_PROXY_PROTO=true ' +
        'if a reverse proxy in front of you terminates TLS and sets X-Forwarded-Proto (the shipped ' +
        'deploy/Caddyfile does). See deploy/README.md.',
    );
  }

  /**
   * An open gateway must be a deliberate choice, not the quick start.
   *
   * .env.example ships OCPP_MIN_SECURITY_PROFILE=0 and OCPP_AUTO_ADOPT=true for
   * the bench, Docker Compose loads it with NODE_ENV=production, and nothing
   * refused the combination: any stranger could enrol a charger and produce
   * billable sessions, and at profile 0 take over a live charger's socket.
   */
  const insecure = insecureGatewayProblems();
  if (insecure.length && !isRelaxedEnv()) {
    if (!config.gateway.allowInsecure) {
      await new Promise<void>((res) => http.close(() => res()));
      throw new Error(
        `Refusing to start in NODE_ENV=${config.env}: ${insecure.join('; ')}. Production needs ` +
          'OCPP_MIN_SECURITY_PROFILE=2 (or 3) and OCPP_AUTO_ADOPT=false (see deploy/README.md). For a ' +
          'supervised bench only, set ALLOW_INSECURE_OCPP=true to acknowledge it.',
      );
    }
    logger.error({ problems: insecure }, 'ALLOW_INSECURE_OCPP=true: this gateway accepts chargers without proper authentication');
  }

  // ---- liveness: server-side ping, and a sweeper for silent chargers ----
  // A half-open 4G socket never emits 'close'; without a ping it lingers until
  // the OS TCP keepalive fires, which can be two hours.
  const pinger = setInterval(() => {
    for (const r of registry.all()) {
      if (r.awaitingPong) {
        logger.info({ cp: r.ocppIdentity }, 'no pong — terminating half-open socket');
        try {
          r.ws.terminate();
        } catch {}
        continue;
      }
      registry.markPingSent(r.ocppIdentity, r.token);
      try {
        r.ws.ping();
      } catch {}
    }
  }, config.gateway.pingIntervalS * 1000);

  const sweeper = setInterval(() => {
    void markStaleOffline().catch((e) => logger.warn({ err: e }, 'liveness sweep failed'));
  }, 60_000);

  return {
    http,
    wss,
    async close() {
      clearInterval(pinger);
      clearInterval(sweeper);
      // wss.close() waits for every client to disconnect and hangs forever on idle
      // charger sockets. Close them politely first (1001 Going Away), so the
      // charger's own reconnect logic engages instead of seeing an abnormal 1006.
      for (const r of registry.all()) {
        r.rpc.destroy(new Error('shutting down'));
        try {
          r.ws.close(1001, 'server shutting down');
        } catch {}
      }
      await new Promise<void>((res) => setTimeout(res, 250));
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {}
      }
      registry.clear();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}

async function gatewayHealth() {
  try {
    await query('SELECT 1');
    return { ok: true, connected: registry.all().length, time: new Date().toISOString() };
  } catch {
    return { ok: false, connected: registry.all().length, db: 'unreachable', time: new Date().toISOString() };
  }
}

// ------------------------------------------------------------------ upgrade

async function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  supported: OcppVersion[],
) {
  const remoteIp = (socket as unknown as { remoteAddress?: string }).remoteAddress ?? null;
  const forwardedFor = headerString(req.headers['x-forwarded-for']);
  const userAgent = headerString(req.headers['user-agent']);
  const requestPath = req.url ?? '';
  const subprotocols = headerString(req.headers['sec-websocket-protocol']);
  const authHeader = req.headers.authorization;
  const authPresent = Boolean(authHeader);
  const authScheme = authHeader ? authHeader.split(' ')[0] ?? null : null;
  const tls = isTls(req);

  const base = { remoteIp, forwardedFor, requestPath, subprotocols, authPresent, authScheme, tls, userAgent };

  const finish = async (outcome: AttemptOutcome, status: number, detail: string, extra: Record<string, unknown> = {}) => {
    await recordAttempt({ ...base, ...extra, outcome, httpStatus: status, detail }).catch((e) =>
      logger.error({ err: e }, 'failed to record connection attempt'),
    );
    logger.warn({ ...base, outcome, detail }, 'OCPP upgrade rejected');
    reject(socket, status, detail);
  };

  // --- identity -------------------------------------------------------
  let identity: string | null;
  try {
    identity = extractIdentity(requestPath);
  } catch {
    return finish('rejected_malformed_path', 400, 'Malformed percent-encoding in path');
  }
  if (!identity) {
    return finish('rejected_no_identity', 404, 'Charge point identity missing from path');
  }
  if (!IDENTITY_RE.test(identity)) {
    return finish('rejected_no_identity', 400, `Identity must match ${IDENTITY_RE.source}`, {
      ocppIdentity: identity.slice(0, MAX_IDENTITY_LEN),
    });
  }

  // --- subprotocol ----------------------------------------------------
  const version = negotiate(req.headers['sec-websocket-protocol'], supported);
  if (!version) {
    return finish('rejected_no_subprotocol', 400, `No supported OCPP subprotocol offered (we speak ${supported.join(', ')})`, {
      ocppIdentity: identity,
    });
  }

  // --- known charge point ---------------------------------------------
  const cp = await assets.adoptOrPark(identity);
  if (!cp) {
    return finish(
      'rejected_unknown_cp',
      404,
      'Unknown charge point — queued for adoption. Register this identity, or enable auto-adopt in development.',
      { ocppIdentity: identity, negotiated: version },
    );
  }

  // A sandbox charger exists only inside the gateway. Nothing on the network may
  // connect as one, whatever credentials it presents.
  if (cp.virtual) {
    return finish('rejected_unknown_cp', 404, 'Unknown charge point', { ocppIdentity: identity, chargePointId: cp.id, negotiated: version });
  }

  /**
   * A DECOMMISSIONED unit is no longer part of the fleet: refused here, at the
   * upgrade, before any credential is looked at. It used to connect (its
   * credentials are cleared at decommissioning, but at security profile 0 there
   * are none to clear), boot Accepted and open billable sessions. Refusing the
   * socket rather than answering BootNotification Rejected is deliberate: a
   * Rejected unit stays connected and re-boots for ever, while the 403 is what
   * an unknown unit gets and is recorded in its connection log. Reinstating
   * the unit (→ pending_adoption) lets it back in through the adoption gate.
   *
   * A SUSPENDED unit is let in and answered Pending at BootNotification
   * (adapter16.onBoot): it must still be able to deliver the stop of a
   * transaction that was running when it was suspended.
   */
  if (cp.status === 'decommissioned') {
    return finish('rejected_auth', 403, 'Charge point is decommissioned', {
      ocppIdentity: identity,
      chargePointId: cp.id,
      negotiated: version,
    });
  }

  // --- transport security ---------------------------------------------
  const required = Math.max(config.gateway.minSecurityProfile, cp.security_profile ?? 0);
  if (required >= 2 && !tls) {
    // Previously profile 2 accepted plaintext, which made the "production
    // baseline" claim meaningless.
    return finish('rejected_tls_required', 403, 'Security profile 2 requires TLS', {
      ocppIdentity: identity,
      chargePointId: cp.id,
      negotiated: version,
    });
  }

  // --- authentication --------------------------------------------------
  if (required >= 3) {
    // Security Profile 3 — mutual TLS. The client certificate IS the credential
    // and replaces the AuthorizationKey. The cert is verified against the CA at
    // the TLS terminator (this gateway, or the trusted proxy); here we bind it to
    // THIS charge point so one trusted charger cannot use another's certificate.
    const certCtx = {
      headers: req.headers,
      socket: req.socket as never,
      trustProxyProto: config.gateway.trustProxyProto,
      fromTrustedProxy: fromTrustedProxy(req.socket.remoteAddress),
      headerName: config.gateway.clientCertHeader,
    };
    let cc = checkClientCert(certCtx, cp.client_cert_fingerprint);
    if (cc.ok && cp.client_cert_prev_fingerprint) {
      // The charger uses its new certificate: the old one is no longer accepted.
      await query(`UPDATE charge_point SET client_cert_prev_fingerprint = NULL WHERE id = $1`, [cp.id]).catch(() => {});
    } else if (!cc.ok && cp.client_cert_prev_fingerprint) {
      // A certificate change in progress: the previous one still works until the new one is used.
      const prev = checkClientCert(certCtx, cp.client_cert_prev_fingerprint);
      if (prev.ok) cc = prev;
    }
    if (!cc.ok) {
      return finish('rejected_auth', 401, `Client certificate check failed: ${cc.reason}`, {
        ocppIdentity: identity,
        chargePointId: cp.id,
        negotiated: version,
      });
    }
  } else if (required >= 1) {
    const auth = await checkBasicAuth(authHeader, identity);
    if (!auth.ok) {
      return finish('rejected_auth', 401, `Authentication failed: ${auth.reason}`, {
        ocppIdentity: identity,
        chargePointId: cp.id,
        negotiated: version,
      });
    }
    if (auth.matched === 'current') {
      // The charger has demonstrably applied the new key; close the rotation window.
      await retirePreviousKey(identity).catch(() => {});
    }
  }

  // Record only once the upgrade has ACTUALLY completed, and distinguish a unit
  // that connected but is still awaiting adoption — it will be answered `Pending`
  // at BootNotification and cannot transact, so calling that plain "accepted"
  // showed a blocked charger as healthy and hid it from the adoption queue.
  wss.handleUpgrade(req, socket as never, head, (ws) => {
    const pending = cp.status === 'pending_adoption';
    void recordAttempt({
      ...base,
      ocppIdentity: identity!,
      chargePointId: cp.id,
      negotiated: version,
      outcome: pending ? 'accepted_pending_adoption' : 'accepted',
      httpStatus: 101,
      detail: pending
        ? 'Upgrade accepted, but the charge point is awaiting operator adoption; BootNotification will answer Pending.'
        : cp.status === 'suspended'
          ? 'Upgrade accepted, but the charge point is suspended; BootNotification will answer Pending and new sessions are refused.'
          : null,
    }).catch((e) => logger.error({ err: e }, 'failed to record connection attempt'));

    // A rejection here used to take the whole process down and with it every
    // other charger's socket — see the note on setChargePointStatus below.
    // What the handshake actually proved: the enforced profile, with Basic auth counted as Profile 2
    // only when the connection is TLS (directly or via a trusted proxy).
    const authenticatedProfile = required >= 3 ? 3 : required >= 1 ? (tls ? 2 : 1) : 0;
    void onConnection(ws, identity!, cp.id, cp.org_id, version, authenticatedProfile).catch((e) =>
      logger.error({ err: e, cp: identity }, 'connection setup failed'),
    );
  });
}

/**
 * Attach a sandbox (virtual) charger: the gateway gets one end of an in-memory
 * socket pair and runs its ordinary connection handler on it; the simulator
 * gets the other end. Only charge points flagged virtual may attach this way.
 */
export async function attachVirtualCharger(identity: string, version: OcppVersion): Promise<MemorySocket> {
  const cp = await assets.findChargePoint(identity);
  if (!cp || !cp.virtual) throw new Error(`${identity} is not a virtual charge point`);
  if (cp.status === 'decommissioned') throw new Error(`${identity} is decommissioned`);
  const [client, server] = socketPair(version);
  void recordAttempt({
    remoteIp: null, forwardedFor: null, requestPath: `virtual:${identity}`, subprotocols: version, authPresent: false,
    authScheme: null, tls: false, userAgent: 'PlugSure sandbox', ocppIdentity: identity, chargePointId: cp.id, negotiated: version,
    outcome: cp.status === 'pending_adoption' ? 'accepted_pending_adoption' : 'accepted', httpStatus: 101, detail: 'sandbox virtual charger',
  }).catch(() => {});
  // In-process only (no network path), and the sandbox needs certificate signing: Profile 2.
  await onConnection(server as unknown as WebSocket, identity, cp.id, cp.org_id, version, 2);
  return client;
}

// ------------------------------------------------------------------ helpers

/** The charge point ID is ALWAYS the final path segment. We do not get to choose it. */
/**
 * The charge point identity from the request path.
 *
 * `OCPP_PATH` is now ENFORCED. It was read from config and never used
 * (`grep config.gateway.path src/` found no consumer), so the last path segment
 * was taken as the identity whatever came before it: `/ocpp/` enrolled a charge
 * point literally named "ocpp", `/foo/AUTEL-01` was accepted as readily as
 * `/ocpp/AUTEL-01`, and `/ocpp/a/b` registered "b". With auto-adopt on, junk
 * rows appeared in a tenant's fleet; with it off, the troubleshooting guide's
 * promised "identity missing from path" 404 never appeared because a bare
 * prefix looked like a perfectly good identity.
 *
 * `basePath` is passed explicitly so this stays a pure function under test.
 */
export function extractIdentity(url: string, basePath: string = config.gateway.path): string | null {
  const path = (url.split('?')[0] ?? '').split('#')[0] ?? '';
  const parts = path.split('/').filter(Boolean);

  const prefix = basePath.split('/').filter(Boolean);
  for (const [i, seg] of prefix.entries()) {
    if (parts[i]?.toLowerCase() !== seg.toLowerCase()) return null;
  }
  const rest = parts.slice(prefix.length);
  if (rest.length === 0) return null; // the prefix alone is not an identity

  const last = rest.at(-1)!;
  // Tolerate the version-in-path fallback form: /ocpp/1.6/{id}
  if (/^(1\.6|2\.0\.1|2\.1|ocpp1\.6|ocpp2\.0\.1|ocpp2\.1)$/i.test(last)) return null;
  return decodeURIComponent(last); // throws on malformed encoding; caller handles
}

/**
 * Header negotiation is authoritative. Some chargers offer a list; we echo exactly
 * one, and only a version we can actually speak.
 */
export function negotiate(
  header: string | string[] | undefined,
  supported: OcppVersion[] = config.gateway.supportedVersions as OcppVersion[],
): OcppVersion | null {
  const fallback = supported.includes('ocpp1.6' as OcppVersion) ? ('ocpp1.6' as OcppVersion) : null;
  if (!header) return fallback; // some 1.6 units omit the header entirely
  const offered = (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (offered.length === 0) return null;
  for (const v of supported) if (offered.includes(v)) return v;
  return null;
}

const fromTrustedProxy = makeProxyMatcher(config.gateway.trustedProxies);

/** What makes this gateway's configuration unsafe to expose, in words for the operator. */
export function insecureGatewayProblems(g: { minSecurityProfile: number; autoAdopt: boolean } = config.gateway): string[] {
  const out: string[] = [];
  if (g.minSecurityProfile < 2) out.push(`OCPP_MIN_SECURITY_PROFILE=${g.minSecurityProfile} accepts chargers without TLS${g.minSecurityProfile === 0 ? ' or any credential' : ''}`);
  if (g.autoAdopt) out.push('OCPP_AUTO_ADOPT=true enrols any unknown charger that connects');
  return out;
}

/** True when the original client connection was TLS. */
function isTls(req: IncomingMessage): boolean {
  if ((req.socket as any).encrypted) return true;
  if (!config.gateway.trustProxyProto) return false;
  // Only a configured proxy's word counts: anyone reaching the port directly could
  // otherwise claim TLS it does not have, and send its Basic key in the clear.
  if (!fromTrustedProxy(req.socket.remoteAddress)) return false;
  const proto = headerString(req.headers['x-forwarded-proto']);
  return proto?.split(',')[0]?.trim().toLowerCase() === 'https';
}

/**
 * OCPP 1.6J Basic auth: username = chargePointId, password = the AuthorizationKey.
 * Verification, rotation and the grace window live in services/chargepoint-keys.ts.
 */
async function checkBasicAuth(
  header: string | undefined,
  identity: string,
): Promise<{ ok: boolean; matched?: 'current' | 'previous'; reason?: string }> {
  if (!header?.startsWith('Basic ')) return { ok: false, reason: 'no Basic credentials' };

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return { ok: false, reason: 'undecodable credentials' };
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return { ok: false, reason: 'malformed credentials' };

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (user !== identity) return { ok: false, reason: 'username must equal the charge point identity' };

  const res = await verifyAuthorizationKey(identity, pass);
  if (res.ok) return { ok: true, matched: res.matched };
  return {
    ok: false,
    reason: res.reason === 'no_key_provisioned' ? 'no AuthorizationKey provisioned for this charge point' : 'key mismatch',
  };
}

function headerString(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(', ') : v;
}

function reject(socket: Duplex, code: number, msg: string) {
  const reason = msg.replace(/[\r\n]/g, ' ').slice(0, 200);
  try {
    socket.write(
      `HTTP/1.1 ${code} ${statusText(code)}\r\n` +
        `Content-Type: text/plain\r\n` +
        `Content-Length: ${Buffer.byteLength(reason)}\r\n` +
        `Connection: close\r\n\r\n${reason}`,
    );
  } catch {}
  socket.destroy();
}

function statusText(code: number): string {
  return (
    { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' }[
      code
    ] ?? 'Error'
  );
}

async function markStaleOffline() {
  const { rows } = await query<{ ocpp_identity: string; org_id: string }>(
    `UPDATE charge_point cp
        SET status = 'offline', offline_since = COALESCE(cp.offline_since, now())
       FROM site s
      WHERE s.id = cp.site_id
        AND cp.status = 'online'
        AND (cp.last_seen_at IS NULL OR cp.last_seen_at < now() - ($1 || ' seconds')::interval)
      RETURNING cp.ocpp_identity, s.org_id`,
    [config.gateway.offlineAfterS],
  );
  for (const r of rows) {
    if (!registry.isOnline(r.ocpp_identity)) {
      logger.warn({ cp: r.ocpp_identity }, 'charge point silent past the liveness window — marked offline');
      bus.emit('charge_point.disconnected', { orgId: r.org_id, ocppIdentity: r.ocpp_identity });
    }
  }
}

// ------------------------------------------------------------------ connection

async function onConnection(ws: WebSocket, identity: string, chargePointId: string, orgId: string, version: OcppVersion, securityProfile = 0) {
  logger.info({ cp: identity, version }, 'charge point connected');

  // A previous socket for this identity must be closed, not merely displaced.
  // Leaving it open let a second party take over command routing while the real
  // charger kept writing billing data.
  const previous = registry.get(identity);
  if (previous) {
    logger.warn({ cp: identity }, 'identity reconnected while a socket was still open — closing the old one');
    previous.rpc.destroy(new Error('superseded by a new connection'));
    try {
      previous.ws.close(1012, 'superseded');
    } catch {}
  }

  const ctx: AdapterContext = { ocppIdentity: identity, chargePointId, orgId, version, securityProfile };

  /**
   * Deviations observed before the quirk profile is known.
   *
   * Validation runs BEFORE the handler, so on the very first BootNotification of
   * a connection ctx has no vendor, model or profile id yet and the sink below
   * dropped the finding. That is precisely the frame the registry most needs:
   * Autel's 21-character chargePointModel against a CiString20 field is a
   * BootNotification deviation and nothing else. And because ctx is per
   * connection, the next boot started empty too — so the single most common
   * real-hardware deviation could never be recorded at all. Buffer, then flush.
   */
  const pendingDeviations: string[] = [];
  const MAX_BUFFERED_DEVIATIONS = 32;

  const flushDeviations = () => {
    if (!ctx.quirkProfileId || !ctx.vendor || !ctx.model || pendingDeviations.length === 0) return;
    const batch = pendingDeviations.splice(0, pendingDeviations.length);
    void recordFinding(
      ctx.quirkProfileId,
      { specDeviations: batch },
      { vendor: ctx.vendor, model: ctx.model, firmware: ctx.firmware },
    ).catch(() => {});
  };

  const rpc = new OcppRpcConnection(
    identity,
    ws,
    async (action, payload) => {
      if (action === 'BootNotification') {
        // 1.6 carries vendor/model/firmware at the top level; 2.0.1 nests them
        // under `chargingStation`. Read from whichever the negotiated version uses.
        const cs = payload.chargingStation ?? {};
        const vendor = payload.chargePointVendor ?? cs.vendorName;
        const model = payload.chargePointModel ?? cs.model;
        const firmware = payload.firmwareVersion ?? cs.firmwareVersion;
        const profile = await ensureQuirkProfile(vendor ?? 'unknown', model ?? 'unknown', firmware);
        ctx.vendor = vendor;
        ctx.model = model;
        ctx.firmware = firmware;
        ctx.quirkProfileId = profile.id;
        await query(`UPDATE charge_point SET quirk_profile_id = $2 WHERE id = $1`, [chargePointId, profile.id]);
        // The boot frame's own deviations are now attributable.
        flushDeviations();
      }

      // One dispatch point, chosen by the negotiated version. Both adapters emit
      // the same canonical events, so nothing downstream gains a version branch.
      const result =
        version === 'ocpp2.0.1' || version === 'ocpp2.1'
          ? await handle201Call(ctx, action, payload)
          : await handle16Call(ctx, action, payload);

      if (action === 'BootNotification' && result?.status === 'Accepted') {
        // Never block the BootNotification response on provisioning.
        setImmediate(() =>
          void provisionChargePoint(identity, ctx).catch((e) => logger.warn({ err: e }, 'provisioning failed')),
        );
      }
      return result;
    },
    {
      callTimeoutMs: config.gateway.callTimeoutMs,
      version,
      deviationSink: (action, deviations) => {
        for (const d of deviations) {
          if (pendingDeviations.length >= MAX_BUFFERED_DEVIATIONS) break;
          pendingDeviations.push(`${action}${d.message}`);
        }
        flushDeviations();
      },
      frameSink: (f) => {
        void query(
          `INSERT INTO ocpp_frame (charge_point_id, ocpp_identity, direction, message_type, action, unique_id, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [chargePointId, identity, f.direction, f.messageType, f.action ?? null, f.uniqueId ?? null, safeJson(f.payload)],
        ).catch((e) => {
          // Never silently. A charger could previously delete its own frames from
          // the audit trail by including a NUL byte in any payload.
          logger.error({ cp: identity, action: f.action, err: e.message }, 'FRAME LOG WRITE FAILED — evidence lost');
        });
      },
    },
  );

  // Register the close listener BEFORE any await, or a socket that closes during
  // the status write is never observed and the row stays 'online' forever.
  const token = registry.register({ ocppIdentity: identity, chargePointId, version, rpc, ws, connectedAt: new Date() });

  // Keyed by THIS registration: a late pong from a superseded socket must not
  // mark the connection that replaced it alive.
  ws.on('pong', () => registry.markPong(identity, token));
  ws.on('close', () => {
    const wasCurrent = registry.unregister(identity, token);
    if (!wasCurrent) {
      logger.debug({ cp: identity }, 'stale socket closed after reconnect — registry untouched');
      return;
    }
    /**
     * A status write is bookkeeping, not a reason to drop the fleet.
     *
     * Node 22 defaults to --unhandled-rejections=throw, so an un-caught
     * rejection here terminated the gateway process. One transient database
     * error at connect or disconnect therefore closed every OTHER charger's
     * socket too, and systemd's StartLimitBurst=5 would give up after five of
     * them. Log it; the liveness sweeper reconciles the row either way.
     */
    void assets.setChargePointStatus(chargePointId, 'offline').catch((e) =>
      logger.error({ err: e, cp: identity }, 'could not mark charge point offline'),
    );
    bus.emit('charge_point.disconnected', { orgId, ocppIdentity: identity });
    logger.info({ cp: identity }, 'charge point disconnected');
  });

  await assets.setChargePointStatus(chargePointId, 'online').catch((e) =>
    logger.error({ err: e, cp: identity }, 'could not mark charge point online'),
  );
  bus.emit('charge_point.connected', { orgId, ocppIdentity: identity, version });
}

/** JSONB rejects NUL bytes; strip them rather than losing the frame. */
function safeJson(payload: unknown): string {
  return JSON.stringify(payload).replace(/\\u0000/g, '');
}
