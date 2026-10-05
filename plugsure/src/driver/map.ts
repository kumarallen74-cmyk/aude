import { createHash } from 'node:crypto';
import { listStations, priceStations, haversineKm, type BBox, type StationView } from './stations.js';
import { roamingStationsOf, roamingEligibility, type RoamingStation } from './roaming.js';
import { emspOrgForApp } from './roaming-pay.js';
import type { DriverPrincipal } from './identity.js';

/**
 * The map (docs/MOBILE-APP-SPEC.md G7): one viewport query for the native app, hosted and partner stations merged,
 * clustered on the server by zoom, filtered, paged, with an ETag.
 *
 *   hosted   chargers on this platform (any operator; an operator's own app: its own), path 'direct', guests can start;
 *   partner  locations the app's eMSP organisation receives from the hub / bilateral OCPI, path 'roaming', visible to
 *            guests too (`startable: false, reasonCode: 'sign_in'`). Hosted operators that also joined the hub are
 *            shown once, as hosted (G5).
 *
 * Clustering is a grid of CELLS_PER_TILE × CELLS_PER_TILE cells per 256-px web-mercator tile width at the requested
 * zoom (≈ 64 px cells): two or more stations in a cell are one cluster with their count, how many have a free
 * connector, their bounds and the zoom at which they come apart. From CLUSTER_MAX_ZOOM (or `cluster=0`) every
 * station is returned. Clusters are always complete; stations are paged (`limit`, `cursor`).
 */

export const CELLS_PER_TILE = 4;
export const CLUSTER_MAX_ZOOM = 15;
export const MAX_ZOOM = 20;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;

export interface MapStation {
  /** hosted: the site id; partner: `<partnerId>:<countryCode>:<partyId>:<locationId>`. */
  id: string;
  kind: 'hosted' | 'partner';
  /** How the app starts a charge here: directly at the operator (guest OK) or through roaming (signed in, card hold). */
  path: 'direct' | 'roaming';
  name: string;
  operator: string;
  address: string | null;
  lat: number;
  lon: number;
  distanceKm: number | null;
  availableCount: number;
  totalCount: number;
  maxPowerKw: number | null;
  dc: boolean;
  /** Distinct connector types, as labels (CCS2, Type 2, CHAdeMO, GB/T…). */
  connectorTypes: string[];
  priceFromMinor: number | null;
  priceFromMajor: number | null;
  /** The currency the charge is paid in (partner: null when the location's currency is not one PlugSure supports). */
  currency: string | null;
  pricesIncludeTax: boolean | null;
  startable: boolean;
  reason: string | null;
  reasonCode: 'sign_in' | 'payment' | 'fleet_limit' | 'unavailable' | null;
  /** hosted only */
  siteId?: string;
  /** partner only: what /d/v1/roaming/charge needs, plus the hold placed before a start. */
  partner?: { partnerId: string; countryCode: string; partyId: string; locationId: string; holdMinor: number | null };
}

export interface MapCluster {
  id: string;
  lat: number;
  lon: number;
  count: number;
  /** Stations in the cluster with at least one free connector. */
  available: number;
  bbox: [number, number, number, number];
  /** Zoom in to at least this to see the stations apart. */
  expansionZoom: number;
}

export interface MapFilters {
  /** Connector type labels, normalised (CCS2, TYPE2, CHADEMO, GBT, CCS1, TYPE1, TESLA). */
  connectors?: string[];
  minKw?: number;
  dc?: boolean;
  available?: boolean;
  network?: 'hosted' | 'partner';
  startable?: boolean;
}

export const normType = (label: string) => label.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function parseFilters(q: Record<string, unknown>): MapFilters {
  const f: MapFilters = {};
  const list = String(q.connector ?? '').split(',').map((x) => normType(x)).filter(Boolean);
  if (list.length) f.connectors = list;
  const minKw = Number(q.minKw);
  if (Number.isFinite(minKw) && minKw > 0) f.minKw = minKw;
  if (q.dc === '1' || q.dc === 'true') f.dc = true;
  if (q.available === '1' || q.available === 'true') f.available = true;
  if (q.network === 'hosted' || q.network === 'partner') f.network = q.network;
  if (q.startable === '1' || q.startable === 'true') f.startable = true;
  return f;
}

