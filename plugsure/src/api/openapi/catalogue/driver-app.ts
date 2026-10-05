import { type Op, type Schema, ref, arrayOf, nullable, OK } from '../types.js';

const S: Schema = { type: 'string' };
const B: Schema = { type: 'boolean' };
const theme: Schema = {
  type: 'object',
  required: ['accent', 'deep', 'on', 'glow', 'contrast'],
  properties: {
    accent: { type: 'string', description: 'The accent as used: nudged lighter (dark theme) or darker (light theme) until it reads at 4.5:1 or more.' },
    deep: S,
    on: { type: 'string', description: 'Text on a solid accent fill.' },
    glow: S,
    contrast: { type: 'number', description: 'Lowest contrast of the accent against the theme’s surfaces.' },
  },
};

export const schemas: Record<string, Schema> = {
  DriverAppBrand: {
    type: 'object',
    description: 'The operator’s own driver app.',
    required: ['orgId', 'slug', 'status', 'appName', 'shortName', 'accentColor', 'badgeColor', 'hasIcon', 'androidCertSha256', 'versionName', 'versionCode', 'updatedAt'],
    properties: {
      orgId: { type: 'string', format: 'uuid' },
      slug: { type: 'string', description: 'Short name used in the preview address and icon paths.', examples: ['nusacharge'] },
      status: { type: 'string', enum: ['draft', 'live'], description: 'Live: served on its web address. Draft: preview only.' },
      appName: { type: 'string', maxLength: 30 },
      shortName: { type: 'string', maxLength: 12, description: 'Under the icon on a phone.' },
      taglineId: nullable('string'), taglineEn: nullable('string'),
      descriptionId: nullable('string'), descriptionEn: nullable('string'),
      accentColor: { type: 'string', pattern: '^#[0-9a-f]{6}$' },
      badgeColor: { type: 'string', pattern: '^#[0-9a-f]{6}$', description: 'Behind the icon in maskable and App Store icons.' },
      hasIcon: B,
      iconSha256: nullable('string'),
      supportEmail: nullable('string'), supportPhone: nullable('string'),
      privacyUrl: nullable('string'), termsUrl: nullable('string'),
      hostname: nullable('string', { description: 'The app’s own web address, e.g. app.nusantaracharge.id.' }),
      androidPackage: nullable('string'),
      androidCertSha256: arrayOf({ type: 'string', description: 'SHA-256 signing certificate fingerprint, AA:BB:… form.' }),
      iosBundleId: nullable('string'), iosTeamId: nullable('string'),
      versionName: S, versionCode: { type: 'integer' },
      updatedAt: { type: 'string', format: 'date-time' },
      publishedAt: nullable('string', { format: 'date-time' }),
      apnsKeyId: nullable('string', { description: 'The APNs key’s id (the key itself is never returned).' }),
      apnsConfigured: { type: 'boolean', description: 'An APNs key is stored: the iOS app gets native notifications.' },
      apnsCheckedAt: nullable('string', { format: 'date-time' }),
      apnsCheckOk: nullable('boolean', { description: 'Apple accepted the key, Team ID and bundle identifier at the last check (or refused them while sending).' }),
      apnsCheckDetail: nullable('string'),
      scope: { type: 'string', enum: ['operator', 'network'], description: 'operator: a white-label app limited to this operator’s chargers. network: the PlugSure app itself (PlugSure Mobility), every operator’s chargers.' },
      fcmProjectId: nullable('string', { description: 'Android notifications: the Firebase project of the stored service account.' }),
      fcmClientEmail: nullable('string'),
      fcmConfigured: { type: 'boolean', description: 'A Firebase service account is stored: the Android app gets native notifications (FCM HTTP v1).' },
      fcmCheckedAt: nullable('string', { format: 'date-time' }),
      fcmCheckOk: nullable('boolean'),
      fcmCheckDetail: nullable('string'),
      appConfig: ref('DriverAppConfig'),
    },
  },
  DriverAppConfig: {
    type: 'object',
    description: 'The native apps’ version gate and remote configuration, served to them by GET /d/v1/app/config. Every part is optional.',
    properties: {
      ios: ref('DriverAppRelease'),
      android: ref('DriverAppRelease'),
      maintenance: { type: 'object', properties: { active: B, messageId: { type: 'string', maxLength: 300 }, messageEn: { type: 'string', maxLength: 300 } } },
      features: {
        type: 'object', description: 'Feature switches (absent: the default). A switch cannot turn on what the server does not offer (roaming, reservations).',
        properties: Object.fromEntries(['roaming', 'reservations', 'queue', 'memberships', 'favourites', 'liveActivities', 'accountDeletion', 'applePay', 'googlePay', 'routePlanner'].map((k) => [k, B])),
        additionalProperties: false,
      },
      links: { type: 'object', properties: { support: S, faq: S, status: S } },
    },
  },
  DriverAppRelease: {
    type: 'object',
    properties: {
      minSupported: { type: 'string', pattern: '^\\d{1,3}\\.\\d{1,3}\\.\\d{1,4}$', description: 'Older versions must update before anything else (blocking screen).' },
      latest: { type: 'string', pattern: '^\\d{1,3}\\.\\d{1,3}\\.\\d{1,4}$', description: 'Older versions see a dismissable "update available".' },
      storeUrl: { type: 'string', description: 'https:// store page (Android default: the Play page of the package).' },
    },
  },
  DriverAppView: {
    type: 'object',
    required: ['brand', 'palette', 'checks', 'previewUrl', 'appUrl', 'iconUrls', 'maskableUrl'],
    properties: {
      brand: { anyOf: [ref('DriverAppBrand'), { type: 'null' }], description: 'Null: the operator uses the PlugSure app.' },
      palette: { anyOf: [{ type: 'object', required: ['dark', 'light', 'badge', 'adjusted'], properties: { dark: theme, light: theme, badge: S, adjusted: B } }, { type: 'null' }] },
      checks: arrayOf({
        type: 'object', required: ['key', 'ok', 'label', 'for'],
        properties: { key: S, ok: B, label: S, for: { type: 'string', enum: ['live', 'play', 'appstore', 'recommended'] } },
      }),
      previewUrl: nullable('string'),
      appUrl: nullable('string'),
      iconUrls: { anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'null' }] },
      maskableUrl: nullable('string'),
      dnsTarget: nullable('string', { description: 'Point the web address here (CNAME).' }),
      iosPushDevices: { type: 'integer', description: 'iPhones registered for native notifications.' },
      liveActivities: {
        type: 'object', description: 'iOS Live Activities: charges shown on lock screens now, and iPhones that let PlugSure start one (iOS 17.2+).',
        properties: { active: { type: 'integer' }, pushToStart: { type: 'integer' } },
      },
    },
  },
};

