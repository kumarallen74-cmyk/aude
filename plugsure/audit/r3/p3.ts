import { validateTariff, rateSession, type Tariff } from '../../src/services/tariff.js';
const L = (s:any)=>console.log(s);
const ctx = { startedAt: new Date('2026-03-02T10:00:00Z'), endedAt: new Date('2026-03-02T12:00:00Z'), connectorMaxPowerW: 60000, pbjtRateBps: 500, timezone: 'Asia/Jakarta' };

L('=== A. two energy tiers at the ceiling rate, both covering all energy ===');
const t: Tariff = { id:'a',name:'a',currency:'IDR',plnScheme:'layanan_khusus',plnBaseRate:1645,plnMultiplier:1.5, components:[
  { kind:'energy', rate:2467.5, touBlock:'ANY', fromKwh:0 },
  { kind:'energy', rate:2467.5, touBlock:'WBP', fromKwh:0 },
]};
L('validateTariff flags: ' + JSON.stringify(validateTariff(t, 60000).map(f=>f.code)));
const r = rateSession(t, { ...ctx, energyWh: 40000 });
L('lines: ' + JSON.stringify(r.lines.map(l=>[l.description,l.quantity,l.amountIdr])));
L('subtotal: ' + r.tax.subtotalIdr + '  effective Rp/kWh = ' + (r.tax.subtotalIdr/40));
L('flags: ' + JSON.stringify(r.flags.map(f=>f.code)));

L('\n=== B. same, but LWBP+WBP splitting (legit) ===');
const t2: Tariff = { ...t, components:[
  { kind:'energy', rate:2467.5, touBlock:'WBP', fromKwh:0 },
  { kind:'energy', rate:2000, touBlock:'LWBP', fromKwh:0 },
]};
const r2 = rateSession(t2, { startedAt:new Date('2026-03-02T09:00:00Z'), endedAt:new Date('2026-03-02T11:00:00Z'), energyWh:40000, connectorMaxPowerW:60000, pbjtRateBps:0, timezone:'Asia/Jakarta' });
L('lines: ' + JSON.stringify(r2.lines.map(l=>[l.description,l.quantity,l.amountIdr])) + ' flags ' + JSON.stringify(r2.flags.map(f=>f.code)));

L('\n=== C. two ANY tiers same band (duplicate row) ===');
const t3: Tariff = { ...t, components:[
  { kind:'energy', rate:2467.5, touBlock:'ANY', fromKwh:0 },
  { kind:'energy', rate:2467.5, touBlock:'ANY', fromKwh:0 },
]};
L('validate: '+JSON.stringify(validateTariff(t3,60000).map(f=>f.code)));
const r3 = rateSession(t3, {...ctx, energyWh:40000});
L('lines: '+JSON.stringify(r3.lines.map(l=>[l.description,l.quantity,l.amountIdr]))+' flags '+JSON.stringify(r3.flags.map(f=>f.code)));

L('\n=== D. session ceiling: two session components 20000 + 20000 ===');
const t4: Tariff = { ...t, components:[
  { kind:'energy', rate:2467.5, touBlock:'ANY', fromKwh:0 },
  { kind:'session', rate:20000, touBlock:'ANY' },
  { kind:'session', rate:20000, touBlock:'ANY' },
]};
L('validate: '+JSON.stringify(validateTariff(t4,60000).map(f=>f.code)));
const r4 = rateSession(t4, {...ctx, energyWh:40000});
L('lines: '+JSON.stringify(r4.lines.map(l=>[l.kind,l.amountIdr]))+' flags '+JSON.stringify(r4.flags.map(f=>f.code))+' subtotal '+r4.tax.subtotalIdr);

L('\n=== E. banded tiers: 0-50 @2467.5, 50+ @2000 ===');
const t5: Tariff = { ...t, components:[
  { kind:'energy', rate:2467.5, touBlock:'ANY', fromKwh:0, sortOrder:0 },
  { kind:'energy', rate:2000, touBlock:'ANY', fromKwh:50, sortOrder:1 },
]};
for (const kwh of [30,50,60,80]) {
  const rr = rateSession(t5, {...ctx, energyWh: kwh*1000});
  L(`  ${kwh} kWh -> ${JSON.stringify(rr.lines.map(l=>[l.description,l.quantity,l.amountIdr]))} sub=${rr.tax.subtotalIdr} flags=${JSON.stringify(rr.flags.map(f=>f.code))}`);
}

L('\n=== F. banded WBP tiers where session is part WBP: pool interaction ===');
const t6: Tariff = { ...t, components:[
  { kind:'energy', rate:2467.5, touBlock:'WBP', fromKwh:0, toKwh:10, sortOrder:0 },
  { kind:'energy', rate:2000, touBlock:'WBP', fromKwh:10, sortOrder:1 },
  { kind:'energy', rate:1800, touBlock:'LWBP', fromKwh:0, sortOrder:2 },
]};
const r6 = rateSession(t6, { startedAt:new Date('2026-03-02T09:00:00Z'), endedAt:new Date('2026-03-02T11:00:00Z'), energyWh:40000, connectorMaxPowerW:60000, pbjtRateBps:0, timezone:'Asia/Jakarta' });
L(JSON.stringify(r6.lines.map(l=>[l.description,l.quantity,l.amountIdr]))+' flags '+JSON.stringify(r6.flags.map(f=>f.code)));

L('\n=== G. ultrafast ceiling with 57000 fees on a 60kW connector, and 25000 check at exactly 50kW/50001W ===');
import { chargingClassForPowerW } from '../../src/domain/spklu.js';
for (const w of [7000,7001,22000,22001,50000,50001,60000,150000]) L(`  ${w} W -> ${chargingClassForPowerW(w)}`);
