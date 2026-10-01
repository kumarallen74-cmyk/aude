import { one, many, query, outsideRequestScope } from '../db/pool.js';
import { logger } from '../logger.js';
import { bus } from './events.js';
import { extras, providerOfPayment } from './payments/registry.js';
import { PREPAID_CLAIM_WINDOW_MIN } from './sessions.js';

/**
 * Refunds — money PlugSure owes back to a driver.
 *
 * Two ways a prepaid (QRIS) driver ends up owed money:
 *   1. They used less than they paid (the session settled below the payment).
 *   2. They paid and the charge never started (charger busy or faulted, driver
 *      left). The payment sat in 'captured' forever, flagged by nothing.
 *
 * Both used to end at an alert (or nothing) while the app told the driver
 * "sisa saldo dikembalikan". A refund is now a tracked state on the payment:
 *   due → processing → refunded        (provider refund API)
 *   due → refunded                     (bank transfer, recorded with its reference)
 *   processing → failed → due/refunded (provider refused; retry or pay manually)
 * Every transition is audited by the caller; the driver sees the state in-app.
 *
 * A refund is paid once. Each transition is a conditional UPDATE from the state it
 * leaves (two clicks, or a click and the worker, cannot both complete it). While a
 * provider refund is in flight or pending at the acquirer ('processing'), it cannot
 * be recorded as paid by bank transfer: only once the acquirer has refused it
 * ('failed'). A provider call with no answer stays 'processing' (it may have been
 * made). The refunds worker settles 'processing' refunds: it asks the acquirer where
 * the refund stands, where it can say (Xendit's pending refunds; Midtrans lists the
 * refunds on the order), sends one that never got an answer again with the same
 * idempotency key, and the acquirer's refund callback settles it too (refundSettled).
 * The database refuses a refund larger than what was captured (migration 044).
 */

/** A 'processing' refund untouched this long is looked at by the worker. */
const PROCESSING_STALE_MIN = 10;


/** Grace after the claim window before an unused payment is declared refundable. */
const UNUSED_GRACE_MIN = 5;

