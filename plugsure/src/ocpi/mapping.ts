import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { plnEnergyRate, usesFormulaRate, type Tariff, type TariffComponent, type CdrLine } from '../services/tariff.js';

/**
 * PlugSure's data model -> OCPI 2.2.1 objects.
 *
 * Pure functions only: every database read happens in store.ts, so the shapes
 * partners receive can be tested without a database. OCPI's own vocabulary
 * (SCREAMING_CASE enums, snake_case fields) stays inside this folder.
 */

export const OCPI_VERSION = '2.2.1';

export type OcpiRole = 'CPO' | 'EMSP' | 'HUB' | 'NAP' | 'NSP' | 'OTHER' | 'SCSP';
export type EvseStatus =
  | 'AVAILABLE' | 'BLOCKED' | 'CHARGING' | 'INOPERATIVE' | 'OUTOFORDER' | 'PLANNED' | 'REMOVED' | 'RESERVED' | 'UNKNOWN';
export type TokenType = 'AD_HOC_USER' | 'APP_USER' | 'OTHER' | 'RFID';
export type WhitelistType = 'ALWAYS' | 'ALLOWED' | 'ALLOWED_OFFLINE' | 'NEVER';
export type AuthMethod = 'AUTH_REQUEST' | 'COMMAND' | 'WHITELIST';

export interface Party {
  country_code: string;
  party_id: string;
  business_name: string;
  website?: string | null;
}

// ─────────────────────────────────────────────── envelope, dates, ids

/** OCPI status codes used here (§ 5 "Status codes"). */
export const STATUS = {
  OK: 1000,
  CLIENT_ERROR: 2000,
  INVALID_PARAMS: 2001,
  NOT_ENOUGH_INFO: 2002,
  UNKNOWN_LOCATION: 2003,
  UNKNOWN_TOKEN: 2004,
  SERVER_ERROR: 3000,
  UNABLE_TO_USE_CLIENT_API: 3001,
  UNSUPPORTED_VERSION: 3002,
  NO_MATCHING_ENDPOINTS: 3003,
} as const;

export function envelope<T>(data: T, statusCode: number = STATUS.OK, statusMessage?: string) {
  return {
    ...(data === undefined ? {} : { data }),
    status_code: statusCode,
    ...(statusMessage ? { status_message: statusMessage } : {}),
    timestamp: ocpiDateTime(new Date()),
  };
}

/** OCPI DateTime: UTC, second precision, `Z` suffix. */
export function ocpiDateTime(d: Date | string | number): string {
  const t = d instanceof Date ? d : new Date(d);
  return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The credentials token from an Authorization header.
 *
 * OCPI 2.2 and later send `Token <base64(token)>`; 2.1.1 sent the token itself,
 * and some implementations still do. Both readings are returned so the caller
 * can try each against its stored hashes.
 */
export function tokensFromAuthHeader(h: unknown): string[] {
  if (typeof h !== 'string') return [];
  const m = /^Token\s+(\S+)$/i.exec(h.trim());
  if (!m) return [];
  const raw = m[1]!;
  const out = [raw];
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (decoded && /^[\x21-\x7e]+$/.test(decoded) && decoded !== raw) out.unshift(decoded);
  }
  return out;
}

export const authHeaderFor = (token: string) => `Token ${Buffer.from(token, 'utf8').toString('base64')}`;
export const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * EVSE uid: unique within this CPO, at most 36 characters, and stable for the
 * life of the EVSE (partners key their data on it).
 */
export function evseUid(ocppIdentity: string, evseNo: number): string {
  const plain = `${ocppIdentity}-${evseNo}`;
  if (plain.length <= 36) return plain;
  return `${createHash('sha256').update(ocppIdentity).digest('hex').slice(0, 24)}-${evseNo}`;
}

/** eMI3 EVSE id shown to drivers, e.g. ID*PLS*EAUTELDC60SMB002*1. */
export function emi3EvseId(party: Pick<Party, 'country_code' | 'party_id'>, ocppIdentity: string, evseNo: number): string {
  const ident = ocppIdentity.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 24) || 'EVSE';
  return `${party.country_code}*${party.party_id}*E${ident}*${evseNo}`;
}

const trunc = (s: string | null | undefined, n: number) => (s ?? '').trim().slice(0, n);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

