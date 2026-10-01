import { appNameFor } from '../services/brand.js';
import { randomBytes, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config, isRelaxedEnv } from '../config.js';
import * as registry from '../ocpp/registry.js';
import { remoteStartTransaction, remoteStopTransaction } from '../ocpp/commands.js';
import { loadTariffForConnector } from '../services/tariff-store.js';
import { v2xView, setDriverConsent, V2xError } from '../services/v2x.js';
import { signedDataFor } from '../services/signed-metering.js';
import { driverAllowanceWh, type PriceAdjustment } from '../services/tariff.js';
import { benefitsFor } from '../services/benefits.js';
import { connectorMaySellEnergy } from '../services/compliance.js';
import { effectivePpnRateBps } from '../services/tax.js';
import { PREPAID_CLAIM_WINDOW_MIN, runningCost } from '../services/sessions.js';
import { receiptHtml } from '../services/session-query.js';
import { paymentsFor, PaymentsUnavailable, logPaymentCreated, availableMethods, methodChoices, startPayment, MethodUnavailable, cardOptions, walletOptions, postpayOptions, type PreparedPayment } from '../services/payments/registry.js';
import { outstandingPostpay, settlePostpayNow, LINK_ENDED, HOLD_EXPIRED, PAID_IN_APP } from '../services/payments/holds.js';
import { endLink, listCards, walletToken } from '../services/payments/cards.js';
import { WalletLinkEnded, methodOf, type Channel } from '../services/payments/provider.js';
import { QRIS_MAX_TRANSACTION_IDR, estimateQrisMdrIdr, CHANNEL_LABEL } from '../services/payments/provider.js';
import { cardUsage } from '../ocpi/emsp.js';
import { reservationOn } from './reservations.js';
import { queueBlocks } from './queue.js';
import type { DriverPrincipal } from './identity.js';

/**
 * The charge flow — the whole reason the app exists.
 *
 * Two payment models sit behind one flow:
 *   PREPAID  — a guest (or account holder) pays a fixed rupiah amount by QRIS.
 *              QRIS has no pre-authorisation, so the charger delivers exactly that
 *              much energy and stops. Enforced by the platform's prepaid module.
 *   FLEET    — a corporate RFID token. No payment; the session is billed postpaid
 *              to the organisation. The driver pays nothing.
 *
 * This module never touches the OCPP hot path. It records the driver's intent in
 * driver_charge, mints or reuses the token the charger will present, and asks the
 * charger to start. The session is created by StartTransaction exactly as before,
 * and reconciled back to the driver_charge when it appears.
 */


interface ConnFull {
  connector_uuid: string;
  connector_no: number;
  charge_point_id: string;
  ocpp_identity: string;
  org_id: string;
  site_name: string;
  max_power_w: number;
  pbjt_rate_bps: number;
  timezone: string;
  tera_status: string;
  current_type: string;
  site_id: string;
  in_maintenance: boolean;
  listed: boolean;
  /** Suspended by the operator (v1.4.1): stays on the map, but sells nothing. */
  suspended: boolean;
}

