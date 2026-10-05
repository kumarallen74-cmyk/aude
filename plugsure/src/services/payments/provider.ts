import { logger } from '../../logger.js';
import type { CurrencyCode } from '../../domain/money.js';
import { COUNTRIES } from '../../domain/country.js';
import { guardedFetch, type GuardedResponse } from '../net-guard.js';

/**
 * Payment provider abstraction.
 *
 * The tiered model this interface exists to serve:
 *
 *   Tier 1  registered driver   e-wallet TOKENISATION  — link once, charge the exact
 *                               final amount server-side after the session. No hold,
 *                               no float, no e-money licence. The primary path.
 *   Tier 2  premium / fleet     card PRE-AUTH then capture (7-day hold, capture <= auth).
 *   Tier 3  walk-up guest       QRIS PRE-PURCHASE. QRIS has no pre-authorisation and
 *                               never will — so invert the problem: the driver buys a
 *                               fixed rupiah amount and the charger delivers exactly
 *                               that much energy. This is what PLN already does at
 *                               SPKLU, so it matches driver expectations.
 *   Tier 4  B2B fleet           postpaid against a fixed virtual account.
 *
 * Two things this interface deliberately does NOT support:
 *   - a stored-balance driver wallet (open-loop e-money licensing exposure that the
 *     multi-tenant model makes worse — legal advice required before it is built)
 *   - charge-max-then-refund on QRIS (bad UX that only postpones the same problem)
 */

export type PaymentMethod = 'qris' | 'ewallet_token' | 'card' | 'va';
export type PaymentMode = 'prepurchase' | 'tokenized' | 'preauth' | 'postpaid';

export interface CreateQrisChargeArgs {
  referenceId: string;
  amountMinor: number;
  /** The payment's currency (absent = IDR). An adapter refuses a currency its account does not take. */
  currency?: CurrencyCode;
  expiresInS?: number;
  description?: string;
}

export interface QrisCharge {
  providerRef: string;
  /** EMVCo payload string to render as a QR at the charger or in the browser. */
  qrString: string;
  amountMinor: number;
  expiresAt: string;
  status: 'pending' | 'paid' | 'expired' | 'failed';
}

export interface TokenizedChargeArgs {
  referenceId: string;
  /** Payment method id returned when the driver linked their wallet, once, at signup. */
  paymentMethodId: string;
  amountMinor: number;
  description?: string;
}

export interface PreauthArgs {
  referenceId: string;
  cardTokenId: string;
  /** Conservative worst-case amount. Capture may be lower, never higher. */
  amountMinor: number;
}

export interface CaptureArgs {
  providerRef: string;
  amountMinor: number;
}

export interface PaymentResult {
  providerRef: string;
  status: 'pending' | 'authorised' | 'captured' | 'failed' | 'expired';
  amountMinor: number;
  raw?: unknown;
}

/**
 * How a driver pays. QRIS: a QR code any bank or e-wallet app scans. The
 * e-wallets: their own app (deeplink / redirect), or — OVO — a push to the
 * driver's OVO app for their phone number. CARD: the acquirer's hosted card
 * page with 3-D Secure; card numbers never reach PlugSure.
 */
export type Channel = 'QRIS' | 'GOPAY' | 'SHOPEEPAY' | 'OVO' | 'DANA' | 'LINKAJA' | 'CARD' | 'PAYNOW' | 'FPX' | 'GRABPAY';
export const CHANNELS: Channel[] = ['QRIS', 'GOPAY', 'SHOPEEPAY', 'OVO', 'DANA', 'LINKAJA', 'CARD', 'PAYNOW', 'FPX', 'GRABPAY'];
/**
 * Channels reserved for phase 2 (docs/MULTI-COUNTRY-DESIGN.md §D6): DuitNow QR, Touch 'n Go, Boost (MY), NETS (SG).
 * Not offered by any adapter yet; named here so nothing else claims the codes.
 */
