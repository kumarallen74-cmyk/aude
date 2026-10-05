/**
 * Money: the only place that knows currency exponents, rounding, provider
 * units and formatting (docs/MULTI-COUNTRY-DESIGN.md §D2).
 *
 * Every stored amount is an INTEGER in PlugSure's unit for its currency plus a
 * `currency` next to it. PlugSure's unit is `10^-exponent` of the major unit:
 *
 *   IDR  exponent 0  whole rupiah (what every pre-1.7 row holds; ISO says 2)
 *   MYR  exponent 2  sen
 *   SGD  exponent 2  cents
 *
 * Rates (per kWh, per minute) stay DECIMAL in major units — RM 0.4550/kWh needs
 * fractions of a sen — and a line amount is round(quantity × rate × 10^exp).
 * Rounding is Math.round (half toward +∞) exactly as the Indonesian engine has
 * always done, so IDR results are unchanged.
 */

export type CurrencyCode = 'IDR' | 'MYR' | 'SGD';

export interface CurrencyUnit {
  code: CurrencyCode;
  /** PlugSure storage exponent (minor unit = 10^-exponent major). */
  exponent: number;
  /** ISO 4217 exponent (what a provider's "minor unit" means). */
  isoExponent: number;
  symbol: string;
}

export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyUnit>> = Object.freeze({
  IDR: { code: 'IDR', exponent: 0, isoExponent: 2, symbol: 'Rp' },
  MYR: { code: 'MYR', exponent: 2, isoExponent: 2, symbol: 'RM' },
  SGD: { code: 'SGD', exponent: 2, isoExponent: 2, symbol: 'S$' },
});

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

export interface Money {
  currency: CurrencyCode;
  minor: number;
}

export function isCurrency(x: unknown): x is CurrencyCode {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(CURRENCIES, x);
}

/** The unit of a currency; throws on an unknown code (fail closed). */
export function unitOf(cur: string): CurrencyUnit {
  if (!isCurrency(cur)) throw new Error(`unsupported currency ${JSON.stringify(cur)}`);
  return CURRENCIES[cur];
}

/** The currency of every row and JSON object written before 1.7 (an absent `currency`). */
export const LEGACY_CURRENCY: CurrencyCode = 'IDR';

/** A currency code read from a row or JSON; absent means IDR (every pre-1.7 row). */
export function currencyOr(x: unknown, fallback: CurrencyCode = 'IDR'): CurrencyCode {
  if (x == null || x === '') return fallback;
  return unitOf(String(x)).code;
}

/**
 * Major units (a number or a decimal string such as "12.345") to PlugSure minor
 * units, half-up on the first dropped digit. Decimal-string based so 1.005 MYR is
 * 101 sen, not the 100 that binary floating point gives.
 */
