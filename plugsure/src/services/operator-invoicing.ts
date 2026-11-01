import { randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { moneyText, currencyOr } from '../domain/money.js';
import { unseal } from './secrets.js';
import { sendEmail } from './notify-transports.js';
import { getSettings } from './fleet-billing.js';
import { accountsFor, xenditOf } from './finance.js';
import { recordPayment, PayoutError } from './payouts.js';
import { PdfDoc, Flow, type Rgb } from './pdf.js';
import { parties, footers } from './fleet-pdf.js';
import { persistAlert } from './alerts.js';
import { opsAlertOrgs } from './worker-health.js';

/**
 * Operator invoicing of PlugSure's fees (v1.25.0). A finalised statement from PlugSure to an operator (a
 * commission_statement with owner_id NULL) is its invoice for the month's fees:
 *
 *   invoice PDF      numbered as the statement; PlugSure (the platform administrators' organisation) as seller, the
 *                    operator as buyer; the fee lines, tax, total, what was paid, what is due and by when (14 days)
 *   e-mail           to the operator's billing e-mail (organisation.billing_email), logged per send
 *   payment link     a Xendit invoice on the PLATFORM's Xendit account for what is outstanding; the worker polls it,
 *                    and when Xendit reports it paid, the payment is recorded on the statement (kind platform_fee),
 *                    so collections, bank reconciliation and the operator's statement of account see it
 *   reminders        automatic, on days past the due date (the settings), with the link
 *   statement of     every fee statement of an operator with its payments and the running balance
 *   account
 *
 * Only platform administrators reach any of this.
 */

export class InvoicingError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const TERMS_DAYS = 14;
const DAY = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MUTED: Rgb = [0.36, 0.39, 0.44];
const zone = () => config.billing.timeZone;
const localDay = (t: Date | number = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date(t));
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
export const LINK_ALERT = 'finance.platform_invoice_link';

// ─────────────────────────────────────────── settings

export interface InvoicingSettings { autoSend: boolean; autoLink: boolean; reminderDays: number[]; linkDays: number }

export async function settings(orgId: string): Promise<InvoicingSettings> {
  const r = await outsideRequestScope(() => one<{ platform_invoicing: any }>(`SELECT platform_invoicing FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.platform_invoicing ?? {};
  return {
    autoSend: v.autoSend === true, autoLink: v.autoLink === true,
    reminderDays: Array.isArray(v.reminderDays) ? v.reminderDays.map(Number) : [3, 14, 30],
    linkDays: Number(v.linkDays ?? 30),
  };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<InvoicingSettings> {
  const cur = await settings(orgId);
  let reminderDays = cur.reminderDays;
  if (b.reminderDays !== undefined) {
    const raw = Array.isArray(b.reminderDays) ? b.reminderDays : String(b.reminderDays ?? '').split(/[,\s]+/).filter(Boolean);
    reminderDays = [...new Set(raw.map(Number))].sort((x, y) => x - y);
    if (reminderDays.length > 6 || reminderDays.some((d) => !Number.isInteger(d) || d < -14 || d > 180)) {
      throw new InvoicingError(422, 'Reminders are up to 6 whole numbers of days from the due date, -14 to 180 (e.g. 3, 14, 30); none for no reminders.');
    }
  }
  const linkDays = b.linkDays === undefined || b.linkDays === '' ? cur.linkDays : Number(b.linkDays);
  if (!Number.isInteger(linkDays) || linkDays < 1 || linkDays > 90) throw new InvoicingError(422, 'A payment link lasts 1 to 90 days.');
  const v: InvoicingSettings = {
    autoSend: b.autoSend === undefined ? cur.autoSend : b.autoSend === true,
    autoLink: b.autoLink === undefined ? cur.autoLink : b.autoLink === true,
    reminderDays, linkDays,
  };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, platform_invoicing, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET platform_invoicing = EXCLUDED.platform_invoicing, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, JSON.stringify(v), userId]));
  return v;
}

/** The operator's billing e-mail (PlugSure's invoices go there). */
export async function setBillingEmail(operatorId: string, raw: unknown) {
  if (!UUID_RE.test(operatorId)) throw new InvoicingError(404, 'No such operator.');
  const email = String(raw ?? '').trim() || null;
  if (email && (email.length > 300 || !email.split(/[,;]\s*/).every((x) => EMAIL_RE.test(x)))) throw new InvoicingError(422, 'Enter a valid e-mail address (several separated by commas).');
  const r = await outsideRequestScope(() => one(`UPDATE organisation SET billing_email = $2 WHERE id = $1 RETURNING id`, [operatorId, email]));
  if (!r) throw new InvoicingError(404, 'No such operator.');
  return { operatorId, billingEmail: email };
}

// ─────────────────────────────────────────── the invoices

interface StatementRow {
  id: string; org_id: string; number: string; period: string; currency: string; finalised_at: Date; data: any;
  commission_minor: string; minimum_topup_minor: string; private_fee_minor: string; mdr_credit_minor: string; net_minor: string; tax_minor: string; total_minor: string;
  operator: string; npwp: string | null; billing_address: string | null; billing_email: string | null; paid: string;
}

async function statementOf(id: string): Promise<StatementRow> {
  if (!UUID_RE.test(id)) throw new InvoicingError(404, 'No such fee statement.');
  const s = await outsideRequestScope(() => one<StatementRow>(
    `SELECT s.id, s.org_id, s.number, to_char(s.period, 'YYYY-MM') AS period, s.currency, s.finalised_at, s.data,
            s.commission_minor, s.minimum_topup_minor, s.private_fee_minor, s.mdr_credit_minor, s.net_minor, s.tax_minor, s.total_minor,
            o.name AS operator, o.npwp, o.billing_address, o.billing_email,
            COALESCE((SELECT sum(amount_minor) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL), 0)::bigint AS paid
       FROM commission_statement s JOIN organisation o ON o.id = s.org_id
      WHERE s.id = $1 AND s.owner_id IS NULL AND s.finalised_at IS NOT NULL`, [id]));
  if (!s) throw new InvoicingError(404, 'No such fee statement.');
  return s;
}

const dueOf = (finalisedAt: Date) => localDay(new Date(finalisedAt).getTime() + TERMS_DAYS * DAY);

/** One fee statement as an invoice, with what was paid, the open link and the sends. */
export async function invoice(id: string) {
  const s = await statementOf(id);
  const [links, sends, pays] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT * FROM platform_invoice_link WHERE statement_id = $1 ORDER BY id DESC LIMIT 20`, [id])),
    outsideRequestScope(() => many<any>(`SELECT l.*, u.name AS by_name FROM platform_invoice_send l LEFT JOIN app_user u ON u.id = l.sent_by WHERE l.statement_id = $1 ORDER BY l.sent_at DESC LIMIT 50`, [id])),
    outsideRequestScope(() => many<any>(`SELECT id, amount_minor, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, reference FROM statement_payment WHERE statement_id = $1 AND voided_at IS NULL ORDER BY paid_on, id`, [id])),
  ]);
  const total = Number(s.total_minor), paid = Number(s.paid);
  const due = dueOf(s.finalised_at);
  const today = localDay();
  return {
    statementId: s.id, number: s.number, period: s.period, currency: s.currency, issued: localDay(s.finalised_at), due,
    daysPastDue: Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY),
    operator: { id: s.org_id, name: s.operator, npwp: s.npwp, address: s.billing_address, billingEmail: s.billing_email },
    lines: [
      { label: 'Commission', amount: Number(s.commission_minor) },
      { label: 'Minimum fee top-up', amount: Number(s.minimum_topup_minor) },
      { label: 'Private charger fee', amount: Number(s.private_fee_minor) },
      { label: 'Card fee (MDR) credit', amount: -Number(s.mdr_credit_minor) },
    ].filter((l) => l.amount !== 0),
    net: Number(s.net_minor), tax: Number(s.tax_minor), total, paid, outstanding: Math.max(0, total - paid),
    payments: pays.map((p) => ({ id: String(p.id), amount: Number(p.amount_minor), paidOn: p.paid_on, reference: p.reference })),
    link: links.find((l) => l.status === 'pending') ? linkView(links.find((l) => l.status === 'pending')) : null,
    links: links.map(linkView),
    sends: sends.map((l) => ({ kind: l.kind, to: l.sent_to, automatic: l.automatic, error: l.error ?? null, by: l.by_name ?? null, at: iso(l.sent_at) })),
  };
}
export type Invoice = Awaited<ReturnType<typeof invoice>>;

