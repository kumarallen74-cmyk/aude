import { config } from '../config.js';
import { PdfDoc, Flow, type Rgb } from './pdf.js';
import { creditRows } from './fleet-billing.js';
import { splitFees } from './fleet-calc.js';
import type { getCreditNote } from './fleet-credit.js';

/**
 * Fleet invoices and credit notes as PDF, laid out like the printable HTML: the
 * parties, the lines per site, the summary with DPP and PPN, credits and the
 * amount due, how to pay, and an appendix with every card and session.
 */

const idr = (v: unknown) => 'Rp ' + new Intl.NumberFormat('id-ID').format(Math.round(Number(v ?? 0)));
const kwh = (wh: number) => (wh / 1000).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (d: string | null | undefined) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: config.billing.timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const MUTED: Rgb = [0.36, 0.39, 0.44];

function banner(f: Flow, text: string, fill: Rgb, color: Rgb) {
  f.need(28);
  f.y += 8;
  f.doc.rect(f.left, f.y, f.width, 20, { fill });
  f.doc.text(f.left + 8, f.y + 13.5, text, { size: 9.5, bold: true, color });
  f.y += 20;
}

/** Seller and buyer side by side. */
function parties(f: Flow, seller: any, buyer: any) {
  const w = (f.width - 14) / 2;
  const box = (x: number, label: string, name: string, lines: string[]) => {
    let yy = f.y + 14;
    f.doc.text(x + 8, yy, label, { size: 8, color: MUTED });
    yy += 14;
    f.doc.text(x + 8, yy, name, { size: 10.5, bold: true });
    for (const l of lines.filter(Boolean)) { yy += 12; f.doc.text(x + 8, yy, l.slice(0, 90), { size: 8.5, color: MUTED }); }
    return yy + 10;
  };
  f.need(90);
  f.y += 10;
  const top = f.y;
  const h1 = box(f.left, 'From', seller.name, [seller.npwp ? `NPWP ${seller.npwp}${seller.pkp ? ' · PKP' : ''}` : '', ...String(seller.address ?? '').split(/\r?\n/)]);
  const buyerId = buyer.taxId ? `${buyer.taxIdKind === 'TIN' ? 'NPWP' : buyer.taxIdKind} ${buyer.taxId}` : '';
  const h2 = box(f.left + w + 14, 'Bill to', buyer.name, [buyerId, ...String(buyer.address ?? '').split(/\r?\n/), buyer.contact ? `Attn. ${buyer.contact}` : '']);
  const h = Math.max(h1, h2) - top;
  f.doc.rect(f.left, top, w, h, { stroke: [0.89, 0.9, 0.92] });
  f.doc.rect(f.left + w + 14, top, w, h, { stroke: [0.89, 0.9, 0.92] });
  f.y = top + h;
}

function footers(doc: PdfDoc, left: string) {
  const total = doc.pageCount;
  for (let i = 0; i < total; i++) {
    doc.onPage(i);
    doc.line(42, doc.height - 40, doc.width - 42, doc.height - 40, { color: [0.9, 0.91, 0.93] });
    doc.text(42, doc.height - 28, left, { size: 7.5, color: MUTED });
    doc.text(doc.width - 42, doc.height - 28, `Page ${i + 1} of ${total}`, { size: 7.5, color: MUTED, align: 'right' });
  }
}

