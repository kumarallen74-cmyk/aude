import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { Screen } from '@/components/Screen';
import { SkeletonList } from '@/components/Skeleton';
import { ErrorState, EmptyState } from '@/components/StateView';
import { StationRow } from '@/components/StationRow';
import { useStations } from '@/features/stations';
import type { MapStation } from '@/lib/stationModel';
import { useStore } from '@/lib/store';
import { authStore } from '@/state/auth';
import { qk } from '@/state/queryClient';
import { space } from '@/theme';

export default function FavouritesScreen() {
  const { t } = useTranslation();
  const token = useStore(authStore, (s) => s.token);
  const favs = useQuery({ queryKey: qk.favourites, queryFn: () => api.favourites.list(), enabled: !!token });
  const data = useStations(null);
  const list = useMemo(
    () =>
      (favs.data ?? [])
        .map((f) => data.stations.find((s) => (f.siteId ? s.siteId === f.siteId : s.partner?.partnerId === f.partnerId && s.partner?.locationId === f.locationId)))
        .filter((s): s is MapStation => !!s),
    [favs.data, data.stations],
  );
  const open = (s: MapStation) =>
    s.siteId ? router.push(`/station/${s.siteId}`) : s.partner && router.push(`/partner/${s.partner.partnerId}/${encodeURIComponent(s.partner.locationId)}?countryCode=${s.partner.countryCode}&partyId=${s.partner.partyId}`);
  return (
    <Screen back title={t('account.favourites')} onRefresh={() => void favs.refetch()} refreshing={favs.isRefetching}>
      {favs.isLoading || data.loading ? (
        <SkeletonList rows={3} />
      ) : favs.error ? (
        <ErrorState error={favs.error} onRetry={() => void favs.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon="heart" title={t('favourites.emptyTitle')} body={t('favourites.emptyBody')} action={t('activity.findCharger')} onAction={() => router.replace('/')} />
      ) : (
        <View style={{ gap: space.md }}>
          {list.map((s) => (
            <StationRow key={s.key} s={s} onPress={() => open(s)} />
          ))}
        </View>
      )}
    </Screen>
  );
}
