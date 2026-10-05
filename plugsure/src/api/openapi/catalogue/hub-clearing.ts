import { type Op, type Schema } from '../types.js';

/**
 * PlugSure Hub clearing and settlement (WP H2, docs/HUB-DESIGN.md "H2 as built"). Internal (not in the
 * published document) until WP H3 publishes the hub: the platform administration routes under
 * /v1/hub/clearing/* and a member's own view under /v1/roaming/hub/clearing/*. Every route answers 404 while
 * HUB_ENABLED is false. Amounts are integers in minor units of the row's currency (IDR rupiah, MYR sen, SGD
 * cents); DATE fields are 'YYYY-MM-DD'.
 */

const PA = 'Platform administration' as const;
const INTERNAL = 'platform administration (PlugSure Hub clearing)';
const S: Schema = { type: 'string' };
const I: Schema = { type: 'integer' };
const B: Schema = { type: 'boolean' };
const UUID: Schema = { type: 'string', format: 'uuid' };
const OBJ: Schema = { type: 'object' };
const NI: Schema = { type: ['integer', 'null'] };
const NS: Schema = { type: ['string', 'null'] };
const list = (key: string, items: Schema = OBJ): Schema => ({ type: 'object', required: [key], properties: { [key]: { type: 'array', items } } });
const one = (key: string, s: Schema = OBJ): Schema => ({ type: 'object', required: [key], properties: { [key]: s } });
const CUR: Schema = { enum: ['IDR', 'MYR', 'SGD'] };
const REASON: Schema = { enum: ['unknown_token', 'not_authorized', 'duplicate', 'amount', 'energy', 'tariff_mismatch', 'session_not_found', 'other'] };

