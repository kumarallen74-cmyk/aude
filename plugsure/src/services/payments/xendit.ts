import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  providerFetch,
  type CaptureArgs, type Channel, type Checkout, type CheckoutArgs, type CreateQrisChargeArgs, type PaymentNotification,
  type PaymentProvider, type PaymentResult, type PreauthArgs, type QrisCharge, type RefundArgs, type RefundResult, type TokenizedChargeArgs,
  type HoldArgs, type HoldResult, type SavedCardCharge, type SavedCardChargeArgs, cardBrand, last4Of,
  type WalletChargeArgs, type WalletLink, type WalletLinkArgs, type WalletLinkStatus, WalletLinkEnded,
} from './provider.js';
import type { RefundStatusArgs } from './registry.js';

/**
 * Xendit — dynamic QRIS, e-wallets and cards.
 *
 *   QRIS        POST {base}/qr_codes            (api-version 2022-07-31) { reference_id, type: 'DYNAMIC', amount }
 *   e-wallets   POST {base}/ewallets/charges    { reference_id, amount, checkout_method: 'ONE_TIME_PAYMENT',
 *                                                channel_code: ID_OVO | ID_DANA | ID_SHOPEEPAY | ID_LINKAJA,
 *                                                channel_properties: OVO { mobile_number } — pushed to the OVO app;
 *                                                others { success_redirect_url } — actions.*_checkout_url }
 *   cards       POST {base}/v2/invoices         { external_id, amount, payment_methods: ['CREDIT_CARD'] }
 *                                                → invoice_url, Xendit's hosted page with 3-D Secure
 *   callbacks   to the URL shown in Integrations, with x-callback-token = your verification token:
 *                 'qr.payment'      data.status SUCCEEDED
 *                 'ewallet.capture' data.status SUCCEEDED
 *                 invoice           status PAID / SETTLED (no event field)
 *   refunds     e-wallets: POST {base}/ewallets/charges/{id}/refunds; QRIS and cards by bank
 *               transfer from the Refunds page.
 *   test        GET  {base}/balance
 *
 *   card holds  Payments API v3: a hosted Payment Session (mode PAYMENT_LINK, CARDS, capture_method
 *   and       MANUAL) → 'payment.authorization' (AUTHORIZED); POST {base}/v3/payment_requests/{id}/captures
 *   saved       { capture_amount } takes up to the hold, POST …/{id}/cancel releases it. Saving the card
 *   cards       (allow_save_payment_method) returns a payment_token_id; later POST {base}/v3/payment_requests
 *               with that payment_token_id (3-D Secure when Xendit asks: actions[].url).
 *               Confirm the v3 field names in Xendit's sandbox before live traffic.
 *
 *   linked      Payment Methods v2: POST {base}/v2/payment_methods { type: 'EWALLET', reusability:
 *   OVO, DANA,  'MULTIPLE_USE', ewallet: { channel_code, channel_properties } } → actions AUTH url the driver
 *   ShopeePay,  approves in the e-wallet (OVO: pushed to its number); GET {base}/v2/payment_methods/{id} → ACTIVE. Charges: POST
 *   LinkAja     {base}/payment_requests { payment_method_id, amount } (SUCCEEDED at once, or an action
 *               url); refunds of those: POST {base}/refunds { payment_request_id }; balance (as reported):
 *               ewallet.account.balance on GET {base}/v2/payment_methods/{id}; unlink: POST
 *               {base}/v2/payment_methods/{id}/expire. Confirm the fields in Xendit's sandbox.
 *
 *   GoPay       Payments API v3 (api-version 2024-11-11). One-time: POST {base}/v3/payment_requests
 *               { type: 'PAY', channel_code: 'GOPAY', channel_properties: { success_return_url, failure_return_url } }
 *               → actions[] { descriptor: 'WEB_URL', value } opens GoPay. Linked: POST {base}/v3/payment_tokens
 *               { channel_code: 'GOPAY_RECURRING', … } → REQUIRES_ACTION (approve in GoPay) → ACTIVE (GET
 *               {base}/v3/payment_tokens/{id}); charged with POST {base}/v3/payment_requests { payment_token_id };
 *               balance: token_details.account_balance on the token, when GoPay makes it available; unlink:
 *               POST {base}/v3/payment_tokens/{id}/cancel. Refunds: POST {base}/refunds { payment_request_id }.
 *               Xendit activates GoPay recurring per account.
 *
 *   references  reference_id (and the idempotency key of a payment request) is derived from PlugSure's reference
 *               (orderRef), never random: PlugSure records it before asking, and a request repeated after a lost
 *               answer is answered by Xendit with the first payment instead of making a second.
 *   callbacks   only the payment events below are read as payments; link events (payment_method.*, payment_token.*)
 *               go to parseLinkEvent, refund events (refund.*, ewallet.refund) to parseRefundEvent.
 *
 * Authentication: HTTP Basic, the secret key as user name and no password.
 * xenPlatform: `for-user-id` charges on a sub-account.
 */

