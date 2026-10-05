import { LEGACY_KEY_MAP, modernKey } from '../domain/money.js';

/**
 * Backward compatibility for the money rename (docs/MULTI-COUNTRY-DESIGN.md §D2, WP1b).
 *
 * v1.7 names every amount `*Minor` / `*_minor` (in the row's currency unit) and the
 * Indonesian tax fields neutrally (taxMinor, localTaxMinor, taxBaseMinor, …). API
 * clients and webhook receivers written against v1.6 read `totalIdr`, `ppnIdr`,
 * `total_idr`, … — so while an amount's currency is IDR (or not stated, which
 * means IDR) the legacy name is added next to the new one, with the same value.
 * Amounts in MYR/SGD get no `*Idr` alias: a rupiah field holding sen would be a
 * silent error in the client. Removed only in a future /v2.
 *
 * Request bodies may still use the legacy names: they are mapped to the current
 * ones (a body naming both with different values is refused).
 */

/** current name → the legacy name(s) v1.6 used for it (beyond the generic Minor→Idr). */
const EXPLICIT: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  for (const [legacy, current] of Object.entries(LEGACY_KEY_MAP)) (m[current] ??= []).push(legacy);
  return m;
})();

/** The legacy names to add for a current key, or [] when it is not a renamed amount. */
export function legacyNamesFor(key: string): string[] {
  const explicit = EXPLICIT[key];
  if (explicit) return explicit;
  if (/^[a-z][A-Za-z0-9]*Minor$/.test(key)) return [key.slice(0, -5) + 'Idr'];
  if (/^[a-z][a-z0-9_]*_minor$/.test(key)) return [key.slice(0, -6) + '_idr'];
  return [];
}

/** A key naming the currency of some amounts beside it (spend_limit_currency, spendLimitCurrency, limitCurrency). */
const OTHER_CURRENCY_KEY = /^[a-z][a-z0-9_]*_currency$|^[a-z][A-Za-z0-9]*Currency$/;

/** Only JSON-shaped objects are walked (never a Buffer, typed array, stream or class instance). */
const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * A copy of `body` with the legacy alias next to every renamed amount in an IDR
 * context. The currency context is the nearest `currency` field up the tree
 * (the object itself first); none means IDR. `added` reports whether any alias
 * was added (for the Deprecation header).
 */
export function addLegacyMoneyAliases<T>(body: T, inherited: string = 'IDR'): { body: T; added: boolean } {
  let added = false;
  const walk = (v: unknown, cur: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, cur));
    if (!isPlain(v)) return v;
    const here = typeof v.currency === 'string' && v.currency ? v.currency : cur;
    // An amount's currency may be named by another key (a card's spend_limit_currency, a limitCurrency): when any
    // of them is not IDR, the object's amounts are not known to be rupiah, so none gets a rupiah alias (fail safe).
    const otherCurrency = Object.entries(v).some(([k, x]) => k !== 'currency' && OTHER_CURRENCY_KEY.test(k) && typeof x === 'string' && x !== '' && x !== 'IDR');
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = walk(x, here);
      if (here !== 'IDR' || otherCurrency) continue;
      if (x !== null && typeof x !== 'number' && typeof x !== 'string') continue;
      for (const legacy of legacyNamesFor(k)) {
        if (legacy in v || legacy in out) continue;
        out[legacy] = x;
        added = true;
      }
    }
    return out;
  };
  return { body: walk(body, inherited) as T, added };
}

/**
 * A live event (/v1/stream, `{ kind, payload }`) as an API client of v1.5 / v1.6 reads it: the bus carries
 * `totalMinor`, `amountMinor`, `capturedMinor`, … with the event's `currency`; for IDR the v1.6 name
 * (`totalIdr`, `amountIdr`, `capturedIdr`, …) is added beside it, as in responses and webhook payloads.
 */
export function liveEventForClient<T>(event: T): T {
  return addLegacyMoneyAliases(event).body;
}

export class LegacyKeyConflict extends Error {
  statusCode = 400;
  constructor(public readonly legacy: string, public readonly current: string) {
    super(`${legacy} and ${current} name the same amount with different values; send ${current} only`);
  }
}

/** A v1.6 rupiah name used for an amount that is not in rupiah (a v1.6 client would send sen as rupiah). */
export class LegacyKeyCurrency extends Error {
  statusCode = 400;
  constructor(public readonly legacy: string, public readonly current: string, public readonly currency: string) {
    super(`${legacy} is a rupiah amount (v1.6), but this amount is in ${currency}: send ${current} in minor units of ${currency}`);
  }
}

/** The non-IDR currency an object names for its amounts (currency, or a *_currency / *Currency sibling), if any. */
function nonIdrCurrencyOf(v: Record<string, unknown>): string | null {
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'currency' || OTHER_CURRENCY_KEY.test(k)) && typeof x === 'string' && x !== '' && x.toUpperCase() !== 'IDR') return x.toUpperCase();
  }
  return null;
}

/**
 * A copy of a request body with legacy keys mapped to the current ones. Throws
 * LegacyKeyConflict when both are present with different values, and LegacyKeyCurrency
 * when a legacy (rupiah) name sits beside a currency that is not IDR. `used` collects the
 * legacy names mapped, so a route can refuse one for a row stored in another currency
 * (assertLegacyRupiah).
 */
export function acceptLegacyMoneyKeys<T>(body: T, used: string[] = []): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isPlain(v)) return v;
    const out: Record<string, unknown> = {};
    const other = nonIdrCurrencyOf(v);
    for (const [k, x] of Object.entries(v)) {
      const m = modernKey(k);
      if (!m) { if (!(k in out)) out[k] = walk(x); continue; }
      if (other) throw new LegacyKeyCurrency(k, m, other);
      used.push(k);
      if (m in v) {
        if (JSON.stringify(v[m]) !== JSON.stringify(x)) throw new LegacyKeyConflict(k, m);
        continue;
      }
      out[m] = walk(x);
    }
    return out;
  };
  return walk(body) as T;
}

export const DEPRECATION_LINK = '</api-docs.html#money>; rel="deprecation"';

/**
 * A route updating a row whose amounts are already in a currency (a card's spending limit in MYR): refuse a v1.6
 * rupiah name the request used for it. `legacyUsed` is what the request hook recorded (req.legacyMoneyKeys).
 */
export function assertLegacyRupiah(legacyUsed: readonly string[] | undefined, legacyNames: readonly string[], rowCurrency: string | null | undefined): void {
  if (!legacyUsed?.length || !rowCurrency || rowCurrency.toUpperCase() === 'IDR') return;
  const hit = legacyUsed.find((k) => legacyNames.includes(k));
  if (hit) throw new LegacyKeyCurrency(hit, modernKey(hit) ?? hit, rowCurrency.toUpperCase());
}
