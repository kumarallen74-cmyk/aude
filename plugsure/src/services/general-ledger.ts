import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { assertOpen, isLocked } from './finance-periods.js';
import { gate, type Approver } from './finance-approvals.js';
import { accountsFor, periodOf } from './finance.js';
import { journal as gatewayJournal } from './finance-journal.js';
import { xlsx } from './xlsx.js';
import { monthShare } from './insurance.js';

/**
 * The general ledger (v1.31.0). One ledger for the organisation, from every finance module's journal and manual
 * entries:
 *
 *   chart      accounts by code with a type (asset, liability, equity, revenue, expense, other); seeded with the codes
 *              the modules post to; an account a module posts to that is not in the chart is added (typed by its first
 *              digit)
 *   sync       a month's entries from the modules, one per source and currency, posted:
 *                gateway       each payments account's journal (collections, fees, refunds, withdrawals, owner payouts)
 *                assets        the recorded depreciation journal (Finance → Assets)
 *                leases        the recorded lease journal (Finance → Leases)
 *                provision     the recorded bad-debt provision's movement
 *                bills         supplier bills of the month (expense or asset, PPN input, supplier payable, PPh 23
 *                              payable) and the payments made (payable against the bank or petty cash)
 *                deposits      deposits placed and closed (deposits, bank, interest income, penalties)
 *                expenses      expense claims approved (expense, PPN input, claims payable) and reimbursed
 *                intercompany  recharges issued and received, and settlements
 *              Syncing again replaces a module's entry when it changed (the old one is kept, superseded). A locked
 *              month cannot be synced.
 *   manual     an entry with balanced lines (debits = credits) on active accounts; submitted and approved by a second
 *              person (the approvals matrix, kind journal_entry) before it posts; a posted manual entry is reversed,
 *              never edited
 *   reports    trial balance to a month's end; profit and loss for the month and the year to date; balance sheet at the
 *              month's end (the year's result in equity); an account's lines. Per currency. Excel.
 */

export class LedgerError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense', 'other'] as const;
type AccountType = typeof TYPES[number];
export const SOURCES = ['gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'payroll', 'customer_deposits', 'projects', 'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks', 'loyalty', 'fx', 'tax', 'cards'] as const;
type Source = typeof SOURCES[number];

export const SEED: Array<[string, string, AccountType]> = [
  ['1050', 'Petty cash', 'asset'], ['1100', 'Bank', 'asset'], ['1110', 'Bank (gateway payouts)', 'asset'], ['1130', 'Payment gateway balance', 'asset'],
  ['1150', 'Time deposits', 'asset'], ['1290', 'Allowance for doubtful accounts', 'asset'], ['1300', 'Intercompany receivables', 'asset'],
  ['1410', 'VAT input on gateway fees', 'asset'], ['1420', 'PPN input', 'asset'], ['1600', 'Fixed assets at cost', 'asset'], ['1690', 'Accumulated depreciation', 'asset'],
  ['1650', 'Right-of-use assets', 'asset'], ['1659', 'Accumulated depreciation, right-of-use assets', 'asset'],
  ['2100', 'Supplier payables', 'liability'], ['2120', 'Site owners\' shares payable', 'liability'], ['2140', 'Withholding tax payable', 'liability'],
  ['2150', 'PPh 23 payable', 'liability'], ['2151', 'PPh 21 payable', 'liability'], ['2152', 'PPh 26 payable', 'liability'], ['2160', 'Expense claims payable', 'liability'],
  ['2170', 'Salaries payable', 'liability'], ['2180', 'BPJS payable', 'liability'], ['2190', 'Other payroll deductions', 'liability'], ['2200', 'Customer deposits', 'liability'],
  ['2105', 'Goods received not invoiced', 'liability'], ['2110', 'Accrued maintenance', 'liability'], ['2115', 'Accrued maintenance labour', 'liability'], ['2500', 'Loans', 'liability'], ['2300', 'Intercompany payables', 'liability'],
  ['2400', 'Lease liabilities', 'liability'], ['2410', 'Accrued lease payments', 'liability'],
  ['3100', 'Share capital', 'equity'], ['3200', 'Retained earnings', 'equity'],
  ['4100', 'Charging revenue (collected)', 'revenue'], ['4190', 'Refunds to drivers', 'revenue'], ['4900', 'Intercompany recharge income', 'revenue'], ['4200', 'Fleet charging paid from deposits', 'revenue'],
  ['5100', 'Energy cost', 'expense'], ['6100', 'Salaries and wages', 'expense'], ['6105', 'Employer BPJS', 'expense'],
  ['6205', 'Warranty recoveries', 'expense'], ['6260', 'Spare parts used', 'expense'], ['6265', 'Stock adjustments', 'expense'], ['6270', 'Maintenance labour', 'expense'], ['6110', 'Payment gateway fees', 'expense'], ['6200', 'Maintenance', 'expense'], ['6210', 'Rent', 'expense'],
  ['6220', 'Installation', 'expense'], ['6230', 'Equipment (expensed)', 'expense'], ['6240', 'Connectivity', 'expense'], ['6250', 'Services', 'expense'], ['6290', 'Other supplier costs', 'expense'],
  ['6310', 'Fuel', 'expense'], ['6320', 'Travel', 'expense'], ['6330', 'Meals', 'expense'], ['6340', 'Parking', 'expense'], ['6350', 'Tools', 'expense'],
  ['6360', 'Supplies', 'expense'], ['6370', 'Phone', 'expense'], ['6390', 'Other staff expenses', 'expense'],
  ['6400', 'Depreciation expense', 'expense'], ['6410', 'Depreciation, right-of-use assets', 'expense'], ['6420', 'Lease expense (short-term and low-value)', 'expense'],
  ['6500', 'Bad-debt expense', 'expense'], ['6900', 'Intercompany recharge expense', 'expense'],
  ['7100', 'Gain on disposal', 'other'], ['7200', 'Interest on lease liabilities', 'other'], ['7300', 'Interest income', 'other'], ['8100', 'Loss on disposal', 'other'], ['7400', 'FX gains', 'other'], ['8400', 'FX losses', 'other'], ['8200', 'Deposit penalties', 'other'], ['8300', 'Capex written off', 'other'], ['7210', 'Interest on loans', 'other'], ['7215', 'Loan fees', 'other'],
  ['1450', 'Prepaid insurance', 'asset'], ['1750', 'Renewable energy certificates', 'asset'], ['4300', 'Carbon credit sales', 'revenue'], ['5150', 'Renewable energy certificates retired', 'expense'],
  ['6600', 'Insurance', 'expense'], ['6605', 'Insurance recoveries', 'expense'],
  ['1190', 'Disputed funds (chargebacks)', 'asset'], ['1350', 'Grants receivable', 'asset'], ['2420', 'Accrued rent', 'liability'], ['2600', 'Deferred grant income', 'liability'], ['2610', 'Grants repayable', 'liability'],
  ['4400', 'Grant income', 'revenue'], ['6520', 'Chargeback losses', 'expense'], ['6700', 'Grant clawbacks', 'expense'],
  ['2250', 'Loyalty points liability', 'liability'], ['4150', 'Loyalty points deferred', 'revenue'],
  ['1460', 'Prepaid income tax (PPh 25)', 'asset'], ['1465', 'Income tax withheld by others (PPh 22/23)', 'asset'], ['1470', 'Deferred tax assets', 'asset'], ['1480', 'Receivable from employees', 'asset'],
  ['2165', 'Corporate cards payable', 'liability'], ['2700', 'Corporate income tax payable', 'liability'], ['2710', 'Deferred tax liabilities', 'liability'],
  ['6380', 'Software and subscriptions', 'expense'], ['9100', 'Current income tax', 'other'], ['9110', 'Deferred income tax', 'other'],
];
export const BILL_ACCOUNT: Record<string, string> = { energy: '5100', maintenance: '6200', rent: '6210', installation: '6220', equipment: '6230', connectivity: '6240', services: '6250', other: '6290' };
/** (v1.32.0) The payable a bill's withholding is posted to, by kind. */
export const WHT_ACCOUNT: Record<string, string> = { pph23: '2150', pph21: '2151', pph26: '2152' };
export const CLAIM_ACCOUNT: Record<string, string> = { fuel: '6310', travel: '6320', meals: '6330', parking: '6340', tools: '6350', supplies: '6360', phone: '6370', other: '6390' };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const ERR = (st: number, msg: string) => new LedgerError(st, msg);
const typeByCode = (code: string): AccountType => ({ '1': 'asset', '2': 'liability', '3': 'equity', '4': 'revenue', '5': 'expense', '6': 'expense' } as Record<string, AccountType>)[code[0] ?? ''] ?? 'other';

// ─────────────────────────────────────────── chart

export async function ensureChart(orgId: string) {
  const n = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) AS n FROM gl_account WHERE org_id = $1`, [orgId]));
  if (Number(n?.n ?? 0) > 0) return;
  for (const [code, name, type] of SEED) {
    await outsideRequestScope(() => query(`INSERT INTO gl_account (org_id, code, name, type) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, code) DO NOTHING`, [orgId, code, name, type]));
  }
}

export async function chart(orgId: string) {
  await ensureChart(orgId);
  const rows = await outsideRequestScope(() => many<any>(`SELECT code, name, type, active FROM gl_account WHERE org_id = $1 ORDER BY code`, [orgId]));
  return rows.map((r) => ({ code: r.code, name: r.name, type: r.type as AccountType, active: r.active }));
}

export async function saveAccount(orgId: string, b: Record<string, unknown>) {
  await ensureChart(orgId);
  const code = String(b.code ?? '').trim();
  if (!/^[0-9A-Za-z.\-]{1,20}$/.test(code)) throw new LedgerError(422, 'code is up to 20 letters, digits, dots or dashes.');
  const cur = await outsideRequestScope(() => one<any>(`SELECT * FROM gl_account WHERE org_id = $1 AND code = $2`, [orgId, code]));
  const name = b.name === undefined && cur ? cur.name : String(b.name ?? '').trim();
  if (name.length < 2 || name.length > 100) throw new LedgerError(422, 'name is 2 to 100 characters.');
  const type = b.type === undefined && cur ? cur.type : String(b.type ?? '');
  if (!(TYPES as readonly string[]).includes(type)) throw new LedgerError(422, `type is one of ${TYPES.join(', ')}.`);
  if (cur && cur.type !== type) {
    const used = await outsideRequestScope(() => one(`SELECT 1 FROM gl_line l JOIN gl_entry e ON e.id = l.entry_id WHERE l.org_id = $1 AND l.account_code = $2 AND e.status = 'posted' LIMIT 1`, [orgId, code]));
    if (used) throw new LedgerError(409, 'The account has posted lines: its type cannot change.');
  }
  const active = b.active === undefined ? (cur ? cur.active : true) : b.active === true || b.active === 'true';
  await outsideRequestScope(() => query(
    `INSERT INTO gl_account (org_id, code, name, type, active) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, active = EXCLUDED.active`, [orgId, code, name, type, active]));
  return { code, name, type, active };
}

// ─────────────────────────────────────────── entries

export interface Line { account: string; debit: number; credit: number; description?: string | null; name?: string }
interface Draft { source: Source; ref: string; date: string; currency: string; memo: string; lines: Line[] }

async function nextNumber(orgId: string, month: string) {
  const r = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) AS n FROM gl_entry WHERE org_id = $1 AND month = $2`, [orgId, month]));
  return `JE-${month.replace('-', '')}-${String(Number(r?.n ?? 0) + 1).padStart(4, '0')}`;
}

