import type { TaxScheme } from '../../domain/country.js';
import type { TaxEngine, TaxResult, TaxLabels } from './types.js';

/**
 * A single-rate VAT-style tax with no local tax: Singapore GST (SG_GST, 9 %) and
 * Malaysian service tax (MY_SST, 8 %). Prices may be tax-inclusive (Singapore's
 * IRAS rule for consumer price displays): then
 *   tax = round(gross × rate / (10000 + rate)),  net = gross − tax
 * and otherwise tax = round(net × rate / 10000). One rounding per invoice
 * (the session), Math.round as everywhere else. MYR/SGD are exact to the sen /
 * cent: no cash rounding (MY-6).
 */
export function vatEngine(scheme: Extract<TaxScheme, 'SG_GST' | 'MY_SST'>, rateBps: number, labels: (lang: 'id' | 'en') => TaxLabels): TaxEngine {
  const split = (amount: number, inclusive: boolean) => {
    const a = Math.round(amount);
    if (inclusive) {
      const tax = Math.round((a * rateBps) / (10_000 + rateBps));
      return { net: a - tax, tax, total: a };
    }
    const tax = Math.round((a * rateBps) / 10_000);
    return { net: a, tax, total: a + tax };
  };
  return {
    scheme,
    computeSession(i): TaxResult {
      const inclusive = i.pricesIncludeTax === true;
      const s = split(i.subtotalMinor, inclusive);
      return {
        scheme, pricesIncludeTax: inclusive,
        subtotalMinor: s.net, localTaxBaseMinor: 0, localTaxRateBps: 0, localTaxMinor: 0,
        taxBaseMinor: s.net, taxRateBps: rateBps, taxMinor: s.tax, roundingMinor: 0, totalMinor: s.total,
        detail: inclusive ? { inclusive: true, grossMinor: s.total } : {},
      };
    },
    computeFee(i) {
      if (!i.registered) return { netMinor: i.amountMinor, taxBaseMinor: 0, taxMinor: 0, totalMinor: i.amountMinor, taxRateBps: 0 };
      const s = split(i.amountMinor, i.inclusive === true);
      return { netMinor: s.net, taxBaseMinor: s.net, taxMinor: s.tax, totalMinor: s.total, taxRateBps: rateBps };
    },
    invoiceTotals(i) {
      const tax = Math.round((i.taxableMinor * rateBps) / 10_000);
      return { taxBaseMinor: i.taxableMinor, taxMinor: tax, totalMinor: i.taxableMinor + i.untaxedMinor + tax };
    },
    ocpiVatPercent: () => rateBps / 100,
    labels,
  };
}

export const sgLabels = (rateBps: number) => (lang: 'id' | 'en'): TaxLabels => ({
  tax: `GST ${rateBps / 100}%`,
  localTax: null,
  taxBase: lang === 'id' ? 'Harga sebelum GST' : 'Price before GST',
  noTax: lang === 'id' ? 'Tidak terdaftar GST' : 'Not GST-registered',
  inclusiveNote: lang === 'id' ? `Harga sudah termasuk GST ${rateBps / 100}%` : `Prices include ${rateBps / 100}% GST`,
});

export const myLabels = (rateBps: number) => (lang: 'id' | 'en'): TaxLabels => ({
  tax: lang === 'id' ? `Pajak layanan ${rateBps / 100}%` : `Service tax ${rateBps / 100}%`,
  localTax: null,
  taxBase: null,
  noTax: lang === 'id' ? 'Tanpa pajak' : 'No tax charged',
  inclusiveNote: lang === 'id' ? `Harga sudah termasuk pajak layanan ${rateBps / 100}%` : `Prices include ${rateBps / 100}% service tax`,
});
