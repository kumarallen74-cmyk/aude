import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';
import { paymentReturnFailed } from '@/lib/deeplink';
import { pendingHref, usePendingCheckout } from '@/state/checkout';

/**
 * Back from the acquirer (card page, FPX, GrabPay, e-wallet). The return is never proof of payment — the server
 * confirms via the acquirer's notification — so this only resumes the payment screen, which polls (spec §6.5).
 * The payment screen is usually still open under this one: go back to it rather than stacking a second one (two
 * payment screens would both try to start the charge).
 */
export default function PaidReturn() {
  const p = useLocalSearchParams<{ for?: string; status?: string }>();
  const { t } = useTranslation();
  const pending = usePendingCheckout();
  const failed = paymentReturnFailed({ type: 'paid', for: p.for ?? null, status: p.status ?? null });
  const href = pending && !failed ? pendingHref(pending) : null;
  useEffect(() => {
    if (href) router.dismissTo(href as never);
  }, [href]);
  if (href) return null;
  return (
    <Screen back>
      <EmptyState icon={failed ? 'alert' : 'check'} title={failed ? t('pay.cancelled') : t('pay.returned')} body={failed ? t('pay.cancelledBody') : t('pay.returnedBody')} />
    </Screen>
  );
}
