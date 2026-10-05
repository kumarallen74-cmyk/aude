import { randomUUID } from 'node:crypto';
import { countryOfCurrency, currencyOfCountry } from '../../domain/country.js';
import { moneyText, currencyOr, LEGACY_CURRENCY, type CurrencyCode } from '../../domain/money.js';
import { one, outsideRequestScope, query, tx } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { config, isRelaxedEnv } from '../../config.js';
import { bus } from '../events.js';
import { byId, byWebhookKey, logEvent, resolve, type Resolved } from '../../integrations/store.js';
import { MockPaymentProvider } from './mock.js';
import { MidtransProvider } from './midtrans.js';
import { XenditProvider } from './xendit.js';
import { SnapQrisProvider } from './snap-qris.js';
import { StripeProvider } from './stripe.js';
import { CHANNELS, CHANNEL_LABEL, channelTakes, methodOf, WalletLinkEnded, currenciesOf, type Channel, type MethodKind, type PaymentProvider, type SavedCardInfo } from './provider.js';

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
  amountMinor: number | null;
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
  /**
   * The id of a verified event (null unless it verifies): notifications are de-duplicated by it (payment_webhook_event),
   * so a replayed or re-delivered event is answered 2xx and not applied again.
   */
  eventId?(rawBody: string, headers: Record<string, string | string[] | undefined>): string | null;
  /** Any other verified event the acquirer sends (it must be answered 2xx, or the acquirer retries it). */
  parseOtherEvent?(rawBody: string, headers: Record<string, string | string[] | undefined>): { event: string } | null;
  /** The card behind a saved-card token, where the notification does not carry it. */
  savedCardDetails?(token: string): Promise<SavedCardInfo | null>;
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
    case 'stripe': {
      // One Stripe account per country (MY or SG); its currency follows (docs/MULTI-COUNTRY-DESIGN.md §D6).
      const country = r.countryCode === 'MY' || r.countryCode === 'SG' ? r.countryCode : null;
      if (!country) throw new PaymentsUnavailable('A Stripe account serves Malaysia or Singapore: set the integration\'s country.');
      p = new StripeProvider({
        secretKey: k.secretKey ?? '', webhookSecret: k.webhookSecret ?? '', publishableKey: s.publishableKey, country, baseUrl: s.baseUrl,
        apiVersion: s.apiVersion, production: !isRelaxedEnv(), allowTestMode: s.allowTestMode === true, publicBaseUrl: config.console.publicBaseUrl,
      });
      break;
    }
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

/**
 * The acquirer for new payments of an organisation in a country (docs/MULTI-COUNTRY-DESIGN.md §D6):
 * its account for that country, which must take the country's currency. Indonesia
 * (the default) resolves exactly as in v1.6.
 */
export async function paymentsFor(orgId: string, country: string = 'ID'): Promise<{ provider: PaymentProvider; resolved: Resolved }> {
  const r = await resolve('payments', orgId, country);
  if (!r) {
    throw new PaymentsUnavailable(country === 'ID'
      ? 'QRIS payments are not set up yet. The operator connects an acquirer under Govern → Integrations.'
      : `Payments in ${country} are not set up yet. The operator connects an acquirer for ${country} under Govern → Integrations.`);
  }
  const provider = providerFor(r);
  assertCurrency(provider, currencyOfCountry(country));
  return { provider, resolved: r };
}

/** Refuse a payment in a currency the account cannot take, before anything is sent (no FX, ever). */
export function assertCurrency(provider: PaymentProvider, currency: string): void {
  if (!currenciesOf(provider).includes(currency as CurrencyCode)) {
    throw new PaymentsUnavailable(`This payment account cannot take ${currency} (it takes ${currenciesOf(provider).join(', ')}).`);
  }
}

/** The acquirer that took an existing payment (for its refund). */
export async function providerOfPayment(p: { org_id: string; provider: string; integration_id?: string | null; currency?: string | null }): Promise<PaymentProvider | null> {
  if (p.provider === 'mock') return mock;
  if (p.integration_id) {
    const r = await byId(p.integration_id);
    if (r && r.provider === p.provider) return providerFor(r);
  }
  // No account recorded: the organisation's current one for the payment's country (its currency's).
  const cur = await resolve('payments', p.org_id, countryOfCurrency(p.currency ?? LEGACY_CURRENCY)?.code ?? 'ID');
  return cur && cur.provider === p.provider ? providerFor(cur) : null;
}

/** Log that a payment was created (the Integrations activity list). */
export async function logPaymentCreated(r: Resolved, orgId: string, providerRef: string, amountMinor: number, purpose: string, channel: Channel = 'QRIS') {
  await logEvent(r, orgId, channel === 'QRIS' ? 'create_qris' : 'create_checkout', 'created', { providerRef, amountMinor, purpose, ...(channel === 'QRIS' ? {} : { channel }) });
}

/**
 * The payment methods drivers may choose: those the operator enabled
 * (Integrations → methods) that the acquirer offers. Before an operator has
 * chosen: QRIS only — or, on the built-in sandbox, everything.
 */
