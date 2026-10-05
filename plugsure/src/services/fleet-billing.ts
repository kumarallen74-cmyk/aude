import { one, many, query, tx } from '../db/pool.js';
import { upgradeLegacyKeys, isCurrency, currencyOr, formatMoney, moneyText, LEGACY_CURRENCY, CURRENCY_CODES, type CurrencyCode } from '../domain/money.js';
import { countryOfCurrency } from '../domain/country.js';
import { LOCALE_TAG } from '../domain/locale.js';
import { resolveTaxContext } from './tax/index.js';
import { config } from '../config.js';
import { billingZone, todayIn } from './org-timezone.js';
import { unseal } from './secrets.js';
import { sendEmail } from './notify-transports.js';
import { PERIOD_RE, currentPeriod } from './commission.js';
import { computeFleetStatement, splitFees, type FeeLine, type FleetSession, type FleetRoaming, type TaxCfg, type InvoiceTax, extractInclusiveTax } from './fleet-calc.js';
import { efakturXml, fakturDate, settingsProblem, buyerProblem, feeItemProblem, normaliseNpwp, nitkuFor, type EfakturSettings, type EfakturInvoice } from './efaktur.js';
import { membershipFeesFor } from './benefits.js';

/**
 * Fleet billing: the companies fleet cards are billed to (fleet accounts), their
 * monthly statements, the invoices issued from them, and the e-Faktur export.
 *
 * Which month a session belongs to: the month its charge record was issued, in
 * BILLING_TIMEZONE, as for commission statements; a partner network's charge
 * record belongs to the month it was received.
 *
 * Which account a session belongs to: the fleet its card was on WHEN THE SESSION
 * STARTED (charging_session.fleet_account_id, captured by a database trigger,
 * migration 051), and for a partner's charge record the card's fleet when the
 * record was received. Billing by the card's current fleet put a card's past,
 * not yet invoiced sessions on the invoice of whichever account it was moved to.
 *
 * An invoice can be issued only for a month that has ended, and freezes what it
 * bills: each session or record is on at most one live invoice (voiding releases
 * them for a new one).
 */

export class FleetBillingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TAX: () => TaxCfg = () => ({ ppnRateBps: config.tax.id.ppnRateBps, dppNum: config.tax.id.ppnDppNumerator, dppDen: config.tax.id.ppnDppDenominator });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
export const monthName = (period: string) => { const [y, m] = period.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };
const bulan = (period: string) => { const [y, m] = period.split('-'); return `${BULAN[Number(m) - 1]} ${y}`; };

function mustPeriod(period: string) {
  if (!PERIOD_RE.test(String(period))) throw new FleetBillingError(400, 'period must be YYYY-MM');
}
/** The currency of a statement (one invoice per account, month AND currency); absent = IDR. */
export function mustCurrency(c: unknown): CurrencyCode {
  if (c == null || c === '') return LEGACY_CURRENCY;
  if (!isCurrency(c)) throw new FleetBillingError(400, 'currency must be IDR, MYR or SGD');
  return c;
}
function mustId(id: string, what: string) {
  if (!UUID_RE.test(String(id))) throw new FleetBillingError(404, `${what} not found`);
}
/**
 * [start, end) of a month as timestamps, in the organisation's billing zone for the statement's currency
 * (services/org-timezone.ts: Indonesia and rupiah as v1.6 — BILLING_TIMEZONE; a Singapore invoice in SGT).
 */
async function monthBounds(period: string, orgId: string | null = null, currency: CurrencyCode | null = null): Promise<{ from: Date; to: Date }> {
  const tz = await billingZone(orgId, currency);
  const r = await one<{ from: Date; to: Date }>(
    `SELECT (($1 || '-01')::timestamp AT TIME ZONE $2) AS from, ((($1 || '-01')::date + interval '1 month')::timestamp AT TIME ZONE $2) AS to`,
    [period, tz],
  );
  return r!;
}
export const todayLocal = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// ─────────────────────────────────────────── settings (the seller's side)

export interface InvoiceSettings {
  prefix: string;
  paymentInstructions: string;
  efaktur: Partial<EfakturSettings> & { feeItemOpt?: 'A' | 'B'; feeItemCode?: string; feeUnitCode?: string; confirmed?: boolean; confirmedBy?: string | null; confirmedAt?: string | null };
}

export async function getSettings(orgId: string) {
  const o = await one<{ name: string; npwp: string | null; pkp: boolean; nitku: string | null; billing_address: string | null; invoice_settings: any }>(
    `SELECT name, npwp, pkp, nitku, billing_address, invoice_settings FROM organisation WHERE id = $1`,
    [orgId],
  );
  if (!o) throw new FleetBillingError(404, 'organisation not found');
  const s = (o.invoice_settings ?? {}) as Partial<InvoiceSettings>;
  const settings: InvoiceSettings = {
    prefix: s.prefix || 'FLT',
    paymentInstructions: s.paymentInstructions ?? '',
    efaktur: { itemOpt: 'A', itemCode: '', unitCode: '', feeItemOpt: 'B', feeItemCode: '', feeUnitCode: '', confirmed: false, ...(s.efaktur ?? {}) },
  };
  const seller = { name: o.name, npwp: o.npwp, nitku: o.nitku, address: o.billing_address, pkp: o.pkp };
  return { seller, settings, efakturReady: settingsProblem(settings.efaktur, seller) };
}

export async function saveSettings(orgId: string, b: any, actor: string) {
  const cur = await getSettings(orgId);
  const npwp = b.npwp === undefined ? cur.seller.npwp : String(b.npwp ?? '').trim() || null;
  if (npwp && !normaliseNpwp(npwp)) throw new FleetBillingError(422, 'NPWP must have 15 or 16 digits.');
  const nitku = b.nitku === undefined ? cur.seller.nitku : String(b.nitku ?? '').replace(/\D/g, '') || null;
  if (nitku && nitku.length !== 22) throw new FleetBillingError(422, 'NITKU must have 22 digits.');
  const prefix = b.prefix === undefined ? cur.settings.prefix : String(b.prefix ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,12}$/.test(prefix)) throw new FleetBillingError(422, 'The invoice number prefix is 2–12 letters, digits or dashes.');
  const ef = { ...cur.settings.efaktur, ...(b.efaktur ?? {}) };
  if (ef.itemOpt !== 'A' && ef.itemOpt !== 'B') throw new FleetBillingError(422, 'e-Faktur item type is A (goods) or B (services).');
  if (ef.itemCode && !/^\d{6}$/.test(String(ef.itemCode))) throw new FleetBillingError(422, 'The e-Faktur goods/service code has 6 digits.');
  if (ef.unitCode && !/^UM\.\d{4}$/.test(String(ef.unitCode))) throw new FleetBillingError(422, 'The unit code looks like UM.0000.');
  if (ef.feeItemOpt && ef.feeItemOpt !== 'A' && ef.feeItemOpt !== 'B') throw new FleetBillingError(422, 'Membership fee item type is A or B.');
  if (ef.feeItemCode && !/^\d{6}$/.test(String(ef.feeItemCode))) throw new FleetBillingError(422, 'The membership fee code has 6 digits.');
  if (ef.feeUnitCode && !/^UM\.\d{4}$/.test(String(ef.feeUnitCode))) throw new FleetBillingError(422, 'The membership fee unit code looks like UM.0000.');
  // Changing what goes on the faktur un-confirms it.
  const changed = ['itemOpt', 'itemCode', 'unitCode', 'feeItemOpt', 'feeItemCode', 'feeUnitCode'].some((k) => (b.efaktur ?? {})[k] !== undefined && (b.efaktur ?? {})[k] !== (cur.settings.efaktur as any)[k]);
  const confirmed = b.efaktur?.confirmed === true && !!ef.itemCode && !!ef.unitCode ? true : changed ? false : !!cur.settings.efaktur.confirmed && b.efaktur?.confirmed !== false;
  const settings: InvoiceSettings = {
    prefix,
    paymentInstructions: b.paymentInstructions === undefined ? cur.settings.paymentInstructions : String(b.paymentInstructions ?? '').slice(0, 1000),
    efaktur: {
      itemOpt: ef.itemOpt, itemCode: String(ef.itemCode ?? ''), unitCode: String(ef.unitCode ?? ''),
      feeItemOpt: ef.feeItemOpt ?? 'B', feeItemCode: String(ef.feeItemCode ?? ''), feeUnitCode: String(ef.feeUnitCode ?? ''), confirmed,
      confirmedBy: confirmed ? (cur.settings.efaktur.confirmed && !changed ? cur.settings.efaktur.confirmedBy ?? actor : actor) : null,
      confirmedAt: confirmed ? (cur.settings.efaktur.confirmed && !changed ? cur.settings.efaktur.confirmedAt ?? new Date().toISOString() : new Date().toISOString()) : null,
    },
  };
  await query(
    `UPDATE organisation SET npwp = $2, nitku = $3, billing_address = $4, invoice_settings = $5 WHERE id = $1`,
    [orgId, npwp ? normaliseNpwp(npwp) : null, nitku,
     b.address === undefined ? cur.seller.address : String(b.address ?? '').trim().slice(0, 500) || null, JSON.stringify(settings)],
  );
  return getSettings(orgId);
}

// ─────────────────────────────────────────── fleet accounts