export const RESERVED_CHANNELS = ['DUITNOW', 'TNG', 'BOOST', 'NETS'] as const;
export const CHANNEL_LABEL: Record<Channel, string> = {
  QRIS: 'QRIS', GOPAY: 'GoPay', SHOPEEPAY: 'ShopeePay', OVO: 'OVO', DANA: 'DANA', LINKAJA: 'LinkAja', CARD: 'Kartu kredit / debit',
  PAYNOW: 'PayNow', FPX: 'FPX online banking', GRABPAY: 'GrabPay',
};
/**
 * The currencies a channel can take. CARD: any (the account's own). The Indonesian rails are rupiah only; PayNow is
 * Singapore dollars, FPX ringgit, GrabPay either (each through the account of its country).
 */
const RUPIAH = [COUNTRIES.ID.currency] as const;
export const CHANNEL_CURRENCIES: Record<Channel, readonly CurrencyCode[] | 'any'> = {
  QRIS: RUPIAH, GOPAY: RUPIAH, SHOPEEPAY: RUPIAH, OVO: RUPIAH, DANA: RUPIAH, LINKAJA: RUPIAH, CARD: 'any',
  PAYNOW: [COUNTRIES.SG.currency], FPX: [COUNTRIES.MY.currency], GRABPAY: [COUNTRIES.MY.currency, COUNTRIES.SG.currency],
};
export const channelTakes = (c: Channel, cur: CurrencyCode): boolean => {
  const t = CHANNEL_CURRENCIES[c];
  return t === 'any' || (t ?? []).includes(cur);
};
/**
 * The payment_intent.method (and subscription_charge.via) of a channel: 'qris' (QRIS only: the Indonesian MDR rules key on
 * it), 'qr' (another bank QR scheme: PayNow), 'bank' (online banking redirect: FPX), 'ewallet', 'card'.
 */
export type MethodKind = 'qris' | 'qr' | 'bank' | 'ewallet' | 'card';
export const methodOf = (c: Channel): MethodKind =>
  c === 'QRIS' ? 'qris' : c === 'CARD' ? 'card' : c === 'PAYNOW' ? 'qr' : c === 'FPX' ? 'bank' : 'ewallet';

export interface CheckoutArgs {
  referenceId: string;
  amountMinor: number;
  channel: Exclude<Channel, 'QRIS'>;
  /** Where the acquirer sends the driver back after paying (the app's return page). */
  returnUrl: string;
  description?: string;
  expiresInS?: number;
  /** E.164; OVO charges are pushed to this number's OVO app. */
  customerPhone?: string;
  /** CARD: authorise only (a hold); the amount is captured later, up to this. */
  preauth?: boolean;
  /** CARD: the acquirer keeps the card and returns a token (in the notification) for later payments. */
  saveCard?: boolean;
  /** The acquirer's customer reference (PlugSure's driver id; nothing personal). Needed to save a card. */
  customerId?: string;
  /** The payment's currency (absent = IDR). An adapter refuses a currency its account does not take. */
  currency?: CurrencyCode;
}

/** A saved card as the acquirer reports it: its token and what may be shown. Never the card number. */
export interface SavedCardInfo {
  token: string;
  brand: string | null;
  last4: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  tokenExpiresAt?: string | null;
}

export interface SavedCardChargeArgs {
  referenceId: string;
  amountMinor: number;
  /** The acquirer's token for the card. */
  token: string;
  preauth: boolean;
  returnUrl: string;
  customerId: string;
  description?: string;
  /** The payment's currency (absent = IDR). */
  currency?: CurrencyCode;
}

export interface SavedCardCharge {
  providerRef: string;
  providerPaymentId?: string;
  /** authorised / captured: done, no driver action; pending: 3-D Secure at checkoutUrl; failed: declined. */
  status: 'authorised' | 'captured' | 'pending' | 'failed';
  checkoutUrl: string | null;
  expiresAt: string;
  message?: string;
  /** Failed because the e-wallet link, or the saved card's token, has ended at the acquirer (unlinked, deleted or expired): link or save again. */
  linkEnded?: boolean;
}

/**
 * The linked e-wallet's link was ended at the acquirer: the driver unlinked it in
 * the e-wallet app, or it expired. Nothing can be charged to it; link again.
 */
export class WalletLinkEnded extends Error {
  constructor(public readonly acquirerStatus: string) { super(`the e-wallet link is ${acquirerStatus.toLowerCase()} at the acquirer`); }
}

