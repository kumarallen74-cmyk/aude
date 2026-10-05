import { useMutation, useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { DriverCard } from '@/api/types';
import { Banner } from '@/components/Banner';
import { IconButton } from '@/components/Button';
import { Card } from '@/components/Card';
import { Icon } from '@/components/Icon';
import { Screen, Section } from '@/components/Screen';
import { SkeletonList } from '@/components/Skeleton';
import { ErrorState, EmptyState } from '@/components/StateView';
import { Text } from '@/components/Text';
import { qk, queryClient } from '@/state/queryClient';
import { radius, space, useTheme } from '@/theme';

/**
 * Saved cards and linked e-wallets. A saved card is an acquirer token valid only at the operator whose acquirer
 * issued it (spec §2.2) — so each shows "Usable at …"; the start screen pre-selects a matching one ([§14 G15]).
 * Cards are added during a payment ("save this card"), never typed here (PCI SAQ-A).
 */
export default function PaymentMethods() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const q = useQuery({ queryKey: qk.cards, queryFn: () => api.payments.cards() });
  const remove = useMutation({ mutationFn: (id: string) => api.payments.removeCard(id), onSettled: () => queryClient.invalidateQueries({ queryKey: qk.cards }) });
  const cards = (q.data?.cards ?? []).filter((k) => k.kind === 'card');
  const wallets = (q.data?.cards ?? []).filter((k) => k.kind === 'ewallet');

  const row = (k: DriverCard) => (
    <Card key={k.id} style={styles.row}>
      <View style={[styles.icon, { backgroundColor: c.raised }]}>
        <Icon name={k.kind === 'card' ? 'card' : 'wallet'} color={c.accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong">{k.kind === 'card' ? `${(k.brand ?? 'Card').toUpperCase()} •• ${k.last4 ?? ''}` : `${k.channel ?? ''} ${k.accountLabel ?? ''}`}</Text>
        <Text variant="footnote" tone="muted">
          {t('cards.usableAt', { operator: k.usableAt })}
          {k.expMonth ? ` · ${String(k.expMonth).padStart(2, '0')}/${String(k.expYear ?? '').slice(-2)}` : ''}
        </Text>
        {k.expired || k.status === 'failed' ? <Text variant="caption" tone="danger">{t('cards.expired')}</Text> : null}
      </View>
      <IconButton name="trash" label={t('cards.remove')} tone="plain" color={c.danger} onPress={() => remove.mutate(k.id)} />
    </Card>
  );

  return (
    <Screen back title={t('account.paymentMethods')} onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      {q.isLoading ? (
        <SkeletonList rows={3} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.signedIn ? (
        <EmptyState icon="card" title={t('cards.signInTitle')} body={t('cards.signInBody')} action={t('account.signIn')} onAction={() => router.push('/sign-in')} />
      ) : (
        <>
          <Banner tone="info" icon="lock" title={t('cards.howTitle')} body={t('cards.howBody')} />
          <Section title={t('cards.cards')}>{cards.length ? cards.map(row) : <Text tone="muted">{t('cards.none')}</Text>}</Section>
          <Section title={t('cards.wallets')}>{wallets.length ? wallets.map(row) : <Text tone="muted">{t('cards.noWallets')}</Text>}</Section>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
});
