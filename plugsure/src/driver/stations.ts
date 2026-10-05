import { one, many } from '../db/pool.js';
import * as registry from '../ocpp/registry.js';
import { loadTariffForConnector, headlinePrices } from '../services/tariff-store.js';
import { plnEnergyRate, type Tariff } from '../services/tariff.js';
import { connectorMaySellEnergy } from '../services/compliance.js';
import { feeTaxerFor } from '../services/benefits.js';
import { profileFor } from '../services/regulatory/index.js';
import { countryOf } from '../domain/country.js';
import { rateToMinor, type CurrencyCode } from '../domain/money.js';
import { chargingClassForPowerW } from '../domain/spklu.js';
import { config } from '../config.js';
import { reservationOn } from './reservations.js';
import { queueBlocks } from './queue.js';
import type { DriverPrincipal } from './identity.js';

/**
 * The public, unauthenticated view of the charging network.
 *
 * Anyone browsing the app can see stations, their live availability, connector
 * types, power and price — no account, no device token. This is deliberately a
 * read-only, cross-tenant surface: a driver does not care which CPO owns a
 * charger, only whether it is free and what it costs.
 */

/** A Postgres uuid literal — guard callers so a malformed id is a clean 404, not a 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CONNECTOR_LABEL: Record<string, string> = {
  cType2: 'Type 2',
  sType2: 'Type 2',
  cCCS2: 'CCS2',
  cChaDeMo: 'CHAdeMO',
  cGBT: 'GB/T',
  sGBT: 'GB/T',
  cCCS1: 'CCS1',
  cType1: 'Type 1',
};

export interface ConnectorView {
  connectorId: string;
  ocppIdentity: string;
  /** Operator-set friendly name (v1.3), falling back to the OCPP identity. */
  chargerName: string;
  connectorNo: number;
  type: string;
  typeLabel: string;
  current: 'AC' | 'DC';
  maxPowerW: number;
  maxPowerKw: number;
  chargingClass: string;
  status: string; // Available | Charging | Occupied | Faulted | Offline | Blocked | Maintenance | Unavailable | Reserved | Queued
  available: boolean;
  blockedReason: string | null;
}

export interface StationView {
  siteId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  spkluId: string | null;
  operator: string;
  distanceKm: number | null;
  connectors: ConnectorView[];
  availableCount: number;
  totalCount: number;
  maxPowerKw: number;
  fastest: string; // e.g. "60 kW DC"
  /** Headline energy price per kWh: the rate in major units (priceFromMajor) and in minor units (IDR: the rupiah rate, as before). */
  priceFromMinor: number | null;
  priceFromMajor: number | null;
  /** The site's currency and country (every amount for this station is in that currency). */
  currency: CurrencyCode;
  countryCode: string;
  timezone: string | null;
  /** Prices include the tax (Singapore GST, Malaysia): the price shown is what the driver pays per kWh. */
  pricesIncludeTax: boolean;
}

interface ConnectorRow {
  connector_id: string;
  connector_no: number;
  connector_type: string | null;
  current_type: string;
  max_power_w: number;
  status: string;
  tera_status: string;
  in_maintenance: boolean;
  suspended: boolean;
  ocpp_identity: string;
  display_name: string | null;
  site_id: string;
  site_name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  spklu_id: string | null;
  org_id: string;
  operator: string;
  country_code: string;
  timezone: string | null;
}

const CONNECTOR_COLUMNS = `
  c.id AS connector_id, e.evse_id AS connector_no, c.connector_type, c.current_type,
  c.max_power_w, c.status, c.tera_status, (c.maintenance_reason IS NOT NULL) AS in_maintenance,
  (cp.status = 'suspended') AS suspended, cp.ocpp_identity, cp.display_name, s.id AS site_id, s.name AS site_name, s.address, s.lat, s.lon,
  s.spklu_id, s.org_id, o.name AS operator, s.country_code, s.timezone
  FROM connector c
  JOIN evse e ON e.id = c.evse_uuid
  JOIN charge_point cp ON cp.id = e.charge_point_id
  JOIN site s ON s.id = cp.site_id
  JOIN organisation o ON o.id = s.org_id`;

/**
 * What the public may see (v1.3): an archived site, or a charger still awaiting
 * adoption or decommissioned, is not part of the network — not in the list, and
 * not reachable by scanning an old QR sticker or a bookmarked connector link.
 */
// Developer sandbox tenants never appear in the public driver app.
const PUBLICLY_LISTED = `cp.status NOT IN ('pending_adoption', 'decommissioned') AND s.archived_at IS NULL`
  + ` AND NOT EXISTS (SELECT 1 FROM organisation so WHERE so.id = s.org_id AND so.sandbox_of_org_id IS NOT NULL)`;

