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
    method: 'DELETE', path: '/v1/driver-app', tag: 'Driver app',
    summary: 'Remove the driver app',
    description: 'The operator goes back to the PlugSure app. A live app needs `?confirm=<slug>`: its web address stops serving it and its store apps stop working.',
    query: [{ name: 'confirm', description: 'The slug, to remove a live app.', schema: S }],
    responses: { 200: { description: 'Removed', schema: OK } },
    errors: [404, 409],
  },
];
