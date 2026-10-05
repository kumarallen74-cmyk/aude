import { createApi } from '../client';
import { mockFetch, mockOptions, resetMock } from '../mock/server';

/** End-to-end through the typed client against the in-memory backend (same shapes as the real server). */
let token: string | null = null;
const api = createApi({ baseUrl: 'https://mock.test', fetchImpl: mockFetch, getToken: () => token, getLang: () => 'en', brandSlug: 'plugsure', appVersion: '1.0.0', platform: 'android' });

beforeAll(() => {
  mockOptions.latencyMs = 0;
});
beforeEach(async () => {
  resetMock();
  token = null;
  token = (await api.identity.issueDevice()).deviceToken;
});

it('guest: browse, quote, QRIS prepaid, pay, start, charge, stop, receipt', async () => {
  const stations = await api.stations.list({ lat: -6.2, lon: 106.8 });
  expect(stations.length).toBeGreaterThan(3);
  expect(stations[0]!.distanceKm).not.toBeNull();
  const conn = stations.find((s) => s.availableCount > 0 && s.currency === 'IDR')!.connectors.find((c) => c.available)!;
  const q = await api.charge.quote(conn.connectorId, 100000);
  expect(q.ok).toBe(true);
  if (!q.ok) return;
  expect(q.paymentMethods.map((m) => m.channel)).toContain('QRIS');
  expect(q.savedCards).toEqual([]);

  const co = await api.charge.prepaid(conn.connectorId, 100000, { method: 'QRIS' });
  expect(co).toMatchObject({ ok: true, payment: { action: 'qr', channel: 'QRIS' }, demo: true });
  expect(co.qr?.qrString).toMatch(/^000201/);
  expect((await api.charge.status(co.chargeId!)).state).toBe('awaiting_payment');
  await api.charge.confirmDemoPayment(co.chargeId!);
  expect((await api.charge.status(co.chargeId!)).state).toBe('awaiting_start');
  expect(await api.charge.start(co.chargeId!)).toMatchObject({ ok: true, status: 'Accepted' });
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + 10_000);
  const live = await api.charge.status(co.chargeId!);
  expect(live.state).toBe('charging');
  expect(live.energyKwh).toBeGreaterThan(0);
  expect(live.cost?.totalMinor).toBeGreaterThan(0);
  await api.charge.stop(co.chargeId!);
  const done = await api.charge.status(co.chargeId!);
  expect(done.state).toBe('rated');
  const r = await api.charge.receipt(co.chargeId!);
  expect(r.tax?.totalMinor).toBe(done.cost?.totalMinor);
  jest.restoreAllMocks();
});

it('saved card / linked wallet pays at once (action done)', async () => {
  await api.identity.sendOtp('+6281234567890');
  await api.identity.verifyOtp('+6281234567890', '123456');
  const s = (await api.stations.list()).find((x) => x.currency === 'IDR' && x.availableCount > 0)!;
  const conn = s.connectors.find((c) => c.available)!;
  const q = await api.charge.quote(conn.connectorId, 50000);
  if (!q.ok) throw new Error('quote');
  const co = await api.charge.prepaid(conn.connectorId, 50000, { walletId: q.linkedWallets[0]!.id });
  expect(co.payment?.action).toBe('done');
});

it('OTP sign-in: wrong code is a business error, right code signs in; partner stations become startable', async () => {
  const guest = await api.stations.roaming();
  expect(guest.stations.every((s) => !s.startable)).toBe(true);
  await expect(api.identity.verifyOtp('+6281234567890', '000000')).rejects.toMatchObject({ kind: 'business' });
  await api.identity.verifyOtp('+6281234567890', '123456');
  expect((await api.identity.me()).account?.phone).toBe('+6281234567890');
  const signed = await api.stations.roaming();
  expect(signed.stations.every((s) => s.startable)).toBe(true);
  expect(signed.stations[0]!.holdMinor).toBeGreaterThan(0);
});

