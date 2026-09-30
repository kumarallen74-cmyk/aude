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
