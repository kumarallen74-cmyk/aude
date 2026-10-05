import { many } from '../../db/pool.js';
import { countryOf, type CountryCode, type TaxScheme } from '../../domain/country.js';
import { rateRowAt } from './rates.js';
import { ID_ENGINE } from './id.js';
import { vatEngine, sgLabels, myLabels } from './vat.js';
import { noneEngine } from './none.js';
import type { TaxContext, TaxEngine } from './types.js';

/**
 * Tax engines (docs/MULTI-COUNTRY-DESIGN.md §D3).
 *
 *   ID_PPN_PBJT  site in ID: the v1.6 arithmetic (tax/id.ts), unchanged
 *   SG_GST       site in SG, org has an active SG_GST registration: 9 %, prices GST-inclusive by default
 *   MY_SST       site in MY, org registered for MY_SST AND ev_charging_taxable [VERIFY V1]: 8 %
 *   NONE         otherwise (MY default, SG below the threshold, or site.tax_overrides.exempt)
 *
 * resolveTaxContext() reads the registration in force at the supply date and the
 * site's override once per CDR; engineFor() turns it into the engine. Every CDR
 * stores the scheme and rate it was taxed with (cdr.tax_scheme, tax_rate_bps).
 */

export * from './types.js';
export { computeTax, clampBps, effectivePpnRateBps, effectiveVatPercent, pkpFeeTax, ID_ENGINE } from './id.js';
export { RATES, rateRowAt } from './rates.js';

export interface TaxRegistrationRow {
  country_code: string;
  scheme: 'ID_PKP' | 'MY_SST' | 'SG_GST';
  registration_no: string | null;
  registered: boolean;
  ev_charging_taxable: boolean;
  rate_bps: number | null;
  effective_from: string | Date;
  effective_to: string | Date | null;
}

export interface SiteTaxOverrides { exempt?: boolean; reason?: string }

const ymd = (d: string | Date) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const localYmd = (at: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/**
 * The tax context of a supply in `country` at `at`, from the organisation's
 * registrations and the site's override. Pure (tests and the rating preview use it
 * directly; resolveTaxContext loads its inputs).
 */
export function taxContextFrom(
  country: CountryCode,
  registrations: TaxRegistrationRow[],
  overrides: SiteTaxOverrides | null | undefined,
  at: Date,
  timezone?: string,
): TaxContext {
  const c = countryOf(country);
  const tz = timezone ?? c.timezones[0]!;
  const day = localYmd(at, tz);
  const inForce = (scheme: TaxRegistrationRow['scheme']) =>
    registrations.find((r) => r.country_code === country && r.scheme === scheme && ymd(r.effective_from) <= day && (r.effective_to == null || ymd(r.effective_to) > day)) ?? null;

  const base = { country, currency: c.currency, countryScheme: c.taxEngine } as const;
  const exempt = overrides?.exempt ? { reason: String(overrides.reason ?? 'exempt site').slice(0, 200) } : null;

  if (country === 'ID') {
    // PPN applicability in Indonesia stays per tariff (tariff.ppn_applies, v1.6); the
    // ID_PKP registration row is informational.
    const reg = inForce('ID_PKP');
    return {
      ...base, scheme: exempt ? 'NONE' : 'ID_PPN_PBJT', registered: reg?.registered ?? true, registrationNo: reg?.registration_no ?? null,
      rateBps: rateRowAt('ID_PPN_PBJT', at, tz)!.rateBps, exempt, noneReason: exempt ? 'exempt' : null,
    };
  }
  const regScheme = c.taxEngine as 'SG_GST' | 'MY_SST';
  const reg = inForce(regScheme);
  const defaultRate = rateRowAt(regScheme, at, tz)?.rateBps ?? 0;
  const rateBps = reg?.rate_bps ?? defaultRate;
  const registered = reg?.registered === true;
  const taxable = regScheme === 'MY_SST' ? registered && reg!.ev_charging_taxable === true : registered;
  const scheme: TaxScheme = exempt || !taxable ? 'NONE' : regScheme;
  return {
    ...base, scheme, registered, registrationNo: reg?.registration_no ?? null, rateBps, exempt,
    noneReason: exempt ? 'exempt' : !registered ? 'not_registered' : !taxable ? 'not_taxable' : null,
  };
}

/** Load and resolve the tax context for a site's supply at `at`. */
export async function resolveTaxContext(p: {
  orgId: string; country: CountryCode; at: Date; timezone?: string; overrides?: SiteTaxOverrides | null;
}): Promise<TaxContext> {
  const regs = p.country === 'ID' && !p.overrides?.exempt
    ? [] // ID: nothing in the registration changes the arithmetic (see taxContextFrom)
    : await many<TaxRegistrationRow>(
      `SELECT country_code, scheme, registration_no, registered, ev_charging_taxable, rate_bps,
              to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to
         FROM org_tax_registration WHERE org_id = $1 AND country_code = $2`,
      [p.orgId, p.country],
    );
  return taxContextFrom(p.country, regs, p.overrides, p.at, p.timezone);
}

/** resolveTaxContext for a site row (country_code, timezone, tax_overrides as selected from `site`). */
export function taxContextForSite(orgId: string, site: { country_code?: string | null; timezone?: string | null; tax_overrides?: SiteTaxOverrides | null }, at: Date): Promise<TaxContext> {
  const country = countryOf(site.country_code ?? 'ID').code;
  return resolveTaxContext({ orgId, country, at, timezone: site.timezone ?? undefined, overrides: site.tax_overrides });
}

/** The engine that applies a context. */
export function engineFor(ctx: TaxContext): TaxEngine {
  if (ctx.scheme === 'ID_PPN_PBJT') return ID_ENGINE;
  if (ctx.scheme === 'SG_GST') return vatEngine('SG_GST', ctx.rateBps, sgLabels(ctx.rateBps));
  if (ctx.scheme === 'MY_SST') return vatEngine('MY_SST', ctx.rateBps, myLabels(ctx.rateBps));
  const labels = ctx.country === 'SG' ? sgLabels(ctx.rateBps) : ctx.country === 'MY' ? myLabels(ctx.rateBps) : undefined;
  return noneEngine(ctx.noneReason, labels);
}

/** The Indonesian context every v1.6 caller implied (no registration lookup needed). */
export function indonesianTaxContext(): TaxContext {
  return taxContextFrom('ID', [], null, new Date());
}
