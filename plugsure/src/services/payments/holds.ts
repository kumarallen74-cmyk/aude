import { many, one, outsideRequestScope, query } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { bus } from '../events.js';
import { moneyText, currencyOr, LEGACY_CURRENCY } from '../../domain/money.js';
import { extras, providerOfPayment } from './registry.js';
import type pg from 'pg';
import { unseal } from '../secrets.js';
import { currentLink, endLink } from './cards.js';
import type { Channel } from './provider.js';

/** hold_error of a post-pay charge whose e-wallet link has ended (the receipt and "pay now" say to link again). */
export const LINK_ENDED = 'link ended:';
/** hold_error of a card hold whose authorisation expired at the acquirer before it was captured. */
export const HOLD_EXPIRED = 'hold expired:';
/**
 * hold_error of a post-pay charge whose outcome is unknown (no answer from the acquirer). It names the charge's reference,
 * so the next attempt can look that charge up (or send the same reference again) instead of charging blind.
 */
export const OUTCOME_UNKNOWN = 'outcome unknown:';
const UNKNOWN_RE = /^outcome unknown: the e-wallet charge (postpay:[0-9a-f-]{36}:\d+)/;
/** What the console says when an expired hold is retried. */
const EXPIRED_EXPLAINED = 'The card authorisation expired at the acquirer before it was captured, so it can no longer be captured. Nothing was taken from the card; collect the amount another way or write it off.';

/**
 * Card holds (pre-authorisation).
 *
 * The driver's card is authorised for the amount they chose. The charger
 * delivers up to that, like a pre-purchase. When the session is rated,
 * PlugSure captures the actual total (never more than the hold), and the
 * acquirer releases the rest. A hold that never starts a session, or a session
 * that delivered nothing, is released entirely. Nothing goes through the
 * refund queue, because nothing extra was taken.
 *
 *   held ─ rated ─→ capturing ─→ captured
 *     │                  └──→ capture_failed ─ retry ─→ captured
 *     └ unused / 0 kWh ─→ releasing ─→ released
 *                              └──→ release_failed ─ retry ─→ released
 *
 * Captures and releases are retried with back-off (the worker), and can be
 * retried from the console (Refunds → Card holds). An authorisation expires at
 * the acquirer after some days (Midtrans: 7 by default), so a capture still
 * failing after the last automatic retry raises a critical alert. A capture the
 * acquirer refuses because the authorisation has expired (Midtrans 407, Xendit
 * EXPIRED), or its expiry notification, ends the hold at once: no more retries,
 * a critical alert, and the receipt and console say what happened.
 *
 * Post-pay with a linked e-wallet (mode 'postpay') runs the same machine with
 * nothing held at the acquirer: 'capture' charges the linked e-wallet the
 * session's total, 'release' takes nothing. A charge the e-wallet wants the
 * driver to confirm (PIN) waits for them (the receipt offers the link); a driver
 * with an unpaid post-pay session cannot start another one.
 */

/** Minutes before each automatic retry; after the last, an alert and manual retry only. */
const BACKOFF_MIN = [2, 10, 30, 120, 360, 720];
/** Unused holds are released this long after checkout (the claim window plus grace). */
const UNUSED_AFTER_MIN = 35;

export type HoldState = 'held' | 'capturing' | 'captured' | 'capture_failed' | 'releasing' | 'released' | 'release_failed';

interface HoldRow {
  id: string; org_id: string; provider: string; provider_ref: string | null; provider_payment_id: string | null; integration_id: string | null;
  hold_state: HoldState; hold_capture_minor: number | null; hold_attempts: number; amount_authorised_minor: number | null; session_id: string | null;
  mode: string; driver_card_id: string | null; channel: string | null; currency: string;
}

/** Settlement: capture what the session cost (capped at the hold), or release it all when nothing is owed. */
export async function settleHold(intentId: string, invoicedMinor: number): Promise<{ captureMinor: number; shortMinor: number }> {
  const row = await one<{ authorised: number | null }>(`SELECT amount_authorised_minor AS authorised FROM payment_intent WHERE id = $1`, [intentId]);
  const authorised = Number(row?.authorised ?? 0);
  const captureMinor = Math.max(0, Math.min(Math.round(invoicedMinor), authorised));
  await query(
    `UPDATE payment_intent SET hold_state = $2, hold_capture_minor = $3, hold_attempts = 0, hold_error = NULL, hold_next_attempt_at = now(), updated_at = now()
      WHERE id = $1 AND hold_state IN ('held', 'capture_failed', 'release_failed')`,
    [intentId, captureMinor > 0 ? 'capturing' : 'releasing', captureMinor],
  );
  // Not awaited: the charger's StopTransaction must not wait on the acquirer. The worker retries if this fails.
  setImmediate(() => { outsideRequestScope(() => attemptHold(intentId)).catch((e) => logger.warn({ intentId, err: (e as Error).message }, 'hold capture deferred to the worker')); });
  return { captureMinor, shortMinor: Math.max(0, Math.round(invoicedMinor) - authorised) };
}

