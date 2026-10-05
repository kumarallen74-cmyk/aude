/**
 * The Content-Security-Policy header of every response from the API process.
 *
 * script-src is 'self' only: an injected <script> or on…= attribute does not run, whatever gets
 * past the escaping (charger vendor strings, partner data and driver names all reach the console).
 * The console, the printable receipts, statements and invoices need nothing else.
 *
 * The driver app (/app, /app/…) keeps the driver's device token in localStorage, so an injected script there could
 * take it. Its page is rendered per request (driver/server.ts) and its inline scripts — the app itself and each
 * brand's settings — carry a fresh per-response nonce: script-src is 'self' 'nonce-…' there (v1.9.1; it was
 * 'unsafe-inline'). The page has no on…= attributes (handlers are assigned in script). Every other /app file (the
 * payment return page, the worker) runs from 'self' only.
 *
 * The API reference (/api-docs.html) is the one page left with inline script ('unsafe-inline').
 * White-label hosts serve only /app and /d/… (deploy/Caddyfile), so no other path needs it.
 */
export function inlineScriptAllowed(url: string): boolean {
  return url.split('?')[0]! === '/api-docs.html';
}

/** The driver app's pages (where a nonce may be set). */
export function isDriverAppPath(url: string): boolean {
  const path = url.split('?')[0]!;
  return path === '/app' || path.startsWith('/app/');
}

/** A nonce is base64 (RFC 7636 §4.1-ish): anything else is not put into the header. */
const NONCE_RE = /^[A-Za-z0-9+/_-]{16,64}={0,2}$/;

/**
 * Stripe's checkout page (/pay/stripe/<ref>/<payment intent>, services/payments/stripe-page.ts): the only page that loads
 * a third-party script — Stripe.js, which must come from js.stripe.com (PCI DSS) — and frames Stripe's card fields and
 * 3-D Secure. Origins as Stripe's CSP guidance lists them (docs.stripe.com/security/guide#content-security-policy).
 */
export const STRIPE_PAGE_PREFIX = '/pay/stripe/';
export function stripePagePolicy(): string {
  return (
    "default-src 'self'; script-src 'self' https://js.stripe.com https://*.js.stripe.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.stripe.com; font-src 'self'; " +
    "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; " +
    "form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
}

/** `nonce`: the driver app page's per-response script nonce (driver/server.ts), honoured on /app paths only. */
export function contentSecurityPolicy(url: string, tileOrigin: string, framable: boolean, nonce?: string | null): string {
  if (url.split('?')[0]!.startsWith(STRIPE_PAGE_PREFIX)) return stripePagePolicy();
  const extra = inlineScriptAllowed(url) ? " 'unsafe-inline'"
    : nonce && isDriverAppPath(url) && NONCE_RE.test(nonce) ? ` 'nonce-${nonce}'` : '';
  return (
    `default-src 'self'; script-src 'self'${extra}; ` +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    // OpenStreetMap tiles for the site location picker, plus the driver app's
    // map tile host (MAP_TILE_URL) when it is a different one; nothing else is remote.
    `img-src 'self' data: blob: https://tile.openstreetmap.org${tileOrigin}; media-src 'self' blob:; connect-src 'self'; ` +
    "object-src 'none'; base-uri 'none'; " + (framable ? "frame-ancestors 'self'" : "frame-ancestors 'none'")
  );
}
