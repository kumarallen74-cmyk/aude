import { one, many, query, tx } from '../db/pool.js';
import { upgradeLegacyKeys, moneyText, currencyOr, LEGACY_CURRENCY, type CurrencyCode } from '../domain/money.js';
import { config } from '../config.js';
import { unseal } from './secrets.js';
import { sendEmail } from './notify-transports.js';
import { dppOf, ppnOf, type TaxCfg } from './fleet-calc.js';
import { FleetBillingError, getSettings, getInvoice, invoiceRow, todayLocal, balanceOf, fmtDate } from './fleet-billing.js';

/**
 * Credit notes on fleet invoices.
 *
 * An issued invoice never changes: its figures are the ones on the faktur pajak.
 * A mistake, a disputed session or a goodwill gesture is corrected with a numbered
 * credit note against it, for the whole invoice or for lines of an amount each:
 *
 *   - on an unpaid invoice it reduces what is still owed (and settles the invoice
 *     when nothing is left);
 *   - on a paid one the money goes back: refunded (recorded when paid out), or
 *     deducted from the account's next invoice.
 *
 * Amounts are what the customer gets back, PPN included. A line "with PPN" is
 * split into price, DPP (11/12) and PPN (12% of DPP) exactly like an invoice line,
 * so the nota pembatalan in Coretax reverses the same tax. A credit can never take
 * back more than the invoice charged, in total, in DPP or in PPN, or more of the
 * untaxed part (partner networks, sessions without PPN) than there was.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TAX = (): TaxCfg => ({ ppnRateBps: config.tax.id.ppnRateBps, dppNum: config.tax.id.ppnDppNumerator, dppDen: config.tax.id.ppnDppDenominator });

/**
 * The tax of a credit note follows its invoice: rupiah with PPN on DPP 11/12 (v1.6); ringgit /
 * Singapore dollars with the invoice's own rate on the whole price (GST, service tax), as
 * frozen on the invoice (data.taxRateBps).
 */
export function creditTaxCfg(inv: { currency?: string | null; data?: any }): TaxCfg {
  if (currencyOr(inv.currency) === LEGACY_CURRENCY) return TAX();
  return { ppnRateBps: Number(upgradeLegacyKeys(inv.data ?? {})?.taxRateBps ?? 0), dppNum: 1, dppDen: 1 };
}

export interface CreditLine { description: string; amountMinor: number; taxed: boolean; taxableMinor: number; taxBaseMinor: number; taxMinor: number }
export interface Creditable { totalMinor: number; taxBaseMinor: number; taxMinor: number }

/**
 * Split an amount that includes PPN into price + PPN, with PPN = 12% of DPP (11/12 of
 * the price) as on an invoice line. Some amounts cannot be reached exactly (the
 * rounding skips them); then the nearest reachable one is used, and returned.
 */
export function splitInclusive(amount: number, cfg: TaxCfg): { amountMinor: number; taxableMinor: number; taxBaseMinor: number; taxMinor: number } {
  const k = (cfg.dppNum * cfg.ppnRateBps) / (cfg.dppDen * 10_000);
  const guess = Math.round(amount / (1 + k));
  let best: { amountMinor: number; taxableMinor: number; taxBaseMinor: number; taxMinor: number } | null = null;
  for (let base = guess - 3; base <= guess + 3; base++) {
    if (base < 0) continue;
    const dpp = dppOf(base, cfg);
    const ppn = ppnOf(dpp, cfg);
    const c = { amountMinor: base + ppn, taxableMinor: base, taxBaseMinor: dpp, taxMinor: ppn };
    if (c.amountMinor === amount) return c;
    if (!best || Math.abs(c.amountMinor - amount) < Math.abs(best.amountMinor - amount)) best = c;
  }
  return best!;
}

/**
 * The lines and totals of a credit note, checked against what the invoice still
 * has to credit. `invoiceTaxed` is whether the invoice carries PPN at all.
 */
