/**
 * "Save QR" on Android 8–9 (API 26–28): adding an image to the gallery needs WRITE_EXTERNAL_STORAGE there; from
 * Android 10 it needs nothing. Declared with android:maxSdkVersion="28" (Google Play allows this; READ_MEDIA_* stay
 * blocked — the app never reads the gallery). Replaces any declaration without the limit (and the blocked one).
 */
const { withAndroidManifest } = require('expo/config-plugins');

const WRITE = 'android.permission.WRITE_EXTERNAL_STORAGE';

function setWriteUpTo28(manifest) {
  const m = manifest.manifest;
  m.$ = m.$ || {};
  m.$['xmlns:tools'] = m.$['xmlns:tools'] || 'http://schemas.android.com/tools';
  const list = (m['uses-permission'] || []).filter((p) => p.$['android:name'] !== WRITE);
  list.push({ $: { 'android:name': WRITE, 'android:maxSdkVersion': '28', 'tools:replace': 'android:maxSdkVersion' } });
  m['uses-permission'] = list;
  return manifest;
}

function withSaveQrPermission(config) {
  return withAndroidManifest(config, (c) => {
    c.modResults = setWriteUpTo28(c.modResults);
    return c;
  });
}

module.exports = withSaveQrPermission;
module.exports.setWriteUpTo28 = setWriteUpTo28;
