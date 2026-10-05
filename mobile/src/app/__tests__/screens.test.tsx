/**
 * Key screens render against the in-memory backend: connector (price before start, tax label, methods, start CTA),
 * session (state machine on screen), activity (empty / history), account (guest), resolver, delete account.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { api } from '@/api/client';
import { freshDevice, renderScreen } from '@/test/render';

jest.mock('expo-router', () => require('@/test/expoRouterMock'));
jest.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: false, canAskAgain: true }, jest.fn()] }));
jest.mock('expo-notifications', () => ({ AndroidImportance: {}, AndroidNotificationVisibility: {}, AndroidNotificationPriority: {}, getPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })) }));

const { setParams, router } = jest.requireMock('expo-router') as typeof import('@/test/expoRouterMock');
const CONNECTOR = '00000000-0000-4000-8000-000000001001'; // Senayan Hub, CCS2 120 kW, available, IDR

beforeEach(async () => {
  jest.clearAllMocks();
  await freshDevice();
});

it('Connector: price before start with tax label, fees, presets, QRIS default and the start CTA', async () => {
  setParams({ id: CONNECTOR });
  const Screen = require('../connector/[id]').default;
  await renderScreen(<Screen />);
  expect(await screen.findByText('Rp 2,467')).toBeTruthy();
  expect(screen.getByText('excl. PPN & local tax')).toBeTruthy();
  expect(screen.getByText('Service fee')).toBeTruthy();
  expect(screen.getByText('Rp 100,000')).toBeTruthy();
  expect(await screen.findByText(/≈ .* kWh for this amount/)).toBeTruthy();
  const qris = await screen.findByTestId('method-m:QRIS');
  // No silent default: the CTA waits for a choice, which is then shown next to it.
  expect(qris.props.accessibilityState).toMatchObject({ checked: false });
  expect(screen.getByTestId('choose-method-hint')).toBeTruthy();
  await fireEvent.press(qris);
  expect(screen.getByTestId('method-m:QRIS').props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByTestId('chosen-method')).toHaveTextContent('Paying with QRIS');
  expect(screen.getByTestId('start-cta')).toBeTruthy();
});

it('Connector → start with QRIS → payment screen route', async () => {
  setParams({ id: CONNECTOR });
  const Screen = require('../connector/[id]').default;
  const { settingsStore } = require('@/state/settings');
  settingsStore.set({ simpleStart: true });
  await renderScreen(<Screen />);
  await fireEvent.press(await screen.findByTestId('method-m:QRIS'));
  await fireEvent.press(screen.getByRole('button', { name: /Slide to pay Rp 100,000/ }));
  await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/pay\/charge\//)));
});

it('Session: shows the start timeline, then live charging figures and Stop', async () => {
  const s = (await api.stations.list()).find((x) => x.currency === 'IDR' && x.availableCount > 0)!;
  const co = await api.charge.prepaid(s.connectors.find((c) => c.available)!.connectorId, 100000, { method: 'QRIS' });
  await api.charge.confirmDemoPayment(co.chargeId!);
  await api.charge.start(co.chargeId!);
  setParams({ kind: 'charge', id: co.chargeId! });
  const Screen = require('../session/[kind]/[id]').default;
  const first = await renderScreen(<Screen />);
  expect(await screen.findByText('Starting…')).toBeTruthy();
  expect(screen.getByText('Payment received')).toBeTruthy();
  expect(screen.getByText('Plug in your car')).toBeTruthy();
  await first.unmount();
  // 8 s later (the mock backend runs simulated time 40× faster): the car draws current.
  const real = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(real + 8000);
  await renderScreen(<Screen />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(await screen.findByTestId('energy', {}, { timeout: 4000 })).toBeTruthy();
  expect(screen.getByText('Charging')).toBeTruthy();
  expect(screen.getByText('Cost so far')).toBeTruthy();
  expect(screen.getByText(/^Battery \d+%$/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Stop charging' })).toBeTruthy();
  jest.restoreAllMocks();
}, 15_000);

it('Activity: guest with no charges sees the empty state and the sign-in hint', async () => {
  const Screen = require('../(tabs)/activity').default;
  await renderScreen(<Screen />);
  expect(await screen.findByTestId('history-empty')).toBeTruthy();
  expect(screen.getByText('Sign in with your phone number to keep your receipts on every device.')).toBeTruthy();
});

it('Activity: signed-in history with totals per currency (never mixed)', async () => {
  await api.identity.verifyOtp('+6281234567890', '123456');
  const Screen = require('../(tabs)/activity').default;
  await renderScreen(<Screen />);
  expect(await screen.findByText('Sudirman Tower')).toBeTruthy();
  expect(screen.getAllByText('S$ 22.39', { exact: false }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('SGD').length).toBeGreaterThan(0);
  expect(screen.getAllByText('MYR').length).toBeGreaterThan(0);
});

it('Account: guest sees the sign-in card and legal links', async () => {
  const Screen = require('../(tabs)/account').default;
  await renderScreen(<Screen />);
  expect(await screen.findByTestId('signin-card')).toBeTruthy();
  expect(screen.getByText('Privacy policy')).toBeTruthy();
  expect(screen.getByText('Terms of use')).toBeTruthy();
  expect(screen.queryByTestId('delete-account')).toBeNull();
});

it('Deep-link resolver: unknown code → not-found state with manual entry', async () => {
  setParams({ code: 'NOPE-404' });
  const Screen = require('../c/[code]').default;
  await renderScreen(<Screen />);
  expect(await screen.findByTestId('resolve-not-found')).toBeTruthy();
});

it('Deep-link resolver: a known code redirects to its connector', async () => {
  setParams({ code: 'AK-SNY-01:1' });
  const Screen = require('../c/[code]').default;
  await renderScreen(<Screen />);
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/connector/${CONNECTOR}`));
});

it('Delete account: refused while a reservation is open (409 blockers), then deleted; the device starts again as a guest', async () => {
  await api.identity.verifyOtp('+6281234567890', '123456');
  await api.reservations.reserve(CONNECTOR);
  const before = (await api.identity.me()).deviceId;
  const Screen = require('../delete-account').default;
  await renderScreen(<Screen />);
  await fireEvent.press(screen.getByTestId('delete-continue'));
  expect(await screen.findByText('Enter the code we sent to +62 812-****-7890 to confirm.')).toBeTruthy();
  expect(screen.getByText('You have an active reservation')).toBeTruthy();
  await fireEvent.changeText(await screen.findByTestId('delete-code'), '123456');
  await fireEvent.press(screen.getByTestId('delete-confirm'));
  expect(await screen.findByTestId('delete-blocked')).toBeTruthy();
  const r = (await api.reservations.current()).reservation!;
  await api.reservations.cancel(r.id);
  await fireEvent.press(screen.getByTestId('delete-continue'));
  await fireEvent.changeText(await screen.findByTestId('delete-code'), '123456');
  await fireEvent.press(screen.getByTestId('delete-confirm'));
  expect(await screen.findByTestId('delete-done')).toBeTruthy();
  const after = await api.identity.me();
  expect(after.account).toBeNull();
  expect(after.deviceId).not.toBe(before);
});

it('Delete account: OTP confirm deletes the account', async () => {
  await api.identity.verifyOtp('+6281234567890', '123456');
  const Screen = require('../delete-account').default;
  await renderScreen(<Screen />);
  await fireEvent.press(screen.getByTestId('delete-continue'));
  await fireEvent.changeText(await screen.findByTestId('delete-code'), '123456');
  await fireEvent.press(screen.getByTestId('delete-confirm'));
  expect(await screen.findByTestId('delete-done')).toBeTruthy();
  expect((await api.identity.me()).account).toBeNull();
});

it('Connector: a signed-in driver can reserve a free connector (where the operator offers it)', async () => {
  await api.identity.verifyOtp('+6281234567890', '123456');
  setParams({ id: CONNECTOR });
  const Screen = require('../connector/[id]').default;
  await renderScreen(<Screen />);
  await fireEvent.press(await screen.findByTestId('reserve'));
  expect(await screen.findByText('Reserved for you')).toBeTruthy();
  expect((await api.reservations.current()).reservation).toMatchObject({ connectorId: CONNECTOR });
});

it('Station: a signed-in driver joins the site queue (every connector busy) and leaves it', async () => {
  await api.identity.verifyOtp('+6281234567890', '123456');
  setParams({ siteId: '00000000-0000-4000-8000-000000000002' }); // Kuningan Central: both connectors charging
  const Screen = require('../station/[siteId]').default;
  await renderScreen(<Screen />);
  await fireEvent.press(await screen.findByTestId('queue-join'));
  expect(await screen.findByText('You are number 1 in line')).toBeTruthy();
  expect((await api.reservations.myQueue()).entry).toMatchObject({ position: 1, siteName: 'Kuningan Central P2' });
  await fireEvent.press(screen.getByTestId('queue-leave'));
  await waitFor(async () => expect((await api.reservations.myQueue()).entry).toBeNull());
});

const FEE_CONNECTOR = '00000000-0000-4000-8000-000000001009'; // Sudirman Tower, Rp 5,550 reservation fee

it('Connector with a reservation fee: the button shows the fee and opens the payment', async () => {
  await api.identity.verifyOtp('+6281234567890', '123456');
  setParams({ id: FEE_CONNECTOR });
  const Connector = require('../connector/[id]').default;
  await renderScreen(<Connector />);
  expect((await screen.findByTestId('reserve')).props.accessibilityLabel).toBe('Reserve for 15 min · Rp 5,550');
  await fireEvent.press(await screen.findByTestId('method-m:QRIS'));
  await fireEvent.press(screen.getByTestId('reserve'));
  await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/pay\/reservation\//)));
});

it('Reservation fee payment (QRIS, demo) → the connector is held', async () => {
  await api.identity.verifyOtp('+6281234567890', '123456');
  const { reserveConnector } = require('@/features/checkoutFlow');
  expect(await reserveConnector({ connectorId: FEE_CONNECTOR, siteName: 'Sudirman Tower', pay: { method: 'QRIS' } })).toBe(false);
  const checkoutId = String((router.push as jest.Mock).mock.calls[0][0]).split('/').pop()!;
  setParams({ kind: 'reservation', id: checkoutId });
  const Pay = require('../pay/[kind]/[id]').default;
  await renderScreen(<Pay />);
  expect(await screen.findByTestId('pay-amount')).toHaveTextContent('Rp 5,550');
  expect(screen.getByText('Reservation fee — the connector is held once paid')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('simulate-payment'));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/connector/${FEE_CONNECTOR}`));
  expect((await api.reservations.current()).reservation).toMatchObject({ connectorId: FEE_CONNECTOR });
});
