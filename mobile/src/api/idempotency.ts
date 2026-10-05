import { ApiError, newIdempotencyKey } from './http';

/**
 * One Idempotency-Key per user attempt ([§14 G12]). The server stores the first answer for a key: a repeat returns
 * it (`Idempotent-Replayed: true`), a repeat while the first still runs is 409 `idempotency_in_progress`, the same
 * key with a different body is 422 `idempotency_key_reused`.
 *
 * So the key is kept while the outcome is unknown (offline, timeout, 5xx, 429, still in progress) — a retry can then
 * never create a second payment — and rotated once there is an answer (success, or a business refusal). A different
 * request (the driver changed the amount or the method) is a new attempt with a new key.
 */
export class AttemptKey {
  private key = newIdempotencyKey();
  private body: string | null = null;

  /** The key for this request: the same while the same request is retried. */
  for(body: unknown): string {
    const b = JSON.stringify(body ?? null);
    if (this.body !== null && this.body !== b) this.key = newIdempotencyKey();
    this.body = b;
    return this.key;
  }

  /** After the attempt: `error` undefined = success. */
  settle(error?: unknown): void {
    if (error !== undefined && keepsKey(error)) return;
    this.key = newIdempotencyKey();
    this.body = null;
  }
}

/** True when the outcome of a keyed request is unknown, so a retry must reuse its key. */
export function keepsKey(e: unknown): boolean {
  return e instanceof ApiError && (e.retryable || e.kind === 'rate_limited' || e.code === 'idempotency_in_progress');
}

export const isInProgress = (e: unknown) => e instanceof ApiError && e.code === 'idempotency_in_progress';

/**
 * Run a keyed request; while the server is still processing the first request with this key (409), wait and ask
 * again with the same key — the answer is then the stored first response. Gives up after `tries` and throws the 409,
 * which the UI shows as "still processing, please wait".
 */
export async function withIdempotency<T>(key: string, run: (key: string) => Promise<T>, opts: { tries?: number; waitMs?: number } = {}): Promise<T> {
  const tries = opts.tries ?? 6;
  const waitMs = opts.waitMs ?? 2_000;
  for (let i = 1; ; i++) {
    try {
      return await run(key);
    } catch (e) {
      if (!isInProgress(e) || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