/** Net each account's debits and credits into one line per account and side; drop zeros. */
export function compact(lines: Line[]): Line[] {
  const by = new Map<string, Line>();
  for (const l of lines) {
    const k = `${l.account}|${l.description ?? ''}`;
    const x = by.get(k) ?? { account: l.account, debit: 0, credit: 0, description: l.description ?? null, name: l.name };
    x.debit = r2(x.debit + l.debit); x.credit = r2(x.credit + l.credit);
    by.set(k, x);
  }
  return [...by.values()].map((l) => { const net = r2(l.debit - l.credit); return { ...l, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }; }).filter((l) => l.debit || l.credit);
}

const balanced = (lines: Line[]) => r2(lines.reduce((a, l) => a + l.debit - l.credit, 0)) === 0;

async function insertEntry(orgId: string, d: { date: string; month: string; currency: string; source: string; ref: string | null; memo: string; status: string; lines: Line[]; userId: string | null; reversalOf?: string }) {
  for (let k = 0; k < 5; k++) {
    const number = await nextNumber(orgId, d.month);
    try {
      const r = await outsideRequestScope(() => one<{ id: string }>(
        `INSERT INTO gl_entry (org_id, number, entry_date, month, currency, source, source_ref, memo, status, submitted_by, approved_by, posted_at, reversal_of)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text, $10::uuid, CASE WHEN $9::text = 'posted' THEN $10::uuid END, CASE WHEN $9::text = 'posted' THEN now() END, $11) RETURNING id`,
        [orgId, number, d.date, d.month, d.currency, d.source, d.ref, d.memo.slice(0, 300), d.status, d.userId, d.reversalOf ?? null]));
      for (const l of d.lines) {
        await outsideRequestScope(() => query(`INSERT INTO gl_line (org_id, entry_id, account_code, debit, credit, description) VALUES ($1, $2, $3, $4, $5, $6)`,
          [orgId, r!.id, l.account, l.debit, l.credit, l.description ? String(l.description).slice(0, 200) : null]));
      }
      return String(r!.id);
    } catch (e) {
      if ((e as any).code === '23505' && (e as any).constraint === 'gl_entry_org_id_number_key') continue;
      throw e;
    }
  }
  throw new LedgerError(409, 'Could not number the entry. Try again.');
}

async function ensureAccounts(orgId: string, lines: Line[]) {
  for (const l of lines) {
    await outsideRequestScope(() => query(`INSERT INTO gl_account (org_id, code, name, type) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, code) DO NOTHING`,
      [orgId, l.account, (l.name ?? `Account ${l.account}`).slice(0, 100), typeByCode(l.account)]));
  }
}

// ─────────────────────────────────────────── the modules' entries for a month

const fromRows = (rows: any[]): Line[] => rows.map((x) => ({ account: String(x.code), name: x.account, debit: Number(x.debit), credit: Number(x.credit), description: x.description ?? null }));

