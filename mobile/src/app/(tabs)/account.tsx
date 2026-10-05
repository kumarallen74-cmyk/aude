import { useMutation } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Icon } from '@/components/Icon';
import { ListGroup, ListRow } from '@/components/ListRow';
import { Logo } from '@/components/Logo';
import { Screen, Section } from '@/components/Screen';
import { Skeleton } from '@/components/Skeleton';
import { useErrorText } from '@/components/StateView';
import { Text } from '@/components/Text';
import { appVersion, brand } from '@/config';
import { formatPhone } from '@/lib/phone';
import { openLink } from '@/native/browser';
import { unregisterPush } from '@/native/notifications';
import { signOut, useMe } from '@/state/auth';
import { qk, queryClient } from '@/state/queryClient';
import { settingsStore, useSettings } from '@/state/settings';
import { radius, space, touch, useTheme } from '@/theme';

const LANG_NAME: Record<string, string> = { system: 'settings.system', en: 'English', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', zh: '简体中文' };

export default function AccountScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const me = useMe();
  const language = useSettings((s) => s.language);
  const theme = useSettings((s) => s.theme);
  const simpleStart = useSettings((s) => s.simpleStart);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const account = me.data?.account;
  const fleet = me.data?.fleet;

  const saveName = useMutation({
    mutationFn: () => api.identity.setName(name.trim()),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: qk.me });
    },
  });
  const errText = useErrorText();
  const out = useMutation({
    mutationFn: async () => {
      await unregisterPush().catch(() => {});
      await signOut();
    },
  });

  return (
    <Screen title={t('account.title')} testID="account-screen">
      {me.isLoading ? (
        <Skeleton height={120} r={radius.lg} />
      ) : account || fleet ? (
        <Card style={{ gap: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={[styles.avatar, { backgroundColor: c.accentSoft }]}>
              {account?.name ? (
                <Text variant="title2" tone="accent">
                  {account.name.trim().slice(0, 1).toUpperCase()}
                </Text>
              ) : (
                <Icon name={fleet ? 'car' : 'user'} size={26} color={c.accent} />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="title2" numberOfLines={1}>
                {account?.name || (fleet ? t('account.fleetDriver') : t('account.noName'))}
              </Text>
              <Text tone="muted">{account ? formatPhone(account.phone) : fleet?.uid}</Text>
            </View>
            {account ? <Button label={t('common.edit')} variant="secondary" size="sm" full={false} onPress={() => { setName(account.name ?? ''); setEditing(!editing); }} /> : null}
          </View>
          {editing ? (
            <View style={{ gap: space.sm }}>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={t('account.namePlaceholder')}
                placeholderTextColor={c.textFaint}
                autoComplete="name"
                textContentType="name"
                style={[styles.input, { color: c.text, borderColor: c.line, backgroundColor: c.bg }]}
                accessibilityLabel={t('account.namePlaceholder')}
              />
              <Button label={t('common.save')} size="md" loading={saveName.isPending} onPress={() => saveName.mutate()} />
            </View>
          ) : null}
        </Card>
      ) : (
        <Card tone="accent" style={{ gap: space.md }} testID="signin-card">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <Logo size={48} />
            <View style={{ flex: 1 }}>
              <Text variant="title3">{t('account.guestTitle')}</Text>
              <Text variant="footnote" tone="muted">
                {t('account.guestBody')}
              </Text>
            </View>
          </View>
          <Button label={t('account.signIn')} icon="phone" onPress={() => router.push('/sign-in')} testID="go-sign-in" />
          {brand.features.fleetLogin ? <Button label={t('account.fleetLogin')} variant="ghost" size="md" onPress={() => router.push('/fleet')} /> : null}
        </Card>
      )}

      <Section title={t('account.charging')}>
        <ListGroup>
          <ListRow icon="card" label={t('account.paymentMethods')} detail={t('account.paymentMethodsDetail')} onPress={() => router.push('/payment-methods')} />
          {brand.features.memberships ? <ListRow icon="ticket" label={t('account.passes')} onPress={() => router.push('/passes')} /> : null}
          <ListRow icon="heart" label={t('account.favourites')} onPress={() => router.push('/favourites')} last />
        </ListGroup>
      </Section>

      <Section title={t('account.preferences')}>
        <ListGroup>
          <ListRow icon="languages" label={t('settings.language')} value={language === 'system' ? t('settings.system') : LANG_NAME[language]} onPress={() => router.push('/settings/language')} />
          <ListRow icon={theme === 'light' ? 'sun' : 'moon'} label={t('settings.appearance')} value={t(`settings.theme.${theme}`)} onPress={() => router.push('/settings/appearance')} />
          <ListRow icon="bell" label={t('settings.notifications')} onPress={() => router.push('/settings/notifications')} />
          <ListRow icon="bolt" label={t('settings.simpleStart')} detail={t('settings.simpleStartDetail')} toggle={simpleStart} onToggle={(v) => settingsStore.set({ simpleStart: v })} last />
        </ListGroup>
      </Section>

      <Section title={t('account.help')}>
        <ListGroup>
          <ListRow icon="info" label={t('account.faq')} onPress={() => void openLink(brand.links.help)} external />
          {brand.support.whatsapp ? <ListRow icon="chat" label={t('account.whatsapp')} onPress={() => void Linking.openURL(`https://wa.me/${brand.support.whatsapp!.replace(/\D/g, '')}`)} external /> : null}
          {brand.support.phone ? <ListRow icon="phone" label={t('account.call')} value={brand.support.phone} onPress={() => void Linking.openURL(`tel:${brand.support.phone}`)} /> : null}
          <ListRow icon="file" label={t('account.terms')} onPress={() => void openLink(brand.links.terms)} external />
          <ListRow icon="shield" label={t('account.privacy')} onPress={() => void openLink(brand.links.privacy)} external last />
        </ListGroup>
      </Section>

      {account || fleet ? (
        <Section>
          {out.error ? <Banner tone="danger" title={t('account.signOutFailed')} body={errText(out.error).body} testID="sign-out-error" /> : null}
          <ListGroup>
            <ListRow icon="logout" label={t('account.signOut')} onPress={() => out.mutate()} />
            {account ? <ListRow icon="trash" label={t('account.delete')} danger onPress={() => router.push('/delete-account')} testID="delete-account" last /> : null}
          </ListGroup>
        </Section>
      ) : null}

      <Text variant="caption" tone="faint" align="center">
        {brand.appName} {appVersion} ({Application.nativeBuildVersion ?? 'web'}) · {t('account.poweredBy')}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: touch.comfortable, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 17, fontFamily: 'PlusJakartaSans_600SemiBold' },
});
