import { randomUUID } from 'node:crypto';
import { one, outsideRequestScope, query, tx } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { bus } from '../events.js';
import { byId, byWebhookKey, logEvent, resolve, type Resolved } from '../../integrations/store.js';
import { MockPaymentProvider } from './mock.js';
import { MidtransProvider } from './midtrans.js';
import { XenditProvider } from './xendit.js';
import { SnapQrisProvider } from './snap-qris.js';
import { CHANNELS, CHANNEL_LABEL, methodOf, WalletLinkEnded, type Channel, type PaymentProvider } from './provider.js';

/**
 * Which QRIS acquirer takes an operator's payments, from Integrations (or the
 * sandbox outside production). Every payment records the account that took it
 * (payment_intent.integration_id), so its notification and refund go to the
 * same account even after the operator switches provider.
 */

export class PaymentsUnavailable extends Error {}

/** Where a payment stands at the acquirer (an adapter's paymentStatus). */
export interface PaymentStatus {
  status: 'captured' | 'authorised' | 'pending' | 'failed';
  /** The acquirer's own status word, for the log. */
  acquirerStatus: string;
  amountIdr: number | null;
  providerPaymentId?: string;
  raw?: unknown;
}

export interface RefundStatusArgs { providerRef: string; providerPaymentId: string | null; channel: string | null; refundRef: string | null; idempotencyKey: string }

/**
 * What some adapters offer beyond PaymentProvider (provider.ts), used where present:
 *   orderRef        the acquirer's reference for a payment, derived from PlugSure's reference: known BEFORE the
 *                   acquirer is asked (so it is recorded first), and the same when a request is repeated.
 *   paymentStatus   where a payment stands (null: the acquirer has no such payment).
 *   refundStatus    where a refund stands (null: no such refund).
 *   parseRefundEvent  a refund callback, verified.
 *   notificationFresh  whether a notification's signed timestamp is recent (a replay otherwise).
 */
export interface ProviderExtras {
  orderRef?(referenceId: string): string;
  paymentStatus?(providerRef: string): Promise<PaymentStatus | null>;
  refundStatus?(a: RefundStatusArgs): Promise<'refunded' | 'pending' | 'failed' | null>;
  parseRefundEvent?(rawBody: string, headers: Record<string, string | string[] | undefined>): { refundRef: string; status: 'refunded' | 'pending' | 'failed'; event: string } | null;
  notificationFresh?(headers: Record<string, string | string[] | undefined>): boolean;
}
export const extras = (p: PaymentProvider | null | undefined): ProviderExtras => (p ?? {}) as ProviderExtras;

const mock = new MockPaymentProvider();
const instances = new Map<string, { sig: string; p: PaymentProvider }>();

/** The sandbox acquirer (its simulator is used by the development-only payment buttons). */
export function sandboxProvider(): MockPaymentProvider { return mock; }

export function providerFor(r: Resolved): PaymentProvider {
  if (r.provider === 'mock') return mock;
  // One instance per account and settings (SNAP keeps its access token).
  const sig = JSON.stringify([r.provider, r.settings, r.secrets]);
  const key = r.integrationId ?? `env:${r.provider}`;
  const hit = instances.get(key);
  if (hit && hit.sig === sig) return hit.p;
  const s = r.settings, k = r.secrets;
  let p: PaymentProvider;
  switch (r.provider) {
    case 'midtrans': p = new MidtransProvider({ environment: s.environment === 'production' ? 'production' : 'sandbox', serverKey: k.serverKey ?? '', acquirer: s.acquirer, baseUrl: s.baseUrl, savedCard3ds: s.savedCard3ds !== false }); break;
    case 'xendit': p = new XenditProvider({ secretKey: k.secretKey ?? '', callbackToken: k.callbackToken ?? '', forUserId: s.forUserId, baseUrl: s.baseUrl }); break;
    case 'snap': p = new SnapQrisProvider({
      baseUrl: s.baseUrl, partnerId: s.partnerId, clientId: s.clientId, clientSecret: k.clientSecret ?? '', privateKeyPem: k.privateKeyPem ?? '',
      bankPublicKeyPem: s.bankPublicKeyPem, merchantId: s.merchantId, terminalId: s.terminalId, channelId: s.channelId,
      paths: { accessToken: s.accessTokenPath, generateQr: s.generateQrPath },
    }); break;
    default: throw new PaymentsUnavailable(`unknown payment provider ${r.provider}`);
  }
  instances.set(key, { sig, p });
  return p;
}

/** The acquirer for new payments of an organisation. */
export async function paymentsFor(orgId: string): Promise<{ provider: PaymentProvider; resolved: Resolved }> {
  const r = await resolve('payments', orgId);
  if (!r) throw new PaymentsUnavailable('QRIS payments are not set up yet. The operator connects an acquirer under Govern → Integrations.');
  return { provider: providerFor(r), resolved: r };
}

/** The acquirer that took an existing payment (for its refund). */
export async function providerOfPayment(p: { org_id: string; provider: string; integration_id?: string | null }): Promise<PaymentProvider | null> {
  if (p.provider === 'mock') return mock;
  if (p.integration_id) {
    const r = await byId(p.integration_id);
    if (r && r.provider === p.provider) return providerFor(r);
  }
  const cur = await resolve('payments', p.org_id);
  return cur && cur.provider === p.provider ? providerFor(cur) : null;
}

/** Log that a payment was created (the Integrations activity list). */
export async function logPaymentCreated(r: Resolved, orgId: string, providerRef: string, amountIdr: number, purpose: string, channel: Channel = 'QRIS') {
  await logEvent(r, orgId, channel === 'QRIS' ? 'create_qris' : 'create_checkout', 'created', { providerRef, amountIdr, purpose, ...(channel === 'QRIS' ? {} : { channel }) });
}

