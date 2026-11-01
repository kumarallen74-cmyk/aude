import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { moneyText, currencyOr } from '../domain/money.js';
import { unseal } from './secrets.js';
import { sendEmail } from './notify-transports.js';
import { getSettings } from './fleet-billing.js';
import { bucketOf } from './collections.js';
import { xlsx } from './xlsx.js';
import { PdfDoc, Flow, type Rgb } from './pdf.js';
import { parties, footers } from './fleet-pdf.js';

/**
 * Fleet statements of account (v1.22.0). For a fleet account and a month, per currency:
 *
 *   opening balance   what the account owed at the start of the month
 *   invoices          issued (paid or not; void invoices are left out)                     owed  +
 *   credit notes      issued against its invoices, however they are settled               owed  −
 *   payments          an invoice marked paid: what was left on it then                     owed  −
 *   refunds           a credit note settled by refund, when the refund was paid            owed  +
 *   closing balance   what it owes at the end of the month, with the open invoices by age (days past due at month end)
 *
 * (A credit note deducted from a next invoice is counted once, when it is issued: the next invoice's payment is
 * what was left after it.) The statement is a PDF (and Excel for the accountant), e-mailed to the account's billing
 * address from Fleet → Accounts or, with automatic statements on (Finance → Settings), on a day of each month for
 * the month just ended, to every account with a billing address that had activity or owes something.
 */

export class StatementError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const zone = () => config.billing.timeZone;
const localDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const MUTED: Rgb = [0.36, 0.39, 0.44];

export interface Entry { date: string; kind: 'invoice' | 'credit_note' | 'payment' | 'refund'; number: string; description: string; debit: number; credit: number; balance: number }

const lastDay = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
};
const prevMonth = (now = new Date()) => {
  let [y, m] = localDay(now).slice(0, 7).split('-').map(Number) as [number, number];
  m--; if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
};

async function accountOf(orgId: string, id: string) {
  if (!UUID_RE.test(id)) throw new StatementError(404, 'No such fleet account.');
  const a = await outsideRequestScope(() => one<any>(`SELECT * FROM fleet_account WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!a) throw new StatementError(404, 'No such fleet account.');
  return a;
}

/** Every movement of an account up to a date (inclusive), oldest first. */
async function movements(orgId: string, accountId: string, to: string) {
  const z = zone();
  const [inv, cn] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT id, number, status, currency, total_minor, credited_minor, prior_credit_minor, to_char(period, 'YYYY-MM') AS period,
              to_char(issued_at AT TIME ZONE $3, 'YYYY-MM-DD') AS issued, to_char(due_date, 'YYYY-MM-DD') AS due, to_char(paid_at, 'YYYY-MM-DD') AS paid, paid_reference
         FROM fleet_invoice WHERE org_id = $1 AND fleet_account_id = $2 AND status IN ('issued', 'paid') AND (issued_at AT TIME ZONE $3)::date <= $4::date`, [orgId, accountId, z, to])),
    outsideRequestScope(() => many<any>(
      `SELECT c.id, c.number, c.currency, c.settlement, c.total_minor, c.reason, i.number AS invoice_number,
              to_char(c.issued_at AT TIME ZONE $3, 'YYYY-MM-DD') AS issued, to_char(c.refunded_at, 'YYYY-MM-DD') AS refunded, c.refund_reference
         FROM fleet_credit_note c LEFT JOIN fleet_invoice i ON i.id = c.invoice_id
        WHERE c.org_id = $1 AND c.fleet_account_id = $2 AND c.status = 'issued' AND (c.issued_at AT TIME ZONE $3)::date <= $4::date`, [orgId, accountId, z, to])),
  ]);
  const out: Array<Omit<Entry, 'balance'> & { currency: string; order: number }> = [];
  for (const i of inv) {
    out.push({ currency: i.currency, date: i.issued, kind: 'invoice', number: i.number, description: `Invoice for ${i.period}${i.due ? `, due ${i.due}` : ''}`, debit: Number(i.total_minor), credit: 0, order: 0 });
    if (i.status === 'paid' && i.paid && i.paid <= to) {
      const paid = Math.max(0, Number(i.total_minor) - Number(i.credited_minor ?? 0) - Number(i.prior_credit_minor ?? 0));
      if (paid) out.push({ currency: i.currency, date: i.paid, kind: 'payment', number: i.paid_reference || i.number, description: `Payment of invoice ${i.number}`, debit: 0, credit: paid, order: 2 });
    }
  }
  for (const c of cn) {
    out.push({ currency: c.currency, date: c.issued, kind: 'credit_note', number: c.number, description: `Credit note on invoice ${c.invoice_number ?? '—'}: ${String(c.reason ?? '').slice(0, 80)}`, debit: 0, credit: Number(c.total_minor), order: 1 });
    if (c.settlement === 'refund' && c.refunded && c.refunded <= to) {
      out.push({ currency: c.currency, date: c.refunded, kind: 'refund', number: c.refund_reference || c.number, description: `Refund of credit note ${c.number}`, debit: Number(c.total_minor), credit: 0, order: 3 });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.number.localeCompare(b.number));
  return { out, inv };
}

