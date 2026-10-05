import { one, many, query } from '../db/pool.js';
import { parseSpkluId, ALL_SCHEMES } from '../domain/spklu.js';
import { config } from '../config.js';
import { subscriptionCeilingW } from './smartcharging.js';
import { parseWindows, type Window } from './v2x.js';
import { COUNTRIES, COUNTRY_CODES, countryOf, isCountry, type CountryCode } from '../domain/country.js';
import { defaultTimezone, tzLabel } from '../domain/timezone.js';
import { moneyText } from '../domain/money.js';

/**
 * Electrical sites (SPEC Module 3).
 *
 * A site was previously created only by `npm run seed` or a hand-written INSERT,
 * so every new location needed an engineer with psql. This is the write path,
 * with the validation the regulator and PLN impose applied at SAVE time — the
 * same principle the tariff engine follows: an invalid site must be impossible to
 * store, not merely flagged afterwards.
 */

/** PLN tariff groups offered for EV charging sites. Free text is still accepted for legacy groups. */
export const PLN_TARIFF_GROUPS = [
  { code: 'L/TR', label: 'L/TR — Layanan Khusus Tegangan Rendah (EV, low voltage)' },
  { code: 'L/TM', label: 'L/TM — Layanan Khusus Tegangan Menengah (EV, medium voltage)' },
  { code: 'B-2/TR', label: 'B-2/TR — Bisnis Sedang' },
  { code: 'B-3/TM', label: 'B-3/TM — Bisnis Besar Tegangan Menengah' },
  { code: 'I-3/TM', label: 'I-3/TM — Industri Menengah' },
];

/** 200 kVA: above it the connection moves from TR (low) to TM (medium) voltage. */
export const TR_TM_CLIFF_KVA = 200;

export interface SiteInput {
  /**
   * The site's country (docs/MULTI-COUNTRY-DESIGN.md §D1): its currency, time
   * zones, tax and regulation follow. Default: the organisation's home country.
   * Cannot change once the site has a session.
   */
  countryCode?: string;
  /** Per-site tax override honoured by every engine, e.g. { exempt: true, reason: 'private depot' }. */
  taxOverrides?: { exempt?: boolean; reason?: string } | null;
  name?: string;
  address?: string | null;
  /** City, for roaming (OCPI requires one). */
  city?: string | null;
  postalCode?: string | null;
  kabupatenKotaCode?: string | null;
  lat?: number | null;
  lon?: number | null;
  timezone?: string;
  gridTariffGroup?: string | null;
  connectedKva?: number | null;
  powerFactor?: number;
  phases?: number;
  nominalVoltageV?: number;
  spkluId?: string | null;
  spkluScheme?: string | null;
  sloNumber?: string | null;
  sloIssuer?: string | null;
  sloIssuedAt?: string | null;
  sloExpiresAt?: string | null;
  localTaxRateBps?: number;
  /** Minutes a charger here may be offline before the critical alert; null = the fleet default (OFFLINE_ALERT_MINUTES). */
  offlineAlertMinutes?: number | null;
  /** Driver queue (driver/queue.ts): on or off, and its policy. */
  queueEnabled?: boolean;
  queueOfferMinutes?: number;
  queueMaxLength?: number;
  queueMaxWaitMinutes?: number;
  /** Fee for reserving a connector here in the driver app (before PPN); 0 = free. */
  reservationFeeMinor?: number;
  /** Bidirectional charging programme (services/v2x.ts). */
  v2xEnabled?: boolean;
  /** Local-time windows; a string here is input that could not be read (validateSite reports it). */
  v2xWindows?: Window[] | string;
  v2xMaxDischargeW?: number | null;
  v2xAllowExport?: boolean;
  v2xMinSocPercent?: number;
  v2xCreditMinorPerKwh?: number;
  /** Signed meter data (OCMF): off | record | require (services/signed-metering.ts). */
  signedMeterPolicy?: 'off' | 'record' | 'require';
}

