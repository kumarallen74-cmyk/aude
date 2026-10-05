import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, PanResponder, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { Banner } from '@/components/Banner';
import { Button, haptic, IconButton } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Icon } from '@/components/Icon';
import { Logo } from '@/components/Logo';
import { SkeletonList } from '@/components/Skeleton';
import { ErrorState, EmptyState } from '@/components/StateView';
import { availabilityText, StationRow } from '@/components/StationRow';
import { Text } from '@/components/Text';
import { brand } from '@/config';
import { MapLegend } from '@/features/map/Marker';
import { StationMap } from '@/features/map/StationMap';
import type { StationMapHandle } from '@/features/map/types';
import { useMapViewport } from '@/features/mapViewport';
import { activeFilterCount } from '@/lib/filters';
import { formatTime } from '@/lib/format';
import { haversineKm, regionToBBox, type Region } from '@/lib/geo';
import { fromHosted, type MapStation } from '@/lib/stationModel';
import { mapFocusStore } from '@/lib/placeSearch';
import { kv, KEYS } from '@/lib/storage';
import { currentPosition, locationPermission, requestLocation, type LocationPermission } from '@/native/location';
import { authStore } from '@/state/auth';
import { useStore } from '@/lib/store';
import { qk } from '@/state/queryClient';
import { settingsStore, useSettings } from '@/state/settings';
import { radius, space, useTheme } from '@/theme';

const PEEK = 0.4;
const FULL = 0.86;