export function computeCredit(
  remaining: Creditable, invoiceTaxed: boolean, input: { full?: unknown; lines?: unknown }, cfg: TaxCfg, label: string, currency: CurrencyCode = LEGACY_CURRENCY,
): { lines: CreditLine[]; taxBaseMinor: number; taxMinor: number; totalMinor: number } {
  const id = currency === LEGACY_CURRENCY;
  const m = (n: number) => moneyText(n, currency);
  const taxName = id ? 'PPN' : 'tax';
  if (remaining.totalMinor <= 0) throw new FleetBillingError(409, 'Everything on this invoice has already been credited.');
  let lines: CreditLine[];
  if (input.full === true) {
    lines = [{
      description: `Full credit of invoice ${label}`, amountMinor: remaining.totalMinor, taxed: remaining.taxMinor > 0,
      taxableMinor: remaining.taxBaseMinor ? Math.round((remaining.taxBaseMinor * cfg.dppDen) / cfg.dppNum) : 0, taxBaseMinor: remaining.taxBaseMinor, taxMinor: remaining.taxMinor,
    }];
  } else {
    const raw = Array.isArray(input.lines) ? input.lines : [];
    if (!raw.length) throw new FleetBillingError(422, 'Add at least one line: what is credited, and how much.');
    if (raw.length > 50) throw new FleetBillingError(422, 'At most 50 lines.');
    lines = raw.map((l: any, i: number) => {
      const description = String(l?.description ?? '').trim().slice(0, 200);
      if (description.length < 3) throw new FleetBillingError(422, `Line ${i + 1}: say what is credited.`);
      const amount = Number(l?.amountMinor);
      if (!Number.isInteger(amount) || amount <= 0) throw new FleetBillingError(422, id ? `Line ${i + 1}: the amount is a whole number of rupiah above 0.` : `Line ${i + 1}: the amount is a whole number of ${currency} minor units (sen / cents) above 0.`);
      const taxed = l?.taxed === undefined ? invoiceTaxed : l.taxed === true;
      if (taxed && !invoiceTaxed) throw new FleetBillingError(422, `Line ${i + 1}: this invoice carries no ${taxName}, so a credit cannot include any.`);
      if (!taxed) return { description, amountMinor: amount, taxed, taxableMinor: 0, taxBaseMinor: 0, taxMinor: 0 };
      const s = splitInclusive(amount, cfg);
      return { description, taxed, ...s };
    });
  }
  const totalMinor = lines.reduce((a, l) => a + l.amountMinor, 0);
  const taxBaseMinor = lines.reduce((a, l) => a + l.taxBaseMinor, 0);
  const taxMinor = lines.reduce((a, l) => a + l.taxMinor, 0);
  const untaxed = lines.filter((l) => !l.taxed).reduce((a, l) => a + l.amountMinor, 0);
  if (totalMinor > remaining.totalMinor) throw new FleetBillingError(422, `At most ${m(remaining.totalMinor)} of this invoice is left to credit.`);
  if (taxMinor > remaining.taxMinor || taxBaseMinor > remaining.taxBaseMinor) throw new FleetBillingError(422, `At most ${m(remaining.taxMinor)} of ${taxName} is left to credit on this invoice.`);
  // The part of the invoice without PPN (partner networks, sessions without PPN, PBJT outside the base).
  const remainingTaxedGross = remaining.taxBaseMinor ? Math.round((remaining.taxBaseMinor * cfg.dppDen) / cfg.dppNum) + remaining.taxMinor : 0;
  const untaxedLeft = Math.max(0, remaining.totalMinor - remainingTaxedGross);
  if (untaxed > untaxedLeft + 2) {
    throw new FleetBillingError(422, untaxedLeft
      ? `Only ${m(untaxedLeft)} of this invoice carries no ${taxName}; credit the rest with ${taxName}.`
      : `Everything on this invoice carries ${taxName}: credit it with ${taxName}.`);
  }
  return { lines, taxBaseMinor, taxMinor, totalMinor };
}

/** What is left to credit on an invoice after its live credit notes. */
async function remainingOf(inv: any): Promise<Creditable> {
  const c = await one<{ total: string; dpp: string; ppn: string }>(
    `SELECT COALESCE(sum(total_minor), 0) AS total, COALESCE(sum(tax_base_minor), 0) AS dpp, COALESCE(sum(tax_minor), 0) AS ppn
       FROM fleet_credit_note WHERE invoice_id = $1 AND status = 'issued'`, [inv.id]);
  return {
    totalMinor: Number(inv.total_minor) - Number(c?.total ?? 0),
    taxBaseMinor: Number(inv.tax_base_minor) - Number(c?.dpp ?? 0),
    taxMinor: Number(inv.tax_minor) - Number(c?.ppn ?? 0),
  };
}

