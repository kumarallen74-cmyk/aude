import { COUNTRIES, type CountryCode } from './country.js';

/**
 * Mobile numbers of the countries PlugSure operates in, to E.164 (§WP2 identity):
 *   ID  +62 8xxxxxxxxx      (11–15 digits with the country code)
 *   MY  +60 1xxxxxxxx(x)    (^601\d{8,9}$)
 *   SG  +65 8xxxxxxx / 9…   (^65[89]\d{7}$)
 * A number with its country code (with or without +) is read as that country's; a
 * local number (0…, or a bare mobile prefix) as `defaultCountry`'s. Anything else is
 * refused rather than guessed: two spellings of one number must never be two accounts.
 */
const MOBILE: Record<CountryCode, RegExp> = {
  ID: /^628\d{8,12}$/,
  MY: /^601\d{8,9}$/,
  SG: /^65[89]\d{7}$/,
};

export function normaliseMobile(raw: string, defaultCountry: CountryCode = 'ID'): string | null {
  const s = String(raw ?? '').replace(/[^\d+]/g, '');
  if (!s) return null;
  const plus = s.startsWith('+');
  const d = s.replace(/[^\d]/g, '');
  const tryAll = (n: string) => (Object.keys(MOBILE) as CountryCode[]).some((c) => MOBILE[c].test(n)) ? `+${n}` : null;
  if (plus) return tryAll(d);
  const cc = COUNTRIES[defaultCountry].phoneCc;
  // Local forms of the default country.
  if (defaultCountry === 'ID') {
    if (d.startsWith('62')) return tryAll(d);
    if (d.startsWith('0')) return MOBILE.ID.test(`62${d.slice(1)}`) ? `+62${d.slice(1)}` : null;
    if (d.startsWith('8')) return MOBILE.ID.test(`62${d}`) ? `+62${d}` : null;
    return tryAll(d);
  }
  if (defaultCountry === 'MY') {
    if (d.startsWith('0')) return MOBILE.MY.test(`${cc}${d.slice(1)}`) ? `+${cc}${d.slice(1)}` : null;
    if (d.startsWith('1') && MOBILE.MY.test(`${cc}${d}`)) return `+${cc}${d}`;
    return tryAll(d);
  }
  // SG: no trunk prefix; an 8-digit mobile is local.
  if (/^[89]\d{7}$/.test(d)) return `+${cc}${d}`;
  return tryAll(d);
}

/**
 * Any phone number (a support line may be a landline) to E.164, local forms read as
 * `defaultCountry`'s: Indonesia and Malaysia drop the trunk 0 (021 555 0100 → +62 21 555 0100),
 * Singapore has none (6555 0100 → +65 6555 0100). Shape-checked only (8–15 digits).
 */
export function phoneToE164(raw: string, defaultCountry: CountryCode = 'ID'): string | null {
  const s = String(raw ?? '').replace(/[\s().-]/g, '');
  if (!s) return null;
  const cc = COUNTRIES[defaultCountry].phoneCc;
  const e164 = s.startsWith('+') ? s
    : defaultCountry !== 'SG' && s.startsWith('0') ? `+${cc}${s.slice(1)}`
    : s.startsWith(cc) ? `+${s}`
    : defaultCountry === 'SG' && /^\d{8}$/.test(s) ? `+${cc}${s}`
    : s;
  return /^\+\d{8,15}$/.test(e164) ? e164 : null;
}