const cdr: Schema = {
  type: 'object',
  description: 'A ledger row: one per (CPO party, CDR id), pushed or pulled through the hub.',
  properties: {
    id: UUID, cdr_id: S, session_id: NS, credit: B, credit_reference_id: NS, credits_cdr_id: NS, credited_by_cdr_id: NS, currency: S,
    total_excl_minor: I, total_incl_minor: NI, energy_kwh: { type: 'number' }, start_at: S, end_at: S, cpo: S, emsp: S,
    status: { enum: ['held', 'pending', 'disputed', 'accepted', 'credited', 'written_off', 'void'] }, flags: { type: 'array', items: S },
    dispute_deadline: S, accepted_at: NS, forward_state: { enum: ['pending', 'delivered', 'failed', 'not_needed'] }, fee_cpo_minor: NI, fee_emsp_minor: NI,
    settlement_run_id: NS, hold_note: NS, source: { enum: ['push', 'pull'] }, received_at: S, agreement_id: NS, cpo_member_id: UUID, emsp_member_id: UUID,
    cpo_member_name: NS, emsp_member_name: NS, dispute_id: NS,
  },
};
const cdrPage: Schema = { type: 'object', required: ['cdrs'], properties: { cdrs: { type: 'array', items: cdr }, next_cursor: NS } };
const dispute: Schema = {
  type: 'object',
  properties: {
    id: UUID, hub_cdr_id: UUID, cdr_id: S, raised_by: { enum: ['emsp', 'platform'] },
    reason: REASON,
    currency: S, claimed_minor: NI, message: S, status: { enum: ['open', 'accepted', 'rejected', 'escalated', 'credited', 'expired', 'resolved', 'withdrawn'] },
    resolution: { type: ['string', 'null'], enum: ['credited', 'upheld', 'written_off', null] }, respond_by: S, credit_due_by: NS, escalate_by: NS, credit_cdr_id: NS,
  },
};
const disputeDetail: Schema = { type: 'object', required: ['dispute', 'notes'], properties: { dispute, notes: { type: 'array', items: OBJ } } };
const feePlan: Schema = {
  type: 'object',
  description: 'TODO(commercial): the seeded default plans are 0 (placeholders).',
  properties: {
    id: UUID, name: S, currency: S, cpo_bps: I, cpo_fixed_minor: I, cpo_min_minor: I, cpo_max_minor: NI, emsp_bps: I, emsp_fixed_minor: I, emsp_min_minor: I,
    emsp_max_minor: NI, is_default: B, effective_from: S, notes: NS,
  },
};
const feePlanBody: Schema = {
  type: 'object',
  properties: {
    name: S, currency: CUR, cpo_bps: { type: 'integer', minimum: 0, maximum: 5000 }, cpo_fixed_minor: I, cpo_min_minor: I, cpo_max_minor: NI,
    emsp_bps: { type: 'integer', minimum: 0, maximum: 5000 }, emsp_fixed_minor: I, emsp_min_minor: I, emsp_max_minor: NI, is_default: B, effective_from: S, notes: S,
  },
};
const run: Schema = {
  type: 'object',
  properties: {
    id: UUID, currency: S, cycle: { enum: ['monthly', 'weekly'] }, period: S, time_zone: S, period_start: S, period_end: S, finalisable_at: S,
    status: { enum: ['draft', 'finalised', 'void'] }, preview: OBJ, totals: OBJ,
  },
};
const position: Schema = {
  type: 'object',
  properties: {
    id: UUID, run_id: UUID, currency: S, member_a_id: UUID, member_b_id: UUID, a_owes_b_minor: I, b_owes_a_minor: I, net_minor: I, payer_member_id: NS,
    payee_member_id: NS, cdr_count: I, paid_minor: I, outstanding_minor: I, status: { enum: ['open', 'partially_paid', 'paid', 'confirmed', 'overdue', 'written_off', 'nothing_due'] },
    due_date: S, overdue_since: NS, period: NS,
  },
};
const payment: Schema = {
  type: 'object',
  properties: { id: UUID, position_id: UUID, payer_member_id: UUID, payee_member_id: UUID, currency: S, amount_minor: I, method: S, reference: NS, paid_at: S, recorded_side: S, confirmed_by_payee_at: NS },
};
const paymentResult: Schema = { type: 'object', required: ['payment', 'position'], properties: { payment, position } };
const paymentBody: Schema = {
  type: 'object', required: ['position_id', 'amount_minor', 'paid_at', 'reference'],
  properties: { position_id: UUID, amount_minor: { type: 'integer', minimum: 1 }, paid_at: S, reference: S, method: { enum: ['bank_transfer', 'stripe_connect', 'xendit', 'other'] }, note: S },
};
const statement: Schema = {
  type: 'object',
  properties: {
    id: UUID, run_id: UUID, member_id: UUID, currency: S, period: S, number: S, receivable_minor: I, payable_minor: I, net_minor: I, fee_net_minor: I,
    fee_invoice_id: NS, cdr_count: I, issued_at: S, data: OBJ,
  },
};
const invoice: Schema = {
  type: 'object',
  properties: {
    id: UUID, member_id: UUID, entity_country: S, run_id: NS, currency: S, number: S, net_minor: I, tax_scheme: { enum: ['ID_PPN', 'SG_GST', 'MY_SST', 'NONE', 'REVERSE_CHARGE'] },
    tax_rate_bps: I, tax_base_minor: I, tax_minor: I, total_minor: I, wht_expected_minor: I, status: { enum: ['issued', 'paid', 'void'] }, due_date: S, paid_at: NS, data: OBJ,
  },
};
const note: Schema = { type: 'object', properties: { note: S } };
const html = { 200: { description: 'Printable HTML', contentType: 'text/html', schema: S } };
const pdf = { 200: { description: 'PDF', contentType: 'application/pdf', schema: { type: 'string', format: 'binary' } } };
const csv = { 200: { description: 'CSV (amounts in minor units)', contentType: 'text/csv', schema: S } };
const cdrQuery = [
  { name: 'status', schema: S, description: 'one or more, comma-separated' }, { name: 'flag', schema: S }, { name: 'currency', schema: S },
  { name: 'cpo_member', schema: UUID }, { name: 'emsp_member', schema: UUID }, { name: 'member', schema: UUID }, { name: 'agreement', schema: UUID },
  { name: 'run', schema: UUID }, { name: 'unsettled', schema: B }, { name: 'from', schema: S }, { name: 'to', schema: S }, { name: 'q', schema: S, description: 'CDR or session id contains' },
  { name: 'cursor', schema: S, description: 'next_cursor of the previous page' }, { name: 'limit', schema: I },
];

