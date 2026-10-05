import type pg from 'pg';
import { config } from '../../config.js';
import { countryOf, type CountryCode } from '../../domain/country.js';
import type { CurrencyCode } from '../../domain/money.js';
import { engineFor, taxContextFrom, type TaxRegistrationRow } from '../../services/tax/index.js';
import { bpsOf } from './fees.js';
import { addDays, localDateString } from './period.js';

/**
 * Hub fee (commission) invoices (docs/HUB-DESIGN.md §8.6). One per member and finalised run with a non-zero
 * commission: Σ fee_cpo where the member is CPO + Σ fee_emsp where it is eMSP, in the run's currency, issued by
 * the PlugSure entity of the member's country (hub_entity; the seeded rows are PLACEHOLDERS — [OWNER] 14.1-1 —
 * and documents from them say so). A member whose country has no entity is invoiced cross-border by
 * HUB_DEFAULT_ENTITY with tax_scheme REVERSE_CHARGE and no tax [LEGAL] 14.2-3.
 *
 * Tax uses the existing engines (services/tax), on a context built for the PlugSure entity rather than an
 * operator organisation (platformTaxContext):
 *   ID  PPN 12 % on DPP 11/12 when the entity is PKP (tax_registered), as for platform commission; an Indonesian
 *       member is expected to withhold PPh 23 at 2 % of the fee (wht_expected_minor) and send the bukti potong.
 *   SG  GST at the rate in force when the entity is GST-registered, else none [VERIFY threshold; zero-rating of
 *       services to overseas members, LEGAL-SG].
 *   MY  service tax at the rate in force when the entity is registered [VERIFY: is a clearing service a
 *       "taxable service"?], else none.
 * The fee invoice is in the run's currency; when it differs from the entity's country currency, the tax must be
 * reported in local currency at the official rate — FX for tax reporting only, flagged on the document [VERIFY].
 */

export interface EntityRow { country_code: CountryCode; legal_name: string; tax_id: string | null; tax_registered: boolean; address: string; bank_details: string | null; invoice_prefix: string; placeholder: boolean }

export type FeeTaxScheme = 'ID_PPN' | 'SG_GST' | 'MY_SST' | 'NONE' | 'REVERSE_CHARGE';

/** The tax context of the PlugSure entity (not an operator org): its registration is the entity's flag. */
export function platformTaxContext(entity: Pick<EntityRow, 'country_code' | 'tax_registered' | 'tax_id'>, at: Date) {
  const country = entity.country_code;
  const scheme: TaxRegistrationRow['scheme'] = country === 'ID' ? 'ID_PKP' : country === 'SG' ? 'SG_GST' : 'MY_SST';
  const regs: TaxRegistrationRow[] = [{
    country_code: country, scheme, registration_no: entity.tax_id, registered: entity.tax_registered,
    // MY: taxContextFrom applies service tax only to "taxable" supplies; for the hub's service that is the
    // entity's registration itself [VERIFY Group G/I].
    ev_charging_taxable: entity.tax_registered, rate_bps: null, effective_from: '2000-01-01', effective_to: null,
  }];
  return taxContextFrom(country, regs, null, at);
}

/** Tax on a fee invoice (pure apart from config): scheme, base, tax, total and the PPh 23 expected. */
export function feeInvoiceTax(entity: Pick<EntityRow, 'country_code' | 'tax_registered' | 'tax_id'>, memberCountry: string, netMinor: number, at: Date, crossBorder = false) {
  if (crossBorder) return { scheme: 'REVERSE_CHARGE' as FeeTaxScheme, rateBps: 0, taxBaseMinor: 0, taxMinor: 0, totalMinor: netMinor, whtMinor: 0, labels: null };
  const ctx = platformTaxContext(entity, at);
  const engine = engineFor(ctx);
  const r = engine.computeFee({ amountMinor: netMinor, registered: entity.tax_registered });
  const scheme: FeeTaxScheme = r.taxMinor === 0 && !entity.tax_registered ? 'NONE'
    : entity.country_code === 'ID' ? 'ID_PPN' : entity.country_code === 'SG' ? (ctx.scheme === 'SG_GST' ? 'SG_GST' : 'NONE') : (ctx.scheme === 'MY_SST' ? 'MY_SST' : 'NONE');
  // PPh 23 (2 %) on the fee before PPN, withheld by an Indonesian member paying the Indonesian entity.
  const wht = entity.country_code === 'ID' && memberCountry === 'ID' && netMinor > 0 ? bpsOf(netMinor, 200) : 0;
  return {
    scheme, rateBps: scheme === 'NONE' ? 0 : r.taxRateBps, taxBaseMinor: scheme === 'NONE' ? 0 : r.taxBaseMinor, taxMinor: r.taxMinor, totalMinor: r.totalMinor,
    whtMinor: wht, labels: engine.labels('en'),
  };
}