// ─────────────────────────────────────────────── locations

export interface ConnectorIn {
  connector_id: number;
  connector_type: string | null;
  current_type: 'AC' | 'DC' | string;
  phases: number | null;
  max_power_w: number;
  rated_voltage_v: number | null;
  rated_current_a: number | null;
  status: string | null;
  maintenance_reason: string | null;
  tariff_id: string | null;
  last_updated: Date;
}

export interface EvseIn {
  ocpp_identity: string;
  evse_no: number;
  display_name: string | null;
  decommissioned: boolean;
  online: boolean;
  /** An open OCPI reservation holds this EVSE. */
  reserved?: boolean;
  connectors: ConnectorIn[];
  last_updated: Date;
}

export interface SiteIn {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  lat: number | null;
  lon: number | null;
  timezone: string | null;
  last_updated: Date;
}

/**
 * OCPP connector status -> OCPI EVSE status.
 *
 * An unreachable charger is UNKNOWN (OCPI's word for "offline"), whatever its
 * last reported status: telling a driver 400 km away that a dead unit is
 * AVAILABLE is the complaint roaming partners escalate first.
 */
export function evseStatusFor(e: Pick<EvseIn, 'decommissioned' | 'online' | 'reserved'>, c: Pick<ConnectorIn, 'status' | 'maintenance_reason'> | undefined): EvseStatus {
  if (e.decommissioned) return 'REMOVED';
  if (!e.online) return 'UNKNOWN';
  if (c?.maintenance_reason) return 'INOPERATIVE';
  switch (c?.status) {
    case 'Available': return e.reserved ? 'RESERVED' : 'AVAILABLE';
    case 'Preparing':
    case 'Charging':
    case 'SuspendedEV':
    case 'SuspendedEVSE':
    case 'Finishing':
      return 'CHARGING';
    case 'Reserved': return 'RESERVED';
    case 'Unavailable': return 'INOPERATIVE';
    case 'Faulted': return 'OUTOFORDER';
    default: return 'UNKNOWN';
  }
}

/** PlugSure plug codes (services/chargepoints.ts CONNECTOR_TYPES) -> OCPI standard and format. */
export function connectorStandard(type: string | null, current: string): { standard: string; format: 'SOCKET' | 'CABLE' } {
  const format: 'SOCKET' | 'CABLE' = type?.startsWith('s') ? 'SOCKET' : 'CABLE';
  switch (type) {
    case 'cCCS2': return { standard: 'IEC_62196_T2_COMBO', format };
    case 'cCCS1': return { standard: 'IEC_62196_T1_COMBO', format };
    case 'sType2':
    case 'cType2': return { standard: 'IEC_62196_T2', format };
    case 'cType1': return { standard: 'IEC_62196_T1', format };
    case 'cChaDeMo': return { standard: 'CHADEMO', format };
    case 'cGBT':
    case 'sGBT': return { standard: current === 'DC' ? 'GBT_DC' : 'GBT_AC', format };
    default: return { standard: current === 'DC' ? 'IEC_62196_T2_COMBO' : 'IEC_62196_T2', format };
  }
}

export function powerType(current: string, phases: number | null): 'AC_1_PHASE' | 'AC_3_PHASE' | 'DC' {
  if (current === 'DC') return 'DC';
  return phases === 1 ? 'AC_1_PHASE' : 'AC_3_PHASE';
}

/** Nameplate voltage and current, from the stored rating or derived from power. */
export function ratings(c: Pick<ConnectorIn, 'current_type' | 'phases' | 'max_power_w' | 'rated_voltage_v' | 'rated_current_a'>) {
  const pt = powerType(c.current_type, c.phases);
  // OCPI: line-to-neutral voltage for AC, so 230 V even on a 3-phase 400 V supply.
  const voltage = c.rated_voltage_v ?? (pt === 'DC' ? 500 : 230);
  const perPhaseDivisor = pt === 'AC_3_PHASE' ? 3 : 1;
  const amperage = c.rated_current_a ?? Math.max(1, Math.round(c.max_power_w / voltage / perPhaseDivisor));
  return { max_voltage: Math.round(voltage), max_amperage: Math.round(amperage), max_electric_power: Math.round(c.max_power_w) };
}

