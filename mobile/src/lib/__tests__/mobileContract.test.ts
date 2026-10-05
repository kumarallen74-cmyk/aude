import type { MapStationDto, MapViewport } from '@/api/types';
import { toItems } from '@/features/mapViewport';
import { minutesLeft, wantChoices } from '@/features/queue';
import { scrub, scrubBreadcrumb, scrubEvent } from '@/native/crash';
import { base64FromDataUri, qrFileName } from '@/native/saveQr';
import { hrefForResolution } from '../deeplink';
import { clientOnly, DEFAULT_FILTERS, filtersToQuery } from '../filters';
import { maxSpanDeg, snapBBox, viewportQuery } from '../geo';
import { googlePlacesProvider, placeProviders, searchPlaces, stationProvider } from '../placeSearch';
import { fromMapDto, type MapStation } from '../stationModel';

jest.mock('expo-router', () => require('@/test/expoRouterMock'));
jest.mock('expo-media-library', () => ({}));
jest.mock('expo-file-system', () => ({}));

const dto = (p: Partial<MapStationDto> = {}): MapStationDto => ({
  id: 's1', kind: 'hosted', path: 'direct', siteId: 's1', name: 'Summarecon Mall Bekasi', operator: 'Nusantara Charge', address: 'Jl. Bulevar', lat: -6.2246, lon: 106.9998,
  distanceKm: 0.4, availableCount: 1, totalCount: 3, maxPowerKw: 60, dc: true, connectorTypes: ['Type 2', 'CCS2'], priceFromMinor: 2466, priceFromMajor: 2466,
  currency: 'IDR', pricesIncludeTax: false, startable: true, reason: null, reasonCode: null, ...p,
});

describe('§15.4 map model', () => {
  it('a hosted station', () => {
    expect(fromMapDto(dto())).toMatchObject({ key: 'h:s1', kind: 'hosted', siteId: 's1', partner: null, currents: ['AC', 'DC'], availability: 'available', currency: 'IDR' });
  });
  it('a partner station keeps its OCPI address, hold and reason code', () => {
    const p = fromMapDto(dto({
      id: 'p:ID:EXT:LOC1', kind: 'partner', path: 'roaming', siteId: undefined, connectorTypes: ['CCS2'], availableCount: 0, startable: false, reason: 'Sign in to charge on partner networks.', reasonCode: 'sign_in',
      currency: 'MYR', partner: { partnerId: 'p', countryCode: 'ID', partyId: 'EXT', locationId: 'LOC1', holdMinor: 5000 },
    }));
    expect(p).toMatchObject({ key: 'p:p:ID:EXT:LOC1', siteId: null, partner: { locationId: 'LOC1' }, holdMinor: 5000, reasonCode: 'sign_in', currents: ['DC'], availability: 'busy', startable: false });
  });
  it('filters: the server gets connector / power / DC / available / startable / network; the phone keeps the rest', () => {
    const f = { ...DEFAULT_FILTERS, connectors: ['CCS2' as const, 'GB/T' as const, 'CHAdeMO' as const], current: 'DC' as const, minKw: 50, availableNow: true, startableInApp: true, partners: false };
    expect(filtersToQuery(f)).toEqual({ connector: 'CCS2,GBT,CHADEMO', minKw: 50, dc: 1, available: 1, startable: 1, network: 'hosted' });
    expect(filtersToQuery(DEFAULT_FILTERS)).toEqual({});
    expect(clientOnly({ ...f, current: 'AC', networks: ['VoltNusa'], openNow: true })).toMatchObject({ current: 'AC', networks: ['VoltNusa'], openNow: true, availableNow: false, connectors: [], partners: true });
  });
  it('server clusters and stations become markers; client-only filters still apply', () => {
    const vp: MapViewport = {
      zoom: 8, bbox: [106, -7, 108, -5.5], total: 14, unclustered: 2, nextCursor: null, partners: null,
      clusters: [{ id: 'c8:1209:430', lat: -6.2, lon: 106.8, count: 12, available: 9, bbox: [106.75, -6.25, 106.86, -6.15], expansionZoom: 10 }],
      stations: [dto(), dto({ id: 's2', siteId: 's2', operator: 'VoltNusa' })],
    };
    const items = toItems(vp, { ...DEFAULT_FILTERS, networks: ['VoltNusa'] });
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: 'cluster', id: 'c8:1209:430', lat: -6.2, lon: 106.8, count: 12, available: 9, expansionZoom: 10 });
    expect(items[1]).toMatchObject({ type: 'station', station: { siteId: 's2' } });
  });
  it('the map query never exceeds the server cap at its zoom (16 tiles), at any zoom', () => {
    for (const d of [60, 10, 1, 0.1, 0.01, 0.001, 0.0003]) {
      const q = viewportQuery({ latitude: -6.2, longitude: 106.8, latitudeDelta: d * 2.2, longitudeDelta: d }, 360);
      expect(q.bbox[2] - q.bbox[0]).toBeLessThanOrEqual(maxSpanDeg(q.zoom));
      expect(q.bbox[3] - q.bbox[1]).toBeLessThanOrEqual(Math.min(180, maxSpanDeg(q.zoom)));
      expect(q.bbox[0]).toBeLessThanOrEqual(106.8 - d / 2 + 1e-9 + (d > maxSpanDeg(q.zoom) ? 360 : 0));
    }
  });
  it('viewport bboxes snap outwards so small pans reuse the cached answer', () => {
    expect(snapBBox([106.8123, -6.2311, 106.9101, -6.1502], 0.01)).toEqual([106.81, -6.24, 106.92, -6.15]);
  });
});

