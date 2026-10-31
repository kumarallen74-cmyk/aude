import { type Op, type Schema, ref, arrayOf, nullable } from '../types.js';

/**
 * Commercial → Finance (v1.12.0): src/api/finance-routes.ts. The payment gateway's side of the money, per gateway
 * account (a payments integration on Xendit). payment:read to read, payment:write to act; the platform's own
 * account (org null) also needs platform:admin. Amounts are rupiah with up to two decimals (gateway fees and VAT).
 */

const T = 'Finance' as const;
const DT = { type: 'string', format: 'date-time' };
const money: Schema = { type: 'number' };
const count: Schema = { type: 'integer', minimum: 0 };
const ID = { id: 'The payments account (integration) id, from GET /v1/finance/accounts.' };
const PERIOD = [
  { name: 'from', schema: { type: 'string', format: 'date' }, description: 'First day (platform time zone). Default: the first of the current month.' },
  { name: 'to', schema: { type: 'string', format: 'date' }, description: 'Last day, inclusive. Default: today. At most 400 days.' },
];

export const schemas: Record<string, Schema> = {
  FinanceAccount: {
    type: 'object', required: ['id', 'provider', 'label'],
    properties: {
      id: { type: 'string', format: 'uuid' }, orgId: nullable('string', { description: 'Null: the platform\'s own account (it takes the payments of every operator without one).' }),
      orgName: nullable('string'), provider: { type: 'string', enum: ['xendit'] }, environment: nullable('string'),
      archived: { type: 'boolean', description: 'Replaced by another account; kept while its money settles.' }, testMode: { type: 'boolean' }, label: { type: 'string' },
    },
  },
  GatewayTransaction: {
    type: 'object', required: ['id', 'gatewayId', 'kind', 'status', 'amount', 'at'],
    description: 'One transaction in the gateway\'s ledger, as synced, matched to PlugSure\'s payment when it is one.',
    properties: {
      id: { type: 'string' }, gatewayId: { type: 'string', description: 'Xendit\'s transaction id (txn_…).' },
      kind: { type: 'string', enum: ['payment', 'refund', 'payout', 'transfer', 'fee', 'other'] }, type: nullable('string', { description: 'The gateway\'s own type word.' }),
      status: { type: 'string', enum: ['success', 'pending', 'failed', 'voided', 'reversed'] }, cashflow: { type: 'string', enum: ['in', 'out'] },
      channel: nullable('string'), channelCategory: nullable('string'), reference: nullable('string', { description: 'The reference PlugSure gave the gateway (ps-…).' }), productId: nullable('string'),
      currency: { type: 'string' }, amount: money, fee: money, vat: money, withholdingTax: money, net: { type: ['number', 'null'] },
      settlement: nullable('string', { enum: ['pending', 'settled', 'early_settled', null] }), expectedSettlementAt: nullable('string', { format: 'date-time' }),
      settledSeenAt: nullable('string', { format: 'date-time', description: 'When the sync first saw it settled.' }), at: DT, updatedAt: DT,
      matched: nullable('string', { enum: ['intent', 'pass', 'refund', null], description: 'How it matched PlugSure: a payment, a membership pass charge, a refund; null: not matched.' }),
      paymentId: nullable('string'), paymentState: nullable('string'), sessionId: nullable('string'), operator: nullable('string'), passChargeId: nullable('string'),
    },
  },
  ReconciliationException: {
    type: 'object', required: ['id', 'kind', 'text', 'state'],
    properties: {
      id: { type: 'string' },
      kind: { type: 'string', enum: ['missing_in_plugsure', 'missing_at_gateway', 'amount_mismatch', 'pending_too_long', 'settlement_overdue', 'refund_mismatch'] },
      text: { type: 'string' }, state: { type: 'string', enum: ['open', 'resolved'] }, amount: { type: ['number', 'null'] },
      reference: nullable('string'), channel: nullable('string'), gatewayId: nullable('string'), paymentId: nullable('string'), detail: { type: 'object' },
      canApply: { type: 'boolean', description: 'A gateway payment matching a PlugSure payment that never became paid: POST …/apply applies it.' },
      resolution: nullable('string'), resolvedAt: nullable('string', { format: 'date-time' }), firstSeenAt: DT, lastSeenAt: DT,
    },
  },
};

const acct = (summary: string, description: string, path: string, response: Schema, extra: Partial<Op> = {}): Op => ({
  method: 'GET', path: `/v1/finance/accounts/:id${path}`, tag: T, summary, description, pathParams: ID,
  responses: { 200: { description: summary, schema: response } }, errors: [400, 404], ...extra,
});

