#!/usr/bin/env node
/**
 * CI check of the native projects that `expo prebuild` generates (no Xcode / Android SDK needed):
 *
 *   node plugins/verify-prebuild.js <project dir with ios/ and/or android/> [--platform ios|android]
 *
 * Asserts what the config plugins promise, so a plugin / Expo upgrade that silently drops one fails the build:
 *   iOS     — widget extension Info.plist complete (CFBundle* keys, XPC!) and versioned like the app; deployment
 *             target ≥ 16.4 everywhere; iPhone only; no UIBackgroundModes; no Face ID string; an accurate motion
 *             string; no App Group; privacy manifest data types.
 *   Android — WRITE_EXTERNAL_STORAGE capped at API 29 (+ requestLegacyExternalStorage); expo-location's
 *             LocationTaskService removed; App Links (autoVerify) with exact /paid and /app/ prefix; compile SDK 36.
 * Real compilation still needs macOS / Android SDK runners (EAS Build).
 */
const fs = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;

const MIN_IOS = '16.4';
const root = path.resolve(process.argv[2] || '.');
const only = process.argv.includes('--platform') ? process.argv[process.argv.indexOf('--platform') + 1] : null;
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const versionGte = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return true;
};
const unq = (v) => String(v).trim().replace(/^"(.*)"$/, '$1');

function verifyIos() {
  const appDir = fs.readdirSync(path.join(root, 'ios')).find((d) => exists(`ios/${d}/AppDelegate.swift`));
  check(appDir, 'ios: app target folder not found');
  if (!appDir) return;
  const info = plist.parse(read(`ios/${appDir}/Info.plist`));
  check(!('UIBackgroundModes' in info), `ios: UIBackgroundModes must be absent (got ${JSON.stringify(info.UIBackgroundModes)})`);
  check(!('NSFaceIDUsageDescription' in info), 'ios: NSFaceIDUsageDescription must be absent (no biometric feature)');
  check(info.NSMotionUsageDescription && !/detect your current motion activity/.test(info.NSMotionUsageDescription), 'ios: NSMotionUsageDescription must be the app\'s own string');
  check(info.NSSupportsLiveActivities === true, 'ios: NSSupportsLiveActivities missing');

  const ent = plist.parse(read(`ios/${appDir}/${appDir}.entitlements`));
  check(!('com.apple.security.application-groups' in ent), 'ios: app entitlements must not declare an App Group');

  const privacy = read(`ios/${appDir}/PrivacyInfo.xcprivacy`);
  for (const t of ['NSPrivacyCollectedDataTypeOtherUserContent', 'NSPrivacyCollectedDataTypeCustomerSupport']) check(privacy.includes(t), `ios: privacy manifest lacks ${t}`);

  const pods = JSON.parse(read('ios/Podfile.properties.json'));
  check(versionGte(pods['ios.deploymentTarget'], MIN_IOS), `ios: Podfile ios.deploymentTarget ${pods['ios.deploymentTarget']} < ${MIN_IOS}`);

  const pbxDir = fs.readdirSync(path.join(root, 'ios')).find((d) => d.endsWith('.xcodeproj'));
  const pbx = read(`ios/${pbxDir}/project.pbxproj`);
  const targets = [...pbx.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/g)].map((m) => unq(m[1]));
  check(targets.length > 0, 'ios: no IPHONEOS_DEPLOYMENT_TARGET in project.pbxproj');
  for (const t of targets) check(versionGte(t, MIN_IOS), `ios: IPHONEOS_DEPLOYMENT_TARGET ${t} < ${MIN_IOS}`);

  // Build configurations by INFOPLIST_FILE: the app's and the widget's.
  const configs = [...pbx.matchAll(/buildSettings = \{([\s\S]*?)\n\t\t\t\};/g)].map((m) => {
    const s = {};
    for (const l of m[1].matchAll(/^\s*([A-Z_]+) = ([^;]+);/gm)) s[l[1]] = unq(l[2]);
    return s;
  });
  const appConfigs = configs.filter((s) => s.INFOPLIST_FILE === `${appDir}/Info.plist`);
  check(appConfigs.length > 0, 'ios: app build configurations not found');
  for (const s of appConfigs) check(s.TARGETED_DEVICE_FAMILY === '1', `ios: app TARGETED_DEVICE_FAMILY must be "1" (iPhone only), got ${s.TARGETED_DEVICE_FAMILY}`);

  if (!exists('ios/ChargingWidgets/Info.plist')) {
    check(false, 'ios: ios/ChargingWidgets/Info.plist missing (widget extension)');
    return;
  }
  const w = plist.parse(read('ios/ChargingWidgets/Info.plist'));
  const want = {
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleExecutable: '$(EXECUTABLE_NAME)',
    CFBundlePackageType: 'XPC!',
    CFBundleShortVersionString: '$(MARKETING_VERSION)',
    CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
    CFBundleName: '$(PRODUCT_NAME)',
  };
  for (const [k, v] of Object.entries(want)) check(w[k] === v, `ios: widget Info.plist ${k} must be ${v} (got ${w[k]})`);
  check(w.CFBundleDisplayName, 'ios: widget Info.plist CFBundleDisplayName missing');
  check(w.NSExtension && w.NSExtension.NSExtensionPointIdentifier === 'com.apple.widgetkit-extension', 'ios: widget NSExtensionPointIdentifier');
  const widget = configs.filter((s) => s.INFOPLIST_FILE === 'ChargingWidgets/Info.plist');
  check(widget.length === 2, `ios: expected Debug + Release widget configurations, got ${widget.length}`);
  for (const s of widget) {
    check(s.GENERATE_INFOPLIST_FILE === 'NO', 'ios: widget GENERATE_INFOPLIST_FILE must be NO (its Info.plist is complete)');
    check(s.MARKETING_VERSION === String(info.CFBundleShortVersionString), `ios: widget MARKETING_VERSION ${s.MARKETING_VERSION} ≠ app ${info.CFBundleShortVersionString}`);
    check(s.CURRENT_PROJECT_VERSION === String(info.CFBundleVersion), `ios: widget CURRENT_PROJECT_VERSION ${s.CURRENT_PROJECT_VERSION} ≠ app ${info.CFBundleVersion}`);
    check(!s.CODE_SIGN_ENTITLEMENTS, 'ios: widget must not carry entitlements (no App Group)');
    check(/\.ChargingWidgets$/.test(s.PRODUCT_BUNDLE_IDENTIFIER || ''), `ios: widget bundle id ${s.PRODUCT_BUNDLE_IDENTIFIER}`);
  }
}