export interface HoldArgs {
  providerRef: string;
  providerPaymentId?: string | null;
  amountMinor: number;
  idempotencyKey: string;
}

export interface HoldResult {
  ok: boolean;
  /** The acquirer's message when not ok (kept for the retry and the console). */
  error?: string;
  /** The authorisation expired at the acquirer: nothing can be captured, and nothing is held any more. */
  expired?: boolean;
  raw?: unknown;
}

export interface Checkout {
  providerRef: string;
  /**
   * 'redirect': open checkoutUrl (the e-wallet app or the card page); 'push': the driver approves in their app;
   * 'qr': show qrString (a bank QR scheme other than QRIS, e.g. PayNow), scanned with the driver's banking app.
   */
  action: 'redirect' | 'push' | 'qr';
  checkoutUrl: string | null;
  /** action 'qr': the EMVCo payload to render. */
  qrString?: string | null;
  expiresAt: string;
  providerPaymentId?: string;
}

export interface RefundArgs {
  /** The acquirer's own id of the payment, for refund APIs that need it. */
  providerPaymentId?: string | null;
  channel?: string | null;
  providerRef: string;
  amountMinor: number;
  reason: string;
  /** Stable per refund, so a retried call cannot pay the driver twice. */
  idempotencyKey: string;
}

export interface RefundResult {
  status: 'refunded' | 'pending' | 'failed';
  refundRef: string;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  /**
   * The sandbox only: its notifications carry no amount (no real money moves). Every real
   * acquirer's paid or authorised notification MUST state the amount, or it is not recorded
   * (registry.handleNotification). A new provider is held to that unless it opts out here.
   */
  readonly unverifiedAmounts?: boolean;
  /**
   * The currencies this account can take (docs/MULTI-COUNTRY-DESIGN.md §D6). Absent =
   * ['IDR'] (Midtrans, Xendit and SNAP QRIS are Indonesian rails). A payment in any
   * other currency is refused before the provider is called (PaymentsUnavailable).
   */
  currencies?(): CurrencyCode[];
  createQrisCharge(a: CreateQrisChargeArgs): Promise<QrisCharge>;
  chargeTokenized(a: TokenizedChargeArgs): Promise<PaymentResult>;
  authorizeCard(a: PreauthArgs): Promise<PaymentResult>;
  captureCard(a: CaptureArgs): Promise<PaymentResult>;
  /**
   * Pay money back to the original payer. Optional: not every QRIS acquirer
   * exposes a refund API. Without it, refunds are made by bank transfer and
   * recorded manually with the transfer reference (see services/refunds.ts).
   */
  refund?(a: RefundArgs): Promise<RefundResult>;
  /**
   * Verify a webhook signature. NON-NEGOTIABLE on every Indonesian rail — never
   * trust an unsigned JSON payload, and pair this with idempotency keys because
   * replayed events are routine.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
  /**
   * A payment notification, verified: null when the signature (or token) does
   * not check out or the body is not a payment notification. `path` is the
   * path the provider called (SNAP signs it).
   */
  parseNotification?(rawBody: string, headers: Record<string, string | string[] | undefined>, path: string): PaymentNotification | null;
  /**
   * A linked e-wallet's status change the acquirer notifies (activated, ended, linking failed), verified like a payment
   * notification: null when it does not check out or is not such an event. linkRef is the link's id at the acquirer.
   */
  parseLinkEvent?(rawBody: string, headers: Record<string, string | string[] | undefined>): { linkRef: string; status: 'active' | 'ended' | 'failed'; event: string } | null;
  /** The body and status to answer a notification with (some providers expect a specific reply). */
  notificationAck?(ok: boolean): { status: number; body: unknown };
  /** Check the credentials against the provider without moving money. */
  testConnection?(): Promise<{ ok: boolean; message: string }>;
  /** A test double: payments are confirmed with the demo button. */
  readonly demo?: boolean;
  /** The payment channels this acquirer offers (the operator chooses which to enable). */
  channels?(): Channel[];
  /** An e-wallet or card payment: the driver completes it in the e-wallet app or on the hosted card page. */
  createCheckout?(a: CheckoutArgs): Promise<Checkout>;
  /** Whether refund() can pay back a payment made through this channel (otherwise: bank transfer). */
  canRefund?(channel: string | null): boolean;
  /** Card holds and saved cards: what this acquirer adapter supports. */
  cardFeatures?(): { holds: boolean; savedCards: boolean };
  /**
   * The smallest (and, where the rail has one, largest) amount this acquirer takes through a channel, in PlugSure
   * minor units of the currency. A payment outside it is refused before the acquirer is asked (registry.startPayment).
   */
  amountLimits?(channel: Channel, currency: CurrencyCode): { minMinor: number; maxMinor?: number };
  /** Pay with a saved card (its token), as a hold or a sale. May need 3-D Secure (checkoutUrl). */
  chargeSavedCard?(a: SavedCardChargeArgs): Promise<SavedCardCharge>;
  /** Capture a hold, up to the authorised amount; the rest is released. */
  captureHold?(a: HoldArgs): Promise<HoldResult>;
  /** Release a hold entirely (nothing is taken). */
  releaseHold?(a: Omit<HoldArgs, 'amountMinor'>): Promise<HoldResult>;
  /** Forget a saved card at the acquirer, where it offers that. */
  deleteSavedCard?(token: string, customerId: string): Promise<void>;
  /** The e-wallets this acquirer can link for one-tap payments. */
  linkableWallets?(): Channel[];
  /** Start linking an e-wallet: the driver approves in the e-wallet app (activationUrl). */
  linkWallet?(a: WalletLinkArgs): Promise<WalletLink>;
  /** Where a link stands (polled after the driver comes back). */
  walletStatus?(linkRef: string, channel: Channel): Promise<WalletLinkStatus>;
  /** Charge a linked e-wallet: usually at once; some need the e-wallet PIN (checkoutUrl). */
  chargeWallet?(a: WalletChargeArgs): Promise<SavedCardCharge>;
  /** Unlink at the acquirer. */
  unlinkWallet?(linkRef: string, channel: Channel): Promise<void>;
  /** The linked e-wallet's balance, where the acquirer reports it (null: unknown). Throws WalletLinkEnded when the link has ended. */
  walletBalance?(token: string, channel: Channel): Promise<number | null>;
}

