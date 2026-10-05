import type { Brand } from '../services/brand.js';
import { publicBrand } from '../services/brand.js';
import { config } from '../config.js';
import type { Lang } from '../domain/locale.js';

/**
 * The native apps' version gate and remote configuration (docs/MOBILE-APP-SPEC.md G8, §6.12):
 * GET /d/v1/app/config?platform=ios|android&version=1.0.3&build=42, per brand (the console edits it:
 * PUT /v1/driver-app/app-config). Stored on driver_app_brand.app_config, validated here.
 */

export const PLATFORMS = ['ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Remote feature switches the app understands. Absent: the default below. */
export const FEATURE_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({
  roaming: true, reservations: true, queue: true, memberships: true, favourites: true, liveActivities: true,
  accountDeletion: true, applePay: false, googlePay: false, routePlanner: false,
});

export interface PlatformRelease { minSupported?: string; latest?: string; storeUrl?: string }
export interface AppConfig {
  ios?: PlatformRelease;
  android?: PlatformRelease;
  maintenance?: { active?: boolean; messageId?: string; messageEn?: string };
  features?: Record<string, boolean>;
  links?: { support?: string; faq?: string; status?: string };
}

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/;

/** Compare dotted versions numerically (1.10.0 > 1.9.9). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const httpsUrl = (v: unknown) => {
  try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
};

/** Check a configuration from the console; returns the cleaned value or per-field errors. */
export function validateAppConfig(input: unknown): { ok: true; value: AppConfig } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const out: AppConfig = {};
  for (const p of PLATFORMS) {
    if (o[p] == null) continue;
    const r: PlatformRelease = {};
    for (const k of ['minSupported', 'latest'] as const) {
      const v = o[p][k];
      if (v == null || v === '') continue;
      if (!VERSION_RE.test(String(v))) errors[`${p}.${k}`] = 'a version like 1.2.3';
      else r[k] = String(v);
    }
    if (r.minSupported && r.latest && compareVersions(r.minSupported, r.latest) > 0) errors[`${p}.minSupported`] = 'cannot be above latest';
    if (o[p].storeUrl != null && o[p].storeUrl !== '') {
      const u = httpsUrl(o[p].storeUrl);
      if (!u) errors[`${p}.storeUrl`] = 'an https:// address'; else r.storeUrl = u;
    }
    out[p] = r;
  }
  if (o.maintenance != null) {
    const m = o.maintenance;
    const msg = (k: string) => (m[k] == null ? undefined : String(m[k]).trim().slice(0, 300) || undefined);
    if (m.active != null && typeof m.active !== 'boolean') errors['maintenance.active'] = 'true or false';
    out.maintenance = { active: m.active === true, messageId: msg('messageId'), messageEn: msg('messageEn') };
  }
  if (o.features != null) {
    const f: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(o.features as Record<string, unknown>)) {
      if (!(k in FEATURE_DEFAULTS)) errors[`features.${k}`] = 'unknown feature';
      else if (typeof v !== 'boolean') errors[`features.${k}`] = 'true or false';
      else f[k] = v;
    }
    out.features = f;
  }
  if (o.links != null) {
    const l: NonNullable<AppConfig['links']> = {};
    for (const k of ['support', 'faq', 'status'] as const) {
      const v = o.links[k];
      if (v == null || v === '') continue;
      const u = httpsUrl(v);
      if (!u) errors[`links.${k}`] = 'an https:// address'; else l[k] = u;
    }
    out.links = l;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

export interface ConfigContext {
  brand: Brand | null;
  platform: Platform | null;
  version: string | null;
  build: number | null;
  lang: Lang;
  /** Partner networks are available to this app's drivers (an eMSP organisation offers roaming to app drivers). */
  roaming: boolean;
  /** The public origin the app's links (account deletion web form) are on. */
  origin: string;
}

/** What GET /d/v1/app/config answers. */
export function appConfigFor(ctx: ConfigContext) {
  const cfg = (ctx.brand?.appConfig ?? {}) as AppConfig;
  const rel: PlatformRelease = (ctx.platform ? cfg[ctx.platform] : undefined) ?? {};
  const minSupported = rel.minSupported ?? null;
  const latest = rel.latest ?? null;
  const v = ctx.version && VERSION_RE.test(ctx.version) ? ctx.version : null;
  const storeUrl = rel.storeUrl ?? (ctx.platform === 'android' && ctx.brand?.androidPackage
    ? `https://play.google.com/store/apps/details?id=${ctx.brand.androidPackage}` : null);
  const m = cfg.maintenance ?? {};
  const message = m.active ? (ctx.lang === 'en' ? m.messageEn ?? m.messageId : m.messageId ?? m.messageEn) ?? null : null;
  const features: Record<string, boolean> = { ...FEATURE_DEFAULTS, roaming: ctx.roaming, reservations: config.driverApp.reservationsEnabled, ...(cfg.features ?? {}) };
  if (!ctx.roaming) features.roaming = false; // a switch cannot turn on what the server cannot do
  if (!config.driverApp.reservationsEnabled) features.reservations = false;
  const b = ctx.brand;
  return {
    platform: ctx.platform,
    version: v,
    build: ctx.build,
    minSupported,
    latest,
    storeUrl,
    /** Below the minimum: the app must be updated before anything else (blocking screen). */
    force: !!(v && minSupported && compareVersions(v, minSupported) < 0),
    /** A newer version exists (dismissable banner). */
    softUpdate: !!(v && latest && compareVersions(v, latest) < 0),
    maintenance: { active: m.active === true, message },
    features,
    links: {
      terms: b?.termsUrl ?? null,
      privacy: b?.privacyUrl ?? null,
      support: cfg.links?.support ?? (b?.supportEmail ? `mailto:${b.supportEmail}` : null),
      faq: cfg.links?.faq ?? null,
      status: cfg.links?.status ?? null,
      accountDeletion: `${ctx.origin}/account/delete`,
    },
    brand: b ? { ...publicBrand(b), scope: b.scope } : null,
    languages: {
      /** Languages the server writes messages in; the app sends X-Driver-Lang. */
      server: ['id', 'en'],
      /** Malay and Chinese are app-side for now: the server answers them in English (G16). */
      fallback: { ms: 'en', zh: 'en' },
    },
    polling: { liveSessionS: 5, paymentS: 2 },
  };
}
