import { type Op, type Schema } from '../types.js';

/**
 * Phase 39 (v1.51.0): src/api/phase39-routes.ts. Advertising on charger and kiosk screens (Statements and billing;
 * screens under Sites), with the screens' player API (each screen's own key).
 */

const obj: Schema = { type: 'object' };
const id = (what: string) => ({ id: what });
const T = 'Statements and billing';
const xlsx = (d: string) => ({ description: d, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', schema: { type: 'string', format: 'binary' } as Schema });

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  { method: 'GET', path: '/v1/advertising/settings', tag: T, summary: 'Advertising settings', description: '(v1.51.0) On or off, the tax on advertising invoices (basis points) and the default slot length.',
    responses: { 200: { description: 'The settings.', schema: obj } } },
  { method: 'PUT', path: '/v1/advertising/settings', tag: T, summary: 'Change the advertising settings', description: '(v1.51.0) enabled, taxBps (0–5000), slotSeconds (5–120). Audited.',
    body: { required: true, schema: obj }, responses: { 200: { description: 'The settings.', schema: obj } }, errors: [422] },
  { method: 'GET', path: '/v1/advertisers', tag: T, summary: 'Advertisers', description: '(v1.51.0) Each advertiser with its campaigns (and active ones).', responses: { 200: { description: '{advertisers}.', schema: obj } } },
  { method: 'POST', path: '/v1/advertisers', tag: T, summary: 'Add an advertiser', description: '(v1.51.0) name, contactName, email, phone, taxId, address. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The advertiser.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/advertisers/:id', tag: T, summary: 'Change or archive an advertiser', description: '(v1.51.0) The fields above, or archive: true. Audited.', pathParams: id('The advertiser.'),
    body: { required: true, schema: obj }, responses: { 200: { description: 'The advertiser.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/ad-screens', tag: 'Sites', summary: 'Ad screens', description: '(v1.51.0) Each charger or kiosk screen: its site, charger, orientation, online (its player called within 30 minutes) and plays in 7 days.',
    responses: { 200: { description: '{screens}.', schema: obj } } },
  { method: 'POST', path: '/v1/ad-screens', tag: 'Sites', summary: 'Add an ad screen', description: '(v1.51.0) siteId, chargePointId (a charger\'s screen), name, kind (charger, kiosk), orientation. Its player\'s key is shown once. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The screen, with its key.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/ad-screens/:id', tag: 'Sites', summary: 'Change, re-key or archive an ad screen', description: '(v1.51.0) The fields above, status (active, off), rotateKey: true (shown once) or archive: true. Audited.',
    pathParams: id('The screen.'), body: { required: true, schema: obj }, responses: { 200: { description: 'The screen.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/ad-campaigns', tag: T, summary: 'Ad campaigns', description: '(v1.51.0) Campaigns (ended ones for 60 days; status=all: every one) with their plays, spend, creatives and those to review.',
    query: [{ name: 'status', schema: { type: 'string' } }], responses: { 200: { description: '{campaigns}.', schema: obj } } },
  { method: 'POST', path: '/v1/ad-campaigns', tag: T, summary: 'Add an ad campaign',
    description: '(v1.51.0) advertiserId, name, startsOn, endsOn, siteIds (empty: every site with a screen), pricing (cpm: per thousand plays; flat: per month, prorated), rateMinor, budgetMinor (CPM: stops once spent), weight (1–10, its share of the rotation). Starts as a draft. Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The campaign.', schema: obj } }, errors: [422] },
  { method: 'GET', path: '/v1/ad-campaigns/:id', tag: T, summary: 'An ad campaign', description: '(v1.51.0) With its creatives, plays by day and by site, and the charging sessions at its screens while it runs.',
    pathParams: id('The campaign.'), responses: { 200: { description: 'The campaign.', schema: obj } }, errors: [404] },
  { method: 'PUT', path: '/v1/ad-campaigns/:id', tag: T, summary: 'Change an ad campaign', description: '(v1.51.0) The fields above, while it has not ended. Audited.', pathParams: id('The campaign.'),
    body: { required: true, schema: obj }, responses: { 200: { description: 'The campaign.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'POST', path: '/v1/ad-campaigns/:id/status', tag: T, summary: 'Start, pause or end an ad campaign',
    description: '(v1.51.0) status: active (needs an approved creative, an end date not past and budget left), paused (reason), ended. Audited.', pathParams: id('The campaign.'),
    body: { required: true, schema: obj }, responses: { 200: { description: 'The campaign.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/ad-campaigns/:id/proof.xlsx', tag: T, summary: 'Proof of play', description: '(v1.51.0) Plays by day, site, screen and creative, as a spreadsheet.',
    pathParams: id('The campaign.'), responses: { 200: xlsx('An .xlsx file.') }, errors: [404] },
  { method: 'POST', path: '/v1/ad-campaigns/:id/creatives', tag: T, summary: 'Upload a creative',
    description: '(v1.51.0) dataUrl (a JPEG, PNG or WebP image, or an MP4 video, up to 30 MB; the content must match the type), name, seconds (3–120; default the slot), orientation. It plays once approved. Audited.',
    pathParams: id('The campaign.'), body: { required: true, schema: obj }, responses: { 201: { description: '{id, name, review}.', schema: obj } }, errors: [404, 409, 413, 422] },
  { method: 'GET', path: '/v1/ad-creatives/:id/file', tag: T, summary: 'A creative\'s file', description: '(v1.51.0) The image or video, to review it.', pathParams: id('The creative.'),
    responses: { 200: { description: 'The file.', contentType: 'application/octet-stream', schema: { type: 'string', format: 'binary' } } }, errors: [404] },
  { method: 'POST', path: '/v1/ad-creatives/:id/review', tag: T, summary: 'Approve or reject a creative', description: '(v1.51.0) review (approved, rejected), note (required to reject). Audited.',
    pathParams: id('The creative.'), body: { required: true, schema: obj }, responses: { 200: { description: '{id, review}.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/ad-creatives/:id/remove', tag: T, summary: 'Remove a creative', description: '(v1.51.0) It stops playing; its plays are kept. Audited.', pathParams: id('The creative.'),
    responses: { 200: { description: '{id, removed}.', schema: obj } }, errors: [404] },
  { method: 'GET', path: '/v1/ad-invoices', tag: T, summary: 'Advertising invoices', description: '(v1.51.0) Drafted, issued, paid and void invoices to advertisers.', responses: { 200: { description: '{invoices}.', schema: obj } } },
  { method: 'POST', path: '/v1/advertisers/:id/invoices', tag: T, summary: 'Draft an advertising invoice',
    description: '(v1.51.0) month: the advertiser\'s campaigns (CPM by plays, flat by the days run), the tax and the total; a draft is refreshed. Last month is drafted automatically.',
    pathParams: id('The advertiser.'), body: { required: true, schema: obj }, responses: { 200: { description: 'The invoice.', schema: obj } }, errors: [422] },
  { method: 'POST', path: '/v1/ad-invoices/:id', tag: T, summary: 'Issue, mark paid or void an advertising invoice',
    description: '(v1.51.0) action: issue (a draft for a month that is over; refreshed and numbered), paid (reference), void (not paid). Audited.', pathParams: id('The invoice.'),
    body: { required: true, schema: obj }, responses: { 200: { description: 'The invoice.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/ad-invoices/:id/invoice.xlsx', tag: T, summary: 'An advertising invoice as a spreadsheet', description: '(v1.51.0) Its lines, tax and total.', pathParams: id('The invoice.'),
    responses: { 200: xlsx('An .xlsx file.') }, errors: [404] },
  { method: 'GET', path: '/v1/ad-player/:key', tag: 'Sites', summary: 'A screen\'s playlist (the player\'s API)',
    description: '(v1.51.0) The approved creatives of the campaigns running today at the screen\'s site (its orientation first), with their seconds, weight and file URL; refresh every refreshSeconds. Authenticated by the screen\'s key in the path.',
    pathParams: { key: 'The screen\'s key.' }, responses: { 200: { description: '{screen, playlist, refreshSeconds}.', schema: obj } }, errors: [401], permissions: [] },
  { method: 'GET', path: '/v1/ad-player/:key/creatives/:id', tag: 'Sites', summary: 'A creative\'s file (the player\'s API)', description: '(v1.51.0) The image or video to play. Authenticated by the screen\'s key in the path.',
    pathParams: { key: 'The screen\'s key.', id: 'The creative.' }, responses: { 200: { description: 'The file.', contentType: 'application/octet-stream', schema: { type: 'string', format: 'binary' } } }, errors: [401, 404], permissions: [] },
  { method: 'POST', path: '/v1/ad-player/:key/plays', tag: 'Sites', summary: 'A screen reports its plays (the player\'s API)',
    description: '(v1.51.0) plays: [{creativeId, count (1–2000), day (today or yesterday, optional)}]: the proof of play counted for billing. Authenticated by the screen\'s key in the path.',
    pathParams: { key: 'The screen\'s key.' }, body: { required: true, schema: obj }, responses: { 200: { description: '{counted}.', schema: obj } }, errors: [401, 422], permissions: [] },
];
