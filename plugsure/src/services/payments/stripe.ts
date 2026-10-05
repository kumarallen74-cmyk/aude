import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fromProviderAmount, isCurrency, toProviderAmount, type CurrencyCode } from '../../domain/money.js';
import {
  providerFetch,
  type CaptureArgs, type Channel, type Checkout, type CheckoutArgs, type CreateQrisChargeArgs, type HoldArgs, type HoldResult,
  type PaymentNotification, type PaymentProvider, type PaymentResult, type PreauthArgs, type QrisCharge, type RefundArgs,
  type RefundResult, type SavedCardCharge, type SavedCardChargeArgs, type SavedCardInfo, type TokenizedChargeArgs,
} from './provider.js';
import type { PaymentStatus, RefundStatusArgs } from './registry.js';

/**
 * Stripe — cards (holds, saved cards), PayNow (SG), FPX (MY) and GrabPay (MY, SG), for the Malaysian and Singapore
 * operators (docs/MULTI-COUNTRY-DESIGN.md §D6, WP3). One integration row = one Stripe account = one country and one
 * currency (Stripe MY takes MYR, Stripe SG takes SGD); FPX exists only on MY accounts and PayNow only on SG accounts.
 * Stripe's REST API is called directly through providerFetch (the SSRF guard), form-encoded, with the API version pinned
 * (Stripe-Version) and an Idempotency-Key on every POST. No SDK: the dozen calls below do not justify a dependency, and
 * providerFetch keeps the egress rules every other acquirer follows. Docs: deploy/STRIPE.md.
 *
 *   method   PlugSure mode   Stripe
 *   CARD     preauth         PaymentIntent capture_method=manual, payment_method_types[card]; the driver confirms it on
 *            (hold)          PlugSure's Payment Element page (/pay/stripe/<ref>/<pi>: no e-mail, phone or name asked,
 *                            the SG guest rule); payment_intent.amount_capturable_updated = authorised;
 *                            POST /v1/payment_intents/:id/capture {amount_to_capture} (the rest is released);
 *                            POST /v1/payment_intents/:id/cancel releases it all.
 *   CARD     prepurchase     the same PaymentIntent with capture_method=automatic (holds off, or a pass).
 *   CARD     saved card      a Customer per saved card (metadata: PlugSure's driver id only), setup_future_usage=
 *                            off_session; the token PlugSure keeps (sealed) is "<customer>/<payment_method>". Paying with
 *                            it: PaymentIntent {customer, payment_method, confirm, return_url} — 3-D Secure, when the
 *                            bank asks, is next_action.redirect_to_url (the driver is sent there).
 *   PAYNOW   prepurchase     PaymentIntent confirmed server-side with payment_method_data[type]=paynow: the SGQR payload
 *                            (next_action.paynow_display_qr_code.data) is shown like a QRIS code; valid 1 hour.
 *   GRABPAY  prepurchase     confirmed server-side with payment_method_data[type]=grabpay and return_url:
 *                            next_action.redirect_to_url.url opens GrabPay.
 *   FPX      prepurchase     PaymentIntent payment_method_types[fpx], confirmed on the Payment Element page (the bank
 *                            list, FPX's terms and logo are Stripe's); RM 2 – RM 30,000.
 *   refunds  POST /v1/refunds {payment_intent, amount} — asynchronous for PayNow/GrabPay (refund.updated).
 *
 *   references   PlugSure's reference → orderRef (ps_<sha256>), stored as metadata.plugsure_ref on the PaymentIntent and
 *                derived before Stripe is asked; the PaymentIntent is created with Idempotency-Key "pi-<ref>", so a
 *                request repeated after a lost answer gets the same PaymentIntent back.
 *   webhooks     Stripe-Signature "t=…,v1=…[,v1=…]": HMAC-SHA256 over "<t>.<raw body>" with the endpoint's signing
 *                secret (whsec_…; two may be configured while one is rolled), constant-time compare, 300 s tolerance,
 *                and livemode must match the key's mode. Events are de-duplicated by event id (registry,
 *                payment_webhook_event); every verified event is answered 2xx, handled or not.
 *   test / live  sk_test_/rk_test_ keys are refused outside development/test unless the integration says
 *                allowTestMode (a staging deployment running with NODE_ENV=production).
 */