export function availableMethods(r: Resolved, provider: PaymentProvider, currency?: CurrencyCode): Channel[] {
  const offered = provider.channels?.() ?? ['QRIS'];
  const chosen = Array.isArray(r.settings.methods) ? (r.settings.methods as string[]) : r.provider === 'mock' ? CHANNELS : ['QRIS'];
  // Only channels that take the payment's currency (absent: rupiah where the account takes it, as in v1.6; else the account's own).
  const takes = currenciesOf(provider);
  const cur: CurrencyCode = currency ?? (takes.includes(LEGACY_CURRENCY) ? LEGACY_CURRENCY : takes[0]!);
  return CHANNELS.filter((c) => offered.includes(c) && chosen.includes(c) && channelTakes(c, cur));
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
export function cardOptions(r: Resolved, provider: PaymentProvider, currency?: CurrencyCode): { holds: boolean; saveCards: boolean } {
  const f = provider.cardFeatures?.() ?? { holds: false, savedCards: false };
  const cards = availableMethods(r, provider, currency).includes('CARD');
  return { holds: cards && f.holds && r.settings.cardHolds === true, saveCards: cards && f.savedCards && r.settings.saveCards === true };
}

/** The e-wallets drivers may link here: enabled as methods, linkable by the acquirer, and switched on. */
export function walletOptions(r: Resolved, provider: PaymentProvider, currency?: CurrencyCode): Channel[] {
  if (r.settings.linkWallets !== true || !provider.linkableWallets) return [];
  const methods = availableMethods(r, provider, currency);
  return provider.linkableWallets().filter((c) => methods.includes(c));
}

/** Post-pay with linked e-wallets: on, and the most one session may charge. */
export function postpayOptions(r: Resolved, provider: PaymentProvider): { on: boolean; limitMinor: number; needsBalance: boolean } {
  const limit = Number(r.settings.postpayLimitIdr ?? 200_000);
  return { on: r.settings.walletPostpay === true && walletOptions(r, provider).length > 0 && !!provider.chargeWallet, limitMinor: Number.isFinite(limit) && limit > 0 ? Math.round(limit) : 200_000, needsBalance: r.settings.postpayNeedsBalance === true };
}

export interface StartedPayment {
  providerRef: string;
  channel: Channel;
  method: MethodKind;
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
  method: MethodKind;
  channel: Channel;
  savedCardId: string | null;
  saveCard: boolean;
}

/** Start a payment through the operator's acquirer, by the method the driver chose. */
export async function startPayment(
  acq: { provider: PaymentProvider; resolved: Resolved },
  a: {
    channel?: string | null; referenceId: string; amountMinor: number; description?: string; returnUrl: string; customerPhone?: string | null;
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
    /** The payment's currency (absent = IDR); refused unless the account takes it. Callers record it on payment_intent.currency. */
    currency?: CurrencyCode;
  },
): Promise<StartedPayment> {
  const currency: CurrencyCode = a.currency ?? LEGACY_CURRENCY;
  assertCurrency(acq.provider, currency);
  // Linked e-wallet balances are in the payment's currency (the Indonesian e-wallets: rupiah).
  const walletCur = currency;
  // No method named: QRIS where it is offered (Indonesia, as before), else the account's first method (Stripe: the card).
  const offered = availableMethods(acq.resolved, acq.provider, currency);
  const channel = String(a.savedCardId ? 'CARD' : a.channel || (offered.includes('QRIS') || !offered.length ? 'QRIS' : offered[0])).toUpperCase() as Channel;
  if (!availableMethods(acq.resolved, acq.provider, currency).includes(channel)) throw new MethodUnavailable(`${CHANNEL_LABEL[channel] ?? channel} tidak tersedia di operator ini.`);
  // The acquirer's own bounds for the channel (Stripe: its minimum charge per currency; FPX RM 2 – RM 30,000): refused
  // before anything is recorded or sent, rather than failing at the acquirer.
  const lim = acq.provider.amountLimits?.(channel, currency);
  if (lim && a.amountMinor < lim.minMinor) {
    throw new MethodUnavailable(`${CHANNEL_LABEL[channel] ?? channel}: the minimum is ${moneyText(lim.minMinor, currency, 'en')}.`, 'amount_below_minimum');
  }
  if (lim?.maxMinor != null && a.amountMinor > lim.maxMinor) {
    throw new MethodUnavailable(`${CHANNEL_LABEL[channel] ?? channel}: the maximum is ${moneyText(lim.maxMinor, currency, 'en')}.`, 'amount_above_maximum');
  }
  // Only a non-rupiah payment names its currency to the adapter (the Indonesian adapters' requests stay byte-identical).
  const cx = currency === LEGACY_CURRENCY ? {} : { currency };
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
    if (post.on && a.allowHold === true && a.amountMinor <= post.limitMinor) {
      const { postpayExposure } = await import('./holds.js');
      const driverId = a.appDriverId, walletId = a.walletId;
      const postpayRef = `postpay-${randomUUID()}`;
      const decided = await tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('postpay:' || $1::text))`, [driverId]);
        const x = await postpayExposure(driverId, ch, c);
        if (x.unpaid || x.heldMinor + a.amountMinor > post.limitMinor) return false;
        let balance: number | null = null;
        try { balance = acq.provider.walletBalance ? await acq.provider.walletBalance(t.token, ch) : null; } catch (e) {
          if (e instanceof WalletLinkEnded) throw await linkEnded(walletId, ch);
        }
        // Unknown balance while the operator requires a checked one: charged up front below instead.
        if (balance == null && post.needsBalance) return false;
        if (balance != null && balance < x.heldOnWalletMinor + a.amountMinor) {
          throw new MethodUnavailable(x.heldOnWalletMinor > 0
            ? `Saldo ${CHANNEL_LABEL[ch]} Anda (${moneyText(balance, walletCur)}) kurang dari batas yang dipilih ditambah sesi bayar-setelah-selesai Anda yang masih berjalan (${moneyText(x.heldOnWalletMinor, walletCur)}). Pilih jumlah lebih kecil atau isi saldo.`
            : `Saldo ${CHANNEL_LABEL[ch]} Anda (${moneyText(balance, walletCur)}) kurang dari batas yang dipilih. Pilih jumlah lebih kecil atau isi saldo.`);
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
    const c = await acq.provider.chargeWallet({ referenceId: a.referenceId, amountMinor: a.amountMinor, channel: ch, token: t.token, returnUrl: a.returnUrl, customerId: a.appDriverId, description: a.description });
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
    const q = await acq.provider.createQrisCharge({ referenceId: a.referenceId, amountMinor: a.amountMinor, description: a.description });
    return { ...base, providerRef: q.providerRef, channel, method: 'qris', action: 'qr', qrString: q.qrString, checkoutUrl: null, expiresAt: q.expiresAt, providerPaymentId: null };
  }
  if (channel === 'CARD') {
    const opts = cardOptions(acq.resolved, acq.provider, currency);
    const preauth = opts.holds && a.allowHold === true;
    const mode = preauth ? 'preauth' as const : 'prepurchase' as const;
    if (a.savedCardId) {
      if (!opts.saveCards || !a.appDriverId || !acq.provider.chargeSavedCard) throw new MethodUnavailable('Kartu tersimpan tidak bisa dipakai di operator ini.');
      const { cardToken, markUsed, endCard } = await import('./cards.js');
      const t = await cardToken(a.appDriverId, a.savedCardId, { provider: acq.resolved.provider, integrationId: acq.resolved.integrationId });
      if ('error' in t) throw t.ended ? new MethodUnavailable(cardEndedMessage(t.ended, t.ended.expired), 'saved_card_ended') : new MethodUnavailable(t.error);
      await prepare({ mode, method: 'card', channel, savedCardId: a.savedCardId, saveCard: false });
      const c = await acq.provider.chargeSavedCard({ referenceId: a.referenceId, amountMinor: a.amountMinor, token: t.token, preauth, returnUrl: a.returnUrl, customerId: a.appDriverId, description: a.description, ...cx });
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
    const c = await acq.provider.createCheckout!({ referenceId: a.referenceId, amountMinor: a.amountMinor, channel, returnUrl: a.returnUrl, description: a.description, preauth, saveCard, ...(a.appDriverId ? { customerId: a.appDriverId } : {}), ...cx });
    return { ...base, mode, saveCard, providerRef: c.providerRef, channel, method: 'card', action: c.action, qrString: c.qrString ?? null, checkoutUrl: c.checkoutUrl, expiresAt: c.expiresAt, providerPaymentId: c.providerPaymentId ?? null };
  }
  if (!acq.provider.createCheckout) throw new MethodUnavailable(`${CHANNEL_LABEL[channel]} tidak tersedia di operator ini.`);
  // 0812…, 62812… or +62 812-… → +62812…
  const digits = String(a.customerPhone ?? '').replace(/[^\d]/g, '').replace(/^0/, '62');
  const phone = /^628\d{7,12}$/.test(digits) ? `+${digits}` : undefined;
  if (channel === 'OVO' && !phone) throw new MethodUnavailable('Masukkan nomor HP yang terdaftar di OVO (+62…).');
  await prepare({ mode: 'prepurchase', method: methodOf(channel), channel, savedCardId: null, saveCard: false });
  const c = await acq.provider.createCheckout({ referenceId: a.referenceId, amountMinor: a.amountMinor, channel, returnUrl: a.returnUrl, description: a.description, customerPhone: phone, ...cx });
  // PayNow: a QR (its SGQR payload) shown like a QRIS code; FPX / GrabPay: a redirect.
  return { ...base, providerRef: c.providerRef, channel, method: methodOf(channel), action: c.action, qrString: c.qrString ?? null, checkoutUrl: c.checkoutUrl, expiresAt: c.expiresAt, providerPaymentId: c.providerPaymentId ?? null };
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
  // Acquirers that number their events (Stripe): verified first, then each event applied once. A re-delivered or
  // replayed event is answered 2xx (so the acquirer stops) and not applied again; state guards cover two copies in flight.
  const evId = extras(provider).eventId?.call(provider, rawBody, headers) ?? null;
  if (extras(provider).eventId) {
    if (!evId) {
      await logEvent(r, r.orgId, 'notification', 'rejected', { reason: 'signature or body not valid' });
      return ack(false);
    }
    if (await eventSeen(r, evId)) {
      await logEvent(r, r.orgId, 'notification', 'duplicate_event', { eventId: evId });
      return ack(true);
    }
  }
  const done = async <T>(v: T, outcome: string, orgId: string | null = r.orgId): Promise<T> => {
    if (evId) await eventDone(r, evId, outcome, orgId);
    return v;
  };
  const n = provider.parseNotification?.(rawBody, headers, path) ?? null;
  if (!n) {
    // Not a payment: perhaps a linked e-wallet's status change (activated, ended, linking failed).
    const ev = provider.parseLinkEvent?.(rawBody, headers) ?? null;
    if (ev) {
      const outcome = await outsideRequestScope(() => applyLinkEvent(r, ev));
      await logEvent(r, r.orgId, 'notification', outcome, { linkEvent: ev.event, status: ev.status });
      return done(ack(true), outcome);
    }
    // ...or a refund the acquirer completed (or refused) after answering "pending".
    const rf = extras(provider).parseRefundEvent?.call(provider, rawBody, headers) ?? null;
    if (rf) {
      const { refundSettled } = await import('../refunds.js');
      const outcome = await outsideRequestScope(() => refundSettled({ provider: r.provider, integrationId: r.integrationId }, rf.refundRef, rf.status));
      await logEvent(r, r.orgId, 'notification', outcome, { refundEvent: rf.event, refundRef: rf.refundRef, status: rf.status });
      return done(ack(true), outcome);
    }
    // ...or any other verified event: acknowledged, nothing to do (an unanswered event is retried for days).
    const other = extras(provider).parseOtherEvent?.call(provider, rawBody, headers) ?? null;
    if (other) {
      await logEvent(r, r.orgId, 'notification', 'ignored', { event: other.event });
      return done(ack(true), 'ignored');
    }
    await logEvent(r, r.orgId, 'notification', 'rejected', { reason: 'signature or body not valid' });
    return ack(false);
  }
  // FAIL CLOSED on the amount. A paid or held payment is only recorded with the amount the acquirer
  // states: without it, the amount PlugSure asked for was booked as received, unverified (and the
  // underpayment check was skipped). Not recorded; a non-2xx answer so the acquirer retries; an alert.
  if ((n.paid || n.authorised) && (n.amountMinor == null || !Number.isFinite(n.amountMinor)) && !provider.unverifiedAmounts) {
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
  // A saved card whose details the notification does not carry (Stripe: webhook objects are not expanded).
  if (n.savedCard && !n.savedCard.brand && !n.savedCard.last4 && extras(provider).savedCardDetails) {
    const d = await extras(provider).savedCardDetails!.call(provider, n.savedCard.token).catch(() => null);
    if (d) n.savedCard = { ...n.savedCard, ...d };
  }
  const outcome = await outsideRequestScope(() => applyNotification(r, n));
  await logEvent(r, r.orgId ?? outcome.orgId ?? null, 'notification', outcome.outcome, { providerRef: n.providerRef, status: n.status, amountMinor: n.amountMinor, ...(n.currency ? { currency: n.currency } : {}), ...(outcome.detail ?? {}) });
  return done(ack(true), outcome.outcome, r.orgId ?? outcome.orgId ?? null);
}

/** Whether this account already applied this event (payment_webhook_event, migration 070). */
async function eventSeen(r: Resolved, eventId: string): Promise<boolean> {
  if (!r.integrationId) return false;
  const hit = await outsideRequestScope(() => one(`SELECT 1 FROM payment_webhook_event WHERE integration_id = $1 AND event_id = $2`, [r.integrationId, eventId.slice(0, 255)]));
  return !!hit;
}

/**
 * Record an event as applied — after it was, so an event whose handling failed (a 5xx, retried by the acquirer) is not
 * skipped next time. Old rows are pruned now and then (the acquirer retries for 3 days; 35 are kept).
 */
async function eventDone(r: Resolved, eventId: string, outcome: string, orgId: string | null): Promise<void> {
  if (!r.integrationId) return;
  await outsideRequestScope(async () => {
    await query(
      `INSERT INTO payment_webhook_event (integration_id, event_id, org_id, outcome) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [r.integrationId, eventId.slice(0, 255), orgId, outcome.slice(0, 80)]);
    if (Math.random() < 0.01) await query(`DELETE FROM payment_webhook_event WHERE received_at < now() - interval '35 days'`);
  }).catch((e) => logger.warn({ err: (e as Error).message, eventId }, 'payment webhook event not recorded'));
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