async function connFull(connectorUuid: string): Promise<ConnFull | null> {
  if (!UUID_RE.test(String(connectorUuid))) return null;
  return one<ConnFull>(
    `SELECT c.id AS connector_uuid, e.evse_id AS connector_no, cp.id AS charge_point_id,
            cp.ocpp_identity, s.org_id, s.name AS site_name, c.max_power_w, s.pbjt_rate_bps,
            s.timezone, c.tera_status, c.current_type, s.id AS site_id,
            (c.maintenance_reason IS NOT NULL) AS in_maintenance,
            (cp.status NOT IN ('pending_adoption', 'decommissioned') AND s.archived_at IS NULL) AS listed,
            (cp.status = 'suspended') AS suspended
       FROM connector c
       JOIN evse e ON e.id = c.evse_uuid
       JOIN charge_point cp ON cp.id = e.charge_point_id
       JOIN site s ON s.id = cp.site_id
      WHERE c.id = $1`,
    [connectorUuid],
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why this connector may not take a new charge, or null. The same gates the
 * station view shows (v1.3): the Tera meter gate, an operator maintenance hold,
 * and a charger or site that has been withdrawn from the network. Checked
 * BEFORE the driver pays, so nobody is charged for a connector they cannot use.
 */
function sellProblem(c: ConnFull): string | null {
  if (!c.listed) return 'Charger ini tidak lagi beroperasi.';
  if (c.suspended) return 'Charger ini sementara tidak beroperasi.';
  if (!connectorMaySellEnergy(c.tera_status as any).allowed) return 'Konektor ini sedang tidak dapat menjual energi.';
  if (c.in_maintenance) return 'Konektor ini sedang dalam perawatan.';
  return null;
}

/**
 * Whether a fleet card may still charge: blocked, expired, or over the
 * cumulative energy/spend limit set in the RFID centre (v1.3). The charger's
 * Authorize would refuse it anyway — this gives the driver the reason up front
 * instead of a charger that silently will not start.
 */
export async function fleetTokenProblem(tokenId: string): Promise<string | null> {
  const t = await one<{ status: string; valid_to: Date | null; energy_limit_wh: number | null; spend_limit_idr: number | null }>(
    `SELECT status, valid_to, energy_limit_wh, spend_limit_idr FROM token WHERE id = $1`,
    [tokenId],
  );
  if (!t || t.status !== 'Accepted') return 'Kartu armada Anda diblokir. Hubungi admin armada Anda.';
  if (t.valid_to && new Date(t.valid_to) < new Date()) return 'Kartu armada Anda sudah kedaluwarsa. Hubungi admin armada Anda.';
  if (t.energy_limit_wh != null || t.spend_limit_idr != null) {
    // Includes charging on other networks with this card (roaming CDRs).
    const used = await cardUsage(tokenId);
    if (t.energy_limit_wh != null && Number(used?.wh ?? 0) >= Number(t.energy_limit_wh)) {
      return 'Batas energi kartu armada Anda sudah tercapai.';
    }
    if (t.spend_limit_idr != null && Number(used?.idr ?? 0) >= Number(t.spend_limit_idr)) {
      return 'Batas biaya kartu armada Anda sudah tercapai.';
    }
  }
  return null;
}

export interface QuoteResult {
  ok: boolean;
  error?: string;
  minimumViableIdr?: number;
  allowanceWh?: number;
  allowanceKwh?: number;
  amountIdr?: number;
  mdrIdr?: number;
  /** The membership / promotion this price includes, and why an entered code does not apply. */
  membership?: string | null;
  promotion?: string | null;
  codeProblem?: string | null;
  /** How the driver can pay at this charger (QRIS, e-wallets, card). */
  paymentMethods?: Array<{ channel: string; method: string; label: string }>;
  /** Card payments are holds: only what is used is charged. */
  cardHolds?: boolean;
  /** The driver (signed in) may save the card they pay with. */
  canSaveCard?: boolean;
  /** The driver's saved cards this operator's acquirer can charge. */
  savedCards?: Array<{ id: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null }>;
  /** E-wallets the driver may link here (one-tap payments), and those already linked. */
  linkableWallets?: string[];
  /** postpay: this wallet is charged after the session (false: up front, e.g. its balance cannot be checked). */
  linkedWallets?: Array<{ id: string; channel: string | null; accountLabel: string | null; postpay: boolean }>;
  /** Linked e-wallets are charged after the session (post-pay), up to postpayLimitIdr. */
  walletPostpay?: boolean;
  postpayLimitIdr?: number | null;
  /** 'unpaid': an earlier post-pay session is still unpaid, so post-pay is refused until it is. */
  postpayBlocked?: string | null;
}

/** How much energy a given rupiah amount buys on this connector, worst-case reserved. */
export async function quotePrepaid(
  connectorUuid: string,
  amountIdr: number,
  opts: { principal?: DriverPrincipal | null; promoCode?: string | null } = {},
): Promise<QuoteResult> {
  // Whole rupiah only: a fraction (or a number past 2^53) is not an amount any acquirer charges as asked.
  if (!Number.isSafeInteger(amountIdr) || amountIdr <= 0) return { ok: false, error: 'Jumlah tidak valid.' };
  if (amountIdr > QRIS_MAX_TRANSACTION_IDR) {
    return { ok: false, error: `Batas QRIS per transaksi Rp ${QRIS_MAX_TRANSACTION_IDR.toLocaleString('id-ID')}.` };
  }
  const c = await connFull(connectorUuid);
  if (!c) return { ok: false, error: 'Konektor tidak ditemukan.' };

  const problem = sellProblem(c);
  if (problem) return { ok: false, error: problem };

  const now = new Date();
  const { tariff } = await loadTariffForConnector(c.connector_uuid, c.org_id, now);
  const baseCtx = {
    startedAt: now,
    endedAt: new Date(now.getTime() + 45 * 60_000),
    connectorMaxPowerW: c.max_power_w,
    pbjtRateBps: c.pbjt_rate_bps,
    timezone: c.timezone,
  };
  // The driver's membership and a promo code make the same rupiah buy more
  // energy — exactly as the session will later be rated. A promotion with a
  // minimum kWh only counts if the allowance reaches it.
  const p = opts.principal ?? null;
  const b = await benefitsFor(
    c.org_id,
    { appDriverId: p?.appDriverId ?? null, deviceId: p?.deviceId ?? null, promoCode: opts.promoCode ?? null },
    { siteId: c.site_id, currentType: c.current_type },
    now,
    c.timezone,
  ).catch(() => null);
  const m = b?.membership ? [b.membership.adjustment] : [];
  const choices: Array<{ adjustments: PriceAdjustment[]; minKwh: number; promotion: string | null }> = [{ adjustments: m, minKwh: 0, promotion: null }];
  for (const x of b?.promotions ?? []) {
    const adj = { ...x.adjustment } as PriceAdjustment & { minKwh?: number };
    const minKwh = adj.minKwh ?? 0;
    delete adj.minKwh;
    choices.push({ adjustments: x.stacks ? [...m, adj] : [adj], minKwh, promotion: x.name });
  }
  let best = { allowanceWh: -1, choice: choices[0]! };
  for (const ch of choices) {
    const wh = driverAllowanceWh(tariff, amountIdr, { ...baseCtx, adjustments: ch.adjustments });
    if (wh < ch.minKwh * 1000) continue;
    if (wh > best.allowanceWh) best = { allowanceWh: wh, choice: ch };
  }
  const ctx = { ...baseCtx, adjustments: best.choice.adjustments };
  const allowanceWh = Math.max(0, best.allowanceWh);
  if (allowanceWh <= 0) {
    // Find the smallest amount that buys any energy, so the app can nudge upward.
    let lo = 0;
    let hi = 1_000_000;
    for (let i = 0; i < 32; i++) {
      const mid = Math.floor((lo + hi) / 2);
      if (mid === lo) break;
      if (driverAllowanceWh(tariff, mid, ctx) > 0) hi = mid;
      else lo = mid;
    }
    return {
      ok: false,
      error: 'Jumlah ini belum menutup biaya tetap, jadi belum ada energi yang bisa dibeli.',
      minimumViableIdr: hi,
    };
  }

  return {
    ok: true,
    allowanceWh,
    allowanceKwh: Math.round(allowanceWh / 10) / 100,
    amountIdr,
    mdrIdr: estimateQrisMdrIdr(amountIdr),
    membership: best.choice.adjustments.some((a) => a.source === 'subscription') ? b!.membership!.planName : null,
    promotion: best.choice.promotion,
    codeProblem: b?.codeProblem ?? null,
    ...(await paymentSetupFor(c.org_id, p)),
  };
}

/** The payment methods an operator offers drivers (empty: payments not set up). */
export async function paymentMethodsFor(orgId: string) {
  try { const acq = await paymentsFor(orgId); return methodChoices(availableMethods(acq.resolved, acq.provider)); } catch { return []; }
}

/**
 * Everything the app needs to offer payment at this operator: the methods, whether a card
 * is held (charged for what is used) and may be saved, and the driver's saved cards that
 * this operator's acquirer account can charge.
 */
export async function paymentSetupFor(orgId: string, principal: DriverPrincipal | null) {
  try {
    const acq = await paymentsFor(orgId);
    const opts = cardOptions(acq.resolved, acq.provider);
    const mine = principal?.appDriverId ? await listCards(principal.appDriverId, { provider: acq.resolved.provider, integrationId: acq.resolved.integrationId }) : [];
    const savedCards = opts.saveCards
      ? mine.filter((k) => k.kind === 'card' && !k.expired).map((k) => ({ id: k.id, brand: k.brand, last4: k.last4, expMonth: k.expMonth, expYear: k.expYear }))
      : [];
    const wallets = walletOptions(acq.resolved, acq.provider);
    const post = postpayOptions(acq.resolved, acq.provider);
    const linkedWallets = (await Promise.all(mine.filter((k) => k.kind === 'ewallet' && k.status === 'active' && wallets.includes(k.channel as any)).map(async (k) => {
      // Where the operator requires a checked balance, a wallet whose balance cannot be read is charged up front.
      let postpay = post.on;
      if (post.on && post.needsBalance && principal?.appDriverId) {
        const t = await walletToken(principal.appDriverId, k.id, { provider: acq.resolved.provider, integrationId: acq.resolved.integrationId });
        let bal: number | null = null;
        try { bal = 'token' in t && acq.provider.walletBalance ? await acq.provider.walletBalance(t.token, k.channel as any) : null; } catch (e) {
          // The link ended at the acquirer: not offered any more; the e-wallet can be linked again.
          if (e instanceof WalletLinkEnded) { await endLink(k.id); return null; }
        }
        postpay = bal != null;
      }
      return { id: k.id, channel: k.channel, accountLabel: k.accountLabel, postpay };
    }))).filter((w) => w !== null);
    return {
      paymentMethods: methodChoices(availableMethods(acq.resolved, acq.provider)),
      cardHolds: opts.holds,
      canSaveCard: opts.saveCards && !!principal?.appDriverId,
      savedCards,
      /** E-wallets the signed-in driver may link here, and those already linked. */
      linkableWallets: principal?.appDriverId ? wallets.filter((c) => !linkedWallets.some((w) => w.channel === c)) : [],
      linkedWallets,
      /** Linked e-wallets pay after the session (post-pay), up to this limit; why not, when blocked. */
      walletPostpay: post.on && linkedWallets.length > 0,
      postpayLimitIdr: post.on ? post.limitIdr : null,
      postpayBlocked: post.on && principal?.appDriverId && (await outstandingPostpay(principal.appDriverId)) ? 'unpaid' : null,
    };
  } catch {
    return { paymentMethods: [], cardHolds: false, canSaveCard: false, savedCards: [], linkableWallets: [], linkedWallets: [], walletPostpay: false, postpayLimitIdr: null, postpayBlocked: null };
  }
}

export interface CheckoutResult {
  ok: boolean;
  error?: string;
  minimumViableIdr?: number;
  chargeId?: string;
  qr?: { qrString: string; qrImage: string; qrPng: string; providerRef: string; amountIdr: number; expiresAt: string };
  /** How to pay: QRIS shows qr; e-wallets and cards open checkoutUrl, or (OVO) wait for the driver to approve in their app. */
  payment?: PaymentView;
  startToken?: string;
  allowanceWh?: number;
  allowanceKwh?: number;
  /** Sandbox acquirer: the app shows the demo payment button. */
  demo?: boolean;
}

export interface PaymentView {
  method: string; channel: string; label: string;
  /** done: a saved card went through at once, nothing for the driver to do. */
  action: 'qr' | 'redirect' | 'push' | 'done';
  checkoutUrl: string | null; providerRef: string; amountIdr: number; expiresAt: string;
  /** A card hold: amountIdr is reserved, only what is used is charged. */
  hold: boolean;
  /** Post-pay: nothing charged now; amountIdr is the limit, the used amount is charged to the linked e-wallet after the session. */
  postpay: boolean;
  savedCardId: string | null;
  saveCard: boolean;
}

/** Where acquirers send the driver back after an e-wallet or card payment. */
export interface PayOptions { channel?: string | null; phone?: string | null; returnUrl: string; savedCardId?: string | null; saveCard?: boolean; walletId?: string | null }

/** Render a QRIS string as a compact SVG data URI, so the app just displays it. */
export async function qrDataUri(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/**
 * The same QR as a PNG, for "Simpan QR". A driver usually pays with the phone
 * that shows the code, and a phone cannot scan its own screen; bank and e-wallet
 * apps accept a QR image from the gallery instead. PNG (not SVG) because that is
 * what the gallery and every QRIS app understand, and because a canvas can
 * compose it without the cross-browser SVG tainting rules.
 */
export async function qrPngDataUri(text: string): Promise<string> {
  return QRCode.toDataURL(text, { type: 'image/png', margin: 0, scale: 12, errorCorrectionLevel: 'M' });
}

/** Create a prepaid charge: QR to pay, a single-use token bound to the payment. */
export async function checkoutPrepaid(
  principal: DriverPrincipal,
  connectorUuid: string,
  amountIdr: number,
  promoCode: string | null = null,
  pay: PayOptions = { returnUrl: '/app/paid.html' },
): Promise<CheckoutResult> {
  // Checked here too, before anything reaches the acquirer (the quote checks it as well).
  if (!Number.isSafeInteger(amountIdr) || amountIdr <= 0) return { ok: false, error: 'Jumlah tidak valid.' };
  const q = await quotePrepaid(connectorUuid, amountIdr, { principal, promoCode });
  if (!q.ok) return { ok: false, error: q.error, minimumViableIdr: q.minimumViableIdr };

  const c = (await connFull(connectorUuid))!;
  // A reserved connector is for the driver who reserved it. Their reservation's
  // idTag (held by the charger) becomes this payment's claim token.
  const held = await reservationOn(c.connector_uuid, principal);
  if (held && !held.mine) return { ok: false, error: 'Konektor ini sedang dipesan pengemudi lain.' };
  if (!held) {
    const queued = await queueBlocks(c.connector_uuid, principal);
    if (queued) return { ok: false, error: queued };
  }

  let acq: Awaited<ReturnType<typeof paymentsFor>>;
  try { acq = await paymentsFor(c.org_id); } catch (e) { if (e instanceof PaymentsUnavailable) return { ok: false, error: 'Pembayaran belum tersedia di charger ini.' }; throw e; }

  // A single-use claim token bound to this payment. The charger must present this
  // exact idTag to draw the energy; nothing else can take the payment. It is minted
  // as kind='prepaid' so settlePrepaid() retires it (status='Expired') once the
  // session settles — the operator QRIS flow mints the same kind for the same reason.
  // Any other kind is silently NOT retired, leaving the token replayable.
  const reserved = held
    ? await one<{ id: string; uid: string }>(`SELECT id, uid FROM token WHERE id = $1 AND kind = 'prepaid'`, [held.token_id])
    : null;
  const claimTag = reserved?.uid ?? `PS-${randomBytes(6).toString('hex').toUpperCase()}`;

  // The payment is recorded (pending, bound to its claim tag) BEFORE the acquirer is asked, and its acquirer reference —
  // derived from this record's id, so a repeated request names the same payment — is added just before the request
  // (startPayment's prepare). A saved card or linked e-wallet charged at once whose answer is lost, or whose record could
  // not be completed, is then still a payment its notification settles (and, never used, the unused-payment sweep
  // refunds), never an orphaned sale.
  const intentId = randomUUID();
  await query(
    `INSERT INTO payment_intent
        (id, org_id, provider, method, mode, state, amount_authorised_idr, allowance_wh, connector_uuid, claim_id_tag, claim_token_minted,
         expires_at, integration_id, channel)
      VALUES ($1, $2, $3, $4, 'prepurchase', 'pending', $5, $6, $7, $8, true, now() + interval '30 minutes', $9, $10)`,
    [intentId, c.org_id, acq.provider.name, pay.walletId ? 'ewallet' : pay.savedCardId ? 'card' : methodOf(String(pay.channel || 'QRIS').toUpperCase() as Channel), amountIdr, q.allowanceWh, c.connector_uuid, claimTag,
     acq.resolved.integrationId, pay.savedCardId ? 'CARD' : pay.walletId ? null : String(pay.channel || 'QRIS').toUpperCase().slice(0, 20)],
  );
  const prepare = (p: PreparedPayment) => query(
    `UPDATE payment_intent SET provider_ref = COALESCE($2, provider_ref), idem_key = COALESCE($2, idem_key), mode = $3, method = $4, channel = $5,
            driver_card_id = $6, save_card = $7, updated_at = now()
      WHERE id = $1`,
    [intentId, p.providerRef, p.mode, p.method, p.channel, p.savedCardId, p.saveCard],
  ).then(() => undefined);
  let charge: Awaited<ReturnType<typeof startPayment>>;
  try {
    charge = await startPayment(acq, {
      channel: pay.channel, customerPhone: pay.phone ?? principal.account?.phone ?? null, returnUrl: pay.returnUrl,
      appDriverId: principal.appDriverId, savedCardId: pay.savedCardId ?? null, saveCard: pay.saveCard === true, allowHold: true, walletId: pay.walletId ?? null,
      referenceId: `charge:${intentId}`,
      amountIdr,
      description: `${await appNameFor(c.org_id)} ${c.site_name} • ${c.ocpp_identity}/${c.connector_no}`,
      prepare,
    });
  } catch (e) {
    if (e instanceof MethodUnavailable) {
      // Refused (declined, not offered, link ended): nothing was taken.
      await query(`UPDATE payment_intent SET state = 'failed', updated_at = now() WHERE id = $1 AND state = 'pending'`, [intentId]);
      return { ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) };
    }
    // No answer from the acquirer: the record stays pending with its reference, for a notification to settle.
    logger.warn({ intent: intentId, err: (e as Error).message }, 'driver checkout: the acquirer did not answer; the payment stays pending for its notification');
    throw e;
  }

  // The acquirer's answer completes the record. A notification that already arrived (the state is no longer pending) is kept.
  await query(
    `UPDATE payment_intent
        SET provider_ref = $2, idem_key = $2, method = $3, mode = $4, channel = $5, checkout_url = $6,
            provider_payment_id = COALESCE(provider_payment_id, $7), save_card = $8, driver_card_id = COALESCE($9, driver_card_id),
            -- A saved card that went through at once: already held (or taken).
            state = CASE WHEN state <> 'pending' THEN state WHEN $10::text = 'authorised' THEN 'authorised' WHEN $10::text = 'captured' THEN 'captured' ELSE 'pending' END,
            authorised_at = CASE WHEN $10::text = 'authorised' THEN COALESCE(authorised_at, now()) ELSE authorised_at END,
            hold_state = CASE WHEN $10::text = 'authorised' THEN COALESCE(hold_state, 'held') ELSE hold_state END,
            amount_captured_idr = CASE WHEN $10::text = 'captured' THEN COALESCE(amount_captured_idr, amount_authorised_idr) ELSE amount_captured_idr END,
            captured_at = CASE WHEN $10::text = 'captured' THEN COALESCE(captured_at, now()) ELSE captured_at END,
            updated_at = now()
      WHERE id = $1`,
    [intentId, charge.providerRef, charge.method, charge.mode, charge.channel, charge.checkoutUrl, charge.providerPaymentId, charge.saveCard, charge.savedCardId, charge.immediate],
  );
  const intent = { id: intentId };

  const tok = reserved
    ? await one<{ id: string }>(
        `UPDATE token SET status = 'Accepted', valid_to = now() + make_interval(mins => $2::int) WHERE id = $1 RETURNING id`,
        [reserved.id, PREPAID_CLAIM_WINDOW_MIN],
      )
    : await one<{ id: string }>(
        // valid_to = the claim window, so the token cannot outlive its payment.
        `INSERT INTO token (org_id, kind, uid, status, valid_to)
         VALUES ($1,'prepaid',$2,'Accepted', now() + make_interval(mins => $3::int)) RETURNING id`,
        [c.org_id, claimTag, PREPAID_CLAIM_WINDOW_MIN],
      );

  const dc = await one<{ id: string }>(
    `INSERT INTO driver_charge
        (device_id, app_driver_id, org_id, connector_uuid, token_id, payment_intent_id, mode, amount_idr, promo_code)
      VALUES ($1,$2,$3,$4,$5,$6,'prepaid',$7,$8) RETURNING id`,
    [principal.deviceId, principal.appDriverId, c.org_id, c.connector_uuid, tok!.id, intent.id, amountIdr,
     // Kept only when it applies, so the session is rated with it.
     promoCode && q.promotion && !q.codeProblem ? String(promoCode).trim().toUpperCase().slice(0, 30) : null],
  );

  logger.info({ chargeId: dc!.id, connector: c.connector_uuid, amountIdr, provider: acq.provider.name }, 'driver prepaid checkout');
  await logPaymentCreated(acq.resolved, c.org_id, charge.providerRef, amountIdr, 'driver app', charge.channel);
  return {
    ok: true,
    chargeId: dc!.id,
    payment: paymentView(charge, amountIdr),
    ...(charge.qrString ? {
      qr: {
        qrString: charge.qrString,
        qrImage: await qrDataUri(charge.qrString),
        qrPng: await qrPngDataUri(charge.qrString),
        providerRef: charge.providerRef,
        amountIdr,
        expiresAt: charge.expiresAt,
      },
    } : {}),
    startToken: claimTag,
    allowanceWh: q.allowanceWh,
    allowanceKwh: q.allowanceKwh,
    // Sandbox acquirer only: the app offers the demo payment button.
    demo: acq.provider.demo === true,
  };
}

export function paymentView(s: Awaited<ReturnType<typeof startPayment>>, amountIdr: number): PaymentView {
  return {
    method: s.method, channel: s.channel, label: CHANNEL_LABEL[s.channel], action: s.action, checkoutUrl: s.checkoutUrl, providerRef: s.providerRef, amountIdr, expiresAt: s.expiresAt,
    hold: s.mode === 'preauth', postpay: s.mode === 'postpay', savedCardId: s.savedCardId, saveCard: s.saveCard,
  };
}

/** Fleet charge: no payment, billed to the org. Uses the driver's own RFID token. */
export async function checkoutFleet(principal: DriverPrincipal, connectorUuid: string): Promise<CheckoutResult> {
  if (!principal.fleet) return { ok: false, error: 'Masuk sebagai pengemudi armada terlebih dahulu.' };
  const c = await connFull(connectorUuid);
  if (!c) return { ok: false, error: 'Konektor tidak ditemukan.' };
  if (c.org_id !== principal.fleet.orgId) {
    return { ok: false, error: 'Charger ini bukan milik armada Anda.' };
  }
  const problem = sellProblem(c) ?? (await fleetTokenProblem(principal.fleet.tokenId));
  if (problem) return { ok: false, error: problem };
  const held = await reservationOn(c.connector_uuid, principal);
  if (held && !held.mine) return { ok: false, error: 'Konektor ini sedang dipesan pengemudi lain.' };
  if (!held) {
    const queued = await queueBlocks(c.connector_uuid, principal);
    if (queued) return { ok: false, error: queued };
  }

  const dc = await one<{ id: string }>(
    `INSERT INTO driver_charge
        (device_id, app_driver_id, org_id, connector_uuid, token_id, mode)
      VALUES ($1,$2,$3,$4,$5,'fleet') RETURNING id`,
    [principal.deviceId, principal.appDriverId, c.org_id, c.connector_uuid, principal.fleet.tokenId],
  );
  return { ok: true, chargeId: dc!.id, startToken: principal.fleet.uid };
}

/** Dev/mock: confirm the QRIS payment. In production a provider webhook does this. */
export async function confirmPayment(principal: DriverPrincipal, chargeId: string): Promise<{ ok: boolean; error?: string }> {
  const dc = await ownedCharge(principal, chargeId);
  if (!dc) return { ok: false, error: 'Transaksi tidak ditemukan.' };
  if (!isRelaxedEnv()) return { ok: false, error: 'Not available in production.' };
  if (!dc.payment_intent_id) return { ok: false, error: 'Bukan transaksi prabayar.' };
  const pi = await one<{ provider: string }>(`SELECT provider FROM payment_intent WHERE id = $1`, [dc.payment_intent_id]);
  if (pi?.provider !== 'mock') return { ok: false, error: 'Menunggu konfirmasi pembayaran dari penyedia QRIS.' };
  await query(
    `UPDATE payment_intent
        SET state = 'captured', amount_captured_idr = amount_authorised_idr, captured_at = now(), updated_at = now()
      WHERE id = $1 AND state <> 'captured'`,
    [dc.payment_intent_id],
  );
  return { ok: true };
}

// ---------------------------------------------------------------- unpaid sessions, paid in the app

/**
 * Two ways a session can end up unpaid with nothing the acquirer can still do about it:
 *   - a card hold whose authorisation expired before it was captured ("hold expired:");
 *   - a post-pay session whose e-wallet charge failed: the link ended ("link ended:"), the balance was not
 *     enough, or the charge was refused otherwise. The e-wallet may still be charged ("pay now", or a retry);
 *     starting an in-app payment stops the retries, and a payment that arrives for a session already paid is refunded.
 * The driver pays it from the receipt, with any method the operator offers: a separate payment
 * (mode 'settlement') that never buys energy and is never refunded as unused. When it is paid, the
 * session is marked paid (settlementPaid) and the operator's alert resolves.
 */
async function unpaidOf(principal: DriverPrincipal, chargeId: string) {
  const dc = await ownedCharge(principal, chargeId);
  if (!dc?.payment_intent_id) return null;
  const pi = await one<{ id: string; org_id: string; mode: string; hold_state: string | null; hold_error: string | null; hold_capture_idr: number | null; channel: string | null;
    provider: string; provider_ref: string | null; provider_payment_id: string | null; integration_id: string | null }>(
    `SELECT id, org_id, mode, hold_state, hold_error, hold_capture_idr, channel, provider, provider_ref, provider_payment_id, integration_id FROM payment_intent WHERE id = $1`, [dc.payment_intent_id]);
  if (!pi) return null;
  // A card hold only once it has expired; post-pay whenever its e-wallet charge failed (link ended, insufficient balance, …).
  if (pi.mode === 'preauth' ? !pi.hold_error?.startsWith(HOLD_EXPIRED) : pi.mode !== 'postpay') return null;
  const paid = pi.hold_state === 'captured' && !!pi.hold_error?.includes(PAID_IN_APP);
  // Post-pay waiting for the driver's e-wallet PIN can be paid another way too.
  const awaitingPin = pi.mode === 'postpay' && pi.hold_state === 'capturing' && !!pi.hold_error?.startsWith('waiting for the driver');
  if (!paid && pi.hold_state !== 'capture_failed' && !awaitingPin) return null;
  return { dc, pi, kind: pi.mode as 'preauth' | 'postpay', owedIdr: Number(pi.hold_capture_idr ?? 0), paid, awaitingPin };
}

export async function payUnpaid(principal: DriverPrincipal, chargeId: string, pay: PayOptions): Promise<
  | { ok: true; paid: true }
  | { ok: true; paid: false; amountIdr: number; payment: PaymentView; qr?: { qrString: string; qrImage: string; qrPng: string; providerRef: string; amountIdr: number; expiresAt: string }; demo: boolean }
  | { ok: false; status: number; error: string; code?: string }
> {
  const h = await unpaidOf(principal, chargeId);
  if (!h) return { ok: false, status: 404, error: 'Tidak ada tagihan yang perlu dibayar untuk sesi ini.' };
  if (h.paid) return { ok: true, paid: true };
  if (h.owedIdr <= 0) return { ok: false, status: 409, error: 'Tidak ada tagihan yang perlu dibayar untuk sesi ini.' };
  let acq: Awaited<ReturnType<typeof paymentsFor>>;
  try { acq = await paymentsFor(h.pi.org_id); } catch (e) { if (e instanceof PaymentsUnavailable) return { ok: false, status: 409, error: 'Pembayaran belum tersedia di operator ini.' }; throw e; }
  // As at checkout: the settlement payment is recorded (pending) before the acquirer is asked, its reference added just
  // before the request, so a saved card or linked e-wallet charged without an answer still settles the session.
  const settlementId = randomUUID();
  await query(
    `INSERT INTO payment_intent (id, org_id, provider, method, mode, state, amount_authorised_idr, expires_at, integration_id, settles_intent_id)
     VALUES ($1, $2, $3, $4, 'settlement', 'pending', $5, now() + interval '30 minutes', $6, $7)`,
    [settlementId, h.pi.org_id, acq.provider.name, pay.walletId ? 'ewallet' : pay.savedCardId ? 'card' : methodOf(String(pay.channel || 'QRIS').toUpperCase() as Channel),
     h.owedIdr, acq.resolved.integrationId, h.pi.id],
  );
  let s: Awaited<ReturnType<typeof startPayment>>;
  try {
    s = await startPayment(acq, {
      channel: pay.channel, customerPhone: pay.phone ?? principal.account?.phone ?? null, returnUrl: pay.returnUrl,
      // A sale for the amount owed: never a new hold, never post-pay.
      appDriverId: principal.appDriverId, savedCardId: pay.savedCardId ?? null, saveCard: false, allowHold: false, walletId: pay.walletId ?? null,
      referenceId: `settle:${settlementId}`, amountIdr: h.owedIdr,
      description: `${await appNameFor(h.pi.org_id)}: sesi pengisian (${h.kind === 'postpay' ? 'bayar setelah selesai' : 'penahanan kartu berakhir'})`,
      prepare: (p) => query(
        `UPDATE payment_intent SET provider_ref = COALESCE($2, provider_ref), idem_key = COALESCE($2, idem_key), method = $3, channel = $4, driver_card_id = $5, updated_at = now() WHERE id = $1`,
        [settlementId, p.providerRef, p.method, p.channel, p.savedCardId]).then(() => undefined),
    });
  } catch (e) {
    if (e instanceof MethodUnavailable) {
      await query(`UPDATE payment_intent SET state = 'failed', updated_at = now() WHERE id = $1 AND state = 'pending'`, [settlementId]);
      return { ok: false, status: 422, error: e.message, ...(e.code ? { code: e.code } : {}) };
    }
    throw e;
  }
  if (h.awaitingPin) {
    // The driver pays another way instead of confirming the e-wallet PIN: the pending e-wallet charge is cancelled at
    // the acquirer (best effort). Should the driver still confirm it, that charge is refunded (applyNotification).
    const { providerOfPayment } = await import('../services/payments/registry.js');
    const prov = await providerOfPayment(h.pi).catch(() => null);
    if (prov?.releaseHold && h.pi.provider_ref) {
      await prov.releaseHold({ providerRef: h.pi.provider_ref, providerPaymentId: h.pi.provider_payment_id, idempotencyKey: `pin-cancel-${h.pi.id}-${h.pi.provider_ref}` })
        .catch((e) => logger.warn({ intent: h.pi.id, err: (e as Error).message }, 'could not cancel the pending e-wallet charge'));
    }
    await query(
      `UPDATE payment_intent SET hold_state = 'capture_failed', checkout_url = NULL, hold_next_attempt_at = NULL, updated_at = now(),
              hold_error = 'pin not confirmed: the driver chose to pay in the app instead of confirming in ' || COALESCE(channel, 'the e-wallet')
        WHERE id = $1 AND hold_state = 'capturing'`, [h.pi.id]);
  }
  if (h.kind === 'postpay') {
    // The driver is paying another way: the automatic e-wallet retries pause while this payment can still be completed
    // (it expires in 30 minutes; 5 more for its notification), so they are not also charged there. Abandoned, the retries
    // resume. "Bayar sekarang" and the console retry still work; if one of them pays first, this payment is refunded.
    await query(`UPDATE payment_intent SET hold_next_attempt_at = now() + interval '35 minutes', updated_at = now() WHERE id = $1 AND hold_state = 'capture_failed'`, [h.pi.id]);
  }
  // The acquirer's answer completes the record (a notification that already settled it is kept).
  await query(
    `UPDATE payment_intent
        SET provider_ref = $2, idem_key = $2, method = $3, channel = $4, checkout_url = $5, provider_payment_id = COALESCE(provider_payment_id, $6),
            driver_card_id = COALESCE($7, driver_card_id),
            state = CASE WHEN state <> 'pending' THEN state WHEN $8::text = 'captured' THEN 'captured' ELSE 'pending' END,
            amount_captured_idr = CASE WHEN $8::text = 'captured' THEN COALESCE(amount_captured_idr, amount_authorised_idr) ELSE amount_captured_idr END,
            captured_at = CASE WHEN $8::text = 'captured' THEN COALESCE(captured_at, now()) ELSE captured_at END,
            updated_at = now()
      WHERE id = $1`,
    [settlementId, s.providerRef, s.method, s.channel, s.checkoutUrl, s.providerPaymentId, s.savedCardId, s.immediate ?? null],
  );
  const row = { id: settlementId };
  await logPaymentCreated(acq.resolved, h.pi.org_id, s.providerRef, h.owedIdr, h.kind === 'postpay' ? 'unpaid post-pay session' : 'expired card hold', s.channel);
  logger.info({ chargeId, intent: h.pi.id, kind: h.kind, settlement: row.id, amountIdr: h.owedIdr, channel: s.channel }, 'driver paying an unpaid session in the app');
  if (s.immediate === 'captured') {
    const { settlementPaid } = await import('../services/payments/holds.js');
    await settlementPaid(row.id);
    return { ok: true, paid: true };
  }
  return {
    ok: true, paid: false, amountIdr: h.owedIdr, payment: paymentView(s, h.owedIdr), demo: acq.provider.demo === true,
    ...(s.qrString ? { qr: { qrString: s.qrString, qrImage: await qrDataUri(s.qrString), qrPng: await qrPngDataUri(s.qrString), providerRef: s.providerRef, amountIdr: h.owedIdr, expiresAt: s.expiresAt } } : {}),
  };
}

/** This phone's (or its account's) unpaid sessions that can be paid in the app: the home screen shows them. */
export async function unpaidSessions(principal: DriverPrincipal) {
  const rows = await many<{ charge_id: string; mode: string; owed: number; site: string; ended_at: Date }>(
    `SELECT dc.id AS charge_id, pi.mode, pi.hold_capture_idr AS owed, si.name AS site, cs.ended_at
       FROM driver_charge dc
       JOIN payment_intent pi ON pi.id = dc.payment_intent_id
       JOIN charging_session cs ON cs.id = pi.session_id
       JOIN site si ON si.id = cs.site_id
      WHERE (dc.device_id = $1 OR ($2::uuid IS NOT NULL AND dc.app_driver_id = $2::uuid))
        AND pi.hold_state = 'capture_failed' AND (pi.mode = 'postpay' OR (pi.mode = 'preauth' AND pi.hold_error LIKE 'hold expired:%'))
      ORDER BY cs.ended_at DESC LIMIT 10`,
    [principal.deviceId, principal.appDriverId ?? null],
  );
  return rows.map((r) => ({ chargeId: r.charge_id, kind: r.mode === 'postpay' ? 'postpay' : 'expired_hold', owedIdr: Number(r.owed ?? 0), site: r.site, endedAt: r.ended_at }));
}

/** Is the unpaid session paid yet (the app polls this while the driver pays)? */
export async function unpaidStatus(principal: DriverPrincipal, chargeId: string) {
  const h = await unpaidOf(principal, chargeId);
  return h ? { kind: h.kind === 'postpay' ? 'postpay' : 'expired_hold', owedIdr: h.owedIdr, paid: h.paid } : null;
}

/** Dev/sandbox: the driver's latest payment for the unpaid session is paid, exactly as the acquirer's notification would settle it. */
export async function confirmUnpaidPayment(principal: DriverPrincipal, chargeId: string): Promise<{ ok: boolean; error?: string }> {
  const h = await unpaidOf(principal, chargeId);
  if (!h) return { ok: false, error: 'Transaksi tidak ditemukan.' };
  if (!isRelaxedEnv()) return { ok: false, error: 'Not available in production.' };
  const s = await one<{ id: string; provider: string }>(
    `SELECT id, provider FROM payment_intent WHERE settles_intent_id = $1 AND mode = 'settlement' AND state = 'pending' ORDER BY created_at DESC LIMIT 1`, [h.pi.id]);
  if (!s) return { ok: false, error: 'Belum ada pembayaran untuk tagihan ini.' };
  if (s.provider !== 'mock') return { ok: false, error: 'Menunggu konfirmasi pembayaran dari penyedia.' };
  await query(`UPDATE payment_intent SET state = 'captured', amount_captured_idr = amount_authorised_idr, captured_at = now(), updated_at = now() WHERE id = $1 AND state = 'pending'`, [s.id]);
  const { settlementPaid } = await import('../services/payments/holds.js');
  await settlementPaid(s.id);
  return { ok: true };
}

/** A session paid in the app: how much, and with what (the payment named in hold_error). */
async function paidInAppOf(intentId: string, holdError: string | null) {
  const m = /payment ([0-9a-f-]{36})\)/.exec(holdError ?? '');
  if (!m) return null;
  const s = await one<{ channel: string | null; paid: number }>(
    `SELECT channel, amount_captured_idr AS paid FROM payment_intent WHERE id = $1 AND settles_intent_id = $2`, [m[1], intentId]);
  return s ? { amountIdr: Number(s.paid), channel: s.channel } : null;
}
interface ChargeRow {
  id: string;
  device_id: string;
  app_driver_id: string | null;
  org_id: string;
  connector_uuid: string;
  token_id: string;
  payment_intent_id: string | null;
  session_id: string | null;
  mode: string;
  amount_idr: number | null;
  created_at: Date;
}

async function ownedCharge(principal: DriverPrincipal, chargeId: string): Promise<ChargeRow | null> {
  const dc = await one<ChargeRow>(`SELECT * FROM driver_charge WHERE id = $1`, [chargeId]);
  if (!dc) return null;
  // A charge belongs to the device that created it, or to the account it is
  // linked to. Fleet charges also belong to the fleet token the device holds.
  if (dc.device_id === principal.deviceId) return dc;
  if (dc.app_driver_id && dc.app_driver_id === principal.appDriverId) return dc;
  if (dc.mode === 'fleet' && principal.fleet && dc.token_id === principal.fleet.tokenId) return dc;
  return null;
}

/** Paid enough to start: taken (a pre-purchase), or held on the card (a hold). */
function isPaidForStart(i: { state: string; mode: string; hold_state: string | null } | null): boolean {
  if (!i) return false;
  if (i.mode === 'preauth' || i.mode === 'postpay') return i.state === 'authorised' && i.hold_state === 'held';
  return i.state === 'captured';
}

/** Ask the charger to start. Prepaid must be paid first. */
export async function startCharge(principal: DriverPrincipal, chargeId: string): Promise<{ ok: boolean; error?: string; status?: string; presentToken?: string }> {
  const dc = await ownedCharge(principal, chargeId);
  if (!dc) return { ok: false, error: 'Transaksi tidak ditemukan.' };

  // Single-use: a charge that has already bound a session cannot be started again.
  // Reconciliation (liveStatus) stamps session_id once the charger opens the
  // transaction; a replayed start after that would spawn a second, unpaid session.
  if (dc.session_id) return { ok: false, error: 'Sesi ini sudah dimulai.' };

  const claimTok = await one<{ uid: string; status: string }>(`SELECT uid, status FROM token WHERE id = $1`, [dc.token_id]);

  if (dc.mode === 'prepaid') {
    const intent = await one<{ state: string; mode: string; hold_state: string | null }>(`SELECT state, mode, hold_state FROM payment_intent WHERE id = $1`, [dc.payment_intent_id]);
    if (!isPaidForStart(intent)) return { ok: false, error: 'Pembayaran belum diterima.' };
    // The claim token is retired to 'Expired' when a prior session settles. If it is
    // no longer Accepted, this payment has already been consumed — refuse the replay
    // at the API layer rather than command the charger with a spent token.
    if (claimTok!.status !== 'Accepted') return { ok: false, error: 'Token pembayaran ini sudah digunakan.' };
  } else {
    // The card may have been blocked, or hit its limit, since checkout.
    const problem = await fleetTokenProblem(dc.token_id);
    if (problem) return { ok: false, error: problem };
  }

  const c = await connFull(dc.connector_uuid);
  if (!c) return { ok: false, error: 'Konektor tidak ditemukan.' };
  // Suspended (or withdrawn) since checkout: the gateway would refuse the start,
  // so do not send one or tell the driver to present the token.
  if (!c.listed) return { ok: false, error: 'Charger ini tidak lagi beroperasi; sesi tidak dapat dimulai. Pembayaran yang tidak terpakai akan dikembalikan.' };
  if (c.suspended) return { ok: false, error: 'Charger ini sementara tidak beroperasi; sesi tidak dapat dimulai. Pembayaran yang tidak terpakai akan dikembalikan.' };

  const idTag = claimTok!.uid;

  if (!registry.isOnline(c.ocpp_identity)) {
    // Cannot command an offline charger. The driver can still start it manually
    // by presenting the token at the reader.
    return { ok: true, status: 'Offline', presentToken: idTag };
  }

  try {
    const res = await remoteStartTransaction(c.ocpp_identity, c.connector_no, idTag, { type: 'system' });
    if (res?.status === 'Accepted') return { ok: true, status: 'Accepted' };
    // Charger declined the remote command — fall back to manual start.
    return { ok: true, status: res?.status ?? 'Rejected', presentToken: idTag };
  } catch (e) {
    logger.warn({ chargeId, err: (e as Error).message }, 'remote start failed');
    return { ok: true, status: 'Unreachable', presentToken: idTag };
  }
}

/** A refund owed to (or paid to) the driver for this charge, when there is one. */
export interface RefundInfo {
  state: 'due' | 'processing' | 'refunded' | 'failed';
  amountIdr: number;
  reason: string | null;
  reference: string | null;
  refundedAt: string | null;
}

async function refundOf(paymentIntentId: string | null): Promise<RefundInfo | null> {
  if (!paymentIntentId) return null;
  const r = await one<{ refund_state: RefundInfo['state'] | null; refund_due_idr: number | null; refunded_idr: number | null; refund_reason: string | null; refund_ref: string | null; refunded_at: Date | null }>(
    `SELECT refund_state, refund_due_idr, refunded_idr, refund_reason, refund_ref, refunded_at FROM payment_intent WHERE id = $1`,
    [paymentIntentId],
  );
  if (!r?.refund_state) return null;
  return {
    state: r.refund_state,
    amountIdr: Number(r.refunded_idr ?? r.refund_due_idr ?? 0),
    reason: r.refund_reason,
    // A bank-transfer reference is the operator's; the driver only needs to know it was paid.
    reference: r.refund_state === 'refunded' ? r.refund_ref : null,
    refundedAt: r.refunded_at ? new Date(r.refunded_at).toISOString() : null,
  };
}

export interface LiveStatus {
  state: 'awaiting_payment' | 'awaiting_start' | 'charging' | 'finishing' | 'ended' | 'rated' | 'refund_pending' | 'refunded' | 'released' | 'unknown';
  /** Set when money is owed back (paid but never started, or unused balance). */
  refund?: RefundInfo | null;
  chargeId: string;
  mode: string;
  energyKwh: number;
  powerKw: number | null;
  durationMin: number;
  startedAt: string | null;
  // prepaid progress
  amountIdr: number | null;
  allowanceKwh: number | null;
  progressPct: number | null;
  /** The cost so far, PBJT-TL and PPN included (= cost.totalIdr; kept for older app builds). */
  estimatedIdr: number | null;
  /** The cost so far, priced as the charge record will be; `final` once it exists. */
  cost?: {
    totalIdr: number; subtotalIdr: number; taxIdr: number; discountIdr: number;
    idleFeeIdr: number; idleMinutes: number; asOf: string; final: boolean;
  } | null;
  siteName: string;
  connectorLabel: string;
  hasReceipt: boolean;
  /** Bidirectional charging (giving energy back), when the site and the car offer it. */
  v2x?: Awaited<ReturnType<typeof driverV2x>>;
}

/** Live view of a charge, reconciling the session to the driver_charge as it appears. */
export async function liveStatus(principal: DriverPrincipal, chargeId: string): Promise<LiveStatus | null> {
  const dc = await ownedCharge(principal, chargeId);
  if (!dc) return null;

  const c = await connFull(dc.connector_uuid);

  // Find the session this charge produced: the one started on this connector with
  // this token after the charge was created. Reconcile session_id once, so later
  // reads are direct.
  let session = dc.session_id
    ? await one<any>(`SELECT * FROM charging_session WHERE id = $1`, [dc.session_id])
    : null;
  if (!session) {
    session = await one<any>(
      `SELECT * FROM charging_session
        WHERE connector_uuid = $1 AND token_id = $2 AND started_at >= $3::timestamptz - interval '10 minutes'
        ORDER BY started_at DESC LIMIT 1`,
      [dc.connector_uuid, dc.token_id, dc.created_at],
    );
    if (session) {
      await query(`UPDATE driver_charge SET session_id = $2 WHERE id = $1`, [dc.id, session.id]);
    }
  }

  const base = {
    chargeId: dc.id,
    mode: dc.mode,
    amountIdr: dc.amount_idr,
    siteName: c?.site_name ?? '—',
    connectorLabel: c ? `${c.current_type} ${Math.round(c.max_power_w / 100) / 10} kW` : '—',
  };

  if (!session) {
    if (dc.mode === 'prepaid') {
      const intent = await one<{ state: string; mode: string; hold_state: string | null }>(`SELECT state, mode, hold_state FROM payment_intent WHERE id = $1`, [dc.payment_intent_id]);
      const paid = isPaidForStart(intent);
      // An unused card hold that was released: nothing was taken, nothing to refund.
      if ((intent?.mode === 'preauth' || intent?.mode === 'postpay') && (intent.hold_state === 'released' || intent.hold_state === 'releasing')) {
        return { ...base, state: 'released', energyKwh: 0, powerKw: null, durationMin: 0, startedAt: null, allowanceKwh: null, progressPct: 0, estimatedIdr: null, hasReceipt: false };
      }
      // Paid, never started, window expired: the money is on its way back.
      const refund = await refundOf(dc.payment_intent_id);
      return {
        ...base,
        refund,
        state: refund ? (refund.state === 'refunded' ? 'refunded' : 'refund_pending') : paid ? 'awaiting_start' : 'awaiting_payment',
        energyKwh: 0,
        powerKw: null,
        durationMin: 0,
        startedAt: null,
        allowanceKwh: null,
        progressPct: 0,
        estimatedIdr: null,
        hasReceipt: false,
      };
    }
    return {
      ...base,
      state: 'awaiting_start',
      energyKwh: 0,
      powerKw: null,
      durationMin: 0,
      startedAt: null,
      allowanceKwh: null,
      progressPct: 0,
      estimatedIdr: null,
      hasReceipt: false,
    };
  }

  const energyKwh = Math.round(Number(session.energy_wh) / 10) / 100;
  const startedAt = new Date(session.started_at);
  const endRef = session.ended_at ? new Date(session.ended_at) : new Date();
  const durationMin = Math.max(0, Math.round((endRef.getTime() - startedAt.getTime()) / 60_000));

  let powerKw: number | null = null;
  const lastPower = await one<{ value: number }>(
    `SELECT value FROM meter_value
      WHERE session_id = $1 AND measurand = 'Power.Active.Import'
      ORDER BY ts DESC LIMIT 1`,
    [session.id],
  );
  if (lastPower && session.state === 'active') powerKw = Math.round(Number(lastPower.value) / 10) / 100;

  let progressPct: number | null = null;
  let allowanceKwh: number | null = null;
  if (dc.mode === 'prepaid' && session.prepaid_energy_wh) {
    allowanceKwh = Math.round(Number(session.prepaid_energy_wh) / 10) / 100;
    progressPct = Math.min(100, Math.round((Number(session.energy_wh) / Number(session.prepaid_energy_wh)) * 100));
  }

  // The cost so far, priced exactly as the charge record will be (every payment mode).
  const cost = await runningCost(session.id).catch(() => null);
  const estimatedIdr = cost ? cost.totalIdr : null;

  const cdr = await one<{ id: string }>(`SELECT id FROM cdr WHERE session_id = $1`, [session.id]);

  const state: LiveStatus['state'] =
    session.state === 'active'
      ? 'charging'
      : session.state === 'ended'
        ? 'finishing'
        : session.state === 'rated' || session.state === 'settled'
          ? 'rated'
          : 'ended';

  return {
    ...base,
    state,
    energyKwh,
    powerKw,
    durationMin,
    startedAt: startedAt.toISOString(),
    allowanceKwh,
    progressPct,
    estimatedIdr,
    cost: cost && {
      totalIdr: cost.totalIdr, subtotalIdr: cost.subtotalIdr, taxIdr: cost.taxIdr, discountIdr: cost.discountIdr,
      idleFeeIdr: cost.idleFeeIdr, idleMinutes: cost.idleMinutes, asOf: cost.asOf, final: cost.final,
    },
    hasReceipt: Boolean(cdr),
    v2x: await driverV2x(session.id),
  };
}

/**
 * Bidirectional charging, as the driver sees it: offered when the site has a programme and the car
 * said it can give energy back; otherwise only what already happened (energy given back, the credit).
 */
async function driverV2x(sessionId: string) {
  const v = await v2xView(sessionId).catch(() => null);
  if (!v || (!v.canOffer && !v.consent && v.exportWh <= 0)) return null;
  return {
    canOffer: v.canOffer,
    consent: v.consent,
    consentSource: v.consentSource,
    minSocPercent: v.minSocPercent ?? v.siteProgramme.minSocPercent,
    siteMinSocPercent: v.siteProgramme.minSocPercent,
    creditIdrPerKwh: v.consent ? v.creditIdrPerKwh : v.siteProgramme.creditIdrPerKwh,
    windows: v.siteProgramme.windows,
    socPercent: v.socPercent,
    discharging: v.discharging,
    dischargeKw: v.dischargeW ? Math.round(v.dischargeW / 100) / 10 : null,
    exportKwh: Math.round(v.exportWh / 10) / 100,
    creditIdr: v.creditIdr,
    notDischargingBecause: v.notDischargingBecause,
  };
}

/** The driver switches giving energy back on or off for their own live charge. */
export async function setV2xConsent(principal: DriverPrincipal, chargeId: string, enabled: boolean, minSocPercent?: number | null) {
  const dc = await ownedCharge(principal, chargeId);
  if (!dc) return { ok: false as const, status: 404, error: 'Transaksi tidak ditemukan.' };
  const s = dc.session_id
    ? { id: dc.session_id }
    : await one<{ id: string }>(
        `SELECT id FROM charging_session WHERE connector_uuid = $1 AND token_id = $2 AND started_at >= $3::timestamptz - interval '10 minutes' ORDER BY started_at DESC LIMIT 1`,
        [dc.connector_uuid, dc.token_id, dc.created_at]);
  if (!s) return { ok: false as const, status: 409, error: 'Pengisian belum dimulai.' };
  try {
    await setDriverConsent(s.id, enabled, minSocPercent);
    return { ok: true as const, v2x: await driverV2x(s.id) };
  } catch (e) {
    if (e instanceof V2xError) return { ok: false as const, status: e.status, error: e.message };
    throw e;
  }
}

/** Stop a live charge. */
export async function stopCharge(principal: DriverPrincipal, chargeId: string): Promise<{ ok: boolean; error?: string; status?: string }> {
  const dc = await ownedCharge(principal, chargeId);
  if (!dc) return { ok: false, error: 'Transaksi tidak ditemukan.' };

  const session = await one<{ ocpp_transaction_id: string | null; charge_point_id: string; state: string }>(
    `SELECT ocpp_transaction_id, charge_point_id, state FROM charging_session
      WHERE (id = $1 OR (connector_uuid = $2 AND token_id = $3))
        AND state = 'active'
      ORDER BY started_at DESC LIMIT 1`,
    [dc.session_id, dc.connector_uuid, dc.token_id],
  );
  if (!session) return { ok: false, error: 'Tidak ada sesi aktif untuk dihentikan.' };

  const c = await connFull(dc.connector_uuid);
  if (!c || !registry.isOnline(c.ocpp_identity)) {
    return { ok: false, error: 'Charger sedang luring. Cabut konektor untuk menghentikan.' };
  }
  if (!session.ocpp_transaction_id) return { ok: false, error: 'Sesi belum siap dihentikan.' };

  try {
    // 1.6 transaction ids are integers; 2.0.1 ids are the station's own strings.
    const txId = registry.wireTransactionId(c.ocpp_identity, session.ocpp_transaction_id);
    const res = await remoteStopTransaction(c.ocpp_identity, txId, { type: 'system' });
    return { ok: true, status: res?.status ?? 'Rejected' };
  } catch (e) {
    return { ok: false, error: 'Gagal menghentikan. Coba lagi.' };
  }
}

/** The itemised receipt, once the session is rated. */
export async function receipt(principal: DriverPrincipal, chargeId: string): Promise<any | null> {
  const dc = await ownedCharge(principal, chargeId);
  if (!dc) return null;

  const row = await one<any>(
    `SELECT cs.id AS session_id, cs.started_at, cs.ended_at, cs.energy_wh, cs.duration_s,
            cs.idle_minutes, cs.payment_mode, cs.prepaid_amount_idr,
            cp.ocpp_identity, e.evse_id AS connector_no, s.name AS site_name, s.address, s.spklu_id,
            -- Seller of record: the site owner when it is set as such, else the operator.
            CASE WHEN so.seller_of_record = 'owner' THEN COALESCE(so.legal_name, so.name) ELSE o.name END AS operator,
            CASE WHEN so.seller_of_record = 'owner' THEN so.npwp ELSE o.npwp END AS operator_npwp,
            CASE WHEN so.seller_of_record = 'owner' THEN so.pkp ELSE o.pkp END AS operator_pkp,
            d.lines, d.subtotal_idr, d.pbjt_idr, d.pbjt_rate_bps, d.ppn_dpp_idr, d.ppn_rate_bps, d.ppn_idr,
            d.total_idr, d.regulatory_flags, d.id AS cdr_id
       FROM driver_charge dc
       JOIN charging_session cs ON (cs.id = dc.session_id
             OR (cs.connector_uuid = dc.connector_uuid AND cs.token_id = dc.token_id
                 AND cs.started_at >= dc.created_at - interval '10 minutes'))
       JOIN charge_point cp ON cp.id = cs.charge_point_id
       JOIN connector conn ON conn.id = cs.connector_uuid
       JOIN evse e ON e.id = conn.evse_uuid
       JOIN site s ON s.id = cs.site_id
       JOIN organisation o ON o.id = cs.org_id
       LEFT JOIN site_owner so ON so.id = s.owner_id
       LEFT JOIN cdr d ON d.session_id = cs.id
      WHERE dc.id = $1
      ORDER BY cs.started_at DESC LIMIT 1`,
    [chargeId],
  );
  if (!row) return null;

  /**
   * Prepaid reconciliation, for the driver's eyes.
   *
   * A prepaid session stops at its energy allowance, but a driver who tops up
   * Rp 100,000 and only draws Rp 50,000 of energy is owed the difference back.
   * The platform already flags this (PREPAID_REFUND_DUE) and parks it for the
   * operator; the app shows the driver what they paid, what they used, and what
   * is coming back, so the refund is visible rather than a surprise on a
   * statement.
   */
  let settlement: {
    paidIdr: number; usedIdr: number; refundIdr: number; topUpIdr: number; refund: RefundInfo | null;
    /** A card hold: what was held, what is (being) charged, and what was released at once. */
    hold?: {
      heldIdr: number; chargedIdr: number; releasedIdr: number; state: string | null;
      /** The authorisation expired before it was captured: unpaidIdr is owed, payable in the app with payOptions. */
      expired?: boolean; unpaidIdr?: number;
      payOptions?: { paymentMethods: unknown[]; savedCards: unknown[]; linkedWallets: unknown[] } | null;
      /** An expired hold the driver has since paid in the app: how much, and with what. */
      paidInApp?: { amountIdr: number; channel: string | null } | null;
    };
    /** Post-pay: the limit, what is (being) charged to the linked e-wallet, and — while unpaid — how to pay. */
    postpay?: {
      limitIdr: number; chargedIdr: number; state: string | null; channel: string | null; unpaid: boolean; checkoutUrl: string | null; error: string | null; linkEnded: boolean;
      /** The charge failed for lack of balance. */
      insufficient?: boolean;
      /** The e-wallet PIN confirmation expired unconfirmed. */
      pinExpired?: boolean;
      /** The e-wallet refused the PIN confirmation. */
      pinDenied?: boolean;
      /** The driver cancelled the PIN confirmation. */
      pinCancelled?: boolean;
      /** The charge failed (link ended, insufficient balance, …) or waits for the PIN: the session can be paid in the app with any of these. */
      payOptions?: { paymentMethods: unknown[]; savedCards: unknown[]; linkedWallets: unknown[] } | null;
      /** Paid in the app after the charge failed: how much, with what, and why it was needed. */
      paidInApp?: { amountIdr: number; channel: string | null; reason: 'link_ended' | 'charge_failed' | 'pin_not_confirmed' | 'pin_expired' | 'pin_denied' | 'pin_cancelled' } | null;
    };
  } | null = null;
  if (dc.mode === 'prepaid' && dc.payment_intent_id && row.cdr_id) {
    const pi = await one<{ captured: number | null; mode: string; authorised: number | null; hold_capture_idr: number | null; hold_state: string | null; channel: string | null; checkout_url: string | null; hold_error: string | null }>(
      `SELECT amount_captured_idr AS captured, mode, amount_authorised_idr AS authorised, hold_capture_idr, hold_state, channel, checkout_url, hold_error FROM payment_intent WHERE id = $1`,
      [dc.payment_intent_id],
    );
    const used = Number(row.total_idr ?? 0);
    if (pi?.mode === 'postpay') {
      const charged = Number(pi.captured ?? pi.hold_capture_idr ?? Math.min(used, Number(pi.authorised ?? 0)));
      const unpaid = pi.hold_state === 'capture_failed' || pi.hold_state === 'capturing';
      // The e-wallet link ended (unlinked in the e-wallet app or expired): pay in the app with another method,
      // or link it again and "pay now". Once paid in the app, the receipt says so.
      const linkEnded = pi.hold_state === 'capture_failed' && !!pi.hold_error?.startsWith(LINK_ENDED);
      const inApp = pi.hold_state === 'captured' && !!pi.hold_error?.includes(PAID_IN_APP)
        ? await paidInAppOf(dc.payment_intent_id, pi.hold_error) : null;
      // Any failed charge (link ended, insufficient balance, …) can be paid in the app with another method.
      const failed = pi.hold_state === 'capture_failed';
      const awaitingPin = pi.hold_state === 'capturing' && !!pi.hold_error?.startsWith('waiting for the driver');
      const setup = failed || awaitingPin ? await paymentSetupFor(dc.org_id, principal) : null;
      settlement = {
        paidIdr: pi.hold_state === 'captured' ? charged : 0, usedIdr: used, refundIdr: 0, topUpIdr: Math.max(0, used - Number(pi.authorised ?? 0)), refund: null,
        postpay: { limitIdr: Number(pi.authorised ?? 0), chargedIdr: charged, state: pi.hold_state, channel: pi.channel, unpaid,
          checkoutUrl: pi.hold_state === 'capturing' ? pi.checkout_url : null, error: pi.hold_state === 'capture_failed' ? pi.hold_error : null,
          linkEnded,
          /** The e-wallet refused the charge for lack of balance: top up and pay now, or pay another way. */
          insufficient: failed && !linkEnded && /insufficient|not enough|saldo|balance/i.test(pi.hold_error ?? ''),
          /** The driver never confirmed the e-wallet PIN and the confirmation expired: confirm a new one, or pay another way. */
          pinExpired: failed && !!pi.hold_error?.startsWith('pin expired:'),
          /** The e-wallet refused the PIN confirmation (declined, or a wrong PIN): try again, or pay another way. */
          pinDenied: failed && !!pi.hold_error?.startsWith('pin denied:'),
          /** The driver cancelled the PIN confirmation in the e-wallet app: confirm again, or pay another way. */
          pinCancelled: failed && !!pi.hold_error?.startsWith('pin cancelled:'),
          payOptions: setup ? { paymentMethods: setup.paymentMethods, savedCards: setup.savedCards, linkedWallets: setup.linkedWallets } : null,
          paidInApp: inApp ? { ...inApp, reason: pi.hold_error?.startsWith(LINK_ENDED) ? 'link_ended' : pi.hold_error?.startsWith('pin not confirmed:') ? 'pin_not_confirmed' : pi.hold_error?.startsWith('pin expired:') ? 'pin_expired' : pi.hold_error?.startsWith('pin denied:') ? 'pin_denied' : pi.hold_error?.startsWith('pin cancelled:') ? 'pin_cancelled' : 'charge_failed' } : null },
      };
    }
    if (pi?.mode === 'preauth') {
      const held = Number(pi.authorised ?? dc.amount_idr ?? 0);
      // The authorisation expired at the acquirer before it was captured: nothing was taken from the card,
      // the hold is gone, and the driver can pay what is owed in the app (then it is paid in the app).
      const expiredHold = !!pi.hold_error?.startsWith(HOLD_EXPIRED);
      const expired = expiredHold && pi.hold_state === 'capture_failed';
      const paidInApp = expiredHold && pi.hold_state === 'captured';
      const charged = expired ? 0 : Number(pi.captured ?? pi.hold_capture_idr ?? Math.min(used, held));
      if (expired || paidInApp) {
        const owed = Number(pi.hold_capture_idr ?? Math.min(used, held));
        const setup = expired ? await paymentSetupFor(dc.org_id, principal) : null;
        const inApp = paidInApp ? await paidInAppOf(dc.payment_intent_id, pi.hold_error) : null;
        const via = inApp ? { channel: inApp.channel, paid: inApp.amountIdr } : null;
        settlement = {
          paidIdr: paidInApp ? Number(via?.paid ?? pi.captured ?? owed) : 0, usedIdr: used, refundIdr: 0, topUpIdr: Math.max(0, used - held), refund: null,
          hold: {
            heldIdr: held, chargedIdr: 0, releasedIdr: held, state: pi.hold_state, expired: true, unpaidIdr: expired ? owed : 0,
            payOptions: setup ? { paymentMethods: setup.paymentMethods, savedCards: setup.savedCards, linkedWallets: setup.linkedWallets } : null,
            paidInApp: paidInApp ? { amountIdr: Number(via?.paid ?? pi.captured ?? owed), channel: via?.channel ?? null } : null,
          },
        };
      } else {
        settlement = {
          paidIdr: charged, usedIdr: used, refundIdr: 0, topUpIdr: Math.max(0, used - held), refund: null,
          hold: { heldIdr: held, chargedIdr: charged, releasedIdr: Math.max(0, held - charged), state: pi.hold_state },
        };
      }
    }
    const paid = Number(pi?.captured ?? dc.amount_idr ?? 0);
    if (!settlement) settlement = {
      paidIdr: paid,
      usedIdr: used,
      refundIdr: Math.max(0, paid - used),
      topUpIdr: Math.max(0, used - paid),
      refund: await refundOf(dc.payment_intent_id),
    };
  }

  // Loyalty points this session used and earned (when the operator runs a loyalty program).
  const pts = row.session_id
    ? await one<{ earned: number; used: number; used_idr: number }>(
        `SELECT COALESCE(sum(points) FILTER (WHERE kind = 'earn'), 0)::int AS earned, COALESCE(-sum(points) FILTER (WHERE kind = 'redeem'), 0)::int AS used,
                COALESCE(-sum(value_idr) FILTER (WHERE kind = 'redeem'), 0)::int AS used_idr
           FROM loyalty_entry WHERE session_id = $1`, [row.session_id])
    : null;

  return {
    chargeId,
    receiptNo: `PS-${String(row.session_id).slice(0, 8).toUpperCase()}`,
    mode: dc.mode,
    sessionId: row.session_id,
    loyalty: pts && (pts.earned || pts.used) ? { earnedPoints: pts.earned, usedPoints: pts.used, usedIdr: pts.used_idr } : null,
    station: {
      name: row.site_name,
      address: row.address,
      spkluId: row.spklu_id,
      operator: row.operator,
      operatorNpwp: row.operator_npwp,
      operatorPkp: Boolean(row.operator_pkp),
    },
    connector: `${row.ocpp_identity} / ${row.connector_no}`,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    energyKwh: Math.round(Number(row.energy_wh) / 10) / 100,
    durationMin: Math.round(Number(row.duration_s ?? 0) / 60),
    idleMinutes: Number(row.idle_minutes ?? 0),
    paymentMode: row.payment_mode,
    prepaidAmountIdr: row.prepaid_amount_idr,
    settlement,
    rated: Boolean(row.cdr_id),
    lines: row.lines ?? [],
    tax: row.cdr_id
      ? {
          subtotalIdr: row.subtotal_idr,
          pbjtIdr: row.pbjt_idr,
          pbjtRateBps: row.pbjt_rate_bps,
          ppnDppIdr: row.ppn_dpp_idr,
          // The statutory PPN rate on DPP nilai lain (12% × 11/12 = 11% effective).
          // 0 when the tariff is set to PPN-exempt (v1.3) — the app then hides the PPN lines.
          ppnRateBps: row.ppn_rate_bps != null ? Number(row.ppn_rate_bps) : config.tax.ppnRateBps,
          ppnEffectiveRateBps: Number(row.ppn_idr ?? 0) > 0 ? effectivePpnRateBps() : 0,
          dppFraction: `${config.tax.ppnDppNumerator}/${config.tax.ppnDppDenominator}`,
          ppnIdr: row.ppn_idr,
          totalIdr: row.total_idr,
        }
      : null,
    flags: row.regulatory_flags ?? [],
    // Signed meter data (OCMF), when the charger's meter signs: the full data is on the printable receipt.
    signedData: await signedSummary(row.session_id ?? dc.session_id),
  };
}

async function signedSummary(sessionId: string | null | undefined) {
  if (!sessionId) return null;
  const d = await signedDataFor(sessionId).catch(() => null);
  if (!d || (!d.values.length && !d.status)) return null;
  return { status: d.status, meterSerial: d.meterSerial, signedEnergyKwh: d.signedEnergyWh == null ? null : Math.round(d.signedEnergyWh) / 1000, values: d.values.length };
}

/**
 * The printable tax receipt (PBJT-TL, DPP nilai lain, PPN) — the same document
 * the operator console issues, so the driver and the CPO hold identical figures.
 * Only once the session is rated; before that there is nothing to invoice.
 */
export async function receiptDocument(principal: DriverPrincipal, chargeId: string): Promise<string | null> {
  const r = await receipt(principal, chargeId);
  if (!r || !r.rated) return null;
  return receiptHtml(r.sessionId);
}

/** The driver's charge history — everything on this device or account. */
/** `orgId`: a white-label app shows only charges at its operator's sites. */
export async function history(principal: DriverPrincipal, limit = 40, orgId: string | null = null): Promise<any[]> {
  const rows = await many<any>(
    `SELECT dc.id AS charge_id, dc.mode, dc.amount_idr, dc.created_at,
            s.name AS site_name, s.address,
            cs.id AS session_id, cs.state, cs.energy_wh, cs.started_at, cs.ended_at, cs.duration_s,
            d.total_idr, pi.refund_state, COALESCE(pi.refunded_idr, pi.refund_due_idr) AS refund_idr
       FROM driver_charge dc
       LEFT JOIN payment_intent pi ON pi.id = dc.payment_intent_id
       JOIN site si ON si.id = (SELECT site_id FROM connector c
                                JOIN evse e ON e.id = c.evse_uuid
                                JOIN charge_point cp ON cp.id = e.charge_point_id
                                WHERE c.id = dc.connector_uuid)
       JOIN site s ON s.id = si.id
       LEFT JOIN charging_session cs ON (cs.id = dc.session_id
             OR (cs.connector_uuid = dc.connector_uuid AND cs.token_id = dc.token_id
                 AND cs.started_at >= dc.created_at - interval '10 minutes'))
       LEFT JOIN cdr d ON d.session_id = cs.id
      WHERE (dc.device_id = $1
         OR ($2::uuid IS NOT NULL AND dc.app_driver_id = $2)
         OR ($3::uuid IS NOT NULL AND dc.mode = 'fleet' AND dc.token_id = $3))
        AND ($5::uuid IS NULL OR s.org_id = $5)
      ORDER BY dc.created_at DESC
      LIMIT $4`,
    [principal.deviceId, principal.appDriverId, principal.fleet?.tokenId ?? null, limit, orgId],
  );

  // Deduplicate: the session join can multiply rows if a token was reused.
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of rows) {
    if (seen.has(r.charge_id)) continue;
    seen.add(r.charge_id);
    out.push({
      chargeId: r.charge_id,
      mode: r.mode,
      siteName: r.site_name,
      address: r.address,
      createdAt: r.created_at,
      state: r.state ?? (r.session_id ? 'active' : r.refund_state === 'refunded' ? 'refunded' : r.refund_state ? 'refund_pending' : 'no_session'),
      refundState: r.refund_state ?? null,
      refundIdr: r.refund_idr != null ? Number(r.refund_idr) : null,
      energyKwh: r.energy_wh != null ? Math.round(Number(r.energy_wh) / 10) / 100 : null,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMin: r.duration_s != null ? Math.round(Number(r.duration_s) / 60) : null,
      totalIdr: r.total_idr ?? r.amount_idr ?? null,
    });
  }
  return out;
}

