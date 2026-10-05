import { isUnsupported, resetCapabilities } from '../capabilities';
import { createApi } from '../client';
import { ApiError, Http, seg } from '../http';

type Call = { url: string; init: RequestInit };
function fakeFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  });
  return { f: f as unknown as typeof fetch, calls };
}
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const make = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof Http>[0]> = {}) =>
  createApi({ baseUrl: 'https://api.test', fetchImpl, getToken: () => 'psd_secret', getLang: () => 'id', brandSlug: 'plugsure', appVersion: '1.0.0', platform: 'ios', ...extra });

beforeEach(() => resetCapabilities());

describe('Http: headers', () => {
  it('sends the device token, brand, language, app version and JSON body', async () => {
    const { f, calls } = fakeFetch(() => json(200, { stations: [] }));
    const api = make(f);
    await api.stations.list({ lat: -6.2, lon: 106.8 });
    expect(calls[0]!.url).toBe('https://api.test/d/v1/stations?lat=-6.2&lon=106.8');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer psd_secret');
    expect(h['X-Driver-Brand']).toBe('plugsure');
    expect(h['X-Driver-Lang']).toBe('id');
    expect(h['X-App-Version']).toBe('1.0.0');
    expect(h['X-App-Platform']).toBe('ios');
    expect(h['Content-Type']).toBeUndefined();
  });
  it('omits Authorization without a token', async () => {
    const { f, calls } = fakeFetch(() => json(200, { deviceToken: 'psd_x', deviceId: 'd' }));
    await make(f, { getToken: () => null }).identity.issueDevice();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
  it('payment / charge creation carries an Idempotency-Key ([§14 G12]); a retry reuses it', async () => {
    const { f, calls } = fakeFetch(() => json(200, { ok: true, chargeId: 'c1' }));
    const api = make(f);
    await api.charge.prepaid('conn', 100000, { method: 'QRIS' }, undefined, 'key-1');
    await api.charge.prepaid('conn', 100000, { method: 'QRIS' }, undefined, 'key-1');
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toEqual(['key-1', 'key-1']);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ connectorId: 'conn', amountMinor: 100000, method: 'QRIS' });
    await api.roaming.start({ partnerId: 'p', countryCode: 'SG', partyId: 'LCE', locationId: 'L', evseUid: 'E' });
    expect((calls[2]!.init.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$/);
  });
});

describe('Http: error classification (network vs server vs business)', () => {
  it('network failure → offline (retryable)', async () => {
    const api = make((async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch);
    const e = await api.identity.me().catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ kind: 'offline', retryable: true });
  });
  it('timeout → timeout', async () => {
    const hang = ((_: unknown, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch;
    const e = await make(hang, { timeoutMs: 20 }).identity.me().catch((x) => x);
    expect(e).toMatchObject({ kind: 'timeout' });
  });
  it('401 no_device asks the session layer for a fresh device token', async () => {
    const onUnauthorized = jest.fn();
    const { f } = fakeFetch(() => json(401, { error: 'device token required', code: 'no_device' }));
    const e = await make(f, { onUnauthorized }).identity.me().catch((x) => x);
    expect(e).toMatchObject({ kind: 'auth', status: 401, code: 'no_device' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
  it.each([
    [400, { ok: false, error: 'Kode salah. Coba lagi.' }, 'business', 'Kode salah. Coba lagi.'],
    [409, { error: 'Belum ada tagihan.' }, 'business', 'Belum ada tagihan.'],
    [429, { error: 'Terlalu banyak percobaan.' }, 'rate_limited', 'Terlalu banyak percobaan.'],
    [404, { error: 'not_found' }, 'not_found', 'not_found'],
    [503, { ok: false, error: 'Pengisian di jaringan mitra belum tersedia.', code: 'ocpi_url_not_configured' }, 'server', 'Pengisian di jaringan mitra belum tersedia.'],
  ])('%i → %s with the server sentence', async (status, body, kind, message) => {
    const { f } = fakeFetch(() => json(status, body));
    const e = await make(f).identity.verifyOtp('+62812', '000000').catch((x) => x);
    expect(e).toMatchObject({ kind, status, message });
  });
  it('an HTML 502 from a proxy is a server error without a message', async () => {
    const { f } = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const e = await make(f).identity.me().catch((x) => x);
    expect(e).toMatchObject({ kind: 'server', message: '' });
  });
});

describe('feature detection for the not-yet-built P1 endpoints (§14 G9)', () => {
  it('a Fastify "route not found" 404 marks the feature unsupported and short-circuits later calls', async () => {
    const { f, calls } = fakeFetch(() => json(404, { message: 'Route POST:/d/v1/reports not found', error: 'Not Found', statusCode: 404 }));
    const api = make(f);
    expect(await api.feedback.report({ category: 'broken' })).toBe('unsupported');
    expect(isUnsupported('reports')).toBe(true);
    expect(await api.feedback.report({ category: 'broken' })).toBe('unsupported');
    expect(calls).toHaveLength(1);
  });
  it('a business 404 on a supported endpoint is NOT mistaken for a missing route', async () => {
    const { f } = fakeFetch(() => json(404, { error: 'Transaksi tidak ditemukan.' }));
    const e = await make(f).feedback.rate('charge', 'x', 5, []).catch((x) => x);
    expect(e).toMatchObject({ kind: 'not_found' });
    expect(isUnsupported('ratings')).toBe(false);
  });
});

describe('§15 contract', () => {
  it('app config: platform, version and build in the query; unreachable → null (never blocks)', async () => {
    const { f, calls } = fakeFetch(() => json(200, { force: false, softUpdate: true, minSupported: '1.0.0', latest: '1.2.0' }));
    const c = await make(f).appConfig.get('android', '1.0.3', '42');
    expect(c).toMatchObject({ softUpdate: true });
    expect(calls[0]!.url).toContain('/d/v1/app/config?platform=android&version=1.0.3&build=42');
    const { f: down } = fakeFetch(() => json(503, { error: 'down' }));
    expect(await make(down).appConfig.get('ios', '1.0.0')).toBeNull();
  });
  it('the web preview asks without a platform (400 bad_platform otherwise)', async () => {
    const { f, calls } = fakeFetch(() => json(200, {}));
    await make(f).appConfig.get('web', '1.0.0');
    expect(calls[0]!.url).not.toContain('platform=');
  });
  it('FCM / APNs registration sends {token, lang}; 409 no_brand → needs_brand', async () => {
    const { f, calls } = fakeFetch(() => json(200, { ok: true }));
    expect(await make(f).push.registerFcm('tok', 'id')).toBe('registered');
    expect(calls[0]!.url).toContain('/d/v1/push/fcm');
    expect(bodyOf(calls[0]!)).toEqual({ token: 'tok', lang: 'id' });
    const { f: nb } = fakeFetch(() => json(409, { error: 'no brand', code: 'no_brand' }));
    expect(await make(nb).push.registerApns('abc', 'id')).toBe('needs_brand');
  });
  it('live sessions: iOS registers content-state version 2; Android does not', async () => {
    const { f, calls } = fakeFetch(() => json(200, { ok: true, kind: 'charge' }));
    await make(f).push.registerLiveSession('ios', 'ref1', 'hex');
    await make(f).push.registerLiveSession('android', 'ref1', 'fcm');
    expect(bodyOf(calls[0]!)).toEqual({ platform: 'ios', ref: 'ref1', token: 'hex', contentVersion: 2 });
    expect(bodyOf(calls[1]!)).toEqual({ platform: 'android', ref: 'ref1', token: 'fcm' });
  });
  it('map: bbox w,s,e,n, zoom, filters and cluster=0', async () => {
    const { f, calls } = fakeFetch(() => json(200, { zoom: 12, bbox: [0, 0, 0, 0], clusters: [], stations: [], total: 0, unclustered: 0, nextCursor: null, partners: null }));
    await make(f).stations.map({ bbox: [106.6, -6.4, 107.1, -6.0], zoom: 12.4, near: { lat: -6.2, lon: 106.9 }, cluster: false, filters: { connector: 'CCS2,TYPE2', dc: 1 } });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/d/v1/map');
    expect(Object.fromEntries(u.searchParams)).toEqual({ bbox: '106.60000,-6.40000,107.10000,-6.00000', zoom: '12', near: '-6.20000,106.90000', cluster: '0', connector: 'CCS2,TYPE2', dc: '1' });
  });
  it('links/resolve: unknown → null; other_operator is thrown', async () => {
    const { f } = fakeFetch(() => json(404, { error: 'x', code: 'not_found' }));
    expect(await make(f).links.resolve('ZZZ')).toBeNull();
    const { f: other } = fakeFetch(() => json(404, { error: 'Charger belongs to another operator.', code: 'other_operator' }));
    await expect(make(other).links.resolve('ABC')).rejects.toMatchObject({ code: 'other_operator' });
  });
  it('account deletion: 409 with blockers is a value, not a failure', async () => {
    const unpaid = [{ chargeId: 'c', kind: 'postpay', owedMinor: 5000, site: 'X', currency: 'IDR' }];
    const { f } = fakeFetch(() => json(409, { error: 'Akun belum dapat dihapus.', code: 'unpaid', blockers: [{ code: 'unpaid', unpaid }], unpaid }));
    expect(await make(f).account.confirmDeletion('123456')).toEqual({ kind: 'blocked', code: 'unpaid', message: 'Akun belum dapat dihapus.', blockers: [{ code: 'unpaid', unpaid }] });
    const { f: ok } = fakeFetch(() => json(200, { ok: true, deleted: ['name'], retained: ['invoices'], summary: {} }));
    expect(await make(ok).account.confirmDeletion('123456')).toEqual({ kind: 'deleted', deleted: ['name'], retained: ['invoices'] });
  });
});

describe('answers that are values, not failures', () => {
  it('quote 422 returns {ok:false, minimumViableMinor}', async () => {
    const { f } = fakeFetch(() => json(422, { ok: false, error: 'Jumlah ini belum menutup biaya tetap.', minimumViableMinor: 3500 }));
    expect(await make(f).charge.quote('c', 1000)).toEqual({ ok: false, error: 'Jumlah ini belum menutup biaya tetap.', minimumViableMinor: 3500 });
  });
  it('resolve 404 → null; other_operator still throws (shown as "belongs to another operator")', async () => {
    const { f } = fakeFetch(() => json(404, { error: 'not_found', message: 'Kode charger tidak dikenal.' }));
    expect(await make(f).stations.resolve('NOPE')).toBeNull();
    const { f: f2 } = fakeFetch(() => json(404, { error: 'Charger ini dikelola operator lain.', code: 'other_operator' }));
    await expect(make(f2).stations.resolve('X')).rejects.toMatchObject({ code: 'other_operator' });
  });
});

describe('seg (ids from deep links / push into API paths)', () => {
  it('percent-encodes a segment so it cannot add path segments or a query', () => {
    expect(seg('abc-123')).toBe('abc-123');
    expect(seg('../../account/delete?x=1')).toBe('..%2F..%2Faccount%2Fdelete%3Fx%3D1');
  });
  it('refuses dot segments and empty ids (the URL parser would resolve them to another endpoint)', () => {
    for (const bad of ['', '.', '..']) expect(() => seg(bad)).toThrow(ApiError);
    expect(seg('%2e%2e')).toBe('%252e%252e');
  });
});
