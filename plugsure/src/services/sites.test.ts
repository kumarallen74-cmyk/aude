import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateSite, siteInputFrom } from './sites.js';

/** Site validation per country (docs/MULTI-COUNTRY-DESIGN.md §D1, §D5). Database rules: multi-country.test.ts. */

describe('site validation per country', () => {
  test('Indonesia: unchanged rules and messages (absent country = ID)', () => {
    assert.deepEqual(validateSite({ name: 'x', postalCode: '17142', lat: -6.2, lon: 107, timezone: 'Asia/Makassar' }, true).errors, {});
    const v = validateSite({ name: 'x', postalCode: '1714', lat: 7, lon: 150, timezone: 'Asia/Singapore' }, true).errors;
    assert.equal(v.postalCode, 'Indonesian postal codes are 5 digits');
    assert.equal(v.lat, 'Latitude must be within Indonesia (-11.5 to 6.5)');
    assert.equal(v.lon, 'Longitude must be within Indonesia (94 to 141.5)');
    assert.match(v.timezone!, /^Timezone must be WIB/);
    assert.equal(validateSite({ reservationFeeMinor: 100_001 }, false).errors.reservationFeeMinor, 'Reservation fee: Rp 0 (free) to Rp 100,000');
  });

  test('WIB, WITA and WIT — and now Pontianak (WIB) — for Indonesian sites', () => {
    for (const tz of ['Asia/Jakarta', 'Asia/Pontianak', 'Asia/Makassar', 'Asia/Jayapura']) {
      assert.equal(validateSite({ timezone: tz }, false).errors.timezone, undefined, tz);
    }
  });

  test('Malaysia: 5-digit postcodes, Malaysian coordinates, MYT zones, bounds in ringgit', () => {
    const ok = { countryCode: 'MY', name: 'KL', postalCode: '55100', lat: 3.149, lon: 101.713, timezone: 'Asia/Kuala_Lumpur', reservationFeeMinor: 2000 };
    assert.deepEqual(validateSite(ok, true).errors, {});
    assert.deepEqual(validateSite({ ...ok, timezone: 'Asia/Kuching', lat: 1.55, lon: 110.34 }, true).errors, {});
    const bad = validateSite({ ...ok, timezone: 'Asia/Jakarta', lat: -6.2, reservationFeeMinor: 2001, v2xCreditMinorPerKwh: 501 }, true).errors;
    assert.equal(bad.timezone, 'Timezone must be MYT (Asia/Kuala_Lumpur) or MYT (Asia/Kuching)');
    assert.equal(bad.lat, 'Latitude must be within Malaysia (0.8 to 7.5)');
    assert.equal(bad.reservationFeeMinor, 'Reservation fee: RM 0.00 (free) to RM 20.00');
    assert.equal(bad.v2xCreditMinorPerKwh, 'Credit for energy given back: RM 0.00 to RM 5.00 per kWh');
  });

  test('Singapore: 6-digit postal codes, SGT only', () => {
    const ok = { countryCode: 'SG', name: 'Marina', postalCode: '039594', lat: 1.2913, lon: 103.857, timezone: 'Asia/Singapore' };
    assert.deepEqual(validateSite(ok, true).errors, {});
    const bad = validateSite({ ...ok, postalCode: '39594', timezone: 'Asia/Kuala_Lumpur', lon: 104.5 }, true).errors;
    assert.equal(bad.postalCode, 'Singapore postal codes are 6 digits');
    assert.equal(bad.timezone, 'Timezone must be SGT (Asia/Singapore)');
    assert.equal(bad.lon, 'Longitude must be within Singapore (103.6 to 104.1)');
  });

  test('Indonesian regulatory fields are refused for Malaysian and Singapore sites', () => {
    const e = validateSite({ countryCode: 'SG', name: 'x', kabupatenKotaCode: '3171', spkluId: '01.POSO.20.3171.011', sloNumber: 'SLO/1', localTaxRateBps: 500 }, true).errors;
    assert.deepEqual(Object.keys(e).sort(), ['kabupatenKotaCode', 'localTaxRateBps', 'sloNumber', 'spkluId']);
    assert.equal(validateSite({ countryCode: 'MY', name: 'x', localTaxRateBps: 0 }, true).errors.localTaxRateBps, undefined);
  });

  test('an unknown country is refused', () => {
    assert.match(validateSite({ countryCode: 'TH', name: 'x' }, true).errors.countryCode!, /one of ID, MY, SG/);
  });

  test('the request body: country upper-cased, tax overrides cleaned', () => {
    const i = siteInputFrom({ countryCode: 'sg', taxOverrides: { exempt: 'true', reason: 'private depot', extra: 1 } });
    assert.equal(i.countryCode, 'SG');
    assert.deepEqual(i.taxOverrides, { exempt: true, reason: 'private depot' });
    assert.ok(validateSite({ taxOverrides: [] as any }, false).errors.taxOverrides);
  });
});
