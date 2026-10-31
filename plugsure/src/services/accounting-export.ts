import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { FinanceError, periodOf, type Account } from './finance.js';
import { journal, settingsFor, ACCOUNTING_PACKAGES, type AccountingPackage, type JournalLine } from './finance-journal.js';

/**
 * Accounting software export (v1.19.0): a closed month's journal (services/finance-journal.ts) as the import file of
 * the operator's accounting package, with the chart of accounts from Finance → Settings. Each export is logged
 * (accounting_export) so Finance shows which months went to the books, when and by whom.
 *
 *   jurnal     Jurnal.id (Mekari) — Journal Entry import: one row per line, the entry's number and date repeated
 *   accurate   Accurate Online — Jurnal Umum import: No. Bukti, Tanggal, Keterangan, No. Akun, Debit, Kredit
 *   generic    any package: date, entry, account code and name, debit, credit, description
 *
 * The column headings follow the packages' import templates as published; a package may rename a heading between
 * versions, so the first import of each is to be checked against its template. Only closed months: the current month
 * is still moving.
 */

export const PACKAGE_LABEL: Record<AccountingPackage, string> = { jurnal: 'Jurnal.id', accurate: 'Accurate Online', generic: 'Generic CSV' };
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const dmy = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;
const amt = (n: number) => (n ? n.toFixed(2) : '0');
const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The import file for a package (CSV, UTF-8 with BOM so spreadsheet tools read Indonesian characters). */
export function render(pkg: AccountingPackage, lines: JournalLine[], prefix: string): string {
  // Entry numbers short and unique per month, as the packages want a transaction number.
  const no = (e: string) => `${prefix}-${e}`.slice(0, 40);
  let rows: unknown[][];
  if (pkg === 'jurnal') {
    rows = [['*Transaction Date (dd/mm/yyyy)', '*Transaction No', 'Memo', '*Account Code', 'Description', '*Debit', '*Credit', 'Tags'],
      ...lines.map((l) => [dmy(l.date), no(l.entry), `PlugSure ${l.kind}`, l.code, l.description, amt(l.debit), amt(l.credit), 'plugsure'])];
  } else if (pkg === 'accurate') {
    rows = [['No. Bukti', 'Tanggal', 'Keterangan', 'No. Akun', 'Debit', 'Kredit', 'Keterangan Detail'],
      ...lines.map((l) => [no(l.entry), dmy(l.date), `PlugSure ${l.kind}`, l.code, amt(l.debit), amt(l.credit), l.description])];
  } else {
    rows = [['Date', 'Entry', 'Account code', 'Account', 'Debit', 'Credit', 'Description', 'Kind'],
      ...lines.map((l) => [l.date, no(l.entry), l.code, l.account, amt(l.debit), amt(l.credit), l.description, l.kind])];
  }
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const currentMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone }).format(new Date()).slice(0, 7);
const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** Build a closed month's import file for the account's package (or the one asked for) and log it. */
export async function exportMonth(a: Account, monthRaw: unknown, pkgRaw: unknown, userId: string | null) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new FinanceError(400, 'month is YYYY-MM.');
  if (month >= currentMonth()) throw new FinanceError(409, 'Only closed months go to the books: this month is still moving.');
  const settings = await settingsFor(a);
  const pkg = (pkgRaw ? String(pkgRaw) : settings.accountingPackage ?? 'generic') as AccountingPackage;
  if (!ACCOUNTING_PACKAGES.includes(pkg)) throw new FinanceError(400, `package is one of ${ACCOUNTING_PACKAGES.join(', ')}.`);
  const j = await journal(a, periodOf(`${month}-01`, lastDay(month)));
  if (!j.lines.length) throw new FinanceError(409, `Nothing in the journal for ${month}.`);
  const entries = new Set(j.lines.map((l) => l.entry)).size;
  const debit = Math.round(j.lines.reduce((s, l) => s + l.debit, 0) * 100) / 100;
  const filename = `plugsure-${pkg}-${a.provider}-${month}.csv`;
  await outsideRequestScope(() => one(
    `INSERT INTO accounting_export (org_id, integration_id, month, package, filename, entries, total_debit, exported_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [a.orgId, a.id, month, pkg, filename, entries, debit, userId]));
  return { csv: render(pkg, j.lines, `PS${month.replace('-', '')}`), filename, month, package: pkg, entries, totalDebit: debit };
}

/** Which months went to the books: the last 24 months, each with its exports (newest first). */
export async function log(a: Account) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT e.*, u.name AS by_name FROM accounting_export e LEFT JOIN app_user u ON u.id = e.exported_by
      WHERE e.integration_id = $1 ORDER BY e.exported_at DESC LIMIT 200`, [a.id]));
  const exports = rows.map((r) => ({ id: String(r.id), month: r.month, package: r.package, packageLabel: PACKAGE_LABEL[r.package as AccountingPackage] ?? r.package, filename: r.filename,
    entries: r.entries, totalDebit: Number(r.total_debit), by: r.by_name ?? null, at: new Date(r.exported_at).toISOString() }));
  const cur = currentMonth();
  const months: Array<{ month: string; exported: boolean; lastAt: string | null; lastPackage: string | null }> = [];
  let [y, m] = cur.split('-').map(Number) as [number, number];
  for (let i = 0; i < 12; i++) {
    m--; if (m === 0) { m = 12; y--; }
    const k = `${y}-${String(m).padStart(2, '0')}`;
    const last = exports.find((e) => e.month === k);
    months.push({ month: k, exported: Boolean(last), lastAt: last?.at ?? null, lastPackage: last?.package ?? null });
  }
  const settings = await settingsFor(a);
  return { package: settings.accountingPackage, packages: ACCOUNTING_PACKAGES.map((p) => ({ id: p, label: PACKAGE_LABEL[p] })), months, exports };
}