function toConnectorView(r: ConnectorRow): ConnectorView {
  const online = registry.isOnline(r.ocpp_identity);
  // Tera (meter verification) gates Indonesian connectors only (the country's regulatory profile).
  const gate = profileFor(r.country_code ?? 'ID').connectorMaySell(r.tera_status);

  let status: string;
  let available = false;
  let blockedReason: string | null = null;

  if (!gate.allowed) {
    status = 'Blocked';
    blockedReason = 'Sedang tidak dapat digunakan (verifikasi meter).';
  } else if (r.suspended) {
    // Suspended by the operator (v1.4.1): listed, but sells, reserves and queues nothing.
    status = 'Unavailable';
    blockedReason = 'Sementara tidak beroperasi.';
  } else if (r.in_maintenance) {
    // The operator's reason is internal ("gun 2 cable damaged"); the driver gets a plain notice.
    status = 'Maintenance';
    blockedReason = 'Sedang dalam perawatan.';
  } else if (!online) {
    status = 'Offline';
    blockedReason = 'Charger sedang luring.';
  } else if (r.status === 'Available') {
    status = 'Available';
    available = true;
  } else if (r.status === 'Charging' || r.status === 'SuspendedEV' || r.status === 'SuspendedEVSE') {
    status = 'Charging';
    blockedReason = 'Sedang dipakai.';
  } else if (r.status === 'Preparing' || r.status === 'Finishing') {
    status = 'Occupied';
    blockedReason = 'Sedang disiapkan.';
  } else if (r.status === 'Faulted') {
    status = 'Faulted';
    blockedReason = 'Charger bermasalah.';
  } else if (r.status === 'Reserved') {
    status = 'Reserved';
    blockedReason = 'Sedang dipesan pengemudi lain.';
  } else {
    status = 'Unavailable';
    blockedReason = 'Tidak tersedia.';
  }

  const type = r.connector_type ?? (r.current_type === 'DC' ? 'cCCS2' : 'sType2');
  return {
    connectorId: r.connector_id,
    ocppIdentity: r.ocpp_identity,
    chargerName: r.display_name || r.ocpp_identity,
    connectorNo: r.connector_no,
    type,
    typeLabel: CONNECTOR_LABEL[type] ?? type,
    current: r.current_type === 'DC' ? 'DC' : 'AC',
    maxPowerW: r.max_power_w,
    maxPowerKw: Math.round(r.max_power_w / 100) / 10,
    chargingClass: chargingClassForPowerW(r.max_power_w),
    status,
    available,
    blockedReason,
  };
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 10) / 10;
}

/** Headline energy price (per kWh, major units of the tariff's currency) for a connector, or null if none is set. */
export async function connectorEnergyPrice(connectorUuid: string, orgId: string): Promise<number | null> {
  return (await connectorPricing(connectorUuid, orgId))?.rate ?? null;
}

/** The headline energy rate and whether the tariff's prices include the tax. */
async function connectorPricing(connectorUuid: string, orgId: string): Promise<{ rate: number | null; inclusive: boolean } | null> {
  try {
    const { tariff } = await loadTariffForConnector(connectorUuid, orgId, new Date());
    return { rate: energyRateOf(tariff), inclusive: tariff.pricesIncludeTax === true };
  } catch {
    return null;
  }
}

function energyRateOf(t: Tariff): number | null {
  const explicit = t.components.filter((c) => c.kind === 'energy' && c.rate > 0).map((c) => c.rate);
  if (explicit.length) return Math.min(...explicit);
  return plnEnergyRate(t);
}

/** A map viewport: west, south, east, north (degrees). West > east crosses the antimeridian. */
export type BBox = readonly [number, number, number, number];

/** Parse `w,s,e,n`; null when absent or malformed. */
export function parseBbox(raw: unknown): BBox | null {
  if (raw == null || raw === '') return null;
  const p = String(raw).split(',').map((x) => Number(x.trim()));
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) return null;
  const [w, s, e, n] = p as [number, number, number, number];
  if (s < -90 || n > 90 || s > n || w < -180 || w > 180 || e < -180 || e > 180) return null;
  return [w, s, e, n];
}

/** SQL for "the site is in the viewport" with the box at $idx (w, s, e, n as $idx..$idx+3). */
export function bboxSql(alias: string, idx: number): string {
  const [w, s, e, n] = [idx, idx + 1, idx + 2, idx + 3].map((i) => `$${i}::float8`);
  return `(${alias}.lat BETWEEN ${s} AND ${n} AND (CASE WHEN ${w} <= ${e} THEN ${alias}.lon BETWEEN ${w} AND ${e} ELSE (${alias}.lon >= ${w} OR ${alias}.lon <= ${e}) END))`;
}