export function matches(s: MapStation, f: MapFilters): boolean {
  if (f.network && s.kind !== f.network) return false;
  if (f.available && s.availableCount <= 0) return false;
  if (f.dc && !s.dc) return false;
  if (f.minKw != null && (s.maxPowerKw ?? 0) < f.minKw) return false;
  if (f.startable && !s.startable) return false;
  if (f.connectors?.length && !s.connectorTypes.some((t) => f.connectors!.includes(normType(t)))) return false;
  return true;
}

export function fromHosted(v: StationView): MapStation | null {
  if (v.lat == null || v.lon == null) return null;
  return {
    id: v.siteId, kind: 'hosted', path: 'direct', name: v.name, operator: v.operator, address: v.address,
    lat: v.lat, lon: v.lon, distanceKm: v.distanceKm,
    availableCount: v.availableCount, totalCount: v.totalCount, maxPowerKw: v.maxPowerKw,
    dc: v.connectors.some((c) => c.current === 'DC'),
    connectorTypes: [...new Set(v.connectors.map((c) => c.typeLabel))],
    priceFromMinor: v.priceFromMinor, priceFromMajor: v.priceFromMajor, currency: v.currency, pricesIncludeTax: v.pricesIncludeTax,
    startable: v.availableCount > 0,
    reason: v.availableCount > 0 ? null : 'Tidak ada konektor yang tersedia saat ini.',
    reasonCode: v.availableCount > 0 ? null : 'unavailable',
    siteId: v.siteId,
  };
}

export function fromPartner(r: RoamingStation): MapStation | null {
  if (r.lat == null || r.lon == null) return null;
  const conns = r.evses.flatMap((e) => e.connectors);
  const max = conns.reduce<number | null>((m, c) => (c.maxPowerKw != null && (m == null || c.maxPowerKw > m) ? c.maxPowerKw : m), null);
  return {
    id: `${r.partnerId}:${r.countryCode}:${r.partyId}:${r.locationId}`, kind: 'partner', path: 'roaming',
    name: r.name, operator: r.operator, address: r.address, lat: r.lat, lon: r.lon, distanceKm: r.distanceKm,
    availableCount: r.availableCount, totalCount: r.totalCount, maxPowerKw: max,
    dc: conns.some((c) => c.current === 'DC'),
    connectorTypes: [...new Set(conns.map((c) => c.typeLabel))],
    // The partner's tariff, in its currency (before tax when vatPercent is given): "price per the operator".
    priceFromMinor: r.priceFromMinor, priceFromMajor: r.priceFromMajor, currency: r.currency, pricesIncludeTax: r.vatPercent == null ? null : false,
    startable: r.startable && r.availableCount > 0,
    reason: r.reason ?? (r.availableCount > 0 ? null : 'Tidak ada konektor yang tersedia saat ini.'),
    reasonCode: r.reasonCode ?? (r.availableCount > 0 ? null : 'unavailable'),
    partner: { partnerId: r.partnerId, countryCode: r.countryCode, partyId: r.partyId, locationId: r.locationId, holdMinor: r.holdMinor },
  };
}

export function inBox(lat: number, lon: number, b: BBox): boolean {
  const [w, s, e, n] = b;
  if (lat < s || lat > n) return false;
  return w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;
}

/**
 * The largest viewport a zoom may ask for: 16 tiles (a 4096-px-wide screen) at that zoom, in degrees, both ways
 * (whole world from zoom 4 down). A bigger box at a high zoom is refused (`bbox_too_large`): it would make the server
 * load and sort a continent for a street-level map.
 */
export const MAX_VIEW_TILES = 16;
export const maxSpanDeg = (zoom: number) => Math.min(360, (MAX_VIEW_TILES * 360) / 2 ** Math.max(0, Math.floor(zoom)));
export function bboxSpan(b: BBox): { lon: number; lat: number } {
  return { lon: b[0] <= b[2] ? b[2] - b[0] : 360 - b[0] + b[2], lat: b[3] - b[1] };
}
export function bboxFitsZoom(b: BBox, zoom: number): boolean {
  const s = bboxSpan(b);
  const max = maxSpanDeg(zoom);
  return s.lon <= max && s.lat <= Math.min(180, max);
}

