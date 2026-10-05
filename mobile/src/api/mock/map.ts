import type { MapCluster, MapStationDto, MapViewport, RoamingStation, StationView } from '../types';

/**
 * The mock's `GET /d/v1/map` and paged `GET /d/v1/stations` (§15.4), following the server's rules: hosted and
 * partner stations merged, a grid of 4×4 cells per 256-px tile at `zoom`, ≥ 2 stations in a cell → a cluster, none
 * from zoom 15 or with `cluster=0`, the rest nearest-first and paged by an opaque cursor tied to the query.
 */
export function hostedDto(s: StationView): MapStationDto {
  return {
    id: s.siteId, kind: 'hosted', path: 'direct', siteId: s.siteId, name: s.name, operator: s.operator, address: s.address, lat: s.lat!, lon: s.lon!,
    distanceKm: s.distanceKm, availableCount: s.availableCount, totalCount: s.totalCount, maxPowerKw: s.maxPowerKw,
    dc: s.connectors.some((c) => c.current === 'DC'), connectorTypes: [...new Set(s.connectors.map((c) => c.typeLabel))],
    priceFromMinor: s.priceFromMinor, priceFromMajor: s.priceFromMajor, currency: s.currency, pricesIncludeTax: s.pricesIncludeTax,
    startable: true, reason: null, reasonCode: null, reliability: s.reliability ?? null,
  };
}

export function partnerDto(p: RoamingStation): MapStationDto {
  const cs = p.evses.flatMap((e) => e.connectors);
  return {
    id: `${p.partnerId}:${p.countryCode}:${p.partyId}:${p.locationId}`, kind: 'partner', path: 'roaming', name: p.name, operator: p.operator, address: p.address,
    lat: p.lat!, lon: p.lon!, distanceKm: p.distanceKm, availableCount: p.availableCount, totalCount: p.totalCount,
    maxPowerKw: Math.max(0, ...cs.map((c) => c.maxPowerKw ?? 0)), dc: cs.some((c) => c.current === 'DC'), connectorTypes: [...new Set(cs.map((c) => c.typeLabel))],
    priceFromMinor: p.priceFromMinor, priceFromMajor: p.priceFromMajor, currency: (p.currency ?? null) as MapStationDto['currency'], pricesIncludeTax: false,
    startable: p.startable, reason: p.reason, reasonCode: p.startable ? null : 'sign_in',
    partner: { partnerId: p.partnerId, countryCode: p.countryCode, partyId: p.partyId, locationId: p.locationId, holdMinor: p.holdMinor },
    reliability: p.reliability ?? null,
  };
}

export type BBox = [number, number, number, number];

export function parseBBox(v: string | null): BBox | null {
  if (!v) return null;
  const n = v.split(',').map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  const [w, s, e, nn] = n as BBox;
  if (s > nn || s < -90 || nn > 90 || w < -180 || e > 180) return null;
  return [w, s, e, nn];
}

export function inBBox(b: BBox, lat: number, lon: number): boolean {
  const inLon = b[0] <= b[2] ? lon >= b[0] && lon <= b[2] : lon >= b[0] || lon <= b[2];
  return inLon && lat >= b[1] && lat <= b[3];
}

