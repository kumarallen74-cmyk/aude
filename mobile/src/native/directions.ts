import { Linking, Platform } from 'react-native';

/** Directions hand-off (spec §6.3): Google Maps, Apple Maps (iOS), Waze — whichever the driver picks. */
export type MapsApp = 'google' | 'apple' | 'waze';

export function directionsUrl(app: MapsApp, lat: number, lon: number, label?: string): string {
  const q = label ? encodeURIComponent(label) : '';
  switch (app) {
    case 'apple':
      return `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d${q ? `&q=${q}` : ''}`;
    case 'waze':
      return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
    default:
      return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
  }
}

export function availableMapsApps(): MapsApp[] {
  return Platform.OS === 'ios' ? ['apple', 'google', 'waze'] : ['google', 'waze'];
}

export async function openDirections(app: MapsApp, lat: number, lon: number, label?: string): Promise<void> {
  await Linking.openURL(directionsUrl(app, lat, lon, label));
}