/**
 * Why a notification received on account `r` may NOT settle a payment of `owner` (a payment intent or a pass charge);
 * null when it may.
 *
 * The check used to be only "both integration ids set and different". Defence in depth on top of it:
 *  - an organisation's own account (r.orgId set) settles that organisation's payments only, whatever the ids say
 *    (a platform account, r.orgId null, serves every organisation);
 *  - one side naming an account and the other none: every payment taken in production records the account that took
 *    it, and every notification arrives on a configured account, so a mismatch there is not a payment of this account.
 *    Relaxed only in development and test, where the built-in sandbox acquirer has no account row.
 * `requireAccount: false` skips the last rule (pass charges: rows from before the provider was recorded on them).
 * Exported for the unit tests.
 */
export function notificationAccountMismatch(
  owner: { org_id: string; integration_id: string | null },
  r: Pick<Resolved, 'orgId' | 'integrationId'>,
  opts: { env?: string; requireAccount?: boolean } = {},
): string | null {
  if (owner.integration_id && r.integrationId && owner.integration_id !== r.integrationId) return 'another account took this payment';
  if (r.orgId && owner.org_id !== r.orgId) return "the notification arrived on another organisation's account";
  if (opts.requireAccount !== false && !isRelaxedEnv(opts.env) && !owner.integration_id !== !r.integrationId) {
    return owner.integration_id ? 'the payment names an account, the notification none' : 'the notification names an account, the payment none';
  }
  return null;
}