const SETTLED_BY = 'Settled by credit note ';

export async function issueCreditNote(orgId: string, invoiceId: string, b: any, actor: string) {
  const reason = String(b?.reason ?? '').trim().slice(0, 500);
  if (reason.length < 3) throw new FleetBillingError(422, 'Give the reason for the credit (it is printed on the credit note).');
  return tx(async () => {
    await query(`SELECT pg_advisory_xact_lock(hashtextextended('fleet-invoice:' || $1::text, 0))`, [orgId]);
    const inv = await invoiceRow(orgId, invoiceId);
    if (inv.status === 'void') throw new FleetBillingError(409, 'A void invoice cannot be credited.');
    let settlement: 'invoice' | 'refund' | 'next_invoice';
    if (inv.status === 'issued') {
      if (b?.settlement && b.settlement !== 'invoice') throw new FleetBillingError(422, 'The invoice is not paid yet: the credit reduces what is still owed on it.');
      settlement = 'invoice';
    } else {
      settlement = b?.settlement === 'next_invoice' ? 'next_invoice' : b?.settlement == null || b.settlement === 'refund' ? 'refund' : (() => { throw new FleetBillingError(422, 'A paid invoice\'s credit is refunded or deducted from the next invoice.'); })();
    }
    const currency = currencyOr(inv.currency);
    const calc = computeCredit(await remainingOf(inv), Number(inv.tax_minor) > 0, b ?? {}, creditTaxCfg(inv), inv.number, currency);
    if (settlement === 'invoice' && calc.totalMinor > balanceOf(inv)) {
      throw new FleetBillingError(422, `Only ${moneyText(balanceOf(inv), currency)} is still owed on this invoice; record the payment first and credit the rest as a refund.`);
    }
    const { settings } = await getSettings(orgId);
    const today = todayLocal();
    const [y, mo] = today.split('-');
    const prefix = `${settings.prefix}-CN`;
    const last = await one<{ seq: number }>(
      `SELECT COALESCE(max(split_part(number, '/', 4)::int), 0) AS seq FROM fleet_credit_note
        WHERE org_id = $1 AND number LIKE $2 || '%' AND split_part(number, '/', 4) ~ '^[0-9]+$'`,
      [orgId, `${prefix}/${y}/`],
    );
    const number = `${prefix}/${y}/${mo}/${String((last?.seq ?? 0) + 1).padStart(4, '0')}`;
    const row = await one<{ id: string }>(
      `INSERT INTO fleet_credit_note (org_id, fleet_account_id, invoice_id, number, settlement, reason, lines, tax_base_minor, tax_minor, total_minor, issued_by, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [orgId, inv.fleet_account_id, inv.id, number, settlement, reason, JSON.stringify(calc.lines), calc.taxBaseMinor, calc.taxMinor, calc.totalMinor, actor, currency],
    );
    let settledInvoice = false;
    if (settlement === 'invoice') {
      await query(`UPDATE fleet_invoice SET credited_minor = credited_minor + $2 WHERE id = $1`, [inv.id, calc.totalMinor]);
      if (balanceOf({ ...inv, credited_minor: Number(inv.credited_minor) + calc.totalMinor }) === 0) {
        await query(`UPDATE fleet_invoice SET status = 'paid', paid_at = $2, paid_reference = $3 WHERE id = $1`, [inv.id, today, SETTLED_BY + number]);
        await query(`UPDATE subscription_charge SET state = 'paid', paid_at = now() WHERE fleet_invoice_id = $1 AND state = 'pending'`, [inv.id]);
        settledInvoice = true;
      }
    }
    return {
      id: row!.id, number, settlement, totalMinor: calc.totalMinor, settledInvoice,
      fakturWarning: inv.efaktur_exported_at || inv.efaktur_number
        ? `The invoice's faktur pajak${inv.efaktur_number ? ` (${inv.efaktur_number})` : ''} was already reported: record the nota pembatalan (or a replacement faktur) for this credit in Coretax.`
        : null,
    };
  });
}

