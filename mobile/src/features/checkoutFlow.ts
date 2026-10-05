import { router } from 'expo-router';
import { api } from '@/api/client';
import { ApiError, newIdempotencyKey } from '@/api/http';
import { withIdempotency } from '@/api/idempotency';
import type { PayRequest, RoamingStartRequest, StartResult } from '@/api/types';
import { returnUrl } from '@/native/browser';
import { activeChargeStore, setActiveCharge, setStartRecord, type StartRecord } from '@/state/activeCharge';
import { ensureDevice } from '@/state/auth';
import { setPendingCheckout } from '@/state/checkout';
import { qk, queryClient } from '@/state/queryClient';

/**
 * The start flows (spec §3 J1, §6.4–6.6). Every path ends on the session screen, which owns the state machine
 * (payment confirmation, start timeouts, refunds) — so no flow can leave the driver in a dead "starting" state.
 */

/** Charges whose start was acknowledged in this app run (the server answered ok, or said it already started). */
const acknowledged = new Set<string>();
/** Starts on their way: two pay screens (or a pay screen and the session screen) never both send one. */
const inFlight = new Map<string, Promise<StartRecord>>();

export const startAcknowledged = (chargeId: string) => acknowledged.has(chargeId);
export const startInFlight = (chargeId: string) => inFlight.has(chargeId);

/**
 * The server answers a repeated start of a charge that has already bound its session with `ok:false` ("Sesi ini
 * sudah dimulai."): for the app that is a success — the charge is running.
 */
export function isAlreadyStarted(r: StartResult & { code?: string }): boolean {
  return !r.ok && (r.code === 'already_started' || /sudah dimulai|already (been )?started/i.test(r.error ?? ''));
}

/**
 * `POST /charge/:id/start` — the only way a paid hosted charge starts (the server never starts one by itself). Called
 * after payment, and by the session screen for a paid charge whose start was never acknowledged (the app was killed
 * after paying, the start timed out) or when the driver taps "Try starting again". The answer (start token or error)
 * is kept with the active charge, so it survives a restart. Concurrent calls for one charge share one request.
 */
export function requestStart(chargeId: string): Promise<StartRecord> {
  const running = inFlight.get(chargeId);
  if (running) return running;
  const p = (async () => {
    let r: StartResult;
    try {
      r = await api.charge.start(chargeId);
      if (isAlreadyStarted(r)) r = { ok: true, status: 'Started' };
    } catch (e) {
      // A refusal is a 400 `{ok:false,error}`. Otherwise the session screen shows the error and offers to try again;
      // the server's status stays the truth.
      const refused: StartResult & { code?: string } = { ok: false, error: e instanceof ApiError ? e.message : undefined, code: e instanceof ApiError ? e.code : undefined };
      r = e instanceof ApiError && e.kind === 'business' && isAlreadyStarted(refused) ? { ok: true, status: 'Started' } : { ok: false, error: refused.error };
    }
    const prev = activeChargeStore.get().start;
    // A start token from an earlier answer still works at the charger: keep it unless a new one replaced it.
    const presentToken = r.presentToken ?? (prev?.chargeId === chargeId ? prev.presentToken : undefined);
    const rec: StartRecord = { ...r, presentToken, chargeId, at: Date.now() };
    if (r.ok) acknowledged.add(chargeId);
    setStartRecord(rec);
    return rec;
  })().finally(() => inFlight.delete(chargeId));
  inFlight.set(chargeId, p);
  return p;
}

export async function startAfterPayment(chargeId: string, siteName: string): Promise<void> {
  // A second pay screen (or a second poll) for the same charge: the first one is starting it.
  if (inFlight.has(chargeId)) return;
  if (!acknowledged.has(chargeId)) await requestStart(chargeId);
  setActiveCharge({ kind: 'charge', id: chargeId, siteName, startedAt: Date.now() });
  setPendingCheckout(null);
  void queryClient.invalidateQueries({ queryKey: qk.history });
  router.replace(`/session/charge/${chargeId}`);
}

/** Tests: forget the start bookkeeping of this app run. */
export function resetStartsForTests() {
  acknowledged.clear();
  inFlight.clear();
}

export async function startHostedCharge(args: { connectorId: string; siteName: string; amountMinor: number; pay: PayRequest; promoCode?: string; idempotencyKey?: string }): Promise<void> {
  await ensureDevice();
  const r = await withIdempotency(args.idempotencyKey ?? newIdempotencyKey(), (key) => api.charge.prepaid(args.connectorId, args.amountMinor, { ...args.pay, returnUrl: returnUrl() }, args.promoCode, key));
  if (!r.ok || !r.chargeId) throw new ApiError('business', r.error ?? '', 422, r.code, r);
  // A saved card / linked e-wallet that went through at once: straight to charging.
  if (r.payment?.action === 'done') return startAfterPayment(r.chargeId, args.siteName);
  setPendingCheckout({ kind: 'charge', result: r, connectorId: args.connectorId, siteName: args.siteName, at: Date.now() });
  router.push(`/pay/charge/${r.chargeId}`);
}

export async function startFleetCharge(connectorId: string, siteName: string, idempotencyKey = newIdempotencyKey()): Promise<void> {
  await ensureDevice();
  const r = await withIdempotency(idempotencyKey, (key) => api.charge.fleet(connectorId, key));
  if (!r.ok || !r.chargeId) throw new ApiError('business', r.error ?? '', 422, r.code, r);
  return startAfterPayment(r.chargeId, siteName);
}

export async function startRoamingCharge(req: RoamingStartRequest, siteName: string, operator: string, idempotencyKey = newIdempotencyKey()): Promise<void> {
  await ensureDevice();
  const r = await withIdempotency(idempotencyKey, (key) => api.roaming.start({ ...req, returnUrl: returnUrl() }, key));
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
export async function reserveConnector(args: { connectorId: string; siteName: string; pay?: PayRequest; idempotencyKey?: string }): Promise<boolean> {
  await ensureDevice();
  const r = await withIdempotency(args.idempotencyKey ?? newIdempotencyKey(), (key) => api.reservations.reserve(args.connectorId, args.pay ? { ...args.pay, returnUrl: returnUrl() } : {}, key));
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
export async function payUnpaidSession(args: { chargeId: string; siteName: string; pay: PayRequest; idempotencyKey?: string }): Promise<boolean> {
  await ensureDevice();
  const r = await withIdempotency(args.idempotencyKey ?? newIdempotencyKey(), (key) => api.charge.payUnpaid(args.chargeId, { ...args.pay, returnUrl: returnUrl() }, key));
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
