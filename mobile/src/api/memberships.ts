import type { Http } from './http';

/** Passes (30-day memberships per operator) and loyalty points. Read-mostly in v1.0. */
export const membershipsApi = (http: Http) => ({
  overview: () => http.get<{ passes?: unknown[]; plans?: unknown[]; [k: string]: unknown }>('/v1/memberships'),
  loyalty: () => http.get<{ balances?: { orgId: string; operator: string; points: number; valueMinor?: number; currency?: string; autoRedeem?: boolean }[] }>('/v1/loyalty'),
});
