import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/api/http';

/** Server state. Retries only what can succeed on retry (network / 5xx), with backoff; business errors surface at once. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 60 * 60_000,
      retry: (count, e) => (e instanceof ApiError ? e.retryable && count < 3 : count < 2),
      retryDelay: (n) => Math.min(8_000, 600 * 2 ** n),
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

export const qk = {
  me: ['me'] as const,
  stations: (lat?: number, lon?: number) => ['stations', lat?.toFixed(2) ?? '-', lon?.toFixed(2) ?? '-'] as const,
  roaming: (signedIn: boolean, lat?: number, lon?: number) => ['roaming', signedIn, lat?.toFixed(2) ?? '-', lon?.toFixed(2) ?? '-'] as const,
  connector: (id: string) => ['connector', id] as const,
  quote: (id: string, amount: number, promo: string) => ['quote', id, amount, promo] as const,
  history: ['history'] as const,
  unpaid: ['unpaid'] as const,
  favourites: ['favourites'] as const,
  cards: ['cards'] as const,
  receipt: (kind: string, id: string) => ['receipt', kind, id] as const,
  status: (kind: string, id: string) => ['status', kind, id] as const,
  appConfig: ['appConfig'] as const,
  meta: ['meta'] as const,
  memberships: ['memberships'] as const,
};
