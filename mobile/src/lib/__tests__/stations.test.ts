import type { RoamingStation, StationView } from '@/api/types';
import { activeFilterCount, applyFilters, DEFAULT_FILTERS, filtersToQuery } from '../filters';
import { haversineKm, StationClusterer, zoomForRegion } from '../geo';
import { searchStations } from '../search';
import { availabilityOf, mergeStations } from '../stationModel';

const conn = (status: string, type = 'CCS2', current: 'AC' | 'DC' = 'DC', kw = 60) => ({
  connectorId: Math.random().toString(), ocppIdentity: 'X', chargerName: 'X', connectorNo: 1, type, typeLabel: type, current, maxPowerW: kw * 1000, maxPowerKw: kw,
  chargingClass: 'fast', status: status as never, available: status === 'Available', blockedReason: null,
});
const hosted = (id: string, name: string, lat: number, lon: number, cs: ReturnType<typeof conn>[], over: Partial<StationView> = {}): StationView => ({
  siteId: id, name, address: null, lat, lon, spkluId: null, operator: 'Arus Kota', distanceKm: null, connectors: cs, availableCount: cs.filter((c) => c.available).length,
  totalCount: cs.length, maxPowerKw: Math.max(...cs.map((c) => c.maxPowerKw)), fastest: '', priceFromMinor: 2466, priceFromMajor: 2466.78, currency: 'IDR', countryCode: 'ID',
  timezone: null, pricesIncludeTax: false, ...over,
});
const partner = (loc: string, name: string, lat: number, lon: number, over: Partial<RoamingStation> = {}): RoamingStation => ({
  partnerId: 'p1', countryCode: 'SG', partyId: 'LCE', locationId: loc, name, address: null, city: null, operator: 'Bay Charge SG', lat, lon, distanceKm: null,
  evses: [{ uid: 'E1', evseId: 'E1', status: 'Available', available: true, connectors: [{ id: '1', typeLabel: 'CCS2', current: 'DC', maxPowerKw: 120 }] }],
  availableCount: 1, totalCount: 1, fastest: null, priceFromMinor: 72, priceFromMajor: 0.72, priceCurrency: 'SGD', vatPercent: 9, currency: 'SGD', startable: false,
  reason: 'Sign in', holdMinor: 8000, savedCards: [], ...over,
});

describe('availabilityOf', () => {
  it('is available as soon as one connector is', () => expect(availabilityOf(['Charging', 'Available'])).toBe('available'));
  it('busy when in use', () => expect(availabilityOf(['Charging', 'Faulted'])).toBe('busy'));
  it('fault when broken', () => expect(availabilityOf(['Faulted', 'Offline'])).toBe('fault'));
  it('offline when every connector is offline', () => expect(availabilityOf(['Offline', 'Offline'])).toBe('offline'));
  it('unknown without connectors', () => expect(availabilityOf([])).toBe('unknown'));
});

describe('mergeStations', () => {
  const h = [hosted('s1', 'Senayan Hub', -6.2246, 106.8019, [conn('Available'), conn('Charging', 'Type 2', 'AC', 22)])];
  it('keeps one entry for a hosted tenant also imported through the hub (prefer direct, [§14 G5])', () => {
    const list = mergeStations(h, [partner('L1', 'Senayan Hub', -6.22461, 106.80192), partner('L2', 'Woodlands', 1.4456, 103.7687)]);
    expect(list.map((s) => s.key)).toEqual(['h:s1', 'p:p1:SG:LCE:L2']);
    expect(list[0]).toMatchObject({ kind: 'hosted', startable: true, connectorTypes: ['CCS2', 'Type 2'], currents: ['DC', 'AC'] });
    expect(list[1]).toMatchObject({ kind: 'partner', startable: false, reason: 'Sign in', holdMinor: 8000, priceFromMajor: 0.72, currency: 'SGD' });
  });
  it('drops a partner price quoted in another currency than the charge', () => {
    const [p] = mergeStations([], [partner('L3', 'X', 1, 103, { priceCurrency: 'MYR' })]);
    expect(p!.priceFromMajor).toBeNull();
  });
  it('skips stations without coordinates', () => {
    expect(mergeStations([hosted('s2', 'No GPS', null as never, null as never, [conn('Available')])], [])).toHaveLength(0);
  });
});