/** Carry out the capture or release a hold is waiting for. Safe to repeat (idempotency keys at the acquirer). */
export async function attemptHold(intentId: string, opts: { worker?: boolean } = {}): Promise<{ ok: boolean; state: HoldState | null; error?: string }> {
  if (opts.worker) {
    // An automatic retry waits while the driver is paying the session in the app (an unexpired settlement payment):
    // until that payment has expired, plus 5 minutes for its notification. The driver's own "pay now" does not wait.
    const paying = await one<{ until: Date }>(
      `SELECT max(expires_at) + interval '5 minutes' AS until FROM payment_intent
        WHERE settles_intent_id = $1 AND mode = 'settlement' AND state = 'pending' AND expires_at > now() - interval '5 minutes'
       HAVING max(expires_at) IS NOT NULL`, [intentId]);
    if (paying) {
      await query(`UPDATE payment_intent SET hold_next_attempt_at = $2 WHERE id = $1 AND hold_state = 'capture_failed'`, [intentId, paying.until]);
      return { ok: false, state: 'capture_failed', error: 'waiting for the driver to pay in the app' };
    }
  }
  // Claim the attempt so two workers cannot run it at once.
  const h = await one<HoldRow>(
    `UPDATE payment_intent SET hold_attempts = hold_attempts + 1, hold_next_attempt_at = now() + interval '5 minutes'
      WHERE id = $1 AND hold_state IN ('capturing', 'capture_failed', 'releasing', 'release_failed')
        AND (hold_next_attempt_at IS NULL OR hold_next_attempt_at <= now())
      RETURNING id, org_id, provider, provider_ref, provider_payment_id, integration_id, hold_state, hold_capture_minor, hold_attempts, amount_authorised_minor, session_id,
                mode, driver_card_id, channel, currency`,
    [intentId],
  );
  if (!h) {
    const cur = await one<{ hold_state: HoldState | null }>(`SELECT hold_state FROM payment_intent WHERE id = $1`, [intentId]);
    return { ok: false, state: cur?.hold_state ?? null, error: 'nothing to do now' };
  }
  const capture = h.hold_state === 'capturing' || h.hold_state === 'capture_failed';
  const provider = await providerOfPayment(h);
  let result: { ok: boolean; error?: string; pending?: boolean; expired?: boolean };
  if (h.mode === 'postpay') {
    // Nothing is held at the acquirer: releasing takes nothing, capturing charges the linked e-wallet.
    result = capture ? await chargePostpay(h, provider) : { ok: true };
    if (result.pending) return { ok: false, state: 'capturing', error: result.error };
  } else if (!provider?.captureHold || !provider.releaseHold) result = { ok: false, error: `the ${h.provider} account that took this hold is no longer available` };
  else {
    try {
      result = capture
        ? await provider.captureHold({ providerRef: h.provider_ref ?? '', providerPaymentId: h.provider_payment_id, amountMinor: Number(h.hold_capture_minor), idempotencyKey: `hold-capture-${h.id}` })
        : await provider.releaseHold({ providerRef: h.provider_ref ?? '', providerPaymentId: h.provider_payment_id, idempotencyKey: `hold-release-${h.id}` });
    } catch (e) {
      result = { ok: false, error: (e as Error).message };
    }
  }
  // The authorisation lapsed before the capture: retrying cannot help.
  if (capture && result.expired) return holdExpired(h);
  if (result.ok) {
    if (!capture && result.expired) logger.info({ intent: h.id }, 'card hold had already expired at the acquirer: nothing held');
    if (capture) {
      await query(
        `UPDATE payment_intent SET state = 'captured', amount_captured_minor = hold_capture_minor, captured_at = now(), hold_state = 'captured',
                hold_error = NULL, hold_next_attempt_at = NULL, released_at = now(), updated_at = now()
          WHERE id = $1`,
        [h.id],
      );
      bus.emit('payment.hold_captured', { orgId: h.org_id, paymentIntentId: h.id, capturedMinor: Number(h.hold_capture_minor), releasedMinor: Number(h.amount_authorised_minor ?? 0) - Number(h.hold_capture_minor), currency: h.currency });
    } else {
      await query(
        `UPDATE payment_intent SET state = 'voided', hold_state = 'released', hold_error = NULL, hold_next_attempt_at = NULL, released_at = now(), updated_at = now()
          WHERE id = $1`,
        [h.id],
      );
      bus.emit('payment.hold_released', { orgId: h.org_id, paymentIntentId: h.id, releasedMinor: Number(h.amount_authorised_minor ?? 0), currency: h.currency });
    }
    logger.info({ intent: h.id, action: capture ? 'capture' : 'release', amountMinor: h.hold_capture_minor }, 'card hold settled');
    return { ok: true, state: capture ? 'captured' : 'released' };
  }
  const delay = BACKOFF_MIN[h.hold_attempts - 1];
  await query(
    `UPDATE payment_intent SET hold_state = $2, hold_error = $3, updated_at = now(),
            hold_next_attempt_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(mins => $4::int) END
      WHERE id = $1`,
    [h.id, capture ? 'capture_failed' : 'release_failed', String(result.error ?? 'refused').slice(0, 500), delay ?? null],
  );
  logger.warn({ intent: h.id, attempt: h.hold_attempts, err: result.error }, `card hold ${capture ? 'capture' : 'release'} failed`);
  if (delay == null) {
    bus.emit('alert.raised', {
      orgId: h.org_id,
      kind: h.mode === 'postpay' ? 'payment.postpay_failed' : capture ? 'payment.hold_capture_failed' : 'payment.hold_release_failed',
      severity: capture ? 'critical' : 'warning',
      message: h.mode === 'postpay'
        ? `A post-pay e-wallet charge failed after ${h.hold_attempts} attempts (${moneyText(Number(h.hold_capture_minor), currencyOr(h.currency))}): ${result.error}. The driver cannot start another post-pay session until it is paid; they can pay from the app, or retry under Refunds → Holds and post-pay.`
        : capture
        ? `A card hold could not be captured after ${h.hold_attempts} attempts (${moneyText(Number(h.hold_capture_minor), currencyOr(h.currency))}): ${result.error}. The authorisation expires at the acquirer; retry under Refunds → Card holds, or collect otherwise.`
        : `A card hold could not be released after ${h.hold_attempts} attempts: ${result.error}. It will lapse at the acquirer; retry under Refunds → Card holds.`,
      targetType: 'payment_intent',
      targetId: h.id,
    });
  }
  return { ok: false, state: capture ? 'capture_failed' : 'release_failed', error: result.error };
}

