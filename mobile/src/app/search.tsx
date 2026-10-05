import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/Card';
import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';
import { StationRow } from '@/components/StationRow';
import { Text } from '@/components/Text';
import { useStations } from '@/features/stations';
import { cleanCode } from '@/lib/deeplink';
import { mapFocusStore, placeProviders, searchPlaces, type PlaceResult } from '@/lib/placeSearch';
import type { MapStation } from '@/lib/stationModel';
import { radius, space, touch, useTheme } from '@/theme';

export default function SearchScreen() {
  const { t, i18n } = useTranslation();
  const { c } = useTheme();
  const [q, setQ] = useState('');
  const data = useStations(null);
  const stations = data.stations;
  const providers = useMemo(() => placeProviders(() => stations), [stations]);
  const term = q.trim();
  const found = useQuery({
    queryKey: ['placeSearch', term, providers.map((p) => p.id).join(), stations.length],
    queryFn: ({ signal }) => searchPlaces(providers, term, { near: null, lang: i18n.language, signal }),
    enabled: term.length > 0,
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
  const results = term ? (found.data ?? []) : [];
  const pickPlace = (p: PlaceResult) => {
    mapFocusStore.set({ focus: { lat: p.lat, lon: p.lon } });
    router.back();
  };
  const code = cleanCode(q);
  const looksLikeCode = !!code && /[\d:/.-]/.test(code) && code.length >= 3;
  const open = (s: MapStation) => {
    if (s.siteId) router.replace(`/station/${s.siteId}`);
    else if (s.partner) router.replace(`/partner/${s.partner.partnerId}/${encodeURIComponent(s.partner.locationId)}?countryCode=${s.partner.countryCode}&partyId=${s.partner.partyId}`);
  };
  return (
    <Screen back modal title={t('search.title')} scroll={false} testID="search-screen">
      <View style={{ paddingHorizontal: space.lg, gap: space.md, flex: 1 }}>
        <View style={[styles.box, { backgroundColor: c.surface, borderColor: c.fill }]}>
          <Icon name="search" color={c.textMuted} />
          <TextInput
            value={q}
            onChangeText={setQ}
            autoFocus
            placeholder={t('search.placeholder')}
            placeholderTextColor={c.textFaint}
            style={[styles.input, { color: c.text }]}
            returnKeyType="search"
            accessibilityLabel={t('search.placeholder')}
            testID="search-input"
          />
        </View>
        {looksLikeCode ? (
          <Card onPress={() => router.replace(`/c/${encodeURIComponent(code!)}`)} style={styles.codeRow} accessibilityLabel={t('search.openCode', { code })}>
            <Icon name="qr" color={c.accent} />
            <Text variant="bodyStrong" style={{ flex: 1 }}>
              {t('search.openCode', { code })}
            </Text>
            <Icon name="chevron" size={18} color={c.textFaint} />
          </Card>
        ) : null}
        <FlatList
          data={results}
          keyExtractor={(r) => r.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: space.md, paddingBottom: space.xxxl }}
          renderItem={({ item }) =>
            item.station ? (
              <StationRow s={item.station} onPress={() => open(item.station!)} />
            ) : (
              <Card onPress={() => pickPlace(item)} style={styles.codeRow} accessibilityLabel={item.title} testID={`place-${item.id}`}>
                <Icon name="pin" color={c.textMuted} />
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{item.title}</Text>
                  {item.subtitle ? <Text variant="footnote" tone="muted" numberOfLines={1}>{item.subtitle}</Text> : null}
                </View>
                <Icon name="map" size={18} color={c.textFaint} />
              </Card>
            )
          }
          ListEmptyComponent={q.trim() ? <EmptyState icon="search" title={t('search.none', { q })} body={t('search.noneBody')} /> : <Text tone="muted" align="center">{t('search.hint')}</Text>}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 2, borderRadius: radius.pill, paddingHorizontal: space.lg, minHeight: touch.comfortable },
  input: { flex: 1, fontSize: 17, fontFamily: 'PlusJakartaSans_500Medium', minHeight: touch.comfortable },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