export function invoicePdf(st: any): Buffer {
  const t = st.totals;
  const b = st.buyer;
  const s = st.seller;
  const title = st.number ? `Invoice ${st.number}` : `Draft statement ${st.period}`;
  const doc = new PdfDoc({ title, author: s.name, subject: `Charging for ${st.periodLabel} · ${b.fleetName}` });
  const f = new Flow(doc);

  // Header: title left, number and dates right.
  doc.text(f.left, f.y + 18, st.number ? 'Invoice' : 'Fleet statement (draft)', { size: 20, bold: true });
  doc.text(f.left, f.y + 34, `Charging for ${st.periodLabel} · ${b.fleetName}`, { size: 9, color: MUTED });
  const right = st.number
    ? [`No. ${st.number}`, `Date: ${dmy(st.issuedDate)}`, `Due: ${dmy(st.dueDate)}`, st.efakturNumber ? `Faktur pajak: ${st.efakturNumber}` : '']
    : ['DRAFT'];
  right.filter(Boolean).forEach((l, i) => doc.text(f.right, f.y + 14 + i * 12.5, l, { size: 9, bold: i === 0, align: 'right' }));
  f.y += 50;

  if (st.status === 'draft') banner(f, 'Draft — not an invoice. Figures change until the month is invoiced.', [0.88, 0.93, 1], [0.12, 0.23, 0.54]);
  else if (st.status === 'void') banner(f, `VOID — ${st.voidReason ?? ''}`, [1, 0.89, 0.89], [0.6, 0.11, 0.11]);
  else if (st.status === 'paid') banner(f, `Paid ${dmy(st.paidAt)}${st.paidReference ? ` · ${st.paidReference}` : ''}`, [0.86, 0.99, 0.91], [0.09, 0.4, 0.2]);

  parties(f, s, b);
  for (const w of st.warnings ?? []) f.para(`! ${w}`, { size: 8.5, color: [0.57, 0.25, 0.05] });

  f.heading('Charging at our stations');
  f.table(
    [{ label: 'Site', width: 3 }, { label: 'Sessions', width: 1, align: 'right' }, { label: 'kWh', width: 1.1, align: 'right' },
     { label: 'Energy & fees', width: 1.6, align: 'right' }, { label: 'PBJT-TL', width: 1.4, align: 'right' }, { label: 'DPP', width: 1.5, align: 'right' },
     { label: 'PPN', width: 1.4, align: 'right' }, { label: 'Amount', width: 1.6, align: 'right' }],
    st.sites.length
      ? st.sites.map((l: any) => ({
          cells: [l.siteName, String(l.sessions), kwh(l.energyWh), idr(l.subtotalIdr), idr(l.pbjtIdr), idr(l.dppIdr), idr(l.ppnIdr), idr(l.totalIdr)],
          sub: [l.untaxedSessions ? `${l.untaxedSessions} session(s) without PPN` : ''],
        }))
      : [{ cells: ['No sessions.', '', '', '', '', '', '', ''] }],
    { size: 8 },
  );
  if (st.roaming.length) {
    f.heading('Charging on partner networks (re-billed at cost)');
    f.table([{ label: 'When', width: 1.4 }, { label: 'Operator', width: 2.6 }, { label: 'Card', width: 1.8 }, { label: 'kWh', width: 0.9, align: 'right' }, { label: 'Amount', width: 1.4, align: 'right' }],
      st.roaming.map((x: any) => ({ cells: [when(x.startedAt), x.operator, x.cardUid, x.energyKwh.toLocaleString('id-ID', { maximumFractionDigits: 3 }), idr(x.amountIdr)], sub: ['', x.location ?? ''] })));
  }
  const fees = splitFees(st.fees);
  if (fees.memberships.length) {
    f.heading('Memberships');
    f.table([{ label: 'Plan', width: 2 }, { label: 'For', width: 2 }, { label: 'Fee', width: 1.2, align: 'right' }, { label: 'PPN', width: 1.2, align: 'right' }, { label: 'Amount', width: 1.3, align: 'right' }],
      fees.memberships.map((x: any) => ({ cells: [x.planName, x.subscriber, idr(x.feeIdr), idr(x.ppnIdr), idr(x.totalIdr)] })));
  }
  if (fees.reservations.length) {
    f.heading('Connector reservations');
    f.table([{ label: 'Held', width: 1.4 }, { label: 'Site', width: 2.2 }, { label: 'Card', width: 1.6 }, { label: 'Fee', width: 1, align: 'right' }, { label: 'PPN', width: 1, align: 'right' }, { label: 'Amount', width: 1.2, align: 'right' }],
      fees.reservations.map((x: any) => ({ cells: [when(x.periodStart), x.planName, x.subscriber, idr(x.feeIdr), idr(x.ppnIdr), idr(x.totalIdr)] })));
  }

  f.heading('Summary');
  const dppFrac = `${config.tax.ppnDppNumerator}/${config.tax.ppnDppDenominator}`;
  f.row('Energy, service and admin fees', idr(t.subtotalIdr));
  f.row('PBJT-TL (regional tax on electricity)', idr(t.pbjtIdr));
  f.row('Price subject to PPN', idr(t.taxBaseIdr), { muted: true });
  f.row(`DPP nilai lain (${dppFrac} × price)`, idr(t.dppIdr), { muted: true });
  f.row(`PPN ${config.tax.ppnRateBps / 100}% × DPP`, idr(t.ppnIdr));
  f.row('Charging at our stations', idr(t.ownTotalIdr), { bold: true });
  if (fees.membershipsIdr) f.row('Memberships (incl. PPN)', idr(fees.membershipsIdr));
  if (fees.reservationsIdr) f.row(`Connector reservations (${fees.reservations.length}, incl. PPN)`, idr(fees.reservationsIdr));
  if (t.roamingSessions) f.row(`Partner networks (${t.roamingSessions} session${t.roamingSessions === 1 ? '' : 's'}, as billed by the operators, incl. their taxes)`, idr(t.roamingIdr));
  const credits = creditRows(st);
  if (credits.length) {
    f.row('Invoice total', idr(t.totalIdr), { bold: true });
    for (const c of credits) f.row(c.label, `− ${idr(c.amountIdr)}`);
    const paid = st.status === 'paid';
    f.row(paid ? 'Paid' : 'Amount due', idr(paid ? t.totalIdr - credits.reduce((a, c) => a + c.amountIdr, 0) : st.balanceIdr), { bold: true, size: 12, rule: false });
  } else {
    f.row(st.number ? 'Total due' : 'Total so far', idr(t.totalIdr), { bold: true, size: 12, rule: false });
  }
  f.para(`${t.sessions} session${t.sessions === 1 ? '' : 's'} · ${kwh(t.energyWh)} kWh at our stations${t.roundingIdr ? ` · the per-session receipts add up to ${idr(t.receiptsTotalIdr)} (PPN is calculated per invoice line here; difference ${idr(t.roundingIdr)})` : ''}`, { size: 8, color: MUTED });

  if (st.paymentInstructions) { f.heading('How to pay'); f.para(st.paymentInstructions, { size: 9 }); }
  if (st.number && st.status === 'issued') f.para(`Please quote ${st.number} with your payment.`, { size: 9, bold: true });
  f.gap(6);
  f.para([
    `Sessions count in the month their charge record was issued (${config.billing.timeZone}). Each session also has its own tax receipt.`,
    s.pkp ? 'The faktur pajak for the PPN is issued through e-Faktur (Coretax) under this invoice number.' : 'The seller is not a PKP: no PPN is charged.',
    t.roamingSessions ? 'Partner-network charging is re-billed at the amount the partner operator charged; it is not part of our faktur pajak.' : '',
  ].filter(Boolean).join(' '), { size: 7.5, color: MUTED });

  if (st.sessions.length || st.roaming.length) {
    doc.addPage();
    f.y = f.top;
    f.heading('Appendix — sessions by card');
    f.table([{ label: 'Card', width: 2 }, { label: 'Holder', width: 2 }, { label: 'Sessions', width: 0.9, align: 'right' }, { label: 'kWh', width: 1, align: 'right' },
      { label: 'At our stations', width: 1.5, align: 'right' }, { label: 'Partner networks', width: 1.5, align: 'right' }],
      st.cards.map((c: any) => ({ cells: [c.uid, c.holder ?? '', String(c.sessions), kwh(c.energyWh), idr(c.totalIdr), c.roamingIdr ? idr(c.roamingIdr) : '—'] })), { size: 8 });
    if (st.sessions.length) {
      f.heading('Sessions at our stations (receipt amounts)');
      f.table([{ label: 'Started', width: 1.3 }, { label: 'Site / charger', width: 2.6 }, { label: 'Card', width: 2 }, { label: 'kWh', width: 0.9, align: 'right' }, { label: 'Receipt', width: 1.3, align: 'right' }],
        st.sessions.map((x: any) => ({ cells: [when(x.startedAt), x.siteName, x.cardUid, kwh(x.energyWh), idr(x.totalIdr)], sub: ['', x.ocppIdentity, x.holder ?? ''] })), { size: 7.5 });
    }
  }
  footers(doc, `${s.name} · ${title}`);
  return doc.toBuffer();
}