const linkView = (l: any) => ({
  id: String(l.id), url: l.url, amount: Number(l.amount_minor), currency: l.currency, status: l.status, expiresAt: iso(l.expires_at), paidAt: iso(l.paid_at),
  paymentId: l.payment_id ? String(l.payment_id) : null, error: l.error ?? null, createdAt: iso(l.created_at),
});

/** Every finalised fee statement with its invoice state: sent, link, due, paid. */
export async function list(f: { status?: unknown; operatorId?: unknown } = {}) {
  const op = typeof f.operatorId === 'string' && UUID_RE.test(f.operatorId) ? f.operatorId : null;
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT s.id, s.number, to_char(s.period, 'YYYY-MM') AS period, s.org_id, o.name AS operator, o.billing_email, s.currency, s.total_minor, s.finalised_at,
            COALESCE((SELECT sum(amount_minor) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL), 0)::bigint AS paid,
            (SELECT max(sent_at) FROM platform_invoice_send l WHERE l.statement_id = s.id AND l.kind = 'invoice' AND l.error IS NULL) AS sent_at,
            (SELECT count(*) FROM platform_invoice_send l WHERE l.statement_id = s.id AND l.kind = 'reminder' AND l.error IS NULL)::int AS reminders,
            (SELECT url FROM platform_invoice_link k WHERE k.statement_id = s.id AND k.status = 'pending') AS link_url
       FROM commission_statement s JOIN organisation o ON o.id = s.org_id
      WHERE s.owner_id IS NULL AND s.finalised_at IS NOT NULL AND s.total_minor > 0 AND ($1::uuid IS NULL OR s.org_id = $1::uuid)
      ORDER BY s.period DESC, o.name LIMIT 500`, [op]));
  const today = localDay();
  const out = rows.map((r) => {
    const total = Number(r.total_minor), paid = Number(r.paid), due = dueOf(r.finalised_at);
    const outstanding = Math.max(0, total - paid);
    const dpd = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY);
    const status = outstanding === 0 ? 'paid' : dpd > 0 ? 'overdue' : paid > 0 ? 'partial' : 'due';
    return {
      statementId: r.id, number: r.number, period: r.period, operatorId: r.org_id, operator: r.operator, billingEmail: r.billing_email ?? null, currency: r.currency,
      total, paid, outstanding, due, daysPastDue: dpd, status, sentAt: iso(r.sent_at), reminders: r.reminders, linkUrl: r.link_url ?? null,
    };
  });
  return typeof f.status === 'string' && f.status ? out.filter((r) => r.status === f.status) : out;
}

// ─────────────────────────────────────────── the PDF

export async function sellerOf(platformOrgId: string) {
  return (await outsideRequestScope(() => getSettings(platformOrgId)));
}

export function invoicePdf(inv: Invoice, seller: any, paymentInstructions: string | null): Buffer {
  const m = (n: number) => moneyText(n, currencyOr(inv.currency));
  const title = `Invoice ${inv.number} — ${inv.operator.name}`;
  const doc = new PdfDoc({ title, author: seller.name, subject: `PlugSure fees for ${inv.period}` });
  const f = new Flow(doc);
  doc.text(f.left, f.y + 18, 'Invoice', { size: 20, bold: true });
  doc.text(f.left, f.y + 34, `${inv.number} · fees for ${inv.period} · issued ${inv.issued} · due ${inv.due}`, { size: 9, color: MUTED });
  f.y += 44;
  parties(f, seller, { name: inv.operator.name, taxId: inv.operator.npwp, taxIdKind: 'TIN', address: inv.operator.address });
  f.heading('Fees');
  f.table([{ label: 'Description', width: 5 }, { label: 'Amount', width: 2, align: 'right' }],
    inv.lines.map((l) => ({ cells: [l.label, m(l.amount)] })));
  f.gap(4);
  f.row('Net fees', m(inv.net), { muted: true });
  if (inv.tax) f.row('Tax', m(inv.tax), { muted: true });
  f.row('Total', m(inv.total), { bold: true });
  if (inv.paid) f.row('Paid', m(inv.paid), { muted: true });
  f.row('Amount due', m(inv.outstanding), { bold: true, size: 12, rule: false });
  if (inv.payments.length) {
    f.heading('Payments received');
    f.table([{ label: 'Date', width: 1.5 }, { label: 'Reference', width: 4 }, { label: 'Amount', width: 2, align: 'right' }],
      inv.payments.map((p) => ({ cells: [p.paidOn, p.reference, m(p.amount)] })));
  }
  if (inv.outstanding > 0) {
    f.heading('How to pay');
    if (inv.link) f.para(`Pay online (bank transfer, virtual account, e-wallet or card): ${inv.link.url}`, { size: 9 });
    if (paymentInstructions) f.para(paymentInstructions, { size: 9 });
    f.para(`Please quote ${inv.number} with a bank transfer.`, { size: 9 });
  }
  footers(doc, `${seller.name} · ${title}`);
  return doc.toBuffer();
}

// ─────────────────────────────────────────── payment links

/** The platform's Xendit account (an integration with no organisation), or null. */
async function platformXendit(platformOrgId: string) {
  const a = (await accountsFor(platformOrgId, true)).find((x) => x.orgId === null && x.provider === 'xendit' && !x.archived && !x.fallback);
  return a ? { account: a, g: await xenditOf(a.id) } : null;
}

/** A payment link for what is outstanding on a fee statement (the open one, if any, stays). */
export async function createLink(platformOrgId: string, statementId: string, userId: string | null) {
  const inv = await invoice(statementId);
  if (inv.link) return inv.link;
  if (inv.outstanding <= 0) throw new InvoicingError(409, `${inv.number} is paid.`);
  const px = await platformXendit(platformOrgId);
  if (!px?.g) throw new InvoicingError(409, 'Connect PlugSure\'s own Xendit account first (Integrations, platform level).');
  const st = await settings(platformOrgId);
  const externalId = `PSF-${inv.number}-${randomBytes(4).toString('hex')}`.replace(/[^\w-]/g, '-').slice(0, 64);
  let x: { id: string; url: string; expiresAt: string | null };
  try {
    x = await px.g.x.createInvoiceLink({
      externalId, amountMinor: inv.outstanding, currency: inv.currency, durationS: st.linkDays * 86_400,
      description: `PlugSure fees ${inv.period} · ${inv.number} · ${inv.operator.name}`, payerEmail: inv.operator.billingEmail?.split(/[,;]\s*/)[0] ?? null,
    });
  } catch (e) {
    throw new InvoicingError(502, `Xendit refused the payment link: ${(e as Error).message}`);
  }
  try {
    const r = await outsideRequestScope(() => one<any>(
      `INSERT INTO platform_invoice_link (org_id, statement_id, integration_id, external_id, xendit_id, url, amount_minor, currency, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [inv.operator.id, statementId, px.account.id, externalId, x.id, x.url, inv.outstanding, inv.currency, x.expiresAt, userId]));
    return linkView(r);
  } catch (e) {
    if ((e as any).code === '23505') return (await invoice(statementId)).link!;
    throw e;
  }
}