/**
 * The payment methods drivers may choose: those the operator enabled
 * (Integrations → methods) that the acquirer offers. Before an operator has
 * chosen: QRIS only — or, on the built-in sandbox, everything.
 */
export function availableMethods(r: Resolved, provider: PaymentProvider): Channel[] {
  const offered = provider.channels?.() ?? ['QRIS'];
  const chosen = Array.isArray(r.settings.methods) ? (r.settings.methods as string[]) : r.provider === 'mock' ? CHANNELS : ['QRIS'];
  return CHANNELS.filter((c) => offered.includes(c) && chosen.includes(c));
}

export const methodChoices = (list: Channel[]) => list.map((c) => ({ channel: c, method: methodOf(c), label: CHANNEL_LABEL[c] }));

/**
 * Why a post-pay e-wallet charge that waited for the driver did not complete, from the acquirer's status (Midtrans
 * transaction_status; Xendit status plus failure_code, per its Payments API reference). The prefix drives the receipt.
 * PlugSure's own cancels never reach this: by then the session no longer waits for that charge.
 */
export function postpayFailureNote(status: string): string {
  // Xendit USER_DID_NOT_AUTHORIZE: the driver never authorised it in time, i.e. an expired confirmation.
  if (/expire|DID_NOT_AUTHORIZE/i.test(status)) return `pin expired: the e-wallet confirmation expired before the driver confirmed it (${status})`;
  // Midtrans deny; Xendit USER_DECLINED_PAYMENT (and the older USER_DECLINED_THE_TRANSACTION).
  if (/deny|denied|declin/i.test(status)) return `pin denied: the e-wallet refused the confirmation (${status})`;
  if (/cancel/i.test(status)) return `pin cancelled: the driver cancelled the e-wallet confirmation (${status})`;
  // Midtrans / Xendit INSUFFICIENT_BALANCE and anything else: the receipt reads the balance from the text.
  return `the e-wallet charge was not completed (${status})`;
}

export class MethodUnavailable extends Error {
  /** For the app: 'wallet_link_ended': link the e-wallet again; 'saved_card_ended': the saved card can no longer pay. */
  constructor(message: string, public readonly code?: string) { super(message); }
}

/** The driver-facing message when a linked e-wallet's link has ended at the acquirer. */
export function linkEndedMessage(ch: Channel): string {
  const n = CHANNEL_LABEL[ch] ?? ch;
  return `Tautan ${n} Anda sudah tidak aktif: diputus di aplikasi ${n} atau kedaluwarsa. Tidak ada yang ditagih. Hubungkan ${n} lagi, atau pilih metode lain.`;
}

const BRAND_LABEL: Record<string, string> = { VISA: 'Visa', MASTERCARD: 'Mastercard', AMEX: 'Amex', JCB: 'JCB', GPN: 'GPN' };

/** The driver-facing message when a saved card can no longer pay: its token ended at the acquirer, or the card expired. */
export function cardEndedMessage(card: { brand: string | null; last4: string | null }, expired: boolean): string {
  const name = `${card.brand ? BRAND_LABEL[card.brand.toUpperCase()] ?? card.brand : 'Kartu'}${card.last4 ? ` •••• ${card.last4}` : ''}`;
  return expired
    ? `${name} yang tersimpan sudah kedaluwarsa. Tidak ada yang ditagih. Bayar dengan kartu lain (bisa disimpan lagi), atau pilih metode lain.`
    : `${name} yang tersimpan sudah tidak bisa dipakai: dihapus atau kedaluwarsa di penyedia pembayaran. Tidak ada yang ditagih. Bayar dengan kartu (bisa disimpan lagi), atau pilih metode lain.`;
}

/** The link has ended: stop offering it (the e-wallet can be linked again) and tell the driver. */
async function linkEnded(walletId: string, ch: Channel): Promise<MethodUnavailable> {
  const { endLink } = await import('./cards.js');
  await endLink(walletId);
  return new MethodUnavailable(linkEndedMessage(ch), 'wallet_link_ended');
}

/**
 * Card holds and saved cards at this acquirer account: on only when the
 * operator turned them on, the adapter supports them and cards are offered.
 */
export function cardOptions(r: Resolved, provider: PaymentProvider): { holds: boolean; saveCards: boolean } {
  const f = provider.cardFeatures?.() ?? { holds: false, savedCards: false };
  const cards = availableMethods(r, provider).includes('CARD');
  return { holds: cards && f.holds && r.settings.cardHolds === true, saveCards: cards && f.savedCards && r.settings.saveCards === true };
}

/** The e-wallets drivers may link here: enabled as methods, linkable by the acquirer, and switched on. */
export function walletOptions(r: Resolved, provider: PaymentProvider): Channel[] {
  if (r.settings.linkWallets !== true || !provider.linkableWallets) return [];
  const methods = availableMethods(r, provider);
  return provider.linkableWallets().filter((c) => methods.includes(c));
}

/** Post-pay with linked e-wallets: on, and the most one session may charge. */
export function postpayOptions(r: Resolved, provider: PaymentProvider): { on: boolean; limitIdr: number; needsBalance: boolean } {
  const limit = Number(r.settings.postpayLimitIdr ?? 200_000);
  return { on: r.settings.walletPostpay === true && walletOptions(r, provider).length > 0 && !!provider.chargeWallet, limitIdr: Number.isFinite(limit) && limit > 0 ? Math.round(limit) : 200_000, needsBalance: r.settings.postpayNeedsBalance === true };
}

