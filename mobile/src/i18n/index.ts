import { getLocales } from 'expo-localization';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { AppLocale } from '../../brands/brand';
import { brand } from '@/config';
import { runtime } from '@/api/client';
import en from './locales/en.json';
import id from './locales/id.json';
import ms from './locales/ms.json';
import zh from './locales/zh.json';

/**
 * App strings: en + id complete (CI checks every key exists in both with the same {{variables}}); ms and zh are
 * scaffolding for v1.1 (missing keys fall back to English). Language: stored choice → device → brand default
 * (same order as the PWA's pickLang). The server gets `X-Driver-Lang` (id | en only until [§14 G16]).
 */
export const resources = { en: { translation: en }, id: { translation: id }, ms: { translation: ms }, zh: { translation: zh } } as const;
export const SUPPORTED: AppLocale[] = (['en', 'id', 'ms', 'zh'] as AppLocale[]).filter((l) => brand.locales.includes(l));

export function deviceLocale(): AppLocale | null {
  try {
    for (const l of getLocales()) {
      const code = (l.languageCode ?? '').toLowerCase();
      if (code === 'in' || code === 'id') return 'id';
      if (code === 'ms') return SUPPORTED.includes('ms') ? 'ms' : null;
      if (code === 'zh') return SUPPORTED.includes('zh') ? 'zh' : null;
      if (code === 'en') return 'en';
    }
  } catch {
    /* no locale info (tests / web without navigator) */
  }
  return null;
}

export function resolveLanguage(choice: 'system' | AppLocale): AppLocale {
  if (choice !== 'system' && SUPPORTED.includes(choice)) return choice;
  const dev = deviceLocale();
  if (dev && SUPPORTED.includes(dev)) return dev;
  return brand.defaultLocale;
}

/** The server understands id and en only ([§14 G16] adds ms / zh). */
export const serverLang = (l: AppLocale): 'id' | 'en' => (l === 'id' ? 'id' : 'en');

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage('system'),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
  compatibilityJSON: 'v4',
});
runtime.lang = serverLang(i18n.language as AppLocale);

export async function setLanguage(choice: 'system' | AppLocale): Promise<AppLocale> {
  const lng = resolveLanguage(choice);
  await i18n.changeLanguage(lng);
  runtime.lang = serverLang(lng);
  return lng;
}

export default i18n;
