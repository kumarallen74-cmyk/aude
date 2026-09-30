import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

import { splitInclusive, computeCredit } from './fleet-credit.js';
import { invoicePdf, creditNotePdf } from './fleet-pdf.js';
import { dppOf, ppnOf } from './fleet-calc.js';
import { FleetBillingError } from './fleet-billing.js';

const TAX = { ppnRateBps: 1200, dppNum: 11, dppDen: 12 };

/** The text of every page of a PDF from this writer (inflated streams, literal strings). */
function pdfText(buf: Buffer): string {
  const s = buf.toString('latin1');
  const out: string[] = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const page = inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1');
    for (const t of page.matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)) out.push(t[1]!.replace(/\\([0-7]{3}|.)/g, (_x, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : e)));
  }
  return out.join('\n');
}

describe('splitting an amount that includes PPN', () => {
  test('price + PPN = amount, PPN = 12% of DPP (11/12 of price)', () => {
    for (const amount of [111_000, 500_000, 1_234_567, 99_999, 1]) {
      const s = splitInclusive(amount, TAX);
      assert.equal(s.dppIdr, dppOf(s.taxBaseIdr, TAX));
      assert.equal(s.ppnIdr, ppnOf(s.dppIdr, TAX));
      assert.ok(Math.abs(s.amountIdr - amount) <= 1, `${amount} → ${s.amountIdr}`);
    }
    assert.deepEqual(splitInclusive(111_000, TAX), { amountIdr: 111_000, taxBaseIdr: 100_000, dppIdr: 91_667, ppnIdr: 11_000 });
  });
});

describe('credit note arithmetic', () => {
  const inv = { totalIdr: 1_000_000, dppIdr: 800_000, ppnIdr: 96_000 }; // taxed gross ≈ 872,727 + 96,000; the rest is partner networks
  const bad = (fn: () => unknown, status: number, re: RegExp) =>
    assert.throws(fn, (e: unknown) => e instanceof FleetBillingError && e.status === status && re.test(e.message));

  test('full credit takes back exactly what is left', () => {
    const c = computeCredit(inv, true, { full: true }, TAX, 'FLT/2026/08/0001');
    assert.deepEqual([c.totalIdr, c.dppIdr, c.ppnIdr, c.lines.length], [1_000_000, 800_000, 96_000, 1]);
    assert.match(c.lines[0]!.description, /Full credit of invoice FLT\/2026\/08\/0001/);
  });
  test('lines with PPN are split like invoice lines; lines without carry none', () => {
    const c = computeCredit(inv, true, { lines: [{ description: 'Disputed session 12 Aug', amountIdr: 111_000 }, { description: 'Partner fee refund', amountIdr: 5_000, taxed: false }] }, TAX, 'X');
    assert.equal(c.totalIdr, 116_000);
    assert.equal(c.ppnIdr, 11_000);
    assert.equal(c.dppIdr, 91_667);
  });
  test('refused: nothing left, too much, too much PPN, untaxed beyond the untaxed part, PPN on an invoice without', () => {
    bad(() => computeCredit({ totalIdr: 0, dppIdr: 0, ppnIdr: 0 }, true, { full: true }, TAX, 'X'), 409, /already been credited/);
    bad(() => computeCredit(inv, true, { lines: [{ description: 'Too much', amountIdr: 1_000_001, taxed: false }] }, TAX, 'X'), 422, /left to credit/);
    bad(() => computeCredit({ totalIdr: 1_000_000, dppIdr: 10_000, ppnIdr: 1_200 }, true, { lines: [{ description: 'Too much PPN', amountIdr: 200_000 }] }, TAX, 'X'), 422, /PPN is left/);
    bad(() => computeCredit(inv, true, { lines: [{ description: 'No PPN please', amountIdr: 200_000, taxed: false }] }, TAX, 'X'), 422, /carries no PPN; credit the rest with PPN/);
    bad(() => computeCredit({ totalIdr: 50_000, dppIdr: 0, ppnIdr: 0 }, false, { lines: [{ description: 'With PPN', amountIdr: 10_000, taxed: true }] }, TAX, 'X'), 422, /carries no PPN, so a credit cannot/);
    bad(() => computeCredit(inv, true, { lines: [] }, TAX, 'X'), 422, /at least one line/);
    bad(() => computeCredit(inv, true, { lines: [{ description: 'x', amountIdr: 10 }] }, TAX, 'X'), 422, /say what is credited/);
    bad(() => computeCredit(inv, true, { lines: [{ description: 'Half rupiah', amountIdr: 10.5 }] }, TAX, 'X'), 422, /whole number/);
  });
});

