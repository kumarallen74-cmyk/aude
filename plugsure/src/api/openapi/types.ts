/**
 * The API catalogue: one entry per /v1 route, written by hand next to the code
 * it describes, and turned into the published OpenAPI 3.1 document by
 * build.ts. A unit test fails when a registered route has no entry (or an entry
 * has no route), so the document cannot silently fall behind the API.
 *
 * Schemas are JSON Schema 2020-12 (what OpenAPI 3.1 uses). Response schemas
 * describe what the handler really returns — they are checked against live
 * responses by tools/e2e/api-sandbox-e2e.mts — so:
 *   - list the properties a response has, with their types;
 *   - put a property in `required` only when it is ALWAYS present;
 *   - a value that can be null is `type: ['string', 'null']` (etc.);
 *   - leave additionalProperties open (the default), so adding a field is not
 *     a breaking change for the contract test.
 */

export type Schema = Record<string, unknown>;

export interface Param {
  name: string;
  required?: boolean;
  description?: string;
  schema: Schema;
}

export interface Response {
  description: string;
  /** Omit for an empty body (204, or a plain `{ ok: true }` is better given a schema). */
  schema?: Schema;
  /** Default application/json. */
  contentType?: string;
  example?: unknown;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Op {
  method: Method;
  /** Fastify form, exactly as registered: `/v1/sites/:siteId/power`. */
  path: string;
  tag: Tag;
  summary: string;
  description?: string;
  /** Description of each `:param` in the path (all are strings). */
  pathParams?: Record<string, string>;
  query?: Param[];
  body?: { schema: Schema; required?: boolean; contentType?: string; example?: unknown; description?: string };
  /** Success responses by status. 401 / 403 / 429 / 500 are added for every operation. */
  responses: Record<number, Response>;
  /** Further error statuses this operation returns (400, 404, 409, 422, 502…). */
  errors?: number[];
  /**
   * Permissions required, when the generator cannot read them from the
   * handler (it finds `'resource:action'` literals in the route's source).
   */
  permissions?: string[];
  /**
   * Kept out of the published document, with the reason. Console plumbing
   * (sign-in), platform administration and browser-only pages are internal.
   */
  internal?: string;
}

export const TAGS = [
  'Chargers',
  'Commands',
  'Onboarding',
  'Configuration',
  'Sites',
  'Load management',
  'Sessions',
  'Tariffs',
  'Plug & Charge',
  'Integrations',
  'Payments and refunds',
  'RFID and tokens',
  'Firmware and diagnostics',
  'Compliance',
  'Alerts',
  'Alert routing',
  'Availability',
  'Webhooks',
  'Users and roles',
  'API keys',
  'Audit',
  'Statements and billing',
  'Site owners',
  'Roaming',
  'Live events',
  'Reference data',
  'Sandbox',
  'Driver app',
  'Console branding',
  'Console session',
  'Platform administration',
] as const;
export type Tag = (typeof TAGS)[number];

export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
export const arrayOf = (items: Schema): Schema => ({ type: 'array', items });
export const nullable = (type: string, extra: Schema = {}): Schema => ({ type: [type, 'null'], ...extra });
/** `{ ok: true }` — the common acknowledgement body. */
export const OK: Schema = { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'] };
