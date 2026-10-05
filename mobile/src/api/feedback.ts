import type { Http } from './http';
import { ApiError, seg } from './http';
import type { ProblemCategory } from './types';

export type RatingReason = 'slow' | 'price' | 'start_failed' | 'stopped' | 'location' | 'great';

/** [§14 G9] post-session rating (Chargefox pattern) and problem reports. Unsupported → the UI hides itself. */
export const feedbackApi = (http: Http) => ({
  rate: async (kind: 'charge' | 'roaming', id: string, stars: number, reasons: RatingReason[], comment?: string): Promise<'sent' | 'unsupported'> => {
    try {
      const base = kind === 'roaming' ? '/v1/roaming/charge' : '/v1/charge';
      await http.post(`${base}/${seg(id)}/rating`, { stars, reasons, comment: comment || undefined }, { feature: 'ratings' });
      return 'sent';
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'unsupported') return 'unsupported';
      throw e;
    }
  },
  report: async (r: { connectorId?: string; partnerRef?: string; category: ProblemCategory; comment?: string }): Promise<'sent' | 'unsupported'> => {
    try {
      await http.post('/v1/reports', r, { feature: 'reports' });
      return 'sent';
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'unsupported') return 'unsupported';
      throw e;
    }
  },
});
