import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config, isRelaxedEnv } from '../config.js';

/**
 * Secrets at rest (webhook signing secrets; provider credentials later).
 *
 * AES-256-GCM under SECRETS_KEY. The stored form is `enc:v1:<iv>:<tag>:<ct>`
 * (base64url parts), so a leaked database dump does not leak the secrets a
 * third party uses to trust PlugSure's webhooks.
 *
 * SECRETS_KEY is required outside development and test: every entrypoint calls
 * assertSecretsKeyConfigured() at boot. In development and test only, a fixed
 * key derived from a constant is used so a fresh checkout works; values sealed with it are not portable.
 */
const PREFIX = 'enc:v1:';

/**
 * Why a SECRETS_KEY value is unusable in `env`, or null when it is usable.
 *
 * Outside development and test the key is REQUIRED. It used to fall back
 * silently to a key derived from a constant printed in this file, so a
 * deployment that forgot SECRETS_KEY sealed every acquirer key, OCPI token,
 * webhook secret and the charger CA key with a key anyone could read. The
 * documented form is 64 hex characters (`openssl rand -hex 32`). A longer
 * passphrase is still accepted (hashed, as before) so existing sealed values
 * keep opening, but a short value or the README placeholder is refused.
 */
export function secretsKeyProblem(env: string, value: string): string | null {
  if (isRelaxedEnv(env)) return null;
  if (!value) return 'SECRETS_KEY is not set';
  if (/CHANGE_ME/i.test(value)) return 'SECRETS_KEY is still the documentation placeholder';
  if (/^[0-9a-fA-F]{64}$/.test(value)) return null;
  if (value.length < 32) return 'SECRETS_KEY is too short (use 64 hex characters: openssl rand -hex 32)';
  return null;
}

/** Refuse to start with a missing or placeholder SECRETS_KEY outside development and test. */
export function assertSecretsKeyConfigured(env: string = config.env, value: string = config.security.secretsKey): void {
  const problem = secretsKeyProblem(env, value);
  if (problem) {
    throw new Error(
      `${problem}. Stored provider credentials, webhook and roaming secrets and the charger CA key are ` +
        `encrypted with it. Generate one with \`openssl rand -hex 32\` and set it before starting in NODE_ENV=${env}.`,
    );
  }
}

function key(): Buffer {
  const hex = config.security.secretsKey;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  // Defence in depth: a process that skipped the startup check still never seals with the public key.
  assertSecretsKeyConfigured();
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
