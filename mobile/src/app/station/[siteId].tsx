import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { ConnectorView, StationView } from '@/api/types';
import { Banner } from '@/components/Banner';
import { IconButton } from '@/components/Button';
import { Card } from '@/components/Card';
import { ChoiceSheet } from '@/components/ChoiceSheet';
import { Icon } from '@/components/Icon';
import { PriceTag } from '@/components/PriceTag';
import { Screen, Section } from '@/components/Screen';
import { chargerLabel } from '@/lib/chargerLabel';
import { QueuePanel } from '@/features/queue';
import { useSignedIn } from '@/state/auth';
import { Skeleton, SkeletonList } from '@/components/Skeleton';
import { ErrorState, EmptyState } from '@/components/StateView';
import { ReliabilityBadge, StatusDot, statusLabel } from '@/components/Status';
import { Text } from '@/components/Text';
import { linkHost } from '@/config';
import { useFavourite } from '@/features/favourites';
import { formatDistance, formatKw, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { stationShareUrl } from '@/lib/deeplink';
import { availableMapsApps, openDirections, type MapsApp } from '@/native/directions';
import { qk } from '@/state/queryClient';
import { radius, space, useTheme } from '@/theme';

/** Connectors grouped by type and power (spec §6.3). */
function groupConnectors(list: ConnectorView[]) {
  const groups = new Map<string, ConnectorView[]>();
  for (const cn of list) {
    const k = `${cn.typeLabel}|${cn.current}|${cn.maxPowerKw}`;
    groups.set(k, [...(groups.get(k) ?? []), cn]);
  }
  return [...groups.values()].sort((a, b) => b[0]!.maxPowerKw - a[0]!.maxPowerKw);
}

export default function StationScreen() {
  const { siteId } = useLocalSearchParams<{ siteId: string }>();
  const { t, i18n } = useTranslation();
  const { c } = useTheme();
  const lang = i18n.language;
  const [directions, setDirections] = useState(false);
  const signedIn = useSignedIn();
  const now = useNow();
  const q = useQuery({ queryKey: qk.stations(), queryFn: ({ signal }) => api.stations.list(null, signal), staleTime: 20_000, refetchInterval: 30_000 });
  const s: StationView | undefined = q.data?.find((x) => x.siteId === siteId);
  const fav = useFavourite(siteId ? { siteId } : null);
  const groups = useMemo(() => (s ? groupConnectors(s.connectors) : []), [s]);

  if (q.isLoading) {
    return (
      <Screen back>
        <View style={{ gap: space.md }}>
          <Skeleton width="80%" height={30} />
          <Skeleton width="50%" height={16} />
        </View>
        <SkeletonList rows={3} />
      </Screen>
    );
  }
  if (q.error && !s) {
    return (
      <Screen back>
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </Screen>
    );
  }
  if (!s) {
    return (
      <Screen back>
        <EmptyState icon="pin" title={t('station.notFoundTitle')} body={t('station.notFoundBody')} action={t('notFound.action')} onAction={() => router.replace('/')} />
      </Screen>
    );
  }

  const share = () => void Share.share({ message: `${s.name} — ${stationShareUrl(linkHost, s.siteId)}`, url: stationShareUrl(linkHost, s.siteId) });
  const firstAvailable = s.connectors.find((x) => x.available);

  return (
    <Screen
      back
      testID="station-screen"
      right={
        <>
          <IconButton name="share" label={t('station.share')} onPress={share} />
          <IconButton name="heart" label={fav.isFavourite ? t('station.unfavourite') : t('station.favourite')} onPress={fav.toggle} color={fav.isFavourite ? c.accent : undefined} testID="favourite" />
        </>
      }
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      <View style={{ gap: space.sm }}>
        <Text variant="title1" accessibilityRole="header">
          {s.name}
        </Text>
        <Text tone="muted">{[s.operator, s.distanceKm != null ? formatDistance(s.distanceKm, lang) : null].filter(Boolean).join(' · ')}</Text>
        {s.address ? <Text variant="footnote" tone="faint">{s.address}</Text> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs }}>
          <ReliabilityBadge r={s.reliability} />
          {s.reliability?.lastSuccessAt ? (
            <View style={[styles.pill, { backgroundColor: c.raised }]}>
              <Icon name="clock" size={13} color={c.textMuted} />
              <Text variant="caption" tone="muted">
                {t('station.lastSuccess', { ago: relativeTime(s.reliability.lastSuccessAt, now, lang) })}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Card onPress={() => setDirections(true)} style={styles.action} accessibilityLabel={t('station.directions')} testID="directions">
          <Icon name="navigate" color={c.accent} />
          <Text variant="footnote" style={{ fontFamily: 'PlusJakartaSans_700Bold' }}>
            {t('station.directions')}
          </Text>
        </Card>
        <Card style={[styles.action, { flex: 1.4, alignItems: 'flex-start' }]}>
          <Text variant="caption" tone="muted">
            {t('station.priceFrom')}
          </Text>
          <PriceTag rate={s.priceFromMajor} currency={s.currency} inclusive={s.pricesIncludeTax} align="left" />
        </Card>
      </View>

      {s.reliability?.label === 'issue' ? <Banner tone="warning" title={t('station.issueTitle')} body={t('station.issueBody')} /> : null}

      <Section title={t('station.connectors', { available: s.availableCount, total: s.totalCount })}>
        {s.connectors.length === 0 ? (
          <EmptyState icon="plug" title={t('station.noConnectors')} />
        ) : (
          groups.map((g) => (
            <Card key={`${g[0]!.typeLabel}${g[0]!.maxPowerKw}${g[0]!.current}`} padded={false} style={{ overflow: 'hidden' }}>
              <View style={[styles.groupHead, { borderBottomColor: c.line }]}>
                <View style={[styles.typeIcon, { backgroundColor: c.accentSoft }]}>
                  <Icon name={g[0]!.current === 'DC' ? 'bolt' : 'plug'} size={18} color={c.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="title3">
                    {g[0]!.typeLabel} · {formatKw(g[0]!.maxPowerKw, lang)}
                  </Text>
                  <Text variant="footnote" tone="muted">
                    {g[0]!.current === 'DC' ? t('station.dcFast') : t('station.ac')} · {t('station.availableOf', { available: g.filter((x) => x.available).length, total: g.length })}
                  </Text>
                </View>
              </View>
              {g.map((cn, i) => (
                <Card
                  key={cn.connectorId}
                  tone="surface"
                  onPress={() => router.push(`/connector/${cn.connectorId}`)}
                  accessibilityLabel={`${chargerLabel(cn, t).title}, ${statusLabel(t, cn.status)}`}
                  accessibilityHint={cn.available ? t('station.tapToCharge') : undefined}
                  testID={`connector-${cn.connectorId}`}
                  style={[styles.connector, { borderWidth: 0, borderRadius: 0, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: c.line }]}
                >
                  <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                    <Text variant="bodyStrong" numberOfLines={2}>
                      {chargerLabel(cn, t).title}
                    </Text>
                    <Text variant="caption" tone="faint" numberOfLines={1} ellipsizeMode="middle">
                      {chargerLabel(cn, t).detail}
                    </Text>
                    {cn.blockedReason && !cn.available ? (
                      <Text variant="footnote" tone="muted" numberOfLines={2}>
                        {cn.blockedReason}
                      </Text>
                    ) : null}
                  </View>
                  <StatusDot status={cn.status} label={statusLabel(t, cn.status)} />
                  <Icon name="chevron" size={18} color={c.textFaint} />
                </Card>
              ))}
            </Card>
          ))
        )}
      </Section>

      <QueuePanel siteId={s.siteId} signedIn={signedIn} />

      <Section title={t('station.photos')}>
        <View style={[styles.photo, { backgroundColor: c.raised, borderColor: c.line }]}>
          <Icon name="camera" size={22} color={c.textFaint} />
          <Text variant="footnote" tone="muted">
            {t('station.noPhotos')}
          </Text>
        </View>
      </Section>

      <Section title={t('station.help')}>
        <Card onPress={() => router.push(`/report?connectorId=${firstAvailable?.connectorId ?? s.connectors[0]?.connectorId ?? ''}&site=${encodeURIComponent(s.name)}`)} style={styles.row} accessibilityLabel={t('report.title')}>
          <Icon name="flag" color={c.warning} />
          <Text variant="bodyStrong" style={{ flex: 1 }}>
            {t('report.title')}
          </Text>
          <Icon name="chevron" size={18} color={c.textFaint} />
        </Card>
        {s.spkluId ? (
          <Text variant="caption" tone="faint">
            SPKLU {s.spkluId}
          </Text>
        ) : null}
      </Section>

      <ChoiceSheet
        visible={directions}
        title={t('station.directionsWith')}
        choices={availableMapsApps().map((a) => ({ key: a, label: t(`maps.${a}`), icon: 'navigate' as const }))}
        onPick={(k) => {
          setDirections(false);
          if (s.lat != null && s.lon != null) void openDirections(k as MapsApp, s.lat, s.lon, s.name);
        }}
        onClose={() => setDirections(false)}
        cancelLabel={t('common.cancel')}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.pill },
  action: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.xs, minHeight: 84 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: StyleSheet.hairlineWidth },
  typeIcon: { width: 36, height: 36, borderRadius: radius.sm + 2, alignItems: 'center', justifyContent: 'center' },
  connector: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.lg, minHeight: 60 },
  photo: { height: 96, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
