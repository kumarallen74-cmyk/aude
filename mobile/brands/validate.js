// @ts-check
/**
 * Build-time validation of a brand file (plain CommonJS: app.config.ts loads it in Node without a TS loader).
 * @typedef {import('./brand').Brand} Brand
 */
const REQUIRED = ['variant', 'appName', 'easSlug', 'brandSlug', 'scope', 'scheme', 'iosBundleId', 'androidPackage', 'linkHosts', 'apiBase', 'accentColor', 'badgeColor', 'defaultLocale', 'features'];

/**
 * Throws with a readable message when a brand file is incomplete (fails the build early, not in store review).
 * @param {Record<string, unknown>} b
 * @param {string} [file]
 * @returns {Brand}
 */
function validateBrand(b, file = 'brand') {
  const missing = REQUIRED.filter((k) => b[k] === undefined || b[k] === '');
  if (missing.length) throw new Error(`${file}: missing ${missing.join(', ')}`);
  if (!/^#[0-9a-f]{6}$/i.test(String(b.accentColor))) throw new Error(`${file}: accentColor must be #rrggbb`);
  if (!/^#[0-9a-f]{6}$/i.test(String(b.badgeColor))) throw new Error(`${file}: badgeColor must be #rrggbb`);
  if (!/^[a-z][a-z0-9+.-]*$/.test(String(b.scheme))) throw new Error(`${file}: scheme must be a lowercase URL scheme`);
  // The server honours the payment return only for <brandSlug>://paid (spec §15.12): the scheme IS the slug.
  if (b.scheme !== b.brandSlug) throw new Error(`${file}: scheme must equal brandSlug (the server allows <brandSlug>://paid as the payment return)`);
  if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(String(b.iosBundleId))) throw new Error(`${file}: invalid iosBundleId`);
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(String(b.androidPackage))) throw new Error(`${file}: invalid androidPackage`);
  if (b.scope !== 'network' && b.scope !== 'operator') throw new Error(`${file}: scope must be network or operator`);
  return /** @type {Brand} */ (/** @type {unknown} */ (b));
}

module.exports = { validateBrand };
