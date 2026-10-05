import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { MapViewport } from '@/api/types';
import { applyFilters, clientOnly, filtersToQuery, type Filters } from '@/lib/filters';
import { StationClusterer, viewportQuery, type ClusterItem, type Region } from '@/lib/geo';
import { fromMapDto, type MapStation } from '@/lib/stationModel';
import { kv } from '@/lib/storage';
import { useStore } from '@/lib/store';
import { authStore, useMe } from '@/state/auth';

const CACHE_KEY = 'ps.cache.map.v2';

interface Cached {
  at: number;
  list: MapViewport;
}

/** Waits until the viewport stops moving (pans fire many region changes). */
function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

/** Server clusters / stations → marker items, with the filters the server does not apply removed. */
export function toItems(vp: MapViewport, f: Filters): ClusterItem[] {
  const rest = clientOnly(f);
  const stations = applyFilters(vp.stations.map(fromMapDto), rest);
  return [
    ...vp.clusters.map((c) => ({ type: 'cluster' as const, id: c.id, lat: c.lat, lon: c.lon, count: c.count, available: c.available, expansionZoom: c.expansionZoom })),
    ...stations.map((s) => ({ type: 'station' as const, lat: s.lat, lon: s.lon, station: s })),
  ];
}

/**
 * The map tab's data (§15.4): `GET /d/v1/map` for the markers (clustered on the server by zoom) and the same call with
 * `cluster=0` for the list under the map (nearest first). Filters go to the server where it can apply them.
 * The last list answer is kept on the phone, so a cold start without network still shows stations (spec §9).
 */
export function useMapViewport(region: Region, widthPx: number, near: { lat: number; lon: number } | null, filters: Filters) {
  const token = useStore(authStore, (s) => s.token);
  const me = useMe();
  const signedIn = !!me.data?.account || !!me.data?.fleet;
  const settled = useSettled(region, 250);
  const { zoom, bbox } = viewportQuery(settled, widthPx);
  const query = filtersToQuery(filters);
  const nearKey = near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : '-';
  const [cache, setCache] = useState<Cached | null>(null);

  useEffect(() => {
    void kv.get<Cached>(CACHE_KEY).then(setCache);
  }, []);

  // The partner stations' "startable" / reason depend on who asks: the key carries the identity tier.
  const who = token ? (signedIn ? 'account' : 'guest') : 'none';
  const markers = useQuery({
    queryKey: ['map', bbox, zoom, query, who],
    queryFn: ({ signal }) => api.stations.map({ bbox, zoom, near, filters: query }, signal),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchInterval: 45_000,
  });
  const list = useQuery({
    queryKey: ['mapList', bbox, nearKey, query, who],
    queryFn: ({ signal }) => api.stations.map({ bbox, zoom, near, filters: query, cluster: false, limit: 100 }, signal),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchInterval: 45_000,
  });

  useEffect(() => {
    if (list.data) void kv.set(CACHE_KEY, { at: Date.now(), list: list.data } satisfies Cached);
  }, [list.data]);

  const fromCache = !list.data && !!cache;
  const listData = list.data ?? cache?.list ?? null;
  const rest = useMemo(() => clientOnly(filters), [filters]);
  const stations: MapStation[] = useMemo(() => (listData ? applyFilters(listData.stations.map(fromMapDto), rest) : []), [listData, rest]);

  const items: ClusterItem[] = useMemo(() => {
    if (markers.data) return toItems(markers.data, filters);
    // Offline: cluster the cached list on the phone.
    if (!stations.length) return [];
    return new StationClusterer().load(stations).query(settled, zoom);
  }, [markers.data, filters, stations, settled, zoom]);

  return {
    items,
    stations,
    total: markers.data?.total ?? listData?.total ?? 0,
    loading: !listData && list.isLoading,
    error: list.error && !listData ? list.error : null,
    fromCache,
    updatedAt: list.data ? list.dataUpdatedAt : cache?.at ?? null,
    partnerInfo: markers.data?.partners ?? null,
    refetch: () => Promise.all([markers.refetch(), list.refetch()]),
  };
}
