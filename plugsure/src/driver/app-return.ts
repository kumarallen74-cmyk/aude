/**
 * Payment return to the native app (docs/MOBILE-APP-SPEC.md §14 G11, §15.12).
 *
 * The app asks to come back to `<scheme>://paid` (its in-app browser — ASWebAuthenticationSession / Custom Tabs —
 * closes on that URL) or to its link domain's `https://<hostname>/paid`. The app's URL scheme is its brand's slug
 * (`plugsure://`, `nusantaracharge://`): a scheme is honoured ONLY when it names a brand, and only for the `paid`
 * path — never an arbitrary URL (no open redirect). Acquirers (Stripe, Midtrans, Xendit, the sandbox) are always given
 * an https URL on this server, `/paid?for=…&app=<slug>`, which then redirects to `<slug>://paid?…` with the acquirer's
 * result parameters. Without (or with a refused) returnUrl nothing changes: the web app's `/app/paid.html`.
 */
const SCHEME = /^[a-z][a-z0-9+.-]{1,40}$/;

/** Accepted return URLs for this brand: `<slug>://paid[?…]` or `https://<brand hostname>/paid[?…]`. */
export function appReturnSlug(raw: unknown, brand: { slug: string; hostname: string | null } | null): string | null {
  if (!brand || typeof raw !== 'string' || raw.length > 300) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === brand.slug.toLowerCase() && SCHEME.test(scheme)) {
    // `plugsure://paid` parses as host "paid"; `plugsure:///paid` as path "/paid".
    const target = (u.host || '') + u.pathname;
    return target.replace(/\/+$/, '') === 'paid' || target === '/paid' ? brand.slug : null;
  }
  if (scheme === 'https' && brand.hostname && u.host.toLowerCase() === brand.hostname.toLowerCase() && u.pathname.replace(/\/+$/, '') === '/paid') return brand.slug;
  return null;
}

/** What the acquirer gets: the app's bounce on this server, or the web app's return page. */
export function acquirerReturnUrl(base: string, kind: string, appSlug: string | null): string {
  const b = base.replace(/\/+$/, '');
  return appSlug ? `${b}/paid?for=${encodeURIComponent(kind)}&app=${encodeURIComponent(appSlug)}` : `${b}/app/paid.html?for=${encodeURIComponent(kind)}`;
}

/** `/paid?…&app=<slug>` → `<slug>://paid?…` (the `app` parameter removed), for a slug that is a brand's. */
export function appRedirect(query: string, brandSlug: string): string {
  const p = new URLSearchParams(query.replace(/^\?/, ''));
  p.delete('app');
  const q = p.toString();
  return `${brandSlug}://paid${q ? `?${q}` : ''}`;
}
