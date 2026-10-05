import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { RoamingStations, StationView } from '@/api/types';
import { brand } from '@/config';
import { kv, KEYS } from '@/lib/storage';
import { mergeStations, type MapStation } from '@/lib/stationModel';
import { authStore, useMe } from '@/state/auth';
import { useStore } from '@/lib/store';
import { qk } from '@/state/queryClient';

interface Cached {
  at: number;
  hosted: StationView[];
  partners: RoamingStations | null;
}

/**
 * Hosted + partner stations, merged; the last answer is cached on the device so a cold start or a dead network
 * still shows the map (statuses then marked as possibly stale, spec §9).
 * [§14 G7] will replace the two calls with one bbox query; the API layer already feature-detects it.
 */
export function useStations(near: { lat: number; lon: number } | null) {
  const token = useStore(authStore, (s) => s.token);
  const me = useMe();
  const signedIn = !!me.data?.account || !!me.data?.fleet;
  const [cache, setCache] = useState<Cached | null>(null);

  useEffect(() => {
    void kv.get<Cached>(KEYS.stationsCache).then(setCache);
  }, []);

  const hosted = useQuery({
    queryKey: qk.stations(near?.lat, near?.lon),
    queryFn: ({ signal }) => api.stations.list(near, signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const partners = useQuery({
    queryKey: qk.roaming(signedIn, near?.lat, near?.lon),
    queryFn: ({ signal }) => api.stations.roaming(near, signal),
    enabled: !!token && brand.features.roaming && brand.scope === 'network',
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  useEffect(() => {
    if (hosted.data) {
      const c: Cached = { at: Date.now(), hosted: hosted.data, partners: partners.data ?? null };
      void kv.set(KEYS.stationsCache, c);
    }
  }, [hosted.data, partners.data]);

  const hostedList = hosted.data ?? cache?.hosted ?? null;
  const partnerList = useMemo(() => partners.data?.stations ?? cache?.partners?.stations ?? [], [partners.data, cache]);
  const stations: MapStation[] = useMemo(() => (hostedList ? mergeStations(hostedList, partnerList) : []), [hostedList, partnerList]);
  const fromCache = !hosted.data && !!cache;

  return {
    stations,
    loading: !hostedList && hosted.isLoading,
    error: hosted.error && !hostedList ? hosted.error : null,
    fromCache,
    updatedAt: hosted.data ? hosted.dataUpdatedAt : cache?.at ?? null,
    partnerInfo: partners.data ? { enabled: partners.data.enabled, reason: partners.data.reason ?? null } : null,
    refetch: () => Promise.all([hosted.refetch(), partners.refetch()]),
    raw: { hosted: hostedList, partners: partnerList },
  };
}
