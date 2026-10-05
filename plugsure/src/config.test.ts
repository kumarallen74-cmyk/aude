import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNodeEnvSet, nodeEnvProblem } from './config.js';

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