const pa = (o: Omit<Op, 'tag' | 'internal'>): Op => ({ tag: PA, internal: INTERNAL, permissions: ['platform:admin'], ...o });
// Published (v1.8.0): a member's own clearing view, for its console and its own systems (API keys with roaming:*).
const mb = (o: Omit<Op, 'tag' | 'internal'>, perm: 'roaming:read' | 'roaming:write' = 'roaming:read'): Op => ({ tag: 'Roaming', permissions: [perm], ...o });

export const schemas: Record<string, Schema> = {};

export const ops: Op[] = [
  // ── platform
  pa({ method: 'GET', path: '/v1/hub/clearing/overview', summary: 'Clearing overview', description: 'Ledger by currency and status, held flags, disputes, recent runs, outstanding positions, fee invoices.', responses: { 200: { description: 'Overview', schema: OBJ } } }),
  pa({ method: 'GET', path: '/v1/hub/clearing/cdrs', summary: 'The clearing ledger', description: 'Newest first, keyset-paged (next_cursor).', query: cdrQuery, responses: { 200: { description: 'CDRs', schema: cdrPage } }, errors: [400] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/cdrs.csv', summary: 'Export the ledger (CSV)', query: cdrQuery, responses: csv }),
  pa({ method: 'GET', path: '/v1/hub/clearing/cdrs/:id', summary: 'A ledger row', description: 'With the CDR as routed (body), routing ids, its disputes and its credit links.', responses: { 200: { description: 'CDR', schema: { type: 'object', required: ['cdr', 'disputes', 'related'], properties: { cdr, disputes: { type: 'array', items: dispute }, related: { type: 'array', items: OBJ } } } } }, errors: [404] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/cdrs/:id/release', summary: 'Release a held CDR', description: 'pending with a fresh dispute window; a held credit CDR is paired with its original (partial credits allowed).', body: { schema: { type: 'object', required: ['note'], properties: { note: S } } }, responses: { 200: { description: 'Released', schema: one('cdr') } }, errors: [400, 404, 409] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/cdrs/:id/void', summary: 'Void a held or pending CDR', body: { schema: { type: 'object', required: ['note'], properties: { note: S } } }, responses: { 200: { description: 'Void', schema: one('cdr') } }, errors: [400, 404, 409] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/cdrs/:id/dispute', summary: 'Dispute a CDR on behalf of the platform', body: { schema: { type: 'object', required: ['reason', 'message'], properties: { reason: REASON, message: S, claimed_minor: I } } }, responses: { 201: { description: 'Opened', schema: one('dispute', dispute) } }, errors: [400, 404, 409] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/accept-due', summary: 'Accept every CDR whose dispute window has passed now', description: 'What the hub-cdr-accept worker does every 15 minutes.', responses: { 200: { description: 'Accepted', schema: { type: 'object', properties: { accepted: I } } } } }),
  pa({ method: 'GET', path: '/v1/hub/clearing/disputes', summary: 'Disputes', query: [{ name: 'status', schema: S }, { name: 'member', schema: UUID }, { name: 'cdr', schema: UUID }], responses: { 200: { description: 'Disputes', schema: list('disputes', dispute) } } }),
  pa({ method: 'GET', path: '/v1/hub/clearing/disputes/:id', summary: 'A dispute with its notes (evidence and history)', responses: { 200: { description: 'Dispute', schema: disputeDetail } }, errors: [404] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/disputes/:id/resolve', summary: 'Decide a dispute', description: 'upheld (the CDR is accepted), written_off (the CPO is not paid) or credit_required (the CPO must send a credit CDR).', body: { schema: { type: 'object', required: ['outcome', 'note'], properties: { outcome: { enum: ['upheld', 'written_off', 'credit_required'] }, note: S } } }, responses: { 200: { description: 'Dispute', schema: one('dispute', dispute) } }, errors: [400, 404, 409] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/disputes/:id/escalate', summary: 'Escalate a dispute to the platform', body: { schema: note }, responses: { 200: { description: 'Dispute', schema: one('dispute', dispute) } }, errors: [404, 409] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/disputes/:id/withdraw', summary: 'Withdraw a dispute', body: { schema: note }, responses: { 200: { description: 'Dispute', schema: one('dispute', dispute) } }, errors: [404, 409] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/disputes/:id/notes', summary: 'Add a note to a dispute', body: { schema: { type: 'object', required: ['note'], properties: { note: S } } }, responses: { 200: { description: 'Notes', schema: list('notes') } }, errors: [400, 404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/fee-plans', summary: 'Hub commission plans', responses: { 200: { description: 'Plans', schema: list('feePlans', feePlan) } } }),
  pa({ method: 'POST', path: '/v1/hub/clearing/fee-plans', summary: 'Create a commission plan', description: 'One currency; a CPO part and an eMSP part (basis points of the excl.-tax total, a fixed amount per CDR, a minimum and a maximum). `is_default` + `effective_from` make it the currency default from that date.', body: { schema: { ...feePlanBody, required: ['name', 'currency'] } }, responses: { 201: { description: 'Created', schema: one('feePlan', feePlan) } }, errors: [400, 409] }),
  pa({ method: 'PATCH', path: '/v1/hub/clearing/fee-plans/:id', summary: 'Change a commission plan', description: 'Applies to CDRs accepted from now on; fees already frozen do not move.', body: { schema: feePlanBody }, responses: { 200: { description: 'Plan', schema: one('feePlan', feePlan) } }, errors: [400, 404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/agreements', summary: 'Agreements with their clearing terms', responses: { 200: { description: 'Agreements', schema: list('agreements') } } }),
  pa({ method: 'PUT', path: '/v1/hub/clearing/agreements/:id/terms', summary: 'Set an agreement\'s dispute window and commission overrides', body: { schema: { type: 'object', properties: { dispute_days: NI, fee_plans: { type: 'object', additionalProperties: NS, description: '{ "<currency>": "<fee plan id>" | null }' } } } }, responses: { 200: { description: 'Terms', schema: OBJ } }, errors: [400, 404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/members/:id/terms', summary: 'A member\'s commission plans per currency', responses: { 200: { description: 'Terms', schema: OBJ } }, errors: [404] }),
  pa({ method: 'PUT', path: '/v1/hub/clearing/members/:id/terms', summary: 'Set a member\'s commission plans per currency', body: { schema: { type: 'object', properties: { fee_plans: { type: 'object', additionalProperties: NS } } } }, responses: { 200: { description: 'Terms', schema: OBJ } }, errors: [400, 404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/entities', summary: 'PlugSure entities issuing fee invoices', description: 'Seeded as PLACEHOLDERS until the owner confirms them.', responses: { 200: { description: 'Entities', schema: list('entities') } } }),
  pa({ method: 'PUT', path: '/v1/hub/clearing/entities/:country', summary: 'Set a PlugSure entity', pathParams: { country: 'ID, MY or SG' }, body: { schema: { type: 'object', required: ['legal_name', 'address', 'invoice_prefix'], properties: { legal_name: S, tax_id: S, tax_registered: B, address: S, invoice_prefix: S, bank_details: S, placeholder: B } } }, responses: { 200: { description: 'Entity', schema: one('entity') } }, errors: [400, 404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/runs', summary: 'Settlement runs', query: [{ name: 'currency', schema: S }, { name: 'status', schema: S }], responses: { 200: { description: 'Runs', schema: list('runs') } } }),
  pa({ method: 'POST', path: '/v1/hub/clearing/runs', summary: 'Create (or refresh) the draft run of a period', description: 'Idempotent per (currency, cycle, period): 201 when created, 200 when it existed (a finalised run is returned unchanged).', body: { schema: { type: 'object', required: ['currency', 'period'], properties: { currency: CUR, period: { type: 'string', description: 'YYYY-MM (monthly) or YYYY-MM-DD, a Monday (weekly)' }, cycle: { enum: ['monthly', 'weekly'] } } } }, responses: { 200: { description: 'Existing run', schema: { type: 'object', properties: { run, created: B } } }, 201: { description: 'Created', schema: { type: 'object', properties: { run, created: B } } } }, errors: [400] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/runs/:id', summary: 'A run (draft preview, or finalised positions, statements and fee invoices)', responses: { 200: { description: 'Run', schema: { type: 'object', required: ['run'], properties: { run, positions: { type: 'array', items: position }, statements: { type: 'array', items: statement }, feeInvoices: { type: 'array', items: invoice } } } } }, errors: [404] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/runs/:id/preview', summary: 'Recompute a draft run', responses: { 200: { description: 'Run', schema: one('run', run) } }, errors: [404, 409] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/runs/:id/finalise', summary: 'Finalise a run', description: 'Stamps its CDRs, writes positions, statements and fee invoices. Idempotent. Refused before the period ends; before finalisable_at only with force.', body: { schema: { type: 'object', properties: { force: B, reason: { type: 'string', description: 'Why (kept in the audit entry)' } } } }, responses: { 200: { description: 'Finalised', schema: { type: 'object', properties: { run, alreadyFinalised: B } } } }, errors: [404, 409] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/runs/:id/void', summary: 'Void a draft run', body: { schema: { type: 'object', properties: { reason: { type: 'string', description: 'Why (kept in the audit entry)' } } } }, responses: { 200: { description: 'Void', schema: one('run', run) } }, errors: [404, 409] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/positions', summary: 'Settlement positions (bilateral nets)', query: [{ name: 'member', schema: UUID }, { name: 'run', schema: UUID }, { name: 'status', schema: S }, { name: 'currency', schema: S }], responses: { 200: { description: 'Positions', schema: list('positions', position) } } }),
  pa({ method: 'POST', path: '/v1/hub/clearing/positions/:id/write-off', summary: 'Write off what remains of a position', body: { schema: { type: 'object', required: ['note'], properties: { note: S } } }, responses: { 200: { description: 'Position', schema: one('position', position) } }, errors: [400, 404, 409] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/payments', summary: 'Recorded payments', query: [{ name: 'position', schema: UUID }, { name: 'member', schema: UUID }], responses: { 200: { description: 'Payments', schema: list('payments', payment) } } }),
  pa({ method: 'POST', path: '/v1/hub/clearing/payments', summary: 'Record a payment on a position (platform)', body: { schema: paymentBody }, responses: { 201: { description: 'Recorded', schema: paymentResult } }, errors: [400, 404, 409] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/payments/:id/confirm', summary: 'Confirm a payment was received (platform)', responses: { 200: { description: 'Confirmed', schema: paymentResult } }, errors: [404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/statements', summary: 'Member statements', query: [{ name: 'member', schema: UUID }, { name: 'run', schema: UUID }, { name: 'currency', schema: S }, { name: 'period', schema: S }], responses: { 200: { description: 'Statements', schema: list('statements', statement) } } }),
  pa({ method: 'GET', path: '/v1/hub/clearing/statements/:id', summary: 'A statement (frozen data)', responses: { 200: { description: 'Statement', schema: one('statement', statement) } }, errors: [404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/statements/:id/html', summary: 'A statement as printable HTML', responses: html, errors: [404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/statements/:id/pdf', summary: 'A statement as PDF', responses: pdf, errors: [404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/statements/:id/csv', summary: 'A statement\'s CDRs as CSV', responses: csv, errors: [404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/fee-invoices', summary: 'Hub fee invoices', query: [{ name: 'member', schema: UUID }, { name: 'run', schema: UUID }, { name: 'status', schema: S }], responses: { 200: { description: 'Invoices', schema: list('feeInvoices', invoice) } } }),
  pa({ method: 'GET', path: '/v1/hub/clearing/fee-invoices/:id', summary: 'A hub fee invoice', responses: { 200: { description: 'Invoice', schema: one('feeInvoice', invoice) } }, errors: [404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/fee-invoices/:id/html', summary: 'A hub fee invoice as printable HTML', responses: html, errors: [404] }),
  pa({ method: 'GET', path: '/v1/hub/clearing/fee-invoices/:id/pdf', summary: 'A hub fee invoice as PDF', responses: pdf, errors: [404] }),
  pa({ method: 'POST', path: '/v1/hub/clearing/fee-invoices/:id/paid', summary: 'Mark a hub fee invoice paid', body: { schema: { type: 'object', required: ['paid_at'], properties: { paid_at: S, reference: S } } }, responses: { 200: { description: 'Invoice', schema: one('feeInvoice', invoice) } }, errors: [400, 404, 409] }),

  // ── a member's own view
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/summary', summary: 'My hub clearing summary', description: 'Membership, ledger counts per side/currency/status, open disputes, outstanding positions, own bank details.', responses: { 200: { description: 'Summary', schema: OBJ } }, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/cdrs', summary: 'My hub CDRs (both sides)', query: [...cdrQuery.filter((p) => !['cpo_member', 'emsp_member', 'member'].includes(p.name)), { name: 'side', schema: { enum: ['cpo', 'emsp'] } }], responses: { 200: { description: 'CDRs', schema: cdrPage } }, errors: [400, 404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/cdrs.csv', summary: 'Export my hub CDRs (CSV)', query: [{ name: 'side', schema: { enum: ['cpo', 'emsp'] } }, { name: 'status', schema: S }, { name: 'currency', schema: S }], responses: csv, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/cdrs/:id', summary: 'One of my hub CDRs', responses: { 200: { description: 'CDR', schema: { type: 'object', required: ['cdr'], properties: { cdr, disputes: { type: 'array', items: dispute }, related: { type: 'array', items: OBJ } } } } }, errors: [404] }),
  mb({ method: 'POST', path: '/v1/roaming/hub/clearing/cdrs/:id/dispute', summary: 'Dispute a CDR (eMSP side, within its dispute window)', body: { schema: { type: 'object', required: ['reason', 'message'], properties: { reason: REASON, message: S, claimed_minor: I } } }, responses: { 201: { description: 'Opened', schema: one('dispute', dispute) } }, errors: [400, 403, 404, 409] }, 'roaming:write'),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/disputes', summary: 'My disputes (both sides)', query: [{ name: 'status', schema: S }, { name: 'side', schema: { enum: ['cpo', 'emsp'] } }], responses: { 200: { description: 'Disputes', schema: list('disputes', dispute) } }, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/disputes/:id', summary: 'A dispute with its notes', responses: { 200: { description: 'Dispute', schema: disputeDetail } }, errors: [404] }),
  mb({ method: 'POST', path: '/v1/roaming/hub/clearing/disputes/:id/respond', summary: 'Answer a dispute (CPO side): accept or reject', description: 'accept: you will send a credit CDR (and a corrected CDR) through the hub; reject: a note is required.', body: { schema: { type: 'object', required: ['action'], properties: { action: { enum: ['accept', 'reject'] }, note: S } } }, responses: { 200: { description: 'Dispute', schema: one('dispute', dispute) } }, errors: [400, 403, 404, 409] }, 'roaming:write'),
  mb({ method: 'POST', path: '/v1/roaming/hub/clearing/disputes/:id/escalate', summary: 'Escalate a rejected dispute to the platform (eMSP side)', body: { schema: note }, responses: { 200: { description: 'Dispute', schema: one('dispute', dispute) } }, errors: [403, 404, 409] }, 'roaming:write'),
  mb({ method: 'POST', path: '/v1/roaming/hub/clearing/disputes/:id/withdraw', summary: 'Withdraw my dispute (eMSP side)', body: { schema: note }, responses: { 200: { description: 'Dispute', schema: one('dispute', dispute) } }, errors: [403, 404, 409] }, 'roaming:write'),
  mb({ method: 'POST', path: '/v1/roaming/hub/clearing/disputes/:id/notes', summary: 'Add evidence or a comment to a dispute', body: { schema: { type: 'object', required: ['note'], properties: { note: S } } }, responses: { 200: { description: 'Notes', schema: list('notes') } }, errors: [400, 404] }, 'roaming:write'),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/statements', summary: 'My hub statements', query: [{ name: 'currency', schema: S }, { name: 'period', schema: S }], responses: { 200: { description: 'Statements', schema: list('statements', statement) } }, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/statements/:id', summary: 'One of my hub statements', responses: { 200: { description: 'Statement', schema: one('statement', statement) } }, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/statements/:id/html', summary: 'My statement as printable HTML', responses: html, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/statements/:id/pdf', summary: 'My statement as PDF', responses: pdf, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/statements/:id/csv', summary: 'My statement\'s CDRs as CSV', responses: csv, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/fee-invoices', summary: 'My hub fee invoices', query: [{ name: 'status', schema: S }], responses: { 200: { description: 'Invoices', schema: list('feeInvoices', invoice) } }, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/fee-invoices/:id', summary: 'One of my hub fee invoices', responses: { 200: { description: 'Invoice', schema: one('feeInvoice', invoice) } }, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/fee-invoices/:id/html', summary: 'My fee invoice as printable HTML', responses: html, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/fee-invoices/:id/pdf', summary: 'My fee invoice as PDF', responses: pdf, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/fee-plans', summary: 'My commission terms per currency', responses: { 200: { description: 'Plans', schema: one('feePlans') } }, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/positions', summary: 'My settlement positions', query: [{ name: 'status', schema: S }, { name: 'currency', schema: S }, { name: 'run', schema: UUID }], responses: { 200: { description: 'Positions', schema: list('positions', position) } }, errors: [404] }),
  mb({ method: 'GET', path: '/v1/roaming/hub/clearing/payments', summary: 'Payments on my positions', query: [{ name: 'position', schema: UUID }], responses: { 200: { description: 'Payments', schema: list('payments', payment) } }, errors: [404] }),
  mb({ method: 'POST', path: '/v1/roaming/hub/clearing/payments', summary: 'Record a payment (as payer, or as payee: counts as confirmed)', body: { schema: paymentBody }, responses: { 201: { description: 'Recorded', schema: paymentResult } }, errors: [400, 404, 409] }, 'roaming:write'),
  mb({ method: 'POST', path: '/v1/roaming/hub/clearing/payments/:id/confirm', summary: 'Confirm a payment was received (payee)', responses: { 200: { description: 'Confirmed', schema: paymentResult } }, errors: [403, 404] }, 'roaming:write'),
  mb({ method: 'PUT', path: '/v1/roaming/hub/clearing/bank-details', summary: 'Set the account counterparties pay into', description: 'Sealed at rest; printed as the payment instruction on payers\' statements.', body: { schema: { type: 'object', required: ['bank_details'], properties: { bank_details: S } } }, responses: { 200: { description: 'Saved', schema: { type: 'object', properties: { ok: B } } } }, errors: [400, 404] }, 'roaming:write'),
];
