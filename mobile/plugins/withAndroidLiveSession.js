/**
 * Android live charging session — config plugin.
 *
 *   - android.permission.POST_PROMOTED_NOTIFICATIONS: Android 16 "Live Updates" (promoted ongoing notifications,
 *     Notification.ProgressStyle) — https://developer.android.com/about/versions/16/features/progress-centric-notifications
 *   - default FCM channel meta-data for session data messages (channel `live-session`, created at runtime by
 *     src/native/notifications.ts setupNotificationChannels).
 *
 * The notification itself is posted by the local Kotlin module `modules/live-update` (autolinked;
 * Notification.ProgressStyle + requestPromotedOngoing on Android 16, a progress notification before), driven by
 * src/native/liveSession.ts — from the session screen while the app runs and from FCM `live_session` data messages
 * (§15.7) in the background task. Without the module (Expo Go) the JS falls back to a sticky expo-notifications one.
 */
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

function withAndroidLiveSession(config, props = {}) {
  const channelId = props.channelId || 'live-session';
  config = AndroidConfig.Permissions.withPermissions(config, ['android.permission.POST_PROMOTED_NOTIFICATIONS']);
  config = withAndroidManifest(config, (c) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(c.modResults);
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, 'asia.plugsure.live_session_channel', channelId);
    return c;
  });
  return config;
}

module.exports = withAndroidLiveSession;
