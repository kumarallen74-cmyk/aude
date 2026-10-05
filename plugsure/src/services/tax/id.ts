import { config } from '../../config.js';
import type { TaxResult, TaxEngine, FeeTaxInput, FeeTaxResult, InvoiceTaxInput, InvoiceTaxResult, TaxLabels } from './types.js';

/**
 * ID_PPN_PBJT — the Indonesian tax stack for a charging session (the v1.6
 * services/tax.ts, moved verbatim behind the TaxEngine interface: the arithmetic
 * and the rounding are unchanged, and the golden tests prove it).
 *
 * A single retail session can carry five layers:
 *   1. Energy       kWh x rate
 *   2. Service fee  per session (regulated ceiling by charging class)
 *   3. Admin fee    operator discretion
 *   4. PBJT         up to 10%, SET PER KABUPATEN/KOTA — never a national constant
 *   5. PPN          12% on DPP nilai lain = 11/12 x price  → 11% effective
 *
 * The PPN arithmetic must follow the regulation EXACTLY. Applying 11% directly
 * gives the right total but the wrong DPP on the faktur pajak, which fails an
 * audit. Getting the arithmetic right but the document wrong is still a failure.
 */

export interface TaxInput {
  /** Sum of all pre-tax charge lines, in whole rupiah. */
  subtotalMinor: number;
  /** Per-municipality PBJT rate in basis points. 500 = 5%. */
  localTaxRateBps: number;
  /**
   * The energy portion of the subtotal, in whole rupiah.
   *
   * PBJT is *pajak barang dan jasa tertentu atas tenaga listrik* — a tax on
   * ELECTRICITY consumption (UU 1/2022, PP 35/2023). A service fee and an admin
   * fee are not tenaga listrik, and levying PBJT on them overcharged every
   * invoice: Rp 1,387 on a 40 kWh session, which is Rp 1.4M a day at a thousand
   * sessions, and every figure downstream — DPP, PPN, the faktur pajak — inherits
   * the error.
   *
   * Which base is correct is a question for a tax advisor, so it is a deliberate
   * configuration choice rather than a silent assumption in the arithmetic; when
   * this is omitted the whole subtotal is used, which is the previous behaviour.
   */
  energyMinor?: number;
  /** False only for a non-PKP operator's tariff. Omitted = true (the pre-009 behaviour). */
  ppnApplies?: boolean;
}

const round = (n: number) => Math.round(n);

export function computeTax(input: TaxInput): TaxResult {
  const { ppnRateBps, ppnDppNumerator, ppnDppDenominator, pbjtInsidePpnBase, roundingUnitIdr } =
    config.tax.id;

  const localTaxRateBps = clampBps(input.localTaxRateBps);
  const subtotalMinor = round(input.subtotalMinor);

  // PBJT applies to electricity. `pbjtBase` selects whether that means the
  // energy lines alone (the reading of UU 1/2022 we believe is correct) or the
  // whole subtotal (what shipped). VERIFY with a tax advisor before go-live.
  const pbjtBase =
    config.tax.id.pbjtBase === 'energy' && input.energyMinor != null
      ? round(input.energyMinor)
      : subtotalMinor;
  const localTaxMinor = round((pbjtBase * localTaxRateBps) / 10_000);

  // Market practice applies PPN last, on the PBJT-inclusive amount. Configurable
  // because the treatment is not unambiguous in the sources we could reach.
  const ppnBase = pbjtInsidePpnBase ? subtotalMinor + localTaxMinor : subtotalMinor;

  const ppnApplies = input.ppnApplies !== false;
  const taxBaseMinor = ppnApplies ? round((ppnBase * ppnDppNumerator) / ppnDppDenominator) : 0;
  const taxMinor = ppnApplies ? round((taxBaseMinor * ppnRateBps) / 10_000) : 0;

  // Rounding the total to a cash unit is a separate, stated adjustment: rounding
  // the total alone left a receipt whose subtotal, PBJT and PPN did not add up to
  // what the driver paid.
  const exactMinor = subtotalMinor + localTaxMinor + taxMinor;
  const totalMinor = roundingUnitIdr > 1 ? Math.round(exactMinor / roundingUnitIdr) * roundingUnitIdr : exactMinor;

  return {
    scheme: 'ID_PPN_PBJT',
    pricesIncludeTax: false,
    subtotalMinor,
    localTaxBaseMinor: pbjtBase,
    localTaxRateBps,
    localTaxMinor,
    taxBaseMinor,
    taxRateBps: ppnApplies ? ppnRateBps : 0,
    taxMinor,
    roundingMinor: totalMinor - exactMinor,
    totalMinor,
    detail: ppnApplies
      ? { dppFraction: `${ppnDppNumerator}/${ppnDppDenominator}`, localTaxBase: config.tax.id.pbjtBase, localTaxInTaxBase: pbjtInsidePpnBase }
      : { dppFraction: `${ppnDppNumerator}/${ppnDppDenominator}`, localTaxBase: config.tax.id.pbjtBase, ppnApplies: false },
  };
}

