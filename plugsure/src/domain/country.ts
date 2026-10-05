import type { CurrencyCode } from './money.js';

/**
 * Countries PlugSure operates in (docs/MULTI-COUNTRY-DESIGN.md §D1, §5.1).
 *
 * Country is a property of the SITE (organisation home country = the default);
 * its currency, time zones, tax engine and regulatory profile follow from it.
 * The `country` / `currency_unit` tables (migration 059) hold the same codes for
 * foreign keys and SQL reports; the behaviour lives here.
 *
 * Amounts are in PlugSure minor units of the country's currency (domain/money.ts):
 * IDR whole rupiah, MYR sen, SGD cents.
 */

export type CountryCode = 'ID' | 'MY' | 'SG';
export type TaxScheme = 'ID_PPN_PBJT' | 'MY_SST' | 'SG_GST' | 'NONE';
export type RegulatoryProfileCode = 'ID' | 'MY' | 'SG';

export interface CountryProfile {
  code: CountryCode;
  alpha3: string;
  name: string;
  currency: CurrencyCode;
  /** IANA zones allowed for a site; the first is the default. */
  timezones: readonly string[];
  phoneCc: string;
  /** A mobile number as people write it there (form placeholders). */
  phoneExample: string;
  postalCodeRe: RegExp;
  postalCodeHint: string;
  /** Plausibility box for a site's coordinates. */
  latLonBox: { latMin: number; latMax: number; lonMin: number; lonMax: number };
  defaultLocale: 'id' | 'en';
  taxEngine: Exclude<TaxScheme, 'NONE'>;
  regulatoryProfile: RegulatoryProfileCode;
  /** Consumer prices shown tax-inclusive (SG: IRAS rule; MY: consumer clarity; ID: no). */
  displayPricesInclTax: boolean;
  prepaidPresetsMinor: readonly number[];
  /** Largest pre-purchase (ID: the QRIS transaction cap). */
  maxPrepaidMinor: number;
  /** Invoice vs collected difference below which a prepaid session settles silently. */
  settlementToleranceMinor: number;
  /** Rounding step for live cost estimates. */
  estimateStepMinor: number;
  /** eMSP CDR plausibility cap, MAJOR units per kWh. */
  cdrMaxPricePerKwhMajor: number;
  reservationFeeMaxMinor: number;
  v2xCreditMaxMinorPerKwh: number;
  roamingHoldDefaultMinor: number;
  /** Post-pay per-session default limit; null = post-pay not offered. */
  postpayLimitDefaultMinor: number | null;
}

export const COUNTRIES: Readonly<Record<CountryCode, CountryProfile>> = Object.freeze({
  ID: {
    code: 'ID', alpha3: 'IDN', name: 'Indonesia', currency: 'IDR',
    timezones: ['Asia/Jakarta', 'Asia/Pontianak', 'Asia/Makassar', 'Asia/Jayapura'],
    phoneCc: '62', phoneExample: '+62 812 3456 7890', postalCodeRe: /^\d{5}$/, postalCodeHint: 'Indonesian postal codes are 5 digits',
    latLonBox: { latMin: -11.5, latMax: 6.5, lonMin: 94, lonMax: 141.5 },
    defaultLocale: 'id', taxEngine: 'ID_PPN_PBJT', regulatoryProfile: 'ID', displayPricesInclTax: false,
    prepaidPresetsMinor: [50_000, 100_000, 150_000, 200_000, 300_000, 500_000],
    maxPrepaidMinor: 10_000_000, settlementToleranceMinor: 1_000, estimateStepMinor: 500,
    cdrMaxPricePerKwhMajor: 25_000, reservationFeeMaxMinor: 100_000, v2xCreditMaxMinorPerKwh: 20_000,
    roamingHoldDefaultMinor: 300_000, postpayLimitDefaultMinor: 200_000,
  },
  MY: {
    code: 'MY', alpha3: 'MYS', name: 'Malaysia', currency: 'MYR',
    timezones: ['Asia/Kuala_Lumpur', 'Asia/Kuching'],
    phoneCc: '60', phoneExample: '+60 12 345 6789', postalCodeRe: /^\d{5}$/, postalCodeHint: 'Malaysian postcodes are 5 digits',
    latLonBox: { latMin: 0.8, latMax: 7.5, lonMin: 99.5, lonMax: 119.5 },
    defaultLocale: 'en', taxEngine: 'MY_SST', regulatoryProfile: 'MY', displayPricesInclTax: true,
    prepaidPresetsMinor: [1_000, 2_000, 3_000, 5_000, 10_000],
    maxPrepaidMinor: 100_000, settlementToleranceMinor: 20, estimateStepMinor: 10,
    cdrMaxPricePerKwhMajor: 10, reservationFeeMaxMinor: 2_000, v2xCreditMaxMinorPerKwh: 500,
    roamingHoldDefaultMinor: 10_000, postpayLimitDefaultMinor: null,
  },
  SG: {
    code: 'SG', alpha3: 'SGP', name: 'Singapore', currency: 'SGD',
    timezones: ['Asia/Singapore'],
    phoneCc: '65', phoneExample: '+65 8123 4567', postalCodeRe: /^\d{6}$/, postalCodeHint: 'Singapore postal codes are 6 digits',
    latLonBox: { latMin: 1.15, latMax: 1.48, lonMin: 103.6, lonMax: 104.1 },
    defaultLocale: 'en', taxEngine: 'SG_GST', regulatoryProfile: 'SG', displayPricesInclTax: true,
    prepaidPresetsMinor: [1_000, 2_000, 3_000, 5_000, 8_000],
    maxPrepaidMinor: 50_000, settlementToleranceMinor: 10, estimateStepMinor: 10,
    cdrMaxPricePerKwhMajor: 5, reservationFeeMaxMinor: 2_000, v2xCreditMaxMinorPerKwh: 500,
    roamingHoldDefaultMinor: 8_000, postpayLimitDefaultMinor: null,
  },
});

export const COUNTRY_CODES = Object.keys(COUNTRIES) as CountryCode[];

export function isCountry(x: unknown): x is CountryCode {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(COUNTRIES, x);
}

/** Throws on an unknown country (fail closed). */
export function assertCountry(x: unknown): CountryCode {
  if (!isCountry(x)) throw new Error(`unsupported country ${JSON.stringify(x)}`);
  return x;
}

/** The profile of a country code; absent (a pre-1.7 row) means Indonesia. */
export function countryOf(code: string | null | undefined): CountryProfile {
  return COUNTRIES[assertCountry(code ?? 'ID')];
}

export const currencyOfCountry = (code: string | null | undefined): CurrencyCode => countryOf(code).currency;

/** The country whose currency this is (each supported currency has exactly one). */
export function countryOfCurrency(cur: string): CountryProfile | null {
  return Object.values(COUNTRIES).find((c) => c.currency === cur) ?? null;
}

/** eMSP CDR plausibility cap for a currency (major units per kWh); null = unknown currency. */
export function cdrMaxPricePerKwh(cur: string | null | undefined): number | null {
  return cur ? countryOfCurrency(cur)?.cdrMaxPricePerKwhMajor ?? null : null;
}
