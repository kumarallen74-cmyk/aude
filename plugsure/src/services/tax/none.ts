import type { TaxEngine, TaxLabels } from './types.js';

/**
 * NONE: no tax is charged — the operator is not registered in the site's country
 * (Malaysia's default while EV charging is not confirmed a taxable service, V1;
 * Singapore below the S$1m GST threshold), or the site is exempt
 * (site.tax_overrides.exempt). total = subtotal; receipts say why.
 */
export function noneEngine(reason: string | null, labels?: (lang: 'id' | 'en') => TaxLabels): TaxEngine {
  return {
    scheme: 'NONE',
    computeSession(i) {
      const a = Math.round(i.subtotalMinor);
      return {
        scheme: 'NONE', pricesIncludeTax: i.pricesIncludeTax === true,
        subtotalMinor: a, localTaxBaseMinor: 0, localTaxRateBps: 0, localTaxMinor: 0,
        taxBaseMinor: 0, taxRateBps: 0, taxMinor: 0, roundingMinor: 0, totalMinor: a,
        detail: reason ? { reason } : {},
      };
    },
    computeFee: (i) => ({ netMinor: i.amountMinor, taxBaseMinor: 0, taxMinor: 0, totalMinor: i.amountMinor, taxRateBps: 0 }),
    invoiceTotals: (i) => ({ taxBaseMinor: 0, taxMinor: 0, totalMinor: i.taxableMinor + i.untaxedMinor }),
    ocpiVatPercent: () => null,
    labels: labels ?? ((lang) => ({ tax: lang === 'id' ? 'Pajak' : 'Tax', localTax: null, taxBase: null, noTax: lang === 'id' ? 'Tanpa pajak' : 'No tax charged', inclusiveNote: null })),
  };
}
