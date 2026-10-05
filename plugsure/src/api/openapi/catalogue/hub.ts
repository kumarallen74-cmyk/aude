import { type Op, type Schema, OK } from '../types.js';

/**
 * PlugSure Hub (docs/HUB-DESIGN.md §9.1, WP H1): platform administration of the roaming hub. Internal (not
 * in the published document): platform operators only. Every route answers 404 while HUB_ENABLED is false.
 * The OCPI protocol surface itself is at /hub/ocpi and follows the OCPI 2.2.1 specification.
 */

const PA = 'Platform administration' as const;
const INTERNAL = 'platform administration (PlugSure Hub)';
const S: Schema = { type: 'string' };
const UUID: Schema = { type: 'string', format: 'uuid' };
const OBJ: Schema = { type: 'object' };
const list = (key: string): Schema => ({ type: 'object', required: [key], properties: { [key]: { type: 'array', items: OBJ } } });
/** Every lifecycle call takes an optional operator's reason, kept in the audit entry (the console asks for one). */
const REASON: Schema = { type: 'string', maxLength: 500, description: 'Why (kept in the audit entry)' };
const reasonBody = { schema: { type: 'object', properties: { reason: REASON } } as Schema };

const member: Schema = {
  type: 'object',
  properties: {
    id: UUID, org_id: UUID, kind: { enum: ['internal', 'external'] }, legal_name: S, country_code: { enum: ['ID', 'MY', 'SG'] },
    status: { enum: ['onboarding', 'active', 'suspended', 'terminated'] }, open_roaming: { type: 'boolean' },
  },
};
const memberResult: Schema = { type: 'object', required: ['member'], properties: { member } };
const party: Schema = {
  type: 'object',
  properties: {
    id: UUID, member_id: UUID, connection_id: { type: ['string', 'null'] }, country_code: S, party_id: S,
    role: { enum: ['CPO', 'EMSP', 'NSP', 'OTHER', 'SCSP', 'NAP'] }, status: { enum: ['CONNECTED', 'OFFLINE', 'PLANNED', 'SUSPENDED'] }, admin_suspended: { type: 'boolean' },
  },
};
const agreement: Schema = {
  type: 'object',
  properties: {
    id: UUID, cpo_party_id: UUID, emsp_party_id: UUID, status: { enum: ['proposed', 'active', 'suspended', 'ended'] },
    allow_realtime_auth: { type: 'boolean' }, allow_commands: { type: 'boolean' }, allow_charging_profiles: { type: 'boolean' },
    valid_from: { type: ['string', 'null'] }, valid_to: { type: ['string', 'null'] },
  },
};
const connection: Schema = {
  type: 'object',
  description: 'A credentials pairing. Tokens are never returned (token A only once, on creation).',
  properties: { id: UUID, member_id: UUID, kind: { enum: ['internal', 'external'] }, state: { enum: ['pending', 'connected', 'suspended', 'closed'] }, versions_url: { type: ['string', 'null'] }, rate_limit_per_min: { type: 'integer' }, realtime_limit_per_min: { type: 'integer' } },
};

