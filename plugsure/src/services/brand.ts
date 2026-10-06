import { createHash } from 'node:crypto';
import { phoneToE164 } from '../domain/phone.js';
import { COUNTRIES, type CountryCode } from '../domain/country.js';
import { many, one, query, outsideRequestScope } from '../db/pool.js';
import { decodePng, encodePng, onBackground, pngSize, resize, transparentShare, PngError, type Rgba } from './png.js';
import { buildZip, type ZipEntry } from './zip.js';
import { seal, unseal } from './secrets.js';
import { p8Problem, checkCredentials, forgetProviderToken, type ApnsCredentials } from './apns.js';
import { parseServiceAccount, checkFcmCredentials, forgetFcmToken, type FcmCredentials } from './fcm.js';

/**
 * White-label driver apps.
 *
 * An operator's own driver app is PlugSure's driver app with the operator's
 * name, colours and icon, showing only the operator's stations. It is served by
 * the same code, per request:
 *   - on the operator's own web address (`hostname`) once the brand is live;
 *   - at /app/?brand=<slug> as a preview, draft or live.
 * The Play Store and App Store builds are thin shells around that address
 * (an Android Trusted Web Activity, an iOS Capacitor app), made from the build
 * kit this module writes. The web address proves it owns the store apps with
 * /.well-known/assetlinks.json and /.well-known/apple-app-site-association.
 */

export class BrandError extends Error {
  constructor(public status: number, message: string, public fields: Record<string, string> = {}) { super(message); }
}

export interface Brand {
  orgId: string;
  slug: string;
  status: 'draft' | 'live';
  appName: string;
  shortName: string;
  taglineId: string | null;
  taglineEn: string | null;
  descriptionId: string | null;
  descriptionEn: string | null;
  accentColor: string;
  badgeColor: string;
  hasIcon: boolean;
  iconSha256: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  hostname: string | null;
  androidPackage: string | null;
  androidCertSha256: string[];
  iosBundleId: string | null;
  iosTeamId: string | null;
  versionName: string;
  versionCode: number;
  updatedAt: string;
  publishedAt: string | null;
  /** Native iOS notifications: the APNs key's id (the key itself is never returned). */
  apnsKeyId: string | null;
  apnsConfigured: boolean;
  apnsCheckedAt: string | null;
  apnsCheckOk: boolean | null;
  apnsCheckDetail: string | null;
  /**
   * 'operator': a white-label app limited to its operator's chargers (every brand before v1.9).
   * 'network': the PlugSure app itself (the PlugSure Mobility eMSP organisation's brand): every operator's chargers,
   * partner networks through its organisation (docs/MOBILE-APP-SPEC.md §2.2, G1). Set by tools/mobility/setup.mts only.
   */
  scope: 'operator' | 'network';
  /** Android notifications (FCM HTTP v1): the Firebase project and service account (the key itself is never returned). */
  fcmProjectId: string | null;
  fcmClientEmail: string | null;
  fcmConfigured: boolean;
  fcmCheckedAt: string | null;
  fcmCheckOk: boolean | null;
  fcmCheckDetail: string | null;
  /** The native apps' version gate and remote configuration (driver/app-config.ts). */
  appConfig: Record<string, unknown>;
}

interface Row {
  org_id: string; slug: string; status: 'draft' | 'live'; app_name: string; short_name: string;
  tagline_id: string | null; tagline_en: string | null; description_id: string | null; description_en: string | null;
  accent_color: string; badge_color: string; has_icon: boolean; icon_sha256: string | null;
  support_email: string | null; support_phone: string | null; privacy_url: string | null; terms_url: string | null;
  hostname: string | null; android_package: string | null; android_cert_sha256: string[] | null;
  ios_bundle_id: string | null; ios_team_id: string | null; version_name: string; version_code: number;
  updated_at: Date; published_at: Date | null;
  apns_key_id: string | null; apns_configured: boolean; apns_checked_at: Date | null; apns_check_ok: boolean | null; apns_check_detail: string | null;
  scope: 'operator' | 'network'; fcm_project_id: string | null; fcm_client_email: string | null; fcm_configured: boolean;
  fcm_checked_at: Date | null; fcm_check_ok: boolean | null; fcm_check_detail: string | null; app_config: Record<string, unknown> | null;
}

const COLS = `org_id, slug, status, app_name, short_name, tagline_id, tagline_en, description_id, description_en,
  accent_color, badge_color, icon_png IS NOT NULL AS has_icon, icon_sha256, support_email, support_phone, privacy_url, terms_url,
  hostname, android_package, android_cert_sha256, ios_bundle_id, ios_team_id, version_name, version_code, updated_at, published_at,
  apns_key_id, apns_key_sealed IS NOT NULL AS apns_configured, apns_checked_at, apns_check_ok, apns_check_detail,
  scope, fcm_project_id, fcm_client_email, fcm_sa_sealed IS NOT NULL AS fcm_configured, fcm_checked_at, fcm_check_ok, fcm_check_detail, app_config`;

const toBrand = (r: Row): Brand => ({
  orgId: r.org_id, slug: r.slug, status: r.status, appName: r.app_name, shortName: r.short_name,
  taglineId: r.tagline_id, taglineEn: r.tagline_en, descriptionId: r.description_id, descriptionEn: r.description_en,
  accentColor: r.accent_color, badgeColor: r.badge_color, hasIcon: r.has_icon, iconSha256: r.icon_sha256,
  supportEmail: r.support_email, supportPhone: r.support_phone, privacyUrl: r.privacy_url, termsUrl: r.terms_url,
  hostname: r.hostname, androidPackage: r.android_package, androidCertSha256: r.android_cert_sha256 ?? [],
  iosBundleId: r.ios_bundle_id, iosTeamId: r.ios_team_id, versionName: r.version_name, versionCode: r.version_code,
  updatedAt: new Date(r.updated_at).toISOString(), publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
  apnsKeyId: r.apns_key_id, apnsConfigured: r.apns_configured, apnsCheckedAt: r.apns_checked_at ? new Date(r.apns_checked_at).toISOString() : null,
  apnsCheckOk: r.apns_check_ok, apnsCheckDetail: r.apns_check_detail,
  scope: r.scope ?? 'operator',
  fcmProjectId: r.fcm_project_id ?? null, fcmClientEmail: r.fcm_client_email ?? null, fcmConfigured: r.fcm_configured === true,
  fcmCheckedAt: r.fcm_checked_at ? new Date(r.fcm_checked_at).toISOString() : null, fcmCheckOk: r.fcm_check_ok ?? null, fcmCheckDetail: r.fcm_check_detail ?? null,
  appConfig: r.app_config ?? {},
});

// ─────────────────────────────────────────────── lookups (public, cached)

const CACHE_MS = 30_000;
const bySlug = new Map<string, { at: number; brand: Brand | null }>();
const byHost = new Map<string, { at: number; brand: Brand | null }>();
const byOrg = new Map<string, { at: number; brand: Brand | null }>();

export function forgetBrands(): void { bySlug.clear(); byHost.clear(); byOrg.clear(); iconCache.clear(); credCache.clear(); fcmCache.clear(); network = null; }

async function cached(map: Map<string, { at: number; brand: Brand | null }>, key: string, load: () => Promise<Row | null>) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.brand;
  const r = await load();
  const brand = r ? toBrand(r) : null;
  map.set(key, { at: Date.now(), brand });
  return brand;
}

/** A brand by its slug, draft or live (the preview). */
export const brandBySlug = (slug: string) =>
  /^[a-z0-9-]{3,32}$/.test(slug) ? cached(bySlug, slug, () => one<Row>(`SELECT ${COLS} FROM driver_app_brand WHERE slug = $1`, [slug])) : Promise.resolve(null);

/** The live brand whose web address this is. */
export const brandForHost = (host: string | undefined) => {
  const h = String(host ?? '').toLowerCase().replace(/:\d+$/, '');
  return h && HOST_RE.test(h) ? cached(byHost, h, () => one<Row>(`SELECT ${COLS} FROM driver_app_brand WHERE hostname = $1 AND status = 'live'`, [h])) : Promise.resolve(null);
};

/** The operator's brand (any status). */
export const brandForOrg = (orgId: string) => cached(byOrg, orgId, () => one<Row>(`SELECT ${COLS} FROM driver_app_brand WHERE org_id = $1`, [orgId]));

let network: { at: number; brand: Brand | null } | null = null;

/** The PlugSure app's own brand (scope 'network', owned by the PlugSure Mobility organisation), or null when not set up. */
export async function networkBrand(): Promise<Brand | null> {
  if (network && Date.now() - network.at < CACHE_MS) return network.brand;
  const r = await one<Row>(`SELECT ${COLS} FROM driver_app_brand WHERE scope = 'network'`);
  network = { at: Date.now(), brand: r ? toBrand(r) : null };
  return network.brand;
}

/** Is this organisation the PlugSure app's (network brand's) organisation? */
export async function isNetworkOrg(orgId: string | null | undefined): Promise<boolean> {
  if (!orgId) return false;
  return (await networkBrand().catch(() => null))?.orgId === orgId;
}

/** What an operator's customers see as the seller: its live app's name, else PlugSure. */
export async function appNameFor(orgId: string | null | undefined): Promise<string> {
  if (!orgId) return 'PlugSure';
  const b = await brandForOrg(orgId).catch(() => null);
  return b?.status === 'live' ? b.appName : 'PlugSure';
}

/** Is this a web address some brand uses (for on-demand TLS certificates)? */
export async function hostnameKnown(host: string): Promise<boolean> {
  const h = host.toLowerCase();
  return HOST_RE.test(h) && !!(await one(`SELECT 1 FROM driver_app_brand WHERE hostname = $1`, [h]));
}

