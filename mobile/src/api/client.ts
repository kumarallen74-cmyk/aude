import { apiBase, appVersion, brand, isMockApi, platform } from '@/config';
import { accountApi } from './account';
import { appConfigApi } from './appConfig';
import { chargeApi } from './charge';
import { favouritesApi } from './favourites';
import { feedbackApi } from './feedback';
import { Http, type HttpConfig } from './http';
import { identityApi } from './identity';
import { linksApi } from './links';
import { membershipsApi } from './memberships';
import { mockFetch } from './mock/server';
import { paymentsApi } from './payments';
import { pushApi } from './push';
import { reservationsApi } from './reservations';
import { roamingApi } from './roaming';
import { stationsApi } from './stations';

/** The typed driver-API client: one module per area (spec §14/§15 changes land in exactly one file). */
export function createApi(cfg: HttpConfig) {
  const http = new Http(cfg);
  return {
    http,
    stations: stationsApi(http),
    links: linksApi(http),
    identity: identityApi(http),
    charge: chargeApi(http),
    roaming: roamingApi(http),
    payments: paymentsApi(http),
    favourites: favouritesApi(http),
    push: pushApi(http),
    account: accountApi(http),
    appConfig: appConfigApi(http),
    feedback: feedbackApi(http),
    memberships: membershipsApi(http),
    reservations: reservationsApi(http),
  };
}

export type Api = ReturnType<typeof createApi>;

/** Mutable runtime inputs of the shared client (token from secure storage, the UI language). */
export const runtime = {
  token: null as string | null,
  lang: brand.defaultLocale as string,
  onUnauthorized: () => {},
};

export const api: Api = createApi({
  baseUrl: isMockApi ? 'https://mock.plugsure.invalid' : apiBase,
  fetchImpl: isMockApi ? mockFetch : undefined,
  getToken: () => runtime.token,
  getLang: () => runtime.lang,
  onUnauthorized: () => runtime.onUnauthorized(),
  brandSlug: brand.brandSlug,
  appVersion,
  platform,
});
