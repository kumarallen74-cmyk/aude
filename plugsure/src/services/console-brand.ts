import { createHash } from 'node:crypto';
import { one, query, outsideRequestScope } from '../db/pool.js';
import { decodePng, encodePng, pngSize, resize, PngError } from './png.js';
import { BrandError, HOST_RE, reservedHosts, contrast, mix, onFill } from './brand.js';

/**
 * White-label operator console (v1.5.0).
 *
 * An operator may give its console its own name, tagline, colours and logo, and
 * a web address of its own. Every user of the operator sees the brand once
 * signed in (staff, and the site-owner and fleet portals). On the brand's web
 * address the sign-in page shows it too, and only the operator's own accounts
 * may sign in there. Without a brand the console is PlugSure's, unchanged.
 *
 * The web address takes effect only once the platform operator approves it
 * (platform:admin, when adding its Caddy site block). Otherwise an operator could
 * claim the shared console's own name, or another operator's, and decide who may
 * sign in there. Changing the address withdraws the approval.
 *
 * The brand is read before anyone has signed in (the sign-in page, the logo), so
 * those lookups run unscoped; everything that changes it runs in the operator's
 * own request scope.
 */

export interface ConsoleBrand {
  orgId: string;
  productName: string;
  tagline: string | null;
  brandColor: string;
  accentColor: string;
  hasLogo: boolean;
  logoSha256: string | null;
  hostname: string | null;
  /** The platform operator approved the web address: only then does it take effect. */
  hostnameApproved: boolean;
  hostnameApprovedAt: string | null;
  showPoweredBy: boolean;
  updatedAt: string;
}

interface Row {
  org_id: string; product_name: string; tagline: string | null; brand_color: string; accent_color: string;
  logo_sha256: string | null; hostname: string | null; hostname_approved_at: Date | null; show_powered_by: boolean; updated_at: Date;
}
const COLS = 'org_id, product_name, tagline, brand_color, accent_color, logo_sha256, hostname, hostname_approved_at, show_powered_by, updated_at';
const toBrand = (r: Row): ConsoleBrand => ({
  orgId: r.org_id, productName: r.product_name, tagline: r.tagline, brandColor: r.brand_color, accentColor: r.accent_color,
  hasLogo: !!r.logo_sha256, logoSha256: r.logo_sha256, hostname: r.hostname,
  hostnameApproved: !!r.hostname_approved_at, hostnameApprovedAt: r.hostname_approved_at?.toISOString() ?? null,
  showPoweredBy: r.show_powered_by,
  updatedAt: r.updated_at.toISOString(),
});

// ─────────────────────────────────────────────── lookups (cached briefly; cleared on every change)

const CACHE_MS = 30_000;
const byHost = new Map<string, { at: number; brand: ConsoleBrand | null }>();
const byOrg = new Map<string, { at: number; brand: ConsoleBrand | null }>();
const logos = new Map<string, Buffer>();

export function forgetConsoleBrands(): void { byHost.clear(); byOrg.clear(); logos.clear(); }

async function cached(map: Map<string, { at: number; brand: ConsoleBrand | null }>, key: string, load: () => Promise<Row | null>) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.brand;
  const r = await load();
  const brand = r ? toBrand(r) : null;
  map.set(key, { at: Date.now(), brand });
  return brand;
}