export function buildConnector(c: ConnectorIn) {
  const { standard, format } = connectorStandard(c.connector_type, c.current_type);
  return {
    id: String(c.connector_id),
    standard,
    format,
    power_type: powerType(c.current_type, c.phases),
    ...ratings(c),
    ...(c.tariff_id ? { tariff_ids: [c.tariff_id] } : {}),
    last_updated: ocpiDateTime(c.last_updated),
  };
}

export function buildEvse(party: Party, e: EvseIn) {
  return {
    uid: evseUid(e.ocpp_identity, e.evse_no),
    evse_id: emi3EvseId(party, e.ocpp_identity, e.evse_no),
    status: evseStatusFor(e, e.connectors[0]),
    capabilities: ['RFID_READER', 'REMOTE_START_STOP_CAPABLE', 'UNLOCK_CAPABLE', 'RESERVABLE'],
    connectors: e.connectors.map(buildConnector),
    physical_reference: trunc(e.display_name ? `${e.display_name}`.replace(/\s+/g, ' ') : String(e.evse_no), 16),
    last_updated: ocpiDateTime(e.last_updated),
  };
}

/** Why a site cannot be published (OCPI requires coordinates, an address and a city). */
export function locationProblem(s: SiteIn): string | null {
  if (s.lat == null || s.lon == null) return 'set the map location (coordinates are required)';
  if (!trunc(s.address, 45)) return 'enter a street address';
  if (!cityOf(s)) return 'enter the city';
  return null;
}

function cityOf(s: Pick<SiteIn, 'city' | 'address'>): string {
  if (s.city?.trim()) return trunc(s.city, 45);
  const parts = (s.address ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? trunc(parts.at(-1), 45) : '';
}

export function buildLocation(party: Party, s: SiteIn, evses: EvseIn[], opts: { publish?: boolean } = {}) {
  const lastUpdated = [s.last_updated, ...evses.map((e) => e.last_updated)].reduce((a, b) => (b > a ? b : a));
  return {
    country_code: party.country_code,
    party_id: party.party_id,
    id: s.id,
    publish: opts.publish ?? true,
    name: trunc(s.name, 255),
    address: trunc(s.address, 45),
    city: cityOf(s),
    ...(s.postal_code ? { postal_code: trunc(s.postal_code, 10) } : {}),
    country: 'IDN',
    coordinates: { latitude: (s.lat ?? 0).toFixed(6), longitude: (s.lon ?? 0).toFixed(6) },
    evses: evses.map((e) => buildEvse(party, e)),
    operator: { name: party.business_name, ...(party.website ? { website: party.website } : {}) },
    time_zone: s.timezone ?? 'Asia/Jakarta',
    last_updated: ocpiDateTime(lastUpdated),
  };
}

/** A stable fingerprint of a location's content, excluding status (status goes out as PATCHes). */
export function contentHash(o: unknown): string {
  const strip = (v: any): any =>
    Array.isArray(v) ? v.map(strip)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'last_updated' && k !== 'status').map(([k, x]) => [k, strip(x)]))
        : v;
  return createHash('sha256').update(JSON.stringify(strip(o))).digest('hex').slice(0, 32);
}

// ─────────────────────────────────────────────── tariffs

/** PPN as the percentage a driver effectively pays: 12 % of DPP 11/12 = 11 %. */
export function effectiveVatPercent(ppnApplies: boolean | undefined): number {
  if (ppnApplies === false) return 0;
  const { ppnRateBps, ppnDppNumerator, ppnDppDenominator } = config.tax;
  return Math.round((ppnRateBps / 100) * (ppnDppNumerator / ppnDppDenominator) * 100) / 100;
}

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

function windowRestrictions(c: TariffComponent): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  if (c.timeFrom && c.timeTo) {
    r.start_time = c.timeFrom;
    r.end_time = c.timeTo;
  } else if (c.touBlock === 'WBP') {
    r.start_time = config.tou.wbpStart;
    r.end_time = config.tou.wbpEnd;
  } else if (c.touBlock === 'LWBP') {
    // OCPI: an end_time before the start_time wraps past midnight.
    r.start_time = config.tou.wbpEnd;
    r.end_time = config.tou.wbpStart;
  }
  const mask = c.dayMask ?? 127;
  if (mask !== 127) r.day_of_week = DAYS.filter((_, i) => mask & (1 << i));
  return r;
}

