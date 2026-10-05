import { isUnsupported, mark, type Feature } from './capabilities';

export type ApiErrorKind = 'offline' | 'timeout' | 'auth' | 'not_found' | 'unsupported' | 'rate_limited' | 'business' | 'server';

/**
 * Every failure the UI can meet, classified so screens can say a human sentence (spec §6: network vs server vs
 * business error). `message` is the server's own sentence when it sent one (already in the driver's language via
 * `X-Driver-Lang`), else empty — the UI then uses its own copy for the kind.
 */
export class ApiError extends Error {
  constructor(
    public kind: ApiErrorKind,
    message: string,
    public status: number,
    public code?: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get retryable(): boolean {
    return this.kind === 'offline' || this.kind === 'timeout' || this.kind === 'server';
  }
}

export interface HttpConfig {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  getToken: () => string | null;
  /** The device token was refused (revoked / unknown): the session layer issues a fresh one. */
  onUnauthorized?: () => void;
  brandSlug: string;
  getLang: () => string;
  appVersion: string;
  platform: string;
  timeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** POSTs that create payments / charges carry an Idempotency-Key ([§14 G12]); a retry reuses the key. */
  idempotencyKey?: string;
  /** For [§14] endpoints: a 404/405/501 marks this feature unsupported instead of being a plain not-found. */
  feature?: Feature;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function newIdempotencyKey(): string {
  const rnd = () => Math.random().toString(16).slice(2, 10);
  return `${Date.now().toString(16)}-${rnd()}-${rnd()}`;
}

/**
 * One path segment from a value that may come from a deep link, push payload or route param: percent-encoded, and
 * never a dot segment (`..` would be resolved by the URL parser and reach another endpoint).
 */
export function seg(v: string | number): string {
  const e = encodeURIComponent(String(v));
  if (!e || /^(\.|%2e){1,2}$/i.test(e)) throw new ApiError('not_found', '', 404, 'bad_id');
  return e;
}

function qs(query?: RequestOptions['query']): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export class Http {
  constructor(private cfg: HttpConfig) {}

  /** Swap transport / base URL at runtime (tests, the demo backend, a staging switch in dev builds). */
  configure(patch: Partial<HttpConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'X-Driver-Brand': this.cfg.brandSlug,
      'X-Driver-Lang': this.cfg.getLang(),
      'X-App-Version': this.cfg.appVersion,
      'X-App-Platform': this.cfg.platform,
      ...extra,
    };
    const token = this.cfg.getToken();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  url(path: string, query?: RequestOptions['query']): string {
    return `${this.cfg.baseUrl}/d${path}${qs(query)}`;
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
    if (opts.feature && isUnsupported(opts.feature)) {
      throw new ApiError('unsupported', '', 404, 'feature_unsupported');
    }
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.cfg.timeoutMs ?? 15_000);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);
    const extra: Record<string, string> = {};
    if (opts.body !== undefined) extra['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) extra['Idempotency-Key'] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await fetchImpl(this.url(path, opts.query), {
        method,
        headers: this.headers(extra),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === 'AbortError';
      if (aborted && opts.signal?.aborted) throw e;
      throw new ApiError(aborted ? 'timeout' : 'offline', '', 0);
    } finally {
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
    }

    let body: unknown = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const obj = (body && typeof body === 'object' ? body : {}) as { error?: string; message?: string; code?: string };
    const message = String(obj.error ?? obj.message ?? '');

    if (res.ok) {
      if (opts.feature) mark(opts.feature, true);
      return body as T;
    }
    if (opts.feature && (res.status === 405 || res.status === 501 || (res.status === 404 && (!message || message === 'Not Found' || /route .* not found/i.test(message))))) {
      mark(opts.feature, false);
      throw new ApiError('unsupported', '', res.status, 'feature_unsupported', body);
    }
    if (res.status === 401) {
      if (obj.code === 'no_device') this.cfg.onUnauthorized?.();
      throw new ApiError('auth', message, 401, obj.code, body);
    }
    if (res.status === 404) throw new ApiError('not_found', message, 404, obj.code, body);
    if (res.status === 429) throw new ApiError('rate_limited', message, 429, obj.code, body);
    if (res.status >= 500) throw new ApiError('server', message, res.status, obj.code, body);
    throw new ApiError('business', message, res.status, obj.code, body);
  }

  get<T>(path: string, opts?: RequestOptions) {
    return this.request<T>('GET', path, opts);
  }
  post<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('POST', path, { ...opts, body: body ?? {} });
  }
  put<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('PUT', path, { ...opts, body: body ?? {} });
  }
  del<T>(path: string, opts?: RequestOptions) {
    return this.request<T>('DELETE', path, opts);
  }
}
