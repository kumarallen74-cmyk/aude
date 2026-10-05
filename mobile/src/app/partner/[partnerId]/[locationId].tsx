import { useMutation, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { RoamingEvse } from '@/api/types';
import { Banner } from '@/components/Banner';
import { Button, IconButton } from '@/components/Button';
import { Card } from '@/components/Card';
import { ChoiceSheet } from '@/components/ChoiceSheet';
import { Icon } from '@/components/Icon';
import { PriceTag } from '@/components/PriceTag';
import { Screen, Section } from '@/components/Screen';
import { SkeletonList } from '@/components/Skeleton';
import { ErrorState, EmptyState, useErrorText } from '@/components/StateView';
import { ReliabilityBadge, StatusDot, statusLabel } from '@/components/Status';
import { Text } from '@/components/Text';
import { useFavourite } from '@/features/favourites';
import { startRoamingCharge } from '@/features/checkoutFlow';
import { formatKw } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { formatMoney } from '@/lib/money';
import { availableMapsApps, openDirections, type MapsApp } from '@/native/directions';
import { useMe } from '@/state/auth';
import { qk } from '@/state/queryClient';
import { radius, space, useTheme } from '@/theme';

/** A partner CPO's location reached through the hub (spec §6.3 partner variant, §2.2 roaming path). */
export default function PartnerStationScreen() {
  const p = useLocalSearchParams<{ partnerId: string; locationId: string; countryCode: string; partyId: string; evseUid?: string }>();
  const locationId = decodeURIComponent(p.locationId ?? '');
  const { t, i18n } = useTranslation();
  const { c } = useTheme();
  const lang = i18n.language;
  const me = useMe();
  const signedIn = !!me.data?.account;
  const fleet = !!me.data?.fleet;
  const errText = useErrorText();
  const [picked, setEvse] = useState<RoamingEvse | null>(null);
  const [directions, setDirections] = useState(false);
  const now = useNow(60_000);

  const q = useQuery({ queryKey: qk.roaming(signedIn || fleet), queryFn: () => api.stations.roaming(null), staleTime: 20_000, refetchInterval: 30_000 });
  const s = q.data?.stations.find((x) => x.partnerId === p.partnerId && x.locationId === locationId && (!p.countryCode || x.countryCode === p.countryCode));
  // A scanned partner EVSE id (§15.5 partner_evse) preselects that EVSE.
  const evse = picked ?? (p.evseUid ? (s?.evses.find((e) => e.uid === p.evseUid) ?? null) : null);
  const fav = useFavourite(s ? { partnerId: s.partnerId, countryCode: s.countryCode, partyId: s.partyId, locationId: s.locationId } : null);

  const start = useMutation({
    mutationFn: (savedCardId: string | null) =>
      startRoamingCharge({ partnerId: s!.partnerId, countryCode: s!.countryCode, partyId: s!.partyId, locationId: s!.locationId, evseUid: evse!.uid, connectorId: evse!.connectors[0]?.id, savedCardId: savedCardId ?? undefined, saveCard: !savedCardId }, s!.name, s!.operator),
  });

  if (q.isLoading) return <Screen back><SkeletonList rows={3} /></Screen>;
  if (q.error) return <Screen back><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;
  if (!s) {
    return (
      <Screen back>
        {q.data && !q.data.enabled ? (
          <EmptyState icon="lock" title={t('partner.signInTitle')} body={q.data.reason ?? t('partner.signInBody')} action={t('account.signIn')} onAction={() => router.push('/sign-in')} />
        ) : (
          <EmptyState icon="pin" title={t('station.notFoundTitle')} body={t('station.notFoundBody')} />
        )}
      </Screen>
    );
  }

  const hold = s.holdMinor != null ? formatMoney(s.holdMinor, s.currency, lang) : null;
  const stale = s.lastUpdated ? now - new Date(s.lastUpdated).getTime() > 24 * 3600_000 : false;

  return (
    <Screen
      back
      testID="partner-screen"
      right={<IconButton name="heart" label={fav.isFavourite ? t('station.unfavourite') : t('station.favourite')} onPress={fav.toggle} color={fav.isFavourite ? c.accent : undefined} />}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
      footer={
        evse ? (
          <View style={{ gap: space.sm }}>
            {start.error ? <Banner tone="danger" title={errText(start.error).title} body={errText(start.error).body} /> : null}
            {!signedIn && !fleet ? (
              <Button label={t('partner.signInToCharge')} icon="phone" onPress={() => router.push('/sign-in')} />
            ) : fleet ? (
              <Button label={t('partner.startFleet')} icon="bolt" loading={start.isPending} onPress={() => start.mutate(null)} testID="start-partner" />
            ) : s.savedCards.length ? (
              <>
                <Button label={t('partner.startWithCard', { card: `${(s.savedCards[0]!.brand ?? '').toUpperCase()} •• ${s.savedCards[0]!.last4 ?? ''}` })} icon="bolt" loading={start.isPending} onPress={() => start.mutate(s.savedCards[0]!.id)} testID="start-partner" />
                <Button label={t('partner.useNewCard')} variant="ghost" size="md" onPress={() => start.mutate(null)} />
              </>
            ) : (
              <Button label={t('partner.startWithNewCard')} icon="card" loading={start.isPending} onPress={() => start.mutate(null)} testID="start-partner" />
            )}
          </View>
        ) : undefined
      }
    >
      <View style={{ gap: space.sm }}>
        <View style={[styles.hub, { backgroundColor: c.infoSoft }]}>
          <Icon name="route" size={14} color={c.info} />
          <Text variant="caption" color={c.info}>
            {t('station.viaHub', { operator: s.operator })}
          </Text>
        </View>
        <Text variant="title1" accessibilityRole="header">
          {s.name}
        </Text>
        {s.address ? <Text tone="muted">{s.address}</Text> : null}
        <ReliabilityBadge r={s.reliability} />
      </View>

      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Card onPress={() => setDirections(true)} style={styles.action} accessibilityLabel={t('station.directions')}>
          <Icon name="navigate" color={c.accent} />
          <Text variant="footnote" style={{ fontFamily: 'PlusJakartaSans_700Bold' }}>
            {t('station.directions')}
          </Text>
        </Card>
        <Card style={[styles.action, { flex: 1.4, alignItems: 'flex-start' }]}>
          <Text variant="caption" tone="muted">
            {t('partner.pricePerOperator', { operator: s.operator })}
          </Text>
          <PriceTag rate={s.priceFromMajor} currency={s.priceCurrency ?? s.currency} inclusive={false} partner align="left" />
          {s.vatPercent != null ? (
            <Text variant="caption" tone="faint">
              {t('partner.vat', { pct: s.vatPercent })}
            </Text>
          ) : null}
        </Card>
      </View>

      {stale ? <Banner tone="warning" icon="clock" title={t('partner.stale')} /> : null}
      {fleet ? (
        <Banner tone="info" icon="card" title={t('partner.fleetBilled')} />
      ) : hold ? (
        <Banner tone="info" icon="lock" title={t('partner.holdTitle', { amount: hold })} body={t('partner.holdBody', { operator: s.operator })} />
      ) : null}
      {!s.startable && s.reason ? <Banner tone="neutral" icon="info" title={s.reason} /> : null}

      <Section title={t('partner.chargers', { available: s.availableCount, total: s.totalCount })}>
        {s.evses.length === 0 ? (
          <EmptyState icon="plug" title={t('station.noConnectors')} />
        ) : (
          s.evses.map((e) => {
            const cn = e.connectors[0];
            const sel = evse?.uid === e.uid;
            return (
              <Card
                key={e.uid}
                onPress={e.available && s.startable ? () => setEvse(sel ? null : e) : undefined}
                accessibilityLabel={`${cn?.typeLabel ?? ''} ${cn?.maxPowerKw ?? ''} kW, ${statusLabel(t, e.status)}`}
                testID={`evse-${e.uid}`}
                style={[styles.evse, sel && { borderColor: c.fill, borderWidth: 2 }]}
              >
                <View style={[styles.typeIcon, { backgroundColor: c.accentSoft }]}>
                  <Icon name={cn?.current === 'DC' ? 'bolt' : 'plug'} size={18} color={c.accent} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="bodyStrong">
                    {cn?.typeLabel ?? '—'} · {formatKw(cn?.maxPowerKw ?? null, lang)}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {e.evseId}
                  </Text>
                </View>
                <StatusDot status={e.status} label={statusLabel(t, e.status)} />
                {sel ? <Icon name="check" size={20} color={c.accent} /> : null}
              </Card>
            );
          })
        )}
      </Section>
      {!evse && s.startable ? (
        <Text variant="footnote" tone="muted" align="center">
          {t('partner.pickCharger')}
        </Text>
      ) : null}

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
  hub: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.pill, alignSelf: 'flex-start' },
  action: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.xs, minHeight: 84 },
  evse: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  typeIcon: { width: 36, height: 36, borderRadius: radius.sm + 2, alignItems: 'center', justifyContent: 'center' },
});
