/**
 * Effective-dated tax rates (docs/MULTI-COUNTRY-DESIGN.md §D3).
 *
 * A future rate change is a new row here (or, for Indonesia, the same env
 * variables as before: PPN_RATE_BPS, PPN_DPP_NUM, PPN_DPP_DEN), and every CDR
 * stores the rate it was computed with, so past documents never move.
 * A registration's own `rate_bps` (org_tax_registration) overrides the default.
 */
import { config } from '../../config.js';

export interface RateRow {
  scheme: 'SG_GST' | 'MY_SST' | 'ID_PPN_PBJT';
  /** First day (inclusive, local date of the supply) the rate applies. */
  from: string;
  rateBps: number;
  /** ID only: the DPP nilai lain fraction. */
  dpp?: [number, number];
}

export const RATES: readonly RateRow[] = [
  // IRAS: 8 % from 1 Jan 2023, 9 % from 1 Jan 2024 (SG-1).
  { scheme: 'SG_GST', from: '2023-01-01', rateBps: 800 },
  { scheme: 'SG_GST', from: '2024-01-01', rateBps: 900 },
  // Service tax 6 % → 8 % from 1 Mar 2024 for most taxable services (MY-1).
  { scheme: 'MY_SST', from: '2018-09-01', rateBps: 600 },
  { scheme: 'MY_SST', from: '2024-03-01', rateBps: 800 },
  // PPN 12 % on DPP 11/12 from 1 Jan 2025 (values come from config.tax.id; this row documents them).
  { scheme: 'ID_PPN_PBJT', from: '2025-01-01', rateBps: 1200, dpp: [11, 12] },
];

/** YYYY-MM-DD of `at` in `tz` (a supply's date is local). */
function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The rate row in force for `scheme` on the local date of `at`, or null before the first row. */
export function rateRowAt(scheme: RateRow['scheme'], at: Date, tz = 'UTC', rows: readonly RateRow[] = RATES): RateRow | null {
  const day = localDate(at, tz);
  let best: RateRow | null = null;
  for (const r of rows) if (r.scheme === scheme && r.from <= day && (!best || r.from > best.from)) best = r;
  if (scheme === 'ID_PPN_PBJT') {
    // Indonesia keeps its env-configured parameters (byte-identical to v1.6).
    const c = config.tax.id;
    return { scheme, from: best?.from ?? '2025-01-01', rateBps: c.ppnRateBps, dpp: [c.ppnDppNumerator, c.ppnDppDenominator] };
  }
  return best;
}
