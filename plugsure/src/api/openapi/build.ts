import { TAGS, type Op, type Schema } from './types.js';
import * as core from './catalogue/core.js';
import * as roaming from './catalogue/roaming.js';
import * as consoleA from './catalogue/console-a.js';
import * as consoleB from './catalogue/console-b.js';
import * as sandbox from './catalogue/sandbox.js';
import * as fleet from './catalogue/fleet.js';
import * as pricing from './catalogue/pricing.js';
import * as pncCat from './catalogue/pnc.js';
import * as onboardingCat from './catalogue/onboarding.js';
import * as integrationsCat from './catalogue/integrations.js';
import * as driverAppCat from './catalogue/driver-app.js';
import * as consoleBrandCat from './catalogue/console-brand.js';

/**
 * Builds the published OpenAPI 3.1 document from the catalogue.
 * `tools/openapi/generate.mts` writes it to src/web/openapi.json (served at
 * /openapi.json, rendered at /api-docs.html); src/api/openapi/spec.test.ts fails
 * when the committed file, the catalogue and the registered routes disagree.
 */

const CATALOGUES = [core, roaming, consoleA, consoleB, sandbox, fleet, pricing, pncCat, onboardingCat, integrationsCat, driverAppCat, consoleBrandCat] as Array<{ ops: Op[]; schemas: Record<string, Schema> }>;

export function allOps(): Op[] {
  return CATALOGUES.flatMap((c) => c.ops);
}

export const routeKey = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

const TAG_TEXT: Record<string, string> = {
  Chargers: 'Charge points: the fleet, live state, OCPP frame log and connection history.',
  Commands: 'Commands sent to a charger through the gateway (OCPP 1.6J and 2.0.1).',
  Onboarding: 'Registering, adopting, activating and securing new chargers.',
  Configuration: 'Charger configuration keys and local authorisation lists.',
  Sites: 'Sites (charging locations) with their PLN connection, SPKLU and tax details.',
  'Load management': 'Site power budgets, dynamic load management and genset curtailment.',
  Sessions: 'Charging sessions, CDRs and tax receipts (PPN and PBJT-TL).',
  Tariffs: 'Tariffs, validated against the regulated ceilings, and their assignment; membership plans, members and promotions.',
  'Plug & Charge': 'ISO 15118 Plug & Charge: contracts (eMAIDs), trust anchors, the V2G certificates of chargers, and the certificate exchange log.',
  Integrations: 'Third-party services: the QRIS acquirer, driver sign-in codes (WhatsApp / SMS), the Plug & Charge PKI and map tiles. Secrets are write-only.',
  'Payments and refunds': 'QRIS checkout and the refund queue.',
  'RFID and tokens': 'RFID and fleet cards, limits and the unknown-card log.',
  'Firmware and diagnostics': 'Firmware images and campaigns, and diagnostics log uploads.',
  Compliance: 'Tera (meter verification) and SLO compliance.',
  Alerts: 'Operational alerts.',
  'Alert routing': 'Who is told about alerts, by e-mail and WhatsApp.',
  Availability: 'Charger uptime and outage history.',
  Webhooks: 'Outbound webhook endpoints and their delivery log. Event payloads are under `webhooks`.',
  'Users and roles': 'Console users and role-based access.',
  'API keys': 'Machine credentials for this API.',
  Audit: 'The tamper-evident audit trail.',
  'Statements and billing': 'Commission statements, per-owner billing, and fleet accounts with their monthly invoices and e-Faktur export.',
  'Site owners': 'Site owners and the sites they own.',
  Roaming: 'OCPI 2.2.1 roaming partners, shared sites, cards abroad. (The OCPI protocol endpoints themselves are at /ocpi and follow the OCPI specification.)',
  'Live events': 'Server-sent event streams.',
  'Reference data': 'Lists and settings the console and integrations use.',
  'Driver app': 'The operator’s own white-label driver app: name, colours, icon, web address, and the build kit for the Play Store and App Store.',
  'Console branding': 'The operator’s own name, colours and logo in the operator console, and optionally the console’s own web address (v1.5.0).',
  Sandbox: 'Developer sandboxes: separate tenants with virtual chargers. Create one with a production key; use the sandbox key it returns for everything else.',
};

