/**
 * Native code paths that cannot run in this environment (no device / no store builds), exercised with mocks:
 * push registration (APNs vs FCM), the Android ongoing notification, the Live Activity bridge, directions.
 */
import { Platform } from 'react-native';

jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 6, DEFAULT: 5, LOW: 4 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  AndroidNotificationPriority: { LOW: 'low' },
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => 'live-session'),
  dismissNotificationAsync: jest.fn(async () => {}),
  setNotificationHandler: jest.fn(),
}));

const mockPush = { registerApns: jest.fn(), registerFcm: jest.fn(), removeApns: jest.fn(), removeFcm: jest.fn(), registerLiveSession: jest.fn(async () => 'registered'), liveSessionEnded: jest.fn(async () => {}) };
jest.mock('@/api/client', () => ({ api: { push: mockPush }, runtime: { token: null, lang: 'en', onUnauthorized: () => {} } }));

const setOS = (os: 'ios' | 'android') => Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
/** A fresh liveSession module (native modules are looked up at load) on `os`. */
function loadLive(os: 'ios' | 'android'): typeof import('../liveSession') {
  setOS(os);
  let mod: typeof import('../liveSession') | undefined;
  jest.isolateModules(() => {
    Object.defineProperty(require('react-native').Platform, 'OS', { get: () => os, configurable: true });
    mod = require('../liveSession');
  });
  return mod!;
}

const snapshot = {
  energyKwh: 12.345, powerKw: 58.2, socPercent: 64, costMinor: 1534, limitMinor: 2000, currency: 'SGD', progressPct: 40, startedAt: '2026-10-04T10:00:00.000Z',
  durationMin: 12, siteName: 'Marina Link', connectorLabel: 'DC 150 kW', operator: null, problem: null, refundMinor: null, receiptRef: null, costFinal: false,
};

beforeEach(() => jest.clearAllMocks());

describe('push registration — native tokens, backend owns delivery', () => {
  it('iOS: APNs device token → POST /push/apns', async () => {
    setOS('ios');
    const N = require('expo-notifications');
    N.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    N.requestPermissionsAsync.mockResolvedValue({ granted: true });
    N.getDevicePushTokenAsync.mockResolvedValue({ type: 'ios', data: 'apns-hex' });
    mockPush.registerApns.mockResolvedValue('needs_brand');
    const { registerForPush } = require('../notifications');
    expect(await registerForPush('id')).toBe('needs_brand');
    expect(mockPush.registerApns).toHaveBeenCalledWith('apns-hex', 'id');
    expect(mockPush.registerFcm).not.toHaveBeenCalled();
  });
  it('Android: FCM token → POST /push/fcm {token, lang} (§15.6)', async () => {
    setOS('android');
    const N = require('expo-notifications');
    N.getPermissionsAsync.mockResolvedValue({ granted: true });
    N.getDevicePushTokenAsync.mockResolvedValue({ type: 'android', data: 'fcm-token' });
    mockPush.registerFcm.mockResolvedValue('registered');
    const { registerForPush } = require('../notifications');
    expect(await registerForPush('en')).toBe('registered');
    expect(mockPush.registerFcm).toHaveBeenCalledWith('fcm-token', 'en');
  });
  it('denied permission never asks the server', async () => {
    setOS('ios');
    const N = require('expo-notifications');
    N.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    const { registerForPush } = require('../notifications');
    expect(await registerForPush('en')).toBe('denied');
    expect(N.getDevicePushTokenAsync).not.toHaveBeenCalled();
  });
  it('creates the Android notification channels (live-session is quiet)', async () => {
    setOS('android');
    const N = require('expo-notifications');
    const { setupNotificationChannels } = require('../notifications');
    await setupNotificationChannels();
    const ids = N.setNotificationChannelAsync.mock.calls.map((c: unknown[]) => c[0]);
    expect(ids).toEqual(['charging', 'payments', 'reservations', 'account', 'promotions', 'live-session']);
    const live = N.setNotificationChannelAsync.mock.calls.find((c: unknown[]) => c[0] === 'live-session')[1];
    expect(live).toMatchObject({ importance: 4, enableVibrate: false });
  });
  it('reads the deep link a tapped notification carries', () => {
    const { urlFromNotification } = require('../notifications');
    expect(urlFromNotification({ request: { content: { data: { url: 'https://go.plugsure.asia/r/charge/x' } } } })).toBe('https://go.plugsure.asia/r/charge/x');
    expect(urlFromNotification({ request: { content: { data: {} } } })).toBeNull();
  });
});