// ─────────────────────────────────────────────── validation

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .\-]*$/u;
const TEXT_RE = /^[\p{L}\p{N} .,!?:;()%/+\-–]*$/u;
export const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const PKG_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const BUNDLE_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const TEAM_RE = /^[A-Z0-9]{10}$/;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i;
const RESERVED_SLUGS = new Set(['app', 'api', 'www', 'admin', 'plugsure', 'console', 'static', 'brand']);

export function slugFrom(name: string): string {
  return name.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
}

/** SHA-256 certificate fingerprint in the colon form Digital Asset Links wants. */
export function normaliseFingerprint(v: string): string | null {
  const hex = v.replace(/[\s:]/g, '').toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g)!.join(':') : null;
}

export function reservedHosts(): Set<string> {
  const out = new Set<string>(['localhost']);
  for (const v of [process.env.CONSOLE_PUBLIC_URL, process.env.PUBLIC_BASE_URL, process.env.DRIVER_PUBLIC_URL, process.env.OCPI_PUBLIC_URL, process.env.API_PUBLIC_URL, process.env.OCPP_PUBLIC_URL]) {
    try { if (v) out.add(new URL(v).hostname.toLowerCase()); } catch { /* not a URL */ }
  }
  return out;
}

export interface BrandInput {
  slug?: unknown; appName?: unknown; shortName?: unknown; taglineId?: unknown; taglineEn?: unknown;
  descriptionId?: unknown; descriptionEn?: unknown; accentColor?: unknown; badgeColor?: unknown;
  supportEmail?: unknown; supportPhone?: unknown; privacyUrl?: unknown; termsUrl?: unknown; hostname?: unknown;
  androidPackage?: unknown; androidCertSha256?: unknown; iosBundleId?: unknown; iosTeamId?: unknown;
  versionName?: unknown; versionCode?: unknown; status?: unknown;
}

type Values = Omit<Brand, 'orgId' | 'hasIcon' | 'iconSha256' | 'updatedAt' | 'publishedAt' | 'apnsKeyId' | 'apnsConfigured' | 'apnsCheckedAt' | 'apnsCheckOk' | 'apnsCheckDetail'
  | 'scope' | 'fcmProjectId' | 'fcmClientEmail' | 'fcmConfigured' | 'fcmCheckedAt' | 'fcmCheckOk' | 'fcmCheckDetail' | 'appConfig'>;

/** Check an edit against the current brand (or none). Throws BrandError with a message per field. */
export function validateBrand(input: BrandInput, current: Brand | null, homeCountry: CountryCode = 'ID'): Values {
  const errors: Record<string, string> = {};
  const has = (k: keyof BrandInput) => Object.prototype.hasOwnProperty.call(input, k);
  const str = (k: keyof BrandInput, prev: string | null) => (has(k) ? (input[k] == null ? '' : String(input[k]).trim()) : prev ?? '');
  const opt = (k: keyof BrandInput, prev: string | null) => { const v = str(k, prev); return v === '' ? null : v; };

  const appName = str('appName', current?.appName ?? null);
  if (!appName) errors.appName = 'The app name is required.';
  else if (appName.length > 30 || !NAME_RE.test(appName)) errors.appName = 'Up to 30 letters, digits, spaces, dots or hyphens (this is the store listing name).';
  const shortName = str('shortName', current?.shortName ?? null) || appName.slice(0, 12).trim();
  if (shortName.length > 12 || (shortName && !NAME_RE.test(shortName))) errors.shortName = 'Up to 12 characters: the name under the icon on a phone.';

  let slug = str('slug', current?.slug ?? null) || slugFrom(appName);
  slug = slug.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) errors.slug = '3–32 lowercase letters, digits and hyphens.';
  // The PlugSure app's own brand keeps its reserved slug (set by tools/mobility/setup.mts); nobody else may take one.
  else if (RESERVED_SLUGS.has(slug) && !(current?.scope === 'network' && current.slug === slug)) errors.slug = 'This name is reserved; choose another.';

  const text = (k: keyof BrandInput, prev: string | null, max: number, label: string) => {
    const v = opt(k, prev);
    if (v && (v.length > max || !TEXT_RE.test(v))) errors[k] = `${label}: up to ${max} characters, without quotes, < > & or $.`;
    return v;
  };
  const taglineId = text('taglineId', current?.taglineId ?? null, 40, 'Tagline');
  const taglineEn = text('taglineEn', current?.taglineEn ?? null, 40, 'Tagline (English)');
  const descriptionId = text('descriptionId', current?.descriptionId ?? null, 80, 'Short description');
  const descriptionEn = text('descriptionEn', current?.descriptionEn ?? null, 80, 'Short description (English)');

  const color = (k: keyof BrandInput, prev: string) => {
    const v = str(k, prev).toLowerCase();
    if (!COLOR_RE.test(v)) { errors[k] = 'A colour as #rrggbb.'; return prev; }
    return v;
  };
  const accentColor = color('accentColor', current?.accentColor ?? '#2fd6a7');
  const badgeColor = color('badgeColor', current?.badgeColor ?? '#1b4d8c');

  const supportEmail = opt('supportEmail', current?.supportEmail ?? null);
  if (supportEmail && (supportEmail.length > 120 || !EMAIL_RE.test(supportEmail))) errors.supportEmail = 'Not an e-mail address.';
  let supportPhone = opt('supportPhone', current?.supportPhone ?? null);
  if (supportPhone) {
    const e164 = phoneToE164(supportPhone, homeCountry);
    if (!e164) errors.supportPhone = `A phone number, e.g. ${COUNTRIES[homeCountry].phoneExample}.`;
    else supportPhone = e164;
  }
  const url = (k: keyof BrandInput, prev: string | null, label: string) => {
    const v = opt(k, prev);
    if (!v) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' || v.length > 300) throw new Error();
      return u.toString();
    } catch { errors[k] = `${label} must be an https:// address.`; return v; }
  };
  const privacyUrl = url('privacyUrl', current?.privacyUrl ?? null, 'The privacy policy');
  const termsUrl = url('termsUrl', current?.termsUrl ?? null, 'The terms of use');

  let hostname = opt('hostname', current?.hostname ?? null);
  if (hostname) {
    hostname = hostname.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
    if (!HOST_RE.test(hostname)) errors.hostname = 'A domain name such as app.example.co.id (no https://, no path).';
    else if (reservedHosts().has(hostname)) errors.hostname = 'This is one of PlugSure’s own addresses; use a domain of your own.';
  }

  const androidPackage = opt('androidPackage', current?.androidPackage ?? null);
  if (androidPackage && (androidPackage.length > 100 || !PKG_RE.test(androidPackage))) errors.androidPackage = 'A package name such as id.nusantaracharge.app (lowercase, at least two parts).';
  let androidCertSha256 = current?.androidCertSha256 ?? [];
  if (has('androidCertSha256')) {
    const raw = input.androidCertSha256;
    const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[\n,;]+/);
    const out: string[] = [];
    for (const f of list.map((x) => x.trim()).filter(Boolean)) {
      const n = normaliseFingerprint(f);
      if (!n) { errors.androidCertSha256 = `Not a SHA-256 certificate fingerprint: ${f.slice(0, 20)}…`; break; }
      if (!out.includes(n)) out.push(n);
    }
    if (out.length > 5) errors.androidCertSha256 = 'At most 5 fingerprints (upload key and Play app signing key).';
    androidCertSha256 = out;
  }
  const iosBundleId = opt('iosBundleId', current?.iosBundleId ?? null);
  if (iosBundleId && (iosBundleId.length > 155 || !BUNDLE_RE.test(iosBundleId))) errors.iosBundleId = 'A bundle identifier such as id.nusantaracharge.app.';
  const iosTeamId = opt('iosTeamId', current?.iosTeamId ?? null)?.toUpperCase() ?? null;
  if (iosTeamId && !TEAM_RE.test(iosTeamId)) errors.iosTeamId = 'The 10-character Apple Team ID (Membership details in the Apple Developer account).';

  const versionName = str('versionName', current?.versionName ?? '1.0.0');
  if (!VERSION_RE.test(versionName)) errors.versionName = 'A version such as 1.0.0.';
  const versionCode = has('versionCode') ? Number(input.versionCode) : current?.versionCode ?? 1;
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) errors.versionCode = 'A whole number from 1; raise it for every store upload.';
  else if (current && versionCode < current.versionCode) errors.versionCode = `The version code cannot go down (it is ${current.versionCode}); the stores refuse an older one.`;

  const status = has('status') ? String(input.status) : current?.status ?? 'draft';
  if (status !== 'draft' && status !== 'live') errors.status = 'draft or live.';

  if (Object.keys(errors).length) throw new BrandError(422, Object.values(errors)[0]!, errors);
  return {
    slug, status: status as 'draft' | 'live', appName, shortName, taglineId, taglineEn, descriptionId, descriptionEn, accentColor, badgeColor,
    supportEmail, supportPhone, privacyUrl, termsUrl, hostname, androidPackage, androidCertSha256, iosBundleId, iosTeamId, versionName, versionCode,
  };
}

// ─────────────────────────────────────────────── colours (WCAG AA in both themes)

type RGB = [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const hexOf = (c: RGB) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const lum = (c: RGB) => {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };
export const mix = (a: string, b: string, t: number) => { const [p, q] = [rgb(a), rgb(b)]; return hexOf([0, 1, 2].map((i) => p[i]! + (q[i]! - p[i]!) * t) as RGB); };

/** The app's own backgrounds the accent must stand out on (text and icons in the accent colour). */
export const DARK_SURFACES = ['#0a1417', '#0f1e22', '#15282d'];
export const LIGHT_SURFACES = ['#ffffff', '#eef3f2', '#f2f6f5'];

/** Nudge a colour toward white (dark theme) or black (light theme) until it reaches 4.5:1 on every surface. */
function readableOn(accent: string, surfaces: string[], toward: string): string {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(accent, toward, t);
    if (surfaces.every((s) => contrast(c, s) >= 4.5)) return c;
  }
  return toward;
}
/** Text on a solid fill: black-ish or white, whichever reads better (always ≥ 4.58:1). */
export const onFill = (fill: string) => (contrast(fill, '#ffffff') >= contrast(fill, '#08130f') ? '#ffffff' : '#08130f');

