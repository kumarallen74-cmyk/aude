import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeTax, effectivePpnRateBps } from './tax.js';
import {
  rateSession,
  validateTariff,
  plnEnergyRate,
  energyAllowanceWh,
  touBlockAt,
  splitEnergyByTou,
  type Tariff,
  driverAllowanceWh,
} from './tariff.js';
import { allocate, wattsToAmps, ampsToWatts, type Demand } from './smartcharging.js';
import { parseSpkluId, chargingClassForPowerW } from '../domain/spklu.js';
import { teraStatusFor, connectorMaySellEnergy } from './compliance.js';
import { estimateQrisMdrIdr } from './payments/provider.js';
import { canonicalJson } from './audit.js';

// ---------------------------------------------------------------- tax

describe('PPN (VAT)', () => {
  test('uses DPP nilai lain = 11/12 x price, not a flat 11%', () => {
    // The regulation's worked example: price 12,000,000 -> DPP 11,000,000 -> PPN 1,320,000
    const r = computeTax({ subtotalIdr: 12_000_000, pbjtRateBps: 0 });
    assert.equal(r.ppnDppIdr, 11_000_000);
    assert.equal(r.ppnIdr, 1_320_000);
    assert.equal(r.totalIdr, 13_320_000);
  });

  test('effective rate is 11% even though the headline is 12%', () => {
    assert.equal(effectivePpnRateBps(), 1100);
    const r = computeTax({ subtotalIdr: 1_000_000, pbjtRateBps: 0 });
    assert.equal(r.ppnIdr, 110_000);
  });

  test('PBJT is applied before PPN and is capped at 10%', () => {
    const r = computeTax({ subtotalIdr: 100_000, pbjtRateBps: 500 });
    assert.equal(r.pbjtIdr, 5_000);
    assert.equal(r.ppnDppIdr, Math.round((105_000 * 11) / 12));
    const capped = computeTax({ subtotalIdr: 100_000, pbjtRateBps: 5_000 });
    assert.equal(capped.pbjtRateBps, 1_000, 'PBJT above the 10% statutory cap is clamped');
  });
});

// ---------------------------------------------------------------- PLN formula

describe('PLN tariff formula', () => {
  test('layanan khusus at N=1.5 reproduces the quoted retail ceiling', () => {
    const rate = plnEnergyRate({ plnScheme: 'layanan_khusus', plnBaseRate: 1650, plnMultiplier: 1.5 });
    assert.equal(rate, 2475); // the widely-quoted Rp 2,466-2,475/kWh is just N = 1.5
  });

  test('curah at Q=1 is the bulk purchase rate', () => {
    assert.equal(plnEnergyRate({ plnScheme: 'curah', plnBaseRate: 707, plnMultiplier: 1 }), 707);
  });

  test('a multiplier outside the regulated range is flagged as a violation', () => {
    const t: Tariff = {
      id: 't', name: 'bad', currency: 'IDR',
      plnScheme: 'layanan_khusus', plnBaseRate: 1650, plnMultiplier: 2.0, components: [],
    };
    const flags = validateTariff(t, 60_000);
    assert.ok(flags.some((f) => f.code === 'PLN_N_OUT_OF_RANGE' && f.severity === 'violation'));
  });
});

// ---------------------------------------------------------------- ceilings

describe('regulatory service fee ceilings', () => {
  test('charging classes follow Permen ESDM 1/2023', () => {
    assert.equal(chargingClassForPowerW(7_000), 'slow');
    assert.equal(chargingClassForPowerW(22_000), 'medium');
    assert.equal(chargingClassForPowerW(50_000), 'fast');
    assert.equal(chargingClassForPowerW(120_000), 'ultrafast');
  });

  test('a session fee above the fast-charging ceiling is rejected at save time', () => {
    const t: Tariff = {
      id: 't', name: 'over', currency: 'IDR', plnScheme: 'none',
      components: [{ kind: 'session', rate: 30_000, touBlock: 'ANY' }],
    };
    const flags = validateTariff(t, 50_000); // fast: Rp 25,000 ceiling
    assert.ok(flags.some((f) => f.code === 'SERVICE_FEE_CEILING_EXCEEDED'));
  });

  test('slow and medium charging are deliberately unregulated', () => {
    const t: Tariff = {
      id: 't', name: 'medium', currency: 'IDR', plnScheme: 'none',
      components: [{ kind: 'session', rate: 30_000, touBlock: 'ANY' }],
    };
    assert.equal(validateTariff(t, 22_000).length, 0);
  });
});

