import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { HistoryItem } from '@/api/types';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { Icon } from '@/components/Icon';
import { Screen, Section } from '@/components/Screen';
import { payUnpaidSession } from '@/features/checkoutFlow';
import { MyQueue } from '@/features/queue';
import { SkeletonList } from '@/components/Skeleton';
import { ErrorState, EmptyState } from '@/components/StateView';
import { Text } from '@/components/Text';
import { formatDateTime, formatKwh } from '@/lib/format';
import { formatMoney, totalsByCurrency } from '@/lib/money';
import { useStore } from '@/lib/store';
import { useActiveCharge } from '@/state/activeCharge';
import { authStore, useMe } from '@/state/auth';
import { qk } from '@/state/queryClient';
import { radius, space, useTheme } from '@/theme';

function stateTone(state: string): 'success' | 'info' | 'warning' | 'muted' {
  if (state === 'rated' || state === 'ended' || state === 'settled') return 'success';
  if (state === 'active' || state === 'starting') return 'info';
  if (state === 'refund_pending' || state === 'refunded' || state === 'no_session') return 'warning';
  return 'muted';
}

/** Activity: current session, unpaid, reservations, then history with totals per currency (spec §6.9). */
export default function ActivityScreen() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { c } = useTheme();
  const token = useStore(authStore, (s) => s.token);
  const me = useMe();
  const active = useActiveCharge();
  const [currency, setCurrency] = useState<string | null>(null);

  const history = useInfiniteQuery({
    queryKey: [...qk.history, currency ?? 'all'],
    queryFn: ({ pageParam }) => api.charge.history(pageParam as string | null, currency),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!token,
  });
  const unpaid = useQuery({ queryKey: qk.unpaid, queryFn: () => api.charge.unpaid(), enabled: !!token });
  const reservation = useQuery({ queryKey: ['reservation'], queryFn: () => api.reservations.current(), enabled: !!token });

  const items: HistoryItem[] = useMemo(() => {
    const all = history.data?.pages.flatMap((p) => p.charges) ?? [];
    // Older servers ignore ?currency: filter here too.
    return currency ? all.filter((h) => h.currency === currency) : all;
  }, [history.data, currency]);
  const totals = useMemo(() => {
    const server = history.data?.pages[0]?.totals;
    if (server?.length && !currency) return server.map((x) => ({ ...x, count: 0 }));
    return totalsByCurrency(items.filter((h) => h.state === 'rated' || h.state === 'ended'));
  }, [history.data, items, currency]);
  const currencies = useMemo(() => [...new Set((history.data?.pages.flatMap((p) => p.charges) ?? []).map((h) => h.currency).filter(Boolean))] as string[], [history.data]);

  const open = (h: HistoryItem) => {
    const kind = h.kind === 'roaming' ? 'roaming' : 'charge';
    if (h.state === 'active' || h.state === 'starting') router.push(`/session/${kind}/${h.chargeId}`);
    else if (kind === 'roaming' && h.cdrId) router.push(`/receipt/roaming/${h.cdrId}`);
    else if (h.chargeId) router.push(h.state === 'rated' || h.state === 'ended' ? `/receipt/charge/${h.chargeId}` : `/session/charge/${h.chargeId}`);
  };

  const res = reservation.data?.reservation;

  return (
    <Screen title={t('activity.title')} onRefresh={() => void Promise.all([history.refetch(), unpaid.refetch()])} refreshing={history.isRefetching} testID="activity-screen">
      {active ? (
        <Card tone="accent" onPress={() => router.push(`/session/${active.kind}/${active.id}`)} accessibilityLabel={t('pill.a11y', { site: active.siteName })} style={styles.current}>
          <View style={[styles.live, { backgroundColor: c.fill }]}>
            <Icon name="bolt" size={22} color={c.on} fill={c.on} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="overline" tone="accent">
              {t('activity.current')}
            </Text>
            <Text variant="title3">{active.siteName}</Text>
          </View>
          <Icon name="chevron" color={c.accent} />
        </Card>
      ) : null}

      {(unpaid.data ?? []).map((u) => (
        <Banner
          key={u.chargeId}
          tone="warning"
          icon="receipt"
          title={t('activity.unpaid', { amount: formatMoney(u.owedMinor, u.currency, lang) })}
          body={u.site}
          action={t('activity.payNow')}
          // A partner network shortfall has no receipt of ours to pay from: paid here; hosted sessions from their receipt.
          onPress={() => (u.kind === 'roaming' ? void payUnpaidSession({ chargeId: u.chargeId, siteName: u.site, pay: {} }).catch(() => router.push(`/receipt/roaming/${u.chargeId}`)) : router.push(`/receipt/charge/${u.chargeId}`))}
          testID={`unpaid-${u.chargeId}`}
        />
      ))}

      <MyQueue />
      {res ? <Banner tone="info" icon="clock" title={t('activity.reservation', { site: res.siteName ?? '' })} body={t('activity.reservationUntil', { time: formatDateTime(res.expiresAt, lang, { hour: '2-digit', minute: '2-digit' }) })} /> : null}

      {totals.length ? (
        <Section title={t('activity.totals')}>
          <Card padded={false}>
            {totals.map((x, i) => (
              <View key={x.currency} style={[styles.total, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line }]} accessible accessibilityLabel={`${formatMoney(x.totalMinor, x.currency, lang)}, ${formatKwh(x.kwh, lang)}`}>
                <View style={[styles.cur, { backgroundColor: c.raised }]}>
                  <Text variant="caption" tone="muted">
                    {x.currency}
                  </Text>
                </View>
                <Text variant="footnote" tone="muted" style={{ flex: 1 }}>
                  {formatKwh(x.kwh, lang)}
                </Text>
                <Text variant="title3" style={{ fontFamily: 'Sora_700Bold' }}>
                  {formatMoney(x.totalMinor, x.currency, lang)}
                </Text>
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      <Section
        title={t('activity.history')}
        action={
          currencies.length > 1 ? (
            <View style={{ flexDirection: 'row', gap: space.xs }}>
              <Chip label={t('activity.all')} selected={!currency} onPress={() => setCurrency(null)} />
              {currencies.map((cu) => (
                <Chip key={cu} label={cu} selected={currency === cu} onPress={() => setCurrency(cu)} />
              ))}
            </View>
          ) : undefined
        }
      >
        {history.isLoading ? (
          <SkeletonList rows={4} testID="history-skeleton" />
        ) : history.error ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} compact />
        ) : items.length === 0 ? (
          <EmptyState
            icon="receipt"
            title={t('activity.emptyTitle')}
            body={me.data?.account ? t('activity.emptyBody') : t('activity.emptyGuest')}
            action={me.data?.account ? t('activity.findCharger') : t('account.signIn')}
            onAction={() => (me.data?.account ? router.push('/') : router.push('/sign-in'))}
            testID="history-empty"
          />
        ) : (
          <View style={{ gap: space.sm }}>
            {items.map((h, i) => {
              const tone = stateTone(h.state);
              return (
                <Card key={`${h.chargeId ?? h.cdrId}-${i}`} onPress={() => open(h)} style={styles.item} accessibilityLabel={[h.siteName, formatMoney(h.totalMinor, h.currency, lang), t(`activity.state.${h.state}`, { defaultValue: h.state })].join(', ')}>
                  <View style={[styles.itemIcon, { backgroundColor: c.raised }]}>
                    <Icon name={h.kind === 'roaming' ? 'route' : 'bolt'} size={18} color={h.kind === 'roaming' ? c.info : c.accent} />
                  </View>
                  <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                    <Text variant="bodyStrong" numberOfLines={2}>
                      {h.siteName}
                    </Text>
                    <Text variant="footnote" tone="muted" numberOfLines={2}>
                      {formatDateTime(h.createdAt, lang)}
                      {h.energyKwh ? ` · ${formatKwh(h.energyKwh, lang).replace(/ /g, '\u00a0')}` : ''}
                      {h.operator ? ` · ${h.operator}` : ''}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 2, flexShrink: 0, maxWidth: '42%' }}>
                    <Text variant="bodyStrong" style={{ fontFamily: 'Sora_700Bold' }} numberOfLines={1}>
                      {formatMoney(h.totalMinor, h.currency, lang)}
                    </Text>
                    <Text variant="caption" tone={tone === 'muted' ? 'muted' : tone}>
                      {t(`activity.state.${h.state}`, { defaultValue: h.state })}
                    </Text>
                  </View>
                </Card>
              );
            })}
            {history.hasNextPage ? <Button label={t('activity.more')} variant="secondary" loading={history.isFetchingNextPage} onPress={() => void history.fetchNextPage()} /> : null}
          </View>
        )}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  current: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  live: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  total: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  cur: { paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  itemIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
});
