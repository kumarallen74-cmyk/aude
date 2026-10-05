import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
import type { Brand } from '../brands/brand';
import defaultBrandJson from '../brands/plugsure.json';

/**
 * Runtime configuration: the brand resolved by app.config.ts at build time (`extra.brand`),
 * falling back to the PlugSure brand file (tests, a bare web export).
 */
interface Extra {
  variant?: string;
  appEnv?: 'development' | 'preview' | 'production';
  apiBase?: string;
  brand?: Brand;
}

const extra: Extra = (Constants.expoConfig?.extra as Extra | undefined) ?? {};
const defaultBrand = defaultBrandJson as unknown as Brand;

export const brand: Brand = { ...defaultBrand, ...(extra.brand ?? {}) };

export const appEnv = extra.appEnv ?? 'development';

/**
 * The API base. `mock` = the built-in demo backend (src/api/mock), used for web screenshots, store review demos and
 * tests. app.config.ts refuses a mock / plain-http base for an APP_ENV=production build, but an OTA update (EAS
 * Update) bundles its own `EXPO_PUBLIC_API_BASE_URL` and `extra`: so a release binary — not a dev build, and on a
 * `production*` update channel or built as production — only ever talks to an https backend, falling back to the
 * brand's own.
 */
export function resolveApiBase(i: { envApi?: string | null; extraApi?: string | null; brandApi: string; dev: boolean; channel?: string | null; appEnv?: string }): string {
  const trim = (u: string) => u.replace(/\/+$/, '');
  const production = !i.dev && (!!i.channel?.startsWith('production') || i.appEnv === 'production');
  if (!production) return trim(i.envApi || i.extraApi || i.brandApi);
  const https = (u?: string | null): u is string => !!u && /^https:\/\/[^/\s]+/i.test(u.trim());
  return trim(https(i.extraApi) ? i.extraApi.trim() : i.brandApi);
}

function updatesChannel(): string | null {
  try {
    return Updates.channel ?? null;
  } catch {
    return null;
  }
}

const envApi = typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_API_BASE_URL : undefined;
export const apiBase: string = resolveApiBase({ envApi, extraApi: extra.apiBase, brandApi: brand.apiBase, dev: typeof __DEV__ !== 'undefined' && __DEV__, channel: updatesChannel(), appEnv });
export const isMockApi = apiBase === 'mock';
export const appVersion: string = Constants.expoConfig?.version ?? '1.0.0';
export const platform = Platform.OS as 'ios' | 'android' | 'web';
export const linkHost = brand.linkHosts[0] ?? 'go.plugsure.asia';
