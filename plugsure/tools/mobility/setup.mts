// Set up (or update) the PlugSure Mobility eMSP organisation and the PlugSure app's network brand
// (docs/MOBILE-APP-SPEC.md §2.2, §15.1). Idempotent. Every setting is optional and comes from the environment:
//
//   PLUGSURE_APP_ORG_ID           adopt an existing organisation instead of creating `plugsure-mobility`
//   MOBILITY_HOME_COUNTRY         ID (default) | MY | SG
//   MOBILITY_PARTIES              OCPI parties, home first (default ID*PSM,MY*PSM,SG*PSM)
//   MOBILITY_LINK_HOST            the link domain, e.g. go.plugsure.asia (serves AASA / assetlinks and /c/<code>)
//   MOBILITY_IOS_BUNDLE_ID        MOBILITY_IOS_TEAM_ID        (apple-app-site-association, APNs topic)
//   MOBILITY_ANDROID_PACKAGE      MOBILITY_ANDROID_CERT_SHA256 (comma-separated; Play App Signing + upload key)
//   MOBILITY_PRIVACY_URL  MOBILITY_TERMS_URL  MOBILITY_SUPPORT_EMAIL
//   MOBILITY_ICON_PNG             path to the square icon (≥ 512 px)      MOBILITY_LIVE=1  set the brand live
//   MOBILITY_APNS_KEY_ID + MOBILITY_APNS_P8_FILE   the APNs key (checked with Apple)
//   MOBILITY_FCM_SA_FILE          the Firebase service account JSON (checked with Google)
//   MOBILITY_JOIN_HUB=1           join the PlugSure Hub as an internal member (HUB_ENABLED, OCPI_PUBLIC_URL)
//
//     npm run mobility:setup
// Then give the organisation a console administrator:
//     npm run create-admin -- --email mobility-admin@plugsure.asia --org-slug plugsure-mobility
// and in its console: payment integrations per country, roaming hold amounts, hub agreements.
import { setupMobility, mobilityOptionsFromEnv } from '../../src/services/mobility.js';
import { pool } from '../../src/db/pool.js';

try {
  const r = await setupMobility(mobilityOptionsFromEnv());
  console.log(JSON.stringify({
    orgId: r.orgId, created: r.created, parties: r.parties, hub: r.hub,
    brand: { slug: r.brand.slug, scope: r.brand.scope, status: r.brand.status, hostname: r.brand.hostname, iosBundleId: r.brand.iosBundleId,
      androidPackage: r.brand.androidPackage, apnsConfigured: r.brand.apnsConfigured, apnsCheckOk: r.brand.apnsCheckOk,
      fcmConfigured: r.brand.fcmConfigured, fcmCheckOk: r.brand.fcmCheckOk },
  }, null, 2));
} catch (e) {
  console.error(`mobility setup failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
