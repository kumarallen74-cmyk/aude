import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinor, toMajor, amountForRate, sum, formatMoney, readMinor, toProviderAmount, fromProviderAmount,
  isCurrency, unitOf, currencyOr, upgradeLegacyKeys, CURRENCIES,
} from './money.js';
import { COUNTRIES, countryOf, currencyOfCountry, cdrMaxPricePerKwh, assertCountry, countryOfCurrency } from './country.js';
import { tzLabel, validTimezones, defaultTimezone, utcOffsetMinutes, localParts, isValidTimezoneFor } from './timezone.js';

test('exponents: IDR is stored in whole rupiah, MYR/SGD in sen/cents', () => {
  assert.equal(CURRENCIES.IDR.exponent, 0);
  assert.equal(CURRENCIES.IDR.isoExponent, 2);
  assert.equal(CURRENCIES.MYR.exponent, 2);
  assert.equal(CURRENCIES.SGD.exponent, 2);
  assert.ok(isCurrency('SGD'));
  assert.ok(!isCurrency('USD'));
  assert.throws(() => unitOf('USD'), /unsupported currency/);
  assert.equal(currencyOr(null), 'IDR');
  assert.equal(currencyOr('MYR'), 'MYR');
  assert.throws(() => currencyOr('EUR'));
});

test('toMinor: decimal-string based, half-up', () => {
  assert.equal(toMinor('0.455', 'MYR'), 46);
  assert.equal(toMinor(0.455, 'MYR'), 46);
  assert.equal(toMinor('1.005', 'MYR'), 101); // binary float would give 100
  assert.equal(toMinor(1.005, 'SGD'), 101);
  assert.equal(toMinor('12.34', 'SGD'), 1234);
  assert.equal(toMinor('12', 'SGD'), 1200);
  assert.equal(toMinor(2467.5, 'IDR'), 2468);
  assert.equal(toMinor('25000', 'IDR'), 25000);
  assert.equal(toMinor('-3.50', 'MYR'), -350);
  assert.throws(() => toMinor('1,5', 'MYR'));
  assert.throws(() => toMinor('abc', 'MYR'));
});

test('toMajor', () => {
  assert.equal(toMajor(1234, 'MYR'), 12.34);
  assert.equal(toMajor(1234, 'SGD'), 12.34);
  assert.equal(toMajor(1234, 'IDR'), 1234);
  assert.equal(toMajor(5, 'SGD'), 0.05);
});

test('amountForRate: same rounding as the pre-1.7 energy line, in minor units', () => {
  assert.equal(amountForRate(12.345, 0.955, 'MYR'), 1179);
  // IDR: exactly Math.round(kwh * rate), as every rupiah line has always been computed.
  for (const [kwh, rate] of [[40, 2467.5], [12.345, 2466], [0.333, 2475], [7.777, 1645.5]] as const) {
    assert.equal(amountForRate(kwh, rate, 'IDR'), Math.round(kwh * rate));
  }
  assert.equal(amountForRate(20, 0.65, 'SGD'), 1300);
  assert.equal(amountForRate(10, 1.2, 'MYR'), 1200);
});

test('sum refuses mixed currencies', () => {
  assert.deepEqual(sum([{ currency: 'MYR', minor: 100 }, { currency: 'MYR', minor: 250 }, null], 'MYR'), { currency: 'MYR', minor: 350 });
  assert.throws(() => sum([{ currency: 'MYR', minor: 100 }, { currency: 'SGD', minor: 1 }], 'MYR'), /cannot add SGD to MYR/);
});

test('formatMoney: the currency decides symbol and decimals, the language the separators', () => {
  assert.equal(formatMoney(12345, 'IDR', 'id'), 'Rp 12.345');
  assert.equal(formatMoney(12345, 'IDR', 'en'), 'Rp 12,345');
  assert.equal(formatMoney(1234, 'MYR', 'id'), 'RM 12,34');
  assert.equal(formatMoney(1234, 'MYR', 'en'), 'RM 12.34');
  assert.equal(formatMoney(1234, 'SGD', 'en'), 'S$ 12.34');
  assert.equal(formatMoney(1234, 'SGD', 'id'), 'S$ 12,34');
  assert.equal(formatMoney(123456789, 'SGD', 'en'), 'S$ 1,234,567.89');
  assert.equal(formatMoney(-500, 'MYR', 'en'), '-RM 5.00');
  assert.equal(formatMoney(1500000, 'IDR', 'id'), 'Rp 1.500.000');
  assert.equal(formatMoney(1234, 'MYR', 'en', { symbol: false }), '12.34');
});