export const hostOf = (host: string | undefined) => String(host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

/**
 * The brand whose APPROVED console web address this is (the sign-in page and its
 * sign-in restriction; unscoped: nobody has signed in yet). PlugSure's own
 * addresses never match, even if a row somehow named one.
 */
export function consoleBrandForHost(host: string | undefined): Promise<ConsoleBrand | null> {
  const h = hostOf(host);
  if (!h || !HOST_RE.test(h) || reservedHosts().has(h)) return Promise.resolve(null);
  return cached(byHost, h, () => outsideRequestScope(() =>
    one<Row>(`SELECT ${COLS} FROM console_brand WHERE hostname = $1 AND hostname_approved_at IS NOT NULL`, [h])));
}

/** The operator's console brand, or null for PlugSure's. */
export const consoleBrandForOrg = (orgId: string) =>
  cached(byOrg, orgId, () => one<Row>(`SELECT ${COLS} FROM console_brand WHERE org_id = $1`, [orgId]));

/** A logo by its hash (public: the sign-in page shows it). */
export async function logoBySha(sha: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  const hit = logos.get(sha);
  if (hit) return hit;
  // Content-addressed: any row with this hash holds the same bytes.
  const r = await outsideRequestScope(() => one<{ logo_png: Buffer }>(`SELECT logo_png FROM console_brand WHERE logo_sha256 = $1 LIMIT 1`, [sha]));
  if (!r) return null;
  if (logos.size > 200) logos.clear();
  logos.set(sha, r.logo_png);
  return r.logo_png;
}

// ─────────────────────────────────────────────── colours (WCAG AA in both console themes)

/** The console's own surfaces (src/web/assets/app.css). */
const LIGHT = ['#ffffff', '#f4f6f9', '#f8f9fb', '#eceff4'];
const DARK = ['#0d1117', '#11161d', '#151b23', '#1a212b'];

export interface ConsoleTheme { accent: string; ink: string; soft: string; contrast: number }
export interface ConsolePalette {
  light: ConsoleTheme;
  dark: ConsoleTheme;
  /** The brand colour as used: the logo tile, avatars and the sign-in panel, under white text. */
  brand: string;
  brandDeep: string;
  /** True when a colour was nudged to stay readable. */
  adjusted: boolean;
}

/**
 * The accent as text and icons on every surface and on its own soft tint (tags),
 * at 4.5:1 or more: nudged darker for the light theme, lighter for the dark one.
 */
function themeFor(accent: string, surfaces: string[], toward: string, softBase: string, softShare: number): ConsoleTheme {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(accent, toward, t);
    const soft = mix(c, softBase, softShare);
    const worst = Math.min(...[...surfaces, soft].map((s) => contrast(c, s)));
    if (worst >= 4.5) return { accent: c, ink: onFill(c), soft, contrast: Math.round(worst * 100) / 100 };
  }
  const c = toward;
  return { accent: c, ink: onFill(c), soft: mix(c, softBase, softShare), contrast: Math.round(Math.min(...surfaces.map((s) => contrast(c, s))) * 100) / 100 };
}

export function consolePalette(brandColor: string, accentColor: string): ConsolePalette {
  const light = themeFor(accentColor, LIGHT, '#000000', '#ffffff', 0.88);
  const dark = themeFor(accentColor, DARK, '#ffffff', '#151b23', 0.78);
  // White text on the brand colour (avatar initials, the sign-in panel) at 4.5:1 or more.
  let brand = brandColor;
  for (let t = 0; contrast(brand, '#ffffff') < 4.5 && t <= 1.0001; t += 0.02) brand = mix(brandColor, '#000000', t);
  return {
    light, dark, brand, brandDeep: mix(brand, '#000000', 0.35),
    adjusted: light.accent !== accentColor || dark.accent !== accentColor || brand !== brandColor,
  };
}

// ─────────────────────────────────────────────── validation and saving

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .&'’\-]*$/u;
const COLOR_RE = /^#[0-9a-f]{6}$/;

export interface ConsoleBrandInput {
  productName?: unknown; tagline?: unknown; brandColor?: unknown; accentColor?: unknown; hostname?: unknown; showPoweredBy?: unknown;
}

/**
 * Is this address in use by another operator's approved console, or by any driver app?
 * (Unscoped: across operators.) A claim still waiting for approval blocks nobody, so an
 * operator cannot squat another's planned address.
 */
export async function hostnameTaken(hostname: string, orgId: string): Promise<'console' | 'driver_app' | null> {
  const r = await outsideRequestScope(() => one<{ what: string }>(
    `SELECT 'console' AS what FROM console_brand WHERE hostname = $1 AND org_id <> $2 AND hostname_approved_at IS NOT NULL
     UNION ALL SELECT 'driver_app' FROM driver_app_brand WHERE hostname = $1
     LIMIT 1`,
    [hostname, orgId],
  ));
  return (r?.what as 'console' | 'driver_app' | undefined) ?? null;
}

