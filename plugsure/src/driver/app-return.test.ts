import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { acquirerReturnUrl, appRedirect, appReturnSlug } from './app-return.js';

/** G11: the native app's payment return — its own scheme / link domain only, through this server's https bounce. */
describe('payment return to the app (G11)', () => {
  const brand = { slug: 'plugsure', hostname: 'go.plugsure.asia' };
  test('accepted: <slug>://paid (with or without a query) and https://<link domain>/paid', () => {
    for (const ok of ['plugsure://paid', 'plugsure://paid?x=1', 'PLUGSURE://paid', 'plugsure:///paid', 'https://go.plugsure.asia/paid', 'https://GO.plugsure.asia/paid?for=charge']) {
      assert.equal(appReturnSlug(ok, brand), 'plugsure', ok);
    }
  });
  test('refused: other schemes, other brands, other paths, other hosts, credentials, junk, no brand', () => {
    for (const bad of ['https://evil.test/paid', 'javascript:alert(1)', 'nusantaracharge://paid', 'plugsure://pay', 'plugsure://paid/../x', 'plugsure://evil.test/paid',
      'http://go.plugsure.asia/paid', 'https://go.plugsure.asia/paidx', 'https://u:p@go.plugsure.asia/paid', 'https://go.plugsure.asia.evil.test/paid', '', 42, null, 'x'.repeat(400)]) {
      assert.equal(appReturnSlug(bad, brand), null, String(bad).slice(0, 40));
    }
    assert.equal(appReturnSlug('plugsure://paid', null), null, 'requests without a brand (the web app) keep the web return');
    assert.equal(appReturnSlug('https://go.plugsure.asia/paid', { slug: 'plugsure', hostname: null }), null);
  });
  test('the acquirer always gets an https URL on this server: the bounce for the app, the web page otherwise (unchanged)', () => {
    assert.equal(acquirerReturnUrl('https://api.plugsure.asia/', 'charge', 'plugsure'), 'https://api.plugsure.asia/paid?for=charge&app=plugsure');
    assert.equal(acquirerReturnUrl('https://api.plugsure.asia', 'reservation', null), 'https://api.plugsure.asia/app/paid.html?for=reservation');
  });
  test('the bounce keeps the acquirer\'s result parameters and drops `app`', () => {
    assert.equal(appRedirect('?for=charge&app=plugsure&redirect_status=succeeded', 'plugsure'), 'plugsure://paid?for=charge&redirect_status=succeeded');
    assert.equal(appRedirect('', 'plugsure'), 'plugsure://paid');
  });
});
