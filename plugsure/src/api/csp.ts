/**
 * The Content-Security-Policy header of every response from the API process.
 *
 * script-src is 'self' only: an injected <script> or on…= attribute does not run, whatever gets
 * past the escaping (charger vendor strings, partner data and driver names all reach the console).
 * The console, the printable receipts, statements and invoices need nothing else.
 *
 * Two pages still carry inline script and keep 'unsafe-inline' until they are split up:
 *   - the driver app (/app, /app/…), which also injects each brand's settings inline;
 *   - the API reference (/api-docs.html).
 * White-label hosts serve only /app and /d/… (deploy/Caddyfile), so no other path needs it.
 */
export function inlineScriptAllowed(url: string): boolean {
  const path = url.split('?')[0]!;
  return path === '/app' || path.startsWith('/app/') || path === '/api-docs.html';
}

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

export function contentSecurityPolicy(url: string, tileOrigin: string, framable: boolean): string {
  if (url.split('?')[0]!.startsWith(STRIPE_PAGE_PREFIX)) return stripePagePolicy();
  return (
    `default-src 'self'; script-src 'self'${inlineScriptAllowed(url) ? " 'unsafe-inline'" : ''}; ` +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    // OpenStreetMap tiles for the site location picker, plus the driver app's
    // map tile host (MAP_TILE_URL) when it is a different one; nothing else is remote.
    `img-src 'self' data: blob: https://tile.openstreetmap.org${tileOrigin}; media-src 'self' blob:; connect-src 'self'; ` +
    "object-src 'none'; base-uri 'none'; " + (framable ? "frame-ancestors 'self'" : "frame-ancestors 'none'")
  );
}