export interface WalletLinkArgs {
  channel: Channel;
  /** The acquirer's customer reference (PlugSure's driver id). */
  customerId: string;
  /** E.164, the e-wallet account's phone number. */
  phone: string;
  returnUrl: string;
}

export interface WalletLink {
  linkRef: string;
  status: 'pending' | 'active' | 'failed';
  activationUrl: string | null;
  /** Once active: the token to charge with (opaque; sealed by the caller). */
  token?: string;
}

export interface WalletLinkStatus {
  status: 'pending' | 'active' | 'failed';
  token?: string;
  message?: string;
}

export interface WalletChargeArgs {
  referenceId: string;
  amountMinor: number;
  channel: Channel;
  token: string;
  returnUrl: string;
  customerId: string;
  description?: string;
}

/** A phone number as the e-wallet account shows it to its owner: ••••7890. */
export const maskAccount = (phone: string | null | undefined): string | null => {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length >= 4 ? `••••${d.slice(-4)}` : null;
};

export interface PaymentNotification {
  /** The reference PlugSure stored on the payment (payment_intent.provider_ref). */
  providerRef: string;
  paid: boolean;
  /** The provider's status word, for the log. */
  status: string;
  amountMinor: number | null;
  /** The provider's own id of the payment (needed by some refund APIs). */
  paymentId?: string;
  /** A card hold was authorised (the money is reserved, not yet taken). */
  authorised?: boolean;
  /**
   * The currency the acquirer reports for the payment (ISO 4217, upper case). Absent: the account's only currency (the
   * Indonesian rails). A notification in another currency than the payment's is never booked (registry.applyNotification).
   */
  currency?: string;
  /** The card was saved at the acquirer (the driver asked): its token. */
  savedCard?: SavedCardInfo;
}

