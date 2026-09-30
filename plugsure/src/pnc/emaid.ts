/**
 * ISO 15118 / DIN SPEC 91286 eMAID: country (2 letters), provider (3), contract
 * instance (9), optional check character. Stored and compared without
 * separators; shown as CC-PPP-IIIIIIIII[-C].
 */
const EMAID_RE = /^[A-Z]{2}[A-Z0-9]{3}[A-Z0-9]{9}[A-Z0-9]?$/;

export function normaliseEmaid(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const v = s.replace(/[-*\s]/g, '').toUpperCase();
  return EMAID_RE.test(v) ? v : null;
}

export function formatEmaid(v: string): string {
  return v.length >= 14 ? `${v.slice(0, 2)}-${v.slice(2, 5)}-${v.slice(5, 14)}${v.length > 14 ? `-${v.slice(14)}` : ''}` : v;
}