export interface TariffIn {
  tariff: Tariff;
  active_from: Date | null;
  active_to: Date | null;
  last_updated: Date;
}

/**
 * A PlugSure tariff as an OCPI tariff.
 *
 * OCPI applies the FIRST element whose restrictions match, per dimension, so
 * the order here carries meaning: a peak (WBP) or off-peak (LWBP) price comes
 * before the ANY catch-all, which is exactly how rating resolves it. Prices
 * exclude taxes; `vat` is PPN's effective rate. PBJT-TL is a regional tax that
 * differs per location and has no OCPI field, so the alt text says so and the
 * CDR carries the authoritative total.
 */
export function buildTariff(party: Party, t: TariffIn) {
  const vat = effectiveVatPercent(t.tariff.ppnApplies);
  const comps = t.tariff.components;
  const elements: Array<{ price_components: unknown[]; restrictions?: Record<string, unknown> }> = [];
  const el = (price_components: unknown[], restrictions: Record<string, unknown> = {}) =>
    elements.push({ price_components, ...(Object.keys(restrictions).length ? { restrictions } : {}) });

  // Energy: block-specific first, then ANY; tiers as min/max kWh.
  const energy = comps.filter((c) => c.kind === 'energy');
  const regulated = plnEnergyRate(t.tariff);
  const rank = (c: TariffComponent) => (c.touBlock === 'ANY' && !c.timeFrom ? 1 : 0);
  const ordered = [...energy].sort((a, b) => rank(a) - rank(b) || (a.fromKwh ?? 0) - (b.fromKwh ?? 0));
  if (ordered.length === 0 && regulated != null) {
    el([{ type: 'ENERGY', price: r4(regulated), vat, step_size: 1 }]);
  }
  for (const c of ordered) {
    const r = windowRestrictions(c);
    if ((c.fromKwh ?? 0) > 0) r.min_kwh = c.fromKwh;
    if (c.toKwh != null) r.max_kwh = c.toKwh;
    // A free tier (rate 0) is published as free; only a tier without a rate uses the PLN formula price.
    el([{ type: 'ENERGY', price: r4(usesFormulaRate(c) ? (regulated ?? 0) : Number(c.rate)), vat, step_size: 1 }], r);
  }

  // Service + admin fee: one flat price, not charged below the minimum billable energy.
  const flat = comps.filter((c) => c.kind === 'session' || c.kind === 'admin').reduce((a, c) => a + c.rate, 0);
  if (flat > 0) el([{ type: 'FLAT', price: flat, vat, step_size: 1 }], { min_kwh: r3(config.limits.minBillableWh / 1000) });

  // Time from session start (per minute in PlugSure, per hour in OCPI).
  for (const c of comps.filter((x) => x.kind === 'time')) {
    const r: Record<string, unknown> = {};
    if ((c.fromMinutes ?? 0) > 0) r.min_duration = (c.fromMinutes ?? 0) * 60;
    if (c.toMinutes != null) r.max_duration = c.toMinutes * 60;
    el([{ type: 'TIME', price: c.rate * 60, vat, step_size: 60 }], r);
  }

  // Idle fee: OCPI 2.2.1 has no restriction for "parking after a grace period",
  // so the grace and the cap are stated in the alt text.
  const idle = comps.filter((x) => x.kind === 'idle');
  for (const c of idle) el([{ type: 'PARKING_TIME', price: c.rate * 60, vat, step_size: 60 }]);

  const idleText = idle.map((c) => `idle fee Rp ${c.rate.toLocaleString('en-US')}/min after ${c.fromMinutes ?? 0} min${c.toMinutes != null ? `, charged for at most ${Math.max(0, c.toMinutes - (c.fromMinutes ?? 0))} min` : ''}`);
  const idleTextId = idle.map((c) => `biaya parkir Rp ${c.rate.toLocaleString('id-ID')}/menit setelah ${c.fromMinutes ?? 0} menit${c.toMinutes != null ? `, maksimum ${Math.max(0, c.toMinutes - (c.fromMinutes ?? 0))} menit` : ''}`);
  const taxEn = vat > 0 ? `Prices exclude PPN (${vat}% effective) and PBJT-TL (regional electricity tax, set per location).` : 'Prices exclude PBJT-TL (regional electricity tax, set per location). No PPN.';
  const taxId = vat > 0 ? `Harga belum termasuk PPN (efektif ${vat}%) dan PBJT-TL (pajak daerah, sesuai lokasi).` : 'Harga belum termasuk PBJT-TL (pajak daerah, sesuai lokasi). Tanpa PPN.';

  return {
    country_code: party.country_code,
    party_id: party.party_id,
    id: t.tariff.id,
    currency: 'IDR',
    type: 'REGULAR',
    tariff_alt_text: [
      { language: 'en', text: [taxEn, ...idleText.map((s) => s[0]!.toUpperCase() + s.slice(1) + '.')].join(' ') },
      { language: 'id', text: [taxId, ...idleTextId.map((s) => s[0]!.toUpperCase() + s.slice(1) + '.')].join(' ') },
    ],
    elements,
    ...(t.active_from ? { start_date_time: ocpiDateTime(t.active_from) } : {}),
    ...(t.active_to ? { end_date_time: ocpiDateTime(t.active_to) } : {}),
    last_updated: ocpiDateTime(t.last_updated),
  };
}

