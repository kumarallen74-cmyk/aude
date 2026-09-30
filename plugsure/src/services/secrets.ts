import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Secrets at rest (webhook signing secrets; provider credentials later).
 *
 * AES-256-GCM under SECRETS_KEY. The stored form is `enc:v1:<iv>:<tag>:<ct>`
 * (base64url parts), so a leaked database dump does not leak the secrets a
 * third party uses to trust PlugSure's webhooks.
 *
 * SECRETS_KEY is required outside development (the process refuses to start
 * without it). In development only, a fixed key derived from a constant is used
 * so a fresh checkout works; values sealed with it are not portable.
 */
const PREFIX = 'enc:v1:';

function key(): Buffer {
  const hex = config.security.secretsKey;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  if (hex) return createHash('sha256').update(hex).digest();
  return createHash('sha256').update('plugsure-development-secrets-key').digest();
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join(':');
}

export function unseal(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plain value
  const [ivB, tagB, ctB] = stored.slice(PREFIX.length).split(':');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB!, 'base64url'));
  d.setAuthTag(Buffer.from(tagB!, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ctB!, 'base64url')), d.final()]).toString('utf8');
}

/** A new random signing secret, shown to the operator once. */
export function newSigningSecret(): string {
  return 'whsec_' + randomBytes(24).toString('base64url');
}
