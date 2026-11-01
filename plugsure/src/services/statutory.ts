import { one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { balances, currencies } from './general-ledger.js';
import { PdfDoc, Flow } from './pdf.js';
import { xlsx } from './xlsx.js';

/**
 * Statutory financial statements (v1.39.0), from the ledger, for a year and a currency, with the year before beside it
 * (SAK / PSAK 1 layout, for the auditors):
 *
 *   balance sheet      current assets (cash and cash equivalents, the rest), non-current assets (fixed and right-of-use
 *                      assets net of depreciation, deferred tax), current liabilities, non-current liabilities (loans,
 *                      lease liabilities, deferred grants, deferred tax), equity (capital, retained earnings: every
 *                      earlier year's result, and the year's)
 *   profit and loss    revenue, cost of energy, operating expenses, other income and expense, the result before tax,
 *                      income tax (current 9100, deferred 9110), the result for the year
 *   cash flows         indirect: the result, plus the non-cash items (depreciation, deferred tax), plus the change in
 *                      each working-capital account; investing (fixed and right-of-use assets at cost); financing
 *                      (loans, lease liabilities, capital). Every account belongs to exactly one line, so the total
 *                      equals the change in cash and cash equivalents (shown and checked).
 *   changes in equity  opening, the result, capital movements, closing
 *   notes              each line's accounts, both years
 *
 * The ledger does not close a year's profit and loss accounts into retained earnings; the statements do it (every
 * earlier year's result is retained earnings). Excel and PDF.
 */

export class StatutoryError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const zone = () => config.billing.timeZone;
const thisYear = (now = new Date()) => Number(new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 4));
export const CASH = new Set(['1050', '1100', '1110', '1130', '1150']);
const ACCUMULATED = new Set(['1690', '1659']);
const DEFERRED_TAX = new Set(['1470', '2710']);
const FINANCING_LIAB = new Set(['2500', '2400']);
const NONCURRENT_LIAB = new Set(['2500', '2400', '2600', '2710']);
const TAX_PL = new Set(['9100', '9110']);

type Bal = { code: string; name: string; type: string; balance: number };

/** The line an account belongs to. Pure. */
export function lineOf(code: string, type: string): string {
  if (CASH.has(code)) return 'cash';
  if (TAX_PL.has(code)) return 'income_tax';
  if (type === 'revenue') return 'revenue';
  if (type === 'expense') return code.startsWith('5') ? 'cost_of_energy' : 'operating_expenses';
  if (type === 'other') return 'other_income_expense';
  if (type === 'asset') return code.startsWith('16') ? 'fixed_assets' : code === '1470' ? 'deferred_tax_asset' : 'other_current_assets';
  if (type === 'liability') return NONCURRENT_LIAB.has(code) ? 'noncurrent_liabilities' : 'current_liabilities';
  if (type === 'equity') return 'capital';
  return 'other_income_expense';
}

export const LABEL: Record<string, string> = {
  cash: 'Cash and cash equivalents', other_current_assets: 'Receivables, prepayments and other current assets', fixed_assets: 'Fixed and right-of-use assets, net',
  deferred_tax_asset: 'Deferred tax assets', current_liabilities: 'Payables, accruals and other current liabilities', noncurrent_liabilities: 'Loans, lease liabilities, deferred grants and deferred tax',
  capital: 'Share capital and other equity', revenue: 'Revenue', cost_of_energy: 'Cost of energy', operating_expenses: 'Operating expenses', other_income_expense: 'Other income and expense',
  income_tax: 'Income tax',
};

const r = (n: number) => Math.round(n);
const sumOf = (xs: Bal[], f: (b: Bal) => number = (b) => b.balance) => r(xs.reduce((a, b) => a + f(b), 0));

/**
 * The cash flow lines from the balances at two year ends and the year's result. Each non-cash balance sheet account's
 * cash effect is minus its change (debit-positive); profit and loss accounts sum to the result. Pure.
 */