// ─────────────────────────────────────────────── sessions and CDRs

export interface TokenRef {
  country_code: string;
  party_id: string;
  uid: string;
  type: TokenType | string;
  contract_id: string;
}

export interface SessionIn {
  id: string;
  state: string;
  started_at: Date;
  ended_at: Date | null;
  energy_wh: number;
  auth_method: AuthMethod | string | null;
  authorization_reference: string | null;
  location_id: string;
  evse_uid: string;
  connector_id: string;
  meter_id: string | null;
  /** Present once rated. */
  cost?: { subtotal_idr: number; pbjt_idr: number; total_idr: number } | null;
  last_updated: Date;
}

export const cdrToken = (t: TokenRef) => ({
  country_code: t.country_code,
  party_id: t.party_id,
  uid: t.uid,
  type: t.type,
  contract_id: t.contract_id,
});

/** Total cost as OCPI Price: excl_vat carries PBJT-TL unless configured otherwise. */
export function priceOf(c: { subtotal_idr: number; pbjt_idr: number; total_idr: number }) {
  const excl = Number(c.subtotal_idr) + (config.ocpi.pbjtInExclVat ? Number(c.pbjt_idr) : 0);
  return { excl_vat: excl, incl_vat: Number(c.total_idr) };
}

export function buildSession(party: Party, s: SessionIn, token: TokenRef) {
  const active = s.state === 'active';
  return {
    country_code: party.country_code,
    party_id: party.party_id,
    id: s.id,
    start_date_time: ocpiDateTime(s.started_at),
    ...(s.ended_at && !active ? { end_date_time: ocpiDateTime(s.ended_at) } : {}),
    kwh: r3(Number(s.energy_wh) / 1000),
    cdr_token: cdrToken(token),
    auth_method: s.auth_method ?? 'WHITELIST',
    ...(s.authorization_reference ? { authorization_reference: s.authorization_reference } : {}),
    location_id: s.location_id,
    evse_uid: s.evse_uid,
    connector_id: s.connector_id,
    ...(s.meter_id ? { meter_id: trunc(s.meter_id, 255) } : {}),
    currency: 'IDR',
    ...(s.cost ? { total_cost: priceOf(s.cost) } : {}),
    status: active ? 'ACTIVE' : 'COMPLETED',
    last_updated: ocpiDateTime(s.last_updated),
  };
}

export interface CdrIn {
  id: string;
  issued_at: Date;
  lines: CdrLine[];
  subtotal_idr: number;
  pbjt_idr: number;
  total_idr: number;
  tariff: Tariff | null;
  session: SessionIn & { idle_minutes: number };
  site: SiteIn;
  evse: EvseIn;
  connector: ConnectorIn;
}

