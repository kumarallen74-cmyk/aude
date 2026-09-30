import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  providerFetch,
  type CaptureArgs, type Channel, type Checkout, type CheckoutArgs, type CreateQrisChargeArgs, type PaymentNotification, type PaymentProvider, type PaymentResult,
  type PreauthArgs, type QrisCharge, type RefundArgs, type RefundResult, type TokenizedChargeArgs,
  type HoldArgs, type HoldResult, type SavedCardCharge, type SavedCardChargeArgs, cardBrand, last4Of,
  type WalletChargeArgs, type WalletLink, type WalletLinkArgs, type WalletLinkStatus, WalletLinkEnded,
} from './provider.js';

/**
 * Midtrans Core API — QRIS.
 *
 *   charge        POST {base}/v2/charge   { payment_type: 'qris', transaction_details, qris: { acquirer } }
 *   notification  Midtrans POSTs JSON to the Payment Notification URL (the
 *                 webhook URL shown in Integrations). Verified with
 *                 signature_key = SHA-512(order_id + status_code + gross_amount + server_key).
 *                 Paid = transaction_status 'settlement' (or 'capture' + fraud_status 'accept').
 *   refund        POST {base}/v2/{order_id}/refund { refund_key, amount, reason }
 *   status        GET  {base}/v2/{order_id}/status  (used to test the key)
 *   GoPay         POST {base}/v2/charge   { payment_type: 'gopay', gopay: { enable_callback, callback_url } }
 *                 → the 'deeplink-redirect' action opens the GoPay app
 *   ShopeePay     POST {base}/v2/charge   { payment_type: 'shopeepay', shopeepay: { callback_url } }
 *   cards         Snap: POST {snap}/snap/v1/transactions { enabled_payments: ['credit_card'], credit_card: { secure: true } }
 *                 → redirect_url, Midtrans' hosted card page with 3-D Secure. Paid = 'capture' + fraud 'accept'.
 *                 Snap: https://app.sandbox.midtrans.com (sandbox), https://app.midtrans.com (production).
 *
 *   card holds    Snap credit_card.type 'authorize' → notification transaction_status 'authorize';
 *                 POST {base}/v2/capture { transaction_id, gross_amount } takes up to the hold,
 *                 POST {base}/v2/{order_id}/cancel releases it.
 *   saved cards   Snap credit_card.save_card + user_id → the notification carries saved_token_id
 *                 (and masked_card); later POST {base}/v2/charge payment_type credit_card with
 *                 credit_card.token_id = saved_token_id (Midtrans One Click: ask Midtrans to enable
 *                 it on the merchant account). With authentication: true the driver passes 3-D Secure
 *                 again (redirect_url); without, the charge completes at once.
 *
 *   linked GoPay  GoPay Tokenization: POST {base}/v2/pay/account { payment_type: 'gopay', gopay_partner:
 *                 { phone_number, country_code: '62', redirect_url } } → account_id + an activation link the
 *                 driver approves in GoPay; GET {base}/v2/pay/account/{id} → ENABLED with the
 *                 GOPAY_WALLET (else GOPAY_SAVINGS, never PAY_LATER) payment option token, looked
 *                 up again before every charge as Midtrans asks; POST {base}/v2/charge payment_type gopay with
 *                 gopay { account_id, payment_option_token } charges it (settlement at once, or a PIN
 *                 verification link); POST {base}/v2/pay/account/{id}/unbind unlinks.
 *
 * Authentication: HTTP Basic, the server key as user name and no password.
 * Base URLs: https://api.sandbox.midtrans.com (sandbox), https://api.midtrans.com (production).
 */
export interface MidtransConfig {
  environment: 'sandbox' | 'production';
  serverKey: string;
  acquirer?: string;
  baseUrl?: string;
  /** Saved cards: ask 3-D Secure again on every payment (default true). */
  savedCard3ds?: boolean;
}

