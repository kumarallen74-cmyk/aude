import Constants from 'expo-constants';
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

/** `mock` = the built-in demo backend (src/api/mock), used for web screenshots, store review demos and tests. */
const envApi = typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_API_BASE_URL : undefined;
export const apiBase: string = (envApi || extra.apiBase || brand.apiBase).replace(/\/+$/, '');
export const isMockApi = apiBase === 'mock';
export const appEnv = extra.appEnv ?? 'development';
export const appVersion: string = Constants.expoConfig?.version ?? '1.0.0';
export const platform = Platform.OS as 'ios' | 'android' | 'web';
export const linkHost = brand.linkHosts[0] ?? 'go.plugsure.asia';
