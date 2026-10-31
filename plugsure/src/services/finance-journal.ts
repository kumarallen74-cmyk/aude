import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { xlsx, type Sheet } from './xlsx.js';
import { FinanceError, methodName, type Account, type Period } from './finance.js';

/**
 * The accounting journal (v1.17.0): one gateway account's period as double-entry journal entries, for the operator's
 * accounting software (Jurnal, Accurate, …) or accountant. Built from Finance's ledger of the gateway and the owner
 * payouts recorded against statements; one entry per day and kind, every entry balanced:
 *
 *   collections      Dr gateway balance         Cr charging revenue (collected)     what drivers paid at the gateway
 *   gateway fees     Dr gateway fees            Cr gateway balance                  the gateway's fee …
 *                    Dr VAT input on fees                                           … and the VAT on it
 *   withholding tax  Dr gateway balance         Cr withholding tax payable          as the gateway reports it
 *   refunds          Dr refunds to drivers      Cr gateway balance                  refunds paid through the gateway
 *   withdrawals      Dr bank                    Cr gateway balance                  settlements / payouts to the bank
 *   owner payouts    Dr owners' shares payable  Cr bank                             recorded against owner statements
 *
 * The account codes and names are the operator's (gateway_account_settings.journal_accounts); PlugSure's defaults
 * otherwise. Days in the platform time zone. Amounts in rupiah with two decimals (gateway fees have cents).
 */

export const JOURNAL_KEYS = ['gateway', 'bank', 'revenue', 'refunds', 'fees', 'vatInput', 'whtPayable', 'ownerPayable'] as const;
export type JournalKey = typeof JOURNAL_KEYS[number];
export type ChartOfAccounts = Record<JournalKey, { code: string; name: string }>;

export const DEFAULT_ACCOUNTS: ChartOfAccounts = {
  gateway: { code: '1130', name: 'Payment gateway balance' },
  bank: { code: '1110', name: 'Bank' },
  revenue: { code: '4100', name: 'Charging revenue (collected)' },
  refunds: { code: '4190', name: 'Refunds to drivers' },
  fees: { code: '6110', name: 'Payment gateway fees' },
  vatInput: { code: '1410', name: 'VAT input on gateway fees' },
  whtPayable: { code: '2140', name: 'Withholding tax payable' },
  ownerPayable: { code: '2120', name: 'Site owners\' shares payable' },
};
export const JOURNAL_LABELS: Record<JournalKey, string> = {
  gateway: 'Gateway balance (money held at the gateway)', bank: 'Bank', revenue: 'Charging revenue (what drivers paid)', refunds: 'Refunds to drivers',
  fees: 'Gateway fees', vatInput: 'VAT input on gateway fees', whtPayable: 'Withholding tax payable', ownerPayable: 'Site owners\' shares payable',
};

