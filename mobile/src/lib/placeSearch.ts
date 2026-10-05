import { createStore } from './store';
import { searchStations } from './search';
import type { MapStation } from './stationModel';

/**
 * Place search behind one provider-agnostic interface (spec §4.3). The default searches the server's stations
 * (name, address, operator); an optional geocoder adds places ("Grand Indonesia", "Bandara Soekarno-Hatta") that
 * move the map there. Google Places (New) is built in and switched on by `EXPO_PUBLIC_GOOGLE_PLACES_KEY`; any other
 * geocoder implements `PlaceSearchProvider`.
 */
export interface PlaceResult {
  id: string;
  kind: 'station' | 'place';
  title: string;
  subtitle: string | null;
  lat: number;
  lon: number;
  station?: MapStation;
  provider: string;
}

export interface PlaceSearchProvider {
  id: string;
  /** Results for `q`, biased to `near` when known. */
  search(q: string, opts: { near: { lat: number; lon: number } | null; lang: string; signal?: AbortSignal }): Promise<PlaceResult[]>;
}

/** The default: the server's station list (`GET /d/v1/stations`), matched on the phone. */
export function stationProvider(stations: () => MapStation[]): PlaceSearchProvider {
  return {
    id: 'stations',
    search: async (q) =>
      searchStations(stations(), q).map((s) => ({ id: s.key, kind: 'station', title: s.name, subtitle: [s.address, s.operator].filter(Boolean).join(' · ') || null, lat: s.lat, lon: s.lon, station: s, provider: 'stations' })),
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Google Places API (New) Text Search — only the fields the app shows (billing SKU "Text Search Essentials IDs + location"). */
export function googlePlacesProvider(apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): PlaceSearchProvider {
  return {
    id: 'google',
    search: async (q, { near, lang, signal }) => {
      if (q.trim().length < 3) return [];
      const body: Record<string, unknown> = { textQuery: q.trim(), languageCode: lang, maxResultCount: 5 };
      if (near) body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: 50_000 } };
      const r = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location' },
        body: JSON.stringify(body),
        signal,
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { places?: { id: string; displayName?: { text?: string }; formattedAddress?: string; location?: { latitude: number; longitude: number } }[] };
      return (j.places ?? [])
        .filter((p) => p.location)
        .map((p) => ({ id: `g:${p.id}`, kind: 'place' as const, title: p.displayName?.text ?? p.formattedAddress ?? '', subtitle: p.formattedAddress ?? null, lat: p.location!.latitude, lon: p.location!.longitude, provider: 'google' }));
    },
  };
}

/** The providers for this build: stations always; Google Places when a key is configured. */
export function placeProviders(stations: () => MapStation[], googleKey: string | null | undefined = typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY : undefined): PlaceSearchProvider[] {
  const key = googleKey?.trim();
  return [stationProvider(stations), ...(key ? [googlePlacesProvider(key)] : [])];
}

/** Run every provider; one failing (network, quota) never hides the others. Stations first. */
export async function searchPlaces(providers: PlaceSearchProvider[], q: string, opts: Parameters<PlaceSearchProvider['search']>[1]): Promise<PlaceResult[]> {
  const all = await Promise.all(providers.map((p) => p.search(q, opts).catch(() => [] as PlaceResult[])));
  return all.flat();
}

/** A place chosen in search: the map tab moves there. */
export const mapFocusStore = createStore<{ focus: { lat: number; lon: number } | null }>({ focus: null });