export const STRIPE_API_VERSION = '2026-09-30.endive';
/** Stripe's minimum charge per settlement currency (docs.stripe.com/currencies#minimum-and-maximum-charge-amounts), in minor units. */
export const STRIPE_MIN_CHARGE_MINOR: Partial<Record<CurrencyCode, number>> = { MYR: 200, SGD: 50 };
/** FPX: RM 2.00 – RM 30,000.00 per transaction (docs.stripe.com/payments/fpx/accept-a-payment). */
export const FPX_LIMITS_MINOR = { min: 200, max: 3_000_000 } as const;
/** Signed-timestamp tolerance, as Stripe's own libraries (5 minutes). */
export const STRIPE_SIGNATURE_TOLERANCE_S = 300;

export type StripeCountry = 'MY' | 'SG';

export interface StripeConfig {
  secretKey: string;
  /** One signing secret, or two separated by whitespace or a comma while the endpoint's secret is being rolled. */
  webhookSecret: string;
  publishableKey?: string;
  country: StripeCountry;
  baseUrl?: string;
  apiVersion?: string;
  /** Outside development/test (production = true), test-mode keys are refused unless this is set. */
  production?: boolean;
  allowTestMode?: boolean;
  /** PlugSure's public URL: Stripe needs absolute return URLs; the checkout page link is made absolute with it. */
  publicBaseUrl?: string;
}

export class StripeModeRefused extends Error {}

export type KeyMode = 'test' | 'live';
/** The mode of a Stripe key from its prefix (sk_/rk_/pk_ + test_/live_); null: not a Stripe key. */
export function keyMode(key: string | null | undefined): KeyMode | null {
  const m = /^(sk|rk|pk)_(test|live)_[A-Za-z0-9]/.exec(String(key ?? ''));
  return m ? (m[2] as KeyMode) : null;
}

/** Stripe's form encoding: nested objects as a[b][c]=v, arrays as a[0]=v. Undefined and null are left out. */
export function stripeForm(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(`${prefix}[${i}]`, x)); return; }
    if (typeof v === 'object') { for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}[${k}]` : k, x); return; }
    out.append(prefix, String(v));
  };
  walk('', params);
  return out;
}

const header = (h: Record<string, string | string[] | undefined>, name: string): string => {
  const v = h[name] ?? h[name.toLowerCase()] ?? Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(v) ? v.join(',') : String(v ?? '');
};

/** The parts of a Stripe-Signature header: the timestamp and every v1 signature (other schemes ignored: no downgrade). */
export function parseStripeSignature(h: string): { t: number | null; v1: string[] } {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of h.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  return { t, v1 };
}

/** Sign a payload as Stripe does (tests and the local fake). */
export function stripeSignatureHeader(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex')}`;
}

