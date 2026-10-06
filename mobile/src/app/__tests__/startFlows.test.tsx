/**
 * Paying and starting never leave the driver stuck: the session screen starts a paid charge nobody started, offers
 * "Try starting again", ends on an unknown session; the payment screens only act on the checkout they describe.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { api } from '@/api/client';
import { ApiError } from '@/api/http';
import { resetStartsForTests } from '@/features/checkoutFlow';
import { activeChargeStore } from '@/state/activeCharge';
import { checkoutStore, setPendingCheckout } from '@/state/checkout';
import { freshDevice, renderScreen } from '@/test/render';

jest.mock('expo-router', () => require('@/test/expoRouterMock'));
jest.mock('expo-notifications', () => ({ AndroidImportance: {}, AndroidNotificationVisibility: {}, AndroidNotificationPriority: {}, getPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })) }));

const { setParams, router } = jest.requireMock('expo-router') as typeof import('@/test/expoRouterMock');
const CONNECTOR = '00000000-0000-4000-8000-000000001001';

/** A QRIS charge that is paid, as if the app was killed right after the payment (nothing called /start). */
async function paidNotStarted() {
  const co = await api.charge.prepaid(CONNECTOR, 100000, { method: 'QRIS' });
  await api.charge.confirmDemoPayment(co.chargeId!);
  return co;
}

beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  await freshDevice();
  resetStartsForTests();
  activeChargeStore.set({ current: null, start: null });
  checkoutStore.set({ pending: null });
});

it('Session: a paid charge whose start was never acknowledged is started by the session screen itself', async () => {
  const co = await paidNotStarted();
  const start = jest.spyOn(api.charge, 'start');
  setParams({ kind: 'charge', id: co.chargeId! });
  const Screen = require('../session/[kind]/[id]').default;
  await renderScreen(<Screen />);
  expect(await screen.findByText('Starting…')).toBeTruthy();
  await waitFor(() => expect(start).toHaveBeenCalledWith(co.chargeId));
  await waitFor(() => expect(activeChargeStore.get().start).toMatchObject({ chargeId: co.chargeId, ok: true }));
  expect(start).toHaveBeenCalledTimes(1);
});

it('Session: a failed start shows why and "Try starting again", which starts it', async () => {
  const co = await paidNotStarted();
  const start = jest.spyOn(api.charge, 'start').mockRejectedValueOnce(new ApiError('timeout', '', 0));
  setParams({ kind: 'charge', id: co.chargeId! });
  const Screen = require('../session/[kind]/[id]').default;
  await renderScreen(<Screen />);
  expect(await screen.findByTestId('start-failed')).toBeTruthy();
  expect(screen.getByText("The charger hasn't started yet")).toBeTruthy();
  await fireEvent.press(screen.getByTestId('start-again'));
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByTestId('start-failed')).toBeNull());
  expect(activeChargeStore.get().start).toMatchObject({ ok: true });
});

it('Session: an unknown session (404) ends — no endless "Reconnecting…"', async () => {
  setParams({ kind: 'charge', id: 'does-not-exist' });
  const status = jest.spyOn(api.charge, 'status');
  const Screen = require('../session/[kind]/[id]').default;
  await renderScreen(<Screen />);
  expect(await screen.findByTestId('session-missing')).toBeTruthy();
  expect(screen.getByText('Session not found')).toBeTruthy();
  expect(screen.queryByTestId('reconnecting')).toBeNull();
  const calls = status.mock.calls.length;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 3200));
  });
  expect(status.mock.calls.length).toBe(calls);
});

it('/paid for an unpaid-session settlement resumes /pay/unpaid/<id>, going back to the open payment screen', async () => {
  setPendingCheckout({ kind: 'unpaid', chargeId: 'u1', result: { ok: true } as never, siteName: 'Senayan', at: Date.now() });
  setParams({});
  const Paid = require('../paid').default;
  await renderScreen(<Paid />);
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/pay/unpaid/u1'));
  expect(router.push).not.toHaveBeenCalled();
});

it('Pay: with no pending checkout for this id, nothing is polled and nothing is started', async () => {
  const co = await paidNotStarted();
  const status = jest.spyOn(api.charge, 'status');
  const start = jest.spyOn(api.charge, 'start');
  setParams({ kind: 'charge', id: co.chargeId! });
  const Pay = require('../pay/[kind]/[id]').default;
  await renderScreen(<Pay />);
  expect(await screen.findByText('No payment in progress')).toBeTruthy();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(status).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it('Pay (partner): a rejected start is an end state — polling stops', async () => {
  setPendingCheckout({
    kind: 'roaming',
    siteName: 'Woodlands',
    operator: 'Bay Charge SG',
    at: Date.now(),
    result: { ok: true, chargeId: 'r1', payment: { hold: true, currency: 'SGD', amountMinor: 8000, action: 'push', checkoutUrl: null, providerRef: 'REF', expiresAt: new Date(Date.now() + 600_000).toISOString() } } as never,
  });
  const status = jest.spyOn(api.roaming, 'status').mockResolvedValue({ state: 'rejected', problem: 'The charger refused the start.' } as never);
  setParams({ kind: 'roaming', id: 'r1' });
  const Pay = require('../pay/[kind]/[id]').default;
  await renderScreen(<Pay />);
  expect(await screen.findByText('The charger refused the start.')).toBeTruthy();
  const calls = status.mock.calls.length;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 2700));
  });
  expect(status.mock.calls.length).toBe(calls);
});

it('Pay (demo): a failing "Simulate payment" shows the error instead of an unhandled rejection', async () => {
  const co = await api.charge.prepaid(CONNECTOR, 100000, { method: 'QRIS' });
  setPendingCheckout({ kind: 'charge', result: co, connectorId: CONNECTOR, siteName: 'Senayan', at: Date.now() });
  jest.spyOn(api.charge, 'confirmDemoPayment').mockRejectedValueOnce(new ApiError('offline', '', 0));
  setParams({ kind: 'charge', id: co.chargeId! });
  const Pay = require('../pay/[kind]/[id]').default;
  await renderScreen(<Pay />);
  await fireEvent.press(await screen.findByTestId('simulate-payment'));
  expect(await screen.findByTestId('simulate-error')).toBeTruthy();
});

it('Partner: while a start is on its way, "Use new card" is off too (no second card hold)', async () => {
  await api.identity.verifyOtp('+6281234567890', '123456');
  const s = (await api.stations.roaming(null)).stations.find((x) => x.countryCode === 'SG')!;
  let settle!: (v: unknown) => void;
  jest.spyOn(api.roaming, 'start').mockReturnValue(new Promise((r) => (settle = r)) as never);
  setParams({ partnerId: s.partnerId, locationId: s.locationId, countryCode: s.countryCode, partyId: s.partyId, evseUid: s.evses[0]!.uid });
  const Partner = require('../partner/[partnerId]/[locationId]').default;
  await renderScreen(<Partner />);
  await fireEvent.press(await screen.findByTestId('start-partner'));
  await waitFor(() => expect(screen.getByTestId('start-partner-new-card').props.accessibilityState).toMatchObject({ disabled: true }));
  await fireEvent.press(screen.getByTestId('start-partner-new-card'));
  expect(api.roaming.start).toHaveBeenCalledTimes(1);
  await act(async () => settle({ ok: false, error: 'Charger busy.' }));
  expect(await screen.findByText('Charger busy.')).toBeTruthy();
});