export interface Palette {
  dark: { accent: string; deep: string; on: string; glow: string; contrast: number };
  light: { accent: string; deep: string; on: string; glow: string; contrast: number };
  badge: string;
  adjusted: boolean;
}

export function palette(accentColor: string, badgeColor: string): Palette {
  const glow = (c: string, a: number) => `rgba(${rgb(c).join(',')},${a})`;
  const d = readableOn(accentColor, DARK_SURFACES, '#ffffff');
  const l = readableOn(accentColor, LIGHT_SURFACES, '#000000');
  return {
    dark: { accent: d, deep: mix(d, '#000000', 0.16), on: onFill(d), glow: glow(d, 0.18), contrast: Math.round(Math.min(...DARK_SURFACES.map((s) => contrast(d, s))) * 100) / 100 },
    light: { accent: l, deep: mix(l, '#000000', 0.16), on: onFill(l), glow: glow(l, 0.12), contrast: Math.round(Math.min(...LIGHT_SURFACES.map((s) => contrast(l, s))) * 100) / 100 },
    badge: badgeColor,
    adjusted: d !== accentColor || l !== accentColor,
  };
}

// ─────────────────────────────────────────────── the icon

export const ICON_SIZES = [48, 72, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512, 1024] as const;
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const iconCache = new Map<string, Buffer>();

export interface IconReport { width: number; height: number; bytes: number; sha256: string; warnings: string[] }

/** Check an uploaded icon; returns what was stored. */
export function checkIcon(png: Buffer): IconReport {
  if (png.length > MAX_ICON_BYTES) throw new BrandError(413, 'The icon is larger than 2 MB.');
  let size: { width: number; height: number };
  try { size = pngSize(png); } catch { throw new BrandError(422, 'The icon must be a PNG file.'); }
  if (size.width !== size.height) throw new BrandError(422, `The icon must be square (this one is ${size.width} × ${size.height}).`);
  if (size.width < 512 || size.width > 2048) throw new BrandError(422, `The icon must be between 512 and 2048 pixels square (this one is ${size.width}); 1024 is best.`);
  let img: Rgba;
  try { img = decodePng(png); } catch (e) { throw new BrandError(422, e instanceof PngError ? `The icon could not be read: ${e.message}.` : 'The icon could not be read.'); }
  const warnings: string[] = [];
  if (size.width < 1024) warnings.push('The App Store icon is 1024 × 1024; this icon will be enlarged for it. Upload a 1024-pixel icon for a sharp store listing.');
  if (transparentShare(img) > 0.25) warnings.push('A quarter of the icon is transparent. Phones cut their own shape (circle, rounded square); a full-bleed square icon looks best.');
  return { ...size, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), warnings };
}

async function iconSource(orgId: string): Promise<Buffer | null> {
  const r = await one<{ icon_png: Buffer | null }>(`SELECT icon_png FROM driver_app_brand WHERE org_id = $1`, [orgId]);
  return r?.icon_png ?? null;
}

/**
 * One icon file: `icon-<size>.png` (the artwork resized), `maskable-<size>.png`
 * (on the badge colour, inside the 80 % safe zone) or `appstore-1024.png`
 * (opaque, for the App Store).
 */
export async function iconFile(b: Brand, file: string, source?: Buffer): Promise<Buffer | null> {
  if (!b.hasIcon || !b.iconSha256) return null;
  const m = /^(icon|maskable)-(\d{2,4})\.png$|^(appstore)-1024\.png$/.exec(file);
  if (!m) return null;
  const kind = m[3] ? 'appstore' : m[1]!;
  const size = m[3] ? 1024 : Number(m[2]);
  if (!(ICON_SIZES as readonly number[]).includes(size)) return null;
  const key = `${b.iconSha256}:${b.badgeColor}:${kind}:${size}`;
  const hit = iconCache.get(key);
  if (hit) return hit;
  const src = source ?? await iconSource(b.orgId);
  if (!src) return null;
  const img = decodePng(src);
  const bg = rgb(b.badgeColor);
  const out = kind === 'icon' ? encodePng(resize(img, size, size))
    : kind === 'maskable' ? encodePng(onBackground(img, size, bg, 0.8))
      : encodePng(onBackground(img, 1024, bg, 1), { opaque: true });
  if (iconCache.size > 400) iconCache.clear();
  iconCache.set(key, out);
  return out;
}

const iconUrl = (b: Brand, file: string) => `/app/brand/${b.slug}/${file}?v=${(b.iconSha256 ?? '').slice(0, 10)}`;

// ─────────────────────────────────────────────── the web app, rendered per brand

/** What the app itself is told (window.BRAND). Nothing secret. */
export const publicBrand = (b: Brand) => ({
  slug: b.slug, name: b.appName, shortName: b.shortName, supportEmail: b.supportEmail, supportPhone: b.supportPhone,
  privacyUrl: b.privacyUrl, termsUrl: b.termsUrl,
  // The accent as used on dark surfaces (the lock screen's Live Activity).
  accent: palette(b.accentColor, b.badgeColor).dark.accent,
});

const DEFAULT_TAGLINE_ID = 'Isi daya, di mana saja';

/**
 * The driver app's page for a brand: renamed, recoloured, with the brand's
 * icon, and told which brand it is (it sends X-Driver-Brand with every API
 * call, so stations and history are scoped to the operator). `preview` keeps
 * the brand in the manifest link and start URL.
 */
export function renderIndex(html: string, b: Brand, opts: { preview: boolean; defaultLang?: string | null }): string {
  const p = palette(b.accentColor, b.badgeColor);
  let out = html;
  // The operator's default language (Malaysia and Singapore: English): the app's language until the driver
  // chooses one (stored), after the device's language when that is English.
  if (opts.defaultLang === 'en' || opts.defaultLang === 'id') out = out.replace('<html lang="id">', `<html lang="${opts.defaultLang}" data-default-lang="${opts.defaultLang}">`);
  // The tagline, and its English in the translation table.
  if (b.taglineId) {
    out = out.replace(`'${DEFAULT_TAGLINE_ID}':'Charge anywhere'`, `'${b.taglineId}':'${b.taglineEn || b.taglineId}'`);
    out = out.split(DEFAULT_TAGLINE_ID).join(b.taglineId);
  }
  out = out.replace(/const BRAND_ICON='[^\n]*';/, `const BRAND_ICON='<img class="brand-badge" src="${iconUrl(b, 'icon-96.png')}" alt="${b.appName}" width="36" height="36">';`);
  out = out.replace(/<link rel="icon" href="[^"]*">/, `<link rel="icon" type="image/png" href="${iconUrl(b, 'icon-96.png')}">\n<link rel="apple-touch-icon" href="${iconUrl(b, 'icon-180.png')}">`);
  if (opts.preview) out = out.replace('<link rel="manifest" href="manifest.webmanifest">', `<link rel="manifest" href="manifest.webmanifest?brand=${b.slug}">`);
  // The name: the characters allowed in it are safe in HTML, in JS strings and in the translation keys.
  out = out.split('PlugSure').join(b.appName);
  const vars = (t: Palette['dark']) =>
    `--arus:${t.accent};--arus-deep:${t.deep};--arus-glow:${t.glow};--on-arus:${t.on};--ocean:${p.badge};`;
  const style = `<style id="brand-theme">
:root{${vars(p.dark)}}
:root[data-theme="light"]{${vars(p.light)}}
.brand-badge{box-shadow:0 4px 14px ${p.dark.glow};object-fit:cover;background:${p.badge}}
@media (min-width:520px) and (min-height:600px){
  body{background:radial-gradient(120% 80% at 50% -10%, ${mix(p.dark.accent, '#0a1417', 0.86)} 0%, var(--bg) 55%)}
  :root[data-theme="light"] body{background:radial-gradient(120% 80% at 50% -10%, ${mix(p.light.accent, '#eef3f2', 0.84)} 0%, var(--bg) 55%)}
}
</style>`;
  const script = `<script>window.BRAND=${JSON.stringify(publicBrand(b)).replace(/</g, '\\u003c')};</script>`;
  return out.replace('</head>', `${style}\n${script}\n</head>`);
}