export interface FinanceSettings {
  journalAccounts: ChartOfAccounts;
  contractRates: ContractRates;
  accountingPackage: AccountingPackage | null;
  closeEmail: { enabled: boolean; recipients: string[]; sentPeriod: string | null; lastError: string | null; lastAt: string | null };
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** (v1.19.0) A rate agreed with the gateway for a method: pct of the amount plus a fixed fee (excluding VAT), with an
 * optional minimum, and the amount up to which the method is free (QRIS: 0% up to Rp 100,000 from October 2026). */
export interface ContractRate { pct: number; fixed?: number; min?: number; freeUpTo?: number }
export type ContractRates = Record<string, ContractRate>;
export const ACCOUNTING_PACKAGES = ['jurnal', 'accurate', 'generic'] as const;
export type AccountingPackage = typeof ACCOUNTING_PACKAGES[number];

function validRates(raw: unknown): ContractRates {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new FinanceError(422, 'contractRates is an object of { pct, fixed, min, freeUpTo } by method.');
  const out: ContractRates = {};
  const entries = Object.entries(raw as Record<string, any>);
  if (entries.length > 40) throw new FinanceError(422, 'At most 40 methods.');
  for (const [k, v] of entries) {
    const m = methodName(k);
    if (!/^[A-Z0-9_]{2,40}$/.test(m)) throw new FinanceError(422, `"${k.slice(0, 40)}" is not a payment method code (e.g. QRIS, DANA, CARD).`);
    const n = (x: unknown, what: string, max: number) => {
      if (x == null || x === '') return undefined;
      const y = Number(x);
      if (!Number.isFinite(y) || y < 0 || y > max) throw new FinanceError(422, `${m}: ${what} is a number from 0 to ${max}.`);
      return y;
    };
    const pct = n(v?.pct, 'the percentage', 20);
    if (pct === undefined) throw new FinanceError(422, `${m}: the percentage (pct) is required (0 for a fixed fee only).`);
    out[m] = { pct, ...(n(v?.fixed, 'the fixed fee', 100_000) !== undefined ? { fixed: n(v?.fixed, 'the fixed fee', 100_000)! } : {}),
      ...(n(v?.min, 'the minimum fee', 100_000) !== undefined ? { min: n(v?.min, 'the minimum fee', 100_000)! } : {}),
      ...(n(v?.freeUpTo, 'the free-up-to amount', 100_000_000) !== undefined ? { freeUpTo: n(v?.freeUpTo, 'the free-up-to amount', 100_000_000)! } : {}) };
  }
  return out;
}

export async function settingsFor(a: Account): Promise<FinanceSettings> {
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM gateway_account_settings WHERE integration_id = $1`, [a.id]));
  const saved = (r?.journal_accounts ?? {}) as Partial<ChartOfAccounts>;
  const journalAccounts = Object.fromEntries(JOURNAL_KEYS.map((k) => [k, saved[k]?.code ? { code: String(saved[k]!.code), name: String(saved[k]!.name || DEFAULT_ACCOUNTS[k].name) } : DEFAULT_ACCOUNTS[k]])) as ChartOfAccounts;
  return {
    journalAccounts,
    // (v1.19.0) The rates agreed with the gateway, per method (services/fee-audit.ts), and the accounting package.
    contractRates: (r?.contract_rates ?? {}) as ContractRates,
    accountingPackage: (r?.accounting_package ?? null) as AccountingPackage | null,
    closeEmail: {
      enabled: Boolean(r?.close_email_enabled), recipients: r?.close_email_recipients ?? [], sentPeriod: r?.close_email_sent_period ?? null,
      lastError: r?.close_email_last_error ?? null, lastAt: r?.close_email_last_at ? new Date(r.close_email_last_at).toISOString() : null,
    },
  };
}

/** Save the chart of accounts and the close e-mail. `channelOrgId`: whose e-mail channel sends it (the saver's organisation). */
export async function saveSettings(a: Account, b: { journalAccounts?: unknown; closeEmail?: unknown; contractRates?: unknown; accountingPackage?: unknown }, channelOrgId: string, userId: string | null): Promise<FinanceSettings> {
  const cur = await settingsFor(a);
  let accounts = cur.journalAccounts;
  if (b.journalAccounts !== undefined) {
    const j = (b.journalAccounts ?? {}) as Record<string, any>;
    if (typeof j !== 'object' || Array.isArray(j)) throw new FinanceError(422, 'journalAccounts is an object of { code, name } by key.');
    accounts = { ...accounts };
    for (const [k, v] of Object.entries(j)) {
      if (!JOURNAL_KEYS.includes(k as JournalKey)) throw new FinanceError(422, `Unknown journal account "${k}" (one of ${JOURNAL_KEYS.join(', ')}).`);
      const code = String(v?.code ?? '').trim(), name = String(v?.name ?? '').trim();
      if (!/^[A-Za-z0-9.\-/]{1,20}$/.test(code)) throw new FinanceError(422, `The account code for ${JOURNAL_LABELS[k as JournalKey]} is 1 to 20 letters, digits, . - or /.`);
      if (name.length > 80) throw new FinanceError(422, 'An account name is at most 80 characters.');
      accounts[k as JournalKey] = { code, name: name || DEFAULT_ACCOUNTS[k as JournalKey].name };
    }
  }
  let enabled = cur.closeEmail.enabled, recipients = cur.closeEmail.recipients;
  if (b.closeEmail !== undefined) {
    const c = (b.closeEmail ?? {}) as Record<string, unknown>;
    if (c.recipients !== undefined) {
      const list = (Array.isArray(c.recipients) ? c.recipients : String(c.recipients).split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean);
      if (list.length > 10) throw new FinanceError(422, 'At most 10 recipients.');
      const bad = list.find((x) => !EMAIL_RE.test(x) || x.length > 254);
      if (bad) throw new FinanceError(422, `Not an e-mail address: ${bad.slice(0, 80)}`);
      recipients = [...new Set(list.map((x) => x.toLowerCase()))];
    }
    if (c.enabled !== undefined) enabled = c.enabled === true;
    if (enabled && !recipients.length) throw new FinanceError(422, 'Add at least one recipient for the monthly close e-mail.');
  }
  const rates = b.contractRates !== undefined ? validRates(b.contractRates) : cur.contractRates;
  let pkg = cur.accountingPackage;
  if (b.accountingPackage !== undefined) {
    if (b.accountingPackage !== null && b.accountingPackage !== '' && !ACCOUNTING_PACKAGES.includes(b.accountingPackage as AccountingPackage)) {
      throw new FinanceError(422, `accountingPackage is one of ${ACCOUNTING_PACKAGES.join(', ')} (or null).`);
    }
    pkg = (b.accountingPackage || null) as AccountingPackage | null;
  }
  await outsideRequestScope(() => query(
    `INSERT INTO gateway_account_settings (integration_id, org_id, journal_accounts, close_email_enabled, close_email_recipients, channel_org_id, updated_by, updated_at, contract_rates, accounting_package)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9)
     ON CONFLICT (integration_id) DO UPDATE SET journal_accounts = EXCLUDED.journal_accounts, close_email_enabled = EXCLUDED.close_email_enabled,
       close_email_recipients = EXCLUDED.close_email_recipients, channel_org_id = EXCLUDED.channel_org_id, updated_by = EXCLUDED.updated_by, updated_at = now(),
       contract_rates = EXCLUDED.contract_rates, accounting_package = EXCLUDED.accounting_package`,
    [a.id, a.orgId, JSON.stringify(accounts), enabled, recipients, channelOrgId, userId, JSON.stringify(rates), pkg]));
  return settingsFor(a);
}

export interface JournalLine { date: string; entry: string; kind: string; code: string; account: string; debit: number; credit: number; description: string }

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The period's journal entries, balanced per entry. */
export async function journal(a: Account, p: Period): Promise<{ lines: JournalLine[]; accounts: ChartOfAccounts; totals: Array<{ code: string; account: string; debit: number; credit: number }> }> {
  const accounts = (await settingsFor(a)).journalAccounts;
  const zone = config.billing.timeZone;
  const [days, payouts] = await outsideRequestScope(() => Promise.all([
    many<any>(
      `SELECT to_char((gateway_created_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
              COALESCE(sum(amount) FILTER (WHERE kind = 'payment' AND cashflow = 'in'), 0) AS collected,
              COALESCE(sum(fee), 0) AS fee, COALESCE(sum(vat), 0) AS vat, COALESCE(sum(withholding_tax), 0) AS wht,
              COALESCE(sum(amount) FILTER (WHERE kind = 'refund'), 0) AS refunds,
              COALESCE(sum(amount) FILTER (WHERE kind = 'payout'), 0) AS withdrawals
         FROM gateway_transaction WHERE integration_id = $1 AND status = 'success' AND gateway_created_at >= $2 AND gateway_created_at < $3
        GROUP BY 1 ORDER BY 1`, [a.id, p.from, p.to, zone]),
    // Owner payouts recorded for the operators whose payments this account took (an operator's own account: its own).
    many<any>(
      `SELECT to_char(sp.paid_on, 'YYYY-MM-DD') AS day, sum(sp.amount_minor) AS amount, count(*)::int AS n
         FROM statement_payment sp
        WHERE sp.kind = 'owner_payout' AND sp.voided_at IS NULL AND sp.currency = $6
          AND sp.paid_on >= ($2 AT TIME ZONE $4)::date AND sp.paid_on < ($3 AT TIME ZONE $4)::date
          AND (sp.org_id = $5::uuid OR ($5::uuid IS NULL AND sp.org_id IN (SELECT DISTINCT org_id FROM payment_intent WHERE integration_id = $1)))
        GROUP BY 1 ORDER BY 1`, [a.id, p.from, p.to, zone, a.orgId, LEGACY_CURRENCY]),
  ]));
  const lines: JournalLine[] = [];
  const byDay = new Map<string, Array<() => void>>();
  let n = 0;
  const entry = (day: string, kind: string, description: string, debits: Array<[JournalKey, number]>, credits: Array<[JournalKey, number]>) => {
    const d = debits.filter(([, v]) => r2(v) !== 0), c = credits.filter(([, v]) => r2(v) !== 0);
    if (!d.length && !c.length) return;
    n++;
    const id = `J-${day.replace(/-/g, '')}-${String(n).padStart(4, '0')}`;
    for (const [k, v] of d) lines.push({ date: day, entry: id, kind, code: accounts[k].code, account: accounts[k].name, debit: r2(v), credit: 0, description });
    for (const [k, v] of c) lines.push({ date: day, entry: id, kind, code: accounts[k].code, account: accounts[k].name, debit: 0, credit: r2(v), description });
  };
  for (const x of days) {
    const day = x.day, col = Number(x.collected), fee = Number(x.fee), vat = Number(x.vat), wht = Number(x.wht), ref = Number(x.refunds), wd = Number(x.withdrawals);
    const fns = byDay.get(day) ?? [];
    fns.push(() => entry(day, 'collections', `Collected at ${a.label}`, [['gateway', col]], [['revenue', col]]));
    fns.push(() => entry(day, 'fees', `${a.label} fees and VAT on fees`, [['fees', fee], ['vatInput', vat]], [['gateway', fee + vat]]));
    if (wht) fns.push(() => entry(day, 'withholding', `Withholding tax on ${a.label} fees (as the gateway reports it)`, [['gateway', wht]], [['whtPayable', wht]]));
    fns.push(() => entry(day, 'refunds', `Refunds paid through ${a.label}`, [['refunds', ref]], [['gateway', ref]]));
    fns.push(() => entry(day, 'withdrawals', `${a.label} payout to the bank`, [['bank', wd]], [['gateway', wd]]));
    byDay.set(day, fns);
  }
  for (const x of payouts) {
    const fns = byDay.get(x.day) ?? [];
    fns.push(() => entry(x.day, 'owner_payouts', `Site owners' shares paid (${x.n} payment${x.n === 1 ? '' : 's'})`, [['ownerPayable', Number(x.amount)]], [['bank', Number(x.amount)]]));
    byDay.set(x.day, fns);
  }
  for (const day of [...byDay.keys()].sort()) for (const f of byDay.get(day)!) f();
  const tot = new Map<string, { code: string; account: string; debit: number; credit: number }>();
  for (const l of lines) {
    const t = tot.get(l.code) ?? { code: l.code, account: l.account, debit: 0, credit: 0 };
    t.debit = r2(t.debit + l.debit); t.credit = r2(t.credit + l.credit);
    tot.set(l.code, t);
  }
  return { lines, accounts, totals: [...tot.values()].sort((x, y) => x.code.localeCompare(y.code)) };
}

const HEAD = ['Date', 'Entry', 'Account code', 'Account', 'Debit', 'Credit', 'Description', 'Kind'];
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function journalCsv(j: Awaited<ReturnType<typeof journal>>): string {
  return '﻿' + [HEAD, ...j.lines.map((l) => [l.date, l.entry, l.code, l.account, l.debit || '', l.credit || '', l.description, l.kind])]
    .map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function journalXlsx(a: Account, p: Period, j: Awaited<ReturnType<typeof journal>>): Buffer {
  const sheets: Sheet[] = [
    { name: 'Journal', rows: [HEAD, ...j.lines.map((l) => [l.date, l.entry, l.code, l.account, l.debit || null, l.credit || null, l.description, l.kind])],
      widths: [12, 18, 12, 32, 16, 16, 48, 14], formats: [null, null, null, null, 'money', 'money', null, null] },
    { name: 'By account', rows: [['Account code', 'Account', 'Debit', 'Credit', 'Net (debit − credit)'], ...j.totals.map((t) => [t.code, t.account, t.debit, t.credit, r2(t.debit - t.credit)])],
      widths: [12, 36, 18, 18, 20], formats: [null, null, 'money', 'money', 'money'] },
    { name: 'About', rows: [['Item', 'Value'], ['Account', a.label], ['From', p.from.toISOString()], ['To (exclusive)', p.to.toISOString()], ['Time zone', config.billing.timeZone],
      ['Source', 'Finance\'s ledger of the gateway, and owner payouts recorded against statements'], ['Check', 'Every entry balances; the By account sheet nets to zero']],
      widths: [20, 70], formats: [null, null] },
  ];
  return xlsx(sheets);
}
