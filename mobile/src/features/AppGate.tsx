import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { useState, type ReactNode } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { updateGate } from '@/api/appConfig';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Logo } from '@/components/Logo';
import { Text } from '@/components/Text';
import { appVersion, brand, platform } from '@/config';
import { qk } from '@/state/queryClient';
import { space, useTheme } from '@/theme';

/** Force-update (blocking) / soft-update (dismissable) / maintenance banner from `/d/v1/app/config` ([§14 G8]). */
export function AppGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(false);
  const cfg = useQuery({
    queryKey: qk.appConfig,
    queryFn: () => api.appConfig.get(platform, appVersion, Application.nativeBuildVersion ?? undefined),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: 0,
  });
  const gate = updateGate(cfg.data ?? null);
  const storeUrl = cfg.data?.storeUrl ?? (Platform.OS === 'ios' ? brand.store.appStoreUrl : brand.store.playStoreUrl);

  if (gate === 'force') {
    return (
      <View testID="force-update" style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.lg }}>
        <Logo size={88} />
        <Text variant="title1" align="center">
          {t('update.forceTitle')}
        </Text>
        <Text tone="muted" align="center">
          {t('update.forceBody', { app: brand.appName })}
        </Text>
        <Button label={t('update.open')} icon="download" onPress={() => void Linking.openURL(storeUrl)} />
      </View>
    );
  }
  const maintenance = cfg.data?.maintenance.active;
  return (
    <View style={{ flex: 1 }}>
      {children}
      {maintenance || (gate === 'soft' && !dismissed) ? (
        <View style={{ position: 'absolute', left: space.lg, right: space.lg, top: insets.top + space.xxxl + space.lg }} pointerEvents="box-none">
          {maintenance ? (
            <Banner tone="warning" icon="settings" title={t('update.maintenanceTitle')} body={cfg.data?.maintenance.message ?? t('update.maintenanceBody')} />
          ) : (
            <Banner tone="info" icon="download" title={t('update.softTitle')} body={t('update.softBody')} action={t('update.open')} onPress={() => { setDismissed(true); void Linking.openURL(storeUrl); }} />
          )}
        </View>
      ) : null}
    </View>
  );
}
