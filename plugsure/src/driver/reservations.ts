import { appNameFor } from '../services/brand.js';
import { randomBytes } from 'node:crypto';
import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config, isRelaxedEnv } from '../config.js';
import * as registry from '../ocpp/registry.js';
import { reserveNow, cancelReservation } from '../ocpp/commands.js';
import { bus } from '../services/events.js';
import { connectorMaySellEnergy } from '../services/compliance.js';
import { fleetTokenProblem, paymentView, qrDataUri, qrPngDataUri, type PayOptions } from './charge.js';
import { feeTax } from '../services/benefits.js';
import { paymentsFor, startPayment, logPaymentCreated, PaymentsUnavailable, MethodUnavailable } from '../services/payments/registry.js';
import { markRefundDue } from '../services/refunds.js';
import { notifyReservation } from './notify.js';
import type { DriverPrincipal } from './identity.js';

/**
 * Reserving a connector from the driver app (PlugSure chargers).
 *
 * The charger itself holds the connector (OCPP ReserveNow), so a walk-up driver
 * cannot take it. The reserved idTag is the one that will start the charge:
 *   fleet driver    their card
 *   account driver  a claim token minted now, which checkout reuses as the
 *                   payment's claim token (so paying does not change the idTag)
 *
 * Signed-in drivers only (a phone number or a fleet card), one live reservation
 * each, for DRIVER_RESERVATION_MINUTES. A driver who lets reservations lapse
 * too often in a day cannot reserve again until the next day.
 *
 * A site may charge a reservation fee (site.reservation_fee_idr, plus PPN when the
 * operator is PKP). An app driver pays it first (reservation_checkout: QRIS, e-wallet,
 * card, saved card or linked e-wallet) and the connector is held once it is paid; a
 * fleet card's fee goes on the next fleet invoice. The fee is kept once the connector
 * is held, whether or not the driver charges: it pays for holding the connector. It is
 * not charged (or refunded) when the charger refuses the hold, or when the driver
 * cancels within FEE_GRACE_MIN minutes. Queue offers are always free.
 *
 * A site queue's offer to the next driver (queue.ts) is a reservation too, linked
 * by queue_entry_id: it is shown and started the same way, but it ends in the
 * queue (served, missed, left) and never counts as a reservation no-show.
 */

export interface ReservationView {
  id: string; connectorId: string; siteName: string; chargerName: string; connectorNo: number;
  state: string; expiresAt: string; minutesLeft: number;
  /** An offer from the site's queue rather than the driver's own reservation. */
  queue: boolean;
}

const SELECT = `SELECT r.*, s.name AS site_name, COALESCE(cp.display_name, cp.ocpp_identity) AS charger_name, cp.ocpp_identity
                  FROM driver_reservation r
                  JOIN charge_point cp ON cp.id = r.charge_point_id
                  JOIN site s ON s.id = cp.site_id`;

function view(r: any): ReservationView {
  return {
    id: r.id, connectorId: r.connector_uuid, siteName: r.site_name, chargerName: r.charger_name, connectorNo: r.connector_no,
    state: r.state, expiresAt: new Date(r.expires_at).toISOString(),
    minutesLeft: Math.max(0, Math.ceil((new Date(r.expires_at).getTime() - Date.now()) / 60_000)),
    queue: !!r.queue_entry_id,
  };
}

/** The driver's live reservation, if any. */
export async function currentReservation(p: DriverPrincipal): Promise<ReservationView | null> {
  const r = await one(`${SELECT} WHERE r.device_id = $1 AND r.state IN ('requested','active') ORDER BY r.created_at DESC LIMIT 1`, [p.deviceId]);
  return r ? view(r) : null;
}

/** A live reservation on a connector, with whether it is this driver's. */
export async function reservationOn(connectorUuid: string, p?: DriverPrincipal | null) {
  const r = await one<{ id: string; device_id: string; app_driver_id: string | null; token_id: string; expires_at: Date }>(
    `SELECT id, device_id, app_driver_id, token_id, expires_at FROM driver_reservation
      WHERE connector_uuid = $1 AND state IN ('requested','active') AND expires_at > now()`,
    [connectorUuid],
  );
  if (!r) return null;
  const mine = !!p && (r.device_id === p.deviceId || (!!r.app_driver_id && r.app_driver_id === p.appDriverId));
  return { ...r, mine };
}

