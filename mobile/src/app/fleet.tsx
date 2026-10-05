import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useErrorText } from '@/components/StateView';
import { Text } from '@/components/Text';
import { ensureDevice } from '@/state/auth';
import { queryClient } from '@/state/queryClient';
import { radius, space, touch, useTheme } from '@/theme';

/** Fleet login (J4): organisation code + RFID card number + PIN; charges are billed to the fleet. */
export default function FleetLogin() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const errText = useErrorText();
  const [org, setOrg] = useState('');
  const [uid, setUid] = useState('');
  const [pin, setPin] = useState('');
  const m = useMutation({
    mutationFn: async () => {
      await ensureDevice();
      return api.identity.fleetLogin(org.trim(), uid.trim(), pin);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      router.back();
    },
  });
  const field = (label: string, value: string, set: (v: string) => void, opts: Partial<React.ComponentProps<typeof TextInput>> = {}) => (
    <View style={{ gap: space.xs }}>
      <Text variant="footnote" tone="muted">
        {label}
      </Text>
      <TextInput value={value} onChangeText={set} style={[styles.input, { color: c.text, borderColor: c.line, backgroundColor: c.surface }]} placeholderTextColor={c.textFaint} accessibilityLabel={label} autoCorrect={false} {...opts} />
    </View>
  );
  return (
    <Screen back modal title={t('fleet.title')} subtitle={t('fleet.subtitle')} footer={<Button label={t('fleet.signIn')} loading={m.isPending} disabled={!org || !uid || pin.length < 4} onPress={() => m.mutate()} />}>
      {m.error ? <Banner tone="danger" title={errText(m.error).title} body={errText(m.error).body} /> : null}
      {field(t('fleet.org'), org, setOrg, { autoCapitalize: 'none', placeholder: 'acme-logistics' })}
      {field(t('fleet.card'), uid, setUid, { autoCapitalize: 'characters', placeholder: '04A1B2C3D4' })}
      {field(t('fleet.pin'), pin, (v) => setPin(v.replace(/\D/g, '').slice(0, 8)), { keyboardType: 'number-pad', secureTextEntry: true, placeholder: '••••' })}
    </Screen>
  );
}

const styles = StyleSheet.create({ input: { minHeight: touch.comfortable, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 17, fontFamily: 'PlusJakartaSans_600SemiBold' } });
