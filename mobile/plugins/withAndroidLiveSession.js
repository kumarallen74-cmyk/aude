/**
 * Android live charging session — config plugin.
 *
 *   - android.permission.POST_PROMOTED_NOTIFICATIONS: Android 16 "Live Updates" (promoted ongoing notifications,
 *     Notification.ProgressStyle) — https://developer.android.com/about/versions/16/features/progress-centric-notifications
 *   - removes expo-location's merged `LocationTaskService` (foregroundServiceType="location"): the app only reads the
 *     location while in use (no background location, no foreground service), and an unused location foreground
 *     service is a Play policy declaration we do not want to make.
 *
 * The notification itself is posted by the local Kotlin module `modules/live-update` (autolinked;
 * Notification.ProgressStyle + the promoted-ongoing request on Android 16, a progress notification before), on the
 * `live-session` channel (created by the module and by src/native/notifications.ts setupNotificationChannels), driven
 * by src/native/liveSession.ts — from the session screen while the app runs and from FCM `live_session` /
 * `session.started` data messages (§15.7) in the background task. Without the module (Expo Go) the JS falls back to a
 * sticky expo-notifications one.
 */
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const LOCATION_SERVICE = 'expo.modules.location.services.LocationTaskService';

function removeLocationService(manifest) {
  const m = manifest.manifest;
  m.$ = m.$ || {};
  m.$['xmlns:tools'] = m.$['xmlns:tools'] || 'http://schemas.android.com/tools';
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const services = (app.service || []).filter((s) => s.$['android:name'] !== LOCATION_SERVICE);
  services.push({ $: { 'android:name': LOCATION_SERVICE, 'tools:node': 'remove' } });
  app.service = services;
  // Earlier versions declared an unused channel meta-data; drop it if a stale manifest still has it.
  AndroidConfig.Manifest.removeMetaDataItemFromMainApplication(app, 'asia.plugsure.live_session_channel');
  return manifest;
}

function withAndroidLiveSession(config) {
  config = AndroidConfig.Permissions.withPermissions(config, ['android.permission.POST_PROMOTED_NOTIFICATIONS']);
  config = withAndroidManifest(config, (c) => {
    c.modResults = removeLocationService(c.modResults);
    return c;
  });
  return config;
}

module.exports = withAndroidLiveSession;
module.exports.removeLocationService = removeLocationService;
