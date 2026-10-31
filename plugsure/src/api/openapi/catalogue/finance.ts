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
  OwnerShare: {
    type: 'object', required: ['statementId', 'number', 'period', 'ownerId', 'owner', 'currency', 'due', 'paid', 'outstanding', 'status'],
    properties: {
      statementId: { type: 'string', format: 'uuid' }, number: { type: 'string' }, period: { type: 'string', description: 'YYYY-MM.' }, ownerId: { type: 'string', format: 'uuid' }, owner: { type: 'string' },
      currency: { type: 'string' }, due: count, paid: count, outstanding: count, status: { type: 'string', enum: ['due', 'partial', 'paid'] },
      finalisedAt: nullable('string', { format: 'date-time' }), lastPaidOn: nullable('string', { format: 'date' }),
      bank: { type: ['object', 'null'], properties: { bankName: { type: 'string' }, holderName: { type: 'string' }, accountMasked: { type: 'string' } } },
    },
  },
  OperatorStatementDue: {
    type: 'object', required: ['statementId', 'number', 'period', 'orgId', 'operator', 'currency', 'due', 'paid', 'outstanding', 'status'],
    properties: {
      statementId: { type: 'string', format: 'uuid' }, number: { type: 'string' }, period: { type: 'string' }, orgId: { type: 'string', format: 'uuid' }, operator: { type: 'string' },
      currency: { type: 'string' }, due: count, paid: count, outstanding: count, status: { type: 'string', enum: ['due', 'partial', 'paid'] },
      finalisedAt: nullable('string', { format: 'date-time' }), lastPaidOn: nullable('string', { format: 'date' }),
    },
  },
  StatementDue: {
    type: 'object', required: ['id', 'number', 'kind', 'currency', 'due', 'paid', 'outstanding', 'status'],
    properties: {
      id: { type: 'string', format: 'uuid' }, number: { type: 'string' }, kind: { type: 'string', enum: ['owner_payout', 'platform_fee'] }, currency: { type: 'string' },
      due: count, paid: count, outstanding: count, status: { type: 'string', enum: ['due', 'partial', 'paid'] },
    },
  },
  StatementPayment: {
    type: 'object', required: ['id', 'amount', 'currency', 'paidOn', 'reference', 'voided'],
    properties: {
      id: { type: 'string' }, amount: count, currency: { type: 'string' }, paidOn: { type: 'string', format: 'date' }, reference: { type: 'string' }, note: nullable('string'),
      recordedBy: nullable('string'), recordedAt: nullable('string', { format: 'date-time' }), voided: { type: 'boolean' }, voidedAt: nullable('string', { format: 'date-time' }),
      voidedBy: nullable('string'), voidReason: nullable('string'),
    },
  },
  OwnerBankAccount: {
    type: 'object', required: ['ownerId', 'bankName', 'holderName', 'accountMasked'],
    properties: {
      ownerId: { type: 'string', format: 'uuid' }, bankName: { type: 'string' }, bankCode: nullable('string'), holderName: { type: 'string' }, accountMasked: { type: 'string', description: '••••7890' }, updatedAt: DT,
      nameCheck: {
        type: ['object', 'null'], description: '(v1.15.0) The last name check (Duitku Disbursement inquiry); cleared when the account, bank code or holder changes.',
        properties: { status: { type: 'string', enum: ['matched', 'mismatch', 'failed'] }, bankName: nullable('string', { description: 'The holder\'s name the bank returned.' }), checkedAt: DT },
      },
    },
  },
  PayoutTransfer: {
    type: 'object', required: ['id', 'statementId', 'state', 'amount', 'currency', 'bankCode', 'accountMasked', 'holderName', 'namesMatch', 'requestedAt'],
    description: '(v1.16.0) An owner\'s share paid through Duitku Disbursement from the operator\'s own account, approved by a second person.',
    properties: {
      id: { type: 'string' }, statementId: { type: 'string', format: 'uuid' }, number: nullable('string'), owner: nullable('string'),
      rail: { type: 'string', enum: ['duitku', 'xendit'], description: '(v1.17.0) Duitku Disbursement or Xendit Payouts.' },
      state: { type: 'string', enum: ['awaiting_approval', 'sending', 'sent', 'succeeded', 'failed', 'rejected'] },
      amount: count, currency: { type: 'string' }, bankCode: { type: 'string' }, accountMasked: { type: 'string' },
      holderName: { type: 'string' }, checkedName: nullable('string'), namesMatch: { type: 'boolean' }, note: nullable('string'),
      requestedBy: nullable('string'), requestedByName: nullable('string'), requestedAt: DT,
      approvedBy: nullable('string'), approvedByName: nullable('string'), approvedAt: nullable('string', { format: 'date-time' }),
      reason: nullable('string'), responseCode: nullable('string'), error: nullable('string'),
      statementPaymentId: nullable('string', { description: 'The statement payment recorded once Duitku confirmed it.' }),
    },
  },
  GatewayReport: {
    type: 'object', required: ['id', 'type', 'status', 'ready'],
    description: '(v1.16.0) A report Xendit generates on request (Report API), as CSV.',
    properties: {
      id: { type: 'string' }, type: { type: 'string', enum: ['TRANSACTIONS', 'BALANCE_HISTORY', 'UPCOMING_TRANSACTIONS'] }, from: DT, to: DT,
      status: { type: 'string', enum: ['PENDING', 'COMPLETED', 'FAILED'] }, ready: { type: 'boolean' }, error: nullable('string'),
      requestedAt: DT, updatedAt: DT, requestedBy: nullable('string'),
      url: { type: 'string', description: 'With ?link=true on a completed report: Xendit\'s download link (short-lived).' },
    },
  },
  RefundTransfer: {
    type: 'object', required: ['id', 'paymentId', 'state', 'amount', 'currency', 'bankCode', 'accountMasked', 'holderName', 'namesMatch', 'requestedAt'],
    description: '(v1.15.0) A refund paid to the driver\'s bank account through Duitku Disbursement, approved by a second person.',
    properties: {
      id: { type: 'string' }, paymentId: { type: 'string', format: 'uuid' },
      rail: { type: 'string', enum: ['duitku', 'xendit'], description: '(v1.17.0) Duitku Disbursement or Xendit Payouts (no name check: checkedName is null).' },
      state: { type: 'string', enum: ['awaiting_approval', 'sending', 'sent', 'succeeded', 'failed', 'rejected'], description: 'sent: accepted, the result not confirmed yet (checked automatically).' },
      amount: count, currency: { type: 'string' }, bankCode: { type: 'string' }, accountMasked: { type: 'string' },
      holderName: { type: 'string', description: 'The name entered.' }, checkedName: nullable('string', { description: 'The holder\'s name the bank returned (inquiry).' }),
      namesMatch: { type: 'boolean' }, requestedBy: nullable('string'), requestedByName: nullable('string'), requestedAt: DT,
      approvedBy: nullable('string'), approvedByName: nullable('string'), approvedAt: nullable('string', { format: 'date-time' }),
      reason: nullable('string'), responseCode: nullable('string', { description: 'Duitku\'s responseCode (00 paid).' }), error: nullable('string'),
    },
  },
  FinanceAccount: {
    type: 'object', required: ['id', 'provider', 'label'],
    properties: {
      id: { type: 'string', format: 'uuid' }, orgId: nullable('string', { description: 'Null: the platform\'s own account (it takes the payments of every operator without one).' }),
      orgName: nullable('string'), provider: { type: 'string', enum: ['xendit', 'duitku'] }, environment: nullable('string'),
      fallback: { type: 'boolean', description: '(v1.13.0) The fallback account (Duitku): its ledger is built from PlugSure\'s payments with the fee Duitku reports, settlement estimated from Duitku\'s schedule.' },
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
  acct('Receivables', 'Collected and not yet settled to the bank: totals by expected settlement day (overdue flagged) and the rows; for an operator\'s own account, its fleet invoices issued and not paid. (v1.15.0) Also post-pay sessions not charged yet; for the platform\'s account PlugSure Hub\'s unpaid fee invoices, for an operator\'s the Hub settlement positions it is owed (hubPositions).',
    '/receivables', { type: 'object', required: ['byDay', 'total', 'rows', 'fleetInvoices'], properties: {
      byDay: arrayOf({ type: 'object', properties: { day: nullable('string', { format: 'date' }), net: money, gross: money, count, overdue: { type: 'boolean' } } }), total: money,
      rows: arrayOf(ref('GatewayTransaction')),
      fleetInvoices: arrayOf({ type: 'object', properties: { id: { type: 'string' }, number: { type: 'string' }, period: { type: 'string' }, total: money, currency: { type: 'string' }, dueDate: { type: 'string' }, account: nullable('string'), overdue: { type: 'boolean' } } }),
      postpay: { type: 'object', description: '(v1.15.0) Post-pay sessions on this account not charged yet (and how many failed).', properties: { count, amount: money, failed: count } },
      hubFeeInvoices: arrayOf({ type: 'object', description: '(v1.15.0) The platform\'s account: PlugSure Hub fee invoices issued and not paid.', properties: { number: { type: 'string' }, member: nullable('string'), total: money, currency: { type: 'string' }, dueDate: { type: 'string', format: 'date' }, overdue: { type: 'boolean' } } }),
      hubPositions: arrayOf({ type: 'object', properties: { id: { type: 'string' }, counterparty: nullable('string'), outstanding: money, currency: { type: 'string' }, dueDate: { type: 'string', format: 'date' }, status: { type: 'string' } } }),
    } }),
  acct('Payables', 'Refunds due on payments this account took (with the gateway\'s refund window and days left), (v1.15.0) for an operator\'s own account the PlugSure Hub settlement positions it owes, and site owners\' shares on statements finalised in the last 120 days of the operators whose payments it took, with what was paid against each (recorded with POST /v1/finance/statements/:sid/payments).',
    '/payables', { type: 'object', required: ['refunds', 'ownerShares'], properties: {
      refunds: arrayOf({ type: 'object', properties: { paymentId: { type: 'string' }, state: { type: 'string' }, amount: money, currency: { type: 'string' }, reason: nullable('string'), requestedAt: nullable('string', { format: 'date-time' }), channel: nullable('string'), paidAt: nullable('string', { format: 'date-time' }), reference: nullable('string'), operator: nullable('string'), refundWindowDays: { type: ['integer', 'null'] }, daysLeft: { type: ['integer', 'null'] } } }),
      ownerShares: arrayOf({ type: 'object', properties: { statementId: { type: 'string' }, period: { type: 'string' }, owner: { type: 'string' }, operator: { type: 'string' }, amount: money, paid: money, currency: { type: 'string' }, finalisedAt: DT, status: { type: 'string', enum: ['due', 'partial', 'paid'] } } }),
      hubPositions: arrayOf({ type: 'object', properties: { id: { type: 'string' }, counterparty: nullable('string'), outstanding: money, currency: { type: 'string' }, dueDate: { type: 'string', format: 'date' }, status: { type: 'string' } } }),
    } }),
  acct('Period by operator and site', '(v1.15.0) The accountant\'s month close: collected, payments, fees, VAT on fees, refunds and net from the gateway\'s ledger, attributed through PlugSure\'s payment to its session\'s site and operator (rows without one under site null); per operator also the site owners\' shares on statements finalised for months starting in the period, and what was paid against them.',
    '/breakdown', { type: 'object', required: ['bySite', 'byOperator'], properties: {
      bySite: arrayOf({ type: 'object', properties: { operator: nullable('string'), site: nullable('string'), payments: count, collected: money, fees: money, vat: money, refunds: money, net: money } }),
      byOperator: arrayOf({ type: 'object', properties: { orgId: nullable('string'), operator: nullable('string'), payments: count, collected: money, fees: money, vat: money, refunds: money, net: money, ownerShares: money, ownerSharesPaid: money } }),
    } }, { query: PERIOD }),
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
  // ─────────────────────────────────────────── (v1.14.0) payouts and statement payments, recorded
  {
    method: 'GET', path: '/v1/finance/owner-shares', tag: T, summary: 'Site owners\' shares and their payouts',
    description: 'The organisation\'s owner statements (finalised, with a share), newest first: the share due, what was paid against it (recorded transfers), outstanding, and status (due, partial, paid), with the owner\'s bank (masked). The operator\'s bank makes the transfers and they are recorded here; (v1.16.0) or, with Disbursement on the operator\'s own Duitku account (payoutsAvailable), they can be sent with POST /v1/finance/statements/{sid}/payout.',
    query: [{ name: 'status', schema: { type: 'string', enum: ['due', 'partial', 'paid'] } }],
    responses: { 200: { description: 'Shares', schema: { type: 'object', required: ['shares'], properties: { shares: arrayOf(ref('OwnerShare')), payoutsAvailable: { type: 'boolean' }, payoutRails: arrayOf({ type: 'string', enum: ['duitku', 'xendit'] }) } } } },
    errors: [400],
  },
  {
    method: 'GET', path: '/v1/finance/owner-shares/transfer-list.csv', tag: T, summary: 'Transfer list for the bank',
    description: 'What is still owed to site owners, one line per statement, with each owner\'s bank, code, holder and FULL account number, for the bank\'s bulk transfer. payment:write; audited as finance.transfer_list_exported.',
    responses: { 200: { description: 'CSV (attachment)', contentType: 'text/csv', schema: { type: 'string' } } },
  },
  {
    method: 'GET', path: '/v1/finance/operator-statements', tag: T, summary: 'Operators\' statements to PlugSure',
    description: 'Platform administrators: every operator\'s finalised statement to PlugSure (total due), what the operator paid (recorded), outstanding and status.',
    query: [{ name: 'status', schema: { type: 'string', enum: ['due', 'partial', 'paid'] } }],
    responses: { 200: { description: 'Statements', schema: { type: 'object', required: ['statements'], properties: { statements: arrayOf(ref('OperatorStatementDue')) } } } },
    errors: [400],
  },
  {
    method: 'GET', path: '/v1/finance/statements/:sid/payments', tag: T, summary: 'Payments recorded against a statement',
    description: 'An owner statement of the caller\'s organisation, or (platform administrators) an operator\'s statement to PlugSure: what is due and paid, and every payment recorded, voided ones included.',
    pathParams: { sid: 'The statement id.' },
    responses: { 200: { description: 'The statement and its payments', schema: { type: 'object', required: ['statement', 'payments'], properties: { statement: ref('StatementDue'), payments: arrayOf(ref('StatementPayment')) } } } },
    errors: [404, 409],
  },
  {
    method: 'POST', path: '/v1/finance/statements/:sid/payments', tag: T, summary: 'Record a payout or statement payment',
    description: 'Records a transfer the operator\'s bank made: to a site owner against an owner statement (finance.owner_payout_recorded), or from the operator to PlugSure against its statement (platform administrators; finance.platform_fee_recorded). amount is in the statement currency\'s minor units (rupiah: whole rupiah); more than is outstanding is refused; the statement must be finalised.',
    pathParams: { sid: 'The statement id.' },
    body: { required: true, schema: { type: 'object', required: ['amount', 'paidOn', 'reference'], properties: {
      amount: { type: 'integer', minimum: 1 }, paidOn: { type: 'string', format: 'date' }, reference: { type: 'string', minLength: 1, maxLength: 120 }, note: { type: 'string', maxLength: 500 },
    } }, example: { amount: 1250000, paidOn: '2026-11-05', reference: 'BCA 20261105-7781', note: 'October share' } },
    responses: { 201: { description: 'Recorded', schema: { type: 'object', required: ['paymentId', 'statement'], properties: { paymentId: { type: 'string' }, statement: ref('StatementDue') } } } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/finance/statement-payments/:pid/void', tag: T, summary: 'Void a recorded payment',
    description: 'A payment recorded by mistake is voided (never deleted), with a reason; the statement is due again by its amount. Audited as finance.statement_payment_voided.',
    pathParams: { pid: 'The payment id.' },
    body: { required: true, schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 300 } } }, example: { reason: 'Recorded against the wrong month' } },
    responses: { 200: { description: 'Voided', schema: { type: 'object', required: ['ok', 'statement'], properties: { ok: { type: 'boolean' }, statement: ref('StatementDue') } } } },
    errors: [404, 409, 422],
  },
  {
    method: 'GET', path: '/v1/finance/owners/:oid/bank-account', tag: T, summary: 'A site owner\'s bank details',
    description: 'Where the owner is paid: bank, code, account holder; the account number masked (it is stored sealed). 404 when none are saved.',
    pathParams: { oid: 'The site owner id.' },
    responses: { 200: { description: 'Bank details', schema: { type: 'object', required: ['account'], properties: { account: ref('OwnerBankAccount') } } } },
    errors: [404],
  },
  {
    method: 'PUT', path: '/v1/finance/owners/:oid/bank-account', tag: T, summary: 'Set a site owner\'s bank details',
    description: 'bankName and holderName are required; accountNumber (5–20 digits) is required the first time and kept when omitted later. payment:write; audited as finance.owner_bank_account_saved (masked).',
    pathParams: { oid: 'The site owner id.' },
    body: { required: true, schema: { type: 'object', required: ['bankName', 'holderName'], properties: {
      bankName: { type: 'string', maxLength: 80 }, bankCode: { type: 'string', pattern: '^[A-Za-z0-9]{2,12}$' }, holderName: { type: 'string', maxLength: 120 }, accountNumber: { type: 'string', pattern: '^[0-9 .-]{5,24}$' },
    } }, example: { bankName: 'BCA', bankCode: '014', holderName: 'PT Hotel Nusantara', accountNumber: '1234567890' } },
    responses: { 200: { description: 'Saved', schema: { type: 'object', required: ['account'], properties: { account: ref('OwnerBankAccount') } } } },
    errors: [404, 422],
  },
  {
    method: 'POST', path: '/v1/finance/owners/:oid/bank-account/check', tag: T, summary: 'Check a site owner\'s bank account by name',
    description: '(v1.15.0) Duitku Disbursement\'s inquiry (the operator\'s Duitku account, else the platform\'s): the holder\'s name the bank has, compared with the name saved. Nothing is transferred. Needs the bank code. payment:write; audited as finance.owner_bank_account_checked.',
    pathParams: { oid: 'The site owner id.' },
    responses: { 200: { description: 'Checked', schema: { type: 'object', required: ['check', 'account'], properties: {
      check: { type: 'object', properties: { status: { type: 'string', enum: ['matched', 'mismatch', 'failed'] }, bankName: nullable('string'), error: nullable('string') } }, account: ref('OwnerBankAccount') } } } },
    errors: [404, 409, 422],
  },
  {
    method: 'GET', path: '/v1/refund-transfers', tag: T, summary: 'Refund transfers through Duitku Disbursement',
    description: '(v1.15.0) The organisation\'s refund transfers, newest first (at most 300); open=true: only those not settled (awaiting approval, sending, sent).',
    query: [{ name: 'open', schema: { type: 'string', enum: ['true'] }, description: 'Only open transfers.' }],
    responses: { 200: { description: 'Transfers', schema: { type: 'object', required: ['transfers'], properties: { transfers: arrayOf(ref('RefundTransfer')) } } } },
  },
  {
    method: 'POST', path: '/v1/refunds/:id/disbursement', tag: T, summary: 'Request a refund transfer through Duitku Disbursement',
    description: '(v1.15.0) For a due (or failed) refund of a Duitku payment whose account has Disbursement: the driver\'s bank account is checked by Duitku\'s inquiry (the holder\'s name the bank has) and the transfer waits for a SECOND person\'s approval. The refund is held (processing) meanwhile. Refused above the largest transfer allowed. payment:write; audited as refund.transfer_requested.',
    pathParams: { id: 'The payment id.' },
    body: { required: true, schema: { type: 'object', required: ['bankCode', 'accountNumber', 'holderName'], properties: {
      bankCode: { type: 'string', pattern: '^[A-Za-z0-9]{2,12}$', description: 'Duitku\'s bank code (e.g. 014 BCA).' }, accountNumber: { type: 'string', pattern: '^[0-9 .-]{5,24}$' }, holderName: { type: 'string', maxLength: 120 },
    } }, example: { bankCode: '014', accountNumber: '1234567890', holderName: 'Budi Santoso' } },
    responses: { 201: { description: 'Requested, awaiting approval', schema: { type: 'object', required: ['transfer'], properties: { transfer: ref('RefundTransfer') } } } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/refund-transfers/:tid/approve', tag: T, summary: 'Approve and send a refund transfer',
    description: '(v1.15.0) By a second person with payment:write (never the requester: 403). Within the limits (one transfer; all approved that day), a fresh inquiry is made (the bank\'s name must not have changed) and the transfer sent, once. succeeded: the refund is recorded refunded (method disbursement); failed: due again; sent: not confirmed yet, checked automatically. Audited as refund.transfer_approved.',
    pathParams: { tid: 'The transfer id.' },
    responses: { 200: { description: 'The transfer after sending', schema: { type: 'object', required: ['transfer'], properties: { transfer: ref('RefundTransfer') } } } },
    errors: [403, 404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/refund-transfers/:tid/reject', tag: T, summary: 'Reject a refund transfer before it is sent',
    description: '(v1.15.0) Awaiting approval only, with a reason (the requester withdrawing it, or another person refusing it). The refund is due again. Audited as refund.transfer_rejected.',
    pathParams: { tid: 'The transfer id.' },
    body: { required: true, schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 300 } } }, example: { reason: 'The bank names someone else' } },
    responses: { 200: { description: 'Rejected', schema: { type: 'object', required: ['transfer'], properties: { transfer: ref('RefundTransfer') } } } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/refund-transfers/:tid/resolve', tag: T, summary: 'Settle a refund transfer whose result Duitku never confirmed',
    description: '(v1.15.0) For a transfer sent (or stuck sending) without a confirmed result, after checking Duitku\'s dashboard: succeeded records the refund refunded; failed makes it due again. Audited as refund.transfer_resolved.',
    pathParams: { tid: 'The transfer id.' },
    body: { required: true, schema: { type: 'object', required: ['outcome', 'note'], properties: { outcome: { type: 'string', enum: ['succeeded', 'failed'] }, note: { type: 'string', minLength: 1, maxLength: 300 } } }, example: { outcome: 'succeeded', note: 'Duitku dashboard: transfer 88123 success' } },
    responses: { 200: { description: 'Settled', schema: { type: 'object', required: ['transfer'], properties: { transfer: ref('RefundTransfer') } } } },
    errors: [404, 409, 422],
  },
  acct('A ledger row\'s whole trail', '(v1.16.0) The gateway transaction with its raw record (payer details masked), the other ledger rows of the same payment, PlugSure\'s payment with its state history and refund, the charging session (site, charger, energy, driver masked) and its charge record, Disbursement refund transfers, the membership pass it paid, and reconciliation exceptions.',
    '/transactions/:tid/trail', { type: 'object', required: ['transaction', 'related', 'transfers', 'exceptions'], properties: {
      transaction: { allOf: [ref('GatewayTransaction')], properties: { raw: { type: 'object' } } }, related: arrayOf(ref('GatewayTransaction')),
      payment: { type: ['object', 'null'] }, session: { type: ['object', 'null'] }, transfers: arrayOf({ type: 'object' }), pass: { type: ['object', 'null'] }, exceptions: arrayOf({ type: 'object' }),
    } }, { pathParams: { ...ID, tid: 'The ledger row id.' } }),
  acct('Xendit reports', '(v1.16.0) Reports requested from Xendit for this account (newest 50).', '/reports', { type: 'object', required: ['reports'], properties: { reports: arrayOf(ref('GatewayReport')) } }),
  {
    method: 'POST', path: '/v1/finance/accounts/:id/reports', tag: T, summary: 'Ask Xendit to generate a report',
    description: '(v1.16.0) Xendit\'s Report API for the period (from, to): TRANSACTIONS, BALANCE_HISTORY or UPCOMING_TRANSACTIONS (the next 30 days whatever the period), as CSV. 409 for a Duitku account; 502 when Xendit refuses (the key needs the Report permission). Audited as finance.report_requested.',
    pathParams: ID, query: PERIOD,
    body: { required: true, schema: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['TRANSACTIONS', 'BALANCE_HISTORY', 'UPCOMING_TRANSACTIONS'] } } }, example: { type: 'TRANSACTIONS' } },
    responses: { 201: { description: 'Requested', schema: { type: 'object', required: ['report'], properties: { report: ref('GatewayReport') } } } },
    errors: [404, 409, 422, 502],
  },
  acct('A Xendit report', '(v1.16.0) Its state, asked of Xendit while pending. link=true on a completed one: Xendit\'s download link (asked again, as links expire); audited as finance.report_downloaded.',
    '/reports/:rid', { type: 'object', required: ['report'], properties: { report: ref('GatewayReport') } }, { pathParams: { ...ID, rid: 'The report id.' }, query: [{ name: 'link', schema: { type: 'string', enum: ['true'] } }] }),
  {
    method: 'GET', path: '/v1/finance/method-costs', tag: T, summary: 'What each payment method costs',
    description: '(v1.16.0) Per gateway account the caller may see, over the period: per method the payments, amount, fees and VAT on fees, the average fee, the effective rate and the cost per 100,000 rupiah collected; for a Duitku account also what Duitku quotes today for 100,000 rupiah by method (getpaymentmethod; null when it does not answer).',
    query: PERIOD,
    responses: { 200: { description: 'Costs', schema: { type: 'object', required: ['per', 'accounts'], properties: { per: count, accounts: arrayOf({ type: 'object', properties: {
      id: { type: 'string' }, label: { type: 'string' }, provider: { type: 'string' }, fallback: { type: 'boolean' },
      methods: arrayOf({ type: 'object', properties: { channel: { type: 'string' }, payments: count, amount: money, fees: money, averageFee: { type: ['number', 'null'] }, rate: { type: ['number', 'null'] }, per100k: { type: ['number', 'null'] } } }),
      quoted: { type: ['array', 'null'], items: { type: 'object', properties: { channel: { type: 'string' }, fee: money } } },
    } }) } } } },
    errors: [400],
  },
  {
    method: 'GET', path: '/v1/finance/payout-transfers', tag: T, summary: 'Owner payouts through Duitku Disbursement',
    description: '(v1.16.0) The organisation\'s owner payouts, newest first (at most 300); open=true: only those not settled.',
    query: [{ name: 'open', schema: { type: 'string', enum: ['true'] } }],
    responses: { 200: { description: 'Payouts', schema: { type: 'object', required: ['transfers'], properties: { transfers: arrayOf(ref('PayoutTransfer')) } } } },
  },
  {
    method: 'POST', path: '/v1/finance/statements/:sid/payout', tag: T, summary: 'Request an owner payout through Duitku Disbursement',
    description: '(v1.16.0) For an owner statement due or part-paid, to the owner\'s saved bank account (it needs the bank code): Duitku\'s inquiry returns the holder\'s name, and the payout waits for a SECOND person\'s approval. amount (minor units) defaults to what is outstanding; never more. Paid only from the operator\'s OWN Duitku account. payment:write; audited as finance.owner_payout_requested.',
    pathParams: { sid: 'The owner statement id.' },
    body: { required: false, schema: { type: 'object', properties: { amount: { type: 'integer', minimum: 1 }, note: { type: 'string', maxLength: 300 }, rail: { type: 'string', enum: ['duitku', 'xendit'], description: '(v1.17.0) Default: the first available (Xendit first).' } } }, example: { amount: 1250000, note: 'October share' } },
    responses: { 201: { description: 'Requested, awaiting approval', schema: { type: 'object', required: ['transfer'], properties: { transfer: ref('PayoutTransfer') } } } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/finance/payout-transfers/:tid/approve', tag: T, summary: 'Approve and send an owner payout',
    description: '(v1.16.0) By a second person (never the requester: 403). Within the payout limits, with what is outstanding checked again and a fresh inquiry, the transfer is sent once; when Duitku confirms it the statement payment is recorded. Audited as finance.owner_payout_approved.',
    pathParams: { tid: 'The payout id.' },
    responses: { 200: { description: 'The payout after sending', schema: { type: 'object', required: ['transfer'], properties: { transfer: ref('PayoutTransfer') } } } },
    errors: [403, 404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/finance/payout-transfers/:tid/reject', tag: T, summary: 'Reject an owner payout before it is sent',
    description: '(v1.16.0) Awaiting approval only, with a reason. Audited as finance.owner_payout_rejected.',
    pathParams: { tid: 'The payout id.' },
    body: { required: true, schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 300 } } }, example: { reason: 'Wrong month' } },
    responses: { 200: { description: 'Rejected', schema: { type: 'object', required: ['transfer'], properties: { transfer: ref('PayoutTransfer') } } } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/finance/payout-transfers/:tid/resolve', tag: T, summary: 'Settle an owner payout Duitku never confirmed',
    description: '(v1.16.0) After checking Duitku\'s dashboard: succeeded records the statement payment; failed records nothing. Audited as finance.owner_payout_resolved.',
    pathParams: { tid: 'The payout id.' },
    body: { required: true, schema: { type: 'object', required: ['outcome', 'note'], properties: { outcome: { type: 'string', enum: ['succeeded', 'failed'] }, note: { type: 'string', minLength: 1, maxLength: 300 } } }, example: { outcome: 'succeeded', note: 'Dashboard: success' } },
    responses: { 200: { description: 'Settled', schema: { type: 'object', required: ['transfer'], properties: { transfer: ref('PayoutTransfer') } } } },
    errors: [404, 409, 422],
  },
  acct('Finance settings', '(v1.17.0) The accounting journal\'s chart of accounts (code and name per line: gateway, bank, revenue, refunds, fees, vatInput, whtPayable, ownerPayable) and the monthly close e-mail, with PlugSure\'s defaults and the labels.',
    '/settings', { type: 'object', required: ['settings'], properties: {
      settings: { type: 'object', properties: { journalAccounts: { type: 'object', additionalProperties: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } } }, closeEmail: { type: 'object', properties: { enabled: { type: 'boolean' }, recipients: arrayOf({ type: 'string' }), sentPeriod: nullable('string'), lastError: nullable('string'), lastAt: nullable('string', { format: 'date-time' }) } } } },
      defaults: { type: 'object', additionalProperties: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } } }, labels: { type: 'object', additionalProperties: { type: 'string' } },
    } }),
  {
    method: 'PUT', path: '/v1/finance/accounts/:id/settings', tag: T, summary: 'Save the finance settings',
    description: '(v1.17.0) journalAccounts: codes (1–20 letters, digits, . - /) and names by key; closeEmail: enabled and up to 10 recipients (sent through the e-mail channel of the caller\'s organisation). payment:write; audited as finance.settings_saved.',
    pathParams: ID,
    body: { required: true, schema: { type: 'object', properties: { journalAccounts: { type: 'object', additionalProperties: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } } }, closeEmail: { type: 'object', properties: { enabled: { type: 'boolean' }, recipients: arrayOf({ type: 'string', format: 'email' }) } } } },
      example: { journalAccounts: { revenue: { code: '4-1100', name: 'Pendapatan pengisian' } }, closeEmail: { enabled: true, recipients: ['finance@operator.co.id'] } } },
    responses: { 200: { description: 'Saved', schema: { type: 'object', required: ['settings'], properties: { settings: { type: 'object' } } } } },
    errors: [404, 422],
  },
  acct('Accounting journal', '(v1.17.0) The period as double-entry journal entries, one per day and kind (collections, gateway fees and VAT on fees, withholding tax, refunds, withdrawals to the bank, owner payouts), every entry balanced, with the account codes from the settings. format: xlsx (default; Journal, By account, About), csv, or json. Audited as finance.journal_exported.',
    '/journal', { type: 'object', properties: {
      lines: arrayOf({ type: 'object', properties: { date: { type: 'string', format: 'date' }, entry: { type: 'string' }, kind: { type: 'string' }, code: { type: 'string' }, account: { type: 'string' }, debit: money, credit: money, description: { type: 'string' } } }),
      totals: arrayOf({ type: 'object', properties: { code: { type: 'string' }, account: { type: 'string' }, debit: money, credit: money } }),
    } }, { query: [...PERIOD, { name: 'format', schema: { type: 'string', enum: ['xlsx', 'csv', 'json'] } }] }),
  {
    method: 'POST', path: '/v1/finance/accounts/:id/close-email/send', tag: T, summary: 'Send a month\'s close e-mail now',
    description: '(v1.17.0) The finance export (Excel and PDF) and the journal (Excel) for month (YYYY-MM, default last month) to the saved recipients, through the e-mail channel. 409 without an e-mail channel; 422 without recipients; 502 when the e-mail server refuses. Audited as finance.close_email_sent.',
    pathParams: ID,
    body: { required: false, schema: { type: 'object', properties: { month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } } }, example: { month: '2026-10' } },
    responses: { 200: { description: 'Sent', schema: { type: 'object', required: ['ok', 'month', 'to'], properties: { ok: { type: 'boolean' }, month: { type: 'string' }, to: arrayOf({ type: 'string' }), reference: nullable('string') } } } },
    errors: [404, 409, 422, 502],
  },
];
