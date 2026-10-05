import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { getLocales } from 'expo-localization';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useErrorText } from '@/components/StateView';
import { Text } from '@/components/Text';
import { brand } from '@/config';
import { countryForRegion, PHONE_COUNTRIES, toE164, type PhoneCountry } from '@/lib/phone';
import { ensureDevice } from '@/state/auth';
import { qk, queryClient } from '@/state/queryClient';
import { settingsStore, useSettings } from '@/state/settings';
import { radius, space, touch, useTheme } from '@/theme';

/** Phone OTP (spec §6.10): country picker from the device region, SMS autofill (`oneTimeCode`), resend timer. */
export default function SignIn() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const errText = useErrorText();
  const saved = useSettings((s) => s.phoneCountry);
  const [country, setCountry] = useState<PhoneCountry>(() => saved ?? countryForRegion(getLocales()[0]?.regionCode));
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [resendIn, setResendIn] = useState(0);
  const [devCode, setDevCode] = useState<string | null>(null);
  const codeRef = useRef<TextInput>(null);
  const e164 = toE164(country, phone);

  useEffect(() => {
    if (resendIn <= 0) return;
    const h = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(h);
  }, [resendIn]);

  const send = useMutation({
    mutationFn: async () => {
      await ensureDevice();
      return api.identity.sendOtp(e164!);
    },
    onSuccess: (r) => {
      settingsStore.set({ phoneCountry: country });
      setDevCode(r.devCode ?? null);
      setStep('code');
      setResendIn(45);
      setTimeout(() => codeRef.current?.focus(), 200);
    },
  });
  const verify = useMutation({
    mutationFn: () => api.identity.verifyOtp(e164!, code.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      void queryClient.invalidateQueries({ queryKey: qk.me });
      router.back();
    },
  });

  useEffect(() => {
    if (code.length === 6 && step === 'code' && !verify.isPending) verify.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const err = send.error ?? verify.error;
  return (
    <Screen back modal title={step === 'phone' ? t('signIn.title') : t('signIn.codeTitle')} subtitle={step === 'phone' ? t('signIn.subtitle', { app: brand.appName }) : t('signIn.codeSent', { phone: e164 })} testID="sign-in"
      footer={
        step === 'phone' ? (
          <Button label={t('signIn.sendCode')} icon="chat" disabled={!e164} loading={send.isPending} onPress={() => send.mutate()} testID="send-code" />
        ) : (
          <View style={{ gap: space.sm }}>
            <Button label={t('signIn.verify')} disabled={code.trim().length < 4} loading={verify.isPending} onPress={() => verify.mutate()} testID="verify-code" />
            <Button label={resendIn > 0 ? t('signIn.resendIn', { s: resendIn }) : t('signIn.resend')} variant="ghost" size="md" disabled={resendIn > 0} onPress={() => send.mutate()} />
          </View>
        )
      }
    >
      {err ? <Banner tone="danger" title={errText(err).title} body={errText(err).body} testID="sign-in-error" /> : null}
      {step === 'phone' ? (
        <View style={{ gap: space.md }}>
          <View style={{ flexDirection: 'row', gap: space.sm }} accessibilityRole="radiogroup">
            {(brand.countries as PhoneCountry[]).map((k) => (
              <Pressable key={k} onPress={() => setCountry(k)} accessibilityRole="radio" accessibilityState={{ checked: country === k }} accessibilityLabel={`+${PHONE_COUNTRIES[k].dial}`} style={[styles.cc, { borderColor: country === k ? c.fill : c.line, backgroundColor: country === k ? c.accentSoft : c.surface }]}>
                <Text variant="bodyStrong">
                  {PHONE_COUNTRIES[k].flag} +{PHONE_COUNTRIES[k].dial}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={[styles.field, { borderColor: e164 || !phone ? c.line : c.warning, backgroundColor: c.surface }]}>
            <Text variant="title3" tone="muted">
              +{PHONE_COUNTRIES[country].dial}
            </Text>
            <TextInput
              value={phone}
              onChangeText={setPhone}
              placeholder={PHONE_COUNTRIES[country].example}
              placeholderTextColor={c.textFaint}
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
              autoFocus
              style={[styles.input, { color: c.text }]}
              accessibilityLabel={t('signIn.phone')}
              testID="phone-input"
            />
          </View>
          <Text variant="footnote" tone="muted">
            {t('signIn.why')}
          </Text>
        </View>
      ) : (
        <View style={{ gap: space.md }}>
          <TextInput
            ref={codeRef}
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            placeholder="••••••"
            placeholderTextColor={c.textFaint}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="sms-otp"
            style={[styles.code, { color: c.text, borderColor: c.fill, backgroundColor: c.surface }]}
            accessibilityLabel={t('signIn.code')}
            testID="code-input"
            maxFontSizeMultiplier={1.4}
          />
          {devCode ? <Banner tone="info" title={t('signIn.devCode', { code: devCode })} /> : null}
          <Button label={t('signIn.changeNumber')} variant="ghost" size="sm" full={false} onPress={() => { setStep('phone'); setCode(''); }} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cc: { flex: 1, minHeight: touch.min + 4, borderRadius: radius.md, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  field: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.lg, minHeight: touch.comfortable + 8 },
  input: { flex: 1, fontSize: 22, fontFamily: 'Sora_600SemiBold', minHeight: touch.comfortable + 8, letterSpacing: 0.5 },
  code: { minHeight: 72, borderWidth: 2, borderRadius: radius.lg, textAlign: 'center', fontSize: 34, fontFamily: 'Sora_700Bold', letterSpacing: 12 },
});