export default function MapScreen() {
  const { c, scheme, shadow } = useTheme();
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const mapRef = useRef<StationMapHandle>(null);
  const filters = useSettings((s) => s.filters);
  const mode = useSettings((s) => s.mapMode);
  const locationPrompted = useSettings((s) => s.locationPrompted);
  const token = useStore(authStore, (s) => s.token);

  const [region, setRegion] = useState<Region>(brand.defaultRegion);
  const [user, setUser] = useState<{ lat: number; lon: number } | null>(null);
  const [perm, setPerm] = useState<LocationPermission | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const locate = async (ask: boolean) => {
    let p = perm ?? (await locationPermission());
    if (p !== 'granted' && ask) {
      p = await requestLocation();
      settingsStore.set({ locationPrompted: true });
    }
    setPerm(p);
    if (p !== 'granted') return;
    const pos = await currentPosition();
    if (!pos) return;
    setUser(pos);
    const r = { latitude: pos.lat, longitude: pos.lon, latitudeDelta: 0.08, longitudeDelta: 0.08 };
    setRegion(r);
    mapRef.current?.animateTo(r);
  };

  // A place chosen in search (station search or the optional geocoder): move the map there.
  const focus = useStore(mapFocusStore, (s) => s.focus);
  useEffect(() => {
    if (!focus) return;
    const r = { latitude: focus.lat, longitude: focus.lon, latitudeDelta: 0.04, longitudeDelta: 0.04 };
    const h = setTimeout(() => {
      setRegion(r);
      mapRef.current?.animateTo(r);
      mapFocusStore.set({ focus: null });
    }, 0);
    return () => clearTimeout(h);
  }, [focus]);

  // Restore the last viewport (offline / cold start), then centre on the driver when allowed.
  useEffect(() => {
    void kv.get<Region>(KEYS.lastRegion).then((r) => r && setRegion(r));
    void locationPermission().then(async (p) => {
      setPerm(p);
      if (p === 'granted') await locate(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = useMapViewport(region, width, user, filters);
  const meta = useQuery({ queryKey: qk.meta, queryFn: () => api.stations.meta(), staleTime: 3600_000 });
  const favs = useQuery({ queryKey: qk.favourites, queryFn: () => api.favourites.list(), enabled: !!token });

  const items = data.items;

  const center = user ?? { lat: region.latitude, lon: region.longitude };
  const inView = useMemo(() => {
    const [w, s, e, n] = regionToBBox(region);
    return data.stations
      .filter((x) => x.lon >= w && x.lon <= e && x.lat >= s && x.lat <= n)
      .map((x) => ({ ...x, distanceKm: x.distanceKm ?? Math.round(haversineKm(center.lat, center.lon, x.lat, x.lon) * 10) / 10 }))
      .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0) || b.availableCount - a.availableCount);
  }, [data.stations, region, center.lat, center.lon]);
  // Nothing here: the nearest station anywhere (paged stations, nearest first), to offer a jump.
  const nearest = useQuery({
    queryKey: ['nearest', center.lat.toFixed(1), center.lon.toFixed(1)],
    queryFn: () => api.stations.page({ near: center, limit: 1 }),
    enabled: !data.loading && !inView.length,
    staleTime: 5 * 60_000,
  });
  const nearestOutside = !inView.length && nearest.data?.stations[0] ? fromHosted(nearest.data.stations[0]) : null;

  const favStations = useMemo(() => {
    const list = favs.data ?? [];
    return list
      .map((f) => data.stations.find((s) => (f.siteId ? s.siteId === f.siteId : s.partner?.partnerId === f.partnerId && s.partner?.locationId === f.locationId)))
      .filter((s): s is MapStation => !!s);
  }, [favs.data, data.stations]);

  const selectedStation = selected ? data.stations.find((s) => s.key === selected) ?? null : null;

  const onRegionChange = (r: Region) => {
    setRegion(r);
    void kv.set(KEYS.lastRegion, r);
  };

  // Bottom sheet: peek ↔ full (list mode).
  const [sheetH] = useState(() => new Animated.Value(height * (mode === 'list' ? FULL : PEEK)));
  useEffect(() => {
    Animated.spring(sheetH, { toValue: height * (mode === 'list' ? FULL : PEEK), useNativeDriver: false, bounciness: 2 }).start();
  }, [mode, height, sheetH]);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 8,
        onPanResponderRelease: (_, g) => {
          if (g.dy < -40) settingsStore.set({ mapMode: 'list' });
          else if (g.dy > 40) settingsStore.set({ mapMode: 'map' });
        },
      }),
    [],
  );

  const openStation = (s: MapStation) => {
    if (s.kind === 'hosted' && s.siteId) router.push(`/station/${s.siteId}`);
    else if (s.partner) router.push(`/partner/${s.partner.partnerId}/${encodeURIComponent(s.partner.locationId)}?countryCode=${s.partner.countryCode}&partyId=${s.partner.partyId}`);
  };

  const toggle = (patch: Partial<typeof filters>) => settingsStore.set({ filters: { ...filters, ...patch } });
  const fastOn = filters.current === 'DC' && filters.minKw >= 50;
  const nFilters = activeFilterCount(filters);

  const listHeader = (
    <View style={{ gap: space.md, paddingBottom: space.md }}>
      {perm !== 'granted' && !locationPrompted && perm !== null ? (
        <Banner tone="accent" icon="locate" title={t('map.locationPrompt.title')} body={t('map.locationPrompt.body', { app: brand.appName })} action={t('map.locationPrompt.allow')} onPress={() => void locate(true)} testID="location-preprompt" />
      ) : perm === 'denied' ? (
        <Banner tone="neutral" icon="locate" title={t('map.locationDenied.title')} body={t('map.locationDenied.body')} />
      ) : null}
      {data.fromCache ? <Banner tone="warning" icon="clock" title={t('map.cached', { time: data.updatedAt ? formatTime(new Date(data.updatedAt), i18n.language) : '—' })} body={t('map.cachedBody')} /> : null}
      {favStations.length ? (
        <View style={{ gap: space.sm }}>
          <Text variant="overline" tone="muted">
            {t('map.favourites')}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            {favStations.map((s) => (
              <Pressable key={s.key} onPress={() => openStation(s)} accessibilityRole="button" accessibilityLabel={s.name} style={[styles.fav, { backgroundColor: c.raised, borderColor: c.line }]}>
                <Icon name="heart" size={14} color={c.accent} fill={c.accent} />
                <Text variant="footnote" numberOfLines={1} style={{ maxWidth: 140, fontFamily: 'PlusJakartaSans_700Bold' }}>
                  {s.name}
                </Text>
                <Text variant="caption" color={s.availableCount ? c.status.available : c.textMuted}>
                  {s.availableCount}/{s.totalCount}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }} testID="map-screen">
      <StationMap
        ref={mapRef}
        mapLabel={t('map.a11yMap')}
        clusterLabel={(count, available) => t('map.a11yCluster', { count, available })}
        stationLabel={(s) => `${s.name}, ${availabilityText(t, s)}`}
        userLabel={t('map.a11yYou')}
        region={region}
        onRegionChange={onRegionChange}
        items={items}
        selectedKey={selected}
        onSelect={(k) => {
          haptic('selection');
          setSelected(k);
          settingsStore.set({ mapMode: 'map' });
        }}
        onClusterPress={(id, lat, lon) => {
          const hit = items.find((it) => it.type === 'cluster' && it.id === id);
          const z = (hit?.type === 'cluster' ? hit.expansionZoom : undefined) ?? Math.min(18, Math.round(Math.log2((360 * (width / 256)) / region.longitudeDelta)) + 2);
          const d = (360 * (width / 256)) / 2 ** z;
          const r = { latitude: lat, longitude: lon, latitudeDelta: d, longitudeDelta: d };
          setRegion(r);
          mapRef.current?.animateTo(r);
        }}
        user={user}
        tileUrl={meta.data?.map.tileUrl}
        scheme={scheme}
        bottomInset={height * PEEK}
        stale={data.fromCache}
      />

      {/* Top: search + filters */}
      <View style={[styles.top, { paddingTop: insets.top + space.sm }]} pointerEvents="box-none">
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
          <Pressable
            testID="search-bar"
            accessibilityRole="search"
            accessibilityLabel={t('map.searchPlaceholder')}
            onPress={() => router.push('/search')}
            style={[styles.search, shadow(2), { backgroundColor: c.surface, borderColor: c.line }]}
          >
            {width >= 380 ? <Logo size={30} /> : null}
            <Text tone="muted" style={{ flex: 1 }} numberOfLines={1}>
              {t('map.searchPlaceholder')}
            </Text>
            <Icon name="search" size={20} color={c.textMuted} />
          </Pressable>
          <IconButton name="sliders" label={t('map.filters')} onPress={() => router.push('/filters')} tone="glass" badge={nFilters} size={52} testID="filters-button" />
        </View>
        <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingVertical: space.sm, paddingRight: space.xl }}>
          <Chip label={t('filters.availableNow')} icon="check" selected={filters.availableNow} onPress={() => toggle({ availableNow: !filters.availableNow })} testID="chip-available" />
          <Chip label={t('filters.fast')} icon="bolt" selected={fastOn} onPress={() => toggle(fastOn ? { current: 'any', minKw: 0 } : { current: 'DC', minKw: 50 })} />
          <Chip label={t('filters.startable')} icon="phone" selected={filters.startableInApp} onPress={() => toggle({ startableInApp: !filters.startableInApp })} />
          {brand.scope === 'network' ? <Chip label={t('filters.partners')} icon="route" selected={filters.partners} onPress={() => toggle({ partners: !filters.partners })} /> : null}
          <Chip label={t('filters.more')} icon="sliders" count={nFilters || undefined} onPress={() => router.push('/filters')} />
        </ScrollView>
          {/* Edge fade: more chips to the right */}
          <View style={styles.fade} pointerEvents="none">
            {[0.15, 0.35, 0.6, 0.85].map((o) => (
              <View key={o} style={{ flex: 1, backgroundColor: c.mapLand, opacity: o }} />
            ))}
          </View>
        </View>
      </View>

      {/* What the pin colours mean */}
      <Animated.View style={[styles.legend, { bottom: Animated.add(sheetH, space.md) }]} pointerEvents="none">
        <MapLegend labels={{ available: t('map.legend.available'), busy: t('map.legend.busy'), offline: t('map.legend.offline'), partner: brand.scope === 'network' ? t('map.legend.partner') : undefined }} />
      </Animated.View>

      {/* Locate */}
      <Animated.View style={[styles.fabs, { bottom: Animated.add(sheetH, space.md) }]} pointerEvents="box-none">
        <IconButton name="locate" label={t('map.locate')} onPress={() => void locate(true)} tone="glass" size={48} testID="locate" />
      </Animated.View>

      {/* Sheet */}
      <Animated.View style={[styles.sheet, shadow(3), { height: sheetH, backgroundColor: c.bg, borderColor: c.line }]}>
        <View {...pan.panHandlers} style={styles.handleArea}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mode === 'list' ? t('map.showMap') : t('map.showList')}
            onPress={() => settingsStore.set({ mapMode: mode === 'list' ? 'map' : 'list' })}
            style={{ alignItems: 'center', paddingVertical: space.sm }}
          >
            <View style={[styles.handle, { backgroundColor: c.lineStrong }]} />
          </Pressable>
          <View style={styles.sheetHeader}>
            <View style={{ flex: 1 }}>
              <Text variant="title2" accessibilityRole="header">
                {t('map.nearby')}
              </Text>
              <Text variant="footnote" tone="muted">
                {data.loading ? t('common.loading') : t('map.count', { count: inView.length })}
              </Text>
            </View>
            <Pressable
              testID="toggle-list"
              accessibilityRole="button"
              onPress={() => settingsStore.set({ mapMode: mode === 'list' ? 'map' : 'list' })}
              style={[styles.modeBtn, { backgroundColor: c.raised }]}
            >
              <Icon name={mode === 'list' ? 'map' : 'list'} size={18} color={c.accent} />
              <Text variant="footnote" color={c.accent} style={{ fontFamily: 'PlusJakartaSans_700Bold' }}>
                {mode === 'list' ? t('map.showMap') : t('map.showList')}
              </Text>
            </Pressable>
          </View>
        </View>

        {selectedStation ? (
          <View style={{ paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.sm }}>
            <StationRow s={selectedStation} onPress={() => openStation(selectedStation)} stale={data.fromCache} testID="selected-station" />
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button label={t('map.details')} size="md" icon="bolt" onPress={() => openStation(selectedStation)} style={{ flex: 1 }} />
              <Button label={t('common.close')} variant="secondary" size="md" onPress={() => setSelected(null)} full={false} />
            </View>
          </View>
        ) : null}

        {data.loading ? (
          <View style={{ paddingHorizontal: space.lg }}>
            <SkeletonList rows={3} testID="map-skeleton" />
          </View>
        ) : data.error ? (
          <ErrorState error={data.error} onRetry={() => void data.refetch()} compact />
        ) : (
          <FlatList
            data={selectedStation ? inView.filter((s) => s.key !== selected) : inView}
            keyExtractor={(s) => s.key}
            ListHeaderComponent={listHeader}
            contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + 120, gap: space.md }}
            renderItem={({ item }) => <StationRow s={item} onPress={() => openStation(item)} stale={data.fromCache} />}
            ListEmptyComponent={
              <EmptyState
                icon="map"
                title={t('map.emptyTitle')}
                body={nearestOutside ? t('map.emptyNearest', { name: nearestOutside.name }) : t('map.emptyBody')}
                action={nearestOutside ? t('map.showNearest') : nFilters ? t('filters.reset') : undefined}
                onAction={() => {
                  if (nearestOutside) {
                    const r = { latitude: nearestOutside.lat, longitude: nearestOutside.lon, latitudeDelta: 0.06, longitudeDelta: 0.06 };
                    setRegion(r);
                    mapRef.current?.animateTo(r);
                  } else settingsStore.set({ filters: { ...filters, connectors: [], current: 'any', minKw: 0, availableNow: false, startableInApp: false, networks: [], maxPrice: {}, openNow: false, partners: true } });
                }}
                testID="map-empty"
              />
            }
          />
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { position: 'absolute', left: 0, right: 0, top: 0, paddingHorizontal: space.lg, gap: 0 },
  search: { flex: 1, minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingLeft: space.sm + 2, paddingRight: space.lg, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth * 2 },
  fabs: { position: 'absolute', right: space.lg, gap: space.sm },
  legend: { position: 'absolute', left: space.lg, right: 76 },
  fade: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 28, flexDirection: 'row' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  handleArea: { paddingHorizontal: space.lg },
  handle: { width: 40, height: 5, borderRadius: 3 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', paddingBottom: space.md, gap: space.md },
  modeBtn: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, paddingHorizontal: space.md, minHeight: 40, borderRadius: radius.pill },
  fav: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, paddingHorizontal: space.md, minHeight: 40, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth * 2 },
});
