/**
 * How long after a payment the gateway still refunds it to the payer's own method (v1.15.0; in Finance since v1.12.0).
 *
 * Past the window a refund can only go by bank transfer (or, at Duitku, Disbursement). The figures are the gateways'
 * published limits; the gateway decides, so PlugSure only WARNS (the Refunds page, Finance → Refunds & shares due) and still lets a
 * refund be tried: a refusal leaves it 'failed', payable by bank transfer as before.
 *
 *   Xendit   e-wallets: OVO 90 days, DANA 30, ShopeePay 365, LinkAja 30, GoPay 30
 *            QRIS: 7 days (Xendit's QRIS table; a help article says 30 — confirm with Xendit). Partial refunds only
 *            where the issuer allows them (DANA, ShopeePay, OVO; not LinkAja): Xendit answers PARTIAL_REFUND_NOT_SUPPORTED.
 *   Duitku   none: Duitku has no refund API (bank transfer or Disbursement).
 *   others   unknown (null): no warning.
 */
const XENDIT: Record<string, number> = { OVO: 90, DANA: 30, SHOPEEPAY: 365, LINKAJA: 30, GOPAY: 30, QRIS: 7 };

/** Days after the payment the gateway refunds it; null when there is no gateway refund or the limit is unknown. */
export function refundWindowDays(provider: string | null | undefined, channel: string | null | undefined): number | null {
  const ch = String(channel ?? 'QRIS').toUpperCase();
  if (provider === 'xendit') return XENDIT[ch] ?? null;
  return null;
}

/** Days left in the window (negative: closed), or null. Whole days since the payment, as the gateways count. */
export function refundDaysLeft(windowDays: number | null, paidAt: Date | string | null | undefined, now = Date.now()): number | null {
  if (windowDays == null || !paidAt) return null;
  return windowDays - Math.floor((now - new Date(paidAt).getTime()) / 86_400_000);
}

/** A refund whose window closes within this many days is flagged (and listed first). */
export const REFUND_WINDOW_WARN_DAYS = 7;
