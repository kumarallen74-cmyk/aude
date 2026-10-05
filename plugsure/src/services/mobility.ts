import { readFileSync } from 'node:fs';
import { one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { setParty } from '../ocpi/store.js';
import { checkIcon, forgetBrands, brandOf, saveApnsKey, saveFcmServiceAccount, normaliseFingerprint, HOST_RE, type Brand } from './brand.js';
import { COUNTRIES, type CountryCode } from '../domain/country.js';

/**
 * The PlugSure Mobility eMSP organisation and the PlugSure app's network brand (docs/MOBILE-APP-SPEC.md §2.2, G1).
 *
 * PlugSure Mobility is an ordinary tenant organisation (its own console, users, acquirer integrations per country,
 * roaming settings) that:
 *   - has OCPI parties (EMSP role in the home country; default ID*PSM, MY*PSM, SG*PSM — [OWNER] party ids);
 *   - offers partner networks to app drivers (roaming_settings.appDrivers = true; holds per currency);
 *   - owns the ONE network-scope brand (slug `plugsure`): the PlugSure app's name, link domain, bundle ids, APNs key
 *     and Firebase service account — but no operator scoping, so every hosted operator stays directly chargeable;
 *   - joins the PlugSure Hub as an internal member (optional here: `joinHub`), so the hub delivers every agreed CPO's
 *     locations and tariffs into its ocpi_remote_location / ocpi_remote_tariff.
 *
 * Idempotent: run again to change settings. Used by the seed (development) and tools/mobility/setup.mts (production).
 */

export interface MobilityOptions {
  /** Adopt an existing organisation (PLUGSURE_APP_ORG_ID) instead of creating `plugsure-mobility`. */
  orgId?: string | null;
  name?: string;
  slug?: string;
  homeCountry?: CountryCode;
  /** OCPI parties, home first: ['ID*PSM', 'MY*PSM', 'SG*PSM']. */
  parties?: string[];
  /** The link domain (universal links / App Links), e.g. go.plugsure.asia. */
  linkHost?: string | null;
  iosBundleId?: string | null;
  iosTeamId?: string | null;
  androidPackage?: string | null;
  androidCertSha256?: string[];
  privacyUrl?: string | null;
  termsUrl?: string | null;
  supportEmail?: string | null;
  /** The app icon (square PNG ≥ 512 px): needed to set the brand live. */
  iconPng?: Buffer | null;
  /** Set live (needs the link domain and an icon). */
  live?: boolean;
  apns?: { keyId: string; p8: string } | null;
  fcmServiceAccount?: string | null;
  joinHub?: boolean;
  /**
   * Turn an existing OPERATOR brand of the organisation into the network-wide PlugSure app (v1.9.0). Without it the
   * setup refuses: converting shows every operator's chargers in that operator's app and breaks its store apps.
   */
  convertOperatorBrand?: boolean;
}

export interface MobilitySetup { orgId: string; created: boolean; brand: Brand; parties: string[]; hub: { joined: boolean; detail: string } }

export const DEFAULT_PARTIES = ['ID*PSM', 'MY*PSM', 'SG*PSM'];

export function parsePartyList(raw: string | string[] | undefined | null): string[] {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((x) => x.trim().toUpperCase()).filter(Boolean);
  for (const p of list) if (!/^[A-Z]{2}\*[A-Z0-9]{3}$/.test(p)) throw new Error(`party "${p}" must look like ID*PSM`);
  return list;
}

export async function setupMobility(o: MobilityOptions = {}): Promise<MobilitySetup> {
  const slug = o.slug ?? 'plugsure-mobility';
  const name = o.name ?? 'PlugSure Mobility';
  const home = o.homeCountry ?? 'ID';
  if (!COUNTRIES[home]) throw new Error(`unknown home country ${home}`);
  let org = o.orgId
    ? await one<{ id: string }>(`SELECT id FROM organisation WHERE id = $1`, [o.orgId])
    : await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [slug]);
  if (o.orgId && !org) throw new Error(`organisation ${o.orgId} (PLUGSURE_APP_ORG_ID) does not exist`);
  const created = !org;
  org ??= await one<{ id: string }>(
    // Its default language: the app sends X-Driver-Lang anyway; without it, Indonesian for an Indonesian home (as the web app).
    `INSERT INTO organisation (name, slug, home_country_code, default_locale) VALUES ($1, $2, $3, $4) RETURNING id`, [name, slug, home, home === 'ID' ? 'id' : 'en']);
  const orgId = org!.id;

  // Refused before anything is written (v1.9.0).
  const existing = await brandOf(orgId);
  if (existing && existing.scope !== 'network' && !o.convertOperatorBrand) {
    throw new Error(
      `organisation ${orgId} already has its own driver app "${existing.appName}" (${existing.slug}, ${existing.status}). Making it the PlugSure app ` +
      'would show every operator\'s chargers in it and stop its store apps finding their brand. Use a separate organisation for ' +
      'PlugSure Mobility, or set MOBILITY_CONVERT_BRAND=1 if converting it is really intended.',
    );
  }
  if (o.joinHub && !config.hub.enabled) {
    throw new Error('MOBILITY_JOIN_HUB needs the PlugSure Hub (HUB_ENABLED=true): with the hub off its /hub/ocpi endpoints do not exist.');
  }
  // Another organisation's network brand would make two PlugSure apps.
  const other = await one<{ org_id: string }>(`SELECT org_id FROM driver_app_brand WHERE scope = 'network' AND org_id <> $1`, [orgId]);
  if (other) throw new Error(`organisation ${other.org_id} already owns the PlugSure app's network brand`);

  // Partner networks for the app's signed-in drivers (holds: the country defaults until set in the console).
  await query(
    `UPDATE organisation SET roaming_settings = jsonb_set(COALESCE(roaming_settings, '{}'::jsonb), '{appDrivers}', 'true'::jsonb) WHERE id = $1`, [orgId]);

  const parties = parsePartyList(o.parties ?? DEFAULT_PARTIES);
  for (const [i, p] of parties.entries()) {
    const [cc, pid] = p.split('*') as [string, string];
    const taken = await one<{ org_id: string }>(`SELECT org_id FROM ocpi_party WHERE country_code = $1 AND party_id = $2 AND org_id <> $3`, [cc, pid, orgId]);
    if (taken) throw new Error(`party ${p} belongs to another organisation`);
    await setParty(orgId, { country_code: cc, party_id: pid, business_name: name, website: null }, { home: i === 0 });
  }

  const linkHost = o.linkHost ? o.linkHost.toLowerCase() : null;
  if (linkHost && !HOST_RE.test(linkHost)) throw new Error(`link host "${linkHost}" is not a domain name`);
  const certs = (o.androidCertSha256 ?? []).map((c) => {
    const n = normaliseFingerprint(c);
    if (!n) throw new Error(`"${c}" is not a SHA-256 certificate fingerprint`);
    return n;
  });
  const cur = await brandOf(orgId);
  await query(
    cur
      ? `UPDATE driver_app_brand SET scope = 'network', slug = 'plugsure', app_name = COALESCE($2, app_name), short_name = 'PlugSure',
           hostname = COALESCE($3, hostname), ios_bundle_id = COALESCE($4, ios_bundle_id), ios_team_id = COALESCE($5, ios_team_id),
           android_package = COALESCE($6, android_package), android_cert_sha256 = CASE WHEN cardinality($7::text[]) > 0 THEN $7 ELSE android_cert_sha256 END,
           privacy_url = COALESCE($8, privacy_url), terms_url = COALESCE($9, terms_url), support_email = COALESCE($10, support_email), updated_at = now()
         WHERE org_id = $1`
      : `INSERT INTO driver_app_brand (org_id, slug, status, app_name, short_name, scope, hostname, ios_bundle_id, ios_team_id, android_package,
           android_cert_sha256, privacy_url, terms_url, support_email, tagline_id, tagline_en)
         VALUES ($1, 'plugsure', 'draft', COALESCE($2, 'PlugSure'), 'PlugSure', 'network', $3, $4, $5, $6, $7, $8, $9, $10,
                 'Isi daya di semua jaringan', 'Charge on every network')`,
    [orgId, 'PlugSure', linkHost, o.iosBundleId ?? null, o.iosTeamId ?? null, o.androidPackage ?? null, certs, o.privacyUrl ?? null, o.termsUrl ?? null, o.supportEmail ?? null],
  );
  if (o.iconPng) {
    const r = checkIcon(o.iconPng);
    await query(`UPDATE driver_app_brand SET icon_png = $2, icon_sha256 = $3, updated_at = now() WHERE org_id = $1`, [orgId, o.iconPng, r.sha256]);
  }
  if (o.live) {
    const b = await one<{ ok: boolean }>(`SELECT hostname IS NOT NULL AND icon_png IS NOT NULL AS ok FROM driver_app_brand WHERE org_id = $1`, [orgId]);
    if (!b?.ok) throw new Error('to set the PlugSure app live it needs the link domain (linkHost) and an icon');
    await query(`UPDATE driver_app_brand SET status = 'live', published_at = COALESCE(published_at, now()) WHERE org_id = $1`, [orgId]);
  }
  forgetBrands();
  if (o.apns) await saveApnsKey(orgId, o.apns.keyId, o.apns.p8);
  if (o.fcmServiceAccount) await saveFcmServiceAccount(orgId, o.fcmServiceAccount);

  let hub = { joined: false, detail: 'not requested' };
  if (o.joinHub) {
    try {
      const { joinTenant } = await import('../hub/lifecycle.js');
      const r = await joinTenant(orgId, null);
      hub = { joined: true, detail: r.created ? 'joined the hub as an internal member' : 'already a hub member' };
    } catch (e) {
      hub = { joined: false, detail: (e as Error).message };
    }
  }
  const brand = (await brandOf(orgId))!;
  logger.info({ orgId, created, parties, brand: brand.slug, status: brand.status, hub: hub.detail }, 'PlugSure Mobility set up');
  return { orgId, created, brand, parties, hub };
}

