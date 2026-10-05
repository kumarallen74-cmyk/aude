import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { Card } from '@/components/Card';
import { Screen, Section } from '@/components/Screen';
import { SkeletonList } from '@/components/Skeleton';
import { EmptyState } from '@/components/StateView';
import { Text } from '@/components/Text';
import { formatMoney } from '@/lib/money';
import { useMe } from '@/state/auth';
import { qk } from '@/state/queryClient';
import { space } from '@/theme';

interface PassView {
  id?: string;
  planName?: string;
  operator?: string;
  expiresAt?: string;
  priceMinor?: number;
  currency?: string;
}

/** Passes (30-day memberships per operator) and loyalty points — read in v1.0; buying a pass follows the charge pay flow. */
export default function PassesScreen() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const signedIn = !!me.data?.account;
  const passes = useQuery({ queryKey: qk.memberships, queryFn: () => api.memberships.overview(), enabled: signedIn });
  const loyalty = useQuery({ queryKey: ['loyalty'], queryFn: () => api.memberships.loyalty(), enabled: signedIn });
  const active = ((passes.data?.passes ?? passes.data?.active ?? []) as PassView[]).filter(Boolean);
  const balances = loyalty.data?.balances ?? [];
  return (
    <Screen back title={t('account.passes')}>
      {!signedIn ? (
        <EmptyState icon="ticket" title={t('passes.signIn')} />
      ) : passes.isLoading ? (
        <SkeletonList rows={2} />
      ) : (
        <>
          <Section title={t('passes.active')}>
            {active.length ? (
              active.map((p, i) => (
                <Card key={p.id ?? i} style={{ gap: 2 }}>
                  <Text variant="title3">{p.planName ?? '—'}</Text>
                  <Text variant="footnote" tone="muted">
                    {p.operator ?? ''}
                  </Text>
                </Card>
              ))
            ) : (
              <Text tone="muted">{t('passes.none')}</Text>
            )}
          </Section>
          <Section title={t('passes.points')}>
            {balances.length ? (
              <View style={{ gap: space.sm }}>
                {balances.map((b) => (
                  <Card key={b.orgId} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text variant="bodyStrong">{b.operator}</Text>
                    <Text variant="bodyStrong">
                      {t('passes.pointsValue', { points: b.points })}
                      {b.valueMinor != null && b.currency ? ` · ${formatMoney(b.valueMinor, b.currency, i18n.language)}` : ''}
                    </Text>
                  </Card>
                ))}
              </View>
            ) : (
              <Text tone="muted">{t('passes.noPoints')}</Text>
            )}
          </Section>
        </>
      )}
    </Screen>
  );
}