export const ops: Op[] = [
  {
    method: 'GET', path: '/v1/finance/accounts', tag: T, summary: 'Payments accounts with finance data',
    description: 'The gateway accounts the caller may see: its organisation\'s own Xendit account(s), and for platform administrators the platform\'s.',
    responses: { 200: { description: 'Accounts', schema: { type: 'object', required: ['accounts'], properties: { accounts: arrayOf(ref('FinanceAccount')) } } } },
  },
  acct('Finance overview', 'Over the period: collected, payments, fees, VAT on fees, withholding tax, refunds, payouts, settled, net (collected − fees − VAT − refunds), by channel and by day. Now: receivable (collected, not yet settled, by expected day; overdue), the last balance at the gateway, refunds due, open reconciliation exceptions, and the sync state.',
    '/overview', { type: 'object', required: ['account', 'collected', 'net', 'receivable'], properties: {
      account: ref('FinanceAccount'), period: { type: 'object', properties: { from: DT, to: DT, timeZone: { type: 'string' } } }, currency: { type: 'string' },
      collected: money, payments: count, fees: money, vat: money, withholdingTax: money, feeRate: { type: ['number', 'null'] }, refunds: money, refundCount: count,
      payouts: money, settled: money, net: money,
      receivable: { type: 'object', properties: { amount: money, count, overdue: money, byDay: arrayOf({ type: 'object', properties: { day: { type: 'string', format: 'date' }, amount: money, count } }) } },
      balance: { type: ['object', 'null'], properties: { amount: money, at: DT } },
      payable: { type: 'object', properties: { refundsDue: money, refundsDueCount: count } },
      byChannel: arrayOf({ type: 'object', properties: { channel: { type: 'string' }, count, amount: money, fees: money } }),
      daily: arrayOf({ type: 'object', properties: { day: { type: 'string', format: 'date' }, collected: money, fees: money, refunds: money } }),
      exceptionsOpen: count,
      sync: { type: ['object', 'null'], properties: { lastRunAt: nullable('string', { format: 'date-time' }), ok: { type: ['boolean', 'null'] }, error: nullable('string'), rows: { type: ['integer', 'null'] }, complete: { type: 'boolean' }, lastReconciledAt: nullable('string', { format: 'date-time' }) } },
    } }, { query: PERIOD }),
  acct('Gateway transactions', 'The synced ledger, newest first. Filters: kind, status, settlement (pending, settled, early_settled, none), channel, matched (true / false), q (part of a reference or id). Page with before = nextBefore.',
    '/transactions', { type: 'object', required: ['transactions', 'nextBefore'], properties: { transactions: arrayOf(ref('GatewayTransaction')), nextBefore: nullable('string') } },
    { query: [...PERIOD,
      { name: 'kind', schema: { type: 'string', enum: ['payment', 'refund', 'payout', 'transfer', 'fee', 'other'] } }, { name: 'status', schema: { type: 'string', enum: ['success', 'pending', 'failed', 'voided', 'reversed'] } },
      { name: 'settlement', schema: { type: 'string', enum: ['pending', 'settled', 'early_settled', 'none'] } }, { name: 'channel', schema: { type: 'string' } },
      { name: 'matched', schema: { type: 'boolean' } }, { name: 'q', schema: { type: 'string', maxLength: 100 } }, { name: 'before', schema: { type: 'string' } },
      { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }] }),
  acct('Receivables', 'Collected and not yet settled to the bank: totals by expected settlement day (overdue flagged) and the rows; for an operator\'s own account, its fleet invoices issued and not paid.',
    '/receivables', { type: 'object', required: ['byDay', 'total', 'rows', 'fleetInvoices'], properties: {
      byDay: arrayOf({ type: 'object', properties: { day: nullable('string', { format: 'date' }), net: money, gross: money, count, overdue: { type: 'boolean' } } }), total: money,
      rows: arrayOf(ref('GatewayTransaction')),
      fleetInvoices: arrayOf({ type: 'object', properties: { id: { type: 'string' }, number: { type: 'string' }, period: { type: 'string' }, total: money, currency: { type: 'string' }, dueDate: { type: 'string' }, account: nullable('string'), overdue: { type: 'boolean' } } }),
    } }),
  acct('Payables', 'Refunds due on payments this account took (with the e-wallet\'s refund window and days left), and site owners\' shares on statements finalised in the last 120 days of the operators whose payments it took (listed as due; recording their payment comes later).',
    '/payables', { type: 'object', required: ['refunds', 'ownerShares'], properties: {
      refunds: arrayOf({ type: 'object', properties: { paymentId: { type: 'string' }, state: { type: 'string' }, amount: money, currency: { type: 'string' }, reason: nullable('string'), requestedAt: nullable('string', { format: 'date-time' }), channel: nullable('string'), paidAt: nullable('string', { format: 'date-time' }), reference: nullable('string'), operator: nullable('string'), refundWindowDays: { type: ['integer', 'null'] }, daysLeft: { type: ['integer', 'null'] } } }),
      ownerShares: arrayOf({ type: 'object', properties: { statementId: { type: 'string' }, period: { type: 'string' }, owner: { type: 'string' }, operator: { type: 'string' }, amount: money, currency: { type: 'string' }, finalisedAt: DT, status: { type: 'string', enum: ['due'] } } }),
    } }),
  acct('Gateway fees', 'Fees, VAT and withholding tax on payments by month and channel with the effective rate; and the QRIS fees Xendit charged against PlugSure\'s estimate (the one on owner statements).',
    '/fees', { type: 'object', required: ['rows', 'qris'], properties: {
      rows: arrayOf({ type: 'object', properties: { month: { type: 'string' }, channel: { type: 'string' }, count, amount: money, fee: money, vat: money, withholdingTax: money, total: money, rate: { type: ['number', 'null'] } } }),
      qris: { type: 'object', properties: { payments: count, actual: money, estimated: money, difference: money } },
    } }, { query: PERIOD }),
  acct('Reconciliation exceptions', 'Differences between the gateway\'s ledger and PlugSure over the last 35 days, open first. Found by the reconciliation every 6 hours (and on POST …/sync); one that is no longer found closes itself.',
    '/exceptions', { type: 'object', required: ['exceptions'], properties: { exceptions: arrayOf(ref('ReconciliationException')) } },
    { query: [{ name: 'state', schema: { type: 'string', enum: ['open', 'resolved'] } }, { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }] }),
  {
    method: 'POST', path: '/v1/finance/accounts/:id/exceptions/:eid/apply', tag: T, summary: 'Apply a payment PlugSure missed',
    description: 'For a missing_in_plugsure exception whose gateway payment matches a PlugSure payment that never became paid: the payment is applied exactly as its lost notification would have been (state, amount and currency checks; a refund when it came too late), and the exception resolved with the outcome. Audited as finance.exception_applied.',
    pathParams: { ...ID, eid: 'The exception id.' },
    responses: { 200: { description: 'Applied', schema: { type: 'object', required: ['ok', 'outcome'], properties: { ok: { type: 'boolean' }, outcome: { type: 'string' } } } } },
    errors: [404, 409],
  },
  {
    method: 'POST', path: '/v1/finance/accounts/:id/exceptions/:eid/resolve', tag: T, summary: 'Resolve a reconciliation exception',
    description: 'Closes an open exception with a note saying what was done. Audited as finance.exception_resolved.',
    pathParams: { ...ID, eid: 'The exception id.' },
    body: { required: true, schema: { type: 'object', required: ['note'], properties: { note: { type: 'string', minLength: 1, maxLength: 500 } } }, example: { note: 'Refunded by bank transfer, ref 123456.' } },
    responses: { 200: { description: 'Resolved', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } } },
    errors: [404, 422],
  },
  {
    method: 'POST', path: '/v1/finance/accounts/:id/sync', tag: T, summary: 'Sync and reconcile now',
    description: 'Syncs the account\'s transactions changed since the last run, reads the balance and reconciles (the workers do this every 15 minutes, hourly and every 6 hours). At most 4 a minute. Audited as finance.synced.',
    pathParams: ID,
    responses: { 200: { description: 'Done', schema: { type: 'object', properties: {
      sync: { type: 'object', properties: { ok: { type: 'boolean' }, rows: count, complete: { type: 'boolean' }, error: { type: 'string' } } },
      balance: { type: ['number', 'null'] }, reconciliation: { type: 'object', properties: { open: count, found: count, cleared: count } },
    } } } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/finance/accounts/:id/export', tag: T, summary: 'Export the period (CSV, Excel, PDF)',
    description: 'The period for the accountant: csv — every transaction; xlsx — Summary, By channel, Fees and Transactions sheets; pdf — the summary, by channel, fees by month, then the transactions. Audited as finance.exported.',
    pathParams: ID, query: [...PERIOD, { name: 'format', schema: { type: 'string', enum: ['csv', 'xlsx', 'pdf'], default: 'xlsx' } }],
    responses: { 200: { description: 'The file (attachment)', contentType: 'application/octet-stream', schema: { type: 'string', format: 'binary' } } },
    errors: [400, 404],
  },
];
