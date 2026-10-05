import { countryOf, type CountryCode } from '../../domain/country.js';
import { ID_PROFILE } from './id.js';
import { MY_PROFILE, SG_PROFILE } from './open.js';
import type { RegulatoryProfile } from './types.js';

/**
 * Regulatory profiles per country (docs/MULTI-COUNTRY-DESIGN.md §D4).
 *
 * | Hook              | ID                                   | MY / SG                     |
 * |-------------------|--------------------------------------|-----------------------------|
 * | validateTariff    | PLN ranges, energy + fee ceilings    | time-fee bound + idle cap   |
 * | caps in rating    | service-fee cap line, idle cap line  | idle cap line               |
 * | formula rate      | PLN                                  | none (refused)              |
 * | ToU               | WBP 17:00–22:00 / LWBP               | explicit windows only       |
 * | connectorMaySell  | tera status                          | always                      |
 */
export * from './types.js';
export { usesFormulaRate, priceText, amountText } from './common.js';
export { plnEnergyRate, validateMultiplier, serviceFeeCeiling, regulatedEnergyCeiling, ID_PROFILE } from './id.js';
export { MY_PROFILE, SG_PROFILE } from './open.js';

const PROFILES: Record<CountryCode, RegulatoryProfile> = { ID: ID_PROFILE, MY: MY_PROFILE, SG: SG_PROFILE };

/** The profile of a country (absent = Indonesia, every pre-1.7 tariff and site). */
export function profileFor(country: string | null | undefined): RegulatoryProfile {
  return PROFILES[countryOf(country).regulatoryProfile];
}