test('provider units', () => {
  assert.equal(toProviderAmount(1234, 'SGD', 'minor'), 1234);
  assert.equal(toProviderAmount(1234, 'MYR', 'major'), 12.34);
  assert.equal(toProviderAmount(25000, 'IDR', 'whole'), 25000);
  assert.equal(toProviderAmount(25000, 'IDR', 'minor'), 2500000);
  assert.throws(() => toProviderAmount(1234, 'SGD', 'whole'));
  assert.equal(toProviderAmount(1200, 'SGD', 'whole'), 12);
  assert.equal(fromProviderAmount(1234, 'SGD', 'minor'), 1234);
  assert.equal(fromProviderAmount(2500000, 'IDR', 'minor'), 25000);
  assert.equal(fromProviderAmount(12.34, 'MYR', 'major'), 1234);
});

test('readMinor reads current and legacy keys', () => {
  assert.equal(readMinor({ amountMinor: 5 }, 'amount'), 5);
  assert.equal(readMinor({ amountIdr: 7 }, 'amount'), 7);
  assert.equal(readMinor({ total_idr: '9' }, 'total'), 9);
  assert.equal(readMinor({ total_minor: 11, total_idr: 9 }, 'total'), 11);
  assert.equal(readMinor({ amountMinor: 0, amountIdr: 3 }, 'amount'), 0);
  assert.equal(readMinor({}, 'amount'), null);
  assert.equal(readMinor(null, 'amount'), null);
});

test('upgradeLegacyKeys: frozen JSON from before 1.7 reads with the current names', () => {
  const frozen = {
    lines: [{ kind: 'energy', amountIdr: 1000 }, { kind: 'session', amountIdr: 25000 }],
    ppnIdr: 3000, dppIdr: 24000, pbjtIdr: 500, taxBaseIdr: 26500, totalIdr: 30000,
    plan: { upToIdr: 10, minPerChargerAcIdr: 150000 },
    estimateQrisMdrIdr: 1, when: new Date(0),
  };
  const up = upgradeLegacyKeys(frozen) as any;
  assert.deepEqual(up.lines, [{ kind: 'energy', amountMinor: 1000 }, { kind: 'session', amountMinor: 25000 }]);
  assert.equal(up.taxMinor, 3000);
  assert.equal(up.taxBaseMinor, 24000);
  assert.equal(up.localTaxMinor, 500);
  assert.equal(up.taxableMinor, 26500);
  assert.equal(up.totalMinor, 30000);
  assert.equal(up.plan.upToMinor, 10);
  assert.equal(up.estimateQrisMdrIdr, 1);
  assert.ok(up.when instanceof Date);
  // A new key already present wins over the legacy one.
  assert.deepEqual(upgradeLegacyKeys({ amountMinor: 2, amountIdr: 1 }), { amountMinor: 2 });
  // Not mutated.
  assert.equal((frozen.lines[0] as any).amountIdr, 1000);
});

test('countries', () => {
  assert.equal(countryOf('ID').currency, 'IDR');
  assert.equal(countryOf(null).code, 'ID');
  assert.equal(currencyOfCountry('MY'), 'MYR');
  assert.equal(currencyOfCountry('SG'), 'SGD');
  assert.equal(COUNTRIES.SG.alpha3, 'SGP');
  assert.equal(COUNTRIES.MY.alpha3, 'MYS');
  assert.equal(COUNTRIES.ID.alpha3, 'IDN');
  assert.throws(() => assertCountry('TH'));
  assert.equal(cdrMaxPricePerKwh('IDR'), 25_000);
  assert.equal(cdrMaxPricePerKwh('MYR'), 10);
  assert.equal(cdrMaxPricePerKwh('SGD'), 5);
  assert.equal(cdrMaxPricePerKwh('EUR'), null);
  assert.equal(countryOfCurrency('SGD')?.code, 'SG');
  assert.ok(COUNTRIES.SG.postalCodeRe.test('018989'));
  assert.ok(!COUNTRIES.SG.postalCodeRe.test('10110'));
  assert.equal(COUNTRIES.ID.displayPricesInclTax, false);
  assert.equal(COUNTRIES.SG.displayPricesInclTax, true);
});

