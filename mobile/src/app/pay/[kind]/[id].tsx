import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Icon } from '@/components/Icon';
import { QRCode } from '@/components/QRCode';
import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';
import { Text } from '@/components/Text';
import { startAfterPayment } from '@/features/checkoutFlow';
import { formatClock, formatKwh } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { openCheckout } from '@/native/browser';
import { needsRationale, saveQrToPhotos, type SaveQrResult } from '@/native/saveQr';
import { setActiveCharge } from '@/state/activeCharge';
import { setPendingCheckout, usePendingCheckout } from '@/state/checkout';
import { qk, queryClient } from '@/state/queryClient';
import { radius, space, useTheme } from '@/theme';

/** QRIS hand-off to wallet apps (spec §6.5) — [VERIFY] schemes per wallet; opening the app lets the driver scan from gallery / pay. */
const WALLET_APPS: { key: string; label: string; ios: string; android: string }[] = [
  { key: 'gopay', label: 'GoPay', ios: 'gojek://', android: 'gojek://' },
  { key: 'ovo', label: 'OVO', ios: 'ovo://', android: 'ovo://' },
  { key: 'dana', label: 'DANA', ios: 'dana://', android: 'dana://' },
  { key: 'shopeepay', label: 'ShopeePay', ios: 'shopeeid://', android: 'shopeeid://' },
];

