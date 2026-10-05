import type { CurrencyCode } from '@/api/types';

/**
 * Money formatting, matching the server's `domain/money.ts`:
 *   - amounts travel as integers in PlugSure minor units: IDR exponent 0 (whole rupiah), MYR / SGD exponent 2;
 *   - always currency-explicit (`Rp`, `RM`, `S$`), never converted (no FX, spec §1.4.7);
 *   - Indonesian grouping (`Rp 12.345`, `RM 1,50` in id) vs English (`Rp 12,345`, `RM 1.50`).
 * Implemented without Intl currency formatting so output is identical on Hermes, web and Node (tests).
 */
export const CURRENCY: Record<CurrencyCode, { exponent: number; symbol: string }> = {
  IDR: { exponent: 0, symbol: 'Rp' },
  MYR: { exponent: 2, symbol: 'RM' },
  SGD: { exponent: 2, symbol: 'S$' },
};

export function isCurrency(x: unknown): x is CurrencyCode {
  return x === 'IDR' || x === 'MYR' || x === 'SGD';
}

type Lang = string;
const separators = (lang: Lang) => (lang === 'id' ? { group: '.', point: ',' } : { group: ',', point: '.' });

function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function fixed(n: number, decimals: number): string {
  // toFixed on a value nudged by epsilon so 1.005 → "1.01" (half-up like the server's decimal rounding).
  const f = Math.abs(n) + Number.EPSILON * Math.max(1, Math.abs(n));
  return f.toFixed(decimals);
}

export interface MoneyOptions {
  /** Omit the symbol (tables with a currency header). */
  symbol?: boolean;
  /** Show "+"/"-" explicitly for refunds and credits. */
  signed?: boolean;
}

/** `formatMoney(12345, 'IDR', 'id')` → "Rp 12.345"; `formatMoney(150, 'MYR', 'en')` → "RM 1.50". */
export function formatMoney(minor: number | null | undefined, currency: string | null | undefined, lang: Lang = 'en', opts: MoneyOptions = {}): string {
  if (minor == null || !Number.isFinite(minor)) return '—';
  const cur = isCurrency(currency) ? currency : 'IDR';
  const { exponent, symbol } = CURRENCY[cur];
  const major = minor / 10 ** exponent;
  const [i, f] = fixed(major, exponent).split('.');
  const { group: g, point } = separators(lang);
  const body = f ? `${group(i!, g)}${point}${f}` : group(i!, g);
  const sign = major < 0 ? '-' : opts.signed && major > 0 ? '+' : '';
  return opts.symbol === false ? `${sign}${body}` : `${sign}${symbol} ${body}`;
}

/**
 * A per-kWh / per-minute RATE in MAJOR units (rates are decimals: RM 0.4550/kWh needs fractions of a sen).
 * IDR: whole rupiah, never decimals (Rp 2.467 for 2,466.78: the rupiah has no minor unit in circulation; the receipt
 * carries the exact amounts). MYR / SGD: 2–4 decimals (RM 0.4550/kWh needs fractions of a sen).
 */
export function formatRate(major: number | null | undefined, currency: string | null | undefined, lang: Lang = 'en'): string {
  if (major == null || !Number.isFinite(major)) return '—';
  const cur = isCurrency(currency) ? currency : 'IDR';
  const { symbol } = CURRENCY[cur];
  const minD = cur === 'IDR' ? 0 : 2;
  const maxD = cur === 'IDR' ? 0 : 4;
  let s = fixed(major, maxD);
  // Trim trailing zeros down to the minimum decimals.
  if (s.includes('.')) {
    let [i, f] = s.split('.') as [string, string];
    while (f.length > minD && f.endsWith('0')) f = f.slice(0, -1);
    s = f.length ? `${i}.${f}` : i;
  }
  const [i, f] = s.split('.');
  const { group: g, point } = separators(lang);
  const body = f ? `${group(i!, g)}${point}${f}` : group(i!, g);
  return `${major < 0 ? '-' : ''}${symbol} ${body}`;
}

/** Major units typed by the driver (e.g. "12.50" for RM) → minor units; null if not a valid positive amount. */
export function parseAmount(text: string, currency: CurrencyCode, lang: Lang = 'en'): number | null {
  const { exponent } = CURRENCY[currency];
  const { group: g, point } = separators(lang);
  let t = text.trim().replace(/\s/g, '');
  if (!t) return null;
  t = t.split(g).join('');
  if (point !== '.') t = t.replace(point, '.');
  if (!/^\d+(\.\d*)?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  if (f.length > exponent) return null;
  const v = Number(i) * 10 ** exponent + Number((f + '0'.repeat(exponent)).slice(0, exponent) || '0');
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** Totals per currency — history never adds rupiah to ringgit (spec §6.9). */
export function totalsByCurrency<T extends { currency?: string | null; totalMinor?: number | null; energyKwh?: number | null }>(
  items: T[],
): { currency: CurrencyCode; totalMinor: number; kwh: number; count: number }[] {
  const map = new Map<CurrencyCode, { currency: CurrencyCode; totalMinor: number; kwh: number; count: number }>();
  for (const it of items) {
    if (!isCurrency(it.currency) || it.totalMinor == null) continue;
    const t = map.get(it.currency) ?? { currency: it.currency, totalMinor: 0, kwh: 0, count: 0 };
    t.totalMinor += it.totalMinor;
    t.kwh = Math.round((t.kwh + (it.energyKwh ?? 0)) * 100) / 100;
    t.count += 1;
    map.set(it.currency, t);
  }
  const order: CurrencyCode[] = ['IDR', 'MYR', 'SGD'];
  return order.filter((c) => map.has(c)).map((c) => map.get(c)!);
}

/** The tax label shown next to a price (spec §7: "tax label next to prices"). */
export function taxLabelKey(currency: string | null | undefined, inclusive: boolean): string {
  const cur = isCurrency(currency) ? currency : 'IDR';
  const tax = cur === 'IDR' ? 'ppn' : cur === 'SGD' ? 'gst' : 'sst';
  return `price.tax.${tax}.${inclusive ? 'incl' : 'excl'}`;
}
