import type { MapFilterQuery } from '@/api/stations';
import type { MapStation } from './stationModel';

/**
 * Station filters (spec §4.1.2, §6.2). The map sends what the server filters (§15.4: connector, minKw, dc, available,
 * network, startable — `filtersToQuery`) and applies the rest on the phone (`clientOnly`: operator, price, AC, open now).
 */
export type ConnectorFilter = 'CCS2' | 'Type 2' | 'CHAdeMO' | 'GB/T';

export interface Filters {
  connectors: ConnectorFilter[];
  current: 'any' | 'AC' | 'DC';
  minKw: number;
  availableNow: boolean;
  startableInApp: boolean;
  /** Operator / network names; empty = all. */
  networks: string[];
  /** Max energy price per kWh, in major units of that currency. */
  maxPrice: Partial<Record<'IDR' | 'MYR' | 'SGD', number>>;
  openNow: boolean;
  /** Include partner networks (roaming) on the map. */
  partners: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  connectors: [],
  current: 'any',
  minKw: 0,
  availableNow: false,
  startableInApp: false,
  networks: [],
  maxPrice: {},
  openNow: false,
  partners: true,
};

export const POWER_STEPS = [0, 7, 22, 50, 100, 150] as const;

export function matchesFilters(s: MapStation, f: Filters): boolean {
  if (!f.partners && s.kind === 'partner') return false;
  if (f.availableNow && s.availableCount <= 0) return false;
  if (f.startableInApp && !s.startable) return false;
  if (f.current !== 'any' && !s.currents.includes(f.current)) return false;
  if (f.minKw > 0 && s.maxPowerKw < f.minKw) return false;
  if (f.connectors.length && !f.connectors.some((c) => s.connectorTypes.includes(c))) return false;
  if (f.networks.length && !f.networks.includes(s.operator)) return false;
  const cap = s.currency ? f.maxPrice[s.currency] : undefined;
  // Unknown price passes ("price per the operator"): we never hide a station for what we do not know.
  if (cap != null && s.priceFromMajor != null && s.priceFromMajor > cap) return false;
  // Open now: only stations KNOWN to be closed are hidden (spec: "open now (if data)").
  if (f.openNow && s.openNow === false) return false;
  return true;
}

export function applyFilters(list: MapStation[], f: Filters): MapStation[] {
  return list.filter((s) => matchesFilters(s, f));
}

export function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.connectors.length) n++;
  if (f.current !== 'any') n++;
  if (f.minKw > 0) n++;
  if (f.availableNow) n++;
  if (f.startableInApp) n++;
  if (f.networks.length) n++;
  if (Object.values(f.maxPrice).some((v) => v != null)) n++;
  if (f.openNow) n++;
  if (!f.partners) n++;
  return n;
}

const CONNECTOR_PARAM: Record<ConnectorFilter, string> = { CCS2: 'CCS2', 'Type 2': 'TYPE2', CHAdeMO: 'CHADEMO', 'GB/T': 'GBT' };

/** The `GET /d/v1/map` filter parameters (§15.4). */
export function filtersToQuery(f: Filters): MapFilterQuery {
  const q: MapFilterQuery = {};
  if (f.connectors.length) q.connector = f.connectors.map((c) => CONNECTOR_PARAM[c]).join(',');
  if (f.minKw > 0) q.minKw = f.minKw;
  if (f.current === 'DC') q.dc = 1;
  if (f.availableNow) q.available = 1;
  if (f.startableInApp) q.startable = 1;
  if (!f.partners) q.network = 'hosted';
  return q;
}

/** What the server does not filter: operators, price caps, AC only, opening hours. */
export function clientOnly(f: Filters): Filters {
  return { ...DEFAULT_FILTERS, current: f.current === 'AC' ? 'AC' : 'any', networks: f.networks, maxPrice: f.maxPrice, openNow: f.openNow };
}