type Notification = NonNullable<ReturnType<NonNullable<PaymentProvider['parseNotification']>>>;

/**
 * The acquirer reports LESS than the payment was for: a card held for less than the driver chose, or a QRIS / e-wallet
 * payment for less than the price.
 *
 * It was only logged, and the notification answered 200, so the acquirer never asked again: the money stayed taken (or
 * held) with nothing in PlugSure owing it back and nobody told. It still does not buy what was asked for — the payment
 * is never booked as paid or held, so it cannot start a session, and its claim token is retired — but now:
 *  - a hold for less is RELEASED through the card-hold machinery (hold_state 'releasing'; the hold worker releases it
 *    at the acquirer and retries, and the console shows it under Refunds → Card holds). Nothing was taken, so nothing
 *    is refunded;
 *  - money taken for less is recorded as taken (amount_captured_minor) on a payment marked 'voided' (never 'captured',
 *    which would let it start a session or count as paid) and queued for a full refund (Refunds), so it is paid back,
 *    not stranded;
 *  - a critical alert, as for a notification without an amount.
 * Once per payment: a repeated notification finds the row already moved and raises nothing again.
 */
async function underpaid(
  r: Resolved,
  intent: { id: string; org_id: string; amount_authorised_minor: number | null; currency?: string | null },
  n: Notification,
  kind: 'hold' | 'payment',
): Promise<{ outcome: string; orgId?: string; detail?: Record<string, unknown> }> {
  const expected = Number(intent.amount_authorised_minor);
  // Amounts in the payment's currency (rupiah written exactly as before).
  const cur = currencyOr(intent.currency);
  const m = (x: number) => moneyText(x, cur, 'id');
  const plain = (x: number) => moneyText(x, cur, 'plain');
  const got = Math.max(0, Math.round(Number(n.amountMinor)));
  const event = JSON.stringify([{ at: new Date(), status: n.status, amountMinor: n.amountMinor, expectedMinor: expected, amountMismatch: true }]);
  const moved = kind === 'hold'
    ? await one<{ id: string }>(
        `UPDATE payment_intent SET hold_state = 'releasing', hold_attempts = 0, hold_next_attempt_at = now(), updated_at = now(),
                hold_error = $4, raw_events = raw_events || $2::jsonb, provider_payment_id = COALESCE($3, provider_payment_id)
          WHERE id = $1 AND state = 'pending' AND hold_state IS NULL
          RETURNING id`,
        [intent.id, event, n.paymentId ?? null,
         `amount mismatch: authorised ${m(got)} of ${m(expected)}; the authorisation is released`],
      )
    : await one<{ id: string }>(
        `UPDATE payment_intent SET state = 'voided', amount_captured_minor = $4, captured_at = now(), updated_at = now(),
                raw_events = raw_events || $2::jsonb, provider_payment_id = COALESCE(provider_payment_id, $3)
          WHERE id = $1 AND state NOT IN ('captured', 'voided') AND amount_captured_minor IS NULL
          RETURNING id`,
        [intent.id, event, n.paymentId ?? null, got],
      );
  if (!moved) {
    // Already handled by an earlier copy of this notification (or settled otherwise): only the event is kept.
    await query(`UPDATE payment_intent SET raw_events = raw_events || $2::jsonb WHERE id = $1`, [intent.id, event]);
    return { outcome: 'amount_mismatch', orgId: intent.org_id, detail: { expected, duplicate: true } };
  }
  // The payment cannot start a session any more: its single-use token goes with it.
  await query(
    `UPDATE token SET status = 'Expired'
      WHERE org_id = $1 AND kind = 'prepaid' AND uid = (SELECT claim_id_tag FROM payment_intent WHERE id = $2 AND session_id IS NULL)`,
    [intent.org_id, intent.id],
  );
  let refundQueued = false;
  if (kind === 'payment') {
    const { markRefundDue } = await import('../refunds.js');
    refundQueued = await markRefundDue(intent.id, got, `Paid ${plain(got)} of the ${plain(expected)} asked; not accepted as payment, refunded in full`);
  }
  logger.error({ intent: intent.id, provider: r.provider, got, expected, kind }, kind === 'hold'
    ? 'card hold authorised for less than asked; not accepted, the authorisation is released'
    : 'payment notification for less than the payment amount; not captured, refund queued');
  bus.emit('alert.raised', {
    orgId: intent.org_id, kind: 'payment.amount_mismatch', severity: 'critical',
    message: kind === 'hold'
      ? `${r.provider} authorised ${m(got)} on a card for payment ${n.providerRef}, which was for ${m(expected)}. ` +
        `It was not accepted (no session can start with it) and the authorisation is being released (Refunds → Card holds). Check it in the acquirer's dashboard.`
      : `${r.provider} reported payment ${n.providerRef} as paid for ${m(got)}, but it was for ${m(expected)}. ` +
        `It was not accepted as paid (no session can start with it); ` +
        (refundQueued ? `a full refund of what was taken is queued under Refunds.` : `nothing was queued for refund — check it in the acquirer's dashboard.`),
    targetType: 'payment_intent', targetId: intent.id,
  });
  return { outcome: 'amount_mismatch', orgId: intent.org_id, detail: { expected, ...(kind === 'hold' ? { released: true } : { refundQueued }) } };
}