/**
 * Headline prices one connector at a time (two queries each) — what listStations did before v1.9. Kept for the
 * equivalence test and the benchmark (tools/bench/stations-bench.mts); listStations uses headlinePrices.
 */
export async function pricesOneByOne(connectors: ReadonlyArray<{ connectorId: string; orgId: string }>): Promise<Map<string, { rate: number | null; inclusive: boolean } | null>> {
  const out = new Map<string, { rate: number | null; inclusive: boolean } | null>();
  for (const c of connectors) out.set(c.connectorId, await connectorPricing(c.connectorId, c.orgId));
  return out;
}

export interface ListOptions {
  /** Only sites inside this viewport. */
  bbox?: BBox | null;
  /** false: no headline prices (priceFrom* null) — the map prices only the stations it returns (`priceStations`). */
  prices?: boolean;
  /** false: no ordering (the map orders the merged list itself). */
  sort?: boolean;
}

/** Fill in the headline price of these stations (one batch for all their connectors). */
export async function priceStations(stations: StationView[]): Promise<void> {
  if (!stations.length) return;
  let prices: Map<string, { rate: number | null; inclusive: boolean }>;
  try {
    prices = await headlinePrices(stations.flatMap((s) => s.connectors.map((c) => c.connectorId)), new Date());
  } catch {
    return;
  }
  for (const st of stations) {
    let priceFrom: number | null = null;
    let inclusive = false;
    for (const c of st.connectors) {
      const p = prices.get(c.connectorId);
      if (p?.rate != null && (priceFrom == null || p.rate < priceFrom)) { priceFrom = p.rate; inclusive = p.inclusive; }
    }
    st.priceFromMinor = priceFrom == null ? null : rateToMinor(priceFrom, st.currency);
    st.priceFromMajor = priceFrom;
    st.pricesIncludeTax = inclusive;
  }
}

/**
 * Every station, with live availability and a headline price, nearest first when
 * a location is given. orgId: a white-label app, which shows its operator's only.
 * bbox: only the viewport (the map, G7). Prices are resolved for all connectors in one batch (headlinePrices).
 */
export async function listStations(loc?: { lat: number; lon: number }, orgId: string | null = null, opts: ListOptions = {}): Promise<StationView[]> {
  const box = opts.bbox ?? null;
  const rows = await many<ConnectorRow>(
    `SELECT ${CONNECTOR_COLUMNS}
      WHERE ${PUBLICLY_LISTED} AND ($1::uuid IS NULL OR s.org_id = $1)${box ? ` AND ${bboxSql('s', 2)}` : ''}
      ORDER BY s.name, cp.ocpp_identity, e.evse_id`,
    box ? [orgId, ...box] : [orgId],
  );

  const bySite = new Map<string, { info: ConnectorRow; connectors: ConnectorView[] }>();
  for (const r of rows) {
    const g = bySite.get(r.site_id) ?? { info: r, connectors: [] };
    g.connectors.push(toConnectorView(r));
    bySite.set(r.site_id, g);
  }

  // Every connector's headline price in one go (it was two queries per connector).
  let prices: Map<string, { rate: number | null; inclusive: boolean }>;
  try {
    prices = opts.prices === false ? new Map() : await headlinePrices(rows.map((r) => r.connector_id), new Date());
  } catch {
    prices = new Map();
  }

  const stations: StationView[] = [];
  for (const { info, connectors } of bySite.values()) {
    const available = connectors.filter((c) => c.available).length;
    const maxKw = Math.max(0, ...connectors.map((c) => c.maxPowerKw));
    const fastestConn = connectors.reduce((a, b) => (b.maxPowerW > a.maxPowerW ? b : a), connectors[0]!);

    // Cheapest headline price across the site's connectors, in the site's currency.
    let priceFrom: number | null = null;
    let inclusive = false;
    for (const c of connectors) {
      const p = prices.get(c.connectorId);
      if (p?.rate != null && (priceFrom == null || p.rate < priceFrom)) { priceFrom = p.rate; inclusive = p.inclusive; }
    }
    const country = countryOf(info.country_code);

    stations.push({
      siteId: info.site_id,
      name: info.site_name,
      address: info.address,
      lat: info.lat,
      lon: info.lon,
      spkluId: info.spklu_id,
      operator: info.operator,
      distanceKm:
        loc && info.lat != null && info.lon != null ? haversineKm(loc.lat, loc.lon, info.lat, info.lon) : null,
      connectors,
      availableCount: available,
      totalCount: connectors.length,
      maxPowerKw: maxKw,
      fastest: `${fastestConn.maxPowerKw} kW ${fastestConn.current}`,
      priceFromMinor: priceFrom == null ? null : rateToMinor(priceFrom, country.currency),
      priceFromMajor: priceFrom,
      currency: country.currency,
      countryCode: country.code,
      timezone: info.timezone,
      pricesIncludeTax: inclusive,
    });
  }

  if (opts.sort !== false) stations.sort((a, b) => {
    if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
    // Available stations first, then by name.
    if ((b.availableCount > 0 ? 1 : 0) !== (a.availableCount > 0 ? 1 : 0)) {
      return (b.availableCount > 0 ? 1 : 0) - (a.availableCount > 0 ? 1 : 0);
    }
    return a.name.localeCompare(b.name);
  });
  return stations;
}