test('time zones per country and their labels', () => {
  assert.deepEqual(validTimezones('ID'), ['Asia/Jakarta', 'Asia/Pontianak', 'Asia/Makassar', 'Asia/Jayapura']);
  assert.equal(defaultTimezone('MY'), 'Asia/Kuala_Lumpur');
  assert.equal(defaultTimezone('SG'), 'Asia/Singapore');
  assert.ok(isValidTimezoneFor('MY', 'Asia/Kuching'));
  assert.ok(!isValidTimezoneFor('SG', 'Asia/Jakarta'));
  assert.equal(tzLabel('Asia/Jakarta'), 'WIB');
  assert.equal(tzLabel('Asia/Pontianak'), 'WIB');
  assert.equal(tzLabel('Asia/Makassar'), 'WITA');
  assert.equal(tzLabel('Asia/Jayapura'), 'WIT');
  assert.equal(tzLabel('Asia/Kuala_Lumpur'), 'MYT');
  assert.equal(tzLabel('Asia/Singapore'), 'SGT');
  assert.equal(tzLabel('Europe/Berlin'), 'Europe/Berlin');
  const d = new Date('2026-10-03T00:30:00Z');
  assert.equal(utcOffsetMinutes(d, 'Asia/Jakarta'), 420);
  assert.equal(utcOffsetMinutes(d, 'Asia/Makassar'), 480);
  assert.equal(utcOffsetMinutes(d, 'Asia/Jayapura'), 540);
  assert.equal(utcOffsetMinutes(d, 'Asia/Singapore'), 480);
  assert.equal(utcOffsetMinutes(d, 'Asia/Kuala_Lumpur'), 480);
  assert.equal(localParts(d, 'Asia/Singapore').hour, '08');
});

describe('the console copy of formatMoney (web/js/money.js) is identical', () => {
  test('same text for every currency, language and a spread of amounts', async () => {
    // @ts-expect-error a browser ES module without types
    const web = await import('../web/js/money.js');
    const { formatMoney: server } = await import('./money.js');
    for (const cur of ['IDR', 'MYR', 'SGD'] as const) {
      for (const lang of ['id', 'en'] as const) {
        for (const n of [0, 1, 5, 99, 100, 1234, 12345, 123456789, -1, -12345, 1e9 + 7]) {
          assert.equal(web.formatMoney(n, cur, lang), server(n, cur, lang), `${n} ${cur} ${lang}`);
          assert.equal(web.formatMoney(n, cur, lang, { symbol: false }), server(n, cur, lang, { symbol: false }));
          assert.equal(web.formatMoney(n, cur, lang, { decimals: 4 }), server(n, cur, lang, { decimals: 4 }));
        }
      }
    }
    // The console writes rupiah exactly as v1.6 did (Rp 12.345, Rp -5), other currencies in English.
    assert.equal(web.moneyText(12345, 'IDR'), 'Rp 12.345');
    assert.equal(web.moneyText(-5, 'IDR'), 'Rp -5');
    assert.equal(web.moneyText(123456, 'MYR'), 'RM 1,234.56');
    assert.equal(web.moneyText(1300, 'SGD'), 'S$ 13.00');
    assert.equal(web.rateText(0.455, 'MYR'), 'RM 0.455');
    assert.equal(web.rateText(2466.5, 'IDR'), 'Rp 2.466,5');
  });
});

test('amountForRate for MYR/SGD is decimal-exact (review 7); IDR stays Math.round(qty × rate)', () => {
  // Binary floating point puts these on the wrong side of the half: 1.005 × 100 = 100.49999…; 8.025 × 100 = 802.4999….
  assert.equal(amountForRate(1.005, 1, 'MYR'), 101);
  assert.equal(amountForRate(12.345, 0.65, 'SGD'), 802); // 8.02425
  assert.equal(amountForRate(8.025, 1, 'SGD'), 803);
  assert.equal(amountForRate(0.5, 0.01, 'MYR'), 1); // 0.5 sen rounds up
  assert.equal(amountForRate(-1.005, 1, 'MYR'), -100); // Math.round: -100.5 → -100
  assert.equal(amountForRate(33.333, 0.4555, 'MYR'), 1518); // 15.1831815
  // IDR: identical to the v1.6 expression for a sweep of quantities and rates.
  for (let wh = 0; wh <= 90_000; wh += 137) for (const rate of [1650.5, 2466.5, 2467, 3600.75, 5000]) {
    assert.equal(amountForRate(wh / 1000, rate, 'IDR'), Math.round((wh / 1000) * rate));
  }
});
