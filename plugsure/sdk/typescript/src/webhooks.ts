import type { WebhookEvent } from './generated.js';

/**
 * Webhook signatures. Every delivery carries
 *   PlugSure-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * Verify it against the RAW body (before any JSON parsing), and refuse old
 * timestamps so a captured delivery cannot be replayed later.
 */

export interface VerifyOptions {
  /** The endpoint's signing secret (shown once when the endpoint was created). */
  secret: string;
  /** The PlugSure-Signature header. */
  signature: string | null | undefined;
  /** The raw request body, exactly as received. */
  body: string | Uint8Array;
  /** Refuse deliveries signed longer ago than this (seconds). Default 300. */
  toleranceS?: number;
  /** For tests: the current time in unix seconds. */
  nowS?: number;
}

export class WebhookSignatureError extends Error {
  readonly name = 'WebhookSignatureError';
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Compare in time independent of where the strings differ. */
function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** True when the signature is valid and recent. Uses Web Crypto (Node 18+, Deno, Bun, browsers). */
export async function verifyWebhookSignature(o: VerifyOptions): Promise<boolean> {
  const parts = Object.fromEntries(String(o.signature ?? '').split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  const v1 = String(parts.v1 ?? '');
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const now = o.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (o.toleranceS ?? 300)) return false;
  const body = typeof o.body === 'string' ? o.body : new TextDecoder().decode(o.body);
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(o.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`)));
  return sameText(mac, v1);
}

/**
 * Verify, then parse the delivery. Throws WebhookSignatureError when the
 * signature is missing, wrong or too old. Deliveries may arrive more than once:
 * deduplicate on `event.id`.
 */
export async function parseWebhook(o: VerifyOptions): Promise<WebhookEvent> {
  if (!(await verifyWebhookSignature(o))) throw new WebhookSignatureError('invalid or expired webhook signature');
  return JSON.parse(typeof o.body === 'string' ? o.body : new TextDecoder().decode(o.body)) as WebhookEvent;
}