it('roaming: card hold checkout → paying → starting → charging → billed', async () => {
  await api.identity.verifyOtp('+6591234567', '123456');
  const st = (await api.stations.roaming()).stations.find((s) => s.currency === 'SGD')!;
  const r = await api.roaming.start({ partnerId: st.partnerId, countryCode: st.countryCode, partyId: st.partyId, locationId: st.locationId, evseUid: st.evses[0]!.uid });
  expect(r).toMatchObject({ ok: true, payment: { hold: true, action: 'redirect', currency: 'SGD', amountMinor: 8000 } });
  expect((await api.roaming.status(r.chargeId!)).state).toBe('paying');
  const t0 = Date.now();
  const at = (ms: number) => jest.spyOn(Date, 'now').mockReturnValue(t0 + ms);
  at(3500);
  expect((await api.roaming.status(r.chargeId!)).state).toBe('starting');
  at(20_000);
  const charging = await api.roaming.status(r.chargeId!);
  expect(charging).toMatchObject({ state: 'charging', canStop: true });
  await api.roaming.stop(r.chargeId!);
  const billed = await api.roaming.status(r.chargeId!);
  expect(billed.state).toBe('billed');
  expect(billed.cdrId).toBe(r.chargeId);
  jest.restoreAllMocks();
});

it('favourites and history per currency', async () => {
  await api.identity.verifyOtp('+6281234567890', '123456');
  const s = (await api.stations.list())[0]!;
  await api.favourites.add({ siteId: s.siteId });
  expect(await api.favourites.list()).toHaveLength(1);
  const h = await api.charge.history();
  expect(new Set(h.charges.map((x) => x.currency))).toEqual(new Set(['IDR', 'SGD', 'MYR']));
});

it('P1 gaps (ratings, reports not built): with gaps=true the client degrades instead of failing', async () => {
  mockOptions.gaps = true;
  try {
    expect(await api.push.registerFcm('tok', 'en')).toBe('registered');
    expect(await api.appConfig.get('android', '1.0.0')).toMatchObject({ force: false, softUpdate: false });
    expect(await api.feedback.report({ category: 'broken' })).toBe('unsupported');
  } finally {
    mockOptions.gaps = false;
  }
});

it('§15.4 map: server clusters at low zoom, none with cluster=0; filters; paged stations with a query-bound cursor', async () => {
  const java: [number, number, number, number] = [106.6, -6.4, 107.1, -6.0];
  const z10 = await api.stations.map({ bbox: java, zoom: 10 });
  expect(z10.clusters.length).toBeGreaterThan(0);
  expect(z10.total).toBe(z10.clusters.reduce((a, c) => a + c.count, 0) + z10.unclustered);
  const flat = await api.stations.map({ bbox: java, zoom: 10, cluster: false, near: { lat: -6.22, lon: 106.8 } });
  expect(flat.clusters).toHaveLength(0);
  expect(flat.stations.length).toBe(flat.total);
  expect(flat.stations.some((s) => s.kind === 'partner')).toBe(true);
  const dc = await api.stations.map({ bbox: java, zoom: 12, cluster: false, filters: { dc: 1, network: 'hosted' } });
  await expect(api.stations.map({ bbox: java, zoom: 16 })).rejects.toMatchObject({ status: 400, code: 'bbox_too_large' });
  expect(dc.stations.every((s) => s.dc && s.kind === 'hosted')).toBe(true);
  const p1 = await api.stations.page({ limit: 3 });
  expect(p1.stations).toHaveLength(3);
  expect(p1.nextCursor).toBeTruthy();
  const p2 = await api.stations.page({ limit: 3, cursor: p1.nextCursor });
  expect(p2.stations[0]!.siteId).not.toBe(p1.stations[0]!.siteId);
  await expect(api.stations.page({ limit: 4, cursor: p1.nextCursor })).rejects.toMatchObject({ status: 400, code: 'bad_cursor' });
});

it('§15.5 links/resolve: sticker URL, partner EVSE id, station share link, unknown', async () => {
  expect(await api.links.resolve('https://go.plugsure.test/c/AK-SNY-01:2')).toMatchObject({ kind: 'connector', connector: { connectorNo: 2 } });
  expect(await api.links.resolve('ID*GEN*E7001')).toMatchObject({ kind: 'partner_evse', partner: { evseUid: 'EVSE-1' } });
  expect(await api.links.resolve('https://go.plugsure.test/s/00000000-0000-4000-8000-000000000004')).toEqual({ kind: 'site', siteId: '00000000-0000-4000-8000-000000000004' });
  expect(await api.links.resolve('NOPE-123')).toBeNull();
});