/**
 * A 30-day pass paid for LESS than it costs. It was only logged (and answered 200, so the acquirer never asked again):
 * the driver's money stayed taken, the charge stayed pending, nothing owed it back and nobody was told. Treated like
 * an underpaid payment (underpaid() above):
 *  - the pass is NOT activated (markPassPaid is never called for it);
 *  - what was taken is recorded as a payment (mode 'pass') and queued for a full refund (Refunds) through the same
 *    machinery as a pass paid after its checkout was voided (recordPassPaymentForRefund) — paid back, not stranded;
 *  - the charge is voided, so this checkout cannot activate the pass later; the driver buys again in the app. An
 *    automatic renewal is not retried automatically: an acquirer that charged the wrong amount once may do so again,
 *    and every retry would take (and owe back) more of the driver's money. Auto-renewal is switched off with the
 *    reason, the driver renews by hand, and the operator has the alert;
 *  - a critical payment.amount_mismatch alert, once: a repeated notification finds the payment already recorded and the
 *    charge already void, and raises nothing.
 */
async function passUnderpaid(
  r: Resolved,
  pass: { id: string; org_id: string; total_minor: number; currency?: string | null },
  n: Notification,
): Promise<{ outcome: string; orgId?: string; detail?: Record<string, unknown> }> {
  const expected = Number(pass.total_minor);
  const cur = currencyOr(pass.currency);
  const m = (x: number) => moneyText(x, cur, 'id');
  const plain = (x: number) => moneyText(x, cur, 'plain');
  const got = Math.max(0, Math.round(Number(n.amountMinor)));
  const { recordPassPaymentForRefund } = await import('../../driver/membership.js');
  // Money first: should anything after this fail, the payment is already owed back.
  const rec = await recordPassPaymentForRefund(pass.id, { provider: r.provider, integrationId: r.integrationId },
    { amountMinor: got, paymentId: n.paymentId ?? null, status: n.status }, {
      idemPrefix: 'pass-underpaid',
      reason: `Paid ${plain(got)} of the ${plain(expected)} a 30-day pass costs; not accepted as payment, refunded in full`,
      event: { expectedMinor: expected, amountMismatch: true },
    });
  const voided = await one<{ subscription_id: string; auto_renewal: boolean }>(
    `UPDATE subscription_charge SET state = 'void' WHERE id = $1 AND state = 'pending' RETURNING subscription_id, auto_renewal`, [pass.id]);
  if (voided?.auto_renewal) {
    await query(`UPDATE subscription SET auto_renew = false, renew_next_at = NULL, renew_error = $2 WHERE id = $1`,
      [voided.subscription_id, 'Renewal: the payment was reported for the wrong amount and refunded. Renew in the app.']);
  }
  // Once: the first copy of the notification records the payment (or, with nothing to refund, voids the charge).
  const first = rec ? rec.created : voided != null;
  if (!first) return { outcome: 'amount_mismatch', orgId: pass.org_id, detail: { expected, duplicate: true } };
  const refundQueued = rec?.created === true;
  logger.error({ pass: pass.id, provider: r.provider, got, expected, refundIntent: rec?.id ?? null },
    'pass payment notification for less than the pass costs; pass not activated, refund queued');
  bus.emit('alert.raised', {
    orgId: pass.org_id, kind: 'payment.amount_mismatch', severity: 'critical',
    message: `${r.provider} reported 30-day pass payment ${n.providerRef} as paid for ${m(got)}, but the pass costs ` +
      `${m(expected)}. The pass was not activated and the checkout was cancelled; ` +
      (refundQueued ? 'a full refund of what was taken is queued under Refunds.' : 'nothing was queued for refund — check it in the acquirer\'s dashboard.'),
    ...(rec?.id ? { targetType: 'payment_intent', targetId: rec.id } : {}),
  });
  return { outcome: 'amount_mismatch', orgId: pass.org_id, detail: { expected, refundQueued } };
}

