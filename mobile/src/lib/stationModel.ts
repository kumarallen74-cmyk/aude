import type { ConnectorStatus, CurrencyCode, MapStationDto, Reliability, RoamingStation, StationView } from '@/api/types';
import { isCurrency } from './money';

/**
 * One station model for the map and lists, whether hosted on the PlugSure CSMS (`direct`) or a partner CPO
 * reached through the hub (`partner`, spec §2.2: "two charge paths, one UI").
 */
export type Availability = 'available' | 'busy' | 'fault' | 'offline' | 'unknown';

export interface MapStation {
  key: string;
  kind: 'hosted' | 'partner';
  siteId: string | null;
  partner: { partnerId: string; countryCode: string; partyId: string; locationId: string } | null;
  name: string;
  address: string | null;
  operator: string;
  lat: number;
  lon: number;
  distanceKm: number | null;
  availableCount: number;
  totalCount: number;
  maxPowerKw: number;
  connectorTypes: string[];
  currents: ('AC' | 'DC')[];
  priceFromMajor: number | null;
  currency: CurrencyCode | null;
  pricesIncludeTax: boolean;
  startable: boolean;
  reason: string | null;
  /** §15.4 `sign_in` | `payment` | `fleet_limit` | `unavailable`. */
  reasonCode?: string | null;
  holdMinor: number | null;
  availability: Availability;
  openNow: boolean | null;
  reliability: Reliability | null;
}

const BUSY: ConnectorStatus[] = ['Charging', 'Occupied', 'Reserved', 'Queued'];
const FAULT: ConnectorStatus[] = ['Faulted', 'Blocked', 'Maintenance'];

export function availabilityOf(statuses: string[]): Availability {
  if (!statuses.length) return 'unknown';
  if (statuses.includes('Available')) return 'available';
  if (statuses.some((s) => BUSY.includes(s as ConnectorStatus))) return 'busy';
  if (statuses.every((s) => s === 'Offline')) return 'offline';
  if (statuses.some((s) => FAULT.includes(s as ConnectorStatus))) return 'fault';
  return statuses.every((s) => s === 'Unavailable' || s === 'Offline') ? 'offline' : 'unknown';
}

export function fromHosted(s: StationView): MapStation | null {
  if (s.lat == null || s.lon == null) return null;
  return {
    key: `h:${s.siteId}`,
    kind: 'hosted',
    siteId: s.siteId,
    partner: null,
    name: s.name,
    address: s.address,
    operator: s.operator,
    lat: s.lat,
    lon: s.lon,
    distanceKm: s.distanceKm,
    availableCount: s.availableCount,
    totalCount: s.totalCount,
    maxPowerKw: s.maxPowerKw,
    connectorTypes: [...new Set(s.connectors.map((c) => c.typeLabel))],
    currents: [...new Set(s.connectors.map((c) => c.current))],
    priceFromMajor: s.priceFromMajor,
    currency: s.currency,
    pricesIncludeTax: s.pricesIncludeTax,
    startable: true,
    reason: null,
    holdMinor: null,
    availability: availabilityOf(s.connectors.map((c) => c.status)),
    openNow: null,
    reliability: s.reliability ?? null,
  };
}

export function partnerKey(p: { partnerId: string; countryCode: string; partyId: string; locationId: string }): string {
  return `p:${p.partnerId}:${p.countryCode}:${p.partyId}:${p.locationId}`;
}

