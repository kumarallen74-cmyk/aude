import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The console's confirmation dialog treats its message as TEXT.
 *
 * It used to insert `message` as raw HTML, and the Plug & Charge view passed a
 * charger-reported certificate serial number and a PKI subject straight in: CSP stops
 * script there, but not injected markup and styling. A plain string is now escaped; markup
 * goes only through the html`` tag, which escapes every interpolated value.
 */

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const viewDir = new URL('../web/js/views/', import.meta.url);
const views = readdirSync(viewDir).filter((f) => f.endsWith('.js')).map((f) => ({ f, s: src(`../web/js/views/${f}`) }));

async function core() {
  // core.js only touches the DOM inside its functions; html``/asHtml need none of it.
  (globalThis as any).document ??= { addEventListener() {} };
  (globalThis as any).window ??= { addEventListener() {} };
  return import('../web/js/core.js' as string) as Promise<any>;
}

test('html`` keeps its own markup and escapes every interpolated value; fragments nest', async () => {
  const { html, asHtml } = await core();
  const serial = '"><b style="position:fixed">Safe — confirm</b>';
  assert.equal(String(html`Delete serial <b>${serial}</b>?`), 'Delete serial <b>&quot;&gt;&lt;b style=&quot;position:fixed&quot;&gt;Safe — confirm&lt;/b&gt;</b>?');
  assert.equal(String(html`a ${html`<i>${'<x>'}</i>`} b`), 'a <i>&lt;x&gt;</i> b');
  assert.equal(asHtml('<img src=x>'), '&lt;img src=x&gt;', 'a plain string is text');
  assert.equal(asHtml(html`<b>${'&'}</b>`), '<b>&amp;</b>');
  assert.equal(asHtml(undefined), '');
});

test('confirmDialog renders its message through asHtml (never raw)', () => {
  const c = src('../web/js/core.js');
  const fn = c.slice(c.indexOf('export function confirmDialog'), c.indexOf('export function drawer'));
  assert.match(fn, /\$\{asHtml\(message\)\}/);
  assert.doesNotMatch(fn, /\$\{message\}/);
});

test('no confirmDialog caller passes markup in a plain template (it would now show as text)', () => {
  for (const { f, s } of views) {
    for (const m of s.matchAll(/message:\s*([^,]*?)`([^`]*)`/g)) {
      const prefix = m[1]!;
      const body = m[2]!;
      if (/<[a-z]/i.test(body)) assert.match(prefix, /html$/, `${f}: confirmDialog message with markup must use html\`\`: ${body.slice(0, 80)}`);
    }
  }
});

test('the Plug & Charge confirmations pass charger/PKI strings as text', () => {
  const pnc = src('../web/js/views/pnc.js');
  assert.match(pnc, /message: `Delete serial \$\{h\.serialNumber\}/);
  assert.match(pnc, /message: `Remove \$\{a\.subject\}/);
});
