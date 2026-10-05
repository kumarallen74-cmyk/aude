import { type Op, type Schema, ref, arrayOf, nullable } from '../types.js';

const T = 'Integrations' as const;
const KIND = { kind: 'Integration: payments (the acquirer: QRIS, e-wallets, cards), otp (driver sign-in codes), otp_fallback, pnc_pki (Plug & Charge PKI) or map_tiles.' };
const DT = { type: 'string', format: 'date-time' };

const configured: Schema = {
  type: ['object', 'null'],
  properties: {
    id: { type: 'string', format: 'uuid' }, scope: { type: 'string', enum: ['org', 'platform'] }, provider: { type: 'string' },
    countryCode: { type: 'string', enum: ['ID', 'MY', 'SG'], description: 'Payments: the country this acquirer account serves (ID for every v1.6 account).' },
    settings: { type: 'object', description: 'Non-secret settings.' },
    secretHints: { type: 'object', description: 'Secret fields that are set, as a hint (last characters). Secret values are never returned.' },
    enabled: { type: 'boolean' },
    webhookPath: nullable('string'), webhookUrl: nullable('string'),
    lastTest: { type: ['object', 'null'], properties: { at: DT, ok: { type: ['boolean', 'null'] }, message: nullable('string') } },
    updatedAt: DT,
  },
};

export const schemas: Record<string, Schema> = {
  IntegrationField: {
    type: 'object', required: ['key', 'label', 'type'],
    properties: {
      key: { type: 'string' }, label: { type: 'string' }, type: { type: 'string', enum: ['text', 'secret', 'select', 'multiselect', 'textarea', 'url', 'number', 'boolean'], description: 'multiselect: an array of option values (payments: methods, the payment methods offered to drivers).' },
      required: { type: 'boolean' }, options: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } } } },
      default: {}, help: { type: 'string' }, placeholder: { type: 'string' }, advanced: { type: 'boolean' },
    },
  },
  IntegrationKind: {
    type: 'object', required: ['kind', 'label', 'scope', 'providers', 'editable'],
    properties: {
      kind: { type: 'string', enum: ['payments', 'otp', 'otp_fallback', 'pnc_pki', 'map_tiles'] },
      label: { type: 'string' }, description: { type: 'string' },
      scope: { type: 'string', enum: ['org', 'platform'], description: 'org: each operator may connect its own account (falls back to the platform\'s); platform: one for the deployment.' },
      providers: arrayOf({
        type: 'object', required: ['id', 'label', 'fields'],
        properties: { id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, fields: arrayOf(ref('IntegrationField')), devOnly: { type: 'boolean' }, webhook: { type: 'boolean' }, docs: { type: 'string' } },
      }),
      own: configured,
      platform: { type: ['object', 'null'], description: 'The platform\'s account; its settings only for platform administrators.' },
      effective: { type: ['object', 'null'], description: 'What is in force: provider and source (console, environment or default). Null = not configured.', properties: { provider: { type: 'string' }, source: { type: 'string' }, scope: { type: 'string' } } },
      editable: { type: 'boolean' },
    },
  },
  IntegrationInput: {
    type: 'object', required: ['provider'],
    properties: {
      provider: { type: 'string' },
      scope: { type: 'string', enum: ['org', 'platform'], default: 'org', description: 'For payments: platform = the default account for operators without their own (platform administrators).' },
      settings: { type: 'object' },
      secrets: { type: 'object', description: 'Only the secrets to set or change; an empty or missing field keeps the stored one.' },
      enabled: { type: 'boolean', default: true },
      countryCode: { type: 'string', enum: ['ID', 'MY', 'SG'], default: 'ID', description: 'Payments: the country of this acquirer account (one account per organisation and country; its currency follows). Stripe needs MY or SG; the Indonesian acquirers take ID only. MY/SG need MULTI_COUNTRY=true (409 otherwise).' },
    },
  },
};

