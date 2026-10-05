import { router } from 'expo-router';
import { api } from '@/api/client';
import { ApiError, newIdempotencyKey } from '@/api/http';
import type { PayRequest, RoamingStartRequest, StartResult } from '@/api/types';
import { returnUrl } from '@/native/browser';
import { setActiveCharge } from '@/state/activeCharge';
import { ensureDevice } from '@/state/auth';
import { setPendingCheckout } from '@/state/checkout';
import { qk, queryClient } from '@/state/queryClient';

/**
 * The start flows (spec §3 J1, §6.4–6.6). Every path ends on the session screen, which owns the state machine
 * (payment confirmation, start timeouts, refunds) — so no flow can leave the driver in a dead "starting" state.
 */

/** The start token the charger needs when the remote start could not reach it (shown on the session screen). */
let lastStart: StartResult | null = null;
export const consumeLastStart = () => {
  const s = lastStart;
  lastStart = null;
  return s;
};

export async function startAfterPayment(chargeId: string, siteName: string): Promise<void> {
  try {
    lastStart = await api.charge.start(chargeId);
  } catch (e) {
    // The session screen shows the server's state; a start error here is shown there too.
    lastStart = { ok: false, error: e instanceof ApiError ? e.message : undefined };
  }
  setActiveCharge({ kind: 'charge', id: chargeId, siteName, startedAt: Date.now() });
  setPendingCheckout(null);
  void queryClient.invalidateQueries({ queryKey: qk.history });
  router.replace(`/session/charge/${chargeId}`);
}

export async function startHostedCharge(args: { connectorId: string; siteName: string; amountMinor: number; pay: PayRequest; promoCode?: string; idempotencyKey?: string }): Promise<void> {
  await ensureDevice();
  const r = await api.charge.prepaid(args.connectorId, args.amountMinor, { ...args.pay, returnUrl: returnUrl() }, args.promoCode, args.idempotencyKey ?? newIdempotencyKey());
  if (!r.ok || !r.chargeId) throw new ApiError('business', r.error ?? '', 422, r.code, r);
  // A saved card / linked e-wallet that went through at once: straight to charging.
  if (r.payment?.action === 'done') return startAfterPayment(r.chargeId, args.siteName);
  setPendingCheckout({ kind: 'charge', result: r, connectorId: args.connectorId, siteName: args.siteName, at: Date.now() });
  router.push(`/pay/charge/${r.chargeId}`);
}

export async function startFleetCharge(connectorId: string, siteName: string): Promise<void> {
  await ensureDevice();
  const r = await api.charge.fleet(connectorId);
  if (!r.ok || !r.chargeId) throw new ApiError('business', r.error ?? '', 422, r.code, r);
  return startAfterPayment(r.chargeId, siteName);
}

export async function startRoamingCharge(req: RoamingStartRequest, siteName: string, operator: string): Promise<void> {
  await ensureDevice();
  const r = await api.roaming.start({ ...req, returnUrl: returnUrl() });
  if (!r.ok || !r.chargeId) throw new ApiError('business', r.error ?? '', 422, r.code, r);
  if (r.payment && r.payment.action !== 'done') {
    setPendingCheckout({ kind: 'roaming', result: r, siteName, operator, at: Date.now() });
    router.push(`/pay/roaming/${r.chargeId}`);
    return;
  }
  setActiveCharge({ kind: 'roaming', id: r.chargeId, siteName, startedAt: Date.now() });
  router.replace(`/session/roaming/${r.chargeId}`);
}

/**
 * Reserve a connector. Free (or fleet-invoiced): held at once. With a reservation fee: paid first like a charge
 * (QRIS / card / e-wallet → the pay screen), and the connector is held once the fee is paid.
 * Returns true when the connector is already held.
 */
export async function reserveConnector(args: { connectorId: string; siteName: string; pay?: PayRequest }): Promise<boolean> {
  await ensureDevice();
  const r = await api.reservations.reserve(args.connectorId, args.pay ? { ...args.pay, returnUrl: returnUrl() } : {});
  if (!r.ok) throw new ApiError('business', r.error ?? '', 422, r.code, r);
  void queryClient.invalidateQueries({ queryKey: qk.connector(args.connectorId) });
  if (!r.checkout || r.checkout.state === 'held' || r.payment?.action === 'done') return true;
  setPendingCheckout({ kind: 'reservation', result: { ...r, checkout: r.checkout }, connectorId: args.connectorId, siteName: args.siteName, at: Date.now() });
  router.push(`/pay/reservation/${r.checkout.id}`);
  return false;
}

/**
 * Pay an unpaid session (a card hold that expired before capture, post-pay whose charge failed, a partner network
 * shortfall) with any method the operator offers. Returns true when it was paid at once (saved card, linked wallet).
 */
export async function payUnpaidSession(args: { chargeId: string; siteName: string; pay: PayRequest }): Promise<boolean> {
  await ensureDevice();
  const r = await api.charge.payUnpaid(args.chargeId, { ...args.pay, returnUrl: returnUrl() });
  if (r.ok === false) throw new ApiError('business', r.error ?? '', 422, r.code, r);
  if (r.paid || r.payment?.action === 'done') {
    void queryClient.invalidateQueries({ queryKey: qk.unpaid });
    void queryClient.invalidateQueries({ queryKey: ['receipt'] });
    return true;
  }
  setPendingCheckout({ kind: 'unpaid', chargeId: args.chargeId, result: r, siteName: args.siteName, at: Date.now() });
  router.push(`/pay/unpaid/${args.chargeId}`);
  return false;
}
