import Supercluster from 'supercluster';
import type { MapStation } from './stationModel';

export interface Region {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function regionToBBox(r: Region): [number, number, number, number] {
  return [r.longitude - r.longitudeDelta / 2, r.latitude - r.latitudeDelta / 2, r.longitude + r.longitudeDelta / 2, r.latitude + r.latitudeDelta / 2];
}

/** Web-mercator zoom level that shows `longitudeDelta` degrees across `widthPx`. */
export function zoomForRegion(r: Region, widthPx = 390): number {
  const z = Math.log2((360 * (widthPx / 256)) / Math.max(r.longitudeDelta, 1e-6));
  return Math.max(1, Math.min(20, z));
}

export function regionForZoom(lat: number, lon: number, zoom: number, widthPx: number, heightPx: number): Region {
  const lonDelta = (360 * (widthPx / 256)) / 2 ** zoom;
  const latDelta = lonDelta * (heightPx / widthPx) * Math.cos((lat * Math.PI) / 180);
  return { latitude: lat, longitude: lon, latitudeDelta: latDelta, longitudeDelta: lonDelta };
}

/** Region that fits every point, with padding. */
export function fitRegion(points: { lat: number; lon: number }[], pad = 1.4): Region | null {
  if (!points.length) return null;
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max(0.02, (maxLat - minLat) * pad),
    longitudeDelta: Math.max(0.02, (maxLon - minLon) * pad),
  };
}

export type ClusterItem =
  | { type: 'cluster'; id: number | string; lat: number; lon: number; count: number; available: number; expansionZoom?: number }
  | { type: 'station'; lat: number; lon: number; station: MapStation };

/**
 * Client clustering (supercluster). The map tab uses the server's clusters (§15.4 `GET /d/v1/map`); this stays for
 * the offline cache (last answer re-clustered on the phone) and the mock backend.
 */
export class StationClusterer {
  private index = new Supercluster<{ key: string; available: number }, { available: number }>({
    radius: 64,
    maxZoom: 15,
    map: (p) => ({ available: p.available > 0 ? 1 : 0 }),
    reduce: (acc, p) => {
      acc.available += p.available;
    },
  });
  private byKey = new Map<string, MapStation>();

  load(stations: MapStation[]): this {
    this.byKey = new Map(stations.map((s) => [s.key, s]));
    this.index.load(
      stations.map((s) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
        properties: { key: s.key, available: s.availableCount },
      })),
    );
    return this;
  }

  query(region: Region, zoom: number): ClusterItem[] {
    const bbox = regionToBBox(region);
    return this.index.getClusters(bbox, Math.floor(zoom)).map((f) => {
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const p = f.properties as { cluster?: boolean; cluster_id?: number; point_count?: number; available?: number; key?: string };
      if (p.cluster) return { type: 'cluster', id: p.cluster_id!, lat, lon, count: p.point_count!, available: p.available ?? 0 };
      return { type: 'station', lat, lon, station: this.byKey.get(p.key!)! };
    });
  }

  expansionZoom(clusterId: number | string): number {
    return this.index.getClusterExpansionZoom(Number(clusterId));
  }
}

/** Web Mercator tile math (used by the web map fallback). */
export function lonToX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 256 * 2 ** zoom;
}
export function latToY(lat: number, zoom: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** zoom;
}
export function xToLon(x: number, zoom: number): number {
  return (x / (256 * 2 ** zoom)) * 360 - 180;
}
export function yToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (256 * 2 ** zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** A bbox rounded outwards to `step` degrees, so small pans reuse the cached server answer. */
export function snapBBox(b: [number, number, number, number], step = 0.01): [number, number, number, number] {
  const r = (n: number, f: (x: number) => number) => Math.round(f(n / step) * step * 1e6) / 1e6;
  return [r(b[0], Math.floor), r(b[1], Math.floor), r(b[2], Math.ceil), r(b[3], Math.ceil)];
}

/** Server cap (§15.4): a viewport may span at most 16 tiles at its zoom (both ways), else 400 `bbox_too_large`. */
export const maxSpanDeg = (zoom: number) => Math.min(360, (16 * 360) / 2 ** Math.max(0, Math.floor(zoom)));

/**
 * The map query for a region: an integer zoom and the region's bbox snapped outwards to an eighth of a tile (so small
 * pans reuse the cached answer) and never larger than the server allows at that zoom.
 */
export function viewportQuery(region: Region, widthPx: number): { zoom: number; bbox: [number, number, number, number] } {
  const zoom = Math.round(zoomForRegion(region, widthPx));
  const step = 360 / 2 ** zoom / 8;
  const max = maxSpanDeg(zoom);
  const half = (d: number, cap: number) => Math.min(d, cap) / 2;
  const lonHalf = half(region.longitudeDelta, max * 0.9);
  const latHalf = half(region.latitudeDelta, Math.min(170, max * 0.9));
  const raw: [number, number, number, number] = [
    Math.max(-180, region.longitude - lonHalf), Math.max(-85, region.latitude - latHalf),
    Math.min(180, region.longitude + lonHalf), Math.min(85, region.latitude + latHalf),
  ];
  return { zoom, bbox: snapBBox(raw, step) };
}