/** Card brand from the first digits of a masked card number (e.g. "481111-1114"). */
export function cardBrand(masked: string | null | undefined): string | null {
  const d = String(masked ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('4')) return 'VISA';
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'MASTERCARD';
  if (/^3[47]/.test(d)) return 'AMEX';
  if (/^35/.test(d)) return 'JCB';
  if (/^(60|65|62)/.test(d)) return 'GPN';
  return null;
}
export const last4Of = (masked: string | null | undefined): string | null => {
  const d = String(masked ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
};

/**
 * A call to a payment / OTP / PKI provider — at an operator-configurable base
 * URL, so it goes through the SSRF guard (net-guard.ts guardedFetch): the
 * resolved address is checked when connecting (no private, loopback,
 * link-local or metadata addresses outside development/test), redirects are
 * NOT followed (a 3xx comes back as the status), `timeoutMs` (default 15 s) is
 * a total deadline, and the answer is capped at 2 MB.
 *
 * The raw answer is never handed back for display: callers build operator-facing
 * messages from the parsed JSON (`body`) and the status. `text` is kept for
 * compatibility but holds only a placeholder; the real body of a failed call
 * is logged server-side. (Echoing it made a URL pointed at an internal service
 * a way to read that service.)
 */
export async function providerFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: any; text: string }> {
  let host = '?';
  try { host = new URL(url).host; } catch { /* reported by guardedFetch */ }
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  const b = init.body;
  if (b != null && typeof b !== 'string' && !(b instanceof URLSearchParams) && !Buffer.isBuffer(b)) throw new Error('providerFetch: unsupported request body');
  if (b instanceof URLSearchParams && !headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  let res: GuardedResponse;
  try {
    res = await guardedFetch(url, {
      method: init.method ?? 'GET', headers, body: b == null ? undefined : b instanceof URLSearchParams ? b.toString() : b,
      timeoutMs: init.timeoutMs ?? 15_000, maxBytes: 2 * 1024 * 1024, signal: init.signal ?? undefined,
    });
  } catch (e) {
    throw new Error(`cannot reach ${host}: ${(e as Error).message}`);
  }
  let body: any = null;
  try { body = res.text ? JSON.parse(res.text) : null; } catch { body = null; }
  if (res.status >= 300) logger.warn({ host, status: res.status, body: res.text.slice(0, 2000) }, 'provider answered with an error');
  return { status: res.status, body, text: `(answer not shown: HTTP ${res.status})` };
}

/**
 * Merchant discount rate estimator.
 *
 * From 1 October 2026 Bank Indonesia extends 0% MDR to ALL merchant categories
 * for transactions <= Rp 100,000. At ~Rp 2,466/kWh a 40 kWh session is ~Rp 99,000,
 * so a large share of Indonesian charging volume lands in the free band.
 *
 * Price the QRIS pre-purchase tiers at or below Rp 100,000 deliberately.
 *
 * Note: surcharging is prohibited — MDR may not be passed to the consumer as a
 * line item. Build it into the kWh tariff instead.
 */
export function estimateQrisMdrIdr(
  amountMinor: number,
  opts: { category?: 'UMI' | 'UKE' | 'UME' | 'UBE' | 'SPBU'; onOrAfterOct2026?: boolean } = {},
): number {
  const category = opts.category ?? 'UKE';
  const zeroBandActive = opts.onOrAfterOct2026 ?? new Date() >= new Date('2026-10-01T00:00:00+07:00');

  if (category === 'UMI') {
    return amountMinor <= 500_000 ? 0 : Math.round(amountMinor * 0.003);
  }
  if (zeroBandActive && amountMinor <= 100_000) return 0;

  // VERIFY with the PJP whether EV charging is assigned the SPBU category (0.4%)
  // or standard (0.7%). Globally EV charging has its own MCC 5552. The 0.3%
  // delta is material at scale.
  const rate = category === 'SPBU' ? 0.004 : 0.007;
  return Math.round(amountMinor * rate);
}

/** Per-transaction QRIS ceiling, PADG 3/2025. Not Rp 20M — that figure is from a superseded 2022 announcement. */
export const QRIS_MAX_TRANSACTION_IDR = 10_000_000;

/** The currencies a provider takes (absent: IDR only). */
export const currenciesOf = (p: Pick<PaymentProvider, 'currencies'>): CurrencyCode[] => p.currencies?.() ?? ['IDR'];
