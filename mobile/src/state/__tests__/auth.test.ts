/** Sign-out and account reset leave nothing of the old identity behind, and never pretend to succeed offline. */
import { api, runtime } from '@/api/client';
import { mockFetch } from '@/api/mock/server';
import { activeChargeStore, setActiveCharge, setStartRecord } from '@/state/activeCharge';
import { resetDevice, signOut } from '@/state/auth';
import { checkoutStore, setPendingCheckout } from '@/state/checkout';
import { freshDevice } from '@/test/render';

const seed = () => {
  setActiveCharge({ kind: 'charge', id: 'c1', siteName: 'Senayan', startedAt: Date.now() });
  setStartRecord({ chargeId: 'c1', ok: true, presentToken: 'PS1', at: Date.now() });
  setPendingCheckout({ kind: 'unpaid', chargeId: 'c2', result: { ok: true } as never, siteName: 'Senayan', at: Date.now() });
};

beforeEach(async () => {
  await freshDevice();
  await api.identity.verifyOtp('+6281234567890', '123456');
  seed();
});

it('sign-out: clears the active charge and the pending payment, and continues as a new guest (the old token is revoked)', async () => {
  const old = runtime.token;
  await signOut();
  expect(activeChargeStore.get()).toEqual({ current: null, start: null });
  expect(checkoutStore.get().pending).toBeNull();
  expect(runtime.token).toBeTruthy();
  expect(runtime.token).not.toBe(old);
  expect((await api.identity.me()).account).toBeNull();
});

it('sign-out offline: throws, keeps the token and local state (nothing pretends it signed out)', async () => {
  const old = runtime.token;
  api.http.configure({ fetchImpl: async () => Promise.reject(new TypeError('Network request failed')) });
  await expect(signOut()).rejects.toMatchObject({ kind: 'offline' });
  expect(runtime.token).toBe(old);
  expect(activeChargeStore.get().current).not.toBeNull();
  expect(checkoutStore.get().pending).not.toBeNull();
  api.http.configure({ fetchImpl: mockFetch });
});

it('sign-out with a token that is already revoked (401 no_device) counts as signed out', async () => {
  await api.identity.signOut();
  const old = runtime.token;
  await signOut();
  expect(runtime.token).not.toBe(old);
  expect(checkoutStore.get().pending).toBeNull();
});

it('reset after account deletion clears the in-memory stores too, not only storage', async () => {
  await resetDevice();
  expect(activeChargeStore.get()).toEqual({ current: null, start: null });
  expect(checkoutStore.get().pending).toBeNull();
  expect(runtime.token).toBeTruthy();
});