/** Gapless numbering under a row lock (one sequence per key). */
export async function nextNumber(c: pg.PoolClient, key: string, format: (seq: number) => string): Promise<string> {
  await c.query(`INSERT INTO hub_doc_seq (key, last) VALUES ($1, 0) ON CONFLICT (key) DO NOTHING`, [key]);
  const r = (await c.query<{ last: number }>(`UPDATE hub_doc_seq SET last = last + 1 WHERE key = $1 RETURNING last`, [key])).rows[0]!;
  return format(Number(r.last));
}

export async function issueFeeInvoice(c: pg.PoolClient, o: { run: any; member: any; feeCpoMinor: number; feeEmspMinor: number; cdrsAsCpo: number; cdrsAsEmsp: number; now: Date }) {
  const { run, member, now } = o;
  const cur = run.currency as CurrencyCode;
  let entity = (await c.query<EntityRow>(`SELECT * FROM hub_entity WHERE country_code = $1`, [member.country_code])).rows[0];
  let crossBorder = false;
  if (!entity) {
    entity = (await c.query<EntityRow>(`SELECT * FROM hub_entity WHERE country_code = $1`, [config.hub.defaultEntity])).rows[0];
    crossBorder = true;
    if (!entity) throw new Error(`no hub_entity for ${member.country_code} nor HUB_DEFAULT_ENTITY ${config.hub.defaultEntity}`);
  }
  const netMinor = o.feeCpoMinor + o.feeEmspMinor;
  const tax = feeInvoiceTax(entity, member.country_code, netMinor, now, crossBorder);
  const year = run.period.slice(0, 4);
  const number = await nextNumber(c, `fee:${entity.country_code}:${year}`, (seq) => `${entity!.invoice_prefix}${year}-${String(seq).padStart(6, '0')}`);
  const issued = localDateString(now, cur);
  const due = addDays(issued, config.hub.paymentTermsDays);
  const flags: string[] = [];
  if (entity.placeholder) flags.push('placeholder_entity');
  if (countryOf(entity.country_code).currency !== cur) flags.push('foreign_currency_tax_reporting');
  if (crossBorder) flags.push('cross_border');
  const data = {
    kind: netMinor < 0 ? 'credit_note' : 'invoice',
    issuer: { country: entity.country_code, name: entity.legal_name, taxId: entity.tax_id, taxRegistered: entity.tax_registered, address: entity.address, placeholder: entity.placeholder },
    buyer: { memberId: member.id, name: member.legal_name, country: member.country_code, taxId: member.tax_id, email: member.billing_email },
    currency: cur, period: run.period, runId: run.id, issuedDate: issued, dueDate: due,
    lines: [
      ...(o.cdrsAsCpo ? [{ label: `Hub clearing and roaming services as CPO (${o.cdrsAsCpo} CDR${o.cdrsAsCpo === 1 ? '' : 's'})`, amountMinor: o.feeCpoMinor }] : []),
      ...(o.cdrsAsEmsp ? [{ label: `Hub clearing and roaming services as eMSP (${o.cdrsAsEmsp} CDR${o.cdrsAsEmsp === 1 ? '' : 's'})`, amountMinor: o.feeEmspMinor }] : []),
    ],
    tax: { scheme: tax.scheme, rateBps: tax.rateBps, label: tax.labels?.tax ?? null, baseLabel: tax.labels?.taxBase ?? null, noTaxLabel: tax.labels?.noTax ?? null },
    flags,
  };
  const row = (await c.query(
    `INSERT INTO hub_fee_invoice (member_id, org_id, entity_country, run_id, currency, number, net_minor, tax_scheme, tax_rate_bps, tax_base_minor, tax_minor,
                                  total_minor, wht_expected_minor, due_date, data, issued_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, number, total_minor`,
    [member.id, member.org_id, entity.country_code, run.id, cur, number, netMinor, tax.scheme, tax.rateBps, tax.taxBaseMinor, tax.taxMinor, tax.totalMinor,
      tax.whtMinor, due, JSON.stringify(data), now])).rows[0];
  return row as { id: string; number: string; total_minor: number };
}