/**
 * The first `k` of `items` by `cmp`, in order, without sorting everything: a bounded max-heap (n log k). The map pages
 * 200 at a time out of a whole country at low zoom.
 */
export function firstK<T>(items: readonly T[], k: number, cmp: (a: T, b: T) => number): T[] {
  if (k <= 0) return [];
  if (items.length <= k || k * 8 >= items.length) return [...items].sort(cmp).slice(0, k);
  const heap: T[] = [];
  const up = (i: number) => { while (i > 0) { const p = (i - 1) >> 1; if (cmp(heap[i]!, heap[p]!) <= 0) break; [heap[i], heap[p]] = [heap[p]!, heap[i]!]; i = p; } };
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < heap.length && cmp(heap[l]!, heap[m]!) > 0) m = l;
      if (r < heap.length && cmp(heap[r]!, heap[m]!) > 0) m = r;
      if (m === i) return;
      [heap[i], heap[m]] = [heap[m]!, heap[i]!];
      i = m;
    }
  };
  for (const x of items) {
    if (heap.length < k) { heap.push(x); up(heap.length - 1); }
    else if (cmp(x, heap[0]!) < 0) { heap[0] = x; down(0); }
  }
  return heap.sort(cmp);
}

/** Degrees per cell at a zoom. */
export const cellDeg = (zoom: number) => 360 / (2 ** zoom * CELLS_PER_TILE);
const cellOf = (lat: number, lon: number, zoom: number) => {
  const d = cellDeg(zoom);
  return `${Math.floor((lon + 180) / d)}:${Math.floor((lat + 90) / d)}`;
};

/** Grid clustering (pure). */
export function cluster(points: readonly MapStation[], zoom: number): { clusters: MapCluster[]; singles: MapStation[] } {
  const z = Math.max(0, Math.min(MAX_ZOOM, Math.floor(zoom)));
  const cells = new Map<string, MapStation[]>();
  for (const p of points) {
    const k = cellOf(p.lat, p.lon, z);
    const g = cells.get(k);
    if (g) g.push(p); else cells.set(k, [p]);
  }
  const clusters: MapCluster[] = [];
  const singles: MapStation[] = [];
  for (const [k, g] of cells) {
    if (g.length === 1) { singles.push(g[0]!); continue; }
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity, lat = 0, lon = 0;
    for (const p of g) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); lat += p.lat; lon += p.lon; }
    // The first zoom at which the cell's stations no longer share one cell.
    let ez = z + 1;
    while (ez < MAX_ZOOM && new Set(g.map((p) => cellOf(p.lat, p.lon, ez))).size === 1) ez++;
    clusters.push({
      id: `c${z}:${k}`, lat: Math.round((lat / g.length) * 1e6) / 1e6, lon: Math.round((lon / g.length) * 1e6) / 1e6,
      count: g.length, available: g.filter((p) => p.availableCount > 0).length, bbox: [w, s, e, n], expansionZoom: Math.min(ez, MAX_ZOOM),
    });
  }
  clusters.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  return { clusters, singles };
}

export interface MapQuery {
  bbox: BBox;
  zoom: number;
  filters: MapFilters;
  near?: { lat: number; lon: number } | null;
  limit?: number;
  offset?: number;
  cluster?: boolean;
}

export interface MapResult {
  zoom: number;
  clusters: MapCluster[];
  stations: MapStation[];
  /** Every station matching the query in the viewport (in clusters or not). */
  total: number;
  /** Stations not in a cluster (what `stations` pages through). */
  unclustered: number;
  nextOffset: number | null;
  partners: { enabled: boolean; reason: string | null };
}

/**
 * The stations in a viewport for this app and driver.
 * scopeOrg: an operator's own app (its sites only, no dedupe). emspBrandOrg: the brand whose eMSP role lists partner
 * stations (an operator's app or the PlugSure app's organisation); null: the single unbranded eMSP, as before.
 */
