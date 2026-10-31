import { PdfDoc, Flow } from './pdf.js';
import { xlsx, type Sheet } from './xlsx.js';
import { config } from '../config.js';
import { formatMoney, LEGACY_CURRENCY } from '../domain/money.js';
import type { Account } from './finance.js';
import { monthClose } from './finance.js';

/**
 * Finance exports (v1.12.0): one account's period, as CSV (the transactions), Excel (Summary, By channel, Fees,
 * Transactions; v1.15.0 then By operator and By site, after the four sheets of v1.12.0) or PDF (the summary, by channel, by operator and site, fees, then the
 * transactions). For the accountant's close.
 */

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';
type Close = Awaited<ReturnType<typeof monthClose>>;

const TX_HEAD = ['Date', 'Gateway id', 'Type', 'Status', 'Channel', 'Reference', 'Amount', 'Fee', 'VAT', 'Withholding tax', 'Net', 'Settlement', 'Expected settlement', 'PlugSure payment', 'PlugSure state', 'Operator'];
const txRow = (t: Close['transactions'][number]) => [
  t.at, t.gatewayId, t.kind, t.status, t.channel, t.reference, t.amount, t.fee, t.vat, t.withholdingTax, t.net, t.settlement ?? '', t.expectedSettlementAt ?? '',
  t.paymentId ?? '', t.paymentState ?? (t.matched === 'pass' ? 'pass' : ''), t.operator ?? '',
];

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // A leading = + - @ is a formula to a spreadsheet: neutralised (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(c: Close): string {
  return '﻿' + [TX_HEAD, ...c.transactions.map(txRow)].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function summaryRows(a: Account, c: Close): Array<[string, string | number]> {
  const o = c.overview;
  return [
    ['Account', a.label], ['Period from', o.period.from], ['Period to (exclusive)', o.period.to], ['Time zone', o.period.timeZone], ['Currency', o.currency],
    ['Collected (payments)', o.collected], ['Payments', o.payments], ['Gateway fees', o.fees], ['VAT on fees', o.vat], ['Withholding tax', o.withholdingTax],
    ['Refunds', o.refunds], ['Refund count', o.refundCount], ['Payouts', o.payouts], ['Net (collected − fees − VAT − refunds)', o.net],
    ['Settled in the period (net)', o.settled], ['Receivable now (not yet settled)', o.receivable.amount], ['Refunds due now', o.payable.refundsDue],
    ['Open reconciliation exceptions', o.exceptionsOpen], ['QRIS fees: actual', c.fees.qris.actual], ['QRIS fees: PlugSure estimate', c.fees.qris.estimated],
  ];
}

export function toXlsx(a: Account, c: Close): Buffer {
  const sheets: Sheet[] = [
    { name: 'Summary', rows: [['Item', 'Value'], ...summaryRows(a, c)], widths: [42, 36], formats: [null, 'money'] },
    { name: 'By channel', rows: [['Channel', 'Payments', 'Amount', 'Fees incl. VAT'], ...c.overview.byChannel.map((x) => [x.channel, x.count, x.amount, x.fees])], widths: [24, 12, 18, 18], formats: [null, 'int', 'money', 'money'] },
    { name: 'Fees', rows: [['Month', 'Channel', 'Payments', 'Amount', 'Fee', 'VAT', 'Withholding tax', 'Total', 'Rate'], ...c.fees.rows.map((x) => [x.month, x.channel, x.count, x.amount, x.fee, x.vat, x.withholdingTax, x.total, x.rate])],
      widths: [10, 20, 10, 16, 14, 12, 14, 14, 8], formats: [null, null, 'int', 'money', 'money', 'money', 'money', 'money', 'pct'] },
    { name: 'Transactions', rows: [TX_HEAD, ...c.transactions.map(txRow)], widths: [24, 30, 10, 10, 14, 38, 14, 12, 10, 12, 14, 13, 24, 38, 12, 24],
      formats: [null, null, null, null, null, null, 'money', 'money', 'money', 'money', 'money'] },
    { name: 'By operator', rows: [['Operator', 'Payments', 'Collected', 'Fees', 'VAT on fees', 'Refunds', 'Net', 'Owners\' shares (statements)', 'Owners\' shares paid'],
      ...c.byOperator.map((x) => [x.operator ?? '(platform / unmatched)', x.payments, x.collected, x.fees, x.vat, x.refunds, x.net, x.ownerShares, x.ownerSharesPaid])],
      widths: [30, 10, 16, 14, 12, 14, 16, 18, 18], formats: [null, 'int', 'money', 'money', 'money', 'money', 'money', 'money', 'money'] },
    { name: 'By site', rows: [['Operator', 'Site', 'Payments', 'Collected', 'Fees', 'VAT on fees', 'Refunds', 'Net'],
      ...c.bySite.map((x) => [x.operator ?? '', x.site ?? '(no site: passes, unmatched)', x.payments, x.collected, x.fees, x.vat, x.refunds, x.net])],
      widths: [26, 30, 10, 16, 14, 12, 14, 16], formats: [null, null, 'int', 'money', 'money', 'money', 'money', 'money'] },
  ];
  return xlsx(sheets);
}

