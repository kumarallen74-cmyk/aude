import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  providerFetch,
  type CaptureArgs, type Channel, type Checkout, type CheckoutArgs, type CreateQrisChargeArgs, type PaymentNotification,
  type PaymentProvider, type PaymentResult, type PreauthArgs, type QrisCharge, type TokenizedChargeArgs,
} from './provider.js';
import type { PaymentStatus } from './registry.js';
import { LEGACY_CURRENCY } from '../../domain/money.js';

/**
 * Duitku (v1.13.0) — the FALLBACK acquirer: used for a new charging payment when the main acquirer (Xendit) does not
 * answer (registry.startPaymentWithFallback). QRIS, DANA, ShopeePay, LinkAja and cards, one payment at a time; no holds,
 * saved cards or linked e-wallets (Duitku's API offers none of them).
 *
 *   payments   POST {base}/webapi/api/merchant/v2/inquiry  { merchantCode, paymentAmount, paymentMethod, merchantOrderId,
 *                 productDetails, email, phoneNumber, customerVaName, callbackUrl, returnUrl, expiryPeriod, signature }
 *                 → { reference, paymentUrl, qrString, statusCode '00' }. QRIS: qrString shown like Xendit's; others: paymentUrl.
 *   callback   form POST to the callback URL (/pay/notify/<key>): merchantCode, amount, merchantOrderId, resultCode
 *                 ('00' paid, '01' failed), reference, signature. Answered 200.
 *   status     POST {base}/webapi/api/merchant/transactionStatus { merchantCode, merchantOrderId, signature }
 *                 → { reference, amount, fee, statusCode '00' paid | '01' pending | '02' failed / expired }
 *   test       POST {base}/webapi/api/merchant/paymentmethod/getpaymentmethod (the methods and fees on the account)
 *   balance    Disbursement (optional, when its credentials are saved): POST {base}/webapi/api/disbursement/checkBalance
 *                 { userId, email, timestamp, signature = sha256(email + timestamp + secretKey) } → { balance, effectiveBalance }
 *   refunds    none by API: refunded by bank transfer from the Refunds page (canRefund false).
 *
 * Signatures (Duitku's official SDK): md5(merchantCode + merchantOrderId + paymentAmount + apiKey) for a payment,
 * md5(merchantCode + merchantOrderId + apiKey) for its status, md5(merchantCode + amount + merchantOrderId + apiKey) on
 * the callback, sha256(merchantCode + amount + datetime + apiKey) for the method list. Duitku's 2026 documentation
 * describes HMAC-SHA256 keyed with the API key over the same fields: the `signature` setting chooses ('md5' default,
 * 'hmac'); confirm with Duitku which the account uses. Base URLs: sandbox https://sandbox.duitku.com, production
 * https://passport.duitku.com.
 */

export interface DuitkuConfig {
  environment: 'sandbox' | 'production';
  merchantCode: string;
  apiKey: string;
  /** The QRIS method code on the account: SP (ShopeePay QRIS) or NQ (Nobu QRIS). */
  qrisMethod?: string;
  signature?: 'md5' | 'hmac';
  /** Where Duitku posts the callback: https://<public host>/pay/notify/<key>. */
  callbackUrl: string;
  baseUrl?: string;
  /** Disbursement (Transfer Online), optional: the balance in Finance. */
  disbursementUserId?: string;
  disbursementEmail?: string;
  disbursementSecretKey?: string;
}

/** PlugSure's channel → Duitku's payment method code. */
export const DUITKU_METHOD: Partial<Record<Channel, string>> = { DANA: 'DA', SHOPEEPAY: 'SA', LINKAJA: 'LA', CARD: 'VC' };

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const same = (a: string, b: string) => {
  const x = Buffer.from(a.toLowerCase()), y = Buffer.from(b.toLowerCase());
  return x.length === y.length && timingSafeEqual(x, y);
};

export class DuitkuProvider implements PaymentProvider {
  readonly name = 'duitku';
  constructor(private cfg: DuitkuConfig) {}

  private base() {
    return (this.cfg.baseUrl || (this.cfg.environment === 'production' ? 'https://passport.duitku.com' : 'https://sandbox.duitku.com')).replace(/\/+$/, '');
  }
  /** The account's signature over the fields (the API key appended for md5, the HMAC key for hmac). */
  sign(fields: string): string {
    return this.cfg.signature === 'hmac' ? createHmac('sha256', this.cfg.apiKey).update(fields, 'utf8').digest('hex') : md5(fields + this.cfg.apiKey);
  }