const REFUND_EVENTS = new Set(['refund.created', 'refund.updated', 'refund.failed', 'charge.refund.updated']);

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  constructor(private cfg: StripeConfig) {}

  private base() { return (this.cfg.baseUrl || 'https://api.stripe.com').replace(/\/+$/, ''); }
  private cur(): CurrencyCode { return this.cfg.country === 'MY' ? 'MYR' : 'SGD'; }
  currencies(): CurrencyCode[] { return [this.cur()]; }
  get country(): StripeCountry { return this.cfg.country; }
  get publishableKey(): string { return this.cfg.publishableKey ?? ''; }
  get mode(): KeyMode | null { return keyMode(this.cfg.secretKey); }

  /** Refuse to move money with a key of the wrong mode (or no Stripe key at all). */
  assertMode(): void {
    const m = this.mode;
    if (!m) throw new StripeModeRefused('The Stripe secret key is not a Stripe key (sk_live_…, rk_live_…, sk_test_… or rk_test_…).');
    if (m === 'test' && this.cfg.production && !this.cfg.allowTestMode) {
      throw new StripeModeRefused('A Stripe TEST key is configured on a production deployment. Use the live key, or allow test mode on this integration (staging only).');
    }
  }

  /** The currency of a payment: the account's own; any other is refused (no FX, ever). */
  private currencyFor(c: CurrencyCode | undefined): CurrencyCode {
    const mine = this.cur();
    if (c && c !== mine) throw new Error(`This Stripe account (${this.cfg.country}) takes ${mine}, not ${c}.`);
    return mine;
  }

  private abs(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    const b = (this.cfg.publicBaseUrl ?? '').replace(/\/+$/, '');
    return b ? `${b}${url.startsWith('/') ? '' : '/'}${url}` : url;
  }

  private headers(idem?: string): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.secretKey}`,
      'stripe-version': this.cfg.apiVersion || STRIPE_API_VERSION,
      ...(idem ? { 'idempotency-key': idem } : {}),
    };
  }

  private async post(path: string, params: Record<string, unknown>, idem: string) {
    this.assertMode();
    return providerFetch(`${this.base()}${path}`, { method: 'POST', headers: this.headers(idem), body: stripeForm(params) });
  }

  private async get(path: string, query?: Record<string, unknown>) {
    this.assertMode();
    const q = query ? `?${stripeForm(query).toString()}` : '';
    return providerFetch(`${this.base()}${path}${q}`, { headers: this.headers() });
  }

  private static err(r: { status: number; body: any }): string {
    const e = r.body?.error ?? {};
    return `${r.status} ${e.code ?? e.type ?? ''}${e.decline_code ? `/${e.decline_code}` : ''} ${e.message ?? ''}`.trim();
  }

  /** PlugSure's reference → the reference kept on the PaymentIntent (metadata.plugsure_ref): known before Stripe is asked. */
  orderRef(referenceId: string): string { return `ps_${createHash('sha256').update(referenceId, 'utf8').digest('hex').slice(0, 32)}`; }

  channels(): Channel[] { return this.cfg.country === 'SG' ? ['CARD', 'PAYNOW', 'GRABPAY'] : ['CARD', 'FPX', 'GRABPAY']; }
  canRefund(_channel: string | null): boolean { return true; }
  cardFeatures() { return { holds: true, savedCards: true }; }

  amountLimits(channel: Channel, currency: CurrencyCode): { minMinor: number; maxMinor?: number } {
    const min = STRIPE_MIN_CHARGE_MINOR[currency] ?? 1;
    // FPX's own band; GrabPay has no minimum ("can be as low as 1"); every other method Stripe's minimum charge.
    if (channel === 'FPX') return { minMinor: Math.max(min, FPX_LIMITS_MINOR.min), maxMinor: FPX_LIMITS_MINOR.max };
    if (channel === 'GRABPAY') return { minMinor: 1, maxMinor: 99_999_999 };
    return { minMinor: min, ...(channel === 'PAYNOW' ? { maxMinor: 99_999_999 } : {}) };
  }

  /** Where the driver confirms a card or FPX payment: PlugSure's Payment Element page for this PaymentIntent. */
  pagePath(providerRef: string, paymentIntentId: string): string { return `/pay/stripe/${encodeURIComponent(providerRef)}/${encodeURIComponent(paymentIntentId)}`; }

  private metadata(ref: string, referenceId: string, returnUrl?: string) {
    return { plugsure_ref: ref, plugsure_reference: referenceId.slice(0, 450), ...(returnUrl ? { plugsure_return: this.abs(returnUrl).slice(0, 500) } : {}) };
  }

  private async createIntent(ref: string, params: Record<string, unknown>, what: string): Promise<any> {
    const r = await this.post('/v1/payment_intents', params, `pi-${ref}`);
    const j = r.body ?? {};
    if (r.status >= 300 || !j.id) throw new Error(`Stripe ${what} failed: ${StripeProvider.err(r)}`);
    return j;
  }

  /** A Customer for a card the driver asked to save (PlugSure's driver id in metadata; nothing personal). */
  private async customerFor(appDriverId: string, ref: string): Promise<string> {
    const r = await this.post('/v1/customers', { description: 'PlugSure driver', metadata: { plugsure_driver: appDriverId } }, `cus-${ref}`);
    if (r.status >= 300 || !r.body?.id) throw new Error(`Stripe customer failed: ${StripeProvider.err(r)}`);
    return String(r.body.id);
  }

  async createCheckout(a: CheckoutArgs): Promise<Checkout> {
    const currency = this.currencyFor(a.currency);
    if (!this.channels().includes(a.channel)) throw new Error(`Stripe ${this.cfg.country} does not offer ${a.channel}`);
    const ref = this.orderRef(a.referenceId);
    const amount = toProviderAmount(a.amountMinor, currency, 'minor');
    const base = {
      amount, currency: currency.toLowerCase(), metadata: this.metadata(ref, a.referenceId, a.returnUrl),
      ...(a.description ? { description: a.description.slice(0, 500) } : {}),
    };
    const fallbackExpiry = new Date(Date.now() + (a.expiresInS ?? 1800) * 1000).toISOString();
    if (a.channel === 'PAYNOW') {
      const pi = await this.createIntent(ref, { ...base, payment_method_types: ['paynow'], payment_method_data: { type: 'paynow' }, confirm: true }, 'PayNow payment');
      const qr = pi.next_action?.paynow_display_qr_code;
      if (!qr?.data) throw new Error(`Stripe PayNow payment ${pi.id} has no QR code (status ${pi.status})`);
      return {
        providerRef: ref, action: 'qr', qrString: String(qr.data), checkoutUrl: qr.hosted_instructions_url ?? null,
        expiresAt: qr.expires_at ? new Date(Number(qr.expires_at) * 1000).toISOString() : new Date(Date.now() + 3600_000).toISOString(), providerPaymentId: pi.id,
      };
    }
    if (a.channel === 'GRABPAY') {
      const pi = await this.createIntent(ref, { ...base, payment_method_types: ['grabpay'], payment_method_data: { type: 'grabpay' }, confirm: true, return_url: this.abs(a.returnUrl) }, 'GrabPay payment');
      const url = pi.next_action?.redirect_to_url?.url;
      if (!url) throw new Error(`Stripe GrabPay payment ${pi.id} has no redirect (status ${pi.status})`);
      return { providerRef: ref, action: 'redirect', checkoutUrl: String(url), expiresAt: fallbackExpiry, providerPaymentId: pi.id };
    }
    if (a.channel === 'FPX') {
      const pi = await this.createIntent(ref, { ...base, payment_method_types: ['fpx'] }, 'FPX payment');
      return { providerRef: ref, action: 'redirect', checkoutUrl: this.abs(this.pagePath(ref, pi.id)), expiresAt: fallbackExpiry, providerPaymentId: pi.id };
    }
    // CARD: a hold (manual capture) or a sale, optionally saving the card for the signed-in driver.
    const save = a.saveCard === true && !!a.customerId;
    const customer = save ? await this.customerFor(a.customerId!, ref) : null;
    const pi = await this.createIntent(ref, {
      ...base, payment_method_types: ['card'], capture_method: a.preauth ? 'manual' : 'automatic',
      ...(customer ? { customer, setup_future_usage: 'off_session' } : {}),
    }, a.preauth ? 'card hold' : 'card payment');
    return { providerRef: ref, action: 'redirect', checkoutUrl: this.abs(this.pagePath(ref, pi.id)), expiresAt: fallbackExpiry, providerPaymentId: pi.id };
  }

  /** "<customer>/<payment_method>" — the saved card's token as PlugSure keeps it (sealed). */
  static splitToken(token: string): { customer: string; paymentMethod: string } | null {
    const m = /^(cus_[A-Za-z0-9]+)\/(pm_[A-Za-z0-9]+|card_[A-Za-z0-9]+)$/.exec(token);
    return m ? { customer: m[1]!, paymentMethod: m[2]! } : null;
  }

  async chargeSavedCard(a: SavedCardChargeArgs): Promise<SavedCardCharge> {
    const currency = this.currencyFor(a.currency);
    const ref = this.orderRef(a.referenceId);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const t = StripeProvider.splitToken(a.token);
    if (!t) return { providerRef: ref, status: 'failed', checkoutUrl: null, expiresAt, message: 'not a Stripe saved card', linkEnded: true };
    const r = await this.post('/v1/payment_intents', {
      amount: toProviderAmount(a.amountMinor, currency, 'minor'), currency: currency.toLowerCase(),
      customer: t.customer, payment_method: t.paymentMethod, payment_method_types: ['card'], confirm: true,
      capture_method: a.preauth ? 'manual' : 'automatic', return_url: this.abs(a.returnUrl),
      metadata: this.metadata(ref, a.referenceId, a.returnUrl), ...(a.description ? { description: a.description.slice(0, 500) } : {}),
    }, `pi-${ref}`);
    const j = r.body ?? {};
    if (r.status >= 300) {
      // A decline comes back as 402 with the PaymentIntent; a card Stripe no longer has (detached, deleted) or that has
      // expired cannot pay again: the saved card has ended.
      const e = j.error ?? {};
      const ended = e.code === 'resource_missing' || e.code === 'payment_method_unexpected_state' || e.decline_code === 'expired_card' || e.code === 'expired_card';
      return { providerRef: ref, providerPaymentId: e.payment_intent?.id, status: 'failed', checkoutUrl: null, expiresAt, message: StripeProvider.err(r), ...(ended ? { linkEnded: true } : {}) };
    }
    if (j.status === 'requires_capture') return { providerRef: ref, providerPaymentId: j.id, status: 'authorised', checkoutUrl: null, expiresAt };
    if (j.status === 'succeeded') return { providerRef: ref, providerPaymentId: j.id, status: 'captured', checkoutUrl: null, expiresAt };
    if (j.status === 'requires_action' || j.status === 'processing') {
      // 3-D Secure: Stripe's redirect, or (another kind of next action) PlugSure's page, which hands it to Stripe.js.
      const url = j.next_action?.redirect_to_url?.url ?? (j.status === 'requires_action' ? this.abs(this.pagePath(ref, j.id)) : null);
      return { providerRef: ref, providerPaymentId: j.id, status: 'pending', checkoutUrl: url, expiresAt };
    }
    return { providerRef: ref, providerPaymentId: j.id, status: 'failed', checkoutUrl: null, expiresAt, message: `${j.status ?? ''} ${j.last_payment_error?.code ?? ''}`.trim() };
  }

  async deleteSavedCard(token: string): Promise<void> {
    const t = StripeProvider.splitToken(token);
    if (!t) return;
    await this.post(`/v1/payment_methods/${encodeURIComponent(t.paymentMethod)}/detach`, {}, `detach-${t.paymentMethod}`);
  }

  /** The card behind a token (brand, last four, expiry), for the driver's list. Webhook objects are not expanded. */
  async savedCardDetails(token: string): Promise<SavedCardInfo | null> {
    const t = StripeProvider.splitToken(token);
    if (!t) return null;
    const r = await this.get(`/v1/payment_methods/${encodeURIComponent(t.paymentMethod)}`);
    const c = r.status < 300 ? r.body?.card : null;
    if (!c) return null;
    return { token, brand: c.brand ? String(c.brand).toUpperCase() : null, last4: c.last4 ? String(c.last4) : null, expMonth: c.exp_month ?? null, expYear: c.exp_year ?? null };
  }

  private async intent(id: string): Promise<any | null> {
    const r = await this.get(`/v1/payment_intents/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`Stripe payment lookup failed: ${StripeProvider.err(r)}`);
    return r.body;
  }

  /** The PaymentIntent for PlugSure's checkout page, checked to be the one this reference made. */
  async pageIntent(providerRef: string, paymentIntentId: string): Promise<any | null> {
    if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return null;
    const pi = await this.intent(paymentIntentId);
    return pi && pi.metadata?.plugsure_ref === providerRef ? pi : null;
  }

  /**
   * Capture a hold, up to what was authorised; Stripe releases the rest. Stripe replays the saved answer of an
   * Idempotency-Key, failures included (a 500 would be answered 500 for 24 h), so each attempt has its own key under the
   * hold's: safe, because a PaymentIntent is captured at most once — a repeated capture is refused, and the
   * PaymentIntent's status (looked up first) says whether it already went through.
   */
  async captureHold(a: HoldArgs): Promise<HoldResult> {
    if (!a.providerPaymentId) return { ok: false, error: 'the Stripe PaymentIntent of the hold is unknown (its webhook never arrived)' };
    const before = await this.intent(a.providerPaymentId).catch(() => null);
    if (before?.status === 'succeeded') return { ok: true, raw: { note: 'already captured', amount_received: before.amount_received } };
    if (before?.status === 'canceled') return { ok: false, expired: true, error: `the authorisation was cancelled at Stripe (${before.cancellation_reason ?? 'canceled'})` };
    const r = await this.post(`/v1/payment_intents/${encodeURIComponent(a.providerPaymentId)}/capture`,
      { amount_to_capture: toProviderAmount(a.amountMinor, this.cur(), 'minor') }, `${a.idempotencyKey}:${randomUUID().slice(0, 8)}`);
    if (r.status < 300 && ['succeeded', 'processing'].includes(r.body?.status)) return { ok: true, raw: { id: r.body.id, status: r.body.status, amount_received: r.body.amount_received } };
    const now = await this.intent(a.providerPaymentId).catch(() => null);
    if (now?.status === 'succeeded') return { ok: true, raw: { note: 'captured (confirmed by lookup)' } };
    return { ok: false, error: StripeProvider.err(r), ...(now?.status === 'canceled' ? { expired: true } : {}) };
  }

  /** Release a hold (cancel the PaymentIntent). Already cancelled or expired: nothing is held, which is what was wanted. */
  async releaseHold(a: Omit<HoldArgs, 'amountMinor'>): Promise<HoldResult> {
    if (!a.providerPaymentId) return { ok: true, raw: { note: 'never created at Stripe: nothing held' } };
    const before = await this.intent(a.providerPaymentId).catch(() => null);
    if (before?.status === 'canceled') return { ok: true, ...(before.cancellation_reason === 'automatic' ? { expired: true } : {}), raw: { note: 'already cancelled' } };
    if (before?.status === 'succeeded') return { ok: false, error: 'the payment was already captured at Stripe; refund it instead' };
    const r = await this.post(`/v1/payment_intents/${encodeURIComponent(a.providerPaymentId)}/cancel`, {}, `${a.idempotencyKey}:${randomUUID().slice(0, 8)}`);
    if (r.status < 300) return { ok: true, raw: { id: r.body?.id, status: r.body?.status } };
    const now = await this.intent(a.providerPaymentId).catch(() => null);
    if (now?.status === 'canceled') return { ok: true, raw: { note: 'cancelled (confirmed by lookup)' } };
    return { ok: false, error: StripeProvider.err(r) };
  }

  /** Where a payment stands, by PlugSure's reference (the Search API on metadata). */
  async paymentStatus(providerRef: string): Promise<PaymentStatus | null> {
    if (!/^ps_[0-9a-f]{32}$/.test(providerRef)) return null;
    const r = await this.get('/v1/payment_intents/search', { query: `metadata['plugsure_ref']:'${providerRef}'`, limit: 1 });
    if (r.status >= 300) throw new Error(`Stripe payment search failed: ${StripeProvider.err(r)}`);
    const pi = r.body?.data?.[0];
    if (!pi) return null;
    const cur = String(pi.currency ?? '').toUpperCase() as CurrencyCode;
    const status = pi.status === 'succeeded' ? 'captured' : pi.status === 'requires_capture' ? 'authorised' : pi.status === 'canceled' ? 'failed' : 'pending';
    const amt = status === 'captured' ? pi.amount_received : status === 'authorised' ? pi.amount_capturable : null;
    return { status, acquirerStatus: String(pi.status), amountMinor: amt != null && cur === this.cur() ? fromProviderAmount(Number(amt), cur, 'minor') : null, providerPaymentId: pi.id };
  }

  private static refundState(st: unknown): 'refunded' | 'pending' | 'failed' {
    const s = String(st ?? '');
    return s === 'succeeded' ? 'refunded' : s === 'failed' || s === 'canceled' ? 'failed' : 'pending';
  }

  /**
   * Refund through Stripe's Refunds API, with PlugSure's stable idempotency key (refund-<payment>): a retried call can
   * never pay twice. PayNow and GrabPay refunds are asynchronous (pending → refund.updated).
   */
  async refund(a: RefundArgs): Promise<RefundResult> {
    if (!a.providerPaymentId) return { status: 'failed', refundRef: '', raw: { error: 'the Stripe PaymentIntent of this payment is unknown' } };
    const r = await this.post('/v1/refunds', {
      payment_intent: a.providerPaymentId, amount: toProviderAmount(a.amountMinor, this.cur(), 'minor'), reason: 'requested_by_customer',
      metadata: { plugsure_idem: a.idempotencyKey, plugsure_ref: a.providerRef },
    }, a.idempotencyKey);
    const j = r.body ?? {};
    if (r.status >= 300) return { status: 'failed', refundRef: '', raw: { status: r.status, error: StripeProvider.err(r) } };
    return { status: StripeProvider.refundState(j.status), refundRef: String(j.id ?? ''), raw: { id: j.id, status: j.status, amount: j.amount } };
  }

  /** A refund that came back pending, or whose answer was lost: by its id, or among the payment's refunds by PlugSure's key. */
  async refundStatus(a: RefundStatusArgs): Promise<'refunded' | 'pending' | 'failed' | null> {
    if (a.refundRef && /^(re|pyr)_/.test(a.refundRef)) {
      const r = await this.get(`/v1/refunds/${encodeURIComponent(a.refundRef)}`);
      if (r.status === 404) return null;
      if (r.status >= 300) throw new Error(`Stripe refund lookup failed: ${StripeProvider.err(r)}`);
      return StripeProvider.refundState(r.body?.status);
    }
    if (!a.providerPaymentId) return null;
    const r = await this.get('/v1/refunds', { payment_intent: a.providerPaymentId, limit: 100 });
    if (r.status >= 300) throw new Error(`Stripe refund lookup failed: ${StripeProvider.err(r)}`);
    const hit = (r.body?.data ?? []).find((x: any) => x?.metadata?.plugsure_idem === a.idempotencyKey);
    return hit ? StripeProvider.refundState(hit.status) : null;
  }

  // ---------------------------------------------------------------- webhooks

  private secrets(): string[] { return this.cfg.webhookSecret.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean); }

  /** The signed timestamp is within the tolerance (checked by the registry before anything is read: a replay otherwise). */
  notificationFresh(headers: Record<string, string | string[] | undefined>, now = Date.now()): boolean {
    const { t } = parseStripeSignature(header(headers, 'stripe-signature'));
    return t != null && Math.abs(now / 1000 - t) <= STRIPE_SIGNATURE_TOLERANCE_S;
  }

  /** Stripe-Signature: HMAC-SHA256 of "<t>.<raw body>", any v1 signature matching any configured secret, in constant time. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, now = Date.now()): boolean {
    const { t, v1 } = parseStripeSignature(header(headers, 'stripe-signature'));
    if (t == null || !v1.length || !this.secrets().length) return false;
    if (Math.abs(now / 1000 - t) > STRIPE_SIGNATURE_TOLERANCE_S) return false;
    let ok = false;
    for (const s of this.secrets()) {
      const expect = createHmac('sha256', s).update(`${t}.${rawBody}`, 'utf8').digest();
      for (const sig of v1) {
        const given = Buffer.from(sig, 'hex');
        // No early exit: every candidate is compared.
        if (given.length === expect.length && timingSafeEqual(given, expect)) ok = true;
      }
    }
    return ok;
  }

  /** A verified event (signature, and livemode matching the key's mode), or null. */
  private event(rawBody: string, headers: Record<string, string | string[] | undefined>): any | null {
    if (!this.verifyWebhook(rawBody, headers)) return null;
    let j: any;
    try { j = JSON.parse(rawBody); } catch { return null; }
    if (j?.object !== 'event' || typeof j.id !== 'string' || typeof j.type !== 'string' || !j.data?.object) return null;
    if (typeof j.livemode === 'boolean' && this.mode && j.livemode !== (this.mode === 'live')) return null;
    return j;
  }

  /** The event's id (evt_…), for de-duplication; null unless the event verifies. */
  eventId(rawBody: string, headers: Record<string, string | string[] | undefined>): string | null {
    const e = this.event(rawBody, headers);
    return e ? String(e.id) : null;
  }

  parseNotification(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentNotification | null {
    const e = this.event(rawBody, headers);
    if (!e || !String(e.type).startsWith('payment_intent.')) return null;
    const pi = e.data.object;
    const ref = pi?.metadata?.plugsure_ref;
    if (pi?.object !== 'payment_intent' || typeof ref !== 'string' || !ref) return null;
    const currency = String(pi.currency ?? '').toUpperCase();
    const amt = (v: unknown): number | null => {
      if (v == null || !Number.isFinite(Number(v))) return null;
      // A currency PlugSure does not know cannot be converted: reported as is (the registry refuses the currency).
      return isCurrency(currency) ? fromProviderAmount(Number(v), currency, 'minor') : Math.round(Number(v));
    };
    const savedCard = (): SavedCardInfo | undefined => {
      const pm = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
      const cus = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id;
      if (!pm || !cus || pi.setup_future_usage == null) return undefined;
      const c = typeof pi.payment_method === 'object' ? pi.payment_method?.card : null;
      return { token: `${cus}/${pm}`, brand: c?.brand ? String(c.brand).toUpperCase() : null, last4: c?.last4 ?? null, expMonth: c?.exp_month ?? null, expYear: c?.exp_year ?? null };
    };
    const base = { providerRef: ref, paymentId: String(pi.id), currency };
    switch (e.type) {
      case 'payment_intent.succeeded': {
        const sc = savedCard();
        return { ...base, paid: true, status: 'succeeded', amountMinor: amt(pi.amount_received), ...(sc ? { savedCard: sc } : {}) };
      }
      case 'payment_intent.amount_capturable_updated': {
        const sc = savedCard();
        const capturable = Number(pi.amount_capturable ?? 0);
        // amount_capturable drops to 0 after a capture or cancel: that is not a new authorisation.
        if (!(capturable > 0)) return { ...base, paid: false, status: 'capturable_cleared', amountMinor: null };
        return { ...base, paid: false, authorised: true, status: 'requires_capture', amountMinor: amt(capturable), ...(sc ? { savedCard: sc } : {}) };
      }
      case 'payment_intent.payment_failed': {
        // A declined attempt leaves the PaymentIntent open (requires_payment_method): the driver may try another card
        // on the page. Only an expired PayNow QR ends it.
        const code = String(pi.last_payment_error?.code ?? '');
        return { ...base, paid: false, status: code === 'payment_intent_payment_attempt_expired' ? 'expired' : 'requires_payment_method', amountMinor: null };
      }
      case 'payment_intent.canceled':
        // automatic: Stripe cancelled it — an uncaptured authorisation that expired (7 days for most cards).
        return { ...base, paid: false, status: pi.cancellation_reason === 'automatic' ? 'expired' : 'canceled', amountMinor: null };
      default:
        // processing, requires_action, created, partially_funded: not an outcome.
        return { ...base, paid: false, status: String(pi.status ?? e.type), amountMinor: null };
    }
  }

  /** A refund event (refund.created / refund.updated / refund.failed / charge.refund.updated): the refund's state. */
  parseRefundEvent(rawBody: string, headers: Record<string, string | string[] | undefined>): { refundRef: string; status: 'refunded' | 'pending' | 'failed'; event: string } | null {
    const e = this.event(rawBody, headers);
    if (!e || !REFUND_EVENTS.has(e.type)) return null;
    const r = e.data.object;
    if (r?.object !== 'refund' || !r.id) return null;
    return { refundRef: String(r.id), status: StripeProvider.refundState(r.status), event: e.type };
  }

  /** Any other verified event (charge.*, charge.refunded, customer.*, …): answered 2xx so Stripe does not retry it. */
  parseOtherEvent(rawBody: string, headers: Record<string, string | string[] | undefined>): { event: string } | null {
    const e = this.event(rawBody, headers);
    return e ? { event: String(e.type) } : null;
  }

  notificationAck(ok: boolean) { return { status: ok ? 200 : 400, body: ok ? { received: true } : { error: 'invalid signature' } }; }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try { this.assertMode(); } catch (e) { return { ok: false, message: (e as Error).message }; }
    const pk = keyMode(this.cfg.publishableKey);
    if (this.cfg.publishableKey && pk !== this.mode) return { ok: false, message: `The publishable key is a ${pk ?? 'non-Stripe'} key but the secret key is a ${this.mode} key.` };
    const b = await this.get('/v1/balance');
    if (b.status === 401 || b.status === 403) return { ok: false, message: `Stripe refused the secret key (${StripeProvider.err(b)}).` };
    if (b.status >= 300) return { ok: false, message: `Unexpected answer from Stripe: ${StripeProvider.err(b)}` };
    // The account's country must be the integration's: a Singapore key on the Malaysian integration would take SGD for MYR prices.
    const acct = await this.get('/v1/account');
    const country = acct.status < 300 ? String(acct.body?.country ?? '') : '';
    if (country && country !== this.cfg.country) return { ok: false, message: `This Stripe account is registered in ${country}, but the integration is for ${this.cfg.country}.` };
    const cur = String(acct.body?.default_currency ?? '').toUpperCase();
    return {
      ok: true,
      message: `Secret key accepted by Stripe${this.mode === 'test' ? ' (TEST mode)' : ' (live mode)'}${country ? `; account in ${country}` : ''}${cur ? `, settles ${cur}` : ''}.`,
    };
  }

  async createQrisCharge(_a: CreateQrisChargeArgs): Promise<QrisCharge> { throw new Error('stripe: QRIS is an Indonesian rail; PayNow is offered as a channel instead'); }
  async chargeTokenized(_a: TokenizedChargeArgs): Promise<PaymentResult> { throw new Error('stripe: not used'); }
  async authorizeCard(_a: PreauthArgs): Promise<PaymentResult> { throw new Error('stripe: card holds go through createCheckout (preauth)'); }
  async captureCard(_a: CaptureArgs): Promise<PaymentResult> { throw new Error('stripe: captures go through captureHold'); }
}
