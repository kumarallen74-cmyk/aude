import { useQuery } from '@tanstack/react-query';
import { api, runtime } from '@/api/client';
import { ApiError } from '@/api/http';
import type { Me } from '@/api/types';
import { createStore, useStore } from '@/lib/store';
import { secret, kv, KEYS } from '@/lib/storage';
import { setActiveCharge } from './activeCharge';
import { setPendingCheckout } from './checkout';
import { qk, queryClient } from './queryClient';

/**
 * Identity tiers: guest device token (issued silently on first launch, spec §6.1) → phone OTP account → fleet.
 * The `psd_…` token lives in secure storage; a 401 `no_device` (revoked) issues a fresh one transparently.
 */
interface AuthState {
  ready: boolean;
  token: string | null;
  error: unknown;
}

export const authStore = createStore<AuthState>({ ready: false, token: null, error: null });
let issuing: Promise<string> | null = null;

async function issue(): Promise<string> {
  if (!issuing) {
    issuing = (async () => {
      const d = await api.identity.issueDevice();
      await secret.set(KEYS.deviceToken, d.deviceToken);
      runtime.token = d.deviceToken;
      authStore.set({ token: d.deviceToken, ready: true, error: null });
      return d.deviceToken;
    })().finally(() => {
      issuing = null;
    });
  }
  return issuing;
}

/** First launch: read the stored token or issue one (network failure leaves the app usable for public browse). */
export async function bootstrapAuth(): Promise<void> {
  runtime.onUnauthorized = () => {
    void secret.remove(KEYS.deviceToken).then(issue).then(() => queryClient.invalidateQueries());
  };
  const stored = await secret.get(KEYS.deviceToken);
  if (stored) {
    runtime.token = stored;
    authStore.set({ token: stored, ready: true });
    return;
  }
  try {
    await issue();
  } catch (e) {
    authStore.set({ ready: true, error: e });
  }
}

/** Ensure a device token before an authenticated call (offline first launch → retried here). */
export async function ensureDevice(): Promise<string> {
  return runtime.token ?? issue();
}

export function useMe() {
  const token = useStore(authStore, (s) => s.token);
  return useQuery<Me>({
    queryKey: qk.me,
    queryFn: () => api.identity.me(),
    enabled: !!token,
    staleTime: 5 * 60_000,
  });
}

export function useSignedIn(): boolean {
  const me = useMe();
  return !!me.data?.account || !!me.data?.fleet;
}

/** Forget the charge being followed and the payment in progress — memory and storage (both belong to the old token). */
function clearLocalCharge() {
  setActiveCharge(null); // and its start record
  setPendingCheckout(null);
}

/** Drop the device token and issue a new guest one (offline: issued at the next authenticated call). */
async function replaceDevice(): Promise<void> {
  runtime.token = null;
  authStore.set({ token: null });
  await secret.remove(KEYS.deviceToken);
  try {
    await issue();
  } catch (e) {
    authStore.set({ ready: true, error: e });
  }
}

/** §15.8: after account deletion the old device token is revoked — discard it and start again as a new guest. */
export async function resetDevice(): Promise<void> {
  // The deleted account's local traces go too (v1.9.0): its active charge, pending checkout and push token.
  clearLocalCharge();
  await kv.remove(KEYS.pushToken);
  queryClient.clear();
  await replaceDevice();
}

/**
 * Sign out. The server revokes this device token, so the app continues as a new guest with a fresh one. Offline (or
 * any failure but "already signed out") throws: the driver is told, and nothing pretends the sign-out happened.
 */
export async function signOut(): Promise<void> {
  try {
    await api.identity.signOut();
  } catch (e) {
    // 401 (no_device): the token is already revoked — signed out.
    if (!(e instanceof ApiError && e.kind === 'auth')) throw e;
  }
  clearLocalCharge();
  await replaceDevice();
  await queryClient.resetQueries();
}
