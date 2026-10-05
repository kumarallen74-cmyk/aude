/**
 * iOS: no UIBackgroundModes.
 *
 * expo-task-manager adds `fetch` and expo-notifications' enableBackgroundRemoteNotifications adds
 * `remote-notification`, but nothing on iOS runs in the background: the only background task
 * (src/native/backgroundTasks.ts, FCM data messages) is Android-only, server pushes to iOS are visible APNs alerts
 * (the badge is set in `aps`), and Live Activity updates are delivered to ActivityKit by the system (push type
 * liveactivity), not to the app. Declaring unused modes is an App Review rejection risk (Guideline 2.5.4).
 *
 * Runs as the last Info.plist step (`withFinalizedMod` cannot see modResults; this plugin is listed last in
 * app.config.ts and removes the modes whatever plugin added them before it). Pass { keep: ['…'] } to keep some.
 */
const { withInfoPlist } = require('expo/config-plugins');

const REMOVE = ['fetch', 'remote-notification'];

function stripBackgroundModes(infoPlist, keep = []) {
  const modes = Array.isArray(infoPlist.UIBackgroundModes) ? infoPlist.UIBackgroundModes : [];
  const left = modes.filter((m) => !REMOVE.includes(m) || keep.includes(m));
  if (left.length) infoPlist.UIBackgroundModes = left;
  else delete infoPlist.UIBackgroundModes;
  return infoPlist;
}

function withIosBackgroundModes(config, props = {}) {
  return withInfoPlist(config, (c) => {
    c.modResults = stripBackgroundModes(c.modResults, props.keep || []);
    return c;
  });
}

module.exports = withIosBackgroundModes;
module.exports.stripBackgroundModes = stripBackgroundModes;
