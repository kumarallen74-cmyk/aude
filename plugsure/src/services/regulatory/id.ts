import { config } from '../../config.js';
import type { ChargingClass } from '../../domain/spklu.js';
import { chargingClassForPowerW } from '../../domain/spklu.js';
import { connectorMaySellEnergy, type TeraStatus } from '../compliance.js';
import type { RegulatoryProfile, RegulatoryFlag, TariffLike } from './types.js';
import { usesFormulaRate, genericTimeFeeFlags, ambiguousTouFlag, rateMissingFlags } from './common.js';

/**
 * Indonesia: PLN formula tariffs and ceilings, Kepmen ESDM 182.K/2023 service-fee
 * caps, tera (meter verification) blocking, WBP/LWBP time of use. The v1.6 code of
 * services/tariff.ts, moved here unchanged (messages included).
 */

/** Resolve the regulated energy rate from the PLN multiplier formula. */
export function plnEnergyRate(t: Pick<TariffLike, 'plnScheme' | 'plnBaseRate' | 'plnMultiplier'>): number | null {
  if (!t.plnScheme || t.plnScheme === 'none') return null;
  const base =
    t.plnBaseRate ??
    (t.plnScheme === 'curah' ? config.regulatory.id.curahBase : config.regulatory.id.layananKhususBase);
  const mult = t.plnMultiplier ?? 1;
  return base * mult;
}

export function validateMultiplier(scheme: 'curah' | 'layanan_khusus', multiplier: number): RegulatoryFlag[] {
  const flags: RegulatoryFlag[] = [];
  const r = config.regulatory.id;
  if (scheme === 'curah' && (multiplier < r.curahQMin || multiplier > r.curahQMax)) {
    flags.push({
      code: 'PLN_Q_OUT_OF_RANGE',
      severity: 'violation',
      message: `Curah multiplier Q=${multiplier} is outside the regulated range ${r.curahQMin}-${r.curahQMax}.`,
    });
  }
  if (scheme === 'layanan_khusus' && (multiplier < 1 || multiplier > r.layananKhususNMax)) {
    flags.push({
      code: 'PLN_N_OUT_OF_RANGE',
      severity: 'violation',
      message: `Layanan khusus multiplier N=${multiplier} is outside the regulated range 1.0-${r.layananKhususNMax}. Values outside the range require Director-General approval.`,
    });
  }
  return flags;
}

/** Service-fee ceiling per session for a charging class, or null when unregulated. */
export function serviceFeeCeiling(cls: ChargingClass): number | null {
  return config.regulatory.id.serviceFeeCeilingIdr[cls];
}

/**
 * The regulated ceiling on the per-kWh price, in IDR.
 *
 * `plnScheme` used to gate this: setting it to `'none'` removed the ceiling
 * entirely, and a tariff at Rp 10,000/kWh — four times the legal maximum —
 * saved and billed with no flag at all. But the scheme is a property of the
 * SUPPLY, not a field the tariff author gets to opt out of. A public SPKLU in
 * Indonesia sells under layanan khusus unless it is genuinely on curah, so an
 * unstated scheme resolves to layanan khusus rather than to "unregulated".
 */
export function regulatedEnergyCeiling(t: Pick<TariffLike, 'plnScheme' | 'plnBaseRate'>): number {
  if (t.plnScheme === 'curah') {
    return (t.plnBaseRate ?? config.regulatory.id.curahBase) * config.regulatory.id.curahQMax;
  }
  return (t.plnBaseRate ?? config.regulatory.id.layananKhususBase) * config.regulatory.id.layananKhususNMax;
}

const fmt = (n: number) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(n);

/**
 * Validate an Indonesian tariff against the regulatory ceilings (the v1.6
 * validateTariff, flag for flag and in the same order).
 */
function validateIdTariff(t: TariffLike, connectorMaxPowerW: number): RegulatoryFlag[] {
  const flags: RegulatoryFlag[] = [];
  const cls = chargingClassForPowerW(connectorMaxPowerW);

  if (t.plnScheme && t.plnScheme !== 'none' && t.plnMultiplier != null) {
    flags.push(...validateMultiplier(t.plnScheme, t.plnMultiplier));
  }

  flags.push(...rateMissingFlags(t));

  const ceiling = serviceFeeCeiling(cls);
  if (ceiling != null) {
    // The ceiling caps the charge for the charging SERVICE, not just the
    // component that happens to be named "session". An "admin fee" levied on
    // every session is the same charge under another name, and excluding it was
    // a loophole wide enough to drive the whole fee through.
    const serviceFees = t.components
      .filter((c) => c.kind === 'session' || c.kind === 'admin')
      .reduce((a, c) => a + c.rate, 0);
    if (serviceFees > ceiling) {
      flags.push({
        code: 'SERVICE_FEE_CEILING_EXCEEDED',
        severity: 'violation',
        message:
          `Service + admin fees total Rp ${fmt(serviceFees)}, above the Rp ${fmt(ceiling)} ceiling ` +
          `for ${cls} charging (Kepmen ESDM 182.K/2023).`,
      });
    }
  }

  flags.push(...genericTimeFeeFlags(t, 'IDR', config.regulatory.id.idleFeeCapIdr));

  // The regulated ceiling applies to the rate actually billed per kWh, which is
  // the `energy` component — not to `base × multiplier`, which can only fail
  // when the multiplier is already out of range and validateMultiplier has
  // caught it. That made this check structurally unable to fire.
  const maxEnergy = regulatedEnergyCeiling(t);
  const formulaRate = plnEnergyRate(t) ?? 0;
  const billed = t.components.filter((c) => c.kind === 'energy').map((c) => (usesFormulaRate(c) ? formulaRate : c.rate));
  const worst = billed.length ? Math.max(...billed) : null;
  if (worst != null && worst > maxEnergy + 0.001) {
    flags.push({
      code: 'ENERGY_CEILING_EXCEEDED',
      severity: 'violation',
      message:
        `Energy rate Rp ${fmt(worst)}/kWh exceeds the ` +
        `${t.plnScheme === 'curah' ? 'curah' : 'layanan khusus'} ceiling of Rp ${fmt(maxEnergy)}/kWh ` +
        `(${(worst / maxEnergy).toFixed(2)}×).` +
        (t.plnScheme === 'none' || !t.plnScheme
          ? ' A tariff with no declared PLN scheme is still bound by the layanan khusus ceiling — ' +
            'the scheme is a property of the supply, not something a tariff opts out of.'
          : ''),
    });
  }

  const amb = ambiguousTouFlag(t);
  if (amb) flags.push(amb);
  return flags;
}

export const ID_PROFILE: RegulatoryProfile = {
  code: 'ID',
  hasTou: true,
  validateTariff: validateIdTariff,
  formulaEnergyRate: plnEnergyRate,
  energyCeiling: regulatedEnergyCeiling,
  serviceFeeCeilingMinor: serviceFeeCeiling,
  ratingFlags(t) {
    return t.plnScheme && t.plnScheme !== 'none' && t.plnMultiplier != null ? validateMultiplier(t.plnScheme, t.plnMultiplier) : [];
  },
  idleFeeCapMinor: () => config.regulatory.id.idleFeeCapIdr,
  connectorMaySell: (tera) => connectorMaySellEnergy(tera as TeraStatus),
  siteFields: ['kabupatenKotaCode', 'spkluId', 'spkluScheme', 'sloNumber', 'sloIssuer', 'sloIssuedAt', 'sloExpiresAt', 'localTaxRateBps', 'gridTariffGroup'],
};