export interface StartedPayment {
  providerRef: string;
  channel: Channel;
  method: 'qris' | 'ewallet' | 'card';
  /** prepurchase: the amount is taken now (unused balance refunded); preauth: a card hold, the used amount captured later;
   *  postpay: nothing taken now, the used amount charged to the linked e-wallet after the session. */
  mode: 'prepurchase' | 'preauth' | 'postpay';
  /** qr: show qrString; redirect: open checkoutUrl; push: the driver approves in their e-wallet app; done: a saved card went through at once. */
  action: 'qr' | 'redirect' | 'push' | 'done';
  qrString: string | null;
  checkoutUrl: string | null;
  expiresAt: string;
  providerPaymentId: string | null;
  /** A saved card that went through at once: authorised (a hold) or captured (a sale). */
  immediate: 'authorised' | 'captured' | null;
  savedCardId: string | null;
  /** The driver asked to save the card (it is saved when the acquirer confirms the payment). */
  saveCard: boolean;
}

/** What startPayment is about to ask the acquirer for (see its prepare option). */
export interface PreparedPayment {
  /** The acquirer's reference the payment will have; null when it is only known from the answer (the sandbox). */
  providerRef: string | null;
  mode: StartedPayment['mode'];
  method: StartedPayment['method'];
  channel: Channel;
  savedCardId: string | null;
  saveCard: boolean;
}

