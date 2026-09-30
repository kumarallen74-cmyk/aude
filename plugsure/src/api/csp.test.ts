import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentSecurityPolicy, inlineScriptAllowed } from './csp.js';

const scriptSrc = (url: string) => /script-src ([^;]*)/.exec(contentSecurityPolicy(url, '', false))![1]!;

test('script-src is strict for the console, the API and the printable pages', () => {
  for (const u of ['/', '/index.html', '/js/app.js', '/v1/sessions/1/receipt', '/v1/fleet-accounts/1/statement.html',
    '/d/v1/charge/1/receipt.html', '/pay/sandbox/x', '/hooks/whatsapp/x']) {
    assert.equal(scriptSrc(u), "'self'", u);
  }
});

test("'unsafe-inline' only for the driver app and the API reference, not for look-alike paths", () => {
  for (const u of ['/app', '/app/', '/app/index.html', '/app/?brand=x', '/api-docs.html']) assert.ok(inlineScriptAllowed(u), u);
  for (const u of ['/application', '/app-evil', '/apps/x', '/api-docs.html.evil', '/v1/app/', '/x?/app/']) assert.ok(!inlineScriptAllowed(u), u);
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
