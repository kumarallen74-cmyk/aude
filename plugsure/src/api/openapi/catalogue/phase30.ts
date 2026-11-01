import { type Op, type Schema } from '../types.js';

/**
 * Phase 30 (v1.42.0): src/api/phase30-routes.ts. On-site solar and batteries (Load management), charger health
 * (Availability), the custom report builder (Reports) and SAML single sign-on (Users and roles; the browser legs and the
 * identity provider's post are console plumbing, internal).
 */

const obj: Schema = { type: 'object' };
const SAML_INTERNAL = 'console sign-in; browser navigation and the identity provider\'s form post, API keys do not use it';
const SPEC = 'The report: `columns` [{field, agg?, bucket?}], `filters` [{field, op, value, value2?}], `groupBy` [{field, bucket?}], `sort` {index, dir}, `limit` (≤ 5000), `chart` {type: bar|line, x, y}. Fields, operators and aggregations come from GET /v1/reports/builder.';

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  // ------------------------------------------------------------------ solar and battery
  { method: 'GET', path: '/v1/energy', tag: 'Load management', summary: 'Solar and battery sites',
    description: '(v1.42.0) Each site with on-site solar or a battery: its assets and settings, the latest reading, what the load manager counts now (the grid part, held at the peak-shaving target, plus only measured, recent solar and battery discharge at the trust share) and the battery\'s set-point.',
    responses: { 200: { description: 'Sites.', schema: obj } } },
  { method: 'GET', path: '/v1/energy/sites/:siteId/results', tag: 'Load management', summary: 'Solar and battery results',
    description: '(v1.42.0) Over a period (from, to; 30 days by default, at most 400): solar produced and used on site (self-consumption), export, grid import, the battery\'s charge (from solar or the grid) and discharge, the grid peak against the peak without the battery, and the savings at the site\'s electricity tariff; day by day too.',
    pathParams: { siteId: 'The site.' }, query: [{ name: 'from', schema: { type: 'string', format: 'date' } }, { name: 'to', schema: { type: 'string', format: 'date' } }],
    responses: { 200: { description: 'Results.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/energy/assets', tag: 'Load management', summary: 'Add a solar array or battery',
    description: '(v1.42.0) siteId, kind (solar | battery), name, capacityKw (the inverter\'s AC kW, or the battery\'s kW), peakKwp (solar), energyKwh, minSocPct, maxSocPct (battery), commissionedOn, costMinor, note. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The asset.', schema: obj } }, errors: [404, 422] },
  { method: 'PUT', path: '/v1/energy/assets/:id', tag: 'Load management', summary: 'Change or archive a solar array or battery',
    description: '(v1.42.0) The fields above, or archive: true. Audited.', pathParams: { id: 'The asset.' },
    body: { required: true, schema: obj }, responses: { 200: { description: 'The asset.', schema: obj } }, errors: [404, 422] },
  { method: 'PUT', path: '/v1/energy/sites/:siteId/settings', tag: 'Load management', summary: 'Solar-first, peak shaving and trust',
    description: '(v1.42.0) solarFirst, peakShaving with peakTargetKw (the grid power to keep under), trustPct (the share of measured output the load manager may count, 80 by default) and maxAgeS (readings older are not counted, 120 by default). Audited.',
    pathParams: { siteId: 'The site.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/energy/sites/:siteId/key', tag: 'Load management', summary: 'A new key for the site\'s energy box',
    description: '(v1.42.0) Returns the key once (pse_…); only its hash is kept and the previous key stops working. Audited.', pathParams: { siteId: 'The site.' },
    responses: { 200: { description: '{key, hint}.', schema: obj } }, errors: [404] },
  { method: 'POST', path: '/v1/energy/sites/:siteId/readings', tag: 'Load management', summary: 'Post solar, battery and grid readings',
    description: '(v1.42.0) For the site\'s inverter, EMS or gateway: Authorization: Bearer <site key> (or x-site-key). One reading or {readings: [...]} (≤ 500): ts, solarW, batteryW (+ discharging), batterySocPct, gridW (+ import). A reading already kept is ignored. The answer carries the battery\'s set-point for the next interval (batteryW: + discharge, − charge). At most 120 posts a minute per site.',
    pathParams: { siteId: 'The site.' }, body: { required: true, schema: obj }, responses: { 200: { description: '{accepted, duplicates, setpoint}.', schema: obj } }, errors: [401, 422, 429], permissions: [] },

  // ------------------------------------------------------------------ charger health
  { method: 'GET', path: '/v1/charger-health', tag: 'Availability', summary: 'Charger health',
    description: '(v1.42.0) Every charger\'s health over 30 days, worst first: the score (100 less outages, faults, reboots, failed starts and a fault now), the risk (ok, watch, at_risk) with its reasons, the score 7 and 30 days ago, and open work orders. Filter by risk or siteId.',
    query: [{ name: 'risk', schema: { type: 'string', enum: ['ok', 'watch', 'at_risk'] } }, { name: 'siteId', schema: { type: 'string', format: 'uuid' } }],
    responses: { 200: { description: 'Chargers and a summary.', schema: obj } } },
  { method: 'GET', path: '/v1/charger-health/:cpId', tag: 'Availability', summary: 'One charger\'s health',
    description: '(v1.42.0) Its parts (outages and hours offline, faults by code, reboots, failed starts, a fault now), the score, the risk and reasons, and the daily history (90 days).', pathParams: { cpId: 'The charge point.' },
    responses: { 200: { description: 'The charger.', schema: obj } }, errors: [404] },
  { method: 'POST', path: '/v1/charger-health/:cpId/work-order', tag: 'Availability', summary: 'Open a work order from charger health',
    description: '(v1.42.0) A corrective work order for the charger carrying its health reasons. Needs charge_point:write or payment:write. Audited.', pathParams: { cpId: 'The charge point.' },
    responses: { 201: { description: 'The work order.', schema: obj } }, errors: [404, 422], permissions: ['charge_point:write'] },
  { method: 'POST', path: '/v1/charger-health/run', tag: 'Availability', summary: 'Score the chargers now',
    description: '(v1.42.0) What the daily run does, for this organisation now: keep each charger\'s day, raise charger.health_at_risk or resolve it.',
    responses: { 200: { description: '{chargers, alerts}.', schema: obj } } },

  // ------------------------------------------------------------------ the report builder
  { method: 'GET', path: '/v1/reports/builder', tag: 'Reports', summary: 'Report builder catalogue',
    description: '(v1.42.0) The datasets this user may report on (sessions, chargers, outages, work orders, ledger lines), their fields and types, the aggregations, filter operators and date buckets.',
    responses: { 200: { description: 'The catalogue.', schema: obj } }, permissions: ['session:read'] },
  { method: 'POST', path: '/v1/reports/builder/run', tag: 'Reports', summary: 'Run a report',
    description: `(v1.42.0) dataset and spec. ${SPEC} format=xlsx for Excel. Each dataset needs its permission (sessions session:read, chargers and outages charge_point:read, work orders and the ledger payment:read).`,
    query: [{ name: 'format', schema: { type: 'string', enum: ['xlsx'] } }], body: { required: true, schema: obj }, responses: { 200: { description: 'Headers and rows (truncated when over the limit).', schema: obj } }, errors: [403, 422], permissions: ['session:read'] },
  { method: 'GET', path: '/v1/reports/saved', tag: 'Reports', summary: 'Saved reports', description: '(v1.42.0) The organisation\'s saved reports on datasets this user may read.',
    responses: { 200: { description: 'Reports.', schema: obj } }, permissions: ['session:read'] },
  { method: 'GET', path: '/v1/reports/saved/:id', tag: 'Reports', summary: 'A saved report', pathParams: { id: 'The report.' },
    responses: { 200: { description: 'The report.', schema: obj } }, errors: [404], permissions: ['session:read'] },
  { method: 'POST', path: '/v1/reports/saved', tag: 'Reports', summary: 'Save a report',
    description: `(v1.42.0) name, dataset, spec; optionally an e-mail schedule: frequency (daily, weekly with weekday 1–7, monthly), recipients (1–10). ${SPEC} A scheduled report is sent with the saver's organisation-wide permissions. Audited.`,
    body: { required: true, schema: obj }, responses: { 201: { description: 'The report.', schema: obj } }, errors: [403, 422], permissions: ['session:read'] },
  { method: 'PUT', path: '/v1/reports/saved/:id', tag: 'Reports', summary: 'Change or archive a saved report', description: '(v1.42.0) As saving, or archive: true. Audited.',
    pathParams: { id: 'The report.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The report.', schema: obj } }, errors: [403, 404, 422], permissions: ['session:read'] },
  { method: 'GET', path: '/v1/reports/saved/:id/run', tag: 'Reports', summary: 'Run a saved report', description: '(v1.42.0) Its rows now; format=xlsx for Excel.',
    pathParams: { id: 'The report.' }, query: [{ name: 'format', schema: { type: 'string', enum: ['xlsx'] } }], responses: { 200: { description: 'The report and its rows.', schema: obj } }, errors: [403, 404], permissions: ['session:read'] },
  { method: 'POST', path: '/v1/reports/saved/:id/send', tag: 'Reports', summary: 'E-mail a saved report now', description: '(v1.42.0) To its recipients, Excel attached, through the organisation\'s e-mail channel. Audited.',
    pathParams: { id: 'The report.' }, responses: { 200: { description: '{ok, to, rows}.', schema: obj } }, errors: [404, 409, 422, 502], permissions: ['session:read'] },

  // ------------------------------------------------------------------ SAML single sign-on
  { method: 'GET', path: '/v1/auth/saml', tag: 'Users and roles', summary: 'SAML single sign-on set-up',
    description: '(v1.42.0) The organisation\'s identity provider (entity id, sign-on URL, its certificates summarised, allowed domains, automatic set-up, the group → role map), what to enter at the identity provider (entity id, ACS URL, metadata) and the roles a group may map to (never an administrator role).',
    responses: { 200: { description: 'The set-up.', schema: obj } } },
  { method: 'PUT', path: '/v1/auth/saml', tag: 'Users and roles', summary: 'Set up SAML single sign-on',
    description: '(v1.42.0) enabled, idpEntityId, ssoUrl (https, HTTP-Redirect), certificates (1–3 PEM, the identity provider\'s signing certificates), allowedDomains (one organisation per domain), jitEnabled (automatic account set-up: needs a mapping), groupAttribute, roleMap [{group, role}]. Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: 'The set-up.', schema: obj } }, errors: [409, 422] },
  { method: 'GET', path: '/v1/auth/saml/start', tag: 'Console session', summary: 'Start a SAML sign-in',
    description: 'The sign-in page navigates here with the work e-mail; 303 to the identity provider (HTTP-Redirect AuthnRequest) with a short-lived browser-binding cookie, or back to the console with `?sso=<reason>`.',
    query: [{ name: 'email', schema: { type: 'string' } }], responses: { 303: { description: 'To the identity provider, or back with ?sso=.' } }, permissions: [], internal: SAML_INTERNAL },
  { method: 'POST', path: '/v1/auth/saml/:orgId/acs', tag: 'Console session', summary: 'SAML assertion consumer service',
    description: 'The identity provider posts SAMLResponse and RelayState (HTTP-POST binding). Verified against the sign-in in flight; answers a page that continues to /v1/auth/saml/finish.',
    pathParams: { orgId: 'The organisation.' }, body: { schema: obj, contentType: 'application/x-www-form-urlencoded' }, responses: { 200: { description: 'A continue page.' }, 303: { description: 'Back to the console with ?sso=<reason>.' } }, permissions: [], internal: SAML_INTERNAL },
  { method: 'GET', path: '/v1/auth/saml/finish', tag: 'Console session', summary: 'Finish a SAML sign-in',
    description: 'With the browser-binding cookie: the console session, then 303 to the console (or ?sso=<reason>).', query: [{ name: 'h', schema: { type: 'string' } }],
    responses: { 303: { description: 'To the console.' } }, permissions: [], internal: SAML_INTERNAL },
  { method: 'GET', path: '/v1/auth/saml/:orgId/metadata', tag: 'Console session', summary: 'SAML service-provider metadata',
    description: 'For the identity provider\'s set-up: the entity id, the ACS URL (HTTP-POST) and the NameID format.', pathParams: { orgId: 'The organisation.' },
    responses: { 200: { description: 'SAML metadata (XML).' } }, errors: [404], permissions: [], internal: SAML_INTERNAL },
];