export async function saveConsoleBrand(orgId: string, input: ConsoleBrandInput): Promise<ConsoleBrand> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BrandError(422, 'Send the brand as a JSON object.');
  const cur = await consoleBrandForOrgFresh(orgId);
  const errors: Record<string, string> = {};
  const str = (k: keyof ConsoleBrandInput, fallback: string | null): string | null => {
    if (!(k in input)) return fallback;
    const v = input[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') { errors[k] = 'Must be text.'; return fallback; }
    const t = v.trim();
    return t === '' ? null : t;
  };

  const productName = str('productName', cur?.productName ?? null);
  if (!productName) errors.productName = 'A name is required (it replaces “PlugSure” in the console).';
  else if (productName.length > 30 || !NAME_RE.test(productName)) errors.productName = 'Up to 30 letters, digits, spaces and . & \' -';

  const tagline = str('tagline', cur?.tagline ?? null);
  if (tagline && (tagline.length > 30 || !NAME_RE.test(tagline))) errors.tagline = 'Up to 30 letters, digits, spaces and . & \' -';

  const colour = (k: 'brandColor' | 'accentColor', fallback: string) => {
    const v = str(k, fallback)?.toLowerCase() ?? fallback;
    if (!COLOR_RE.test(v)) { errors[k] = 'A colour such as #1b4d8c.'; return fallback; }
    return v;
  };
  const brandColor = colour('brandColor', cur?.brandColor ?? '#1b4d8c');
  const accentColor = colour('accentColor', cur?.accentColor ?? '#0c7856');

  let hostname = str('hostname', cur?.hostname ?? null);
  if (hostname) {
    hostname = hostname.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
    if (!HOST_RE.test(hostname)) errors.hostname = 'A domain name such as console.example.co.id (no https://, no path).';
    else if (reservedHosts().has(hostname)) errors.hostname = 'This is one of PlugSure’s own addresses; use a domain of your own.';
  }

  let showPoweredBy = cur?.showPoweredBy ?? true;
  if ('showPoweredBy' in input) {
    if (typeof input.showPoweredBy !== 'boolean') errors.showPoweredBy = 'true or false.';
    else showPoweredBy = input.showPoweredBy;
  }

  if (Object.keys(errors).length) throw new BrandError(422, 'Some fields need attention.', errors);

  if (hostname) {
    const taken = await hostnameTaken(hostname, orgId);
    if (taken) throw new BrandError(409, taken === 'console' ? 'Another operator’s console already uses this web address.' : 'A driver app already uses this web address; the console needs one of its own.', { hostname: 'taken' });
  }

  // A new (or removed) address withdraws the platform operator's approval of the old one.
  await query(
    `INSERT INTO console_brand (org_id, product_name, tagline, brand_color, accent_color, hostname, show_powered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id) DO UPDATE SET product_name = $2, tagline = $3, brand_color = $4, accent_color = $5,
       hostname = $6, show_powered_by = $7, updated_at = now(),
       hostname_approved_at = CASE WHEN console_brand.hostname IS NOT DISTINCT FROM $6 THEN console_brand.hostname_approved_at END,
       hostname_approved_by = CASE WHEN console_brand.hostname IS NOT DISTINCT FROM $6 THEN console_brand.hostname_approved_by END`,
    [orgId, productName, tagline, brandColor, accentColor, hostname, showPoweredBy],
  );
  forgetConsoleBrands();
  return (await consoleBrandForOrgFresh(orgId))!;
}

async function consoleBrandForOrgFresh(orgId: string): Promise<ConsoleBrand | null> {
  const r = await one<Row>(`SELECT ${COLS} FROM console_brand WHERE org_id = $1`, [orgId]);
  return r ? toBrand(r) : null;
}

// ─────────────────────────────────────────────── the platform operator's approval of web addresses

export interface HostnameClaim {
  orgId: string; orgName: string; productName: string; hostname: string; approvedAt: string | null; updatedAt: string;
}

/** Every operator's console web address, approved or waiting (platform:admin; across operators). */
export async function listHostnameClaims(): Promise<HostnameClaim[]> {
  const rows = await outsideRequestScope(() => query<{ org_id: string; org_name: string; product_name: string; hostname: string; hostname_approved_at: Date | null; updated_at: Date }>(
    `SELECT b.org_id, o.name AS org_name, b.product_name, b.hostname, b.hostname_approved_at, b.updated_at
       FROM console_brand b JOIN organisation o ON o.id = b.org_id
      WHERE b.hostname IS NOT NULL
      ORDER BY (b.hostname_approved_at IS NOT NULL), b.updated_at DESC`,
  ));
  return rows.rows.map((r) => ({
    orgId: r.org_id, orgName: r.org_name, productName: r.product_name, hostname: r.hostname,
    approvedAt: r.hostname_approved_at?.toISOString() ?? null, updatedAt: r.updated_at.toISOString(),
  }));
}

/**
 * Approve an operator's console web address (platform:admin). `hostname` must be the
 * address the operator has now, so an approval cannot land on one changed meanwhile.
 */