/** Cancelling this soon after the connector is held costs nothing. */
export const FEE_GRACE_MIN = 2;

export async function reserve(p: DriverPrincipal, connectorUuid: string, pay: PayOptions = { returnUrl: '/app/paid.html' }): Promise<{ ok: boolean; error?: string; code?: string; reservation?: ReservationView } & Partial<CheckoutStarted>> {
  if (!config.driverApp.reservationsEnabled) return { ok: false, error: 'Reservasi tidak tersedia.' };
  if (!p.account && !p.fleet) return { ok: false, error: 'Masuk dengan nomor HP atau kartu armada untuk memesan.' };
  if (!/^[0-9a-f-]{36}$/i.test(connectorUuid)) return { ok: false, error: 'Konektor tidak ditemukan.' };
  const c = await one<{ connector_uuid: string; connector_no: number; charge_point_id: string; ocpp_identity: string; org_id: string; status: string; tera_status: string; in_maintenance: boolean; listed: boolean; suspended: boolean; site_name: string; reservation_fee_idr: number; pkp: boolean }>(
    `SELECT c.id AS connector_uuid, e.evse_id AS connector_no, cp.id AS charge_point_id, cp.ocpp_identity, s.org_id, c.status,
            c.tera_status, (c.maintenance_reason IS NOT NULL) AS in_maintenance, s.name AS site_name, s.reservation_fee_idr, o.pkp,
            (cp.status NOT IN ('pending_adoption','decommissioned') AND s.archived_at IS NULL) AS listed,
            (cp.status = 'suspended') AS suspended
       FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id
       JOIN organisation o ON o.id = s.org_id
      WHERE c.id = $1`,
    [connectorUuid],
  );
  if (!c || !c.listed) return { ok: false, error: 'Konektor tidak ditemukan.' };
  if (!connectorMaySellEnergy(c.tera_status as any).allowed || c.in_maintenance || c.suspended) return { ok: false, error: 'Konektor ini sedang tidak dapat dipakai.' };
  if (!registry.isOnline(c.ocpp_identity)) return { ok: false, error: 'Charger sedang luring; tidak dapat dipesan.' };
  if (c.status !== 'Available') return { ok: false, error: 'Konektor ini sedang tidak tersedia untuk dipesan.' };
  if (p.fleet && p.fleet.orgId !== c.org_id) return { ok: false, error: 'Charger ini bukan milik armada Anda.' };
  if (p.fleet) {
    const problem = await fleetTokenProblem(p.fleet.tokenId);
    if (problem) return { ok: false, error: problem };
  }
  if ((await currentReservation(p)) || (await (await import('./roaming.js')).hasRoamingReservation(p.deviceId))) {
    return { ok: false, error: 'Anda sudah punya reservasi aktif. Batalkan dulu untuk memesan yang lain.' };
  }
  const noShows = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM driver_reservation
      WHERE state = 'expired' AND queue_entry_id IS NULL AND created_at > now() - interval '24 hours'
        AND (device_id = $1 OR ($2::uuid IS NOT NULL AND app_driver_id = $2))`,
    [p.deviceId, p.appDriverId],
  );
  if ((noShows?.n ?? 0) >= config.driverApp.reservationNoShowLimit) {
    return { ok: false, error: `Reservasi Anda sudah ${noShows!.n}x tidak dipakai hari ini. Coba lagi besok, atau langsung isi di charger.` };
  }

  // A site with a queue: a free connector belongs to the next driver in it, not to whoever reserves first.
  const { queueBlocks } = await import('./queue.js');
  const queued = await queueBlocks(c.connector_uuid, p);
  if (queued) return { ok: false, error: queued };

  // A reservation fee: an app driver pays it first; a fleet card's goes on the fleet invoice.
  const fee = c.reservation_fee_idr > 0 ? { feeIdr: c.reservation_fee_idr, ...feeTax(c.reservation_fee_idr, c.pkp) } : null;
  if (fee && !p.fleet) return startCheckout(p, c, fee, pay);
  const fleetAccount = fee && p.fleet ? (await one<{ id: string | null }>(`SELECT fleet_account_id AS id FROM token WHERE id = $1`, [p.fleet.tokenId]))?.id ?? null : null;
  const held = await holdConnector(
    { orgId: c.org_id, deviceId: p.deviceId, appDriverId: p.appDriverId, fleet: p.fleet ? { tokenId: p.fleet.tokenId, uid: p.fleet.uid } : null },
    c, config.driverApp.reservationMinutes, null,
    fee && fleetAccount ? { ...fee, state: 'invoice', intentId: null, fleetAccountId: fleetAccount } : null,
  );
  if (!held.ok) {
    if (held.conflict) return { ok: false, error: 'Konektor ini baru saja dipesan orang lain.' };
    const why = held.status === 'Occupied' ? 'Konektor sedang dipakai.' : held.status === 'Faulted' || held.status === 'Unavailable' ? 'Konektor sedang tidak berfungsi.' : 'Charger menolak reservasi.';
    return { ok: false, error: `${why} Coba konektor lain.` };
  }
  return { ok: true, reservation: view({ ...held.row, site_name: c.site_name, charger_name: c.ocpp_identity }) };
}

/** Who a connector is held for: a signed-in driver's phone, and their fleet card if they charge on one. */
export interface Holder { orgId: string; deviceId: string; appDriverId: string | null; fleet: { tokenId: string; uid: string } | null }
export interface HoldTarget { connector_uuid: string; connector_no: number; charge_point_id: string; ocpp_identity: string; org_id: string }

/**
 * Hold a connector on the charger (OCPP ReserveNow) for `minutes`: a driver's own
 * reservation, or a queue offer (`queueEntryId`). The idTag the charger holds it for
 * is the fleet card, or a prepaid claim token minted now that checkout reuses.
 * `conflict`: someone else holds the connector, or this phone already holds one.
 */
/** What a reservation costs, and where its fee stands (see the header). */
export interface HoldFee { feeIdr: number; dpp: number; ppn: number; total: number; state: 'paid' | 'invoice'; intentId: string | null; fleetAccountId: string | null }

export async function holdConnector(h: Holder, c: HoldTarget, minutes: number, queueEntryId: string | null, fee: HoldFee | null = null):
  Promise<{ ok: true; row: any } | { ok: false; status: string; conflict?: boolean }> {
  const expires = new Date(Date.now() + minutes * 60_000);
  let tokenId: string;
  let idTag: string;
  if (h.fleet) {
    tokenId = h.fleet.tokenId;
    idTag = h.fleet.uid;
  } else {
    // A prepaid claim token, usable only once it is paid for (authorizeIdTag checks the payment).
    idTag = `PS-${randomBytes(6).toString('hex').toUpperCase()}`;
    const t = await one<{ id: string }>(
      `INSERT INTO token (org_id, kind, uid, status, valid_to) VALUES ($1,'prepaid',$2,'Accepted',$3) RETURNING id`,
      [c.org_id, idTag, expires],
    );
    tokenId = t!.id;
  }
  let row: any;
  try {
    row = await one(
      `INSERT INTO driver_reservation (org_id, device_id, app_driver_id, fleet_token_id, token_id, connector_uuid, charge_point_id, connector_no, expires_at,
                                       queue_entry_id, reminded_at, fee_idr, fee_dpp_idr, fee_ppn_idr, fee_total_idr, fee_state, fee_intent_id, fleet_account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $10::uuid IS NULL THEN NULL ELSE now() END,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [c.org_id, h.deviceId, h.appDriverId, h.fleet?.tokenId ?? null, tokenId, c.connector_uuid, c.charge_point_id, c.connector_no, expires, queueEntryId,
       fee?.feeIdr ?? 0, fee?.dpp ?? 0, fee?.ppn ?? 0, fee?.total ?? 0, fee?.state ?? 'none', fee?.intentId ?? null, fee?.fleetAccountId ?? null],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      if (!h.fleet) await query(`UPDATE token SET status = 'Expired' WHERE id = $1`, [tokenId]);
      return { ok: false, status: 'Held', conflict: true };
    }
    throw e;
  }
  let status = '';
  try {
    const r = await reserveNow(c.ocpp_identity, { connectorId: c.connector_no, expiryDate: expires.toISOString(), idTag, reservationId: row.ocpp_reservation_id }, { type: 'system' });
    status = String(r?.status ?? '');
  } catch (e) {
    status = /not connected/i.test((e as Error).message) ? 'Offline' : 'NoAnswer';
  }
  if (status !== 'Accepted') {
    // Not held: no fee (a paid one is refunded by the caller).
    await query(`UPDATE driver_reservation SET state = 'rejected', charger_status = $2, ended_at = now(), fee_state = CASE WHEN fee_state = 'none' THEN 'none' ELSE 'waived' END WHERE id = $1`, [row.id, status]);
    await retireClaimToken(row);
    return { ok: false, status };
  }
  await query(`UPDATE driver_reservation SET state = 'active', charger_status = 'Accepted', held_at = now() WHERE id = $1`, [row.id]);
  logger.info({ reservation: row.id, cp: c.ocpp_identity, connector: c.connector_no, queueEntry: queueEntryId }, queueEntryId ? 'queue offer held' : 'driver reservation accepted');
  return { ok: true, row: { ...row, state: 'active' } };
}
export async function cancel(p: DriverPrincipal, id: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: 'Reservasi tidak ditemukan.' };
  const r = await one<any>(`${SELECT} WHERE r.id = $1 AND r.device_id = $2 AND r.state IN ('requested','active')`, [id, p.deviceId]);
  if (!r) return { ok: false, error: 'Reservasi tidak ditemukan.' };
  await releaseReservation(id);
  // Changed their mind at once: the fee is not charged (a paid one is refunded).
  if (r.fee_state !== 'none' && r.held_at && Date.now() - new Date(r.held_at).getTime() <= FEE_GRACE_MIN * 60_000) await waiveFee(r, 'Reservation cancelled within ' + FEE_GRACE_MIN + ' minutes');
  // Declining a queue offer gives the place up; the connector goes to the next driver.
  if (r.queue_entry_id) await (await import('./queue.js')).offerEnded(r, 'cancelled');
  return { ok: true };
}

