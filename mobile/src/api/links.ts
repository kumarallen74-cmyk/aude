import type { Http } from './http';
import { ApiError } from './http';
import type { LinkResolution } from './types';

/**
 * §15.5 `GET /d/v1/links/resolve?url=` — any scanned QR text or tapped link: link-domain URLs, the web app's links,
 * operators' printed stickers (last path segment), `plugsure://c/…`, bare codes and partner EVSE ids.
 * Null when unknown (404 `not_found`); 404 `other_operator` (a white-label app scanning another operator's charger)
 * is thrown so the screen can say so.
 */
export const linksApi = (http: Http) => ({
  resolve: async (url: string): Promise<LinkResolution | null> => {
    try {
      return await http.get<LinkResolution>('/v1/links/resolve', { query: { url } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && e.code !== 'other_operator') return null;
      throw e;
    }
  },
});
