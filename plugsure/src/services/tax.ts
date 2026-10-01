import { config } from '../config.js';

/**
 * Indonesian tax stack for a charging session.
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
  subtotalIdr: number;
  /** Per-municipality PBJT rate in basis points. 500 = 5%. */
  pbjtRateBps: number;
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
  energyIdr?: number;
  /** False only for a non-PKP operator's tariff. Omitted = true (the pre-009 behaviour). */
  ppnApplies?: boolean;
}

export interface TaxResult {
  subtotalIdr: number;
  /** The amount PBJT was actually levied on — energy only, or the whole subtotal. */
  pbjtBaseIdr: number;
  pbjtRateBps: number;
  pbjtIdr: number;
  /** DPP nilai lain — the figure that must appear on the faktur pajak. */
  ppnDppIdr: number;
  ppnRateBps: number;
  ppnIdr: number;
  /**
   * Rounding to ROUNDING_UNIT_IDR (pembulatan): totalIdr − (subtotal + PBJT +
   * PPN), 0 when the unit is 1. A receipt shows it as its own line so the lines
   * add up to the total; the taxes themselves are never rounded to the unit.
   */
  roundingIdr: number;
  totalIdr: number;
}

const round = (n: number) => Math.round(n);

export function computeTax(input: TaxInput): TaxResult {
  const { ppnRateBps, ppnDppNumerator, ppnDppDenominator, pbjtInsidePpnBase, roundingUnitIdr } =
    config.tax;

  const pbjtRateBps = clampBps(input.pbjtRateBps);
  const subtotalIdr = round(input.subtotalIdr);

  // PBJT applies to electricity. `pbjtBase` selects whether that means the
  // energy lines alone (the reading of UU 1/2022 we believe is correct) or the
  // whole subtotal (what shipped). VERIFY with a tax advisor before go-live.
  const pbjtBase =
    config.tax.pbjtBase === 'energy' && input.energyIdr != null
      ? round(input.energyIdr)
      : subtotalIdr;
  const pbjtIdr = round((pbjtBase * pbjtRateBps) / 10_000);

  // Market practice applies PPN last, on the PBJT-inclusive amount. Configurable
  // because the treatment is not unambiguous in the sources we could reach.
  const ppnBase = pbjtInsidePpnBase ? subtotalIdr + pbjtIdr : subtotalIdr;

  const ppnApplies = input.ppnApplies !== false;
  const ppnDppIdr = ppnApplies ? round((ppnBase * ppnDppNumerator) / ppnDppDenominator) : 0;
  const ppnIdr = ppnApplies ? round((ppnDppIdr * ppnRateBps) / 10_000) : 0;

  // Rounding the total to a cash unit is a separate, stated adjustment: rounding
  // the total alone left a receipt whose subtotal, PBJT and PPN did not add up to
  // what the driver paid.
  const exactIdr = subtotalIdr + pbjtIdr + ppnIdr;
  const totalIdr = roundingUnitIdr > 1 ? Math.round(exactIdr / roundingUnitIdr) * roundingUnitIdr : exactIdr;

  return {
    subtotalIdr,
    pbjtBaseIdr: pbjtBase,
    pbjtRateBps,
    pbjtIdr,
    ppnDppIdr,
    ppnRateBps: ppnApplies ? ppnRateBps : 0,
    ppnIdr,
    roundingIdr: totalIdr - exactIdr,
    totalIdr,
  };
}

export function clampBps(bps: number): number {
  const max = config.regulatory.pbjtMaxBps;
  if (!Number.isFinite(bps) || bps < 0) return 0;
  return Math.min(Math.round(bps), max);
}

/**
 * Effective PPN rate, for display only. Never use this to compute the DPP.
 */
export function effectivePpnRateBps(): number {
  const { ppnRateBps, ppnDppNumerator, ppnDppDenominator } = config.tax;
  return Math.round((ppnRateBps * ppnDppNumerator) / ppnDppDenominator);
}