/**
 * The hold's authorisation expired at the acquirer before PlugSure captured it: nothing was
 * taken from the card and nothing can be any more. No more retries; one critical alert.
 */
async function holdExpired(h: Pick<HoldRow, 'id' | 'org_id' | 'provider' | 'hold_capture_minor'> & { currency?: string | null }): Promise<{ ok: false; state: HoldState; error: string }> {
  const owed = Number(h.hold_capture_minor ?? 0);
  const owedText = moneyText(owed, currencyOr(h.currency));
  const first = await one<{ id: string }>(
    `UPDATE payment_intent SET hold_state = 'capture_failed', hold_next_attempt_at = NULL, updated_at = now(),
            hold_error = $2
      WHERE id = $1 AND (hold_error IS NULL OR hold_error NOT LIKE 'hold expired:%') RETURNING id`,
    [h.id, `${HOLD_EXPIRED} the card authorisation expired at ${h.provider} before it was captured; ${owedText} can no longer be taken from the card`],
  );
  if (first) {
    logger.warn({ intent: h.id, owedMinor: owed }, 'card hold expired at the acquirer before capture');
    bus.emit('alert.raised', {
      orgId: h.org_id, kind: 'payment.hold_expired', severity: 'critical',
      message: `A card hold expired at the acquirer (${h.provider}) before it was captured: ${owedText} for a charging session was not charged, and it can no longer be taken from the card. The driver is asked to pay it from the receipt in the app (this alert resolves when they do); otherwise collect it another way, or write it off (Refunds → Holds and post-pay).`,
      targetType: 'payment_intent', targetId: h.id,
    });
  }
  return { ok: false, state: 'capture_failed', error: EXPIRED_EXPLAINED };
}

/** In hold_error of a hold (or post-pay session) the driver paid in the app, after its prefix. */
export const PAID_IN_APP = 'paid by the driver in the app';

/**
 * SQL for an amount in MINOR units as its major-unit text: `12345` (IDR, exponent 0), `1.30` (SGD 130). The
 * paid-in-app note used to print the minor units ("S$ 130" for S$ 1.30) for currencies with cents.
 */
export const MAJOR_AMOUNT_SQL = (minor: string, exponent: string) =>
  `to_char(${minor}::numeric / (10 ^ ${exponent}), 'FM999999999990' || CASE WHEN ${exponent} > 0 THEN '.' || repeat('0', ${exponent}) ELSE '' END)`;

/**
 * The driver paid an unpaid session in the app (a 'settlement' payment): an expired card hold, or a
 * post-pay session whose e-wallet charge failed (link ended, insufficient balance, …). The session is paid;
 * its hold_error starts "hold expired:" / "link ended:" / "charge failed:" and names the payment, so the receipt and the console still say
 * how it was paid; its alert is resolved and, for post-pay, the driver may use post-pay again.
 * Idempotent. A payment for a session already paid otherwise is refunded in full.
 */
