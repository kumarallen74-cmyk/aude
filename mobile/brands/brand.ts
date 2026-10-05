/**
 * White-label brand definition. One JSON file per variant in this folder
 * (`brands/<variant>.json`) plus its generated assets in `brands/<variant>/`.
 * `APP_VARIANT=<variant>` selects it at build time (app.config.ts); the app
 * reads the resolved values at runtime from `expoConfig.extra.brand`.
 *
 * Keep this file free of React Native imports: app.config.ts loads it in Node.
 */
export type BrandScope = 'network' | 'operator';
export type AppLocale = 'en' | 'id' | 'ms' | 'zh';
export type CountryCode = 'ID' | 'MY' | 'SG';

export interface BrandFeatures {
  guestCharge: boolean;
  roaming: boolean;
  fleetLogin: boolean;
  reservations: boolean;
  queue: boolean;
  memberships: boolean;
  liveActivities: boolean;
  ratings: boolean;
  problemReports: boolean;
  applePay: boolean;
  routePlanner: boolean;
}

export interface Brand {
  variant: string;
  appName: string;
  shortName: string;
  tagline: Partial<Record<AppLocale, string>> & { en: string };
  easSlug: string;
  /** Sent as `X-Driver-Brand` (server `driver_app_brand.slug`). */
  brandSlug: string;
  /** `network`: the PlugSure Hub app (every operator); `operator`: a white-label app scoped to one operator (§2.2). */
  scope: BrandScope;
  scheme: string;
  iosBundleId: string;
  androidPackage: string;
  /** Universal / app link hosts (first one is used to build share links). */
  linkHosts: string[];
  apiBase: string;
  accentColor: string;
  badgeColor: string;
  defaultLocale: AppLocale;
  locales: AppLocale[];
  countries: CountryCode[];
  defaultRegion: { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };
  support: { phone?: string; whatsapp?: string; email?: string };
  links: { terms: string; privacy: string; deleteAccount: string; help: string };
  store: { appStoreId: string; playStoreUrl: string; appStoreUrl: string };
  easProjectId: string;
  appleTeamId: string;
  features: BrandFeatures;
}

export { validateBrand } from './validate';
