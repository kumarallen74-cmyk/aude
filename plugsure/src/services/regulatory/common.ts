import { formatMoney, moneyText, rateToMinor, unitOf, type CurrencyCode } from '../../domain/money.js';
import type { RegulatoryFlag, TariffLike } from './types.js';

/**
 * Is this energy component billed at the formula rate? Only when it says so
 * (formulaRate) or carries no rate. Typed as number, a rate can still arrive as
 * null/undefined from JSON (the API, a stored tariff snapshot).
 */
export function usesFormulaRate(c: { rate: number; formulaRate?: boolean }): boolean {
  return c.formulaRate === true || c.rate == null;
}

/** A price as the v1.6 messages wrote it for IDR ("Rp 2.467,5"), else formatMoney in English. */
export function priceText(major: number, cur: CurrencyCode): string {
  if (unitOf(cur).exponent === 0) return moneyText(major, cur, 'rate');
  // Rates may carry fractions of a sen: up to 4 decimals, at least the currency's own.
  const minorUnits = rateToMinor(major, cur);
  const decimals = Number.isInteger(minorUnits) ? undefined : Math.min(4, Math.max(2, (String(major).split('.')[1] ?? '').length));
  return formatMoney(minorUnits, cur, 'en', decimals != null ? { decimals } : {});
}
/** An amount in minor units, in the same style. */
export function amountText(minor: number, cur: CurrencyCode): string {
  return moneyText(minor, cur, 'rate');
}

/** Only an energy component may leave its rate out; anything else without a price cannot be billed. */
export function rateMissingFlags(t: TariffLike): RegulatoryFlag[] {
  const flags: RegulatoryFlag[] = [];
  for (const c of t.components) {
    if (c.kind !== 'energy' && (c.rate == null || !Number.isFinite(Number(c.rate)))) {
      flags.push({ code: 'RATE_MISSING', severity: 'violation', message: `The ${c.kind} component has no rate.` });
    }
  }
  return flags;
}

/**
 * Occupancy charges are commercially distinct from a service fee, but they are
 * per-minute and were unbounded: an abandoned vehicle on the shipped seed tariff
 * accrued Rp 6,692,360. Require an explicit upper bound and check the worst case
 * against the platform cap (in minor units of the tariff's currency).
 */
export function genericTimeFeeFlags(t: TariffLike, cur: CurrencyCode, capMinor: number): RegulatoryFlag[] {
  const flags: RegulatoryFlag[] = [];
  const capEnv = `IDLE_FEE_CAP_${cur}`;
  for (const c of t.components) {
    if (c.kind !== 'idle' && c.kind !== 'time') continue;
    if (c.toMinutes == null) {
      flags.push({
        code: 'UNBOUNDED_TIME_FEE',
        severity: 'violation',
        message:
          `The ${c.kind} component charges ${priceText(c.rate, cur)}/min with no to_minutes bound. ` +
          `Set an upper bound so the worst-case charge is knowable before it is billed.`,
      });
      continue;
    }
    // Not rounded: a worst case a fraction above the cap is above it.
    const worst = Math.max(0, c.toMinutes - (c.fromMinutes ?? 0)) * rateToMinor(c.rate, cur);
    if (worst > capMinor) {
      flags.push({
        code: 'TIME_FEE_CAP_EXCEEDED',
        severity: 'violation',
        message:
          `The ${c.kind} component tops out at ${amountText(worst, cur)} per session, above the ` +
          `${amountText(capMinor, cur)} platform cap. Lower the rate, narrow the window, or raise ` +
          `${capEnv} deliberately.`,
      });
    }
  }
  return flags;
}

/**
 * Overlapping ToU coverage. A kWh in a block priced by BOTH a block-specific
 * component and the ANY catch-all used to be billed twice; rating now lets the
 * specific component win, but the tariff is still ambiguous as written and the
 * operator should be told at save time rather than discovering it on an invoice.
 */
export function ambiguousTouFlag(t: TariffLike): RegulatoryFlag | null {
  const blocks = new Set(t.components.filter((c) => c.kind === 'energy').map((c) => c.touBlock));
  if (blocks.has('ANY') && (blocks.has('WBP') || blocks.has('LWBP'))) {
    return {
      code: 'AMBIGUOUS_TOU_COVERAGE',
      severity: 'warning',
      message:
        `Energy is priced both for a specific ToU block and by an ANY component. The ` +
        `block-specific price applies and ANY covers only the remaining blocks; state both ` +
        `blocks explicitly if that is not what you meant.`,
    };
  }
  return null;
}