const LABEL_PARAM = (l: string) => l.replace(/\s|\//g, '').toUpperCase();

export function matchesQuery(d: MapStationDto, q: URLSearchParams): boolean {
  const conn = q.get('connector');
  if (conn && !conn.split(',').some((c) => d.connectorTypes.map(LABEL_PARAM).includes(c.toUpperCase()))) return false;
  const minKw = Number(q.get('minKw') ?? 0);
  if (minKw && (d.maxPowerKw ?? 0) < minKw) return false;
  if (q.get('dc') === '1' && !d.dc) return false;
  if (q.get('available') === '1' && d.availableCount <= 0) return false;
  if (q.get('startable') === '1' && !d.startable) return false;
  const net = q.get('network');
  if (net === 'hosted' && d.kind !== 'hosted') return false;
  if (net === 'partner' && d.kind !== 'partner') return false;
  return true;
}

const enc = (o: object) => (typeof btoa === 'function' ? btoa(JSON.stringify(o)) : Buffer.from(JSON.stringify(o)).toString('base64'));
const dec = (s: string): { o: number; t: string } | null => {
  try {
    return JSON.parse(typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('utf8'));
  } catch {
    return null;
  }
};

/** Paging tied to the query: a cursor from another query is refused (400 bad_cursor). */
export function page<T>(all: T[], q: URLSearchParams, defLimit: number, maxLimit: number): { items: T[]; nextCursor: string | null } | { error: string } {
  const limit = q.has('limit') ? Number(q.get('limit')) : defLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) return { error: 'bad_limit' };
  const tag = [...q.entries()].filter(([k]) => k !== 'cursor').map(([k, v]) => `${k}=${v}`).sort().join('&');
  let offset = 0;
  const c = q.get('cursor');
  if (c) {
    const d = dec(c);
    if (!d || d.t !== tag) return { error: 'bad_cursor' };
    offset = d.o;
  }
  const items = all.slice(offset, offset + limit);
  return { items, nextCursor: offset + limit < all.length ? enc({ o: offset + limit, t: tag }) : null };
}

export function mapAnswer(all: MapStationDto[], q: URLSearchParams, partners: MapViewport['partners']): MapViewport | { error: string } {
  const bbox = parseBBox(q.get('bbox'));
  if (!bbox) return { error: 'bad_bbox' };
  const zoom = Number(q.get('zoom'));
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) return { error: 'bad_zoom' };
  const max = Math.min(360, (16 * 360) / 2 ** zoom);
  const lonSpan = bbox[0] <= bbox[2] ? bbox[2] - bbox[0] : 360 - bbox[0] + bbox[2];
  if (lonSpan > max || bbox[3] - bbox[1] > Math.min(180, max)) return { error: 'bbox_too_large' };
  const near = q.get('near')?.split(',').map(Number);
  const c = near && near.length === 2 ? { lat: near[0]!, lon: near[1]! } : { lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 };
  const dist = (d: MapStationDto) => Math.hypot(d.lat - c.lat, (d.lon - c.lon) * Math.cos((c.lat * Math.PI) / 180));
  const inView = all.filter((d) => inBBox(bbox, d.lat, d.lon) && matchesQuery(d, q)).sort((a, b) => dist(a) - dist(b));

  const clusters: MapCluster[] = [];
  let rest = inView;
  if (zoom < 15 && q.get('cluster') !== '0') {
    const cell = 360 / (2 ** zoom * 4);
    const cells = new Map<string, MapStationDto[]>();
    for (const d of inView) {
      const k = `${Math.floor((d.lon + 180) / cell)}:${Math.floor((d.lat + 90) / cell)}`;
      cells.set(k, [...(cells.get(k) ?? []), d]);
    }
    rest = [];
    for (const [k, ds] of cells) {
      if (ds.length < 2) {
        rest.push(...ds);
        continue;
      }
      const lats = ds.map((d) => d.lat);
      const lons = ds.map((d) => d.lon);
      const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lons) - Math.min(...lons), 1e-4);
      clusters.push({
        id: `c${zoom}:${k}`,
        lat: lats.reduce((a, b) => a + b, 0) / ds.length,
        lon: lons.reduce((a, b) => a + b, 0) / ds.length,
        count: ds.length,
        available: ds.filter((d) => d.availableCount > 0).length,
        bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
        expansionZoom: Math.min(15, Math.max(zoom + 1, Math.ceil(Math.log2(360 / (span * 4))))),
      });
    }
    rest.sort((a, b) => dist(a) - dist(b));
  }
  const p = page(rest, q, 200, 500);
  if ('error' in p) return p;
  return { zoom, bbox, clusters, stations: p.items, total: inView.length, unclustered: rest.length, nextCursor: p.nextCursor, partners };
}