const DESCRIPTION = `
The PlugSure CSMS operator API: everything the operator console does, for your own systems.

## Authentication
Send an API key as a bearer token: \`Authorization: Bearer psk_<prefix>_<secret>\`.
Create keys in the console under **Govern → API keys** (or \`POST /v1/api-keys\`), each with the permissions it needs;
a key only ever sees its own organisation. Each operation lists the permissions its handler checks (\`x-permissions\`).
The console's own session cookie also works, but machines should use keys.

## Sandbox
Build and test against a **sandbox**: a separate tenant with virtual chargers that speak real OCPP inside the gateway.
Create one under **Govern → Developers** (or \`POST /v1/sandboxes\`) and use the key it returns.
Everything behaves as in production — commands reach the (virtual) charger, sessions are metered, rated and receipted,
alerts and webhooks fire — and \`POST /v1/sandbox/chargers/{identity}/simulate\` acts out a card tap, a fault or a dropped
4G link. Sandboxes never appear in the driver app or to roaming partners, and cannot command real hardware.

## Conventions
- Timestamps are ISO 8601 in UTC. Money is in rupiah (IDR). Energy is in Wh unless a field says kWh.
- Field names follow the resource they come from: database rows are \`snake_case\`, computed views are \`camelCase\`.
  New fields may be added to any response; ignore what you do not know.
- Errors are JSON: \`{ "error": "human-readable reason" }\`, sometimes with a \`code\` or details. Validation problems are 400 or 422.
- Rate limits: each API key has its own limit (default 600 requests a minute, \`API_KEY_RATE_LIMIT_PER_MIN\`; set per key under **Govern → API keys**).
  It is a token bucket: a key may send its whole minute's allowance at once, then refills steadily. Every answer to a key carries
  \`RateLimit-Limit\`, \`RateLimit-Remaining\`, \`RateLimit-Reset\` (seconds until the bucket is full) and \`RateLimit-Policy\`; over the limit you get
  429 with \`Retry-After\` and \`code: rate_limited\`. Wait that long and retry (the SDK does). Requests without a key are limited per client IP.
- SDK: a generated TypeScript client (\`@plugsure/csms-sdk\`, no dependencies) is published with this document at \`/sdk/plugsure-csms-sdk.tgz\`.
- Writes are audited with the key or user that made them.

## Webhooks
Subscribe under **Govern → Webhooks** (\`POST /v1/webhooks\`). Each delivery is a POST with the envelope
\`{ id, type, created_at, api_version, data }\`, headers \`PlugSure-Event\`, \`PlugSure-Delivery\` and
\`PlugSure-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>\`. Verify the signature and reject old
timestamps; deliveries are retried with back-off and may arrive more than once (deduplicate on \`id\`).
The event payloads are described under \`webhooks\` below.
`.trim();

const ERROR: Schema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string', description: 'What went wrong, in plain words.' },
    code: { type: 'string', description: 'A stable code, where there is one (e.g. password_change_required).' },
  },
};

const STD_ERRORS: Record<number, string> = {
  400: 'The request is malformed or a value is invalid',
  401: 'Missing or invalid API key',
  403: 'The key lacks a permission for this resource',
  404: 'Not found (or not visible to this key)',
  409: 'Conflicts with the current state',
  413: 'Too large',
  422: 'Refused by a business or regulatory rule',
  429: 'Rate limit exceeded; see Retry-After',
  500: 'Internal error',
  501: 'Not available in this installation (e.g. no PKI configured)',
  502: 'The charger or an upstream service did not answer',
  503: 'Temporarily unavailable',
};

const RATE_LIMIT_HEADERS = {
  'Retry-After': { description: 'Seconds to wait before the next request.', schema: { type: 'integer' } },
  'RateLimit-Limit': { description: 'The key’s limit, requests a minute (answers to API keys only).', schema: { type: 'integer' } },
  'RateLimit-Remaining': { description: 'Requests the key may still send at once.', schema: { type: 'integer' } },
  'RateLimit-Reset': { description: 'Seconds until the key’s allowance is full again.', schema: { type: 'integer' } },
};