describe('§15.5 resolved links → screens', () => {
  it.each([
    [{ kind: 'connector', path: 'direct', connectorId: 'c1', siteId: 's', connector: {} }, '/connector/c1'],
    [{ kind: 'partner_evse', path: 'roaming', name: 'KL', operator: 'ABC', status: 'AVAILABLE', partner: { partnerId: 'p1', countryCode: 'MY', partyId: 'ABC', locationId: 'L 1', evseUid: 'L1-E1', connectorId: '1' } }, '/partner/p1/L%201?countryCode=MY&partyId=ABC&evseUid=L1-E1'],
    [{ kind: 'site', siteId: 's9' }, '/station/s9'],
    [{ kind: 'charge', chargeId: 'x' }, '/session/charge/x'],
    [{ kind: 'receipt', chargeId: 'x' }, '/receipt/charge/x'],
    [{ kind: 'partner_receipt', cdrId: 'y' }, '/receipt/roaming/y'],
    [{ kind: 'payment_return', for: 'charge' }, '/paid?for=charge'],
  ] as const)('%j → %s', (r, href) => expect(hrefForResolution(r as never)).toBe(href));
});

describe('place search (provider-agnostic)', () => {
  const st = { key: 'h:1', name: 'Grand Indonesia P5', address: 'Jl. MH Thamrin', operator: 'Arus Kota', lat: -6.195, lon: 106.82, siteId: '1' } as MapStation;
  it('stations only when no geocoder key is configured', () => {
    expect(placeProviders(() => [st], undefined).map((p) => p.id)).toEqual(['stations']);
    expect(placeProviders(() => [st], ' ').map((p) => p.id)).toEqual(['stations']);
    expect(placeProviders(() => [st], 'AIza-test').map((p) => p.id)).toEqual(['stations', 'google']);
  });
  it('the station provider matches name / address / operator', async () => {
    const r = await stationProvider(() => [st]).search('thamrin', { near: null, lang: 'en' });
    expect(r).toEqual([expect.objectContaining({ kind: 'station', title: 'Grand Indonesia P5', station: st })]);
  });
  it('Google Places (New) text search: key + field mask headers, location bias; one failing provider hides nothing', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ places: [{ id: 'abc', displayName: { text: 'Bandara Soekarno-Hatta' }, formattedAddress: 'Tangerang', location: { latitude: -6.12, longitude: 106.65 } }] }) }));
    const g = googlePlacesProvider('KEY', fetchImpl);
    const r = await g.search('bandara', { near: { lat: -6.2, lon: 106.8 }, lang: 'id' });
    expect(r).toEqual([{ id: 'g:abc', kind: 'place', title: 'Bandara Soekarno-Hatta', subtitle: 'Tangerang', lat: -6.12, lon: 106.65, provider: 'google' }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(init.headers).toMatchObject({ 'X-Goog-Api-Key': 'KEY', 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location' });
    expect(JSON.parse(init.body)).toMatchObject({ textQuery: 'bandara', languageCode: 'id', locationBias: { circle: { center: { latitude: -6.2, longitude: 106.8 } } } });
    const broken = { id: 'x', search: async () => Promise.reject(new Error('quota')) };
    expect(await searchPlaces([stationProvider(() => [st]), broken], 'grand', { near: null, lang: 'en' })).toHaveLength(1);
  });
});

