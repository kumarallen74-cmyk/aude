import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cluster, parseFilters, matches, inBox, cellDeg, fromPartner, firstK, bboxFitsZoom, maxSpanDeg, type MapStation } from './map.js';
import { parseBbox, encodeCursor, decodeCursor, bboxSql } from './stations.js';
import { parseLink, webFallback, normEvseId } from './links.js';
import { compareVersions, validateAppConfig, appConfigFor } from './app-config.js';
import { appleAssociation, assetLinks, NETWORK_LINK_PATHS, type Brand } from '../services/brand.js';
import { contentOf, liveSessionMessage, planFor, type Snapshot } from '../services/live-activity.js';
import { phoneHash } from './account-deletion.js';

/**
 * The mobile app's backend (docs/MOBILE-APP-SPEC.md §14 G1–G8, §15), the parts without a database: map clustering,
 * filters and paging; deep links; the version gate; app-site association for the network brand; live session payloads.
 */

const st = (id: string, lat: number, lon: number, over: Partial<MapStation> = {}): MapStation => ({
  id, kind: 'hosted', path: 'direct', name: id, operator: 'Op', address: null, lat, lon, distanceKm: null,
  availableCount: 1, totalCount: 2, maxPowerKw: 60, dc: true, connectorTypes: ['CCS2'], priceFromMinor: 2466, priceFromMajor: 2466,
  currency: 'IDR', pricesIncludeTax: false, startable: true, reason: null, reasonCode: null, ...over,
});

