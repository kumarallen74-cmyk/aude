import { one } from '../db/pool.js';
import { config } from '../config.js';
import { COUNTRIES, countryOfCurrency, isCountry } from '../domain/country.js';
import type { CurrencyCode } from '../domain/money.js';

/**
 * The time zone that decides an organisation's months and days (docs/MULTI-COUNTRY-DESIGN.md §D5, review fix 3).
 *
 *   billingZone(org, currency)   fleet invoice months, commission periods, membership/pass months, the fleet
 *                                portal's "this month": a statement in the currency of the organisation's home
 *                                country uses the organisation's zone; a statement in another country's currency
 *                                (an Indonesian operator's SGD invoice) uses that country's zone, where its sites are.
 *   alertZone(org)               quiet hours, on-call rotas and the times in alert messages.
 *
 * Indonesia is unchanged: an organisation at home in Indonesia, for rupiah, keeps the platform settings
 * (BILLING_TIMEZONE, ALERT_TIMEZONE; default WIB) exactly as v1.6 did.
 */
interface OrgZone { home: string; timezone: string | null }

const cache = new Map<string, { at: number; v: OrgZone }>();
const TTL_MS = 60_000;

async function orgZone(orgId: string | null | undefined): Promise<OrgZone> {
  if (!orgId) return { home: 'ID', timezone: null };
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const r = await one<{ home: string | null; timezone: string | null }>(
    `SELECT home_country_code AS home, timezone FROM organisation WHERE id = $1`, [orgId]).catch(() => null);
  const v = { home: r?.home && isCountry(r.home) ? r.home : 'ID', timezone: r?.timezone ?? null };
  cache.set(orgId, { at: Date.now(), v });
  return v;
}

/** Forget cached zones (an organisation's settings changed; tests). */
export function invalidateOrgZones(orgId?: string): void {
  if (orgId) cache.delete(orgId); else cache.clear();
}

/** Pure: the zone for a statement of an organisation at home in `home` (with its own zone `orgTz`), in `currency`. */
export function billingZoneFor(home: string, orgTz: string | null, currency?: CurrencyCode | null, platformTz = config.billing.timeZone): string {
  const cc = currency ? countryOfCurrency(currency)?.code ?? home : home;
  if (cc !== home) return COUNTRIES[cc as keyof typeof COUNTRIES].timezones[0]!;
  if (home === 'ID') return platformTz;
  return orgTz ?? COUNTRIES[home as keyof typeof COUNTRIES].timezones[0]!;
}

export async function billingZone(orgId: string | null | undefined, currency?: CurrencyCode | null): Promise<string> {
  const z = await orgZone(orgId);
  return billingZoneFor(z.home, z.timezone, currency);
}

export async function alertZone(orgId: string | null | undefined): Promise<string> {
  const z = await orgZone(orgId);
  if (z.home === 'ID') return config.alerts.timeZone;
  return z.timezone ?? COUNTRIES[z.home as keyof typeof COUNTRIES].timezones[0]!;
}

/** "YYYY-MM-DD" today in a zone. */
export const todayIn = (tz: string, at = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