export function fromPartner(s: RoamingStation): MapStation | null {
  if (s.lat == null || s.lon == null) return null;
  const connectors = s.evses.flatMap((e) => e.connectors);
  return {
    key: partnerKey(s),
    kind: 'partner',
    siteId: null,
    partner: { partnerId: s.partnerId, countryCode: s.countryCode, partyId: s.partyId, locationId: s.locationId },
    name: s.name,
    address: s.address,
    operator: s.operator,
    lat: s.lat,
    lon: s.lon,
    distanceKm: s.distanceKm,
    availableCount: s.availableCount,
    totalCount: s.totalCount,
    maxPowerKw: Math.max(0, ...connectors.map((c) => c.maxPowerKw ?? 0)),
    connectorTypes: [...new Set(connectors.map((c) => c.typeLabel))],
    currents: [...new Set(connectors.map((c) => c.current))],
    priceFromMajor: s.priceCurrency && s.priceCurrency === s.currency ? s.priceFromMajor : null,
    currency: isCurrency(s.currency) ? s.currency : null,
    pricesIncludeTax: false,
    startable: s.startable,
    reason: s.reason,
    holdMinor: s.holdMinor,
    availability: availabilityOf(s.evses.map((e) => e.status)),
    openNow: s.openingTimes?.openNow ?? (s.openingTimes?.twentyfourseven ? true : null),
    reliability: s.reliability ?? null,
  };
}

/**
 * Merge hosted and partner stations. A hosted tenant that also appears through the hub import is shown once,
 * on the direct path ([§14 G5] — until the server dedupes, match by name + ~60 m).
 */
export function mergeStations(hosted: StationView[], partners: RoamingStation[]): MapStation[] {
  const h = hosted.map(fromHosted).filter((x): x is MapStation => !!x);
  const p = partners.map(fromPartner).filter((x): x is MapStation => !!x);
  const dup = (a: MapStation, b: MapStation) =>
    Math.abs(a.lat - b.lat) < 0.0006 && Math.abs(a.lon - b.lon) < 0.0006 && a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
  const merged = [...h, ...p.filter((x) => !h.some((y) => dup(x, y)))];
  return merged.sort((a, b) => {
    if (a.distanceKm != null && b.distanceKm != null && a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    return (b.availableCount > 0 ? 1 : 0) - (a.availableCount > 0 ? 1 : 0) || a.name.localeCompare(b.name);
  });
}

export function networksOf(list: MapStation[]): string[] {
  return [...new Set(list.map((s) => s.operator))].sort((a, b) => a.localeCompare(b));
}

const AC_TYPES = /type ?[12]|gb\/?t ?ac|schuko|tesla/i;

/** A station of `GET /d/v1/map` (§15.4) — hosted and partner, merged and de-duplicated by the server (G5). */
export function fromMapDto(d: MapStationDto): MapStation {
  const partner = d.kind === 'partner' && d.partner ? { partnerId: d.partner.partnerId, countryCode: d.partner.countryCode, partyId: d.partner.partyId, locationId: d.partner.locationId } : null;
  const ac = d.connectorTypes.some((t) => AC_TYPES.test(t));
  return {
    key: partner ? partnerKey(partner) : `h:${d.siteId ?? d.id}`,
    kind: d.kind,
    siteId: d.kind === 'hosted' ? (d.siteId ?? d.id) : null,
    partner,
    name: d.name,
    address: d.address ?? null,
    operator: d.operator,
    lat: d.lat,
    lon: d.lon,
    distanceKm: d.distanceKm ?? null,
    availableCount: d.availableCount,
    totalCount: d.totalCount,
    maxPowerKw: d.maxPowerKw ?? 0,
    connectorTypes: d.connectorTypes,
    currents: [...(ac || !d.dc ? (['AC'] as const) : []), ...(d.dc ? (['DC'] as const) : [])],
    priceFromMajor: d.priceFromMajor,
    currency: d.currency && isCurrency(d.currency) ? d.currency : null,
    pricesIncludeTax: !!d.pricesIncludeTax,
    startable: d.startable,
    reason: d.reason,
    reasonCode: d.reasonCode,
    holdMinor: d.partner?.holdMinor ?? null,
    availability: d.availableCount > 0 ? 'available' : d.totalCount > 0 ? 'busy' : 'unknown',
    openNow: null,
    reliability: d.reliability ?? null,
  };
}
