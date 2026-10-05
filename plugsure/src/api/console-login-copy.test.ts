import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The sign-in page's product copy. With Malaysia and Singapore offered (MULTI_COUNTRY, v1.7.0) it speaks for an
 * operator in the three countries; on an Indonesian installation (the default) it keeps v1.5's wording — the live
 * pilot's sign-in page does not change. /console-sign-in.json says which (signInMultiCountry()).
 * The operator's own brand (name, tagline, logo) still comes from the console brand, not from this copy.
 */
const app = readFileSync(fileURLToPath(new URL('../web/js/app.js', import.meta.url)), 'utf8');
const art = app.slice(app.indexOf('function loginPage'), app.indexOf('function renderLogin'));
const multi = art.slice(art.indexOf('signInMultiCountry()'), art.indexOf("v1.5's wording"));
const indonesia = art.slice(art.indexOf("v1.5's wording"));

test('multi-country: the sign-in copy names the three countries and no Indonesia-only regulation', () => {
  assert.match(multi, /Indonesia/);
  assert.match(multi, /Malaysia/);
  assert.match(multi, /Singapore/);
  assert.doesNotMatch(multi, /Permen ESDM|PLN capacity|DPP nilai lain\) invoicing/);
});

test('an Indonesian installation keeps v1.5\'s copy (no Malaysia, Singapore, ringgit)', () => {
  assert.match(indonesia, /set PLN capacity limits, price sessions under Permen ESDM/);
  assert.match(indonesia, /PBJT-TL &amp; PPN \(DPP nilai lain\) invoicing/);
  assert.doesNotMatch(indonesia.slice(0, indonesia.indexOf('</ul>')), /Malaysia|Singapore|ringgit/);
});

test('the brand still drives the sign-in panel (name, tagline, logo)', () => {
  assert.match(art, /\$\{brandLogo\(\)\}/);
  assert.match(art, /esc\(productName\(\)\)/);
  assert.match(art, /productTagline\(\)/);
});
