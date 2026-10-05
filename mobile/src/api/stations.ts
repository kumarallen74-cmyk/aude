import type { Http } from './http';
import { ApiError, seg } from './http';
import type { ConnectorDetail, ConnectorView, MapViewport, Meta, RoamingStations, SiteQueueView, StationsPage, StationView } from './types';

export interface LatLon {
  lat: number;
  lon: number;
}

/** [west, south, east, north] in degrees (`w > e` crosses the antimeridian). */
export type BBox = [number, number, number, number];

/** §15.4 map filters (`connector=CCS2,TYPE2&minKw=50&dc=1&available=1&network=hosted|partner&startable=1`). */
export interface MapFilterQuery {
  connector?: string;
  minKw?: number;
  dc?: 1;
  available?: 1;
  network?: 'hosted' | 'partner';
  startable?: 1;
}

const bboxParam = (b: BBox) => b.map((n) => n.toFixed(5)).join(',');
const nearParam = (n?: LatLon | null) => (n ? `${n.lat.toFixed(5)},${n.lon.toFixed(5)}` : undefined);

/** Public browse (token optional, §15.2): stations, the map, connectors, code resolution, settings, site queues. */
export const stationsApi = (http: Http) => ({
  /** `GET /d/v1/stations` without paging: every hosted station (nearest first with lat/lon). */
  list: (near?: LatLon | null, signal?: AbortSignal) =>
    http.get<{ stations: StationView[] }>('/v1/stations', { query: near ? { lat: near.lat, lon: near.lon } : undefined, signal }).then((r) => r.stations),

  /** `GET /d/v1/stations?bbox&near&limit&cursor` — the native list view (hosted only, full StationView, paged). */
  page: (q: { bbox?: BBox | null; near?: LatLon | null; limit?: number; cursor?: string | null }, signal?: AbortSignal) =>
    http.get<StationsPage>('/v1/stations', {
      query: { bbox: q.bbox ? bboxParam(q.bbox) : undefined, near: nearParam(q.near), limit: q.limit ?? 50, cursor: q.cursor ?? undefined },
      signal,
    }),

  /**
   * `GET /d/v1/map` — hosted + partner stations in a viewport, clustered on the server by zoom (`cluster: false` →
   * none, nearest first), filtered and paged. 400 `bad_bbox` / `bad_zoom` / `bad_limit` / `bad_cursor`.
   */
  map: (
    q: { bbox: BBox; zoom: number; near?: LatLon | null; limit?: number; cursor?: string | null; cluster?: boolean; filters?: MapFilterQuery },
    signal?: AbortSignal,
  ) =>
    http.get<MapViewport>('/v1/map', {
      query: {
        bbox: bboxParam(q.bbox),
        zoom: Math.max(0, Math.min(22, Math.round(q.zoom))),
        near: nearParam(q.near),
        limit: q.limit,
        cursor: q.cursor ?? undefined,
        cluster: q.cluster === false ? 0 : undefined,
        ...(q.filters ?? {}),
      },
      signal,
    }),

  /** `GET /d/v1/roaming/stations` — partner networks (full EVSE detail for the partner screen). */
  roaming: (near?: LatLon | null, signal?: AbortSignal) =>
    http.get<RoamingStations>('/v1/roaming/stations', { query: near ? { lat: near.lat, lon: near.lon } : undefined, signal }),

  connector: (id: string, signal?: AbortSignal) => http.get<ConnectorDetail>(`/v1/connectors/${seg(id)}`, { signal }),

  /** `GET /d/v1/resolve?code=` (kept for the web app; the native app uses links.resolve). Null when unknown. */
  resolve: async (code: string): Promise<ConnectorView | null> => {
    try {
      return await http.get<ConnectorView>('/v1/resolve', { query: { code } });
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'not_found' && e.code !== 'other_operator') return null;
      throw e;
    }
  },

  meta: () => http.get<Meta>('/v1/meta'),

  siteQueue: (siteId: string) => http.get<SiteQueueView>(`/v1/sites/${seg(siteId)}/queue`),
});
