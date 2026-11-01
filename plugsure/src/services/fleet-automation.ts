import { randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { issueAll, sendInvoice, markPaid, getInvoice, getSettings, FleetBillingError } from './fleet-billing.js';
import { accountsFor, xenditOf } from './finance.js';
import { persistAlert } from './alerts.js';

/**
 * Fleet invoicing automation (v1.27.0), per organisation (finance_org_settings.fleet_automation):
 *
 *   issue          on a day of the month (1–28), the month just ended is invoiced for every fleet account with
 *                  charges (as Fleet billing → Issue all)
 *   e-Faktur       with "require the e-Faktur number" on, an invoice with PPN to a buyer with a tax id is not sent
 *                  until its faktur pajak number is set (Fleet billing → e-Faktur): the preview says which
 *   send           every issued invoice not sent yet, to the account's billing e-mail, with a payment link
 *   payment links  a Xendit invoice on the operator's own Xendit account for the balance; the worker asks Xendit,
 *                  and a paid link marks the invoice paid (with the Xendit reference)
 *
 * Reminders for unpaid invoices are Collections' dunning (Finance → Collections), which already covers fleet invoices.
 */

export class FleetAutomationError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const LINK_ALERT = 'finance.fleet_invoice_link';
const zone = () => config.billing.timeZone;
const localDay = (t: Date | number = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date(t));
const prevMonth = (now = new Date()) => {
  let [y, m] = localDay(now).slice(0, 7).split('-').map(Number) as [number, number];
  m--; if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface AutoSettings { autoIssue: boolean; issueDay: number; autoSend: boolean; requireEfaktur: boolean; paymentLinks: boolean; linkDays: number }

export async function settings(orgId: string): Promise<AutoSettings> {
  const r = await outsideRequestScope(() => one<{ fleet_automation: any }>(`SELECT fleet_automation FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.fleet_automation ?? {};
  return {
    autoIssue: v.autoIssue === true, issueDay: Number(v.issueDay ?? 2), autoSend: v.autoSend === true,
    requireEfaktur: v.requireEfaktur === true, paymentLinks: v.paymentLinks === true, linkDays: Number(v.linkDays ?? 30),
  };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<AutoSettings> {
  const cur = await settings(orgId);
  const issueDay = b.issueDay === undefined || b.issueDay === '' ? cur.issueDay : Number(b.issueDay);
  if (!Number.isInteger(issueDay) || issueDay < 1 || issueDay > 28) throw new FleetAutomationError(422, 'The issue day is 1 to 28.');
  const linkDays = b.linkDays === undefined || b.linkDays === '' ? cur.linkDays : Number(b.linkDays);
  if (!Number.isInteger(linkDays) || linkDays < 1 || linkDays > 90) throw new FleetAutomationError(422, 'A payment link lasts 1 to 90 days.');
  const flag = (k: keyof AutoSettings) => (b[k] === undefined ? cur[k] as boolean : b[k] === true);
  const v: AutoSettings = { autoIssue: flag('autoIssue'), issueDay, autoSend: flag('autoSend'), requireEfaktur: flag('requireEfaktur'), paymentLinks: flag('paymentLinks'), linkDays };
  if (v.paymentLinks && !(await ownXendit(orgId))) throw new FleetAutomationError(409, 'Payment links need your own Xendit account (Integrations → Payments).');
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, fleet_automation, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET fleet_automation = EXCLUDED.fleet_automation, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/** The operator's own Xendit account (not the platform's). */
async function ownXendit(orgId: string) {
  const a = (await accountsFor(orgId, false)).find((x) => x.orgId === orgId && x.provider === 'xendit' && !x.archived && !x.fallback);
  if (!a) return null;
  const g = await xenditOf(a.id);
  return g ? { id: a.id, g } : null;
}

/** Why an issued, unsent invoice is not sent yet (null: it can be). */
function holdOf(inv: any, s: AutoSettings, sellerPkp: boolean): string | null {
  if (!inv.billing_email) return 'No billing e-mail on the fleet account.';
  if (s.requireEfaktur && sellerPkp && Number(inv.tax_minor) > 0 && inv.tax_id && !inv.efaktur_number) return 'Waiting for its e-Faktur number (Fleet billing → e-Faktur).';
  return null;
}

/** What the automation would do now: the month to issue, invoices to send or held (and why), open links. */
export async function preview(orgId: string, now = new Date()) {
  const s = await settings(orgId);
  const { seller } = await outsideRequestScope(() => getSettings(orgId));
  const month = prevMonth(now);
  const [unsent, links, issuedForMonth] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT i.id, i.number, i.currency, i.total_minor, i.tax_minor, i.efaktur_number, to_char(i.period, 'YYYY-MM') AS period, a.name, a.billing_email, a.tax_id
         FROM fleet_invoice i JOIN fleet_account a ON a.id = i.fleet_account_id
        WHERE i.org_id = $1 AND i.status = 'issued' AND i.sent_at IS NULL ORDER BY i.issued_at`, [orgId])),
    outsideRequestScope(() => many<any>(
      `SELECT l.*, i.number FROM fleet_invoice_link l JOIN fleet_invoice i ON i.id = l.invoice_id WHERE l.org_id = $1 ORDER BY l.created_at DESC LIMIT 100`, [orgId])),
    outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM fleet_invoice WHERE org_id = $1 AND to_char(period, 'YYYY-MM') = $2 AND status <> 'void'`, [orgId, month])),
  ]);
  const day = Number(localDay(now).slice(8, 10));
  return {
    settings: s, month, issueDue: s.autoIssue && day >= s.issueDay, issuedForMonth: issuedForMonth?.n ?? 0, xendit: Boolean(await ownXendit(orgId)),
    toSend: unsent.map((i) => {
      const hold = holdOf(i, s, seller.pkp === true);
      return { invoiceId: i.id, number: i.number, account: i.name, period: i.period, currency: i.currency, total: Number(i.total_minor), efaktur: i.efaktur_number ?? null, ready: hold === null, hold };
    }),
    links: links.map((l) => ({ id: String(l.id), invoiceId: l.invoice_id, number: l.number, url: l.url, amount: Number(l.amount_minor), currency: l.currency, status: l.status, paidAt: iso(l.paid_at), error: l.error ?? null, createdAt: iso(l.created_at) })),
  };
}

// ─────────────────────────────────────────── payment links

/** A Xendit payment link for an issued invoice's balance (the open one if there is one). */
export async function createLink(orgId: string, invoiceId: string, userId: string | null) {
  const st = await outsideRequestScope(() => getInvoice(orgId, invoiceId)).catch((e) => {
    if (e instanceof FleetBillingError) throw new FleetAutomationError(e.status, e.message);
    throw e;
  });
  if (st.status !== 'issued') throw new FleetAutomationError(409, `The invoice is ${st.status}.`);
  const open = await outsideRequestScope(() => one<any>(`SELECT * FROM fleet_invoice_link WHERE invoice_id = $1 AND status = 'pending'`, [invoiceId]));
  if (open) return { id: String(open.id), url: open.url, amount: Number(open.amount_minor), status: open.status };
  const balance = Number(st.balanceMinor);
  if (balance <= 0) throw new FleetAutomationError(409, 'Nothing to pay on this invoice.');
  const x = await ownXendit(orgId);
  if (!x) throw new FleetAutomationError(409, 'Payment links need your own Xendit account (Integrations → Payments).');
  const s = await settings(orgId);
  const externalId = `FI-${String(st.number).replace(/[^\w-]+/g, '-')}-${randomBytes(4).toString('hex')}`.slice(0, 64);
  let r: { id: string; url: string; expiresAt: string | null };
  try {
    r = await x.g.x.createInvoiceLink({ externalId, amountMinor: balance, currency: st.currency, durationS: s.linkDays * 86_400, description: `Invoice ${st.number} · ${st.buyer.fleetName}`, payerEmail: String(st.buyer.email ?? '').split(/[,;]\s*/)[0] || null });
  } catch (e) {
    throw new FleetAutomationError(502, `Xendit refused the payment link: ${(e as Error).message}`);
  }
  try {
    const row = await outsideRequestScope(() => one<any>(
      `INSERT INTO fleet_invoice_link (org_id, invoice_id, integration_id, external_id, xendit_id, url, amount_minor, currency, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`, [orgId, invoiceId, x.id, externalId, r.id, r.url, balance, st.currency, r.expiresAt, userId]));
    return { id: String(row.id), url: row.url, amount: Number(row.amount_minor), status: row.status };
  } catch (e) {
    if ((e as any).code === '23505') return createLink(orgId, invoiceId, userId);
    throw e;
  }
}

/** The open link's URL for an invoice, if any (used in the invoice e-mail). */
export async function openLinkUrl(invoiceId: string): Promise<string | null> {
  return (await outsideRequestScope(() => one<{ url: string }>(`SELECT url FROM fleet_invoice_link WHERE invoice_id = $1 AND status = 'pending'`, [invoiceId])))?.url ?? null;
}

/** Ask Xendit about one link; paid → the invoice marked paid, once. */
export async function checkLink(linkId: string): Promise<string> {
  const l = await outsideRequestScope(() => one<any>(`SELECT * FROM fleet_invoice_link WHERE id = $1`, [linkId]));
  if (!l || l.status !== 'pending') return l?.status ?? 'missing';
  const g = l.integration_id ? await xenditOf(l.integration_id) : null;
  if (!g) { await outsideRequestScope(() => query(`UPDATE fleet_invoice_link SET checked_at = now(), error = 'The Xendit account is no longer connected.' WHERE id = $1`, [linkId])); return 'pending'; }
  let st;
  try { st = await g.x.invoiceStatus(l.xendit_id); } catch (e) {
    await outsideRequestScope(() => query(`UPDATE fleet_invoice_link SET checked_at = now(), error = $2 WHERE id = $1`, [linkId, (e as Error).message.slice(0, 300)]));
    return 'pending';
  }
  if (st.status === 'pending') { await outsideRequestScope(() => query(`UPDATE fleet_invoice_link SET checked_at = now(), error = NULL WHERE id = $1`, [linkId])); return 'pending'; }
  if (st.status === 'expired') { await outsideRequestScope(() => query(`UPDATE fleet_invoice_link SET status = 'expired', checked_at = now() WHERE id = $1 AND status = 'pending'`, [linkId])); return 'expired'; }
  const won = await outsideRequestScope(() => one(`UPDATE fleet_invoice_link SET status = 'paid', paid_at = $2, checked_at = now(), error = NULL WHERE id = $1 AND status = 'pending' RETURNING id`, [linkId, st.paidAt ?? new Date().toISOString()]));
  if (!won) return 'paid';
  try {
    await outsideRequestScope(() => markPaid(l.org_id, l.invoice_id, { paidAt: localDay(st.paidAt ? new Date(st.paidAt) : new Date()), reference: `Xendit ${l.external_id}${st.method ? ` (${st.method})` : ''}` }));
  } catch (e) {
    const msg = (e as Error).message;
    await outsideRequestScope(() => query(`UPDATE fleet_invoice_link SET error = $2 WHERE id = $1`, [linkId, `Paid at Xendit, but not marked paid: ${msg}`.slice(0, 300)]));
    await persistAlert({ orgId: l.org_id, kind: LINK_ALERT, severity: 'warning', targetType: 'fleet_invoice', targetId: l.invoice_id, message: `A fleet invoice was paid through its Xendit link but could not be marked paid: ${msg}` }).catch(() => undefined);
  }
  return 'paid';
}

// ─────────────────────────────────────────── the worker

/** One organisation: issue (on the day), links, send. */
export async function run(orgId: string, now = new Date(), actor = 'automation') {
  const s = await settings(orgId);
  const out = { issued: [] as string[], sent: [] as string[], held: [] as Array<{ number: string; hold: string }>, failed: [] as Array<{ number: string; error: string }> };
  const p = await preview(orgId, now);
  if (p.issueDue && p.issuedForMonth === 0) {
    const r = await outsideRequestScope(() => issueAll(orgId, p.month, actor));
    out.issued.push(...r.issued.map((x) => x.number));
  }
  if (!s.autoSend) return out;
  const fresh = out.issued.length ? await preview(orgId, now) : p;
  for (const i of fresh.toSend) {
    if (!i.ready) { out.held.push({ number: i.number, hold: i.hold! }); continue; }
    try {
      if (s.paymentLinks) await createLink(orgId, i.invoiceId, null).catch((e) => logger.warn({ invoice: i.invoiceId, err: (e as Error).message }, 'fleet payment link not created'));
      await outsideRequestScope(() => sendInvoice(orgId, i.invoiceId));
      out.sent.push(i.number);
    } catch (e) {
      out.failed.push({ number: i.number, error: (e as Error).message });
      if (e instanceof FleetBillingError && e.status === 409) break; // no e-mail channel: the same for all
    }
  }
  return out;
}

export async function sweep(now = new Date()): Promise<number> {
  let n = 0;
  const links = await outsideRequestScope(() => many<{ id: string }>(`SELECT id FROM fleet_invoice_link WHERE status = 'pending' ORDER BY checked_at NULLS FIRST LIMIT 300`));
  for (const l of links) { try { await checkLink(l.id); } catch (e) { logger.warn({ link: l.id, err: (e as Error).message }, 'fleet payment link check failed'); } }
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(
    `SELECT org_id FROM finance_org_settings WHERE (fleet_automation->>'autoIssue')::boolean IS TRUE OR (fleet_automation->>'autoSend')::boolean IS TRUE`));
  for (const o of orgs) {
    try { const r = await run(o.org_id, now); n += r.issued.length + r.sent.length; } catch (e) { logger.warn({ org: o.org_id, err: (e as Error).message }, 'fleet automation failed'); }
  }
  return n;
}