describe('filters', () => {
  const list = mergeStations(
    [
      hosted('a', 'DC fast', 0, 0, [conn('Available', 'CCS2', 'DC', 120)]),
      hosted('b', 'AC slow busy', 0, 0.01, [conn('Charging', 'Type 2', 'AC', 7)], { operator: 'VoltNusa', priceFromMajor: 2600 }),
    ],
    [partner('L', 'Partner', 0, 0.02)],
  );
  const names = (f: Partial<typeof DEFAULT_FILTERS>) => applyFilters(list, { ...DEFAULT_FILTERS, ...f }).map((s) => s.name).sort();
  it('available now', () => expect(names({ availableNow: true })).toEqual(['DC fast', 'Partner']));
  it('AC / DC and minimum power', () => {
    expect(names({ current: 'AC' })).toEqual(['AC slow busy']);
    expect(names({ minKw: 100 })).toEqual(['DC fast', 'Partner']);
  });
  it('connector type', () => expect(names({ connectors: ['Type 2'] })).toEqual(['AC slow busy']));
  it('startable in app hides partner charging that needs sign-in', () => expect(names({ startableInApp: true })).toEqual(['AC slow busy', 'DC fast']));
  it('network', () => expect(names({ networks: ['VoltNusa'] })).toEqual(['AC slow busy']));
  it('max price per currency; unknown prices pass', () => expect(names({ maxPrice: { IDR: 2500 } })).toEqual(['DC fast', 'Partner']));
  it('partners off', () => expect(names({ partners: false })).toEqual(['AC slow busy', 'DC fast']));
  it('counts active filters and builds the §15.4 map query', () => {
    const f = { ...DEFAULT_FILTERS, availableNow: true, connectors: ['CCS2' as const, 'Type 2' as const], current: 'DC' as const, minKw: 50 };
    expect(activeFilterCount(f)).toBe(4);
    expect(filtersToQuery(f)).toMatchObject({ connector: 'CCS2,TYPE2', dc: 1, minKw: 50, available: 1 });
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
  });
});

describe('geo + clustering', () => {
  it('haversine', () => expect(Math.round(haversineKm(-6.2, 106.8, -6.3, 106.8))).toBe(11));
  it('zoom from region', () => expect(Math.round(zoomForRegion({ latitude: 0, longitude: 0, latitudeDelta: 0.35, longitudeDelta: 0.35 }, 390))).toBe(11));
  it('clusters nearby stations and splits them when zoomed in', () => {
    const many = mergeStations(Array.from({ length: 20 }, (_, i) => hosted(`s${i}`, `S${i}`, -6.2 + i * 0.0005, 106.8, [conn(i % 2 ? 'Available' : 'Charging')])), []);
    const c = new StationClusterer().load(many);
    const far = c.query({ latitude: -6.2, longitude: 106.8, latitudeDelta: 1, longitudeDelta: 1 }, 9);
    expect(far).toHaveLength(1);
    expect(far[0]).toMatchObject({ type: 'cluster', count: 20, available: 10 });
    const near = c.query({ latitude: -6.195, longitude: 106.8, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 18);
    expect(near.every((x) => x.type === 'station')).toBe(true);
  });
});

describe('search', () => {
  const list = mergeStations([hosted('a', 'Sudirman Tower', 0, 0, [conn('Available')]), hosted('b', 'Kemang Square', 0, 0, [conn('Available')], { address: 'Jl. Kemang Raya', operator: 'VoltNusa' })], []);
  it('matches name, address and operator, accent- and case-insensitive', () => {
    expect(searchStations(list, 'sudir').map((s) => s.name)).toEqual(['Sudirman Tower']);
    expect(searchStations(list, 'KEMANG raya').map((s) => s.name)).toEqual(['Kemang Square']);
    expect(searchStations(list, 'voltnusa').map((s) => s.name)).toEqual(['Kemang Square']);
    expect(searchStations(list, '  ')).toEqual([]);
  });
});
