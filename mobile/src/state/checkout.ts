import type { CheckoutResult, ReserveResult, RoamingStartResult } from '@/api/types';
import { createStore, useStore } from '@/lib/store';
import { kv, KEYS } from '@/lib/storage';

/**
 * The payment in progress. Kept across the trip to the acquirer's page / e-wallet app and an app restart, so the
 * return link (`/paid`) resumes exactly where the driver left (spec §6.5).
 */
export type PendingCheckout =
  | { kind: 'charge'; result: CheckoutResult; connectorId: string; siteName: string; at: number }
  | { kind: 'roaming'; result: RoamingStartResult; siteName: string; operator: string; at: number }
  | { kind: 'unpaid'; chargeId: string; result: CheckoutResult; siteName: string; at: number }
  | { kind: 'reservation'; result: ReserveResult & { checkout: NonNullable<ReserveResult['checkout']> }; connectorId: string; siteName: string; at: number };

export const checkoutStore = createStore<{ pending: PendingCheckout | null }>({ pending: null });

export async function hydrateCheckout() {
  const p = await kv.get<PendingCheckout>(KEYS.pendingCheckout);
  if (p && Date.now() - p.at < 60 * 60_000) checkoutStore.set({ pending: p });
}

export function setPendingCheckout(p: PendingCheckout | null) {
  checkoutStore.set({ pending: p });
  if (p) void kv.set(KEYS.pendingCheckout, p);
  else void kv.remove(KEYS.pendingCheckout);
}

export const usePendingCheckout = () => useStore(checkoutStore, (s) => s.pending);
