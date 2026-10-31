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
  /** Disbursement (Transfer Online), optional: the balance in Finance; (v1.15.0) refunds sent and accounts checked by name. */
  disbursementUserId?: string;
  disbursementEmail?: string;
  disbursementSecretKey?: string;
  /** (v1.15.0) Limits on refunds sent through Disbursement, in rupiah: one transfer, and all transfers approved in a day. */
  disbursementMaxPerTransfer?: string | number;
  disbursementMaxPerDay?: string | number;
  /** (v1.16.0) Limits on owner payouts sent through Disbursement: one payout, and all payouts approved in a day. */
  disbursementMaxPayout?: string | number;
  disbursementMaxPayoutPerDay?: string | number;
}

/** Duitku's Disbursement answer to an inquiry: the holder's name the bank has, and the id the transfer must quote. */
export interface DisbursementInquiry { ok: boolean; accountName: string | null; disburseId: string | null; custRefNumber: string | null; responseCode: string; error: string | null }
/** A transfer: paid ('00'), refused, or not known (a timeout or link down: asked again with inquirystatus). */
export interface DisbursementResult { outcome: 'succeeded' | 'failed' | 'unknown'; responseCode: string; error: string | null }

/** Disbursement codes that mean the result is not known yet (Duitku: TO timeout, LD link down, plus no answer). */
const DISB_UNKNOWN = new Set(['TO', 'LD', '']);

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

  /**
   * (v1.18.0) Duitku Disbursement's callback (JSON with a disburseId), set in Duitku's dashboard to this account's
   * notification URL. Its signature scheme is not relied on: it only names the transfer, whose state PlugSure then asks
   * Duitku (inquirystatus). Only with Disbursement set up.
   */
  parsePayoutEvent(rawBody: string): { ref: string; event: string } | null {
    if (!this.hasDisbursement()) return null;
    let j: any;
    try { j = JSON.parse(rawBody); } catch { return null; }
    const id = j?.disburseId;
    return id != null && /^[A-Za-z0-9_-]{1,40}$/.test(String(id)) ? { ref: String(id), event: `disbursement ${String(j.responseCode ?? '')}`.trim() } : null;
  }

  /** (v1.15.0) Disbursement credentials saved: refunds can be sent and accounts checked. */
  hasDisbursement(): boolean { return Boolean(this.cfg.disbursementUserId && this.cfg.disbursementEmail && this.cfg.disbursementSecretKey); }
  disbursementLimits(): { perTransfer: number; perDay: number } {
    const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : d);
    return { perTransfer: n(this.cfg.disbursementMaxPerTransfer, 5_000_000), perDay: n(this.cfg.disbursementMaxPerDay, 25_000_000) };
  }
  /** (v1.16.0) Owner payouts: larger than refunds, with their own daily total. */
  payoutLimits(): { perTransfer: number; perDay: number } {
    const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : d);
    return { perTransfer: n(this.cfg.disbursementMaxPayout, 50_000_000), perDay: n(this.cfg.disbursementMaxPayoutPerDay, 100_000_000) };
  }
  /** Sandbox and production paths differ (inquirysandbox / transfersandbox). */
  private disbPath(op: 'inquiry' | 'transfer') {
    return `${this.base()}/webapi/api/disbursement/${op}${this.cfg.environment === 'production' ? '' : 'sandbox'}`;
  }

  /**
   * (v1.15.0) Disbursement inquiry: the bank's name for the account, and a disburseId for the transfer.
   *   POST {base}/webapi/api/disbursement/inquiry[sandbox]
   *   { userId, amountTransfer, bankAccount, bankCode, email, purpose, timestamp, senderId, senderName,
   *     signature = sha256(email + timestamp + bankCode + bankAccount + amountTransfer + purpose + secretKey) }
   *   → { accountName, disburseId, custRefNumber, responseCode '00', responseDesc }
   * Confirm the field names and signature with Duitku before live traffic (to confirm, deploy/DUITKU.md).
   */
  async disbursementInquiry(a: { bankCode: string; bankAccount: string; amount: number; purpose: string }): Promise<DisbursementInquiry> {
    const { disbursementUserId: userId, disbursementEmail: email, disbursementSecretKey: secret } = this.cfg;
    if (!userId || !email || !secret) return { ok: false, accountName: null, disburseId: null, custRefNumber: null, responseCode: '', error: 'Disbursement is not set up on the Duitku account.' };
    const timestamp = Date.now();
    const amountTransfer = Math.round(a.amount);
    const purpose = a.purpose.slice(0, 40);
    const r = await providerFetch(this.disbPath('inquiry'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: Number(userId), amountTransfer, bankAccount: a.bankAccount, bankCode: a.bankCode, email, purpose, timestamp,
        senderId: Number(userId), senderName: 'PlugSure', signature: sha256(`${email}${timestamp}${a.bankCode}${a.bankAccount}${amountTransfer}${purpose}${secret}`) }),
      timeoutMs: 20_000,
    });
    const j = r.body ?? {};
    const code = String(j.responseCode ?? '');
    if (r.status >= 300 || code !== '00') return { ok: false, accountName: null, disburseId: null, custRefNumber: null, responseCode: code, error: `${j.responseDesc ?? j.Message ?? r.text.slice(0, 160)}`.trim() || `HTTP ${r.status}` };
    return { ok: true, accountName: j.accountName ? String(j.accountName) : null, disburseId: j.disburseId != null ? String(j.disburseId) : null, custRefNumber: j.custRefNumber != null ? String(j.custRefNumber) : null, responseCode: code, error: null };
  }

  /**
   * (v1.15.0) The transfer, quoting the inquiry's disburseId:
   *   POST {base}/webapi/api/disbursement/transfer[sandbox]
   *   { disburseId, userId, email, bankCode, bankAccount, amountTransfer, accountName, custRefNumber, purpose, timestamp,
   *     signature = sha256(email + timestamp + bankCode + bankAccount + accountName + custRefNumber + amountTransfer + purpose + disburseId + secretKey) }
   *   → responseCode '00' paid. No answer, TO or LD: not known (asked with inquirystatus); anything else: refused.
   */
  async disbursementTransfer(a: { bankCode: string; bankAccount: string; amount: number; purpose: string; accountName: string; custRefNumber: string; disburseId: string }): Promise<DisbursementResult> {
    const { disbursementUserId: userId, disbursementEmail: email, disbursementSecretKey: secret } = this.cfg;
    if (!userId || !email || !secret) return { outcome: 'failed', responseCode: '', error: 'Disbursement is not set up on the Duitku account.' };
    const timestamp = Date.now();
    const amountTransfer = Math.round(a.amount);
    const purpose = a.purpose.slice(0, 40);
    let r;
    try {
      r = await providerFetch(this.disbPath('transfer'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disburseId: Number(a.disburseId) || a.disburseId, userId: Number(userId), email, bankCode: a.bankCode, bankAccount: a.bankAccount, amountTransfer,
          accountName: a.accountName, custRefNumber: a.custRefNumber, purpose, timestamp,
          signature: sha256(`${email}${timestamp}${a.bankCode}${a.bankAccount}${a.accountName}${a.custRefNumber}${amountTransfer}${purpose}${a.disburseId}${secret}`) }),
        timeoutMs: 30_000,
      });
    } catch (e) {
      return { outcome: 'unknown', responseCode: '', error: `no answer from Duitku (${(e as Error).message})` };
    }
    const j = r.body ?? {};
    const code = String(j.responseCode ?? '');
    if (code === '00') return { outcome: 'succeeded', responseCode: code, error: null };
    if (r.status >= 500 || DISB_UNKNOWN.has(code)) return { outcome: 'unknown', responseCode: code, error: `${j.responseDesc ?? `HTTP ${r.status}`}` };
    return { outcome: 'failed', responseCode: code, error: `${j.responseDesc ?? j.Message ?? r.text.slice(0, 160)}`.trim() || `HTTP ${r.status}` };
  }

  /**
   * (v1.15.0) Where a transfer stands: POST {base}/webapi/api/disbursement/inquirystatus
   * { disburseId, userId, email, timestamp, signature = sha256(email + timestamp + disburseId + secretKey) } → '00' paid.
   * Only '00' is taken as an outcome: anything else stays not known, for a person to settle after checking Duitku's
   * dashboard (a transfer wrongly taken as failed could be paid twice).
   */
  async disbursementStatus(disburseId: string): Promise<DisbursementResult> {
    const { disbursementUserId: userId, disbursementEmail: email, disbursementSecretKey: secret } = this.cfg;
    if (!userId || !email || !secret) return { outcome: 'unknown', responseCode: '', error: 'Disbursement is not set up on the Duitku account.' };
    const timestamp = Date.now();
    const r = await providerFetch(`${this.base()}/webapi/api/disbursement/inquirystatus`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disburseId: Number(disburseId) || disburseId, userId: Number(userId), email, timestamp, signature: sha256(`${email}${timestamp}${disburseId}${secret}`) }),
      timeoutMs: 15_000,
    });
    const code = String(r.body?.responseCode ?? '');
    return code === '00' ? { outcome: 'succeeded', responseCode: code, error: null } : { outcome: 'unknown', responseCode: code, error: String(r.body?.responseDesc ?? `HTTP ${r.status}`) };
  }

  /**
   * (v1.16.0) What Duitku quotes for each method on the project, for an amount (getpaymentmethod's totalFee), by
   * PlugSure channel. For Finance's method cost comparison; null when Duitku does not answer.
   */
  async quotedFees(amount = 100_000): Promise<Array<{ channel: string; fee: number }> | null> {
    const datetime = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const r = await providerFetch(`${this.base()}/webapi/api/merchant/paymentmethod/getpaymentmethod`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ merchantcode: this.cfg.merchantCode, amount, datetime, signature: sha256(`${this.cfg.merchantCode}${amount}${datetime}${this.cfg.apiKey}`) }),
      timeoutMs: 8_000,
    }).catch(() => null);
    const list = Array.isArray(r?.body?.paymentFee) ? r!.body.paymentFee : null;
    if (!list) return null;
    const byCode = new Map<string, string>(Object.entries(DUITKU_METHOD).map(([ch, code]) => [code as string, ch]));
    byCode.set(this.cfg.qrisMethod || 'SP', 'QRIS');
    return list.flatMap((m: any) => {
      const ch = byCode.get(String(m.paymentMethod));
      const fee = Number(m.totalFee);
      return ch && Number.isFinite(fee) ? [{ channel: ch, fee }] : [];
    });
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
