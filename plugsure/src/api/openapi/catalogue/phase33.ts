import { type Op, type Schema } from '../types.js';

/**
 * Phase 33 (v1.45.0): src/api/phase33-routes.ts. The support case desk (Sessions), demand forecasting and site planning
 * (Sites), driver credit — gift cards, vouchers and referrals (Payments and refunds) — and vehicle telematics (Load
 * management).
 */

const obj: Schema = { type: 'object' };

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  // ------------------------------------------------------------------ the support desk
  { method: 'GET', path: '/v1/support/cases', tag: 'Sessions', summary: 'Support cases',
    description: '(v1.45.0) status (active — the default: new, open and pending — or one status), priority, category, assignee (me, none), breached, q (subject, customer, PS-number). Most urgent and soonest due first; at most 300. With counts (new, active, breached, unassigned, mine).',
    query: [{ name: 'status', schema: { type: 'string' } }, { name: 'priority', schema: { type: 'string' } }, { name: 'category', schema: { type: 'string' } }, { name: 'assignee', schema: { type: 'string' } }, { name: 'breached', schema: { type: 'string' } }, { name: 'q', schema: { type: 'string' } }],
    responses: { 200: { description: '{cases, counts}.', schema: obj } } },
  { method: 'POST', path: '/v1/support/cases', tag: 'Sessions', summary: 'Open a support case (staff)',
    description: '(v1.45.0) subject, body, category (charging, payment, refund, account, charger_fault, other), priority (low, normal, high, urgent; by default from the category), customerName, customerEmail, sessionId, chargePointId. Its first-answer and resolution times come from the priority\'s SLA. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The case.', schema: obj } }, errors: [422] },
  { method: 'GET', path: '/v1/support/cases/:id', tag: 'Sessions', summary: 'A support case',
    description: '(v1.45.0) The case, its messages (and the WhatsApp chat since it opened), the session it is about (energy, total, payment and refund state) and the customer\'s other cases.',
    pathParams: { id: 'The case.' }, responses: { 200: { description: 'The case.', schema: obj } }, errors: [404] },
  { method: 'PUT', path: '/v1/support/cases/:id', tag: 'Sessions', summary: 'Change a support case',
    description: '(v1.45.0) status (open, pending, resolved, closed), priority (moves the due times), category, assigneeId (null to unassign). Resolving it resolves its SLA alert. Audited.',
    pathParams: { id: 'The case.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The case.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/support/cases/:id/messages', tag: 'Sessions', summary: 'Reply to a support case, or add a note',
    description: '(v1.45.0) body, or macroId (its text, with {{name}}, {{number}}, {{charger}}, {{site}} filled in, and its status); internal: true for a note never sent; status. A reply goes out on the case\'s channel: e-mail (the operator\'s e-mail channel), WhatsApp (within its 24-hour window) or the app (with a push notification). Audited.',
    pathParams: { id: 'The case.' }, body: { required: true, schema: obj }, responses: { 201: { description: 'The case.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/support/macros', tag: 'Sessions', summary: 'Support macros', description: '(v1.45.0) Saved replies.', responses: { 200: { description: '{macros}.', schema: obj } } },
  { method: 'POST', path: '/v1/support/macros', tag: 'Sessions', summary: 'Add a support macro',
    description: '(v1.45.0) name, body ({{name}}, {{number}}, {{charger}}, {{site}}), category, setStatus (open, pending, resolved). Audited.', body: { required: true, schema: obj }, responses: { 201: { description: 'The macro.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/support/macros/:id', tag: 'Sessions', summary: 'Change or archive a support macro',
    description: '(v1.45.0) The fields above, or archive: true. Audited.', pathParams: { id: 'The macro.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The macro.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/support/settings', tag: 'Sessions', summary: 'Support desk settings',
    description: '(v1.45.0) enabled, the SLA per priority (minutes to the first answer and to resolution), autoAcknowledge (e-mail), the inbound key\'s prefix.', responses: { 200: { description: 'The settings.', schema: obj } } },
  { method: 'PUT', path: '/v1/support/settings', tag: 'Sessions', summary: 'Change the support desk settings',
    description: '(v1.45.0) enabled (drivers can report problems in the app; e-mail and WhatsApp open cases), sla {urgent|high|normal|low: {first, resolve}} in minutes, autoAcknowledge. Audited.', body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [422] },
  { method: 'POST', path: '/v1/support/settings/inbound-key', tag: 'Sessions', summary: 'A new key for inbound support e-mail',
    description: '(v1.45.0) The key for /v1/support/inbound-email/{key}, shown once; the old one stops working. Audited.', responses: { 200: { description: '{key, prefix}.', schema: obj } } },
  { method: 'GET', path: '/v1/support/stats', tag: 'Sessions', summary: 'Support desk figures',
    description: '(v1.45.0) Over days (default 30): opened, resolved, breached (and its share), the median first answer and resolution in minutes, satisfaction (1–5), by channel and by category.',
    query: [{ name: 'days', schema: { type: 'integer' } }], responses: { 200: { description: 'The figures.', schema: obj } } },
  { method: 'POST', path: '/v1/support/inbound-email/:key', tag: 'Sessions', summary: 'Inbound support e-mail (the e-mail provider)',
    description: '(v1.45.0) The operator\'s e-mail provider forwards what arrives at the support address: JSON {from, fromName, subject, text}. A subject carrying a case\'s [PS-n] from the case\'s own customer adds to it (and reopens it); anything else opens a case. Quoted earlier messages are cut. Authenticated by the key in the path.',
    pathParams: { key: 'The inbound key (Support → Settings).' }, body: { required: true, schema: obj }, responses: { 201: { description: '{caseId, ref, created}.', schema: obj } }, errors: [404, 409, 422], permissions: [] },

  // ------------------------------------------------------------------ demand and site planning
  { method: 'GET', path: '/v1/demand/sites', tag: 'Sites', summary: 'Demand by site',
    description: '(v1.45.0) Each site over the last 8 weeks: connectors, utilisation, the busiest hour and how busy it is, hours a week at 80 % or more, drivers turned away by the queue in 30 days, the trend, the next 7 days\' sessions and kWh, and advice (add_connectors with how many, under_used, ok, no_history).',
    responses: { 200: { description: '{sites, weeks, generatedAt}.', schema: obj } } },
  { method: 'GET', path: '/v1/demand/forecast', tag: 'Sites', summary: 'Hour-by-hour demand forecast',
    description: '(v1.45.0) siteId (default: every site together), days (1–14, default 7): the hour-of-week heatmap (occupancy, sessions, kWh) and the forecast for each coming hour (the profile × the trend).',
    query: [{ name: 'siteId', schema: { type: 'string', format: 'uuid' } }, { name: 'days', schema: { type: 'integer' } }], responses: { 200: { description: '{heatmap, forecast, totals}.', schema: obj } }, errors: [404] },
  { method: 'GET', path: '/v1/demand/candidates', tag: 'Sites', summary: 'Candidate sites, scored',
    description: '(v1.45.0) Each place being considered, scored 0–100 from nearby demand (50 %), the gap to the nearest site (30 %) and how busy the sites within 5 km are (20 %), with an estimate of sessions a day. Best first.',
    responses: { 200: { description: '{candidates, sites}.', schema: obj } } },
  { method: 'POST', path: '/v1/demand/candidates', tag: 'Sites', summary: 'Add a candidate site',
    description: '(v1.45.0) name, lat, lon, connectors (1–100), powerKw, status (idea, surveyed, approved, rejected), notes. Audited.', body: { required: true, schema: obj }, responses: { 201: { description: 'The candidate.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/demand/candidates/:id', tag: 'Sites', summary: 'Change or archive a candidate site',
    description: '(v1.45.0) The fields above, or archive: true. Audited.', pathParams: { id: 'The candidate.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The candidate.', schema: obj } }, errors: [404, 422] },

  // ------------------------------------------------------------------ driver credit
  { method: 'GET', path: '/v1/credit', tag: 'Payments and refunds', summary: 'Driver credit: overview',
    description: '(v1.45.0) The settings, credit outstanding (paid-for, promotional, held by charges), this month\'s movement, the gift card and voucher batches, and the latest referrals.',
    responses: { 200: { description: 'The overview.', schema: obj } } },
  { method: 'PUT', path: '/v1/credit/settings', tag: 'Payments and refunds', summary: 'Driver credit settings',
    description: '(v1.45.0) enabled, currency, expiryMonths (1–60), minGatewayMinor (what a charge paid partly with credit still pays through the gateway), referralEnabled, referrerRewardMinor, refereeRewardMinor, referralMinKwh (the new driver\'s first paid session), referralMonthlyCap. Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [422] },
  { method: 'POST', path: '/v1/credit/batches', tag: 'Payments and refunds', summary: 'Create gift cards or vouchers',
    description: '(v1.45.0) name, kind (gift: sold — priceMinor per card, at most its value, soldOn, buyer, cashAccountId; voucher: given away), currency, valueMinor, quantity (1–10,000), expiresOn. The codes are returned once, here. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: '{batch, codes}.', schema: obj } }, errors: [422] },
  { method: 'POST', path: '/v1/credit/batches/:id/void', tag: 'Payments and refunds', summary: 'Void a batch\'s unused codes',
    description: '(v1.45.0) Codes not redeemed yet stop working; credit already redeemed stays the drivers\'. Audited.', pathParams: { id: 'The batch.' }, responses: { 200: { description: '{id, voidedCards}.', schema: obj } }, errors: [404] },
  { method: 'POST', path: '/v1/credit/drivers/:driverId/adjust', tag: 'Payments and refunds', summary: 'Give or take back a driver\'s credit',
    description: '(v1.45.0) amountMinor (positive: goodwill credit; negative: takes back promotional credit only, never paid-for), note (required). Audited.',
    pathParams: { driverId: 'The app driver.' }, body: { required: true, schema: obj }, responses: { 201: { description: '{id, amountMinor}.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/finance/driver-credit', tag: 'Finance', summary: 'Driver credit: a month\'s movement',
    description: '(v1.45.0) month (YYYY-MM), currency: gift cards sold (price and value), credit redeemed and issued (vouchers, referrals, adjustments), used (paid-for and promotional) and expired. The ledger posts it (source driver_credit): 2260 gift card liability, 4110 charging paid with credit, 4160 breakage, 6450 promotions.',
    query: [{ name: 'month', schema: { type: 'string' } }, { name: 'currency', schema: { type: 'string' } }], responses: { 200: { description: 'The movement.', schema: obj } } },

  // ------------------------------------------------------------------ vehicle telematics
  { method: 'GET', path: '/v1/telematics/connections', tag: 'Load management', summary: 'Telematics connections and the latest readings',
    description: '(v1.45.0) Each connection (webhook or poll; its field map, last reading, last error, vehicles linked) and each vehicle\'s latest reading (state of charge, range, position, odometer; fresh when 30 minutes or newer).',
    responses: { 200: { description: '{connections, latest}.', schema: obj } } },
  { method: 'POST', path: '/v1/telematics/connections', tag: 'Load management', summary: 'Add a telematics connection',
    description: '(v1.45.0) name, kind (webhook: the platform posts to /v1/telematics/ingest/{key}, the key returned once; poll: url (https, public), authorization (kept sealed), pollMinutes 5–1440), fieldMap (dot paths: list, vehicleId, socPct, rangeKm, lat, lon, odometerKm, charging, at; socIsFraction "true" for 0–1). Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The connection (with key, once, for a webhook).', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/telematics/connections/:id', tag: 'Load management', summary: 'Change, re-key or archive a telematics connection',
    description: '(v1.45.0) The fields above, rotateKey: true (a webhook\'s new key, returned once), or archive: true (its vehicles are unlinked). Audited.', pathParams: { id: 'The connection.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The connection.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/telematics/connections/:id/poll', tag: 'Load management', summary: 'Poll a telematics connection now',
    description: '(v1.45.0) Reads the platform now (through the outbound guard: 15 s, 1 MB, no redirects).', pathParams: { id: 'The connection.' }, responses: { 200: { description: '{readings, stored, unknownVehicles}.', schema: obj } }, errors: [404, 409, 502] },
  { method: 'PUT', path: '/v1/fleet-vehicles/:id/telematics', tag: 'Load management', summary: 'Link a fleet vehicle to its telematics id',
    description: '(v1.45.0) connectionId and telematicsId (the vehicle\'s id on the platform, often its VIN); connectionId null to unlink. Audited.', pathParams: { id: 'The vehicle.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The link.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'POST', path: '/v1/telematics/ingest/:key', tag: 'Load management', summary: 'Send vehicle readings (telematics platform)',
    description: '(v1.45.0) One reading or a list, read with the connection\'s field map; each matched to a linked vehicle by its telematics id. Unknown vehicles are counted, not stored. Authenticated by the key in the path.',
    pathParams: { key: 'The connection\'s key.' }, body: { required: true, schema: obj }, responses: { 200: { description: '{readings, stored, unknownVehicles}.', schema: obj } }, errors: [404, 409], permissions: [] },
];
