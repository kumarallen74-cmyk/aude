import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretsKeyProblem, assertSecretsKeyConfigured } from './secrets.js';

const HEX = 'a'.repeat(64);

test('outside development and test, a missing SECRETS_KEY refuses to start', () => {
  for (const env of ['production', 'staging', 'prod', '']) {
    assert.match(secretsKeyProblem(env, '') ?? '', /not set/, env);
    assert.throws(() => assertSecretsKeyConfigured(env, ''), /SECRETS_KEY is not set/);
  }
});

test('the README placeholder and short values are refused; 64 hex or a long passphrase is accepted', () => {
  assert.match(secretsKeyProblem('production', 'CHANGE_ME_openssl_rand_hex_32') ?? '', /placeholder/);
  assert.match(secretsKeyProblem('production', 'hunter2') ?? '', /too short/);
  assert.equal(secretsKeyProblem('production', HEX), null);
  assert.equal(secretsKeyProblem('production', 'x'.repeat(40)), null);
});

test('development and test keep the convenience key', () => {
  assert.equal(secretsKeyProblem('development', ''), null);
  assert.equal(secretsKeyProblem('test', ''), null);
});

test('only an explicit development or test environment is relaxed; staging, prod or a typo is production', async () => {
  const { isRelaxedEnv } = await import('../config.js');
  assert.equal(isRelaxedEnv('development'), true);
  assert.equal(isRelaxedEnv('test'), true);
  for (const env of ['production', 'staging', 'prod', 'Production', '']) assert.equal(isRelaxedEnv(env), false, env);
});
