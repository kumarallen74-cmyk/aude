import { useQuery } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { Screen } from '@/components/Screen';
import { SkeletonList } from '@/components/Skeleton';
import { ErrorState, EmptyState } from '@/components/StateView';
import { Text } from '@/components/Text';
import { cleanCode, hrefForResolution } from '@/lib/deeplink';

/** Deep-link / QR resolver: `/c/<code>` → the connector, a partner EVSE, a station… (§15.5 links/resolve; J1 step 2). */
export default function ResolveCode() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { t } = useTranslation();
  const clean = cleanCode(decodeURIComponent(code ?? ''));
  const q = useQuery({ queryKey: ['resolve', clean], queryFn: () => api.links.resolve(clean!), enabled: !!clean, retry: 1 });

  if (q.data) return <Redirect href={hrefForResolution(q.data) as never} />;
  return (
    <Screen back title={t('resolve.title')}>
      {!clean ? (
        <EmptyState icon="qr" title={t('resolve.invalid')} action={t('scan.enterCode')} onAction={() => router.replace('/scan')} />
      ) : q.isLoading ? (
        <>
          <Text tone="muted">{t('resolve.looking', { code: clean })}</Text>
          <SkeletonList rows={2} />
        </>
      ) : q.error instanceof ApiError && q.error.code === 'other_operator' ? (
        <EmptyState icon="lock" title={t('resolve.otherOperator')} body={q.error.message} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <EmptyState icon="qr" title={t('resolve.notFound')} body={t('resolve.notFoundBody', { code: clean })} action={t('scan.enterCode')} onAction={() => router.replace('/scan')} testID="resolve-not-found" />
      )}
    </Screen>
  );
}
