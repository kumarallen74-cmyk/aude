import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentSecurityPolicy, inlineScriptAllowed } from './csp.js';
import { withScriptNonce } from '../driver/server.js';
import { pool } from '../db/pool.js';
import { STRIPE_PAGE_JS } from '../services/payments/stripe-page.js';

const scriptSrc = (url: string) => /script-src ([^;]*)/.exec(contentSecurityPolicy(url, '', false))![1]!;

test('script-src is strict for the console, the API and the printable pages', () => {
  for (const u of ['/', '/index.html', '/js/app.js', '/v1/sessions/1/receipt', '/v1/fleet-accounts/1/statement.html',
    '/d/v1/charge/1/receipt.html', '/pay/sandbox/x', '/hooks/whatsapp/x']) {
    assert.equal(scriptSrc(u), "'self'", u);
  }
});

test('js.stripe.com only on the Stripe card page (WP3), never with inline script; everything else unchanged', () => {
  const p = contentSecurityPolicy('/pay/stripe/ps_0123/pi_abc', '', false);
  assert.match(p, /script-src 'self' https:\/\/js\.stripe\.com https:\/\/\*\.js\.stripe\.com;/);
  assert.match(p, /frame-src [^;]*hooks\.stripe\.com/);
  assert.match(p, /connect-src 'self' https:\/\/api\.stripe\.com/);
  assert.match(p, /frame-ancestors 'none'/);
  assert.ok(!/unsafe-inline'[^;]*;?\s*$/.test(/script-src ([^;]*)/.exec(p)![1]!) && !/script-src[^;]*unsafe-inline/.test(p));
  for (const u of ['/pay/stripe.js', '/pay/stripex/1', '/pay/sandbox/x', '/pay/notify/k', '/app/', '/']) assert.ok(!contentSecurityPolicy(u, '', u.startsWith('/app/')).includes('stripe.com'), u);
  assert.ok(!/<script/i.test(STRIPE_PAGE_JS) && !/innerHTML/.test(STRIPE_PAGE_JS), 'the page script writes text only');
});

test("'unsafe-inline' only for the API reference, not for look-alike paths — the driver app no longer (v1.9.1)", () => {
  assert.ok(inlineScriptAllowed('/api-docs.html'));
  for (const u of ['/app', '/app/', '/app/index.html', '/app/?brand=x', '/application', '/app-evil', '/apps/x', '/api-docs.html.evil', '/v1/app/', '/x?/app/']) {
    assert.ok(!inlineScriptAllowed(u), u);
  }
});

test('the driver app: a per-response nonce instead of inline script, on /app paths only; the console unchanged (v1.9.1)', () => {
  const nonce = 'q8Zr0sXk3Yb7Lw2Fh5Nc9Tg1';
  const sp = (u: string, n?: string | null) => /script-src ([^;]*)/.exec(contentSecurityPolicy(u, '', u.startsWith('/app/'), n))![1]!;
  for (const u of ['/app', '/app/', '/app/index.html', '/app/?brand=x']) assert.equal(sp(u, nonce), `'self' 'nonce-${nonce}'`, u);
  // Without a nonce (paid.html, sw.js, icons): 'self' only.
  for (const u of ['/app/', '/app/paid.html', '/app/sw.js']) assert.equal(sp(u), "'self'", u);
  // A nonce never widens anything else, and a malformed one is not written into the header.
  for (const u of ['/', '/index.html', '/v1/me', '/d/v1/charge/1/receipt.html', '/application']) assert.equal(sp(u, nonce), "'self'", u);
  assert.equal(sp('/app/', "x'; script-src *"), "'self'");
  // The console's whole policy is what it was.
  assert.equal(contentSecurityPolicy('/', '', false, nonce), contentSecurityPolicy('/', '', false));
  assert.match(contentSecurityPolicy('/app/', '', true, nonce), /style-src 'self' 'unsafe-inline'/, 'styles unchanged');
});

test('the driver app page: every inline script gets the nonce, none has an inline handler; the payment return page has no inline script', () => {
  const html = src('../driver-web/index.html');
  assert.ok(!INLINE_HANDLER.test(html), 'driver-web/index.html: inline event handler');
  const out = withScriptNonce(`${html}<script>window.BRAND={}</script><script src="x.js"></script>`, 'NONCE123NONCE123');
  assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*nonce="NONCE123NONCE123")[^>]*>/i.test(out), 'an inline script without the nonce');
  assert.match(out, /<script src="x\.js"><\/script>/, 'a script file is left alone');
  const paid = src('../driver-web/paid.html');
  assert.ok(!INLINE_HANDLER.test(paid) && !INLINE_SCRIPT.test(paid), 'paid.html');
  assert.match(paid, /<script src="paid\.js"><\/script>/);
});

test('served: GET /app/ carries a nonce in its header that matches its scripts, a new one per response', async (t) => {
  let app: Awaited<ReturnType<typeof import('./server.js')['buildApi']>>;
  try {
    app = await (await import('./server.js')).buildApi();
    await app.ready();
  } catch (e) {
    t.skip(`API could not be built here (${(e as Error).message})`);
    return;
  }
  try {
    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({ method: 'GET', url: '/app/' });
      assert.equal(r.statusCode, 200);
      const csp = String(r.headers['content-security-policy']);
      const n = /'nonce-([^']+)'/.exec(csp)?.[1];
      assert.ok(n, csp);
      assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), csp);
      const tags = r.body.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? [];
      assert.ok(tags.length >= 2 && tags.every((x) => x.includes(`nonce="${n}"`)), tags.join(' '));
      nonces.push(n!);
    }
    assert.notEqual(nonces[0], nonces[1]);
    const paid = await app.inject({ method: 'GET', url: '/app/paid.js' });
    assert.equal(paid.statusCode, 200);
    const console = await app.inject({ method: 'GET', url: '/' });
    assert.match(String(console.headers['content-security-policy']), /script-src 'self';/);
  } finally {
    await app.close();
    await pool.end();
  }
});

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const INLINE_HANDLER = /<[a-z][^>]*\son[a-z]+\s*=/i;
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>/i;

test('the printable receipt, statements and invoices carry no inline script (it would not run)', () => {
  for (const f of ['../services/session-query.ts', '../services/commission.ts', '../services/fleet-billing.ts', '../services/fleet-pdf.ts']) {
    const s = src(f);
    assert.ok(!INLINE_HANDLER.test(s), `${f}: inline event handler`);
    assert.ok(!INLINE_SCRIPT.test(s), `${f}: inline <script>`);
  }
  assert.match(src('../services/session-query.ts'), /<script src="\/d\/print\.js" defer><\/script>/, 'the Print button script');
});

test('the console has no inline handler or inline script anywhere (it would silently stop working)', () => {
  const dir = new URL('../web/js/views/', import.meta.url);
  const files = ['../web/index.html', '../web/js/app.js', '../web/js/core.js', ...readdirSync(dir).map((f) => `../web/js/views/${f}`)];
  for (const f of files) {
    const s = src(f);
    assert.ok(!INLINE_HANDLER.test(s), `${f}: inline event handler`);
    assert.ok(!INLINE_SCRIPT.test(s), `${f}: inline <script>`);
  }
});