export function cashFlow(open: Bal[], close: Bal[], result: number) {
  const codes = new Map<string, Bal>();
  for (const b of [...open, ...close]) if (!codes.has(b.code)) codes.set(b.code, b);
  const bal = (xs: Bal[], c: string) => xs.find((x) => x.code === c)?.balance ?? 0;
  const op: Array<{ code: string; name: string; amount: number }> = [], inv: typeof op = [], fin: typeof op = [];
  let depreciation = 0, deferredTax = 0, cashOpen = 0, cashClose = 0;
  for (const [code, b] of codes) {
    const delta = bal(close, code) - bal(open, code);
    if (CASH.has(code)) { cashOpen += bal(open, code); cashClose += bal(close, code); continue; }
    if (!['asset', 'liability', 'equity'].includes(b.type)) continue;
    const effect = -delta;
    if (!effect) continue;
    if (ACCUMULATED.has(code)) depreciation += effect;
    else if (DEFERRED_TAX.has(code)) deferredTax += effect;
    else if (b.type === 'asset' && code.startsWith('16')) inv.push({ code, name: b.name, amount: r(effect) });
    else if (b.type === 'equity' || FINANCING_LIAB.has(code)) fin.push({ code, name: b.name, amount: r(effect) });
    else op.push({ code, name: b.name, amount: r(effect) });
  }
  const operating = r(result + depreciation + deferredTax + op.reduce((a, x) => a + x.amount, 0));
  const investing = r(inv.reduce((a, x) => a + x.amount, 0)), financing = r(fin.reduce((a, x) => a + x.amount, 0));
  const net = operating + investing + financing, change = r(cashClose - cashOpen);
  return {
    result: r(result), depreciation: r(depreciation), deferredTax: r(deferredTax), workingCapital: op, operating, investing: inv, investingTotal: investing, financing: fin, financingTotal: financing,
    net, cashOpen: r(cashOpen), cashClose: r(cashClose), change, reconciles: net === change,
  };
}

async function yearData(orgId: string, currency: string, year: number) {
  const [close, pl] = await Promise.all([balances(orgId, currency, null, `${year}-12`), balances(orgId, currency, `${year}-01`, `${year}-12`)]);
  const priorPl = await balances(orgId, currency, null, `${year - 1}-12`);
  const plRows = (rows: Bal[]) => rows.filter((b) => ['revenue', 'expense', 'other'].includes(b.type) || TAX_PL.has(b.code));
  const priorResult = -sumOf(plRows(priorPl));
  const g = (k: string, sign: 1 | -1) => close.filter((b) => !['revenue', 'expense', 'other'].includes(b.type) && !TAX_PL.has(b.code) && lineOf(b.code, b.type) === k).map((b) => ({ code: b.code, name: b.name, amount: r(sign * b.balance) }));
  const p = (k: string) => plRows(pl).filter((b) => lineOf(b.code, b.type) === k).map((b) => ({ code: b.code, name: b.name, amount: r(-b.balance) }));
  const tot = (xs: Array<{ amount: number }>) => r(xs.reduce((a, x) => a + x.amount, 0));
  const assets = { cash: g('cash', 1), other_current_assets: g('other_current_assets', 1), fixed_assets: g('fixed_assets', 1), deferred_tax_asset: g('deferred_tax_asset', 1) };
  const liabilities = { current_liabilities: g('current_liabilities', -1), noncurrent_liabilities: g('noncurrent_liabilities', -1) };
  const capital = g('capital', -1);
  const plLines = { revenue: p('revenue'), cost_of_energy: p('cost_of_energy'), operating_expenses: p('operating_expenses'), other_income_expense: p('other_income_expense'), income_tax: p('income_tax') };
  const beforeTax = tot(plLines.revenue) + tot(plLines.cost_of_energy) + tot(plLines.operating_expenses) + tot(plLines.other_income_expense);
  const result = beforeTax + tot(plLines.income_tax);
  const currentAssets = tot(assets.cash) + tot(assets.other_current_assets), nonCurrentAssets = tot(assets.fixed_assets) + tot(assets.deferred_tax_asset);
  const totalLiabilities = tot(liabilities.current_liabilities) + tot(liabilities.noncurrent_liabilities);
  const equity = { capital: tot(capital), retainedEarnings: priorResult, result, total: tot(capital) + priorResult + result };
  return {
    year, close, assets, liabilities, capital, plLines,
    balanceSheet: { currentAssets, nonCurrentAssets, totalAssets: currentAssets + nonCurrentAssets, currentLiabilities: tot(liabilities.current_liabilities), nonCurrentLiabilities: tot(liabilities.noncurrent_liabilities), totalLiabilities, equity, balanced: currentAssets + nonCurrentAssets === totalLiabilities + equity.total },
    profitAndLoss: { revenue: tot(plLines.revenue), costOfEnergy: tot(plLines.cost_of_energy), grossProfit: tot(plLines.revenue) + tot(plLines.cost_of_energy), operatingExpenses: tot(plLines.operating_expenses), otherIncomeExpense: tot(plLines.other_income_expense), resultBeforeTax: beforeTax, incomeTax: tot(plLines.income_tax), result },
  };
}