/** Record that money is owed. Idempotent: a payment already in the refund flow is left alone. */
export async function markRefundDue(intentId: string, amountIdr: number, reason: string): Promise<boolean> {
  if (!(amountIdr > 0)) return false;
  const r = await one<{ org_id: string }>(
    `UPDATE payment_intent
        SET refund_state = 'due', refund_due_idr = $2, refund_reason = $3,
            refund_requested_at = now(), updated_at = now()
      WHERE id = $1 AND refund_state IS NULL
      RETURNING org_id`,
    [intentId, Math.round(amountIdr), reason],
  );
  if (!r) return false;
  bus.emit('refund.due', { orgId: r.org_id, paymentIntentId: intentId, amountIdr: Math.round(amountIdr), reason });
  // Paid with a linked e-wallet: the driver never approved this payment by hand, so what is owed goes back at once.
  const linked = await one<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM payment_intent pi JOIN driver_card k ON k.id = pi.driver_card_id WHERE pi.id = $1 AND k.kind = 'ewallet') AS ok`, [intentId]);
  if (linked?.ok) {
    setImmediate(() => {
      outsideRequestScope(() => processRefund(intentId, null))
        .then((o) => logger.info({ intentId, state: o.state }, 'linked e-wallet refund processed automatically'))
        .catch((e) => logger.warn({ intentId, err: (e as Error).message }, 'automatic e-wallet refund failed; it stays in the refund queue'));
    });
  }
  return true;
}

/**
 * Find paid prepurchases whose claim window has passed without a session, mark
 * them refundable in full, and retire their claim tokens. Runs in the worker.
 */
export async function sweepUnusedPayments(): Promise<number> {
  const rows = await many<{ id: string; org_id: string; amount: number; claim_id_tag: string | null }>(
    `SELECT id, org_id, COALESCE(amount_captured_idr, amount_authorised_idr, 0) AS amount, claim_id_tag
       FROM payment_intent
      WHERE mode = 'prepurchase' AND state = 'captured' AND session_id IS NULL
        AND refund_state IS NULL
        AND created_at < now() - make_interval(mins => $1::int)
      ORDER BY created_at
      LIMIT 200`,
    [PREPAID_CLAIM_WINDOW_MIN + UNUSED_GRACE_MIN],
  );
  let n = 0;
  for (const r of rows) {
    const marked = await markRefundDue(r.id, Number(r.amount), 'Paid but charging never started (claim window expired)');
    if (!marked) continue;
    n++;
    // The token must never be able to start a session after its money is refunded.
    if (r.claim_id_tag) {
      await query(`UPDATE token SET status = 'Expired' WHERE org_id = $1 AND kind = 'prepaid' AND uid = $2`, [r.org_id, r.claim_id_tag]);
    }
    bus.emit('alert.raised', {
      orgId: r.org_id,
      kind: 'payment.refund_due',
      severity: 'warning',
      message: `A driver paid Rp ${Number(r.amount).toLocaleString('id-ID')} and charging never started. A full refund is due — see Refunds.`,
      targetType: 'payment_intent',
      targetId: r.id,
    });
  }
  if (n) logger.info({ n }, 'unused prepaid payments marked for refund');
  return n + (await sweepProcessingRefunds());
}

/**
 * Worker: refunds left 'processing' — pending at the acquirer, or sent without an answer. The acquirer is asked where
 * each stands (refunded → completed; refused → failed, so it can be retried or paid by bank transfer); one the acquirer
 * has no record of and that never got an answer is sent again, with the same idempotency key.
 */
export async function sweepProcessingRefunds(): Promise<number> {
  const rows = await many<{ id: string; org_id: string; provider: string; provider_ref: string | null; integration_id: string | null; channel: string | null;
    provider_payment_id: string | null; refund_ref: string | null; due: number }>(
    `SELECT id, org_id, provider, provider_ref, integration_id, channel, provider_payment_id, refund_ref, refund_due_idr AS due
       FROM payment_intent
      WHERE refund_state = 'processing' AND updated_at < now() - make_interval(mins => $1::int)
      ORDER BY updated_at LIMIT 50`,
    [PROCESSING_STALE_MIN],
  );
  let n = 0;
  for (const r of rows) {
    const provider = await providerOfPayment(r).catch(() => null);
    const ask = extras(provider).refundStatus;
    let st: 'refunded' | 'pending' | 'failed' | null | undefined;
    if (ask && r.provider_ref) {
      try {
        st = await ask.call(provider, { providerRef: r.provider_ref, providerPaymentId: r.provider_payment_id, channel: r.channel, refundRef: r.refund_ref, idempotencyKey: `refund-${r.id}` });
      } catch (e) {
        logger.warn({ intentId: r.id, err: (e as Error).message }, 'refund status lookup failed; asked again later');
        st = 'pending';
      }
    }
    if (st === 'refunded') {
      if (await complete(r.id, r.org_id, Number(r.due), 'provider', r.refund_ref ?? `refund-${r.id}`, null, ['processing'])) n++;
    } else if (st === 'failed') {
      await query(`UPDATE payment_intent SET refund_state = 'failed', refund_error = $2, updated_at = now() WHERE id = $1 AND refund_state = 'processing'`,
        [r.id, 'The payment provider reports the refund failed. Retry, or refund by bank transfer and record the reference.']);
    } else if (st == null && !r.refund_ref) {
      // Never answered, and (where the acquirer can be asked) not made: sent again, under the same idempotency key.
      if ((await processRefund(r.id, null, { resume: true })).state === 'refunded') n++;
    } else {
      // Still pending at the acquirer (or it cannot be asked): looked at again later.
      await query(`UPDATE payment_intent SET updated_at = now() WHERE id = $1 AND refund_state = 'processing'`, [r.id]);
    }
  }
  return n;
}

/**
 * The acquirer's refund callback (e.g. Xendit refund.succeeded / refund.failed) for a refund that came back pending:
 * completes or fails it, once. Matched by the refund's reference at the account that sent it.
 */
export async function refundSettled(acquirer: { provider: string; integrationId: string | null }, refundRef: string, status: 'refunded' | 'pending' | 'failed'): Promise<string> {
  const r = await one<{ id: string; org_id: string; due: number }>(
    `SELECT id, org_id, refund_due_idr AS due FROM payment_intent
      WHERE provider = $1 AND refund_ref = $2 AND refund_method = 'provider'
        AND ($3::uuid IS NULL OR integration_id IS NULL OR integration_id = $3::uuid)
      ORDER BY refund_requested_at DESC LIMIT 1`,
    [acquirer.provider, refundRef, acquirer.integrationId],
  );
  if (!r) return 'refund_unknown';
  if (status === 'refunded') return (await complete(r.id, r.org_id, Number(r.due), 'provider', refundRef, null, ['processing'])) ? 'refund_completed' : 'duplicate';
  if (status === 'failed') {
    const f = await one(`UPDATE payment_intent SET refund_state = 'failed', refund_error = $2, updated_at = now() WHERE id = $1 AND refund_state = 'processing' RETURNING id`,
      [r.id, 'The payment provider reports the refund failed. Retry, or refund by bank transfer and record the reference.']);
    return f ? 'refund_failed' : 'duplicate';
  }
  return 'refund_pending';
}

export interface RefundOutcome {
  ok: boolean;
  state: string;
  refundRef?: string;
  error?: string;
}

/**
 * Pay the refund through the payment provider. `resume` (the worker): also a refund left 'processing' without an answer
 * (no refund reference) for a while — sent again with the same idempotency key, so the acquirer cannot pay it twice.
 */
export async function processRefund(intentId: string, actorUserId: string | null, opts: { resume?: boolean } = {}): Promise<RefundOutcome> {
  const row = await one<{ org_id: string; provider: string; provider_ref: string | null; integration_id: string | null; channel: string | null; provider_payment_id: string | null; due: number }>(
    `UPDATE payment_intent SET refund_state = 'processing', refund_error = NULL, updated_at = now()
      WHERE id = $1 AND (refund_state IN ('due', 'failed')
                         OR ($2::boolean AND refund_state = 'processing' AND refund_ref IS NULL AND updated_at < now() - make_interval(mins => $3::int)))
      RETURNING org_id, provider, provider_ref, integration_id, channel, provider_payment_id, refund_due_idr AS due`,
    [intentId, opts.resume === true, PROCESSING_STALE_MIN],
  );
  if (!row) {
    const cur = await one<{ refund_state: string | null }>(`SELECT refund_state FROM payment_intent WHERE id = $1`, [intentId]);
    return { ok: false, state: cur?.refund_state ?? 'none', error: cur ? `refund is ${cur.refund_state ?? 'not due'}` : 'payment not found' };
  }

  // The account that took the payment, even if the operator has since changed acquirer.
  const provider = await providerOfPayment(row);
  const fail = async (error: string): Promise<RefundOutcome> => {
    await query(`UPDATE payment_intent SET refund_state = 'failed', refund_error = $2, updated_at = now() WHERE id = $1 AND refund_state = 'processing'`, [intentId, error]);
    return { ok: false, state: 'failed', error };
  };
  if (!provider?.refund) {
    return fail(`The ${row.provider} payment provider has no refund API. Refund by bank transfer and record the transfer reference.`);
  }
  if (provider.canRefund && !provider.canRefund(row.channel ?? 'QRIS')) {
    return fail(`${row.provider} cannot refund ${row.channel ?? 'QRIS'} payments by API. Refund by bank transfer and record the transfer reference.`);
  }
  if (!row.provider_ref) return fail('The payment has no provider reference to refund against.');

  try {
    const res = await provider.refund({
      providerRef: row.provider_ref,
      providerPaymentId: row.provider_payment_id,
      channel: row.channel ?? 'QRIS',
      amountIdr: Number(row.due),
      reason: 'PlugSure prepaid refund',
      idempotencyKey: `refund-${intentId}`,
    });
    if (res.status === 'failed') return fail(`Provider refused the refund${res.refundRef ? ` (${res.refundRef})` : ''}.`);
    if (res.status === 'pending') {
      // Accepted by the provider, settles asynchronously; keep 'processing' with its reference (the worker and the
      // acquirer's refund callback complete it).
      await query(`UPDATE payment_intent SET refund_ref = $2, refund_method = 'provider', updated_at = now() WHERE id = $1 AND refund_state = 'processing'`, [intentId, res.refundRef]);
      return { ok: true, state: 'processing', refundRef: res.refundRef };
    }
    if (!(await complete(intentId, row.org_id, Number(row.due), 'provider', res.refundRef, actorUserId, ['processing']))) {
      const cur = await one<{ refund_state: string | null }>(`SELECT refund_state FROM payment_intent WHERE id = $1`, [intentId]);
      return { ok: false, state: cur?.refund_state ?? 'none', error: 'The refund was completed meanwhile.' };
    }
    return { ok: true, state: 'refunded', refundRef: res.refundRef };
  } catch (e) {
    // No answer: the provider may have made the refund. It stays 'processing' (not 'failed', which would allow a bank
    // transfer on top); the worker asks the provider, or sends it again with the same idempotency key.
    logger.warn({ intentId, err: (e as Error).message }, 'provider refund got no answer; outcome unknown');
    const error = `No answer from the payment provider (${(e as Error).message}). The refund may have been made; it is checked again automatically.`;
    await query(`UPDATE payment_intent SET refund_error = $2, refund_method = 'provider', updated_at = now() WHERE id = $1 AND refund_state = 'processing'`, [intentId, error]);
    return { ok: false, state: 'processing', error };
  }
}

/** Record a refund paid outside the provider (bank transfer), with its reference. */
export async function markRefundedManually(intentId: string, reference: string, actorUserId: string | null): Promise<RefundOutcome> {
  const ref = String(reference ?? '').trim();
  if (ref.length < 3) return { ok: false, state: 'due', error: 'Enter the bank transfer reference.' };
  const row = await one<{ org_id: string; due: number; refund_state: string; refund_ref: string | null }>(
    `SELECT org_id, refund_due_idr AS due, refund_state, refund_ref FROM payment_intent WHERE id = $1 AND refund_state IN ('due', 'failed', 'processing')`,
    [intentId],
  );
  if (!row) return { ok: false, state: 'none', error: 'No refund is outstanding for this payment.' };
  // A provider refund in flight or pending at the acquirer may still pay the driver: a bank transfer on top would pay
  // twice. Only once the acquirer has refused it ('failed') can it be paid another way.
  if (row.refund_state === 'processing') {
    return {
      ok: false, state: 'processing',
      error: row.refund_ref
        ? `A refund through the payment provider is in progress (${row.refund_ref}). It is checked automatically; record a bank transfer only if it fails.`
        : 'A refund through the payment provider is being made. Wait until it completes or fails.',
    };
  }
  if (!(await complete(intentId, row.org_id, Number(row.due), 'manual', ref.slice(0, 120), actorUserId, ['due', 'failed']))) {
    const cur = await one<{ refund_state: string | null }>(`SELECT refund_state FROM payment_intent WHERE id = $1`, [intentId]);
    return { ok: false, state: cur?.refund_state ?? 'none', error: 'The refund changed meanwhile (completed or being paid by the provider). Reload.' };
  }
  return { ok: true, state: 'refunded', refundRef: ref };
}

/** Mark the refund paid, once: only from the states given (a conditional UPDATE). False when it was not in one of them. */
async function complete(intentId: string, orgId: string, amount: number, method: 'provider' | 'manual', reference: string, actor: string | null, from: Array<'due' | 'failed' | 'processing'>): Promise<boolean> {
  const done = await one<{ id: string }>(
    `UPDATE payment_intent
        SET refund_state = 'refunded', refunded_idr = $2, refund_method = $3, refund_ref = $4,
            refunded_at = now(), refunded_by = $5, refund_error = NULL, updated_at = now()
      WHERE id = $1 AND refund_state = ANY($6::text[])
      RETURNING id`,
    [intentId, amount, method, reference, actor, from],
  );
  if (!done) return false;
  // Close the "refund due" alert this payment raised, if any.
  await query(
    `UPDATE alert SET resolved_at = now() WHERE target_type = 'payment_intent' AND target_id = $1 AND resolved_at IS NULL`,
    [intentId],
  );
  bus.emit('refund.completed', { orgId, paymentIntentId: intentId, amountIdr: amount, method, reference });
  return true;
}

export async function listRefunds(orgId: string, state?: string) {
  const states = state && ['due', 'processing', 'refunded', 'failed'].includes(state) ? [state] : ['due', 'processing', 'refunded', 'failed'];
  return many(
    `SELECT pi.id, pi.refund_state, pi.refund_due_idr, pi.refunded_idr, pi.refund_reason, pi.refund_method,
            pi.refund_ref, pi.refund_error, pi.refund_requested_at, pi.refunded_at,
            pi.provider, pi.provider_ref, pi.method, pi.channel, pi.amount_captured_idr, pi.created_at AS paid_at,
            pi.session_id, s.name AS site_name, cp.ocpp_identity, e.evse_id AS connector_no,
            ad.phone AS driver_phone, u.name AS refunded_by_name
       FROM payment_intent pi
       LEFT JOIN connector c ON c.id = pi.connector_uuid
       LEFT JOIN evse e ON e.id = c.evse_uuid
       LEFT JOIN charge_point cp ON cp.id = e.charge_point_id
       LEFT JOIN site s ON s.id = cp.site_id
       LEFT JOIN driver_charge dc ON dc.payment_intent_id = pi.id
       LEFT JOIN app_driver ad ON ad.id = dc.app_driver_id
       LEFT JOIN app_user u ON u.id = pi.refunded_by
      WHERE pi.org_id = $1 AND pi.refund_state = ANY($2::text[])
      ORDER BY (pi.refund_state = 'refunded'), pi.refund_requested_at DESC
      LIMIT 500`,
    [orgId, states],
  );
}

export async function refundSummary(orgId: string) {
  return one<{ due_count: number; due_idr: number; failed_count: number; refunded_30d_idr: number }>(
    `SELECT count(*) FILTER (WHERE refund_state IN ('due', 'processing'))::int AS due_count,
            COALESCE(sum(refund_due_idr) FILTER (WHERE refund_state IN ('due', 'processing', 'failed')), 0)::bigint AS due_idr,
            count(*) FILTER (WHERE refund_state = 'failed')::int AS failed_count,
            COALESCE(sum(refunded_idr) FILTER (WHERE refund_state = 'refunded' AND refunded_at > now() - interval '30 days'), 0)::bigint AS refunded_30d_idr
       FROM payment_intent WHERE org_id = $1 AND refund_state IS NOT NULL`,
    [orgId],
  );
}