const EVENT_DATA: Record<string, { summary: string; properties: Record<string, Schema>; required: string[] }> = {
  'session.started': { summary: 'A charging session started', required: ['sessionId', 'ocppIdentity', 'connectorId'], properties: { sessionId: { type: 'string', format: 'uuid' }, ocppIdentity: { type: 'string' }, connectorId: { type: 'integer' } } },
  'session.ended': { summary: 'A charging session ended', required: ['sessionId', 'energyWh', 'durationS'], properties: { sessionId: { type: 'string', format: 'uuid' }, energyWh: { type: 'number' }, durationS: { type: 'number' }, stopReason: { type: 'string' } } },
  'cdr.created': { summary: 'A session was rated into a charge record (receipt)', required: ['cdrId', 'sessionId', 'totalIdr'], properties: { cdrId: { type: 'string', format: 'uuid' }, sessionId: { type: 'string', format: 'uuid' }, totalIdr: { type: 'number' } } },
  'charge_point.connected': { summary: 'A charger connected', required: ['ocppIdentity', 'version'], properties: { ocppIdentity: { type: 'string' }, version: { type: 'string', examples: ['ocpp1.6', 'ocpp2.0.1'] } } },
  'charge_point.disconnected': { summary: 'A charger disconnected', required: ['ocppIdentity'], properties: { ocppIdentity: { type: 'string' } } },
  'charge_point.booted': { summary: 'A charger sent BootNotification', required: ['ocppIdentity', 'vendor', 'model'], properties: { ocppIdentity: { type: 'string' }, vendor: { type: 'string' }, model: { type: 'string' }, firmware: { type: 'string' } } },
  'connector.status_changed': { summary: "A connector's status changed", required: ['ocppIdentity', 'evseId', 'connectorId', 'status'], properties: { ocppIdentity: { type: 'string' }, evseId: { type: 'integer' }, connectorId: { type: 'integer' }, status: { type: 'string', examples: ['Available', 'Preparing', 'Charging', 'Faulted'] }, errorCode: { type: 'string' } } },
  'alert.raised': { summary: 'An operational alert was raised', required: ['kind', 'severity', 'message'], properties: { kind: { type: 'string' }, severity: { type: 'string', examples: ['info', 'warning', 'critical'] }, message: { type: 'string' }, targetType: { type: 'string' }, targetId: { type: 'string' } } },
  'refund.due': { summary: 'Money is owed back to a driver', required: ['paymentIntentId', 'amountIdr', 'reason'], properties: { paymentIntentId: { type: 'string', format: 'uuid' }, amountIdr: { type: 'number' }, reason: { type: 'string' } } },
  'refund.completed': { summary: 'A refund was paid', required: ['paymentIntentId', 'amountIdr', 'method', 'reference'], properties: { paymentIntentId: { type: 'string', format: 'uuid' }, amountIdr: { type: 'number' }, method: { type: 'string', enum: ['provider', 'manual'] }, reference: { type: 'string' } } },
  'firmware.status': { summary: 'A charger reported firmware update progress', required: ['ocppIdentity', 'status'], properties: { ocppIdentity: { type: 'string' }, status: { type: 'string' }, jobId: { type: ['string', 'null'] } } },
};

function operationId(op: Op, taken: Set<string>): string {
  // Articles add nothing to a method name (getChargePoint, not getAChargePoint): the SDK uses these ids.
  // Possessives go ("a key's usage" → keyUsage) and acronyms are camel-cased (Api, Pdf, Ocpp).
  const words = op.summary.replace(/['’]s\b/g, '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w && !/^(a|an|the)$/i.test(w))
    .map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w));
  let id = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1))).join('') || 'operation';
  if (taken.has(id)) id = `${id}${op.method[0]}${op.method.slice(1).toLowerCase()}`;
  let n = 2;
  const base = id;
  while (taken.has(id)) id = `${base}${n++}`;
  taken.add(id);
  return id;
}

export const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

export interface BuildOptions {
  version: string;
  /** Permissions found in each route's handler source, by routeKey. */
  permissions?: Map<string, string[]>;
  /** Include operations marked internal (for the coverage test). */
  includeInternal?: boolean;
}

