import type { Http } from './http';
import { newIdempotencyKey, seg } from './http';
import type { RoamingReceipt, RoamingStartRequest, RoamingStartResult, RoamingStatus } from './types';

/** Partner CPOs reached through the hub (OCPI): signed-in drivers with a card hold, or fleet cards. */
export const roamingApi = (http: Http) => ({
  start: (req: RoamingStartRequest, idempotencyKey = newIdempotencyKey()) =>
    http.post<RoamingStartResult>('/v1/roaming/charge', req, { idempotencyKey, timeoutMs: 45_000 }),
  status: (id: string, signal?: AbortSignal) => http.get<RoamingStatus>(`/v1/roaming/charge/${seg(id)}/status`, { signal }),
  stop: (id: string) => http.post<{ ok: boolean; error?: string }>(`/v1/roaming/charge/${seg(id)}/stop`, undefined, { timeoutMs: 45_000 }),
  receipt: (cdrId: string) => http.get<RoamingReceipt>(`/v1/roaming/cdr/${seg(cdrId)}`),
});
