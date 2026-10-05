import type { MapStation } from './stationModel';

const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Search stations by name, address or operator, accent-insensitive (spec §4.3). Place search needs the [OWNER] geocoder. */
export function searchStations(list: MapStation[], q: string): MapStation[] {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return list
    .map((s) => {
      const hay = norm([s.name, s.address ?? '', s.operator].join(' '));
      const score = terms.every((t) => hay.includes(t)) ? (norm(s.name).startsWith(terms[0]!) ? 2 : 1) : 0;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.s.distanceKm ?? 0) - (b.s.distanceKm ?? 0))
    .map((x) => x.s)
    .slice(0, 30);
}