const ACCOUNT_COLS = `a.id, a.name, a.legal_name, a.tax_id, a.tax_id_kind, a.nitku, a.address, a.billing_email, a.contact_name, a.phone,
  a.payment_terms_days, a.include_roaming, a.notes, a.v2x_allowed, a.v2x_min_soc_percent, a.archived_at, a.created_at, a.updated_at`;

export async function listAccounts(orgId: string, includeArchived = false) {
  return many(
    `SELECT ${ACCOUNT_COLS},
            (SELECT count(*)::int FROM token t WHERE t.fleet_account_id = a.id) AS cards,
            (SELECT count(*)::int FROM fleet_invoice i WHERE i.fleet_account_id = a.id AND i.status = 'issued') AS open_invoices,
            -- What is owed, per currency (never added across currencies); outstanding_minor is the rupiah figure (v1.6).
            (SELECT COALESCE(sum(GREATEST(0, i.total_minor - i.credited_minor - i.prior_credit_minor)), 0)::bigint FROM fleet_invoice i WHERE i.fleet_account_id = a.id AND i.status = 'issued' AND i.currency = $3) AS outstanding_minor,
            (SELECT COALESCE(jsonb_object_agg(x.currency, x.owed), '{}'::jsonb) FROM (
               SELECT i.currency, sum(GREATEST(0, i.total_minor - i.credited_minor - i.prior_credit_minor))::bigint AS owed
                 FROM fleet_invoice i WHERE i.fleet_account_id = a.id AND i.status = 'issued' GROUP BY i.currency) x) AS outstanding_by_currency,
            (SELECT count(*)::int FROM user_role ur WHERE ur.scope_type = 'fleet' AND ur.scope_id = a.id) AS portal_users
       FROM fleet_account a
      WHERE a.org_id = $1 AND ($2 OR a.archived_at IS NULL)
      ORDER BY a.name`,
    [orgId, includeArchived, LEGACY_CURRENCY],
  );
}

export async function getAccount(orgId: string, id: string) {
  mustId(id, 'fleet account');
  const a = await one<any>(`SELECT ${ACCOUNT_COLS} FROM fleet_account a WHERE a.id = $1 AND a.org_id = $2`, [id, orgId]);
  if (!a) throw new FleetBillingError(404, 'fleet account not found');
  const cards = await many(
    `SELECT id, uid, holder_name, status, account_type, (customer_blocked_at IS NOT NULL AND status = 'Blocked') AS blocked_by_customer
       FROM token WHERE fleet_account_id = $1 ORDER BY uid`,
    [id],
  );
  // The customer's own staff with portal access (role fleet_customer on this account).
  const portalUsers = await many(
    `SELECT u.id, u.name, u.email, u.status, u.last_login_at, u.must_change_password
       FROM user_role ur JOIN app_user u ON u.id = ur.user_id
      WHERE ur.scope_type = 'fleet' AND ur.scope_id = $1 AND u.org_id = $2 ORDER BY u.name`,
    [id, orgId],
  );
  return { ...a, cards, portalUsers };
}

function accountInput(b: any, creating: boolean) {
  const out: Record<string, unknown> = {};
  const str = (v: unknown, max = 300) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
  if (creating || b.name !== undefined) {
    const name = str(b.name, 200);
    if (!name) throw new FleetBillingError(422, 'Enter the fleet name (as used on its cards).');
    out.name = name;
  }
  if (b.legalName !== undefined) out.legal_name = str(b.legalName, 200);
  if (b.taxIdKind !== undefined) {
    if (!['TIN', 'NIK', 'Passport', 'Other'].includes(b.taxIdKind)) throw new FleetBillingError(422, 'Tax ID type is TIN (NPWP), NIK, Passport or Other.');
    out.tax_id_kind = b.taxIdKind;
  }
  if (b.taxId !== undefined) {
    const raw = str(b.taxId, 40);
    const kind = (b.taxIdKind ?? 'TIN') as string;
    if (raw && kind === 'TIN' && !normaliseNpwp(raw)) throw new FleetBillingError(422, 'NPWP must have 15 or 16 digits.');
    if (raw && kind === 'NIK' && !/^\d{16}$/.test(raw.replace(/\D/g, ''))) throw new FleetBillingError(422, 'NIK has 16 digits.');
    out.tax_id = raw ? (kind === 'TIN' ? normaliseNpwp(raw) : raw.replace(/\s/g, '')) : null;
  }
  if (b.nitku !== undefined) {
    const d = String(b.nitku ?? '').replace(/\D/g, '');
    if (d && d.length !== 22) throw new FleetBillingError(422, 'NITKU has 22 digits (leave empty for the head office).');
    out.nitku = d || null;
  }
  if (b.address !== undefined) out.address = str(b.address, 500);
  if (b.billingEmail !== undefined) {
    const e = str(b.billingEmail, 200);
    if (e && !e.split(/[,;]\s*/).every((x) => EMAIL_RE.test(x))) throw new FleetBillingError(422, 'Enter valid billing e-mail address(es), separated by commas.');
    out.billing_email = e;
  }
  if (b.contactName !== undefined) out.contact_name = str(b.contactName, 200);
  if (b.phone !== undefined) out.phone = str(b.phone, 40);
  if (b.paymentTermsDays !== undefined) {
    const d = Number(b.paymentTermsDays);
    if (!Number.isInteger(d) || d < 0 || d > 120) throw new FleetBillingError(422, 'Payment terms are 0–120 days.');
    out.payment_terms_days = d;
  }
  if (b.includeRoaming !== undefined) out.include_roaming = Boolean(b.includeRoaming);
  // Standing consent for the fleet's cars to give energy back where a site has a programme (services/v2x.ts).
  if (b.v2xAllowed !== undefined) out.v2x_allowed = Boolean(b.v2xAllowed);
  if (b.v2xMinSocPercent !== undefined && b.v2xMinSocPercent !== null && b.v2xMinSocPercent !== '') {
    const p = Number(b.v2xMinSocPercent);
    if (!Number.isInteger(p) || p < 10 || p > 95) throw new FleetBillingError(422, 'Battery floor for giving energy back: 10% to 95%.');
    out.v2x_min_soc_percent = p;
  }
  if (b.notes !== undefined) out.notes = str(b.notes, 1000);
  return out;
}

export async function createAccount(orgId: string, b: any) {
  const v = accountInput(b, true);
  const cols = Object.keys(v);
  try {
    const r = await one<{ id: string }>(
      `INSERT INTO fleet_account (org_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [orgId, ...cols.map((c) => v[c])],
    );
    return getAccount(orgId, r!.id);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new FleetBillingError(409, 'A fleet account with that name already exists.');
    throw e;
  }
}

export async function updateAccount(orgId: string, id: string, b: any) {
  const before = await getAccount(orgId, id);
  const v = accountInput(b, false);
  const cols = Object.keys(v);
  if (cols.length) {
    try {
      await query(
        `UPDATE fleet_account SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = now() WHERE id = $1 AND org_id = $2`,
        [id, orgId, ...cols.map((c) => v[c])],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new FleetBillingError(409, 'A fleet account with that name already exists.');
      throw e;
    }
    // Cards show the fleet's name in the RFID centre: keep it in step.
    if (v.name && v.name !== before.name) await query(`UPDATE token SET fleet_name = $2 WHERE fleet_account_id = $1`, [id, v.name]);
  }
  return getAccount(orgId, id);
}

export async function archiveAccount(orgId: string, id: string, archived: boolean) {
  await getAccount(orgId, id);
  await query(`UPDATE fleet_account SET archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, archived]);
  return getAccount(orgId, id);
}

/** Put cards on this account (by UID), making them fleet cards of this fleet. */
export async function assignCards(orgId: string, id: string, uids: string[], remove: string[] = []) {
  const a = await getAccount(orgId, id);
  const add = [...new Set(uids.map((u) => String(u).trim()).filter(Boolean))];
  const unknown: string[] = [];
  for (const uid of add) {
    const r = await query(
      `UPDATE token SET fleet_account_id = $2, fleet_name = $3, account_type = 'fleet', updated_at = now()
        WHERE org_id = $1 AND uid = $4 AND kind = 'rfid'`,
      [orgId, id, a.name, uid],
    );
    if (!r.rowCount) unknown.push(uid);
  }
  for (const uid of remove.map((u) => String(u).trim()).filter(Boolean)) {
    await query(`UPDATE token SET fleet_account_id = NULL, fleet_name = NULL, updated_at = now() WHERE org_id = $1 AND uid = $2 AND fleet_account_id = $3`, [orgId, uid, id]);
  }
  return { account: await getAccount(orgId, id), unknown };
}

// ─────────────────────────────────────────── the month