/** End a live reservation and tell the charger (CancelReservation). No ownership check: callers do that. */
export async function releaseReservation(id: string): Promise<void> {
  const r = await one<any>(`${SELECT} WHERE r.id = $1 AND r.state IN ('requested','active')`, [id]);
  if (!r) return;
  await query(`UPDATE driver_reservation SET state = 'cancelled', ended_at = now() WHERE id = $1 AND state IN ('requested','active')`, [id]);
  await retireClaimToken(r);
  try {
    await cancelReservation(r.ocpp_identity, r.ocpp_reservation_id, { type: 'system' });
  } catch (e) {
    // The charger drops it at expiry anyway; the connector is free in PlugSure now.
    logger.warn({ reservation: id, err: (e as Error).message }, 'CancelReservation not delivered');
  }
}

/** A minted claim token that was never paid for must not outlive its reservation. */
async function retireClaimToken(r: { token_id: string; fleet_token_id: string | null }) {
  if (r.fleet_token_id) return;
  await query(
    `UPDATE token SET status = 'Expired' WHERE id = $1 AND kind = 'prepaid'
        AND NOT EXISTS (SELECT 1 FROM payment_intent pi JOIN token t ON t.uid = pi.claim_id_tag WHERE t.id = $1)`,
    [r.token_id],
  );
}

