/** The start flows route every path to a screen that owns the outcome (spec §6.4–6.6). */
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock('expo-web-browser', () => ({}));
jest.mock('expo-linking', () => ({ createURL: (p: string) => `plugsure://${p}` }));

jest.mock('@/api/client', () => ({ api: { charge: { prepaid: jest.fn(), start: jest.fn(), fleet: jest.fn() }, roaming: { start: jest.fn() } }, runtime: { token: 'psd_x' } }));
jest.mock('@/state/auth', () => ({ ensureDevice: jest.fn(async () => 'psd_x') }));

import { ApiError } from '@/api/http';
import { checkoutStore } from '@/state/checkout';
import { activeChargeStore } from '@/state/activeCharge';
import { requestStart, resetStartsForTests, startAcknowledged, startAfterPayment, startFleetCharge, startHostedCharge, startRoamingCharge } from '../checkoutFlow';

const mockRouter = jest.requireMock('expo-router').router as { push: jest.Mock; replace: jest.Mock };
const { charge: mockCharge, roaming: mockRoaming } = jest.requireMock('@/api/client').api as { charge: { prepaid: jest.Mock; start: jest.Mock; fleet: jest.Mock }; roaming: { start: jest.Mock } };

beforeEach(() => {
  jest.clearAllMocks();
  checkoutStore.set({ pending: null });
  activeChargeStore.set({ current: null, start: null });
  resetStartsForTests();
});

it('QRIS: keeps the checkout and opens the payment screen; the return URL is the app link ([§14 G11])', async () => {
  mockCharge.prepaid.mockResolvedValue({ ok: true, chargeId: 'c1', payment: { action: 'qr' }, qr: { qrString: '000201' } });
  await startHostedCharge({ connectorId: 'k', siteName: 'Senayan', amountMinor: 100000, pay: { method: 'QRIS' } });
  expect(mockCharge.prepaid).toHaveBeenCalledWith('k', 100000, { method: 'QRIS', returnUrl: 'plugsure://paid' }, undefined, expect.any(String));
  expect(checkoutStore.get().pending).toMatchObject({ kind: 'charge', connectorId: 'k', siteName: 'Senayan' });
  expect(mockRouter.push).toHaveBeenCalledWith('/pay/charge/c1');
  expect(mockCharge.start).not.toHaveBeenCalled();
});

it('saved card that went through at once: start → session, no payment screen', async () => {
  mockCharge.prepaid.mockResolvedValue({ ok: true, chargeId: 'c2', payment: { action: 'done' } });
  mockCharge.start.mockResolvedValue({ ok: true, status: 'Offline', presentToken: 'PS123' });
  await startHostedCharge({ connectorId: 'k', siteName: 'Senayan', amountMinor: 50000, pay: { savedCardId: 'card' } });
  expect(mockCharge.start).toHaveBeenCalledWith('c2');
  expect(mockRouter.replace).toHaveBeenCalledWith('/session/charge/c2');
  expect(activeChargeStore.get().current).toMatchObject({ kind: 'charge', id: 'c2' });
  // The start token is kept with the active charge (persisted: it survives a restart).
  expect(activeChargeStore.get().start).toMatchObject({ chargeId: 'c2', ok: true, presentToken: 'PS123' });
  expect(startAcknowledged('c2')).toBe(true);
});

it('a start that fails or times out is recorded (not swallowed) and not acknowledged, so the session screen can retry', async () => {
  mockCharge.start.mockRejectedValueOnce(new ApiError('timeout', '', 0));
  await startAfterPayment('c3', 'Senayan');
  expect(mockRouter.replace).toHaveBeenCalledWith('/session/charge/c3');
  expect(activeChargeStore.get().start).toMatchObject({ chargeId: 'c3', ok: false });
  expect(startAcknowledged('c3')).toBe(false);
  mockCharge.start.mockRejectedValueOnce(new ApiError('business', 'Pembayaran belum diterima.', 400));
  expect(await requestStart('c3')).toMatchObject({ ok: false, error: 'Pembayaran belum diterima.' });
});