async function loadMonth(orgId: string, accountId: string, period: string, currency: CurrencyCode = LEGACY_CURRENCY) {
  const { from, to } = await monthBounds(period, orgId, currency);
  // The session's own fleet (at its start), not the card's fleet today.
  const sessions = await many<any>(
    `SELECT cs.id, cs.started_at, cs.ended_at, cs.site_id, s.name AS site_name, cp.ocpp_identity, t.uid, t.holder_name,
            cs.energy_wh, d.subtotal_minor, d.local_tax_minor, d.tax_base_minor, d.tax_rate_bps, d.tax_minor, d.total_minor
       FROM cdr d
       JOIN charging_session cs ON cs.id = d.session_id
       JOIN token t ON t.id = cs.token_id
       JOIN site s ON s.id = cs.site_id
       JOIN charge_point cp ON cp.id = cs.charge_point_id
      WHERE d.org_id = $1 AND cs.fleet_account_id = $2 AND d.issued_at >= $3 AND d.issued_at < $4
        AND COALESCE(cs.payment_mode, '') <> 'prepurchase' AND d.currency = $5
        AND NOT EXISTS (SELECT 1 FROM fleet_invoice_item i WHERE i.kind = 'session' AND i.ref_id = cs.id)
      ORDER BY cs.started_at`,
    [orgId, accountId, from, to, currency],
  );
  const roaming = await many<any>(
    `SELECT r.id, p.name AS operator, r.data->'cdr_location'->>'name' AS location, t.uid, r.start_date_time, r.end_date_time,
            r.total_energy, r.total_excl_vat, r.total_incl_vat, r.currency
       FROM ocpi_remote_cdr r
       JOIN token t ON t.id = r.token_id
       JOIN ocpi_partner p ON p.id = r.partner_id
      WHERE r.org_id = $1 AND r.fleet_account_id = $2
        -- Only accepted partner records are billed; one held for review counts from
        -- the month an operator accepted it (its own month may be invoiced by then).
        AND r.status = 'accepted'
        AND COALESCE(r.reviewed_at, r.received_at) >= $3 AND COALESCE(r.reviewed_at, r.received_at) < $4
        AND r.currency = $5
        AND NOT EXISTS (SELECT 1 FROM fleet_invoice_item i WHERE i.kind = 'roaming' AND i.ref_id = r.id)
      ORDER BY r.start_date_time`,
    [orgId, accountId, from, to, currency],
  );
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    sessions: sessions.map((r): FleetSession => ({
      id: r.id, startedAt: iso(r.started_at)!, endedAt: iso(r.ended_at), siteId: r.site_id, siteName: r.site_name,
      ocppIdentity: r.ocpp_identity, cardUid: r.uid, holder: r.holder_name, energyWh: Number(r.energy_wh),
      subtotalMinor: r.subtotal_minor, localTaxMinor: r.local_tax_minor, taxBaseMinor: r.tax_base_minor, ppnRateBps: r.tax_rate_bps, taxMinor: r.tax_minor, totalMinor: r.total_minor,
    })),
    roaming: roaming.map((r): FleetRoaming => ({
      id: r.id, operator: r.operator, location: r.location, cardUid: r.uid, startedAt: iso(r.start_date_time)!, endedAt: iso(r.end_date_time)!,
      energyKwh: Number(r.total_energy), exclVat: Number(r.total_excl_vat), inclVat: r.total_incl_vat == null ? null : Number(r.total_incl_vat), currency: r.currency,
    })),
  };
}

/**
 * Reservation fees for the month: connectors held in the driver app with this fleet's
 * cards (the fee was set on the site; waived ones — refused by the charger, or
 * cancelled at once — are not here). Counted in the month the connector was held.
 */
async function reservationFeesFor(orgId: string, accountId: string, from: Date, to: Date, currency: CurrencyCode = LEGACY_CURRENCY): Promise<FeeLine[]> {
  const rows = await many<any>(
    `SELECT r.id, r.held_at, r.expires_at, r.fee_minor, r.fee_tax_base_minor, r.fee_tax_minor, r.fee_total_minor, s.name AS site_name, t.uid
       FROM driver_reservation r
       JOIN charge_point cp ON cp.id = r.charge_point_id
       JOIN site s ON s.id = cp.site_id
       JOIN token t ON t.id = r.token_id
      WHERE r.org_id = $1 AND r.fleet_account_id = $2 AND r.fee_state = 'invoice' AND r.held_at >= $3 AND r.held_at < $4
        AND r.currency = $5
        AND NOT EXISTS (SELECT 1 FROM fleet_invoice_item i WHERE i.kind = 'reservation' AND i.ref_id = r.id)
      ORDER BY r.held_at`,
    [orgId, accountId, from, to, currency],
  );
  return rows.map((r) => ({
    kind: 'reservation' as const, reservationId: r.id, subscriptionId: '', planName: r.site_name, subscriber: r.uid,
    feeMinor: r.fee_minor, taxableMinor: r.fee_tax_minor > 0 ? r.fee_minor : 0, taxBaseMinor: r.fee_tax_base_minor, taxMinor: r.fee_tax_minor, totalMinor: r.fee_total_minor,
    periodStart: new Date(r.held_at).toISOString(), periodEnd: new Date(r.expires_at).toISOString(),
  }));
}
function buyerOf(a: any) {
  return {
    name: a.legal_name || a.name, fleetName: a.name, taxId: a.tax_id, taxIdKind: a.tax_id_kind, nitku: a.nitku,
    address: a.address, email: a.billing_email, contact: a.contact_name, termsDays: a.payment_terms_days,
  };
}

/** A month for one account: the live invoice if there is one, else a draft of what is not yet invoiced. */
export async function statementFor(orgId: string, accountId: string, period: string, currencyIn?: unknown) {
  mustPeriod(period);
  const currency = mustCurrency(currencyIn);
  const a = await getAccount(orgId, accountId);
  const inv = await one<any>(
    `SELECT * FROM fleet_invoice WHERE fleet_account_id = $1 AND period = ($2 || '-01')::date AND status <> 'void' AND currency = $3`,
    [accountId, period, currency],
  );
  if (inv) return withCredits(inv);
  return draftFor(orgId, a, period, currency);
}

/**
 * The tax of a statement in a currency: IDR the Indonesian PPN/DPP per invoice line (v1.6);
 * ringgit / Singapore dollars the engine of the operator's registration in that country,
 * extracted from each invoice line's gross (fleet-calc.ts extractInclusiveTax).
 */
async function invoiceTaxFor(orgId: string, currency: CurrencyCode, period: string): Promise<{ invoiceTax?: InvoiceTax; scheme: string; rateBps: number; registrationNo: string | null }> {
  if (currency === LEGACY_CURRENCY) return { scheme: 'ID_PPN_PBJT', rateBps: config.tax.id.ppnRateBps, registrationNo: null };
  const c = countryOfCurrency(currency)!;
  const { to } = await monthBounds(period, orgId, currency);
  const ctx = await resolveTaxContext({ orgId, country: c.code, at: new Date(to.getTime() - 1), timezone: c.timezones[0] });
  return {
    // Extracted from the receipts' gross (fleet-calc.ts extractInclusiveTax): never more than the prices shown.
    invoiceTax: extractInclusiveTax(ctx.scheme === 'NONE' ? 0 : ctx.rateBps),
    scheme: ctx.scheme, rateBps: ctx.scheme === 'NONE' ? 0 : ctx.rateBps, registrationNo: ctx.registrationNo,
  };
}

async function draftFor(orgId: string, a: any, period: string, currency: CurrencyCode = LEGACY_CURRENCY) {
  const { seller, settings } = await getSettings(orgId);
  const m = await loadMonth(orgId, a.id, period, currency);
  const { from, to } = await monthBounds(period, orgId, currency);
  // Memberships, and connector reservations made with the fleet's cards in the driver app.
  const fees = [...(await membershipFeesFor(orgId, a.id, from, to, currency)), ...(await reservationFeesFor(orgId, a.id, from, to, currency))];
  const tax = await invoiceTaxFor(orgId, currency, period);
  const calc = computeFleetStatement(m.sessions, m.roaming, { includeRoaming: a.include_roaming, cfg: TAX(), fees, currency, invoiceTax: tax.invoiceTax });
  const warnings = [...calc.warnings];
  if (currency === LEGACY_CURRENCY) {
    if (!seller.pkp && calc.totals.taxMinor > 0) warnings.push('Sessions carry PPN but your organisation is not marked PKP.');
    if (seller.pkp && calc.totals.taxMinor > 0 && buyerProblem({ taxId: a.tax_id, kind: a.tax_id_kind, nitku: a.nitku, name: '', address: null, email: null })) {
      warnings.push('The fleet account has no NPWP/NIK: a faktur pajak cannot be prepared for it.');
    }
  }
  if (!a.billing_email) warnings.push('No billing e-mail: the invoice cannot be e-mailed.');
  return {
    status: 'draft' as const, number: null, id: null, period, periodLabel: monthName(period),
    ended: period < currentPeriod(),
    account: { id: a.id, name: a.name }, buyer: buyerOf(a), seller, paymentInstructions: settings.paymentInstructions,
    ...calc, warnings,
    // Outside Indonesia: the tax scheme the invoice was taxed with (frozen with the invoice).
    ...(currency === LEGACY_CURRENCY ? {} : { taxScheme: tax.scheme, taxRateBps: tax.rateBps, taxRegistrationNo: tax.registrationNo }),
  };
}