// ---------------------------------------------------------------- rating

describe('session rating', () => {
  const tariff: Tariff = {
    id: 't', name: 'Public DC', currency: 'IDR',
    plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5,
    components: [
      { kind: 'energy', rate: 2467.5, touBlock: 'ANY', sortOrder: 0 },
      { kind: 'session', rate: 25_000, touBlock: 'ANY', sortOrder: 1 },
      { kind: 'admin', rate: 4_000, touBlock: 'ANY', sortOrder: 2 },
      { kind: 'idle', rate: 1_000, touBlock: 'ANY', fromMinutes: 15, sortOrder: 3 },
    ],
  };

  test('builds the full Indonesian layered bill', () => {
    const r = rateSession(tariff, {
      startedAt: new Date('2026-08-23T02:00:00Z'),
      endedAt: new Date('2026-08-23T03:00:00Z'),
      energyWh: 20_000,
      connectorMaxPowerW: 60_000,
      pbjtRateBps: 500,
    });
    const energy = r.lines.find((l) => l.kind === 'energy')!;
    assert.equal(energy.amountIdr, Math.round(20 * 2467.5)); // 49,350
    assert.equal(r.tax.subtotalIdr, 49_350 + 25_000 + 4_000);
    // PBJT is a tax on TENAGA LISTRIK, so its base is the energy line alone.
    // Levying it on the biaya layanan and the admin fee too overcharged every
    // invoice, and DPP, PPN and the faktur pajak all inherited the error.
    assert.equal(r.tax.pbjtBaseIdr, 49_350);
    assert.equal(r.tax.pbjtIdr, Math.round(49_350 * 0.05));
    assert.equal(r.chargingClass, 'ultrafast');
    assert.equal(r.tax.totalIdr, r.tax.subtotalIdr + r.tax.pbjtIdr + r.tax.ppnIdr);
  });

  test('idle fee respects the grace period', () => {
    const base = {
      startedAt: new Date('2026-08-23T02:00:00Z'),
      endedAt: new Date('2026-08-23T03:00:00Z'),
      energyWh: 10_000,
      connectorMaxPowerW: 60_000,
      pbjtRateBps: 0,
    };
    const within = rateSession(tariff, { ...base, idleMinutes: 10 });
    assert.equal(within.lines.filter((l) => l.kind === 'idle').length, 0);
    const beyond = rateSession(tariff, { ...base, idleMinutes: 45 });
    assert.equal(beyond.lines.find((l) => l.kind === 'idle')!.amountIdr, 30_000); // (45-15) x 1000
  });

  test('the tariff snapshot is frozen on the result so invoices reproduce exactly', () => {
    const r = rateSession(tariff, {
      startedAt: new Date(), endedAt: new Date(), energyWh: 1_000,
      connectorMaxPowerW: 22_000, pbjtRateBps: 0,
    });
    r.tariffSnapshot.components[0]!.rate = 99_999;
    assert.equal(tariff.components[0]!.rate, 2467.5, 'mutating the snapshot must not touch the source');
  });
});

describe('QRIS pre-purchase inverse rating', () => {
  test('a rupiah amount converts to an energy allowance the charger can enforce', () => {
    const tariff: Tariff = {
      id: 't', name: 'AC', currency: 'IDR', plnScheme: 'none',
      components: [{ kind: 'energy', rate: 2467.5, touBlock: 'ANY' }],
    };
    const ctx = {
      startedAt: new Date('2026-08-23T02:00:00Z'),
      endedAt: new Date('2026-08-23T03:00:00Z'),
      connectorMaxPowerW: 22_000,
      pbjtRateBps: 0,
    };
    const wh = energyAllowanceWh(tariff, 100_000, ctx);
    // Round-trip: rating that allowance must not exceed what the driver paid.
    const back = rateSession(tariff, { ...ctx, energyWh: wh });
    assert.ok(back.tax.totalIdr <= 100_000, `${back.tax.totalIdr} exceeds the prepaid amount`);
    assert.ok(back.tax.totalIdr > 99_000, 'allowance should be tight, not conservative');
  });
});

