import { seg } from './http';
import type { Http } from './http';
import type { Favourite } from './types';

export type FavouriteTarget = { siteId: string } | { partnerId: string; countryCode: string; partyId: string; locationId: string };

export const favouritesApi = (http: Http) => ({
  list: () => http.get<{ favourites: Favourite[] }>('/v1/favourites').then((r) => r.favourites),
  add: (target: FavouriteTarget) => http.post<{ ok: true; favourite: Favourite }>('/v1/favourites', target),
  remove: (id: string) => http.del<{ ok: true }>(`/v1/favourites/${seg(id)}`),
});