/** Opaque paging cursor: an offset into a stable ordering (tagged so a cursor from another query is refused). */
export function encodeCursor(offset: number, tag: string): string {
  return Buffer.from(JSON.stringify({ o: offset, t: tag })).toString('base64url');
}
export function decodeCursor(raw: unknown, tag: string): number | null {
  if (raw == null || raw === '') return 0;
  try {
    const v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')) as { o?: unknown; t?: unknown };
    return Number.isSafeInteger(v.o) && (v.o as number) >= 0 && v.t === tag ? (v.o as number) : null;
  } catch {
    return null;
  }
}

/** One connector in full, with pricing and the tariff's fixed fees. */
export async function connectorDetail(connectorUuid: string, principal?: DriverPrincipal | null, orgId: string | null = null): Promise<
  | (ConnectorView & {
      station: { siteId: string; name: string; address: string | null; operator: string; spkluId: string | null };
      energyPriceMinor: number | null;
      currency: CurrencyCode;
      countryCode: string;
      timezone: string | null;
      pricesIncludeTax: boolean;
      presetsMinor: number[];
      maxPrepaidMinor: number;
      fees: Array<{ kind: string; label: string; rate: number }>;
      reservedForYou: { id: string; expiresAt: string } | null;
      canReserve: boolean;
      /** The site's reservation fee (with PPN where the operator is PKP); null = free. */
      reservationFee: { feeMinor: number; taxMinor: number; totalMinor: number; fleetInvoice: boolean; currency: CurrencyCode } | null;
      /** A fee paid in the app: how the driver can pay it (as for a charge). */
      reservationPay: Record<string, unknown> | null;
    })
  | 'other_operator'
  | null