export async function statements(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const year = q.year == null || q.year === '' ? thisYear(now) - 1 : Number(q.year);
  if (!Number.isInteger(year) || year < 2000 || year > thisYear(now)) throw new StatutoryError(422, 'year is a past or the current year.');
  const curs = await currencies(orgId);
  const currency = q.currency == null || q.currency === '' ? (curs[0] ?? LEGACY_CURRENCY) : String(q.currency).toUpperCase();
  const [cur, prior, before] = await Promise.all([yearData(orgId, currency, year), yearData(orgId, currency, year - 1), yearData(orgId, currency, year - 2)]);
  const cf = cashFlow(prior.close, cur.close, cur.profitAndLoss.result);
  const cfPrior = cashFlow(before.close, prior.close, prior.profitAndLoss.result);
  const notes = Object.keys(LABEL).map((k) => {
    const pick = (d: typeof cur) => ([...((d.assets as any)[k] ?? []), ...((d.liabilities as any)[k] ?? []), ...(k === 'capital' ? d.capital : []), ...((d.plLines as any)[k] ?? [])] as Array<{ code: string; name: string; amount: number }>);
    const a = pick(cur), b = pick(prior);
    const codes = [...new Set([...a.map((x) => x.code), ...b.map((x) => x.code)])].sort();
    return { line: k, label: LABEL[k]!, accounts: codes.map((c) => ({ code: c, name: (a.find((x) => x.code === c) ?? b.find((x) => x.code === c))!.name, amount: a.find((x) => x.code === c)?.amount ?? 0, prior: b.find((x) => x.code === c)?.amount ?? 0 })) };
  }).filter((n) => n.accounts.length);
  const strip = (d: typeof cur) => ({ year: d.year, balanceSheet: d.balanceSheet, profitAndLoss: d.profitAndLoss });
  return {
    year, currency, currencies: curs.length ? curs : [currency],
    current: strip(cur), prior: strip(prior),
    cashFlow: cf, cashFlowPrior: cfPrior,
    equity: {
      opening: prior.balanceSheet.equity.total, result: cur.profitAndLoss.result, capitalMovements: cur.balanceSheet.equity.capital - prior.balanceSheet.equity.capital, closing: cur.balanceSheet.equity.total,
      prior: { opening: before.balanceSheet.equity.total, result: prior.profitAndLoss.result, capitalMovements: prior.balanceSheet.equity.capital - before.balanceSheet.equity.capital },
    },
    notes,
    checks: { balanced: cur.balanceSheet.balanced && prior.balanceSheet.balanced, cashFlowReconciles: cf.reconciles && cfPrior.reconciles },
  };
}

type S = Awaited<ReturnType<typeof statements>>;
const rowsOf = (s: S) => {
  const c = s.current, p = s.prior, cf = s.cashFlow, pf = s.cashFlowPrior;
  const bs: Array<[string, number | string, number | string]> = [
    ['ASSETS', '', ''], ['Current assets', c.balanceSheet.currentAssets, p.balanceSheet.currentAssets], ['Non-current assets', c.balanceSheet.nonCurrentAssets, p.balanceSheet.nonCurrentAssets], ['Total assets', c.balanceSheet.totalAssets, p.balanceSheet.totalAssets],
    ['LIABILITIES AND EQUITY', '', ''], ['Current liabilities', c.balanceSheet.currentLiabilities, p.balanceSheet.currentLiabilities], ['Non-current liabilities', c.balanceSheet.nonCurrentLiabilities, p.balanceSheet.nonCurrentLiabilities],
    ['Share capital and other equity', c.balanceSheet.equity.capital, p.balanceSheet.equity.capital], ['Retained earnings', c.balanceSheet.equity.retainedEarnings, p.balanceSheet.equity.retainedEarnings], ['Result for the year', c.balanceSheet.equity.result, p.balanceSheet.equity.result],
    ['Total equity', c.balanceSheet.equity.total, p.balanceSheet.equity.total], ['Total liabilities and equity', c.balanceSheet.totalLiabilities + c.balanceSheet.equity.total, p.balanceSheet.totalLiabilities + p.balanceSheet.equity.total],
  ];
  const pl: typeof bs = [
    ['Revenue', c.profitAndLoss.revenue, p.profitAndLoss.revenue], ['Cost of energy', c.profitAndLoss.costOfEnergy, p.profitAndLoss.costOfEnergy], ['Gross profit', c.profitAndLoss.grossProfit, p.profitAndLoss.grossProfit],
    ['Operating expenses', c.profitAndLoss.operatingExpenses, p.profitAndLoss.operatingExpenses], ['Other income and expense', c.profitAndLoss.otherIncomeExpense, p.profitAndLoss.otherIncomeExpense],
    ['Result before tax', c.profitAndLoss.resultBeforeTax, p.profitAndLoss.resultBeforeTax], ['Income tax', c.profitAndLoss.incomeTax, p.profitAndLoss.incomeTax], ['Result for the year', c.profitAndLoss.result, p.profitAndLoss.result],
  ];
  const cfr: typeof bs = [
    ['Result for the year', cf.result, pf.result], ['Depreciation', cf.depreciation, pf.depreciation], ['Deferred tax', cf.deferredTax, pf.deferredTax],
    ['Change in working capital', cf.operating - cf.result - cf.depreciation - cf.deferredTax, pf.operating - pf.result - pf.depreciation - pf.deferredTax],
    ['Cash flows from operating activities', cf.operating, pf.operating], ['Cash flows from investing activities', cf.investingTotal, pf.investingTotal], ['Cash flows from financing activities', cf.financingTotal, pf.financingTotal],
    ['Net change in cash and cash equivalents', cf.net, pf.net], ['Cash and cash equivalents at the start of the year', cf.cashOpen, pf.cashOpen], ['Cash and cash equivalents at the end of the year', cf.cashClose, pf.cashClose],
  ];
  return { bs, pl, cfr };
};