export async function approveHostname(orgId: string, hostname: unknown, approverId: string | null): Promise<HostnameClaim> {
  const h = typeof hostname === 'string' ? hostOf(hostname) : '';
  const cur = await outsideRequestScope(() => one<Row>(`SELECT ${COLS} FROM console_brand WHERE org_id = $1`, [orgId]));
  if (!cur?.hostname) throw new BrandError(404, 'This operator has not entered a console web address.');
  if (cur.hostname !== h) throw new BrandError(409, `The operator’s console web address is ${cur.hostname}, not ${h || 'that'}; approve the address it has now.`, { hostname: 'changed' });
  if (reservedHosts().has(h)) throw new BrandError(409, 'This is one of PlugSure’s own addresses: it cannot belong to one operator.', { hostname: 'reserved' });
  const taken = await hostnameTaken(h, orgId);
  if (taken) throw new BrandError(409, taken === 'console' ? 'Another operator’s console already has this address approved.' : 'A driver app uses this address.', { hostname: 'taken' });
  try {
    const done = await outsideRequestScope(() => query(
      `UPDATE console_brand SET hostname_approved_at = now(), hostname_approved_by = $3 WHERE org_id = $1 AND hostname = $2`,
      [orgId, h, approverId],
    ));
    // The operator changed or removed the address after it was read: nothing was approved.
    if (!done.rowCount) throw new BrandError(409, 'The operator changed its console web address meanwhile; approve the address it has now.', { hostname: 'changed' });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new BrandError(409, 'Another operator’s console already has this address approved.', { hostname: 'taken' });
    throw e;
  }
  forgetConsoleBrands();
  return (await listHostnameClaims()).find((c) => c.orgId === orgId)!;
}

/** Withdraw the approval (platform:admin): the address stops taking effect; the operator keeps its brand. */
export async function revokeHostname(orgId: string): Promise<boolean> {
  const r = await outsideRequestScope(() => query(
    `UPDATE console_brand SET hostname_approved_at = NULL, hostname_approved_by = NULL WHERE org_id = $1 AND hostname_approved_at IS NOT NULL`, [orgId]));
  forgetConsoleBrands();
  return (r.rowCount ?? 0) > 0;
}

// ─────────────────────────────────────────────── the logo

export const LOGO_SIZE = 256;
const MAX_LOGO_BYTES = 1024 * 1024;

export interface LogoReport { width: number; height: number; bytes: number; sha256: string }

/** Check a square PNG and store it as a 256 × 256 PNG. Needs a brand first (its name). */
export async function saveConsoleLogo(orgId: string, png: Buffer): Promise<{ brand: ConsoleBrand; logo: LogoReport }> {
  if (!(await consoleBrandForOrgFresh(orgId))) throw new BrandError(404, 'Save the console’s name first.');
  if (png.length > MAX_LOGO_BYTES) throw new BrandError(413, 'The logo is larger than 1 MB.');
  let size: { width: number; height: number };
  try { size = pngSize(png); } catch { throw new BrandError(422, 'The logo must be a PNG file.'); }
  if (size.width !== size.height) throw new BrandError(422, `The logo must be square (this one is ${size.width} × ${size.height}).`);
  if (size.width < 64 || size.width > 2048) throw new BrandError(422, `The logo must be between 64 and 2048 pixels square (this one is ${size.width}); 256 or more is best.`);
  let out: Buffer;
  try {
    const img = decodePng(png);
    out = encodePng(size.width === LOGO_SIZE ? img : resize(img, LOGO_SIZE, LOGO_SIZE));
  } catch (e) {
    throw new BrandError(422, e instanceof PngError ? `The logo could not be read: ${e.message}.` : 'The logo could not be read.');
  }
  const sha256 = createHash('sha256').update(out).digest('hex');
  await query(`UPDATE console_brand SET logo_png = $2, logo_sha256 = $3, updated_at = now() WHERE org_id = $1`, [orgId, out, sha256]);
  forgetConsoleBrands();
  return { brand: (await consoleBrandForOrgFresh(orgId))!, logo: { ...size, bytes: png.length, sha256 } };
}

export async function removeConsoleLogo(orgId: string): Promise<ConsoleBrand | null> {
  await query(`UPDATE console_brand SET logo_png = NULL, logo_sha256 = NULL, updated_at = now() WHERE org_id = $1`, [orgId]);
  forgetConsoleBrands();
  return consoleBrandForOrgFresh(orgId);
}

export async function deleteConsoleBrand(orgId: string): Promise<void> {
  await query(`DELETE FROM console_brand WHERE org_id = $1`, [orgId]);
  forgetConsoleBrands();
}

// ─────────────────────────────────────────────── what the console is given

export interface ConsoleBrandView {
  productName: string;
  tagline: string | null;
  logoUrl: string | null;
  palette: ConsolePalette;
  showPoweredBy: boolean;
}

/** The part of a brand the console paints with (also served before sign-in on the brand's address). */
export function brandView(b: ConsoleBrand): ConsoleBrandView {
  return {
    productName: b.productName,
    tagline: b.tagline,
    logoUrl: b.logoSha256 ? `/console-brand/${b.logoSha256}.png` : null,
    palette: consolePalette(b.brandColor, b.accentColor),
    showPoweredBy: b.showPoweredBy,
  };
}
