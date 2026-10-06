import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config, isRelaxedEnv } from '../config.js';
import { logger } from '../logger.js';

/**
 * CORS for the DRIVER API only (`/d/v1/*`), for browser builds of the native app served from another origin — the
 * Expo web build in development (`http://localhost:8081`) or a hosted web preview of the app.
 *
 * Off unless `DRIVER_WEB_ORIGINS` lists exact origins (comma-separated; no wildcard, no paths). In production only
 * `https://` origins are accepted (a listed `http://` origin is ignored, with a warning). Nothing changes for the
 * operator API (`/v1/*`, cookie sessions: its CSRF guard relies on this API never granting a preflight there), the
 * web app at `/app` (same origin) or requests without a listed `Origin`. The driver API is bearer-token only (no
 * cookies), so credentials are never allowed.
 */
export const DRIVER_CORS_HEADERS = [
  'authorization', 'content-type', 'idempotency-key', 'if-none-match',
  'x-driver-brand', 'x-driver-lang', 'x-app-version', 'x-app-platform', 'x-app-build',
] as const;
const METHODS = 'GET, POST, PUT, DELETE';
const ORIGIN = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d{1,5})?$/i;

/** The allow-list from `DRIVER_WEB_ORIGINS`: exact, normalised origins; `http://` only outside production. */
export function parseWebOrigins(raw: string | undefined, env: string = config.env): { origins: string[]; ignored: string[] } {
  const origins: string[] = [];
  const ignored: string[] = [];
  for (const item of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = ORIGIN.exec(item.replace(/\/+$/, ''));
    if (!m || (m[1]!.toLowerCase() === 'http' && !isRelaxedEnv(env))) {
      ignored.push(item);
      continue;
    }
    origins.push(`${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3] ?? ''}`);
  }
  return { origins: [...new Set(origins)], ignored };
}

/** The response headers for a request from `origin`, or null when it gets none (not listed / not the driver API). */
export function corsHeadersFor(path: string, origin: string | undefined, allowed: readonly string[], preflight: boolean): Record<string, string> | null {
  if (!origin || !allowed.length || !path.startsWith('/d/v1/')) return null;
  if (!allowed.includes(origin.toLowerCase())) return null;
  const h: Record<string, string> = { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': 'ETag, Retry-After, Deprecation, Idempotent-Replayed' };
  if (preflight) {
    h['access-control-allow-methods'] = METHODS;
    h['access-control-allow-headers'] = DRIVER_CORS_HEADERS.join(', ');
    h['access-control-max-age'] = '600';
  }
  return h;
}

export function registerDriverCors(app: FastifyInstance, raw: string | undefined = process.env.DRIVER_WEB_ORIGINS): void {
  const { origins, ignored } = parseWebOrigins(raw);
  if (ignored.length) logger.warn({ ignored }, 'DRIVER_WEB_ORIGINS: entries ignored (exact http(s) origins only; https only in production)');
  if (!origins.length) return;
  logger.info({ origins }, 'driver API: CORS allowed for these web origins');
  const pathOf = (req: FastifyRequest) => req.url.split('?')[0]!;
  // Preflight: answered here, before routing (the driver API has no OPTIONS routes of its own).
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const pre = req.method === 'OPTIONS' && typeof req.headers['access-control-request-method'] === 'string';
    const h = corsHeadersFor(pathOf(req), req.headers.origin, origins, pre);
    if (!h) return;
    reply.headers(h);
    if (pre) return reply.status(204).send();
  });
}