export function buildCdr(party: Party, c: CdrIn, token: TokenRef) {
  const s = c.session;
  const start = new Date(s.started_at);
  const end = new Date(s.ended_at ?? s.started_at);
  const totalH = Math.max(0, (end.getTime() - start.getTime()) / 3_600_000);
  const parkingH = Math.min(totalH, Math.max(0, Number(s.idle_minutes ?? 0)) / 60);
  const kwh = r3(Number(s.energy_wh) / 1000);
  const sum = (kinds: string[]) => c.lines.filter((l) => kinds.includes(l.kind)).reduce((a, l) => a + Number(l.amountIdr), 0);
  const energyCost = sum(['energy']);
  const fixedCost = sum(['session', 'admin']);
  const timeCost = sum(['time']);
  const parkingCost = sum(['idle']);

  const periods: unknown[] = [{
    start_date_time: ocpiDateTime(start),
    dimensions: [
      { type: 'ENERGY', volume: kwh },
      { type: 'TIME', volume: r4(totalH - parkingH) },
    ],
    ...(c.tariff ? { tariff_id: c.tariff.id } : {}),
  }];
  if (parkingH > 0) {
    periods.push({
      start_date_time: ocpiDateTime(new Date(end.getTime() - parkingH * 3_600_000)),
      dimensions: [{ type: 'PARKING_TIME', volume: r4(parkingH) }],
      ...(c.tariff ? { tariff_id: c.tariff.id } : {}),
    });
  }
  const conn = buildConnector(c.connector);

  return {
    country_code: party.country_code,
    party_id: party.party_id,
    id: c.id,
    start_date_time: ocpiDateTime(start),
    end_date_time: ocpiDateTime(end),
    session_id: s.id,
    cdr_token: cdrToken(token),
    auth_method: s.auth_method ?? 'WHITELIST',
    ...(s.authorization_reference ? { authorization_reference: s.authorization_reference } : {}),
    cdr_location: {
      id: c.site.id,
      name: trunc(c.site.name, 255),
      address: trunc(c.site.address, 45),
      city: cityOf(c.site),
      ...(c.site.postal_code ? { postal_code: trunc(c.site.postal_code, 10) } : {}),
      country: 'IDN',
      coordinates: { latitude: (c.site.lat ?? 0).toFixed(6), longitude: (c.site.lon ?? 0).toFixed(6) },
      evse_uid: evseUid(c.evse.ocpp_identity, c.evse.evse_no),
      evse_id: emi3EvseId(party, c.evse.ocpp_identity, c.evse.evse_no),
      connector_id: conn.id,
      connector_standard: conn.standard,
      connector_format: conn.format,
      connector_power_type: conn.power_type,
    },
    ...(s.meter_id ? { meter_id: trunc(s.meter_id, 255) } : {}),
    currency: 'IDR',
    ...(c.tariff ? { tariffs: [buildTariff(party, { tariff: c.tariff, active_from: null, active_to: null, last_updated: c.issued_at })] } : {}),
    charging_periods: periods,
    total_cost: priceOf(c),
    ...(fixedCost ? { total_fixed_cost: { excl_vat: fixedCost } } : {}),
    total_energy: kwh,
    ...(energyCost ? { total_energy_cost: { excl_vat: energyCost } } : {}),
    total_time: r4(totalH),
    ...(timeCost ? { total_time_cost: { excl_vat: timeCost } } : {}),
    ...(parkingH > 0 ? { total_parking_time: r4(parkingH) } : {}),
    ...(parkingCost ? { total_parking_cost: { excl_vat: parkingCost } } : {}),
    last_updated: ocpiDateTime(c.issued_at),
  };
}

// ─────────────────────────────────────────────── tokens (received from partners)

const TOKEN_TYPES: TokenType[] = ['AD_HOC_USER', 'APP_USER', 'OTHER', 'RFID'];
const WHITELISTS: WhitelistType[] = ['ALWAYS', 'ALLOWED', 'ALLOWED_OFFLINE', 'NEVER'];

export interface TokenIn {
  country_code: string;
  party_id: string;
  uid: string;
  type: TokenType;
  contract_id: string;
  visual_number: string | null;
  issuer: string;
  group_id: string | null;
  valid: boolean;
  whitelist: WhitelistType;
  language: string | null;
  default_profile_type: string | null;
  energy_contract: unknown;
  last_updated: Date;
}