export async function settlementPaid(settlementId: string): Promise<boolean> {
  const r = await one<{ id: string; org_id: string; mode: string; paid: number }>(
    `UPDATE payment_intent o
        SET state = 'captured', amount_captured_minor = s.amount_captured_minor, captured_at = now(), hold_state = 'captured',
            hold_error = CASE WHEN o.mode = 'preauth' THEN 'hold expired: ' WHEN o.hold_error LIKE 'link ended:%' THEN 'link ended: ' WHEN o.hold_error LIKE 'pin not confirmed:%' THEN 'pin not confirmed: ' WHEN o.hold_error LIKE 'pin expired:%' THEN 'pin expired: ' WHEN o.hold_error LIKE 'pin denied:%' THEN 'pin denied: ' WHEN o.hold_error LIKE 'pin cancelled:%' THEN 'pin cancelled: ' ELSE 'charge failed: ' END || '${PAID_IN_APP} ('
                         || COALESCE(s.channel, s.method) || ', ' || (SELECT cu.symbol || ' ' || ${MAJOR_AMOUNT_SQL('s.amount_captured_minor', 'cu.exponent')} FROM currency_unit cu WHERE cu.code = s.currency)
                         || '; payment ' || s.id || ')',
            checkout_url = NULL, hold_next_attempt_at = NULL, released_at = COALESCE(o.released_at, now()), updated_at = now()
       FROM payment_intent s
      WHERE s.id = $1 AND s.mode = 'settlement' AND s.state = 'captured' AND o.id = s.settles_intent_id AND o.hold_state = 'capture_failed'
        AND ((o.mode = 'preauth' AND o.hold_error LIKE 'hold expired:%') OR o.mode = 'postpay')
      RETURNING o.id, o.org_id, o.mode, s.amount_captured_minor AS paid`,
    [settlementId],
  );
  if (!r) {
    // A partner network charge's shortfall paid in the app (review fix 2): the roaming charge is paid.
    const rc = await one<{ id: string; org_id: string; payment_intent_id: string }>(
      `UPDATE driver_roaming_charge rc SET shortfall_paid_at = now(), shortfall_settlement_id = s.id
         FROM payment_intent s
        WHERE s.id = $1 AND s.mode = 'settlement' AND s.state = 'captured' AND rc.payment_intent_id = s.settles_intent_id
          AND rc.shortfall_minor > 0 AND rc.shortfall_paid_at IS NULL
        RETURNING rc.id, rc.org_id, rc.payment_intent_id`,
      [settlementId],
    );
    if (rc) {
      const { resolveAlertsFor } = await import('../alerts.js');
      await resolveAlertsFor(rc.org_id, 'roaming.hold_shortfall', 'payment_intent', rc.payment_intent_id);
      logger.info({ roamingCharge: rc.id, settlement: settlementId }, 'roaming shortfall paid in the app');
      return true;
    }
    // A second payment for a roaming shortfall already paid: refunded in full.
    const dupRoaming = await one<{ id: string; amount: number }>(
      `SELECT s.id, s.amount_captured_minor AS amount FROM payment_intent s JOIN driver_roaming_charge rc ON rc.payment_intent_id = s.settles_intent_id
        WHERE s.id = $1 AND s.mode = 'settlement' AND s.state = 'captured' AND rc.shortfall_paid_at IS NOT NULL AND rc.shortfall_settlement_id <> s.id`,
      [settlementId]);
    if (dupRoaming) {
      const { markRefundDue } = await import('../refunds.js');
      await markRefundDue(dupRoaming.id, Number(dupRoaming.amount), 'Paid twice for the same partner network charge; this second payment is refunded');
      return false;
    }
    // The same payment again (a replayed notification) for a roaming shortfall: nothing more to do.
    if (await one(`SELECT 1 FROM payment_intent s JOIN driver_roaming_charge rc ON rc.payment_intent_id = s.settles_intent_id WHERE s.id = $1`, [settlementId])) return false;
    // The session was already paid, by another of the driver's payments (e.g. a card page left open, then
    // QRIS) or by the e-wallet itself: this one is money taken twice for the same session, refunded in full.
    const dup = await one<{ id: string; amount: number }>(
      `SELECT s.id, s.amount_captured_minor AS amount FROM payment_intent s JOIN payment_intent o ON o.id = s.settles_intent_id
        WHERE s.id = $1 AND s.mode = 'settlement' AND s.state = 'captured' AND o.hold_state = 'captured'
          AND position(s.id::text in COALESCE(o.hold_error, '')) = 0`,
      [settlementId],
    );
    if (dup) {
      const { markRefundDue } = await import('../refunds.js');
      await markRefundDue(dup.id, Number(dup.amount), 'Paid twice for the same charging session; this second payment is refunded');
    }
    return false;
  }
  const { resolveAlertsFor } = await import('../alerts.js');
  await resolveAlertsFor(r.org_id, r.mode === 'postpay' ? 'payment.postpay_failed' : 'payment.hold_expired', 'payment_intent', r.id);
  logger.info({ intent: r.id, mode: r.mode, settlement: settlementId, paidMinor: r.paid }, 'unpaid session paid in the app');
  bus.emit('payment.unpaid_settled', { orgId: r.org_id, paymentIntentId: r.id });
  return true;
}
/**
 * The acquirer notified that the hold's authorisation expired. An unused or releasing hold is simply
 * released (nothing is held any more); one waiting to be captured has expired uncollected.
 */