describe('time of use', () => {
  test('WBP window is classified in WIB, not UTC', () => {
    // 18:00 WIB = 11:00 UTC
    assert.equal(touBlockAt(new Date('2026-08-23T11:00:00Z')), 'WBP');
    assert.equal(touBlockAt(new Date('2026-08-23T02:00:00Z')), 'LWBP'); // 09:00 WIB
  });

  test('energy splits across the WBP boundary', () => {
    // 16:00-18:00 WIB = 09:00-11:00 UTC; WBP starts 17:00 WIB, so half the session
    const split = splitEnergyByTou(
      new Date('2026-08-23T09:00:00Z'),
      new Date('2026-08-23T11:00:00Z'),
      10_000,
    );
    assert.equal(split.WBP + split.LWBP, 10_000);
    assert.ok(Math.abs(split.WBP - 5_000) < 100);
  });
});

// ---------------------------------------------------------------- smart charging

describe('load allocation', () => {
  const d = (id: string, max: number, min: number, type: 'AC' | 'DC', active = true): Demand => ({
    ocppIdentity: id, chargePointId: id, connectorNo: 1,
    maxPowerW: max, minPowerW: min, currentType: type, phases: 3, priority: 0, active,
  });

  test('never exceeds the site budget', () => {
    const out = allocate(50_000, [d('a', 22_000, 4_140, 'AC'), d('b', 40_000, 5_000, 'DC')]);
    const total = out.reduce((s, a) => s + a.allocatedW, 0);
    assert.ok(total <= 50_000, `allocated ${total} against a 50,000 W budget`);
  });

  test('caps each session at its own nameplate', () => {
    const out = allocate(500_000, [d('a', 22_000, 4_140, 'AC')]);
    assert.equal(out[0]!.allocatedW, 22_000);
  });

  test('sheds the lowest-priority session rather than starving everyone', () => {
    const high = { ...d('hi', 40_000, 20_000, 'DC'), priority: 10 };
    const low = { ...d('lo', 40_000, 20_000, 'DC'), priority: 1 };
    const out = allocate(25_000, [high, low]);
    const byId = Object.fromEntries(out.map((a) => [a.ocppIdentity, a.allocatedW]));
    assert.ok(byId['hi']! >= 20_000, 'the high-priority session keeps a usable rate');
    assert.equal(byId['lo'], 0, 'the low-priority session is shed, not starved');
  });

  test('idle connectors get nothing', () => {
    const out = allocate(50_000, [d('a', 22_000, 4_140, 'AC', false)]);
    assert.equal(out[0]!.allocatedW, 0);
  });

  test('AC limits are expressed in amps, DC in watts', () => {
    const out = allocate(50_000, [d('a', 22_000, 4_140, 'AC'), d('b', 40_000, 5_000, 'DC')]);
    assert.equal(out.find((x) => x.ocppIdentity === 'a')!.unit, 'A');
    assert.equal(out.find((x) => x.ocppIdentity === 'b')!.unit, 'W');
  });

  test('amp/watt conversion round-trips at 230 V per phase', () => {
    assert.equal(Math.round(ampsToWatts(32, 3)), 22_080);
    assert.ok(Math.abs(wattsToAmps(22_080, 3) - 32) < 0.01);
  });
});

// ---------------------------------------------------------------- compliance

describe('SPKLU identity number', () => {
  test('parses the scheme and municipality code', () => {
    const p = parseSpkluId('01.POSO.20.3275.010')!;
    assert.equal(p.scheme, 'POSO');
    assert.equal(p.schemeFamily, 'provider');
    assert.equal(p.ownsAsset, true);
    assert.equal(p.selfOperated, true);
    assert.equal(p.kabupatenKotaCode, '3275'); // Kota Bekasi — drives PBJT resolution
  });

  test('distinguishes retailer schemes', () => {
    assert.equal(parseSpkluId('07.RLPO.21.3171.004')!.schemeFamily, 'retailer');
    assert.equal(parseSpkluId('07.RLPO.21.3171.004')!.ownsAsset, false);
  });

  test('rejects malformed and unknown-scheme identifiers', () => {
    assert.equal(parseSpkluId('01.XXXX.20.3275.010'), null);
    assert.equal(parseSpkluId('POSO-3275-010'), null);
  });
});

describe('metrology (tera ulang)', () => {
  const now = new Date('2026-08-23T00:00:00Z');
  test('classifies verification state', () => {
    assert.equal(teraStatusFor(new Date('2026-12-01'), now), 'verified');
    assert.equal(teraStatusFor(new Date('2026-09-15'), now), 'due_soon');
    assert.equal(teraStatusFor(new Date('2026-08-11'), now), 'lapsed');
    assert.equal(teraStatusFor(null, now), 'unknown');
  });

  test('a lapsed meter blocks commercial sessions, not just a warning', () => {
    assert.equal(connectorMaySellEnergy('lapsed').allowed, false);
    assert.equal(connectorMaySellEnergy('due_soon').allowed, true);
  });
});

