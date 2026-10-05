import { formatMoney, isCurrency, type CurrencyCode } from '../../domain/money.js';
import { PdfDoc, Flow, type Rgb } from '../../services/pdf.js';

/**
 * Hub statements and fee invoices as HTML (printable), PDF and CSV — laid out like the platform commission
 * statements (services/commission.ts statementHtml) and fleet invoices (services/fleet-pdf.ts): the same
 * page, table and summary styles, the same PdfDoc/Flow machinery. Rendered from the frozen `data` of the
 * statement / invoice, so a document never changes after issue. All amounts are minor units of ONE currency.
 *
 * A hub statement is NOT a tax invoice: the CPO invoices the eMSP itself (§8.1). The fee invoice is PlugSure's
 * tax invoice for its commission.
 */

const MUTED: Rgb = [0.36, 0.39, 0.44];
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
const curOf = (c: unknown): CurrencyCode => {
  if (!isCurrency(c)) throw new Error(`unsupported currency ${String(c)}`);
  return c;
};
const money = (cur: CurrencyCode) => (n: unknown) => formatMoney(Math.round(Number(n ?? 0)), cur, 'en');
/** Plain ASCII sign for the PDF fonts (WinAnsi). */
const pdfMoney = (cur: CurrencyCode) => (n: unknown) => formatMoney(Math.round(Number(n ?? 0)), cur, 'en');
const day = (d: unknown) => (d ? new Date(String(d).length === 10 ? `${d}T00:00:00Z` : String(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '-');
const when = (d: unknown, tz: string) => (d ? new Date(String(d)).toLocaleString('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
const kwh = (n: unknown) => Number(n ?? 0).toLocaleString('en-GB', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export function periodLabel(period: string, cycle: string): string {
  if (cycle === 'weekly') return `week of ${day(period)}`;
  const [y, m] = period.split('-');
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(m) - 1]} ${y}`;
}

const STYLE = `
  body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:0;background:#f4f5f7}
  .page{max-width:900px;margin:24px auto;background:#fff;padding:32px 36px;border:1px solid #e3e6ea;border-radius:10px}
  h1{font-size:20px;margin:0}h2{font-size:15px;margin:22px 0 6px}.muted{color:#5b6470;font-size:12.5px}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th,td{padding:7px 6px;border-bottom:1px solid #eceef1;text-align:left;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#5b6470}
  .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .grand td{font-weight:700;font-size:16px;border-top:2px solid #111;border-bottom:0}
  .head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}
  .warn{background:#fef3c7;color:#92400e;padding:8px 10px;border-radius:6px;margin-top:12px;font-size:12.5px}
  .note{margin-top:18px;font-size:11.5px;color:#5b6470}
  @media print{body{background:#fff}.page{border:0;margin:0;max-width:none}}`;

export interface StatementDoc { number: string; issued_at: string | Date; data: any }

// ─────────────────────────────────────────────────────────── statement

export function statementHtml(st: StatementDoc): string {
  const d = st.data;
  const cur = curOf(d.currency);
  const m = money(cur);
  const t = d.totals;
  const cps = (d.counterparties as any[]).map((c) => `<tr><td><b>${esc(c.name)}</b><div class="muted">${esc(c.country)} · ${c.cdrCount} CDR${c.cdrCount === 1 ? '' : 's'}</div>
    ${c.direction === 'pay' && c.payeeBankDetails ? `<div class="muted">Pay to: ${esc(c.payeeBankDetails)}</div>` : ''}</td>
    <td class="n">${m(c.receivableMinor)}</td><td class="n">${m(c.payableMinor)}</td>
    <td class="n"><b>${c.direction === 'receive' ? `You receive ${m(c.netMinor)}` : c.direction === 'pay' ? `You pay ${m(-c.netMinor)}` : 'Nothing due'}</b></td></tr>`).join('');
  const rows = (d.cdrs as any[]).slice(0, 2000).map((x) => `<tr><td>${esc(x.cdrId)}${x.credit ? ` <span class="muted">credit of ${esc(x.credits)}</span>` : ''}<div class="muted">${esc(x.counterparty)}</div></td>
    <td>${x.side === 'cpo' ? 'CPO (receivable)' : 'eMSP (payable)'}</td><td>${esc(when(x.start, d.timeZone))}</td><td class="n">${kwh(x.energyKwh)}</td>
    <td class="n">${m(x.exclMinor)}</td><td class="n">${x.inclMinor == null ? '-' : m(x.inclMinor)}</td><td class="n">${m(x.feeMinor)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hub statement ${esc(st.number)}</title><style>${STYLE}</style></head><body><div class="page">
<div class="head"><div><h1>PlugSure Hub — clearing statement</h1>
<div class="muted">Roaming CDRs cleared through PlugSure Hub · ${esc(cur)} · ${esc(periodLabel(d.period, d.cycle))} (${esc(d.timeZone)})</div></div>
<div class="muted" style="text-align:right">No. ${esc(st.number)}<br>Issued: ${esc(day(String(d.issuedAt).slice(0, 10)))}<br>Payment due: ${esc(day(d.dueDate))}</div></div>
<p class="muted" style="margin-top:14px">Member: <b style="color:#111">${esc(d.member.name)}</b> · ${esc(d.member.country)}${d.member.taxId ? ` · Tax ID ${esc(d.member.taxId)}` : ''}</p>
<h2>By counterparty (bilateral netting)</h2>
<table><thead><tr><th>Counterparty</th><th class="n">You receive (as CPO)</th><th class="n">You owe (as eMSP)</th><th class="n">Net</th></tr></thead>
<tbody>${cps || '<tr><td colspan="4" class="muted">No settled CDRs in this period.</td></tr>'}</tbody></table>
<h2>Summary</h2>
<table><tbody>
<tr><td>Receivable as CPO (${t.cdrsAsCpo} CDRs, ${kwh(t.energyAsCpoKwh)} kWh)</td><td class="n">${m(t.receivableMinor)}</td></tr>
<tr><td>Payable as eMSP (${t.cdrsAsEmsp} CDRs, ${kwh(t.energyAsEmspKwh)} kWh)</td><td class="n">${m(t.payableMinor)}</td></tr>
<tr class="grand"><td>Net ${t.netMinor >= 0 ? 'receivable' : 'payable'}</td><td class="n">${m(Math.abs(t.netMinor))}</td></tr>
</tbody></table>
<h2>Hub commission</h2>
<table><tbody>
<tr><td>As CPO</td><td class="n">${m(t.feeCpoMinor)}</td></tr>
<tr><td>As eMSP</td><td class="n">${m(t.feeEmspMinor)}</td></tr>
<tr><td><b>Commission before tax</b>${d.feeInvoice ? ` — invoiced separately on ${esc(d.feeInvoice.number)} (total ${m(d.feeInvoice.totalMinor)} incl. tax)` : ''}</td><td class="n"><b>${m(t.feeNetMinor)}</b></td></tr>
</tbody></table>
${d.carried?.count ? `<div class="warn">${d.carried.count} CDR(s) of yours (${m(d.carried.amountMinor)}) were still pending, disputed or held at the cut-off and are carried to a later statement.</div>` : ''}
<h2>CDRs</h2>
<table><thead><tr><th>CDR</th><th>Side</th><th>Start</th><th class="n">kWh</th><th class="n">Excl. tax</th><th class="n">Incl. tax</th><th class="n">Hub fee</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="muted">None.</td></tr>'}</tbody></table>
<div class="note">Amounts are the CDR totals as sent by the CPO, in ${esc(cur)}; netting is incl. tax (excl. tax where a CDR had no incl_vat). Each CPO invoices its eMSP counterparties itself:
this statement is <b>not a tax invoice</b>. Payments are made directly between members (PlugSure holds no funds) and recorded in the hub console.
Credit CDRs offset the CDRs they credit. Disputed or pending CDRs at the cut-off are settled in a later period.</div>
</div></body></html>`;
}

export function statementPdf(st: StatementDoc): Buffer {
  const d = st.data;
  const cur = curOf(d.currency);
  const m = pdfMoney(cur);
  const t = d.totals;
  const title = `Hub statement ${st.number}`;
  const doc = new PdfDoc({ title, author: 'PlugSure Hub', subject: `${cur} ${periodLabel(d.period, d.cycle)} · ${d.member.name}` });
  const f = new Flow(doc);
  doc.text(f.left, f.y + 18, 'Clearing statement', { size: 20, bold: true });
  doc.text(f.left, f.y + 34, `PlugSure Hub · ${cur} · ${periodLabel(d.period, d.cycle)} (${d.timeZone})`, { size: 9, color: MUTED });
  [`No. ${st.number}`, `Issued: ${day(String(d.issuedAt).slice(0, 10))}`, `Payment due: ${day(d.dueDate)}`].forEach((l, i) => doc.text(f.right, f.y + 14 + i * 12.5, l, { size: 9, bold: i === 0, align: 'right' }));
  f.y += 50;
  f.para(`Member: ${d.member.name} (${d.member.country})${d.member.taxId ? ` · Tax ID ${d.member.taxId}` : ''}`, { size: 10, bold: true });
  f.heading('By counterparty (bilateral netting)');
  f.table([{ label: 'Counterparty', width: 3 }, { label: 'Receivable (CPO)', width: 1.7, align: 'right' }, { label: 'Payable (eMSP)', width: 1.7, align: 'right' }, { label: 'Net', width: 2, align: 'right' }],
    (d.counterparties as any[]).length ? (d.counterparties as any[]).map((c) => ({
      cells: [c.name, m(c.receivableMinor), m(c.payableMinor), c.direction === 'receive' ? `receive ${m(c.netMinor)}` : c.direction === 'pay' ? `pay ${m(-c.netMinor)}` : 'nothing due'],
      sub: [c.direction === 'pay' && c.payeeBankDetails ? `Pay to: ${c.payeeBankDetails}` : `${c.cdrCount} CDR(s)`],
    })) : [{ cells: ['No settled CDRs in this period.', '', '', ''] }], { size: 8.5 });
  f.heading('Summary');
  f.row(`Receivable as CPO (${t.cdrsAsCpo} CDRs, ${kwh(t.energyAsCpoKwh)} kWh)`, m(t.receivableMinor));
  f.row(`Payable as eMSP (${t.cdrsAsEmsp} CDRs, ${kwh(t.energyAsEmspKwh)} kWh)`, m(t.payableMinor));
  f.row(`Net ${t.netMinor >= 0 ? 'receivable' : 'payable'}`, m(Math.abs(t.netMinor)), { bold: true, size: 12 });
  f.heading('Hub commission (invoiced separately)');
  f.row('As CPO', m(t.feeCpoMinor));
  f.row('As eMSP', m(t.feeEmspMinor));
  f.row(`Commission before tax${d.feeInvoice ? ` (invoice ${d.feeInvoice.number})` : ''}`, m(t.feeNetMinor), { bold: true });
  if (d.carried?.count) f.para(`${d.carried.count} CDR(s) (${m(d.carried.amountMinor)}) pending, disputed or held at the cut-off are carried to a later statement.`, { size: 8.5, color: [0.57, 0.25, 0.05] });
  f.gap(6);
  f.para('This statement is not a tax invoice: each CPO invoices its eMSP counterparties itself. Payments are made directly between members (PlugSure holds no funds). Credit CDRs offset the CDRs they credit.', { size: 7.5, color: MUTED });
  if ((d.cdrs as any[]).length) {
    doc.addPage();
    f.y = f.top;
    f.heading('Appendix - CDRs');
    f.table([{ label: 'CDR', width: 2.2 }, { label: 'Side', width: 0.9 }, { label: 'Start', width: 1.4 }, { label: 'kWh', width: 0.9, align: 'right' },
      { label: 'Excl. tax', width: 1.3, align: 'right' }, { label: 'Incl. tax', width: 1.3, align: 'right' }, { label: 'Fee', width: 1.1, align: 'right' }],
    (d.cdrs as any[]).slice(0, 5000).map((x) => ({
      cells: [x.cdrId, x.side === 'cpo' ? 'CPO' : 'eMSP', when(x.start, d.timeZone), kwh(x.energyKwh), m(x.exclMinor), x.inclMinor == null ? '-' : m(x.inclMinor), m(x.feeMinor)],
      sub: [`${x.counterparty ?? ''}${x.credit ? ` · credit of ${x.credits}` : ''}`],
    })), { size: 7.5 });
  }
  footer(doc, `PlugSure Hub · ${title}`);
  return doc.toBuffer();
}

function footer(doc: PdfDoc, left: string) {
  const total = doc.pageCount;
  for (let i = 0; i < total; i++) {
    doc.onPage(i);
    doc.line(42, doc.height - 40, doc.width - 42, doc.height - 40, { color: [0.9, 0.91, 0.93] });
    doc.text(42, doc.height - 28, left, { size: 7.5, color: MUTED });
    doc.text(doc.width - 42, doc.height - 28, `Page ${i + 1} of ${total}`, { size: 7.5, color: MUTED, align: 'right' });
  }
}

const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  // Formula injection (=, +, -, @, tab, CR) is neutralised, but a plain number stays a number: credit CDRs carry
  // negative amounts (pg returns bigint as text), and "'-1500" would no longer add up in a spreadsheet.
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** The statement's CDRs, per counterparty (amounts in minor units of the statement currency). */
export function statementCsv(st: StatementDoc): string {
  const d = st.data;
  const head = ['Statement', 'Period', 'Currency', 'Counterparty', 'Side', 'CDR id', 'Session id', 'Start', 'End', 'Energy kWh',
    'Total excl. tax (minor)', 'Total incl. tax (minor)', 'Settled amount (minor)', 'Credit', 'Credits CDR', 'Hub fee (minor)'];
  const rows = [...(d.cdrs as any[])].sort((a, b) => String(a.counterparty).localeCompare(String(b.counterparty)) || String(a.start).localeCompare(String(b.start)))
    .map((x) => [st.number, d.period, d.currency, x.counterparty, x.side === 'cpo' ? 'CPO' : 'eMSP', x.cdrId, x.sessionId ?? '', x.start, x.end, x.energyKwh,
      x.exclMinor, x.inclMinor ?? '', x.amountMinor, x.credit ? 'yes' : 'no', x.credits ?? '', x.feeMinor]);
  return toCsv([head, ...rows]);
}

/** Ledger rows (the console's export). */
export function ledgerCsv(rows: any[]): string {
  const head = ['Received', 'CPO', 'eMSP', 'CDR id', 'Session id', 'Currency', 'Total excl. tax (minor)', 'Total incl. tax (minor)', 'Energy kWh', 'Start', 'End',
    'Status', 'Flags', 'Credit', 'Credit reference', 'Dispute deadline', 'CPO fee (minor)', 'eMSP fee (minor)', 'Source', 'Settlement run'];
  return toCsv([head, ...rows.map((r) => [new Date(r.received_at).toISOString(), r.cpo, r.emsp, r.cdr_id, r.session_id ?? '', r.currency, r.total_excl_minor, r.total_incl_minor ?? '',
    r.energy_kwh, new Date(r.start_at).toISOString(), new Date(r.end_at).toISOString(), r.status, (r.flags ?? []).join(' '), r.credit ? 'yes' : 'no', r.credit_reference_id ?? '',
    new Date(r.dispute_deadline).toISOString(), r.fee_cpo_minor ?? '', r.fee_emsp_minor ?? '', r.source, r.settlement_run_id ?? ''])]);
}

// ─────────────────────────────────────────────────────────── fee invoice

export interface InvoiceDoc { number: string; status: string; net_minor: number; tax_scheme: string; tax_rate_bps: number; tax_base_minor: number; tax_minor: number; total_minor: number; wht_expected_minor: number; paid_at?: string | null; paid_reference?: string | null; data: any }

function invoiceNotes(inv: InvoiceDoc, m: (n: unknown) => string): string[] {
  const d = inv.data;
  const notes: string[] = [];
  if (d.issuer.placeholder) notes.push('PLACEHOLDER ISSUER: the PlugSure entity details on this document are placeholders until the legal entities are confirmed; not valid as a tax invoice.');
  if (inv.tax_scheme === 'REVERSE_CHARGE') notes.push('Cross-border supply: no tax charged by the issuer; the customer accounts for any tax due in its country (reverse charge / self-assessment).');
  if (inv.tax_scheme === 'NONE') notes.push(`${d.tax.noTaxLabel ?? 'No tax charged'}: the issuer is not registered for this tax.`);
  if (inv.wht_expected_minor) notes.push(`If you are a PPh 23 withholding agent, withhold 2% of the fee before tax (${m(inv.wht_expected_minor)}) and send us the bukti potong.`);
  if ((d.flags ?? []).includes('foreign_currency_tax_reporting')) notes.push(`Invoiced in ${d.currency}; the issuer reports the tax in its local currency at the official rate of the invoice date.`);
  return notes;
}

export function feeInvoiceHtml(inv: InvoiceDoc): string {
  const d = inv.data;
  const cur = curOf(d.currency);
  const m = money(cur);
  const credit = d.kind === 'credit_note';
  const lines = (d.lines as any[]).map((l) => `<tr><td>${esc(l.label)}</td><td class="n">${m(l.amountMinor)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${credit ? 'Credit note' : 'Invoice'} ${esc(inv.number)}</title><style>${STYLE}</style></head><body><div class="page">
<div class="head"><div><h1>${credit ? 'Credit note' : 'Tax invoice'} — hub commission</h1>
<div class="muted">${esc(d.issuer.name)}${d.issuer.taxId ? ` · Tax ID ${esc(d.issuer.taxId)}` : ''}<br>${esc(d.issuer.address)}</div></div>
<div class="muted" style="text-align:right">No. ${esc(inv.number)}<br>Date: ${esc(day(d.issuedDate))}<br>Due: ${esc(day(d.dueDate))}<br>Period: ${esc(d.period)}</div></div>
${d.issuer.placeholder ? '<div class="warn">PLACEHOLDER ISSUER — entity details to be confirmed; not valid as a tax invoice.</div>' : ''}
${inv.status === 'paid' ? `<div class="warn" style="background:#dcfce7;color:#166534">Paid ${esc(day(inv.paid_at))}${inv.paid_reference ? ` · ${esc(inv.paid_reference)}` : ''}</div>` : ''}
<p class="muted" style="margin-top:14px">To: <b style="color:#111">${esc(d.buyer.name)}</b> · ${esc(d.buyer.country)}${d.buyer.taxId ? ` · Tax ID ${esc(d.buyer.taxId)}` : ''}</p>
<table><thead><tr><th>Description</th><th class="n">Amount (${esc(cur)})</th></tr></thead><tbody>${lines}</tbody></table>
<table><tbody>
<tr><td>Total before tax</td><td class="n">${m(inv.net_minor)}</td></tr>
${inv.tax_scheme === 'ID_PPN' ? `<tr><td class="muted">${esc(d.tax.baseLabel ?? 'DPP')}</td><td class="n muted">${m(inv.tax_base_minor)}</td></tr>` : ''}
<tr><td>${inv.tax_scheme === 'NONE' || inv.tax_scheme === 'REVERSE_CHARGE' ? 'Tax' : esc(d.tax.label ?? 'Tax')}</td><td class="n">${m(inv.tax_minor)}</td></tr>
<tr class="grand"><td>Total ${credit ? 'credited' : 'due'}</td><td class="n">${m(inv.total_minor)}</td></tr>
</tbody></table>
<div class="note">${invoiceNotes(inv, m).map(esc).join('<br>')}<br>Please quote ${esc(inv.number)} with your payment. TODO(commercial): commission rates are placeholders until set by PlugSure.</div>
</div></body></html>`;
}

export function feeInvoicePdf(inv: InvoiceDoc): Buffer {
  const d = inv.data;
  const cur = curOf(d.currency);
  const m = pdfMoney(cur);
  const credit = d.kind === 'credit_note';
  const title = `${credit ? 'Credit note' : 'Invoice'} ${inv.number}`;
  const doc = new PdfDoc({ title, author: d.issuer.name, subject: `Hub commission ${d.period} · ${d.buyer.name}` });
  const f = new Flow(doc);
  doc.text(f.left, f.y + 18, credit ? 'Credit note' : 'Tax invoice', { size: 20, bold: true });
  doc.text(f.left, f.y + 34, `Hub commission · ${cur} · ${d.period}`, { size: 9, color: MUTED });
  [`No. ${inv.number}`, `Date: ${day(d.issuedDate)}`, `Due: ${day(d.dueDate)}`].forEach((l, i) => doc.text(f.right, f.y + 14 + i * 12.5, l, { size: 9, bold: i === 0, align: 'right' }));
  f.y += 50;
  if (d.issuer.placeholder) f.para('PLACEHOLDER ISSUER - entity details to be confirmed; not valid as a tax invoice.', { size: 9, bold: true, color: [0.6, 0.11, 0.11] });
  f.para(`From: ${d.issuer.name}${d.issuer.taxId ? ` · Tax ID ${d.issuer.taxId}` : ''} · ${d.issuer.address}`, { size: 9 });
  f.para(`Bill to: ${d.buyer.name} (${d.buyer.country})${d.buyer.taxId ? ` · Tax ID ${d.buyer.taxId}` : ''}`, { size: 9, bold: true });
  f.heading('Services');
  f.table([{ label: 'Description', width: 5 }, { label: `Amount (${cur})`, width: 1.6, align: 'right' }], (d.lines as any[]).map((l) => ({ cells: [l.label, m(l.amountMinor)] })), { size: 8.5 });
  f.heading('Summary');
  f.row('Total before tax', m(inv.net_minor));
  if (inv.tax_scheme === 'ID_PPN') f.row(d.tax.baseLabel ?? 'DPP', m(inv.tax_base_minor), { muted: true });
  f.row(inv.tax_scheme === 'NONE' || inv.tax_scheme === 'REVERSE_CHARGE' ? 'Tax' : (d.tax.label ?? 'Tax'), m(inv.tax_minor));
  f.row(`Total ${credit ? 'credited' : 'due'}`, m(inv.total_minor), { bold: true, size: 12, rule: false });
  f.gap(6);
  for (const n of invoiceNotes(inv, m)) f.para(n, { size: 8, color: MUTED });
  f.para(`Please quote ${inv.number} with your payment.`, { size: 9, bold: true });
  footer(doc, `${d.issuer.name} · ${title}`);
  return doc.toBuffer();
}
