import * as Location from 'expo-location';
import { Platform } from 'react-native';

export type LocationPermission = 'granted' | 'denied' | 'undetermined';

export async function locationPermission(): Promise<LocationPermission> {
  try {
    const p = await Location.getForegroundPermissionsAsync();
    return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Asked in context, after the in-app pre-prompt (spec §6.1). Foreground only; never background. */
export async function requestLocation(): Promise<LocationPermission> {
  try {
    const p = await Location.requestForegroundPermissionsAsync();
    return p.granted ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Fast fix: last known first (instant), then a balanced-accuracy fix within 6 s. */
export async function currentPosition(): Promise<{ lat: number; lon: number } | null> {
  try {
    if (Platform.OS !== 'web') {
      const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 });
      if (last) return { lat: last.coords.latitude, lon: last.coords.longitude };
    }
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((r) => setTimeout(() => r(null), 6000)),
    ]);
    return fix ? { lat: fix.coords.latitude, lon: fix.coords.longitude } : null;
  } catch {
    return null;
  }
}