const SETTLEMENT_TEXT: Record<string, (c: any) => string> = {
  invoice: (c) => `This credit reduces the amount due on invoice ${c.invoice.number}.`,
  refund: (c) => (c.refundedAt ? `Refunded on ${dmy(c.refundedAt)}${c.refundReference ? ` (${c.refundReference})` : ''}.` : 'This amount will be refunded to you.'),
  next_invoice: (c) => (c.appliedInvoice ? `Deducted from invoice ${c.appliedInvoice}.` : 'This amount will be deducted from your next invoice.'),
};

export function creditNotePdf(c: Awaited<ReturnType<typeof getCreditNote>>): Buffer {
  const title = `Credit note ${c.number}`;
  const doc = new PdfDoc({ title, author: c.seller.name, subject: `Credits invoice ${c.invoice.number}` });
  const f = new Flow(doc);
  doc.text(f.left, f.y + 18, 'Credit note', { size: 20, bold: true });
  doc.text(f.left, f.y + 34, `Nota kredit · credits invoice ${c.invoice.number} of ${dmy(c.invoice.issuedDate)} (${c.invoice.periodLabel})`, { size: 9, color: MUTED });
  [`No. ${c.number}`, `Date: ${dmy(c.issuedDate)}`].forEach((l, i) => doc.text(f.right, f.y + 14 + i * 12.5, l, { size: 9, bold: i === 0, align: 'right' }));
  f.y += 50;
  if (c.status === 'void') banner(f, `VOID — ${c.voidReason ?? ''}`, [1, 0.89, 0.89], [0.6, 0.11, 0.11]);
  parties(f, c.seller, c.buyer);
  f.heading('Reason');
  f.para(c.reason, { size: 9.5 });
  f.heading('Credited');
  f.table([{ label: 'Description', width: 3.4 }, { label: 'Price', width: 1.3, align: 'right' }, { label: 'DPP', width: 1.3, align: 'right' }, { label: 'PPN', width: 1.2, align: 'right' }, { label: 'Amount', width: 1.4, align: 'right' }],
    c.lines.map((l) => ({ cells: [l.description, l.taxed ? idr(l.taxBaseIdr) : '—', l.taxed ? idr(l.dppIdr) : '—', l.taxed ? idr(l.ppnIdr) : '—', idr(l.amountIdr)], sub: [l.taxed ? '' : 'no PPN'] })));
  f.gap(4);
  f.row('DPP credited', idr(c.dppIdr), { muted: true });
  f.row(`PPN credited (${config.tax.ppnRateBps / 100}% × DPP)`, idr(c.ppnIdr));
  f.row('Total credited', idr(c.totalIdr), { bold: true, size: 12, rule: false });
  f.gap(8);
  f.para(SETTLEMENT_TEXT[c.settlement]!(c), { size: 9.5, bold: true });
  if (c.ppnIdr > 0) {
    f.para(`The PPN credited is reversed in e-Faktur (Coretax) with a nota pembatalan${c.invoice.efakturNumber ? ` for faktur pajak ${c.invoice.efakturNumber}` : ''} for invoice ${c.invoice.number}.`, { size: 7.5, color: MUTED });
  }
  footers(doc, `${c.seller.name} · ${title}`);
  return doc.toBuffer();
}
