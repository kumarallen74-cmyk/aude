import type { Http } from './http';
import { newIdempotencyKey, seg } from './http';
import type {
  CheckoutResult,
  HistoryPage,
  HostedReceipt,
  HostedStatus,
  PayRequest,
  Quote,
  StartResult,
  UnpaidItem,
} from './types';

/** Hosted chargers (tenants on the PlugSure CSMS): quote → prepaid checkout → start → status → stop → receipt. */
export const chargeApi = (http: Http) => ({
  /** 422 with `{ok:false,error,minimumViableMinor}` is returned as a value (it is an answer, not a failure). */
  quote: async (connectorId: string, amountMinor: number, promoCode?: string): Promise<Quote> => {
    try {
      return await http.post<Quote>('/v1/charge/quote', { connectorId, amountMinor, promoCode: promoCode || undefined });
    } catch (e) {
      const body = (e as { body?: unknown }).body as Quote | undefined;
      if (body && body.ok === false) return body;
      throw e;
    }
  },

  prepaid: (connectorId: string, amountMinor: number, pay: PayRequest, promoCode?: string, idempotencyKey = newIdempotencyKey()) =>
    http.post<CheckoutResult>('/v1/charge/prepaid', { connectorId, amountMinor, promoCode: promoCode || undefined, ...pay }, { idempotencyKey }),

  fleet: (connectorId: string, idempotencyKey = newIdempotencyKey()) =>
    http.post<CheckoutResult>('/v1/charge/fleet', { connectorId }, { idempotencyKey }),

  /** Sandbox acquirer only ("simulate payment"): 403 in production. */
  confirmDemoPayment: (chargeId: string) => http.post<{ ok: boolean }>(`/v1/charge/${seg(chargeId)}/confirm-payment`),

  start: (chargeId: string) => http.post<StartResult>(`/v1/charge/${seg(chargeId)}/start`),
  status: (chargeId: string, signal?: AbortSignal) => http.get<HostedStatus>(`/v1/charge/${seg(chargeId)}/status`, { signal }),
  stop: (chargeId: string) => http.post<{ ok: boolean; status?: string; error?: string }>(`/v1/charge/${seg(chargeId)}/stop`),
  receipt: (chargeId: string) => http.get<HostedReceipt>(`/v1/charge/${seg(chargeId)}/receipt`),
  /** The printable tax receipt (HTML; needs the Authorization header — fetched, then printed to PDF on device). */
  receiptHtml: async (chargeId: string): Promise<string> => {
    const res = await fetch(http.url(`/v1/charge/${seg(chargeId)}/receipt.html`), { headers: http.headers({ Accept: 'text/html' }) });
    if (!res.ok) throw new Error(`receipt ${res.status}`);
    return res.text();
  },

  /**
   * `GET /d/v1/history` — today: last 40 hosted + roaming, no paging. [§14 G14] adds `cursor`, `limit`,
   * `currency` and `{nextCursor, totals}`; older servers ignore the query and return everything once.
   */
  history: (cursor?: string | null, currency?: string | null) =>
    http.get<HistoryPage>('/v1/history', { query: { cursor: cursor ?? undefined, limit: 20, currency: currency ?? undefined } }),

  unpaid: () => http.get<{ unpaid: UnpaidItem[] }>('/v1/unpaid').then((r) => r.unpaid),
  payUnpaid: (chargeId: string, pay: PayRequest, idempotencyKey = newIdempotencyKey()) =>
    http.post<CheckoutResult & { paid?: boolean; amountMinor?: number }>(`/v1/charge/${seg(chargeId)}/pay-unpaid`, pay, { idempotencyKey }),
  unpaidStatus: (chargeId: string) => http.get<{ kind: string; owedMinor: number; paid: boolean }>(`/v1/charge/${seg(chargeId)}/pay-unpaid`),
  /** Sandbox acquirer only: the settlement payment for an unpaid session is paid. */
  confirmUnpaidPayment: (chargeId: string) => http.post<{ ok: boolean }>(`/v1/charge/${seg(chargeId)}/pay-unpaid/confirm-payment`),
  payNow: (chargeId: string) => http.post<{ ok: boolean; paid?: boolean; checkoutUrl?: string | null; error?: string; code?: string }>(`/v1/charge/${seg(chargeId)}/pay-now`),
});