/**
 * The acquirer reports the payment in ANOTHER currency than PlugSure asked for. Nothing in that currency can be booked
 * against this payment (no FX, ever), and its amount cannot be compared. Never accepted: a hold is released through the
 * hold machinery (nothing was taken); money taken is NOT queued for an automatic refund (PlugSure's refund amounts are in
 * the payment's currency) — the payment is voided and a critical alert asks for a refund in the acquirer's dashboard.
 * Once per payment.
 */
async function currencyMismatch(
  r: Resolved,
  intent: { id: string; org_id: string; currency?: string | null },
  n: Notification,
  kind: 'hold' | 'payment',
): Promise<{ outcome: string; orgId?: string; detail?: Record<string, unknown> }> {
  const expected = intent.currency ?? LEGACY_CURRENCY;
  const event = JSON.stringify([{ at: new Date(), status: n.status, amountMinor: n.amountMinor, currency: n.currency, expectedCurrency: expected, currencyMismatch: true }]);
  const moved = kind === 'hold'
    ? await one<{ id: string }>(
        `UPDATE payment_intent SET hold_state = 'releasing', hold_attempts = 0, hold_next_attempt_at = now(), updated_at = now(),
                hold_error = $4, raw_events = raw_events || $2::jsonb, provider_payment_id = COALESCE($3, provider_payment_id)
          WHERE id = $1 AND state = 'pending' AND hold_state IS NULL RETURNING id`,
        [intent.id, event, n.paymentId ?? null, `currency mismatch: authorised in ${n.currency}, the payment is in ${expected}; the authorisation is released`])
    : await one<{ id: string }>(
        `UPDATE payment_intent SET state = 'voided', updated_at = now(), raw_events = raw_events || $2::jsonb, provider_payment_id = COALESCE(provider_payment_id, $3)
          WHERE id = $1 AND state NOT IN ('captured', 'voided') RETURNING id`,
        [intent.id, event, n.paymentId ?? null]);
  if (!moved) {
    await query(`UPDATE payment_intent SET raw_events = raw_events || $2::jsonb WHERE id = $1`, [intent.id, event]);
    return { outcome: 'currency_mismatch', orgId: intent.org_id, detail: { expected, duplicate: true } };
  }
  await query(
    `UPDATE token SET status = 'Expired'
      WHERE org_id = $1 AND kind = 'prepaid' AND uid = (SELECT claim_id_tag FROM payment_intent WHERE id = $2 AND session_id IS NULL)`,
    [intent.org_id, intent.id]);
  logger.error({ intent: intent.id, provider: r.provider, got: n.currency, expected, kind }, 'payment notification in another currency than the payment; not accepted');
  bus.emit('alert.raised', {
    orgId: intent.org_id, kind: 'payment.amount_mismatch', severity: 'critical',
    message: `${r.provider} reported payment ${n.providerRef} in ${n.currency}, but it was asked for in ${expected}. It was not accepted (no session can start with it); ` +
      (kind === 'hold' ? 'the authorisation is being released (Refunds → Card holds).' : `refund what was taken in the acquirer's dashboard (${n.amountMinor ?? '?'} ${n.currency}); PlugSure did not queue a refund.`),
    targetType: 'payment_intent', targetId: intent.id,
  });
  return { outcome: 'currency_mismatch', orgId: intent.org_id, detail: { expected, got: n.currency, ...(kind === 'hold' ? { released: true } : {}) } };
}