export async function expireHold(intentId: string): Promise<'released' | 'expired' | null> {
  const h = await one<HoldRow>(
    `SELECT id, org_id, provider, provider_ref, provider_payment_id, integration_id, hold_state, hold_capture_minor, hold_attempts, amount_authorised_minor, session_id, mode, driver_card_id, channel, currency
       FROM payment_intent WHERE id = $1 AND mode = 'preauth'`, [intentId]);
  if (!h) return null;
  if (h.hold_state === 'capturing' || h.hold_state === 'capture_failed') { await holdExpired(h); return 'expired'; }
  if (h.hold_state === 'held' || h.hold_state === 'releasing' || h.hold_state === 'release_failed') {
    await query(
      `UPDATE payment_intent SET state = 'voided', hold_state = 'released', hold_error = NULL, hold_next_attempt_at = NULL, released_at = now(), updated_at = now()
        WHERE id = $1 AND hold_state IN ('held', 'releasing', 'release_failed')`, [h.id]);
    // A hold that never started a session: its claim token must not start one now.
    await query(
      `UPDATE token SET status = 'Expired' WHERE org_id = $1 AND kind = 'prepaid' AND uid = (SELECT claim_id_tag FROM payment_intent WHERE id = $2 AND session_id IS NULL)`,
      [h.org_id, h.id]);
    bus.emit('payment.hold_released', { orgId: h.org_id, paymentIntentId: h.id, releasedMinor: Number(h.amount_authorised_minor ?? 0), currency: h.currency });
    return 'released';
  }
  return null;
}

