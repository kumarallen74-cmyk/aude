import type { ChargingClass } from '../../domain/spklu.js';
import type { CurrencyCode } from '../../domain/money.js';

export interface RegulatoryFlag {
  code: string;
  severity: 'info' | 'warning' | 'violation';
  message: string;
}

/** The parts of a tariff the profiles read (services/tariff.ts Tariff satisfies it). */
export interface TariffLike {
  id?: string;
  currency?: string;
  countryCode?: string;
  pricesIncludeTax?: boolean;
  plnScheme?: 'curah' | 'layanan_khusus' | 'none';
  plnBaseRate?: number;
  plnMultiplier?: number;
  components: Array<{
    kind: 'energy' | 'time' | 'session' | 'idle' | 'admin';
    rate: number;
    formulaRate?: boolean;
    touBlock: 'WBP' | 'LWBP' | 'ANY';
    fromMinutes?: number;
    toMinutes?: number;
    timeFrom?: string;
    timeTo?: string;
  }>;
}

/**
 * Tariff regulation per country (docs/MULTI-COUNTRY-DESIGN.md §D4). validateTariff
 * and rateSession call the profile of the tariff's country instead of
 * config.regulatory directly.
 */
export interface RegulatoryProfile {
  code: 'ID' | 'MY' | 'SG';
  /** WBP/LWBP time-of-use blocks exist (ID); elsewhere only explicit time windows. */
  hasTou: boolean;
  /** Save-time checks (the full list for this country, generic checks included). */
  validateTariff(t: TariffLike, connectorMaxPowerW: number): RegulatoryFlag[];
  /** Regulated formula energy rate (ID: PLN), null = formula rates refused. */
  formulaEnergyRate(t: Pick<TariffLike, 'plnScheme' | 'plnBaseRate' | 'plnMultiplier'>): number | null;
  /** Ceiling on the billed energy rate per kWh, major units; null = none. */
  energyCeiling(t: Pick<TariffLike, 'plnScheme' | 'plnBaseRate'>): number | null;
  /** Per-session service + admin fee ceiling for a charging class (minor units); null = unregulated. */
  serviceFeeCeilingMinor(cls: ChargingClass): number | null;
  /** Flags rating adds after the caps (ID: PLN multiplier range). */
  ratingFlags(t: TariffLike): RegulatoryFlag[];
  /** Platform cap on occupancy (idle / time) charges per session, minor units. */
  idleFeeCapMinor(currency: CurrencyCode): number;
  /** May a connector with this meter-verification status sell energy (ID: tera)? */
  connectorMaySell(teraStatus: string | null | undefined): { allowed: boolean; reason?: string };
  /** Country-specific site fields the console shows (and the API accepts). */
  siteFields: string[];
}