/** Midtrans reports times in Jakarta time without an offset ("2027-12-31 07:00:00"). */
const jakartaIso = (s: string): string | null => { const d = new Date(s.replace(' ', 'T') + '+07:00'); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

export class MidtransProvider implements PaymentProvider {
  readonly name = 'midtrans';
  constructor(private cfg: MidtransConfig) {}

  private base() { return (this.cfg.baseUrl || (this.cfg.environment === 'production' ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com')).replace(/\/+$/, ''); }
  private headers() {
    return { Authorization: 'Basic ' + Buffer.from(`${this.cfg.serverKey}:`).toString('base64'), Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  async createQrisCharge(a: CreateQrisChargeArgs): Promise<QrisCharge> {
    // order_id: letters, digits, - _ . ~ and at most 50 characters. It is the reference notifications carry.
    const orderId = `ps-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const minutes = Math.max(1, Math.round((a.expiresInS ?? 900) / 60));
    const r = await providerFetch(`${this.base()}/v2/charge`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({
        payment_type: 'qris',
        transaction_details: { order_id: orderId, gross_amount: Math.round(a.amountIdr) },
        qris: { acquirer: this.cfg.acquirer || 'gopay' },
        custom_expiry: { expiry_duration: minutes, unit: 'minute' },
        ...(a.description ? { item_details: [{ id: 'charging', price: Math.round(a.amountIdr), quantity: 1, name: a.description.slice(0, 50) }] } : {}),
      }),
    });
    const j = r.body ?? {};
    if (String(j.status_code) !== '201' || !j.qr_string) {
      throw new Error(`Midtrans QRIS charge failed: ${j.status_code ?? r.status} ${j.status_message ?? r.text.slice(0, 200)}`);
    }
    return { providerRef: orderId, qrString: j.qr_string, amountIdr: a.amountIdr, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(), status: 'pending' };
  }

  /** The signature Midtrans puts on a notification. */
  signature(orderId: string, statusCode: string, grossAmount: string): string {
    return createHash('sha512').update(`${orderId}${statusCode}${grossAmount}${this.cfg.serverKey}`).digest('hex');
  }

  parseNotification(rawBody: string): PaymentNotification | null {
    let j: any;
    try { j = JSON.parse(rawBody); } catch { return null; }
    if (!j?.order_id || !j.signature_key || j.status_code == null || j.gross_amount == null) return null;
    const expect = this.signature(String(j.order_id), String(j.status_code), String(j.gross_amount));
    const given = String(j.signature_key);
    if (given.length !== expect.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expect))) return null;
    const st = String(j.transaction_status ?? '');
    const accepted = (j.fraud_status ?? 'accept') === 'accept';
    const paid = st === 'settlement' || (st === 'capture' && accepted);
    const authorised = st === 'authorize' && accepted;
    // A card saved at the driver's request: Midtrans' token, and the masked number for display.
    const savedCard = (paid || authorised) && j.saved_token_id
      ? { token: String(j.saved_token_id), brand: cardBrand(j.masked_card), last4: last4Of(j.masked_card), tokenExpiresAt: j.saved_token_id_expired_at ? jakartaIso(String(j.saved_token_id_expired_at)) : null }
      : undefined;
    return { providerRef: String(j.order_id), paid, authorised, status: st, amountIdr: Math.round(Number(j.gross_amount)), paymentId: j.transaction_id ? String(j.transaction_id) : undefined, ...(savedCard ? { savedCard } : {}) };
  }

  verifyWebhook(rawBody: string): boolean { return this.parseNotification(rawBody) !== null; }
  notificationAck(ok: boolean) { return { status: ok ? 200 : 401, body: ok ? { status: 'ok' } : { error: 'invalid signature' } }; }

  async refund(a: RefundArgs): Promise<RefundResult> {
    const r = await providerFetch(`${this.base()}/v2/${encodeURIComponent(a.providerRef)}/refund`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ refund_key: a.idempotencyKey.slice(0, 50), amount: Math.round(a.amountIdr), reason: a.reason.slice(0, 100) }),
    });
    const j = r.body ?? {};
    if (String(j.status_code) === '200') return { status: 'refunded', refundRef: String(j.refund_key ?? a.idempotencyKey), raw: j };
    return { status: 'failed', refundRef: '', raw: { status_code: j.status_code ?? r.status, message: j.status_message ?? r.text.slice(0, 200) } };
  }

  async testConnection() {
    const r = await providerFetch(`${this.base()}/v2/plugsure-connection-test-${Date.now()}/status`, { headers: this.headers() });
    const code = String(r.body?.status_code ?? r.status);
    if (code === '404') return { ok: true, message: `Server key accepted by Midtrans ${this.cfg.environment}.` };
    if (code === '401') return { ok: false, message: 'Midtrans refused the server key (401). Check the key and the environment (sandbox keys start with SB-).' };
    return { ok: false, message: `Unexpected answer from Midtrans: ${code} ${r.body?.status_message ?? r.text.slice(0, 120)}` };
  }

  channels(): Channel[] { return ['QRIS', 'GOPAY', 'SHOPEEPAY', 'CARD']; }
  canRefund(): boolean { return true; }
  private snapBase() { return (this.cfg.baseUrl || (this.cfg.environment === 'production' ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com')).replace(/\/+$/, ''); }

  async createCheckout(a: CheckoutArgs): Promise<Checkout> {
    const orderId = `ps-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const minutes = Math.max(1, Math.round((a.expiresInS ?? 900) / 60));
    const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
    const details = { order_id: orderId, gross_amount: Math.round(a.amountIdr) };
    if (a.channel === 'CARD') {
      const r = await providerFetch(`${this.snapBase()}/snap/v1/transactions`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({
          transaction_details: details, enabled_payments: ['credit_card'],
          credit_card: { secure: true, ...(a.preauth ? { type: 'authorize' } : {}), ...(a.saveCard ? { save_card: true } : {}) },
          ...(a.saveCard && a.customerId ? { user_id: a.customerId } : {}),
          callbacks: { finish: a.returnUrl }, expiry: { unit: 'minutes', duration: minutes },
        }),
      });
      if (r.status >= 300 || !r.body?.redirect_url) throw new Error(`Midtrans card checkout failed: ${r.status} ${(r.body?.error_messages ?? []).join('; ') || r.text.slice(0, 200)}`);
      return { providerRef: orderId, action: 'redirect', checkoutUrl: r.body.redirect_url, expiresAt };
    }
    if (a.channel !== 'GOPAY' && a.channel !== 'SHOPEEPAY') throw new Error(`Midtrans does not offer ${a.channel} here`);
    const body = a.channel === 'GOPAY'
      ? { payment_type: 'gopay', transaction_details: details, gopay: { enable_callback: true, callback_url: a.returnUrl }, custom_expiry: { expiry_duration: minutes, unit: 'minute' } }
      : { payment_type: 'shopeepay', transaction_details: details, shopeepay: { callback_url: a.returnUrl }, custom_expiry: { expiry_duration: minutes, unit: 'minute' } };
    const r = await providerFetch(`${this.base()}/v2/charge`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    const j = r.body ?? {};
    const url = (j.actions ?? []).find((x: any) => x.name === 'deeplink-redirect')?.url;
    if (String(j.status_code) !== '201' || !url) throw new Error(`Midtrans ${a.channel} charge failed: ${j.status_code ?? r.status} ${j.status_message ?? r.text.slice(0, 200)}`);
    return { providerRef: orderId, action: 'redirect', checkoutUrl: url, expiresAt, providerPaymentId: j.transaction_id };
  }

  cardFeatures() { return { holds: true, savedCards: true }; }

  /** A saved card (One Click): a hold or a sale on its token; 3-D Secure again when configured. */
  async chargeSavedCard(a: SavedCardChargeArgs): Promise<SavedCardCharge> {
    const orderId = `ps-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const r = await providerFetch(`${this.base()}/v2/charge`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({
        payment_type: 'credit_card',
        transaction_details: { order_id: orderId, gross_amount: Math.round(a.amountIdr) },
        credit_card: {
          token_id: a.token, authentication: this.cfg.savedCard3ds !== false, ...(a.preauth ? { type: 'authorize' } : {}),
          ...(this.cfg.savedCard3ds !== false ? { callback_url: a.returnUrl } : {}),
        },
        customer_details: { customer_id: a.customerId },
      }),
    });
    const j = r.body ?? {};
    const code = String(j.status_code ?? r.status);
    const accepted = (j.fraud_status ?? 'accept') === 'accept';
    if (code === '201' && j.redirect_url) return { providerRef: orderId, providerPaymentId: j.transaction_id, status: 'pending', checkoutUrl: j.redirect_url, expiresAt };
    if (code === '200' && accepted && (j.transaction_status === 'authorize' || j.transaction_status === 'capture')) {
      return { providerRef: orderId, providerPaymentId: j.transaction_id, status: j.transaction_status === 'authorize' ? 'authorised' : 'captured', checkoutUrl: null, expiresAt };
    }
    // 411 "Token id is missing, invalid, or timed out": the saved card's token no longer works (expired or deleted).
    return { providerRef: orderId, providerPaymentId: j.transaction_id, status: 'failed', checkoutUrl: null, expiresAt, message: `${code} ${j.status_message ?? (j.validation_messages ?? []).join('; ') ?? r.text.slice(0, 200)}`.trim(), ...(code === '411' ? { linkEnded: true } : {}) };
  }

  linkableWallets(): Channel[] { return ['GOPAY']; }

  async linkWallet(a: WalletLinkArgs): Promise<WalletLink> {
    if (a.channel !== 'GOPAY') throw new Error(`Midtrans links GoPay only, not ${a.channel}`);
    const local = a.phone.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
    const r = await providerFetch(`${this.base()}/v2/pay/account`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ payment_type: 'gopay', gopay_partner: { phone_number: local, country_code: '62', redirect_url: a.returnUrl } }),
    });
    const j = r.body ?? {};
    if (!['200', '201'].includes(String(j.status_code)) || !j.account_id) throw new Error(`Midtrans GoPay linking failed: ${j.status_code ?? r.status} ${j.status_message ?? r.text.slice(0, 200)}`);
    const pick = (n: string) => (j.actions ?? []).find((x: any) => x.name === n)?.url;
    const url = pick('activation-deeplink') ?? pick('activation-link-url') ?? pick('activation-link-app') ?? null;
    const status = j.account_status === 'ENABLED' ? 'active' : j.account_status === 'PENDING' ? 'pending' : 'failed';
    return { linkRef: String(j.account_id), status, activationUrl: url, ...(status === 'active' ? { token: await this.gopayToken(String(j.account_id)) ?? undefined } : {}) };
  }

  /** The GoPay wallet's payment option token of an enabled account, as account id + token. */
  private async gopayToken(accountId: string): Promise<string | null> {
    const s = await this.walletStatus(accountId);
    return s.token ?? null;
  }

  /**
   * The GoPay option a session is charged from: the GoPay wallet, else GoPay Tabungan
   * (GOPAY_SAVINGS). Never PAY_LATER: that is credit, not a balance the driver holds.
   */
  private static gopayOption(account: any): { name: string; token: string; balance: number | null } | null {
    const opts: any[] = account?.metadata?.payment_options ?? [];
    for (const name of ['GOPAY_WALLET', 'GOPAY_SAVINGS']) {
      const o = opts.find((x) => x?.name === name && x.active !== false && x.token);
      if (o) {
        const v = Number(o.balance?.value);
        return { name, token: String(o.token), balance: o.balance?.value != null && Number.isFinite(v) ? Math.floor(v) : null };
      }
    }
    return null;
  }

  /** Get Pay Account: the account's state and its current options (tokens can change, e.g. on an upgrade to Tabungan). */
  private async payAccount(accountId: string): Promise<{ status: number; body: any } | null> {
    const r = await providerFetch(`${this.base()}/v2/pay/account/${encodeURIComponent(accountId)}`, { headers: this.headers() }).catch(() => null);
    return r ? { status: r.status, body: r.body ?? {} } : null;
  }

  async walletStatus(linkRef: string): Promise<WalletLinkStatus> {
    const r = await providerFetch(`${this.base()}/v2/pay/account/${encodeURIComponent(linkRef)}`, { headers: this.headers() });
    const j = r.body ?? {};
    if (r.status >= 300 && !j.account_status) return { status: 'pending', message: `${j.status_code ?? r.status} ${j.status_message ?? ''}`.trim() };
    if (j.account_status === 'ENABLED') {
      const opt = MidtransProvider.gopayOption(j);
      if (!opt) return { status: 'pending', message: 'enabled but no GoPay wallet or Tabungan option yet' };
      return { status: 'active', token: JSON.stringify({ accountId: linkRef, token: opt.token }) };
    }
    if (j.account_status === 'PENDING') return { status: 'pending' };
    return { status: 'failed', message: String(j.account_status ?? 'unknown') };
  }

  async chargeWallet(a: WalletChargeArgs): Promise<SavedCardCharge> {
    const orderId = `ps-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    let t: { accountId: string; token: string };
    try { t = JSON.parse(a.token); } catch { return { providerRef: orderId, status: 'failed', checkoutUrl: null, expiresAt, message: 'the GoPay link is damaged; link it again' }; }
    // Midtrans: call Get Pay Account before every payment, because the option token can change.
    // If the lookup itself fails, fall back to the token stored at link time.
    const acct = await this.payAccount(t.accountId);
    let token = t.token;
    if (acct?.body?.account_status) {
      if (acct.body.account_status !== 'ENABLED') {
        const ended = ['DISABLED', 'EXPIRED'].includes(acct.body.account_status);
        return { providerRef: orderId, status: 'failed', checkoutUrl: null, expiresAt, message: `the GoPay link is ${String(acct.body.account_status).toLowerCase()}; link it again`, ...(ended ? { linkEnded: true } : {}) };
      }
      const opt = MidtransProvider.gopayOption(acct.body);
      if (!opt) return { providerRef: orderId, status: 'failed', checkoutUrl: null, expiresAt, message: 'the linked GoPay account has no active wallet or Tabungan option' };
      token = opt.token;
    }
    const r = await providerFetch(`${this.base()}/v2/charge`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({
        payment_type: 'gopay', transaction_details: { order_id: orderId, gross_amount: Math.round(a.amountIdr) },
        gopay: { account_id: t.accountId, payment_option_token: token, callback_url: a.returnUrl },
      }),
    });
    const j = r.body ?? {};
    const code = String(j.status_code ?? r.status);
    if (code === '200' && j.transaction_status === 'settlement') return { providerRef: orderId, providerPaymentId: j.transaction_id, status: 'captured', checkoutUrl: null, expiresAt };
    const verify = (j.actions ?? []).find((x: any) => /verification/.test(String(x.name)))?.url;
    if (code === '201' && verify) return { providerRef: orderId, providerPaymentId: j.transaction_id, status: 'pending', checkoutUrl: verify, expiresAt };
    return { providerRef: orderId, providerPaymentId: j.transaction_id, status: 'failed', checkoutUrl: null, expiresAt, message: `${code} ${j.status_message ?? r.text.slice(0, 160)}`.trim() };
  }

  /**
   * GoPay Tokenization reports the balance per option (checked before a post-pay session).
   * This is the balance of the option the session will be charged from (wallet, else
   * Tabungan); PAY_LATER is ignored. A link disabled in GoPay or expired throws
   * WalletLinkEnded, so the driver is told to link again.
   */
  async walletBalance(token: string): Promise<number | null> {
    let t: { accountId: string };
    try { t = JSON.parse(token); } catch { return null; }
    const acct = await this.payAccount(t.accountId);
    const status = acct?.body?.account_status;
    if (status === 'DISABLED' || status === 'EXPIRED') throw new WalletLinkEnded(status);
    return MidtransProvider.gopayOption(acct?.body)?.balance ?? null;
  }

  async unlinkWallet(linkRef: string): Promise<void> {
    await providerFetch(`${this.base()}/v2/pay/account/${encodeURIComponent(linkRef)}/unbind`, { method: 'POST', headers: this.headers() });
  }

  /** Take up to the hold; Midtrans releases the rest. */
  async captureHold(a: HoldArgs): Promise<HoldResult> {
    if (!a.providerPaymentId) return { ok: false, error: 'the Midtrans transaction id of the hold is unknown (its notification never arrived)' };
    const r = await providerFetch(`${this.base()}/v2/capture`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ transaction_id: a.providerPaymentId, gross_amount: Math.round(a.amountIdr) }),
    });
    const j = r.body ?? {};
    if (String(j.status_code) === '200' && (j.transaction_status ?? 'capture') === 'capture') return { ok: true, raw: j };
    // 407 "Expired transaction": the authorisation lapsed before this capture.
    const expired = String(j.status_code) === '407' || j.transaction_status === 'expire';
    return { ok: false, error: `${j.status_code ?? r.status} ${j.status_message ?? r.text.slice(0, 200)}`.trim(), raw: j, ...(expired ? { expired: true } : {}) };
  }

  async releaseHold(a: Omit<HoldArgs, 'amountIdr'>): Promise<HoldResult> {
    const r = await providerFetch(`${this.base()}/v2/${encodeURIComponent(a.providerRef)}/cancel`, { method: 'POST', headers: this.headers() });
    const j = r.body ?? {};
    // 412: already cancelled / expired; 407: expired — nothing is held any more.
    if (['200', '412', '407'].includes(String(j.status_code))) return { ok: true, raw: j, ...(String(j.status_code) === '407' ? { expired: true } : {}) };
    return { ok: false, error: `${j.status_code ?? r.status} ${j.status_message ?? r.text.slice(0, 200)}`.trim(), raw: j };
  }

  async chargeTokenized(_a: TokenizedChargeArgs): Promise<PaymentResult> { throw new Error('midtrans: not used for QRIS'); }
  async authorizeCard(_a: PreauthArgs): Promise<PaymentResult> { throw new Error('midtrans: not used for QRIS'); }
  async captureCard(_a: CaptureArgs): Promise<PaymentResult> { throw new Error('midtrans: not used for QRIS'); }
}