/** Post-pay: charge the linked e-wallet what the session cost. */
async function chargePostpay(h: HoldRow, provider: Awaited<ReturnType<typeof providerOfPayment>>): Promise<{ ok: boolean; error?: string; pending?: boolean }> {
  if (!provider?.chargeWallet) return { ok: false, error: `the ${h.provider} account that linked this e-wallet is no longer available` };
  const k = await one<{ app_driver_id: string; token_sealed: string; channel: string | null; status: string; removed_at: Date | null }>(
    `SELECT app_driver_id, token_sealed, channel, status, removed_at FROM driver_card WHERE id = $1 AND kind = 'ewallet'`, [h.driver_card_id]);
  if (!k?.token_sealed) return { ok: false, error: 'the linked e-wallet is gone' };
  const channel = (h.channel ?? k.channel ?? 'GOPAY') as Channel;
  let token: string | undefined;
  let cardId = h.driver_card_id!;
  if (k.status !== 'active' || k.removed_at) {
    // The link ended (or was replaced): once the driver links this e-wallet again, the new link pays.
    const cur = await currentLink(k.app_driver_id, channel, { provider: h.provider, integrationId: h.integration_id });
    if (cur) {
      token = cur.token; cardId = cur.id;
      await query(`UPDATE payment_intent SET driver_card_id = $2, updated_at = now() WHERE id = $1`, [h.id, cur.id]);
    } else if (k.status === 'failed') {
      return { ok: false, error: `${LINK_ENDED} the ${channel} link was unlinked in the e-wallet app or expired; the driver must link ${channel} again, then pay from the receipt` };
    }
  }
  if (token === undefined) {
    try { token = unseal(k.token_sealed); } catch { return { ok: false, error: 'the e-wallet token cannot be unsealed (SECRETS_KEY changed?)' }; }
  }
  const base = (process.env.DRIVER_PUBLIC_URL || process.env.CONSOLE_PUBLIC_URL || '').replace(/\/+$/, '');
  // A new charge while the previous one still waits for the driver's PIN (never confirmed, e.g. after an hour): cancel
  // that one first (best effort). Otherwise the driver could still confirm it, and its payment would no longer match
  // this session, which by then points at the new charge.
  const prev = await one<{ checkout_url: string | null; hold_error: string | null }>(`SELECT checkout_url, hold_error FROM payment_intent WHERE id = $1`, [h.id]);
  if (prev?.checkout_url && prev.hold_error?.startsWith('waiting for the driver') && h.provider_ref && provider.releaseHold) {
    await provider.releaseHold({ providerRef: h.provider_ref, providerPaymentId: h.provider_payment_id, idempotencyKey: `pin-cancel-${h.id}-${h.provider_ref}` })
      .catch((e) => logger.warn({ intent: h.id, err: (e as Error).message }, 'could not cancel the unconfirmed e-wallet charge'));
    await query(`UPDATE payment_intent SET checkout_url = NULL WHERE id = $1`, [h.id]);
  }
  // Each attempt is one charge with its own reference (postpay:<payment>:<attempt>); the acquirer's order id and
  // idempotency key are derived from it and recorded BEFORE the acquirer is asked, so the settlement notification of a
  // charge whose answer was lost (a timeout after GoPay settled) still finds this session, and is never 'unknown_payment'.
  // An attempt whose outcome is unknown is not followed by a blind new charge: the acquirer is asked where that charge
  // stands, where it can say (Midtrans); otherwise the same reference is sent again, which the acquirer's idempotency key
  // answers with the first charge instead of making a second (Xendit).
  const x = extras(provider);
  let referenceId = `postpay:${h.id}:${h.hold_attempts}`;
  const unknown = UNKNOWN_RE.exec(prev?.hold_error ?? '');
  if (unknown && h.provider_ref) {
    if (x.paymentStatus) {
      let st;
      try { st = await x.paymentStatus.call(provider, h.provider_ref); } catch (e) {
        return { ok: false, error: `${OUTCOME_UNKNOWN} the e-wallet charge ${unknown[1]} could not be looked up yet (${(e as Error).message}); it is looked up again before any new charge` };
      }
      if (st?.status === 'captured') {
        logger.warn({ intent: h.id, ref: h.provider_ref, amountMinor: st.amountMinor }, 'post-pay charge whose answer was lost had gone through; recorded, not charged again');
        await query(`UPDATE payment_intent SET provider_payment_id = COALESCE($2, provider_payment_id), updated_at = now() WHERE id = $1`, [h.id, st.providerPaymentId ?? null]);
        return { ok: true };
      }
      if (st?.status === 'pending') {
        // Waiting for the driver's PIN, without its link (the answer was lost): looked up again in an hour, by then
        // confirmed (its notification settles it) or lapsed (a new charge).
        await query(
          `UPDATE payment_intent SET hold_state = 'capturing', hold_error = $2, hold_next_attempt_at = now() + interval '60 minutes', updated_at = now() WHERE id = $1`,
          [h.id, `${OUTCOME_UNKNOWN} the e-wallet charge ${unknown[1]} is waiting for the driver to confirm in ${channel}`],
        );
        return { ok: false, pending: true, error: 'waiting for the driver to confirm' };
      }
      // Failed, or the acquirer never received it: a new charge below.
    } else {
      referenceId = unknown[1]!;
    }
  }
  const ref = x.orderRef?.call(provider, referenceId) ?? null;
  if (ref) await query(`UPDATE payment_intent SET provider_ref = $2, updated_at = now() WHERE id = $1`, [h.id, ref]);
  let c;
  try {
    c = await provider.chargeWallet({
      referenceId, amountMinor: Number(h.hold_capture_minor), channel, token,
      returnUrl: `${base}/app/paid.html?for=charge`, customerId: k.app_driver_id, description: 'PlugSure charging (post-pay)',
    });
  } catch (e) {
    // No answer: the e-wallet may have been charged. Named so the next attempt looks it up first.
    return { ok: false, error: `${OUTCOME_UNKNOWN} the e-wallet charge ${referenceId} got no answer (${(e as Error).message}); it is looked up before any new charge` };
  }
  await query(`UPDATE payment_intent SET provider_ref = $2, provider_payment_id = $3, checkout_url = $4, updated_at = now() WHERE id = $1`,
    [h.id, c.providerRef, c.providerPaymentId ?? null, c.checkoutUrl]);
  if (c.status === 'captured') return { ok: true };
  if (c.status === 'pending') {
    // The e-wallet wants the driver's PIN: the receipt offers the link; its notification settles it.
    // If they never confirm, the next attempt (a new charge) is in an hour.
    await query(
      `UPDATE payment_intent SET hold_state = 'capturing', hold_error = $2, hold_next_attempt_at = now() + interval '60 minutes', updated_at = now() WHERE id = $1`,
      [h.id, `waiting for the driver to confirm in ${channel}`],
    );
    return { ok: false, pending: true, error: 'waiting for the driver to confirm' };
  }
  if (c.linkEnded) {
    await endLink(cardId);
    return { ok: false, error: `${LINK_ENDED} the ${channel} link was unlinked in the e-wallet app or expired; the driver must link ${channel} again, then pay from the receipt` };
  }
  return { ok: false, error: c.message ?? 'declined' };
}

/** The driver's post-pay payments: through the session (driver_charge) or the linked e-wallet (recorded before the session's charge row). */
const DRIVER_POSTPAY = `pi.mode = 'postpay' AND (
         EXISTS (SELECT 1 FROM driver_charge dc WHERE dc.payment_intent_id = pi.id AND dc.app_driver_id = $1)
      OR EXISTS (SELECT 1 FROM driver_card k WHERE k.id = pi.driver_card_id AND k.app_driver_id = $1))`;