async function applyNotification(r: Resolved, n: Notification): Promise<{ outcome: string; orgId?: string; detail?: Record<string, unknown> }> {
  const intent = await one<{ id: string; org_id: string; state: string; mode: string; amount_authorised_minor: number | null; integration_id: string | null; save_card: boolean; currency: string }>(
    `SELECT id, org_id, state, mode, amount_authorised_minor, integration_id, save_card, currency FROM payment_intent WHERE provider = $1 AND provider_ref = $2`,
    [r.provider, n.providerRef],
  );
  if (intent) {
    // A notification from one operator's account cannot settle another's payment.
    const foreign = notificationAccountMismatch(intent, r);
    if (foreign) {
      logger.error({ intent: intent.id, integrationId: r.integrationId, reason: foreign }, 'payment notification from an account that did not take this payment; refused');
      // v1.9.0: money reported taken on a refused notification was only logged; the operator is told.
      if (n.paid || n.authorised) {
        bus.emit('alert.raised', {
          orgId: intent.org_id, kind: 'payment.amount_mismatch', severity: 'critical',
          message: `${r.provider} reported payment ${n.providerRef} as ${n.paid ? 'paid' : 'authorised'} from a payment account that did not take it. ` +
            `It was not accepted; check the payment in both accounts' dashboards and refund it there if money was taken.`,
          targetType: 'payment_intent', targetId: intent.id,
        });
      }
      return { outcome: 'wrong_account', orgId: intent.org_id, detail: { reason: foreign } };
    }
    // Money in another currency than asked for is never booked (the amounts cannot even be compared).
    if (n.currency && (n.paid || n.authorised) && n.currency.toUpperCase() !== (intent.currency ?? LEGACY_CURRENCY)) {
      return currencyMismatch(r, intent, n, intent.mode === 'preauth' && n.authorised ? 'hold' : 'payment');
    }
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
          `UPDATE payment_intent SET state = 'captured', amount_captured_minor = COALESCE($2, hold_capture_minor), captured_at = now(), hold_state = 'captured',
                  hold_error = NULL, hold_next_attempt_at = NULL, checkout_url = NULL, updated_at = now(), provider_payment_id = COALESCE($3, provider_payment_id),
                  raw_events = raw_events || $4::jsonb
            WHERE id = $1 AND hold_state <> 'captured' RETURNING id`,
          [intent.id, n.amountMinor, n.paymentId ?? null, JSON.stringify([{ at: new Date(), status: n.status, amountMinor: n.amountMinor }])],
        );
        if (!r2) {
          // Already paid in the app (the driver chose another method instead of the PIN, and the pending charge could
          // not be cancelled): this e-wallet charge is money taken twice, so it is refunded to the e-wallet.
          const cur = await one<{ hold_error: string | null; owed: number | null }>(`SELECT hold_error, hold_capture_minor AS owed FROM payment_intent WHERE id = $1`, [intent.id]);
          if (cur?.hold_error?.includes('paid by the driver in the app')) {
            const { markRefundDue } = await import('../refunds.js');
            await markRefundDue(intent.id, Number(n.amountMinor ?? cur.owed ?? 0), 'Paid twice for the same charging session: the e-wallet charge was confirmed after the session was paid in the app; it is refunded');
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
        // v1.9.0: a hold authorised AFTER PlugSure gave up on it (the start timed out and was marked failed, or the
        // checkout lapsed) still blocks the driver's money. Release it instead of ignoring the notification: the
        // hold sweep (holds.ts) releases anything 'releasing', and the release marks the payment voided.
        if (intent.state === 'failed' || intent.state === 'expired') {
          const late = await one<{ id: string }>(
            `UPDATE payment_intent SET hold_state = 'releasing', hold_attempts = 0, hold_next_attempt_at = now(), authorised_at = now(),
                    provider_payment_id = COALESCE($3, provider_payment_id), raw_events = raw_events || $2::jsonb, updated_at = now()
              WHERE id = $1 AND state IN ('failed', 'expired') AND hold_state IS NULL RETURNING id`,
            [intent.id, JSON.stringify([{ at: new Date(), status: n.status, paymentId: n.paymentId ?? null, late: true }]), n.paymentId ?? null],
          );
          if (late) {
            logger.warn({ intent: intent.id, state: intent.state }, 'card hold authorised after the payment was given up; releasing it');
            return { outcome: 'late_hold_released', orgId: intent.org_id };
          }
        }
        if (intent.state !== 'pending') return { outcome: 'duplicate', orgId: intent.org_id };
        if (n.amountMinor != null && intent.amount_authorised_minor != null && n.amountMinor < intent.amount_authorised_minor) {
          return underpaid(r, intent, n, 'hold');
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
        const event = JSON.stringify([{ at: new Date(), status: n.status, amountMinor: n.amountMinor }]);
        if (n.amountMinor != null && intent.amount_authorised_minor != null && n.amountMinor > intent.amount_authorised_minor) {
          logger.error({ intent: intent.id, captured: n.amountMinor, authorised: intent.amount_authorised_minor }, 'capture confirmation above the hold; not reconciled');
          bus.emit('alert.raised', {
            orgId: intent.org_id, kind: 'payment.amount_mismatch', severity: 'critical',
            message: `${r.provider} confirmed a capture of ${moneyText(Number(n.amountMinor), currencyOr(intent.currency), 'id')} on payment ${n.providerRef}, ` +
              `above its hold of ${moneyText(Number(intent.amount_authorised_minor), currencyOr(intent.currency), 'id')}. Not reconciled: check it in the acquirer's dashboard.`,
            targetType: 'payment_intent', targetId: intent.id,
          });
          await query(`UPDATE payment_intent SET raw_events = raw_events || $2::jsonb WHERE id = $1`, [intent.id, event]);
          return { outcome: 'amount_mismatch', orgId: intent.org_id, detail: { authorised: intent.amount_authorised_minor } };
        }
        const settled = await one<{ id: string; captured: number; authorised: number | null; currency: string }>(
          `UPDATE payment_intent SET state = 'captured', amount_captured_minor = hold_capture_minor, captured_at = COALESCE(captured_at, now()), hold_state = 'captured',
                  hold_error = NULL, hold_next_attempt_at = NULL, released_at = COALESCE(released_at, now()), updated_at = now(),
                  provider_payment_id = COALESCE(provider_payment_id, $3), raw_events = raw_events || $2::jsonb
            WHERE id = $1 AND hold_state IN ('capturing', 'capture_failed') AND hold_capture_minor IS NOT NULL
              AND (amount_authorised_minor IS NULL OR hold_capture_minor <= amount_authorised_minor)
            RETURNING id, hold_capture_minor AS captured, amount_authorised_minor AS authorised, currency`,
          [intent.id, event, n.paymentId ?? null],
        );
        if (settled) {
          logger.warn({ intent: intent.id, capturedMinor: settled.captured }, 'card hold capture confirmed by the acquirer after PlugSure recorded it as not captured; reconciled');
          const { resolveAlertsFor } = await import('../alerts.js');
          for (const kind of ['payment.hold_capture_failed', 'payment.hold_expired']) await resolveAlertsFor(intent.org_id, kind, 'payment_intent', intent.id);
          bus.emit('payment.hold_captured', { orgId: intent.org_id, paymentIntentId: intent.id, capturedMinor: Number(settled.captured), releasedMinor: Number(settled.authorised ?? 0) - Number(settled.captured), currency: settled.currency });
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
    if (intent.state === 'voided') {
      // v1.9.0: voided (an underpaid payment, refund queued) stays voided. Captured here, the refund already queued
      // would be for the short amount only and this second payment would never be paid back. Kept and raised —
      // unless it is the same underpaid notification again (same amount as recorded): then it is a plain duplicate.
      const v = await one<{ amount_captured_minor: number | null }>(`SELECT amount_captured_minor FROM payment_intent WHERE id = $1`, [intent.id]);
      if (n.amountMinor == null || (v?.amount_captured_minor != null && Number(n.amountMinor) === Number(v.amount_captured_minor))) {
        await query(`UPDATE payment_intent SET raw_events = raw_events || $2::jsonb WHERE id = $1`,
          [intent.id, JSON.stringify([{ at: new Date(), status: n.status, amountMinor: n.amountMinor, duplicate: true }])]);
        return { outcome: 'duplicate', orgId: intent.org_id };
      }
      await query(`UPDATE payment_intent SET raw_events = raw_events || $2::jsonb WHERE id = $1`,
        [intent.id, JSON.stringify([{ at: new Date(), status: n.status, amountMinor: n.amountMinor, paidAfterVoid: true }])]);
      logger.error({ intent: intent.id, provider: r.provider, amountMinor: n.amountMinor }, 'payment reported paid after it was voided; not captured');
      bus.emit('alert.raised', {
        orgId: intent.org_id, kind: 'payment.amount_mismatch', severity: 'critical',
        message: `${r.provider} reported payment ${n.providerRef} as paid${n.amountMinor != null ? ` (${moneyText(Number(n.amountMinor), currencyOr(intent.currency), 'id')})` : ''} ` +
          `after it had been voided as underpaid. It was not accepted; money may have been taken twice — check it in the acquirer's dashboard and refund it there.`,
        targetType: 'payment_intent', targetId: intent.id,
      });
      return { outcome: 'paid_after_void', orgId: intent.org_id };
    }
    if (n.amountMinor != null && intent.amount_authorised_minor != null && n.amountMinor < intent.amount_authorised_minor) {
      return underpaid(r, intent, n, 'payment');
    }
    await one(
      `UPDATE payment_intent SET state = 'captured', amount_captured_minor = COALESCE($2, amount_authorised_minor), captured_at = now(), updated_at = now(),
              raw_events = raw_events || $3::jsonb, provider_payment_id = COALESCE(provider_payment_id, $4)
        WHERE id = $1 AND state NOT IN ('captured', 'voided')`,
      [intent.id, n.amountMinor, JSON.stringify([{ at: new Date(), status: n.status, paymentId: n.paymentId ?? null }]), n.paymentId ?? null],
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
  const pass = await one<{ id: string; org_id: string; state: string; integration_id: string | null; total_minor: number; currency: string | null }>(
    `SELECT id, org_id, state, integration_id, total_minor, currency
       FROM subscription_charge WHERE provider_ref = $1 AND (provider = $2 OR provider IS NULL)`, [n.providerRef, r.provider]);
  if (pass) {
    // As for payments: a notification from one operator's account cannot settle (or fail) another's pass.
    const foreignPass = notificationAccountMismatch(pass, r, { requireAccount: false });
    if (foreignPass) return { outcome: 'wrong_account', orgId: pass.org_id, detail: { reason: foreignPass } };
    // A pass paid in another currency than it costs: not activated, never compared (an alert; refund at the acquirer).
    if (n.paid && n.currency && n.currency.toUpperCase() !== (pass.currency ?? LEGACY_CURRENCY)) {
      logger.error({ pass: pass.id, got: n.currency, expected: pass.currency ?? LEGACY_CURRENCY }, 'pass payment in another currency; not accepted');
      bus.emit('alert.raised', {
        orgId: pass.org_id, kind: 'payment.amount_mismatch', severity: 'critical',
        message: `${r.provider} reported 30-day pass payment ${n.providerRef} in ${n.currency}, but the pass costs ${pass.currency ?? LEGACY_CURRENCY}. The pass was not activated; refund it in the acquirer's dashboard.`,
      });
      return { outcome: 'currency_mismatch', orgId: pass.org_id, detail: { expected: pass.currency ?? LEGACY_CURRENCY, got: n.currency } };
    }
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
    if (n.amountMinor != null && n.amountMinor < Number(pass.total_minor)) return passUnderpaid(r, pass, n);
    const { markPassPaid, passPaidAfterVoid } = await import('../../driver/membership.js');
    if (!(await markPassPaid(pass.id))) {
      // Paid after its checkout was replaced or cancelled (void): the money arrived, the pass will not come from it. Kept
      // as a payment owed back in full (Refunds), never silently.
      const owed = await passPaidAfterVoid(pass.id, { provider: r.provider, integrationId: r.integrationId }, { amountMinor: n.amountMinor, paymentId: n.paymentId ?? null, status: n.status });
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
export async function sandboxCheckout(ref: string): Promise<{ amountMinor: number; currency: CurrencyCode; channel: string; state: string; purpose: string; hold?: boolean; save?: boolean } | null> {
  if (!/^mock_[a-z]+_[0-9a-f-]{8,40}$/.test(ref)) return null;
  return outsideRequestScope(async () => {
    const pi = await one<{ amount_authorised_minor: number; channel: string | null; state: string; mode: string; save_card: boolean; currency: string; roaming_charge_id: string | null }>(`SELECT amount_authorised_minor, channel, state, mode, save_card, currency, roaming_charge_id FROM payment_intent WHERE provider = 'mock' AND provider_ref = $1`, [ref]);
    if (pi) return { amountMinor: pi.amount_authorised_minor, currency: currencyOr(pi.currency), channel: pi.channel ?? 'QRIS', state: pi.state, purpose: pi.mode === 'reservation' ? 'Reservation fee' : pi.roaming_charge_id ? 'Partner network charging (hold)' : 'Charging', hold: pi.mode === 'preauth', save: pi.save_card };
    const sc = await one<{ total_minor: number; channel: string | null; state: string; currency: string }>(`SELECT total_minor, channel, state, currency FROM subscription_charge WHERE provider = 'mock' AND provider_ref = $1`, [ref]);
    return sc ? { amountMinor: sc.total_minor, currency: currencyOr(sc.currency), channel: sc.channel ?? 'QRIS', state: sc.state === 'paid' ? 'captured' : sc.state, purpose: '30-day pass' } : null;
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
      providerRef: ref, paid: paid && !hold, authorised: hold, status: !paid ? 'cancel' : hold ? 'authorize' : 'settlement', amountMinor: null, paymentId: `sandbox-${ref}`,
      ...(save ? { savedCard: { token: `mock_tok_${randomUUID().replace(/-/g, '').slice(0, 16)}`, brand: 'VISA', last4: '1111', expMonth: 12, expYear: new Date().getFullYear() + 4 } } : {}),
    });
  });
  return out.outcome;
}