import { useMutation, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { AttemptKey } from '@/api/idempotency';
import type { ConnectorDetail } from '@/api/types';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { Icon } from '@/components/Icon';
import { Screen, Section } from '@/components/Screen';
import { Skeleton, SkeletonList } from '@/components/Skeleton';
import { SlideToStart } from '@/components/SlideToStart';
import { ErrorState, useErrorText } from '@/components/StateView';
import { StatusDot, statusLabel } from '@/components/Status';
import { Text } from '@/components/Text';
import { reserveConnector, startFleetCharge, startHostedCharge } from '@/features/checkoutFlow';
import { buildPicks } from '@/features/paymentPicks';
import { chargerLabel } from '@/lib/chargerLabel';
import { formatKwh, formatKw } from '@/lib/format';
import { formatMoney, formatRate, parseAmount, taxLabelKey } from '@/lib/money';
import { useOnline } from '@/state/network';
import { useMe } from '@/state/auth';
import { qk } from '@/state/queryClient';
import { settingsStore, useSettings } from '@/state/settings';
import { radius, space, touch, useTheme } from '@/theme';

export default function ConnectorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { c } = useTheme();
  const online = useOnline();
  const simple = useSettings((s) => s.simpleStart);
  const errText = useErrorText();
  const me = useMe();
  const fleet = !!me.data?.fleet;

  const q = useQuery({ queryKey: qk.connector(id!), queryFn: ({ signal }) => api.stations.connector(id!, signal), refetchInterval: 15_000 });
  const con: ConnectorDetail | undefined = q.data;

  const [chosenAmount, setAmount] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [promo, setPromo] = useState('');
  const [promoOpen, setPromoOpen] = useState(false);
  const [pickKey, setPickKey] = useState<string | null>(null);
  const [typedPhone, setPhone] = useState<string | null>(null);
  // One key per attempt: a retry after a lost answer can never create a second payment or hold ([§14 G12]).
  const [startKey] = useState(() => new AttemptKey());
  const [reserveKey] = useState(() => new AttemptKey());
  // Defaults derive from the data (the second preset, the account's phone) until the driver changes them.
  const amount = chosenAmount ?? con?.presetsMinor[1] ?? con?.presetsMinor[0] ?? null;
  const phone = typedPhone ?? me.data?.account?.phone ?? '';


  const quote = useQuery({
    queryKey: qk.quote(id!, amount ?? 0, promo),
    queryFn: () => api.charge.quote(id!, amount!, promo || undefined),
    enabled: !!con && !!amount && !fleet,
    staleTime: 20_000,
    placeholderData: (prev) => prev,
  });
  const qok = quote.data?.ok ? quote.data : null;
  const picks = useMemo(() => (qok ? buildPicks(qok, t) : []), [qok, t]);
  // No silent default: the driver chooses how to pay (the CTA stays disabled until then); the method used last time
  // in this currency counts as chosen. The choice is repeated next to the CTA so it is always visible.
  const lastMethod = useSettings((st) => (con ? st.lastMethod[con.currency] : undefined));
  const pick = picks.find((p) => p.key === pickKey) ?? picks.find((p) => p.key === lastMethod) ?? null;

  const meta = useQuery({ queryKey: qk.meta, queryFn: () => api.stations.meta(), staleTime: 3600_000 });
  // Free (or fleet-invoiced) reservations hold at once; a reservation fee is paid first with the chosen method.
  const signedIn = !!me.data?.account || fleet;
  const reserve = useMutation({
    mutationFn: async () => {
      if (!con) return false;
      if (!signedIn) {
        router.push('/sign-in');
        return false;
      }
      const fee = con.reservationFee && !con.reservationFee.fleetInvoice ? con.reservationFee : null;
      if (fee && !pick) throw new ApiError('business', t('pay.noMethods'), 422);
      const pay = fee && pick ? { ...pick.pay, phone: pick.needsPhone ? phone : undefined } : undefined;
      return reserveConnector({ connectorId: con.connectorId, siteName: con.station.name, pay, idempotencyKey: reserveKey.for({ c: con.connectorId, pay }) });
    },
    onSuccess: () => reserveKey.settle(),
    onError: (e) => reserveKey.settle(e),
    onSettled: () => void q.refetch(),
  });

  const go = useMutation({
    mutationFn: async () => {
      if (!con) return;
      if (fleet) return startFleetCharge(con.connectorId, con.station.name, startKey.for({ fleet: con.connectorId }));
      if (!amount || !pick) return;
      settingsStore.set((st) => ({ lastMethod: { ...st.lastMethod, [con.currency]: pick.key } }));
      const pay = { ...pick.pay, phone: pick.needsPhone ? phone : undefined };
      const promoCode = promo || undefined;
      return startHostedCharge({ connectorId: con.connectorId, siteName: con.station.name, amountMinor: amount, pay, promoCode, idempotencyKey: startKey.for({ c: con.connectorId, amount, pay, promoCode }) });
    },
    // The key is kept while the outcome is unknown (offline, timeout, 5xx, still processing) and rotated after an answer.
    onSuccess: () => startKey.settle(),
    onError: (e) => {
      startKey.settle(e);
      void quote.refetch();
    },
  });

  if (q.isLoading) {
    return (
      <Screen back>
        <Skeleton width="70%" height={28} />
        <Skeleton height={120} r={radius.lg} />
        <SkeletonList rows={2} />
      </Screen>
    );
  }
  if (q.error || !con) return <Screen back><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;

  const presets = con.presetsMinor;
  const canStart = con.available && online && (fleet || (!!qok && !!pick && (!pick.needsPhone || phone.length > 8)));
  const ctaLabel = fleet ? t('connector.startFleet') : amount ? (pick?.channel === 'LINKED' && pick.detail === t('pay.postpay') ? t('connector.startPostpay', { limit: formatMoney(amount, con.currency, lang) }) : pick ? t('connector.slideToPay', { amount: formatMoney(amount, con.currency, lang) }) : t('pay.chooseMethod')) : t('connector.chooseAmount');
  const fees = con.fees.filter((f) => f.rate > 0);

  return (
    <Screen
      back
      testID="connector-screen"
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
      footer={
        <View style={{ gap: space.sm }}>
          {go.error ? <Banner tone="danger" title={errText(go.error).title} body={errText(go.error).body} testID="start-error" /> : null}
          {!online ? <Banner tone="warning" icon="offline" title={t('offline.actionDisabled')} /> : null}
          {con.available && !fleet && qok ? (
            pick ? (
              <Text variant="footnote" tone="muted" align="center" testID="chosen-method">
                {t('pay.payingWith', { method: pick.label })}
              </Text>
            ) : (
              <Text variant="footnote" tone="warning" align="center" testID="choose-method-hint">
                {t('pay.chooseMethodHint')}
              </Text>
            )
          ) : null}
          {!con.available ? (
            <Button label={con.blockedReason ?? statusLabel(t, con.status)} disabled icon="boltOff" />
          ) : (
            <SlideToStart label={ctaLabel} onComplete={() => go.mutate()} disabled={!canStart} loading={go.isPending} simple={simple} testID="start-cta" />
          )}
          {con.available && !fleet && pick?.channel === 'CARD' && qok?.cardHolds ? (
            <Text variant="caption" tone="muted" align="center">
              {t('pay.holdNote', { amount: amount ? formatMoney(amount, con.currency, lang) : '' })}
            </Text>
          ) : null}
        </View>
      }
    >
      <View style={{ gap: space.sm }}>
        <Text variant="footnote" tone="muted">
          {con.station.name} · {con.station.operator}
        </Text>
        <Text variant="title1" accessibilityRole="header">
          {con.typeLabel} · {formatKw(con.maxPowerKw, lang)} {con.current}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
          <StatusDot status={con.status} label={statusLabel(t, con.status)} />
          <Text variant="footnote" tone="muted" numberOfLines={1} ellipsizeMode="middle" style={{ flexShrink: 1 }}>
            {[chargerLabel(con, t).title, chargerLabel(con, t).detail].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </View>

      {con.reservedForYou ? <Banner tone="success" icon="clock" title={t('connector.reservedForYou')} /> : null}
      {con.canReserve && !con.reservedForYou && meta.data?.reservations.enabled ? (
        <Button
          label={
            con.reservationFee && !con.reservationFee.fleetInvoice
              ? t('connector.reserveFee', { min: meta.data.reservations.minutes, fee: formatMoney(con.reservationFee.totalMinor, con.reservationFee.currency, lang) })
              : t('connector.reserve', { min: meta.data.reservations.minutes })
          }
          variant="secondary"
          size="md"
          icon="clock"
          loading={reserve.isPending}
          onPress={() => reserve.mutate()}
          testID="reserve"
        />
      ) : null}
      {reserve.error ? <Banner tone="danger" title={errText(reserve.error).title} body={errText(reserve.error).body} /> : null}
      {!con.available && con.blockedReason ? (
        <Banner
          tone="warning"
          title={con.blockedReason}
          body={t('connector.notAvailableBody')}
          action={t('connector.otherConnectors')}
          onPress={() => router.replace(`/station/${con.station.siteId}`)}
        />
      ) : null}

      {/* Price before start (spec §6.4): energy rate + tax label, fees, idle rule. */}
      <Card testID="price-card">
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Text variant="footnote" tone="muted">
            {t('connector.energyPrice')}
          </Text>
          <Text variant="caption" tone="faint">
            {t(taxLabelKey(con.currency, con.pricesIncludeTax))}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 2 }}>
          <Text variant="display">{formatRate(con.energyPriceMinor, con.currency, lang)}</Text>
          <Text tone="muted">/kWh</Text>
        </View>
        {fees.length ? (
          <View style={{ marginTop: space.md, gap: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line, paddingTop: space.md }}>
            {fees.map((f) => (
              <View key={f.kind} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
                <Text variant="footnote" tone="muted" style={{ flex: 1 }}>
                  {t(`fees.${f.kind}`, { defaultValue: f.label })}
                </Text>
                <Text variant="footnote" style={{ fontFamily: 'PlusJakartaSans_700Bold' }}>
                  {f.kind === 'session' || f.kind === 'admin' ? formatMoney(f.rate, con.currency, lang) : `${formatRate(f.rate, con.currency, lang)}/${t('fees.min')}`}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </Card>

      {fleet ? (
        <Banner tone="info" icon="card" title={t('connector.fleetBilled')} body={t('connector.fleetBody')} />
      ) : (
        <>
          <Section title={t('connector.amount')}>
            <View style={styles.amounts}>
              {presets.map((p) => (
                <Chip key={p} label={formatMoney(p, con.currency, lang)} selected={amount === p && !custom} onPress={() => { setCustom(''); setAmount(p); }} testID={`amount-${p}`} />
              ))}
            </View>
            <View style={[styles.input, { borderColor: custom ? c.fill : c.line, backgroundColor: c.surface }]}>
              <Text tone="muted">{con.currency === 'IDR' ? 'Rp' : con.currency === 'MYR' ? 'RM' : 'S$'}</Text>
              <TextInput
                value={custom}
                onChangeText={(v) => {
                  setCustom(v);
                  const a = parseAmount(v, con.currency, lang);
                  if (a) setAmount(Math.min(a, con.maxPrepaidMinor));
                }}
                placeholder={t('connector.otherAmount')}
                placeholderTextColor={c.textFaint}
                keyboardType="decimal-pad"
                style={[styles.textInput, { color: c.text }]}
                accessibilityLabel={t('connector.otherAmount')}
                maxFontSizeMultiplier={1.6}
              />
            </View>
            {quote.data && !quote.data.ok ? (
              <Banner
                tone="warning"
                title={quote.data.error}
                action={quote.data.minimumViableMinor ? formatMoney(quote.data.minimumViableMinor, con.currency, lang) : undefined}
                onPress={quote.data.minimumViableMinor ? () => setAmount(quote.data && !quote.data.ok ? quote.data.minimumViableMinor ?? null : null) : undefined}
              />
            ) : qok ? (
              <View style={[styles.estimate, { backgroundColor: c.accentSoft }]} accessibilityLiveRegion="polite">
                <Icon name="battery" size={18} color={c.accent} />
                <Text variant="callout" color={c.text} style={{ flex: 1 }}>
                  {t('connector.estimate', { kwh: formatKwh(qok.allowanceKwh, lang) })}
                </Text>
                {qok.membership || qok.promotion ? (
                  <Text variant="caption" color={c.accent}>
                    {qok.membership ?? qok.promotion}
                  </Text>
                ) : null}
              </View>
            ) : quote.isFetching ? (
              <Skeleton height={44} r={radius.md} />
            ) : null}
            {qok?.codeProblem ? <Text variant="footnote" tone="warning">{qok.codeProblem}</Text> : null}
            <Pressable onPress={() => setPromoOpen(!promoOpen)} accessibilityRole="button" style={{ minHeight: touch.min, justifyContent: 'center' }}>
              <Text variant="footnote" tone="accent" style={{ fontFamily: 'PlusJakartaSans_700Bold' }}>
                {promoOpen ? t('connector.hidePromo') : t('connector.havePromo')}
              </Text>
            </Pressable>
            {promoOpen ? (
              <View style={[styles.input, { borderColor: c.line, backgroundColor: c.surface }]}>
                <Icon name="ticket" size={18} color={c.textMuted} />
                <TextInput value={promo} onChangeText={(v) => setPromo(v.toUpperCase().slice(0, 30))} placeholder={t('connector.promoPlaceholder')} placeholderTextColor={c.textFaint} autoCapitalize="characters" style={[styles.textInput, { color: c.text }]} accessibilityLabel={t('connector.promoPlaceholder')} />
              </View>
            ) : null}
          </Section>

          <Section title={t('pay.method')}>
            {quote.isLoading ? (
              <SkeletonList rows={2} />
            ) : picks.length === 0 && qok ? (
              <Banner tone="warning" title={t('pay.noMethods')} />
            ) : (
              <View style={{ gap: space.sm }} accessibilityRole="radiogroup">
                {picks.map((p) => {
                  const on = p.key === pick?.key;
                  return (
                    <Pressable
                      key={p.key}
                      testID={`method-${p.key}`}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={[p.label, p.detail].filter(Boolean).join(', ')}
                      onPress={() => setPickKey(p.key)}
                      style={[styles.method, { borderColor: on ? c.fill : c.line, backgroundColor: on ? c.accentSoft : c.surface }]}
                    >
                      <View style={[styles.methodIcon, { backgroundColor: on ? c.fill : c.raised }]}>
                        <Icon name={p.icon} size={18} color={on ? c.on : c.textMuted} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text variant="bodyStrong">{p.label}</Text>
                        {p.detail ? <Text variant="footnote" tone="muted">{p.detail}</Text> : null}
                      </View>
                      <View style={[styles.radio, { borderColor: on ? c.fill : c.lineStrong }]}>{on ? <View style={[styles.radioDot, { backgroundColor: c.fill }]} /> : null}</View>
                    </Pressable>
                  );
                })}
                {pick?.needsPhone ? (
                  <View style={[styles.input, { borderColor: c.line, backgroundColor: c.surface }]}>
                    <Icon name="phone" size={18} color={c.textMuted} />
                    <TextInput value={phone} onChangeText={setPhone} placeholder={t('pay.ovoPhone')} placeholderTextColor={c.textFaint} keyboardType="phone-pad" textContentType="telephoneNumber" style={[styles.textInput, { color: c.text }]} accessibilityLabel={t('pay.ovoPhone')} />
                  </View>
                ) : null}
                {qok?.postpayBlocked ? <Banner tone="warning" title={t('pay.postpayBlocked')} action={t('activity.payNow')} onPress={() => router.push('/activity')} /> : null}
              </View>
            )}
          </Section>
        </>
      )}

      <Text variant="caption" tone="faint" align="center">
        {t('connector.plugInHint')}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  amounts: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  input: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: touch.comfortable },
  textInput: { flex: 1, fontSize: 17, fontFamily: 'PlusJakartaSans_600SemiBold', minHeight: touch.comfortable, paddingVertical: 0 },
  estimate: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderRadius: radius.md },
  method: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1.5, minHeight: 64 },
  methodIcon: { width: 38, height: 38, borderRadius: radius.sm + 2, alignItems: 'center', justifyContent: 'center' },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
