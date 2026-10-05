/**
 * Languages of the driver app, receipts and messages (docs/MULTI-COUNTRY-DESIGN.md §D10):
 * Indonesian and English this phase (Malay and Chinese later: add a dictionary and a
 * tag here). The BCP 47 tag decides date and number formats; money goes through
 * domain/money.ts (formatMoney), whose separators follow the same language.
 */
export type Lang = 'id' | 'en';

export const LANGS: readonly Lang[] = ['id', 'en'];

/** The Intl locale for a language: Indonesian dates and numbers, British English (day month year, 24-hour). */
export const LOCALE_TAG: Readonly<Record<Lang, string>> = Object.freeze({ id: 'id-ID', en: 'en-GB' });

export function isLang(x: unknown): x is Lang {
  return x === 'id' || x === 'en';
}

/** A language from a stored choice, else the fallback (a country's or brand's default). */
export function langOr(x: unknown, fallback: Lang): Lang {
  return isLang(x) ? x : fallback;
}

/**
 * The driver app's language (§D10): the driver's stored choice → the device's language →
 * the brand's default (MY/SG brands: English) → Indonesian.
 */
export function pickLang(stored: unknown, deviceLanguages: readonly string[] | null | undefined, brandDefault: unknown): Lang {
  if (isLang(stored)) return stored;
  for (const l of deviceLanguages ?? []) {
    const base = String(l).toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return langOr(brandDefault, 'id');
}
