import { one, many, query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { COUNTRIES, COUNTRY_CODES, isCountry, type CountryCode } from '../domain/country.js';
import { isValidTimezoneFor, defaultTimezone } from '../domain/timezone.js';
import { isLang } from '../domain/locale.js';

/**
 * An organisation's country settings (docs/MULTI-COUNTRY-DESIGN.md §D1, §D10): its home
 * country (default for new sites, the eMSP identity, the console language), its reporting
 * time zone (statements, alerts, the console's times) and default language, and its tax
 * registrations per country:
 *
 *   ID  ID_PKP   PKP (PPN) — mirrored to organisation.pkp / npwp, which Indonesian billing reads (v1.6)
 *   MY  MY_SST   service tax; charged on EV charging only when "EV charging taxable" is set [VERIFY V1]
 *   SG  SG_GST   GST 9 %, GST-inclusive consumer prices
 *
 * A registration is effective-dated: a change closes the open row (effective_to) and opens a
 * new one, so a CDR is always taxed with the registration in force on its supply date.
 */

export class OrgSettingsError extends Error {
  constructor(public status: number, message: string, public errors?: Record<string, string>) { super(message); }
}

const SCHEME: Record<CountryCode, 'ID_PKP' | 'MY_SST' | 'SG_GST'> = { ID: 'ID_PKP', MY: 'MY_SST', SG: 'SG_GST' };
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface TaxRegistration {
  id: string; countryCode: CountryCode; scheme: string; registrationNo: string | null; registered: boolean;
  evChargingTaxable: boolean; rateBps: number | null; effectiveFrom: string; effectiveTo: string | null; createdAt: Date; createdBy: string | null;
}

export async function getOrgSettings(orgId: string) {
  const o = await one<{ name: string; home_country_code: string; timezone: string; default_locale: string; pkp: boolean; npwp: string | null }>(
    `SELECT name, home_country_code, timezone, default_locale, pkp, npwp FROM organisation WHERE id = $1`, [orgId]);
  if (!o) throw new OrgSettingsError(404, 'organisation not found');
  const regs = await many<any>(
    `SELECT id, country_code, scheme, registration_no, registered, ev_charging_taxable, rate_bps,
            to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to, created_at, created_by
       FROM org_tax_registration WHERE org_id = $1 ORDER BY country_code, effective_from DESC`, [orgId]);
  const sites = await many<{ country_code: string; n: number }>(
    `SELECT country_code, count(*)::int AS n FROM site WHERE org_id = $1 AND archived_at IS NULL GROUP BY country_code`, [orgId]);
  return {
    name: o.name,
    homeCountry: o.home_country_code,
    timezone: o.timezone,
    defaultLocale: o.default_locale,
    multiCountry: config.features.multiCountry,
    // Indonesia's PKP status as billing reads it (organisation.pkp / npwp, set before v1.7 by the seed, the
    // installer or SQL). Without a registration row the console shows this, not "not registered" for a PKP.
    indonesiaPkp: { registered: o.pkp === true, npwp: o.npwp ?? null },
    sitesByCountry: Object.fromEntries(sites.map((s) => [s.country_code, s.n])),
    countries: COUNTRY_CODES.map((c) => ({
      code: c, name: COUNTRIES[c].name, currency: COUNTRIES[c].currency, timezones: COUNTRIES[c].timezones, scheme: SCHEME[c],
      displayPricesInclTax: COUNTRIES[c].displayPricesInclTax,
    })),
    taxRegistrations: regs.map((r): TaxRegistration => ({
      id: r.id, countryCode: r.country_code, scheme: r.scheme, registrationNo: r.registration_no, registered: r.registered,
      evChargingTaxable: r.ev_charging_taxable, rateBps: r.rate_bps, effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
      createdAt: r.created_at, createdBy: r.created_by,
    })),
  };
}

/** Home country, reporting time zone and default language. */
export async function saveOrgSettings(orgId: string, b: any) {
  const cur = await getOrgSettings(orgId);
  const errors: Record<string, string> = {};
  const home = b.homeCountry === undefined ? cur.homeCountry : String(b.homeCountry ?? '').toUpperCase();
  if (!isCountry(home)) errors.homeCountry = `Home country is one of ${COUNTRY_CODES.join(', ')}`;
  else if (home !== 'ID' && home !== cur.homeCountry && !config.features.multiCountry) errors.homeCountry = 'Malaysia and Singapore are not enabled on this platform yet (MULTI_COUNTRY).';
  const tz = b.timezone === undefined ? (home !== cur.homeCountry && isCountry(home) ? defaultTimezone(home) : cur.timezone) : String(b.timezone ?? '');
  // The reporting zone is one of the zones of a country the organisation is in (its home country, or a country of its sites).
  const zoneCountries = [home, ...Object.keys(cur.sitesByCountry)].filter(isCountry);
  if (!zoneCountries.some((c) => isValidTimezoneFor(c, tz))) errors.timezone = `Choose a time zone of ${zoneCountries.map((c) => COUNTRIES[c].name).join(' or ')}`;
  const locale = b.defaultLocale === undefined ? cur.defaultLocale : String(b.defaultLocale ?? '');
  if (!isLang(locale)) errors.defaultLocale = 'Language is id (Indonesian) or en (English)';
  if (Object.keys(errors).length) throw new OrgSettingsError(422, 'Check the highlighted fields', errors);
  await query(`UPDATE organisation SET home_country_code = $2, timezone = $3, default_locale = $4 WHERE id = $1`, [orgId, home, tz, locale]);
  (await import('./org-timezone.js')).invalidateOrgZones(orgId);
  return { before: { homeCountry: cur.homeCountry, timezone: cur.timezone, defaultLocale: cur.defaultLocale }, after: await getOrgSettings(orgId) };
}

/**
 * Record a tax registration in a country from a date (the open one there ends that day).
 * `registered: false` records that the organisation is NOT registered from that date.
 */
export async function setTaxRegistration(orgId: string, b: any, actor: string) {
  const errors: Record<string, string> = {};
  const country = String(b.countryCode ?? '').toUpperCase();
  if (!isCountry(country)) throw new OrgSettingsError(422, `Country is one of ${COUNTRY_CODES.join(', ')}`, { countryCode: 'Choose a country' });
  const scheme = SCHEME[country];
  const registered = b.registered !== false;
  const no = b.registrationNo == null ? null : String(b.registrationNo).trim().slice(0, 40) || null;
  if (registered && !no) errors.registrationNo = country === 'ID' ? 'Enter the NPWP' : country === 'SG' ? 'Enter the GST registration number' : 'Enter the SST registration number';
  if (no && country === 'ID' && !/^\d{15,16}$/.test(no.replace(/\D/g, ''))) errors.registrationNo = 'NPWP has 15 or 16 digits';
  if (no && country === 'SG' && !/^[A-Z0-9-]{8,12}$/i.test(no)) errors.registrationNo = 'A GST registration number looks like M90000000X or 200012345A';
  if (no && country === 'MY' && !/^[A-Z0-9-]{6,20}$/i.test(no)) errors.registrationNo = 'An SST registration number looks like W10-1808-31000015';
  const from = b.effectiveFrom == null || b.effectiveFrom === '' ? null : String(b.effectiveFrom);
  if (!from || !YMD.test(from)) errors.effectiveFrom = 'Effective from is a date (YYYY-MM-DD)';
  let rateBps: number | null = null;
  if (b.rateBps != null && b.rateBps !== '') {
    rateBps = Number(b.rateBps);
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 3000) errors.rateBps = 'The rate is 0–3000 basis points (900 = 9 %)';
  }
  if (country !== 'MY' && b.evChargingTaxable === false) errors.evChargingTaxable = 'Only a Malaysian registration has this choice';
  if (Object.keys(errors).length) throw new OrgSettingsError(422, 'Check the highlighted fields', errors);
  const evTaxable = country === 'MY' ? b.evChargingTaxable === true : true;
  return tx(async () => {
    const open = await one<{ id: string; effective_from: string }>(
      `SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from FROM org_tax_registration
        WHERE org_id = $1 AND country_code = $2 AND scheme = $3 AND effective_to IS NULL FOR UPDATE`, [orgId, country, scheme]);
    if (open && open.effective_from >= from!) {
      throw new OrgSettingsError(409, `The registration in force starts ${open.effective_from}: a change takes effect after that date.`, { effectiveFrom: `After ${open.effective_from}` });
    }
    if (open) await query(`UPDATE org_tax_registration SET effective_to = $2 WHERE id = $1`, [open.id, from]);
    const r = await one<{ id: string }>(
      `INSERT INTO org_tax_registration (org_id, country_code, scheme, registration_no, registered, ev_charging_taxable, rate_bps, effective_from, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [orgId, country, scheme, no, registered, evTaxable, rateBps, from, actor]);
    // Indonesia: billing reads organisation.pkp / npwp (v1.6); keep them in step with the registration in force today.
    if (country === 'ID' && from! <= new Date().toISOString().slice(0, 10)) {
      await query(`UPDATE organisation SET pkp = $2, npwp = COALESCE($3, npwp) WHERE id = $1`, [orgId, registered, no ? no.replace(/\D/g, '') : null]);
    }
    return { id: r!.id, country, scheme, closed: open?.id ?? null };
  });
}