it('a repeated start of a charge that already runs (400 "sudah dimulai") counts as started; an earlier start token is kept', async () => {
  mockCharge.start.mockResolvedValueOnce({ ok: true, status: 'Offline', presentToken: 'PS9' });
  await requestStart('c4');
  mockCharge.start.mockRejectedValueOnce(new ApiError('business', 'Sesi ini sudah dimulai.', 400, undefined, { ok: false, error: 'Sesi ini sudah dimulai.' }));
  expect(await requestStart('c4')).toMatchObject({ ok: true, presentToken: 'PS9' });
});

it('two pay screens finishing at once send one start', async () => {
  let resolve!: (v: unknown) => void;
  mockCharge.start.mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const a = startAfterPayment('c5', 'S');
  const b = startAfterPayment('c5', 'S');
  resolve({ ok: true, status: 'Accepted' });
  await Promise.all([a, b]);
  expect(mockCharge.start).toHaveBeenCalledTimes(1);
  // Already acknowledged: a later finish only routes to the session.
  await startAfterPayment('c5', 'S');
  expect(mockCharge.start).toHaveBeenCalledTimes(1);
});

it('the Idempotency-Key given for the attempt is the one sent', async () => {
  mockCharge.prepaid.mockResolvedValue({ ok: true, chargeId: 'c6', payment: { action: 'qr' } });
  await startHostedCharge({ connectorId: 'k', siteName: 'S', amountMinor: 1, pay: {}, idempotencyKey: 'key-1' });
  expect(mockCharge.prepaid.mock.calls[0]![4]).toBe('key-1');
  mockRoaming.start.mockResolvedValue({ ok: true, chargeId: 'r9', payment: { action: 'done' } });
  await startRoamingCharge({ partnerId: 'p', countryCode: 'SG', partyId: 'LCE', locationId: 'L', evseUid: 'E' }, 'W', 'B', 'key-2');
  expect(mockRoaming.start.mock.calls[0]![1]).toBe('key-2');
});

it('a refused checkout surfaces the server sentence as a business error', async () => {
  mockCharge.prepaid.mockResolvedValue({ ok: false, error: 'Konektor ini sedang dipesan pengemudi lain.' });
  await expect(startHostedCharge({ connectorId: 'k', siteName: 'S', amountMinor: 1, pay: {} })).rejects.toMatchObject({ kind: 'business', message: 'Konektor ini sedang dipesan pengemudi lain.' });
  expect(mockRouter.push).not.toHaveBeenCalled();
});

it('fleet: no payment, straight to start', async () => {
  mockCharge.fleet.mockResolvedValue({ ok: true, chargeId: 'f1' });
  mockCharge.start.mockResolvedValue({ ok: true, status: 'Accepted' });
  await startFleetCharge('k', 'Depot');
  expect(mockRouter.replace).toHaveBeenCalledWith('/session/charge/f1');
});

it('roaming: hold checkout → payment screen; saved card hold → session', async () => {
  mockRoaming.start.mockResolvedValueOnce({ ok: true, chargeId: 'r1', payment: { action: 'redirect', checkoutUrl: 'https://pay', hold: true } });
  await startRoamingCharge({ partnerId: 'p', countryCode: 'SG', partyId: 'LCE', locationId: 'L', evseUid: 'E' }, 'Woodlands', 'Bay Charge SG');
  expect(mockRouter.push).toHaveBeenCalledWith('/pay/roaming/r1');
  mockRoaming.start.mockResolvedValueOnce({ ok: true, chargeId: 'r2', payment: { action: 'done' } });
  await startRoamingCharge({ partnerId: 'p', countryCode: 'SG', partyId: 'LCE', locationId: 'L', evseUid: 'E', savedCardId: 'c' }, 'Woodlands', 'Bay Charge SG');
  expect(mockRouter.replace).toHaveBeenCalledWith('/session/roaming/r2');
});
