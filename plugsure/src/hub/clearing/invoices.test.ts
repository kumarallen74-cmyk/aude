import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { feeInvoiceTax, platformTaxContext } from './invoices.js';
import { positionStatus } from './settlement.js';
import { feeInvoiceHtml, feeInvoicePdf, statementCsv, statementHtml, statementPdf } from './documents.js';

/** Hub fee invoices with the existing tax engines (§8.6), position status, and the documents. */
describe('hub fee invoice tax (existing engines, PlugSure entity context)', () => {
  const at = new Date('2026-10-20T03:00:00Z');

  test('ID entity, PKP: PPN 12 % on DPP 11/12; an Indonesian member withholds PPh 23 at 2 %', () => {
    const t = feeInvoiceTax({ country_code: 'ID', tax_registered: true, tax_id: '01.234' }, 'ID', 120_000, at);
    assert.equal(t.scheme, 'ID_PPN');
    assert.equal(t.taxBaseMinor, 110_000);
    assert.equal(t.taxMinor, 13_200);
    assert.equal(t.totalMinor, 133_200);
    assert.equal(t.whtMinor, 2_400);
    assert.equal(feeInvoiceTax({ country_code: 'ID', tax_registered: true, tax_id: null }, 'MY', 120_000, at).whtMinor, 0, 'no PPh 23 from a foreign member');
  });

  test('ID entity, not PKP: no PPN', () => {
    const t = feeInvoiceTax({ country_code: 'ID', tax_registered: false, tax_id: null }, 'ID', 120_000, at);
    assert.deepEqual([t.scheme, t.taxMinor, t.totalMinor], ['NONE', 0, 120_000]);
  });

  test('SG entity: GST 9 % when registered, none otherwise (cents)', () => {
    const g = feeInvoiceTax({ country_code: 'SG', tax_registered: true, tax_id: '2026X' }, 'SG', 4_455, at);
    assert.deepEqual([g.scheme, g.rateBps, g.taxMinor, g.totalMinor], ['SG_GST', 900, 401, 4_856]); // 400.95 → 401
    const n = feeInvoiceTax({ country_code: 'SG', tax_registered: false, tax_id: null }, 'SG', 4_455, at);
    assert.deepEqual([n.scheme, n.taxMinor, n.totalMinor], ['NONE', 0, 4_455]);
    assert.equal(platformTaxContext({ country_code: 'SG', tax_registered: true, tax_id: null }, at).scheme, 'SG_GST');
  });

  test('MY entity: service tax 8 % when registered [VERIFY], none otherwise', () => {
    const s = feeInvoiceTax({ country_code: 'MY', tax_registered: true, tax_id: 'W10' }, 'MY', 1_000, at);
    assert.deepEqual([s.scheme, s.rateBps, s.taxMinor, s.totalMinor], ['MY_SST', 800, 80, 1_080]);
    assert.equal(feeInvoiceTax({ country_code: 'MY', tax_registered: false, tax_id: null }, 'MY', 1_000, at).scheme, 'NONE');
  });

  test('cross-border (no entity in the member\'s country): reverse charge, no tax', () => {
    const r = feeInvoiceTax({ country_code: 'SG', tax_registered: true, tax_id: null }, 'MY', 1_000, at, true);
    assert.deepEqual([r.scheme, r.taxMinor, r.totalMinor, r.whtMinor], ['REVERSE_CHARGE', 0, 1_000, 0]);
  });
});

describe('settlement position status', () => {
  const p = (o: Partial<Parameters<typeof positionStatus>[0]> = {}) => positionStatus({ net_minor: 10_000, paid_minor: 0, status: 'open', due_date: '2026-11-15', unconfirmed: 0, ...o }, '2026-11-10');
  test('open → partially paid → paid → confirmed; overdue past the due date', () => {
    assert.equal(p(), 'open');
    assert.equal(p({ paid_minor: 4_000, unconfirmed: 1 }), 'partially_paid');
    assert.equal(p({ paid_minor: 10_000, unconfirmed: 1 }), 'paid');
    assert.equal(p({ paid_minor: 10_000, unconfirmed: 0 }), 'confirmed');
    assert.equal(positionStatus({ net_minor: 10_000, paid_minor: 4_000, status: 'partially_paid', due_date: '2026-11-15', unconfirmed: 0 }, '2026-11-16'), 'overdue');
    assert.equal(positionStatus({ net_minor: 10_000, paid_minor: 10_000, status: 'overdue', due_date: '2026-11-15', unconfirmed: 0 }, '2026-11-30'), 'confirmed', 'paid late');
    assert.equal(p({ status: 'nothing_due', net_minor: 0 }), 'nothing_due');
    assert.equal(p({ status: 'written_off' }), 'written_off');
  });
});

