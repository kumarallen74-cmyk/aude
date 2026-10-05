import { type Op, type Schema, ref, nullable, OK } from '../types.js';

/**
 * "Sign in with Microsoft" (v1.6.0): src/api/microsoft-routes.ts, and the per-user unbind in
 * console-routes.ts. The two browser legs of the sign-in are console plumbing (internal); the
 * organisation's tenant settings are ordinary user-management routes.
 */

const AUTH_INTERNAL = 'console sign-in; browser navigation, API keys do not use it';
const uuid: Schema = { type: 'string', format: 'uuid' };

export const schemas: Record<string, Schema> = {
  MicrosoftTenant: {
    type: 'object',
    description: 'The Microsoft Entra tenant the organisation connected for “Sign in with Microsoft”.',
    required: ['tenantId', 'allowedDomains', 'linkedAt', 'linkedBy', 'linkedByAccount'],
    properties: {
      tenantId: { ...uuid, description: 'The Entra directory (tenant) id, from the validated sign-in that connected it.' },
      allowedDomains: {
        type: 'array',
        items: { type: 'string' },
        description: 'When not empty, a first Microsoft sign-in is matched to a console user only by an address in one of these domains.',
      },
      linkedAt: { type: 'string', format: 'date-time' },
      linkedBy: {
        anyOf: [{ type: 'object', required: ['id', 'name'], properties: { id: uuid, name: { type: 'string' } } }, { type: 'null' }],
        description: 'The administrator who connected it.',
      },
      linkedByAccount: nullable('string', { description: 'The Microsoft account that proved control of the tenant.' }),
    },
  },
};

const redirect = (what: string) => ({ description: what });

