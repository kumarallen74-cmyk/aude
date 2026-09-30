import {
  rateSession,
  splitEnergyByTou,
  energyAllowanceWh,
  validateTariff,
  type Tariff,
} from '../../plugsure/src/services/tariff.js';

const L = (s: string) => console.log(s);
const sum = (r: any, kind: string) => r.lines.filter((l: any) => l.kind === kind).reduce((a: number, l: any) => a + l.amountIdr, 0);
const show = (r: any) =>
  r.lines.map((l: any) => `${l.kind}${l.touBlock ? '/' + l.touBlock : ''} ${l.quantity}${l.unit} @${l.unitRate} = ${l.amountIdr}`).join('\n    ');

const baseCtx = {
  connectorMaxPowerW: 60_000,
  pbjtRateBps: 500,
};

// ---------------------------------------------------------------- 2a ToU units
L('=== 2a. ToU unit check: is (byTou[block] ?? 0)/1000 in kWh? ===');
// Session 16:00-18:00 WIB = 09:00-11:00Z, 20 kWh. WBP starts 17:00 WIB -> exactly half.
const s1 = new Date('2026-08-23T09:00:00Z');
const e1 = new Date('2026-08-23T11:00:00Z');
const split = splitEnergyByTou(s1, e1, 20_000);
L(`splitEnergyByTou(20000 Wh) = ${JSON.stringify(split)}  (units: Wh)`);

const touTariff: Tariff = {
  id: 't', name: 'ToU', currency: 'IDR', plnScheme: 'none',
  components: [
    { kind: 'energy', rate: 3000, touBlock: 'WBP', sortOrder: 0 },
    { kind: 'energy', rate: 2000, touBlock: 'LWBP', sortOrder: 1 },
  ],
};
const rTou = rateSession(touTariff, { ...baseCtx, startedAt: s1, endedAt: e1, energyWh: 20_000 });
L(`  ${show(rTou)}`);
L(`expected: 10 kWh WBP @3000 = 30000 ; 10 kWh LWBP @2000 = 20000 ; total energy 50000`);
L(`actual energy subtotal: ${sum(rTou, 'energy')}`);
L(`total kWh billed: ${rTou.lines.filter((l: any) => l.kind === 'energy').reduce((a: number, l: any) => a + l.quantity, 0)} (should be 20)`);

L('\n=== 2b. WBP + LWBP both present: billed once, twice, or partially? ===');
const flatTou: Tariff = {
  id: 't', name: 'ToU flat', currency: 'IDR', plnScheme: 'none',
  components: [
    { kind: 'energy', rate: 2467.5, touBlock: 'WBP', sortOrder: 0 },
    { kind: 'energy', rate: 2467.5, touBlock: 'LWBP', sortOrder: 1 },
  ],
};
const rFlat = rateSession(flatTou, { ...baseCtx, startedAt: s1, endedAt: e1, energyWh: 20_000 });
const singleTariff: Tariff = {
  id: 't', name: 'flat', currency: 'IDR', plnScheme: 'none',
  components: [{ kind: 'energy', rate: 2467.5, touBlock: 'ANY', sortOrder: 0 }],
};
const rSingle = rateSession(singleTariff, { ...baseCtx, startedAt: s1, endedAt: e1, energyWh: 20_000 });
L(`ToU(WBP+LWBP both @2467.5) energy = ${sum(rFlat, 'energy')} ; single ANY component = ${sum(rSingle, 'energy')}`);
L(`  identical? ${sum(rFlat, 'energy') === sum(rSingle, 'energy')} (delta ${sum(rFlat, 'energy') - sum(rSingle, 'energy')} — Wh->kWh rounding of the split)`);

L('\n=== 2b2. ONLY a WBP component, session fully in LWBP -> energy silently unbilled? ===');
const wbpOnly: Tariff = {
  id: 't', name: 'WBP only', currency: 'IDR', plnScheme: 'none',
  components: [{ kind: 'energy', rate: 2467.5, touBlock: 'WBP', sortOrder: 0 }],
};
const rWbpOnly = rateSession(wbpOnly, {
  ...baseCtx,
  startedAt: new Date('2026-08-23T02:00:00Z'), // 09:00 WIB, all LWBP
  endedAt: new Date('2026-08-23T03:00:00Z'),
  energyWh: 30_000,
});
L(`30 kWh delivered, lines = ${JSON.stringify(rWbpOnly.lines)}  subtotal = ${rWbpOnly.tax.subtotalIdr}`);