describe('queue helpers', () => {
  it('offer minutes left and the connector-kind choices', () => {
    expect(minutesLeft(new Date(Date.now() + 9.2 * 60_000).toISOString(), Date.now())).toBe(10);
    expect(minutesLeft(new Date(Date.now() - 1000).toISOString(), Date.now())).toBe(0);
    expect(wantChoices({ types: [{ current: 'DC', type: 'cCCS2', typeLabel: 'CCS2' }] })).toEqual([
      { key: 'any', want: { current: null, type: null }, label: null },
      { key: 'DC|cCCS2', want: { current: 'DC', type: 'cCCS2' }, label: 'CCS2 DC' },
    ]);
  });
});

describe('Save QR', () => {
  it('takes the PNG body of the server data URI; a safe file name', () => {
    expect(base64FromDataUri('data:image/png;base64,iVBORw0KGgo=')).toEqual({ base64: 'iVBORw0KGgo=', ext: 'png' });
    expect(base64FromDataUri('https://x/qr.png')).toBeNull();
    expect(qrFileName('MOCK-abc/../123', 'png')).toBe('qr-MOCK-abc123.png');
  });
});

describe('crash reporting scrubbing', () => {
  it('redacts secrets, device tokens and phone numbers; drops the user and request bodies', () => {
    expect(scrub({ token: 'psd_x', nested: { phone: '+6281234567890', note: 'call +62 812 3456 7890 with psd_abc123' } })).toEqual({ token: '[redacted]', nested: { phone: '[redacted]', note: 'call [phone] with psd_[redacted]' } });
    const e = scrubEvent({ user: { id: 'u' }, request: { url: 'https://api/d/v1/charge?x=1', headers: { authorization: 'Bearer psd_x' }, data: { code: '123456' } }, message: 'otp for +6281234567890' });
    expect(e).toEqual({ request: { url: 'https://api/d/v1/charge' }, message: 'otp for [phone]' });
  });
  it('URLs lose query strings everywhere: exception values, breadcrumbs (fetch / navigation), messages', () => {
    const e = scrubEvent({
      exception: { values: [{ type: 'ApiError', value: 'GET https://api.plugsure.asia/d/v1/links/resolve?url=plugsure://c/X&token=psd_abc failed for +6281234567890' }] },
      breadcrumbs: [{ data: { url: 'https://api/d/v1/charge/x/status?lang=id', method: 'GET' } }, { data: { from: '/sign-in?phone=0812', to: '/paid?for=charge&status=ok' } }],
      message: 'opened plugsure://paid?for=charge&code=123456',
    });
    expect(e.exception!.values![0]!.value).toBe('GET https://api.plugsure.asia/d/v1/links/resolve failed for [phone]');
    expect(e.breadcrumbs).toEqual([{ data: { url: 'https://api/d/v1/charge/x/status', method: 'GET' }, message: undefined }, { data: { from: '/sign-in', to: '/paid' }, message: undefined }]);
    expect(e.message).toBe('opened plugsure://paid');
    expect(scrubBreadcrumb({ message: 'psd_secretToken123 at /c/ABC?x=1' }).message).toBe('psd_[redacted] at /c/ABC');
  });
});

