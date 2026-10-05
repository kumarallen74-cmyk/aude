import type { CurrencyCode } from '../../domain/money.js';
import type { CountryCode, TaxScheme } from '../../domain/country.js';

/**
 * The tax engine interface (docs/MULTI-COUNTRY-DESIGN.md §D3). One engine per
 * scheme; the engine for a CDR is chosen by the site's country and the
 * organisation's registration there (resolveTaxContext / engineFor).
 *
 * Amounts are PlugSure minor units of the session's currency (domain/money.ts).
 */

export interface SessionTaxInput {
  /** Sum of the rated lines: NET of tax, or GROSS when pricesIncludeTax. */
  subtotalMinor: number;
  /** The energy lines (ID: what PBJT-TL is levied on). */
  energyMinor?: number;
  /** ID: per-municipality PBJT-TL in basis points. */
  localTaxRateBps?: number;
  /** ID: false for a non-PKP operator's tariff. */
  ppnApplies?: boolean;
  /** The tariff's prices include the tax (SG default). */
  pricesIncludeTax?: boolean;
}

/**
 * The engine-agnostic invoice structure every CDR stores:
 * lines → subtotal (net) → local tax → tax base → tax → rounding → total.
 */
export interface TaxResult {
  scheme: TaxScheme;
  /** Whether the rated lines were tax-inclusive (then subtotal = lines − tax). */
  pricesIncludeTax: boolean;
  /** Net of every tax. */
  subtotalMinor: number;
  localTaxBaseMinor: number;
  localTaxRateBps: number;
  localTaxMinor: number;
  /** What the main tax was levied on (ID: DPP nilai lain). */
  taxBaseMinor: number;
  taxRateBps: number;
  taxMinor: number;
  roundingMinor: number;
  totalMinor: number;
  /** Engine extras (ID DPP fraction and PBJT base; SG inclusive; an exemption's reason). */
  detail: Record<string, unknown>;
}

export interface FeeTaxInput {
  amountMinor: number;
  /** The amount already includes the tax. */
  inclusive?: boolean;
  /** The operator is registered for this tax (ID: PKP). */
  registered: boolean;
}
export interface FeeTaxResult { netMinor: number; taxBaseMinor: number; taxMinor: number; totalMinor: number; taxRateBps: number }

export interface InvoiceTaxInput { taxableMinor: number; untaxedMinor: number }
export interface InvoiceTaxResult { taxBaseMinor: number; taxMinor: number; totalMinor: number }

export interface TaxLabels {
  tax: string;
  localTax: string | null;
  taxBase: string | null;
  noTax: string;
  inclusiveNote: string | null;
}

export interface TaxEngine {
  scheme: TaxScheme;
  computeSession(i: SessionTaxInput): TaxResult;
  computeFee(i: FeeTaxInput): FeeTaxResult;
  invoiceTotals(i: InvoiceTaxInput): InvoiceTaxResult;
  /** OCPI `vat` percentage for a tariff (null = omit: no VAT). */
  ocpiVatPercent(ppnApplies?: boolean): number | null;
  labels(lang: 'id' | 'en'): TaxLabels;
}

/** Everything that decides how a supply at a site is taxed, resolved once per CDR. */
export interface TaxContext {
  country: CountryCode;
  currency: CurrencyCode;
  /** The scheme actually applied (NONE when not registered / not taxable / exempt). */
  scheme: TaxScheme;
  /** The country's scheme, whether or not it applies. */
  countryScheme: Exclude<TaxScheme, 'NONE'>;
  registered: boolean;
  registrationNo: string | null;
  /** Rate in force for MY/SG at the supply date (registration override first). */
  rateBps: number;
  /** site.tax_overrides.exempt */
  exempt: { reason: string } | null;
  /** Why the scheme is NONE (for receipts: "Not GST-registered"). */
  noneReason: 'not_registered' | 'not_taxable' | 'exempt' | null;
}
