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

export function contentSecurityPolicy(url: string, tileOrigin: string, framable: boolean): string {
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
