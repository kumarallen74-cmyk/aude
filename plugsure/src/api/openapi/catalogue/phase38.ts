import { type Op, type Schema } from '../types.js';

/**
 * Phase 38 (v1.50.0): src/api/phase38-routes.ts. EV dealer partnerships (Statements and billing), with the dealer's
 * portal (its own link). A buyer redeems the welcome code in the app like any voucher (POST /d/v1/credit/redeem).
 */

const obj: Schema = { type: 'object' };
const id = (what: string) => ({ id: what });

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  { method: 'GET', path: '/v1/dealers', tag: 'Statements and billing', summary: 'Car dealers',
    description: '(v1.50.0) Each dealer: the welcome credit its buyers get and who pays for it, the commission on their charging, its portal link, cars sold (30 days, all), codes redeemed and pending. archived=true: also the archived ones.',
    query: [{ name: 'archived', schema: { type: 'string' } }], responses: { 200: { description: '{dealers}.', schema: obj } } },
  { method: 'POST', path: '/v1/dealers', tag: 'Statements and billing', summary: 'Add a car dealer',
    description: '(v1.50.0) name, make, branch, contactName, email, phone, welcomeMinor, codeDays (7–365), funding (dealer: billed for redeemed credit; operator), commissionBps (0–5000), commissionMonths (1–60). Audited.',
    body: { required: true, schema: obj }, responses: { 201: { description: 'The dealer.', schema: obj } }, errors: [422] },
  { method: 'PUT', path: '/v1/dealers/:id', tag: 'Statements and billing', summary: 'Change or archive a car dealer',
    description: '(v1.50.0) The fields above (new sales take the new terms), or archive: true (its portal link stops). Audited.', pathParams: id('The dealer.'),
    body: { required: true, schema: obj }, responses: { 200: { description: 'The dealer.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/dealers/:id/portal', tag: 'Statements and billing', summary: 'A new dealer portal link',
    description: '(v1.50.0) The dealer\'s page at /dealer/{token}, shown once; the old link stops working. Audited.', pathParams: id('The dealer.'),
    responses: { 200: { description: '{token, path}.', schema: obj } }, errors: [404] },
  { method: 'GET', path: '/v1/dealer-sales', tag: 'Statements and billing', summary: 'Cars sold by dealers',
    description: '(v1.50.0) Each sale: the buyer (phone by its last digits), the car, the welcome code\'s last four, pending, redeemed, expired or void. dealerId and month (YYYY-MM) filter.',
    query: [{ name: 'dealerId', schema: { type: 'string' } }, { name: 'month', schema: { type: 'string' } }], responses: { 200: { description: '{sales}.', schema: obj } } },
  { method: 'POST', path: '/v1/dealers/:id/sales', tag: 'Statements and billing', summary: 'Register a car sold',
    description: '(v1.50.0) buyerName, buyerPhone (only that number can redeem the code), vehicle, vin (one sale per VIN), plate, soldOn. The welcome code is in the answer this once. Audited.',
    pathParams: id('The dealer.'), body: { required: true, schema: obj }, responses: { 201: { description: 'The sale, with its code.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'POST', path: '/v1/dealer-sales/:id/void', tag: 'Statements and billing', summary: 'Void a sale', description: '(v1.50.0) Only while its code is not redeemed; the code stops working. Audited.',
    pathParams: id('The sale.'), responses: { 200: { description: '{id, voided}.', schema: obj } }, errors: [409] },
  { method: 'GET', path: '/v1/dealers/:id/preview', tag: 'Statements and billing', summary: 'A dealer\'s month so far',
    description: '(v1.50.0) month (default this month): cars sold, codes redeemed and their credit, billed to the dealer, its buyers\' charging before tax, the commission and the net.',
    pathParams: id('The dealer.'), query: [{ name: 'month', schema: { type: 'string' } }], responses: { 200: { description: 'The figures.', schema: obj } }, errors: [404, 422] },
  { method: 'GET', path: '/v1/dealer-statements', tag: 'Statements and billing', summary: 'Dealer statements', description: '(v1.50.0) Drafted, issued and settled statements; dealerId filters.',
    query: [{ name: 'dealerId', schema: { type: 'string' } }], responses: { 200: { description: '{statements}.', schema: obj } } },
  { method: 'POST', path: '/v1/dealers/:id/statements', tag: 'Statements and billing', summary: 'Draft a dealer statement',
    description: '(v1.50.0) month: drafted, or its draft refreshed (an issued one is not changed). Last month is drafted automatically.', pathParams: id('The dealer.'),
    body: { required: true, schema: obj }, responses: { 200: { description: 'The statement.', schema: obj } }, errors: [404, 422] },
  { method: 'POST', path: '/v1/dealer-statements/:id', tag: 'Statements and billing', summary: 'Issue or settle a dealer statement',
    description: '(v1.50.0) action: refresh (a draft), issue (a draft for a month that is over; refreshed first), settle (an issued one; reference required). Audited.', pathParams: id('The statement.'),
    body: { required: true, schema: obj }, responses: { 200: { description: 'The statement.', schema: obj } }, errors: [404, 409, 422] },
  { method: 'GET', path: '/v1/dealer-statements/:id/statement.xlsx', tag: 'Statements and billing', summary: 'A dealer statement as a spreadsheet', description: '(v1.50.0) The figures and the month\'s sales.',
    pathParams: id('The statement.'), responses: { 200: { description: 'An .xlsx file.', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', schema: { type: 'string', format: 'binary' } } }, errors: [404] },
  { method: 'GET', path: '/v1/dealer-portal/:token', tag: 'Statements and billing', summary: 'The dealer\'s portal',
    description: '(v1.50.0) The dealer\'s terms, this month so far, its sales and its issued statements. Authenticated by the link\'s token.', pathParams: { token: 'The portal link token.' },
    responses: { 200: { description: 'The portal.', schema: obj } }, errors: [404], permissions: [] },
  { method: 'POST', path: '/v1/dealer-portal/:token/sales', tag: 'Statements and billing', summary: 'The dealer registers a car sold',
    description: '(v1.50.0) As POST /v1/dealers/{id}/sales, from the dealer\'s portal. The welcome code is in the answer this once. Authenticated by the link\'s token.', pathParams: { token: 'The portal link token.' },
    body: { required: true, schema: obj }, responses: { 201: { description: 'The sale, with its code.', schema: obj } }, errors: [404, 409, 422], permissions: [] },
];