export interface SiteValidation {
  errors: Record<string, string>;
  warnings: string[];
}

/** Engineering figures the site form shows live, computed the same way the load manager does. */
export function siteComputations(connectedKva: number | null | undefined, powerFactor: number) {
  const kva = connectedKva ?? 0;
  const ceilingW = connectedKva == null ? null : subscriptionCeilingW(connectedKva, powerFactor);
  return {
    activePowerCeilingKw: ceilingW == null ? null : Math.round(ceilingW / 10) / 100,
    crossesTrTmCliff: kva > TR_TM_CLIFF_KVA,
    trTmThresholdKva: TR_TM_CLIFF_KVA,
    /** Rekening minimum: 40 hours x kVA per month, payable whether used or not. */
    rekeningMinimumKwhPerMonth: Math.round(40 * kva),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fields that exist only for Indonesian sites (PLN, SPKLU, SLO, PBJT-TL). */
const ID_ONLY_FIELDS = ['kabupatenKotaCode', 'spkluId', 'spkluScheme', 'sloNumber', 'sloIssuer', 'sloIssuedAt', 'sloExpiresAt'] as const;

/**
 * Validate a site for its country (`input.countryCode`, default Indonesia):
 * postal code, coordinates, time zone and money bounds per country; the
 * Indonesian regulatory fields only for Indonesian sites. Indonesian messages
 * are unchanged from v1.6.
 */
export function validateSite(input: SiteInput, creating: boolean): SiteValidation {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  if (input.countryCode != null && !isCountry(input.countryCode)) {
    errors.countryCode = `Country must be one of ${COUNTRY_CODES.join(', ')}`;
  }
  const country: CountryCode = isCountry(input.countryCode) ? input.countryCode : 'ID';
  const cp = COUNTRIES[country];
  const isId = country === 'ID';
  const money = (minor: number) => moneyText(minor, cp.currency, 'en');
  if (!isId) {
    for (const f of ID_ONLY_FIELDS) {
      const v = input[f];
      if (v != null && v !== '') errors[f] = `${f} applies to Indonesian sites only`;
    }
    if (input.localTaxRateBps != null && Number(input.localTaxRateBps) !== 0) {
      errors.localTaxRateBps = 'PBJT-TL (regional electricity tax) applies to Indonesian sites only';
    }
  }
  if (input.taxOverrides != null && (typeof input.taxOverrides !== 'object' || Array.isArray(input.taxOverrides)
      || Object.keys(input.taxOverrides).some((k) => k !== 'exempt' && k !== 'reason'))) {
    errors.taxOverrides = 'Tax overrides: { exempt: true|false, reason: "…" }';
  }

  if (creating || input.name !== undefined) {
    if (!input.name || !String(input.name).trim()) errors.name = 'Site name is required';
    else if (String(input.name).length > 200) errors.name = 'Site name is too long';
  }
  if (input.kabupatenKotaCode != null && input.kabupatenKotaCode !== '' && !/^\d{4}$/.test(input.kabupatenKotaCode)) {
    errors.kabupatenKotaCode = 'Kabupaten/kota code is the 4-digit BPS code, e.g. 3171 (Jakarta Pusat)';
  }
  if (input.postalCode != null && input.postalCode !== '' && !cp.postalCodeRe.test(input.postalCode)) {
    errors.postalCode = cp.postalCodeHint;
  }
  const box = cp.latLonBox;
  if (input.lat != null && (!Number.isFinite(input.lat) || input.lat < box.latMin || input.lat > box.latMax)) {
    errors.lat = `Latitude must be within ${cp.name} (${box.latMin} to ${box.latMax})`;
  }
  if (input.lon != null && (!Number.isFinite(input.lon) || input.lon < box.lonMin || input.lon > box.lonMax)) {
    errors.lon = `Longitude must be within ${cp.name} (${box.lonMin} to ${box.lonMax})`;
  }
  if (input.connectedKva != null) {
    if (!Number.isFinite(input.connectedKva) || input.connectedKva <= 0 || input.connectedKva > 100_000) {
      errors.connectedKva = 'Subscribed capacity must be a positive kVA figure';
    } else if (input.connectedKva > TR_TM_CLIFF_KVA) {
      warnings.push(
        `Subscribed capacity ${input.connectedKva} kVA is above the ${TR_TM_CLIFF_KVA} kVA TR/TM cliff: a medium-voltage ` +
          'connection with its own transformer, cubicle switchgear and MV metering.',
      );
    }
  }
  if (input.powerFactor != null && (!Number.isFinite(input.powerFactor) || input.powerFactor < 0.5 || input.powerFactor > 1)) {
    errors.powerFactor = 'Power factor must be between 0.50 and 1.00';
  }
  if (input.phases != null && ![1, 3].includes(Number(input.phases))) errors.phases = 'Incoming supply is 1-phase or 3-phase';
  if (input.offlineAlertMinutes != null) {
    const m = Number(input.offlineAlertMinutes);
    if (!Number.isInteger(m) || m < 1 || m > 1440) errors.offlineAlertMinutes = 'Offline alert after 1 to 1440 minutes, or leave empty for the fleet default';
  }
  for (const [k, lo, hi, what] of [
    ['queueOfferMinutes', 2, 15, 'Time to start after a connector is offered: 2 to 15 minutes'],
    ['queueMaxLength', 1, 200, 'Queue length: 1 to 200 drivers'],
    ['queueMaxWaitMinutes', 15, 720, 'Longest wait: 15 to 720 minutes'],
    ['reservationFeeMinor', 0, cp.reservationFeeMaxMinor, `Reservation fee: ${money(0)} (free) to ${money(cp.reservationFeeMaxMinor)}`],
    ['v2xMinSocPercent', 10, 95, 'Battery floor: 10% to 95%'],
    ['v2xCreditMinorPerKwh', 0, cp.v2xCreditMaxMinorPerKwh, `Credit for energy given back: ${money(0)} to ${money(cp.v2xCreditMaxMinorPerKwh)} per kWh`],
  ] as const) {
    const v = input[k];
    if (v != null && (!Number.isInteger(Number(v)) || Number(v) < lo || Number(v) > hi)) errors[k] = what;
  }
  if (typeof input.v2xWindows === 'string') errors.v2xWindows = input.v2xWindows;
  if (input.signedMeterPolicy !== undefined && !['off', 'record', 'require'].includes(input.signedMeterPolicy)) {
    errors.signedMeterPolicy = 'Signed meter data: off, record or require';
  }
  if (input.v2xMaxDischargeW != null && (!Number.isInteger(Number(input.v2xMaxDischargeW)) || Number(input.v2xMaxDischargeW) < 1000 || Number(input.v2xMaxDischargeW) > 10_000_000)) {
    errors.v2xMaxDischargeW = 'Site discharge limit: at least 1 kW, or leave empty for no limit of its own';
  }
  if (input.v2xEnabled && input.v2xAllowExport) {
    warnings.push(isId
      ? 'Energy may flow back to the PLN grid from this site. Only allow this with an export (paralel) agreement from PLN.'
      : 'Energy may flow back to the grid from this site. Only allow this with an export agreement from the grid operator.');
  }
  if (input.localTaxRateBps != null) {
    const bps = Number(input.localTaxRateBps);
    if (!Number.isInteger(bps) || bps < 0 || bps > config.regulatory.id.pbjtMaxBps) {
      errors.localTaxRateBps = `PBJT-TL is set in basis points between 0 and ${config.regulatory.id.pbjtMaxBps} (10%)`;
    }
  }
  if (input.spkluId) {
    const parsed = parseSpkluId(input.spkluId);
    if (!parsed) {
      errors.spkluId =
        'SPKLU ID must be XX.SCHEME.YY.ZZZZ.NNN, e.g. 01.POSO.20.3171.011, with a scheme of ' + ALL_SCHEMES.join(', ');
    } else {
      if (input.kabupatenKotaCode && parsed.kabupatenKotaCode !== input.kabupatenKotaCode) {
        warnings.push(
          `The SPKLU ID encodes kabupaten/kota ${parsed.kabupatenKotaCode}, but the site is set to ${input.kabupatenKotaCode}. ` +
            'PBJT is levied by the municipality the site is actually in.',
        );
      }
      if (input.spkluScheme && parsed.scheme !== input.spkluScheme) {
        errors.spkluScheme = `The SPKLU ID encodes scheme ${parsed.scheme}; the selected scheme is ${input.spkluScheme}`;
      }
    }
  }
  if (input.spkluScheme && !ALL_SCHEMES.includes(input.spkluScheme as any)) {
    errors.spkluScheme = `Scheme must be one of ${ALL_SCHEMES.join(', ')}`;
  }
  for (const f of ['sloIssuedAt', 'sloExpiresAt'] as const) {
    const v = input[f];
    if (v != null && v !== '' && !DATE_RE.test(String(v))) errors[f] = 'Use YYYY-MM-DD';
  }
  if (input.sloIssuedAt && input.sloExpiresAt && input.sloExpiresAt <= input.sloIssuedAt) {
    errors.sloExpiresAt = 'SLO expiry must be after the issue date';
  }
  if (input.timezone && !cp.timezones.includes(input.timezone)) {
    errors.timezone = isId
      ? `Timezone must be WIB (${cp.timezones[0]}, ${cp.timezones[1]}), WITA (${cp.timezones[2]}) or WIT (${cp.timezones[3]})`
      : `Timezone must be ${cp.timezones.map((z) => `${tzLabel(z)} (${z})`).join(' or ')}`;
  }
  return { errors, warnings };
}

const COLS: Array<[keyof SiteInput, string]> = [
  ['countryCode', 'country_code'],
  ['taxOverrides', 'tax_overrides'],
  ['name', 'name'],
  ['address', 'address'],
  ['city', 'city'],
  ['postalCode', 'postal_code'],
  ['kabupatenKotaCode', 'kabupaten_kota_code'],
  ['lat', 'lat'],
  ['lon', 'lon'],
  ['timezone', 'timezone'],
  ['gridTariffGroup', 'grid_tariff_group'],
  ['connectedKva', 'connected_kva'],
  ['powerFactor', 'power_factor'],
  ['phases', 'phases'],
  ['nominalVoltageV', 'nominal_voltage_v'],
  ['spkluId', 'spklu_id'],
  ['spkluScheme', 'spklu_scheme'],
  ['sloNumber', 'slo_number'],
  ['sloIssuer', 'slo_issuer'],
  ['sloIssuedAt', 'slo_issued_at'],
  ['sloExpiresAt', 'slo_expires_at'],
  ['localTaxRateBps', 'local_tax_rate_bps'],
  ['offlineAlertMinutes', 'offline_alert_minutes'],
  ['queueEnabled', 'queue_enabled'],
  ['queueOfferMinutes', 'queue_offer_minutes'],
  ['queueMaxLength', 'queue_max_length'],
  ['queueMaxWaitMinutes', 'queue_max_wait_minutes'],
  ['reservationFeeMinor', 'reservation_fee_minor'],
  ['v2xEnabled', 'v2x_enabled'],
  ['v2xWindows', 'v2x_windows'],
  ['v2xMaxDischargeW', 'v2x_max_discharge_w'],
  ['v2xAllowExport', 'v2x_allow_export'],
  ['v2xMinSocPercent', 'v2x_min_soc_percent'],
  ['v2xCreditMinorPerKwh', 'v2x_credit_minor_per_kwh'],
  ['signedMeterPolicy', 'signed_meter_policy'],
];

/** JSON columns go to Postgres as JSON text (a JS array would be sent as a Postgres array). */
const dbValue = (k: keyof SiteInput, v: unknown) => (k === 'v2xWindows' || k === 'taxOverrides' ? JSON.stringify(v ?? {}) : v);

/** Discharge windows from the form ("17:00-22:00, 05:00-07:00") or the API ([{from, to}]). */
function windowsFrom(v: unknown): Window[] | string {
  if (typeof v === 'string') {
    const text = v.trim();
    if (!text) return [];
    const found = [...text.matchAll(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/g)].map((m) => ({ from: m[1]!.padStart(5, '0'), to: m[2]!.padStart(5, '0') }));
    const leftover = text.replace(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/g, '').replace(/[\s,;]/g, '');
    if (!found.length || leftover) return 'Discharge hours: ranges such as 17:00-22:00, separated by commas';
    return parseWindows(found);
  }
  return parseWindows(v);
}

/** Normalise a raw request body into SiteInput. Empty strings become null. */
export function siteInputFrom(b: any): SiteInput {
  const out: SiteInput = {};
  const str = (v: unknown) => (v === undefined ? undefined : v === null || String(v).trim() === '' ? null : String(v).trim());
  const numOrNull = (v: unknown) => (v === undefined ? undefined : v === null || v === '' ? null : Number(v));
  if (b.name !== undefined) out.name = String(b.name ?? '').trim();
  const s = (k: keyof SiteInput) => {
    const v = str(b[k]);
    if (v !== undefined) (out as any)[k] = v;
  };
  const n = (k: keyof SiteInput) => {
    const v = numOrNull(b[k]);
    if (v !== undefined) (out as any)[k] = v;
  };
  s('address'); s('city'); s('postalCode'); s('kabupatenKotaCode'); s('gridTariffGroup'); s('spkluId'); s('spkluScheme');
  s('sloNumber'); s('sloIssuer'); s('sloIssuedAt'); s('sloExpiresAt'); s('timezone'); s('countryCode');
  if (out.countryCode) out.countryCode = out.countryCode.toUpperCase();
  if (out.countryCode === null) delete out.countryCode;
  if (b.taxOverrides !== undefined) {
    const t = b.taxOverrides;
    out.taxOverrides = t && typeof t === 'object' && !Array.isArray(t)
      ? { ...(t.exempt !== undefined ? { exempt: t.exempt === true || t.exempt === 'true' } : {}), ...(t.reason != null ? { reason: String(t.reason).slice(0, 200) } : {}) }
      : t === null || t === '' ? {} : (t as any);
  }
  n('lat'); n('lon'); n('connectedKva'); n('powerFactor'); n('phases'); n('nominalVoltageV'); n('localTaxRateBps'); n('offlineAlertMinutes');
  n('queueOfferMinutes'); n('queueMaxLength'); n('queueMaxWaitMinutes'); n('reservationFeeMinor');
  n('v2xMaxDischargeW'); n('v2xMinSocPercent'); n('v2xCreditMinorPerKwh');
  const flag = (v: unknown) => v === true || v === 'true' || v === 'on' || v === '1';
  if (b.v2xEnabled !== undefined) out.v2xEnabled = flag(b.v2xEnabled);
  if (b.v2xAllowExport !== undefined) out.v2xAllowExport = flag(b.v2xAllowExport);
  if (b.v2xWindows !== undefined) out.v2xWindows = windowsFrom(b.v2xWindows);
  if (b.signedMeterPolicy !== undefined && b.signedMeterPolicy !== null && b.signedMeterPolicy !== '') out.signedMeterPolicy = String(b.signedMeterPolicy) as SiteInput['signedMeterPolicy'];
  // Empty floor or credit keep the current value (the database has defaults).
  for (const k of ['v2xMinSocPercent', 'v2xCreditMinorPerKwh'] as const) if (out[k] === null) delete out[k];
  // An empty reservation fee means free.
  if (out.reservationFeeMinor === null) out.reservationFeeMinor = 0;
  // The queue settings have defaults in the database: an empty field keeps the current value.
  for (const k of ['queueOfferMinutes', 'queueMaxLength', 'queueMaxWaitMinutes'] as const) if (out[k] === null) delete out[k];
  if (b.queueEnabled !== undefined) out.queueEnabled = b.queueEnabled === true || b.queueEnabled === 'true' || b.queueEnabled === 'on' || b.queueEnabled === '1';
  if (out.spkluId) out.spkluId = out.spkluId.toUpperCase();
  if (out.phases != null && out.nominalVoltageV == null) out.nominalVoltageV = out.phases === 1 ? 230 : 400;
  if (out.timezone === null) delete out.timezone;
  if (out.powerFactor === null) delete out.powerFactor;
  if (out.phases === null) delete out.phases;
  if (out.nominalVoltageV === null) delete out.nominalVoltageV;
  if (out.localTaxRateBps === null) out.localTaxRateBps = 0;
  return out;
}

/**
 * Country rules a site write must pass, beyond validateSite (they need the
 * database and the installation's settings): a new site's country defaults to
 * the organisation's home country; Malaysian and Singapore sites need
 * MULTI_COUNTRY=true; a site's country cannot change once it has a session (its
 * currency is frozen on every session and CDR). Fills in the country and its
 * default time zone on `input` when creating. Returns an error message, or null.
 */
export async function siteCountryProblem(orgId: string, input: SiteInput, siteId: string | null): Promise<{ status: 409 | 422; error: string } | null> {
  if (siteId === null) {
    if (!input.countryCode) {
      const org = await one<{ home_country_code: string }>(`SELECT home_country_code FROM organisation WHERE id = $1`, [orgId]);
      input.countryCode = org?.home_country_code ?? 'ID';
    }
  } else if (input.countryCode) {
    const cur = await one<{ country_code: string; has_sessions: boolean }>(
      `SELECT country_code, EXISTS (SELECT 1 FROM charging_session WHERE site_id = $1) AS has_sessions FROM site WHERE id = $1`, [siteId]);
    // Unchanged: nothing to decide (an existing site stays editable whatever MULTI_COUNTRY says).
    if (!cur || cur.country_code === input.countryCode) return null;
    {
      if (cur.has_sessions) {
        return { status: 409, error: 'The site has charging sessions: its country (and currency) can no longer change.' };
      }
      // Its time zone must follow the new country unless one was given.
      if (!input.timezone) input.timezone = defaultTimezone(input.countryCode);
    }
  }
  if (input.countryCode && input.countryCode !== 'ID' && !config.features.multiCountry) {
    return { status: 422, error: 'Malaysian and Singapore sites need MULTI_COUNTRY=true on this installation.' };
  }
  if (siteId === null && input.countryCode && !input.timezone && isCountry(input.countryCode)) {
    input.timezone = countryOf(input.countryCode).timezones[0]!;
  }
  return null;
}

export async function createSite(orgId: string, input: SiteInput): Promise<string> {
  const present = COLS.filter(([k]) => input[k] !== undefined);
  const cols = ['org_id', ...present.map(([, c]) => c)];
  const vals = [orgId, ...present.map(([k]) => dbValue(k, input[k]))];
  const row = await one<{ id: string }>(
    `INSERT INTO site (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    vals,
  );
  // A new site starts with a load-management budget at its subscription, so the
  // DLM studio has a real number to show instead of the 22 kW fallback.
  if (input.connectedKva != null) {
    await query(
      `INSERT INTO site_power_budget (site_id, ceiling_w, reserve_w) VALUES ($1, $2, 0)
       ON CONFLICT (site_id) DO NOTHING`,
      [row!.id, subscriptionCeilingW(input.connectedKva, input.powerFactor ?? 0.95)],
    );
  }
  return row!.id;
}

export async function updateSite(siteId: string, input: SiteInput): Promise<void> {
  const present = COLS.filter(([k]) => input[k] !== undefined);
  if (present.length === 0) return;
  await query(
    `UPDATE site SET ${present.map(([, c], i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [siteId, ...present.map(([k]) => dbValue(k, input[k]))],
  );
}

export async function getSite(siteId: string) {
  return one(
    `SELECT s.*, o.name AS org_name, b.ceiling_w, b.reserve_w, b.strategy, b.curtailed
       FROM site s
       JOIN organisation o ON o.id = s.org_id
       LEFT JOIN site_power_budget b ON b.site_id = s.id
      WHERE s.id = $1`,
    [siteId],
  );
}

/**
 * The Site Management Hub table. `onlineIdentities` comes from the connection
 * registry (local or bridged), because liveness is not a database fact.
 */
export async function listSites(orgId: string, visible: string[] | null, onlineIdentities: Set<string>) {
  const rows = await many<any>(
    `SELECT s.id, s.name, s.address, s.city, s.postal_code, s.kabupaten_kota_code, s.lat, s.lon, s.timezone, s.country_code, s.tax_overrides,
            s.grid_tariff_group, s.connected_kva, s.power_factor, s.phases, s.nominal_voltage_v,
            s.spklu_id, s.spklu_scheme, s.slo_number, s.slo_issuer, s.slo_issued_at, s.slo_expires_at,
            s.local_tax_rate_bps, s.archived_at, s.created_at,
            o.name AS org_name,
            b.ceiling_w, b.reserve_w, b.strategy, b.curtailed,
            COALESCE(array_agg(DISTINCT cp.ocpp_identity) FILTER (WHERE cp.id IS NOT NULL), '{}') AS identities,
            count(DISTINCT c.id)::int AS connector_count,
            count(DISTINCT c.id) FILTER (WHERE c.status = 'Charging')::int AS charging_count,
            count(DISTINCT c.id) FILTER (WHERE c.status = 'Faulted')::int AS faulted_count
       FROM site s
       JOIN organisation o ON o.id = s.org_id
       LEFT JOIN site_power_budget b ON b.site_id = s.id
       LEFT JOIN charge_point cp ON cp.site_id = s.id AND cp.status <> 'decommissioned'
       LEFT JOIN evse e ON e.charge_point_id = cp.id
       LEFT JOIN connector c ON c.evse_uuid = e.id
      WHERE s.org_id = $1
        AND ($2::uuid[] IS NULL OR s.id = ANY($2))
      GROUP BY s.id, o.name, b.site_id
      ORDER BY s.archived_at NULLS FIRST, s.name`,
    [orgId, visible],
  );
  return rows.map((r) => {
    const ids: string[] = r.identities ?? [];
    const online = ids.filter((i) => onlineIdentities.has(i)).length;
    const pf = Number(r.power_factor ?? 0.95);
    const kva = r.connected_kva != null ? Number(r.connected_kva) : null;
    const subscriptionW = kva == null ? null : subscriptionCeilingW(kva, pf);
    const configured = r.ceiling_w != null ? Number(r.ceiling_w) : subscriptionW;
    return {
      ...r,
      identities: undefined,
      connected_kva: kva,
      power_factor: pf,
      charger_count: ids.length,
      online_count: online,
      managed_ceiling_w: configured == null ? null : subscriptionW == null ? configured : Math.min(configured, subscriptionW),
      live_status: ids.length === 0 ? 'empty' : online === ids.length ? 'online' : online === 0 ? 'offline' : 'partial',
      computed: siteComputations(kva, pf),
      spklu_valid: r.spklu_id ? parseSpkluId(r.spklu_id) !== null : null,
    };
  });
}