/** Validate a Token object a partner pushed. Returns the cleaned token or an error message. */
export function parseToken(b: any, path?: { country_code: string; party_id: string; uid: string }): TokenIn | string {
  if (!b || typeof b !== 'object') return 'body must be a Token object';
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
  const cc = str(b.country_code, 2);
  const pid = str(b.party_id, 3);
  const uid = str(b.uid, 36);
  const contract = str(b.contract_id, 36);
  const issuer = str(b.issuer, 64);
  if (!cc || !pid || !uid) return 'country_code, party_id and uid are required';
  if (path && (cc !== path.country_code || pid !== path.party_id || uid !== path.uid)) {
    return 'country_code, party_id and uid must match the URL';
  }
  if (!TOKEN_TYPES.includes(b.type)) return `type must be one of ${TOKEN_TYPES.join(', ')}`;
  if (!contract) return 'contract_id is required';
  if (!issuer) return 'issuer is required';
  if (typeof b.valid !== 'boolean') return 'valid must be true or false';
  if (!WHITELISTS.includes(b.whitelist)) return `whitelist must be one of ${WHITELISTS.join(', ')}`;
  const lu = new Date(b.last_updated);
  if (!b.last_updated || Number.isNaN(lu.getTime())) return 'last_updated is required';
  return {
    country_code: cc.toUpperCase(),
    party_id: pid.toUpperCase(),
    uid,
    type: b.type,
    contract_id: contract,
    visual_number: str(b.visual_number, 64),
    issuer,
    group_id: str(b.group_id, 36),
    valid: b.valid,
    whitelist: b.whitelist,
    language: str(b.language, 2),
    default_profile_type: str(b.default_profile_type, 20),
    energy_contract: b.energy_contract && typeof b.energy_contract === 'object' ? b.energy_contract : null,
    last_updated: lu,
  };
}

export function tokenOut(t: TokenIn) {
  return {
    country_code: t.country_code,
    party_id: t.party_id,
    uid: t.uid,
    type: t.type,
    contract_id: t.contract_id,
    ...(t.visual_number ? { visual_number: t.visual_number } : {}),
    issuer: t.issuer,
    ...(t.group_id ? { group_id: t.group_id } : {}),
    valid: t.valid,
    whitelist: t.whitelist,
    ...(t.language ? { language: t.language } : {}),
    ...(t.default_profile_type ? { default_profile_type: t.default_profile_type } : {}),
    ...(t.energy_contract ? { energy_contract: t.energy_contract } : {}),
    last_updated: ocpiDateTime(t.last_updated),
  };
}

// ─────────────────────────────────────────────── charging profiles (§ 14)

export interface ChargingProfileIn {
  /** Absent: the schedule counts from the start of charging. */
  start_date_time?: string;
  duration?: number;
  charging_rate_unit: 'W' | 'A';
  min_charging_rate?: number;
  charging_profile_period: Array<{ start_period: number; limit: number }>;
}

/** The most periods a partner may send: a day in 15-minute steps, with room to spare. */
export const MAX_PROFILE_PERIODS = 200;

/** Validate an OCPI ChargingProfile. Returns the cleaned profile or an error message. */
export function parseChargingProfile(b: any): ChargingProfileIn | string {
  if (!b || typeof b !== 'object') return 'charging_profile must be a ChargingProfile object';
  if (b.charging_rate_unit !== 'W' && b.charging_rate_unit !== 'A') return 'charging_rate_unit must be W or A';
  const periods = b.charging_profile_period;
  if (!Array.isArray(periods) || periods.length === 0) return 'charging_profile_period must list at least one period';
  if (periods.length > MAX_PROFILE_PERIODS) return `charging_profile_period may list at most ${MAX_PROFILE_PERIODS} periods`;
  const clean: ChargingProfileIn['charging_profile_period'] = [];
  for (const p of periods) {
    const start = Number(p?.start_period);
    const limit = Number(p?.limit);
    if (!Number.isInteger(start) || start < 0) return 'start_period must be a whole number of seconds, 0 or more';
    if (!Number.isFinite(limit) || limit < 0) return 'limit must be a number, 0 or more';
    if (clean.length && start <= clean[clean.length - 1]!.start_period) return 'periods must be in order of start_period, without repeats';
    clean.push({ start_period: start, limit });
  }
  if (clean[0]!.start_period !== 0) return 'the first period must start at 0';
  let start: string | undefined;
  if (b.start_date_time != null) {
    const d = new Date(String(b.start_date_time));
    if (Number.isNaN(d.getTime())) return 'start_date_time is not a date';
    start = d.toISOString();
  }
  if (b.duration != null && (!Number.isInteger(Number(b.duration)) || Number(b.duration) <= 0)) return 'duration must be a whole number of seconds';
  if (b.min_charging_rate != null && (!Number.isFinite(Number(b.min_charging_rate)) || Number(b.min_charging_rate) < 0)) return 'min_charging_rate must be a number, 0 or more';
  return {
    ...(start ? { start_date_time: start } : {}),
    ...(b.duration != null ? { duration: Number(b.duration) } : {}),
    charging_rate_unit: b.charging_rate_unit,
    ...(b.min_charging_rate != null ? { min_charging_rate: Number(b.min_charging_rate) } : {}),
    charging_profile_period: clean,
  };
}