export function statementsXlsx(s: S): Buffer {
  const { bs, pl, cfr } = rowsOf(s);
  const head = ['', String(s.year), String(s.year - 1)];
  const F = { widths: [46, 18, 18], formats: [null, 'money', 'money'] as Array<'money' | null> };
  return xlsx([
    { name: 'Balance sheet', rows: [head, ...bs], ...F },
    { name: 'Profit and loss', rows: [head, ...pl], ...F },
    { name: 'Cash flows', rows: [head, ...cfr], ...F },
    { name: 'Changes in equity', rows: [head, ['Opening equity', s.equity.opening, s.equity.prior.opening], ['Result for the year', s.equity.result, s.equity.prior.result], ['Capital movements', s.equity.capitalMovements, s.equity.prior.capitalMovements], ['Closing equity', s.equity.closing, s.equity.opening]], ...F },
    { name: 'Notes', rows: [['Line', 'Code', 'Account', String(s.year), String(s.year - 1)], ...s.notes.flatMap((n) => n.accounts.map((a) => [n.label, a.code, a.name, a.amount, a.prior]))], widths: [40, 8, 36, 18, 18], formats: [null, null, null, 'money', 'money'] },
  ]);
}

export async function statementsPdf(orgId: string, q: Record<string, unknown> = {}): Promise<Buffer> {
  const s = await statements(orgId, q);
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const name = org?.name ?? 'PlugSure CSMS';
  const doc = new PdfDoc({ title: `Financial statements ${s.year}`, author: name, subject: 'Financial statements', created: new Date() });
  const f = new Flow(doc);
  const m = (n: number | string) => (typeof n === 'number' ? n.toLocaleString('en-US') : n);
  const { bs, pl, cfr } = rowsOf(s);
  f.para(`${name}`, { size: 16, bold: true });
  f.para(`Financial statements for the year ended 31 December ${s.year} (${s.currency}), with ${s.year - 1} for comparison. Prepared from the ledger; not audited.`, { size: 9, color: [0.36, 0.39, 0.44] });
  const cols = [{ label: '', width: 4.6 }, { label: String(s.year), width: 1.8, align: 'right' as const }, { label: String(s.year - 1), width: 1.8, align: 'right' as const }];
  const bold = /^(Total|Gross|Result|Cash flows|Net change|ASSETS|LIABILITIES)/;
  for (const [title, rows] of [['Statement of financial position', bs], ['Statement of profit or loss', pl], ['Statement of cash flows (indirect)', cfr]] as const) {
    f.heading(title);
    f.table(cols, rows.map(([l, a, b]) => ({ cells: [l, m(a), m(b)], bold: bold.test(l) })), { size: 9 });
  }
  f.heading('Statement of changes in equity');
  f.table(cols, [{ cells: ['Opening equity', m(s.equity.opening), m(s.equity.prior.opening)] }, { cells: ['Result for the year', m(s.equity.result), m(s.equity.prior.result)] }, { cells: ['Capital movements', m(s.equity.capitalMovements), m(s.equity.prior.capitalMovements)] }, { cells: ['Closing equity', m(s.equity.closing), m(s.equity.opening)], bold: true }], { size: 9 });
  f.heading('Notes');
  for (const n of s.notes) {
    f.para(n.label, { size: 9, bold: true });
    f.table([{ label: 'Account', width: 4.6 }, { label: String(s.year), width: 1.8, align: 'right' }, { label: String(s.year - 1), width: 1.8, align: 'right' }], n.accounts.map((a) => ({ cells: [`${a.code} ${a.name}`, m(a.amount), m(a.prior)] })), { size: 8 });
  }
  if (!s.checks.balanced || !s.checks.cashFlowReconciles) f.para(`Check: ${!s.checks.balanced ? 'the balance sheet does not balance' : ''}${!s.checks.cashFlowReconciles ? ' the cash flow does not reconcile to the change in cash' : ''}.`, { size: 9, color: [0.7, 0.1, 0.1] });
  return doc.toBuffer();
}