function verifyAndroid() {
  const m = read('android/app/src/main/AndroidManifest.xml');
  check(/<uses-permission android:name="android\.permission\.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29"/.test(m), 'android: WRITE_EXTERNAL_STORAGE must have maxSdkVersion="29"');
  check(/android:requestLegacyExternalStorage="true"/.test(m), 'android: requestLegacyExternalStorage="true" missing (expo-media-library on API 29)');
  check(/<service android:name="expo\.modules\.location\.services\.LocationTaskService" tools:node="remove"\/>/.test(m), 'android: expo-location LocationTaskService must be removed (tools:node="remove")');
  check(!m.includes('asia.plugsure.live_session_channel'), 'android: unused live_session_channel meta-data');
  check(m.includes('android.permission.POST_PROMOTED_NOTIFICATIONS'), 'android: POST_PROMOTED_NOTIFICATIONS missing');
  const filter = (m.match(/<intent-filter android:autoVerify="true"[\s\S]*?<\/intent-filter>/) || [''])[0];
  check(filter, 'android: App Links intent filter (autoVerify) missing');
  for (const p of ['android:pathPrefix="/c/"', 'android:pathPrefix="/s/"', 'android:pathPrefix="/r/"', 'android:path="/paid"', 'android:pathPrefix="/app/"']) check(filter.includes(p), `android: App Links lacks ${p}`);
  check(!/android:pathPrefix="\/(paid|app)"/.test(filter), 'android: App Links must not use the loose /paid or /app prefixes');
  const props = read('android/gradle.properties');
  check(/^android\.compileSdkVersion=36$/m.test(props), 'android: compileSdkVersion must be 36 (modules/live-update targets API 36.0)');
}

if (only !== 'android') verifyIos();
if (only !== 'ios') verifyAndroid();
if (failures.length) {
  console.error(`prebuild verification failed (${failures.length}):\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`prebuild verification OK (${only || 'ios + android'})`);