/** The callback events that report a payment (QRIS, e-wallet charges, payment requests v2 and v3). Anything else is not one. */
const PAYMENT_EVENTS = new Set([
  'qr.payment', 'ewallet.capture',
  'payment.succeeded', 'payment.failed', 'payment.pending', 'payment.awaiting_capture',
  'payment.capture', 'payment.authorization', 'payment.failure', 'payment.expiry',
]);
/** The callback events that report a refund. */
const REFUND_EVENTS = new Set(['refund.succeeded', 'refund.failed', 'ewallet.refund']);
export interface XenditConfig {
  secretKey: string;
  callbackToken: string;
  forUserId?: string;
  baseUrl?: string;
}

export class XenditProvider implements PaymentProvider {
  readonly name = 'xendit';
  constructor(private cfg: XenditConfig) {}

  private base() { return (this.cfg.baseUrl || 'https://api.xendit.co').replace(/\/+$/, ''); }
  private headers() {
    return {
      Authorization: 'Basic ' + Buffer.from(`${this.cfg.secretKey}:`).toString('base64'),
      'Content-Type': 'application/json', 'api-version': '2022-07-31',
      ...(this.cfg.forUserId ? { 'for-user-id': this.cfg.forUserId } : {}),
    };
  }

  /** reference_id for a PlugSure reference: the same reference, the same Xendit payment (and idempotency key). */
  orderRef(referenceId: string): string { return `ps-${createHash('sha256').update(referenceId, 'utf8').digest('hex').slice(0, 32)}`; }

  channels(): Channel[] { return ['QRIS', 'GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA', 'CARD']; }
  canRefund(channel: string | null): boolean { return ['GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA'].includes(String(channel)); }