/** Payment in progress: QR (QRIS / PayNow) with expiry, hosted page (card hold, FPX, GrabPay, e-wallet), or approve-in-app. */
export default function PayScreen() {
  const { kind, id } = useLocalSearchParams<{ kind: 'charge' | 'roaming' | 'reservation' | 'unpaid'; id: string }>();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { c } = useTheme();
  const pending = usePendingCheckout();
  const [now, setNow] = useState(() => Date.now());
  const [opening, setOpening] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveQrResult | 'rationale' | 'saving' | null>(null);
  const done = useRef(false);
  const autoOpened = useRef(false);

  const match =
    pending &&
    ((pending.kind === 'charge' && pending.result.chargeId === id) ||
      (pending.kind === 'roaming' && pending.result.chargeId === id) ||
      (pending.kind === 'reservation' && pending.result.checkout.id === id) ||
      (pending.kind === 'unpaid' && pending.chargeId === id && kind === 'unpaid'))
      ? pending
      : null;
  const raw = match ? match.result.payment : undefined;
  const payment = raw
    ? { channel: 'channel' in raw ? String(raw.channel) : 'CARD', label: 'label' in raw ? raw.label : t('pay.methods.CARD'), action: raw.action, checkoutUrl: raw.checkoutUrl, providerRef: raw.providerRef, amountMinor: raw.amountMinor, expiresAt: raw.expiresAt, hold: raw.hold }
    : undefined;
  const qr = match?.kind === 'charge' || match?.kind === 'reservation' || match?.kind === 'unpaid' ? match.result.qr : undefined;
  const currency =
    match?.kind === 'charge' || match?.kind === 'unpaid'
      ? match.result.currency ?? 'IDR'
      : match?.kind === 'roaming'
        ? match.result.payment?.currency ?? 'IDR'
        : match?.kind === 'reservation'
          ? match.result.checkout.currency ?? 'IDR'
          : 'IDR';
  const amountMinor = payment?.amountMinor ?? qr?.amountMinor ?? (match?.kind === 'reservation' ? match.result.checkout.totalMinor : 0);
  const expiresAt = payment?.expiresAt ? new Date(payment.expiresAt).getTime() : null;
  const remaining = expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;
  const expired = remaining === 0;

  const finish = async () => {
    if (done.current) return;
    done.current = true;
    if (kind === 'unpaid') {
      setPendingCheckout(null);
      void queryClient.invalidateQueries({ queryKey: qk.unpaid });
      void queryClient.invalidateQueries({ queryKey: ['receipt'] });
      router.replace(`/receipt/charge/${id}`);
    } else if (kind === 'reservation') {
      const connectorId = match?.kind === 'reservation' ? match.connectorId : null;
      setPendingCheckout(null);
      if (connectorId) {
        void queryClient.invalidateQueries({ queryKey: qk.connector(connectorId) });
        router.replace(`/connector/${connectorId}`);
      } else router.replace('/activity');
    } else if (kind === 'roaming') {
      setPendingCheckout(null);
      setActiveCharge({ kind: 'roaming', id: id!, siteName: match?.siteName ?? '', startedAt: Date.now() });
      router.replace(`/session/roaming/${id}`);
    } else {
      await startAfterPayment(id!, match?.siteName ?? '');
    }
  };

  const check = async () => {
    if (done.current || !id) return;
    try {
      if (kind === 'unpaid') {
        const s = await api.charge.unpaidStatus(id);
        if (s.paid) void finish();
      } else if (kind === 'reservation') {
        const s = await api.reservations.checkoutStatus(id);
        if (s.state === 'held') void finish();
        else if (s.state !== 'pending') {
          done.current = true;
          setProblem(s.problem ?? t('pay.failed'));
        }
      } else if (kind === 'roaming') {
        const s = await api.roaming.status(id);
        if (s.state === 'rejected') setProblem(s.problem ?? t('pay.failed'));
        else if (s.state !== 'paying') void finish();
      } else {
        const s = await api.charge.status(id);
        if (s.state !== 'awaiting_payment') void finish();
      }
    } catch {
      /* keep polling; the offline banner explains */
    }
  };

  // Poll every 2.5 s, and at once when the driver comes back from the bank / wallet app.
  useEffect(() => {
    const h = setInterval(() => void check(), 2500);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void check());
    const first = setTimeout(() => void check(), 0);
    return () => {
      clearTimeout(first);
      clearInterval(h);
      clearInterval(tick);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind]);

  const openPage = async () => {
    if (!payment?.checkoutUrl) return;
    setOpening(true);
    try {
      const r = await openCheckout(payment.checkoutUrl);
      if (r.type === 'returned' && /cancel|deny|fail|expire/i.test(r.url)) setProblem(t('pay.cancelledBody'));
      void check();
    } finally {
      setOpening(false);
    }
  };

  // Hosted pages open by themselves once (the driver chose the method a second ago).
  useEffect(() => {
    if (payment?.action === 'redirect' && payment.checkoutUrl && !autoOpened.current && Platform.OS !== 'web') {
      autoOpened.current = true;
      // Next tick: the screen paints (amount, explanation) before the secure browser sheet slides over it.
      const h = setTimeout(() => void openPage(), 0);
      return () => clearTimeout(h);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment?.action]);

  if (!match || !payment) {
    return (
      <Screen back title={t('pay.title')}>
        <EmptyState icon="receipt" title={t('pay.noPending')} body={t('pay.noPendingBody')} action={t('activity.title')} onAction={() => router.replace('/activity')} />
      </Screen>
    );
  }

  const demo = (match.kind === 'charge' || match.kind === 'reservation' || match.kind === 'unpaid') && !!match.result.demo;
  const allowance = match.kind === 'charge' ? match.result.allowanceKwh : null;
  const cancel = () => {
    if (match.kind === 'reservation') void api.reservations.cancelCheckout(id!).catch(() => {});
    setPendingCheckout(null);
    router.back();
  };
  const saveQr = async (confirmed = false) => {
    if (!qr?.qrPng) return;
    if (!confirmed && (await needsRationale())) {
      setSaveState('rationale');
      return;
    }
    setSaveState('saving');
    setSaveState(await saveQrToPhotos(qr.qrPng, payment.providerRef));
  };

  return (
    <Screen
      back={cancel}
      title={qr ? t('pay.qrTitle', { method: payment.channel === 'PAYNOW' ? 'PayNow' : 'QRIS' }) : payment.action === 'push' ? t('pay.approveTitle', { method: payment.label }) : t('pay.redirectTitle')}
      subtitle={match.siteName}
      testID="pay-screen"
      footer={
        <View style={{ gap: space.sm }}>
          {demo ? (
            <Button
              label={t('pay.simulate')}
              variant="secondary"
              icon="check"
              loading={simulating}
              testID="simulate-payment"
              onPress={async () => {
                setSimulating(true);
                try {
                  if (kind === 'reservation') await api.reservations.confirmDemoCheckout(id!);
                  else if (kind === 'unpaid') await api.charge.confirmUnpaidPayment(id!);
                  else await api.charge.confirmDemoPayment(id!);
                  await check();
                } finally {
                  setSimulating(false);
                }
              }}
            />
          ) : null}
          <Button label={t('pay.cancel')} variant="ghost" onPress={cancel} />
        </View>
      }
    >
      <View style={{ alignItems: 'center', gap: space.xs }}>
        <Text variant="caption" tone="muted">
          {payment.hold ? t('pay.holdAmount') : t('pay.amount')}
        </Text>
        <Text variant="hero" testID="pay-amount">
          {formatMoney(amountMinor, currency, lang)}
        </Text>
        {match.kind === 'reservation' ? (
          <Text tone="muted">{t('pay.reservationFee')}</Text>
        ) : null}
        {allowance ? (
          <Text tone="muted">{t('connector.estimate', { kwh: formatKwh(allowance, lang) })}</Text>
        ) : null}
      </View>

      {problem ? <Banner tone="danger" title={t('pay.cancelled')} body={problem} /> : null}

      {qr ? (
        <View style={{ alignItems: 'center', gap: space.md }}>
          {expired ? (
            <Card style={{ alignItems: 'center', gap: space.md, width: '100%' }}>
              <Icon name="clock" size={32} color={c.warning} />
              <Text variant="title3">{t('pay.expired')}</Text>
              <Button label={t('pay.newQr')} icon="refresh" onPress={cancel} />
            </Card>
          ) : (
            <>
              <QRCode value={qr.qrString} size={250} label={t('pay.qrA11y', { amount: formatMoney(amountMinor, currency, lang) })} />
              {remaining != null ? (
                <View style={[styles.timer, { backgroundColor: remaining < 60 ? c.warningSoft : c.raised }]} accessibilityLiveRegion="polite" accessibilityLabel={t('pay.expiresIn', { time: formatClock(remaining) })}>
                  <Icon name="timer" size={16} color={remaining < 60 ? c.warning : c.textMuted} />
                  <Text variant="footnote" color={remaining < 60 ? c.warning : c.textMuted}>
                    {t('pay.expiresIn', { time: formatClock(remaining) })}
                  </Text>
                </View>
              ) : null}
              <Text variant="callout" tone="muted" align="center">
                {kind === 'charge' ? (payment.channel === 'PAYNOW' ? t('pay.paynowHint') : t('pay.qrisHint')) : payment.channel === 'PAYNOW' ? t('pay.paynowHintOther') : t('pay.qrisHintOther')}
              </Text>
              {qr.qrPng ? (
                saveState === 'rationale' ? (
                  <Card style={{ gap: space.sm, width: '100%' }} testID="save-qr-rationale">
                    <Text variant="bodyStrong">{t('pay.saveQrWhyTitle')}</Text>
                    <Text variant="footnote" tone="muted">
                      {t('pay.saveQrWhy')}
                    </Text>
                    <Button label={t('pay.saveQrAllow')} icon="download" size="sm" onPress={() => void saveQr(true)} testID="save-qr-allow" />
                  </Card>
                ) : (
                  <Button
                    label={saveState === 'saved' ? t('pay.qrSaved') : t('pay.saveQr')}
                    icon={saveState === 'saved' ? 'check' : 'download'}
                    variant="secondary"
                    size="sm"
                    full={false}
                    loading={saveState === 'saving'}
                    disabled={saveState === 'saved'}
                    onPress={() => void saveQr()}
                    testID="save-qr"
                  />
                )
              ) : null}
              {saveState === 'denied' ? <Banner tone="warning" title={t('pay.saveQrDenied')} /> : saveState === 'error' ? <Banner tone="danger" title={t('pay.saveQrFailed')} /> : null}
              {payment.channel !== 'PAYNOW' && Platform.OS !== 'web' ? (
                <View style={styles.wallets}>
                  {WALLET_APPS.map((w) => (
                    <Button key={w.key} label={w.label} variant="secondary" size="sm" full={false} onPress={() => void Linking.openURL(Platform.OS === 'ios' ? w.ios : w.android).catch(() => {})} />
                  ))}
                </View>
              ) : null}
            </>
          )}
        </View>
      ) : payment.action === 'push' ? (
        <Card style={{ alignItems: 'center', gap: space.md }}>
          <Icon name="phone" size={32} color={c.accent} />
          <Text variant="title3" align="center">
            {t('pay.approveBody', { method: payment.label })}
          </Text>
        </Card>
      ) : (
        <Card style={{ gap: space.md }}>
          <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
            <Icon name={payment.hold ? 'lock' : 'external'} size={24} color={c.accent} />
            <Text style={{ flex: 1 }}>{payment.hold ? t('pay.holdExplain', { amount: formatMoney(amountMinor, currency, lang) }) : t('pay.redirectBody')}</Text>
          </View>
          <Button label={t('pay.openPage')} icon="external" loading={opening} onPress={() => void openPage()} testID="open-checkout" />
        </Card>
      )}

      <View style={[styles.waiting, { backgroundColor: c.surface, borderColor: c.line }]} accessibilityLiveRegion="polite">
        <ActivityIndicator color={c.accent} />
        <Text variant="footnote" tone="muted" style={{ flex: 1 }}>
          {t('pay.waiting')}
        </Text>
      </View>
      <Text variant="caption" tone="faint" align="center">
        {t('pay.reference', { ref: payment.providerRef })}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  timer: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, paddingHorizontal: space.md, paddingVertical: space.xs + 2, borderRadius: radius.pill },
  wallets: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2 },
});
