import { type Op, type Schema, ref, arrayOf, nullable } from '../types.js';

const money = (d?: string): Schema => ({ type: 'integer', ...(d ? { description: d } : {}) });
const PERIOD = { name: 'period', required: true, description: 'Month, YYYY-MM.', schema: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } };
/** One statement and invoice per currency: never mixed (default IDR). */
const CURRENCY = { name: 'currency', description: 'The statement\'s currency: IDR (default), MYR or SGD. An account charging in several currencies has one statement and invoice per currency.', schema: { type: 'string', enum: ['IDR', 'MYR', 'SGD'] } };

export const schemas: Record<string, Schema> = {
  FleetSeller: {
    type: 'object',
    required: ['name', 'pkp'],
    properties: {
      name: { type: 'string' }, npwp: nullable('string'), nitku: nullable('string'), address: nullable('string'), pkp: { type: 'boolean' },
    },
  },
  FleetBillingSettings: {
    type: 'object',
    required: ['seller', 'settings'],
    properties: {
      seller: ref('FleetSeller'),
      settings: {
        type: 'object',
        required: ['prefix', 'paymentInstructions', 'efaktur'],
        properties: {
          prefix: { type: 'string', description: 'Invoice numbers are PREFIX/YYYY/MM/NNNN.' },
          paymentInstructions: { type: 'string' },
          efaktur: {
            type: 'object',
            properties: {
              itemOpt: { type: 'string', enum: ['A', 'B'], description: 'A = goods, B = services.' },
              itemCode: { type: 'string', description: '6-digit e-Faktur goods/service code.' },
              unitCode: { type: 'string', description: 'Coretax unit code, UM.nnnn.' },
              confirmed: { type: 'boolean', description: 'Confirmed with a tax adviser; required before export.' },
              confirmedBy: nullable('string'),
              confirmedAt: nullable('string', { format: 'date-time' }),
            },
          },
        },
      },
      efakturReady: { type: ['string', 'null'], description: 'Why e-Faktur export is not possible yet; null when it is.' },
    },
  },
  FleetAccount: {
    type: 'object',
    required: ['id', 'name', 'tax_id_kind', 'payment_terms_days', 'include_roaming'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string', description: 'The fleet name, as on its cards in the RFID centre.' },
      legal_name: nullable('string'),
      tax_id: { type: ['string', 'null'], description: '16-digit NPWP, or a NIK.' },
      tax_id_kind: { type: 'string', enum: ['TIN', 'NIK', 'Passport', 'Other'] },
      nitku: { type: ['string', 'null'], description: '22-digit NITKU; empty = head office.' },
      address: nullable('string'),
      billing_email: nullable('string'),
      contact_name: nullable('string'),
      phone: nullable('string'),
      payment_terms_days: { type: 'integer' },
      include_roaming: { type: 'boolean', description: 'Re-bill partner-network charging on the invoice.' },
      v2x_allowed: { type: 'boolean', description: 'Standing consent: the fleet’s cars give energy back at sites with a bidirectional programme.' },
      v2x_min_soc_percent: { type: 'integer', description: 'Battery floor for the fleet’s cars when giving energy back (the site’s floor applies if higher).' },
      notes: nullable('string'),
      archived_at: nullable('string', { format: 'date-time' }),
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      cards: { description: 'Card count (list) or the cards (detail).' },
      open_invoices: { type: 'integer' },
      outstanding_minor: { type: 'integer', description: 'Still owed on issued invoices, after credit notes.' },
      portal_users: { type: 'integer', description: 'Fleet customer portal users (list).' },
    },
  },
  FleetAccountDetail: {
    allOf: [ref('FleetAccount')],
    properties: {
      cards: arrayOf({
        type: 'object',
        required: ['id', 'uid', 'status'],
        properties: {
          id: { type: 'string', format: 'uuid' }, uid: { type: 'string' }, holder_name: nullable('string'), status: { type: 'string' }, account_type: { type: 'string' },
          blocked_by_customer: { type: 'boolean', description: 'Blocked by the fleet customer in its portal (it can unblock it again).' },
        },
      }),
      portalUsers: arrayOf({
        type: 'object',
        description: "The customer's own staff with fleet portal access (role fleet_customer on this account).",
        properties: {
          id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, email: { type: 'string' }, status: { type: 'string' },
          last_login_at: nullable('string', { format: 'date-time' }), must_change_password: { type: 'boolean' },
        },
      }),
    },
  },
  FleetAccountInput: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 200 },
      legalName: { type: 'string' },
      taxIdKind: { type: 'string', enum: ['TIN', 'NIK', 'Passport', 'Other'], default: 'TIN' },
      taxId: { type: 'string', description: 'NPWP (15 or 16 digits) or NIK (16 digits).' },
      nitku: { type: 'string', description: '22 digits; leave empty for the head office.' },
      address: { type: 'string' },
      billingEmail: { type: 'string', description: 'One or more addresses, comma-separated.' },
      contactName: { type: 'string' },
      phone: { type: 'string' },
      paymentTermsDays: { type: 'integer', minimum: 0, maximum: 120, default: 14 },
      includeRoaming: { type: 'boolean', default: true },
      v2xAllowed: { type: 'boolean', default: false, description: 'The fleet agrees that its cars give energy back at sites with a bidirectional programme (V2G / V2B). The credit per kWh reduces each session on the invoice.' },
      v2xMinSocPercent: { type: 'integer', minimum: 10, maximum: 95, default: 50, description: 'Battery floor for the fleet’s cars.' },
      notes: { type: 'string' },
    },
  },
  FleetSiteLine: {
    type: 'object',
    required: ['siteId', 'siteName', 'sessions', 'energyWh', 'subtotalMinor', 'localTaxMinor', 'taxableMinor', 'taxBaseMinor', 'taxMinor', 'totalMinor'],
    properties: {
      siteId: { type: 'string', format: 'uuid' }, siteName: { type: 'string' }, sessions: { type: 'integer' }, energyWh: { type: 'number' },
      subtotalMinor: money('Energy, service and admin fees.'), localTaxMinor: money(), taxableMinor: money('Price subject to PPN (e-Faktur TaxBase).'),
      taxBaseMinor: money('DPP nilai lain, 11/12 of the price.'), taxMinor: money(), totalMinor: money(), untaxedSessions: { type: 'integer' },
    },
  },
  FleetStatement: {
    type: 'object',
    description: 'A fleet account\'s month: a live draft of what is not yet invoiced, or the frozen invoice.',
    required: ['status', 'period', 'buyer', 'seller', 'sites', 'cards', 'sessions', 'roaming', 'totals', 'warnings'],
    properties: {
      status: { type: 'string', enum: ['draft', 'issued', 'paid', 'void'] },
      id: { type: ['string', 'null'], description: 'Invoice id (null for a draft).' },
      number: { type: ['string', 'null'], examples: ['FLT/2026/10/0001'] },
      period: { type: 'string' },
      periodLabel: { type: 'string' },
      ended: { type: 'boolean' },
      issuedDate: { type: 'string', format: 'date' },
      issuedAt: { type: 'string', format: 'date-time' },
      dueDate: { type: 'string', format: 'date' },
      paidAt: nullable('string', { format: 'date' }),
      paidReference: nullable('string'),
      voidedAt: nullable('string', { format: 'date-time' }),
      voidReason: nullable('string'),
      efakturExportedAt: nullable('string', { format: 'date-time' }),
      efakturNumber: nullable('string'),
      sentAt: nullable('string', { format: 'date-time' }),
      sentTo: nullable('string'),
      account: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } },
      buyer: {
        type: 'object',
        required: ['name', 'fleetName'],
        properties: {
          name: { type: 'string' }, fleetName: { type: 'string' }, taxId: nullable('string'), taxIdKind: { type: 'string' }, nitku: nullable('string'),
          address: nullable('string'), email: nullable('string'), contact: nullable('string'), termsDays: { type: 'integer' },
        },
      },
      seller: ref('FleetSeller'),
      paymentInstructions: { type: 'string' },
      sites: arrayOf(ref('FleetSiteLine')),
      cards: arrayOf({
        type: 'object',
        properties: { uid: { type: 'string' }, holder: nullable('string'), sessions: { type: 'integer' }, energyWh: { type: 'number' }, totalMinor: money(), roamingMinor: money() },
      }),
      sessions: arrayOf({
        type: 'object',
        required: ['id', 'startedAt', 'siteName', 'cardUid', 'energyWh', 'totalMinor'],
        properties: {
          id: { type: 'string', format: 'uuid' }, startedAt: { type: 'string', format: 'date-time' }, endedAt: nullable('string', { format: 'date-time' }),
          siteId: { type: 'string', format: 'uuid' }, siteName: { type: 'string' }, ocppIdentity: { type: 'string' }, cardUid: { type: 'string' }, holder: nullable('string'),
          energyWh: { type: 'number' }, subtotalMinor: money(), localTaxMinor: money(), taxBaseMinor: money(), ppnRateBps: { type: 'integer' }, taxMinor: money(),
          totalMinor: money('The session receipt total.'), taxableMinor: money(),
        },
      }),
      roaming: arrayOf({
        type: 'object',
        required: ['id', 'operator', 'cardUid', 'amountMinor'],
        properties: {
          id: { type: 'string', format: 'uuid' }, operator: { type: 'string' }, location: nullable('string'), cardUid: { type: 'string' },
          startedAt: { type: 'string', format: 'date-time' }, endedAt: { type: 'string', format: 'date-time' }, energyKwh: { type: 'number' },
          exclVat: { type: 'number' }, inclVat: nullable('number'), currency: { type: 'string' }, amountMinor: money('Re-billed amount.'),
        },
      }),
      fees: arrayOf({
        type: 'object',
        description: 'Membership fees billed on this invoice (plans with invoice billing).',
        properties: {
          subscriptionId: { type: 'string', format: 'uuid' }, planName: { type: 'string' }, subscriber: { type: 'string' }, feeMinor: money(),
          taxableMinor: money(), taxBaseMinor: money(), taxMinor: money(), totalMinor: money(), periodStart: { type: 'string', format: 'date-time' }, periodEnd: { type: 'string', format: 'date-time' },
        },
      }),
      totals: {
        type: 'object',
        required: ['sessions', 'energyWh', 'subtotalMinor', 'localTaxMinor', 'taxableMinor', 'taxBaseMinor', 'taxMinor', 'ownTotalMinor', 'roamingMinor', 'totalMinor'],
        properties: {
          sessions: { type: 'integer' }, energyWh: { type: 'number' }, subtotalMinor: money(), localTaxMinor: money(), taxableMinor: money(), taxBaseMinor: money(), taxMinor: money(),
          ownTotalMinor: money(), roamingSessions: { type: 'integer' }, roamingMinor: money(), feesMinor: money('Membership fees incl. PPN.'), totalMinor: money('Total due.'),
          receiptsTotalMinor: money('Sum of the per-session receipts.'), roundingMinor: money('Invoice minus receipts (PPN computed per invoice line).'),
        },
      },
      warnings: arrayOf({ type: 'string' }),
      creditedMinor: money('Credit notes settled against this invoice.'),
      priorCreditMinor: money('Earlier credit notes deducted from this invoice.'),
      balanceMinor: money('Still owed on an issued invoice (0 once paid or for a draft).'),
      priorCredits: arrayOf({
        type: 'object',
        description: 'Credit notes on earlier invoices deducted from this one.',
        properties: { id: { type: 'string', format: 'uuid' }, number: { type: 'string' }, invoiceNumber: { type: 'string' }, totalMinor: money() },
      }),
      creditNotes: arrayOf({
        type: 'object',
        description: 'Credit notes issued against this invoice.',
        properties: {
          id: { type: 'string', format: 'uuid' }, number: { type: 'string' }, status: { type: 'string', enum: ['issued', 'void'] },
          settlement: { type: 'string', enum: ['invoice', 'refund', 'next_invoice'] }, reason: { type: 'string' }, totalMinor: money(), taxMinor: money(),
          issuedAt: { type: 'string', format: 'date-time' }, refundedAt: nullable('string', { format: 'date' }), applied: { type: 'boolean' },
        },
      }),
    },
  },
  FleetInvoiceRow: {
    type: 'object',
    required: ['id', 'number', 'period', 'status', 'total_minor', 'account_id', 'account_name', 'overdue'],
    properties: {
      id: { type: 'string', format: 'uuid' }, number: { type: 'string' }, period: { type: 'string' },
      status: { type: 'string', enum: ['issued', 'paid', 'void'] }, issued_at: { type: 'string', format: 'date-time' }, due_date: { type: 'string', format: 'date' },
      sessions: { type: 'integer' }, energy_wh: { type: 'integer' }, tax_minor: { type: 'integer' }, roaming_total_minor: { type: 'integer' }, total_minor: { type: 'integer' },
      paid_at: nullable('string', { format: 'date' }), paid_reference: nullable('string'), voided_at: nullable('string', { format: 'date-time' }),
      efaktur_exported_at: nullable('string', { format: 'date-time' }), efaktur_number: nullable('string'), sent_at: nullable('string', { format: 'date-time' }),
      account_id: { type: 'string', format: 'uuid' }, account_name: { type: 'string' }, overdue: { type: 'boolean', description: 'Issued, something still owed, and past its due date.' },
      credited_minor: money('Credit notes settled against this invoice.'), prior_credit_minor: money('Earlier credit notes deducted from this invoice.'),
      balance_minor: money('Still owed: total less both kinds of credit (0 once paid).'),
    },
  },
  FleetCreditLine: {
    type: 'object',
    required: ['description', 'amountMinor', 'taxed'],
    properties: {
      description: { type: 'string' }, amountMinor: money('Credited, PPN included.'), taxed: { type: 'boolean', description: 'Carries PPN (split like an invoice line).' },
      taxableMinor: money('Price subject to PPN.'), taxBaseMinor: money('DPP nilai lain, 11/12 of the price.'), taxMinor: money('12% of the DPP.'),
    },
  },
  FleetCreditNote: {
    type: 'object',
    description: 'A numbered credit note against a fleet invoice. The invoice itself never changes.',
    required: ['id', 'number', 'status', 'settlement', 'reason', 'lines', 'taxBaseMinor', 'taxMinor', 'totalMinor', 'invoice'],
    properties: {
      id: { type: 'string', format: 'uuid' }, number: { type: 'string', examples: ['FLT-CN/2026/10/0001'] },
      status: { type: 'string', enum: ['issued', 'void'] },
      settlement: {
        type: 'string', enum: ['invoice', 'refund', 'next_invoice'],
        description: 'invoice: reduces what is owed on the (unpaid) invoice. refund: paid back (refundedAt once done). next_invoice: deducted from the account\'s next invoice (appliedInvoice once done).',
      },
      reason: { type: 'string' }, lines: arrayOf(ref('FleetCreditLine')),
      taxBaseMinor: money(), taxMinor: money(), totalMinor: money('Total credited, PPN included.'),
      issuedAt: { type: 'string', format: 'date-time' }, issuedDate: { type: 'string', format: 'date' }, issuedBy: nullable('string'),
      refundedAt: nullable('string', { format: 'date' }), refundReference: nullable('string'), appliedInvoice: { type: ['string', 'null'], description: 'The invoice it was deducted from.' },
      voidedAt: nullable('string', { format: 'date-time' }), voidReason: nullable('string'), sentAt: nullable('string', { format: 'date-time' }), sentTo: nullable('string'),
      invoice: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, number: { type: 'string' }, issuedDate: { type: 'string', format: 'date' }, periodLabel: { type: 'string' }, totalMinor: money(), efakturNumber: nullable('string'), status: { type: 'string' } },
      },
      accountId: { type: 'string', format: 'uuid' }, seller: ref('FleetSeller'), buyer: { type: 'object' },
    },
  },
  FleetCreditNoteRow: {
    type: 'object',
    required: ['id', 'number', 'status', 'settlement', 'total_minor', 'invoice_number', 'account_name', 'pending'],
    properties: {
      id: { type: 'string', format: 'uuid' }, number: { type: 'string' }, status: { type: 'string', enum: ['issued', 'void'] },
      settlement: { type: 'string', enum: ['invoice', 'refund', 'next_invoice'] }, reason: { type: 'string' }, total_minor: money(), tax_minor: money(),
      issued_at: { type: 'string', format: 'date-time' }, refunded_at: nullable('string', { format: 'date' }), refund_reference: nullable('string'),
      voided_at: nullable('string', { format: 'date-time' }), sent_at: nullable('string', { format: 'date-time' }),
      invoice_id: { type: 'string', format: 'uuid' }, invoice_number: { type: 'string' }, account_id: { type: 'string', format: 'uuid' }, account_name: { type: 'string' },
      applied_invoice: nullable('string'), pending: { type: 'boolean', description: 'Still to refund, or waiting for the next invoice.' },
    },
  },
};