  async createQrisCharge(a: CreateQrisChargeArgs): Promise<QrisCharge> {
    const referenceId = this.orderRef(a.referenceId);
    const expiresAt = new Date(Date.now() + (a.expiresInS ?? 900) * 1000).toISOString();
    const r = await providerFetch(`${this.base()}/qr_codes`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ reference_id: referenceId, type: 'DYNAMIC', currency: 'IDR', amount: Math.round(a.amountMinor), expires_at: expiresAt }),
    });
    const j = r.body ?? {};
    if (r.status >= 300 || !j.qr_string) throw new Error(`Xendit QR code failed: ${r.status} ${j.error_code ?? ''} ${j.message ?? r.text.slice(0, 200)}`.trim());
    return { providerRef: referenceId, qrString: j.qr_string, amountMinor: a.amountMinor, expiresAt: j.expires_at ?? expiresAt, status: 'pending' };
  }

  /** Payments API v3 (sessions, payment requests, captures). */
  private v3Headers() { return { ...this.headers(), 'api-version': '2024-11-11' }; }
  cardFeatures() { return { holds: true, savedCards: true }; }

  linkableWallets(): Channel[] { return ['OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA', 'GOPAY']; }

  async linkWallet(a: WalletLinkArgs): Promise<WalletLink> {
    if (!this.linkableWallets().includes(a.channel)) throw new Error(`Xendit links GoPay, OVO, DANA, ShopeePay and LinkAja here, not ${a.channel}`);
    if (a.channel === 'GOPAY') return this.gopayLink(a);
    const r = await providerFetch(`${this.base()}/v2/payment_methods`, {
      method: 'POST', headers: { ...this.headers(), 'idempotency-key': `link-${a.customerId}-${a.channel}-${Date.now()}` },
      body: JSON.stringify({
        type: 'EWALLET', reusability: 'MULTIPLE_USE',
        customer: { reference_id: a.customerId, type: 'INDIVIDUAL', individual_detail: { given_names: 'PlugSure driver' }, mobile_number: a.phone },
        ewallet: {
          channel_code: a.channel,
          channel_properties: { success_return_url: a.returnUrl, failure_return_url: a.returnUrl, cancel_return_url: a.returnUrl, ...(a.channel === 'OVO' ? { mobile_number: a.phone } : {}) },
        },
        metadata: { source: 'plugsure' },
      }),
    });
    const j = r.body ?? {};
    if (r.status >= 300 || !j.id) throw new Error(`Xendit ${a.channel} linking failed: ${r.status} ${j.error_code ?? ''} ${j.message ?? r.text.slice(0, 200)}`.trim());
    const url = (j.actions ?? []).find((x: any) => x.action === 'AUTH' || x.url)?.url ?? null;
    const status = j.status === 'ACTIVE' ? 'active' : ['PENDING', 'REQUIRES_ACTION'].includes(j.status) ? 'pending' : 'failed';
    return { linkRef: String(j.id), status, activationUrl: url, ...(status === 'active' ? { token: String(j.id) } : {}) };
  }

  async walletStatus(linkRef: string, channel?: Channel): Promise<WalletLinkStatus> {
    if (channel === 'GOPAY') return this.gopayStatus(linkRef);
    const r = await providerFetch(`${this.base()}/v2/payment_methods/${encodeURIComponent(linkRef)}`, { headers: this.headers() });
    const j = r.body ?? {};
    if (r.status >= 300) return { status: 'pending', message: `${r.status} ${j.error_code ?? ''}`.trim() };
    if (j.status === 'ACTIVE') return { status: 'active', token: String(j.id ?? linkRef) };
    if (['PENDING', 'REQUIRES_ACTION'].includes(j.status)) return { status: 'pending' };
    return { status: 'failed', message: String(j.status ?? 'unknown') };
  }

  async chargeWallet(a: WalletChargeArgs): Promise<SavedCardCharge> {
    // GoPay: a v3 payment request on its payment token (the same call as a saved card, as a sale).
    if (a.channel === 'GOPAY') {
      const c = await this.chargeSavedCard({ referenceId: a.referenceId, amountMinor: a.amountMinor, token: a.token, preauth: false, returnUrl: a.returnUrl, customerId: a.customerId, description: a.description });
      return c.linkEnded ? { ...c, message: `the GoPay link has ended; link it again (${c.message ?? 'refused'})` } : c;
    }
    const referenceId = this.orderRef(a.referenceId);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const r = await providerFetch(`${this.base()}/payment_requests`, {
      method: 'POST', headers: { ...this.headers(), 'idempotency-key': referenceId },
      body: JSON.stringify({ reference_id: referenceId, amount: Math.round(a.amountMinor), currency: 'IDR', payment_method_id: a.token, ...(a.description ? { description: a.description.slice(0, 250) } : {}) }),
    });
    const j = r.body ?? {};
    // Refused: was the link ended in the e-wallet app, or did it expire (the payment method INACTIVE / EXPIRED)?
    const refused = async (c: SavedCardCharge): Promise<SavedCardCharge> =>
      (await this.paymentMethodEnded(a.token)) ? { ...c, linkEnded: true, message: `the ${a.channel} link has ended; link it again (${c.message ?? 'refused'})` } : c;
    if (r.status >= 300) return refused({ providerRef: referenceId, status: 'failed', checkoutUrl: null, expiresAt, message: `${r.status} ${j.error_code ?? ''} ${j.message ?? ''}`.trim() });
    if (j.status === 'SUCCEEDED') return { providerRef: referenceId, providerPaymentId: j.id, status: 'captured', checkoutUrl: null, expiresAt };
    const url = (j.actions ?? []).find((x: any) => x.url)?.url ?? null;
    if (['PENDING', 'REQUIRES_ACTION'].includes(j.status)) return { providerRef: referenceId, providerPaymentId: j.id, status: url ? 'pending' : 'pending', checkoutUrl: url, expiresAt };
    return refused({ providerRef: referenceId, providerPaymentId: j.id, status: 'failed', checkoutUrl: null, expiresAt, message: `${j.status ?? ''} ${j.failure_code ?? ''}`.trim() });
  }

  /** Payment method states in which a linked e-wallet can no longer be charged (unlinked in the app, deactivated, or expired). */
  private static readonly ENDED_METHOD = ['INACTIVE', 'EXPIRED'];

  private async paymentMethodEnded(id: string): Promise<boolean> {
    const r = await providerFetch(`${this.base()}/v2/payment_methods/${encodeURIComponent(id)}`, { headers: this.headers() }).catch(() => null);
    return !!r && r.status < 300 && XenditProvider.ENDED_METHOD.includes(r.body?.status);
  }

  /**
   * The linked account's balance as Xendit reports it on the payment method
   * (ewallet.account.balance): OVO, DANA, ShopeePay and LinkAja. When it is not
   * reported the balance is unknown (null), and post-pay either starts without the
   * check or, if the operator requires a checked balance, the e-wallet is charged
   * up front. Confirm per e-wallet in Xendit's sandbox which report it. A payment method
   * that is INACTIVE (unlinked in the e-wallet app) or EXPIRED throws WalletLinkEnded.
   */
  async walletBalance(token: string, channel: Channel): Promise<number | null> {
    if (!this.linkableWallets().includes(channel)) return null;
    if (channel === 'GOPAY') {
      // v3 payment token: token_details.account_balance, when GoPay makes it available.
      const t = await providerFetch(`${this.base()}/v3/payment_tokens/${encodeURIComponent(token)}`, { headers: this.v3Headers() }).catch(() => null);
      if (t && t.status < 300 && XenditProvider.ENDED_TOKEN.includes(t.body?.status)) throw new WalletLinkEnded(String(t.body.status));
      const b = t && t.status < 300 ? t.body?.token_details?.account_balance : null;
      return b != null && Number.isFinite(Number(b)) ? Math.floor(Number(b)) : null;
    }
    const r = await providerFetch(`${this.base()}/v2/payment_methods/${encodeURIComponent(token)}`, { headers: this.headers() }).catch(() => null);
    if (!r || r.status >= 300) return null;
    if (XenditProvider.ENDED_METHOD.includes(r.body?.status)) throw new WalletLinkEnded(String(r.body.status));
    const v = Number(r.body?.ewallet?.account?.balance);
    return r.body?.ewallet?.account?.balance != null && Number.isFinite(v) ? Math.floor(v) : null;
  }

  async unlinkWallet(linkRef: string, channel?: Channel): Promise<void> {
    if (channel === 'GOPAY') {
      await providerFetch(`${this.base()}/v3/payment_tokens/${encodeURIComponent(linkRef)}/cancel`, { method: 'POST', headers: this.v3Headers() });
      return;
    }
    await providerFetch(`${this.base()}/v2/payment_methods/${encodeURIComponent(linkRef)}/expire`, { method: 'POST', headers: this.headers() });
  }

  // ---------------------------------------------------------------- GoPay (Payments API v3)
  // One-time: a payment request with channel_code GOPAY. Linked: a payment token with channel_code
  // GOPAY_RECURRING (Xendit activates recurring GoPay per account), charged by payment_token_id;
  // token_details.account_balance reports the balance when GoPay makes it available.

  /** The redirect in a v3 response: actions[] { type, descriptor: 'WEB_URL', value }. */
  private v3Redirect(j: any): string | null {
    const a = (j?.actions ?? []).find((x: any) => (x.descriptor === 'WEB_URL' || x.type === 'REDIRECT_CUSTOMER') && (x.value || x.url));
    return a ? String(a.value ?? a.url) : null;
  }

  private async gopayLink(a: WalletLinkArgs): Promise<WalletLink> {
    const r = await providerFetch(`${this.base()}/v3/payment_tokens`, {
      method: 'POST', headers: { ...this.v3Headers(), 'idempotency-key': `link-${a.customerId}-GOPAY-${Date.now()}` },
      body: JSON.stringify({
        reference_id: `link-${randomUUID()}`, country: 'ID', currency: 'IDR', channel_code: 'GOPAY_RECURRING',
        channel_properties: { success_return_url: a.returnUrl, failure_return_url: a.returnUrl },
        customer: { reference_id: a.customerId, type: 'INDIVIDUAL', individual_detail: { given_names: 'PlugSure driver' }, mobile_number: a.phone },
        metadata: { source: 'plugsure' },
      }),
    });
    const j = r.body ?? {};
    const id = j.payment_token_id ?? j.id;
    if (r.status >= 300 || !id) throw new Error(`Xendit GoPay linking failed: ${r.status} ${j.error_code ?? ''} ${j.message ?? r.text.slice(0, 200)}`.trim());
    const status = j.status === 'ACTIVE' ? 'active' : ['PENDING', 'REQUIRES_ACTION'].includes(j.status) ? 'pending' : 'failed';
    return { linkRef: String(id), status, activationUrl: this.v3Redirect(j), ...(status === 'active' ? { token: String(id) } : {}) };
  }

  /** Payment token states in which it can no longer be charged (a card token deleted or expired; GoPay unlinked or expired). */
  private static readonly ENDED_TOKEN = ['EXPIRED', 'CANCELED', 'CANCELLED'];

  private async paymentTokenEnded(token: string): Promise<boolean> {
    const t = await providerFetch(`${this.base()}/v3/payment_tokens/${encodeURIComponent(token)}`, { headers: this.v3Headers() }).catch(() => null);
    return !!t && t.status < 300 && XenditProvider.ENDED_TOKEN.includes(t.body?.status);
  }

  private async gopayStatus(linkRef: string): Promise<WalletLinkStatus> {
    const r = await providerFetch(`${this.base()}/v3/payment_tokens/${encodeURIComponent(linkRef)}`, { headers: this.v3Headers() });
    const j = r.body ?? {};
    if (r.status >= 300) return { status: 'pending', message: `${r.status} ${j.error_code ?? ''}`.trim() };
    if (j.status === 'ACTIVE') return { status: 'active', token: String(j.payment_token_id ?? linkRef) };
    if (['PENDING', 'REQUIRES_ACTION'].includes(j.status)) return { status: 'pending' };
    return { status: 'failed', message: String(j.status ?? 'unknown') };
  }

  /** GoPay one-time: the driver is sent to GoPay to approve (v3 payment request). */
  private async gopayCheckout(a: CheckoutArgs, referenceId: string, expiresAt: string): Promise<Checkout> {
    const r = await providerFetch(`${this.base()}/v3/payment_requests`, {
      method: 'POST', headers: { ...this.v3Headers(), 'idempotency-key': referenceId },
      body: JSON.stringify({
        reference_id: referenceId, type: 'PAY', country: 'ID', currency: 'IDR', request_amount: Math.round(a.amountMinor), capture_method: 'AUTOMATIC',
        channel_code: 'GOPAY', channel_properties: { success_return_url: a.returnUrl, failure_return_url: a.returnUrl },
        ...(a.description ? { description: a.description.slice(0, 250) } : {}),
      }),
    });
    const j = r.body ?? {};
    const url = this.v3Redirect(j);
    if (r.status >= 300 || !url) throw new Error(`Xendit GoPay payment failed: ${r.status} ${j.error_code ?? j.status ?? ''} ${j.message ?? r.text.slice(0, 200)}`.trim());
    return { providerRef: referenceId, action: 'redirect', checkoutUrl: url, expiresAt, providerPaymentId: j.payment_request_id ?? j.id };
  }

  /** A card hold and/or a saved card: Xendit's hosted payment session. */
  private async cardSession(a: CheckoutArgs, referenceId: string, expiresAt: string): Promise<Checkout> {
    const r = await providerFetch(`${this.base()}/sessions`, {
      method: 'POST', headers: this.v3Headers(),
      body: JSON.stringify({
        reference_id: referenceId, session_type: 'PAY', mode: 'PAYMENT_LINK', country: 'ID', currency: 'IDR', amount: Math.round(a.amountMinor),
        allowed_payment_channels: ['CARDS'], capture_method: a.preauth ? 'MANUAL' : 'AUTOMATIC',
        ...(a.saveCard ? { allow_save_payment_method: 'FORCED' } : {}),
        customer: { reference_id: a.customerId ?? referenceId, type: 'INDIVIDUAL', individual_detail: { given_names: 'PlugSure driver' } },
        success_return_url: a.returnUrl, cancel_return_url: a.returnUrl, expires_at: expiresAt,
        ...(a.description ? { description: a.description.slice(0, 250) } : {}),
      }),
    });
    const j = r.body ?? {};
    if (r.status >= 300 || !j.payment_link_url) throw new Error(`Xendit card session failed: ${r.status} ${j.error_code ?? ''} ${j.message ?? r.text.slice(0, 200)}`.trim());
    return { providerRef: referenceId, action: 'redirect', checkoutUrl: j.payment_link_url, expiresAt, providerPaymentId: j.payment_session_id };
  }

  async chargeSavedCard(a: SavedCardChargeArgs): Promise<SavedCardCharge> {
    const referenceId = this.orderRef(a.referenceId);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const r = await providerFetch(`${this.base()}/v3/payment_requests`, {
      method: 'POST', headers: { ...this.v3Headers(), 'idempotency-key': referenceId },
      body: JSON.stringify({
        reference_id: referenceId, type: 'PAY', country: 'ID', currency: 'IDR', request_amount: Math.round(a.amountMinor),
        capture_method: a.preauth ? 'MANUAL' : 'AUTOMATIC', payment_token_id: a.token,
        channel_properties: { success_return_url: a.returnUrl, failure_return_url: a.returnUrl },
        ...(a.description ? { description: a.description.slice(0, 250) } : {}),
      }),
    });
    const j = r.body ?? {};
    const id = j.payment_request_id ?? j.id;
    // Refused: has the token ended (a saved card deleted or expired, GoPay unlinked)?
    const refused = async (c: SavedCardCharge): Promise<SavedCardCharge> => ((await this.paymentTokenEnded(a.token)) ? { ...c, linkEnded: true } : c);
    if (r.status >= 300) return refused({ providerRef: referenceId, status: 'failed', checkoutUrl: null, expiresAt, message: `${r.status} ${j.error_code ?? ''} ${j.message ?? ''}`.trim() });
    if (j.status === 'REQUIRES_ACTION') {
      const url = this.v3Redirect(j);
      return { providerRef: referenceId, providerPaymentId: id, status: url ? 'pending' : 'failed', checkoutUrl: url, expiresAt, ...(url ? {} : { message: 'Xendit asked for an action without a URL' }) };
    }
    if (j.status === 'AUTHORIZED') return { providerRef: referenceId, providerPaymentId: id, status: 'authorised', checkoutUrl: null, expiresAt };
    if (j.status === 'SUCCEEDED') return { providerRef: referenceId, providerPaymentId: id, status: 'captured', checkoutUrl: null, expiresAt };
    return refused({ providerRef: referenceId, providerPaymentId: id, status: 'failed', checkoutUrl: null, expiresAt, message: `${j.status ?? ''} ${j.failure_code ?? ''}`.trim() });
  }

  async captureHold(a: HoldArgs): Promise<HoldResult> {
    if (!a.providerPaymentId) return { ok: false, error: 'the Xendit payment request of the hold is unknown (its callback never arrived)' };
    const r = await providerFetch(`${this.base()}/v3/payment_requests/${encodeURIComponent(a.providerPaymentId)}/captures`, {
      method: 'POST', headers: { ...this.v3Headers(), 'idempotency-key': a.idempotencyKey },
      body: JSON.stringify({ capture_amount: Math.round(a.amountMinor) }),
    });
    const j = r.body ?? {};
    if (r.status < 300 && ['SUCCEEDED', 'PENDING', undefined].includes(j.status)) return { ok: true, raw: j };
    const expired = j.status === 'EXPIRED' || (await this.paymentRequestExpired(a.providerPaymentId));
    return { ok: false, error: `${r.status} ${j.error_code ?? j.status ?? ''} ${j.message ?? ''}`.trim(), raw: j, ...(expired ? { expired: true } : {}) };
  }

  /** Refused: has the authorisation (the v3 payment request) expired at Xendit? */
  private async paymentRequestExpired(id: string): Promise<boolean> {
    const r = await providerFetch(`${this.base()}/v3/payment_requests/${encodeURIComponent(id)}`, { headers: this.v3Headers() }).catch(() => null);
    return !!r && r.status < 300 && r.body?.status === 'EXPIRED';
  }

  async releaseHold(a: Omit<HoldArgs, 'amountMinor'>): Promise<HoldResult> {
    if (!a.providerPaymentId) return { ok: true, raw: { note: 'never authorised at Xendit: nothing held' } };
    const r = await providerFetch(`${this.base()}/v3/payment_requests/${encodeURIComponent(a.providerPaymentId)}/cancel`, {
      method: 'POST', headers: { ...this.v3Headers(), 'idempotency-key': a.idempotencyKey },
    });
    const j = r.body ?? {};
    if (r.status < 300) return { ok: true, raw: j };
    // Already expired at Xendit: nothing is held any more, which is what releasing wanted.
    if (await this.paymentRequestExpired(a.providerPaymentId)) return { ok: true, expired: true, raw: j };
    return { ok: false, error: `${r.status} ${j.error_code ?? ''} ${j.message ?? ''}`.trim(), raw: j };
  }

  async createCheckout(a: CheckoutArgs): Promise<Checkout> {
    const referenceId = this.orderRef(a.referenceId);
    const expiresInS = a.expiresInS ?? 900;
    const expiresAt = new Date(Date.now() + expiresInS * 1000).toISOString();
    if (a.channel === 'CARD' && (a.preauth || a.saveCard)) return this.cardSession(a, referenceId, expiresAt);
    if (a.channel === 'CARD') {
      const r = await providerFetch(`${this.base()}/v2/invoices`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({
          external_id: referenceId, amount: Math.round(a.amountMinor), currency: 'IDR', payment_methods: ['CREDIT_CARD'],
          invoice_duration: expiresInS, success_redirect_url: a.returnUrl, failure_redirect_url: a.returnUrl,
          ...(a.description ? { description: a.description.slice(0, 250) } : {}),
        }),
      });
      if (r.status >= 300 || !r.body?.invoice_url) throw new Error(`Xendit card checkout failed: ${r.status} ${r.body?.error_code ?? ''} ${r.body?.message ?? r.text.slice(0, 200)}`.trim());
      return { providerRef: referenceId, action: 'redirect', checkoutUrl: r.body.invoice_url, expiresAt, providerPaymentId: r.body.id };
    }
    if (a.channel === 'GOPAY') return this.gopayCheckout(a, referenceId, expiresAt);
    if (!['OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA'].includes(a.channel)) throw new Error(`Xendit does not offer ${a.channel} here`);
    if (a.channel === 'OVO' && !a.customerPhone) throw new Error('OVO needs the driver\'s phone number');
    const r = await providerFetch(`${this.base()}/ewallets/charges`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({
        reference_id: referenceId, currency: 'IDR', amount: Math.round(a.amountMinor), checkout_method: 'ONE_TIME_PAYMENT', channel_code: `ID_${a.channel}`,
        channel_properties: a.channel === 'OVO' ? { mobile_number: a.customerPhone } : { success_redirect_url: a.returnUrl },
      }),
    });
    const j = r.body ?? {};
    if (r.status >= 300 || !j.id) throw new Error(`Xendit ${a.channel} charge failed: ${r.status} ${j.error_code ?? ''} ${j.message ?? r.text.slice(0, 200)}`.trim());
    const url = j.actions?.mobile_deeplink_checkout_url ?? j.actions?.mobile_web_checkout_url ?? j.actions?.desktop_web_checkout_url ?? null;
    return { providerRef: referenceId, action: a.channel === 'OVO' ? 'push' : 'redirect', checkoutUrl: a.channel === 'OVO' ? null : url, expiresAt, providerPaymentId: j.id };
  }

  /** Xendit signs nothing: every callback carries the account's callback token. */
  private callbackOk(headers: Record<string, string | string[] | undefined>): boolean {
    const given = String(headers['x-callback-token'] ?? '');
    const expect = this.cfg.callbackToken;
    return !!given && given.length === expect.length && timingSafeEqual(Buffer.from(given), Buffer.from(expect));
  }

  /**
   * Linked e-wallets: Xendit notifies a payment method (v2: OVO, DANA, ShopeePay, LinkAja) being activated or expired,
   * and a payment token (v3: GoPay) being activated, failing or expiring. The events go to the same callback URL.
   */
  parseLinkEvent(rawBody: string, headers: Record<string, string | string[] | undefined>): { linkRef: string; status: 'active' | 'ended' | 'failed'; event: string } | null {
    if (!this.callbackOk(headers)) return null;
    let j: any;
    try { j = JSON.parse(rawBody); } catch { return null; }
    const event = String(j?.event ?? '');
    if (!/^payment_(method|token)\./.test(event)) return null;
    const d = j.data ?? {};
    const linkRef = String(event.startsWith('payment_token.') ? d.payment_token_id ?? d.id ?? '' : d.id ?? '');
    if (!linkRef) return null;
    const st = String(d.status ?? '').toUpperCase();
    const status = st === 'ACTIVE' || /activat/.test(event) ? 'active'
      : ['EXPIRED', 'INACTIVE', 'CANCELED', 'CANCELLED'].includes(st) || /expir|deactivat/.test(event) ? 'ended'
      : st === 'FAILED' || /failure/.test(event) ? 'failed' : null;
    return status ? { linkRef, status, event } : null;
  }

  parseNotification(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentNotification | null {
    if (!this.callbackOk(headers)) return null;
    let j: any;
    try { j = JSON.parse(rawBody); } catch { return null; }
    // Invoice (cards): a flat body without an event.
    if (!j?.event && j?.external_id) {
      const st = String(j.status ?? '');
      return { providerRef: String(j.external_id), paid: st === 'PAID' || st === 'SETTLED', status: st, amountMinor: j.paid_amount != null ? Math.round(Number(j.paid_amount)) : j.amount != null ? Math.round(Number(j.amount)) : null, paymentId: j.id ? String(j.id) : undefined };
    }
    // Only payment events are payments: a GoPay link (payment_token.*, which also carries a reference_id) belongs to
    // parseLinkEvent, and a refund (refund.*: status SUCCEEDED, an amount, the payment's reference) is not money received.
    if (!PAYMENT_EVENTS.has(String(j?.event ?? ''))) return null;
    const d = j?.data;
    if (!d?.reference_id) return null;
    const amount = d.captured_amount ?? d.capture_amount ?? d.charge_amount ?? d.request_amount ?? d.amount;
    const paid = d.status === 'SUCCEEDED';
    const authorised = d.status === 'AUTHORIZED';
    // v3 card payments: the payment request id (captures and cancels use it); e-wallets: the charge id.
    const paymentId = d.payment_request_id ?? d.id ?? d.payment_id;
    const masked = d.card_details?.masked_card_number ?? d.payment_details?.masked_card_number ?? d.channel_properties?.masked_card_number ?? null;
    const savedCard = (paid || authorised) && d.payment_token_id
      ? { token: String(d.payment_token_id), brand: cardBrand(masked) ?? (d.card_details?.network ? String(d.card_details.network).toUpperCase() : null), last4: last4Of(masked),
          expMonth: d.card_details?.expiry_month != null ? Number(d.card_details.expiry_month) : null, expYear: d.card_details?.expiry_year != null ? Number(d.card_details.expiry_year) : null }
      : undefined;
    // A failed payment carries its reason (e.g. FAILED USER_DECLINED_THE_TRANSACTION: the driver refused it in the e-wallet).
    const status = `${String(d.status ?? j.event ?? '')}${d.status === 'FAILED' && d.failure_code ? ` ${String(d.failure_code)}` : ''}`;
    return { providerRef: String(d.reference_id), paid, authorised, status, amountMinor: amount != null ? Math.round(Number(amount)) : null, paymentId: paymentId ? String(paymentId) : undefined, ...(savedCard ? { savedCard } : {}) };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean { return this.parseNotification(rawBody, headers) !== null; }
  notificationAck(ok: boolean) { return { status: ok ? 200 : 401, body: ok ? { received: true } : { error: 'invalid callback token' } }; }

  /** E-wallet charges only; QRIS and card payments are refunded by bank transfer. */
  async refund(a: RefundArgs): Promise<RefundResult> {
    if (!this.canRefund(a.channel ?? null) || !a.providerPaymentId) return { status: 'failed', refundRef: '', raw: { error: 'refund this payment by bank transfer' } };
    if (a.providerPaymentId.startsWith('pr-')) {
      // A linked e-wallet payment (a payment request): the Refunds API.
      const r = await providerFetch(`${this.base()}/refunds`, {
        method: 'POST', headers: { ...this.headers(), 'Idempotency-key': a.idempotencyKey },
        body: JSON.stringify({ payment_request_id: a.providerPaymentId, amount: Math.round(a.amountMinor), currency: 'IDR', reason: 'REQUESTED_BY_CUSTOMER' }),
      });
      const j = r.body ?? {};
      if (r.status >= 300) return { status: 'failed', refundRef: '', raw: { status: r.status, error: j.error_code ?? j.message ?? r.text.slice(0, 200) } };
      return { status: j.status === 'SUCCEEDED' ? 'refunded' : 'pending', refundRef: String(j.id ?? a.idempotencyKey), raw: j };
    }
    const r = await providerFetch(`${this.base()}/ewallets/charges/${encodeURIComponent(a.providerPaymentId)}/refunds`, {
      method: 'POST', headers: { ...this.headers(), 'Idempotency-key': a.idempotencyKey },
      body: JSON.stringify({ amount: Math.round(a.amountMinor), reason: 'REQUESTED_BY_CUSTOMER' }),
    });
    const j = r.body ?? {};
    if (r.status >= 300) return { status: 'failed', refundRef: '', raw: { status: r.status, error: j.error_code ?? j.message ?? r.text.slice(0, 200) } };
    return { status: j.status === 'SUCCEEDED' ? 'refunded' : 'pending', refundRef: String(j.id ?? a.idempotencyKey), raw: j };
  }

  /**
   * A refund that came back pending (or whose answer was lost): its state at Xendit. Payment requests: GET /refunds/{id};
   * e-wallet charges: GET /ewallets/charges/{charge}/refunds/{id}. null: Xendit has no such refund (or it cannot be named).
   */
  async refundStatus(a: RefundStatusArgs): Promise<'refunded' | 'pending' | 'failed' | null> {
    if (!a.refundRef || !a.providerPaymentId || a.refundRef === a.idempotencyKey) return null;
    const url = a.providerPaymentId.startsWith('pr-')
      ? `${this.base()}/refunds/${encodeURIComponent(a.refundRef)}`
      : `${this.base()}/ewallets/charges/${encodeURIComponent(a.providerPaymentId)}/refunds/${encodeURIComponent(a.refundRef)}`;
    const r = await providerFetch(url, { headers: this.headers() });
    if (r.status === 404) return null;
    if (r.status >= 300) throw new Error(`Xendit refund lookup failed: ${r.status} ${r.body?.error_code ?? ''}`.trim());
    return XenditProvider.refundState(r.body?.status);
  }

  private static refundState(st: unknown): 'refunded' | 'pending' | 'failed' {
    const s = String(st ?? '').toUpperCase();
    return s === 'SUCCEEDED' ? 'refunded' : s === 'FAILED' ? 'failed' : 'pending';
  }

  /** A refund callback (refund.succeeded / refund.failed; ewallet.refund), verified like a payment callback. */
  parseRefundEvent(rawBody: string, headers: Record<string, string | string[] | undefined>): { refundRef: string; status: 'refunded' | 'pending' | 'failed'; event: string } | null {
    if (!this.callbackOk(headers)) return null;
    let j: any;
    try { j = JSON.parse(rawBody); } catch { return null; }
    const event = String(j?.event ?? '');
    if (!REFUND_EVENTS.has(event)) return null;
    const id = j.data?.id;
    return id ? { refundRef: String(id), status: XenditProvider.refundState(j.data?.status), event } : null;
  }

  async testConnection() {
    const r = await providerFetch(`${this.base()}/balance`, { headers: this.headers() });
    if (r.status === 200) return { ok: true, message: `Secret key accepted by Xendit${this.cfg.secretKey.startsWith('xnd_development') ? ' (test mode)' : ''}.` };
    if (r.status === 401 || r.status === 403) return { ok: false, message: `Xendit refused the secret key (${r.status} ${r.body?.error_code ?? ''}).`.trim() };
    return { ok: false, message: `Unexpected answer from Xendit: ${r.status} ${r.body?.message ?? r.text.slice(0, 120)}` };
  }

  async chargeTokenized(_a: TokenizedChargeArgs): Promise<PaymentResult> { throw new Error('xendit: e-wallet account linking is not used'); }
  async authorizeCard(_a: PreauthArgs): Promise<PaymentResult> { throw new Error('xendit: card pre-authorisation is not used'); }
  async captureCard(_a: CaptureArgs): Promise<PaymentResult> { throw new Error('xendit: card pre-authorisation is not used'); }
}