/** Start a payment through the operator's acquirer, by the method the driver chose. */
export async function startPayment(
  acq: { provider: PaymentProvider; resolved: Resolved },
  a: {
    channel?: string | null; referenceId: string; amountIdr: number; description?: string; returnUrl: string; customerPhone?: string | null;
    /** The signed-in driver (saved cards need one). */
    appDriverId?: string | null;
    /** Pay with this saved card. */
    savedCardId?: string | null;
    /** Save the card used. */
    saveCard?: boolean;
    /** A hold is possible (charging); passes are always a sale. */
    allowHold?: boolean;
    /** Pay with this linked e-wallet (one tap). */
    walletId?: string | null;
    /**
     * Called just BEFORE the acquirer is asked (and, for post-pay, before the decision is released): record the payment
     * with its acquirer reference (null where the adapter cannot tell it in advance: the sandbox), so a charge whose answer
     * is lost — a timeout after the e-wallet or card was charged — still has a record its notification settles. The
     * reference is derived from referenceId, so referenceId must name this payment (e.g. its payment_intent id).
     */
    prepare?: (p: PreparedPayment) => Promise<void>;
  },
): Promise<StartedPayment> {
  const channel = String(a.savedCardId ? 'CARD' : a.channel || 'QRIS').toUpperCase() as Channel;
  if (!availableMethods(acq.resolved, acq.provider).includes(channel)) throw new MethodUnavailable(`${CHANNEL_LABEL[channel] ?? channel} tidak tersedia di operator ini.`);
  const base = { immediate: null, savedCardId: null, saveCard: false, mode: 'prepurchase' as 'prepurchase' | 'preauth' | 'postpay' };
  const ref = extras(acq.provider).orderRef?.(a.referenceId) ?? null;
  const prepare = (p: Omit<PreparedPayment, 'providerRef'> & { providerRef?: string | null }) => a.prepare?.({ ...p, providerRef: p.providerRef ?? ref }) ?? Promise.resolve();
  if (a.walletId) {
    // A linked e-wallet: charged in one tap for the chosen amount; unused balance is refunded automatically.
    if (!a.appDriverId || !acq.provider.chargeWallet) throw new MethodUnavailable('E-wallet terhubung tidak bisa dipakai di operator ini.');
    const { walletToken, markUsed } = await import('./cards.js');
    const t = await walletToken(a.appDriverId, a.walletId, { provider: acq.resolved.provider, integrationId: acq.resolved.integrationId });
    // A link already found ended (e.g. by this checkout's quote): the same message, naming the e-wallet.
    if ('error' in t) throw t.ended ? new MethodUnavailable(linkEndedMessage(t.ended.channel as Channel), 'wallet_link_ended') : new MethodUnavailable(t.error);
    const ch = t.channel as Channel;
    if (!walletOptions(acq.resolved, acq.provider).includes(ch)) throw new MethodUnavailable(`${CHANNEL_LABEL[ch] ?? ch} terhubung tidak tersedia di operator ini.`);
    const post = postpayOptions(acq.resolved, acq.provider);
    // Post-pay: nothing is charged now. The amount is the session's spending limit; the actual total is charged when it ends.
    // Above the operator's limit, or while an earlier post-pay session is unpaid, the e-wallet is charged up front instead.
    // The limit covers ALL the driver's post-pay sessions not yet charged (held, or being decided), and the balance all
    // those on this e-wallet, not this one alone: otherwise any number of sessions started at once each passed the same
    // limit and balance. One decision at a time per driver (an advisory lock), and this payment is recorded as post-pay
    // before the lock is released.
    if (post.on && a.allowHold === true && a.amountIdr <= post.limitIdr) {
      const { postpayExposure } = await import('./holds.js');
      const driverId = a.appDriverId, walletId = a.walletId;
      const postpayRef = `postpay-${randomUUID()}`;
      const decided = await tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('postpay:' || $1::text))`, [driverId]);
        const x = await postpayExposure(driverId, ch, c);
        if (x.unpaid || x.heldIdr + a.amountIdr > post.limitIdr) return false;
        let balance: number | null = null;
        try { balance = acq.provider.walletBalance ? await acq.provider.walletBalance(t.token, ch) : null; } catch (e) {
          if (e instanceof WalletLinkEnded) throw await linkEnded(walletId, ch);
        }
        // Unknown balance while the operator requires a checked one: charged up front below instead.
        if (balance == null && post.needsBalance) return false;
        if (balance != null && balance < x.heldOnWalletIdr + a.amountIdr) {
          throw new MethodUnavailable(x.heldOnWalletIdr > 0
            ? `Saldo ${CHANNEL_LABEL[ch]} Anda (Rp ${balance.toLocaleString('id-ID')}) kurang dari batas yang dipilih ditambah sesi bayar-setelah-selesai Anda yang masih berjalan (Rp ${x.heldOnWalletIdr.toLocaleString('id-ID')}). Pilih jumlah lebih kecil atau isi saldo.`
            : `Saldo ${CHANNEL_LABEL[ch]} Anda (Rp ${balance.toLocaleString('id-ID')}) kurang dari batas yang dipilih. Pilih jumlah lebih kecil atau isi saldo.`);
        }
        await prepare({ providerRef: postpayRef, mode: 'postpay', method: 'ewallet', channel: ch, savedCardId: walletId, saveCard: false });
        return true;
      });
      if (decided) {
        await markUsed(a.walletId);
        return {
          ...base, mode: 'postpay', providerRef: postpayRef, channel: ch, method: 'ewallet', action: 'done', qrString: null, checkoutUrl: null,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), providerPaymentId: null, immediate: 'authorised', savedCardId: a.walletId,
        };
      }
    }
    await prepare({ mode: 'prepurchase', method: 'ewallet', channel: ch, savedCardId: a.walletId, saveCard: false });
    const c = await acq.provider.chargeWallet({ referenceId: a.referenceId, amountIdr: a.amountIdr, channel: ch, token: t.token, returnUrl: a.returnUrl, customerId: a.appDriverId, description: a.description });
    if (c.status === 'failed' && c.linkEnded) throw await linkEnded(a.walletId, ch);
    if (c.status === 'failed') throw new MethodUnavailable(`Pembayaran ${CHANNEL_LABEL[ch]} ditolak${c.message ? ` (${c.message})` : ''}. Periksa saldo, atau pilih metode lain.`);
    await markUsed(a.walletId);
    return {
      ...base, providerRef: c.providerRef, channel: ch, method: 'ewallet', action: c.status === 'pending' ? 'redirect' : 'done', qrString: null,
      checkoutUrl: c.checkoutUrl, expiresAt: c.expiresAt, providerPaymentId: c.providerPaymentId ?? null,
      immediate: c.status === 'captured' ? 'captured' : null, savedCardId: a.walletId,
    };
  }
  if (channel === 'QRIS') {
    await prepare({ mode: 'prepurchase', method: 'qris', channel, savedCardId: null, saveCard: false });
    const q = await acq.provider.createQrisCharge({ referenceId: a.referenceId, amountIdr: a.amountIdr, description: a.description });
    return { ...base, providerRef: q.providerRef, channel, method: 'qris', action: 'qr', qrString: q.qrString, checkoutUrl: null, expiresAt: q.expiresAt, providerPaymentId: null };
  }
  if (channel === 'CARD') {
    const opts = cardOptions(acq.resolved, acq.provider);
    const preauth = opts.holds && a.allowHold === true;
    const mode = preauth ? 'preauth' as const : 'prepurchase' as const;
    if (a.savedCardId) {
      if (!opts.saveCards || !a.appDriverId || !acq.provider.chargeSavedCard) throw new MethodUnavailable('Kartu tersimpan tidak bisa dipakai di operator ini.');
      const { cardToken, markUsed, endCard } = await import('./cards.js');
      const t = await cardToken(a.appDriverId, a.savedCardId, { provider: acq.resolved.provider, integrationId: acq.resolved.integrationId });
      if ('error' in t) throw t.ended ? new MethodUnavailable(cardEndedMessage(t.ended, t.ended.expired), 'saved_card_ended') : new MethodUnavailable(t.error);
      await prepare({ mode, method: 'card', channel, savedCardId: a.savedCardId, saveCard: false });
      const c = await acq.provider.chargeSavedCard({ referenceId: a.referenceId, amountIdr: a.amountIdr, token: t.token, preauth, returnUrl: a.returnUrl, customerId: a.appDriverId, description: a.description });
      // The acquirer no longer accepts the saved token: stop offering the card, and say what to do.
      if (c.status === 'failed' && c.linkEnded) { await endCard(a.savedCardId); throw new MethodUnavailable(cardEndedMessage(t, false), 'saved_card_ended'); }
      if (c.status === 'failed') throw new MethodUnavailable(`Kartu ditolak${c.message ? ` (${c.message})` : ''}. Coba kartu lain atau metode lain.`);
      await markUsed(a.savedCardId);
      return {
        ...base, mode, providerRef: c.providerRef, channel, method: 'card', action: c.status === 'pending' ? 'redirect' : 'done', qrString: null,
        checkoutUrl: c.checkoutUrl, expiresAt: c.expiresAt, providerPaymentId: c.providerPaymentId ?? null,
        immediate: c.status === 'pending' ? null : c.status, savedCardId: a.savedCardId,
      };
    }
    const saveCard = a.saveCard === true && opts.saveCards && !!a.appDriverId;
    await prepare({ mode, method: 'card', channel, savedCardId: null, saveCard });
    const c = await acq.provider.createCheckout!({ referenceId: a.referenceId, amountIdr: a.amountIdr, channel, returnUrl: a.returnUrl, description: a.description, preauth, saveCard, ...(a.appDriverId ? { customerId: a.appDriverId } : {}) });
    return { ...base, mode, saveCard, providerRef: c.providerRef, channel, method: 'card', action: c.action, qrString: null, checkoutUrl: c.checkoutUrl, expiresAt: c.expiresAt, providerPaymentId: c.providerPaymentId ?? null };
  }
  if (!acq.provider.createCheckout) throw new MethodUnavailable(`${CHANNEL_LABEL[channel]} tidak tersedia di operator ini.`);
  // 0812…, 62812… or +62 812-… → +62812…
  const digits = String(a.customerPhone ?? '').replace(/[^\d]/g, '').replace(/^0/, '62');
  const phone = /^628\d{7,12}$/.test(digits) ? `+${digits}` : undefined;
  if (channel === 'OVO' && !phone) throw new MethodUnavailable('Masukkan nomor HP yang terdaftar di OVO (+62…).');
  await prepare({ mode: 'prepurchase', method: methodOf(channel), channel, savedCardId: null, saveCard: false });
  const c = await acq.provider.createCheckout({ referenceId: a.referenceId, amountIdr: a.amountIdr, channel, returnUrl: a.returnUrl, description: a.description, customerPhone: phone });
  return { ...base, providerRef: c.providerRef, channel, method: methodOf(channel), action: c.action, qrString: null, checkoutUrl: c.checkoutUrl, expiresAt: c.expiresAt, providerPaymentId: c.providerPaymentId ?? null };
}

/**
 * A payment notification from an acquirer, at /pay/notify/<key>. Verified with
 * that account's secret; the payment is captured once, only for its full
 * amount. Returns what to answer the acquirer.
 */
export async function handleNotification(key: string, rawBody: string, headers: Record<string, string | string[] | undefined>, path: string): Promise<{ status: number; body: unknown }> {
  const r = await byWebhookKey(key);
  if (!r) return { status: 404, body: { error: 'unknown notification URL' } };
  const provider = providerFor(r);
  const ack = (ok: boolean) => provider.notificationAck?.(ok) ?? { status: ok ? 200 : 401, body: ok ? { ok: true } : { error: 'invalid signature' } };
  // A signed timestamp too far from now (BI-SNAP X-TIMESTAMP, ±5 minutes): a replayed notification, refused unread.
  const fresh = extras(provider).notificationFresh;
  if (fresh && !fresh.call(provider, headers)) {
    await logEvent(r, r.orgId, 'notification', 'rejected', { reason: 'timestamp outside the allowed window (replay?)' });
    return ack(false);
  }
  const n = provider.parseNotification?.(rawBody, headers, path) ?? null;
  if (!n) {
    // Not a payment: perhaps a linked e-wallet's status change (activated, ended, linking failed).
    const ev = provider.parseLinkEvent?.(rawBody, headers) ?? null;
    if (ev) {
      const outcome = await outsideRequestScope(() => applyLinkEvent(r, ev));
      await logEvent(r, r.orgId, 'notification', outcome, { linkEvent: ev.event, status: ev.status });
      return ack(true);
    }
    // ...or a refund the acquirer completed (or refused) after answering "pending".
    const rf = extras(provider).parseRefundEvent?.call(provider, rawBody, headers) ?? null;
    if (rf) {
      const { refundSettled } = await import('../refunds.js');
      const outcome = await outsideRequestScope(() => refundSettled({ provider: r.provider, integrationId: r.integrationId }, rf.refundRef, rf.status));
      await logEvent(r, r.orgId, 'notification', outcome, { refundEvent: rf.event, refundRef: rf.refundRef, status: rf.status });
      return ack(true);
    }
    await logEvent(r, r.orgId, 'notification', 'rejected', { reason: 'signature or body not valid' });
    return ack(false);
  }
  // FAIL CLOSED on the amount. A paid or held payment is only recorded with the amount the acquirer
  // states: without it, the amount PlugSure asked for was booked as received, unverified (and the
  // underpayment check was skipped). Not recorded; a non-2xx answer so the acquirer retries; an alert.
  if ((n.paid || n.authorised) && (n.amountIdr == null || !Number.isFinite(n.amountIdr)) && !provider.unverifiedAmounts) {
    const owner = await outsideRequestScope(() =>
      one<{ org_id: string }>(`SELECT org_id FROM payment_intent WHERE provider = $1 AND provider_ref = $2`, [r.provider, n.providerRef]));
    const orgId = owner?.org_id ?? r.orgId ?? null;
    logger.error({ provider: r.provider, providerRef: n.providerRef, status: n.status }, 'payment notification without an amount; NOT recorded as paid');
    if (orgId) {
      bus.emit('alert.raised', {
        orgId, kind: 'payment.amount_missing', severity: 'critical',
        message: `${r.provider} reported payment ${n.providerRef} as ${n.status} without an amount. It was not recorded as paid. ` +
          `Check it in the acquirer's dashboard; the acquirer will retry the notification.`,
      });
    }
    await logEvent(r, orgId, 'notification', 'amount_missing', { providerRef: n.providerRef, status: n.status });
    return { status: 422, body: { error: 'payment notification has no amount' } };
  }
  const outcome = await outsideRequestScope(() => applyNotification(r, n));
  await logEvent(r, r.orgId ?? outcome.orgId ?? null, 'notification', outcome.outcome, { providerRef: n.providerRef, status: n.status, amountIdr: n.amountIdr, ...(outcome.detail ?? {}) });
  return ack(true);
}

