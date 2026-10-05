import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Two kinds of storage:
 *  - secrets (the `psd_…` device token): Keychain (AfterFirstUnlockThisDeviceOnly) / Android Keystore via
 *    expo-secure-store; never AsyncStorage, never logged (spec §11.1). Web (screenshots, dev only) falls back to
 *    localStorage.
 *  - cache / preferences: AsyncStorage, JSON, failures swallowed (a cache miss is never an error).
 */
const webStore = () => (typeof localStorage !== 'undefined' ? localStorage : null);

export const secret = {
  async get(key: string): Promise<string | null> {
    try {
      if (Platform.OS === 'web') return webStore()?.getItem(key) ?? null;
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      webStore()?.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  },
  async remove(key: string): Promise<void> {
    try {
      if (Platform.OS === 'web') webStore()?.removeItem(key);
      else await SecureStore.deleteItemAsync(key);
    } catch {
      /* already gone */
    }
  },
};

export const kv = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw == null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  },
  async set<T>(key: string, value: T): Promise<void> {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* cache only */
    }
  },
  async remove(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* cache only */
    }
  },
};

export const KEYS = {
  deviceToken: 'ps.deviceToken',
  settings: 'ps.settings.v1',
  lastRegion: 'ps.map.lastRegion',
  stationsCache: 'ps.cache.stations',
  activeCharge: 'ps.activeCharge',
  capabilities: 'ps.capabilities',
  pendingCheckout: 'ps.pendingCheckout',
  pushToken: 'ps.pushToken',
} as const;
