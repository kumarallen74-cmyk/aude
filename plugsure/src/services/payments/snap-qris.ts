import { createHash, createHmac, createSign, createVerify, randomBytes, randomUUID } from 'node:crypto';
import {
  providerFetch,
  type CaptureArgs, type Channel, type CreateQrisChargeArgs, type PaymentNotification, type PaymentProvider, type PaymentResult,
  type PreauthArgs, type QrisCharge, type TokenizedChargeArgs,
} from './provider.js';

/**
 * BANK-DIRECT QRIS via BI-SNAP (Standar Nasional Open API Pembayaran).
 * ==================================================================
 * Accepting QRIS directly through a bank (BRI, BCA, Mandiri, BNI, …) instead of
 * an aggregator. SNAP standardises the request/response shape across banks; the
 * base URL, a few paths and some field names differ per bank — they are
 * settings (Integrations → QRIS payments → Bank direct).
 *
 * Flow (QRIS Merchant-Presented Mode, dynamic):
 *   1. access token   POST {accessTokenPath}, X-SIGNATURE = RSA-SHA256(`${clientId}|${timestamp}`)
 *                     with YOUR private key (the bank holds your public key)
 *   2. generate QR    POST {generateQrPath}, X-SIGNATURE = HMAC-SHA512(clientSecret,
 *                     `${method}:${path}:${accessToken}:${sha256hex(minified body)}:${timestamp}`)
 *   3. notification   the bank POSTs to the webhook URL shown in Integrations. It
 *                     signs asymmetrically with ITS private key:
 *                     X-SIGNATURE = RSA-SHA256(`POST:${path}:${sha256hex(minified body)}:${timestamp}`),
 *                     verified with the bank's public key. Paid = latestTransactionStatus '00'.
 *
 * Timestamps are ISO-8601 with the +07:00 offset. Confirm every path and field
 * in the bank's SNAP sandbox before production. Refunds are by bank transfer
 * (Refunds page) unless the bank offers a refund API.
 */
export interface SnapQrisConfig {
  baseUrl: string;
  partnerId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
  bankPublicKeyPem: string;
  merchantId: string;
  terminalId?: string;
  channelId?: string;
  paths?: { accessToken?: string; generateQr?: string };
}

