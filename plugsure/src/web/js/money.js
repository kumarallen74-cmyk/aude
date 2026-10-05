// Money in the console and the fleet portal (docs/MULTI-COUNTRY-DESIGN.md §D10).
// A copy of formatMoney in src/domain/money.ts, kept identical by
// src/domain/money.test.ts: the currency decides the symbol and the decimals,
// the language the separators. Amounts are integers in PlugSure minor units
// (IDR whole rupiah, MYR sen, SGD cents); rates are decimals in major units.

export const CURRENCIES = Object.freeze({
  IDR: { code: 'IDR', exponent: 0, isoExponent: 2, symbol: 'Rp' },
  MYR: { code: 'MYR', exponent: 2, isoExponent: 2, symbol: 'RM' },
  SGD: { code: 'SGD', exponent: 2, isoExponent: 2, symbol: 'S$' },
});

export const isCurrency = (x) => typeof x === 'string' && Object.prototype.hasOwnProperty.call(CURRENCIES, x);

export function formatMoney(minor, cur, lang = 'en', opts = {}) {
  const u = CURRENCIES[cur];
  if (!u) throw new Error(`unsupported currency ${JSON.stringify(cur)}`);
  const decimals = opts.decimals ?? u.exponent;
  const major = Number(minor) / 10 ** u.exponent;
  const neg = major < 0;
  const fixed = Math.abs(major).toFixed(decimals);
  const [i, f] = fixed.split('.');
  const group = lang === 'id' ? '.' : ',';
  const point = lang === 'id' ? ',' : '.';
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const body = f ? `${grouped}${point}${f}` : grouped;
  const sign = neg ? '-' : '';
  return opts.symbol === false ? `${sign}${body}` : `${sign}${u.symbol} ${body}`;
}

/** BCP 47 tags of the console's and receipts' languages (domain/locale.ts). */
export const LOCALE_TAG = Object.freeze({ id: 'id-ID', en: 'en-GB' });

/** The legacy currency (every pre-1.7 row), and its v1.6 text "Rp 12.345" (also for negatives: "Rp -12"). */
export const LEGACY_CURRENCY = 'IDR';
const nfLegacy = new Intl.NumberFormat('id-ID');
export const legacyMoney = (n) => `Rp ${nfLegacy.format(Math.round(Number(n)))}`;
const nfLegacyRate = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });

/**
 * Money in the console: rupiah exactly as v1.6 wrote it, any other currency in English
 * (RM 12.34, S$ 12.34). '—' for nothing. An unknown currency is shown as rupiah would be
 * never: it is named instead (fail visibly, not silently).
 */
export function moneyText(n, cur = LEGACY_CURRENCY) {
  if (n == null || n === '') return '—';
  const c = cur || LEGACY_CURRENCY;
  if (c === LEGACY_CURRENCY) return legacyMoney(n);
  if (!isCurrency(c)) return `${c} ${Math.round(Number(n))}`;
  return formatMoney(Math.round(Number(n)), c, 'en');
}

/** A rate per kWh or minute, in major units: "Rp 2.466,5", "RM 0.4550", "S$ 0.65". */
export function rateText(major, cur = LEGACY_CURRENCY) {
  if (major == null || major === '') return '—';
  const c = cur || LEGACY_CURRENCY;
  if (c === LEGACY_CURRENCY) return `Rp ${nfLegacyRate.format(Number(major))}`;
  if (!isCurrency(c)) return `${c} ${major}`;
  const u = CURRENCIES[c];
  const dec = (String(major).split('.')[1] ?? '').length;
  return formatMoney(Number(major) * 10 ** u.exponent, c, 'en', { decimals: Math.min(u.exponent + 2, Math.max(u.exponent, dec)) });
}

/** WIB, WITA, WIT, MYT, SGT (domain/timezone.ts tzLabel); any other zone by its name. */
const TZ_LABEL = { 'Asia/Jakarta': 'WIB', 'Asia/Pontianak': 'WIB', 'Asia/Makassar': 'WITA', 'Asia/Jayapura': 'WIT', 'Asia/Kuala_Lumpur': 'MYT', 'Asia/Kuching': 'MYT', 'Asia/Singapore': 'SGT' };
export const tzLabel = (tz) => TZ_LABEL[tz] ?? tz;

/** Countries (domain/country.ts): currency, time zones (first = default), whether consumer prices include tax. */
export const COUNTRIES = Object.freeze({
  ID: { code: 'ID', name: 'Indonesia', currency: 'IDR', timezones: ['Asia/Jakarta', 'Asia/Pontianak', 'Asia/Makassar', 'Asia/Jayapura'], displayPricesInclTax: false, taxScheme: 'ID_PKP', phoneExample: '+62 812 3456 7890', taxName: 'PPN (PKP)' },
  MY: { code: 'MY', name: 'Malaysia', currency: 'MYR', timezones: ['Asia/Kuala_Lumpur', 'Asia/Kuching'], displayPricesInclTax: true, taxScheme: 'MY_SST', phoneExample: '+60 12 345 6789', taxName: 'Service tax (SST)' },
  SG: { code: 'SG', name: 'Singapore', currency: 'SGD', timezones: ['Asia/Singapore'], displayPricesInclTax: true, taxScheme: 'SG_GST', phoneExample: '+65 8123 4567', taxName: 'GST' },
});
export const countryCurrency = (cc) => COUNTRIES[cc]?.currency ?? LEGACY_CURRENCY;

/** Minor units to major (12345 sen → 123.45). */
export const toMajor = (minor, cur) => Number(minor) / 10 ** (CURRENCIES[cur]?.exponent ?? 0);

/** Major units (a form field, "12.34") to minor units, half-up; NaN when it is not a number. */
export function toMinor(major, cur) {
  const exp = CURRENCIES[cur]?.exponent ?? 0;
  const n = Number(String(major ?? '').trim().replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 10 ** exp) : NaN;
}