describe('live session on the lock screen', () => {
  it('iOS content-state version 2 (§15.7): costs in minor units of `currency`, which is always present', () => {
    const { contentState } = require('../liveSession');
    expect(contentState(snapshot, false)).toEqual({
      status: 'charging', energyWh: 12345, powerW: 58200, socPercent: 64, progressPct: 40, costIdr: null, estimateIdr: 1534,
      startedAt: Date.parse('2026-10-04T10:00:00.000Z') / 1000, endedAt: null, currency: 'SGD',
    });
    const fin = contentState({ ...snapshot, currency: 'IDR', costFinal: true, costMinor: 98640 }, true);
    expect(fin).toMatchObject({ status: 'finished', costIdr: 98640, estimateIdr: null, currency: 'IDR' });
    expect(typeof fin.endedAt).toBe('number');
  });
  it('Android payload: SoC drives the progress bar and the status-bar chip; unknown → indeterminate', () => {
    const { liveUpdatePayload } = require('../liveSession');
    const labels = { title: 'Charging at Marina Link', body: '12.35 kWh' };
    expect(liveUpdatePayload('c1', 'charge', snapshot, labels, false)).toEqual({
      title: 'Charging at Marina Link', text: '12.35 kWh', shortText: '64%', progress: 64, progressMax: 100, indeterminate: false, ongoing: true, url: 'plugsure://session/charge/c1',
    });
    const none = liveUpdatePayload('r1', 'roaming', { ...snapshot, socPercent: null, progressPct: null }, labels, false);
    expect(none).toMatchObject({ shortText: '12.3 kWh', progress: 0, indeterminate: true, url: 'plugsure://session/roaming/r1' });
    expect(liveUpdatePayload('c1', 'charge', snapshot, labels, true)).toMatchObject({ ongoing: false, indeterminate: false });
  });
  it('Android without the Live Update module: a sticky notification, registered once per ref for FCM updates', async () => {
    setOS('android');
    const N = require('expo-notifications');
    const storage = require('@/lib/storage');
    await storage.kv.set(storage.KEYS.pushToken, { platform: 'android', token: 'fcm-token' });
    let mod: typeof import('../liveSession') | undefined;
    jest.isolateModules(() => {
      mod = require('../liveSession');
    });
    const labels = { title: 'Charging at Marina Link', body: '12.35 kWh', appName: 'PlugSure', accentHex: '#2fd6a7' };
    await mod!.showLiveSession('c1', 'charge', snapshot, labels);
    await mod!.showLiveSession('c1', 'charge', snapshot, labels);
    expect(N.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'live-session',
      content: expect.objectContaining({ title: 'Charging at Marina Link', sticky: true, autoDismiss: false, data: { url: '/session/charge/c1' } }),
      trigger: { channelId: 'live-session' },
    });
    expect(mockPush.registerLiveSession).toHaveBeenCalledTimes(1);
    expect(mockPush.registerLiveSession).toHaveBeenCalledWith('android', 'c1', 'fcm-token');
    await mod!.showLiveSession('c1', 'charge', snapshot, { title: '', body: '', appName: '', accentHex: '' }, true);
    expect(N.dismissNotificationAsync).toHaveBeenCalledWith('live-session');
    expect(mockPush.liveSessionEnded).toHaveBeenCalledWith('c1');
  });
  it('Android with the Live Update module (ProgressStyle): show / end per ref', async () => {
    setOS('android');
    const native = { isSupported: jest.fn(() => true), isProgressStyle: jest.fn(() => true), show: jest.fn(), end: jest.fn() };
    jest.doMock('expo', () => ({ requireOptionalNativeModule: (name: string) => (name === 'PlugSureLiveUpdate' ? native : null) }));
    const mod = loadLive('android');
    const N = require('expo-notifications');
    const labels = { title: 'Charging', body: '12.35 kWh', appName: 'PlugSure', accentHex: '#2fd6a7' };
    await mod!.showLiveSession('c2', 'charge', snapshot, labels);
    expect(native.show).toHaveBeenCalledWith('c2', expect.objectContaining({ progress: 64, shortText: '64%', ongoing: true }));
    expect(N.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(mod!.liveUpdatesAvailable()).toBe(true);
    await mod!.showLiveSession('c2', 'charge', snapshot, labels, true);
    expect(native.end).toHaveBeenCalledWith('c2');
    jest.dontMock('expo');
  });
  it('FCM live_session data messages (all strings, empty = unknown) drive the ongoing notification', () => {
    setOS('android');
    const native = { isSupported: () => true, isProgressStyle: () => true, show: jest.fn(), end: jest.fn() };
    jest.doMock('expo', () => ({ requireOptionalNativeModule: (name: string) => (name === 'PlugSureLiveUpdate' ? native : null) }));
    const mod = loadLive('android');
    const msg = {
      type: 'live_session', event: 'update', ref: 'c3', path: 'direct', status: 'charging', energyWh: '6000', powerW: '45000', socPercent: '44', progressPct: '',
      costMinor: '', estimateMinor: '18250', currency: 'IDR', progress: '44', progressMax: '100', progressIndeterminate: '0', ongoing: '1', site: 'Summarecon Mall Bekasi',
    };
    expect(mod!.handleLiveSessionData(msg, 'en')).toBe(true);
    expect(native.show).toHaveBeenCalledWith('c3', {
      title: 'Summarecon Mall Bekasi', text: expect.stringMatching(/^6\.00 kWh · 45 kW · Rp\s?18,250$/), shortText: '44%', progress: 44, progressMax: 100, indeterminate: false, ongoing: true, url: 'plugsure://session/charge/c3',
    });
    mod!.handleLiveSessionData({ ...msg, event: 'end', status: 'finished', ongoing: '0' });
    expect(native.end).toHaveBeenCalledWith('c3');
    expect(mod!.handleLiveSessionData({ type: 'session.ended', ref: 'c3' })).toBe(false);
    jest.dontMock('expo');
  });
  it('session.started push → registers the live session for that charge (Android push-to-start)', async () => {
    setOS('android');
    const storage = require('@/lib/storage');
    await storage.kv.set(storage.KEYS.pushToken, { platform: 'android', token: 'fcm-token' });
    let mod: typeof import('../liveSession') | undefined;
    jest.isolateModules(() => {
      mod = require('../liveSession');
    });
    expect(mod!.handleLiveSessionData({ type: 'session.started', ref: 'c4' })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockPush.registerLiveSession).toHaveBeenCalledWith('android', 'c4', 'fcm-token');
  });
  it('iOS: starts, updates and ends the Live Activity through the native module; tokens registered as v2', async () => {
    setOS('ios');
    let emit: ((e: { activityId: string; token: string }) => void) | null = null;
    const native = {
      isSupported: jest.fn(() => true), start: jest.fn(async () => 'act-1'), update: jest.fn(async () => {}), end: jest.fn(async () => {}),
      addListener: jest.fn((_: string, fn: (e: { activityId: string; token: string }) => void) => ((emit = fn), { remove: jest.fn() })),
    };
    jest.doMock('expo', () => ({ requireOptionalNativeModule: (name: string) => (name === 'PlugSureLiveActivity' ? native : null) }));
    let mod: typeof import('../liveSession') | undefined;
    jest.isolateModules(() => {
      mod = require('../liveSession');
    });
    const stop = mod!.watchLiveActivityTokens();
    const labels = { title: 't', body: 'b', appName: 'PlugSure', accentHex: '#2fd6a7' };
    await mod!.showLiveSession('c9', 'charge', snapshot, labels);
    expect(native.start).toHaveBeenCalledWith({ ref: 'c9', site: 'Marina Link', connector: 'DC 150 kW', appName: 'PlugSure', accentHex: '#2fd6a7' }, expect.objectContaining({ status: 'charging', currency: 'SGD' }));
    emit!({ activityId: 'act-1', token: 'hex-token' });
    expect(mockPush.registerLiveSession).toHaveBeenCalledWith('ios', 'c9', 'hex-token');
    await mod!.showLiveSession('c9', 'charge', snapshot, labels);
    expect(native.update).toHaveBeenCalledWith('act-1', expect.any(Object), 180);
    await mod!.showLiveSession('c9', 'charge', snapshot, labels, true);
    expect(native.end).toHaveBeenCalledWith('act-1', expect.objectContaining({ status: 'finished' }), 1800);
    expect(mockPush.liveSessionEnded).toHaveBeenCalledWith('c9');
    stop();
    jest.dontMock('expo');
  });
});