/** The currencies an account has anything in for a month (sessions, partner records, fees), IDR first. */
export async function currenciesFor(orgId: string, accountId: string, period: string): Promise<CurrencyCode[]> {
  // Each currency's month is in its own zone (monthBounds): look a day wider than the home zone's month, so a
  // currency whose month starts or ends earlier is still found (its statement then takes exactly its own month).
  const b = await monthBounds(period, orgId);
  const from = new Date(b.from.getTime() - 86_400_000), to = new Date(b.to.getTime() + 86_400_000);
  const rows = await many<{ c: string }>(
    `SELECT DISTINCT d.currency AS c FROM cdr d JOIN charging_session cs ON cs.id = d.session_id
      WHERE d.org_id = $1 AND cs.fleet_account_id = $2 AND d.issued_at >= $3 AND d.issued_at < $4
     UNION SELECT DISTINCT r.currency FROM ocpi_remote_cdr r
      WHERE r.org_id = $1 AND r.fleet_account_id = $2 AND r.status = 'accepted' AND COALESCE(r.reviewed_at, r.received_at) >= $3 AND COALESCE(r.reviewed_at, r.received_at) < $4
     UNION SELECT DISTINCT r.currency FROM driver_reservation r WHERE r.org_id = $1 AND r.fleet_account_id = $2 AND r.fee_state = 'invoice' AND r.held_at >= $3 AND r.held_at < $4
     UNION SELECT DISTINCT p.currency FROM subscription s JOIN subscription_plan p ON p.id = s.plan_id LEFT JOIN token t ON t.id = s.token_id
      WHERE s.org_id = $1 AND s.billing = 'invoice' AND (s.fleet_account_id = $2 OR t.fleet_account_id = $2) AND p.monthly_fee_minor > 0`,
    [orgId, accountId, from, to],
  );
  const set = new Set(rows.map((r) => r.c).filter(isCurrency));
  return CURRENCY_CODES.filter((c) => c === LEGACY_CURRENCY || set.has(c));
}

/** What is still owed on an invoice: its total less credit notes against it and earlier credits deducted from it. */
export const balanceOf = (inv: { status: string; total_minor: unknown; credited_minor?: unknown; prior_credit_minor?: unknown }) =>
  inv.status === 'issued' ? Math.max(0, Number(inv.total_minor) - Number(inv.credited_minor ?? 0) - Number(inv.prior_credit_minor ?? 0)) : 0;

function frozen(inv: any) {
  return {
    ...upgradeLegacyKeys(inv.data),
    creditedMinor: Number(inv.credited_minor ?? 0), priorCreditMinor: Number(inv.prior_credit_minor ?? 0), balanceMinor: balanceOf(inv),
    status: inv.status, id: inv.id, number: inv.number, issuedAt: inv.issued_at, dueDate: fmtDate(inv.due_date),
    paidAt: inv.paid_at ? fmtDate(inv.paid_at) : null, paidReference: inv.paid_reference,
    voidedAt: inv.voided_at, voidReason: inv.void_reason, efakturExportedAt: inv.efaktur_exported_at, efakturNumber: inv.efaktur_number,
    sentAt: inv.sent_at, sentTo: inv.sent_to,
  };
}
/** A stored invoice with the credit notes issued against it (for the documents and the console). */
async function withCredits(inv: any) {
  const creditNotes = await many<any>(
    `SELECT id, number, status, settlement, reason, total_minor, tax_minor, issued_at, refunded_at, applied_invoice_id
       FROM fleet_credit_note WHERE invoice_id = $1 ORDER BY issued_at`, [inv.id]);
  return {
    ...frozen(inv),
    creditNotes: creditNotes.map((c) => ({
      id: c.id, number: c.number, status: c.status, settlement: c.settlement, reason: c.reason, totalMinor: Number(c.total_minor),
      taxMinor: Number(c.tax_minor), issuedAt: c.issued_at, refundedAt: c.refunded_at ? fmtDate(c.refunded_at) : null, applied: !!c.applied_invoice_id,
    })),
  };
}
export const fmtDate = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10));

/** The month for every account with something to bill or already billed. */
export async function periodOverview(orgId: string, period: string) {
  mustPeriod(period);
  const accounts = await many<any>(`SELECT ${ACCOUNT_COLS} FROM fleet_account a WHERE a.org_id = $1 ORDER BY a.name`, [orgId]);
  const invoices = await many<any>(
    `SELECT * FROM fleet_invoice WHERE org_id = $1 AND period = ($2 || '-01')::date ORDER BY issued_at`,
    [orgId, period],
  );
  const rows = [];
  // One row per account AND currency: a fleet charging in Indonesia and Malaysia gets a rupiah and a ringgit invoice.
  for (const a of accounts) for (const currency of await currenciesFor(orgId, a.id, period)) {
    const live = invoices.find((i) => i.fleet_account_id === a.id && i.status !== 'void' && i.currency === currency);
    const voided = invoices.filter((i) => i.fleet_account_id === a.id && i.status === 'void' && i.currency === currency).length;
    if (live) {
      rows.push({
        accountId: a.id, name: a.name, legalName: a.legal_name, currency, status: live.status, invoiceId: live.id, number: live.number,
        sessions: live.sessions, energyWh: Number(live.energy_wh), taxMinor: Number(live.tax_minor), roamingMinor: Number(live.roaming_total_minor),
        totalMinor: Number(live.total_minor), balanceMinor: balanceOf(live), dueDate: fmtDate(live.due_date),
        overdue: live.status === 'issued' && balanceOf(live) > 0 && fmtDate(live.due_date) < todayLocal(),
        efakturExported: !!live.efaktur_exported_at, efakturNumber: live.efaktur_number, sent: !!live.sent_at, voided, warnings: 0,
      });
      continue;
    }
    if (a.archived_at) continue;
    const d = await draftFor(orgId, a, period, currency);
    if (!d.totals.sessions && !d.totals.roamingSessions && !d.fees.length) continue;
    rows.push({
      accountId: a.id, name: a.name, legalName: a.legal_name, currency, status: 'draft', invoiceId: null, number: null,
      sessions: d.totals.sessions, energyWh: d.totals.energyWh, taxMinor: d.totals.taxMinor, roamingMinor: d.totals.roamingMinor,
      totalMinor: d.totals.totalMinor, dueDate: null, overdue: false, efakturExported: false, efakturNumber: null, sent: false, voided, warnings: d.warnings.length,
    });
  }
  const unassigned = await unassignedFleetSessions(orgId, period);
  return { period, periodLabel: monthName(period), current: currentPeriod(), ended: period < currentPeriod(), rows, unassigned };
}

/**
 * Fleet-card sessions this month that ran while their card was on no fleet
 * account (so they are on no invoice — putting the card on an account later
 * does not bill its earlier sessions).
 */
async function unassignedFleetSessions(orgId: string, period: string) {
  const { from, to } = await monthBounds(period, orgId);
  const rows = await many<{ n: number; total: number; currency: string }>(
    `SELECT count(*)::int AS n, COALESCE(sum(d.total_minor), 0)::bigint AS total, d.currency
       FROM cdr d JOIN charging_session cs ON cs.id = d.session_id JOIN token t ON t.id = cs.token_id
      WHERE d.org_id = $1 AND t.account_type = 'fleet' AND cs.fleet_account_id IS NULL
        AND d.issued_at >= $2 AND d.issued_at < $3 AND COALESCE(cs.payment_mode, '') <> 'prepurchase'
      GROUP BY d.currency ORDER BY d.currency = $4 DESC, d.currency`,
    [orgId, from, to, LEGACY_CURRENCY],
  );
  // The rupiah figure as before; other currencies listed beside it (never added up: no FX).
  const idr = rows.find((r) => r.currency === LEGACY_CURRENCY);
  return {
    sessions: rows.reduce((a, r) => a + r.n, 0), totalMinor: Number(idr?.total ?? 0),
    byCurrency: rows.map((r) => ({ currency: r.currency, sessions: r.n, totalMinor: Number(r.total) })),
  };
}

// ─────────────────────────────────────────── invoices