// ---------------------------------------------------------------- 2c dayMask/time window
L('\n=== 2c. dayMask / timeFrom / timeTo: used in rating? ===');
const windowed: Tariff = {
  id: 't', name: 'weekend-only 06:00-08:00', currency: 'IDR', plnScheme: 'none',
  components: [
    { kind: 'energy', rate: 9_999, touBlock: 'ANY', dayMask: 0, timeFrom: '06:00', timeTo: '08:00', sortOrder: 0 },
  ],
};
const rWin = rateSession(windowed, {
  ...baseCtx,
  startedAt: new Date('2026-08-24T02:00:00Z'), // Monday 09:00 WIB — outside BOTH the dayMask (0 = no days) and the window
  endedAt: new Date('2026-08-24T03:00:00Z'),
  energyWh: 10_000,
});
L(`dayMask=0 (no days), window 06:00-08:00, session Monday 09:00 WIB:`);
L(`  ${show(rWin)}`);
L(`  -> component with dayMask=0 STILL BILLED: ${sum(rWin, 'energy') > 0}`);

// ---------------------------------------------------------------- 2d stepped pricing
L('\n=== 2d. Stepped pricing (fromKwh): two-tier tariff ===');
const stepped: Tariff = {
  id: 't', name: 'first 50 kWh @2000, above 50 @1500', currency: 'IDR', plnScheme: 'none',
  components: [
    { kind: 'energy', rate: 2000, touBlock: 'ANY', fromKwh: 0, sortOrder: 0 },
    { kind: 'energy', rate: 1500, touBlock: 'ANY', fromKwh: 50, sortOrder: 1 },
  ],
};
for (const kwh of [20, 50, 60, 100]) {
  const r = rateSession(stepped, {
    ...baseCtx, pbjtRateBps: 0,
    startedAt: new Date('2026-08-23T02:00:00Z'),
    endedAt: new Date('2026-08-23T04:00:00Z'),
    energyWh: kwh * 1000,
  });
  const intendedTier = Math.min(kwh, 50) * 2000 + Math.max(0, kwh - 50) * 1500;
  L(`${kwh} kWh: lines -> ${r.lines.map((l: any) => `${l.quantity}kWh@${l.unitRate}=${l.amountIdr}`).join(' + ')} = ${sum(r, 'energy')}`);
  L(`   intended tiered price = ${intendedTier}  |  OVERCHARGE = ${sum(r, 'energy') - intendedTier}`);
}

// ---------------------------------------------------------------- 2e degenerate sessions
L('\n=== 2e. Degenerate sessions ===');
const std: Tariff = {
  id: 't', name: 'Public DC', currency: 'IDR', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5,
  components: [
    { kind: 'energy', rate: 2467.5, touBlock: 'ANY', sortOrder: 0 },
    { kind: 'session', rate: 25_000, touBlock: 'ANY', sortOrder: 1 },
    { kind: 'admin', rate: 4_000, touBlock: 'ANY', sortOrder: 2 },
  ],
};
const cases: Array<[string, any]> = [
  ['zero energy', { startedAt: new Date('2026-08-23T02:00:00Z'), endedAt: new Date('2026-08-23T03:00:00Z'), energyWh: 0 }],
  ['negative energy', { startedAt: new Date('2026-08-23T02:00:00Z'), endedAt: new Date('2026-08-23T03:00:00Z'), energyWh: -5000 }],
  ['ended < started', { startedAt: new Date('2026-08-23T03:00:00Z'), endedAt: new Date('2026-08-23T02:00:00Z'), energyWh: 20_000 }],
  ['ended == started', { startedAt: new Date('2026-08-23T03:00:00Z'), endedAt: new Date('2026-08-23T03:00:00Z'), energyWh: 20_000 }],
  ['spans midnight WIB', { startedAt: new Date('2026-08-23T16:00:00Z'), endedAt: new Date('2026-08-23T20:00:00Z'), energyWh: 40_000 }],
  ['spans WBP window fully', { startedAt: new Date('2026-08-23T08:00:00Z'), endedAt: new Date('2026-08-23T16:00:00Z'), energyWh: 40_000 }],
];
for (const [name, c] of cases) {
  const r = rateSession(std, { ...baseCtx, ...c });
  L(`${name.padEnd(26)} subtotal=${String(r.tax.subtotalIdr).padStart(8)} total=${String(r.tax.totalIdr).padStart(8)}  lines: ${r.lines.map((l: any) => `${l.kind}:${l.amountIdr}`).join(',')}`);
}