const op = (o: Omit<Op, 'tag' | 'internal'>): Op => ({ tag: PA, internal: INTERNAL, permissions: ['platform:admin'], ...o });

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  op({ method: 'GET', path: '/v1/hub/overview', summary: 'Hub overview', description: 'Counts of members, parties by status, agreements, 24 h traffic per route and the outbox; members and parties by country; open hub alerts; the optional hub modules of this build (`modules.clearing`).', responses: { 200: { description: 'Overview', schema: OBJ } } }),
  op({ method: 'GET', path: '/v1/hub/self-parties', summary: 'The hub\'s own parties (role HUB)', description: 'From HUB_PARTIES, one per country, and the versions URL members register with.', responses: { 200: { description: 'Parties', schema: list('parties') } } }),
  op({ method: 'GET', path: '/v1/hub/tenants', summary: 'Tenants that can join the hub', description: 'Organisations with a roaming identity (OCPI party), with their hub membership if any.', responses: { 200: { description: 'Tenants', schema: list('tenants') } } }),
  op({ method: 'GET', path: '/v1/hub/members', summary: 'Hub members', query: [{ name: 'status', schema: S }, { name: 'kind', schema: { enum: ['internal', 'external'] } }], responses: { 200: { description: 'Members', schema: list('members') } } }),
  op({
    method: 'POST', path: '/v1/hub/members', summary: 'Create an external member',
    description: 'Creates the member and its hub-only organisation. It starts `onboarding`: its parties stay PLANNED until it is activated.',
    body: { schema: { type: 'object', required: ['legal_name', 'country_code'], properties: { legal_name: S, country_code: { enum: ['ID', 'MY', 'SG'] }, tax_id: S, billing_email: S, contract_ref: S, open_roaming: { type: 'boolean' } } } },
    responses: { 201: { description: 'Created', schema: memberResult } }, errors: [400],
  }),
  op({
    method: 'POST', path: '/v1/hub/members/join-tenant', summary: 'Join a PlugSure tenant to the hub (zero configuration)',
    description: 'One transaction, no HTTP handshake: a hub connection (kind internal) and a "PlugSure Hub" partner in the tenant\'s org. Idempotent.',
    body: { schema: { type: 'object', required: ['org_id'], properties: { org_id: UUID, reason: REASON } } },
    responses: { 200: { description: 'Joined', schema: { type: 'object', properties: { member, connectionId: UUID, partnerId: UUID, created: { type: 'boolean' } } } } }, errors: [400, 404, 409],
  }),
  op({ method: 'POST', path: '/v1/hub/members/leave-tenant', summary: 'A tenant leaves the hub', description: 'Closes its hub connection and partner; its parties become SUSPENDED.', body: { schema: { type: 'object', required: ['org_id'], properties: { org_id: UUID, reason: REASON } } }, responses: { 200: { description: 'Left', schema: OK } }, errors: [400, 404] }),
  op({ method: 'GET', path: '/v1/hub/members/:id', summary: 'One member, with its connections and parties', pathParams: { id: 'Member id' }, responses: { 200: { description: 'Member', schema: OBJ } }, errors: [404] }),
  op({
    method: 'PATCH', path: '/v1/hub/members/:id', summary: 'Activate, suspend, resume or terminate a member; open roaming; details',
    pathParams: { id: 'Member id' },
    body: { schema: { type: 'object', properties: { action: { enum: ['activate', 'suspend', 'resume', 'terminate'] }, open_roaming: { type: 'boolean' }, billing_email: S, contract_ref: S, tax_id: S, legal_name: S, reason: REASON } } },
    responses: { 200: { description: 'Updated', schema: memberResult } }, errors: [400, 404, 409],
  }),
  op({
    method: 'POST', path: '/v1/hub/members/:id/connections', summary: 'New external connection: token A (shown once) and the versions URL',
    pathParams: { id: 'Member id' }, body: { schema: { type: 'object', properties: { rate_limit_per_min: { type: 'integer' }, realtime_limit_per_min: { type: 'integer' }, reason: REASON } } },
    responses: { 201: { description: 'Created', schema: { type: 'object', required: ['connection', 'token', 'versionsUrl'], properties: { connection, token: S, versionsUrl: S } } } }, errors: [400, 404, 409],
  }),
  op({ method: 'GET', path: '/v1/hub/connections', summary: 'Hub connections', query: [{ name: 'state', schema: S }], responses: { 200: { description: 'Connections', schema: list('connections') } } }),
  op({ method: 'GET', path: '/v1/hub/connections/:id', summary: 'One connection and its parties', pathParams: { id: 'Connection id' }, responses: { 200: { description: 'Connection', schema: OBJ } }, errors: [404] }),
  op({ method: 'PATCH', path: '/v1/hub/connections/:id', summary: 'Rate limits of a connection', pathParams: { id: 'Connection id' }, body: { schema: { type: 'object', properties: { rate_limit_per_min: { type: 'integer' }, realtime_limit_per_min: { type: 'integer' }, reason: REASON } } }, responses: { 200: { description: 'Updated', schema: OBJ } }, errors: [400, 404] }),
  op({
    method: 'POST', path: '/v1/hub/connections/:id/connect', summary: 'Hub-initiated handshake with a member\'s versions URL and token A',
    pathParams: { id: 'Connection id (pending)' }, body: { schema: { type: 'object', required: ['versions_url', 'token'], properties: { versions_url: S, token: S } } },
    responses: { 200: { description: 'Connected', schema: OBJ } }, errors: [400, 404, 409, 502],
  }),
  ...(['suspend', 'resume', 'rotate', 'close', 'alive-check'] as const).map((a) => op({
    method: 'POST', path: `/v1/hub/connections/:id/${a}`,
    summary: { suspend: 'Suspend a connection (its parties SUSPENDED)', resume: 'Resume a suspended connection', rotate: 'Rotate a connection\'s tokens (old token valid for HUB_TOKEN_GRACE_MIN)', close: 'Close a connection (tokens die; parties SUSPENDED)', 'alive-check': 'Check a member\'s versions URL now' }[a],
    pathParams: { id: 'Connection id' }, body: reasonBody, responses: { 200: { description: 'Done', schema: OBJ } }, errors: [404, 409, 502],
  })),
  op({ method: 'POST', path: '/v1/hub/connections/:id/capture', summary: 'Capture redacted bodies in the message log (support, at most 72 h)', pathParams: { id: 'Connection id' }, body: { schema: { type: 'object', required: ['hours'], properties: { hours: { type: 'number', minimum: 0, maximum: 72 }, reason: REASON } } }, responses: { 200: { description: 'Set', schema: OBJ } }, errors: [400, 404] }),
  op({ method: 'POST', path: '/v1/hub/connections/:id/parties', summary: 'Approve an additional party for a connection', description: 'A PLANNED party the member then confirms with PUT /credentials.', pathParams: { id: 'Connection id' }, body: { schema: { type: 'object', required: ['role', 'country_code', 'party_id'], properties: { role: S, country_code: S, party_id: S, business_name: S, website: S, reason: REASON } } }, responses: { 201: { description: 'Approved', schema: { type: 'object', properties: { party } } } }, errors: [400, 404] }),
  op({ method: 'GET', path: '/v1/hub/parties', summary: 'Hub parties', query: [{ name: 'member', schema: UUID }, { name: 'status', schema: S }, { name: 'role', schema: S }], responses: { 200: { description: 'Parties', schema: list('parties') } } }),
  op({ method: 'PATCH', path: '/v1/hub/parties/:id', summary: 'Suspend or resume one party', pathParams: { id: 'Party id' }, body: { schema: { type: 'object', required: ['action'], properties: { action: { enum: ['suspend', 'resume'] }, reason: REASON } } }, responses: { 200: { description: 'Updated', schema: { type: 'object', properties: { party } } } }, errors: [400, 404] }),
  op({ method: 'GET', path: '/v1/hub/agreements', summary: 'Roaming agreements', query: [{ name: 'status', schema: S }, { name: 'party', schema: UUID }], responses: { 200: { description: 'Agreements', schema: list('agreements') } } }),
  op({
    method: 'POST', path: '/v1/hub/agreements', summary: 'Create a roaming agreement (CPO party ⇄ eMSP-side party)',
    description: 'Active at once unless `activate` is false (then proposed). No agreement between two parties of the same member.',
    body: { schema: { type: 'object', required: ['cpo_party_id', 'emsp_party_id'], properties: { cpo_party_id: UUID, emsp_party_id: UUID, activate: { type: 'boolean' }, allow_realtime_auth: { type: 'boolean' }, allow_commands: { type: 'boolean' }, allow_charging_profiles: { type: 'boolean' }, valid_from: S, valid_to: S, notes: S } } },
    responses: { 201: { description: 'Created', schema: { type: 'object', properties: { agreement } } } }, errors: [400, 404, 409],
  }),
  op({ method: 'PATCH', path: '/v1/hub/agreements/:id', summary: 'Approve, suspend, resume or end an agreement; module flags', pathParams: { id: 'Agreement id' }, body: { schema: { type: 'object', properties: { action: { enum: ['approve', 'suspend', 'resume', 'end'] }, allow_realtime_auth: { type: 'boolean' }, allow_commands: { type: 'boolean' }, allow_charging_profiles: { type: 'boolean' }, notes: S, reason: REASON } } }, responses: { 200: { description: 'Updated', schema: { type: 'object', properties: { agreement } } } }, errors: [400, 404, 409] }),
  op({
    method: 'GET', path: '/v1/hub/messages', summary: 'The routing log (redacted)',
    query: [{ name: 'connection', schema: UUID }, { name: 'correlation', schema: S }, { name: 'route', schema: S }, { name: 'party', schema: S, description: 'CC*PID' }, { name: 'status', schema: { enum: ['ok', 'error'] } }, { name: 'module', schema: S, description: 'OCPI module (locations, sessions, cdrs, …)' }, { name: 'from', schema: S }, { name: 'to', schema: S }, { name: 'before', schema: S }, { name: 'limit', schema: { type: 'integer' } }],
    responses: { 200: { description: 'Messages', schema: list('messages') } },
  }),
  op({ method: 'GET', path: '/v1/hub/messages/trace/:correlationId', summary: 'All legs of one correlation id', pathParams: { correlationId: 'X-Correlation-ID' }, responses: { 200: { description: 'Legs', schema: list('legs') } } }),
  op({ method: 'GET', path: '/v1/hub/outbox', summary: 'The hub outbox (broadcasts, callbacks, ClientInfo)', query: [{ name: 'state', schema: S }, { name: 'connection', schema: UUID }], responses: { 200: { description: 'Rows', schema: list('rows') } } }),
  op({ method: 'POST', path: '/v1/hub/outbox/replay', summary: 'Replay a connection\'s failed outbox rows', body: { schema: { type: 'object', required: ['connection_id'], properties: { connection_id: UUID, reason: REASON } } }, responses: { 200: { description: 'Replayed', schema: { type: 'object', properties: { replayed: { type: 'integer' } } } } }, errors: [400] }),
  op({ method: 'GET', path: '/v1/hub/health', summary: 'Per-connection health', description: 'Traffic in the last 15 min, error and 4002/4003 counts, p95 latency of outbound legs, outbox backlog, liveness.', responses: { 200: { description: 'Health', schema: list('connections') } } }),
  {
    method: 'GET', path: '/v1/roaming/hub', tag: 'Roaming',
    summary: 'This operator\'s hub membership', description: 'Membership, its parties and the roaming agreements they are in (counterparty name, status, module flags). Never tokens or endpoints.', permissions: ['roaming:read'], responses: { 200: { description: 'Membership', schema: OBJ } },
  },
  {
    method: 'POST', path: '/v1/roaming/hub/join', tag: 'Roaming',
    summary: 'Join PlugSure Hub (when HUB_SELF_JOIN)', permissions: ['roaming:write'], responses: { 200: { description: 'Joined', schema: OBJ } }, errors: [403, 409],
  },
];