/** A driver with a post-pay session still unpaid (charge failed, or waiting for them) may not start another. */
export async function outstandingPostpay(appDriverId: string | null | undefined): Promise<boolean> {
  if (!appDriverId) return false;
  const r = await one<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM payment_intent pi WHERE ${DRIVER_POSTPAY} AND pi.hold_state IN ('capturing', 'capture_failed')) AS ok`,
    [appDriverId],
  );
  return r?.ok === true;
}

/**
 * What the driver's post-pay sessions could still charge: unpaid (a charge failed or waits for them), and the spending
 * limits of those not charged yet — held (claimable or running), or being decided right now (recorded, not yet held):
 * in all (the operator's limit is per driver) and on this e-wallet (its balance pays only its own sessions).
 * A new post-pay session must fit the limit and the e-wallet's balance together with these; the caller holds the
 * driver's advisory lock while it decides (registry.startPayment), and passes its transaction's client.
 */
export async function postpayExposure(appDriverId: string, channel: string, c?: pg.PoolClient): Promise<{ unpaid: boolean; heldMinor: number; heldOnWalletMinor: number }> {
  const sql = `SELECT COALESCE(bool_or(pi.hold_state IN ('capturing', 'capture_failed')), false) AS unpaid,
                      COALESCE(sum(pi.amount_authorised_minor) FILTER (WHERE pi.hold_state = 'held' OR pi.hold_state IS NULL), 0)::bigint AS held,
                      COALESCE(sum(pi.amount_authorised_minor) FILTER (WHERE (pi.hold_state = 'held' OR pi.hold_state IS NULL) AND pi.channel = $2), 0)::bigint AS held_here
                 FROM payment_intent pi
                WHERE ${DRIVER_POSTPAY}
                  AND (pi.hold_state IN ('held', 'capturing', 'capture_failed')
                       OR (pi.hold_state IS NULL AND pi.state = 'pending' AND pi.created_at > now() - interval '1 hour'))`;
  type Row = { unpaid: boolean; held: number; held_here: number };
  const r = c ? (await c.query<Row>(sql, [appDriverId, channel])).rows[0] : await one<Row>(sql, [appDriverId, channel]);
  return { unpaid: r?.unpaid === true, heldMinor: Number(r?.held ?? 0), heldOnWalletMinor: Number(r?.held_here ?? 0) };
}

/** The driver pays an unpaid post-pay session now: a new charge (or the e-wallet's confirmation link). */
export async function settlePostpayNow(intentId: string): Promise<{ ok: boolean; state: HoldState | null; checkoutUrl: string | null; error?: string }> {
  return outsideRequestScope(async () => {
    const pending = await one<{ checkout_url: string | null; hold_error: string | null }>(
      `SELECT checkout_url, hold_error FROM payment_intent WHERE id = $1 AND mode = 'postpay' AND hold_state = 'capturing' AND hold_error LIKE 'waiting for the driver%'`, [intentId]);
    if (pending?.checkout_url) return { ok: false, state: 'capturing' as HoldState, checkoutUrl: pending.checkout_url };
    await query(`UPDATE payment_intent SET hold_next_attempt_at = now() WHERE id = $1 AND mode = 'postpay' AND hold_state IN ('capturing', 'capture_failed')`, [intentId]);
    const r = await attemptHold(intentId);
    const cur = await one<{ checkout_url: string | null }>(`SELECT checkout_url FROM payment_intent WHERE id = $1`, [intentId]);
    return { ...r, checkoutUrl: r.state === 'capturing' ? cur?.checkout_url ?? null : null };
  });
}

/** Worker: release holds that never started a session, and retry captures / releases that are due. */
export async function sweepHolds(): Promise<number> {
  const unused = await many<{ id: string; org_id: string; claim_id_tag: string | null }>(
    `UPDATE payment_intent SET hold_state = 'releasing', hold_attempts = 0, hold_next_attempt_at = now(), updated_at = now()
      WHERE mode IN ('preauth', 'postpay') AND hold_state = 'held' AND session_id IS NULL
        -- A roaming hold has no session of ours: driver/roaming-pay.ts sweeps it (the 4-day rule).
        AND roaming_charge_id IS NULL
        AND created_at < now() - make_interval(mins => $1::int)
      RETURNING id, org_id, claim_id_tag`,
    [UNUSED_AFTER_MIN],
  );
  for (const u of unused) {
    // Its claim token must not start a session once the hold is gone.
    if (u.claim_id_tag) await query(`UPDATE token SET status = 'Expired' WHERE org_id = $1 AND kind = 'prepaid' AND uid = $2`, [u.org_id, u.claim_id_tag]);
  }
  // Pending holds that were never authorised simply lapse.
  await query(
    `UPDATE payment_intent SET state = 'expired', updated_at = now()
      WHERE mode = 'preauth' AND state = 'pending' AND created_at < now() - interval '2 hours'`,
  );
  const due = await many<{ id: string }>(
    `SELECT id FROM payment_intent
      WHERE hold_state IN ('capturing', 'capture_failed', 'releasing', 'release_failed')
        AND hold_next_attempt_at IS NOT NULL AND hold_next_attempt_at <= now()
      ORDER BY hold_next_attempt_at LIMIT 50`,
  );
  let n = 0;
  for (const d of due) if ((await attemptHold(d.id, { worker: true })).ok) n++;
  if (unused.length || n) logger.info({ released: unused.length, settled: n }, 'card holds swept');
  return unused.length + n;
}

/** Console: holds that need attention or are in progress, and recent ones. */
export async function holdsOverview(orgId: string) {
  const rows = await many<any>(
    `SELECT pi.id, pi.hold_state, pi.amount_authorised_minor, pi.hold_capture_minor, pi.amount_captured_minor, pi.hold_attempts, pi.hold_error,
            pi.hold_next_attempt_at, pi.authorised_at, pi.released_at, pi.provider, pi.provider_ref, pi.created_at, pi.session_id,
            pi.mode, pi.channel, pi.currency, s.name AS site_name, cp.ocpp_identity
       FROM payment_intent pi
       LEFT JOIN connector c ON c.id = pi.connector_uuid
       LEFT JOIN evse e ON e.id = c.evse_uuid
       LEFT JOIN charge_point cp ON cp.id = e.charge_point_id
       LEFT JOIN site s ON s.id = cp.site_id
      WHERE pi.org_id = $1 AND pi.mode IN ('preauth', 'postpay') AND pi.hold_state IS NOT NULL
        AND (pi.hold_state NOT IN ('captured', 'released') OR pi.updated_at > now() - interval '14 days')
      ORDER BY (pi.hold_state IN ('capture_failed', 'release_failed')) DESC, pi.created_at DESC
      LIMIT 200`,
    [orgId],
  );
  const holds = rows.map((r) => ({
    id: r.id, kind: r.mode === 'postpay' ? 'postpay' : 'card_hold', channel: r.channel ?? null, state: r.hold_state, heldMinor: r.amount_authorised_minor, captureMinor: r.hold_capture_minor, capturedMinor: r.amount_captured_minor,
    attempts: r.hold_attempts, error: r.hold_error, nextAttemptAt: r.hold_next_attempt_at, authorisedAt: r.authorised_at, settledAt: r.released_at,
    /** The authorisation expired at the acquirer before it was captured: it cannot be retried. */
    expired: String(r.hold_error ?? '').startsWith(HOLD_EXPIRED),
    /** An expired hold, or a post-pay session whose link ended, the driver has since paid in the app. */
    paidInApp: String(r.hold_error ?? '').includes(PAID_IN_APP) && r.hold_state === 'captured',
    provider: r.provider, providerRef: r.provider_ref, createdAt: r.created_at, sessionId: r.session_id, site: r.site_name, charger: r.ocpp_identity,
    currency: r.currency,
  }));
  return {
    holds,
    summary: {
      held: holds.filter((h) => h.state === 'held').length,
      inProgress: holds.filter((h) => h.state === 'capturing' || h.state === 'releasing').length,
      failed: holds.filter((h) => h.state === 'capture_failed' || h.state === 'release_failed').length,
      /** Of the failed: card holds that expired before capture and are still unpaid (cannot be retried), and what they left uncollected. */
      expired: holds.filter((h) => h.expired && !h.paidInApp).length,
      // Rupiah (v1.6); the other currencies separately (never added up).
      expiredMinor: holds.filter((h) => h.expired && !h.paidInApp && h.currency === LEGACY_CURRENCY).reduce((s, h) => s + Number(h.captureMinor ?? 0), 0),
      expiredByCurrency: holds.filter((h) => h.expired && !h.paidInApp).reduce((o, h) => ({ ...o, [h.currency]: (o[h.currency] ?? 0) + Number(h.captureMinor ?? 0) }), {} as Record<string, number>),
      heldMinor: holds.filter((h) => h.state === 'held' && h.currency === LEGACY_CURRENCY).reduce((s, h) => s + Number(h.heldMinor ?? 0), 0),
    },
  };
}

/** Console: retry a failed capture or release now. */
export async function retryHold(orgId: string, intentId: string) {
  // Both steps outside the request's transaction: the attempt must see "due now", and its
  // result must stand even if the request fails afterwards (the acquirer has already acted).
  return outsideRequestScope(async () => {
    // An expired authorisation cannot be captured: say so instead of asking the acquirer again.
    const exp = await one<{ id: string }>(`SELECT id FROM payment_intent WHERE id = $1 AND org_id = $2 AND hold_state = 'capture_failed' AND hold_error LIKE 'hold expired:%'`, [intentId, orgId]);
    if (exp) return { ok: false, state: 'capture_failed' as HoldState, error: EXPIRED_EXPLAINED };
    const r = await one<{ id: string }>(
      `UPDATE payment_intent SET hold_next_attempt_at = now() WHERE id = $1 AND org_id = $2 AND hold_state IN ('capture_failed', 'release_failed', 'capturing', 'releasing') RETURNING id`,
      [intentId, orgId],
    );
    return r ? attemptHold(intentId) : null;
  });
}
