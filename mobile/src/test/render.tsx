import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { resetCapabilities } from '@/api/capabilities';
import { api, runtime } from '@/api/client';
import { mockFetch, mockOptions, resetMock } from '@/api/mock/server';
import i18n from '@/i18n';
import { authStore } from '@/state/auth';
import { ThemeProvider } from '@/theme';

/** Render a screen with the app's providers (fresh query cache, English, dark theme) against the mock backend. */
export async function renderScreen(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <ThemeProvider forced="dark">{children}</ThemeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </SafeAreaProvider>
  );
  const r = await render(ui, { wrapper: Wrapper });
  return { ...r, client };
}

/** A fresh mock backend and a device token (guest), like the first launch does. */
export async function freshDevice(): Promise<string> {
  mockOptions.latencyMs = 0;
  api.http.configure({ fetchImpl: mockFetch, baseUrl: 'https://mock.plugsure.invalid' });
  resetMock();
  resetCapabilities();
  runtime.token = null;
  const d = await api.identity.issueDevice();
  runtime.token = d.deviceToken;
  authStore.set({ token: d.deviceToken, ready: true });
  await i18n.changeLanguage('en');
  return d.deviceToken;
}