export function buildSpec(opts: BuildOptions): Record<string, any> {
  const schemas: Record<string, Schema> = { Error: ERROR };
  for (const c of CATALOGUES) {
    for (const [name, s] of Object.entries(c.schemas)) {
      if (schemas[name] && JSON.stringify(schemas[name]) !== JSON.stringify(s)) throw new Error(`component schema ${name} is defined twice, differently`);
      schemas[name] = s;
    }
  }

  const paths: Record<string, Record<string, any>> = {};
  const usedTags = new Set<string>();
  const taken = new Set<string>();
  for (const op of allOps()) {
    if (op.internal && !opts.includeInternal) continue;
    const p = toOpenApiPath(op.path);
    const perms = op.permissions ?? opts.permissions?.get(routeKey(op.method, op.path)) ?? [];
    const pathNames = [...op.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
    const parameters = [
      ...pathNames.map((name) => ({ name, in: 'path', required: true, description: op.pathParams?.[name] ?? '', schema: { type: 'string' } })),
      ...(op.query ?? []).map((q) => ({ name: q.name, in: 'query', required: !!q.required, ...(q.description ? { description: q.description } : {}), schema: q.schema })),
    ];
    const responses: Record<string, any> = {};
    for (const [status, r] of Object.entries(op.responses)) {
      responses[status] = {
        description: r.description,
        ...(r.schema ? { content: { [r.contentType ?? 'application/json']: { schema: r.schema, ...(r.example !== undefined ? { example: r.example } : {}) } } } : {}),
      };
    }
    const errs = new Set<number>([...(op.errors ?? []), 401, 429, 500]);
    if (perms.length) errs.add(403);
    // Any id or body value can be malformed; a command needs the charger connected.
    if (pathNames.length || op.body) errs.add(400);
    if (op.tag === 'Commands') errs.add(409);
    if (op.path === '/v1/auth/login') errs.delete(401);
    for (const s of [...errs].sort()) responses[String(s)] ??= { $ref: `#/components/responses/E${s}` };

    const permText = perms.length ? `\n\n**Permissions checked:** ${perms.map((x) => `\`${x}\``).join(', ')}.` : '';
    usedTags.add(op.tag);
    (paths[p] ??= {})[op.method.toLowerCase()] = {
      tags: [op.tag],
      summary: op.summary,
      operationId: operationId(op, taken),
      ...(op.description || permText ? { description: `${op.description ?? ''}${permText}`.trim() } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: op.body.required ?? true,
              ...(op.body.description ? { description: op.body.description } : {}),
              content: { [op.body.contentType ?? 'application/json']: { schema: op.body.schema, ...(op.body.example !== undefined ? { example: op.body.example } : {}) } },
            },
          }
        : {}),
      responses,
      ...(perms.length ? { 'x-permissions': perms } : {}),
      ...(op.internal ? { 'x-internal': op.internal } : {}),
      ...(op.path === '/v1/auth/login' ? { security: [] } : {}),
    };
  }

  const responses: Record<string, any> = {};
  const usedErrors = new Set<string>(JSON.stringify(paths).match(/#\/components\/responses\/E\d{3}/g)?.map((r) => r.slice(-3)) ?? []);
  for (const s of [...new Set([...Object.keys(STD_ERRORS), ...usedErrors])].sort()) {
    responses[`E${s}`] = {
      description: STD_ERRORS[Number(s)] ?? 'Error',
      ...(s === '429' ? { headers: RATE_LIMIT_HEADERS } : {}),
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }

  const webhooks: Record<string, any> = {};
  for (const [type, e] of Object.entries(EVENT_DATA)) {
    webhooks[type] = {
      post: {
        summary: e.summary,
        operationId: `webhook_${type.replace(/\./g, '_')}`,
        parameters: [
          { name: 'PlugSure-Event', in: 'header', required: true, schema: { type: 'string', const: type } },
          { name: 'PlugSure-Delivery', in: 'header', required: true, description: 'Event id; the same on every retry.', schema: { type: 'string' } },
          { name: 'PlugSure-Signature', in: 'header', required: true, description: '`t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`', schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id', 'type', 'created_at', 'api_version', 'data'],
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string', const: type },
                  created_at: { type: 'string', format: 'date-time' },
                  api_version: { type: 'string', examples: ['2026-09'] },
                  data: { type: 'object', required: ['orgId', ...e.required], properties: { orgId: { type: 'string', format: 'uuid' }, ...e.properties } },
                },
              },
            },
          },
        },
        responses: { '2XX': { description: 'Received. Anything else (or no answer in 10 s) is retried.' } },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'PlugSure CSMS API',
      version: opts.version,
      description: DESCRIPTION,
      contact: { name: 'PlugSure', url: 'https://plugsure.id' },
    },
    servers: [
      { url: '/', description: 'This installation' },
      { url: 'https://{host}', description: 'Your API host', variables: { host: { default: 'api.example.id' } } },
    ],
    security: [{ bearerAuth: [] }],
    tags: TAGS.filter((t) => usedTags.has(t)).map((name) => ({ name, ...(TAG_TEXT[name] ? { description: TAG_TEXT[name] } : {}) })),
    paths,
    webhooks,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'psk_<prefix>_<secret>', description: 'An API key from Govern → API keys, or a sandbox key.' },
      },
      schemas,
      responses,
    },
  };
}