/** Rupiah; gateway fees and VAT have cents, shown as two decimals (never one). */
const rp = (n: number) => {
  const whole = Number.isInteger(Math.round(n * 100) / 100);
  return formatMoney(n, LEGACY_CURRENCY, 'id', { decimals: whole ? 0 : 2 });
};
const day = (s: string | null) => (s ? new Date(s).toLocaleString('en-GB', { timeZone: config.alerts.timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '');

export function toPdf(a: Account, c: Close): Buffer {
  const o = c.overview;
  const doc = new PdfDoc({ title: `Finance — ${a.label}`, author: 'PlugSure CSMS', subject: 'Payments, fees, refunds and settlement', created: new Date() });
  const f = new Flow(doc);
  const fromDay = new Date(o.period.from).toLocaleDateString('en-GB', { timeZone: o.period.timeZone, day: 'numeric', month: 'long', year: 'numeric' });
  const toDay = new Date(new Date(o.period.to).getTime() - 1).toLocaleDateString('en-GB', { timeZone: o.period.timeZone, day: 'numeric', month: 'long', year: 'numeric' });
  f.para('Payments, fees, refunds and settlement', { size: 16, bold: true });
  f.para(`${a.label} · ${fromDay} – ${toDay} (${o.period.timeZone})`, { size: 9.5, color: [0.36, 0.39, 0.44] });
  f.para(`${config.billing.issuerName} · generated ${day(new Date().toISOString())} · amounts in rupiah, from the gateway's ledger`, { size: 8, color: [0.36, 0.39, 0.44] });
  f.heading('Summary');
  const COUNTS = new Set(['Payments', 'Refund count', 'Open reconciliation exceptions']);
  for (const [k, v] of summaryRows(a, c).slice(5)) f.row(k, typeof v === 'number' && !COUNTS.has(k) ? rp(v) : String(v), { bold: /^Net/.test(k) });
  f.heading('By channel');
  f.table([{ label: 'Channel', width: 3 }, { label: 'Payments', width: 1.4, align: 'right' }, { label: 'Amount', width: 2.2, align: 'right' }, { label: 'Fees incl. VAT', width: 2.2, align: 'right' }],
    o.byChannel.map((x) => ({ cells: [x.channel, String(x.count), rp(x.amount), rp(x.fees)] })));
  if (c.byOperator.length) {
    f.heading('By operator');
    f.table([{ label: 'Operator', width: 2.6 }, { label: 'Collected', width: 1.8, align: 'right' }, { label: 'Fees + VAT', width: 1.5, align: 'right' }, { label: 'Refunds', width: 1.5, align: 'right' },
      { label: 'Net', width: 1.8, align: 'right' }, { label: 'Owners\' shares', width: 1.8, align: 'right' }, { label: 'paid', width: 1.6, align: 'right' }],
    c.byOperator.map((x) => ({ cells: [x.operator ?? '(platform / unmatched)', rp(x.collected), rp(x.fees + x.vat), rp(x.refunds), rp(x.net), rp(x.ownerShares), rp(x.ownerSharesPaid)] })));
    f.heading('By site');
    f.table([{ label: 'Site', width: 3.2 }, { label: 'Payments', width: 1.2, align: 'right' }, { label: 'Collected', width: 1.9, align: 'right' }, { label: 'Fees + VAT', width: 1.6, align: 'right' },
      { label: 'Refunds', width: 1.5, align: 'right' }, { label: 'Net', width: 1.9, align: 'right' }],
    c.bySite.map((x) => ({ cells: [`${x.site ?? '(no site)'}${x.operator ? ` · ${x.operator}` : ''}`, String(x.payments), rp(x.collected), rp(x.fees + x.vat), rp(x.refunds), rp(x.net)] })), { size: 8 });
  }
  if (c.fees.rows.length) {
    f.heading('Fees by month');
    f.table([{ label: 'Month', width: 1.3 }, { label: 'Channel', width: 2.2 }, { label: 'Amount', width: 2, align: 'right' }, { label: 'Fee', width: 1.7, align: 'right' }, { label: 'VAT', width: 1.5, align: 'right' }, { label: 'Rate', width: 1, align: 'right' }],
      c.fees.rows.map((x) => ({ cells: [x.month, x.channel, rp(x.amount), rp(x.fee), rp(x.vat), x.rate == null ? '—' : `${(x.rate * 100).toFixed(2)}%`] })));
  }
  f.heading(`Transactions (${c.transactions.length})`);
  f.table([
    { label: 'Date', width: 1.7 }, { label: 'Type / channel', width: 1.8 }, { label: 'Reference', width: 2.6 }, { label: 'Status', width: 1.3 },
    { label: 'Amount', width: 1.6, align: 'right' }, { label: 'Fee + VAT', width: 1.3, align: 'right' }, { label: 'Net', width: 1.6, align: 'right' },
  ], c.transactions.map((t) => ({
    cells: [day(t.at), `${t.kind} · ${t.channel ?? ''}`, t.reference ?? t.gatewayId, `${t.status}${t.settlement ? ` · ${t.settlement.replace('_', ' ')}` : ''}`, rp(t.amount), rp(t.fee + t.vat), t.net == null ? '—' : rp(t.net)],
  })), { size: 7.5 });
  return doc.toBuffer();
}

export function render(a: Account, c: Close, format: ExportFormat): { body: Buffer | string; type: string; ext: string } {
  if (format === 'csv') return { body: toCsv(c), type: 'text/csv; charset=utf-8', ext: 'csv' };
  if (format === 'xlsx') return { body: toXlsx(a, c), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
  return { body: toPdf(a, c), type: 'application/pdf', ext: 'pdf' };
}