describe('unpaid sessions: what is owed and how it can be paid', () => {
  const { unpaidOf } = require('@/app/receipt/[kind]/[id]') as typeof import('@/app/receipt/[kind]/[id]');
  const { unpaidPicks } = require('@/features/UnpaidPay') as typeof import('@/features/UnpaidPay');
  const t = (k: string) => k;
  const options = { paymentMethods: [{ channel: 'CARD', method: 'card', label: 'Card' }, { channel: 'PAYNOW', method: 'qr', label: 'PayNow' }], savedCards: [{ id: 'c1', brand: 'visa', last4: '4242' }], linkedWallets: [{ id: 'w1', channel: 'GOPAY', accountLabel: '0812', postpay: true }] };
  it('an expired card hold owes unpaidMinor; post-pay owes chargedMinor while unpaid; a paid or normal session owes nothing', () => {
    expect(unpaidOf({ settlement: { hold: { expired: true, unpaidMinor: 98, payOptions: options } } } as never)).toEqual({ owedMinor: 98, options });
    expect(unpaidOf({ settlement: { postpay: { unpaid: true, chargedMinor: 5000, payOptions: options } } } as never)).toEqual({ owedMinor: 5000, options });
    expect(unpaidOf({ settlement: { hold: { expired: true, unpaidMinor: 0, paidInApp: { amountMinor: 98 } } } } as never)).toBeNull();
    expect(unpaidOf({ settlement: { refundMinor: 100 } } as never)).toBeNull();
    expect(unpaidOf({ settlement: null } as never)).toBeNull();
  });
  it('a sale: never a new hold, never post-pay, never saving a card', () => {
    const picks = unpaidPicks(options as never, t);
    expect(picks.map((p) => p.key)).toEqual(['c:c1', 'm:CARD', 'm:PAYNOW']);
    expect(picks.every((p) => !('saveCard' in p.pay) || p.pay.saveCard === undefined)).toBe(true);
    expect(picks.find((p) => p.key === 'c:c1')!.detail).toBeUndefined();
  });
});

describe('notification data.url → allow-listed app routes only', () => {
  const { routeForNotificationUrl } = require('../deeplink') as typeof import('../deeplink');
  const id = '11111111-2222-4333-8444-555555555555';
  it.each([
    [`/app/#s/${id}`, `/session/charge/${id}`],
    [`/app/#r/${id}`, `/receipt/charge/${id}`],
    [`https://go.plugsure.asia/r/charge/${id}`, `/receipt/charge/${id}`],
    [`/session/roaming/${id}`, `/session/roaming/${id}`],
    ['/activity', '/activity'],
    ['/c/AUTEL-DC60-SMB-002:1', '/c/AUTEL-DC60-SMB-002:1'],
  ])('%s → %s', (url, href) => expect(routeForNotificationUrl(url)).toBe(href));
  it.each(['https://evil.test/phish', '//evil.test/x', '/settings/../delete-account', '/delete-account', '/sign-in', 'javascript:alert(1)', '/session/charge/not-a-uuid', '', null])('refused: %s', (url) => {
    expect(routeForNotificationUrl(url as string)).toBeNull();
  });
});

describe('config plugins', () => {
  it('Save QR on Android 8–9: WRITE_EXTERNAL_STORAGE limited to API 28, replacing an unlimited or blocked one', () => {
     
    const { setWriteUpTo28 } = require('../../../plugins/withSaveQrPermission.js');
    const m = setWriteUpTo28({ manifest: { $: {}, 'uses-permission': [{ $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE', 'tools:node': 'remove' } }, { $: { 'android:name': 'android.permission.CAMERA' } }] } });
    expect(m.manifest['uses-permission']).toEqual([
      { $: { 'android:name': 'android.permission.CAMERA' } },
      { $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE', 'android:maxSdkVersion': '28', 'tools:replace': 'android:maxSdkVersion' } },
    ]);
    expect(m.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
  });
});
