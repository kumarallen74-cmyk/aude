import { appEnv, appVersion, brand } from '@/config';

/**
 * Crash reporting (Sentry, `@sentry/react-native` + its Expo config plugin). Off unless `EXPO_PUBLIC_SENTRY_DSN` is set
 * at build time: no DSN → the SDK is never initialised and nothing leaves the phone. Events are scrubbed of device
 * tokens, payment / card data and phone numbers before they are sent (`scrubEvent`).
 */
export const sentryDsn: string | null = (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_SENTRY_DSN?.trim()) || null;

const SECRET_KEYS = /token|authorization|cookie|secret|password|pin|otp|code|card|pan|cvc|cvv|phone|email|qr/i;
const PHONE = /\+?\d[\d\s-]{8,}\d/g;
const BEARER = /psd_[A-Za-z0-9_-]+/g;
/** Query strings and fragments of any URL inside a string (tokens, codes, phone numbers travel there). */
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;
const PATH_QUERY = /(\/[\w./%:-]*)\?[^\s"'<>]*/g;

/** A URL without its query string and fragment, tokens and phone numbers masked. */
export function scrubUrl(u: string): string {
  return u.replace(/[?#].*$/, '').replace(BEARER, 'psd_[redacted]').replace(PHONE, '[phone]');
}

/** Redact a value tree: secret-looking keys → "[redacted]"; in strings: URL queries dropped, device tokens and phone numbers masked. */
export function scrub<T>(v: T, depth = 0): T {
  if (depth > 8) return v;
  if (typeof v === 'string') return v.replace(URL_QUERY, '$1').replace(PATH_QUERY, '$1').replace(BEARER, 'psd_[redacted]').replace(PHONE, '[phone]') as T;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1)) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(x, depth + 1);
    return out as T;
  }
  return v;
}

interface SentryEventLike {
  request?: { headers?: Record<string, string>; data?: unknown; url?: string; query_string?: unknown };
  user?: unknown;
  extra?: unknown;
  contexts?: unknown;
  breadcrumbs?: { data?: unknown; message?: string }[];
  message?: string;
  exception?: { values?: { value?: string; type?: string; stacktrace?: unknown }[] };
  transaction?: string;
}

/** `beforeSend`: no user identity, no request bodies, no secrets. */
export function scrubEvent<E extends SentryEventLike>(e: E): E {
  const out = { ...e };
  delete out.user;
  if (out.request) out.request = { url: out.request.url ? scrubUrl(out.request.url) : undefined };
  if (out.exception?.values) out.exception = { ...out.exception, values: out.exception.values.map((x) => ({ ...x, value: x.value ? scrub(x.value) : x.value })) };
  if (out.transaction) out.transaction = scrub(out.transaction);
  if (out.extra) out.extra = scrub(out.extra);
  if (out.contexts) out.contexts = scrub(out.contexts);
  if (out.message) out.message = scrub(out.message);
  if (out.breadcrumbs) out.breadcrumbs = out.breadcrumbs.map(scrubBreadcrumb);
  return out;
}

/** `beforeBreadcrumb`: fetch / navigation breadcrumbs carry URLs (`data.url`, `data.to`, `data.from`). */
export function scrubBreadcrumb<B extends { data?: unknown; message?: string }>(b: B): B {
  const data = b.data && typeof b.data === 'object' ? (b.data as Record<string, unknown>) : null;
  const urls = data ? Object.fromEntries(['url', 'to', 'from'].filter((k) => typeof data[k] === 'string').map((k) => [k, scrubUrl(data[k] as string)])) : {};
  return { ...b, message: b.message ? scrub(b.message) : b.message, data: data ? { ...scrub(data), ...urls } : b.data };
}

let started = false;

export function initCrashReporting(): boolean {
  if (!sentryDsn || started) return false;
  started = true;
  // Required lazily: the SDK is only loaded into a build that configured a DSN.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Sentry = require('@sentry/react-native') as typeof import('@sentry/react-native');
  Sentry.init({
    dsn: sentryDsn,
    environment: appEnv,
    release: `${brand.variant}@${appVersion}`,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (e) => scrubEvent(e as SentryEventLike) as typeof e,
    beforeBreadcrumb: (b) => (b.category === 'console' ? null : (scrubBreadcrumb(b) as typeof b)),
  });
  return true;
}

export function reportError(err: unknown): void {
  if (!started) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('@sentry/react-native') as typeof import('@sentry/react-native')).captureException(err);
}
