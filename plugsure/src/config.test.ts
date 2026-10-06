import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNodeEnvSet, nodeEnvProblem, reviewSignInFrom, weakReviewCode } from './config.js';

/**
 * NODE_ENV fails closed: a missing value used to mean development (OTP codes returned to
 * the caller, chargers auto-adopted, the gateway on every interface, a non-Secure cookie).
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Load config.ts in a fresh process with exactly `env` and report what it decided. */
function configUnder(env: Record<string, string | undefined>) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'NODE_ENV') clean[k] = v;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete clean[k];
    else clean[k] = v;
  }
  const script =
    "import('./src/config.ts').then(({ config, isRelaxedEnv }) => console.log(JSON.stringify({ env: config.env, relaxed: isRelaxedEnv(), " +
    'cookieSecure: config.console.cookieSecure, autoAdopt: config.gateway.autoAdopt, host: config.gateway.host, pki: config.pnc.pki })))';
  // dotenv must not supply a NODE_ENV from a developer's .env during this test.
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: ROOT, env: { ...clean, DOTENV_CONFIG_PATH: '/nonexistent/.env' }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}

describe('NODE_ENV', () => {
  test('missing or blank is refused at start, with a message that says what to set', () => {
    for (const v of [undefined, '', '   ']) {
      assert.match(String(nodeEnvProblem(v)), /NODE_ENV is not set\. Refusing to start: set NODE_ENV=production/);
      assert.throws(() => assertNodeEnvSet({ NODE_ENV: v }), /NODE_ENV is not set/);
    }
  });

  test('development, test and production (and anything else, which counts as production) start', () => {
    for (const v of ['development', 'test', 'production', 'staging']) {
      assert.equal(nodeEnvProblem(v), null, v);
      assert.doesNotThrow(() => assertNodeEnvSet({ NODE_ENV: v }));
    }
  });

  test('missing, every default is the production one — never development', () => {
    const c = configUnder({ NODE_ENV: undefined, OCPP_AUTO_ADOPT: undefined, OCPP_HOST: undefined, CONSOLE_COOKIE_SECURE: undefined, PNC_PKI: undefined });
    assert.deepEqual(c, { env: 'production', relaxed: false, cookieSecure: true, autoAdopt: false, host: '127.0.0.1', pki: 'none' });
  });

  test('an explicit development keeps the workstation defaults', () => {
    const c = configUnder({ NODE_ENV: 'development', OCPP_AUTO_ADOPT: undefined, OCPP_HOST: undefined, CONSOLE_COOKIE_SECURE: undefined, PNC_PKI: undefined });
    assert.deepEqual(c, { env: 'development', relaxed: true, cookieSecure: false, autoAdopt: true, host: '0.0.0.0', pki: 'mock' });
  });

  test('the server entrypoints call the check before anything else', async () => {
    const { readFileSync } = await import('node:fs');
    for (const app of ['api', 'gateway', 'all-in-one']) {
      const src = readFileSync(new URL(`./apps/${app}.ts`, import.meta.url), 'utf8');
      const body = src.slice(src.indexOf('async function main() {'));
      assert.match(body, /^async function main\(\) \{\s*(\/\/[^\n]*\n\s*)*assertNodeEnvSet\(\);/, `${app}.ts`);
    }
  });
});

describe('App Review sign-in (DRIVER_REVIEW_PHONE / DRIVER_REVIEW_CODE, v1.9.1)', () => {
  test('off unless both are set; the number is normalised', () => {
    assert.equal(reviewSignInFrom(undefined, undefined), null);
    assert.equal(reviewSignInFrom('', '  '), null);
    assert.deepEqual(reviewSignInFrom('0812-3456-7890', '583920'), { phone: '+6281234567890', code: '583920' });
    assert.deepEqual(reviewSignInFrom('+60 12 345 6789', '740396'), { phone: '+60123456789', code: '740396' });
  });

  test('refused at start: only one of the two, a number that does not normalise, a code that is not six digits or is weak', () => {
    assert.throws(() => reviewSignInFrom('081234567890', undefined), /set both/);
    assert.throws(() => reviewSignInFrom(undefined, '583920'), /set both/);
    assert.throws(() => reviewSignInFrom('12345', '583920'), /DRIVER_REVIEW_PHONE/);
    for (const c of ['58392', '5839201', '58392a', '58 392']) assert.throws(() => reviewSignInFrom('081234567890', c), /six digits/, c);
    for (const c of ['000000', '111111', '999999', '123456', '012345', '456789', '987654', '543210', '121212', '123123', '909090']) {
      assert.ok(weakReviewCode(c), c);
      assert.throws(() => reviewSignInFrom('081234567890', c), /too easy to guess/, c);
    }
    for (const c of ['583920', '740396', '102938', '123457']) assert.equal(weakReviewCode(c), false, c);
  });

  test('a bad setting stops the process from starting, with the reason', () => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) clean[k] = v;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config.ts').then(() => console.log('started'))"], {
      cwd: ROOT, env: { ...clean, NODE_ENV: 'production', DRIVER_REVIEW_PHONE: '081234567890', DRIVER_REVIEW_CODE: '123456', DOTENV_CONFIG_PATH: '/nonexistent/.env' },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /started/);
    assert.match(r.stderr, /DRIVER_REVIEW_CODE: too easy to guess/);
  });
});