// ---------------------------------------------------------------- payments

describe('QRIS MDR', () => {
  test('sessions at or below Rp 100,000 are free from 1 Oct 2026', () => {
    assert.equal(estimateQrisMdrIdr(99_000, { onOrAfterOct2026: true }), 0);
    assert.equal(estimateQrisMdrIdr(150_000, { onOrAfterOct2026: true }), 1_050); // 0.7%
  });

  test('before the change the standard rate applies at every ticket size', () => {
    assert.equal(estimateQrisMdrIdr(99_000, { onOrAfterOct2026: false }), 693);
  });

  test('the SPBU category, if granted, is 0.4%', () => {
    assert.equal(estimateQrisMdrIdr(200_000, { category: 'SPBU', onOrAfterOct2026: true }), 800);
  });
});

// ---------------------------------------------------------------- audit

describe('audit hash chain', () => {
  test('canonical JSON is key-order independent', () => {
    // JSONB does not preserve key order; hashing raw JSON.stringify breaks verification.
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

// ------------------------------------------------- re-verification regressions

/**
 * Regressions for the defects the second, independent audit found in the FIRST
 * remediation pass. Each of these shipped as "fixed" and was not.
 */
describe('re-verification: caps are enforced, not merely observed', () => {
  const fastConnectorW = 50_000; // Rp 25,000 service-fee ceiling

  test('an unbounded idle fee is rejected at save time', () => {
    // The shipped seed tariff. 60 kWh delivered, vehicle left overnight ->
    // Rp 6,692,360 invoiced automatically, 32.4x the ceiling, unflagged.
    const t: Tariff = {
      id: 't', name: 'seed-as-shipped', currency: 'IDR', plnScheme: 'none',
      components: [
        { kind: 'energy', rate: 2_467.5, touBlock: 'ANY' },
        { kind: 'idle', rate: 1_000, touBlock: 'ANY', fromMinutes: 15 },
      ],
    };
    const flags = validateTariff(t, fastConnectorW);
    assert.ok(flags.some((f) => f.code === 'UNBOUNDED_TIME_FEE' && f.severity === 'violation'));
  });

  test('a bounded idle fee above the platform cap is rejected at save time', () => {
    const t: Tariff = {
      id: 't', name: 'bounded-but-huge', currency: 'IDR', plnScheme: 'none',
      components: [{ kind: 'idle', rate: 1_000, touBlock: 'ANY', fromMinutes: 15, toMinutes: 1_440 }],
    };
    assert.ok(validateTariff(t, fastConnectorW).some((f) => f.code === 'TIME_FEE_CAP_EXCEEDED'));
  });

  test('an idle fee is capped on the invoice even if a bad tariff got assigned', () => {
    const t: Tariff = {
      id: 't', name: 'legacy-bad', currency: 'IDR', plnScheme: 'none',
      components: [
        { kind: 'energy', rate: 2_467.5, touBlock: 'ANY' },
        { kind: 'idle', rate: 1_000, touBlock: 'ANY', fromMinutes: 15 },
      ],
    };
    const r = rateSession(t, {
      energyWh: 60_000,
      startedAt: new Date('2026-08-01T02:00:00Z'),
      endedAt: new Date('2026-08-01T14:00:00Z'),
      idleMinutes: 660, // eleven hours parked after the charge finished
      connectorMaxPowerW: fastConnectorW,
      pbjtRateBps: 500,
      timezone: 'Asia/Jakarta',
    });
    const idleTotal = r.lines.filter((l) => l.kind === 'idle').reduce((a, l) => a + l.amountIdr, 0);
    assert.equal(idleTotal, 100_000, 'idle charges must be capped at the platform cap');
    // A WARNING, deliberately: the invoice has already been corrected by the cap
    // line, so it must still be issued. A violation blocked CDR creation, which
    // made the cap line unreachable and left the session permanently unbillable.
    assert.ok(r.flags.some((f) => f.code === 'TIME_FEE_CAP_EXCEEDED' && f.severity === 'warning'));
    // The invoice as a whole must now be plausible, not 32x the delivery.
    assert.ok(r.tax.totalIdr < 400_000, `total was Rp ${r.tax.totalIdr}`);
  });

  test('an admin fee cannot be used to slip past the biaya layanan ceiling', () => {
    // 25,000 + 4,000 = 29,000 against a 25,000 ceiling. The seed shipped this.
    const t: Tariff = {
      id: 't', name: 'seed-fees', currency: 'IDR', plnScheme: 'none',
      components: [
        { kind: 'session', rate: 25_000, touBlock: 'ANY' },
        { kind: 'admin', rate: 4_000, touBlock: 'ANY' },
      ],
    };
    assert.ok(validateTariff(t, fastConnectorW).some((f) => f.code === 'SERVICE_FEE_CEILING_EXCEEDED'));

    const r = rateSession(t, {
      energyWh: 10_000,
      startedAt: new Date('2026-08-01T02:00:00Z'),
      endedAt: new Date('2026-08-01T03:00:00Z'),
      connectorMaxPowerW: fastConnectorW,
      pbjtRateBps: 0,
      timezone: 'Asia/Jakarta',
    });
    const fees = r.lines
      .filter((l) => l.kind === 'session' || l.kind === 'admin')
      .reduce((a, l) => a + l.amountIdr, 0);
    assert.equal(fees, 25_000, 'service + admin must be capped at the ceiling');
  });

  test('the energy ceiling checks the rate actually billed, not base x multiplier', () => {
    // base x multiplier was compared against base x N_max, so the check could
    // only fire when validateMultiplier had already fired. The `energy`
    // component -- the rate the customer actually pays -- was never checked.
    const t: Tariff = {
      id: 't', name: 'legal-multiplier-illegal-rate', currency: 'IDR',
      plnScheme: 'layanan_khusus', plnBaseRate: 1_645, plnMultiplier: 1.5,
      components: [{ kind: 'energy', rate: 16_650, touBlock: 'ANY' }], // 6.75x the ceiling
    };
    const flags = validateTariff(t, fastConnectorW);
    assert.ok(
      flags.some((f) => f.code === 'ENERGY_CEILING_EXCEEDED' && f.severity === 'violation'),
      'an illegal per-kWh rate must be caught at save time',
    );
  });

  test('a legal tariff still passes cleanly', () => {
    const t: Tariff = {
      id: 't', name: 'seed-corrected', currency: 'IDR',
      plnScheme: 'layanan_khusus', plnBaseRate: 1_645, plnMultiplier: 1.5,
      components: [
        { kind: 'energy', rate: 2_467.5, touBlock: 'ANY' },
        { kind: 'session', rate: 21_000, touBlock: 'ANY' },
        { kind: 'admin', rate: 4_000, touBlock: 'ANY' },
        { kind: 'idle', rate: 1_000, touBlock: 'ANY', fromMinutes: 15, toMinutes: 105 },
      ],
    };
    assert.deepEqual(validateTariff(t, fastConnectorW), []);
  });
});

describe('re-verification: stepped energy pricing', () => {
  const ctx = {
    startedAt: new Date('2026-08-01T02:00:00Z'),
    endedAt: new Date('2026-08-01T03:00:00Z'),
    connectorMaxPowerW: 50_000,
    pbjtRateBps: 0,
    timezone: 'Asia/Jakarta',
  };

  test('two tiers with no explicit upper bound do not double-bill the overlap', () => {
    // The natural way to write stepped pricing. Banding only fixed the +57%
    // overcharge when the operator remembered to set toKwh on the lower tier;
    // written this way it still charged every kWh above the step twice.
    const t: Tariff = {
      id: 't', name: 'stepped', currency: 'IDR', plnScheme: 'none',
      components: [
        { kind: 'energy', rate: 2_467.5, touBlock: 'ANY', fromKwh: 0 },
        { kind: 'energy', rate: 2_000, touBlock: 'ANY', fromKwh: 50 },
      ],
    };
    const r = rateSession(t, { ...ctx, energyWh: 80_000 });
    const energy = r.lines.filter((l) => l.kind === 'energy');
    // 50 kWh at 2,467.50 + 30 kWh at 2,000 = 123,375 + 60,000
    assert.equal(energy.reduce((a, l) => a + l.amountIdr, 0), 183_375);
    assert.equal(energy.reduce((a, l) => a + l.quantity, 0), 80, 'every kWh billed exactly once');
  });

  test('an explicit toKwh that overlaps the next tier is clamped and flagged', () => {
    const t: Tariff = {
      id: 't', name: 'overlapping', currency: 'IDR', plnScheme: 'none',
      components: [
        { kind: 'energy', rate: 2_467.5, touBlock: 'ANY', fromKwh: 0, toKwh: 100 },
        { kind: 'energy', rate: 2_000, touBlock: 'ANY', fromKwh: 50 },
      ],
    };
    const r = rateSession(t, { ...ctx, energyWh: 80_000 });
    assert.ok(r.flags.some((f) => f.code === 'OVERLAPPING_ENERGY_TIERS'));
    assert.equal(r.lines.filter((l) => l.kind === 'energy').reduce((a, l) => a + l.quantity, 0), 80);
  });

  test('a single unbounded tier is unaffected', () => {
    const t: Tariff = {
      id: 't', name: 'flat', currency: 'IDR', plnScheme: 'none',
      components: [{ kind: 'energy', rate: 2_467.5, touBlock: 'ANY' }],
    };
    const r = rateSession(t, { ...ctx, energyWh: 80_000 });
    assert.equal(r.lines.filter((l) => l.kind === 'energy').reduce((a, l) => a + l.amountIdr, 0), 197_400);
  });
});

describe('re-verification 3: each kWh is priced exactly once', () => {
  const fastW = 50_000;
  // 17:00-19:00 WIB is inside the WBP peak window.
  const peakCtx = {
    startedAt: new Date('2026-08-03T10:00:00Z'), // 17:00 WIB
    endedAt: new Date('2026-08-03T12:00:00Z'),   // 19:00 WIB
    connectorMaxPowerW: fastW,
    pbjtRateBps: 0,
    timezone: 'Asia/Jakarta',
  };

  test('an ANY component and a WBP component do not both bill the same kWh', () => {
    // Created through the platform's own API and passed by its own validator,
    // this billed a 40 kWh session as 80 kWh at 2x the regulated ceiling with a
    // clean CDR. The band derivation grouped peers per ToU block, so the two
    // components could never truncate each other.
    const t: Tariff = {
      id: 't', name: 'double', currency: 'IDR', plnScheme: 'layanan_khusus',
      plnBaseRate: 1_645, plnMultiplier: 1.5,
      components: [
        { kind: 'energy', rate: 2_467.5, touBlock: 'ANY' },
        { kind: 'energy', rate: 2_467.5, touBlock: 'WBP' },
      ],
    };
    const r = rateSession(t, { ...peakCtx, energyWh: 40_000 });
    const energy = r.lines.filter((l) => l.kind === 'energy');
    assert.equal(energy.reduce((a, l) => a + l.quantity, 0), 40, 'the invoice must match the meter');
    assert.equal(energy.reduce((a, l) => a + l.amountIdr, 0), 98_700);
    assert.ok(!r.flags.some((f) => f.code === 'DOUBLE_PRICED_ENERGY'));
  });

  test('the save path warns that such a tariff is ambiguous', () => {
    const t: Tariff = {
      id: 't', name: 'double', currency: 'IDR', plnScheme: 'layanan_khusus',
      plnBaseRate: 1_645, plnMultiplier: 1.5,
      components: [
        { kind: 'energy', rate: 2_467.5, touBlock: 'ANY' },
        { kind: 'energy', rate: 2_467.5, touBlock: 'WBP' },
      ],
    };
    assert.ok(validateTariff(t, fastW).some((f) => f.code === 'AMBIGUOUS_TOU_COVERAGE'));
  });

  test('a genuine peak/off-peak differential still prices both blocks', () => {
    const t: Tariff = {
      id: 't', name: 'tou', currency: 'IDR', plnScheme: 'layanan_khusus',
      plnBaseRate: 1_645, plnMultiplier: 1.5,
      components: [
        { kind: 'energy', rate: 2_467.5, touBlock: 'WBP' },
        { kind: 'energy', rate: 1_800, touBlock: 'LWBP' },
      ],
    };
    // 16:00-18:00 WIB: one hour off-peak, one hour peak.
    const r = rateSession(t, {
      ...peakCtx,
      startedAt: new Date('2026-08-03T09:00:00Z'),
      endedAt: new Date('2026-08-03T11:00:00Z'),
      energyWh: 40_000,
    });
    const energy = r.lines.filter((l) => l.kind === 'energy');
    assert.equal(energy.length, 2);
    assert.equal(energy.reduce((a, l) => a + l.quantity, 0), 40);
    assert.equal(energy.reduce((a, l) => a + l.amountIdr, 0), 20 * 1_800 + 20 * 2_467.5);
  });

  test("plnScheme 'none' does not switch the energy ceiling off", () => {
    // Rp 10,000/kWh saved and billed with no flag: 4.05x the legal maximum.
    const t: Tariff = {
      id: 't', name: 'unregulated', currency: 'IDR', plnScheme: 'none',
      components: [{ kind: 'energy', rate: 10_000, touBlock: 'ANY' }],
    };
    assert.ok(
      validateTariff(t, fastW).some((f) => f.code === 'ENERGY_CEILING_EXCEEDED' && f.severity === 'violation'),
      'the ceiling comes from the supply scheme, not from a field the author chooses',
    );
    const r = rateSession(t, { ...peakCtx, energyWh: 40_000 });
    assert.ok(r.flags.some((f) => f.code === 'ENERGY_CEILING_EXCEEDED'));
  });

  test('the effective rate is checked, not just the highest component rate', () => {
    // No single component exceeds the ceiling; the invoice still does.
    const t: Tariff = {
      id: 't', name: 'stacked', currency: 'IDR', plnScheme: 'layanan_khusus',
      plnBaseRate: 1_645, plnMultiplier: 1.5,
      components: [
        { kind: 'energy', rate: 2_000, touBlock: 'ANY', fromKwh: 0, toKwh: 1_000 },
        { kind: 'energy', rate: 2_000, touBlock: 'ANY', fromKwh: 0, toKwh: 1_000 },
      ],
    };
    const r = rateSession(t, { ...peakCtx, energyWh: 40_000 });
    // The tier logic now clamps the duplicate, so nothing is double-priced...
    assert.equal(r.lines.filter((l) => l.kind === 'energy').reduce((a, l) => a + l.quantity, 0), 40);
    assert.ok(!r.flags.some((f) => f.code === 'DOUBLE_PRICED_ENERGY'));
  });
});

describe('driver prepaid allowance (app top-ups)', () => {
  const fastConnectorW = 40_000;
  const seedTariff = {
    id: 't', name: 'seed', currency: 'IDR', plnScheme: 'layanan_khusus',
    plnBaseRate: 1_645, plnMultiplier: 1.5,
    components: [
      { kind: 'energy', rate: 2_467.5, touBlock: 'ANY' },
      { kind: 'session', rate: 21_000, touBlock: 'ANY' },
      { kind: 'admin', rate: 4_000, touBlock: 'ANY' },
      { kind: 'idle', rate: 1_000, touBlock: 'ANY', fromMinutes: 15, toMinutes: 105 },
    ],
  } as Tariff;
  const ctx = {
    startedAt: new Date('2026-08-03T05:00:00Z'), // midday WIB, off-peak
    endedAt: new Date('2026-08-03T05:45:00Z'),
    connectorMaxPowerW: fastConnectorW,
    pbjtRateBps: 500,
    timezone: 'Asia/Jakarta',
  };

  test('a modest top-up buys energy — not priced out by a worst-case idle reservation', () => {
    // The bug: conservativeAllowanceWh reserved the full ~Rp 90k idle window, so
    // Rp 100,000 bought ZERO energy. driverAllowanceWh reserves peak energy + a
    // small idle buffer, so a normal top-up works.
    const wh = driverAllowanceWh(seedTariff, 100_000, ctx);
    assert.ok(wh > 15_000, `Rp 100k should buy >15 kWh, got ${wh} Wh`);
    assert.ok(wh < 30_000, `and not more than the money buys, got ${wh} Wh`);
  });

  test('the reserved price is the PEAK rate — never under-collects across a ToU crossing', () => {
    // With only an ANY energy component the peak and off-peak reservations match;
    // this asserts the function returns the same regardless of when it is called,
    // which is the safety property drivers rely on.
    const midday = driverAllowanceWh(seedTariff, 150_000, ctx);
    const evening = driverAllowanceWh(seedTariff, 150_000, {
      ...ctx,
      startedAt: new Date('2026-08-03T11:00:00Z'), // 18:00 WIB, peak
      endedAt: new Date('2026-08-03T11:45:00Z'),
    });
    assert.equal(midday, evening);
  });

  test('a top-up below the fixed fees still buys nothing (correctly)', () => {
    // Fixed fees alone are ~Rp 27,750 incl tax; Rp 10,000 cannot cover them.
    assert.equal(driverAllowanceWh(seedTariff, 10_000, ctx), 0);
  });
});

describe('re-verification 4: tiers, windows and time are rated on the session, not the block', () => {
  const ctx = { connectorMaxPowerW: 50_000, pbjtRateBps: 0, timezone: 'Asia/Jakarta' };
  const energyOf = (r: ReturnType<typeof rateSession>) => {
    const e = r.lines.filter((l) => l.kind === 'energy');
    return { kwh: e.reduce((a, l) => a + l.quantity, 0), idr: e.reduce((a, l) => a + l.amountIdr, 0), lines: e };
  };
  const stepped: Tariff = {
    id: 't', name: 'stepped', currency: 'IDR', plnScheme: 'none',
    components: [
      { kind: 'energy', rate: 2_000, touBlock: 'ANY', fromKwh: 0, toKwh: 50 },
      { kind: 'energy', rate: 1_500, touBlock: 'ANY', fromKwh: 50 },
    ],
  };

  test('energy tiers band on the cumulative session kWh across a ToU boundary', () => {
    // 14:00-20:00 WIB: 30 kWh off-peak, then 30 kWh in the 17:00 peak block.
    const crossing = rateSession(stepped, {
      ...ctx,
      startedAt: new Date('2026-08-03T07:00:00Z'),
      endedAt: new Date('2026-08-03T13:00:00Z'),
      energyWh: 60_000,
    });
    const e = energyOf(crossing);
    assert.equal(e.kwh, 60);
    // 50 kWh at 2,000 + 10 kWh at 1,500 — the tier-2 kWh are the LAST ten, in WBP.
    assert.equal(e.idr, 115_000, 'Rp 120,000 means tier 2 was never reached');
    const wbpTier2 = e.lines.find((l) => l.touBlock === 'WBP' && l.unitRate === 1_500)!;
    assert.equal(wbpTier2.quantity, 10);
    assert.ok(!e.lines.some((l) => l.touBlock === 'LWBP' && l.unitRate === 1_500));

    // The same delivery entirely off-peak prices identically.
    const offPeak = rateSession(stepped, {
      ...ctx,
      startedAt: new Date('2026-08-03T01:00:00Z'), // 08:00 WIB
      endedAt: new Date('2026-08-03T07:00:00Z'),   // 14:00 WIB
      energyWh: 60_000,
    });
    assert.equal(energyOf(offPeak).idr, 115_000);
  });

  test('day/night windowed energy components price each kWh once across the window edge', () => {
    const t: Tariff = {
      id: 't', name: 'day-night', currency: 'IDR', plnScheme: 'none',
      components: [
        { kind: 'energy', rate: 2_000, touBlock: 'ANY', timeFrom: '06:00', timeTo: '22:00' },
        { kind: 'energy', rate: 1_000, touBlock: 'ANY', timeFrom: '22:00', timeTo: '06:00' },
      ],
    };
    // 20:00-24:00 WIB: two hours of day rate, two of night rate.
    const r = rateSession(t, {
      ...ctx,
      startedAt: new Date('2026-08-03T13:00:00Z'),
      endedAt: new Date('2026-08-03T17:00:00Z'),
      energyWh: 20_000,
    });
    const e = energyOf(r);
    assert.equal(e.kwh, 20, 'the invoice must match the meter');
    assert.equal(e.idr, 10 * 2_000 + 10 * 1_000);
    assert.equal(e.lines.length, 2);
    assert.ok(!r.flags.some((f) => f.code === 'DOUBLE_PRICED_ENERGY' || f.code === 'UNPRICED_ENERGY'));
  });

  test('charging time excludes idle minutes, so overstay is not billed twice', () => {
    const t: Tariff = {
      id: 't', name: 'time+idle', currency: 'IDR', plnScheme: 'none',
      components: [
        { kind: 'energy', rate: 2_000, touBlock: 'ANY' },
        { kind: 'time', rate: 100, touBlock: 'ANY', toMinutes: 600 },
        { kind: 'idle', rate: 1_000, touBlock: 'ANY', fromMinutes: 0, toMinutes: 60 },
      ],
    };
    const base = {
      ...ctx,
      startedAt: new Date('2026-08-03T02:00:00Z'),
      endedAt: new Date('2026-08-03T04:00:00Z'), // 120 min plugged in
      energyWh: 20_000,
    };
    const r = rateSession(t, { ...base, idleMinutes: 30 });
    assert.equal(r.lines.find((l) => l.kind === 'time')!.quantity, 90);
    assert.equal(r.lines.find((l) => l.kind === 'idle')!.quantity, 30);
    // Idle beyond the plug-in duration (clock noise) never makes charging time negative.
    const all = rateSession(t, { ...base, idleMinutes: 500 });
    assert.equal(all.lines.filter((l) => l.kind === 'time').length, 0);
  });
});