export async function drafts(orgId: string, month: string): Promise<Draft[]> {
  const out: Draft[] = [];
  const end = lastDay(month);
  const add = (source: Source, currency: string, memo: string, lines: Line[], key = currency) => {
    const c = compact(lines);
    if (c.length) out.push({ source, ref: `${source}:${month}:${key}`, date: end, currency, memo, lines: c });
  };
  const Q = (sql: string, p: unknown[]) => outsideRequestScope(() => many<any>(sql, p));

  // Gateway: each payments account's journal for the month.
  const [y, m] = month.split('-').map(Number) as [number, number];
  const period = periodOf(`${month}-01`, end);
  for (const a of (await accountsFor(orgId, false)).filter((x) => !x.testMode)) {
    const j = await gatewayJournal(a, period).catch(() => null);
    if (!j || !j.lines.length) continue;
    add('gateway', LEGACY_CURRENCY, `${a.label}: collections, fees, refunds and payouts, ${month}`, j.lines.map((l) => ({ account: l.code, name: l.account, debit: l.debit, credit: l.credit, description: l.kind })), a.id);
  }
  void y; void m;
  for (const r of await Q(`SELECT currency, data FROM fixed_asset_run WHERE org_id = $1 AND month = $2`, [orgId, month])) add('assets', r.currency, `Depreciation and disposals, ${month}`, fromRows(r.data?.lines ?? []));
  for (const r of await Q(`SELECT currency, data FROM lease_run WHERE org_id = $1 AND month = $2`, [orgId, month])) add('leases', r.currency, `Leases (PSAK 73), ${month}`, fromRows(r.data?.lines ?? []));
  for (const r of await Q(`SELECT currency, movement_minor FROM bad_debt_provision WHERE org_id = $1 AND month = $2`, [orgId, month])) {
    const mv = Number(r.movement_minor);
    add('provision', r.currency, `Bad-debt provision, ${month}`, mv >= 0
      ? [{ account: '6500', debit: mv, credit: 0 }, { account: '1290', debit: 0, credit: mv }]
      : [{ account: '1290', debit: -mv, credit: 0 }, { account: '6500', debit: 0, credit: -mv }]);
  }
  // Bills of the month (approved or paid), and payments made in the month.
  const billLines: Record<string, Line[]> = {};
  for (const b of await Q(
    `SELECT b.*, s.name AS supplier, (SELECT 1 FROM fixed_asset a WHERE a.supplier_bill_id = b.id AND a.voided_at IS NULL LIMIT 1) AS capitalised
       FROM supplier_bill b JOIN supplier s ON s.id = b.supplier_id WHERE b.org_id = $1 AND b.status IN ('approved', 'paid') AND to_char(b.bill_date, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (billLines[b.currency] ??= []);
    const d = `${b.supplier} ${b.number}`;
    // (v1.33.0) A bill on a capex project is assets under construction until the project is completed.
    // (v1.34.0) A bill for stock received clears goods received not invoiced.
    L.push({ account: b.capitalised ? '1600' : b.capex_project_id ? '1610' : b.stock ? '2105' : BILL_ACCOUNT[b.category] ?? '6290', debit: Number(b.subtotal_minor), credit: 0, description: d });
    if (Number(b.vat_minor)) L.push({ account: '1420', debit: Number(b.vat_minor), credit: 0, description: d });
    L.push({ account: '2100', debit: 0, credit: Number(b.subtotal_minor) + Number(b.vat_minor) - Number(b.wht_minor), description: d });
    if (Number(b.wht_minor)) L.push({ account: WHT_ACCOUNT[b.wht_kind] ?? '2150', debit: 0, credit: Number(b.wht_minor), description: d });
  }
  for (const p of await Q(
    `SELECT p.amount_minor, b.currency, b.number, s.name AS supplier, a.kind FROM supplier_payment p JOIN supplier_bill b ON b.id = p.bill_id JOIN supplier s ON s.id = b.supplier_id LEFT JOIN cash_account a ON a.id = p.cash_account_id
      WHERE p.org_id = $1 AND p.voided_at IS NULL AND to_char(p.paid_on, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (billLines[p.currency] ??= []);
    L.push({ account: '2100', debit: Number(p.amount_minor), credit: 0, description: `Paid ${p.supplier} ${p.number}` }, { account: p.kind === 'cash' ? '1050' : '1100', debit: 0, credit: Number(p.amount_minor), description: `Paid ${p.supplier} ${p.number}` });
  }
  for (const [c, L] of Object.entries(billLines)) add('bills', c, `Supplier bills and payments, ${month}`, L);
  // Deposits.
  const depLines: Record<string, Line[]> = {};
  for (const d of await Q(`SELECT *, to_char(placed_on, 'YYYY-MM') AS pm, to_char(closed_on, 'YYYY-MM') AS cm FROM deposit WHERE org_id = $1 AND (to_char(placed_on, 'YYYY-MM') = $2 OR to_char(closed_on, 'YYYY-MM') = $2)`, [orgId, month])) {
    const L = (depLines[d.currency] ??= []);
    const what = `Deposit ${d.bank_name}${d.reference ? ` ${d.reference}` : ''}`;
    if (d.pm === month) L.push({ account: '1150', debit: Number(d.principal_minor), credit: 0, description: what }, { account: '1100', debit: 0, credit: Number(d.principal_minor), description: what });
    if (d.cm === month && d.status !== 'active') {
      const interest = Number(d.interest_received_minor ?? 0), penalty = Number(d.penalty_minor ?? 0);
      L.push({ account: '1100', debit: Number(d.principal_minor) + interest - penalty, credit: 0, description: what }, { account: '1150', debit: 0, credit: Number(d.principal_minor), description: what });
      if (interest) L.push({ account: '7300', debit: 0, credit: interest, description: what });
      if (penalty) L.push({ account: '8200', debit: penalty, credit: 0, description: what });
    }
  }
  for (const [c, L] of Object.entries(depLines)) add('deposits', c, `Time deposits, ${month}`, L);
  // Expense claims approved and reimbursed.
  const expLines: Record<string, Line[]> = {};
  for (const l of await Q(
    `SELECT c.currency, c.number, l.category, l.amount_minor, l.vat_minor FROM expense_claim_line l JOIN expense_claim c ON c.id = l.claim_id
      WHERE c.org_id = $1 AND l.removed_at IS NULL AND c.status IN ('approved', 'reimbursed') AND to_char(c.approved_at AT TIME ZONE $3, 'YYYY-MM') = $2`, [orgId, month, zone()])) {
    const L = (expLines[l.currency] ??= []);
    L.push({ account: CLAIM_ACCOUNT[l.category] ?? '6390', debit: Number(l.amount_minor), credit: 0, description: l.number });
    if (Number(l.vat_minor)) L.push({ account: '1420', debit: Number(l.vat_minor), credit: 0, description: l.number });
    L.push({ account: '2160', debit: 0, credit: Number(l.amount_minor) + Number(l.vat_minor), description: l.number });
  }
  for (const c of await Q(
    `SELECT c.currency, c.number, a.kind, (SELECT COALESCE(sum(l.amount_minor + l.vat_minor), 0) FROM expense_claim_line l WHERE l.claim_id = c.id AND l.removed_at IS NULL)::bigint AS total
       FROM expense_claim c LEFT JOIN cash_account a ON a.id = c.cash_account_id WHERE c.org_id = $1 AND c.status = 'reimbursed' AND to_char(c.reimbursed_on, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (expLines[c.currency] ??= []);
    L.push({ account: '2160', debit: Number(c.total), credit: 0, description: `Reimbursed ${c.number}` }, { account: c.kind === 'cash' ? '1050' : '1100', debit: 0, credit: Number(c.total), description: `Reimbursed ${c.number}` });
  }
  for (const [c, L] of Object.entries(expLines)) add('expenses', c, `Expense claims, ${month}`, L);
  // Intercompany.
  const icLines: Record<string, Line[]> = {};
  for (const r of await Q(
    `SELECT r.*, o.name AS from_name, t.name AS to_name FROM intercompany_recharge r JOIN organisation o ON o.id = r.org_id JOIN organisation t ON t.id = r.to_org_id
      WHERE (r.org_id = $1 OR r.to_org_id = $1) AND r.status IN ('issued', 'settled') AND r.month = $2`, [orgId, month])) {
    const L = (icLines[r.currency] ??= []);
    const amt = Number(r.amount_minor);
    if (r.org_id === orgId) L.push({ account: '1300', debit: amt, credit: 0, description: `${r.number} to ${r.to_name}` }, { account: '4900', debit: 0, credit: amt, description: `${r.number} to ${r.to_name}` });
    else L.push({ account: '6900', debit: amt, credit: 0, description: `${r.number} from ${r.from_name}` }, { account: '2300', debit: 0, credit: amt, description: `${r.number} from ${r.from_name}` });
  }
  for (const s of await Q(`SELECT * FROM intercompany_settlement WHERE (org_id = $1 OR other_org_id = $1) AND to_char(settled_on, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (icLines[s.currency] ??= []);
    // receivable/payable are from org_id's side; the other entity sees them the other way round.
    const mine = s.org_id === orgId;
    const rec = Number(mine ? s.receivable_minor : s.payable_minor), pay = Number(mine ? s.payable_minor : s.receivable_minor);
    const net = rec - pay;
    if (pay) L.push({ account: '2300', debit: pay, credit: 0, description: 'Intercompany settlement' });
    if (rec) L.push({ account: '1300', debit: 0, credit: rec, description: 'Intercompany settlement' });
    if (net > 0) L.push({ account: '1100', debit: net, credit: 0, description: 'Intercompany settlement' });
    if (net < 0) L.push({ account: '1100', debit: 0, credit: -net, description: 'Intercompany settlement' });
  }
  for (const [c, L] of Object.entries(icLines)) add('intercompany', c, `Intercompany, ${month}`, L);
  // (v1.33.0) Payroll: approved or paid runs of the month; the payment against the bank.
  const payLines: Record<string, Line[]> = {};
  for (const r of await Q(`SELECT r.*, a.kind AS acct_kind, to_char(r.paid_on, 'YYYY-MM') AS pm FROM payroll_run r LEFT JOIN cash_account a ON a.id = r.cash_account_id
      WHERE r.org_id = $1 AND r.status IN ('approved', 'paid') AND (r.month = $2 OR to_char(r.paid_on, 'YYYY-MM') = $2)`, [orgId, month])) {
    const L = (payLines[r.currency] ??= []);
    const t = r.totals ?? {};
    const d = `Payroll ${r.month}`;
    if (r.month === month) {
      L.push({ account: '6100', debit: Number(t.wages ?? 0), credit: 0, description: d }, { account: '6105', debit: Number(t.employerBpjs ?? 0), credit: 0, description: d },
        { account: '2170', debit: 0, credit: Number(t.net ?? 0), description: d }, { account: '2151', debit: 0, credit: Number(t.pph21 ?? 0), description: d },
        { account: '2180', debit: 0, credit: Number(t.employerBpjs ?? 0) + Number(t.employeeBpjs ?? 0), description: d }, { account: '2190', debit: 0, credit: Number(t.deductions ?? 0), description: d });
    }
    if (r.status === 'paid' && r.pm === month) L.push({ account: '2170', debit: Number(t.net ?? 0), credit: 0, description: `Paid ${d}` }, { account: r.acct_kind === 'cash' ? '1050' : '1100', debit: 0, credit: Number(t.net ?? 0), description: `Paid ${d}` });
  }
  for (const [c, L] of Object.entries(payLines)) add('payroll', c, `Payroll, ${month}`, L);
  // (v1.33.0) Customer security deposits: received and returned through the bank; applied to an invoice as fleet revenue.
  const cdLines: Record<string, Line[]> = {};
  for (const x of await Q(`SELECT d.*, a.name AS account_name, c.kind AS acct_kind FROM customer_deposit d JOIN fleet_account a ON a.id = d.fleet_account_id LEFT JOIN cash_account c ON c.id = d.cash_account_id
      WHERE d.org_id = $1 AND d.voided_at IS NULL AND to_char(d.on_date, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (cdLines[x.currency] ??= []);
    const amt = Number(x.amount_minor), bank = x.acct_kind === 'cash' ? '1050' : '1100', d = `Deposit ${x.account_name}`;
    if (x.kind === 'received') L.push({ account: bank, debit: amt, credit: 0, description: d }, { account: '2200', debit: 0, credit: amt, description: d });
    else if (x.kind === 'returned') L.push({ account: '2200', debit: amt, credit: 0, description: d }, { account: bank, debit: 0, credit: amt, description: d });
    else L.push({ account: '2200', debit: amt, credit: 0, description: d }, { account: '4200', debit: 0, credit: amt, description: d });
  }
  for (const [c, L] of Object.entries(cdLines)) add('customer_deposits', c, `Customer deposits, ${month}`, L);
  // (v1.33.0) Capex projects completed (assets under construction into fixed assets) or cancelled (written off).
  const prLines: Record<string, Line[]> = {};
  for (const p of await Q(`SELECT p.*, (SELECT COALESCE(sum(b.subtotal_minor), 0) FROM supplier_bill b WHERE b.capex_project_id = p.id AND b.status IN ('approved', 'paid') AND NOT b.capitalise)::bigint AS auc
      FROM capex_project p WHERE p.org_id = $1 AND p.status IN ('completed', 'cancelled') AND to_char(p.completed_on, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (prLines[p.currency] ??= []);
    const amt = Number(p.auc), d = `${p.number} ${p.name}`;
    if (!amt) continue;
    L.push({ account: p.status === 'completed' ? '1600' : '8300', debit: amt, credit: 0, description: d }, { account: '1610', debit: 0, credit: amt, description: d });
  }
  for (const [c, L] of Object.entries(prLines)) add('projects', c, `Capex projects, ${month}`, L);
  // (v1.34.0) Inventory: receipts against goods received not invoiced, issues to spare parts used, counts to adjustments.
  const invLines: Record<string, Line[]> = {};
  for (const m of await Q(`SELECT m.kind, i.currency, sum(m.value_minor)::bigint AS v FROM stock_move m JOIN stock_item i ON i.id = m.item_id
      WHERE m.org_id = $1 AND to_char(m.on_date, 'YYYY-MM') = $2 AND m.kind IN ('receipt', 'issue', 'adjust') GROUP BY 1, 2`, [orgId, month])) {
    const L = (invLines[m.currency] ??= []);
    const v = Number(m.v);
    if (m.kind === 'receipt') L.push({ account: '1700', debit: v, credit: 0, description: 'Stock received' }, { account: '2105', debit: 0, credit: v, description: 'Stock received' });
    else if (m.kind === 'issue') L.push({ account: '6260', debit: -v, credit: 0, description: 'Parts issued' }, { account: '1700', debit: 0, credit: -v, description: 'Parts issued' });
    else if (v > 0) L.push({ account: '1700', debit: v, credit: 0, description: 'Stock counted' }, { account: '6265', debit: 0, credit: v, description: 'Stock counted' });
    else if (v < 0) L.push({ account: '6265', debit: -v, credit: 0, description: 'Stock counted' }, { account: '1700', debit: 0, credit: -v, description: 'Stock counted' });
  }
  for (const [c, L] of Object.entries(invLines)) add('inventory', c, `Inventory, ${month}`, L);
  // (v1.34.0) Maintenance: labour of orders done in the month, the contractor accrual (reversed the next month), warranty paid.
  const mtLines: Record<string, Line[]> = {};
  const prev = addMonths(month, -1);
  for (const w of await Q(`SELECT w.*, to_char(w.done_on, 'YYYY-MM') AS dm, (SELECT count(*) FROM supplier_bill b WHERE b.work_order_id = w.id AND b.status <> 'void' AND to_char(b.bill_date, 'YYYY-MM') <= $2)::int AS billed
      FROM work_order w WHERE w.org_id = $1 AND w.status = 'done' AND to_char(w.done_on, 'YYYY-MM') IN ($2, $3)`, [orgId, month, prev])) {
    const L = (mtLines[w.currency] ??= []);
    const labour = Math.round(Number(w.labour_hours) * Number(w.labour_rate_minor)), est = Number(w.contractor_estimate_minor);
    if (w.dm === month && labour) L.push({ account: '6270', debit: labour, credit: 0, description: w.number }, { account: '2115', debit: 0, credit: labour, description: w.number });
    if (w.dm === month && est && !w.billed) L.push({ account: '6200', debit: est, credit: 0, description: `${w.number} accrued` }, { account: '2110', debit: 0, credit: est, description: `${w.number} accrued` });
    // Last month's accrual reversed, whether or not the bill has come.
    if (w.dm === prev && est) {
      const was = await Q(`SELECT count(*)::int AS n FROM supplier_bill b WHERE b.work_order_id = $1 AND b.status <> 'void' AND to_char(b.bill_date, 'YYYY-MM') <= $2`, [w.id, prev]);
      if (!was[0]?.n) L.push({ account: '2110', debit: est, credit: 0, description: `${w.number} accrual reversed` }, { account: '6200', debit: 0, credit: est, description: `${w.number} accrual reversed` });
    }
  }
  for (const c of await Q(`SELECT c.currency, c.paid_minor, w.number FROM warranty_claim c JOIN work_order w ON w.id = c.work_order_id WHERE c.org_id = $1 AND c.status = 'paid' AND to_char(c.paid_on, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (mtLines[c.currency] ??= []);
    L.push({ account: '1100', debit: Number(c.paid_minor), credit: 0, description: `Warranty ${c.number}` }, { account: '6205', debit: 0, credit: Number(c.paid_minor), description: `Warranty ${c.number}` });
  }
  for (const [c, L] of Object.entries(mtLines)) add('maintenance', c, `Maintenance, ${month}`, L);
  // (v1.34.0) Loans: drawdowns and payments.
  const lnLines: Record<string, Line[]> = {};
  for (const d of await Q(`SELECT d.amount_minor, l.currency, l.lender, a.kind FROM loan_drawdown d JOIN loan l ON l.id = d.loan_id LEFT JOIN cash_account a ON a.id = l.cash_account_id WHERE d.org_id = $1 AND d.voided_at IS NULL AND to_char(d.on_date, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (lnLines[d.currency] ??= []);
    L.push({ account: d.kind === 'cash' ? '1050' : '1100', debit: Number(d.amount_minor), credit: 0, description: `Drawdown ${d.lender}` }, { account: '2500', debit: 0, credit: Number(d.amount_minor), description: `Drawdown ${d.lender}` });
  }
  for (const p of await Q(`SELECT p.*, l.currency, l.lender, a.kind FROM loan_payment p JOIN loan l ON l.id = p.loan_id LEFT JOIN cash_account a ON a.id = l.cash_account_id WHERE p.org_id = $1 AND p.voided_at IS NULL AND to_char(p.on_date, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (lnLines[p.currency] ??= []);
    const tot = Number(p.principal_minor) + Number(p.interest_minor) + Number(p.fees_minor), d = `Payment ${p.lender}`;
    if (Number(p.principal_minor)) L.push({ account: '2500', debit: Number(p.principal_minor), credit: 0, description: d });
    if (Number(p.interest_minor)) L.push({ account: '7210', debit: Number(p.interest_minor), credit: 0, description: d });
    if (Number(p.fees_minor)) L.push({ account: '7215', debit: Number(p.fees_minor), credit: 0, description: d });
    L.push({ account: p.kind === 'cash' ? '1050' : '1100', debit: 0, credit: tot, description: d });
  }
  for (const [c, L] of Object.entries(lnLines)) add('loans', c, `Loans, ${month}`, L);
  // (v1.35.0) Carbon: RECs bought (Dr 1750) and retired against the month (Dr 5150); carbon credits sold (Cr 4300).
  const cbLines: Record<string, Line[]> = {};
  const bank = (kind: string | null) => (kind === 'cash' ? '1050' : '1100');
  for (const r of await Q(`SELECT r.*, to_char(r.bought_on, 'YYYY-MM') AS bm, a.kind FROM rec_purchase r LEFT JOIN cash_account a ON a.id = r.cash_account_id WHERE r.org_id = $1 AND r.voided_at IS NULL AND (to_char(r.bought_on, 'YYYY-MM') = $2 OR r.retired_month = $2)`, [orgId, month])) {
    const L = (cbLines[r.currency] ??= []), v = Number(r.price_minor), d = `REC ${r.registry} ${r.vintage}${r.reference ? ` ${r.reference}` : ''}`;
    if (!v) continue;
    if (r.bm === month)
      L.push({ account: '1750', debit: v, credit: 0, description: `${d} bought` }, { account: bank(r.kind), debit: 0, credit: v, description: `${d} bought` });
    if (r.retired_month === month) L.push({ account: '5150', debit: v, credit: 0, description: `${d} retired` }, { account: '1750', debit: 0, credit: v, description: `${d} retired` });
  }
  for (const x of await Q(`SELECT x.*, a.kind FROM carbon_credit_sale x LEFT JOIN cash_account a ON a.id = x.cash_account_id WHERE x.org_id = $1 AND x.voided_at IS NULL AND to_char(x.sold_on, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (cbLines[x.currency] ??= []), v = Number(x.amount_minor), d = `Carbon credits ${Number(x.tonnes)} t to ${x.buyer}`;
    if (v) L.push({ account: bank(x.kind), debit: v, credit: 0, description: d }, { account: '4300', debit: 0, credit: v, description: d });
  }
  for (const [c, L] of Object.entries(cbLines)) add('carbon', c, `Carbon, ${month}`, L);
  // (v1.35.0) Insurance: premiums paid (Dr 1450 prepaid), the month's share of each paid premium (Dr 6600), claims paid (Cr 6605).
  const inLines: Record<string, Line[]> = {};
  for (const p of await Q(`SELECT p.*, to_char(p.start_on, 'YYYY-MM-DD') AS s, to_char(p.end_on, 'YYYY-MM-DD') AS e, to_char(p.paid_on, 'YYYY-MM') AS pm, a.kind FROM insurance_policy p LEFT JOIN cash_account a ON a.id = p.cash_account_id
      WHERE p.org_id = $1 AND p.status = 'active' AND p.paid_on IS NOT NULL AND p.premium_minor > 0 AND (to_char(p.paid_on, 'YYYY-MM') = $2 OR (to_char(p.start_on, 'YYYY-MM') <= $2 AND to_char(p.end_on - 1, 'YYYY-MM') >= $2))`, [orgId, month])) {
    const L = (inLines[p.currency] ??= []), v = Number(p.premium_minor), d = `${p.insurer} ${p.policy_no}`;
    if (p.pm === month) L.push({ account: '1450', debit: v, credit: 0, description: `${d} premium paid` }, { account: bank(p.kind), debit: 0, credit: v, description: `${d} premium paid` });
    const share = monthShare(v, p.s, p.e, month);
    if (share) L.push({ account: '6600', debit: share, credit: 0, description: `${d} ${month}` }, { account: '1450', debit: 0, credit: share, description: `${d} ${month}` });
  }
  for (const c of await Q(`SELECT c.number, c.settled_minor, p.currency, p.insurer, a.kind FROM insurance_claim c JOIN insurance_policy p ON p.id = c.policy_id LEFT JOIN cash_account a ON a.id = p.cash_account_id
      WHERE c.org_id = $1 AND c.status IN ('paid', 'closed') AND c.settled_minor > 0 AND to_char(c.paid_on, 'YYYY-MM') = $2`, [orgId, month])) {
    const L = (inLines[c.currency] ??= []), v = Number(c.settled_minor), d = `Claim ${c.number} ${c.insurer}`;
    L.push({ account: bank(c.kind), debit: v, credit: 0, description: d }, { account: '6605', debit: 0, credit: v, description: d });
  }
  for (const [c, L] of Object.entries(inLines)) add('insurance', c, `Insurance, ${month}`, L);
  // (v1.36.0) Grants, landlord rent accruals and chargebacks, each module's own journal (imported here: no cycles).
  for (const [src, mod, label] of [['grants', './grants.js', 'Grants'], ['landlords', './landlord-deals.js', 'Landlord rent'], ['chargebacks', './chargebacks.js', 'Chargebacks'], ['loyalty', './loyalty-accounting.js', 'Loyalty points'], ['fx', './fx-treasury.js', 'FX hedges settled'], ['tax', './corporate-tax.js', 'Corporate income tax'], ['cards', './corporate-cards.js', 'Corporate cards']] as const) {
    const j: Record<string, Line[]> = await (await import(mod)).journal(orgId, month);
    for (const [c, L] of Object.entries(j)) if (L.length) add(src, c, `${label}, ${month}`, L);
  }
  return out.filter((d) => balanced(d.lines));
}

/** (Re)post the modules' entries for a month: unchanged ones stay, changed ones are superseded by new ones. */
export async function sync(orgId: string, monthRaw: unknown, userId: string | null, now = new Date()) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new LedgerError(422, 'month is YYYY-MM.');
  if (month > thisMonth(now)) throw new LedgerError(422, 'A month that has not started is not synced.');
  await assertOpen(orgId, month, 'The ledger', ERR);
  await ensureChart(orgId);
  const ds = await drafts(orgId, month);
  const existing = await outsideRequestScope(() => many<any>(`SELECT e.id, e.source_ref FROM gl_entry e WHERE e.org_id = $1 AND e.month = $2 AND e.source NOT IN ('manual', 'reversal') AND e.status = 'posted'`, [orgId, month]));
  const lines = existing.length ? await outsideRequestScope(() => many<any>(`SELECT entry_id, account_code, debit, credit, description FROM gl_line WHERE entry_id = ANY($1::bigint[]) ORDER BY id`, [existing.map((e) => e.id)])) : [];
  const sig = (ls: Array<{ account: string; debit: number; credit: number; description?: string | null }>) => JSON.stringify(ls.map((l) => [l.account, r2(Number(l.debit)), r2(Number(l.credit)), l.description ?? null]).sort());
  let posted = 0, unchanged = 0, superseded = 0;
  const keep = new Set<string>();
  for (const d of ds) {
    const ex = existing.find((e) => e.source_ref === d.ref);
    keep.add(d.ref);
    if (ex && sig(lines.filter((l) => String(l.entry_id) === String(ex.id)).map((l) => ({ account: l.account_code, debit: Number(l.debit), credit: Number(l.credit), description: l.description }))) === sig(d.lines)) { unchanged++; continue; }
    if (ex) { await outsideRequestScope(() => query(`UPDATE gl_entry SET status = 'superseded' WHERE id = $1`, [ex.id])); superseded++; }
    await ensureAccounts(orgId, d.lines);
    await insertEntry(orgId, { date: d.date, month, currency: d.currency, source: d.source, ref: d.ref, memo: d.memo, status: 'posted', lines: d.lines, userId });
    posted++;
  }
  for (const e of existing) if (!keep.has(e.source_ref)) { await outsideRequestScope(() => query(`UPDATE gl_entry SET status = 'superseded' WHERE id = $1`, [e.id])); superseded++; }
  return { month, posted, unchanged, superseded };
}

// ─────────────────────────────────────────── manual entries

const ENTRY_SELECT = `SELECT e.*, to_char(e.entry_date, 'YYYY-MM-DD') AS date_s, su.name AS submitted_by_name, ap.name AS approved_by_name, fa.name AS first_approved_by_name
  FROM gl_entry e LEFT JOIN app_user su ON su.id = e.submitted_by LEFT JOIN app_user ap ON ap.id = e.approved_by LEFT JOIN app_user fa ON fa.id = e.first_approved_by`;

async function entryView(orgId: string, r: any) {
  const ls = await outsideRequestScope(() => many<any>(`SELECT l.*, a.name FROM gl_line l LEFT JOIN gl_account a ON a.org_id = l.org_id AND a.code = l.account_code WHERE l.entry_id = $1 ORDER BY l.id`, [r.id]));
  void orgId;
  const lines = ls.map((l) => ({ account: l.account_code, name: l.name ?? null, debit: Number(l.debit), credit: Number(l.credit), description: l.description ?? null }));
  return {
    id: String(r.id), number: r.number, date: r.date_s, month: r.month, currency: r.currency, source: r.source, sourceRef: r.source_ref ?? null, memo: r.memo, status: r.status,
    total: r2(lines.reduce((a, l) => a + l.debit, 0)), lines,
    submittedBy: r.submitted_by_name ?? null, firstApprovedBy: r.first_approved_by_name ?? null, approvedBy: r.approved_by_name ?? null,
    postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null, rejectReason: r.reject_reason ?? null,
    reversalOf: r.reversal_of == null ? null : String(r.reversal_of), reversedBy: r.reversed_by == null ? null : String(r.reversed_by),
  };
}
export type EntryView = Awaited<ReturnType<typeof entryView>>;

export async function entries(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const month = q.month == null || q.month === '' ? thisMonth(now) : String(q.month);
  if (!MONTH_RE.test(month)) throw new LedgerError(422, 'month is YYYY-MM.');
  const status = q.status == null || q.status === '' ? null : String(q.status);
  const source = q.source == null || q.source === '' ? null : String(q.source);
  const rows = await outsideRequestScope(() => many<any>(
    `${ENTRY_SELECT} WHERE e.org_id = $1 AND (e.month = $2 OR ($3::text = 'awaiting_approval' AND e.status = 'awaiting_approval')) AND ($3::text IS NULL OR e.status = $3) AND ($4::text IS NULL OR e.source = $4)
      AND ($3::text IS NOT NULL OR e.status <> 'superseded') ORDER BY e.entry_date, e.id LIMIT 500`, [orgId, month, status, source]));
  const out = [];
  for (const r of rows) out.push(await entryView(orgId, r));
  const pending = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) AS n FROM gl_entry WHERE org_id = $1 AND status = 'awaiting_approval'`, [orgId]));
  return { month, locked: await isLocked(orgId, month), entries: out, awaitingApproval: Number(pending?.n ?? 0) };
}

async function entryRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new LedgerError(404, 'No such entry.');
  const r = await outsideRequestScope(() => one<any>(`${ENTRY_SELECT} WHERE e.id = $1 AND e.org_id = $2`, [id, orgId]));
  if (!r) throw new LedgerError(404, 'No such entry.');
  return r;
}

export async function get(orgId: string, id: string) { return entryView(orgId, await entryRow(orgId, id)); }

export async function createManual(orgId: string, b: Record<string, unknown>, userId: string | null) {
  await ensureChart(orgId);
  const date = String(b.date ?? '');
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new LedgerError(422, 'date is YYYY-MM-DD.');
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new LedgerError(422, 'currency is an ISO code.');
  const memo = String(b.memo ?? '').trim();
  if (memo.length < 3) throw new LedgerError(422, 'memo: say what the entry is for (at least 3 characters).');
  const raw = Array.isArray(b.lines) ? b.lines as Array<Record<string, unknown>> : [];
  if (raw.length < 2 || raw.length > 100) throw new LedgerError(422, 'lines: 2 to 100 lines (account, debit or credit).');
  const accounts = new Map((await chart(orgId)).map((a) => [a.code, a]));
  const lines: Line[] = raw.map((l, i) => {
    const account = String(l.account ?? '');
    const a = accounts.get(account);
    if (!a) throw new LedgerError(422, `Line ${i + 1}: no account ${account} in the chart.`);
    if (!a.active) throw new LedgerError(422, `Line ${i + 1}: ${account} is not active.`);
    const debit = l.debit == null || l.debit === '' ? 0 : Number(l.debit), credit = l.credit == null || l.credit === '' ? 0 : Number(l.credit);
    if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) throw new LedgerError(422, `Line ${i + 1}: a debit or a credit above 0, not both.`);
    return { account, debit: r2(debit), credit: r2(credit), description: l.description == null ? null : String(l.description).slice(0, 200) };
  });
  if (!balanced(lines)) throw new LedgerError(422, `The entry does not balance: debits ${r2(lines.reduce((a, l) => a + l.debit, 0))}, credits ${r2(lines.reduce((a, l) => a + l.credit, 0))}.`);
  await assertOpen(orgId, date.slice(0, 7), 'A journal entry', ERR);
  const draft = b.draft === true || b.draft === 'true';
  const id = await insertEntry(orgId, { date, month: date.slice(0, 7), currency, source: 'manual', ref: null, memo, status: draft ? 'draft' : 'awaiting_approval', lines, userId });
  return get(orgId, id);
}

export async function submit(orgId: string, id: string, userId: string | null) {
  const r = await entryRow(orgId, id);
  if (r.source !== 'manual' || (r.status !== 'draft' && r.status !== 'rejected')) throw new LedgerError(409, `The entry is ${r.status.replace('_', ' ')}.`);
  await outsideRequestScope(() => query(`UPDATE gl_entry SET status = 'awaiting_approval', submitted_by = $3, reject_reason = NULL, first_approved_by = NULL, first_approved_at = NULL WHERE id = $1 AND org_id = $2`, [id, orgId, userId]));
  return get(orgId, id);
}

export async function approve(orgId: string, id: string, who: Approver) {
  const r = await entryRow(orgId, id);
  if (r.status !== 'awaiting_approval') throw new LedgerError(409, `The entry is ${r.status.replace('_', ' ')}.`);
  await assertOpen(orgId, r.month, 'A journal entry', ERR);
  const total = (await get(orgId, id)).total;
  const step = await gate('journal_entry', orgId, { id: r.id, amount: Math.round(total), requested_by: r.submitted_by, first_approved_by: r.first_approved_by }, who);
  if (step === 'first') return { ...(await get(orgId, id)), waitingForSecondApprover: true };
  const won = await outsideRequestScope(() => one(`UPDATE gl_entry SET status = 'posted', approved_by = $3, posted_at = now() WHERE id = $1 AND org_id = $2 AND status = 'awaiting_approval' RETURNING id`, [id, orgId, who.userId]));
  if (!won) throw new LedgerError(409, 'Someone changed the entry at the same time. Reload.');
  return get(orgId, id);
}

export async function reject(orgId: string, id: string, reasonRaw: unknown, userId: string | null) {
  const r = await entryRow(orgId, id);
  if (r.status !== 'awaiting_approval') throw new LedgerError(409, `The entry is ${r.status.replace('_', ' ')}.`);
  if (r.submitted_by === userId) throw new LedgerError(403, 'An entry is rejected by someone other than the person who submitted it.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new LedgerError(422, 'Give a reason (at least 3 characters).');
  await outsideRequestScope(() => query(`UPDATE gl_entry SET status = 'rejected', reject_reason = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, reason.slice(0, 300)]));
  return get(orgId, id);
}

/** Reverse a posted manual entry on a date (an open month): the same lines, debits and credits swapped, posted. */
export async function reverse(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const r = await entryRow(orgId, id);
  if (r.status !== 'posted') throw new LedgerError(409, 'Only a posted entry is reversed.');
  if (r.source !== 'manual') throw new LedgerError(409, 'A module\'s entry is corrected in the module and synced again, not reversed.');
  if (r.reversed_by) throw new LedgerError(409, 'The entry is already reversed.');
  const date = b.date == null || b.date === '' ? r.date_s : String(b.date);
  if (!DATE_RE.test(date) || date < r.date_s) throw new LedgerError(422, 'date is YYYY-MM-DD, not before the entry.');
  await assertOpen(orgId, date.slice(0, 7), 'A reversal', ERR);
  const e = await get(orgId, id);
  const rid = await insertEntry(orgId, { date, month: date.slice(0, 7), currency: e.currency, source: 'reversal', ref: null, memo: `Reversal of ${e.number}: ${e.memo}`, status: 'posted',
    lines: e.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, description: l.description })), userId, reversalOf: id });
  await outsideRequestScope(() => query(`UPDATE gl_entry SET reversed_by = $2 WHERE id = $1`, [id, rid]));
  return get(orgId, rid);
}

// ─────────────────────────────────────────── reports

export async function balances(orgId: string, currency: string, from: string | null, to: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT l.account_code AS code, COALESCE(a.name, l.account_code) AS name, a.type AS type, sum(l.debit) AS debit, sum(l.credit) AS credit
       FROM gl_line l JOIN gl_entry e ON e.id = l.entry_id LEFT JOIN gl_account a ON a.org_id = l.org_id AND a.code = l.account_code
      WHERE e.org_id = $1 AND e.status = 'posted' AND e.currency = $2 AND e.month <= $4 AND ($3::text IS NULL OR e.month >= $3)
      GROUP BY 1, 2, 3 ORDER BY 1`, [orgId, currency, from, to]));
  // (v1.39.0) An account not in the chart yet takes the type its code implies.
  return rows.map((r) => ({ code: r.code as string, name: r.name as string, type: (r.type ?? typeByCode(r.code)) as AccountType, debit: r2(Number(r.debit)), credit: r2(Number(r.credit)), balance: r2(Number(r.debit) - Number(r.credit)) }));
}

export async function currencies(orgId: string) {
  const rows = await outsideRequestScope(() => many<{ currency: string }>(`SELECT DISTINCT currency FROM gl_entry WHERE org_id = $1 AND status = 'posted' ORDER BY 1`, [orgId]));
  return rows.map((r) => r.currency);
}

export async function reports(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const month = q.month == null || q.month === '' ? addMonths(thisMonth(now), -1) : String(q.month);
  if (!MONTH_RE.test(month)) throw new LedgerError(422, 'month is YYYY-MM.');
  const curs = await currencies(orgId);
  const currency = q.currency == null || q.currency === '' ? (curs[0] ?? LEGACY_CURRENCY) : String(q.currency).toUpperCase();
  const yearStart = `${month.slice(0, 4)}-01`;
  const [tb, mon, ytd] = await Promise.all([balances(orgId, currency, null, month), balances(orgId, currency, month, month), balances(orgId, currency, yearStart, month)]);
  const pl = (rows: typeof tb) => {
    const revenue = rows.filter((r) => r.type === 'revenue').map((r) => ({ ...r, amount: -r.balance }));
    const expense = rows.filter((r) => r.type === 'expense').map((r) => ({ ...r, amount: r.balance }));
    const other = rows.filter((r) => r.type === 'other').map((r) => ({ ...r, amount: -r.balance }));
    const sum = (xs: Array<{ amount: number }>) => r2(xs.reduce((a, x) => a + x.amount, 0));
    return { revenue, expense, other, totalRevenue: sum(revenue), totalExpense: sum(expense), totalOther: sum(other), result: r2(sum(revenue) - sum(expense) + sum(other)) };
  };
  const plMonth = pl(mon), plYtd = pl(ytd);
  // Balance sheet: assets, liabilities and equity to the month's end; the result of every earlier year in retained earnings, this year's beside it.
  const priorPl = pl(await balances(orgId, currency, null, addMonths(yearStart, -1)));
  const assets = tb.filter((r) => r.type === 'asset').map((r) => ({ ...r, amount: r.balance }));
  const liabilities = tb.filter((r) => r.type === 'liability').map((r) => ({ ...r, amount: -r.balance }));
  const equity = tb.filter((r) => r.type === 'equity').map((r) => ({ ...r, amount: -r.balance }));
  const s = (xs: Array<{ amount: number }>) => r2(xs.reduce((a, x) => a + x.amount, 0));
  const totalEquity = r2(s(equity) + priorPl.result + plYtd.result);
  return {
    month, currency, currencies: curs.length ? curs : [currency], locked: await isLocked(orgId, month),
    trialBalance: { rows: tb, debit: r2(tb.reduce((a, r) => a + Math.max(0, r.balance), 0)), credit: r2(tb.reduce((a, r) => a + Math.max(0, -r.balance), 0)), balanced: r2(tb.reduce((a, r) => a + r.balance, 0)) === 0 },
    profitAndLoss: { month: plMonth, yearToDate: plYtd },
    balanceSheet: { assets, liabilities, equity, priorYearsResult: priorPl.result, yearResult: plYtd.result, totalAssets: s(assets), totalLiabilities: s(liabilities), totalEquity,
      balanced: r2(s(assets) - s(liabilities) - totalEquity) === 0 },
  };
}

export async function accountLines(orgId: string, code: string, q: Record<string, unknown> = {}, now = new Date()) {
  const month = q.month == null || q.month === '' ? thisMonth(now) : String(q.month);
  if (!MONTH_RE.test(month)) throw new LedgerError(422, 'month is YYYY-MM.');
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT e.number, to_char(e.entry_date, 'YYYY-MM-DD') AS d, e.currency, e.source, e.memo, l.debit, l.credit, l.description
       FROM gl_line l JOIN gl_entry e ON e.id = l.entry_id WHERE e.org_id = $1 AND e.status = 'posted' AND l.account_code = $2 AND e.month = $3 ORDER BY e.entry_date, e.id, l.id`, [orgId, code, month]));
  return { code, month, lines: rows.map((r) => ({ number: r.number, date: r.d, currency: r.currency, source: r.source, memo: r.memo, debit: Number(r.debit), credit: Number(r.credit), description: r.description ?? null })) };
}