describe('statement and fee invoice documents', () => {
  const st = {
    number: 'PSH-ST-2026-MYR-000001', issued_at: '2026-11-16T02:00:00Z',
    data: {
      member: { id: 'm1', name: 'Kedai <Cas> Sdn Bhd', country: 'MY', taxId: null, kind: 'external' }, currency: 'MYR', period: '2026-10', cycle: 'monthly',
      timeZone: 'Asia/Kuala_Lumpur', dueDate: '2026-11-30', issuedAt: '2026-11-16T02:00:00Z',
      totals: { receivableMinor: 1_620, payableMinor: 330, netMinor: 1_290, feeCpoMinor: 49, feeEmspMinor: 0, feeNetMinor: 49, cdrsAsCpo: 1, cdrsAsEmsp: 1, energyAsCpoKwh: 12.5, energyAsEmspKwh: 3 },
      counterparties: [{ memberId: 'm2', name: 'Charge SG Pte Ltd', country: 'SG', receivableMinor: 1_620, payableMinor: 330, netMinor: 1_290, direction: 'receive', cdrCount: 2, dueDate: '2026-11-30', payeeBankDetails: null }],
      cdrs: [
        { cdrId: 'CDR-1', side: 'cpo', counterparty: 'Charge SG Pte Ltd', start: '2026-10-01T10:00:00Z', end: '2026-10-01T10:40:00Z', energyKwh: 12.5, exclMinor: 1_500, inclMinor: 1_620, amountMinor: 1_620, credit: false, feeMinor: 49 },
        { cdrId: '=HYPERLINK("x")', side: 'emsp', counterparty: 'Charge SG Pte Ltd', start: '2026-10-02T10:00:00Z', end: '2026-10-02T10:10:00Z', energyKwh: 3, exclMinor: 300, inclMinor: 330, amountMinor: 330, credit: false, feeMinor: 0 },
      ],
      carried: { count: 1, amountMinor: 999, items: [] }, feeInvoice: { id: 'i1', number: 'PSH-MY-2026-000001', totalMinor: 49 },
    },
  };
  test('statement HTML: escaped, amounts in the currency, not a tax invoice', () => {
    const h = statementHtml(st);
    assert.ok(h.includes('Kedai &lt;Cas&gt; Sdn Bhd'));
    assert.ok(h.includes('RM 16.20') && h.includes('RM 12.90') && h.includes('RM 0.49'));
    assert.ok(h.includes('not a tax invoice'));
    assert.ok(h.includes('carried to a later statement'));
  });
  test('statement PDF and CSV', () => {
    const pdf = statementPdf(st);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const csv = statementCsv(st);
    assert.equal(csv.split('\r\n').filter(Boolean).length, 3);
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'formula injection neutralised');
    assert.ok(csv.includes('"1620"'));
    // review180: a credit's negative amounts stay numbers; text starting with "-" is still neutralised.
    const cr = statementCsv({ ...st, data: { ...st.data, cdrs: [{ ...st.data.cdrs[0], cdrId: '-2+3', exclMinor: -1_500, inclMinor: -1_620, amountMinor: -1_620, credit: true }] } });
    assert.ok(cr.includes('"-1620"') && cr.includes('"-1500"') && !cr.includes(`"'-1620"`), cr);
    assert.ok(cr.includes(`"'-2+3"`), 'formula-like text still neutralised');
  });
  test('fee invoice HTML/PDF: tax lines, PPh 23 note, placeholder issuer flagged', () => {
    const inv = {
      number: 'PSH-ID-2026-000007', status: 'issued', net_minor: 120_000, tax_scheme: 'ID_PPN', tax_rate_bps: 1200, tax_base_minor: 110_000, tax_minor: 13_200,
      total_minor: 133_200, wht_expected_minor: 2_400,
      data: {
        kind: 'invoice', issuer: { country: 'ID', name: 'PT PlugSure Hub Indonesia [PLACEHOLDER]', taxId: null, address: 'Jakarta', placeholder: true },
        buyer: { name: 'PT Charge Indo', country: 'ID', taxId: '09.876' }, currency: 'IDR', period: '2026-10', issuedDate: '2026-11-16', dueDate: '2026-11-30',
        lines: [{ label: 'Hub clearing and roaming services as CPO (3 CDRs)', amountMinor: 120_000 }], tax: { scheme: 'ID_PPN', rateBps: 1200, label: 'PPN (VAT)', baseLabel: 'DPP' }, flags: ['placeholder_entity'],
      },
    };
    const h = feeInvoiceHtml(inv);
    assert.ok(h.includes('PLACEHOLDER ISSUER'));
    assert.ok(h.includes('PPh 23') && h.includes('DPP') && h.includes('PPN (VAT)'));
    assert.ok(h.includes('133,200'));
    assert.equal(feeInvoicePdf(inv).subarray(0, 5).toString(), '%PDF-');
  });
});