describe('directions hand-off', () => {
  it('builds Google / Apple / Waze URLs', () => {
    const { directionsUrl, availableMapsApps } = require('../directions');
    expect(directionsUrl('google', -6.2, 106.8)).toBe('https://www.google.com/maps/dir/?api=1&destination=-6.2,106.8&travelmode=driving');
    expect(directionsUrl('apple', -6.2, 106.8, 'Senayan Hub')).toBe('https://maps.apple.com/?daddr=-6.2,106.8&dirflg=d&q=Senayan%20Hub');
    expect(directionsUrl('waze', 1.29, 103.85)).toBe('https://waze.com/ul?ll=1.29,103.85&navigate=yes');
    setOS('android');
    expect(availableMapsApps()).toEqual(['google', 'waze']);
    setOS('ios');
    expect(availableMapsApps()).toEqual(['apple', 'google', 'waze']);
  });
});

describe('payment return (G11)', () => {
  it('the hosted page opens in an auth session that closes on <scheme>://paid; a failed return is reported', async () => {
    setOS('ios');
    const WB = { openAuthSessionAsync: jest.fn(async () => ({ type: 'success', url: 'plugsure://paid?for=charge&redirect_status=failed' })) };
    jest.doMock('expo-web-browser', () => WB);
    let mod: typeof import('../browser') | undefined;
    jest.isolateModules(() => {
      Object.defineProperty(require('react-native').Platform, 'OS', { get: () => 'ios', configurable: true });
      mod = require('../browser');
    });
    expect(mod!.returnUrl()).toBe('plugsure://paid');
    expect(await mod!.openCheckout('https://pay.example/x')).toEqual({ type: 'returned', url: 'plugsure://paid?for=charge&redirect_status=failed' });
    expect(WB.openAuthSessionAsync).toHaveBeenCalledWith('https://pay.example/x', 'plugsure://paid', expect.any(Object));
    WB.openAuthSessionAsync.mockResolvedValueOnce({ type: 'cancel' } as never);
    expect(await mod!.openCheckout('https://pay.example/y')).toEqual({ type: 'dismissed' });
    jest.dontMock('expo-web-browser');
  });
});
