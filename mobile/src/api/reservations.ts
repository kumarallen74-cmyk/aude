import type { Http } from './http';
import { newIdempotencyKey, seg } from './http';
import type { PayRequest, QueueEntryView, ReservationView, ReserveResult, SiteQueueView } from './types';

/**
 * Reservations (hosted connectors) and site queues, where the operator offers them (`DRIVER_RESERVATIONS`,
 * Sites → Driver queue). A free reservation holds at once; a fee is paid first like a charge (`checkout`), and the
 * connector is held once paid.
 */
export const reservationsApi = (http: Http) => ({
  current: () => http.get<{ reservation: ReservationView | null; partner: unknown | null }>('/v1/reservation'),
  reserve: (connectorId: string, pay: PayRequest = {}, idempotencyKey = newIdempotencyKey()) =>
    http.post<ReserveResult>('/v1/reservations', { connectorId, ...pay }, { idempotencyKey }),
  checkoutStatus: (id: string) =>
    http.get<{ id: string; state: 'pending' | 'held' | 'failed' | 'expired' | 'cancelled' | string; problem: string | null; totalMinor: number; reservation: ReservationView | null }>(
      `/v1/reservations/checkout/${seg(id)}`,
    ),
  /** Sandbox acquirer only. */
  confirmDemoCheckout: (id: string) => http.post<{ ok: boolean }>(`/v1/reservations/checkout/${seg(id)}/confirm-payment`),
  cancelCheckout: (id: string) => http.post<{ ok: boolean }>(`/v1/reservations/checkout/${seg(id)}/cancel`),
  cancel: (id: string) => http.post<{ ok: boolean }>(`/v1/reservations/${seg(id)}/cancel`),

  myQueue: () => http.get<{ entry: QueueEntryView | null; ended: QueueEntryView | null }>('/v1/queue'),
  siteQueue: (siteId: string) => http.get<SiteQueueView>(`/v1/sites/${seg(siteId)}/queue`),
  /** 422 with `connectorId` when a suitable connector is free right now ("charge now instead"). */
  joinQueue: (siteId: string, want: { current?: 'AC' | 'DC' | null; type?: string | null } = {}) =>
    http.post<{ ok: true; entry: QueueEntryView }>('/v1/queue', { siteId, current: want.current ?? null, type: want.type ?? null }),
  leaveQueue: (id: string) => http.post<{ ok: boolean }>(`/v1/queue/${seg(id)}/leave`),
});