describe('fleet documents as PDF', () => {
  const seller = { name: 'PT Nusantara Charge', npwp: '0012345678901000', pkp: true, address: 'Jl. Sudirman 1\nJakarta' };
  const buyer = { name: 'PT Armada Logistik', fleetName: 'Armada', taxId: '0098765432101000', taxIdKind: 'TIN', address: 'Jl. Gatot Subroto 9', contact: 'Rina', email: 'ap@armada.co.id' };
  const st = {
    status: 'issued', number: 'FLT/2026/09/0007', issuedDate: '2026-09-01', dueDate: '2026-09-15', period: '2026-08', periodLabel: 'August 2026',
    seller, buyer, paymentInstructions: 'BCA 123-456-7890 a.n. PT Nusantara Charge', efakturNumber: '04002600000123',
    sites: [{ siteName: 'Grand Indonesia', sessions: 12, energyWh: 250_500, subtotalIdr: 900_000, pbjtIdr: 90_000, dppIdr: 907_500, ppnIdr: 108_900, totalIdr: 1_098_900, untaxedSessions: 0 }],
    roaming: [], fees: [], cards: [{ uid: 'ARM-0001', holder: 'Budi', sessions: 12, energyWh: 250_500, totalIdr: 1_098_900, roamingIdr: 0 }],
    sessions: Array.from({ length: 60 }, (_, i) => ({ startedAt: '2026-08-12T02:00:00Z', siteName: 'Grand Indonesia', ocppIdentity: 'GI-DC-01', cardUid: 'ARM-0001', holder: 'Budi', energyWh: 20_875, totalIdr: 91_575 + i })),
    totals: { sessions: 12, energyWh: 250_500, subtotalIdr: 900_000, pbjtIdr: 90_000, taxBaseIdr: 990_000, dppIdr: 907_500, ppnIdr: 108_900, ownTotalIdr: 1_098_900, roamingSessions: 0, roamingIdr: 0, feesIdr: 0, totalIdr: 1_098_900, receiptsTotalIdr: 1_098_900, roundingIdr: 0 },
    priorCredits: [{ number: 'FLT-CN/2026/08/0002', invoiceNumber: 'FLT/2026/08/0005', totalIdr: 50_000 }],
    creditNotes: [{ number: 'FLT-CN/2026/09/0001', status: 'issued', settlement: 'invoice', reason: 'Disputed session', totalIdr: 111_000 }],
    balanceIdr: 1_098_900 - 50_000 - 111_000,
  };

  test('invoice: number, parties, lines, credits and amount due, appendix, page footers', () => {
    const buf = invoicePdf(st);
    assert.ok(buf.subarray(0, 8).toString() === '%PDF-1.4');
    const txt = pdfText(buf);
    for (const s of ['Invoice', 'No. FLT/2026/09/0007', 'Due: 15 September 2026', 'PT Nusantara Charge', 'PT Armada Logistik', 'NPWP 0098765432101000',
      'Grand Indonesia', 'Faktur pajak: 04002600000123', 'Invoice total', 'Credit note FLT-CN/2026/08/0002 (on invoice FLT/2026/08/0005)',
      'Credit note FLT-CN/2026/09/0001: Disputed session', 'Amount due', 'BCA 123-456-7890 a.n. PT Nusantara Charge', 'Please quote FLT/2026/09/0007 with your payment.',
      'APPENDIX \x97 SESSIONS BY CARD', 'GI-DC-01']) {
      assert.ok(txt.includes(s), `missing: ${s}`);
    }
    assert.ok(txt.includes(`Rp ${new Intl.NumberFormat('id-ID').format(937_900)}`), 'the amount due');
    assert.ok(txt.includes('\x96 Rp 50.000') && !txt.includes('?'), 'credits print with a minus, and nothing prints as ?');
    const pages = Number(/\/Count (\d+)/.exec(buf.toString('latin1'))![1]);
    assert.ok(pages >= 3, `pages ${pages}`);
    assert.ok(txt.includes(`Page ${pages} of ${pages}`));
  });

  test('draft statement and paid invoice banners', () => {
    assert.ok(pdfText(invoicePdf({ ...st, status: 'draft', number: null, creditNotes: [], priorCredits: [] })).includes('Draft \x97 not an invoice.'));
    assert.ok(pdfText(invoicePdf({ ...st, status: 'paid', paidAt: '2026-09-10', paidReference: 'BCA 889', creditNotes: [], priorCredits: [] })).includes('Paid 10 September 2026 \xb7 BCA 889'));
  });

  test('credit note: what it credits, the tax reversed and how it is settled', () => {
    const cn = {
      id: 'x', number: 'FLT-CN/2026/09/0001', status: 'issued', settlement: 'refund', reason: 'Charger fault: session billed twice',
      lines: [{ description: 'Session 12 Aug billed twice', amountIdr: 111_000, taxed: true, taxBaseIdr: 100_000, dppIdr: 91_667, ppnIdr: 11_000 }],
      dppIdr: 91_667, ppnIdr: 11_000, totalIdr: 111_000, issuedAt: '2026-09-20T03:00:00Z', issuedDate: '2026-09-20', issuedBy: 'u', refundedAt: null, refundReference: null,
      appliedInvoice: null, voidedAt: null, voidReason: null, sentAt: null, sentTo: null,
      invoice: { id: 'i', number: 'FLT/2026/09/0007', issuedDate: '2026-09-01', periodLabel: 'August 2026', totalIdr: 1_098_900, efakturNumber: '04002600000123', status: 'paid' },
      accountId: 'a', seller, buyer,
    } as any;
    const txt = pdfText(creditNotePdf(cn));
    for (const s of ['Credit note', 'No. FLT-CN/2026/09/0001', 'credits invoice FLT/2026/09/0007 of 1 September 2026 (August 2026)', 'Charger fault: session billed twice',
      'Session 12 Aug billed twice', 'Total credited', 'This amount will be refunded to you.', 'nota pembatalan for faktur pajak 04002600000123']) {
      assert.ok(txt.includes(s), `missing: ${s}`);
    }
    assert.ok(pdfText(creditNotePdf({ ...cn, settlement: 'next_invoice', appliedInvoice: 'FLT/2026/10/0003' })).includes('Deducted from invoice FLT/2026/10/0003.'));
  });
});
