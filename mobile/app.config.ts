/**
 * Expo app config, resolved per white-label variant and environment.
 *
 *   APP_VARIANT   brand file in ./brands (default: plugsure)
 *   APP_ENV       development | preview | production (default: development) — set by eas.json profiles
 *   API_BASE_URL  overrides the brand's API host (staging, a local backend, or `mock` for the built-in demo data)
 *   EAS_PROJECT_ID, APPLE_TEAM_ID, GOOGLE_MAPS_ANDROID_KEY, GOOGLE_SERVICES_JSON (EAS file secret path)
 *   EXPO_PUBLIC_SENTRY_DSN (+ SENTRY_ORG / SENTRY_PROJECT / SENTRY_AUTH_TOKEN for source maps): crash reporting, off when unset
 *   EXPO_PUBLIC_GOOGLE_PLACES_KEY: place search through Google Places (off when unset: station search only)
 *
 * Everything the JS needs at runtime goes into `extra` (read by src/config.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import type { Brand } from './brands/brand';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateBrand } = require('./brands/validate.js') as { validateBrand: (b: unknown, file?: string) => Brand };

const variant = (process.env.APP_VARIANT ?? 'plugsure').trim();
const appEnv = (process.env.APP_ENV ?? 'development') as 'development' | 'preview' | 'production';
const brandFile = path.join(__dirname, 'brands', `${variant}.json`);
if (!fs.existsSync(brandFile)) throw new Error(`APP_VARIANT=${variant}: brands/${variant}.json not found`);
const brand: Brand = validateBrand(JSON.parse(fs.readFileSync(brandFile, 'utf8')), `brands/${variant}.json`);

const asset = (file: string) => {
  const own = `./brands/${variant}/${file}`;
  return fs.existsSync(path.join(__dirname, own)) ? own : `./brands/plugsure/${file}`;
};

// Development and preview builds install next to the store app.
const idSuffix = appEnv === 'production' ? '' : appEnv === 'preview' ? '.preview' : '.dev';
const nameSuffix = appEnv === 'production' ? '' : appEnv === 'preview' ? ' (Preview)' : ' (Dev)';
const apiBase = process.env.API_BASE_URL?.trim() || brand.apiBase;
const easProjectId = process.env.EAS_PROJECT_ID?.trim() || brand.easProjectId;
const appleTeamId = process.env.APPLE_TEAM_ID?.trim() || brand.appleTeamId || undefined;

// Firebase (Android FCM tokens). EAS: upload as a file secret and point GOOGLE_SERVICES_JSON at it.
const googleServicesFile =
  process.env.GOOGLE_SERVICES_JSON ??
  (fs.existsSync(path.join(__dirname, `brands/${variant}/google-services.json`)) ? `./brands/${variant}/google-services.json` : undefined);
// iOS only needs GoogleService-Info.plist if Firebase SDKs are added; push uses APNs device tokens directly.
const googleServicesPlist =
  process.env.GOOGLE_SERVICES_PLIST ??
  (fs.existsSync(path.join(__dirname, `brands/${variant}/GoogleService-Info.plist`)) ? `./brands/${variant}/GoogleService-Info.plist` : undefined);

const LINK_PATHS = ['/c/', '/s/', '/r/', '/paid', '/app'];

const strings = {
  location: `${brand.appName} uses your location to show chargers near you. It is not stored.`,
  camera: 'To scan the QR code on the charger.',
  faceId: `Unlock ${brand.appName} and confirm payment-method changes.`,
  savePhotos: `${brand.appName} saves the payment QR code to your photos so you can pay with a wallet app on this phone.`,
};
const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim() || '';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: brand.appName + nameSuffix,
  slug: brand.easSlug,
  scheme: brand.scheme,
  version: '1.0.0',
  orientation: 'default',
  icon: asset('icon.png'),
  userInterfaceStyle: 'automatic',
  backgroundColor: '#0a1417',
  runtimeVersion: { policy: 'fingerprint' },
  updates: easProjectId ? { url: `https://u.expo.dev/${easProjectId}`, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 } : { enabled: false },
  assetBundlePatterns: ['**/*'],
  ios: {
    bundleIdentifier: brand.iosBundleId + idSuffix,
    appleTeamId,
    supportsTablet: true,
    deploymentTarget: '16.2',
    associatedDomains: brand.linkHosts.map((h) => `applinks:${h}`),
    googleServicesFile: googleServicesPlist,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: strings.location,
      NSCameraUsageDescription: strings.camera,
      // Only when the brand ships the Live Activity widget (plugins/withLiveActivity adds the same keys).
      ...(brand.features.liveActivities ? { NSSupportsLiveActivities: true, NSSupportsLiveActivitiesFrequentUpdates: true } : {}),
      CFBundleAllowMixedLocalizations: true,
      CFBundleLocalizations: brand.locales.map((l) => (l === 'zh' ? 'zh-Hans' : l)),
      LSApplicationQueriesSchemes: ['comgooglemaps', 'waze', 'gojek', 'ovo', 'dana', 'shopeeid', 'linkaja', 'grab'],
      ITSAppUsesNonExemptEncryption: false,
    },
    entitlements: {
      'aps-environment': appEnv === 'production' ? 'production' : 'development',
    },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyAccessedAPITypes: [
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1'] },
      ],
      NSPrivacyCollectedDataTypes: [
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePhoneNumber', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeName', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePreciseLocation', NSPrivacyCollectedDataTypeLinked: false, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePurchaseHistory', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID', NSPrivacyCollectedDataTypeLinked: true, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
        { NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeCrashData', NSPrivacyCollectedDataTypeLinked: false, NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'] },
      ],
    },
  },
  android: {
    package: brand.androidPackage + idSuffix,
    // No Android auto-backup: the device token, the cached stations and the pending checkout belong to this phone; a
    // restore to another phone would carry a revocable token and stale state (the account itself lives on the server).
    allowBackup: false,
    googleServicesFile,
    adaptiveIcon: {
      foregroundImage: asset('adaptive-foreground.png'),
      monochromeImage: asset('adaptive-monochrome.png'),
      backgroundColor: brand.badgeColor,
    },
    predictiveBackGestureEnabled: true,
    permissions: [
      'android.permission.CAMERA',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.VIBRATE',
    ],
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
      // "Save QR" only adds an image (write-only: no permission on Android 10+); the app never reads the gallery
      // (Google Play's photo and video permissions policy).
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      'android.permission.ACCESS_MEDIA_LOCATION',
    ],
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        category: ['BROWSABLE', 'DEFAULT'],
        data: brand.linkHosts.flatMap((host) => LINK_PATHS.map((pathPrefix) => ({ scheme: 'https', host, pathPrefix }))),
      },
    ],
  },
  web: {
    bundler: 'metro',
    output: 'single',
    favicon: asset('favicon.png'),
    name: brand.appName,
    shortName: brand.shortName,
    themeColor: '#0a1417',
    backgroundColor: '#0a1417',
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        image: asset('splash.png'),
        imageWidth: 180,
        resizeMode: 'contain',
        backgroundColor: '#f2f6f5',
        dark: { image: asset('splash.png'), backgroundColor: '#0a1417' },
      },
    ],
    ['expo-camera', { cameraPermission: strings.camera, microphonePermission: false, recordAudioAndroid: false, barcodeScannerEnabled: true }],
    [
      'expo-location',
      {
        locationWhenInUsePermission: strings.location,
        locationAlwaysAndWhenInUsePermission: false,
        locationAlwaysPermission: false,
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
    [
      'expo-notifications',
      { icon: asset('notification-icon.png'), color: brand.accentColor, defaultChannel: 'charging', enableBackgroundRemoteNotifications: true },
    ],
    ['expo-secure-store', { faceIDPermission: strings.faceId, configureAndroidBackup: false }],
    ['expo-build-properties', { android: { compileSdkVersion: 36, targetSdkVersion: 36, minSdkVersion: 26 } }],
    ['react-native-maps', { androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_ANDROID_KEY ?? '' }],
    'expo-localization',
    'expo-web-browser',
    [
      'expo-media-library',
      {
        // "Save QR" only adds the payment QR to the photo library (write-only); the app never reads photos.
        photosPermission: false,
        savePhotosPermission: strings.savePhotos,
        isAccessMediaLocationEnabled: false,
        granularPermissions: ['photo'],
      },
    ],
    // Crash reporting only when a DSN is configured (off otherwise: no SDK init, no upload step).
    ...(sentryDsn ? [['@sentry/react-native/expo', { organization: process.env.SENTRY_ORG, project: process.env.SENTRY_PROJECT, url: process.env.SENTRY_URL }] as [string, object]] : []),
    ['./plugins/withLiveActivity', { enabled: brand.features.liveActivities, appGroup: `group.${brand.iosBundleId}` }],
    ['./plugins/withAndroidLiveSession', { channelId: 'live-session' }],
    './plugins/withSaveQrPermission',
  ],
  experiments: { typedRoutes: true },
  extra: {
    variant,
    appEnv,
    apiBase,
    brand: { ...brand, apiBase },
    router: {},
    eas: easProjectId ? { projectId: easProjectId } : undefined,
  },
});
