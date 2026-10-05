import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rateSession, energyAllowanceWh, driverAllowanceWh, conservativeAllowanceWh, validateTariff, type RatingResult } from '../tariff.js';
import { computeTax, type TaxResult } from './index.js';
import { buildLocation, buildTariff, buildSession, buildCdr } from '../../ocpi/mapping.js';
import { upgradeLegacyKeys } from '../../domain/money.js';

/**
 * Indonesia, byte for byte (docs/MULTI-COUNTRY-DESIGN.md WP1 acceptance).
 *
 * golden-id.fixture.json was produced by running the v1.6 code (master @ 977d92c,
 * tools/multicountry/golden-gen.mts) over a matrix of Indonesian tariffs and
 * sessions: ten tariffs (the seed tariff, formula-only, tiers, WBP/LWBP, time fees
 * and a non-PKP operator, fees and idle charges above the caps, a free tier, day and
 * night windows, curah, an illegal one) × sessions across WIB/WITA/WIT, peak
 * boundaries, idle time, PBJT-TL 0–10 %, every charging class, memberships,
 * promotions and V2X credits; the pre-purchase allowances; save-time validation;
 * the tax arithmetic; and the OCPI Location, Tariff, Session and CDR built from them.
 *
 * Every input is replayed through the current code. The only difference allowed is
 * the field NAMES the design renamed (amountIdr → amountMinor, ppnIdr → taxMinor,
 * pbjtRateBps → localTaxRateBps …); every amount, line, tax figure, flag (code,
 * severity and message), allowance and OCPI field must be identical.
 */

const fx = JSON.parse(readFileSync(join(import.meta.dirname, 'golden-id.fixture.json'), 'utf8')) as {
  tariffs: Record<string, any>; cases: any[]; env: Record<string, string | null>;
};

// The fixture was made with the default tax settings; the suite runs with them too.
const envOk = !process.env.PBJT_BASE && !process.env.PBJT_IN_PPN_BASE && !process.env.ROUNDING_UNIT_IDR;

const dated = (ctx: any) => ({ ...upgradeLegacyKeys(ctx), startedAt: new Date(ctx.startedAt), endedAt: new Date(ctx.endedAt) });
const dates = (o: any): any => JSON.parse(JSON.stringify(o), (k, v) => (/^(last_updated|started_at|ended_at|issued_at|active_from|active_to)$/.test(k) && typeof v === 'string' ? new Date(v) : v));

/** The current TaxResult in v1.6's names and fields. */
function taxV16(t: TaxResult) {
  return {
    subtotalIdr: t.subtotalMinor, pbjtBaseIdr: t.localTaxBaseMinor, pbjtRateBps: t.localTaxRateBps, pbjtIdr: t.localTaxMinor,
    ppnDppIdr: t.taxBaseMinor, ppnRateBps: t.taxRateBps, ppnIdr: t.taxMinor, roundingIdr: t.roundingMinor, totalIdr: t.totalMinor,
  };
}
/** A current rating result in v1.6's shape. */
function ratingV16(r: RatingResult) {
  return JSON.parse(JSON.stringify({
    lines: r.lines.map(({ amountMinor, ...l }) => {
      // Key order as v1.6 wrote it: amountIdr where amountMinor is.
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries({ ...l, amountMinor })) o[k === 'amountMinor' ? 'amountIdr' : k] = v;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    }),
    chargingClass: r.chargingClass,
    tax: taxV16(r.tax),
    flags: r.flags,
    tariffSnapshot: r.tariffSnapshot,
  }));
}
const sortLines = (o: any) => ({ ...o, lines: o.lines.map((l: any) => Object.fromEntries(Object.keys(l).sort().map((k) => [k, l[k]]))) });

describe('Indonesia golden: rating, tax, validation and OCPI identical to v1.6', { skip: !envOk && 'PBJT_BASE / PBJT_IN_PPN_BASE / ROUNDING_UNIT_IDR set: the fixture uses the defaults' }, () => {
  test('the fixture covers the matrix', () => {
    const kinds = new Map<string, number>();
    for (const c of fx.cases) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    assert.ok((kinds.get('rate') ?? 0) >= 140, 'rating cases');
    assert.ok((kinds.get('tax') ?? 0) >= 50, 'tax cases');
    for (const k of ['allowance', 'validate', 'ocpi.location', 'ocpi.tariff', 'ocpi.session', 'ocpi.cdr']) assert.ok(kinds.get(k), k);
  });

  test('rateSession: every line, tax figure and flag', () => {
    let n = 0;
    for (const c of fx.cases.filter((x) => x.kind === 'rate')) {
      const got = ratingV16(rateSession(structuredClone(fx.tariffs[c.tariff]), dated(c.ctx)));
      assert.deepEqual(got, sortLines(c.out), `case ${c.name}`);
      n++;
    }
    assert.ok(n > 0);
  });

  test('pre-purchase allowances', () => {
    for (const c of fx.cases.filter((x) => x.kind === 'allowance')) {
      const t = fx.tariffs[c.tariff];
      const ctx = dated(c.ctx);
      assert.equal(energyAllowanceWh(t, c.amount, { ...ctx, idleMinutes: 0 }), c.out.energy, `energy ${c.name}`);
      assert.equal(driverAllowanceWh(t, c.amount, ctx), c.out.driver, `driver ${c.name}`);
      assert.equal(conservativeAllowanceWh(t, c.amount, ctx), c.out.conservative, `conservative ${c.name}`);
    }
  });

  test('validateTariff: the same flags in the same order', () => {
    for (const c of fx.cases.filter((x) => x.kind === 'validate')) {
      assert.deepEqual(validateTariff(fx.tariffs[c.tariff], c.maxPowerW), c.out, `validate ${c.name}`);
    }
  });

  test('computeTax (the ID engine)', () => {
    for (const c of fx.cases.filter((x) => x.kind === 'tax')) {
      assert.deepEqual(taxV16(computeTax(upgradeLegacyKeys(c.input))), c.out, `tax ${c.name}`);
    }
  });

  test('OCPI Location, Tariff, Session and CDR', () => {
    const party = { country_code: 'ID', party_id: 'PLS', business_name: 'PT PlugSure', website: 'https://plugsure.id' };
    const token = { country_code: 'NL', party_id: 'EMS', uid: 'TOK-1', type: 'RFID', contract_id: 'NL-EMS-C12345678-X' };
    for (const c of fx.cases.filter((x) => x.kind.startsWith('ocpi.'))) {
      const input = dates(upgradeLegacyKeys(c.input));
      const got = c.kind === 'ocpi.location' ? buildLocation(party, input.site, input.evses)
        : c.kind === 'ocpi.tariff' ? buildTariff(party, input)
        : c.kind === 'ocpi.session' ? buildSession(party, input.session, token)
        : buildCdr(party, input, token);
      assert.deepEqual(JSON.parse(JSON.stringify(got)), c.out, `${c.kind} ${c.name}`);
    }
  });
});
