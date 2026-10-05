import type { ReceiptLine } from '@/api/types';

type T = (key: string) => string;

const KINDS = new Set(['energy', 'session', 'admin', 'idle', 'time']);

/**
 * The label of a receipt line. Hosted receipts carry the rated tariff line (`kind`, an English `description`, no
 * `label`); partner receipts and the demo backend carry a `label`. Same rules as the web app's receipt (lineName).
 */
export function receiptLineLabel(l: ReceiptLine, t: T): string {
  if (typeof l.label === 'string' && l.label.trim()) return l.label;
  if (l.adjustment) return l.adjustment.source === 'v2x' ? t('receipt.line.v2x') : (l.description ?? '');
  if (l.amountMinor < 0) return t('receipt.line.cap');
  if (l.kind === 'energy' && l.touBlock && l.touBlock !== 'ANY') return t(l.touBlock === 'WBP' ? 'receipt.line.energyPeak' : 'receipt.line.energyOffPeak');
  if (l.kind && KINDS.has(l.kind)) return t(`receipt.line.${l.kind}`);
  return l.description ?? l.key ?? '';
}