/** Options from the environment (tools/mobility/setup.mts; every one optional). */
export function mobilityOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): MobilityOptions {
  const file = (p: string | undefined) => (p ? readFileSync(p) : null);
  return {
    orgId: env.PLUGSURE_APP_ORG_ID || null,
    homeCountry: (env.MOBILITY_HOME_COUNTRY as CountryCode) || undefined,
    parties: env.MOBILITY_PARTIES ? parsePartyList(env.MOBILITY_PARTIES) : undefined,
    linkHost: env.MOBILITY_LINK_HOST || null,
    iosBundleId: env.MOBILITY_IOS_BUNDLE_ID || null,
    iosTeamId: env.MOBILITY_IOS_TEAM_ID || null,
    androidPackage: env.MOBILITY_ANDROID_PACKAGE || null,
    androidCertSha256: env.MOBILITY_ANDROID_CERT_SHA256 ? env.MOBILITY_ANDROID_CERT_SHA256.split(',').map((x) => x.trim()).filter(Boolean) : [],
    privacyUrl: env.MOBILITY_PRIVACY_URL || null,
    termsUrl: env.MOBILITY_TERMS_URL || null,
    supportEmail: env.MOBILITY_SUPPORT_EMAIL || null,
    iconPng: file(env.MOBILITY_ICON_PNG),
    live: env.MOBILITY_LIVE === '1' || env.MOBILITY_LIVE === 'true',
    apns: env.MOBILITY_APNS_KEY_ID && env.MOBILITY_APNS_P8_FILE ? { keyId: env.MOBILITY_APNS_KEY_ID, p8: readFileSync(env.MOBILITY_APNS_P8_FILE, 'utf8') } : null,
    fcmServiceAccount: env.MOBILITY_FCM_SA_FILE ? readFileSync(env.MOBILITY_FCM_SA_FILE, 'utf8') : null,
    joinHub: env.MOBILITY_JOIN_HUB === '1' || env.MOBILITY_JOIN_HUB === 'true',
    convertOperatorBrand: env.MOBILITY_CONVERT_BRAND === '1' || env.MOBILITY_CONVERT_BRAND === 'true',
  };
}
