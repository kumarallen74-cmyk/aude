import { Redirect, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';
import { paymentReturnFailed } from '@/lib/deeplink';
import { usePendingCheckout } from '@/state/checkout';

/**
 * Back from the acquirer (card page, FPX, GrabPay, e-wallet). The return is never proof of payment — the server
 * confirms via the acquirer's notification — so this only resumes the payment screen, which polls (spec §6.5).
 */
export default function PaidReturn() {
  const p = useLocalSearchParams<{ for?: string; status?: string }>();
  const { t } = useTranslation();
  const pending = usePendingCheckout();
  const failed = paymentReturnFailed({ type: 'paid', for: p.for ?? null, status: p.status ?? null });
  if (pending && !failed) {
    const id = pending.kind === 'unpaid' ? pending.chargeId : pending.kind === 'reservation' ? pending.result.checkout.id : pending.result.chargeId;
    const kind = pending.kind === 'roaming' ? 'roaming' : pending.kind === 'reservation' ? 'reservation' : 'charge';
    return <Redirect href={`/pay/${kind}/${id}`} />;
  }
  return (
    <Screen back>
      <EmptyState icon={failed ? 'alert' : 'check'} title={failed ? t('pay.cancelled') : t('pay.returned')} body={failed ? t('pay.cancelledBody') : t('pay.returnedBody')} />
    </Screen>
  );
}
