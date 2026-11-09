import type { ClusterItem, Region } from '@/lib/geo';

export interface StationMapProps {
  region: Region;
  onRegionChange: (r: Region) => void;
  items: ClusterItem[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onClusterPress: (id: number | string, lat: number, lon: number) => void;
  user: { lat: number; lon: number } | null;
  tileUrl?: string | null;
  /** Credit line for the tiles (e.g. "© OpenStreetMap contributors"), shown on the tile map. */
  attribution?: string | null;
  scheme: 'light' | 'dark';
  /** Bottom inset (sheet) so centring keeps the pin visible. */
  bottomInset?: number;
  stale?: boolean;
  /** Localised screen-reader labels. */
  mapLabel?: string;
  userLabel?: string;
  clusterLabel?: (count: number, available: number) => string;
  stationLabel?: (s: import('@/lib/stationModel').MapStation) => string;
}

export interface StationMapHandle {
  animateTo(r: Region): void;
  /** Zoom in (+1) or out (-1) one step: the tile map's zoom buttons (it has no pinch gesture). */
  zoomBy?(delta: number): void;
}
