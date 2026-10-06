import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner } from '@/components/Banner';
import { Button, haptic } from '@/components/Button';
import { Card } from '@/components/Card';
import { ChargeRing } from '@/components/ChargeRing';
import { ChoiceSheet } from '@/components/ChoiceSheet';
import { Icon, type IconName } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { Skeleton } from '@/components/Skeleton';
import { Sparkline } from '@/components/Sparkline';
import { Text } from '@/components/Text';
import { brand } from '@/config';
import { requestStart, startAcknowledged, startInFlight } from '@/features/checkoutFlow';
import { useLiveSession } from '@/features/liveSession';
import { formatClock, formatDuration, formatKw, formatKwh, formatNumber } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { canStop, startSteps, TERMINAL, type SessionKind } from '@/lib/sessionMachine';
import { registerForPush } from '@/native/notifications';
import { useStartRecord } from '@/state/activeCharge';
import { settingsStore, useSettings } from '@/state/settings';
import { radius, space, useTheme } from '@/theme';

export default function SessionScreen() {
  const { kind, id } = useLocalSearchParams<{ kind: SessionKind; id: string }>();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const { st, stop, refresh } = useLiveSession(kind === 'roaming' ? 'roaming' : 'charge', id!);
  const [confirmStop, setConfirmStop] = useState(false);
  const [problemSheet, setProblemSheet] = useState(false);
  // The last start answer for this charge (start token, or why it failed) — persisted, so it survives a restart.
  const startInfo = useStartRecord(kind === 'roaming' ? undefined : id);
  const [restarting, setRestarting] = useState(false);
  const autoStarted = useRef(false);
  const pushPrompted = useSettings((s) => s.pushPrompted);
  const [now, setNow] = useState(() => Date.now());
  const s = st.snapshot;

  // Elapsed time counts on the phone between polls.
  useEffect(() => {
    if (st.phase !== 'charging') return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [st.phase]);
  useEffect(() => {
    if (st.phase === 'charging') haptic('success');
  }, [st.phase]);

  // A paid hosted charge only starts when the app asks (the server never starts one by itself). If the app was killed
  // after paying, or the start after payment failed / timed out, nothing acknowledged it in this run: ask once here.
  // The server refuses a second start once the session is bound, which counts as started.
  const hostedStart = kind !== 'roaming' && st.phase === 'starting';
  const startAgain = async () => {
    if (!id) return;
    setRestarting(true);
    try {
      await requestStart(id);
      await refresh();
    } finally {
      setRestarting(false);
    }
  };
  useEffect(() => {
    if (!hostedStart || !id || autoStarted.current || startAcknowledged(id) || startInFlight(id)) return;
    autoStarted.current = true;
    void startAgain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostedStart, id]);
  const startFailed = hostedStart && startInfo != null && !startInfo.ok;

  const elapsedS = s?.startedAt ? Math.max(0, (now - new Date(s.startedAt).getTime()) / 1000) : 0;
  const ringValue = s?.socPercent != null ? s.socPercent / 100 : s?.progressPct != null ? s.progressPct / 100 : null;
  const cur = s?.currency ?? 'IDR';
  const terminal = TERMINAL.has(st.phase);
  const steps = useMemo(() => startSteps(st), [st]);

  const title = st.missing
    ? t('session.notFoundTitle')
    : st.phase === 'charging' ? t('session.charging') : st.phase === 'starting' ? t('session.starting') : st.phase === 'paying' ? t('session.paying') : st.phase === 'finishing' ? t('session.finishing') : st.phase === 'completed' ? t('session.completed') : st.phase === 'failed' ? t('session.failed') : st.phase === 'refunding' ? t('session.refunding') : st.phase === 'refunded' ? t('session.refunded') : st.phase === 'released' ? t('session.released') : t('session.checking');

  const operatorPhone = brand.support.phone;

  return (
    <Screen
      back={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      testID="session-screen"
      footer={
        st.phase === 'charging' ? (
          <View style={{ gap: space.sm }}>
            {st.stopError ? <Banner tone="danger" title={st.stopError} body={t('session.stopAtCharger')} /> : null}
            <Button
              label={st.stop === 'sent' ? t('session.stopping') : t('session.stop')}
              variant="danger"
              icon="stop"
              loading={st.stop === 'requested'}
              disabled={!canStop(st)}
              onPress={() => setConfirmStop(true)}
              testID="stop"
            />
            <Button label={t('session.problem')} variant="ghost" size="md" icon="flag" onPress={() => setProblemSheet(true)} />
          </View>
        ) : terminal || st.missing ? (
          <View style={{ gap: space.sm }}>
            {s?.receiptRef ? <Button label={t('session.viewReceipt')} icon="receipt" onPress={() => router.push(`/receipt/${kind}/${s.receiptRef}`)} testID="view-receipt" /> : null}
            {st.phase === 'completed' && brand.features.ratings ? <Button label={t('session.rate')} variant="secondary" icon="star" onPress={() => router.push(`/rate/${kind}/${id}`)} testID="rate" /> : null}
            <Button label={t('session.done')} variant="ghost" onPress={() => router.replace('/')} />
          </View>
        ) : st.phase === 'starting' && (st.startTimedOut || startFailed) ? (
          <View style={{ gap: space.sm }}>
            {hostedStart ? <Button label={t('session.startAgain')} icon="refresh" loading={restarting} onPress={() => void startAgain()} testID="start-again" /> : null}
            <Button label={t('session.cancelStart')} variant={hostedStart ? 'ghost' : 'secondary'} onPress={() => router.replace('/')} />
          </View>
        ) : undefined
      }
    >
      <View style={{ gap: 4 }}>
        <Text variant="footnote" tone="muted">
          {[s?.siteName, s?.operator].filter(Boolean).join(' · ') || ' '}
        </Text>
        <Text variant="title1" accessibilityRole="header" accessibilityLiveRegion="polite">
          {title}
        </Text>
        {s?.connectorLabel ? <Text variant="footnote" tone="faint">{s.connectorLabel}</Text> : null}
      </View>

      {st.connection === 'reconnecting' ? <Banner tone="warning" icon="offline" title={t('session.reconnecting')} body={st.phase === 'charging' ? t('session.reconnectingBody') : undefined} testID="reconnecting" /> : null}

      {st.missing ? (
        <Card style={{ gap: space.md }} testID="session-missing">
          <Text>{t('session.notFoundBody')}</Text>
        </Card>
      ) : !s ? (
        <View style={{ alignItems: 'center', gap: space.lg }}>
          <Skeleton width={220} height={220} r={110} />
          <Skeleton width="60%" height={20} />
        </View>
      ) : st.phase === 'paying' ? (
        <Card style={{ gap: space.md }}>
          <Text>{t('session.payingBody')}</Text>
          <Button label={t('session.backToPayment')} onPress={() => router.replace(`/pay/${kind}/${id}`)} />
        </Card>
      ) : st.phase === 'starting' ? (
        <View style={{ gap: space.lg }}>
          <Card style={{ gap: space.lg }} testID="start-timeline">
            {steps.map((step) => (
              <View key={step.key} style={styles.step}>
                <View style={[styles.stepDot, { backgroundColor: step.done ? c.fill : step.active ? c.accentSoft : c.raised, borderColor: step.active ? c.fill : 'transparent' }]}>
                  {step.done ? <Icon name="check" size={14} color={c.on} strokeWidth={3} /> : step.active ? <View style={[styles.pulse, { backgroundColor: c.fill }]} /> : null}
                </View>
                <Text variant={step.active ? 'bodyStrong' : 'body'} tone={step.done || step.active ? 'default' : 'faint'}>
                  {kind === 'roaming' && step.key === 'accepted' ? t('session.steps.acceptedBy', { operator: s.operator ?? '' }) : t(`session.steps.${step.key}`)}
                </Text>
              </View>
            ))}
          </Card>
          <Banner tone="accent" icon="plug" title={t('session.plugIn')} body={kind === 'roaming' ? t('session.roamingWait', { operator: s.operator ?? '' }) : t('session.plugInBody')} />
          {startInfo?.presentToken ? <Banner tone="info" icon="card" title={t('session.presentToken', { token: startInfo.presentToken })} /> : null}
          {startFailed ? (
            <Banner tone="danger" icon="alert" title={t('session.startFailedTitle')} body={startInfo?.error || t('session.startFailedBody')} testID="start-failed" />
          ) : st.startTimedOut ? (
            <Banner tone="warning" icon="clock" title={t('session.slowTitle')} body={t('session.slowBody')} testID="start-timeout" />
          ) : null}
        </View>
      ) : st.phase === 'charging' || st.phase === 'finishing' ? (
        <View style={{ gap: space.lg, alignItems: 'center' }}>
          <ChargeRing size={Math.min(260, width - 120)} value={ringValue} stroke={16}>
            <View style={{ alignItems: 'center' }} accessible accessibilityLabel={t('session.a11yEnergy', { kwh: formatKwh(s.energyKwh, lang) })}>
              <Text variant="hero" testID="energy" maxFontSizeMultiplier={1.4}>
                {formatNumber(s.energyKwh, 2, lang)}
              </Text>
              <Text variant="callout" tone="muted">
                kWh
              </Text>
              {s.socPercent != null ? (
                <View style={[styles.soc, { backgroundColor: c.accentSoft }]}>
                  <Icon name="battery" size={14} color={c.accent} />
                  <Text variant="caption" tone="accent">
                    {t('session.soc', { pct: s.socPercent })}
                  </Text>
                </View>
              ) : null}
            </View>
          </ChargeRing>
          <View style={[styles.costCard, { backgroundColor: c.surface, borderColor: c.line }]} accessible accessibilityLabel={`${s.costFinal ? t('session.cost') : t('session.costSoFar')}: ${formatMoney(s.costMinor, cur, lang)}`}>
            <View style={{ flex: 1 }}>
              <Text variant="caption" tone="muted">
                {s.costFinal ? t('session.cost') : t('session.costSoFar')}
              </Text>
              <Text variant="title1" testID="cost">{formatMoney(s.costMinor, cur, lang)}</Text>
            </View>
            {s.limitMinor ? (
              <Text variant="footnote" tone="faint" align="right">
                {t('session.ofLimit', { limit: formatMoney(s.limitMinor, cur, lang) })}
              </Text>
            ) : null}
          </View>
          {s.costParts && (s.costParts.taxMinor > 0 || s.costParts.idleMinor > 0) ? (
            <Text variant="footnote" tone="muted" align="center" style={{ width: '100%' }} testID="cost-parts">
              {[
                t('session.costCharges', { amount: formatMoney(s.costParts.subtotalMinor, cur, lang) }),
                s.costParts.taxMinor ? t('session.costTax', { amount: formatMoney(s.costParts.taxMinor, cur, lang) }) : null,
                s.costParts.idleMinor ? t('session.costIdle', { amount: formatMoney(s.costParts.idleMinor, cur, lang) }) : null,
                s.costParts.discountMinor ? t('session.costDiscount', { amount: formatMoney(s.costParts.discountMinor, cur, lang) }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              {'\n'}
              {t('session.costHint')}
            </Text>
          ) : null}
          <View style={styles.stats}>
            <Stat icon="bolt" label={t('session.power')} value={formatKw(s.powerKw, lang)} />
            <Stat icon="clock" label={t('session.elapsed')} value={s.startedAt ? formatClock(elapsedS) : formatDuration(s.durationMin, lang)} />
          </View>
          {st.powerHistory.length > 1 ? (
            <Card style={{ width: '100%', gap: space.sm }}>
              <Text variant="caption" tone="muted">
                {t('session.powerOverTime')}
              </Text>
              <Sparkline data={st.powerHistory} width={width - space.lg * 2 - space.lg * 2} />
            </Card>
          ) : null}
          {st.phase === 'finishing' ? <Banner tone="info" icon="plug" title={t('session.unplug')} body={t('session.idleNote')} /> : null}
          {st.stop === 'sent' ? <Banner tone="info" icon="stop" title={t('session.stopSent')} /> : null}
          {!pushPrompted ? (
            <Card tone="accent" style={{ width: '100%', gap: space.md }} testID="push-preprompt">
              <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
                <Icon name="bell" color={c.accent} />
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{t('push.prePromptTitle')}</Text>
                  <Text variant="footnote" tone="muted">
                    {t('push.prePromptBody')}
                  </Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button label={t('push.allow')} size="sm" full={false} onPress={() => { settingsStore.set({ pushPrompted: true }); void registerForPush(lang); }} />
                <Button label={t('push.notNow')} size="sm" variant="ghost" full={false} onPress={() => settingsStore.set({ pushPrompted: true })} />
              </View>
            </Card>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: space.lg }}>
          <Card style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xl }}>
            <View style={[styles.doneIcon, { backgroundColor: st.phase === 'failed' ? c.dangerSoft : c.accentSoft }]}>
              <Icon name={st.phase === 'failed' ? 'alert' : st.phase === 'completed' ? 'check' : 'refresh'} size={32} color={st.phase === 'failed' ? c.danger : c.accent} strokeWidth={2.6} />
            </View>
            {st.phase === 'completed' ? (
              <>
                <Text variant="display">{formatKwh(s.energyKwh, lang)}</Text>
                <Text tone="muted">
                  {formatDuration(s.durationMin, lang)} · {formatMoney(s.costMinor, cur, lang)}
                </Text>
              </>
            ) : (
              <Text align="center">
                {st.phase === 'failed'
                  ? s.problem ?? t('session.failedBody')
                  : st.phase === 'refunded' || st.phase === 'refunding'
                    ? t(st.phase === 'refunded' ? 'session.refundedBody' : 'session.refundingBody', { amount: formatMoney(s.refundMinor, cur, lang) })
                    : t('session.releasedBody')}
              </Text>
            )}
          </Card>
          {kind === 'roaming' && st.phase === 'completed' && !s.costFinal ? <Banner tone="info" icon="clock" title={t('session.partnerFinal', { operator: s.operator ?? '' })} /> : null}
          {st.phase === 'completed' && s.limitMinor && s.costMinor != null && s.limitMinor > s.costMinor && kind !== 'roaming' ? (
            <Banner tone="success" icon="refresh" title={t('session.unusedBack', { amount: formatMoney(s.limitMinor - s.costMinor, cur, lang) })} />
          ) : null}
        </View>
      )}

      <Text variant="caption" tone="faint" align="center" selectable>
        {t('session.reference', { ref: id?.slice(-12).toUpperCase() })}
      </Text>

      <ChoiceSheet
        visible={confirmStop}
        title={t('session.stopConfirmTitle')}
        body={t('session.stopConfirmBody')}
        choices={[{ key: 'stop', label: t('session.stop'), icon: 'stop', danger: true }]}
        onPick={() => {
          setConfirmStop(false);
          void stop();
        }}
        onClose={() => setConfirmStop(false)}
        cancelLabel={t('session.keepCharging')}
      />
      <ChoiceSheet
        visible={problemSheet}
        title={t('session.problemTitle')}
        choices={[
          { key: 'report', label: t('report.title'), icon: 'flag' },
          ...(operatorPhone ? [{ key: 'call', label: t('session.callSupport'), icon: 'phone' as IconName, detail: operatorPhone }] : []),
          ...(brand.support.whatsapp ? [{ key: 'wa', label: t('session.whatsapp'), icon: 'chat' as IconName }] : []),
        ]}
        onPick={(k) => {
          setProblemSheet(false);
          if (k === 'report') router.push(`/report?${kind === 'roaming' ? 'partnerRef' : 'chargeId'}=${id}&site=${encodeURIComponent(s?.siteName ?? '')}`);
          if (k === 'call' && operatorPhone) void Linking.openURL(`tel:${operatorPhone}`);
          if (k === 'wa' && brand.support.whatsapp) void Linking.openURL(`https://wa.me/${brand.support.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(t('session.waText', { ref: id }))}`);
        }}
        onClose={() => setProblemSheet(false)}
        cancelLabel={t('common.cancel')}
      />
    </Screen>
  );
}

function Stat({ icon, label, value, sub }: { icon: IconName; label: string; value: string; sub?: string }) {
  const { c } = useTheme();
  return (
    <View style={[styles.stat, { backgroundColor: c.surface, borderColor: c.line }]} accessible accessibilityLabel={`${label}: ${value}${sub ? `, ${sub}` : ''}`}>
      <Icon name={icon} size={16} color={c.accent} />
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {label}
      </Text>
      <Text variant="title3" style={{ fontFamily: 'Sora_700Bold' }} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? (
        <Text variant="caption" tone="faint" numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 28 },
  stepDot: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  pulse: { width: 8, height: 8, borderRadius: 4 },
  soc: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, marginTop: space.xs },
  stats: { flexDirection: 'row', gap: space.sm, width: '100%' },
  costCard: { width: '100%', flexDirection: 'row', alignItems: 'flex-end', gap: space.md, padding: space.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2 },
  stat: { flex: 1, padding: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2, gap: 2 },
  doneIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
});
