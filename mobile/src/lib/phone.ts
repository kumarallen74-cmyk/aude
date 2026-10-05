/** Phone numbers for OTP sign-in (spec §6.10): Indonesia, Malaysia, Singapore. */
export type PhoneCountry = 'ID' | 'MY' | 'SG';

export const PHONE_COUNTRIES: Record<PhoneCountry, { dial: string; flag: string; example: string; min: number; max: number }> = {
  ID: { dial: '62', flag: '🇮🇩', example: '812 3456 7890', min: 9, max: 12 },
  MY: { dial: '60', flag: '🇲🇾', example: '12 345 6789', min: 9, max: 10 },
  SG: { dial: '65', flag: '🇸🇬', example: '8123 4567', min: 8, max: 8 },
};

/** Local digits typed by the driver → E.164 (`+62812…`), or null when it cannot be a mobile number there. */
export function toE164(country: PhoneCountry, typed: string): string | null {
  const c = PHONE_COUNTRIES[country];
  let d = typed.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) {
    d = d.slice(1);
    if (!d.startsWith(c.dial)) return null;
    d = d.slice(c.dial.length);
  } else if (d.startsWith('00' + c.dial)) d = d.slice(2 + c.dial.length);
  else if (d.startsWith(c.dial) && d.length > c.max) d = d.slice(c.dial.length);
  d = d.replace(/^0+/, '');
  if (d.length < c.min || d.length > c.max) return null;
  if (country === 'ID' && !d.startsWith('8')) return null;
  if (country === 'MY' && !d.startsWith('1')) return null;
  if (country === 'SG' && !/^[89]/.test(d)) return null;
  return `+${c.dial}${d}`;
}

/** "+6281234567890" → "+62 812-3456-7890" style, for display. */
export function formatPhone(e164: string): string {
  const m = e164.match(/^\+(62|60|65)(\d+)$/);
  if (!m) return e164;
  const [, cc, rest] = m;
  const groups = rest!.match(/.{1,4}/g) ?? [rest!];
  return `+${cc} ${groups.join(' ')}`;
}

export function countryForRegion(region: string | null | undefined): PhoneCountry {
  return region === 'MY' || region === 'SG' ? region : 'ID';
}