  /** merchantOrderId for a PlugSure reference: the same reference, the same Duitku order (≤ 50 characters). */
  orderRef(referenceId: string): string { return `ps-${createHash('sha256').update(referenceId, 'utf8').digest('hex').slice(0, 32)}`; }

  channels(): Channel[] { return ['QRIS', 'DANA', 'SHOPEEPAY', 'LINKAJA', 'CARD']; }
  canRefund(): boolean { return false; }
  cardFeatures() { return { holds: false, savedCards: false }; }
  amountLimits(): { minMinor: number; maxMinor?: number } { return { minMinor: 10_000 }; }

  private async inquiry(referenceId: string, amountMinor: number, method: string, a: { description?: string; returnUrl?: string; phone?: string; expiresInS?: number }) {
    const orderId = this.orderRef(referenceId);
    const amount = Math.round(amountMinor);
    const expiryMin = Math.max(1, Math.round((a.expiresInS ?? 900) / 60));
    const r = await providerFetch(`${this.base()}/webapi/api/merchant/v2/inquiry`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        merchantCode: this.cfg.merchantCode, paymentAmount: amount, paymentMethod: method, merchantOrderId: orderId,
        productDetails: (a.description || 'PlugSure charging').slice(0, 255), email: 'payments@plugsure.com', customerVaName: 'PlugSure',
        ...(a.phone ? { phoneNumber: a.phone.replace(/^\+/, '') } : {}),
        callbackUrl: this.cfg.callbackUrl, returnUrl: a.returnUrl ?? this.cfg.callbackUrl, expiryPeriod: expiryMin,
        signature: this.sign(`${this.cfg.merchantCode}${orderId}${amount}`),
      }),
      timeoutMs: 15_000,
    });
    const j = r.body ?? {};
    if (r.status >= 300 || j.statusCode !== '00') {
      throw new Error(`Duitku inquiry failed: ${r.status} ${j.statusCode ?? ''} ${j.statusMessage ?? j.Message ?? r.text.slice(0, 200)}`.trim());
    }
    return { orderId, j, expiresAt: new Date(Date.now() + expiryMin * 60_000).toISOString() };
  }

  async createQrisCharge(a: CreateQrisChargeArgs): Promise<QrisCharge> {
    const { orderId, j, expiresAt } = await this.inquiry(a.referenceId, a.amountMinor, this.cfg.qrisMethod || 'SP', a);
    if (!j.qrString) throw new Error('Duitku inquiry returned no QRIS payload (check the QRIS method code on the account).');
    return { providerRef: orderId, qrString: String(j.qrString), amountMinor: a.amountMinor, expiresAt, status: 'pending' };
  }

  async createCheckout(a: CheckoutArgs): Promise<Checkout> {
    const method = DUITKU_METHOD[a.channel];
    if (!method) throw new Error(`Duitku: ${a.channel} is not offered`);
    if (a.preauth || a.saveCard) throw new Error('Duitku: card holds and saved cards are not offered');
    const { orderId, j, expiresAt } = await this.inquiry(a.referenceId, a.amountMinor, method, { description: a.description, returnUrl: a.returnUrl, phone: a.customerPhone, expiresInS: a.expiresInS });
    if (!j.paymentUrl) throw new Error('Duitku inquiry returned no payment URL.');
    return { providerRef: orderId, action: 'redirect', checkoutUrl: String(j.paymentUrl), expiresAt, providerPaymentId: j.reference ? String(j.reference) : undefined };
  }

  /** The callback's form fields, when its signature is the account's. */
  private callback(rawBody: string): URLSearchParams | null {
    const f = new URLSearchParams(rawBody);
    const code = f.get('merchantCode') ?? '', amount = f.get('amount') ?? '', order = f.get('merchantOrderId') ?? '', sig = f.get('signature') ?? '';
    if (!code || !order || !sig || code !== this.cfg.merchantCode) return null;
    return same(sig, this.sign(`${code}${amount}${order}`)) ? f : null;
  }

  verifyWebhook(rawBody: string): boolean { return this.callback(rawBody) !== null; }

  parseNotification(rawBody: string): PaymentNotification | null {
    const f = this.callback(rawBody);
    if (!f) return null;
    const result = f.get('resultCode') ?? '';
    const amount = Number(f.get('amount'));
    return {
      providerRef: String(f.get('merchantOrderId')), paid: result === '00', status: `resultCode ${result}`,
      amountMinor: Number.isFinite(amount) ? Math.round(amount) : null, paymentId: f.get('reference') ?? undefined, currency: LEGACY_CURRENCY,
    };
  }

  notificationAck(ok: boolean) { return { status: ok ? 200 : 401, body: ok ? 'OK' : { error: 'invalid signature' } }; }

  /** Where a payment stands at Duitku (null: no such order). The fee is kept for Finance (raw.fee). */
  async paymentStatus(providerRef: string): Promise<PaymentStatus | null> {
    const r = await providerFetch(`${this.base()}/webapi/api/merchant/transactionStatus`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ merchantCode: this.cfg.merchantCode, merchantOrderId: providerRef, signature: this.sign(`${this.cfg.merchantCode}${providerRef}`) }),
      timeoutMs: 15_000,
    });
    const j = r.body ?? {};
    if (r.status === 404 || (r.status >= 400 && /not found/i.test(String(j.Message ?? j.statusMessage ?? '')))) return null;
    if (r.status >= 300 || !j.statusCode) throw new Error(`Duitku status failed: ${r.status} ${j.statusMessage ?? j.Message ?? r.text.slice(0, 160)}`.trim());
    const code = String(j.statusCode);
    const amount = Number(j.amount);
    return {
      status: code === '00' ? 'captured' : code === '01' ? 'pending' : 'failed', acquirerStatus: `${code} ${j.statusMessage ?? ''}`.trim(),
      amountMinor: Number.isFinite(amount) ? Math.round(amount) : null, providerPaymentId: j.reference ? String(j.reference) : undefined,
      raw: { reference: j.reference ?? null, amount: j.amount ?? null, fee: j.fee ?? null, statusCode: code },
    };
  }

  /** The Disbursement balance (before and after settlement), when its credentials are saved; null otherwise. */
  async accountBalance(): Promise<{ balance: number; effective: number } | null> {
    const { disbursementUserId: userId, disbursementEmail: email, disbursementSecretKey: secret } = this.cfg;
    if (!userId || !email || !secret) return null;
    const timestamp = Date.now();
    const r = await providerFetch(`${this.base()}/webapi/api/disbursement/checkBalance`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: Number(userId), email, timestamp, signature: sha256(`${email}${timestamp}${secret}`) }),
      timeoutMs: 15_000,
    });
    const j = r.body ?? {};
    const b = Number(j.balance), e = Number(j.effectiveBalance);
    if (r.status >= 300 || !Number.isFinite(b)) throw new Error(`Duitku balance: ${r.status} ${j.responseCode ?? ''} ${j.responseDesc ?? r.text.slice(0, 160)}`.trim());
    return { balance: b, effective: Number.isFinite(e) ? e : b };
  }

  async testConnection() {
    const datetime = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const amount = 10_000;
    const r = await providerFetch(`${this.base()}/webapi/api/merchant/paymentmethod/getpaymentmethod`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ merchantcode: this.cfg.merchantCode, amount, datetime, signature: sha256(`${this.cfg.merchantCode}${amount}${datetime}${this.cfg.apiKey}`) }),
    });
    const methods = Array.isArray(r.body?.paymentFee) ? r.body.paymentFee : null;
    if (r.status === 200 && methods) {
      const codes = methods.map((m: any) => String(m.paymentMethod));
      const qris = this.cfg.qrisMethod || 'SP';
      return {
        ok: true,
        message: `Duitku accepted the merchant code and API key${this.cfg.environment === 'sandbox' ? ' (sandbox)' : ''}: ${codes.length} payment methods on the account${codes.includes(qris) ? '' : `; the QRIS method ${qris} is NOT among them`}.`,
      };
    }
    return { ok: false, message: `Duitku refused: ${r.status} ${r.body?.Message ?? r.body?.statusMessage ?? r.text.slice(0, 160)}`.trim() };
  }

  async chargeTokenized(_a: TokenizedChargeArgs): Promise<PaymentResult> { throw new Error('duitku: linked e-wallets are not offered'); }
  async authorizeCard(_a: PreauthArgs): Promise<PaymentResult> { throw new Error('duitku: card holds are not offered'); }
  async captureCard(_a: CaptureArgs): Promise<PaymentResult> { throw new Error('duitku: card holds are not offered'); }
}