export function manifestFor(b: Brand | null, base: string, opts: { preview: boolean }): Record<string, unknown> {
  if (!b) return JSON.parse(base) as Record<string, unknown>;
  const q = opts.preview ? `?brand=${b.slug}` : '';
  const icons = b.hasIcon ? [
    { src: iconUrl(b, 'icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: iconUrl(b, 'icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: iconUrl(b, 'maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ] : (JSON.parse(base) as { icons: unknown[] }).icons;
  return {
    id: `/app/${q}`,
    name: `${b.appName}${b.taglineId ? ` — ${b.taglineId}` : ''}`.slice(0, 45),
    short_name: b.shortName,
    description: b.descriptionId ?? `Isi daya mobil listrik Anda di stasiun ${b.appName}. Pindai, bayar, selesai.`,
    start_url: `/app/${q}`,
    scope: '/app/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a1417',
    theme_color: '#0a1417',
    lang: 'id',
    icons,
    ...(b.androidPackage && b.status === 'live'
      ? { related_applications: [{ platform: 'play', id: b.androidPackage, url: `https://play.google.com/store/apps/details?id=${b.androidPackage}` }], prefer_related_applications: false }
      : {}),
  };
}

/** The push service worker: the brand's name and icon on notifications. */
export function renderServiceWorker(js: string, b: Brand): string {
  return js
    .replace(/icon: 'data:image\/svg\+xml,' \+ encodeURIComponent\([\s\S]*?<\/svg>"\),/,`icon: ${JSON.stringify(iconUrl(b, 'icon-192.png'))},\n    badge: ${JSON.stringify(iconUrl(b, 'icon-96.png'))},`)
    .split("'PlugSure'").join(JSON.stringify(b.appName))
    .split('PlugSure').join(b.appName);
}

/**
 * The app ids of a brand's native app builds (v1.9.1): the store build, and the preview and development builds that
 * install beside it as `<id>.preview` / `<id>.dev` (mobile/app.config.ts). They share the brand's signing key / team,
 * so links and notifications must reach all three.
 */
export const APP_ID_SUFFIXES: readonly string[] = Object.freeze(['', '.preview', '.dev']);
export const appIdsOf = (base: string): string[] => APP_ID_SUFFIXES.map((s) => base + s);

/**
 * The app id a native app says it is (`appId` in a push / live-activity registration), if it is one of this brand's
 * builds for that platform; null for the store build itself, or anything else (the brand's own id is used then).
 */
export function brandAppId(b: Brand | null | undefined, raw: unknown, platform: 'ios' | 'android'): string | null {
  const base = platform === 'ios' ? b?.iosBundleId : b?.androidPackage;
  if (!base || typeof raw !== 'string') return null;
  const v = raw.trim();
  return v !== base && appIdsOf(base).includes(v) ? v : null;
}

/** Digital Asset Links: the Android app (and its preview and development builds) may open this web address. */
export function assetLinks(b: Brand | null): unknown[] {
  if (!b?.androidPackage || !b.androidCertSha256.length) return [];
  return appIdsOf(b.androidPackage).map((pkg) => ({
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: b.androidCertSha256 },
  }));
}

/**
 * The paths a link domain hands to the native app (universal links / App Links), docs/MOBILE-APP-SPEC.md §13.1:
 * charger QR stickers (/c/<code>), shared stations (/s/<siteId>), receipts (/r/<kind>/<id>), payment returns (/paid)
 * and the web app's own links (/app/*). An operator's white-label app keeps /app/* only, as before.
 */
export const NETWORK_LINK_PATHS: ReadonlyArray<{ path: string; comment: string }> = Object.freeze([
  { path: '/c/*', comment: 'A charger QR code' },
  { path: '/s/*', comment: 'A shared station' },
  { path: '/r/*', comment: 'A receipt' },
  { path: '/paid*', comment: 'Back from a payment' },
  { path: '/app/*', comment: 'The driver app' },
]);

/** Apple app-site association: links to this address open the iOS app. */
export function appleAssociation(b: Brand | null): Record<string, unknown> {
  if (!b?.iosBundleId || !b.iosTeamId) return { applinks: { details: [] } };
  // The store build first, then its preview and development builds (v1.9.1).
  const appIds = appIdsOf(b.iosBundleId).map((id) => `${b.iosTeamId}.${id}`);
  const components = b.scope === 'network'
    ? NETWORK_LINK_PATHS.map((x) => ({ '/': x.path, comment: x.comment }))
    : [{ '/': '/app/*', comment: 'The driver app' }];
  return { applinks: { details: [{ appIDs: appIds, components }] }, webcredentials: { apps: appIds } };
}

// ─────────────────────────────────────────────── readiness

export interface Check { key: string; ok: boolean; label: string; for: 'live' | 'play' | 'appstore' | 'recommended' }

export function readiness(b: Brand): Check[] {
  return [
    { key: 'icon', ok: b.hasIcon, label: 'App icon uploaded', for: 'live' },
    { key: 'hostname', ok: !!b.hostname, label: 'Web address set (and pointed at PlugSure)', for: 'live' },
    { key: 'support', ok: !!(b.supportEmail || b.supportPhone), label: 'Support e-mail or phone', for: 'recommended' },
    { key: 'privacy', ok: !!b.privacyUrl, label: 'Privacy policy address', for: 'play' },
    { key: 'androidPackage', ok: !!b.androidPackage, label: 'Android package name', for: 'play' },
    { key: 'androidCert', ok: b.androidCertSha256.length > 0, label: 'Signing certificate fingerprint (SHA-256)', for: 'play' },
    { key: 'privacyIos', ok: !!b.privacyUrl, label: 'Privacy policy address', for: 'appstore' },
    { key: 'iosBundle', ok: !!b.iosBundleId, label: 'iOS bundle identifier', for: 'appstore' },
    { key: 'iosTeam', ok: !!b.iosTeamId, label: 'Apple Team ID', for: 'appstore' },
    { key: 'apns', ok: b.apnsConfigured && b.apnsCheckOk === true, label: 'Notifications key (APNs), checked with Apple', for: 'appstore' },
    { key: 'live', ok: b.status === 'live', label: 'Brand is live', for: 'play' },
  ];
}

// ─────────────────────────────────────────────── writes (inside the operator's request scope)

export async function saveBrand(orgId: string, input: BrandInput): Promise<Brand> {
  const current = await one<Row>(`SELECT ${COLS} FROM driver_app_brand WHERE org_id = $1`, [orgId]);
  const cur = current ? toBrand(current) : null;
  const home = await one<{ c: CountryCode }>(`SELECT home_country_code AS c FROM organisation WHERE id = $1`, [orgId]);
  const v = validateBrand(input, cur, home?.c ?? 'ID');
  if (v.status === 'live') {
    const missing = [!cur?.hasIcon && 'an icon', !v.hostname && 'a web address'].filter(Boolean);
    if (missing.length) throw new BrandError(409, `To go live the app needs ${missing.join(' and ')}.`, { status: 'missing' });
  }
  // Across operators, so outside the request's org scope: inside it, row-level security
  // shows only this operator's rows and the check found nothing (the UNIQUE constraints
  // then failed the write with a server error). A console's approved web address counts too.
  const clash = await outsideRequestScope(() => one<{ what: string }>(
    `SELECT CASE WHEN slug = $2 THEN 'slug' WHEN hostname = $3 THEN 'hostname' WHEN android_package = $4 THEN 'androidPackage' ELSE 'iosBundleId' END AS what
       FROM driver_app_brand WHERE org_id <> $1 AND (slug = $2 OR hostname = $3 OR android_package = $4 OR ios_bundle_id = $5)
     UNION ALL SELECT 'consoleHostname' FROM console_brand WHERE hostname = $3 AND hostname_approved_at IS NOT NULL
     LIMIT 1`,
    [orgId, v.slug, v.hostname, v.androidPackage, v.iosBundleId],
  ));
  if (clash?.what === 'consoleHostname') throw new BrandError(409, 'An operator console already uses this web address; the driver app needs one of its own.', { hostname: 'taken' });
  if (clash) throw new BrandError(409, `Another operator already uses this ${({ slug: 'short name in the address', hostname: 'web address', androidPackage: 'Android package name', iosBundleId: 'iOS bundle identifier' } as Record<string, string>)[clash.what]}.`, { [clash.what]: 'taken' });
  // Not an upsert: PostgreSQL checks the table's CHECK (live needs an icon) on the
  // proposed INSERT row, which has no icon, even when the existing row does.
  const r = await one<Row>(
    cur
      ? `UPDATE driver_app_brand SET slug = $2, status = $3, app_name = $4, short_name = $5, tagline_id = $6, tagline_en = $7,
           description_id = $8, description_en = $9, accent_color = $10, badge_color = $11, support_email = $12, support_phone = $13,
           privacy_url = $14, terms_url = $15, hostname = $16, android_package = $17, android_cert_sha256 = $18, ios_bundle_id = $19,
           ios_team_id = $20, version_name = $21, version_code = $22, updated_at = now(),
           published_at = CASE WHEN $3 = 'live' AND status <> 'live' THEN now() ELSE published_at END
         WHERE org_id = $1
         RETURNING ${COLS}`
      : `INSERT INTO driver_app_brand (org_id, slug, status, app_name, short_name, tagline_id, tagline_en, description_id, description_en,
           accent_color, badge_color, support_email, support_phone, privacy_url, terms_url, hostname, android_package, android_cert_sha256,
           ios_bundle_id, ios_team_id, version_name, version_code, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, CASE WHEN $3 = 'live' THEN now() END)
         RETURNING ${COLS}`,
    [orgId, v.slug, v.status, v.appName, v.shortName, v.taglineId, v.taglineEn, v.descriptionId, v.descriptionEn, v.accentColor, v.badgeColor,
      v.supportEmail, v.supportPhone, v.privacyUrl, v.termsUrl, v.hostname, v.androidPackage, v.androidCertSha256, v.iosBundleId, v.iosTeamId,
      v.versionName, v.versionCode],
  );
  forgetBrands();
  return toBrand(r!);
}

export async function saveIcon(orgId: string, png: Buffer): Promise<{ brand: Brand; icon: IconReport }> {
  const report = checkIcon(png);
  const r = await one<Row>(
    `UPDATE driver_app_brand SET icon_png = $2, icon_sha256 = $3, updated_at = now() WHERE org_id = $1 RETURNING ${COLS}`,
    [orgId, png, report.sha256],
  );
  if (!r) throw new BrandError(404, 'Save the app’s name first, then upload its icon.');
  forgetBrands();
  return { brand: toBrand(r), icon: report };
}

export async function deleteBrand(orgId: string): Promise<boolean> {
  const r = await query(`DELETE FROM driver_app_brand WHERE org_id = $1`, [orgId]);
  // Its iOS app's iPhones: nothing can reach them any more. (Removing only the key keeps them:
  // device tokens belong to the app, so a new key for the same app reaches the same phones.)
  await query(`DELETE FROM push_subscription WHERE kind = 'apns' AND brand_org_id = $1`, [orgId]);
  forgetBrands();
  return (r.rowCount ?? 0) > 0;
}

export async function brandOf(orgId: string): Promise<Brand | null> {
  const r = await one<Row>(`SELECT ${COLS} FROM driver_app_brand WHERE org_id = $1`, [orgId]);
  return r ? toBrand(r) : null;
}

/** Every live brand (the TLS "ask" check, the platform overview). */
export async function liveBrands(): Promise<Brand[]> {
  return (await many<Row>(`SELECT ${COLS} FROM driver_app_brand WHERE status = 'live' ORDER BY app_name`)).map(toBrand);
}

// ─────────────────────────────────────────────── the store build kit

const J = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/**
 * Everything needed to build and list the operator's app, as a zip:
 *   android/  a Bubblewrap (Trusted Web Activity) project definition, launcher
 *             icons, the Digital Asset Links file, and a CI workflow that builds
 *             the signed App Bundle;
 *   ios/      a Capacitor shell (config, package.json, fallback page, the
 *             1024-pixel App Store icon, Info.plist additions) and the
 *             app-site association file;
 *   store/    listing texts in Indonesian and English, and data-safety answers.
 */
export async function buildKit(b: Brand, opts: { iconPng?: Buffer } = {}): Promise<{ zip: Buffer; files: string[]; warnings: string[] }> {
  const icon = (file: string) => iconFile(b, file, opts.iconPng);
  const warnings: string[] = [];
  const host = b.hostname ?? `${b.slug}.example.invalid`;
  if (!b.hostname) warnings.push('No web address yet: the kit uses a placeholder. Set the web address and download the kit again before building.');
  if (!b.hasIcon) warnings.push('No icon yet: the kit has no icons. Upload the icon and download the kit again.');
  if (b.status !== 'live') warnings.push('The brand is still a draft: the store apps open the web address, which serves the app only once the brand is live.');
  if (!b.privacyUrl) warnings.push('Both stores require a privacy policy address.');
  if (!b.apnsConfigured) warnings.push('No notifications key (APNs) yet: the iOS app will build, but get no notifications until the key is uploaded in the console.');
  const pkg = b.androidPackage ?? `id.example.${b.slug.replace(/-/g, '')}`;
  if (!b.androidPackage) warnings.push('No Android package name yet: the kit uses a placeholder.');
  const bundle = b.iosBundleId ?? pkg;
  const pal = palette(b.accentColor, b.badgeColor);
  const url = `https://${host}`;
  const files: ZipEntry[] = [];
  const add = (name: string, data: Buffer | string) => files.push({ name, data });

  add('brand.json', J({ ...publicBrand(b), status: b.status, hostname: b.hostname, accentColor: b.accentColor, badgeColor: b.badgeColor,
    palette: pal, androidPackage: b.androidPackage, iosBundleId: b.iosBundleId, versionName: b.versionName, versionCode: b.versionCode }));

  // ── Android: Trusted Web Activity with Bubblewrap
  add('android/twa-manifest.json', J({
    packageId: pkg,
    host,
    name: b.appName,
    launcherName: b.shortName,
    display: 'standalone',
    orientation: 'portrait',
    themeColor: '#0a1417',
    themeColorDark: '#0a1417',
    navigationColor: '#0a1417',
    navigationColorDark: '#0a1417',
    navigationDividerColor: '#0a1417',
    navigationDividerColorDark: '#0a1417',
    backgroundColor: '#0a1417',
    enableNotifications: true,
    startUrl: '/app/',
    iconUrl: `${url}${iconUrl(b, 'icon-512.png')}`,
    maskableIconUrl: `${url}${iconUrl(b, 'maskable-512.png')}`,
    splashScreenFadeOutDuration: 300,
    signingKey: { path: './android.keystore', alias: 'upload' },
    appVersionName: b.versionName,
    appVersionCode: b.versionCode,
    shortcuts: [
      { name: 'Peta stasiun', shortName: 'Peta', url: '/app/#map', icons: [{ url: `${url}${iconUrl(b, 'icon-192.png')}`, sizes: '192x192' }] },
    ],
    generatorApp: 'plugsure-csms',
    webManifestUrl: `${url}/app/manifest.webmanifest`,
    fallbackType: 'customtabs',
    features: { locationDelegation: { enabled: true } },
    alphaDependencies: { enabled: false },
    enableSiteSettingsShortcut: false,
    isChromeOSOnly: false,
    isMetaQuest: false,
    fullScopeUrl: `${url}/app/`,
    minSdkVersion: 21,
  }));
  add('android/assetlinks.json', J(assetLinks({ ...b, androidPackage: pkg })));
  if (b.hasIcon) {
    const mip: Record<string, number> = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
    for (const [d, s] of Object.entries(mip)) add(`android/res/mipmap-${d}/ic_launcher.png`, (await icon(`icon-${s}.png`))!);
    add('android/store/icon-512.png', (await icon('icon-512.png'))!);
    add('android/store/maskable-512.png', (await icon('maskable-512.png'))!);
  }
  add('android/build-android.yml', `# GitHub Actions: build the signed Android App Bundle for ${b.appName}.
# Put this file in .github/workflows/ of a repository holding the android/ folder of this kit.
# Secrets: ANDROID_KEYSTORE_BASE64 (the upload keystore, base64), ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_PASSWORD.
name: android-${b.slug}
on: { workflow_dispatch: {} }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm install -g @bubblewrap/cli@1
      - name: Keystore
        run: echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > android/android.keystore
        env: { ANDROID_KEYSTORE_BASE64: \${{ secrets.ANDROID_KEYSTORE_BASE64 }} }
      - name: Build
        working-directory: android
        env:
          BUBBLEWRAP_KEYSTORE_PASSWORD: \${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          BUBBLEWRAP_KEY_PASSWORD: \${{ secrets.ANDROID_KEY_PASSWORD }}
        run: |
          yes | bubblewrap doctor || true
          bubblewrap update --skipVersionUpgrade
          bubblewrap build --skipPwaValidation
      - uses: actions/upload-artifact@v4
        with: { name: ${b.slug}-android, path: 'android/*.aab' }
`);

  // ── iOS: a Capacitor shell that opens the web address
  add('ios/capacitor.config.json', J({
    appId: bundle,
    appName: b.appName,
    webDir: 'www',
    server: { url: `${url}/app/`, allowNavigation: [host], cleartext: false },
    ios: { contentInset: 'never', backgroundColor: '#0a1417', limitsNavigationsToAppBoundDomains: true },
    // Notifications also show while the app is open.
    plugins: { PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] } },
  }));
  add('ios/package.json', J({
    name: `${b.slug}-ios`, private: true, version: b.versionName,
    scripts: { sync: 'cap sync ios', open: 'cap open ios' },
    dependencies: { '@capacitor/core': '^7.0.0', '@capacitor/ios': '^7.0.0', '@capacitor/push-notifications': '^7.0.0' },
    devDependencies: { '@capacitor/cli': '^7.0.0' },
  }));
  add('ios/www/index.html', `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${b.appName}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a1417;color:#eaf4f2;font:16px system-ui;text-align:center;padding:24px}</style></head>
<body><div><p><b>${b.appName}</b></p><p>Tidak ada koneksi internet. Periksa koneksi Anda lalu coba lagi.</p><p><a style="color:${pal.dark.accent}" href="${url}/app/">Coba lagi</a></p></div></body></html>
`);
  add('ios/Info.plist.additions.xml', `<!-- Add inside <dict> of ios/App/App/Info.plist -->
<key>NSCameraUsageDescription</key>
<string>${b.appName} memakai kamera untuk memindai kode QR di charger.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>${b.appName} memakai lokasi Anda untuk menampilkan stasiun terdekat.</string>
<key>WKAppBoundDomains</key>
<array><string>${host}</string></array>
<key>NSSupportsLiveActivities</key>
<true/>
<key>CFBundleShortVersionString</key>
<string>${b.versionName}</string>
<key>CFBundleVersion</key>
<string>${b.versionCode}</string>
`);
  add('ios/App.entitlements.additions.xml', `<!-- Add to ios/App/App/App.entitlements (Signing & Capabilities → Associated Domains) -->
<key>com.apple.developer.associated-domains</key>
<array><string>applinks:${host}</string><string>webcredentials:${host}</string></array>
<!-- Signing & Capabilities → + Capability → Push Notifications adds this; "production" for TestFlight and the App Store. -->
<key>aps-environment</key>
<string>production</string>
<!-- Signing & Capabilities → + Capability → Time Sensitive Notifications: "your turn" and reservation reminders come through Focus. -->
<key>com.apple.developer.usernotifications.time-sensitive</key>
<true/>
`);
  add('ios/PlugSureNotifications.swift', `import UserNotifications

/// The buttons on ${b.appName}'s notifications. The app page carries each one out
/// (Capacitor's pushNotificationActionPerformed, with the button's id); the server
/// names the category and where each button leads.
/// Call PlugSureNotifications.registerCategories() in AppDelegate's
/// application(_:didFinishLaunchingWithOptions:), before "return true".
enum PlugSureNotifications {
    static func registerCategories() {
        let en = Locale.preferredLanguages.first?.hasPrefix("en") ?? false
        let stop = UNNotificationAction(identifier: "stop", title: en ? "Stop charging" : "Hentikan pengisian",
                                        options: [.foreground, .destructive, .authenticationRequired])
        let receipt = UNNotificationAction(identifier: "receipt", title: en ? "View receipt" : "Lihat struk", options: [.foreground])
        let pay = UNNotificationAction(identifier: "pay", title: en ? "Pay now" : "Bayar sekarang", options: [.foreground, .authenticationRequired])
        let leave = UNNotificationAction(identifier: "leave", title: en ? "Give up my turn" : "Lepaskan giliran", options: [.foreground, .destructive])
        let cancel = UNNotificationAction(identifier: "cancel", title: en ? "Cancel reservation" : "Batalkan reservasi", options: [.foreground, .destructive])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "PS_SESSION", actions: [stop], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "PS_RECEIPT", actions: [receipt], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "PS_UNPAID", actions: [pay], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "PS_QUEUE", actions: [leave], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "PS_RESERVATION", actions: [cancel], intentIdentifiers: [], options: []),
        ])
    }
}
`);
  add('ios/NotificationService/NotificationService.swift', `import UserNotifications

/// ${b.appName}'s Notification Service Extension: downloads the picture a notification
/// names ("image": the charge's energy and power curve) and attaches it. iOS gives an
/// extension about 30 seconds; without the picture the notification is shown as it came.
/// Xcode: File → New → Target → Notification Service Extension, named "NotificationService";
/// replace its NotificationService.swift with this file.
class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var best: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        best = request.content.mutableCopy() as? UNMutableNotificationContent
        guard let best = best,
              let address = request.content.userInfo["image"] as? String,
              let url = URL(string: address), url.scheme == "https" else {
            contentHandler(request.content)
            return
        }
        URLSession.shared.downloadTask(with: url) { file, response, _ in
            defer { contentHandler(best) }
            guard let file = file, (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            let saved = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString + ".png")
            try? FileManager.default.moveItem(at: file, to: saved)
            if let picture = try? UNNotificationAttachment(identifier: "charge", url: saved, options: nil) {
                best.attachments = [picture]
            }
        }.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler = contentHandler, let content = best { handler(content) }
    }
}
`);

  // ── Live Activities (ActivityKit): a charge under way on the lock screen and in the Dynamic Island.
  add('ios/LiveActivity/ChargingAttributes.swift', `import ActivityKit
import Foundation

/// A charge under way, as ${b.appName} shows it on the lock screen and in the Dynamic Island.
/// Target membership: the App AND the widget extension. Keep the property names: PlugSure
/// sends them (the Live Activity "content-state" and "attributes"); times are Unix seconds.
struct ChargingAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var status: String          // "charging" or "finished"
        var energyWh: Int
        var powerW: Int?
        var socPercent: Int?
        var progressPct: Int?       // of a prepaid allowance
        var costIdr: Int?           // the final cost, once rated
        var estimateIdr: Int?       // the cost so far while charging (tax included); nil once final
        var startedAt: Int
        var endedAt: Int?
    }
    var ref: String                 // the charge (or, started by push, the session)
    var site: String
    var connector: String
    var appName: String
    var accentHex: String
}

extension ChargingAttributes.ContentState {
    static let english = Locale.preferredLanguages.first?.hasPrefix("en") ?? false
    var started: Date { Date(timeIntervalSince1970: TimeInterval(startedAt)) }
    var ended: Date? { endedAt.map { Date(timeIntervalSince1970: TimeInterval($0)) } }
    var finished: Bool { status == "finished" }
    var energyText: String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: Self.english ? "en_US" : "id_ID")
        f.minimumFractionDigits = 1
        f.maximumFractionDigits = 1
        return (f.string(from: NSNumber(value: Double(energyWh) / 1000)) ?? "0") + " kWh"
    }
    var powerText: String? { powerW.map { "\\(Int((Double($0) / 1000).rounded())) kW" } }
    var costText: String? { costIdr.map(Self.rupiah) }
    var estimateText: String? { estimateIdr.map(Self.rupiah) }
    /// The cost so far, labelled; the final cost replaces it once rated.
    var runningCostText: String? {
        guard costIdr == nil, let e = estimateText else { return nil }
        return Self.english ? "Cost so far \\(e)" : "Biaya sejauh ini \\(e)"
    }
    static func rupiah(_ c: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "id_ID")
        return "Rp " + (f.string(from: NSNumber(value: c)) ?? "\\(c)")
    }
}
`);
  add('ios/LiveActivity/ChargingLiveActivity.swift', `import ActivityKit
import SwiftUI
import WidgetKit

/// ${b.appName}'s Live Activity: the widget extension's only widget.
/// Xcode: File → New → Target → Widget Extension ("ChargingWidgets", iOS 16.2+),
/// replace its generated Swift with this file, and add ChargingAttributes.swift to it.
@main
struct ChargingWidgets: WidgetBundle {
    var body: some Widget { ChargingLiveActivity() }
}

struct ChargingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ChargingAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state, stale: context.isStale)
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(Color(hex: context.attributes.accentHex))
        } dynamicIsland: { context in
            let accent = Color(hex: context.attributes.accentHex)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.state.energyText, systemImage: "bolt.fill").font(.headline).foregroundStyle(accent)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(context.state.finished ? (context.state.costText ?? context.state.estimateText.map { "≈ " + $0 } ?? "") : (context.state.powerText ?? ""))
                            .font(.headline)
                        if !context.state.finished, let e = context.state.estimateText {
                            Text(e).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text(context.attributes.site).lineLimit(1)
                        Spacer()
                        ElapsedText(state: context.state)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            } compactLeading: {
                Image(systemName: context.state.finished ? "checkmark.circle.fill" : "bolt.fill").foregroundStyle(accent)
            } compactTrailing: {
                Text(context.state.energyText).font(.caption2).monospacedDigit()
            } minimal: {
                Image(systemName: "bolt.fill").foregroundStyle(accent)
            }
            .keylineTint(accent)
        }
    }
}

/// Time since the start, counted by the phone itself (no push needed); the duration once finished.
struct ElapsedText: View {
    let state: ChargingAttributes.ContentState
    var body: some View {
        Group {
            if let end = state.ended {
                Text("\\(Int(end.timeIntervalSince(state.started) / 60)) min")
            } else {
                Text(state.started, style: .timer)
            }
        }
        .monospacedDigit()
    }
}

struct LockScreenView: View {
    let attributes: ChargingAttributes
    let state: ChargingAttributes.ContentState
    let stale: Bool

    var body: some View {
        let accent = Color(hex: attributes.accentHex)
        let en = ChargingAttributes.ContentState.english
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: state.finished ? "checkmark.circle.fill" : "bolt.fill").foregroundStyle(accent)
                Text(attributes.appName).font(.caption).bold()
                Text("· " + attributes.site).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                ElapsedText(state: state).font(.caption).foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline) {
                Text(state.energyText).font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                Spacer()
                if state.finished {
                    Text(state.costText ?? state.estimateText.map { "≈ " + $0 } ?? (en ? "Finished" : "Selesai")).font(.title3.bold()).foregroundStyle(accent)
                } else if let p = state.powerText {
                    Text(p).font(.title3.bold()).foregroundStyle(accent)
                }
            }
            if !state.finished, let c = state.runningCostText {
                Text(c).font(.subheadline.weight(.semibold)).monospacedDigit()
            }
            if let pct = state.socPercent ?? state.progressPct {
                ProgressView(value: Double(pct), total: 100).tint(accent)
                Text(state.socPercent != nil ? (en ? "Battery \\(pct)%" : "Baterai \\(pct)%") : (en ? "\\(pct)% of what you paid for" : "\\(pct)% dari yang dibayar"))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if stale && !state.finished {
                Text(en ? "Waiting for the charger…" : "Menunggu data charger…").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .foregroundStyle(.white)
    }
}

extension Color {
    init(hex: String) {
        let v = UInt64(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0x2fd6a7
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}
`);
  add('ios/LiveActivity/LiveActivityPlugin.swift', `import ActivityKit
import Capacitor
import Foundation

/// Lets the app page start a Live Activity for a charge, and hands ${b.appName}'s server the
/// tokens to update it and — iOS 17.2+ — to start one by push. Target: the App.
/// Registered by MyViewController; used from the page as Capacitor.Plugins.LiveActivity.
@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "observe", returnType: CAPPluginReturnPromise),
    ]
    private var watched = Set<String>()

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 16.2, *) {
            call.resolve(["available": ActivityAuthorizationInfo().areActivitiesEnabled])
        } else {
            call.resolve(["available": false])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.reject("Live Activities need iOS 16.2"); return }
        let ref = call.getString("chargeId") ?? ""
        // One activity per charge: one started by push for the same charge is reused.
        if let existing = Activity<ChargingAttributes>.activities.first(where: { $0.attributes.ref == ref }) {
            DispatchQueue.main.async { self.watch(existing) }
            call.resolve(["id": existing.id])
            return
        }
        let attributes = ChargingAttributes(ref: ref, site: call.getString("site") ?? "", connector: call.getString("connector") ?? "",
                                            appName: call.getString("appName") ?? "", accentHex: call.getString("accent") ?? "#2fd6a7")
        let state = ChargingAttributes.ContentState(status: "charging", energyWh: call.getInt("energyWh") ?? 0, powerW: call.getInt("powerW"),
                                                    socPercent: nil, progressPct: nil, costIdr: nil, estimateIdr: nil,
                                                    startedAt: call.getInt("startedAt") ?? Int(Date().timeIntervalSince1970), endedAt: nil)
        do {
            let activity = try Activity.request(attributes: attributes,
                                                content: .init(state: state, staleDate: Date().addingTimeInterval(180)),
                                                pushType: .token)
            DispatchQueue.main.async { self.watch(activity) }
            call.resolve(["id": activity.id])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    /// Activities already running or started by push report their tokens; iOS 17.2+ also gives a push-to-start token.
    @objc func observe(_ call: CAPPluginCall) {
        guard #available(iOS 16.2, *) else { call.resolve(["pushToStart": false]); return }
        DispatchQueue.main.async { Activity<ChargingAttributes>.activities.forEach { self.watch($0) } }
        Task {
            for await activity in Activity<ChargingAttributes>.activityUpdates {
                DispatchQueue.main.async { self.watch(activity) }
            }
        }
        if #available(iOS 17.2, *) {
            Task {
                for await data in Activity<ChargingAttributes>.pushToStartTokenUpdates {
                    self.notifyListeners("startToken", data: ["token": data.map { String(format: "%02x", $0) }.joined()], retainUntilConsumed: true)
                }
            }
            call.resolve(["pushToStart": true])
        } else {
            call.resolve(["pushToStart": false])
        }
    }

    @available(iOS 16.2, *)
    private func watch(_ activity: Activity<ChargingAttributes>) {
        guard !watched.contains(activity.id) else { return }
        watched.insert(activity.id)
        let ref = activity.attributes.ref
        Task {
            for await data in activity.pushTokenUpdates {
                self.notifyListeners("token", data: ["chargeId": ref, "token": data.map { String(format: "%02x", $0) }.joined()], retainUntilConsumed: true)
            }
        }
        Task {
            for await state in activity.activityStateUpdates where state == .dismissed {
                self.notifyListeners("ended", data: ["chargeId": ref], retainUntilConsumed: true)
            }
        }
    }
}
`);
  add('ios/LiveActivity/MyViewController.swift', `import Capacitor
import UIKit

/// Registers ${b.appName}'s own Capacitor plugin (LiveActivity). Target: the App.
/// In Main.storyboard, set the Bridge View Controller's Custom Class to MyViewController.
class MyViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LiveActivityPlugin())
    }
}
`);
  add('ios/AppDelegate.additions.swift', `// Add these two methods inside class AppDelegate in ios/App/App/AppDelegate.swift.
// They hand the device token (or the error) to Capacitor's PushNotifications plugin,
// which the app page uses to register the iPhone with ${b.appName}.
import Capacitor

func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
}

func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
}
`);
  add('ios/apple-app-site-association', J(appleAssociation({ ...b, iosBundleId: bundle, iosTeamId: b.iosTeamId ?? 'TEAMID0000' })));
  if (b.hasIcon) add('ios/AppIcon-1024.png', (await icon('appstore-1024.png'))!);

  // ── Store listings
  const desc = (lang: 'id' | 'en') => lang === 'id'
    ? `${b.appName} adalah aplikasi resmi untuk mengisi daya mobil listrik di stasiun ${b.appName}.

• Temukan stasiun terdekat di peta, dengan ketersediaan langsung dan harga per kWh.
• Pindai kode QR di charger dan mulai mengisi daya — bayar dengan QRIS, e-wallet atau kartu.
• Pantau pengisian dari ponsel dan terima notifikasi saat selesai.
• Pesan konektor dan antre di lokasi yang ramai.
• Struk pajak (PPN dan PBJT) langsung di aplikasi.
${b.supportEmail || b.supportPhone ? `\nBantuan: ${[b.supportEmail, b.supportPhone].filter(Boolean).join(' · ')}` : ''}`
    : `${b.appName} is the official app for charging your electric car at ${b.appName} stations.

• Find nearby stations on the map, with live availability and the price per kWh.
• Scan the QR code on the charger and start charging — pay with QRIS, e-wallets or cards.
• Follow the charge on your phone and get a notification when it is done.
• Reserve a connector, and queue at busy sites.
• Tax receipts (PPN and PBJT) in the app.
${b.supportEmail || b.supportPhone ? `\nSupport: ${[b.supportEmail, b.supportPhone].filter(Boolean).join(' · ')}` : ''}`;
  for (const lang of ['id', 'en'] as const) {
    add(`store/listing-${lang}.md`, `# ${b.appName} — store listing (${lang === 'id' ? 'Bahasa Indonesia' : 'English'})

**App name (≤ 30):** ${b.appName}

**Short description (≤ 80):** ${(lang === 'id' ? b.descriptionId : b.descriptionEn) ?? (lang === 'id' ? `Isi daya mobil listrik di stasiun ${b.appName}.` : `Charge your electric car at ${b.appName} stations.`)}

**Category:** ${lang === 'id' ? 'Mobil & Kendaraan (Google Play) · Navigasi (App Store)' : 'Auto & Vehicles (Google Play) · Navigation (App Store)'}

**Privacy policy:** ${b.privacyUrl ?? '(required — set it in the console)'}
**Terms of use:** ${b.termsUrl ?? '(optional)'}
**Support:** ${[b.supportEmail, b.supportPhone].filter(Boolean).join(' · ') || '(set a support e-mail or phone in the console)'}
**Website:** ${url}/app/

## Full description (≤ 4000)

${desc(lang)}
`);
  }
  add('store/data-safety.md', `# Data safety / App privacy answers for ${b.appName}

What the app collects, as built by PlugSure (check against your own practices and privacy policy):

| Data | Collected | Why | Shared | Notes |
|---|---|---|---|---|
| Phone number | Yes, when the driver signs in | Account, sign-in codes, receipts | With the WhatsApp / SMS provider that sends the code | Optional: guests can pay by QRIS without an account |
| Name | Optional | Shown on the account and receipts | No | |
| Approximate / precise location | Only while the app is open, when the driver taps "near me" | Nearest stations | No | Not stored on the server |
| Payment information | No card numbers | Payments are made on the acquirer's page (Midtrans / Xendit); PlugSure keeps only the acquirer's token, the card brand and last 4 digits | With the payment acquirer | |
| Purchase history | Yes | Charging history and tax receipts | With the operator; with a roaming partner for roaming charges | |
| Device identifiers | A random device token | Keeps the driver signed in | No | Not the advertising ID |
| Push notification token | When the driver switches notifications on | Charging started / finished, receipts | With the push service (Google / Apple / Mozilla) | |

- Data is encrypted in transit (HTTPS).
- Drivers can ask for their account to be deleted through the support contact${b.supportEmail ? ` (${b.supportEmail})` : ''}.
- No advertising, no tracking across other companies' apps (App Store: "Data Not Used to Track You").
`);

  add('README.md', `# ${b.appName} — build kit

Generated by PlugSure for **${b.appName}** (\`${b.slug}\`), version ${b.versionName} (${b.versionCode}).
The apps open **${url}/app/**, which PlugSure serves with your name, colours and icon, showing only your stations.
${warnings.length ? `\n## Before you build\n\n${warnings.map((w) => `- ${w}`).join('\n')}\n` : ''}
## 1. The web address

1. Point \`${host}\` at the PlugSure driver host (DNS \`CNAME\` to it, or an \`A\` record to its address). The certificate is issued automatically.
2. Check \`${url}/app/\` shows your app, and \`${url}/.well-known/assetlinks.json\` and \`${url}/.well-known/apple-app-site-association\` answer.

## 2. Android (Google Play) — Trusted Web Activity

Needs: a Google Play developer account, JDK 17, Node 22, \`npm i -g @bubblewrap/cli\`.

1. Create the upload key once and keep it safe (losing it means a new listing):
   \`keytool -genkeypair -v -keystore android/android.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000\`
2. In the console (Commercial → Driver app → Store builds), add the SHA-256 fingerprints of **both** the upload key
   (\`keytool -list -v -keystore android/android.keystore -alias upload\`) and, after the first upload, Play's **app signing key**
   (Play Console → Test and release → App integrity). Without them the app opens with a browser bar.
3. \`cd android && bubblewrap build\` (or run \`build-android.yml\` in GitHub Actions). Upload \`app-release-bundle.aab\` to Play Console.
4. Store listing texts: \`store/listing-id.md\`, \`store/listing-en.md\`. Icon: \`android/store/icon-512.png\`. Data safety: \`store/data-safety.md\`.

For each new release, raise the version code in the console and download the kit again.

## 3. iOS (App Store) — Capacitor shell

Needs: an Apple Developer account (Team ID ${b.iosTeamId ?? 'not set yet'}), a Mac with Xcode 16, Node 22.

1. \`cd ios && npm install && npx cap add ios && npx cap sync ios\`
2. Copy the keys in \`Info.plist.additions.xml\` and \`App.entitlements.additions.xml\` into the Xcode project, and the two methods in \`AppDelegate.additions.swift\` into \`AppDelegate.swift\`; set the app icon from \`AppIcon-1024.png\`.
3. Signing & Capabilities: team, bundle \`${bundle}\`, Associated Domains \`applinks:${host}\`, and **Push Notifications**.
4. Notifications: in the Apple Developer account, Certificates, Identifiers & Profiles → Keys → **+**, tick *Apple Push Notifications service (APNs)*, download the \`.p8\` (once only) and note its Key ID. Upload both in the console (Commercial → Driver app → iOS notifications); PlugSure checks them with Apple. ${b.apnsConfigured ? `The key ${b.apnsKeyId} is uploaded${b.apnsCheckOk ? ' and was accepted by Apple' : ''}.` : 'Not uploaded yet.'}
5. Rich notifications:
   - add \`PlugSureNotifications.swift\` to the App target and call \`PlugSureNotifications.registerCategories()\` in \`application(_:didFinishLaunchingWithOptions:)\` — the buttons: stop charging, view receipt, pay now, give up my turn, cancel reservation;
   - File → New → Target → **Notification Service Extension** named \`NotificationService\`, and replace its source with \`NotificationService/NotificationService.swift\` — the picture of the charge on "charging finished";
   - Signing & Capabilities → **Time Sensitive Notifications** — "your turn" and reservation reminders come through Focus.
   The badge on the app icon counts sessions waiting to be paid; nothing to set up.
6. Live Activities (a charge under way on the lock screen and in the Dynamic Island; iOS 16.2+):
   - File → New → Target → **Widget Extension** named \`ChargingWidgets\` (deployment target iOS 16.2), and replace its source with \`LiveActivity/ChargingLiveActivity.swift\`;
   - add \`LiveActivity/ChargingAttributes.swift\` to **both** the App and \`ChargingWidgets\` (Target Membership);
   - add \`LiveActivity/LiveActivityPlugin.swift\` and \`LiveActivity/MyViewController.swift\` to the App, and in \`Main.storyboard\` set the Bridge View Controller's class to \`MyViewController\`;
   - \`NSSupportsLiveActivities\` is in \`Info.plist.additions.xml\`.
   The app starts the activity when a charge starts in it; PlugSure updates and ends it with your APNs key. On iOS 17.2+ PlugSure can also start it when a charge starts without the app (a fleet card at the charger).
7. \`npx cap open ios\`, then Product → Archive, and upload to App Store Connect.

**Know before you submit:**
- Apple reviews apps that mainly show a website strictly (guideline 4.2). This app is a full charging service (maps, payments, live charging), which is usually accepted; describe those features in the review notes and give a test account.
- **Notifications** in the iOS app are native (APNs), sent with your key: charging started and finished, receipts, refunds, reservations and the queue. A build run from Xcode gets development tokens; PlugSure finds the right APNs server by itself. The first time a driver switches notifications on, iOS asks for permission.
- Payments are for a real-world service (charging), so Apple's in-app purchase rules do not apply.

## Files

${[...files.map((f) => f.name), 'README.md'].sort().map((n) => `- \`${n}\``).join('\n')}
`);
  return { zip: buildZip(files), files: files.map((f) => f.name), warnings };
}

// ─────────────────────────────────────────────── native iOS notifications (APNs)

/**
 * Store the operator's APNs key (sealed) and check it with Apple at once. The
 * key signs for the whole Apple team; the brand's bundle id is the topic.
 */
export async function saveApnsKey(orgId: string, keyIdRaw: unknown, p8Raw: unknown): Promise<Brand> {
  const b = await brandOf(orgId);
  if (!b) throw new BrandError(404, 'Set up the driver app first.');
  if (!b.iosTeamId || !b.iosBundleId) throw new BrandError(409, 'Enter the Apple Team ID and the iOS bundle identifier first: the key is checked against them.', { apnsKeyId: 'ios' });
  const keyId = String(keyIdRaw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new BrandError(422, 'The Key ID is the 10-character id shown with the key in the Apple Developer account.', { apnsKeyId: 'format' });
  const p8 = String(p8Raw ?? '').replace(/\r\n/g, '\n').trim();
  const problem = p8Problem(p8);
  if (problem) throw new BrandError(422, problem, { apnsKey: 'format' });
  if (b.apnsKeyId) forgetProviderToken(b.iosTeamId, b.apnsKeyId);
  const check = await checkCredentials({ teamId: b.iosTeamId, keyId, p8, topic: b.iosBundleId });
  await query(
    `UPDATE driver_app_brand SET apns_key_id = $2, apns_key_sealed = $3, apns_checked_at = now(), apns_check_ok = $4, apns_check_detail = $5, updated_at = now() WHERE org_id = $1`,
    [orgId, keyId, seal(p8), check.ok, check.detail],
  );
  forgetBrands();
  return (await brandOf(orgId))!;
}

export async function recheckApns(orgId: string): Promise<Brand> {
  const c = await apnsCredentialsFor(orgId);
  if (!c) throw new BrandError(409, 'Upload the notifications key (APNs) first, with the Team ID and bundle identifier.');
  const check = await checkCredentials(c);
  await query(`UPDATE driver_app_brand SET apns_checked_at = now(), apns_check_ok = $2, apns_check_detail = $3 WHERE org_id = $1`, [orgId, check.ok, check.detail]);
  forgetBrands();
  return (await brandOf(orgId))!;
}

export async function removeApnsKey(orgId: string): Promise<void> {
  await query(`UPDATE driver_app_brand SET apns_key_id = NULL, apns_key_sealed = NULL, apns_checked_at = NULL, apns_check_ok = NULL, apns_check_detail = NULL, updated_at = now() WHERE org_id = $1`, [orgId]);
  forgetBrands();
}

/** Record that Apple refused the key while sending (the console shows it). */
/**
 * Apple refused the credentials a send used. Marked on the brand only if they are still the
 * brand's credentials: the gateway caches them for up to 30 s, so right after an operator replaces
 * the key a send can go out with the OLD one. Marking that refusal would flag the new, working key
 * as refused in the console. Either way the cache is dropped, so the next send uses what is stored.
 */
export async function markApnsRefused(orgId: string, detail: string, used?: Pick<ApnsCredentials, 'teamId' | 'keyId'>): Promise<void> {
  await query(
    `UPDATE driver_app_brand SET apns_checked_at = now(), apns_check_ok = false, apns_check_detail = $2
      WHERE org_id = $1 AND apns_check_ok IS DISTINCT FROM false
        AND ($3::text IS NULL OR (apns_key_id = $3 AND ios_team_id = $4))`,
    [orgId, detail, used?.keyId ?? null, used?.teamId ?? null]);
  forgetBrands();
}

const credCache = new Map<string, { at: number; c: ApnsCredentials | null }>();

/** The APNs credentials of a brand's iOS app (the worker, outside any request). */
export async function apnsCredentialsFor(orgId: string): Promise<ApnsCredentials | null> {
  const hit = credCache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.c;
  const r = await one<{ ios_team_id: string | null; ios_bundle_id: string | null; apns_key_id: string | null; apns_key_sealed: string | null }>(
    `SELECT ios_team_id, ios_bundle_id, apns_key_id, apns_key_sealed FROM driver_app_brand WHERE org_id = $1`, [orgId],
  );
  const c = r?.ios_team_id && r.ios_bundle_id && r.apns_key_id && r.apns_key_sealed
    ? { teamId: r.ios_team_id, keyId: r.apns_key_id, p8: unseal(r.apns_key_sealed), topic: r.ios_bundle_id }
    : null;
  credCache.set(orgId, { at: Date.now(), c });
  return c;
}

// ─────────────────────────────────────────────── native Android notifications (FCM)

const fcmCache = new Map<string, { at: number; c: FcmCredentials | null }>();

/**
 * Store the brand's Firebase service account (sealed) and check it with Google at once. One per brand: the Android
 * app's Firebase project (its google-services.json) must be the same project.
 */
export async function saveFcmServiceAccount(orgId: string, json: unknown): Promise<Brand> {
  const b = await brandOf(orgId);
  if (!b) throw new BrandError(404, 'Set up the driver app first.');
  const parsed = parseServiceAccount(json);
  if (!parsed.ok) throw new BrandError(422, parsed.error, { fcmServiceAccount: 'format' });
  const check = await checkFcmCredentials(parsed.creds);
  const text = typeof json === 'string' ? json : JSON.stringify(json);
  await query(
    `UPDATE driver_app_brand SET fcm_project_id = $2, fcm_client_email = $3, fcm_sa_sealed = $4, fcm_checked_at = now(), fcm_check_ok = $5,
            fcm_check_detail = $6, updated_at = now() WHERE org_id = $1`,
    [orgId, parsed.creds.projectId, parsed.creds.clientEmail, seal(text), check.ok, check.detail],
  );
  forgetBrands();
  return (await brandOf(orgId))!;
}

export async function recheckFcm(orgId: string): Promise<Brand> {
  const c = await fcmCredentialsFor(orgId);
  if (!c) throw new BrandError(409, 'Upload the Firebase service account (Android notifications) first.');
  forgetFcmToken(c);
  const check = await checkFcmCredentials(c);
  await query(`UPDATE driver_app_brand SET fcm_checked_at = now(), fcm_check_ok = $2, fcm_check_detail = $3 WHERE org_id = $1`, [orgId, check.ok, check.detail]);
  forgetBrands();
  return (await brandOf(orgId))!;
}

export async function removeFcm(orgId: string): Promise<void> {
  await query(`UPDATE driver_app_brand SET fcm_project_id = NULL, fcm_client_email = NULL, fcm_sa_sealed = NULL, fcm_checked_at = NULL,
                      fcm_check_ok = NULL, fcm_check_detail = NULL, updated_at = now() WHERE org_id = $1`, [orgId]);
  forgetBrands();
}

/** Google refused the service account while sending (marked only if it is still the brand's account). */
export async function markFcmRefused(orgId: string, detail: string, used?: Pick<FcmCredentials, 'clientEmail'>): Promise<void> {
  await query(
    `UPDATE driver_app_brand SET fcm_checked_at = now(), fcm_check_ok = false, fcm_check_detail = $2
      WHERE org_id = $1 AND fcm_check_ok IS DISTINCT FROM false AND ($3::text IS NULL OR fcm_client_email = $3)`,
    [orgId, detail, used?.clientEmail ?? null]);
  forgetBrands();
}

/** The FCM credentials of a brand's Android app (the worker, outside any request). */
export async function fcmCredentialsFor(orgId: string): Promise<FcmCredentials | null> {
  const hit = fcmCache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.c;
  const r = await one<{ fcm_sa_sealed: string | null }>(`SELECT fcm_sa_sealed FROM driver_app_brand WHERE org_id = $1`, [orgId]);
  let c: FcmCredentials | null = null;
  if (r?.fcm_sa_sealed) {
    const p = parseServiceAccount(unseal(r.fcm_sa_sealed));
    c = p.ok ? p.creds : null;
  }
  fcmCache.set(orgId, { at: Date.now(), c });
  return c;
}

/** The brand's native app configuration as stored (validated in driver/app-config.ts). */
export async function saveAppConfig(orgId: string, cfg: Record<string, unknown>): Promise<Brand> {
  const r = await one<Row>(`UPDATE driver_app_brand SET app_config = $2::jsonb, updated_at = now() WHERE org_id = $1 RETURNING ${COLS}`, [orgId, JSON.stringify(cfg)]);
  if (!r) throw new BrandError(404, 'Set up the driver app first.');
  forgetBrands();
  return toBrand(r);
}