const jakartaIso = (ms = Date.now()): string => new Date(ms + 7 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+07:00');
const sha256LowerHex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').toLowerCase();

export class SnapQrisProvider implements PaymentProvider {
  readonly name = 'snap';
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private cfg: SnapQrisConfig) {}

  private paths() {
    return {
      accessToken: this.cfg.paths?.accessToken || '/v1.0/access-token/b2b',
      generateQr: this.cfg.paths?.generateQr || '/v1.0/qr/qr-mpm-generate',
    };
  }
  private base() { return this.cfg.baseUrl.replace(/\/+$/, ''); }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const timestamp = jakartaIso();
    const signature = createSign('RSA-SHA256').update(`${this.cfg.clientId}|${timestamp}`).sign(this.cfg.privateKeyPem, 'base64');
    const r = await providerFetch(this.base() + this.paths().accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CLIENT-KEY': this.cfg.clientId, 'X-TIMESTAMP': timestamp, 'X-SIGNATURE': signature },
      body: JSON.stringify({ grantType: 'client_credentials' }),
    });
    const j = r.body ?? {};
    if (r.status >= 300 || !j.accessToken) throw new Error(`SNAP access token failed: ${r.status} ${j.responseCode ?? ''} ${j.responseMessage ?? ''}`.trim());
    this.token = { value: j.accessToken, expiresAt: Date.now() + Number(j.expiresIn ?? 900) * 1000 };
    return j.accessToken;
  }

  private txSignature(method: string, path: string, accessToken: string, body: string, timestamp: string): string {
    return createHmac('sha512', this.cfg.clientSecret).update(`${method}:${path}:${accessToken}:${sha256LowerHex(body)}:${timestamp}`).digest('base64');
  }

  async createQrisCharge(a: CreateQrisChargeArgs): Promise<QrisCharge> {
    const accessToken = await this.getAccessToken();
    const path = this.paths().generateQr;
    const timestamp = jakartaIso();
    const validForS = a.expiresInS ?? 900;
    // partnerReferenceNo: ours, alphanumeric; it is what the notification names.
    const partnerReferenceNo = `PS${randomBytes(12).toString('hex').toUpperCase()}`;
    const body = JSON.stringify({
      partnerReferenceNo,
      amount: { value: a.amountIdr.toFixed(2), currency: 'IDR' },
      merchantId: this.cfg.merchantId,
      ...(this.cfg.terminalId ? { terminalId: this.cfg.terminalId } : {}),
      validityPeriod: jakartaIso(Date.now() + validForS * 1000),
    });
    const r = await providerFetch(this.base() + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'X-TIMESTAMP': timestamp,
        'X-SIGNATURE': this.txSignature('POST', path, accessToken, body, timestamp), 'X-PARTNER-ID': this.cfg.partnerId,
        'X-EXTERNAL-ID': randomUUID().replace(/-/g, '').slice(0, 32), 'CHANNEL-ID': this.cfg.channelId ?? '',
      },
      body,
    });
    const j = r.body ?? {};
    if (r.status >= 300 || !j.qrContent || !String(j.responseCode ?? '').endsWith('00')) {
      throw new Error(`SNAP generate QR failed: ${r.status} ${j.responseCode ?? ''} ${j.responseMessage ?? ''}`.trim());
    }
    return { providerRef: partnerReferenceNo, qrString: j.qrContent, amountIdr: a.amountIdr, expiresAt: new Date(Date.now() + validForS * 1000).toISOString(), status: 'pending' };
  }

  /** The bank's notification, verified with the bank's public key over the SNAP string-to-sign. */
  parseNotification(rawBody: string, headers: Record<string, string | string[] | undefined>, path: string): PaymentNotification | null {
    const h = (k: string) => String(headers[k.toLowerCase()] ?? '');
    const signature = h('X-SIGNATURE');
    const timestamp = h('X-TIMESTAMP');
    if (!signature || !timestamp) return null;
    let j: any;
    try { j = JSON.parse(rawBody); } catch { return null; }
    const minified = JSON.stringify(j);
    const ok = (() => {
      try { return createVerify('RSA-SHA256').update(`POST:${path}:${sha256LowerHex(minified)}:${timestamp}`).verify(this.cfg.bankPublicKeyPem, signature, 'base64'); } catch { return false; }
    })();
    if (!ok) return null;
    const ref = j.originalPartnerReferenceNo ?? j.partnerReferenceNo;
    if (!ref) return null;
    const st = String(j.latestTransactionStatus ?? j.transactionStatusDesc ?? '');
    return { providerRef: String(ref), paid: st === '00', status: st, amountIdr: j.amount?.value != null ? Math.round(Number(j.amount.value)) : null, paymentId: j.originalReferenceNo ? String(j.originalReferenceNo) : undefined };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    return this.parseNotification(rawBody, headers, '/v1.0/qr/qr-mpm-notify') !== null;
  }
  notificationAck(ok: boolean) {
    return ok ? { status: 200, body: { responseCode: '2005200', responseMessage: 'Successful' } } : { status: 401, body: { responseCode: '4015200', responseMessage: 'Unauthorized. Invalid signature' } };
  }

  async testConnection() {
    try {
      this.token = null;
      await this.getAccessToken();
      return { ok: true, message: 'The bank issued an access token: the client key and your private key are accepted.' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  channels(): Channel[] { return ['QRIS']; }

  async chargeTokenized(_a: TokenizedChargeArgs): Promise<PaymentResult> { throw new Error('snap: e-wallet tokenisation is not offered by a bank QRIS rail'); }
  async authorizeCard(_a: PreauthArgs): Promise<PaymentResult> { throw new Error('snap: card pre-auth is not offered by a bank QRIS rail'); }
  async captureCard(_a: CaptureArgs): Promise<PaymentResult> { throw new Error('snap: card capture is not offered by a bank QRIS rail'); }
}
