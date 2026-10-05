import type { AppLocale } from '../../brands/brand';
import { createStore, useStore } from '@/lib/store';
import { kv, KEYS } from '@/lib/storage';
import { DEFAULT_FILTERS, type Filters } from '@/lib/filters';

export type ThemePref = 'system' | 'light' | 'dark';
export type NotificationCategory = 'charging' | 'payments' | 'reservations' | 'account' | 'promotions';

export interface Settings {
  hydrated: boolean;
  onboarded: boolean;
  language: 'system' | AppLocale;
  theme: ThemePref;
  /** Spec §6.10: per category; promotions are opt-in (separate consent, PDPA). */
  notifications: Record<NotificationCategory, boolean>;
  /** Accessibility: replace slide-to-start with a plain button (WCAG 2.5.7). */
  simpleStart: boolean;
  filters: Filters;
  mapMode: 'map' | 'list';
  locationPrompted: boolean;
  pushPrompted: boolean;
  /** The last country used for phone sign-in (+62 / +60 / +65). */
  phoneCountry: 'ID' | 'MY' | 'SG' | null;
  /** The payment method last used per currency (its pick key): preselected next time — a choice the driver made. */
  lastMethod: Partial<Record<string, string>>;
}

export const DEFAULT_SETTINGS: Settings = {
  hydrated: false,
  onboarded: false,
  language: 'system',
  theme: 'system',
  notifications: { charging: true, payments: true, reservations: true, account: true, promotions: false },
  simpleStart: false,
  filters: DEFAULT_FILTERS,
  mapMode: 'map',
  locationPrompted: false,
  pushPrompted: false,
  phoneCountry: null,
  lastMethod: {},
};

export const settingsStore = createStore<Settings>(DEFAULT_SETTINGS, (s) => {
  if (!s.hydrated) return;
  const { hydrated: _h, ...persist } = s;
  void kv.set(KEYS.settings, persist);
});

export async function hydrateSettings(): Promise<void> {
  const saved = await kv.get<Partial<Settings>>(KEYS.settings);
  settingsStore.set({
    ...DEFAULT_SETTINGS,
    ...(saved ?? {}),
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(saved?.notifications ?? {}) },
    filters: { ...DEFAULT_FILTERS, ...(saved?.filters ?? {}) },
    hydrated: true,
  });
}

export const useSettings = <S>(selector: (s: Settings) => S) => useStore(settingsStore, selector);