/** Expire the open link at our side (e.g. the operator paid by bank transfer). */
export async function cancelLink(statementId: string) {
  const r = await outsideRequestScope(() => one(`UPDATE platform_invoice_link SET status = 'expired', checked_at = now(), error = 'cancelled' WHERE statement_id = $1 AND status = 'pending' RETURNING id`, [statementId]));
  if (!r) throw new InvoicingError(404, 'No open payment link on this statement.');
  return { ok: true };
}

/**
 * Check one link at Xendit; on paid, record the payment on the statement (what was outstanding at most) and mark
 * the link paid. Returns the link's state.
 */
export async function checkLink(platformOrgId: string, linkId: string): Promise<string> {
  const l = await outsideRequestScope(() => one<any>(`SELECT * FROM platform_invoice_link WHERE id = $1`, [linkId]));
  if (!l || l.status !== 'pending') return l?.status ?? 'missing';
  const g = l.integration_id ? await xenditOf(l.integration_id) : null;
  if (!g) {
    await outsideRequestScope(() => query(`UPDATE platform_invoice_link SET checked_at = now(), error = 'The Xendit account is no longer connected.' WHERE id = $1`, [linkId]));
    return 'pending';
  }
  let st: Awaited<ReturnType<typeof g.x.invoiceStatus>>;
  try {
    st = await g.x.invoiceStatus(l.xendit_id);
  } catch (e) {
    await outsideRequestScope(() => query(`UPDATE platform_invoice_link SET checked_at = now(), error = $2 WHERE id = $1`, [linkId, (e as Error).message.slice(0, 300)]));
    return 'pending';
  }
  if (st.status === 'pending') {
    await outsideRequestScope(() => query(`UPDATE platform_invoice_link SET checked_at = now(), error = NULL WHERE id = $1`, [linkId]));
    return 'pending';
  }
  if (st.status === 'expired') {
    await outsideRequestScope(() => query(`UPDATE platform_invoice_link SET status = 'expired', checked_at = now(), error = NULL WHERE id = $1 AND status = 'pending'`, [linkId]));
    return 'expired';
  }
  // Paid. Claim the link first, so a second worker run never records the payment twice.
  const claimed = await outsideRequestScope(() => one(`UPDATE platform_invoice_link SET status = 'paid', paid_at = $2, checked_at = now(), error = NULL WHERE id = $1 AND status = 'pending' RETURNING id`,
    [linkId, st.paidAt ?? new Date().toISOString()]));
  if (!claimed) return 'paid';
  const inv = await invoice(l.statement_id);
  const amount = Math.min(inv.outstanding, Math.round(st.paidAmount ?? Number(l.amount_minor)));
  if (amount > 0) {
    try {
      const p = await recordPayment(l.statement_id, platformOrgId, true, {
        amount, paidOn: localDay(st.paidAt ? new Date(st.paidAt) : new Date()), reference: `Xendit ${l.external_id}`.slice(0, 120),
        note: `Paid online${st.method ? ` (${st.method})` : ''} through the payment link.`,
      }, null);
      await outsideRequestScope(() => query(`UPDATE platform_invoice_link SET payment_id = $2 WHERE id = $1`, [linkId, p.paymentId]));
    } catch (e) {
      const msg = e instanceof PayoutError ? e.message : (e as Error).message;
      await outsideRequestScope(() => query(`UPDATE platform_invoice_link SET error = $2 WHERE id = $1`, [linkId, `Paid at Xendit, but not recorded: ${msg}`.slice(0, 300)]));
      await persistAlert({ orgId: platformOrgId, kind: LINK_ALERT, severity: 'warning', targetType: 'commission_statement', targetId: l.statement_id,
        message: `${inv.number} was paid through its Xendit link, but the payment could not be recorded: ${msg}. Record it by hand.` }).catch(() => undefined);
    }
  }
  return 'paid';
}