describe('map (G7)', () => {
  test('the viewport may not be larger than 16 tiles at its zoom (whole world from zoom 4 down)', () => {
    assert.equal(maxSpanDeg(0), 360);
    assert.equal(maxSpanDeg(4), 360);
    assert.equal(maxSpanDeg(5), 180);
    assert.ok(Math.abs(maxSpanDeg(16) - 0.0879) < 1e-3);
    assert.ok(bboxFitsZoom([95, -11, 141, 7], 5), 'Indonesia to the Philippines at zoom 5');
    assert.ok(!bboxFitsZoom([95, -11, 141, 7], 16), 'a continent at street level');
    assert.ok(bboxFitsZoom([106.8, -6.25, 106.84, -6.21], 16));
    assert.ok(bboxFitsZoom([170, -10, -170, 10], 4), 'across the antimeridian: 20 degrees wide');
    assert.ok(!bboxFitsZoom([106.8, -60, 106.9, 60], 6), 'too tall');
  });

  test('firstK: the first k in order without sorting everything (same as a full sort)', () => {
    const xs = Array.from({ length: 5000 }, (_, i) => (i * 7919) % 5003);
    const cmp = (a: number, b: number) => a - b;
    assert.deepEqual(firstK(xs, 200, cmp), [...xs].sort(cmp).slice(0, 200));
    assert.deepEqual(firstK(xs, 1, cmp), [Math.min(...xs)]);
    assert.deepEqual(firstK([3, 1, 2], 10, cmp), [1, 2, 3]);
    assert.deepEqual(firstK(xs, 0, cmp), []);
  });

  test('bbox: w,s,e,n validated; antimeridian boxes allowed', () => {
    assert.deepEqual(parseBbox('106.7,-6.4,107.1,-6.1'), [106.7, -6.4, 107.1, -6.1]);
    assert.equal(parseBbox('1,2,3'), null);
    assert.equal(parseBbox('0,10,1,5'), null, 'south above north');
    assert.equal(parseBbox('0,-91,1,5'), null);
    assert.deepEqual(parseBbox('170,-10,-170,10'), [170, -10, -170, 10]);
    assert.ok(inBox(0, 175, [170, -10, -170, 10]));
    assert.ok(inBox(0, -175, [170, -10, -170, 10]));
    assert.ok(!inBox(0, 0, [170, -10, -170, 10]));
    assert.ok(bboxSql('s', 2).includes('$2::float8') && bboxSql('s', 2).includes('$5::float8'));
  });

  test('clusters: stations sharing a cell are one cluster with count, availability, bounds and the zoom that splits them', () => {
    const pts = [
      st('a', -6.2000, 106.8000), st('b', -6.2001, 106.8001, { availableCount: 0 }), st('c', -6.2002, 106.8002),
      st('far', -7.5, 110.4),
    ];
    const { clusters, singles } = cluster(pts, 8);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]!.count, 3);
    assert.equal(clusters[0]!.available, 2);
    assert.deepEqual(singles.map((s) => s.id), ['far']);
    assert.ok(clusters[0]!.expansionZoom > 8 && clusters[0]!.expansionZoom <= 20);
    const [w, s, e, n] = clusters[0]!.bbox;
    assert.ok(w <= 106.8 && e >= 106.8002 && s <= -6.2002 && n >= -6.2);
    // At the expansion zoom the three no longer share one cell.
    const again = cluster(pts.slice(0, 3), clusters[0]!.expansionZoom);
    assert.ok(again.clusters.every((c) => c.count < 3));
    // Cell size halves with each zoom level.
    assert.equal(cellDeg(10) * 2, cellDeg(9));
  });

  test('filters: connector type, power, DC, available, network, startable', () => {
    const f = parseFilters({ connector: 'ccs2,Type 2', minKw: '50', dc: '1', available: 'true', network: 'hosted', startable: '1' });
    assert.deepEqual(f, { connectors: ['CCS2', 'TYPE2'], minKw: 50, dc: true, available: true, network: 'hosted', startable: true });
    assert.ok(matches(st('a', 0, 0), f));
    assert.ok(!matches(st('a', 0, 0, { maxPowerKw: 22 }), f));
    assert.ok(!matches(st('a', 0, 0, { connectorTypes: ['CHAdeMO'] }), f));
    assert.ok(!matches(st('a', 0, 0, { kind: 'partner' }), f));
    assert.ok(!matches(st('a', 0, 0, { availableCount: 0 }), f));
    assert.ok(matches(st('a', 0, 0, { connectorTypes: ['Type 2'], dc: false, maxPowerKw: 22 }), { connectors: ['TYPE2'] }));
  });

  test('a partner station on the map: roaming path, its reason code, the hold', () => {
    const m = fromPartner({
      partnerId: 'p', countryCode: 'MY', partyId: 'ABC', locationId: 'L1', name: 'KL Sentral', address: null, city: null, operator: 'ABC',
      lat: 3.13, lon: 101.68, distanceKm: null, evses: [{ uid: 'E1', evseId: 'MY*ABC*E1', status: 'Available', available: true, connectors: [{ id: '1', typeLabel: 'CCS2', current: 'DC', maxPowerKw: 120 }] }],
      availableCount: 1, totalCount: 1, fastest: '120 kW DC', priceFromMinor: 120, priceFromMajor: 1.2, priceCurrency: 'MYR', vatPercent: 8, currency: 'MYR',
      startable: false, reason: 'Masuk untuk mengisi di jaringan mitra.', reasonCode: 'sign_in', holdMinor: 5000, savedCards: [],
    })!;
    assert.equal(m.path, 'roaming');
    assert.equal(m.id, 'p:MY:ABC:L1');
    assert.equal(m.reasonCode, 'sign_in');
    assert.equal(m.startable, false);
    assert.equal(m.partner!.holdMinor, 5000);
    assert.equal(m.maxPowerKw, 120);
  });

  test('cursors: opaque, tied to their query', () => {
    const c = encodeCursor(50, 'st:x');
    assert.equal(decodeCursor(c, 'st:x'), 50);
    assert.equal(decodeCursor(c, 'st:y'), null);
    assert.equal(decodeCursor('garbage', 'st:x'), null);
    assert.equal(decodeCursor(undefined, 'st:x'), 0);
  });
});

