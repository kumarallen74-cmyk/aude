import { countryOf, COUNTRIES, type CountryCode } from './country.js';

/**
 * Time zones per country (docs/MULTI-COUNTRY-DESIGN.md §D5).
 *
 * A site's zone is one of its country's zones; an organisation's reporting zone
 * defaults to its home country's first zone. The platform default (TZ, env
 * ALERT_TIMEZONE / BILLING_TIMEZONE / COMPLIANCE_TZ) applies only to
 * platform-wide work.
 */

export function validTimezones(country: CountryCode | string | null | undefined): readonly string[] {
  return countryOf(country).timezones;
}

export function defaultTimezone(country: CountryCode | string | null | undefined): string {
  return countryOf(country).timezones[0]!;
}

export function isValidTimezoneFor(country: CountryCode | string | null | undefined, tz: string): boolean {
  return validTimezones(country).includes(tz);
}

const LABELS: Record<string, string> = {
  'Asia/Jakarta': 'WIB',
  'Asia/Pontianak': 'WIB',
  'Asia/Makassar': 'WITA',
  'Asia/Jayapura': 'WIT',
  'Asia/Kuala_Lumpur': 'MYT',
  'Asia/Kuching': 'MYT',
  'Asia/Singapore': 'SGT',
};

/** WIB, WITA, WIT, MYT, SGT; any other zone is shown by its IANA name. */
export function tzLabel(tz: string): string {
  return LABELS[tz] ?? tz;
}

/** Every zone any supported country allows (for request validation). */
export const ALL_TIMEZONES: readonly string[] = [...new Set(Object.values(COUNTRIES).flatMap((c) => c.timezones))];

const PARTS = new Map<string, Intl.DateTimeFormat>();

/** Local calendar and clock fields of `d` in `tz` (all 2-digit strings, year 4). */
export function localParts(d: Date, tz: string): Record<string, string> {
  let f = PARTS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    PARTS.set(tz, f);
  }
  return Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value])) as Record<string, string>;
}

/** Offset of `tz` from UTC at `d`, in minutes (WIB +420, WITA +480, SGT +480). */
export function utcOffsetMinutes(d: Date, tz: string): number {
  const p = localParts(d, tz);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  const whole = Math.floor(d.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - whole) / 60_000);
}