/** The statement of account of a fleet account for a month. */
export async function statement(orgId: string, accountId: string, monthRaw: unknown) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new StatementError(422, 'month is YYYY-MM.');
  const a = await accountOf(orgId, accountId);
  const from = `${month}-01`, to = lastDay(month);
  const [{ out, inv }, st] = await Promise.all([movements(orgId, accountId, to), outsideRequestScope(() => getSettings(orgId))]);
  const curs = [...new Set(out.map((e) => e.currency))].sort();
  const currencies = curs.map((cur) => {
    const mine = out.filter((e) => e.currency === cur);
    const opening = mine.filter((e) => e.date < from).reduce((s, e) => s + e.debit - e.credit, 0);
    let bal = opening;
    const entries: Entry[] = mine.filter((e) => e.date >= from).map(({ currency: _c, order: _o, ...e }) => { bal += e.debit - e.credit; return { ...e, balance: bal }; });
    // Open at month end: issued by then, not paid by then.
    const open = inv.filter((i) => i.currency === cur && (i.status === 'issued' || (i.paid && i.paid > to)))
      .map((i) => {
        const left = Math.max(0, Number(i.total_minor) - Number(i.credited_minor ?? 0) - Number(i.prior_credit_minor ?? 0));
        const dpd = i.due ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${i.due}T00:00:00Z`)) / 86_400_000) : 0;
        return { number: i.number, issued: i.issued, due: i.due, outstanding: left, daysPastDue: dpd, bucket: bucketOf(dpd) };
      }).filter((x) => x.outstanding > 0);
    const aging = Object.fromEntries(['current', '1-30', '31-60', '61-90', '90+'].map((b) => [b, open.filter((o) => o.bucket === b).reduce((s, o) => s + o.outstanding, 0)]));
    return {
      currency: cur, opening, closing: bal,
      invoiced: entries.reduce((s, e) => s + (e.kind === 'invoice' ? e.debit : 0), 0),
      credited: entries.reduce((s, e) => s + (e.kind === 'credit_note' ? e.credit : 0), 0),
      paid: entries.reduce((s, e) => s + (e.kind === 'payment' ? e.credit : 0), 0),
      refunded: entries.reduce((s, e) => s + (e.kind === 'refund' ? e.debit : 0), 0),
      entries, open, aging,
    };
  });
  return {
    month, from, to,
    account: { id: a.id, name: a.name, legalName: a.legal_name ?? null, taxId: a.tax_id ?? null, taxIdKind: a.tax_id_kind ?? null, address: a.address ?? null, contact: a.contact_name ?? null, email: a.billing_email ?? null },
    seller: st.seller, paymentInstructions: st.settings.paymentInstructions || null,
    currencies,
  };
}

export type Statement = Awaited<ReturnType<typeof statement>>;
const KIND_LABEL: Record<Entry['kind'], string> = { invoice: 'Invoice', credit_note: 'Credit note', payment: 'Payment', refund: 'Refund' };

export function statementXlsx(s: Statement): Buffer {
  const rows: Array<Array<string | number | null>> = [['Currency', 'Date', 'Type', 'Number', 'Description', 'Debit', 'Credit', 'Balance']];
  for (const c of s.currencies) {
    rows.push([c.currency, s.from, 'Opening balance', '', '', null, null, c.opening]);
    for (const e of c.entries) rows.push([c.currency, e.date, KIND_LABEL[e.kind], e.number, e.description, e.debit || null, e.credit || null, e.balance]);
    rows.push([c.currency, s.to, 'Closing balance', '', '', null, null, c.closing]);
  }
  const open: Array<Array<string | number | null>> = [['Currency', 'Invoice', 'Issued', 'Due', 'Days past due', 'Bucket', 'Outstanding']];
  for (const c of s.currencies) for (const o of c.open) open.push([c.currency, o.number, o.issued, o.due, o.daysPastDue, o.bucket, o.outstanding]);
  return xlsx([
    { name: 'Statement', rows, widths: [9, 12, 16, 22, 60, 16, 16, 16], formats: [null, null, null, null, null, 'int', 'int', 'int'] },
    { name: 'Open invoices', rows: open, widths: [9, 22, 12, 12, 14, 10, 16], formats: [null, null, null, null, 'int', null, 'int'] },
  ]);
}

export function statementPdf(s: Statement): Buffer {
  const title = `Statement of account ${s.month} — ${s.account.name}`;
  const doc = new PdfDoc({ title, author: s.seller.name, subject: `Statement of account for ${s.month}` });
  const f = new Flow(doc);
  doc.text(f.left, f.y + 18, 'Statement of account', { size: 20, bold: true });
  doc.text(f.left, f.y + 34, `${s.from} to ${s.to}`, { size: 9, color: MUTED });
  f.y += 44;
  parties(f, s.seller, { name: s.account.legalName || s.account.name, taxId: s.account.taxId, taxIdKind: s.account.taxIdKind, address: s.account.address, contact: s.account.contact });
  if (!s.currencies.length) { f.heading('Nothing to show'); f.para('No invoices, credit notes or payments up to the end of this month.', { size: 9.5 }); }
  for (const c of s.currencies) {
    const m = (n: number) => moneyText(n, currencyOr(c.currency));
    f.heading(s.currencies.length > 1 ? `In ${c.currency}` : 'Movements');
    f.table([{ label: 'Date', width: 1.1 }, { label: 'Type', width: 1.1 }, { label: 'Number', width: 1.5 }, { label: 'Description', width: 3 }, { label: 'Debit', width: 1.3, align: 'right' }, { label: 'Credit', width: 1.3, align: 'right' }, { label: 'Balance', width: 1.4, align: 'right' }], [
      { cells: [s.from, 'Opening', '', 'Balance brought forward', '', '', m(c.opening)], bold: true },
      ...c.entries.map((e) => ({ cells: [e.date, KIND_LABEL[e.kind], e.number, e.description, e.debit ? m(e.debit) : '', e.credit ? m(e.credit) : '', m(e.balance)] })),
      { cells: [s.to, 'Closing', '', 'Balance owed', '', '', m(c.closing)], bold: true },
    ]);
    f.gap(4);
    f.row('Invoiced this month', m(c.invoiced), { muted: true });
    f.row('Credited', m(c.credited), { muted: true });
    f.row('Paid', m(c.paid), { muted: true });
    if (c.refunded) f.row('Refunded to you', m(c.refunded), { muted: true });
    f.row(c.closing >= 0 ? 'Balance owed' : 'In your favour', m(Math.abs(c.closing)), { bold: true, size: 12, rule: false });
    if (c.open.length) {
      f.heading('Open invoices at month end');
      f.table([{ label: 'Invoice', width: 1.8 }, { label: 'Issued', width: 1.2 }, { label: 'Due', width: 1.2 }, { label: 'Days past due', width: 1.2, align: 'right' }, { label: 'Outstanding', width: 1.6, align: 'right' }],
        c.open.map((o) => ({ cells: [o.number, o.issued, o.due ?? '—', String(Math.max(0, o.daysPastDue)), m(o.outstanding)] })));
    }
  }
  if (s.paymentInstructions) { f.heading('How to pay'); f.para(s.paymentInstructions, { size: 9 }); }
  footers(doc, `${s.seller.name} · ${title}`);
  return doc.toBuffer();
}

/** E-mail a statement to the account's billing address (or `to`), logged. */
export async function send(orgId: string, accountId: string, monthRaw: unknown, o: { to?: unknown; automatic?: boolean; userId?: string | null } = {}) {
  const s = await statement(orgId, accountId, monthRaw);
  const log = (fields: { to: string | null; ref?: string | null; error?: string | null }) => outsideRequestScope(() => query(
    `INSERT INTO fleet_statement_send (org_id, fleet_account_id, month, automatic, sent_to, closing_minor, reference, error, sent_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [orgId, accountId, s.month, o.automatic === true, fields.to, JSON.stringify(Object.fromEntries(s.currencies.map((c) => [c.currency, c.closing]))), fields.ref ?? null, fields.error?.slice(0, 300) ?? null, o.userId ?? null]));
  const to = String(o.to ?? s.account.email ?? '').trim();
  if (!to || !to.split(/[,;]\s*/).every((x) => EMAIL_RE.test(x))) throw new StatementError(422, 'No valid billing e-mail address for this fleet account.');
  const ch = await outsideRequestScope(() => one<{ enabled: boolean; config: any; secret: string | null }>(`SELECT enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind = 'email'`, [orgId]));
  if (!ch?.enabled || !ch.config?.host) throw new StatementError(409, 'Set up the e-mail channel first (Governance → Alert routing → Channels).');
  let secret: string | null = null;
  try { secret = ch.secret ? unseal(ch.secret) : null; } catch { secret = null; }
  const lines = s.currencies.map((c) => `${c.closing >= 0 ? 'Balance owed' : 'In your favour'}${s.currencies.length > 1 ? ` (${c.currency})` : ''}: ${moneyText(Math.abs(c.closing), currencyOr(c.currency))}`);
  const text = `${s.seller.name}\nStatement of account for ${s.account.name}, ${s.from} to ${s.to}\n\n${lines.join('\n') || 'No movements.'}\n\nThe statement is attached (PDF, with the movements and the invoices still open). Please let us know if anything does not match your records.`;
  const esc = (x: string) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const file = `statement-${s.account.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account'}-${s.month}`;
  const res = await sendEmail(ch.config, secret, to, {
    subject: `Statement of account ${s.month} — ${s.account.name}`, text,
    html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${esc(text)}</pre>`, kind: 'fleet-statement',
    attachments: [{ filename: `${file}.pdf`, content: statementPdf(s), contentType: 'application/pdf' }],
  });
  if (!res.ok) {
    await log({ to: to.slice(0, 300), error: res.error ?? 'failed' });
    throw new StatementError(502, `The e-mail was not sent: ${res.error ?? 'failed'}`);
  }
  await log({ to: to.slice(0, 300), ref: res.ref ?? null });
  return { ok: true, to, month: s.month, reference: res.ref ?? null };
}

export async function sends(orgId: string, accountId?: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT l.*, a.name AS account_name, u.name AS by_name FROM fleet_statement_send l JOIN fleet_account a ON a.id = l.fleet_account_id LEFT JOIN app_user u ON u.id = l.sent_by
      WHERE l.org_id = $1 AND ($2::uuid IS NULL OR l.fleet_account_id = $2::uuid) ORDER BY l.sent_at DESC LIMIT 200`, [orgId, accountId && UUID_RE.test(accountId) ? accountId : null]));
  return rows.map((r) => ({ accountId: r.fleet_account_id, account: r.account_name, month: r.month, automatic: r.automatic, to: r.sent_to, closing: r.closing_minor, error: r.error ?? null, by: r.by_name ?? null, at: new Date(r.sent_at).toISOString() }));
}

export async function settings(orgId: string) {
  const r = await outsideRequestScope(() => one<{ fleet_statements: any }>(`SELECT fleet_statements FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.fleet_statements ?? {};
  return { enabled: v.enabled === true, day: Number(v.day ?? 3) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const day = b.day == null || b.day === '' ? 3 : Number(b.day);
  if (!Number.isInteger(day) || day < 1 || day > 28) throw new StatementError(422, 'The day is 1 to 28 (of the month).');
  const v = { enabled: b.enabled === true, day };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, fleet_statements, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET fleet_statements = EXCLUDED.fleet_statements, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/** The worker: on the day set (or after, if missed), every account's statement for last month, once. */
export async function sweep(now = new Date()): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string; fleet_statements: any }>(`SELECT org_id, fleet_statements FROM finance_org_settings WHERE (fleet_statements->>'enabled')::boolean IS TRUE`));
  const today = localDay(now), month = prevMonth(now);
  let n = 0;
  for (const o of orgs) {
    if (Number(today.slice(8, 10)) < Number(o.fleet_statements?.day ?? 3)) continue;
    const accounts = await outsideRequestScope(() => many<{ id: string }>(
      `SELECT a.id FROM fleet_account a WHERE a.org_id = $1 AND a.archived_at IS NULL AND a.billing_email IS NOT NULL AND a.billing_email <> ''
          AND NOT EXISTS (SELECT 1 FROM fleet_statement_send l WHERE l.fleet_account_id = a.id AND l.month = $2 AND l.automatic AND l.error IS NULL)
          AND (SELECT count(*) FROM fleet_statement_send l WHERE l.fleet_account_id = a.id AND l.month = $2 AND l.automatic AND l.error IS NOT NULL) < 3`, [o.org_id, month]));
    for (const a of accounts) {
      try {
        const s = await statement(o.org_id, a.id, month);
        if (!s.currencies.some((c) => c.entries.length || c.closing !== 0)) continue;
        await send(o.org_id, a.id, month, { automatic: true });
        n++;
      } catch (e) {
        logger.warn({ org: o.org_id, account: a.id, err: (e as Error).message }, 'fleet statement not sent');
        if (e instanceof StatementError && e.statusCode === 409) break; // the e-mail channel is not set up: the same for every account
      }
    }
  }
  return n;
}