/**
 * The limit a profile sets at `now`, in its own unit, or null when it sets none
 * (not started yet, or its duration has run out). The last period holds until
 * the duration ends, or for the rest of the session when there is none.
 */
export function profileLimitAt(p: ChargingProfileIn, now: Date, chargingStartedAt: Date): number | null {
  const start = p.start_date_time ? new Date(p.start_date_time) : chargingStartedAt;
  const s = (now.getTime() - start.getTime()) / 1000;
  if (s < 0) return null;
  if (p.duration != null && s >= p.duration) return null;
  let limit: number | null = null;
  for (const period of p.charging_profile_period) {
    if (period.start_period <= s) limit = period.limit;
    else break;
  }
  return limit;
}

// ─────────────────────────────────────────────── hub client info (§ 16)

export type ConnectionStatus = 'CONNECTED' | 'OFFLINE' | 'PLANNED' | 'SUSPENDED';
const ROLES: OcpiRole[] = ['CPO', 'EMSP', 'HUB', 'NAP', 'NSP', 'OTHER', 'SCSP'];
const CONNECTION_STATUSES: ConnectionStatus[] = ['CONNECTED', 'OFFLINE', 'PLANNED', 'SUSPENDED'];

export interface ClientInfoIn {
  country_code: string;
  party_id: string;
  role: OcpiRole;
  status: ConnectionStatus;
  last_updated: Date;
}

/** Validate a ClientInfo object from a hub. Returns the cleaned object or an error message. */
export function parseClientInfo(b: any, path?: { country_code: string; party_id: string }): ClientInfoIn | string {
  if (!b || typeof b !== 'object') return 'body must be a ClientInfo object';
  const cc = String(b.country_code ?? '').toUpperCase();
  const pid = String(b.party_id ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || !/^[A-Z0-9]{3}$/.test(pid)) return 'country_code (2 letters) and party_id (3 characters) are required';
  if (path && (cc !== path.country_code || pid !== path.party_id)) return 'country_code and party_id must match the URL';
  if (!ROLES.includes(b.role)) return `role must be one of ${ROLES.join(', ')}`;
  if (!CONNECTION_STATUSES.includes(b.status)) return `status must be one of ${CONNECTION_STATUSES.join(', ')}`;
  const lu = new Date(b.last_updated);
  if (!b.last_updated || Number.isNaN(lu.getTime())) return 'last_updated is required';
  return { country_code: cc, party_id: pid, role: b.role, status: b.status, last_updated: lu };
}

export const clientInfoOut = (c: ClientInfoIn) => ({
  party_id: c.party_id, country_code: c.country_code, role: c.role, status: c.status, last_updated: ocpiDateTime(c.last_updated),
});

// ─────────────────────────────────────────────── paging

export function paging(q: Record<string, unknown>, max = 100) {
  const offset = Math.max(0, Math.floor(Number(q.offset ?? 0)) || 0);
  const limit = Math.min(max, Math.max(1, Math.floor(Number(q.limit ?? max)) || max));
  const from = q.date_from ? new Date(String(q.date_from)) : null;
  const to = q.date_to ? new Date(String(q.date_to)) : null;
  return {
    offset,
    limit,
    dateFrom: from && !Number.isNaN(from.getTime()) ? from : null,
    dateTo: to && !Number.isNaN(to.getTime()) ? to : null,
  };
}