export const ops: Op[] = [
  {
    method: 'GET', path: '/v1/integrations', tag: T, summary: 'Integrations and their status',
    description: 'Every integration with its providers and fields, what this operator and the platform have configured, and what is in force (console settings over environment variables over the built-in default). Secret values are never returned.',
    responses: { 200: { description: 'Integrations', schema: { type: 'object', required: ['kinds', 'production'], properties: {
      kinds: arrayOf(ref('IntegrationKind')), production: { type: 'boolean' }, publicBaseUrl: { type: 'string' },
      paymentsByCountry: arrayOf({
        type: 'object', description: 'Payments accounts for countries other than Indonesia (Stripe MY / SG), one entry per country that has one. kinds[payments] stays Indonesia\'s.',
        properties: { countryCode: { type: 'string', enum: ['MY', 'SG'] }, own: configured, platform: { type: ['object', 'null'] }, effective: { type: ['object', 'null'] } },
      }),
    } } } },
  },
  {
    method: 'PUT', path: '/v1/integrations/:kind', tag: T, summary: 'Connect or change an integration', pathParams: KIND,
    description: 'Saves the provider, its settings and (sealed with SECRETS_KEY) its secrets. Payments: the operator\'s own merchant account (org:write), or the platform default (platform:admin); settings.methods chooses the payment methods drivers may use among those the acquirer offers (QRIS, GOPAY, SHOPEEPAY, OVO, DANA, LINKAJA, CARD; Stripe: CARD, PAYNOW (SG), FPX (MY), GRABPAY; at least one; default QRIS, Stripe CARD). countryCode picks the country\'s account (Stripe for MY and SG: publishable key, secret key, webhook signing secret; test keys refused in production unless settings.allowTestMode — deploy/STRIPE.md). The other kinds are platform-wide (platform:admin). Test doubles are refused in production. Audited as integration.updated, without secret values.',
    body: { required: true, schema: ref('IntegrationInput'), example: { provider: 'midtrans', settings: { environment: 'sandbox', acquirer: 'gopay', methods: ['QRIS', 'GOPAY', 'CARD'] }, secrets: { serverKey: 'SB-Mid-server-…' } } },
    responses: { 200: { description: 'Saved (secrets as hints)', schema: configured } },
    errors: [404, 422],
  },
  {
    method: 'DELETE', path: '/v1/integrations/:kind', tag: T, summary: 'Remove an integration\'s console settings', pathParams: KIND,
    description: 'The environment variables (or the default) apply again. A payments account is archived (its payments keep their webhook and refunds).',
    query: [{ name: 'scope', schema: { type: 'string', enum: ['org', 'platform'] } }, { name: 'countryCode', schema: { type: 'string', enum: ['ID', 'MY', 'SG'], default: 'ID' }, description: 'Payments: which country\'s account.' }],
    responses: { 200: { description: 'Removed', schema: { type: 'object', required: ['removed'], properties: { removed: { type: 'boolean' } } } } },
    errors: [404],
  },
  {
    method: 'POST', path: '/v1/integrations/:kind/test', tag: T, summary: 'Test an integration', pathParams: KIND,
    description: 'Checks the credentials without moving money: the acquirer\'s authentication, the messaging account (and, with a phone number, a real test code), the PKI gateway\'s roots, a map tile.',
    body: { schema: { type: 'object', properties: { scope: { type: 'string', enum: ['org', 'platform'] }, phone: { type: 'string', description: 'Sign-in codes: send a real test code to this number.' }, countryCode: { type: 'string', enum: ['ID', 'MY', 'SG'], description: 'Payments: which country\'s account (Stripe: also checks the Stripe account is registered in that country).' } } }, example: { phone: '081234567890' } },
    responses: { 200: { description: 'The result', schema: { type: 'object', required: ['ok', 'message'], properties: { ok: { type: 'boolean' }, message: { type: 'string' } } } } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/integrations/:kind/events', tag: T, summary: 'Integration activity', pathParams: KIND,
    description: 'Payments created (create_qris; create_checkout for e-wallets and cards, with the channel) and notified, codes sent (numbers masked, codes never), tests.',
    query: [{ name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }],
    responses: { 200: { description: 'Events', schema: { type: 'object', required: ['events'], properties: { events: arrayOf({ type: 'object', properties: { id: { type: 'integer' }, kind: { type: 'string' }, provider: { type: 'string' }, action: { type: 'string' }, outcome: { type: 'string' }, detail: { type: 'object' }, created_at: DT } }) } } } },
    errors: [404],
  },
];
