/** The start flows route every path to a screen that owns the outcome (spec §6.4–6.6). */
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock('expo-web-browser', () => ({}));
jest.mock('expo-linking', () => ({ createURL: (p: string) => `plugsure://${p}` }));

jest.mock('@/api/client', () => ({ api: { charge: { prepaid: jest.fn(), start: jest.fn(), fleet: jest.fn() }, roaming: { start: jest.fn() } }, runtime: { token: 'psd_x' } }));
jest.mock('@/state/auth', () => ({ ensureDevice: jest.fn(async () => 'psd_x') }));

import { checkoutStore } from '@/state/checkout';
import { activeChargeStore } from '@/state/activeCharge';
import { consumeLastStart, startFleetCharge, startHostedCharge, startRoamingCharge } from '../checkoutFlow';

const mockRouter = jest.requireMock('expo-router').router as { push: jest.Mock; replace: jest.Mock };
const { charge: mockCharge, roaming: mockRoaming } = jest.requireMock('@/api/client').api as { charge: { prepaid: jest.Mock; start: jest.Mock; fleet: jest.Mock }; roaming: { start: jest.Mock } };

beforeEach(() => {
  jest.clearAllMocks();
  checkoutStore.set({ pending: null });
  activeChargeStore.set({ current: null });
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
  expect(consumeLastStart()).toMatchObject({ presentToken: 'PS123' });
  expect(consumeLastStart()).toBeNull();
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
