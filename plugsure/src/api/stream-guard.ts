import type { FastifyRequest } from 'fastify';
import { outsideRequestScope } from '../db/pool.js';
import { logger } from '../logger.js';
import { authenticate, type AuthResult } from '../services/auth.js';
import type { Principal } from '../services/authz.js';
import { sessionHold } from './session-holds.js';

/**
 * Seconds between re-checks of a live stream's credential: STREAM_REVALIDATE_SECONDS,
 * default 60. Read on every call so tests (and an operator) can change it.
 */
export function streamRevalidateMs(): number {
  const n = Number(process.env.STREAM_REVALIDATE_SECONDS);
  return (Number.isFinite(n) && n > 0 ? n : 60) * 1000;
}

/**
 * Keep re-validating the credential a long-lived response (Server-Sent Events: /v1/stream,
 * /v1/events/frames) was opened with, and end the response once it no longer holds.
 *
 * Authentication used to happen once, when the stream opened: signing out, an
 * administrator disabling the user or resetting their password, revoking the API key —
 * none of it reached a stream already open, which kept delivering the organisation's live
 * events (and the OCPP log, drivers' idTags included) for as long as the tab stayed open.
 *
 * Every `intervalMs` the request's own headers are authenticated again, WITHOUT counting
 * as activity (an open tab must not keep an idle session alive), the same holds as any
 * request apply (api/session-holds.ts), and `stillAllowed` re-checks the route's
 * permission against the fresh grants. Any failure — including the database being
 * unreachable — ends the stream: EventSource reconnects by itself, and the reconnect is
 * authenticated like any other request (fail closed, at the cost of a reconnect).
 *
 * Returns a stop function; the caller also stops it when the client goes away.
 */
export function watchLiveStream(
  req: FastifyRequest,
  opts: {
    stillAllowed: (p: Principal) => boolean;
    close: () => void;
    intervalMs?: number;
    /** For tests. */
    authenticateFn?: (headers: Record<string, unknown>, o: { touch?: boolean }) => Promise<AuthResult>;
  },
): () => void {
  // A snapshot: only the credential headers matter, and the request object may be recycled.
  const headers: Record<string, unknown> = { authorization: req.headers.authorization, cookie: req.headers.cookie };
  const host = req.headers.host;
  const path = (req.routeOptions?.url ?? req.url.split('?')[0]) as string;
  const auth = opts.authenticateFn ?? authenticate;
  let stopped = false;
  let running = false;

  const check = async () => {
    if (stopped || running) return;
    running = true;
    let ok = false;
    let why = 'credential no longer valid';
    try {
      const a = await auth(headers, { touch: false });
      if (sessionHold(a, 'GET', path, host)) why = 'session held (see session-holds)';
      else if (!opts.stillAllowed(a.principal)) why = 'permission withdrawn';
      else ok = true;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 401) why = `re-check failed: ${(e as Error).message}`;
    } finally {
      running = false;
    }
    if (ok || stopped) return;
    stop();
    logger.info({ path, reason: why }, 'live stream ended: its credential no longer holds');
    try {
      opts.close();
    } catch {
      /* already gone */
    }
  };

  // Outside the request scope: the stream's request holds no transaction, and a timer must
  // not reach for one.
  const timer = setInterval(() => outsideRequestScope(() => void check()), opts.intervalMs ?? streamRevalidateMs());
  timer.unref();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}