export async function mapQuery(q: MapQuery, ctx: { principal: DriverPrincipal | null; scopeOrg: string | null; emspBrandOrg: string | null }): Promise<MapResult> {
  const center = q.near ?? { lat: (q.bbox[1] + q.bbox[3]) / 2, lon: q.bbox[0] <= q.bbox[2] ? (q.bbox[0] + q.bbox[2]) / 2 : q.bbox[0] };
  // Prices are looked up only for the stations this page returns (not for those inside clusters).
  const hosted = q.filters.network === 'partner' ? [] : await listStations(q.near ?? undefined, ctx.scopeOrg, { bbox: q.bbox, prices: false, sort: false });
  const hostedById = new Map(hosted.map((v) => [v.siteId, v]));
  let partners: RoamingStation[] = [];
  let partnerState: { enabled: boolean; reason: string | null } = { enabled: false, reason: null };
  if (q.filters.network !== 'hosted') {
    const p = ctx.principal;
    const emsp = await emspOrgForApp(ctx.emspBrandOrg);
    if (emsp) {
      const el = p ? await roamingEligibility(p, ctx.emspBrandOrg) : null;
      const who = el?.enabled
        ? { mode: el.mode!, limitCurrency: el.limitCurrency ?? null, appDriverId: p!.appDriverId }
        : { mode: 'guest' as const };
      partners = await roamingStationsOf(el?.enabled ? el.orgId! : emsp, who, q.near ?? undefined, { dedupe: !ctx.scopeOrg, bbox: q.bbox, sort: false });
      partnerState = { enabled: true, reason: el?.enabled ? null : 'Masuk untuk mengisi di jaringan mitra.' };
    } else if (p?.fleet) {
      // A fleet card that may roam with its own operator (no app eMSP): its partner network.
      const el = await roamingEligibility(p, ctx.emspBrandOrg);
      if (el.enabled) {
        partners = await roamingStationsOf(el.orgId!, { mode: 'fleet', limitCurrency: el.limitCurrency ?? null }, q.near ?? undefined, { dedupe: !ctx.scopeOrg, bbox: q.bbox, sort: false });
        partnerState = { enabled: true, reason: null };
      }
    }
  }
  const all = [
    ...hosted.map(fromHosted),
    ...partners.filter((r) => r.lat != null && r.lon != null && inBox(r.lat, r.lon, q.bbox)).map(fromPartner),
  ].filter((x): x is MapStation => !!x && matches(x, q.filters));

  for (const s of all) if (s.distanceKm == null) s.distanceKm = q.near ? haversineKm(q.near.lat, q.near.lon, s.lat, s.lon) : null;
  // Each station's distance once (not inside the comparator).
  const dist = new Map<MapStation, number>();
  for (const s of all) dist.set(s, haversineKm(center.lat, center.lon, s.lat, s.lon));
  // Nearest first (to the driver, else the viewport's centre); ties: free first, then by name and id (stable paging).
  const cmp = (a: MapStation, b: MapStation) =>
    dist.get(a)! - dist.get(b)! || (b.availableCount > 0 ? 1 : 0) - (a.availableCount > 0 ? 1 : 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

  const zoom = Math.max(0, Math.min(MAX_ZOOM, Math.floor(q.zoom)));
  const doCluster = q.cluster !== false && zoom < CLUSTER_MAX_ZOOM;
  const { clusters, singles } = doCluster ? cluster(all, zoom) : { clusters: [], singles: all };
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(q.limit ?? DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  // Only the stations up to this page are ordered (clustered ones never are).
  const page = firstK(singles, offset + limit, cmp).slice(offset);
  const priced = page.filter((p) => p.kind === 'hosted').map((p) => hostedById.get(p.id)!).filter(Boolean);
  await priceStations(priced);
  for (const p of page) {
    const v = p.kind === 'hosted' ? hostedById.get(p.id) : undefined;
    if (v) { p.priceFromMinor = v.priceFromMinor; p.priceFromMajor = v.priceFromMajor; p.pricesIncludeTax = v.pricesIncludeTax; }
  }
  return {
    zoom, clusters, stations: page, total: all.length, unclustered: singles.length,
    nextOffset: offset + limit < singles.length ? offset + limit : null,
    partners: partnerState,
  };
}

/** A strong validator for a map answer (the app sends it back as If-None-Match). */
export function etagOf(body: unknown): string {
  return `"${createHash('sha1').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
}
