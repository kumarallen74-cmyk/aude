import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config, isRelaxedEnv } from '../config.js';
import { logger } from '../logger.js';

/**
 * Secrets at rest (webhook signing secrets; provider credentials later).
 *
 * AES-256-GCM under SECRETS_KEY. The stored form is `enc:v1:<iv>:<tag>:<ct>`
 * (base64url parts), so a leaked database dump does not leak the secrets a
 * third party uses to trust PlugSure's webhooks.
 *
 * `enc:v2:` is the same, plus GCM ASSOCIATED DATA. A v1 value is bound to the
 * key and nothing else, so anyone who can write the database can move a sealed
 * value from one row or column to another — put one tenant's acquirer secret
 * in another tenant's integration row, or a partner's OCPI token in a different
 * partner — and it still opens. Pass `aad` (e.g. `integration:<id>:secrets`)
 * to both `seal` and `unseal` and the value only opens where it was sealed:
 *
 *     seal(secret, `webhook_endpoint:${id}:secret`)   → 'enc:v2:…'
 *     unseal(stored, `webhook_endpoint:${id}:secret`) → the secret, or throws
 *
 * Existing call sites do not pass it yet (they belong to their features and are
 * migrated one by one: seal with the AAD on the next write; v1 values keep
 * opening). Note the AAD has to be known before the row exists — use a stable
 * natural key or a pre-generated id.
 *
 * Every value written by this codebase carries a prefix. An UNPREFIXED value is
 * refused outside development/test (see `unseal`).
 *
 * SECRETS_KEY is required outside development and test: every entrypoint calls
 * assertSecretsKeyConfigured() at boot. In development and test only, a fixed
 * key derived from a constant is used so a fresh checkout works; values sealed with it are not portable.
 */
const PREFIX = 'enc:v1:';
const PREFIX_V2 = 'enc:v2:';
/** Pinned: Node otherwise accepts a truncated tag (down to 4 bytes) on decrypt. */
const TAG_BYTES = 16;

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

/**
 * Seal `plain`. With `aad`, the value is bound to it (`enc:v2:`) and only
 * `unseal(value, aad)` with the same string opens it; without, `enc:v1:` as
 * before.
 */
export function seal(plain: string, aad?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return (aad !== undefined ? PREFIX_V2 : PREFIX) + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join(':');
}

function open(body: string, aad: string | undefined): string {
  const parts = body.split(':');
  if (parts.length !== 3) throw new Error('sealed value is malformed');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
  if (iv.length !== 12 || tag.length !== TAG_BYTES) throw new Error('sealed value is malformed');
  const d = createDecipheriv('aes-256-gcm', key(), iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

let warnedPlaintext = false;

/**
 * Open a value from `seal`.
 *
 * - `enc:v2:` needs the same `aad` it was sealed with; a missing or different
 *   one throws (that is the point: the value was moved).
 * - `enc:v1:` opens with or without `aad` — it has none to check — so values
 *   sealed before v2 keep working. Re-seal with the AAD to get the binding.
 * - '' is returned as '' (a column holding "no secret", e.g. a pending e-wallet
 *   link).
 * - Anything else is UNSEALED TEXT. It used to be returned as-is, as a "legacy
 *   plain value". Every write path in this codebase seals, and no migration
 *   ever stored plaintext (migration 048 lists any it finds), so outside
 *   development/test such a value is refused: with the fallback, anyone who
 *   can write the database could replace a sealed webhook secret, OCPI token
 *   or CA key with plaintext of their choosing and have it used. A deployment
 *   that really does hold legacy plaintext can set SECRETS_ALLOW_PLAINTEXT=1
 *   while it re-enters those secrets; each use then logs a warning (once per
 *   process).
 */
export function unseal(stored: string, aad?: string): string {
  if (stored.startsWith(PREFIX_V2)) {
    if (aad === undefined) throw new Error('this value is sealed to associated data: pass the same aad to unseal');
    return open(stored.slice(PREFIX_V2.length), aad);
  }
  if (stored.startsWith(PREFIX)) return open(stored.slice(PREFIX.length), undefined);
  if (stored === '') return '';
  if (!plaintextAllowed()) {
    throw new Error(
      'refusing an unsealed secret: the stored value has no enc: prefix. Re-enter it so it is sealed with SECRETS_KEY ' +
        '(or set SECRETS_ALLOW_PLAINTEXT=1 temporarily if this deployment holds legacy plaintext).',
    );
  }
  if (!warnedPlaintext) {
    warnedPlaintext = true;
    logger.warn('an UNSEALED secret was read from the database and used as plaintext; re-enter it so it is sealed (warned once per process)');
  }
  return stored;
}

/** Whether `unseal` may hand back an unprefixed value. Exported for tests. */
export function plaintextAllowed(env: string = config.env, flag: string | undefined = process.env.SECRETS_ALLOW_PLAINTEXT): boolean {
  if (isRelaxedEnv(env)) return true;
  return flag === '1' || flag === 'true';
}

/** A new random signing secret, shown to the operator once. */
export function newSigningSecret(): string {
  return 'whsec_' + randomBytes(24).toString('base64url');
}
