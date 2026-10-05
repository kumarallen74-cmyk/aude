import { seg } from './http';
import type { Http } from './http';
import type { Channel, DriverCard } from './types';

/** Saved cards (acquirer tokens, valid only at the operator whose acquirer issued them — `usableAt`) and e-wallet links. */
export const paymentsApi = (http: Http) => ({
  cards: () => http.get<{ cards: DriverCard[]; signedIn: boolean }>('/v1/cards'),
  removeCard: (id: string) => http.del<{ ok: true }>(`/v1/cards/${seg(id)}`),
  linkWallet: (channel: Channel, opts: { connectorId?: string; planId?: string; phone?: string }) =>
    http.post<{ ok: true; id: string; checkoutUrl?: string | null; action?: string }>('/v1/wallets', { channel, ...opts }),
  walletStatus: (id: string) => http.get<{ id: string; status: string; channel: Channel; accountLabel: string | null }>(`/v1/wallets/${seg(id)}`),
});