/** Worker: remind 5 minutes before the end, and close reservations that lapsed. */
export async function sweepReservations(): Promise<void> {
  await sweepCheckouts();
  const soon = await many<any>(`${SELECT} WHERE r.state = 'active' AND r.reminded_at IS NULL AND r.expires_at <= now() + interval '5 minutes' AND r.expires_at > now()`);
  for (const r of soon) {
    await query(`UPDATE driver_reservation SET reminded_at = now() WHERE id = $1`, [r.id]);
    await notifyReservation(r.device_id, r.id, 'reminder', r.site_name, new Date(r.expires_at));
  }
  const lapsed = await many<any>(
    `UPDATE driver_reservation r SET state = 'expired', ended_at = now()
      FROM charge_point cp, site s
     WHERE r.state IN ('active','requested') AND r.expires_at <= now() AND cp.id = r.charge_point_id AND s.id = cp.site_id
     RETURNING r.*, s.name AS site_name`,
  );
  for (const r of lapsed) {
    await retireClaimToken(r);
    // A queue offer nobody took: the queue moves on to the next driver.
    if (r.queue_entry_id) await (await import('./queue.js')).offerEnded(r, 'expired');
    else await notifyReservation(r.device_id, r.id, 'expired', r.site_name, new Date(r.expires_at));
  }
}

