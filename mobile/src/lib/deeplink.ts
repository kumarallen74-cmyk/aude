import { brand } from '@/config';
/**
 * Deep links, universal links / app links and scanned QR payloads (spec §6.11, §13.1).
 *
 *   https://go.plugsure.asia/c/<code>         charger QR (new stickers)
 *   https://<any>/app/?code=<code> | ?c= | #c/<code>   existing PWA stickers — must keep working
 *   https://go.plugsure.asia/s/<siteId>       station share
 *   https://go.plugsure.asia/r/<kind>/<id>    receipt
 *   https://go.plugsure.asia/paid?for=…       payment return (acquirer → app)
 *   plugsure://<same paths>                   custom scheme (white-label: the brand's scheme)
 *   PWA push hashes: #s/<chargeId>, #r/<chargeId>, #rr/<cdrId>, #home, #history, #account, #paid
 *   raw codes: connector UUID, IDENTITY:n, IDENTITY/n, bare identity, SPKLU id
 */
export type LinkIntent =
  | { type: 'charger'; code: string }
  | { type: 'station'; siteId: string }
  | { type: 'partner'; partnerId: string; countryCode: string; partyId: string; locationId: string }
  | { type: 'session'; kind: 'charge' | 'roaming'; id: string }
  | { type: 'receipt'; kind: 'charge' | 'roaming'; id: string }
  | { type: 'paid'; for: string | null; status: string | null }
  | { type: 'tab'; tab: 'map' | 'activity' | 'account' }
  | { type: 'unknown'; raw: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Codes are short printable identifiers; anything else is refused before it reaches the API. */
const CODE = /^[\w.:/*#-]{1,80}$/;

export function cleanCode(raw: string): string | null {
  const c = raw.trim().replace(/^\/+|\/+$/g, '');
  return c && CODE.test(c) ? c : null;
}

/**
 * The charger code inside a scanned QR or typed text — the same rules as the PWA scanner:
 * `code` param, `c` param, `#c/…` hash, else the last path segment; non-URLs are the code itself.
 */
export function extractChargerCode(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      return null;
    }
    const fromQuery = u.searchParams.get('code') ?? u.searchParams.get('c');
    if (fromQuery) return cleanCode(decodeURIComponent(fromQuery));
    const hash = u.hash.replace(/^#/, '');
    if (hash.startsWith('c/')) return cleanCode(decodeURIComponent(hash.slice(2)));
    const segs = pathSegments(u);
    if (segs[0] === 'c' && segs[1]) return cleanCode(decodeURIComponent(segs.slice(1).join('/')));
    const last = segs[segs.length - 1];
    if (!last || last === 'app' || last === 'index.html') return null;
    return cleanCode(decodeURIComponent(last));
  }
  return cleanCode(text);
}

/** Path segments; for a custom scheme (`plugsure://c/ABC`) the host is the first segment. */
function pathSegments(u: URL): string[] {
  const custom = !/^https?:$/.test(u.protocol);
  const parts = u.pathname.split('/').filter(Boolean);
  return custom && u.hostname ? [u.hostname, ...parts] : parts;
}

function kindOf(s: string | undefined): 'charge' | 'roaming' | null {
  return s === 'charge' || s === 'roaming' ? s : null;
}

/** Classify an incoming URL (universal link, custom scheme, push payload URL). */
export function parseLink(raw: string): LinkIntent {
  const text = raw.trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    const code = cleanCode(text);
    return code ? { type: 'charger', code } : { type: 'unknown', raw };
  }
  const segs = pathSegments(u);
  const hash = u.hash.replace(/^#/, '');

  // PWA hashes (push notifications, old shares).
  if (hash) {
    if (hash.startsWith('c/')) {
      const code = cleanCode(decodeURIComponent(hash.slice(2)));
      if (code) return { type: 'charger', code };
    }
    const [h0, h1] = hash.split('/');
    if (h0 === 's' && h1 && UUID.test(h1)) return { type: 'session', kind: 'charge', id: h1 };
    if (h0 === 'r' && h1 && UUID.test(h1)) return { type: 'receipt', kind: 'charge', id: h1 };
    if (h0 === 'rr' && h1 && UUID.test(h1)) return { type: 'receipt', kind: 'roaming', id: h1 };
    if (h0 === 'home') return { type: 'tab', tab: 'map' };
    if (h0 === 'history') return { type: 'tab', tab: 'activity' };
    if (h0 === 'account') return { type: 'tab', tab: 'account' };
    if (h0 === 'paid') return { type: 'paid', for: u.searchParams.get('for'), status: payStatus(u) };
  }

  const [s0, s1, s2, s3, s4] = segs;
  if (s0 === 'paid' || s0 === 'paid.html' || (s0 === 'app' && s1 === 'paid.html')) return { type: 'paid', for: u.searchParams.get('for'), status: payStatus(u) };
  if (s0 === 'c' && s1) {
    const code = cleanCode(decodeURIComponent(segs.slice(1).join('/')));
    return code ? { type: 'charger', code } : { type: 'unknown', raw };
  }
  if (s0 === 's' && s1 && UUID.test(s1)) return { type: 'station', siteId: s1 };
  if (s0 === 'p' && s1 && UUID.test(s1) && s2 && s3 && s4) return { type: 'partner', partnerId: s1, countryCode: s2, partyId: s3, locationId: decodeURIComponent(s4) };
  if (s0 === 'r' && kindOf(s1) && s2 && UUID.test(s2)) return { type: 'receipt', kind: kindOf(s1)!, id: s2 };
  if (s0 === 'session' && kindOf(s1) && s2 && UUID.test(s2)) return { type: 'session', kind: kindOf(s1)!, id: s2 };
  if (s0 === 'activity') return { type: 'tab', tab: 'activity' };
  if (s0 === 'account') return { type: 'tab', tab: 'account' };
  if (s0 === 'map') return { type: 'tab', tab: 'map' };

  // Old PWA stickers: /app/?code=… or …?c=…, or any other URL whose last segment is the code.
  const code = extractChargerCode(text);
  return code ? { type: 'charger', code } : { type: 'unknown', raw };
}

/** Acquirer return status: Midtrans transaction_status, Xendit / sandbox status, Stripe redirect_status. */
function payStatus(u: URL): string | null {
  const s = u.searchParams.get('status') ?? u.searchParams.get('transaction_status') ?? u.searchParams.get('redirect_status');
  return s ? s.toLowerCase() : null;
}

/** A failed / cancelled acquirer return ("no money was taken"); linking an e-wallet is checked by the app instead. */
export function paymentReturnFailed(intent: Extract<LinkIntent, { type: 'paid' }>): boolean {
  return intent.for !== 'link' && !!intent.status && /cancel|deny|fail|expire/.test(intent.status);
}

/** The in-app route for an intent (expo-router href). */
export function hrefFor(intent: LinkIntent): string | null {
  switch (intent.type) {
    case 'charger':
      return `/c/${encodeURIComponent(intent.code)}`;
    case 'station':
      return `/station/${intent.siteId}`;
    case 'partner':
      return `/partner/${intent.partnerId}/${encodeURIComponent(intent.locationId)}?countryCode=${intent.countryCode}&partyId=${intent.partyId}`;
    case 'session':
      return `/session/${intent.kind}/${intent.id}`;
    case 'receipt':
      return `/receipt/${intent.kind}/${intent.id}`;
    case 'paid':
      return `/paid${intent.for ? `?for=${encodeURIComponent(intent.for)}` : ''}${intent.status ? `${intent.for ? '&' : '?'}status=${encodeURIComponent(intent.status)}` : ''}`;
    case 'tab':
      return intent.tab === 'map' ? '/' : `/${intent.tab}`;
    default:
      return null;
  }
}

/** Share link for a station (universal link host of the brand). */
export function stationShareUrl(host: string, siteId: string): string {
  return `https://${host}/s/${siteId}`;
}

/** The in-app route for a server link resolution (§15.5 `GET /d/v1/links/resolve`). */
export function hrefForResolution(r: import('@/api/types').LinkResolution): string {
  switch (r.kind) {
    case 'connector':
      return `/connector/${r.connectorId}`;
    case 'partner_evse':
      return `/partner/${r.partner.partnerId}/${encodeURIComponent(r.partner.locationId)}?countryCode=${r.partner.countryCode}&partyId=${encodeURIComponent(r.partner.partyId)}&evseUid=${encodeURIComponent(r.partner.evseUid)}`;
    case 'site':
      return `/station/${r.siteId}`;
    case 'charge':
      return `/session/charge/${r.chargeId}`;
    case 'receipt':
      return `/receipt/charge/${r.chargeId}`;
    case 'partner_receipt':
      return `/receipt/roaming/${r.cdrId}`;
    case 'payment_return':
      return `/paid${r.for ? `?for=${encodeURIComponent(r.for)}` : ''}`;
  }
}

/**
 * The app routes a push notification or an external link may open (anything else is ignored): a notification's
 * `data.url` comes from the server, but it is still input — it must not open arbitrary screens or web pages.
 */
const ALLOWED_ROUTES: RegExp[] = [
  /^\/$/,
  /^\/(activity|account|favourites|passes|scan|search)$/,
  /^\/(session|receipt|rate)\/(charge|roaming)\/[0-9a-f-]{36}$/i,
  /^\/(station)\/[0-9a-f-]{36}$/i,
  /^\/connector\/[0-9a-f-]{36}$/i,
  /^\/c\/[^/?#\s]{1,120}$/,
  /^\/partner\/[0-9a-f-]{36}\/[^/?#\s]{1,120}(\?[\w=&%.*-]*)?$/i,
  /^\/paid(\?[\w=&%.-]*)?$/,
];
export function isAllowedRoute(href: string | null | undefined): href is string {
  return !!href && href.length <= 300 && ALLOWED_ROUTES.some((r) => r.test(href));
}

/** A notification's `data.url` → an allowed in-app route, or null (never a web page, never an unknown screen). */
export function routeForNotificationUrl(url: string | null | undefined, own: { hosts: readonly string[]; scheme: string } = { hosts: brand.linkHosts, scheme: brand.scheme }): string | null {
  if (!url || typeof url !== 'string' || url.startsWith('//')) return null;
  let href: string | null;
  if (url.startsWith('/')) href = url.startsWith('/app') ? hrefFor(parseLink(`https://app.invalid${url}`)) : url;
  else {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    // Only the app's own link domains and scheme.
    const ours = u.protocol === `${own.scheme}:` || (u.protocol === 'https:' && own.hosts.some((h) => h.toLowerCase() === u.hostname.toLowerCase()));
    href = ours ? hrefFor(parseLink(url)) : null;
  }
  return isAllowedRoute(href) ? href : null;
}