export function toMinor(major: number | string, cur: CurrencyCode): number {
  const exp = unitOf(cur).exponent;
  let s = typeof major === 'number' ? numberToPlainString(major) : String(major).trim();
  if (!/^[-+]?\d*(\.\d*)?$/.test(s) || s === '' || s === '.' || s === '-' || s === '+') {
    throw new Error(`not a decimal amount: ${JSON.stringify(major)}`);
  }
  let neg = false;
  if (s[0] === '-' || s[0] === '+') {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  const [intPart = '0', frac = ''] = s.split('.');
  const kept = (frac + '0'.repeat(exp)).slice(0, exp);
  const next = Number(frac.charAt(exp) || '0');
  let v = Number((intPart || '0') + kept);
  if (next >= 5) v += 1;
  // Half-up for the magnitude; negative amounts mirror Math.round's toward-+∞ only
  // where it matters (a refund line), which is never fractional in practice.
  return neg ? -v : v;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite amount: ${n}`);
  // Up to 12 significant decimals, never exponent notation.
  const s = n.toFixed(12);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** PlugSure minor units to major units (a JS number; OCPI wants ≤ 4 decimals). */
export function toMajor(minor: number, cur: CurrencyCode): number {
  const exp = unitOf(cur).exponent;
  if (exp === 0) return Number(minor);
  return Number((Number(minor) / 10 ** exp).toFixed(exp));
}

/** A finite number as an integer scaled by 10^scale, half-up on the dropped digits (decimal, not binary, rounding). */
export function toScaled(n: number, scale: number): bigint {
  let s = numberToPlainString(n);
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [i = '0', f = ''] = s.split('.');
  let v = BigInt((i || '0') + (f + '0'.repeat(scale)).slice(0, scale));
  if (Number(f.charAt(scale) || '0') >= 5) v += 1n;
  return neg ? -v : v;
}

/** Quantities are exact to 10^-9 units (Wh/1000, minutes), rates to 10^-6 (tariff rates are NUMERIC(14,4)). */
const QTY_SCALE = 9, RATE_SCALE = 6;

/**
 * The amount for `qty` units at `rateMajor` per unit, in minor units, rounded half-up (toward +∞ at .5, as Math.round).
 *  - IDR (exponent 0): exactly the pre-1.7 `Math.round(kwh * rate)`, byte for byte (the golden cases depend on it).
 *  - MYR / SGD: integer arithmetic on the decimal values — qty × rate × 10^exp with no binary floating point, so
 *    1.005 kWh at RM 1.00 is 101 sen and 12.345 kWh at S$ 0.65 is 802 cents (8.02425 → 802), never off by a cent.
 */
export function amountForRate(qty: number, rateMajor: number, cur: CurrencyCode): number {
  const exp = unitOf(cur).exponent;
  if (exp === 0) return Math.round(qty * rateMajor);
  const num = toScaled(qty, QTY_SCALE) * toScaled(rateMajor, RATE_SCALE) * 10n ** BigInt(exp);
  const den = 10n ** BigInt(QTY_SCALE + RATE_SCALE);
  // floor((num + den/2) / den), with floor division for negatives (Math.round semantics).
  const x = num * 2n + den;
  const d = den * 2n;
  const q = x >= 0n ? x / d : -((-x + d - 1n) / d);
  return Number(q);
}

/** A per-unit rate in major units expressed in minor units (not rounded). */
export function rateToMinor(rateMajor: number, cur: CurrencyCode): number {
  const exp = unitOf(cur).exponent;
  return exp === 0 ? rateMajor : rateMajor * 10 ** exp;
}

export const roundMinor = (x: number): number => Math.round(x);

/** Sum amounts that must all be in `cur`; a mixed list is an error, never a silent total. */
export function sum(list: Array<Money | null | undefined>, cur: CurrencyCode): Money {
  let minor = 0;
  for (const m of list) {
    if (!m) continue;
    if (m.currency !== cur) throw new Error(`cannot add ${m.currency} to ${cur}`);
    minor += Number(m.minor);
  }
  return { currency: cur, minor };
}

export type MoneyLang = 'id' | 'en';

export interface FormatOpts {
  /** Omit the symbol (a table column that states the currency once). */
  symbol?: boolean;
  /** Fraction digits to show; default the currency's PlugSure exponent. */
  decimals?: number;
}

/**
 * "Rp 12.345" (id) / "Rp 12,345" (en) / "RM 12,34" (id) / "RM 12.34" (en) /
 * "S$ 12.34". The currency decides the symbol and the decimals; the language
 * decides the separators. Byte-identical copy in web/js/money.js.
 */
export function formatMoney(minor: number, cur: CurrencyCode, lang: MoneyLang = 'en', opts: FormatOpts = {}): string {
  const u = unitOf(cur);
  const decimals = opts.decimals ?? u.exponent;
  const major = Number(minor) / 10 ** u.exponent;
  const neg = major < 0;
  const fixed = Math.abs(major).toFixed(decimals);
  const [i, f] = fixed.split('.');
  const group = lang === 'id' ? '.' : ',';
  const point = lang === 'id' ? ',' : '.';
  const grouped = i!.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const body = f ? `${grouped}${point}${f}` : grouped;
  const sign = neg ? '-' : '';
  return opts.symbol === false ? `${sign}${body}` : `${sign}${u.symbol} ${body}`;
}

/**
 * Money in operator / driver MESSAGES: an IDR amount keeps exactly the text v1.6
 * wrote (messages are matched by tests, alerts and the driver app's translation
 * patterns); any other currency is formatMoney in English.
 *   'id'     Rp 12.345        (toLocaleString('id-ID'))
 *   'en'     Rp 12,345        (toLocaleString('en-US'))
 *   'plain'  Rp 12345
 *   'rate'   Rp 2.467,5       (id-ID, up to 2 decimals: a per-kWh price)
 */
export function moneyText(amount: number, cur: CurrencyCode, style: 'id' | 'en' | 'plain' | 'rate' = 'id'): string {
  if (cur !== 'IDR') return formatMoney(amount, cur, 'en');
  if (style === 'plain') return `Rp ${amount}`;
  if (style === 'en') return `Rp ${amount.toLocaleString('en-US')}`;
  if (style === 'rate') return `Rp ${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(amount)}`;
  return `Rp ${amount.toLocaleString('id-ID')}`;
}

/**
 * The amount in a payment provider's unit:
 *  - 'minor': ISO minor units (Stripe: sen/cents; rupiah × 100 for IDR)
 *  - 'major': major units as a number (12.34)
 *  - 'whole': whole major units (Midtrans/Xendit/QRIS rupiah); refuses fractions
 */
export function toProviderAmount(minor: number, cur: CurrencyCode, unit: 'minor' | 'major' | 'whole'): number {
  const u = unitOf(cur);
  if (unit === 'major') return toMajor(minor, cur);
  if (unit === 'minor') return Math.round(Number(minor) * 10 ** (u.isoExponent - u.exponent));
  const major = Number(minor) / 10 ** u.exponent;
  if (!Number.isInteger(major)) throw new Error(`${formatMoney(minor, cur)} is not a whole number of ${cur}`);
  return major;
}

/** The inverse of toProviderAmount for a provider-reported amount. */
export function fromProviderAmount(amount: number, cur: CurrencyCode, unit: 'minor' | 'major' | 'whole'): number {
  const u = unitOf(cur);
  if (unit === 'minor') return Math.round(Number(amount) / 10 ** (u.isoExponent - u.exponent));
  return toMinor(Number(amount), cur);
}

/**
 * Read an amount from an object that may have been frozen before 1.7:
 * `${base}Minor` (new), else `${base}Idr` / `${base}_idr` (legacy), else
 * `${base}_minor`. Returns null when none is present.
 */
export function readMinor(obj: Record<string, any> | null | undefined, base: string): number | null {
  if (!obj) return null;
  const snake = base.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  for (const k of [`${base}Minor`, `${snake}_minor`, `${base}Idr`, `${snake}_idr`]) {
    const v = obj[k];
    if (v != null && v !== '') return Number(v);
  }
  return null;
}

/**
 * Legacy JSON keys (frozen in cdr.lines, invoice data, statement data, commercial
 * plans) → current keys. Every `xIdr` / `x_idr` key becomes `xMinor` / `x_minor`
 * unless the current key is already present; the explicit map covers the tax
 * names that changed (ppnIdr → taxMinor, …). Deep, non-mutating.
 */
export const LEGACY_KEY_MAP: Readonly<Record<string, string>> = Object.freeze({
  ppnDppIdr: 'taxBaseMinor',
  dppIdr: 'taxBaseMinor',
  ppnIdr: 'taxMinor',
  pbjtIdr: 'localTaxMinor',
  taxBaseIdr: 'taxableMinor',
  taxIdr: 'taxTotalMinor',
  pbjtBaseIdr: 'localTaxBaseMinor',
  memberRateIdr: 'memberRate',
  energyRateIdr: 'energyRate',
  creditIdrPerKwh: 'creditMinorPerKwh',
  v2xCreditIdrPerKwh: 'v2xCreditMinorPerKwh',
  pbjtRateBps: 'localTaxRateBps',
  pbjt_rate_bps: 'local_tax_rate_bps',
  ppn_rate_bps: 'tax_rate_bps',
  ppn_dpp_idr: 'tax_base_minor',
  dpp_idr: 'tax_base_minor',
  ppn_idr: 'tax_minor',
  pbjt_idr: 'local_tax_minor',
  tax_base_idr: 'taxable_minor',
  fee_dpp_idr: 'fee_tax_base_minor',
  fee_ppn_idr: 'fee_tax_minor',
  member_rate_idr: 'member_rate',
  v2x_credit_idr_per_kwh: 'v2x_credit_minor_per_kwh',
});

/** Keys that end in Idr but are not amounts in a row's currency (left alone). */
const NOT_MONEY = new Set(['estimateQrisMdrIdr', 'postpayLimitIdr']);

export function modernKey(k: string): string | null {
  if (NOT_MONEY.has(k)) return null;
  const mapped = LEGACY_KEY_MAP[k];
  if (mapped) return mapped;
  if (/^[a-z][A-Za-z0-9]*Idr$/.test(k)) return k.slice(0, -3) + 'Minor';
  if (/^[a-z][a-z0-9_]*_idr$/.test(k)) return k.slice(0, -4) + '_minor';
  return null;
}

export function upgradeLegacyKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => upgradeLegacyKeys(x)) as unknown as T;
  if (!v || typeof v !== 'object' || v instanceof Date) return v;
  const out: Record<string, unknown> = {};
  const src = v as Record<string, unknown>;
  for (const [k, x] of Object.entries(src)) {
    const m = modernKey(k);
    if (m && m in src) continue; // the current key wins
    out[m ?? k] = upgradeLegacyKeys(x);
  }
  return out as T;
}
