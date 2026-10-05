import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { DeletionBlocker, DeletionStart } from '@/api/types';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { EmptyState, useErrorText } from '@/components/StateView';
import { Text } from '@/components/Text';
import { brand } from '@/config';
import { formatMoney } from '@/lib/money';
import { openLink } from '@/native/browser';
import { kv, KEYS } from '@/lib/storage';
import { refreshPushRegistration } from '@/native/notifications';
import { resetDevice } from '@/state/auth';
import { radius, space, touch, useTheme } from '@/theme';

/**
 * Account deletion (App Store 5.1.1(v), Google Play): explain what is deleted vs retained → OTP re-confirm → done
 * (spec §11.4, contract §15.8). Refused while money is owed or a charge, hold, reservation or queue place is open.
 */
export default function DeleteAccount() {
  const { t, i18n } = useTranslation();
  const { c } = useTheme();
  const errText = useErrorText();
  const [step, setStep] = useState<'explain' | 'code' | 'done'>('explain');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<DeletionStart | null>(null);
  const [blocked, setBlocked] = useState<{ message: string; blockers: DeletionBlocker[] } | null>(null);

  const start = useMutation({
    mutationFn: () => api.account.startDeletion(),
    onSuccess: (r) => {
      setSent(r);
      setCode('');
      setBlocked(r.blockers.length ? { message: t('delete.blockedTitle'), blockers: r.blockers } : null);
      setStep('code');
    },
  });
  const confirm = useMutation({
    mutationFn: () => api.account.confirmDeletion(code),
    onSuccess: async (r) => {
      if (r.kind === 'blocked') {
        // The code is used up: settle what blocks, then ask for a new one.
        setBlocked({ message: r.message, blockers: r.blockers });
        setStep('explain');
        return;
      }
      setStep('done');
      // §15.8: the old device token is revoked server-side — discard it and start again as a new guest.
      await kv.remove(KEYS.pushToken).catch(() => {});
      await resetDevice();
      void refreshPushRegistration(i18n.language);
    },
  });

  if (step === 'done') {
    return (
      <Screen back={() => router.replace('/')}>
        <EmptyState icon="check" title={t('delete.doneTitle')} body={t('delete.doneBody')} action={t('common.close')} onAction={() => router.replace('/')} testID="delete-done" />
      </Screen>
    );
  }
  const err = start.error ?? confirm.error;
  return (
    <Screen
      back
      title={t('delete.title')}
      testID="delete-screen"
      footer={
        step === 'explain' ? (
          <Button label={blocked ? t('delete.tryAgain') : t('delete.continue')} variant="danger" icon="trash" loading={start.isPending} onPress={() => start.mutate()} testID="delete-continue" />
        ) : (
          <Button label={t('delete.confirm')} variant="danger" disabled={code.length < 4} loading={confirm.isPending} onPress={() => confirm.mutate()} testID="delete-confirm" />
        )
      }
    >
      {err ? <Banner tone="danger" title={errText(err).title} body={errText(err).body} /> : null}
      {blocked ? <Blockers message={blocked.message} blockers={blocked.blockers} lang={i18n.language} /> : null}
      {!blocked && step === 'explain' ? (
        <Text variant="footnote" tone="muted">
          {t('delete.webAlso')}{' '}
          <Text variant="footnote" tone="accent" onPress={() => void openLink(brand.links.deleteAccount)}>
            {brand.links.deleteAccount.replace(/^https?:\/\//, '')}
          </Text>
        </Text>
      ) : null}

      {step === 'explain' ? (
        <>
          <Card style={{ gap: space.md }}>
            <Text variant="title3">{t('delete.deletedTitle')}</Text>
            {(['phone', 'name', 'cards', 'favourites', 'push'] as const).map((k) => (
              <View key={k} style={styles.li}>
                <Icon name="trash" size={16} color={c.danger} />
                <Text style={{ flex: 1 }}>{t(`delete.deleted.${k}`)}</Text>
              </View>
            ))}
          </Card>
          <Card style={{ gap: space.md }}>
            <Text variant="title3">{t('delete.keptTitle')}</Text>
            {(['receipts', 'unpaid'] as const).map((k) => (
              <View key={k} style={styles.li}>
                <Icon name="file" size={16} color={c.textMuted} />
                <Text style={{ flex: 1 }}>{t(`delete.kept.${k}`)}</Text>
              </View>
            ))}
          </Card>
        </>
      ) : (
        <View style={{ gap: space.md }}>
          <Text tone="muted" testID="delete-code-sent">{t('delete.codeSentTo', { phone: sent?.phoneMasked ?? '' })}</Text>
          {sent?.devCode ? (
            <Text variant="footnote" tone="faint" testID="delete-dev-code">
              {t('signIn.devCode', { code: sent.devCode })}
            </Text>
          ) : null}
          <TextInput
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="sms-otp"
            placeholder="••••••"
            placeholderTextColor={c.textFaint}
            style={[styles.code, { color: c.text, borderColor: confirm.error ? c.danger : code ? c.fill : c.line, backgroundColor: c.surface }]}
            accessibilityLabel={t('signIn.code')}
            testID="delete-code"
          />
        </View>
      )}
    </Screen>
  );
}

/** What stops the deletion now, each with its way out (§15.8: "the app shows blockers with Pay / Stop actions"). */
function Blockers({ message, blockers, lang }: { message: string; blockers: DeletionBlocker[]; lang: string }) {
  const { t } = useTranslation();
  return (
    <View style={{ gap: space.sm }} testID="delete-blocked">
      <Banner tone="warning" title={message} />
      {blockers.map((b) =>
        b.code === 'unpaid' ? (
          <Banner
            key={b.code}
            tone="danger"
            icon="receipt"
            title={t('delete.unpaidTitle')}
            body={b.unpaid.map((u) => `${u.site}: ${formatMoney(u.owedMinor, u.currency, lang)}`).join('\n')}
            action={t('activity.payNow')}
            onPress={() => router.push('/activity')}
            testID="delete-blocker-unpaid"
          />
        ) : b.code === 'active_session' || b.code === 'open_hold' ? (
          <Banner
            key={b.code}
            tone="warning"
            icon="bolt"
            title={t(`delete.blocker.${b.code}`)}
            action={b.chargeIds[0] ? t('delete.openCharge') : undefined}
            onPress={b.chargeIds[0] ? () => router.push(`/session/charge/${b.chargeIds[0]}`) : undefined}
          />
        ) : (
          <Banner key={b.code} tone="warning" icon="clock" title={t(`delete.blocker.${b.code}`)} action={t('activity.title')} onPress={() => router.push('/activity')} />
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  li: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  code: { minHeight: touch.comfortable + 16, borderWidth: 2, borderRadius: radius.lg, textAlign: 'center', fontSize: 30, fontFamily: 'Sora_700Bold', letterSpacing: 10 },
});