describe('deep links (G6)', () => {
  test('link domain paths, the web app\'s links and plain codes', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    assert.deepEqual(parseLink('https://go.plugsure.asia/c/AUTEL-DC60-SMB-002:1'), { kind: 'code', code: 'AUTEL-DC60-SMB-002:1' });
    assert.deepEqual(parseLink('https://go.plugsure.asia/c/AUTEL-DC60-SMB-002/2'), { kind: 'code', code: 'AUTEL-DC60-SMB-002/2' });
    assert.deepEqual(parseLink(`https://go.plugsure.asia/s/${id}`), { kind: 'site', siteId: id });
    assert.deepEqual(parseLink(`https://go.plugsure.asia/r/charge/${id}`), { kind: 'receipt', chargeId: id });
    assert.deepEqual(parseLink(`https://go.plugsure.asia/r/partner/${id}`), { kind: 'partner_receipt', cdrId: id });
    assert.deepEqual(parseLink('https://go.plugsure.asia/paid?for=charge'), { kind: 'payment_return', for: 'charge' });
    assert.deepEqual(parseLink('https://app.nusacharge.id/app/?code=AUTEL-AC22-SMB-001'), { kind: 'code', code: 'AUTEL-AC22-SMB-001' });
    assert.deepEqual(parseLink('https://x.id/app/#c/01.POSO.20.3275.010'), { kind: 'code', code: '01.POSO.20.3275.010' });
    assert.deepEqual(parseLink(`https://x.id/app/#s/${id}`), { kind: 'charge', chargeId: id });
    assert.deepEqual(parseLink(`https://x.id/app/#rr/${id}`), { kind: 'partner_receipt', cdrId: id });
    assert.deepEqual(parseLink('https://stickers.example.com/q/ABC123'), { kind: 'code', code: 'ABC123' }, 'operators\' stickers: the last segment');
    assert.deepEqual(parseLink('plugsure://c/XYZ:1'), { kind: 'code', code: 'XYZ:1' });
    assert.deepEqual(parseLink('  MY*ABC*E1  '), { kind: 'code', code: 'MY*ABC*E1' });
    assert.equal(parseLink(''), null);
    assert.equal(parseLink('https://x.id/app/'), null);
    assert.equal(normEvseId('my*abc*e-1'), 'MYABCE1');
  });

  test('web fallbacks: the PWA\'s own routes', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    assert.equal(webFallback({ kind: 'code', code: 'A B:1' }), '/app/#c/A%20B%3A1');
    assert.equal(webFallback({ kind: 'receipt', chargeId: id }), `/app/#r/${id}`);
    assert.equal(webFallback({ kind: 'partner_receipt', cdrId: id }), `/app/#rr/${id}`);
    assert.equal(webFallback({ kind: 'payment_return', for: 'charge' }, '?for=charge'), '/app/paid.html?for=charge');
    assert.equal(webFallback(null), '/app/');
  });
});

const brand = (over: Partial<Brand> = {}): Brand => ({
  orgId: '00000000-0000-4000-8000-000000000009', slug: 'plugsure', status: 'live', appName: 'PlugSure', shortName: 'PlugSure',
  taglineId: null, taglineEn: null, descriptionId: null, descriptionEn: null, accentColor: '#2fd6a7', badgeColor: '#1b4d8c',
  hasIcon: true, iconSha256: null, supportEmail: 'help@plugsure.asia', supportPhone: null, privacyUrl: 'https://plugsure.asia/privacy', termsUrl: 'https://plugsure.asia/terms',
  hostname: 'go.plugsure.asia', androidPackage: 'asia.plugsure.app', androidCertSha256: ['AB:CD'], iosBundleId: 'asia.plugsure.app', iosTeamId: 'ABCDE12345',
  versionName: '1.0.0', versionCode: 1, updatedAt: new Date().toISOString(), publishedAt: null,
  apnsKeyId: null, apnsConfigured: false, apnsCheckedAt: null, apnsCheckOk: null, apnsCheckDetail: null,
  scope: 'network', fcmProjectId: null, fcmClientEmail: null, fcmConfigured: false, fcmCheckedAt: null, fcmCheckOk: null, fcmCheckDetail: null, appConfig: {}, ...over,
});

describe('app-site association (G6)', () => {
  test('the network brand hands /c, /s, /r, /paid and /app to the app; an operator\'s brand keeps /app only', () => {
    const net = appleAssociation(brand()) as any;
    assert.deepEqual(net.applinks.details[0].appIDs, ['ABCDE12345.asia.plugsure.app']);
    assert.deepEqual(net.applinks.details[0].components.map((c: any) => c['/']), NETWORK_LINK_PATHS.map((p) => p.path));
    const op = appleAssociation(brand({ scope: 'operator' })) as any;
    assert.deepEqual(op.applinks.details[0].components, [{ '/': '/app/*', comment: 'The driver app' }]);
    assert.equal((assetLinks(brand()) as any)[0].target.package_name, 'asia.plugsure.app');
  });
});

