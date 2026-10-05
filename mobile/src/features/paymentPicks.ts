import type { Channel, PayRequest, QuoteOk } from '@/api/types';
import type { IconName } from '@/components/Icon';

/** A payment choice in the method picker. */
export type Pick = { key: string; label: string; detail?: string; icon: IconName; pay: PayRequest; channel: Channel | 'SAVED' | 'LINKED'; needsPhone?: boolean };

export const METHOD_ICON: Record<string, IconName> = { QRIS: 'qr', PAYNOW: 'qr', CARD: 'card', FPX: 'globe', GOPAY: 'wallet', OVO: 'wallet', DANA: 'wallet', SHOPEEPAY: 'wallet', LINKAJA: 'wallet', GRABPAY: 'wallet' };
/** Country default (spec J1 step 4): ID QRIS, SG PayNow, MY card. */
export const DEFAULT_METHOD: Record<string, Channel> = { IDR: 'QRIS', SGD: 'PAYNOW', MYR: 'CARD' };

export function buildPicks(q: QuoteOk, t: (k: string, o?: Record<string, unknown>) => string): Pick[] {
  const picks: Pick[] = [];
  for (const w of q.linkedWallets) {
    if (q.postpayBlocked && w.postpay) continue;
    picks.push({ key: `w:${w.id}`, label: `${w.channel ?? ''} ${w.accountLabel ?? ''}`.trim(), detail: w.postpay ? t('pay.postpay') : t('pay.linked'), icon: 'wallet', pay: { walletId: w.id }, channel: 'LINKED' });
  }
  for (const card of q.savedCards) {
    picks.push({ key: `c:${card.id}`, label: `${(card.brand ?? t('pay.card')).toUpperCase()} •• ${card.last4 ?? ''}`, detail: q.cardHolds ? t('pay.holdShort') : undefined, icon: 'card', pay: { savedCardId: card.id }, channel: 'SAVED' });
  }
  for (const m of q.paymentMethods) {
    const label = m.channel === 'CARD' ? t('pay.methods.CARD') : t(`pay.methods.${m.channel}`, { defaultValue: m.label });
    const detail = m.channel === 'CARD' ? (q.cardHolds ? t('pay.holdShort') : undefined) : m.method === 'qris' || m.method === 'qr' ? t('pay.scanWithApp') : m.method === 'bank' ? t('pay.bankRedirect') : t('pay.ewalletRedirect');
    picks.push({ key: `m:${m.channel}`, label, detail, icon: METHOD_ICON[m.channel] ?? 'wallet', pay: { method: m.channel, saveCard: m.channel === 'CARD' && q.canSaveCard ? true : undefined }, channel: m.channel, needsPhone: m.channel === 'OVO' });
  }
  return picks;
}