/** A linked e-wallet's status change at the acquirer: a pending link becomes active or failed; an active one ends. */
async function applyLinkEvent(r: Resolved, ev: { linkRef: string; status: 'active' | 'ended' | 'failed' }): Promise<string> {
  const k = await one<{ id: string; status: string }>(
    `SELECT id, status FROM driver_card WHERE provider = $1 AND integration_id IS NOT DISTINCT FROM $2::uuid AND link_ref = $3
        AND kind = 'ewallet' AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [r.provider, r.integrationId, ev.linkRef]);
  if (!k) return 'link_unknown';
  const { settleLink, endLink } = await import('./cards.js');
  if (ev.status === 'active' && k.status === 'pending') { await settleLink(k.id, { status: 'active', token: ev.linkRef }); return 'link_activated'; }
  if (ev.status === 'failed' && k.status === 'pending') { await settleLink(k.id, { status: 'failed' }); return 'link_failed'; }
  if (ev.status === 'ended' && k.status === 'active') { await endLink(k.id); return 'link_ended'; }
  return 'link_unchanged';
}

async function applyNotification(r: Resolved, n: NonNullable<ReturnType<NonNullable<PaymentProvider['parseNotification']>>>): Promise<{ outcome: string; orgId?: string; detail?: Record<string, unknown> }> {
  const intent = await one<{ id: string; org_id: string; state: string; mode: string; amount_authorised_idr: number | null; integration_id: string | null; save_card: boolean }>(
    `SELECT id, org_id, state, mode, amount_authorised_idr, integration_id, save_card FROM payment_intent WHERE provider = $1 AND provider_ref = $2`,
    [r.provider, n.providerRef],
  );
  if (intent) {
    // A notification from one operator's account cannot settle another's payment.
    if (intent.integration_id && r.integrationId && intent.integration_id !== r.integrationId) return { outcome: 'wrong_account', orgId: intent.org_id };
    // The card the driver asked to save, once the acquirer has taken or held the payment.
    const keepCard = async () => {
      if (!n.savedCard || !intent.save_card) return;
      const d = await one<{ app_driver_id: string | null }>(`SELECT app_driver_id FROM driver_charge WHERE payment_intent_id = $1`, [intent.id]);
      if (!d?.app_driver_id) return;
      const { saveCard } = await import('./cards.js');
      const cardId = await saveCard(d.app_driver_id, { provider: r.provider, integrationId: intent.integration_id ?? r.integrationId }, n.savedCard);
      if (cardId) await query(`UPDATE payment_intent SET driver_card_id = $2 WHERE id = $1`, [intent.id, cardId]);
    };
    if (intent.mode === 'postpay') {
      // A post-pay charge the driver confirmed (or let lapse) in the e-wallet.
      if (n.paid) {
        const r2 = await one<{ id: string }>(
          `UPDATE payment_intent SET state = 'captured', amount_captured_idr = COALESCE($2, hold_capture_idr), captured_at = now(), hold_state = 'captured',
                  hold_error = NULL, hold_next_attempt_at = NULL, checkout_url = NULL, updated_at = now(), provider_payment_id = COALESCE($3, provider_payment_id),
                  raw_events = raw_events || $4::jsonb
            WHERE id = $1 AND hold_state <> 'captured' RETURNING id`,
          [intent.id, n.amountIdr, n.paymentId ?? null, JSON.stringify([{ at: new Date(), status: n.status, amountIdr: n.amountIdr }])],
        );
        if (!r2) {
          // Already paid in the app (the driver chose another method instead of the PIN, and the pending charge could
          // not be cancelled): this e-wallet charge is money taken twice, so it is refunded to the e-wallet.
          const cur = await one<{ hold_error: string | null; owed: number | null }>(`SELECT hold_error, hold_capture_idr AS owed FROM payment_intent WHERE id = $1`, [intent.id]);
          if (cur?.hold_error?.includes('paid by the driver in the app')) {
            const { markRefundDue } = await import('../refunds.js');
            await markRefundDue(intent.id, Number(n.amountIdr ?? cur.owed ?? 0), 'Paid twice for the same charging session: the e-wallet charge was confirmed after the session was paid in the app; it is refunded');
            return { outcome: 'postpay_paid_twice_refunded', orgId: intent.org_id };
          }
        }
        return { outcome: r2 ? 'postpay_paid' : 'duplicate', orgId: intent.org_id };
      }
      if (/expire|deny|cancel|fail/i.test(n.status)) {
        await query(
          `UPDATE payment_intent SET hold_state = 'capture_failed', hold_error = $2, hold_next_attempt_at = now() + interval '10 minutes', checkout_url = NULL, updated_at = now()
            WHERE id = $1 AND hold_state = 'capturing'`,
          // An expired, denied or cancelled confirmation (the PIN never entered, refused / wrong, or cancelled by the driver)
          // is named, so the receipt can say so.
          [intent.id, postpayFailureNote(n.status)],
        );
        return { outcome: 'postpay_failed', orgId: intent.org_id };
      }
      return { outcome: 'not_paid', orgId: intent.org_id };
    }
    if (intent.mode === 'preauth') {
      // A card hold. 'authorised' reserves the money; PlugSure captures what was used when the session is rated.
      if (n.authorised) {
        if (intent.state !== 'pending') return { outcome: 'duplicate', orgId: intent.org_id };
        if (n.amountIdr != null && intent.amount_authorised_idr != null && n.amountIdr < intent.amount_authorised_idr) {
          return { outcome: 'amount_mismatch', orgId: intent.org_id, detail: { expected: intent.amount_authorised_idr } };
        }
        await query(
          `UPDATE payment_intent SET state = 'authorised', authorised_at = now(), hold_state = 'held', updated_at = now(),
                  raw_events = raw_events || $2::jsonb, provider_payment_id = COALESCE($3, provider_payment_id)
            WHERE id = $1 AND state = 'pending'`,
          [intent.id, JSON.stringify([{ at: new Date(), status: n.status, paymentId: n.paymentId ?? null }]), n.paymentId ?? null],
        );
        await keepCard();
        return { outcome: 'authorised', orgId: intent.org_id };
      }
      if (n.paid && intent.state !== 'pending') {
        // The acquirer confirming the capture PlugSure asked for. When PlugSure did not see that capture succeed (its answer
        // was lost, or a retry was refused because it had already gone through), the hold is still capturing or
        // capture_failed: this confirmation settles it, for what PlugSure asked to capture, never above the hold.
        const event = JSON.stringify([{ at: new Date(), status: n.status, amountIdr: n.amountIdr }]);
        if (n.amountIdr != null && intent.amount_authorised_idr != null && n.amountIdr > intent.amount_authorised_idr) {
          logger.error({ intent: intent.id, captured: n.amountIdr, authorised: intent.amount_authorised_idr }, 'capture confirmation above the hold; not reconciled');
          await query(`UPDATE payment_intent SET raw_events = raw_events || $2::jsonb WHERE id = $1`, [intent.id, event]);
          return { outcome: 'amount_mismatch', orgId: intent.org_id, detail: { authorised: intent.amount_authorised_idr } };
        }
        const settled = await one<{ id: string; captured: number; authorised: number | null }>(
          `UPDATE payment_intent SET state = 'captured', amount_captured_idr = hold_capture_idr, captured_at = COALESCE(captured_at, now()), hold_state = 'captured',
                  hold_error = NULL, hold_next_attempt_at = NULL, released_at = COALESCE(released_at, now()), updated_at = now(),
                  provider_payment_id = COALESCE(provider_payment_id, $3), raw_events = raw_events || $2::jsonb
            WHERE id = $1 AND hold_state IN ('capturing', 'capture_failed') AND hold_capture_idr IS NOT NULL
              AND (amount_authorised_idr IS NULL OR hold_capture_idr <= amount_authorised_idr)
            RETURNING id, hold_capture_idr AS captured, amount_authorised_idr AS authorised`,
          [intent.id, event, n.paymentId ?? null],
        );
        if (settled) {
          logger.warn({ intent: intent.id, capturedIdr: settled.captured }, 'card hold capture confirmed by the acquirer after PlugSure recorded it as not captured; reconciled');
          const { resolveAlertsFor } = await import('../alerts.js');
          for (const kind of ['payment.hold_capture_failed', 'payment.hold_expired']) await resolveAlertsFor(intent.org_id, kind, 'payment_intent', intent.id);
          bus.emit('payment.hold_captured', { orgId: intent.org_id, paymentIntentId: intent.id, capturedIdr: Number(settled.captured), releasedIdr: Number(settled.authorised ?? 0) - Number(settled.captured) });
          return { outcome: 'capture_reconciled', orgId: intent.org_id };
        }
        await query(`UPDATE payment_intent SET raw_events = raw_events || $2::jsonb WHERE id = $1`, [intent.id, event]);
        return { outcome: 'capture_confirmed', orgId: intent.org_id };
      }
      if (!n.paid && /expire/i.test(n.status) && intent.state === 'authorised') {
        // The authorisation lapsed at the acquirer: released if nothing was owed yet, otherwise expired uncollected.
        const { expireHold } = await import('./holds.js');
        const o = await expireHold(intent.id);
        return { outcome: o === 'expired' ? 'hold_expired' : o === 'released' ? 'hold_released' : 'expired', orgId: intent.org_id };
      }
      if (n.paid) {
        // Taken in full straight away (the account does not hold): it is a pre-purchase after all, unused balance refunded.
        await query(`UPDATE payment_intent SET mode = 'prepurchase' WHERE id = $1 AND state = 'pending'`, [intent.id]);
        logger.warn({ intent: intent.id }, 'card hold was captured in full by the acquirer; treated as a pre-purchase');
      }
    }
    if (!n.paid) {
      const next = /expire/i.test(n.status) ? 'expired' : /deny|cancel|fail/i.test(n.status) ? 'failed' : null;
      if (next && intent.state === 'pending') await one(`UPDATE payment_intent SET state = $2, updated_at = now(), raw_events = raw_events || $3::jsonb WHERE id = $1`, [intent.id, next, JSON.stringify([{ at: new Date(), ...n }])]);
      if (next && intent.mode === 'reservation') await (await import('../../driver/reservations.js')).reservationFeeFailed(intent.id);
      return { outcome: next ?? 'not_paid', orgId: intent.org_id };
    }
    if (intent.state === 'captured') return { outcome: 'duplicate', orgId: intent.org_id };
    if (n.amountIdr != null && intent.amount_authorised_idr != null && n.amountIdr < intent.amount_authorised_idr) {
      logger.error({ intent: intent.id, paid: n.amountIdr, expected: intent.amount_authorised_idr }, 'QRIS notification for less than the payment amount; not captured');
      return { outcome: 'amount_mismatch', orgId: intent.org_id, detail: { expected: intent.amount_authorised_idr } };
    }
    await one(
      `UPDATE payment_intent SET state = 'captured', amount_captured_idr = COALESCE($2, amount_authorised_idr), captured_at = now(), updated_at = now(),
              raw_events = raw_events || $3::jsonb, provider_payment_id = COALESCE(provider_payment_id, $4)
        WHERE id = $1 AND state <> 'captured'`,
      [intent.id, n.amountIdr, JSON.stringify([{ at: new Date(), status: n.status, paymentId: n.paymentId ?? null }]), n.paymentId ?? null],
    );
    await keepCard();
    if (intent.mode === 'reservation') {
      // A reservation fee paid in the app: hold the connector now (or refund, if it can no longer be held).
      const r = await (await import('../../driver/reservations.js')).reservationFeePaid(intent.id);
      return { outcome: r?.ok ? 'reservation_paid' : 'reservation_paid_refund_due', orgId: intent.org_id };
    }
    if (intent.mode === 'settlement') {
      // The driver paid an expired card hold in the app: the hold is paid.
      const { settlementPaid } = await import('./holds.js');
      await settlementPaid(intent.id);
      return { outcome: 'hold_settled', orgId: intent.org_id };
    }
    return { outcome: 'captured', orgId: intent.org_id };
  }
  // A 30-day app pass bought in the driver app.
  const pass = await one<{ id: string; org_id: string; state: string; integration_id: string | null; total_idr: number }>(
    `SELECT id, org_id, state, integration_id, total_idr FROM subscription_charge WHERE provider_ref = $1 AND (provider = $2 OR provider IS NULL)`, [n.providerRef, r.provider]);
  if (pass) {
    // As for payments: a notification from one operator's account cannot settle (or fail) another's pass.
    if (pass.integration_id && r.integrationId && pass.integration_id !== r.integrationId) return { outcome: 'wrong_account', orgId: pass.org_id };
    if (!n.paid) {
      // An automatic renewal that will not complete (expired PIN, refused, cancelled) is retried by the renewal worker.
      if (/expire|deny|cancel|fail|DID_NOT_AUTHORIZE|declin/i.test(n.status)) {
        const { passPaymentFailed } = await import('../../driver/membership.js');
        await passPaymentFailed(pass.id, n.status);
        return { outcome: 'pass_failed', orgId: pass.org_id };
      }
      return { outcome: 'not_paid', orgId: pass.org_id };
    }
    if (pass.state === 'paid') return { outcome: 'duplicate', orgId: pass.org_id };
    // Never for less than the pass costs (as for payments).
    if (n.amountIdr != null && n.amountIdr < Number(pass.total_idr)) {
      logger.error({ pass: pass.id, paid: n.amountIdr, expected: pass.total_idr }, 'pass payment notification for less than the pass costs; not marked paid');
      return { outcome: 'amount_mismatch', orgId: pass.org_id, detail: { expected: Number(pass.total_idr) } };
    }
    const { markPassPaid, passPaidAfterVoid } = await import('../../driver/membership.js');
    if (!(await markPassPaid(pass.id))) {
      // Paid after its checkout was replaced or cancelled (void): the money arrived, the pass will not come from it. Kept
      // as a payment owed back in full (Refunds), never silently.
      const owed = await passPaidAfterVoid(pass.id, { provider: r.provider, integrationId: r.integrationId }, { amountIdr: n.amountIdr, paymentId: n.paymentId ?? null, status: n.status });
      return { outcome: owed ? 'pass_paid_after_void_refund_due' : 'pass_not_payable', orgId: pass.org_id };
    }
    if (n.savedCard) {
      const sc = await one<{ save_card: boolean; app_driver_id: string | null; integration_id: string | null }>(
        `SELECT c.save_card, s.app_driver_id, c.integration_id FROM subscription_charge c JOIN subscription s ON s.id = c.subscription_id WHERE c.id = $1`, [pass.id]);
      if (sc?.save_card && sc.app_driver_id) {
        const { saveCard } = await import('./cards.js');
        const cardId = await saveCard(sc.app_driver_id, { provider: r.provider, integrationId: sc.integration_id ?? r.integrationId }, n.savedCard);
        if (cardId) await query(`UPDATE subscription_charge SET driver_card_id = $2 WHERE id = $1`, [pass.id, cardId]);
      }
    }
    return { outcome: 'pass_paid', orgId: pass.org_id };
  }
  return { outcome: 'unknown_payment' };
}

// ---------------------------------------------------------------- sandbox checkout (development only)

/** A sandbox e-wallet / card payment awaiting the test checkout page. */
export async function sandboxCheckout(ref: string): Promise<{ amountIdr: number; channel: string; state: string; purpose: string; hold?: boolean; save?: boolean } | null> {
  if (!/^mock_[a-z]+_[0-9a-f-]{8,40}$/.test(ref)) return null;
  return outsideRequestScope(async () => {
    const pi = await one<{ amount_authorised_idr: number; channel: string | null; state: string; mode: string; save_card: boolean }>(`SELECT amount_authorised_idr, channel, state, mode, save_card FROM payment_intent WHERE provider = 'mock' AND provider_ref = $1`, [ref]);
    if (pi) return { amountIdr: pi.amount_authorised_idr, channel: pi.channel ?? 'QRIS', state: pi.state, purpose: pi.mode === 'reservation' ? 'Reservation fee' : 'Charging', hold: pi.mode === 'preauth', save: pi.save_card };
    const sc = await one<{ total_idr: number; channel: string | null; state: string }>(`SELECT total_idr, channel, state FROM subscription_charge WHERE provider = 'mock' AND provider_ref = $1`, [ref]);
    return sc ? { amountIdr: sc.total_idr, channel: sc.channel ?? 'QRIS', state: sc.state === 'paid' ? 'captured' : sc.state, purpose: '30-day pass' } : null;
  });
}

/** The sandbox acquirer "notifies" the outcome of its test checkout page, exactly as a real notification is applied. */
export async function sandboxSettle(ref: string, paid: boolean): Promise<string> {
  const r: Resolved = { kind: 'payments', provider: 'mock', settings: {}, secrets: {}, integrationId: null, orgId: null, source: 'default', webhookKey: null };
  const out = await outsideRequestScope(async () => {
    // A sandbox card: a hold is authorised (not taken), and a card the driver asked to save comes back as a token.
    const pi = await one<{ mode: string; channel: string | null; save_card: boolean }>(`SELECT mode, channel, save_card FROM payment_intent WHERE provider = 'mock' AND provider_ref = $1`, [ref]);
    const sc = pi ? null : await one<{ channel: string | null; save_card: boolean }>(`SELECT channel, save_card FROM subscription_charge WHERE provider = 'mock' AND provider_ref = $1`, [ref]);
    const hold = paid && pi?.mode === 'preauth';
    const save = paid && (pi?.save_card || sc?.save_card) === true;
    return applyNotification(r, {
      providerRef: ref, paid: paid && !hold, authorised: hold, status: !paid ? 'cancel' : hold ? 'authorize' : 'settlement', amountIdr: null, paymentId: `sandbox-${ref}`,
      ...(save ? { savedCard: { token: `mock_tok_${randomUUID().replace(/-/g, '').slice(0, 16)}`, brand: 'VISA', last4: '1111', expMonth: 12, expYear: new Date().getFullYear() + 4 } } : {}),
    });
  });
  return out.outcome;
}