import { rateSession, energyAllowanceWh, splitSession, type Tariff } from '../../src/services/tariff.js';
import { computeTax } from '../../src/services/tax.js';

const L = (s: any) => console.log(s);
const seed: Tariff = {
  id: 't', name: 'seed', currency: 'IDR', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5,
  components: [
    { kind: 'energy', rate: 2467.5, touBlock: 'ANY', fromKwh: 0, fromMinutes: 0, sortOrder: 0 },
    { kind: 'session', rate: 21000, touBlock: 'ANY', fromKwh: 0, fromMinutes: 0, sortOrder: 1 },
    { kind: 'admin', rate: 4000, touBlock: 'ANY', fromKwh: 0, fromMinutes: 0, sortOrder: 2 },
    { kind: 'idle', rate: 1000, touBlock: 'ANY', fromKwh: 0, fromMinutes: 15, toMinutes: 105, sortOrder: 3 },
  ],
};
const baseCtx = {
  startedAt: new Date('2026-03-02T03:00:00Z'), endedAt: new Date('2026-03-02T04:00:00Z'),
  connectorMaxPowerW: 60000, pbjtRateBps: 500, timezone: 'Asia/Jakarta',
};

L('=== A. seed tariff, 40 kWh, 1h, no idle ===');
const a = rateSession(seed, { ...baseCtx, energyWh: 40000 });
L(JSON.stringify(a.lines, null, 1));
L(JSON.stringify(a.tax));
L('flags: ' + JSON.stringify(a.flags));

L('\n=== B. line quantity x unitRate vs amount consistency ===');
for (const wh of [12345, 33333, 7777, 1]) {
  const r = rateSession(seed, { ...baseCtx, energyWh: wh });
  for (const l of r.lines) {
    const impl = Math.round(l.quantity * l.unitRate);
    if (impl !== l.amountIdr) L(`  MISMATCH wh=${wh} ${l.description}: qty ${l.quantity} x ${l.unitRate} = ${impl} but amount = ${l.amountIdr}`);
  }
}
L(' (no output above = consistent)');

L('\n=== C. ANY + WBP tier double-billing check ===');
const t2: Tariff = { ...seed, components: [
  { kind: 'energy', rate: 2000, touBlock: 'ANY', fromKwh: 0, sortOrder: 0 },
  { kind: 'energy', rate: 500, touBlock: 'WBP', fromKwh: 0, sortOrder: 1 },
]};
const c = rateSession(t2, { startedAt: new Date('2026-03-02T10:00:00Z'), endedAt: new Date('2026-03-02T12:00:00Z'), energyWh: 40000, connectorMaxPowerW: 60000, pbjtRateBps: 0, timezone: 'Asia/Jakarta' });
L(JSON.stringify(c.lines.map(l=>[l.description,l.quantity,l.amountIdr])));
L('flags: ' + JSON.stringify(c.flags.map(f=>f.code)));

L('\n=== D. WBP/LWBP split across the 17:00 boundary (Asia/Jakarta) ===');
// 16:00 -> 18:00 WIB == 09:00 -> 11:00 UTC
const s = splitSession(new Date('2026-03-02T09:00:00Z'), new Date('2026-03-02T11:00:00Z'), 40000, [], 'Asia/Jakarta');
L(JSON.stringify(s.tou) + ' (expect WBP 20000 / LWBP 20000)');
// midnight crossing 23:00 -> 01:00 WIB
const s2 = splitSession(new Date('2026-03-02T16:00:00Z'), new Date('2026-03-02T18:00:00Z'), 40000, [], 'Asia/Jakarta');
L('midnight cross: ' + JSON.stringify(s2.tou));

L('\n=== E. component with a night window 00:00-06:00 across midnight ===');
const night: Tariff = { ...seed, plnScheme: 'none', components: [
  { kind: 'energy', rate: 2000, touBlock: 'ANY', timeFrom: '00:00', timeTo: '06:00', fromKwh: 0, sortOrder: 0 },
]};
// 23:00 -> 03:00 WIB = 16:00 -> 20:00 UTC
const e = rateSession(night, { startedAt: new Date('2026-03-02T16:00:00Z'), endedAt: new Date('2026-03-02T20:00:00Z'), energyWh: 40000, connectorMaxPowerW: 60000, pbjtRateBps: 0, timezone: 'Asia/Jakarta' });
L(JSON.stringify(e.lines.map(l=>[l.description,l.quantity,l.amountIdr])) + ' expect 30 kWh priced');
L('flags: ' + JSON.stringify(e.flags.map(f=>f.code)));

L('\n=== F. service fee ceiling: 21000+4000=25000 exactly at fast ceiling; try 60kW ultrafast ===');
L('fast(50kW): ' + JSON.stringify(rateSession(seed, {...baseCtx, connectorMaxPowerW: 50000, energyWh: 40000}).flags.map(f=>f.code)));
L('medium(22kW): ' + JSON.stringify(rateSession(seed, {...baseCtx, connectorMaxPowerW: 22000, energyWh: 40000}).flags.map(f=>f.code)));

L('\n=== G. idle cap interaction with tax ===');
const bigIdle: Tariff = { ...seed, components: [
  ...seed.components.filter(c=>c.kind!=='idle'),
  { kind: 'idle', rate: 5000, touBlock: 'ANY', fromKwh: 0, fromMinutes: 0, toMinutes: 600, sortOrder: 3 },
]};
const g = rateSession(bigIdle, { ...baseCtx, energyWh: 40000, idleMinutes: 300 });
L(JSON.stringify(g.lines.map(l=>[l.kind,l.description,l.amountIdr])));
L(JSON.stringify(g.tax));
L('flags: ' + JSON.stringify(g.flags.map(f=>f.code)));

L('\n=== H. inverse rating agreement (with and without idle) ===');
for (const amt of [50000, 100000, 150000, 250000, 33900, 33800]) {
  const wh = energyAllowanceWh(seed, amt, baseCtx);
  const fwd = rateSession(seed, { ...baseCtx, energyWh: wh });
  const fwd1 = rateSession(seed, { ...baseCtx, energyWh: wh + 1 });
  L(`  amt=${amt} -> ${wh} Wh; forward total=${fwd.tax.totalIdr} (<=amt: ${fwd.tax.totalIdr<=amt}); wh+1 total=${fwd1.tax.totalIdr}`);
}

L('\n=== I. zero and negative energy ===');
for (const wh of [0, -1, -5000]) {
  const r = rateSession(seed, { ...baseCtx, energyWh: wh });
  L(`  wh=${wh}: subtotal=${r.tax.subtotalIdr} total=${r.tax.totalIdr} flags=${JSON.stringify(r.flags.map(f=>f.code))}`);
  L(`      lines=${JSON.stringify(r.lines.map(l=>[l.kind,l.quantity,l.amountIdr]))}`);
}
const noComp: Tariff = { id:'x',name:'x',currency:'IDR',plnScheme:'layanan_khusus',plnMultiplier:1.5,components:[]};
L('  no-component tariff, wh=-5000: ' + JSON.stringify(rateSession(noComp, {...baseCtx, energyWh:-5000}).lines));

L('\n=== J. tax worked example ===');
L(JSON.stringify(computeTax({ subtotalIdr: 100000, pbjtRateBps: 0 })));
L('expect DPP 91667, PPN 11000');