export async function issueInvoice(orgId: string, accountId: string, period: string, actor: string, currencyIn?: unknown) {
  mustPeriod(period);
  const currency = mustCurrency(currencyIn);
  if (period >= currentPeriod()) throw new FleetBillingError(409, 'Only a month that has ended can be invoiced.');
  return tx(async () => {
    await query(`SELECT pg_advisory_xact_lock(hashtextextended('fleet-invoice:' || $1::text, 0))`, [orgId]);
    const a = await getAccount(orgId, accountId);
    if (a.archived_at) throw new FleetBillingError(409, 'The fleet account is archived.');
    const live = await one(`SELECT number FROM fleet_invoice WHERE fleet_account_id = $1 AND period = ($2 || '-01')::date AND status <> 'void' AND currency = $3`, [accountId, period, currency]);
    if (live) throw new FleetBillingError(409, `Already invoiced (${(live as any).number}).`);
    const st = await draftFor(orgId, a, period, currency);
    if (!st.totals.sessions && !st.totals.roamingSessions && !st.fees.length) throw new FleetBillingError(409, 'Nothing to invoice for this month.');
    const { settings } = await getSettings(orgId);
    const issued = todayIn(await billingZone(orgId, currency));
    const [y, mo] = issued.split('-');
    const stem = `${settings.prefix}/${y}/${mo}/`;
    const last = await one<{ seq: number }>(
      `SELECT COALESCE(max(split_part(number, '/', 4)::int), 0) AS seq FROM fleet_invoice
        WHERE org_id = $1 AND number LIKE $2 || '%' AND split_part(number, '/', 4) ~ '^[0-9]+$'`,
      [orgId, `${settings.prefix}/${y}/`],
    );
    const number = `${stem}${String((last?.seq ?? 0) + 1).padStart(4, '0')}`;
    const due = new Date(`${issued}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + a.payment_terms_days);
    // Credit notes on earlier (paid) invoices that are to be deducted from the next one: whole notes, while they fit.
    const open = await many<{ id: string; number: string; total_minor: string; invoice_number: string }>(
      `SELECT c.id, c.number, c.total_minor, i.number AS invoice_number FROM fleet_credit_note c JOIN fleet_invoice i ON i.id = c.invoice_id
        WHERE c.fleet_account_id = $1 AND c.org_id = $2 AND c.status = 'issued' AND c.settlement = 'next_invoice' AND c.applied_invoice_id IS NULL
          AND c.currency = $3
        ORDER BY c.issued_at FOR UPDATE OF c`, [accountId, orgId, currency]);
    const priorCredits: Array<{ id: string; number: string; invoiceNumber: string; totalMinor: number }> = [];
    let room = st.totals.totalMinor;
    for (const c of open) {
      const amt = Number(c.total_minor);
      if (amt > room) continue;
      priorCredits.push({ id: c.id, number: c.number, invoiceNumber: c.invoice_number, totalMinor: amt });
      room -= amt;
    }
    const priorCreditMinor = priorCredits.reduce((a, c) => a + c.totalMinor, 0);
    const data = { ...st, status: 'issued', number, issuedDate: issued, priorCredits };
    const t = st.totals;
    const inv = await one<{ id: string }>(
      `INSERT INTO fleet_invoice (org_id, fleet_account_id, period, number, due_date, sessions, energy_wh, subtotal_minor, local_tax_minor,
                                  taxable_minor, tax_base_minor, tax_minor, own_total_minor, roaming_total_minor, total_minor, data, issued_by, fees_total_minor, prior_credit_minor, currency)
       VALUES ($1,$2,($3 || '-01')::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [orgId, accountId, period, number, due.toISOString().slice(0, 10), t.sessions, t.energyWh, t.subtotalMinor, t.localTaxMinor,
       t.taxableMinor, t.taxBaseMinor, t.taxMinor, t.ownTotalMinor, t.roamingMinor, t.totalMinor, JSON.stringify(data), actor, t.feesMinor, priorCreditMinor, currency],
    );
    if (priorCredits.length) {
      await query(`UPDATE fleet_credit_note SET applied_invoice_id = $1 WHERE id = ANY($2::uuid[])`, [inv!.id, priorCredits.map((c) => c.id)]);
    }
    // Membership fees: one charge per membership and month, owed on this invoice.
    const feeCharges: string[] = [];
    for (const f of st.fees) {
      if (f.kind === 'reservation') continue; // the reservation itself is the invoiced item
      const ch = await one<{ id: string }>(
        `INSERT INTO subscription_charge (subscription_id, org_id, period_start, period_end, fee_minor, tax_base_minor, tax_minor, total_minor, via, fleet_invoice_id, days_billed, days_in_period, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'invoice',$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`,
        [f.subscriptionId, orgId, f.periodStart, f.periodEnd, f.feeMinor, f.taxBaseMinor, f.taxMinor, f.totalMinor, inv!.id, f.days ?? null, f.daysInPeriod ?? null, currency],
      );
      if (!ch) throw new FleetBillingError(409, 'A membership fee was just invoiced elsewhere; try again.');
      feeCharges.push(ch.id);
    }
    const items = [...st.sessions.map((s) => ['session', s.id]), ...st.roaming.map((x) => ['roaming', x.id]), ...feeCharges.map((id) => ['subscription_charge', id]),
      ...st.fees.filter((f) => f.kind === 'reservation').map((f) => ['reservation', f.reservationId!])];
    for (const [kind, ref] of items) {
      const r = await query(
        `INSERT INTO fleet_invoice_item (invoice_id, org_id, kind, ref_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [inv!.id, orgId, kind, ref],
      );
      if (!r.rowCount) throw new FleetBillingError(409, 'Some of these charges were just invoiced elsewhere; try again.');
    }
    return { id: inv!.id, number, currency, totalMinor: t.totalMinor, priorCreditMinor, balanceMinor: t.totalMinor - priorCreditMinor };
  });
}

/** Issue every account's invoice for a month (those with charges and no invoice yet). */
export async function issueAll(orgId: string, period: string, actor: string) {
  const o = await periodOverview(orgId, period);
  const issued: Array<{ accountId: string; number: string; currency: string }> = [];
  const skipped: Array<{ accountId: string; reason: string; currency: string }> = [];
  for (const r of o.rows.filter((x) => x.status === 'draft')) {
    try {
      const inv = await issueInvoice(orgId, r.accountId, period, actor, r.currency);
      issued.push({ accountId: r.accountId, number: inv.number, currency: r.currency });
    } catch (e) {
      skipped.push({ accountId: r.accountId, reason: (e as Error).message, currency: r.currency });
    }
  }
  return { issued, skipped };
}

export async function invoiceRow(orgId: string, id: string) {
  mustId(id, 'invoice');
  const inv = await one<any>(`SELECT * FROM fleet_invoice WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!inv) throw new FleetBillingError(404, 'invoice not found');
  return inv;
}

export async function getInvoice(orgId: string, id: string) {
  return withCredits(await invoiceRow(orgId, id));
}

export async function listInvoices(orgId: string, f: { accountId?: string; status?: string; limit?: number } = {}) {
  const rows = await many<any>(
    `SELECT i.id, i.number, to_char(i.period, 'YYYY-MM') AS period, i.status, i.issued_at, i.due_date, i.sessions, i.energy_wh,
            i.tax_minor, i.roaming_total_minor, i.total_minor, i.credited_minor, i.prior_credit_minor, i.paid_at, i.paid_reference, i.voided_at, i.efaktur_exported_at, i.efaktur_number,
            i.sent_at, i.currency, a.id AS account_id, a.name AS account_name
       FROM fleet_invoice i JOIN fleet_account a ON a.id = i.fleet_account_id
      WHERE i.org_id = $1 AND ($2::uuid IS NULL OR i.fleet_account_id = $2) AND ($3::text IS NULL OR i.status = $3)
      ORDER BY i.issued_at DESC LIMIT $4`,
    [orgId, f.accountId && UUID_RE.test(f.accountId) ? f.accountId : null, f.status || null, Math.min(f.limit ?? 200, 1000)],
  );
  const today = todayLocal();
  return rows.map((r) => ({
    ...r, due_date: fmtDate(r.due_date), paid_at: r.paid_at ? fmtDate(r.paid_at) : null, balance_minor: balanceOf(r),
    overdue: r.status === 'issued' && balanceOf(r) > 0 && fmtDate(r.due_date) < today,
  }));
}

export async function markPaid(orgId: string, id: string, b: any) {
  const inv = await invoiceRow(orgId, id);
  if (inv.status !== 'issued') throw new FleetBillingError(409, `The invoice is ${inv.status}.`);
  const paidAt = b.paidAt ? String(b.paidAt) : todayLocal();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) throw new FleetBillingError(422, 'paidAt is a date (YYYY-MM-DD).');
  await query(`UPDATE fleet_invoice SET status = 'paid', paid_at = $3, paid_reference = $4 WHERE id = $1 AND org_id = $2`,
    [id, orgId, paidAt, b.reference ? String(b.reference).slice(0, 200) : null]);
  await query(`UPDATE subscription_charge SET state = 'paid', paid_at = now() WHERE fleet_invoice_id = $1 AND state = 'pending'`, [id]);
  return getInvoice(orgId, id);
}

/** Void: the invoice keeps its number; its charges are released for a new invoice. */
export async function voidInvoice(orgId: string, id: string, reason: string) {
  const inv = await invoiceRow(orgId, id);
  if (inv.status === 'void') throw new FleetBillingError(409, 'Already void.');
  if (inv.status === 'paid') throw new FleetBillingError(409, 'A paid invoice cannot be voided; issue a credit note instead.');
  const why = String(reason ?? '').trim();
  if (why.length < 3) throw new FleetBillingError(422, 'Give the reason for voiding.');
  const credits = await one<{ n: number }>(`SELECT count(*)::int AS n FROM fleet_credit_note WHERE invoice_id = $1 AND status = 'issued'`, [id]);
  if (credits?.n) throw new FleetBillingError(409, 'This invoice has credit notes: void them first, or credit the rest instead of voiding.');
  await tx(async () => {
    // Earlier credit notes deducted from this invoice go back to wait for the next one.
    await query(`UPDATE fleet_credit_note SET applied_invoice_id = NULL WHERE applied_invoice_id = $1`, [id]);
    await query(`UPDATE fleet_invoice SET status = 'void', voided_at = now(), void_reason = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, why.slice(0, 500)]);
    await query(`DELETE FROM fleet_invoice_item WHERE invoice_id = $1`, [id]);
    // Its membership fees go back to the draft too.
    await query(`UPDATE subscription_charge SET state = 'void' WHERE fleet_invoice_id = $1`, [id]);
  });
  return {
    invoice: await getInvoice(orgId, id),
    fakturWarning: inv.efaktur_exported_at
      ? 'This invoice was exported to e-Faktur: cancel (batal) or replace (pengganti) the faktur pajak in Coretax too.'
      : null,
  };
}

export async function setFakturNumber(orgId: string, id: string, number: string | null) {
  await invoiceRow(orgId, id);
  const n = number == null ? null : String(number).trim().slice(0, 40) || null;
  await query(`UPDATE fleet_invoice SET efaktur_number = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, n]);
  return getInvoice(orgId, id);
}

// ─────────────────────────────────────────── e-Faktur

const lineName = (site: string, period: string, sessions: number, kwh: number) =>
  `Pengisian listrik kendaraan listrik (SPKLU) ${site} — ${bulan(period)} — ${sessions} sesi, ${kwh.toLocaleString(LOCALE_TAG.id, { maximumFractionDigits: 3 })} kWh`;

/**
 * The Coretax import file for a month's invoices: the live ones with PPN not yet
 * exported, or the given ids (exported or not). Importing the same invoice into
 * Coretax twice prepares a second faktur pajak for the same sale, so an invoice
 * already exported is left out (listed as skipped) unless it is asked for by id
 * or with `reexport` (for a file lost before it was imported). Invoices that
 * cannot carry a faktur are listed as skipped.
 */
export async function efakturExport(orgId: string, period: string, ids?: string[], opts: { reexport?: boolean } = {}) {
  mustPeriod(period);
  const { seller, settings, efakturReady } = await getSettings(orgId);
  if (efakturReady) throw new FleetBillingError(409, efakturReady);
  const byId = !!ids?.length;
  const rows = await many<any>(
    `SELECT * FROM fleet_invoice WHERE org_id = $1 AND period = ($2 || '-01')::date AND status <> 'void'
        AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[])) ORDER BY number`,
    [orgId, period, byId ? ids!.filter((i) => UUID_RE.test(i)) : null],
  );
  const invoices: EfakturInvoice[] = [];
  const included: string[] = [];
  const skipped: Array<{ number: string; reason: string }> = [];
  for (const inv of rows) {
    // e-Faktur is Indonesia's (services/einvoice): an invoice in another currency never carries a faktur pajak.
    if (inv.currency !== LEGACY_CURRENCY) {
      if (byId) skipped.push({ number: inv.number, reason: `a ${inv.currency} invoice is not Indonesian: no faktur pajak` });
      continue;
    }
    if (inv.efaktur_exported_at && !byId && !opts.reexport) {
      skipped.push({ number: inv.number, reason: `already exported ${fmtDate(new Date(inv.efaktur_exported_at))} (export it by id, or with reexport=true, to export it again)` });
      continue;
    }
    const d = upgradeLegacyKeys(inv.data);
    const lines = (d.sites as any[]).filter((l) => l.taxableMinor > 0).map((l) => ({
      name: lineName(l.siteName, d.period, l.sessions - l.untaxedSessions, Math.round(l.energyWh) / 1000),
      taxableMinor: l.taxableMinor, taxBaseMinor: l.taxBaseMinor, taxMinor: l.taxMinor,
    }));
    const fees = ((d.fees ?? []) as any[]).filter((f) => f.taxableMinor > 0);
    if (fees.length) {
      const fp = feeItemProblem(settings.efaktur as any);
      if (fp) { skipped.push({ number: inv.number, reason: fp }); continue; }
      const ef = settings.efaktur as any;
      for (const f of fees) {
        lines.push({
          name: f.kind === 'reservation'
            ? `Reservasi konektor ${f.planName} ${String(f.periodStart).slice(0, 10)} (kartu ${f.subscriber})`
            : `Keanggotaan ${f.planName} (${f.subscriber}) — ${bulan(d.period)}`,
          taxableMinor: f.taxableMinor, taxBaseMinor: f.taxBaseMinor, taxMinor: f.taxMinor,
          item: { itemOpt: ef.feeItemOpt, itemCode: ef.feeItemCode, unitCode: ef.feeUnitCode },
        } as any);
      }
    }
    if (!lines.length) { skipped.push({ number: inv.number, reason: 'no PPN on this invoice' }); continue; }
    const buyer = { taxId: d.buyer.taxId, kind: d.buyer.taxIdKind, nitku: d.buyer.nitku, name: d.buyer.name, address: d.buyer.address, email: (d.buyer.email ?? '').split(/[,;]/)[0]?.trim() || null };
    const bp = buyerProblem(buyer);
    if (bp) { skipped.push({ number: inv.number, reason: `buyer has ${bp}` }); continue; }
    // Dated the last day of the month billed (a faktur gabungan, see fakturDate);
    // the invoice number stays the reference (RefDesc) to the commercial invoice,
    // which keeps its own issue date.
    invoices.push({ number: inv.number, date: fakturDate(d.period ?? period), buyer, lines });
    included.push(inv.id);
  }
  if (!invoices.length) throw new FleetBillingError(409, skipped.length ? `No invoice can carry a faktur: ${skipped.map((s) => `${s.number} (${s.reason})`).join('; ')}` : 'No invoices for this month.');
  const xml = efakturXml({ npwp: seller.npwp!, nitku: seller.nitku }, invoices, settings.efaktur as EfakturSettings, config.tax.id.ppnRateBps / 100);
  await query(`UPDATE fleet_invoice SET efaktur_exported_at = now() WHERE id = ANY($1::uuid[])`, [included]);
  return { xml, included: invoices.map((i) => i.number), skipped, sellerNpwp: normaliseNpwp(seller.npwp), sellerNitku: nitkuFor(normaliseNpwp(seller.npwp), seller.nitku) };
}

// ─────────────────────────────────────────── documents

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
/** A rupiah amount as v1.6 printed it ("Rp 12.345"); other currencies through docTax(st).m. */
const idr = (n: unknown) => moneyText(Math.round(Number(n ?? 0)), LEGACY_CURRENCY, 'id');
const kwh = (wh: number) => (wh / 1000).toLocaleString(LOCALE_TAG.id, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(LOCALE_TAG.id, { timeZone: config.billing.timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const dmy = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—');

/** The deductions printed under an invoice's total: earlier credits taken off it, and credit notes against it. */
export function creditRows(st: any): Array<{ label: string; amountMinor: number }> {
  return [
    ...((st.priorCredits ?? []) as any[]).map((c) => ({ label: `Credit note ${c.number} (on invoice ${c.invoiceNumber})`, amountMinor: Number(c.totalMinor) })),
    ...((st.creditNotes ?? []) as any[]).filter((c) => c.status === 'issued' && c.settlement === 'invoice')
      .map((c) => ({ label: `Credit note ${c.number}: ${c.reason}`, amountMinor: Number(c.totalMinor) })),
  ];
}

/**
 * How a statement's amounts and taxes are written (docs/MULTI-COUNTRY-DESIGN.md §D10): a rupiah
 * statement exactly as v1.6 (PBJT-TL, DPP nilai lain, PPN); a ringgit or Singapore-dollar one in
 * its currency with its own tax (GST 9 %, service tax 8 %) or none (not registered), no local tax
 * and no DPP. Shared by the HTML, the PDF and the e-mail.
 */
export function docTax(st: any) {
  const cur = currencyOr(st?.currency);
  if (cur === LEGACY_CURRENCY) {
    return { cur, id: true, m: idr, tax: 'PPN', taxPct: config.tax.id.ppnRateBps / 100, registered: !!st?.seller?.pkp, scheme: 'ID_PPN_PBJT', noTaxNote: 'The seller is not a PKP: no PPN is charged.', regLabel: null as string | null };
  }
  const scheme = String(st?.taxScheme ?? 'NONE');
  const pct = Number(st?.taxRateBps ?? 0) / 100;
  const sg = cur === 'SGD';
  return {
    cur, id: false, m: (n: unknown) => formatMoney(Math.round(Number(n ?? 0)), cur, 'en'),
    tax: scheme === 'SG_GST' ? `GST ${pct}%` : scheme === 'MY_SST' ? `Service tax ${pct}%` : sg ? 'GST' : 'Tax',
    taxPct: pct, registered: scheme !== 'NONE', scheme,
    noTaxNote: sg ? 'The seller is not GST-registered: no GST is charged.' : 'No service tax is charged (the seller is not registered for service tax on EV charging).',
    regLabel: scheme === 'SG_GST' ? 'GST Reg. No.' : scheme === 'MY_SST' ? 'SST No.' : null,
  };
}

export function invoiceHtml(st: any): string {
  const t = st.totals;
  const fees = splitFees(st.fees);
  const dppFrac = `${config.tax.id.ppnDppNumerator}/${config.tax.id.ppnDppDenominator}`;
  const ppnPct = config.tax.id.ppnRateBps / 100;
  const dx = docTax(st);
  const idr = dx.m;
  const b = st.buyer;
  const s = st.seller;
  const title = st.number ? `Invoice ${st.number}` : `Draft statement ${st.period}`;
  const siteRows = dx.id ? st.sites.map((l: any) => `<tr><td><b>${esc(l.siteName)}</b>${l.untaxedSessions ? `<div class="muted">${l.untaxedSessions} session(s) without PPN</div>` : ''}</td>
    <td class="n">${l.sessions}</td><td class="n">${kwh(l.energyWh)}</td><td class="n">${idr(l.subtotalMinor)}</td><td class="n">${idr(l.localTaxMinor)}</td>
    <td class="n">${idr(l.taxBaseMinor)}</td><td class="n">${idr(l.taxMinor)}</td><td class="n"><b>${idr(l.totalMinor)}</b></td></tr>`).join('')
    : st.sites.map((l: any) => `<tr><td><b>${esc(l.siteName)}</b></td>
    <td class="n">${l.sessions}</td><td class="n">${kwh(l.energyWh)}</td><td class="n">${idr(l.subtotalMinor)}</td><td class="n">${idr(l.taxMinor)}</td><td class="n"><b>${idr(l.totalMinor)}</b></td></tr>`).join('');
  const roamRows = st.roaming.map((x: any) => `<tr><td>${esc(dt(x.startedAt))}</td><td>${esc(x.operator)}${x.location ? `<div class="muted">${esc(x.location)}</div>` : ''}</td>
    <td class="mono">${esc(x.cardUid)}</td><td class="n">${x.energyKwh.toLocaleString(LOCALE_TAG.id, { maximumFractionDigits: 3 })}</td><td class="n">${idr(x.amountMinor)}</td></tr>`).join('');
  const sessRows = st.sessions.map((x: any) => `<tr><td>${esc(dt(x.startedAt))}</td><td>${esc(x.siteName)}<div class="muted mono">${esc(x.ocppIdentity)}</div></td>
    <td class="mono">${esc(x.cardUid)}${x.holder ? `<div class="muted">${esc(x.holder)}</div>` : ''}</td><td class="n">${kwh(x.energyWh)}</td><td class="n">${idr(x.totalMinor)}</td></tr>`).join('');
  const statusBanner = st.status === 'draft'
    ? `<div class="banner info">Draft — not an invoice. Figures change until the month is invoiced.</div>`
    : st.status === 'void' ? `<div class="banner crit">VOID — ${esc(st.voidReason ?? '')}</div>`
    : st.status === 'paid' ? `<div class="banner ok">Paid ${esc(dmy(st.paidAt))}${st.paidReference ? ` · ${esc(st.paidReference)}` : ''}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  @page{size:A4;margin:14mm}
  body{font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:0;background:#f4f5f7}
  .page{max-width:900px;margin:24px auto;background:#fff;padding:32px 36px;border:1px solid #e3e6ea;border-radius:10px}
  h1{font-size:22px;margin:0}h2{font-size:14px;margin:22px 0 6px;text-transform:uppercase;letter-spacing:.05em;color:#374151}
  .muted{color:#5b6470;font-size:12px}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  th,td{padding:6px 6px;border-bottom:1px solid #eceef1;text-align:left;vertical-align:top}
  th{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#5b6470}
  .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .grand td{font-weight:700;font-size:16px;border-top:2px solid #111;border-bottom:0}
  .head{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}
  .parties{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}
  .box{border:1px solid #e3e6ea;border-radius:8px;padding:10px 12px}
  .box b{font-size:14px}
  .banner{padding:8px 10px;border-radius:6px;margin-top:12px;font-size:12.5px}
  .info{background:#e0ecff;color:#1e3a8a}.crit{background:#fee2e2;color:#991b1b;font-weight:700}.ok{background:#dcfce7;color:#166534}
  .warn{background:#fef3c7;color:#92400e;padding:6px 8px;border-radius:6px;margin-top:6px;font-size:12px}
  .note{margin-top:16px;font-size:11px;color:#5b6470}
  .pay{white-space:pre-wrap}
  .appendix{page-break-before:always}
  @media print{body{background:#fff}.page{border:0;margin:0;max-width:none;padding:0}}
  @media (max-width:640px){.parties{grid-template-columns:1fr}.page{padding:20px 16px;margin:0;border-radius:0}}
</style></head><body><div class="page">
<div class="head"><div><h1>${st.number ? 'Invoice' : 'Fleet statement (draft)'}</h1>
<div class="muted">Charging for ${esc(st.periodLabel)} · ${esc(b.fleetName)}</div></div>
<div class="muted" style="text-align:right">${st.number ? `No. <b style="color:#111">${esc(st.number)}</b><br>Date: ${esc(dmy(st.issuedDate))}<br>Due: <b style="color:#111">${esc(dmy(st.dueDate))}</b>` : 'DRAFT'}
${st.efakturNumber ? `<br>Faktur pajak: ${esc(st.efakturNumber)}` : ''}</div></div>
${statusBanner}
<div class="parties">
  <div class="box"><div class="muted">From</div><b>${esc(s.name)}</b>
    ${dx.id ? (s.npwp ? `<div class="muted">NPWP ${esc(s.npwp)}${s.pkp ? ' · PKP' : ''}</div>` : '') : dx.regLabel && st.taxRegistrationNo ? `<div class="muted">${esc(dx.regLabel)} ${esc(st.taxRegistrationNo)}</div>` : ''}${s.address ? `<div class="muted">${esc(s.address)}</div>` : ''}</div>
  <div class="box"><div class="muted">Bill to</div><b>${esc(b.name)}</b>
    ${b.taxId ? `<div class="muted">${b.taxIdKind === 'TIN' ? 'NPWP' : esc(b.taxIdKind)} ${esc(b.taxId)}</div>` : ''}${b.address ? `<div class="muted">${esc(b.address)}</div>` : ''}
    ${b.contact ? `<div class="muted">Attn. ${esc(b.contact)}</div>` : ''}</div>
</div>
${(st.warnings ?? []).map((w: string) => `<div class="warn">${esc(w)}</div>`).join('')}
<h2>Charging at our stations</h2>
${dx.id ? `<table><thead><tr><th>Site</th><th class="n">Sessions</th><th class="n">kWh</th><th class="n">Energy &amp; fees</th><th class="n">PBJT-TL</th><th class="n">DPP</th><th class="n">PPN</th><th class="n">Amount</th></tr></thead>
<tbody>${siteRows || '<tr><td colspan="8" class="muted">No sessions.</td></tr>'}</tbody></table>` : `<table><thead><tr><th>Site</th><th class="n">Sessions</th><th class="n">kWh</th><th class="n">Energy &amp; fees</th><th class="n">${esc(dx.tax)}</th><th class="n">Amount (${esc(dx.cur)})</th></tr></thead>
<tbody>${siteRows || '<tr><td colspan="6" class="muted">No sessions.</td></tr>'}</tbody></table>`}
${st.roaming.length ? `<h2>Charging on partner networks (re-billed at cost)</h2>
<table><thead><tr><th>When</th><th>Operator</th><th>Card</th><th class="n">kWh</th><th class="n">Amount</th></tr></thead><tbody>${roamRows}</tbody></table>` : ''}
${fees.memberships.length ? `<h2>Memberships</h2>
<table><thead><tr><th>Plan</th><th>For</th><th class="n">Fee</th><th class="n">${dx.id ? 'PPN' : esc(dx.tax)}</th><th class="n">Amount</th></tr></thead><tbody>${fees.memberships.map((f: any) => `<tr><td>${esc(f.planName)}</td><td>${esc(f.subscriber)}</td><td class="n">${idr(f.feeMinor)}</td><td class="n">${idr(f.taxMinor)}</td><td class="n"><b>${idr(f.totalMinor)}</b></td></tr>`).join('')}</tbody></table>` : ''}
${fees.reservations.length ? `<h2>Connector reservations</h2>
<table><thead><tr><th>Held</th><th>Site</th><th>Card</th><th class="n">Fee</th><th class="n">${dx.id ? 'PPN' : esc(dx.tax)}</th><th class="n">Amount</th></tr></thead><tbody>${fees.reservations.map((f: any) => `<tr><td>${esc(dt(f.periodStart))}</td><td>${esc(f.planName)}</td><td class="mono">${esc(f.subscriber)}</td><td class="n">${idr(f.feeMinor)}</td><td class="n">${idr(f.taxMinor)}</td><td class="n"><b>${idr(f.totalMinor)}</b></td></tr>`).join('')}</tbody></table>` : ''}
<h2>Summary</h2>
<table><tbody>
${dx.id ? `<tr><td>Energy, service and admin fees</td><td class="n">${idr(t.subtotalMinor)}</td></tr>
<tr><td>PBJT-TL (regional tax on electricity)</td><td class="n">${idr(t.localTaxMinor)}</td></tr>
<tr><td class="muted">Price subject to PPN</td><td class="n muted">${idr(t.taxableMinor)}</td></tr>
<tr><td class="muted">DPP nilai lain (${esc(dppFrac)} × price)</td><td class="n muted">${idr(t.taxBaseMinor)}</td></tr>
<tr><td>PPN ${ppnPct}% × DPP</td><td class="n">${idr(t.taxMinor)}</td></tr>` : `<tr><td>Energy, service and admin fees (before tax)</td><td class="n">${idr(t.subtotalMinor)}</td></tr>
${dx.registered ? `<tr><td class="muted">Price subject to ${esc(dx.tax.replace(/ \d.*$/, ''))}</td><td class="n muted">${idr(t.taxableMinor)}</td></tr>
<tr><td>${esc(dx.tax)}</td><td class="n">${idr(t.taxMinor)}</td></tr>` : `<tr><td>${esc(dx.noTaxNote)}</td><td class="n">${idr(0)}</td></tr>`}`}
<tr><td><b>Charging at our stations</b></td><td class="n"><b>${idr(t.ownTotalMinor)}</b></td></tr>
${fees.membershipsMinor ? `<tr><td>Memberships (incl. ${dx.id ? 'PPN' : esc(dx.tax)})</td><td class="n">${idr(fees.membershipsMinor)}</td></tr>` : ''}
${fees.reservationsMinor ? `<tr><td>Connector reservations (${fees.reservations.length}, incl. ${dx.id ? 'PPN' : esc(dx.tax)})</td><td class="n">${idr(fees.reservationsMinor)}</td></tr>` : ''}
${t.roamingSessions ? `<tr><td>Partner networks (${t.roamingSessions} session${t.roamingSessions === 1 ? '' : 's'}, as billed by the operators, incl. their taxes)</td><td class="n">${idr(t.roamingMinor)}</td></tr>` : ''}
${creditRows(st).length ? `<tr><td><b>Invoice total</b></td><td class="n"><b>${idr(t.totalMinor)}</b></td></tr>`
  + creditRows(st).map((c) => `<tr><td>${esc(c.label)}</td><td class="n">− ${idr(c.amountMinor)}</td></tr>`).join('')
  + `<tr class="grand"><td>${st.status === 'paid' ? 'Paid' : 'Amount due'}</td><td class="n">${idr(st.status === 'paid' ? t.totalMinor - creditRows(st).reduce((a, c) => a + c.amountMinor, 0) : st.balanceMinor)}</td></tr>`
  : `<tr class="grand"><td>${st.number ? 'Total due' : 'Total so far'}</td><td class="n">${idr(t.totalMinor)}</td></tr>`}
</tbody></table>
<div class="muted" style="margin-top:6px">${t.sessions} session${t.sessions === 1 ? '' : 's'} · ${kwh(t.energyWh)} kWh at our stations${t.roundingMinor ? ` · the per-session receipts add up to ${idr(t.receiptsTotalMinor)} (${dx.id ? 'PPN' : esc(dx.tax.replace(/ \d.*$/, ''))} is calculated per invoice line here; difference ${idr(t.roundingMinor)})` : ''}${dx.id ? '' : ` · all amounts in ${esc(dx.cur)}`}</div>
${st.paymentInstructions ? `<h2>How to pay</h2><div class="pay">${esc(st.paymentInstructions)}</div>` : ''}
${st.number ? `<div class="muted" style="margin-top:8px">Please quote <b>${esc(st.number)}</b> with your payment.</div>` : ''}
<div class="note">Sessions count in the month their charge record was issued (${esc(config.billing.timeZone)}). Each session also has its own tax receipt.
${dx.id ? (s.pkp ? 'The faktur pajak for the PPN is issued through e-Faktur (Coretax) under this invoice number.' : 'The seller is not a PKP: no PPN is charged.') : dx.registered ? `${esc(dx.tax)} is calculated on each line's total before tax.` : esc(dx.noTaxNote)}
${t.roamingSessions ? `Partner-network charging is re-billed at the amount the partner operator charged; it is not part of our ${dx.id ? 'faktur pajak' : 'tax invoice'}.` : ''}</div>
${st.sessions.length || st.roaming.length ? `<div class="appendix"><h2>Appendix — sessions by card</h2>
<table><thead><tr><th>Card</th><th>Holder</th><th class="n">Sessions</th><th class="n">kWh</th><th class="n">At our stations</th><th class="n">Partner networks</th></tr></thead><tbody>
${st.cards.map((c: any) => `<tr><td class="mono">${esc(c.uid)}</td><td>${esc(c.holder ?? '')}</td><td class="n">${c.sessions}</td><td class="n">${kwh(c.energyWh)}</td><td class="n">${idr(c.totalMinor)}</td><td class="n">${c.roamingMinor ? idr(c.roamingMinor) : '—'}</td></tr>`).join('')}
</tbody></table>
${st.sessions.length ? `<h2>Sessions at our stations (receipt amounts)</h2><table><thead><tr><th>Started</th><th>Site / charger</th><th>Card</th><th class="n">kWh</th><th class="n">Receipt</th></tr></thead><tbody>${sessRows}</tbody></table>` : ''}
</div>` : ''}
</div></body></html>`;
}

const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function invoiceCsv(st: any): string {
  const dx = docTax(st);
  // Amounts in minor units of the statement's currency (rupiah, sen, cents): named in the header outside Indonesia.
  const head = dx.id
    ? ['Invoice', 'Period', 'Fleet', 'Kind', 'Started', 'Ended', 'Site / operator', 'Charger', 'Card', 'Holder', 'Energy kWh',
      'Energy & fees', 'PBJT-TL', 'PPN (receipt)', 'Receipt / amount']
    : ['Invoice', 'Period', 'Fleet', 'Kind', 'Started', 'Ended', 'Site / operator', 'Charger', 'Card', 'Holder', 'Energy kWh',
      `Energy & fees (${dx.cur} minor)`, 'Local tax', `${dx.tax.replace(/ \d.*$/, '')} (receipt)`, `Receipt / amount (${dx.cur} minor)`];
  const rows = [
    ...st.sessions.map((x: any) => [st.number ?? 'DRAFT', st.period, st.buyer.fleetName, 'session', x.startedAt, x.endedAt ?? '', x.siteName, x.ocppIdentity,
      x.cardUid, x.holder ?? '', (x.energyWh / 1000).toFixed(3), x.subtotalMinor, x.localTaxMinor, x.taxMinor, x.totalMinor]),
    ...st.roaming.map((x: any) => [st.number ?? 'DRAFT', st.period, st.buyer.fleetName, 'partner network', x.startedAt, x.endedAt, x.operator + (x.location ? ` — ${x.location}` : ''), '',
      x.cardUid, '', x.energyKwh.toFixed(3), '', '', '', x.amountMinor]),
    ...(st.fees ?? []).map((x: any) => x.kind === 'reservation'
      ? [st.number ?? 'DRAFT', st.period, st.buyer.fleetName, 'reservation', x.periodStart, x.periodEnd, x.planName, '', x.subscriber, '', '', x.feeMinor, '', x.taxMinor, x.totalMinor]
      : [st.number ?? 'DRAFT', st.period, st.buyer.fleetName, 'membership', x.periodStart, x.periodEnd, x.planName, '',
      x.subscriber, '', '', x.feeMinor, '', x.taxMinor, x.totalMinor]),
  ];
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ─────────────────────────────────────────── e-mail

/** E-mail the invoice to the account's billing address(es), through the organisation's e-mail channel. */
export async function sendInvoice(orgId: string, id: string, overrideTo?: string) {
  const st = await getInvoice(orgId, id);
  if (st.status === 'void') throw new FleetBillingError(409, 'A void invoice is not sent.');
  const to = String(overrideTo ?? st.buyer.email ?? '').trim();
  if (!to || !to.split(/[,;]\s*/).every((x) => EMAIL_RE.test(x))) throw new FleetBillingError(422, 'No valid billing e-mail address for this fleet account.');
  const ch = await one<{ enabled: boolean; config: any; secret: string | null }>(`SELECT enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind = 'email'`, [orgId]);
  if (!ch?.enabled || !ch.config?.host) throw new FleetBillingError(409, 'Set up the e-mail channel first (Govern → Alert routing → Channels).');
  let secret: string | null = null;
  try { secret = ch.secret ? unseal(ch.secret) : null; } catch { secret = null; }
  const html = invoiceHtml(st);
  const idr = docTax(st).m;
  const file = st.number.replace(/[^\w.-]+/g, '_');
  const text = `${st.seller.name}\nInvoice ${st.number} — ${st.periodLabel}\nFleet: ${st.buyer.fleetName}\n${st.status === 'issued' ? `Amount due: ${idr(st.balanceMinor)} by ${dmy(st.dueDate)}` : `Invoice total: ${idr(st.totals.totalMinor)} (${st.status})`}${st.priorCreditMinor ? ` (after ${idr(st.priorCreditMinor)} of earlier credit notes)` : ''}\n\n` +
    `${st.totals.sessions} sessions, ${kwh(st.totals.energyWh)} kWh${st.totals.roamingSessions ? `, plus ${st.totals.roamingSessions} on partner networks` : ''}.\n` +
    (st.paymentInstructions ? `\nHow to pay:\n${st.paymentInstructions}\n` : '') + `\nThe invoice and the session list are attached.`;
  const res = await sendEmail(ch.config, secret, to, {
    subject: `Invoice ${st.number} — ${st.buyer.fleetName} — ${st.periodLabel}`,
    text, html, kind: 'fleet-invoice',
    attachments: [
      { filename: `${file}.pdf`, content: (await import('./fleet-pdf.js')).invoicePdf(st), contentType: 'application/pdf' },
      { filename: `${file}-sessions.csv`, content: invoiceCsv(st), contentType: 'text/csv; charset=utf-8' },
    ],
  });
  if (!res.ok) throw new FleetBillingError(502, `The e-mail was not sent: ${res.error ?? 'failed'}`);
  await query(`UPDATE fleet_invoice SET sent_at = now(), sent_to = $3 WHERE id = $1 AND org_id = $2`, [id, orgId, to.slice(0, 300)]);
  return { ok: true, to, reference: res.ref ?? null };
}