describe('version gate and remote configuration (G8)', () => {
  test('versions compare numerically', () => {
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('1.0.3', '1.0.3'), 0);
    assert.equal(compareVersions('1.0.2', '1.0.10'), -1);
  });

  test('the console\'s configuration is validated field by field', () => {
    const ok = validateAppConfig({ ios: { minSupported: '1.0.0', latest: '1.2.0', storeUrl: 'https://apps.apple.com/app/id1' }, features: { routePlanner: true }, maintenance: { active: false } });
    assert.ok(ok.ok);
    const bad = validateAppConfig({ ios: { minSupported: '2.0.0', latest: '1.0.0', storeUrl: 'http://x' }, android: { latest: 'v1' }, features: { teleport: true, applePay: 'yes' } });
    assert.ok(!bad.ok);
    assert.deepEqual(Object.keys((bad as { errors: Record<string, string> }).errors).sort(),
      ['android.latest', 'features.applePay', 'features.teleport', 'ios.minSupported', 'ios.storeUrl']);
  });

  test('force below the minimum, soft below the latest, maintenance in the driver\'s language', () => {
    const b = brand({ appConfig: { ios: { minSupported: '1.0.2', latest: '1.1.0' }, maintenance: { active: true, messageId: 'Perawatan', messageEn: 'Maintenance' }, features: { applePay: true } } });
    const ctx = { brand: b, platform: 'ios' as const, version: '1.0.1', build: 42, lang: 'en' as const, roaming: true, origin: 'https://go.plugsure.asia' };
    const c = appConfigFor(ctx);
    assert.equal(c.force, true);
    assert.equal(c.softUpdate, true);
    assert.deepEqual(c.maintenance, { active: true, message: 'Maintenance' });
    assert.equal(c.features.applePay, true);
    assert.equal(c.features.roaming, true);
    assert.equal(c.links.accountDeletion, 'https://go.plugsure.asia/account/delete');
    assert.equal(c.brand?.scope, 'network');
    assert.equal(appConfigFor({ ...ctx, version: '1.0.2' }).force, false);
    assert.equal(appConfigFor({ ...ctx, version: '1.1.0' }).softUpdate, false);
    assert.equal(appConfigFor({ ...ctx, lang: 'id' }).maintenance.message, 'Perawatan');
    // A switch cannot turn on what the server does not offer.
    assert.equal(appConfigFor({ ...ctx, roaming: false, brand: brand({ appConfig: { features: { roaming: true } } }) }).features.roaming, false);
    // Android: the Play page by default; no version: never forced.
    const a = appConfigFor({ ...ctx, platform: 'android', version: null });
    assert.equal(a.storeUrl, 'https://play.google.com/store/apps/details?id=asia.plugsure.app');
    assert.equal(a.force, false);
  });
});

describe('live sessions (G3)', () => {
  const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
    sessionState: 'active', energyWh: 12_345, powerW: 48_000, socPercent: 61, progressPct: null,
    startedAt: new Date('2026-10-04T10:00:00Z'), endedAt: null, cdrTotalMinor: null, estimateIdr: 1234, currency: 'MYR', ...over,
  });

  test('content version 1 (installed widgets) is unchanged; version 2 carries costs in every currency', () => {
    const v1 = contentOf(snap());
    assert.equal(v1.estimateIdr, null, 'v1: no ringgit cost shown as rupiah');
    assert.equal(v1.currency, 'MYR');
    const v2 = contentOf(snap(), 2);
    assert.equal(v2.estimateIdr, 1234);
    assert.equal(v2.currency, 'MYR');
    assert.equal(contentOf(snap({ currency: 'IDR' }), 2).currency, 'IDR', 'v2 always names the currency');
    assert.equal(contentOf(snap({ currency: 'IDR' })).currency, undefined, 'v1 IDR content exactly as before');
    assert.equal(planFor({ content: null, status: null, sentAt: null }, snap(), new Date(), 2).action, 'update');
  });

  test('the Android data message: strings only, ProgressStyle hints, the content state', () => {
    const c = contentOf(snap(), 2);
    const m = liveSessionMessage('update', 'ref-1', 'roaming', c, Date.UTC(2026, 9, 4, 10, 5), { site: 'KL Sentral', connector: 'CCS2 120 kW' });
    assert.ok(Object.values(m).every((v) => typeof v === 'string'));
    assert.equal(m.type, 'live_session');
    assert.equal(m.path, 'roaming');
    assert.equal(m.progress, '61');
    assert.equal(m.progressIndeterminate, '0');
    assert.equal(m.ongoing, '1');
    assert.ok(m.staleAt);
    assert.deepEqual(JSON.parse(m.contentState!), c);
    const end = liveSessionMessage('end', 'ref-1', 'direct', contentOf(snap({ sessionState: 'completed', socPercent: null }), 2), Date.now(), null);
    assert.equal(end.ongoing, '0');
    assert.ok(end.dismissAt);
    const noSoc = liveSessionMessage('update', 'r', 'direct', contentOf(snap({ socPercent: null }), 2), Date.now(), null);
    assert.equal(noSoc.progressIndeterminate, '1');
  });
});

describe('account deletion (G4)', () => {
  test('the phone number is replaced by a keyed one-way hash', () => {
    assert.match(phoneHash('+6281234567890'), /^[0-9a-f]{64}$/);
    assert.equal(phoneHash('+6281234567890'), phoneHash('+6281234567890'));
    assert.notEqual(phoneHash('+6281234567890'), phoneHash('+6281234567891'));
  });
});
