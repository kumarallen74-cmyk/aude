import { hrefFor, parseLink } from '@/lib/deeplink';

/**
 * Every incoming URL (universal link, app link, custom scheme, old PWA QR stickers) is normalised to an app route
 * here, before the router sees it (spec §13.1: printed stickers must keep working).
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    // Already an in-app path the router knows.
    if (/^\/(c|station|partner|session|receipt|paid|scan|activity|account)(\/|$|\?)/.test(path)) return path;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `https://app.invalid${path.startsWith('/') ? '' : '/'}${path}`;
    const href = hrefFor(parseLink(url));
    return href ?? '/';
  } catch {
    return '/';
  }
}