L('\n--- negative energy detail ---');
const neg = rateSession({ ...std, components: [{ kind: 'energy', rate: 2467.5, touBlock: 'WBP', sortOrder: 0 }, { kind: 'energy', rate: 2467.5, touBlock: 'LWBP', sortOrder: 1 }] }, {
  ...baseCtx, startedAt: s1, endedAt: e1, energyWh: -5000,
});
L(`ToU tariff, energyWh = -5000: ${JSON.stringify(neg.lines)} subtotal=${neg.tax.subtotalIdr}`);

// ---------------------------------------------------------------- 2f wrong clock / perf
L('\n=== 2f. Charger with a wrong clock ===');
const clockCases: Array<[string, Date, Date]> = [
  ['ended 1 day ahead', new Date('2026-08-23T02:00:00Z'), new Date('2026-08-24T02:00:00Z')],
  ['ended 30 days ahead', new Date('2026-08-23T02:00:00Z'), new Date('2026-09-22T02:00:00Z')],
  // 1970 case removed: does not terminate in reasonable time (see 02b-clock.ts)
];
for (const [name, a, b] of clockCases) {
  const t0 = Date.now();
  const r = rateSession(std, { ...baseCtx, startedAt: a, endedAt: b, energyWh: 20_000 });
  const ms = Date.now() - t0;
  L(`${name.padEnd(28)} total=${r.tax.totalIdr} rated in ${ms} ms  (${r.lines.map((l: any) => l.kind + ':' + l.amountIdr).join(',')})`);
}

L('\n=== 2f2. splitEnergyByTou cost as a function of session length ===');
for (const days of [1]) {
  const a = new Date('2026-01-01T00:00:00Z');
  const b = new Date(a.getTime() + days * 86_400_000);
  const t0 = Date.now();
  splitEnergyByTou(a, b, 20_000);
  L(`  ${String(days).padStart(4)} day span -> ${Date.now() - t0} ms, ${days * 1440} iterations`);
}

// ---------------------------------------------------------------- 3 ceiling
L('\n=== 3. Regulatory ceiling: does rateSession still bill an over-ceiling tariff? ===');
const illegal: Tariff = {
  id: 't', name: 'ILLEGAL', currency: 'IDR', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 3.0,
  components: [
    { kind: 'energy', rate: 9_000, touBlock: 'ANY', sortOrder: 0 },
    { kind: 'session', rate: 250_000, touBlock: 'ANY', sortOrder: 1 },
  ],
};
L(`validateTariff flags: ${JSON.stringify(validateTariff(illegal, 60_000).map((f) => f.code))}`);
const rIllegal = rateSession(illegal, {
  ...baseCtx, startedAt: new Date('2026-08-23T02:00:00Z'), endedAt: new Date('2026-08-23T03:00:00Z'), energyWh: 20_000,
});
L(`rateSession flags: ${JSON.stringify(rIllegal.flags.map((f) => f.code + '/' + f.severity))}`);
L(`rateSession STILL PRODUCED A BILL: subtotal=${rIllegal.tax.subtotalIdr} total=Rp ${rIllegal.tax.totalIdr.toLocaleString('en-US')}`);
L(`energy rate ${9000}/kWh vs layanan khusus ceiling ${1645 * 1.5}/kWh`);
L('NOTE: validateTariff only flags ENERGY_CEILING_EXCEEDED from the PLN formula, not from an explicit energy component:');
L(`  explicit 9000/kWh energy component flagged? ${validateTariff({ ...illegal, plnScheme: 'none', plnMultiplier: undefined }, 60_000).map((f) => f.code).join(',') || 'NO FLAGS'}`);