async function creditRow(orgId: string, id: string) {
  if (!UUID_RE.test(String(id))) throw new FleetBillingError(404, 'credit note not found');
  const c = await one<any>(`SELECT * FROM fleet_credit_note WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!c) throw new FleetBillingError(404, 'credit note not found');
  return c;
}

/** A credit note with what the documents need: the invoice it credits, seller and buyer. */
export async function getCreditNote(orgId: string, id: string) {
  const c = await creditRow(orgId, id);
  const inv = await getInvoice(orgId, c.invoice_id);
  const applied = c.applied_invoice_id ? await one<{ number: string }>(`SELECT number FROM fleet_invoice WHERE id = $1`, [c.applied_invoice_id]) : null;
  return {
    id: c.id, number: c.number, status: c.status, settlement: c.settlement, reason: c.reason, lines: upgradeLegacyKeys(c.lines) as CreditLine[],
    currency: currencyOr(c.currency), taxScheme: (inv as any).taxScheme ?? null, taxRateBps: (inv as any).taxRateBps ?? null, taxRegistrationNo: (inv as any).taxRegistrationNo ?? null,
    taxBaseMinor: Number(c.tax_base_minor), taxMinor: Number(c.tax_minor), totalMinor: Number(c.total_minor),
    issuedAt: c.issued_at, issuedDate: fmtDate(c.issued_at), issuedBy: c.issued_by,
    refundedAt: c.refunded_at ? fmtDate(c.refunded_at) : null, refundReference: c.refund_reference,
    appliedInvoice: applied?.number ?? null, voidedAt: c.voided_at, voidReason: c.void_reason, sentAt: c.sent_at, sentTo: c.sent_to,
    invoice: { id: inv.id, number: inv.number, issuedDate: inv.issuedDate, periodLabel: inv.periodLabel, totalMinor: inv.totals.totalMinor, efakturNumber: inv.efakturNumber, status: inv.status },
    accountId: c.fleet_account_id, seller: inv.seller, buyer: inv.buyer,
  };
}

export async function listCreditNotes(orgId: string, f: { accountId?: string; invoiceId?: string; open?: boolean } = {}) {
  const rows = await many<any>(
    `SELECT c.id, c.number, c.status, c.settlement, c.reason, c.total_minor, c.tax_minor, c.issued_at, c.refunded_at, c.refund_reference,
            c.voided_at, c.sent_at, c.currency, i.id AS invoice_id, i.number AS invoice_number, a.id AS account_id, a.name AS account_name,
            ai.number AS applied_invoice
       FROM fleet_credit_note c JOIN fleet_invoice i ON i.id = c.invoice_id JOIN fleet_account a ON a.id = c.fleet_account_id
       LEFT JOIN fleet_invoice ai ON ai.id = c.applied_invoice_id
      WHERE c.org_id = $1 AND ($2::uuid IS NULL OR c.fleet_account_id = $2) AND ($3::uuid IS NULL OR c.invoice_id = $3)
        AND (NOT $4 OR (c.status = 'issued' AND ((c.settlement = 'refund' AND c.refunded_at IS NULL) OR (c.settlement = 'next_invoice' AND c.applied_invoice_id IS NULL))))
      ORDER BY c.issued_at DESC LIMIT 500`,
    [orgId, f.accountId && UUID_RE.test(f.accountId) ? f.accountId : null, f.invoiceId && UUID_RE.test(f.invoiceId) ? f.invoiceId : null, !!f.open],
  );
  return rows.map((r) => ({
    ...r, total_minor: Number(r.total_minor), tax_minor: Number(r.tax_minor), refunded_at: r.refunded_at ? fmtDate(r.refunded_at) : null,
    // What is still to be done with it: refund it, or wait for the next invoice.
    pending: r.status === 'issued' && ((r.settlement === 'refund' && !r.refunded_at) || (r.settlement === 'next_invoice' && !r.applied_invoice)),
  }));
}

export async function markRefunded(orgId: string, id: string, b: any) {
  const c = await creditRow(orgId, id);
  if (c.status !== 'issued') throw new FleetBillingError(409, 'The credit note is void.');
  if (c.settlement !== 'refund') throw new FleetBillingError(409, 'This credit note is not refunded: it is settled on an invoice.');
  if (c.refunded_at) throw new FleetBillingError(409, 'Already recorded as refunded.');
  const at = b?.refundedAt ? String(b.refundedAt) : todayLocal();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) throw new FleetBillingError(422, 'refundedAt is a date (YYYY-MM-DD).');
  await query(`UPDATE fleet_credit_note SET refunded_at = $2, refund_reference = $3 WHERE id = $1`, [id, at, b?.reference ? String(b.reference).slice(0, 200) : null]);
  return getCreditNote(orgId, id);
}

/** Void a credit note issued in error, while nothing has been done with it yet. */
export async function voidCreditNote(orgId: string, id: string, reason: string) {
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw new FleetBillingError(422, 'Give the reason for voiding.');
  return tx(async () => {
    await query(`SELECT pg_advisory_xact_lock(hashtextextended('fleet-invoice:' || $1::text, 0))`, [orgId]);
    const c = await creditRow(orgId, id);
    if (c.status === 'void') throw new FleetBillingError(409, 'Already void.');
    if (c.refunded_at) throw new FleetBillingError(409, 'It has been refunded; issue an invoice for the amount instead.');
    if (c.applied_invoice_id) throw new FleetBillingError(409, 'It has been deducted from a later invoice; void that invoice first.');
    if (c.settlement === 'invoice') {
      const inv = await invoiceRow(orgId, c.invoice_id);
      if (inv.status === 'paid' && !String(inv.paid_reference ?? '').startsWith(SETTLED_BY)) {
        throw new FleetBillingError(409, 'The invoice has been paid since; the credit cannot be taken back.');
      }
      await query(`UPDATE fleet_invoice SET credited_minor = credited_minor - $2 WHERE id = $1`, [inv.id, Number(c.total_minor)]);
      // It was settled by credit notes alone: owed again.
      if (inv.status === 'paid') {
        await query(`UPDATE fleet_invoice SET status = 'issued', paid_at = NULL, paid_reference = NULL WHERE id = $1`, [inv.id]);
        await query(`UPDATE subscription_charge SET state = 'pending', paid_at = NULL WHERE fleet_invoice_id = $1 AND state = 'paid'`, [inv.id]);
      }
    }
    await query(`UPDATE fleet_credit_note SET status = 'void', voided_at = now(), void_reason = $2 WHERE id = $1`, [id, why.slice(0, 500)]);
    return getCreditNote(orgId, id);
  });
}

/** E-mail the credit note (PDF attached) to the account's billing address, through the e-mail channel. */
export async function sendCreditNote(orgId: string, id: string, pdf: (cn: Awaited<ReturnType<typeof getCreditNote>>) => Buffer, overrideTo?: string) {
  const cn = await getCreditNote(orgId, id);
  if (cn.status === 'void') throw new FleetBillingError(409, 'A void credit note is not sent.');
  const to = String(overrideTo ?? cn.buyer.email ?? '').trim();
  if (!to || !to.split(/[,;]\s*/).every((x) => EMAIL_RE.test(x))) throw new FleetBillingError(422, 'No valid billing e-mail address for this fleet account.');
  const ch = await one<{ enabled: boolean; config: any; secret: string | null }>(`SELECT enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind = 'email'`, [orgId]);
  if (!ch?.enabled || !ch.config?.host) throw new FleetBillingError(409, 'Set up the e-mail channel first (Govern → Alert routing → Channels).');
  let secret: string | null = null;
  try { secret = ch.secret ? unseal(ch.secret) : null; } catch { secret = null; }
  const amount = moneyText(cn.totalMinor, cn.currency);
  const how = cn.settlement === 'invoice' ? `It reduces what is owed on invoice ${cn.invoice.number}.`
    : cn.settlement === 'refund' ? 'We will refund this amount to you.' : 'It will be deducted from your next invoice.';
  const text = `${cn.seller.name}\nCredit note ${cn.number} — credits invoice ${cn.invoice.number}\nFleet: ${cn.buyer.fleetName}\nAmount credited: ${amount}\nReason: ${cn.reason}\n\n${how}\n\nThe credit note is attached.`;
  const res = await sendEmail(ch.config, secret, to, {
    subject: `Credit note ${cn.number} — ${cn.buyer.fleetName} — invoice ${cn.invoice.number}`,
    text, html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`,
    kind: 'fleet-credit-note',
    attachments: [{ filename: `${cn.number.replace(/[^\w.-]+/g, '_')}.pdf`, content: pdf(cn), contentType: 'application/pdf' }],
  });
  if (!res.ok) throw new FleetBillingError(502, `The e-mail was not sent: ${res.error ?? 'failed'}`);
  await query(`UPDATE fleet_credit_note SET sent_at = now(), sent_to = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, to.slice(0, 300)]);
  return { ok: true, to, reference: res.ref ?? null };
}
