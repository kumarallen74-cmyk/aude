/**
 * The SDK's transport: authentication, URLs, JSON, errors, rate limits and
 * retries. Uses the platform's fetch (Node 18+, Deno, Bun, browsers); no
 * dependencies.
 */

export interface ClientOptions {
  /** An API key (`psk_<prefix>_<secret>`) from Govern → API keys, or a sandbox key. */
  apiKey: string;
  /** Your API host, e.g. `https://api.example.id`. */
  baseUrl: string;
  /**
   * Retries of a request refused for the rate limit (429), after the wait the
   * API asks for, and of reads (GET) that failed with 502/503/504 or a network
   * error. Default 2; 0 turns retries off.
   */
  maxRetries?: number;
  /** Never wait longer than this for a retry (seconds); a longer Retry-After is thrown instead. Default 60. */
  maxRetryWaitS?: number;
  /** Per attempt. Default 30 s. */
  timeoutMs?: number;
  /** Replace fetch (tests, proxies, instrumentation). */
  fetch?: typeof fetch;
  /** Sent with every request. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
}

/** The key's rate limit, from the RateLimit-* headers of the last answer. */
export interface RateLimitInfo {
  /** Requests a minute. */
  limit: number;
  /** Requests the key may still send at once. */
  remaining: number;
  /** Seconds until the allowance is full again. */
  resetS: number;
}

export type BinaryBody = Blob | ArrayBuffer | Uint8Array;

export interface RequestSpec {
  method: string;
  path: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  bodyType?: 'json' | 'binary';
  contentType?: string;
  accept: 'json' | 'text' | 'binary' | 'stream' | 'none';
}

/** An answer other than 2xx. `status` 0 means no answer at all (network, timeout). */
export class PlugSureError extends Error {
  readonly name = 'PlugSureError';
  constructor(
    message: string,
    readonly status: number,
    /** A stable code where the API gives one (e.g. `rate_limited`, `charger_offline`). */
    readonly code: string | undefined,
    /** The parsed error body. */
    readonly body: unknown,
    readonly method: string,
    readonly path: string,
    /** For 429: seconds the API asked to wait. */
    readonly retryAfterS?: number,
    readonly rateLimit?: RateLimitInfo,
  ) {
    super(message);
  }
}

const RETRYABLE_READ = new Set([502, 503, 504]);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });

/** AbortSignal.any where it exists (Node 20.3+), linked by hand on Node 18. */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof (AbortSignal as any).any === 'function') return (AbortSignal as any).any([a, b]);
  const c = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

export function buildUrl(baseUrl: string, spec: Pick<RequestSpec, 'path' | 'pathParams' | 'query'>): string {
  const path = spec.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = spec.pathParams?.[name];
    if (v === undefined || v === null || v === '') throw new TypeError(`missing path parameter ${name}`);
    return encodeURIComponent(String(v));
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(spec.query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.append(k, v instanceof Date ? v.toISOString() : String(v));
  }
  const q = qs.toString();
  return `${baseUrl.replace(/\/+$/, '')}${path}${q ? `?${q}` : ''}`;
}

function rateLimitOf(h: Headers): RateLimitInfo | undefined {
  const limit = Number(h.get('ratelimit-limit'));
  if (!h.has('ratelimit-limit') || !Number.isFinite(limit)) return undefined;
  return { limit, remaining: Number(h.get('ratelimit-remaining') ?? 0), resetS: Number(h.get('ratelimit-reset') ?? 0) };
}

export class Transport {
  /** From the most recent answer that carried it. */
  rateLimit: RateLimitInfo | undefined;
  private readonly fetch: typeof fetch;

  constructor(private readonly o: ClientOptions) {
    if (!o?.apiKey) throw new TypeError('apiKey is required');
    if (!o.baseUrl) throw new TypeError('baseUrl is required, e.g. https://api.example.id');
    const f = o.fetch ?? globalThis.fetch;
    if (!f) throw new TypeError('no fetch available: use Node 18 or later, or pass options.fetch');
    this.fetch = f.bind(globalThis);
  }

  async request<T>(spec: RequestSpec, options: RequestOptions = {}): Promise<T> {
    const url = buildUrl(this.o.baseUrl, spec);
    const maxRetries = options.maxRetries ?? this.o.maxRetries ?? 2;
    const maxWaitS = this.o.maxRetryWaitS ?? 60;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.o.apiKey}`,
      accept: spec.accept === 'json' ? 'application/json' : '*/*',
      ...this.o.headers,
      ...options.headers,
    };
    let body: RequestInit['body'];
    if (spec.body !== undefined) {
      if (spec.bodyType === 'binary') {
        body = spec.body as RequestInit['body'];
        headers['content-type'] = spec.contentType ?? 'application/octet-stream';
      } else {
        body = JSON.stringify(spec.body);
        headers['content-type'] = 'application/json';
      }
    }

    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? this.o.timeoutMs ?? 30_000);
      const signal = options.signal ? anySignal(options.signal, timeout) : timeout;
      let res: Response;
      try {
        res = await this.fetch(url, { method: spec.method, headers, body, signal });
      } catch (e) {
        if (options.signal?.aborted) throw e;
        if (spec.method === 'GET' && attempt < maxRetries) { await sleep(500 * 2 ** attempt, options.signal); continue; }
        throw new PlugSureError(`${spec.method} ${spec.path}: no answer (${(e as Error).message})`, 0, undefined, undefined, spec.method, spec.path);
      }
      const rl = rateLimitOf(res.headers);
      if (rl) this.rateLimit = rl;
      if (res.ok) return (await this.read(res, spec.accept)) as T;

      const retryAfterS = Number(res.headers.get('retry-after'));
      const wait = res.status === 429
        ? (Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS : 1)
        : spec.method === 'GET' && RETRYABLE_READ.has(res.status) ? 0.5 * 2 ** attempt : null;
      // A 429 is refused before the API does anything, so any method may be sent again.
      if (wait !== null && attempt < maxRetries && wait <= maxWaitS) {
        await res.body?.cancel().catch(() => undefined);
        await sleep(wait * 1000, options.signal);
        continue;
      }
      const text = await res.text().catch(() => '');
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
      const message = typeof parsed?.error === 'string' ? parsed.error : `HTTP ${res.status}`;
      throw new PlugSureError(`${spec.method} ${spec.path}: ${message}`, res.status, parsed?.code, parsed, spec.method, spec.path,
        res.status === 429 ? (Number.isFinite(retryAfterS) ? retryAfterS : undefined) : undefined, rl);
    }
  }

  private async read(res: Response, accept: RequestSpec['accept']): Promise<unknown> {
    if (accept === 'stream') return res;
    if (accept === 'binary') return res.arrayBuffer();
    if (accept === 'none') { await res.body?.cancel().catch(() => undefined); return undefined; }
    const text = await res.text();
    if (accept === 'text') return text;
    return text ? JSON.parse(text) : undefined;
  }
}