// ─────────────────────────────────────────── e-mail

async function emailChannel(orgId: string) {
  const ch = await outsideRequestScope(() => one<{ enabled: boolean; config: any; secret: string | null }>(`SELECT enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind = 'email'`, [orgId]));
  if (!ch?.enabled || !ch.config?.host) throw new InvoicingError(409, 'Set up the e-mail channel first (Governance → Alert routing → Channels).');
  let secret: string | null = null;
  try { secret = ch.secret ? unseal(ch.secret) : null; } catch { secret = null; }
  return { config: ch.config, secret };
}

/** E-mail the invoice (or a reminder) to the operator's billing e-mail (or `to`), with the PDF; logged. */
export async function send(platformOrgId: string, statementId: string, o: { to?: unknown; kind?: 'invoice' | 'reminder'; automatic?: boolean; userId?: string | null; link?: boolean } = {}) {
  const kind = o.kind === 'reminder' ? 'reminder' as const : 'invoice' as const;
  let inv = await invoice(statementId);
  const to = String(o.to ?? inv.operator.billingEmail ?? '').trim();
  const log = (fields: { to: string | null; ref?: string | null; error?: string | null }) => outsideRequestScope(() => query(
    `INSERT INTO platform_invoice_send (org_id, statement_id, kind, sent_to, reference, error, automatic, sent_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [inv.operator.id, statementId, kind, fields.to, fields.ref ?? null, fields.error?.slice(0, 300) ?? null, o.automatic === true, o.userId ?? null]));
  if (!to || to.length > 300 || !to.split(/[,;]\s*/).every((x) => EMAIL_RE.test(x))) throw new InvoicingError(422, 'No valid billing e-mail address for this operator.');
  if (kind === 'reminder' && inv.outstanding <= 0) throw new InvoicingError(409, `${inv.number} is paid: no reminder.`);
  const ch = await emailChannel(platformOrgId);
  if (o.link && inv.outstanding > 0 && !inv.link) {
    try { await createLink(platformOrgId, statementId, o.userId ?? null); inv = await invoice(statementId); } catch (e) { logger.warn({ statementId, err: (e as Error).message }, 'payment link not created'); }
  }
  const { seller, settings: fb } = await sellerOf(platformOrgId);
  const m = (n: number) => moneyText(n, currencyOr(inv.currency));
  const overdue = inv.daysPastDue > 0;
  const head = kind === 'invoice'
    ? `Please find attached invoice ${inv.number} for PlugSure's fees for ${inv.period}: ${m(inv.total)}, due on ${inv.due}.`
    : overdue ? `Our records show invoice ${inv.number} (fees for ${inv.period}) is ${inv.daysPastDue} day${inv.daysPastDue === 1 ? '' : 's'} past its due date (${inv.due}): ${m(inv.outstanding)} is outstanding.`
      : `A reminder that invoice ${inv.number} (fees for ${inv.period}) is due on ${inv.due}: ${m(inv.outstanding)} is outstanding.`;
  const text = `Dear ${inv.operator.name},\n\n${head}\n\n${inv.link ? `Pay online: ${inv.link.url}\n\n` : ''}${inv.outstanding > 0 ? `Or by bank transfer, quoting ${inv.number}.${fb.paymentInstructions ? `\n${fb.paymentInstructions}` : ''}\n\n` : ''}` +
    `${kind === 'reminder' ? 'If you have already paid, thank you, and please reply with the transfer\'s reference so we can match it.\n\n' : ''}${seller.name}`;
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = text.split('\n\n').map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const res = await sendEmail(ch.config, ch.secret, to, {
    subject: kind === 'invoice' ? `Invoice ${inv.number} — PlugSure fees ${inv.period}` : `${overdue ? 'Overdue' : 'Payment reminder'}: invoice ${inv.number} — ${m(inv.outstanding)}`,
    text, html, kind: 'platform-invoice',
    attachments: [{ filename: `invoice-${inv.number.replace(/[^\w-]+/g, '-')}.pdf`, content: invoicePdf(inv, seller, fb.paymentInstructions || null), contentType: 'application/pdf' }],
  });
  if (!res.ok) {
    await log({ to: to.slice(0, 300), error: res.error ?? 'failed' });
    throw new InvoicingError(502, `The e-mail was not sent: ${res.error ?? 'failed'}`);
  }
  await log({ to: to.slice(0, 300), ref: res.ref ?? null });
  return { ok: true, to, kind, reference: res.ref ?? null, link: inv.link?.url ?? null };
}

// ─────────────────────────────────────────── statement of account

/** An operator's fee statements and payments in one currency-separated ledger, with the running balance. */
export async function accountStatement(operatorId: string) {
  if (!UUID_RE.test(operatorId)) throw new InvoicingError(404, 'No such operator.');
  const op = await outsideRequestScope(() => one<any>(`SELECT id, name, npwp, billing_address, billing_email FROM organisation WHERE id = $1`, [operatorId]));
  if (!op) throw new InvoicingError(404, 'No such operator.');
  const [st, pays] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT id, number, to_char(period, 'YYYY-MM') AS period, currency, total_minor, finalised_at FROM commission_statement
        WHERE org_id = $1 AND owner_id IS NULL AND finalised_at IS NOT NULL AND total_minor > 0`, [operatorId])),
    outsideRequestScope(() => many<any>(
      `SELECT p.id, p.amount_minor, p.currency, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.reference, s.number FROM statement_payment p JOIN commission_statement s ON s.id = p.statement_id
        WHERE s.org_id = $1 AND s.owner_id IS NULL AND p.kind = 'platform_fee' AND p.voided_at IS NULL`, [operatorId])),
  ]);
  const entries = [
    ...st.map((s) => ({ currency: s.currency, date: localDay(s.finalised_at), kind: 'invoice' as const, number: s.number, description: `Fees for ${s.period}, due ${dueOf(s.finalised_at)}`, debit: Number(s.total_minor), credit: 0 })),
    ...pays.map((p) => ({ currency: p.currency, date: p.paid_on, kind: 'payment' as const, number: p.number, description: `Payment ${p.reference}`, debit: 0, credit: Number(p.amount_minor) })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'invoice' ? -1 : 1));
  const currencies = [...new Set(entries.map((e) => e.currency))].sort().map((cur) => {
    let bal = 0;
    const rows = entries.filter((e) => e.currency === cur).map(({ currency: _c, ...e }) => { bal += e.debit - e.credit; return { ...e, balance: bal }; });
    return { currency: cur, entries: rows, invoiced: rows.reduce((s, e) => s + e.debit, 0), paid: rows.reduce((s, e) => s + e.credit, 0), balance: bal };
  });
  return { operator: { id: op.id, name: op.name, billingEmail: op.billing_email ?? null }, currencies };
}

export function accountCsv(a: Awaited<ReturnType<typeof accountStatement>>): string {
  const cell = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const rows = [['currency', 'date', 'kind', 'number', 'description', 'debit_minor', 'credit_minor', 'balance_minor']];
  for (const c of a.currencies) for (const e of c.entries) rows.push([c.currency, e.date, e.kind, e.number, e.description, String(e.debit), String(e.credit), String(e.balance)]);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ─────────────────────────────────────────── the worker

/**
 * Hourly: check every open payment link (paid → recorded); then for each platform organisation with automatic
 * invoicing on: e-mail each fee statement not sent yet (with a link if set), and the reminders reached (once each,
 * at most 3 failed tries a day).
 */
export async function sweep(now = new Date()): Promise<{ checked: number; sent: number; reminded: number }> {
  let checked = 0, sent = 0, reminded = 0;
  const orgs = await outsideRequestScope(() => many<{ org_id: string; platform_invoicing: any }>(
    `SELECT org_id, platform_invoicing FROM finance_org_settings WHERE platform_invoicing <> '{}'::jsonb`));
  const links = await outsideRequestScope(() => many<{ id: string }>(`SELECT id FROM platform_invoice_link WHERE status = 'pending' ORDER BY checked_at NULLS FIRST LIMIT 200`));
  const linkOrg = orgs[0]?.org_id ?? (await opsAlertOrgs())[0] ?? null;
  for (const l of links) {
    if (!linkOrg) break;
    try { await checkLink(linkOrg, l.id); checked++; } catch (e) { logger.warn({ link: l.id, err: (e as Error).message }, 'payment link check failed'); }
  }
  for (const o of orgs) {
    const st = await settings(o.org_id);
    if (!st.autoSend && !st.reminderDays.length) continue;
    const today = localDay(now);
    for (const r of await list()) {
      if (!r.billingEmail) continue;
      try {
        if (st.autoSend && !r.sentAt && r.outstanding > 0) {
          const tries = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM platform_invoice_send WHERE statement_id = $1 AND kind = 'invoice' AND automatic AND error IS NOT NULL AND sent_at::date = $2::date`, [r.statementId, today]));
          if ((tries?.n ?? 0) < 3) { await send(o.org_id, r.statementId, { automatic: true, link: st.autoLink }); sent++; }
          continue;
        }
        if (r.outstanding <= 0 || !r.sentAt) continue;
        const reached = st.reminderDays.filter((d) => r.daysPastDue >= d);
        if (!reached.length) continue;
        const done = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM platform_invoice_send WHERE statement_id = $1 AND kind = 'reminder' AND automatic AND error IS NULL`, [r.statementId]));
        if ((done?.n ?? 0) >= reached.length) continue;
        await send(o.org_id, r.statementId, { kind: 'reminder', automatic: true, link: st.autoLink });
        reminded++;
      } catch (e) {
        logger.warn({ statement: r.statementId, err: (e as Error).message }, 'fee invoice not sent');
        if (e instanceof InvoicingError && e.statusCode === 409 && /e-mail channel/.test(e.message)) break;
      }
    }
  }
  return { checked, sent, reminded };
}