const body: Schema = {
  type: 'object',
  properties: {
    appName: { type: 'string', maxLength: 30 }, shortName: { type: 'string', maxLength: 12 }, slug: S,
    taglineId: S, taglineEn: S, descriptionId: { type: 'string', maxLength: 80 }, descriptionEn: { type: 'string', maxLength: 80 },
    accentColor: S, badgeColor: S, supportEmail: S, supportPhone: S, privacyUrl: S, termsUrl: S, hostname: S,
    androidPackage: S, androidCertSha256: { anyOf: [arrayOf(S), S] }, iosBundleId: S, iosTeamId: S,
    versionName: S, versionCode: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['draft', 'live'] },
  },
};

export const ops: Op[] = [
  {
    method: 'GET', path: '/v1/driver-app', tag: 'Driver app',
    summary: 'The operator’s own driver app',
    description: 'The white-label driver app: its brand, the colours as they are used in both themes, what is still missing to go live and to publish in the stores, and its preview and live addresses.',
    responses: { 200: { description: 'The app', schema: ref('DriverAppView') } },
  },
  {
    method: 'PUT', path: '/v1/driver-app', tag: 'Driver app',
    summary: 'Create or change the driver app',
    description:
      'Fields left out keep their value. The app shows only this operator’s stations. `status: live` needs an icon and a web address, which must point at PlugSure. ' +
      'The version code can only go up (the stores refuse an older one). 409 when another operator uses the web address, package name or bundle identifier, or in a sandbox.',
    body: {
      schema: body,
      example: { appName: 'NusaCharge', taglineId: 'Isi daya di jalan tol', taglineEn: 'Charge on the toll road', accentColor: '#ff8a00', badgeColor: '#12305a', hostname: 'app.nusantaracharge.id', privacyUrl: 'https://nusantaracharge.id/privasi' },
    },
    responses: { 200: { description: 'The app as saved', schema: ref('DriverAppView') } },
    errors: [409, 422],
  },
  {
    method: 'PUT', path: '/v1/driver-app/icon', tag: 'Driver app',
    summary: 'Upload the app icon',
    description: 'A square PNG, 512 to 2048 pixels (1024 is best), up to 2 MB, as base64. The launcher, store, maskable and App Store icons are made from it.',
    body: { schema: { type: 'object', required: ['png'], properties: { png: { type: 'string', description: 'Base64 PNG (a data: URL is accepted).' } } } },
    responses: {
      200: {
        description: 'The app, with what was stored',
        schema: {
          allOf: [ref('DriverAppView'), {
            type: 'object', required: ['icon'],
            properties: { icon: { type: 'object', required: ['width', 'height', 'bytes', 'sha256', 'warnings'], properties: { width: { type: 'integer' }, height: { type: 'integer' }, bytes: { type: 'integer' }, sha256: S, warnings: arrayOf(S) } } },
          }],
        },
      },
    },
    errors: [404, 413, 422],
  },
  {
    method: 'GET', path: '/v1/driver-app/kit', tag: 'Driver app',
    summary: 'Download the store build kit',
    description:
      'A zip with everything to build and list the app: an Android Trusted Web Activity project for Bubblewrap with launcher icons, Digital Asset Links and a CI workflow; ' +
      'an iOS Capacitor shell with the App Store icon, Info.plist and entitlement additions and the app-site association; and store listing texts (Indonesian, English) with data-safety answers. ' +
      'The `x-kit-warnings` header counts what is still missing (listed in the kit’s README).',
    responses: { 200: { description: 'The kit', schema: { type: 'string', format: 'binary' }, contentType: 'application/zip' } },
    errors: [404],
  },
  {
    method: 'PUT', path: '/v1/driver-app/apns', tag: 'Driver app',
    summary: 'Upload the iOS notifications key (APNs)',
    description:
      'The .p8 authentication key from the Apple Developer account (Certificates, Identifiers & Profiles → Keys, with Apple Push Notifications service), and its Key ID. ' +
      'It is stored encrypted, never returned, and checked with Apple at once against the brand’s Team ID and bundle identifier (the result is in pnsCheckOk / pnsCheckDetail). ' +
      '409 until the Team ID and bundle identifier are set.',
    body: { schema: { type: 'object', required: ['keyId', 'p8'], properties: { keyId: { type: 'string', pattern: '^[A-Z0-9]{10}$' }, p8: { type: 'string', description: 'The whole .p8 file (PEM).' } } } },
    responses: { 200: { description: 'The app, with the check’s result', schema: ref('DriverAppView') } },
    errors: [404, 409, 422],
  },
  {
    method: 'POST', path: '/v1/driver-app/apns/check', tag: 'Driver app',
    summary: 'Check the iOS notifications key with Apple again',
    description: 'Asks APNs about a device token that cannot exist: Apple checks the key first, so nobody is notified.',
    responses: { 200: { description: 'The app, with the check’s result', schema: ref('DriverAppView') } },
    errors: [409],
  },
  {
    method: 'DELETE', path: '/v1/driver-app/apns', tag: 'Driver app',
    summary: 'Remove the iOS notifications key',
    description: 'The iOS app stops getting notifications; queued ones fail.',
    responses: { 200: { description: 'Removed', schema: OK } },
    errors: [404],
  },
  {
    method: 'PUT', path: '/v1/driver-app/fcm', tag: 'Driver app',
    summary: 'Upload the Android notifications service account (FCM)',
    description:
      'The Firebase project’s service account key (Firebase console → Project settings → Service accounts → Generate new private key), as the JSON object or its text. ' +
      'It must be the project of the Android app’s google-services.json and hold the “Firebase Cloud Messaging API Admin” role. Stored encrypted, never returned, and checked with Google at once ' +
      '(a validate-only send: nobody is notified; the result is in fcmCheckOk / fcmCheckDetail).',
    body: {
      schema: { type: 'object', required: ['serviceAccount'], properties: { serviceAccount: { anyOf: [{ type: 'object' }, S], description: 'The service account JSON.' } } },
      example: { serviceAccount: { type: 'service_account', project_id: 'plugsure-app', private_key_id: '…', private_key: '-----BEGIN PRIVATE KEY-----\n…', client_email: 'fcm-sender@plugsure-app.iam.gserviceaccount.com', token_uri: 'https://oauth2.googleapis.com/token' } },
    },
    responses: { 200: { description: 'The app, with the check’s result', schema: { allOf: [ref('DriverAppView'), { type: 'object', properties: { androidPushDevices: { type: 'integer' } } }] } } },
    errors: [404, 422],
  },
  {
    method: 'POST', path: '/v1/driver-app/fcm/check', tag: 'Driver app',
    summary: 'Check the Android notifications service account with Google again',
    description: 'A validate-only send to a token that cannot exist: Google checks the service account first, so nobody is notified.',
    responses: { 200: { description: 'The app, with the check’s result', schema: { allOf: [ref('DriverAppView'), { type: 'object', properties: { androidPushDevices: { type: 'integer' } } }] } } },
    errors: [409],
  },
  {
    method: 'DELETE', path: '/v1/driver-app/fcm', tag: 'Driver app',
    summary: 'Remove the Android notifications service account',
    description: 'The Android app stops getting notifications; queued ones fail.',
    responses: { 200: { description: 'Removed', schema: OK } },
    errors: [404],
  },
  {
    method: 'GET', path: '/v1/driver-app/app-config', tag: 'Driver app',
    summary: 'The native apps’ version gate and remote configuration',
    responses: { 200: { description: 'The configuration', schema: { type: 'object', required: ['appConfig'], properties: { appConfig: ref('DriverAppConfig') } } } },
    errors: [404],
  },
  {
    method: 'PUT', path: '/v1/driver-app/app-config', tag: 'Driver app',
    summary: 'Change the native apps’ version gate and remote configuration',
    description:
      'Replaces the whole configuration. Apps below `minSupported` must update (blocking screen); below `latest` they offer an update. ' +
      '`maintenance.active` shows the message (Indonesian / English) instead of the app. 422 with `fields` for a bad version, address or unknown feature.',
    body: {
      schema: ref('DriverAppConfig'),
      example: { ios: { minSupported: '1.0.0', latest: '1.0.3', storeUrl: 'https://apps.apple.com/app/id0000000000' }, android: { minSupported: '1.0.0', latest: '1.0.3' }, maintenance: { active: false }, features: { routePlanner: false } },
    },
    responses: { 200: { description: 'The configuration as saved', schema: { type: 'object', required: ['appConfig'], properties: { appConfig: ref('DriverAppConfig') } } } },
    errors: [404, 422],
  },
  {
    method: 'DELETE', path: '/v1/driver-app', tag: 'Driver app',
    summary: 'Remove the driver app',
    description: 'The operator goes back to the PlugSure app. A live app needs `?confirm=<slug>`: its web address stops serving it and its store apps stop working.',
    query: [{ name: 'confirm', description: 'The slug, to remove a live app.', schema: S }],
    responses: { 200: { description: 'Removed', schema: OK } },
    errors: [404, 409],
  },
];