export function clampBps(bps: number): number {
  const max = config.regulatory.id.pbjtMaxBps;
  if (!Number.isFinite(bps) || bps < 0) return 0;
  return Math.min(Math.round(bps), max);
}

/**
 * Effective PPN rate, for display only. Never use this to compute the DPP.
 */
export function effectivePpnRateBps(): number {
  const { ppnRateBps, ppnDppNumerator, ppnDppDenominator } = config.tax.id;
  return Math.round((ppnRateBps * ppnDppNumerator) / ppnDppDenominator);
}

/**
 * PPN on a non-session supply (reservation fee, 30-day pass, membership fee):
 * DPP 11/12 of the fee, PPN 12 % of the DPP, when the operator is PKP. The v1.6
 * `PKP_TAX` of services/benefits.ts, verbatim.
 */
export function pkpFeeTax(fee: number, pkp: boolean): { dpp: number; ppn: number; total: number } {
  if (!pkp) return { dpp: 0, ppn: 0, total: fee };
  const dpp = Math.round((fee * config.tax.id.ppnDppNumerator) / config.tax.id.ppnDppDenominator);
  const ppn = Math.round((dpp * config.tax.id.ppnRateBps) / 10_000);
  return { dpp, ppn, total: fee + ppn };
}

/** PPN as the percentage a driver effectively pays: 12 % of DPP 11/12 = 11 % (OCPI `vat`). */
export function effectiveVatPercent(ppnApplies: boolean | undefined): number {
  if (ppnApplies === false) return 0;
  const { ppnRateBps, ppnDppNumerator, ppnDppDenominator } = config.tax.id;
  return Math.round((ppnRateBps / 100) * (ppnDppNumerator / ppnDppDenominator) * 100) / 100;
}

export const ID_ENGINE: TaxEngine = {
  scheme: 'ID_PPN_PBJT',
  computeSession: (i) =>
    computeTax({ subtotalMinor: i.subtotalMinor, energyMinor: i.energyMinor, localTaxRateBps: i.localTaxRateBps ?? 0, ppnApplies: i.ppnApplies }),
  computeFee(i: FeeTaxInput): FeeTaxResult {
    const t = pkpFeeTax(i.amountMinor, i.registered);
    return { netMinor: i.amountMinor, taxBaseMinor: t.dpp, taxMinor: t.ppn, totalMinor: t.total, taxRateBps: i.registered ? config.tax.id.ppnRateBps : 0 };
  },
  invoiceTotals(i: InvoiceTaxInput): InvoiceTaxResult {
    // Fleet invoices: DPP 11/12 and PPN 12 % on the SUM of the taxable lines (Indonesian practice).
    const dpp = Math.round((i.taxableMinor * config.tax.id.ppnDppNumerator) / config.tax.id.ppnDppDenominator);
    const ppn = Math.round((dpp * config.tax.id.ppnRateBps) / 10_000);
    return { taxBaseMinor: dpp, taxMinor: ppn, totalMinor: i.taxableMinor + i.untaxedMinor + ppn };
  },
  ocpiVatPercent: (ppnApplies) => effectiveVatPercent(ppnApplies),
  labels(lang): TaxLabels {
    return lang === 'id'
      ? { tax: 'PPN', localTax: 'PBJT-TL', taxBase: 'DPP', noTax: 'Tanpa PPN', inclusiveNote: null }
      : { tax: 'PPN (VAT)', localTax: 'PBJT-TL (regional electricity tax)', taxBase: 'DPP', noTax: 'No PPN', inclusiveNote: null };
  },
};
