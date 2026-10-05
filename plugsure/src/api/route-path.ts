import type { FastifyRequest } from 'fastify';

/**
 * The route pattern Fastify matched for this request (e.g. `/v1/sites/:id`), or
 * '' when nothing matched (the request is on its way to a 404).
 *
 * Security hooks must decide on THIS, never on `req.url`. `req.url` is the raw
 * request target: the router percent-decodes the path before matching, so
 * `/%761/sessions` reached the `/v1/sessions` handler while every hook that
 * tested `req.url.startsWith('/v1/')` (authentication, CSRF, the one-time
 * password gate, the tenant's row-level-security scope) skipped it. An
 * absolute-form target (`GET http://host/v1/sessions`) did the same. The same
 * pattern guarded the driver API (`/d/v1/`) and roaming (`/ocpi/`).
 */
export function routePath(req: FastifyRequest): string {
  return req.routeOptions?.url ?? '';
}

/**
 * Is this request under `prefix` by EITHER reading: the route it matched, or the
 * raw target? The matched route closes the encoded-path bypass; the raw target
 * keeps an unmatched path under a guarded prefix answering 401 rather than 404,
 * so unauthenticated callers learn nothing about which routes exist.
 */
export function underPrefix(req: FastifyRequest, prefix: string): boolean {
  return routePath(req).startsWith(prefix) || req.url.startsWith(prefix);
}

/**
 * A request for the console's or the driver app's own files (JS, CSS, images, fonts, the page shells),
 * served by @fastify/static or the driver app's rendered shell. These are not API calls: one console
 * page load fetches ~60 of them, so counting them against the per-IP API limit throttled an office of
 * operators behind one NAT on page loads alone. Only GET/HEAD on the static routes themselves (by the
 * route Fastify matched, never the raw target, so `/%761/...` cannot pose as a file); everything under
 * an API prefix stays limited.
 */
const STATIC_ROUTES = new Set(['/*', '/', '/app/*', '/app/', '/app/index.html', '/app/manifest.webmanifest', '/app/sw.js']);
const API_PREFIXES = ['/v1/', '/d/', '/ocpi/', '/hub/', '/pay/', '/hooks/', '/fw/', '/diag/', '/.well-known/'];
export function isStaticAsset(req: FastifyRequest): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const route = routePath(req);
  if (!STATIC_ROUTES.has(route)) return false;
  const path = req.url.split('?')[0]!;
  return !API_PREFIXES.some((p) => path.startsWith(p));
}