/** The driver pays an unpaid post-pay session now: charged again, or the e-wallet's confirmation link. */
export async function payPostpayNow(principal: DriverPrincipal, chargeId: string): Promise<{ ok: boolean; paid?: boolean; checkoutUrl?: string | null; error?: string; code?: string }> {
  const dc = await ownedCharge(principal, chargeId);
  if (!dc?.payment_intent_id) return { ok: false, error: 'Transaksi tidak ditemukan.' };
  const pi = await one<{ mode: string; hold_state: string | null; channel: string | null }>(`SELECT mode, hold_state, channel FROM payment_intent WHERE id = $1`, [dc.payment_intent_id]);
  if (pi?.mode !== 'postpay') return { ok: false, error: 'Bukan pembayaran setelah pengisian.' };
  if (pi.hold_state === 'captured') return { ok: true, paid: true };
  if (pi.hold_state !== 'capture_failed' && pi.hold_state !== 'capturing') return { ok: false, error: 'Belum ada tagihan untuk sesi ini.' };
  const r = await settlePostpayNow(dc.payment_intent_id);
  if (r.state === 'captured') return { ok: true, paid: true };
  if (r.checkoutUrl) return { ok: true, paid: false, checkoutUrl: r.checkoutUrl };
  if (r.error?.startsWith(LINK_ENDED)) {
    const n = CHANNEL_LABEL[pi.channel as Channel] ?? 'e-wallet';
    return { ok: false, code: 'wallet_link_ended', error: `Tautan ${n} Anda sudah tidak aktif: diputus di aplikasi ${n} atau kedaluwarsa, jadi tidak ada yang ditagih. Hubungkan ${n} lagi saat memilih pembayaran di charger, lalu bayar dari struk ini.` };
  }
  return { ok: false, error: 'Pembayaran belum berhasil. Periksa saldo e-wallet Anda, lalu coba lagi.' };
}