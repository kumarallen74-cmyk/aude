import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { CHANNELS } from './provider.js';
import type {
  Channel, Checkout, CheckoutArgs, HoldArgs, HoldResult, SavedCardCharge, SavedCardChargeArgs,
  WalletChargeArgs, WalletLink, WalletLinkArgs, WalletLinkStatus,
  PaymentNotification,
  CaptureArgs,
  CreateQrisChargeArgs,
  PaymentProvider,
  PaymentResult,
  PreauthArgs,
  QrisCharge,
  RefundArgs,
  RefundResult,
  TokenizedChargeArgs,
} from './provider.js';

/**
 * Sandbox provider. Behaves like a real PJP — asynchronous webhook confirmation,
 * signature verification, idempotency — so integration code written against it
 * does not need rewriting when Xendit or Midtrans is wired in.
 *
 * Replace with:
 *   src/services/payments/xendit.ts    e-wallet tokenisation + xenPlatform splits
 *   src/services/payments/midtrans.ts  QRIS, VA (Rp 4,000 flat), card pre-auth
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  /** Sandbox notifications are {providerRef, status}: no amount, and no real money. */
  readonly unverifiedAmounts = true;
  readonly demo = true;
  private charges = new Map<string, QrisCharge>();

  constructor(private secret = 'sandbox-webhook-secret') {}

  async createQrisCharge(a: CreateQrisChargeArgs): Promise<QrisCharge> {
    const providerRef = `mock_qr_${randomUUID().slice(0, 12)}`;
    const expiresAt = new Date(Date.now() + (a.expiresInS ?? 900) * 1000).toISOString();
    const charge: QrisCharge = {
      providerRef,
      // Not a valid EMVCo payload — a placeholder the sandbox UI can render.
      qrString: `00020101021226${providerRef}5802ID5910PLUGSURE6007JAKARTA54${a.amountIdr}`,
      amountIdr: a.amountIdr,
      expiresAt,
      status: 'pending',
    };
    this.charges.set(providerRef, charge);
    return charge;
  }

  channels(): Channel[] { return [...CHANNELS]; }
  canRefund(): boolean { return true; }

  /** Sandbox e-wallet / card: the driver completes it on PlugSure's own test checkout page (development only). */
  async createCheckout(a: CheckoutArgs): Promise<Checkout> {
    const providerRef = `mock_${a.channel.toLowerCase()}_${randomUUID().slice(0, 12)}`;
    return {
      providerRef, action: a.channel === 'OVO' ? 'push' : 'redirect',
      checkoutUrl: `/pay/sandbox/${providerRef}?return=${encodeURIComponent(a.returnUrl)}`,
      expiresAt: new Date(Date.now() + (a.expiresInS ?? 900) * 1000).toISOString(),
    };
  }

  cardFeatures() { return { holds: true, savedCards: true }; }

  /** Sandbox saved card: completes at once (no 3-D Secure), as a hold or a sale. */
  async chargeSavedCard(a: SavedCardChargeArgs): Promise<SavedCardCharge> {
    const providerRef = `mock_card_${randomUUID().slice(0, 12)}`;
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    if (!a.token.startsWith('mock_tok_')) return { providerRef, status: 'failed', checkoutUrl: null, expiresAt, message: 'not a sandbox card' };
    return { providerRef, providerPaymentId: `sandbox-${providerRef}`, status: a.preauth ? 'authorised' : 'captured', checkoutUrl: null, expiresAt };
  }

  // ---- linked e-wallets: approved on the sandbox link page (development only)
  private links = new Map<string, { channel: Channel; status: 'pending' | 'active' | 'failed'; phone: string }>();
  linkableWallets(): Channel[] { return ['GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA']; }
  async linkWallet(a: WalletLinkArgs): Promise<WalletLink> {
    const linkRef = `mock_link_${randomUUID().slice(0, 12)}`;
    this.links.set(linkRef, { channel: a.channel, status: 'pending', phone: a.phone });
    return { linkRef, status: 'pending', activationUrl: `/pay/sandbox/link/${linkRef}?return=${encodeURIComponent(a.returnUrl)}` };
  }
  /** The sandbox link page's answer. */
  sandboxLink(linkRef: string, approve: boolean): boolean {
    const l = this.links.get(linkRef);
    if (!l || l.status !== 'pending') return false;
    l.status = approve ? 'active' : 'failed';
    return true;
  }
  sandboxLinkInfo(linkRef: string) { return this.links.get(linkRef) ?? null; }
  async walletStatus(linkRef: string): Promise<WalletLinkStatus> {
    const l = this.links.get(linkRef);
    if (!l) return { status: 'failed', message: 'unknown sandbox link (the API restarted?)' };
    return l.status === 'active' ? { status: 'active', token: `mock_wallet_${linkRef.slice(10)}` } : { status: l.status };
  }
  async chargeWallet(a: WalletChargeArgs): Promise<SavedCardCharge> {
    const providerRef = `mock_wallet_${randomUUID().slice(0, 12)}`;
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    if (!a.token.startsWith('mock_wallet_')) return { providerRef, status: 'failed', checkoutUrl: null, expiresAt, message: 'not a sandbox link' };
    return { providerRef, providerPaymentId: `sandbox-${providerRef}`, status: 'captured', checkoutUrl: null, expiresAt };
  }
  async unlinkWallet(linkRef: string): Promise<void> { this.links.delete(linkRef); }

  async captureHold(a: HoldArgs): Promise<HoldResult> { return a.amountIdr > 0 ? { ok: true } : { ok: false, error: 'amount must be positive' }; }
  async releaseHold(_a: Omit<HoldArgs, 'amountIdr'>): Promise<HoldResult> { return { ok: true }; }

  /** Sandbox helper: simulate the driver paying. */
  async simulatePayment(providerRef: string): Promise<QrisCharge | null> {
    const c = this.charges.get(providerRef);
    if (!c) return null;
    c.status = 'paid';
    return c;
  }

  async chargeTokenized(a: TokenizedChargeArgs): Promise<PaymentResult> {
    // Tokenisation does not guarantee funds — a driver can link a zero-balance
    // wallet. Real implementations must risk-score by history, cap unsecured
    // session value for new users, and degrade to prepay after a failed charge.
    return { providerRef: `mock_tok_${randomUUID().slice(0, 12)}`, status: 'captured', amountIdr: a.amountIdr };
  }

  async authorizeCard(a: PreauthArgs): Promise<PaymentResult> {
    return { providerRef: `mock_auth_${randomUUID().slice(0, 12)}`, status: 'authorised', amountIdr: a.amountIdr };
  }

  async captureCard(a: CaptureArgs): Promise<PaymentResult> {
    // Capture may be lower than authorised, never higher.
    return { providerRef: a.providerRef, status: 'captured', amountIdr: a.amountIdr };
  }

  private refunds = new Map<string, RefundResult>();

  /** Sandbox refund: idempotent on the key, like a real PJP refund endpoint. */
  async refund(a: RefundArgs): Promise<RefundResult> {
    const prior = this.refunds.get(a.idempotencyKey);
    if (prior) return prior;
    if (!(a.amountIdr > 0)) return { status: 'failed', refundRef: '', raw: { error: 'amount must be positive' } };
    const r: RefundResult = { status: 'refunded', refundRef: `mock_rf_${randomUUID().slice(0, 12)}` };
    this.refunds.set(a.idempotencyKey, r);
    return r;
  }

  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  /** Sandbox notification: {"providerRef": …, "status": "paid"} signed with x-plugsure-signature. */
  parseNotification(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentNotification | null {
    if (!this.verifyWebhook(rawBody, headers)) return null;
    let j: any;
    try { j = JSON.parse(rawBody); } catch { return null; }
    if (!j?.providerRef) return null;
    return { providerRef: String(j.providerRef), paid: j.status === 'paid', status: String(j.status ?? ''), amountIdr: j.amountIdr != null ? Number(j.amountIdr) : null };
  }

  notificationAck(ok: boolean) { return { status: ok ? 200 : 401, body: ok ? { ok: true } : { error: 'invalid signature' } }; }

  async testConnection() { return { ok: true, message: 'Sandbox acquirer: nothing to connect to. Payments are confirmed with the demo button.' }; }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
    const given = String(headers['x-plugsure-signature'] ?? '');
    const expect = this.sign(rawBody);
    if (given.length !== expect.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(expect));
  }
}
