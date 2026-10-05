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

/**
 * The OCPP gateway believes X-Forwarded-Proto and the client-certificate header only from
 * OCPP_TRUSTED_PROXIES. Compose used to default that to 172.16.0.0/12 — every container on
 * every Docker bridge network of the host. Now: only the fixed gateway address of the
 * project network, which is where the host's Caddy appears from.
 */
test('the OCPP gateway trusts only the project network\'s fixed gateway address, not the Docker bridge range', () => {
  const trusted = compose.match(/OCPP_TRUSTED_PROXIES: \$\{OCPP_TRUSTED_PROXIES:-(.*)\}\s*$/m);
  assert.ok(trusted, 'OCPP_TRUSTED_PROXIES has a default');
  assert.ok(!/172\.16\.0\.0\/12|\/(8|12|16)\b/.test(trusted![1]!), `no broad range: ${trusted![1]}`);
  const gw = compose.match(/gateway: \$\{PLUGSURE_NET_GATEWAY:-([0-9.]+)\}/);
  const subnet = compose.match(/subnet: \$\{PLUGSURE_NET_SUBNET:-([0-9.]+)\/24\}/);
  assert.ok(gw && subnet, 'the default network has a fixed subnet and gateway');
  assert.ok(trusted![1]!.includes(`\${PLUGSURE_NET_GATEWAY:-${gw![1]}}`), 'the trusted address is that gateway');
  assert.equal(gw![1]!.split('.').slice(0, 3).join('.'), subnet![1]!.split('.').slice(0, 3).join('.'), 'the gateway is inside the subnet');
});