export function reportsXlsx(r: Awaited<ReturnType<typeof reports>>): Buffer {
  const pl = (p: Awaited<ReturnType<typeof reports>>['profitAndLoss']['month']) => [
    ['Revenue', '', ''], ...p.revenue.map((x) => [x.code, x.name, x.amount]), ['', 'Total revenue', p.totalRevenue],
    ['Expenses', '', ''], ...p.expense.map((x) => [x.code, x.name, x.amount]), ['', 'Total expenses', p.totalExpense],
    ['Other income and expense', '', ''], ...p.other.map((x) => [x.code, x.name, x.amount]), ['', 'Total other', p.totalOther], ['', 'Result', p.result]];
  const b = r.balanceSheet;
  return xlsx([
    { name: 'Trial balance', rows: [['Code', 'Account', 'Type', 'Debits', 'Credits', 'Balance'], ...r.trialBalance.rows.map((x) => [x.code, x.name, x.type, x.debit, x.credit, x.balance])], widths: [10, 40, 10, 16, 16, 16], formats: [null, null, null, 'money', 'money', 'money'] },
    { name: `P&L ${r.month}`, rows: [['Code', 'Account', r.currency], ...pl(r.profitAndLoss.month)], widths: [10, 40, 18], formats: [null, null, 'money'] },
    { name: 'P&L year to date', rows: [['Code', 'Account', r.currency], ...pl(r.profitAndLoss.yearToDate)], widths: [10, 40, 18], formats: [null, null, 'money'] },
    { name: 'Balance sheet', rows: [['Code', 'Account', r.currency], ['Assets', '', ''], ...b.assets.map((x) => [x.code, x.name, x.amount]), ['', 'Total assets', b.totalAssets],
      ['Liabilities', '', ''], ...b.liabilities.map((x) => [x.code, x.name, x.amount]), ['', 'Total liabilities', b.totalLiabilities],
      ['Equity', '', ''], ...b.equity.map((x) => [x.code, x.name, x.amount]), ['', 'Result of earlier years', b.priorYearsResult], ['', 'Result of the year', b.yearResult], ['', 'Total equity', b.totalEquity]],
      widths: [10, 40, 18], formats: [null, null, 'money'] },
  ]);
}
