import { type Op, type Schema } from '../types.js';

/**
 * Phase 35 (v1.47.0): src/api/phase35-routes.ts. Home charging reimbursement (Finance), card payment terminals
 * (Payments and refunds), energy market prices (Load management) and driver surveys (Sessions). The app's side of the
 * surveys is in the driver API (GET /d/v1/surveys/pending, POST /d/v1/surveys).
 */

const obj: Schema = { type: 'object' };
const bin = (contentType: string, description: string) => ({ description, contentType, schema: { type: 'string', format: 'binary' } as Schema });

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  // ------------------------------------------------------------------ home charging
  { method: 'GET', path: '/v1/home-chargers', tag: 'Finance', summary: 'Employees\' home chargers',
    description: '(v1.47.0) Each employee\'s home charger: OCPP (a charger PlugSure manages; its sessions, or only the employee\'s card\'s, count) or meter readings, the home electricity rate per kWh, the monthly cap, the last reading.',
    responses: { 200: { description: '{chargers}.', schema: obj } } },
  { method: 'POST', path: '/v1/home-chargers', tag: 'Finance', summary: 'Add an employee\'s home charger',
    description: '(v1.47.0) employeeName, employeeEmail, employeeRef (payroll number), address, mode (ocpp, readings), chargePointId and tokenId (ocpp), rateMinorPerKwh, monthlyCapMinor, currency. An OCPP home charger leaves the public map. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The home charger.', schema: obj } }, errors: [409, 422] },
  { method: 'PUT', path: '/v1/home-chargers/:id', tag: 'Finance', summary: 'Change or archive a home charger',
    description: '(v1.47.0) The fields above, or archive: true. Audited.', pathParams: { id: 'The home charger.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The home charger.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/home-chargers/:id/readings', tag: 'Finance', summary: 'A home meter\'s readings', description: '(v1.47.0) The latest 60.',
    pathParams: { id: 'The home charger.' }, responses: { 200: { description: '{readings}.', schema: obj } }, errors: [404] },
  { method: 'POST', path: '/v1/home-chargers/:id/readings', tag: 'Finance', summary: 'Add a meter reading',
    description: '(v1.47.0) readOn (YYYY-MM-DD), kwhTotal (the meter\'s counter; never below an earlier reading), note. One per day; a second replaces it.',
    pathParams: { id: 'The home charger.' }, body: { required: true, schema: obj }, responses: { 201: { description: '{readings}.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'POST', path: '/v1/home-chargers/:id/portal', tag: 'Finance', summary: 'A new link for the employee',
    description: '(v1.47.0) The employee\'s page at /home-charging/{token}, shown once; the old link stops working. Audited.', pathParams: { id: 'The home charger.' }, responses: { 200: { description: '{token, path}.', schema: obj } }, errors: [404, 409] },
  { method: 'GET', path: '/v1/home-reimbursements', tag: 'Finance', summary: 'Home charging reimbursements',
    description: '(v1.47.0) month (YYYY-MM), homeChargerId: each month\'s kWh, rate, amount (capped or not) and status (draft, approved, paid, void).',
    query: [{ name: 'month', schema: { type: 'string' } }, { name: 'homeChargerId', schema: { type: 'string' } }], responses: { 200: { description: '{reimbursements}.', schema: obj } } },
  { method: 'POST', path: '/v1/home-reimbursements', tag: 'Finance', summary: 'Draft a month\'s reimbursements',
    description: '(v1.47.0) month: for each active home charger, its kWh (sessions started in the month, or the month\'s last reading minus the one before it) × its rate, under the cap. Drafts are recalculated; approved and paid ones stay. Home chargers without the readings needed are listed. Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: '{month, drafted, missing, reimbursements}.', schema: obj } }, errors: [422] },
  { method: 'POST', path: '/v1/home-reimbursements/:id/:action', tag: 'Finance', summary: 'Approve, mark paid or void a reimbursement',
    description: '(v1.47.0) action: approve (needs finance:approve), paid, void. Audited.', pathParams: { id: 'The reimbursement.', action: 'approve, paid or void.' }, responses: { 200: { description: 'The reimbursement.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/home-reimbursements/payroll.csv', tag: 'Finance', summary: 'The payroll export',
    description: '(v1.47.0) month (default this month): the approved and paid reimbursements — payroll number, name, month, kWh, amount, currency, status.',
    query: [{ name: 'month', schema: { type: 'string' } }], responses: { 200: { description: 'CSV.', contentType: 'text/csv', schema: { type: 'string' } } } },
  { method: 'GET', path: '/v1/home-reimbursements.xlsx', tag: 'Finance', summary: 'A month\'s reimbursements as a spreadsheet',
    description: '(v1.47.0) month (default this month).', query: [{ name: 'month', schema: { type: 'string' } }],
    responses: { 200: bin('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'An .xlsx file.') } },
  { method: 'GET', path: '/v1/home-charging/:token', tag: 'Finance', summary: 'The employee\'s page (data)',
    description: '(v1.47.0) The employee\'s rate, this month\'s kWh so far, their readings and reimbursements. Authenticated by the link\'s token.',
    pathParams: { token: 'The employee\'s link token.' }, responses: { 200: { description: 'The page.', schema: obj } }, errors: [404], permissions: [] },
  { method: 'POST', path: '/v1/home-charging/:token', tag: 'Finance', summary: 'The employee: add a meter reading',
    description: '(v1.47.0) readOn, kwhTotal, note. Authenticated by the link\'s token; at most 10 an hour.',
    pathParams: { token: 'The employee\'s link token.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The page.', schema: obj } }, errors: [404, 409, 422, 429], permissions: [] },

  // ------------------------------------------------------------------ card terminals
  { method: 'GET', path: '/v1/terminals', tag: 'Payments and refunds', summary: 'Card payment terminals',
    description: '(v1.47.0) Each terminal (site, charger or kiosk, largest pre-authorisation, callback, last seen) and the last 30 days per day: pre-authorised, captured, voided, failed, open.',
    responses: { 200: { description: '{terminals, days}.', schema: obj } } },
  { method: 'POST', path: '/v1/terminals', tag: 'Payments and refunds', summary: 'Add a card payment terminal',
    description: '(v1.47.0) siteId, chargePointId (none: a kiosk for the site), name, serial, provider, maxPreauthMinor, callbackUrl (capture and void instructions are POSTed there, signed; none: the terminal polls), callbackSecret (kept sealed). The terminal\'s key is shown once. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The terminal, with its key.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/terminals/:id', tag: 'Payments and refunds', summary: 'Change, re-key or archive a terminal',
    description: '(v1.47.0) The fields above, enabled, rotateKey: true (a new key, shown once), or archive: true. Audited.', pathParams: { id: 'The terminal.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The terminal.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/terminal-payments', tag: 'Payments and refunds', summary: 'Card terminal payments',
    description: '(v1.47.0) status (preauth, charging, capture_due, void_due, captured, voided, failed), terminalId: each payment — card, pre-authorised and captured amounts, the session\'s kWh, settlement. Newest first; at most 500.',
    query: [{ name: 'status', schema: { type: 'string' } }, { name: 'terminalId', schema: { type: 'string' } }], responses: { 200: { description: '{payments}.', schema: obj } } },
  { method: 'POST', path: '/v1/terminal-payments/:id/retry', tag: 'Payments and refunds', summary: 'Send a failed capture or void again',
    description: '(v1.47.0) A failed payment\'s instruction is due again (the callback, or the terminal\'s next poll). Audited.', pathParams: { id: 'The payment.' }, responses: { 200: { description: 'The payment.', schema: obj } }, errors: [404, 409] },
  { method: 'POST', path: '/v1/terminal-settlements', tag: 'Payments and refunds', summary: 'Import the provider\'s settlement report',
    description: '(v1.47.0) csv (lines "reference,amount[,date]", amounts in minor units; a header is skipped), batch. Each line is matched to a capture: matched, mismatch or unknown. Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: '{batch, matched, mismatch, unknown, lines}.', schema: obj } }, errors: [413, 422] },
  { method: 'GET', path: '/v1/terminal-settlements/unsettled', tag: 'Payments and refunds', summary: 'Captures not settled yet',
    description: '(v1.47.0) Captures older than 3 days that no settlement report has listed.', responses: { 200: { description: '{payments}.', schema: obj } } },
  { method: 'POST', path: '/v1/terminals/events/:key', tag: 'Payments and refunds', summary: 'A card terminal\'s event (the terminal)',
    description: '(v1.47.0) type: preauth {reference, amountMinor, cardBrand, cardLast4, connectorId, and for a kiosk chargePointId or ocppIdentity} — the connector starts with a single-use guest card limited to the amount; answered {accepted, txnId, receiptUrl} (not accepted: void it); cancel {reference}; poll — the instructions waiting [{reference, action: capture | void, amountMinor}]; captured / voided / failed {reference, amountMinor?, error?}. Authenticated by the terminal\'s key in the path.',
    pathParams: { key: 'The terminal\'s key.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'Depends on the type.', schema: obj } }, errors: [404, 409, 422], permissions: [] },
  { method: 'GET', path: '/v1/terminal-receipts/:token', tag: 'Payments and refunds', summary: 'A card terminal receipt (data)',
    description: '(v1.47.0) The site, charger, card (last four), start and end, kWh, the amount paid or that the hold was released. Behind /terminal-receipt/{token}, the link the terminal shows.',
    pathParams: { token: 'The receipt\'s token.' }, responses: { 200: { description: 'The receipt.', schema: obj } }, errors: [404], permissions: [] },

  // ------------------------------------------------------------------ energy prices
  { method: 'GET', path: '/v1/energy-prices/zones', tag: 'Load management', summary: 'Energy price zones and sites',
    description: '(v1.47.0) Each zone (source: imported or fetched from an address; periods held, last fetch and error) and each site\'s zone and price shifting.', responses: { 200: { description: '{zones, sites}.', schema: obj } } },
  { method: 'POST', path: '/v1/energy-prices/zones', tag: 'Load management', summary: 'Add a price zone',
    description: '(v1.47.0) name, currency, source (manual, url), url (fetched every hour), authorization (an Authorization header, kept sealed). Audited.', body: { required: true, schema: obj }, responses: { 201: { description: 'The zone.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/energy-prices/zones/:id', tag: 'Load management', summary: 'Change or archive a price zone',
    description: '(v1.47.0) The fields above, or archive: true (its sites stop shifting). Audited.', pathParams: { id: 'The zone.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The zone.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/energy-prices/zones/:id/prices', tag: 'Load management', summary: 'Import prices',
    description: '(v1.47.0) prices [{start, price (per kWh, minor units), minutes (15, 30, 60)}] or csv "start,price[,minutes]" lines; a period already held is replaced. Prices per MWh: per: "MWh". Audited.',
    pathParams: { id: 'The zone.' }, body: { required: true, schema: obj }, responses: { 200: { description: '{stored, skipped}.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/energy-prices/zones/:id/fetch', tag: 'Load management', summary: 'Fetch a zone\'s prices now', description: '(v1.47.0) From its address.',
    pathParams: { id: 'The zone.' }, responses: { 200: { description: '{stored, skipped}.', schema: obj } }, errors: [404, 409, 502] },
  { method: 'GET', path: '/v1/energy-prices/zones/:id/day', tag: 'Load management', summary: 'A zone\'s prices for a day',
    description: '(v1.47.0) date (default today, local): each period\'s price, whether it is expensive (the day\'s most expensive quarter), min, max, average.',
    pathParams: { id: 'The zone.' }, query: [{ name: 'date', schema: { type: 'string', format: 'date' } }], responses: { 200: { description: 'The day.', schema: obj } }, errors: [404] },
  { method: 'PUT', path: '/v1/sites/:siteId/energy-prices', tag: 'Load management', summary: 'A site\'s price zone and shifting',
    description: '(v1.47.0) zoneId, shift (in an expensive period the load manager gives the site only capPct % of its grid budget; departures still get what they need), capPct (0–100, default 50), thresholdMinor (expensive at or above this price; empty: the day\'s most expensive quarter). Audited.',
    pathParams: { siteId: 'The site.' }, body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/energy-prices/savings', tag: 'Load management', summary: 'What charging at the hourly prices cost',
    description: '(v1.47.0) month (default this month): per site on a zone, the energy each hour × that hour\'s price, against the same energy at the month\'s average price — the saving from when cars charged.',
    query: [{ name: 'month', schema: { type: 'string' } }], responses: { 200: { description: '{month, sites}.', schema: obj } } },

  // ------------------------------------------------------------------ surveys
  { method: 'GET', path: '/v1/surveys/settings', tag: 'Sessions', summary: 'Driver survey settings',
    description: '(v1.47.0) enabled, question, samplePct (the share of charges asked), minGapDays (per driver), caseOnLow (a detractor\'s comment opens a support case).', responses: { 200: { description: 'The settings.', schema: obj } } },
  { method: 'PUT', path: '/v1/surveys/settings', tag: 'Sessions', summary: 'Change the driver survey settings', description: '(v1.47.0) The fields above. Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [422] },
  { method: 'GET', path: '/v1/surveys/nps', tag: 'Sessions', summary: 'NPS',
    description: '(v1.47.0) days (default 90): NPS (% promoters 9–10 − % detractors 0–6), responses, overall, per site, per charger and per week; the tags drivers chose; the scores\' distribution.',
    query: [{ name: 'days', schema: { type: 'integer' } }], responses: { 200: { description: 'The figures.', schema: obj } } },
  { method: 'GET', path: '/v1/surveys/responses', tag: 'Sessions', summary: 'Survey responses',
    description: '(v1.47.0) band (detractor, passive, promoter), withComment, siteId: the latest 300, with the support case a comment opened.',
    query: [{ name: 'band', schema: { type: 'string' } }, { name: 'withComment', schema: { type: 'string' } }, { name: 'siteId', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: '{responses}.', schema: obj } } },
];