export const ops: Op[] = [
  {
    method: 'GET',
    path: '/v1/auth/microsoft/start',
    tag: 'Console session',
    summary: 'Start signing in with Microsoft',
    description:
      'The console’s “Sign in with Microsoft” button navigates here. Answers 302 to Microsoft’s sign-in page (authorization code flow with PKCE, ' +
      '`response_mode=query`) and sets a short-lived browser-binding cookie. No credentials needed. 404 when MS_CLIENT_ID is not configured; ' +
      'rate limited per client address (MS_SIGNIN_RATE_PER_MIN).',
    responses: { 302: redirect('To Microsoft.'), 303: redirect('Back to the console with `?ms=<reason>` when it cannot start here.') },
    errors: [404],
    permissions: [],
    internal: AUTH_INTERNAL,
  },
  {
    method: 'GET',
    path: '/v1/auth/microsoft/callback',
    tag: 'Console session',
    summary: 'Return from Microsoft sign-in',
    description:
      'The redirect URI registered in Azure (`PUBLIC_BASE_URL` + this path). Consumes the single-use sign-in transaction, redeems the code with the client secret and ' +
      'PKCE verifier, validates the ID token and finds the console user of the organisation that connected the token’s tenant — never creating one. ' +
      'Answers 303 to `/` with the session cookie set (or a pending session when the authenticator-app code is still needed), or to `/?ms=<reason>`: ' +
      '`not_linked`, `no_user`, `disabled`, `locked`, `oid_conflict`, `personal_account`, `admin_host`, `expired`, `cancelled`, `consent`, `failed`. ' +
      'In tenant-connection mode, to `/?ms=linked#/users/microsoft` (or `tenant_taken`, `link_forbidden`, `already_linked`, `not_tenant_admin`, `roles_missing`, `guest_account`). Every outcome is audited.',
    query: [
      { name: 'code', schema: { type: 'string' }, description: 'From Microsoft.' },
      { name: 'state', schema: { type: 'string' }, description: 'From Microsoft.' },
      { name: 'error', schema: { type: 'string' }, description: 'From Microsoft, when the sign-in did not complete.' },
      { name: 'error_description', schema: { type: 'string' }, description: 'From Microsoft.' },
    ],
    responses: { 303: redirect('To the console.') },
    errors: [404],
    permissions: [],
    internal: AUTH_INTERNAL,
  },
  {
    method: 'POST',
    path: '/v1/auth/microsoft/link',
    tag: 'Users and roles',
    summary: 'Start connecting a Microsoft tenant',
    description:
      'For an administrator signed in to the console: answers the Microsoft sign-in URL to open. The administrator signs in there with a MEMBER account of the organisation’s ' +
      'Entra tenant holding a tenant administrator role (Global, Privileged Role, Cloud Application or Application Administrator, from the `wids` claim); the callback records the tenant of that validated sign-in ' +
      'and alerts the platform operator. A tenant can be connected to one organisation only. 409 when one is already connected ' +
      '(disconnect it first) or for a sandbox. Audited.',
    responses: { 200: { description: 'Where to send the browser.', schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' } } } } },
    errors: [404, 409, 502],
    internal: 'console only: needs a signed-in administrator’s browser',
  },
  {
    method: 'GET',
    path: '/v1/auth/microsoft/tenant',
    tag: 'Users and roles',
    summary: 'Get the connected Microsoft tenant',
    description: 'The organisation’s connected Entra tenant (or null), how many users are bound to a Microsoft account, and the redirect URI for this console address. 404 when Microsoft sign-in is not configured.',
    responses: {
      200: {
        description: 'The tenant.',
        schema: {
          type: 'object',
          required: ['tenant', 'boundUsers', 'redirectUri'],
          properties: {
            tenant: { anyOf: [ref('MicrosoftTenant'), { type: 'null' }] },
            boundUsers: { type: 'integer' },
            redirectUri: nullable('string', { description: 'Null when this console address does not offer Microsoft sign-in.' }),
          },
        },
      },
    },
    errors: [404],
  },
  {
    method: 'PUT',
    path: '/v1/auth/microsoft/tenant',
    tag: 'Users and roles',
    summary: 'Set the allowed e-mail domains',
    description: 'Up to 20 domain names; empty = any address of the tenant may be matched to a console user (not recommended). A signed-in administrator only: API keys are refused (403). Audited.',
    body: {
      required: true,
      schema: { type: 'object', required: ['allowedDomains'], properties: { allowedDomains: { type: 'array', items: { type: 'string' }, maxItems: 20 } } },
      example: { allowedDomains: ['voltindo.co.id'] },
    },
    responses: { 200: { description: 'Saved.', schema: { type: 'object', required: ['tenant'], properties: { tenant: ref('MicrosoftTenant') } } } },
    errors: [404],
  },
  {
    method: 'DELETE',
    path: '/v1/auth/microsoft/tenant',
    tag: 'Users and roles',
    summary: 'Disconnect the Microsoft tenant',
    description:
      'Microsoft sign-in stops for the organisation: every user’s binding to a Microsoft account is removed and every session signed in with Microsoft ends. ' +
      'Password sign-in is not affected. A signed-in administrator only: API keys are refused (403). Audited.',
    responses: {
      200: {
        description: 'Disconnected.',
        schema: {
          type: 'object',
          required: ['ok', 'tenantId', 'usersUnbound', 'sessionsEnded'],
          properties: { ok: { type: 'boolean', const: true }, tenantId: uuid, usersUnbound: { type: 'integer' }, sessionsEnded: { type: 'integer' } },
        },
      },
    },
    errors: [404],
  },
  {
    method: 'DELETE',
    path: '/v1/users/:id/microsoft',
    tag: 'Users and roles',
    summary: 'Unbind a user from their Microsoft account',
    description:
      'The user’s next Microsoft sign-in is matched by e-mail address again and binds afresh; their sessions signed in with Microsoft end (password sessions do not). ' +
      'Within your own authority only. Audited.',
    pathParams: { id: 'User id (UUID).' },
    responses: { 200: { description: 'Unbound.', schema: OK } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/platform/microsoft-tenants',
    tag: 'Platform administration',
    summary: 'List every connected Microsoft tenant',
    description: 'The platform operator: which organisation holds which Entra tenant, when and by which Microsoft account it was connected, and how many users are linked.',
    responses: {
      200: {
        description: 'The tenants.',
        schema: {
          type: 'object',
          required: ['tenants'],
          properties: {
            tenants: {
              type: 'array',
              items: {
                type: 'object',
                required: ['orgId', 'orgName', 'tenantId', 'linkedAt', 'linkedByAccount', 'boundUsers'],
                properties: {
                  orgId: uuid, orgName: { type: 'string' }, tenantId: uuid, linkedAt: { type: 'string', format: 'date-time' },
                  linkedByAccount: nullable('string'), boundUsers: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
    errors: [404],
    internal: 'platform administration',
  },
  {
    method: 'DELETE',
    path: '/v1/platform/microsoft-tenants/:tenantId',
    tag: 'Platform administration',
    summary: 'Release a Microsoft tenant from its organisation',
    description:
      'The platform operator releases a tenant connected by an organisation that does not own it: that organisation’s Microsoft links are removed and its Microsoft sessions end, ' +
      'exactly as when it disconnects itself; the tenant can then be connected by its owner. A signed-in platform administrator only. Audited in both organisations.',
    pathParams: { tenantId: 'The Entra tenant id (UUID).' },
    responses: {
      200: {
        description: 'Released.',
        schema: {
          type: 'object',
          required: ['ok', 'orgId', 'usersUnbound', 'sessionsEnded'],
          properties: { ok: { type: 'boolean', const: true }, orgId: uuid, usersUnbound: { type: 'integer' }, sessionsEnded: { type: 'integer' } },
        },
      },
    },
    errors: [404],
    internal: 'platform administration',
  },
];
