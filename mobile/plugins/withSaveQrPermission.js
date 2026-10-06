/**
 * "Save QR" on Android 8–10 (API 26–29): expo-media-library adds an image to the gallery through the legacy
 * external-storage path below API 30, which needs WRITE_EXTERNAL_STORAGE (on API 29 together with
 * android:requestLegacyExternalStorage="true", set by the expo-media-library plugin). From Android 11 (API 30) adding
 * to MediaStore needs no permission. Declared with android:maxSdkVersion="29" (READ_MEDIA_* stay blocked — the app
 * never reads the gallery). Replaces any declaration without the limit (and the blocked one).
 */
const { withAndroidManifest } = require('expo/config-plugins');

const WRITE = 'android.permission.WRITE_EXTERNAL_STORAGE';
const MAX_SDK = 29;

function setWriteMaxSdk(manifest, maxSdk = MAX_SDK) {
  const m = manifest.manifest;
  m.$ = m.$ || {};
  m.$['xmlns:tools'] = m.$['xmlns:tools'] || 'http://schemas.android.com/tools';
  const list = (m['uses-permission'] || []).filter((p) => p.$['android:name'] !== WRITE);
  list.push({ $: { 'android:name': WRITE, 'android:maxSdkVersion': String(maxSdk), 'tools:replace': 'android:maxSdkVersion' } });
  m['uses-permission'] = list;
  return manifest;
}

function withSaveQrPermission(config) {
  return withAndroidManifest(config, (c) => {
    c.modResults = setWriteMaxSdk(c.modResults);
    return c;
  });
}

module.exports = withSaveQrPermission;
module.exports.setWriteMaxSdk = setWriteMaxSdk;
module.exports.MAX_SDK = MAX_SDK;
/** @deprecated the old API-28 cap (kept only until src/lib/__tests__/mobileContract.test.ts moves to setWriteMaxSdk). */
module.exports.setWriteUpTo28 = (manifest) => setWriteMaxSdk(manifest, 28);
