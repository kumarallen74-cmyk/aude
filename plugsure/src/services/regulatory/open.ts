import { config } from '../../config.js';
import { currencyOr, LEGACY_CURRENCY, type CurrencyCode } from '../../domain/money.js';
import type { RegulatoryProfile, RegulatoryFlag, TariffLike } from './types.js';
import { genericTimeFeeFlags, rateMissingFlags, usesFormulaRate } from './common.js';

/**
 * Malaysia and Singapore: no price regulation of EV charging (MY-3: CPOs set rates
 * on commercial terms; SG: none in the EV Charging Act / LTA licence conditions).
 * Only PlugSure's platform safety caps apply: a bounded, capped occupancy fee. No
 * PLN formula, no WBP/LWBP blocks (explicit time windows only), no tera blocking
 * (an LTA registration mark / EVCS reference is informational this phase).
 */
function validateOpenTariff(code: 'MY' | 'SG') {
  return (t: TariffLike): RegulatoryFlag[] => {
    const cur: CurrencyCode = currencyOr(t.currency, code === 'MY' ? 'MYR' : 'SGD');
    const flags: RegulatoryFlag[] = [...rateMissingFlags(t)];
    if (t.plnScheme && t.plnScheme !== 'none') {
      flags.push({ code: 'PLN_SCHEME_NOT_APPLICABLE', severity: 'violation', message: 'PLN tariff schemes apply to Indonesian tariffs only.' });
    }
    for (const c of t.components) {
      if (c.kind === 'energy' && usesFormulaRate(c)) {
        flags.push({ code: 'FORMULA_RATE_NOT_APPLICABLE', severity: 'violation', message: 'Every energy price needs a rate: formula (PLN) rates apply to Indonesian tariffs only.' });
        break;
      }
    }
    if (t.components.some((c) => c.kind === 'energy' && c.touBlock !== 'ANY')) {
      flags.push({
        code: 'TOU_BLOCK_NOT_APPLICABLE', severity: 'violation',
        message: 'Peak / off-peak (WBP/LWBP) blocks are Indonesian; use a time window (from–to) for a time-of-day price.',
      });
    }
    flags.push(...genericTimeFeeFlags(t, cur, idleCap(cur)));
    return flags;
  };
}

const idleCap = (cur: CurrencyCode): number =>
  cur === LEGACY_CURRENCY ? config.regulatory.id.idleFeeCapIdr : config.regulatory.idleFeeCap[cur as 'MYR' | 'SGD'];

function openProfile(code: 'MY' | 'SG', siteFields: string[]): RegulatoryProfile {
  return {
    code,
    hasTou: false,
    validateTariff: validateOpenTariff(code),
    formulaEnergyRate: () => null,
    energyCeiling: () => null,
    serviceFeeCeilingMinor: () => null,
    ratingFlags: () => [],
    idleFeeCapMinor: idleCap,
    connectorMaySell: () => ({ allowed: true }),
    siteFields,
  };
}

export const MY_PROFILE = openProfile('MY', ['regulatoryRef']);
export const SG_PROFILE = openProfile('SG', ['regulatoryRef']);