const ID = { id: 'Fleet account id.' };
const INV = { id: 'Invoice id.' };
const CN = { id: 'Credit note id.' };
const ACC = { accountId: 'Fleet account id (one of the signed-in user\'s).' };
const T = 'Statements and billing' as const;
const SENT: Schema = { type: 'object', required: ['ok', 'to'], properties: { ok: { type: 'boolean' }, to: { type: 'string' }, reference: nullable('string') } };
const PORTAL = "Fleet customer portal: the console sign-in of a fleet customer's staff (role fleet_customer); API keys have no fleet grant.";

export const ops: Op[] = [
  {
    method: 'GET', path: '/v1/fleet-billing/settings', tag: T, summary: 'Get fleet billing settings',
    description: 'The seller details printed on invoices (from the organisation), the invoice number prefix, payment instructions, and the e-Faktur item settings with whether an export is possible.',
    responses: { 200: { description: 'Settings', schema: ref('FleetBillingSettings') } },
  },
  {
    method: 'PUT', path: '/v1/fleet-billing/settings', tag: T, summary: 'Save fleet billing settings',
    description: 'Seller NPWP / NITKU / address, invoice prefix, payment instructions and the e-Faktur item settings. Changing the item type, code or unit clears the tax-adviser confirmation, which must be given again before the next export.',
    body: {
      schema: {
        type: 'object',
        properties: {
          npwp: { type: 'string' }, nitku: { type: 'string' }, address: { type: 'string' }, prefix: { type: 'string', pattern: '^[A-Za-z0-9-]{2,12}$' },
          paymentInstructions: { type: 'string', maxLength: 1000 },
          efaktur: { type: 'object', properties: { itemOpt: { type: 'string', enum: ['A', 'B'] }, itemCode: { type: 'string' }, unitCode: { type: 'string' }, confirmed: { type: 'boolean' } } },
        },
      },
      example: { npwp: '0123456789012345', nitku: '0123456789012345000000', address: 'Jl. Jend. Sudirman Kav. 52, Jakarta Selatan', prefix: 'FLT', paymentInstructions: 'Transfer ke BCA 123-456-7890 a.n. PT Nusantara Charge' },
    },
    responses: { 200: { description: 'Saved', schema: ref('FleetBillingSettings') } },
    errors: [422],
  },
  {
    method: 'GET', path: '/v1/fleet-accounts', tag: T, summary: 'List fleet accounts',
    description: 'The companies fleet cards are billed to, with card count and what is outstanding. A card belongs to the account whose name is its fleet name in the RFID centre.',
    query: [{ name: 'archived', description: '1 to include archived accounts.', schema: { type: 'string', enum: ['0', '1'] } }],
    responses: { 200: { description: 'Accounts', schema: { type: 'object', required: ['accounts'], properties: { accounts: arrayOf(ref('FleetAccount')) } } } },
  },
  {
    method: 'POST', path: '/v1/fleet-accounts', tag: T, summary: 'Create a fleet account',
    body: { required: true, schema: ref('FleetAccountInput'), example: { name: 'PT Logistik Nusantara', legalName: 'PT Logistik Nusantara Tbk', taxIdKind: 'TIN', taxId: '0987654321098765', address: 'Jl. Gatot Subroto 12, Jakarta', billingEmail: 'ap@logistik.co.id', paymentTermsDays: 30 } },
    responses: { 201: { description: 'Created', schema: ref('FleetAccountDetail') } },
    errors: [409, 422],
  },
  {
    method: 'GET', path: '/v1/fleet-accounts/:id', tag: T, summary: 'Get a fleet account', pathParams: ID,
    responses: { 200: { description: 'The account with its cards', schema: ref('FleetAccountDetail') } },
    errors: [404],
  },
  {
    method: 'PUT', path: '/v1/fleet-accounts/:id', tag: T, summary: 'Update a fleet account', pathParams: ID,
    description: 'Renaming the account renames the fleet on its cards too. Issued invoices keep the details they were issued with.',
    body: { required: true, schema: ref('FleetAccountInput'), example: { billingEmail: 'finance@logistik.co.id, ap@logistik.co.id' } },
    responses: { 200: { description: 'Updated', schema: ref('FleetAccountDetail') } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/fleet-accounts/:id/archive', tag: T, summary: 'Archive or restore a fleet account', pathParams: ID,
    description: 'An archived account gets no new invoices; its cards keep working.',
    body: { required: false, schema: { type: 'object', properties: { archived: { type: 'boolean', default: true } } } },
    responses: { 200: { description: 'The account', schema: ref('FleetAccountDetail') } },
    errors: [404],
  },
  {
    method: 'PUT', path: '/v1/fleet-accounts/:id/cards', tag: T, summary: "Change a fleet account's cards", pathParams: ID,
    description: 'Adds cards (by UID) to the account — they become fleet cards with its fleet name — and removes others. UIDs that are not registered cards are returned in `unknown`.',
    body: { required: true, schema: { type: 'object', properties: { add: arrayOf({ type: 'string' }), remove: arrayOf({ type: 'string' }) } }, example: { add: ['FLEET-GRAB-0007'], remove: [] } },
    responses: { 200: { description: 'The account and any unknown UIDs', schema: { type: 'object', required: ['account', 'unknown'], properties: { account: ref('FleetAccountDetail'), unknown: arrayOf({ type: 'string' }) } } } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-accounts/:id/statement', tag: T, summary: "Get a fleet account's monthly statement", pathParams: ID,
    description: 'The month\'s live invoice, or else a draft of the sessions (by the month their charge record was issued) and partner-network charge records not yet invoiced. PPN is computed per site line: DPP nilai lain = 11/12 of the summed price, PPN = 12% of the DPP — the figures the e-Faktur line carries.',
    query: [PERIOD, CURRENCY],
    responses: { 200: { description: 'The statement', schema: ref('FleetStatement') } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-accounts/:id/statement.html', tag: T, summary: 'Print a monthly statement', pathParams: ID,
    description: 'The statement or invoice as an A4 printable page (print to PDF from the browser).',
    query: [PERIOD, CURRENCY],
    responses: { 200: { description: 'HTML', contentType: 'text/html', schema: { type: 'string' } } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-billing/periods/:period', tag: T, summary: 'Get the fleet billing month',
    pathParams: { period: 'Month, YYYY-MM.' },
    description: 'Every fleet account with charges or an invoice in the month: draft totals or the invoice, overdue and e-Faktur state, plus fleet-card sessions whose card is on no account.',
    responses: {
      200: {
        description: 'The month',
        schema: {
          type: 'object',
          required: ['period', 'ended', 'rows', 'unassigned'],
          properties: {
            period: { type: 'string' }, periodLabel: { type: 'string' }, current: { type: 'string', description: 'The current month.' }, ended: { type: 'boolean', description: 'Only an ended month can be invoiced.' },
            rows: arrayOf({
              type: 'object',
              required: ['accountId', 'name', 'status', 'sessions', 'totalMinor'],
              properties: {
                accountId: { type: 'string', format: 'uuid' }, name: { type: 'string' }, legalName: nullable('string'),
                status: { type: 'string', enum: ['draft', 'issued', 'paid'] }, invoiceId: nullable('string', { format: 'uuid' }), number: nullable('string'),
                sessions: { type: 'integer' }, energyWh: { type: 'number' }, taxMinor: { type: 'number' }, roamingMinor: { type: 'number' }, totalMinor: { type: 'number' },
                dueDate: nullable('string', { format: 'date' }), overdue: { type: 'boolean' }, efakturExported: { type: 'boolean' }, efakturNumber: nullable('string'),
                sent: { type: 'boolean' }, voided: { type: 'integer' }, warnings: { type: 'integer' },
              },
            }),
            unassigned: { type: 'object', properties: { sessions: { type: 'integer' }, totalMinor: { type: 'number' } } },
          },
        },
      },
    },
    errors: [400],
  },
  {
    method: 'POST', path: '/v1/fleet-billing/periods/:period/issue', tag: T, summary: "Issue every fleet account's invoice for a month",
    pathParams: { period: 'Month, YYYY-MM (must have ended).' },
    description: 'Issues an invoice for each active account with charges and no invoice yet. Accounts that cannot be invoiced are listed with the reason.',
    responses: {
      200: {
        description: 'What was issued',
        schema: {
          type: 'object', required: ['issued', 'skipped'],
          properties: {
            issued: arrayOf({ type: 'object', properties: { accountId: { type: 'string', format: 'uuid' }, number: { type: 'string' } } }),
            skipped: arrayOf({ type: 'object', properties: { accountId: { type: 'string', format: 'uuid' }, reason: { type: 'string' } } }),
          },
        },
      },
    },
    errors: [400],
  },
  {
    method: 'GET', path: '/v1/fleet-billing/periods/:period/efaktur.xml', tag: T, summary: 'Export e-Faktur (Coretax XML) for a month',
    pathParams: { period: 'Month, YYYY-MM.' },
    description:
      'The bulk-import XML for DJP Coretax (Faktur Pajak → Impor Data): one faktur per live invoice with PPN, transaction code 04 (PPN 12% on DPP nilai lain), one line per site. ' +
      'Refused (409) until the seller NPWP/NITKU and the e-Faktur item settings are saved and confirmed. Invoices whose buyer has no NPWP/NIK are skipped; ' +
      'the included and skipped invoices are in the X-PlugSure-Included and X-PlugSure-Skipped headers. Import, check the drafts in Coretax, then approve there.',
    query: [{ name: 'ids', description: 'Comma-separated invoice ids (default: all of the month).', schema: { type: 'string' } }],
    responses: { 200: { description: 'Coretax import XML', contentType: 'application/xml', schema: { type: 'string' } } },
    errors: [400, 409],
  },
  {
    method: 'POST', path: '/v1/fleet-invoices', tag: T, summary: "Issue a fleet account's invoice for a month",
    description: 'Freezes the month\'s statement as an invoice numbered PREFIX/YYYY/MM/NNNN (per organisation and year), due after the account\'s payment terms. Only a month that has ended; one live invoice per account and month; each session is on at most one live invoice.',
    body: { required: true, schema: { type: 'object', required: ['fleetAccountId', 'period'], properties: { fleetAccountId: { type: 'string', format: 'uuid' }, period: { type: 'string' }, currency: { type: 'string', enum: ['IDR', 'MYR', 'SGD'], description: 'Default IDR: one invoice per account, month and currency.' } } }, example: { fleetAccountId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', period: '2026-09' } },
    responses: { 201: { description: 'The invoice', schema: ref('FleetStatement') } },
    errors: [404, 409],
  },
  {
    method: 'GET', path: '/v1/fleet-invoices', tag: T, summary: 'List fleet invoices',
    query: [
      { name: 'accountId', description: 'One fleet account.', schema: { type: 'string', format: 'uuid' } },
      { name: 'status', schema: { type: 'string', enum: ['issued', 'paid', 'void'] } },
      { name: 'limit', schema: { type: 'integer', default: 200, maximum: 1000 } },
    ],
    responses: { 200: { description: 'Invoices, newest first', schema: { type: 'object', required: ['invoices'], properties: { invoices: arrayOf(ref('FleetInvoiceRow')) } } } },
  },
  {
    method: 'GET', path: '/v1/fleet-invoices/:id', tag: T, summary: 'Get a fleet invoice', pathParams: INV,
    responses: { 200: { description: 'The invoice', schema: ref('FleetStatement') } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-invoices/:id/invoice.html', tag: T, summary: 'Print a fleet invoice', pathParams: INV,
    description: 'A4 printable invoice with an appendix of sessions by card (print to PDF from the browser).',
    responses: { 200: { description: 'HTML', contentType: 'text/html', schema: { type: 'string' } } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-invoices/:id/invoice.csv', tag: T, summary: "Download a fleet invoice's session list", pathParams: INV,
    responses: { 200: { description: 'CSV', contentType: 'text/csv', schema: { type: 'string' } } },
    errors: [404],
  },
  {
    method: 'POST', path: '/v1/fleet-invoices/:id/pay', tag: T, summary: 'Record payment of a fleet invoice', pathParams: INV,
    body: { required: false, schema: { type: 'object', properties: { paidAt: { type: 'string', format: 'date' }, reference: { type: 'string' } } }, example: { paidAt: '2026-10-20', reference: 'BCA 2026102012345' } },
    responses: { 200: { description: 'The invoice', schema: ref('FleetStatement') } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/fleet-invoices/:id/void', tag: T, summary: 'Void a fleet invoice', pathParams: INV,
    description: 'The invoice keeps its number and is marked void; its sessions become billable again, so a corrected invoice can be issued. A paid invoice cannot be voided. If it was exported to e-Faktur, cancel or replace the faktur pajak in Coretax too (`fakturWarning`).',
    body: { required: true, schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 3 } } }, example: { reason: 'Wrong NPWP on the invoice' } },
    responses: { 200: { description: 'Voided', schema: { type: 'object', required: ['invoice'], properties: { invoice: ref('FleetStatement'), fakturWarning: nullable('string') } } } },
    errors: [404, 409, 422],
  },
  {
    method: 'PUT', path: '/v1/fleet-invoices/:id/faktur-number', tag: T, summary: 'Record the faktur pajak number', pathParams: INV,
    description: 'The faktur number Coretax assigned when the imported faktur was approved; printed on the invoice.',
    body: { required: true, schema: { type: 'object', properties: { number: { type: ['string', 'null'] } } }, example: { number: '04002600000012345' } },
    responses: { 200: { description: 'The invoice', schema: ref('FleetStatement') } },
    errors: [404],
  },
  {
    method: 'POST', path: '/v1/fleet-invoices/:id/send', tag: T, summary: 'E-mail a fleet invoice', pathParams: INV,
    description: "Sends the invoice to the account's billing e-mail (or `to`) through the organisation's e-mail channel (Govern → Alert routing), with the invoice (PDF) and the session list (CSV) attached.",
    body: { required: false, schema: { type: 'object', properties: { to: { type: 'string' } } } },
    responses: { 200: { description: 'Sent', schema: SENT } },
    errors: [404, 409, 422, 502],
  },
  {
    method: 'GET', path: '/v1/fleet-invoices/:id/invoice.pdf', tag: T, summary: 'Download a fleet invoice as PDF', pathParams: INV,
    description: 'The invoice as an A4 PDF: seller and buyer, the lines per site with DPP and PPN, partner networks and memberships, credits and the amount due, how to pay, and an appendix with every card and session.',
    responses: { 200: { description: 'PDF', contentType: 'application/pdf', schema: { type: 'string', format: 'binary' } } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-accounts/:id/statement.pdf', tag: T, summary: 'Download a monthly statement as PDF', pathParams: ID,
    description: 'The month as a PDF: the invoice once issued, otherwise the draft (marked as a draft).',
    query: [PERIOD, CURRENCY],
    responses: { 200: { description: 'PDF', contentType: 'application/pdf', schema: { type: 'string', format: 'binary' } } },
    errors: [400, 404],
  },
  {
    method: 'POST', path: '/v1/fleet-invoices/:id/credit-notes', tag: T, summary: 'Issue a credit note', pathParams: INV,
    description:
      'Credits all (`full: true`) or part (`lines`) of an issued or paid invoice with a numbered credit note (PREFIX-CN/YYYY/MM/NNNN). The invoice never changes. ' +
      'Amounts are what the customer gets back, PPN included; a line with PPN is split into price, DPP (11/12) and PPN (12% of DPP) like an invoice line. ' +
      'A credit cannot take back more than the invoice charged (in total, DPP or PPN), or more of its untaxed part than there was. ' +
      'On an unpaid invoice it reduces what is owed (settling the invoice when nothing is left); on a paid one it is refunded (default) or deducted from the next invoice (`settlement: next_invoice`). ' +
      '`fakturWarning` says when the invoice\'s faktur pajak was already reported, so a nota pembatalan is needed in Coretax. Audited.',
    body: {
      required: true,
      schema: {
        type: 'object', required: ['reason'],
        properties: {
          reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Printed on the credit note.' },
          full: { type: 'boolean', description: 'Credit everything still creditable on the invoice.' },
          lines: arrayOf({ type: 'object', required: ['description', 'amountMinor'], properties: { description: { type: 'string', minLength: 3, maxLength: 200 }, amountMinor: { type: 'integer', minimum: 1, description: 'PPN included.' }, taxed: { type: 'boolean', description: 'Default: whether the invoice carries PPN.' } } }),
          settlement: { type: 'string', enum: ['refund', 'next_invoice'], description: 'For a paid invoice only.' },
        },
      },
      example: { reason: 'Session on 12 August billed twice after a charger restart', lines: [{ description: 'Session 12 Aug 09:14, card ARM-0001 (duplicate)', amountMinor: 111000 }] },
    },
    responses: {
      201: {
        description: 'Issued',
        schema: { type: 'object', required: ['creditNote', 'settledInvoice'], properties: { creditNote: ref('FleetCreditNote'), settledInvoice: { type: 'boolean', description: 'The credit left nothing owed, so the invoice is now paid.' }, fakturWarning: nullable('string') } },
      },
    },
    errors: [404, 409, 422],
  },
  {
    method: 'GET', path: '/v1/fleet-credit-notes', tag: T, summary: 'List credit notes',
    description: 'Credit notes, newest first. `open=true` lists only those still to refund or waiting for the next invoice.',
    query: [
      { name: 'accountId', description: 'Only this fleet account.', schema: { type: 'string', format: 'uuid' } },
      { name: 'invoiceId', description: 'Only those against this invoice.', schema: { type: 'string', format: 'uuid' } },
      { name: 'open', description: 'Only credit notes with something still to do.', schema: { type: 'boolean' } },
    ],
    responses: { 200: { description: 'Credit notes', schema: { type: 'object', required: ['creditNotes'], properties: { creditNotes: arrayOf(ref('FleetCreditNoteRow')) } } } },
  },
  {
    method: 'GET', path: '/v1/fleet-credit-notes/:id', tag: T, summary: 'Get a credit note', pathParams: CN,
    responses: { 200: { description: 'The credit note', schema: ref('FleetCreditNote') } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-credit-notes/:id/credit-note.pdf', tag: T, summary: 'Download a credit note as PDF', pathParams: CN,
    description: 'The credit note as an A4 PDF: the invoice it credits, the reason, the lines with DPP and PPN, and how it is settled.',
    responses: { 200: { description: 'PDF', contentType: 'application/pdf', schema: { type: 'string', format: 'binary' } } },
    errors: [404],
  },
  {
    method: 'POST', path: '/v1/fleet-credit-notes/:id/refunded', tag: T, summary: 'Record a credit note as refunded', pathParams: CN,
    description: 'For a credit note settled by refund: the date the money was paid back (default today) and a reference. Audited.',
    body: { required: false, schema: { type: 'object', properties: { refundedAt: { type: 'string', format: 'date' }, reference: { type: 'string', maxLength: 200 } } }, example: { refundedAt: '2026-10-05', reference: 'BCA transfer 5521' } },
    responses: { 200: { description: 'The credit note', schema: ref('FleetCreditNote') } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/fleet-credit-notes/:id/void', tag: T, summary: 'Void a credit note', pathParams: CN,
    description: 'Voids a credit note issued in error, while nothing has been done with it: not refunded, not deducted from a later invoice, and (when it reduced an unpaid invoice) that invoice not paid since. What it reduced is owed again. Audited.',
    body: { required: true, schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 3 } } }, example: { reason: 'Issued against the wrong invoice' } },
    responses: { 200: { description: 'The credit note', schema: ref('FleetCreditNote') } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/fleet-credit-notes/:id/send', tag: T, summary: 'E-mail a credit note', pathParams: CN,
    description: "Sends the credit note (PDF) to the account's billing e-mail (or `to`) through the organisation's e-mail channel.",
    body: { required: false, schema: { type: 'object', properties: { to: { type: 'string' } } } },
    responses: { 200: { description: 'Sent', schema: SENT } },
    errors: [404, 409, 422, 502],
  },
  // ------------------------------------------------------------ fleet customer portal (console sign-in only)
  {
    method: 'GET', path: '/v1/fleet-portal', tag: T, summary: 'Fleet portal: my accounts', permissions: ['fleet:portal'], internal: PORTAL,
    responses: { 200: { description: 'The accounts this user may see, with what is owed', schema: { type: 'object', properties: { accounts: arrayOf({ type: 'object' }) } } } },
  },
  {
    method: 'GET', path: '/v1/fleet-portal/:accountId/invoices', tag: T, summary: 'Fleet portal: invoices and credit notes', pathParams: ACC, permissions: ['fleet:portal'], internal: PORTAL,
    responses: { 200: { description: 'Invoices (not void) and credit notes', schema: { type: 'object', properties: { invoices: arrayOf({ type: 'object' }), creditNotes: arrayOf({ type: 'object' }) } } } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-portal/:accountId/invoices/:id/invoice.pdf', tag: T, summary: 'Fleet portal: invoice PDF', pathParams: { ...ACC, ...INV }, permissions: ['fleet:portal'], internal: PORTAL,
    responses: { 200: { description: 'PDF', contentType: 'application/pdf', schema: { type: 'string', format: 'binary' } } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-portal/:accountId/invoices/:id/invoice.csv', tag: T, summary: 'Fleet portal: invoice session list', pathParams: { ...ACC, ...INV }, permissions: ['fleet:portal'], internal: PORTAL,
    responses: { 200: { description: 'CSV', contentType: 'text/csv', schema: { type: 'string' } } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-portal/:accountId/credit-notes/:id/credit-note.pdf', tag: T, summary: 'Fleet portal: credit note PDF', pathParams: { ...ACC, ...CN }, permissions: ['fleet:portal'], internal: PORTAL,
    responses: { 200: { description: 'PDF', contentType: 'application/pdf', schema: { type: 'string', format: 'binary' } } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/fleet-portal/:accountId/statement', tag: T, summary: 'Fleet portal: this month so far', pathParams: ACC, permissions: ['fleet:portal'], internal: PORTAL,
    query: [{ ...PERIOD, required: false }, CURRENCY],
    responses: { 200: { description: 'The statement (without the operator\'s warnings)', schema: { type: 'object' } } },
    errors: [400, 404],
  },
  {
    method: 'GET', path: '/v1/fleet-portal/:accountId/cards', tag: T, summary: 'Fleet portal: cards', pathParams: ACC, permissions: ['fleet:portal'], internal: PORTAL,
    responses: { 200: { description: 'Cards with their use this month', schema: { type: 'object', properties: { cards: arrayOf({ type: 'object' }) } } } },
    errors: [404],
  },
  {
    method: 'POST', path: '/v1/fleet-portal/:accountId/cards/:tokenId/block', tag: T, summary: 'Fleet portal: block or unblock a card', pathParams: { ...ACC, tokenId: 'Card id.' }, permissions: ['fleet:portal'], internal: PORTAL,
    body: { required: false, schema: { type: 'object', properties: { blocked: { type: 'boolean', default: true } } } },
    responses: { 200: { description: 'Done', schema: { type: 'object', properties: { ok: { type: 'boolean' }, status: { type: 'string' } } } } },
    errors: [404, 409],
  },
];
