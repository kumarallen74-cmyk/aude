import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * docker-compose.yml never falls back to a known secret.
 *
 * `${POSTGRES_PASSWORD:-plugsure}` meant an .env without the line gave the database superuser
 * the password "plugsure": anything that could reach PostgreSQL could log in as superuser, which
 * bypasses row-level security. Secrets are required (`:?`) or empty (`:-`, meaning "not set").
 */
const compose = readFileSync(fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)), 'utf8');
const SECRET = /\$\{([A-Z0-9_]*(PASSWORD|SECRET|TOKEN|_KEY|HMAC)[A-Z0-9_]*):-([^}]*)\}/g;

test('no secret in docker-compose.yml has a non-empty default', () => {
  const bad = [...compose.matchAll(SECRET)].filter((m) => m[3] !== '').map((m) => `${m[1]} defaults to "${m[3]}"`);
  assert.deepEqual(bad, []);
});

test('the database passwords are required', () => {
  assert.match(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
  assert.equal((compose.match(/\$\{POSTGRES_PASSWORD:\?/g) ?? []).length, 2, 'the database service and the migrator');
  assert.ok(!/\$\{POSTGRES_APP_PASSWORD:-/.test(compose));
});