/** A session on a reserved connector with the reserved idTag uses the reservation up. */
export function registerReservationListeners(): void {
  bus.on('session.started', (e) => void (async () => {
    const used = await many<any>(
      `UPDATE driver_reservation r SET state = 'used', ended_at = now()
         FROM charging_session cs
        WHERE cs.id = $1 AND r.connector_uuid = cs.connector_uuid AND r.state = 'active'
          AND r.token_id = cs.token_id
        RETURNING r.*`,
      [e.sessionId],
    );
    for (const r of used) if (r.queue_entry_id) await (await import('./queue.js')).offerEnded(r, 'used');
  })().catch((err) => logger.warn({ err: (err as Error).message }, 'reservation use not recorded')));
}

// ─────────────────────────────────────────── reservation fees paid in the app

export interface CheckoutStarted {
  checkout: { id: string; state: string; feeIdr: number; ppnIdr: number; totalIdr: number; siteName: string };
  payment?: ReturnType<typeof paymentView>;
  qr?: { qrString: string; qrImage: string; qrPng: string; providerRef: string; amountIdr: number; expiresAt: string | null };
  demo?: boolean;
}
type FeeAmounts = { feeIdr: number; dpp: number; ppn: number; total: number };
type ReserveTarget = HoldTarget & { site_name: string };

