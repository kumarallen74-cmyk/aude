import { type Op, type Schema } from '../types.js';

/**
 * Phase 31 (v1.43.0): src/api/phase31-routes.ts. Dynamic pricing (Tariffs), grid demand response (Load management),
 * the public status page (Availability) and SCIM provisioning's console settings (Users and roles). The SCIM 2.0
 * endpoint itself (/scim/v2, RFC 7644) is outside /v1 and documented in deploy/SCIM.md.
 */

const obj: Schema = { type: 'object' };
const STATUS_LINK = 'the links in the status page\'s e-mails; an HTML page for a person, not an API';

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  // ------------------------------------------------------------------ dynamic pricing
  { method: 'GET', path: '/v1/dynamic-pricing', tag: 'Tariffs', summary: 'Dynamic pricing: settings, rules, each site now',
    description: '(v1.43.0) The settings (enabled, floorPct, capPct, includeTime), the rules, and each site\'s price factor now with the rules behind it.',
    responses: { 200: { description: '{settings, rules, sites}.', schema: obj } } },
  { method: 'PUT', path: '/v1/dynamic-pricing/settings', tag: 'Tariffs', summary: 'Dynamic pricing on/off and its band',
    description: '(v1.43.0) enabled; floorPct (50–100, default 80) and capPct (100–200, default 130): every price stays inside; includeTime: the per-minute time fee moves too. Energy only otherwise; session, admin and idle fees and the PLN formula rate never move; an increase is held at the regulated energy ceiling. Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [422] },
  { method: 'POST', path: '/v1/dynamic-pricing/rules', tag: 'Tariffs', summary: 'Add a dynamic pricing rule',
    description: '(v1.43.0) name, kind (time: dayMask, hourFrom, hourTo in the site\'s zone; peak: the grid\'s peak hours of the site\'s energy tariff; occupancy: threshold % of connectors in use; solar: threshold kW of solar output), adjustPct (−50 to 50), siteId (empty: every site), enabled, sortOrder. Matching rules add up. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The rule.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/dynamic-pricing/rules/:id', tag: 'Tariffs', summary: 'Change or archive a dynamic pricing rule',
    description: '(v1.43.0) The fields above, or archive: true. Audited.', pathParams: { id: 'The rule.' },
    body: { required: true, schema: obj }, responses: { 200: { description: 'The rule.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/dynamic-pricing/sites/:siteId/preview', tag: 'Tariffs', summary: 'What a site\'s rules would do',
    description: '(v1.43.0) The factor hour by hour over the next 7 days (time and peak rules), the factor now, a sample price per kWh rated as a session would be (so a regulated ceiling shows), and the last 30 days\' energy revenue under the time and peak rules.',
    pathParams: { siteId: 'The site.' }, responses: { 200: { description: 'The preview.', schema: obj } }, errors: [404] },

  // ------------------------------------------------------------------ demand response
  { method: 'GET', path: '/v1/dr/programs', tag: 'Load management', summary: 'Demand-response programmes',
    description: '(v1.43.0) Each programme: webhook (the grid operator or aggregator posts events) or openadr3 (PlugSure polls an OpenADR 3 server), its sites, the incentive per kWh, the last poll and its error.',
    responses: { 200: { description: '{programs}.', schema: obj } } },
  { method: 'POST', path: '/v1/dr/programs', tag: 'Load management', summary: 'Add a demand-response programme',
    description: '(v1.43.0) name, kind (webhook | openadr3), siteIds, incentiveMinorPerKwh, currency, enabled; openadr3: vtnUrl, tokenUrl, programRef, clientId, clientSecret (kept encrypted). Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The programme.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/dr/programs/:id', tag: 'Load management', summary: 'Change or archive a programme',
    description: '(v1.43.0) The fields above (the kind cannot change), or archive: true. Audited.', pathParams: { id: 'The programme.' },
    body: { required: true, schema: obj }, responses: { 200: { description: 'The programme.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/dr/programs/:id/key', tag: 'Load management', summary: 'A new key for a webhook programme',
    description: '(v1.43.0) Returns the key once (pdr_…) and the URL to post events to; only its hash is kept and the previous key stops working. Audited.',
    pathParams: { id: 'The programme.' }, responses: { 200: { description: '{key, hint, url}.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/dr/programs/:id/manual-event', tag: 'Load management', summary: 'Add an event by hand',
    description: '(v1.43.0) For a call or an e-mail from the grid operator: startsAt, endsAt, limitKw or reducePct, siteIds (default: the programme\'s), note. Audited.',
    pathParams: { id: 'The programme.' }, body: { required: true, schema: obj }, responses: { 201: { description: '{id, created, status}.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/dr/programs/:id/poll', tag: 'Load management', summary: 'Poll an OpenADR programme now',
    description: '(v1.43.0) Fetch the programme\'s events from its OpenADR 3 server now (otherwise every 5 minutes).',
    pathParams: { id: 'The programme.' }, responses: { 200: { description: '{events, program}.', schema: obj } }, errors: [404] },
  { method: 'GET', path: '/v1/dr/events', tag: 'Load management', summary: 'Demand-response events and what they delivered',
    description: '(v1.43.0) Events (days, programId): upcoming, active, completed, cancelled or opted out; per site the baseline and actual energy measured by the load manager, the reduction (kWh, average kW) and the incentive.',
    query: [{ name: 'days', schema: { type: 'integer' } }, { name: 'programId', schema: { type: 'string' } }], responses: { 200: { description: '{events, note}.', schema: obj } } },
  { method: 'POST', path: '/v1/dr/events/:id/opt-out', tag: 'Load management', summary: 'Opt out of an event',
    description: '(v1.43.0) The event no longer limits charging; recorded with who and why (note). Audited.', pathParams: { id: 'The event.' },
    body: { schema: obj }, responses: { 200: { description: '{id, status}.', schema: obj } }, errors: [404, 409] },
  { method: 'POST', path: '/v1/dr/programs/:id/events', tag: 'Load management', summary: 'Send a demand-response event (grid operator / aggregator)',
    description: '(v1.43.0) Authorization: Bearer <programme key>. id (the event\'s own ID: a repeat updates it), start, end or durationMinutes, limitKw (the grid limit for its sites together) or reducePct (1–100), siteIds (default: the programme\'s), status: cancelled to call it off, note. At most 24 hours, 30 days ahead. 201 new, 200 updated. At most 60 a minute per programme.',
    pathParams: { id: 'The programme.' }, body: { required: true, schema: obj }, responses: { 201: { description: '{id, created, status}.', schema: obj }, 200: { description: 'Updated.', schema: obj } }, errors: [401, 409, 422, 429], permissions: [] },

  // ------------------------------------------------------------------ status page
  { method: 'GET', path: '/v1/status-page', tag: 'Availability', summary: 'The public status page\'s settings',
    description: '(v1.43.0) enabled, slug (the page is at /status/<slug>; on an approved own console address also /status), title, intro, siteIds (empty: all), showCounts, and the number of confirmed subscribers.',
    responses: { 200: { description: 'The settings.', schema: obj } } },
  { method: 'PUT', path: '/v1/status-page', tag: 'Availability', summary: 'Change the public status page',
    description: '(v1.43.0) The fields above. A slug belongs to one organisation. Audited.', body: { required: true, schema: obj },
    responses: { 200: { description: 'The settings.', schema: obj } }, errors: [409, 422] },
  { method: 'GET', path: '/v1/status-page/incidents', tag: 'Availability', summary: 'Incidents and planned maintenance',
    description: '(v1.43.0) Open ones, and those closed in the last days (default 60).', query: [{ name: 'days', schema: { type: 'integer' } }],
    responses: { 200: { description: '{incidents}.', schema: obj } } },
  { method: 'POST', path: '/v1/status-page/incidents', tag: 'Availability', summary: 'Open an incident or schedule maintenance',
    description: '(v1.43.0) kind (incident | maintenance), title, impact (minor | major | critical), status, siteIds, message (public), scheduledFrom and scheduledTo (maintenance), notify (default true: e-mail the subscribers). Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The incident.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/status-page/incidents/:id', tag: 'Availability', summary: 'Post an update to an incident',
    description: '(v1.43.0) status and message (an update, public), title, impact, notify. Audited.', pathParams: { id: 'The incident.' },
    body: { required: true, schema: obj }, responses: { 200: { description: 'The incident.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/status/:slug', tag: 'Availability', summary: 'A public status page\'s data',
    description: '(v1.43.0) No credentials. Overall state, each site\'s state (operational, degraded, outage, maintenance; with connector counts if shown), open incidents, planned maintenance, the last 14 days. Cached 30 s. 404 when there is no such page or it is off.',
    pathParams: { slug: 'The page.' }, responses: { 200: { description: 'The page.', schema: obj } }, errors: [404], permissions: [] },
  { method: 'POST', path: '/v1/status/:slug/subscribe', tag: 'Availability', summary: 'Subscribe to a status page by e-mail',
    description: '(v1.43.0) No credentials. email: a confirmation link is sent; nothing else until it is followed. The same answer whether the address is new or not. At most 5 a minute per address.',
    pathParams: { slug: 'The page.' }, body: { required: true, schema: obj }, responses: { 200: { description: '{ok, message}.', schema: obj } }, errors: [404, 422, 429, 503], permissions: [] },
  { method: 'GET', path: '/v1/status/:slug/confirm', tag: 'Availability', summary: 'Confirm a status-page subscription',
    description: '(v1.43.0) The link in the confirmation e-mail.', pathParams: { slug: 'The page.' }, query: [{ name: 't', schema: { type: 'string' } }],
    responses: { 200: { description: 'An HTML page.' } }, permissions: [], internal: STATUS_LINK },
  { method: 'GET', path: '/v1/status/:slug/unsubscribe', tag: 'Availability', summary: 'Unsubscribe from a status page',
    description: '(v1.43.0) The one-click link in every update e-mail.', pathParams: { slug: 'The page.' }, query: [{ name: 't', schema: { type: 'string' } }],
    responses: { 200: { description: 'An HTML page.' } }, permissions: [], internal: STATUS_LINK },

  // ------------------------------------------------------------------ SCIM settings
  { method: 'GET', path: '/v1/scim', tag: 'Users and roles', summary: 'SCIM provisioning settings',
    description: '(v1.43.0) enabled, the token\'s last four characters, the group → role map (empty: the SAML one is used), the endpoint (…/scim/v2) to give the identity provider, the roles a group may give, and how many users and groups it manages.',
    responses: { 200: { description: 'The settings.', schema: obj } } },
  { method: 'PUT', path: '/v1/scim', tag: 'Users and roles', summary: 'Change SCIM provisioning',
    description: '(v1.43.0) enabled, roleMap [{group, role}] (never an administrator or a site-limited role). A changed map is applied to every provisioned user at once. Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [422] },
  { method: 'POST', path: '/v1/scim/token', tag: 'Users and roles', summary: 'A new SCIM token',
    description: '(v1.43.0) Returns the token once (pscim_…) and the endpoint; only its hash is kept and the previous token stops working at once. Audited.',
    responses: { 200: { description: '{token, hint, endpoint}.', schema: obj } } },
];
