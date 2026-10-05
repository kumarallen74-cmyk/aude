/** Config plugins (plugins/*.js): the pure manifest / Info.plist / config transforms. CI also prebuilds both platforms. */
const { stripBackgroundModes } = require('../../../plugins/withIosBackgroundModes.js');
const { removeLocationService } = require('../../../plugins/withAndroidLiveSession.js');
const { setWriteMaxSdk } = require('../../../plugins/withSaveQrPermission.js');
const { withEasAppExtension, MIN_DEPLOYMENT_TARGET } = require('../../../plugins/withLiveActivity.js');

describe('config plugins', () => {
  it('iOS: no unused background modes', () => {
    expect(stripBackgroundModes({ UIBackgroundModes: ['fetch', 'remote-notification'] })).toEqual({});
    expect(stripBackgroundModes({ UIBackgroundModes: ['fetch', 'audio'] })).toEqual({ UIBackgroundModes: ['audio'] });
    expect(stripBackgroundModes({ UIBackgroundModes: ['remote-notification'] }, ['remote-notification'])).toEqual({ UIBackgroundModes: ['remote-notification'] });
  });
  it('Android: expo-location LocationTaskService removed at merge', () => {
    const m = removeLocationService({ manifest: { $: {}, application: [{ $: { 'android:name': '.MainApplication' }, 'meta-data': [{ $: { 'android:name': 'asia.plugsure.live_session_channel', 'android:value': 'live-session' } }] }] } });
    const app = m.manifest.application[0];
    expect(app.service).toEqual([{ $: { 'android:name': 'expo.modules.location.services.LocationTaskService', 'tools:node': 'remove' } }]);
    expect(app['meta-data'] ?? []).toEqual([]);
    expect(m.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
  });
  it('Save QR: WRITE_EXTERNAL_STORAGE up to API 29 (expo-media-library legacy path below API 30)', () => {
    const m = setWriteMaxSdk({ manifest: { $: {}, 'uses-permission': [{ $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE', 'tools:node': 'remove' } }] } });
    expect(m.manifest['uses-permission']).toEqual([{ $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE', 'android:maxSdkVersion': '29', 'tools:replace': 'android:maxSdkVersion' } }]);
  });
  it('Live Activity: the widget extension is declared to EAS once (credentials, version sync)', () => {
    const cfg = { ios: { bundleIdentifier: 'asia.plugsure.hub' }, extra: { eas: { projectId: 'p' } } };
    const once = withEasAppExtension(cfg);
    const twice = withEasAppExtension(once);
    expect(twice.extra.eas).toEqual({
      projectId: 'p',
      build: { experimental: { ios: { appExtensions: [{ targetName: 'ChargingWidgets', bundleIdentifier: 'asia.plugsure.hub.ChargingWidgets', entitlements: {} }] } } },
    });
    expect(MIN_DEPLOYMENT_TARGET).toBe('16.4');
  });
});
