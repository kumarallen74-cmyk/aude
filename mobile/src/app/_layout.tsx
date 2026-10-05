import { PlusJakartaSans_400Regular } from '@expo-google-fonts/plus-jakarta-sans/400Regular';
import { PlusJakartaSans_500Medium } from '@expo-google-fonts/plus-jakarta-sans/500Medium';
import { PlusJakartaSans_600SemiBold } from '@expo-google-fonts/plus-jakarta-sans/600SemiBold';
import { PlusJakartaSans_700Bold } from '@expo-google-fonts/plus-jakarta-sans/700Bold';
import { Sora_600SemiBold } from '@expo-google-fonts/sora/600SemiBold';
import { Sora_700Bold } from '@expo-google-fonts/sora/700Bold';
import { Sora_800ExtraBold } from '@expo-google-fonts/sora/800ExtraBold';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { I18nextProvider } from 'react-i18next';
import { loadCapabilities } from '@/api/capabilities';
import { OfflineBanner } from '@/components/OfflineBanner';
import { AppGate } from '@/features/AppGate';
import i18n, { setLanguage } from '@/i18n';
import { routeForNotificationUrl } from '@/lib/deeplink';
import { registerBackgroundNotificationTask } from '@/native/backgroundTasks';
import { configureForegroundHandler, refreshPushRegistration, setupNotificationChannels, urlFromNotification } from '@/native/notifications';
import { handleLiveSessionData, watchLiveActivityTokens } from '@/native/liveSession';
import { initCrashReporting } from '@/native/crash';
import { hydrateActiveCharge } from '@/state/activeCharge';
import { bootstrapAuth } from '@/state/auth';
import { hydrateCheckout } from '@/state/checkout';
import { startNetworkWatch } from '@/state/network';
import { queryClient } from '@/state/queryClient';
import { hydrateSettings, settingsStore, useSettings } from '@/state/settings';
import { ThemeProvider, useTheme } from '@/theme';

export { ErrorBoundary } from 'expo-router';

void SplashScreen.preventAutoHideAsync().catch(() => {});
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  // Web preview only: text fields draw their own bordered container, so drop the browser's default input outline.
  const style = document.createElement('style');
  style.textContent = 'input:focus,textarea:focus{outline:none}';
  document.head.appendChild(style);
}
initCrashReporting();
if (Platform.OS !== 'web') {
  SplashScreen.setOptions({ duration: 250, fade: true });
  configureForegroundHandler();
}

export const unstable_settings = { initialRouteName: '(tabs)' };

function Navigator() {
  const { c, scheme } = useTheme();
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(c.bg).catch(() => {});
  }, [c.bg]);
  const modal = { presentation: 'modal' as const, animation: 'slide_from_bottom' as const };
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_right' }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" options={{ animation: 'fade', gestureEnabled: false }} />
        <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
        <Stack.Screen name="search" options={modal} />
        <Stack.Screen name="filters" options={modal} />
        <Stack.Screen name="sign-in" options={modal} />
        <Stack.Screen name="fleet" options={modal} />
        <Stack.Screen name="report" options={modal} />
        <Stack.Screen name="rate/[kind]/[id]" options={modal} />
        <Stack.Screen name="session/[kind]/[id]" options={{ gestureEnabled: true }} />
      </Stack>
      <OfflineBanner />
    </View>
  );
}

export default function RootLayout() {
  const [booted, setBooted] = useState(false);
  const [fontsLoaded, fontError] = useFonts({
    Sora_600SemiBold,
    Sora_700Bold,
    Sora_800ExtraBold,
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
  });
  const language = useSettings((s) => s.language);

  useEffect(() => {
    const stopNet = startNetworkWatch();
    const stopLA = watchLiveActivityTokens();
    void (async () => {
      await Promise.all([hydrateSettings(), loadCapabilities(), hydrateActiveCharge(), hydrateCheckout()]);
      await setLanguage(settingsStore.get().language);
      await bootstrapAuth();
      void setupNotificationChannels().catch(() => {});
      void registerBackgroundNotificationTask();
      // Native tokens rotate: re-register at every launch and on return to the foreground (§15.6).
      void refreshPushRegistration(i18n.language);
      setBooted(true);
    })();
    let last = AppState.currentState;
    const appState = AppState.addEventListener('change', (next) => {
      if (last !== 'active' && next === 'active') void refreshPushRegistration(i18n.language);
      last = next;
    });
    // Foreground FCM `live_session` data messages update the ongoing notification (§15.7).
    const liveSub = Platform.OS === 'android' ? Notifications.addNotificationReceivedListener((n) => handleLiveSessionData((n.request.content.data ?? {}) as Record<string, unknown>, i18n.language)) : null;
    return () => {
      stopNet();
      stopLA();
      appState.remove();
      liveSub?.remove();
    };
  }, []);

  useEffect(() => {
    if (booted) void setLanguage(language);
  }, [language, booted]);

  // A tapped notification opens what it is about (session, receipt, reservation…).
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const open = (n: Notifications.Notification) => {
      const url = urlFromNotification(n);
      // Server pushes carry web-app routes (`/app/#s/<id>`, §15.6) or app routes; only allow-listed screens open.
      const href = routeForNotificationUrl(url);
      if (href) router.push(href as never);
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) open(last.notification);
    const sub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification));
    return () => sub.remove();
  }, []);

  const ready = booted && (fontsLoaded || !!fontError);
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  if (!ready) return null;

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AppGate>
            <Navigator />
          </AppGate>
        </ThemeProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