> {
  if (!UUID_RE.test(connectorUuid)) return null;
  const r = await one<ConnectorRow>(`SELECT ${CONNECTOR_COLUMNS} WHERE c.id = $1 AND ${PUBLICLY_LISTED}`, [connectorUuid]);
  if (!r) return null;
  if (orgId && r.org_id !== orgId) return 'other_operator';

  const view = toConnectorView(r);
  // A driver reservation: the driver who holds it may charge; everyone else waits,
  // even before the charger has reported the connector as Reserved.
  const held = await reservationOn(connectorUuid, principal);
  let reservedForYou: { id: string; expiresAt: string } | null = null;
  if (held?.mine) {
    reservedForYou = { id: held.id, expiresAt: new Date(held.expires_at).toISOString() };
    if (view.status === 'Reserved' || view.status === 'Available') {
      view.status = 'Available';
      view.available = true;
      view.blockedReason = null;
    }
  } else if (held && view.available) {
    view.status = 'Reserved';
    view.available = false;
    view.blockedReason = 'Sedang dipesan pengemudi lain.';
  } else if (view.available) {
    // A site queue: a free connector goes to the next driver waiting for it.
    const queued = await queueBlocks(connectorUuid, principal ?? null);
    if (queued) {
      view.status = 'Queued';
      view.available = false;
      view.blockedReason = queued;
    }
  }
  const canReserve = config.driverApp.reservationsEnabled && !!principal && !!(principal.account || principal.fleet) && view.available && !held;
  const country = countryOf(r.country_code);
  const feeRow = await one<{ fee: number; pkp: boolean }>(`SELECT s.reservation_fee_minor AS fee, o.pkp FROM site s JOIN organisation o ON o.id = s.org_id WHERE s.id = $1`, [r.site_id]);
  const tax = feeRow && feeRow.fee > 0 ? (await feeTaxerFor(r.org_id, country.currency, feeRow.pkp))(feeRow.fee) : null;
  const reservationFee = tax ? { feeMinor: feeRow!.fee, taxMinor: tax.ppn, totalMinor: tax.total, fleetInvoice: !!principal?.fleet, currency: country.currency } : null;
  const reservationPay = tax && canReserve && principal && !principal.fleet ? await (await import('./charge.js')).paymentSetupFor(r.org_id, principal, country.code) : null;
  let energyPrice: number | null = null;
  let pricesIncludeTax = false;
  const fees: Array<{ kind: string; label: string; rate: number }> = [];
  try {
    const { tariff } = await loadTariffForConnector(r.connector_id, r.org_id, new Date());
    energyPrice = energyRateOf(tariff);
    pricesIncludeTax = tariff.pricesIncludeTax === true;
    const FEE_LABEL: Record<string, string> = {
      session: 'Biaya layanan',
      admin: 'Biaya admin',
      idle: 'Biaya idle (per menit setelah masa tenggang)',
      time: 'Biaya waktu (per menit)',
    };
    for (const c of tariff.components) {
      if (c.kind === 'session' || c.kind === 'admin' || c.kind === 'idle' || c.kind === 'time') {
        fees.push({ kind: c.kind, label: FEE_LABEL[c.kind] ?? c.kind, rate: c.rate });
      }
    }
  } catch {
    /* no tariff → guest checkout will fall back to the regulated default */
  }

  return {
    ...view,
    station: {
      siteId: r.site_id,
      name: r.site_name,
      address: r.address,
      operator: r.operator,
      spkluId: r.spklu_id,
    },
    energyPriceMinor: energyPrice,
    /** Every amount above is in this currency (rates per kWh / minute in major units; fees in minor units). */
    currency: country.currency,
    countryCode: country.code,
    timezone: r.timezone,
    pricesIncludeTax,
    /** The amounts the app offers for a pre-purchase, and the largest, in `currency` minor units (the country's). */
    presetsMinor: [...country.prepaidPresetsMinor],
    maxPrepaidMinor: country.maxPrepaidMinor,
    fees,
    reservedForYou,
    canReserve,
    reservationFee,
    reservationPay,
  };
}

/**
 * Resolve a scanned or typed code to a connector.
 *
 * Accepts, in order of specificity:
 *   - a full connector UUID
 *   - `OCPP-IDENTITY:connectorNo` or `OCPP-IDENTITY/connectorNo`
 *   - a bare OCPP identity (→ its first connector)
 *   - an SPKLU id like `01.POSO.20.3275.010` (→ the site's first available connector)
 * A scanned URL is handled by the caller, which passes the last path segment here.
 */
export async function resolveCode(codeRaw: string, orgId: string | null = null): Promise<ConnectorView | 'other_operator' | null> {
  const found = await resolveAny(codeRaw);
  if (!found) return null;
  // A white-label app: a charger of another operator is named as such, not "unknown".
  return orgId && found.orgId !== orgId ? 'other_operator' : found.view;
}

async function resolveAny(codeRaw: string): Promise<{ view: ConnectorView; orgId: string } | null> {
  const code = String(codeRaw ?? '').trim();
  if (!code) return null;
  const v = (r: ConnectorRow) => ({ view: toConnectorView(r), orgId: r.org_id });

  // Full connector UUID.
  if (UUID_RE.test(code)) {
    const r = await one<ConnectorRow>(`SELECT ${CONNECTOR_COLUMNS} WHERE c.id = $1 AND ${PUBLICLY_LISTED}`, [code]);
    return r ? v(r) : null;
  }

  // OCPP identity, optionally with a connector number.
  const m = code.match(/^(.+?)[:/](\d{1,3})$/);
  const identity = m ? m[1]! : code;
  const connectorNo = m ? Number(m[2]) : null;

  const idRows = await many<ConnectorRow>(
    `SELECT ${CONNECTOR_COLUMNS} WHERE lower(cp.ocpp_identity) = lower($1) AND ${PUBLICLY_LISTED} ORDER BY e.evse_id`,
    [identity],
  );
  if (idRows.length) {
    const chosen = connectorNo != null ? idRows.find((r) => r.connector_no === connectorNo) : idRows[0];
    return chosen ? v(chosen) : null;
  }

  // SPKLU id → the site's first available (else first) connector.
  const spkluRows = await many<ConnectorRow>(
    `SELECT ${CONNECTOR_COLUMNS} WHERE s.spklu_id = $1 AND ${PUBLICLY_LISTED} ORDER BY e.evse_id`,
    [identity],
  );
  if (spkluRows.length) {
    const views = spkluRows.map(v);
    return views.find((x) => x.view.available) ?? views[0]!;
  }

  return null;
}