/** An app driver pays the reservation fee first; the connector is held once it is paid (reservationFeePaid). */
async function startCheckout(p: DriverPrincipal, c: ReserveTarget, fee: FeeAmounts, pay: PayOptions) {
  let acq: Awaited<ReturnType<typeof paymentsFor>>;
  try { acq = await paymentsFor(c.org_id); } catch (e) { if (e instanceof PaymentsUnavailable) return { ok: false, error: 'Pembayaran belum tersedia di operator ini.' }; throw e; }
  // An earlier checkout this phone abandoned makes way for this one.
  await query(`UPDATE reservation_checkout SET state = 'cancelled', ended_at = now() WHERE device_id = $1 AND state = 'pending'`, [p.deviceId]);
  let started: Awaited<ReturnType<typeof startPayment>>;
  try {
    started = await startPayment(acq, {
      channel: pay.channel, customerPhone: pay.phone ?? p.account?.phone ?? null, returnUrl: pay.returnUrl,
      appDriverId: p.appDriverId, savedCardId: pay.savedCardId ?? null, saveCard: pay.saveCard === true, allowHold: false, walletId: pay.walletId ?? null,
      referenceId: `reservation:${c.connector_uuid}:${Date.now()}`, amountIdr: fee.total, description: `${await appNameFor(c.org_id)} reservasi ${c.site_name}`,
    });
  } catch (e) { if (e instanceof MethodUnavailable) return { ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) }; throw e; }
  const captured = started.immediate === 'captured';
  const intent = await one<{ id: string }>(
    `INSERT INTO payment_intent (org_id, provider, provider_ref, method, mode, state, amount_authorised_idr, idem_key, connector_uuid, integration_id,
                                 channel, checkout_url, provider_payment_id, save_card, driver_card_id, expires_at, amount_captured_idr, captured_at)
     VALUES ($1,$2,$3,$4,'reservation',$5,$6,$3,$7,$8,$9,$10,$11,$12,$13, now() + interval '30 minutes',
             CASE WHEN $5 = 'captured' THEN $6::int END, CASE WHEN $5 = 'captured' THEN now() END) RETURNING id`,
    [c.org_id, acq.provider.name, started.providerRef, started.method, captured ? 'captured' : 'pending', fee.total, c.connector_uuid,
     acq.resolved.integrationId, started.channel, started.checkoutUrl, started.providerPaymentId, started.saveCard, started.savedCardId],
  );
  const co = await one<{ id: string }>(
    `INSERT INTO reservation_checkout (org_id, device_id, app_driver_id, connector_uuid, fee_idr, fee_dpp_idr, fee_ppn_idr, fee_total_idr, payment_intent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [c.org_id, p.deviceId, p.appDriverId, c.connector_uuid, fee.feeIdr, fee.dpp, fee.ppn, fee.total, intent!.id],
  );
  await logPaymentCreated(acq.resolved, c.org_id, started.providerRef, fee.total, 'app reservation', started.channel);
  // A saved card or linked e-wallet taken at once: hold the connector now.
  const held = captured ? await reservationFeePaid(intent!.id) : null;
  const st = await checkoutStatus(p, co!.id);
  if (held && !held.ok) return { ok: false, error: held.error ?? 'Charger menolak reservasi. Biaya reservasi dikembalikan.' };
  return {
    ok: true,
    ...(st?.reservation ? { reservation: st.reservation } : {}),
    checkout: { id: co!.id, state: st?.state ?? 'pending', feeIdr: fee.feeIdr, ppnIdr: fee.ppn, totalIdr: fee.total, siteName: c.site_name },
    payment: paymentView(started, fee.total),
    ...(started.qrString ? { qr: { qrString: started.qrString, qrImage: await qrDataUri(started.qrString), qrPng: await qrPngDataUri(started.qrString), providerRef: started.providerRef, amountIdr: fee.total, expiresAt: started.expiresAt } } : {}),
    demo: acq.provider.demo === true,
  };
}

/**
 * The reservation fee is paid (the acquirer's notification, or at once): hold the connector.
 * Paid for a checkout that was already cancelled or expired, or a connector that can no
 * longer be held: the payment is owed back (Refunds).
 */
export async function reservationFeePaid(intentId: string): Promise<{ ok: boolean; error?: string } | null> {
  const co = await one<any>(`SELECT * FROM reservation_checkout WHERE payment_intent_id = $1`, [intentId]);
  if (!co) return null;
  const claimed = await one<any>(`UPDATE reservation_checkout SET state = 'held' WHERE id = $1 AND state = 'pending' RETURNING *`, [co.id]);
  if (!claimed) {
    if (co.state === 'cancelled' || co.state === 'expired') {
      await markRefundDue(intentId, co.fee_total_idr, 'Reservation fee paid after the reservation was cancelled or had expired');
    }
    return null;
  }
  const target = await one<ReserveTarget>(
    `SELECT c.id AS connector_uuid, e.evse_id AS connector_no, cp.id AS charge_point_id, cp.ocpp_identity, s.org_id, s.name AS site_name
       FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE c.id = $1`,
    [co.connector_uuid]);
  const held = target ? await holdConnector(
    { orgId: co.org_id, deviceId: co.device_id, appDriverId: co.app_driver_id, fleet: null }, target, config.driverApp.reservationMinutes, null,
    { feeIdr: co.fee_idr, dpp: co.fee_dpp_idr, ppn: co.fee_ppn_idr, total: co.fee_total_idr, state: 'paid', intentId, fleetAccountId: null },
  ) : { ok: false as const, status: 'Gone' };
  if (held.ok) {
    await query(`UPDATE reservation_checkout SET reservation_id = $2, ended_at = now() WHERE id = $1`, [co.id, held.row.id]);
    return { ok: true };
  }
  const why = held.conflict ? 'Konektor ini baru saja dipesan orang lain.' : held.status === 'Occupied' ? 'Konektor sedang dipakai.' : 'Charger menolak reservasi.';
  await query(`UPDATE reservation_checkout SET state = 'failed', problem = $2, ended_at = now() WHERE id = $1`, [co.id, why]);
  await markRefundDue(intentId, co.fee_total_idr, `Reservation fee paid but the connector could not be held (${held.status})`);
  return { ok: false, error: `${why} Biaya reservasi dikembalikan.` };
}

/** The acquirer says the fee payment will not complete: the checkout ends; nothing was held. */
export async function reservationFeeFailed(intentId: string): Promise<void> {
  await query(`UPDATE reservation_checkout SET state = 'expired', problem = 'the payment did not complete', ended_at = now() WHERE payment_intent_id = $1 AND state = 'pending'`, [intentId]);
}

/** Where a checkout stands, for the app's payment screen; with the reservation once held. */
export async function checkoutStatus(p: DriverPrincipal, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const co = await one<any>(`SELECT * FROM reservation_checkout WHERE id = $1 AND device_id = $2`, [id, p.deviceId]);
  if (!co) return null;
  const r = co.reservation_id ? await one(`${SELECT} WHERE r.id = $1`, [co.reservation_id]) : null;
  return { id: co.id, state: co.state, problem: co.problem, totalIdr: co.fee_total_idr, reservation: r ? view(r) : null };
}

/** Development / mock provider only: act as if the driver paid the fee. */
export async function confirmCheckoutPayment(p: DriverPrincipal, id: string): Promise<{ ok: boolean; error?: string }> {
  if (!isRelaxedEnv()) return { ok: false, error: 'Not available in production.' };
  const co = await one<{ payment_intent_id: string }>(`SELECT payment_intent_id FROM reservation_checkout WHERE id = $1 AND device_id = $2`, [id, p.deviceId]);
  if (!co) return { ok: false, error: 'Transaksi tidak ditemukan.' };
  const pi = await one<{ provider: string }>(`SELECT provider FROM payment_intent WHERE id = $1`, [co.payment_intent_id]);
  if (pi?.provider !== 'mock') return { ok: false, error: 'Menunggu konfirmasi pembayaran dari penyedia QRIS.' };
  await query(`UPDATE payment_intent SET state = 'captured', amount_captured_idr = amount_authorised_idr, captured_at = now(), updated_at = now() WHERE id = $1 AND state = 'pending'`, [co.payment_intent_id]);
  const r = await reservationFeePaid(co.payment_intent_id);
  return r && !r.ok ? { ok: false, error: r.error } : { ok: true };
}

export async function cancelCheckout(p: DriverPrincipal, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const r = await query(`UPDATE reservation_checkout SET state = 'cancelled', ended_at = now() WHERE id = $1 AND device_id = $2 AND state = 'pending'`, [id, p.deviceId]);
  return (r.rowCount ?? 0) > 0;
}

/** Not charged after all: a fleet fee leaves the invoice; a paid one is owed back. */
async function waiveFee(r: { id: string; fee_state: string; fee_intent_id: string | null; fee_total_idr: number }, reason: string) {
  if (r.fee_state === 'paid' && r.fee_intent_id) {
    await markRefundDue(r.fee_intent_id, r.fee_total_idr, reason);
    await query(`UPDATE driver_reservation SET fee_state = 'refund_due' WHERE id = $1`, [r.id]);
  } else if (r.fee_state === 'invoice') {
    await query(`UPDATE driver_reservation SET fee_state = 'waived' WHERE id = $1`, [r.id]);
  }
}

/** Worker: a fee checkout nobody paid within 30 minutes ends (nothing was held). */
export async function sweepCheckouts(): Promise<void> {
  await query(`UPDATE reservation_checkout SET state = 'expired', problem = 'not paid in time', ended_at = now() WHERE state = 'pending' AND created_at < now() - interval '30 minutes'`);
}