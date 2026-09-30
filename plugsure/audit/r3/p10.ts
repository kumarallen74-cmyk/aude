import { rateSession, energyAllowanceWh, splitSession, type Tariff } from '../../src/services/tariff.js';
const L=(s:any)=>console.log(s);

L('=== S1. splitSession sampling bias at the 17:00 WBP boundary ===');
// session 16:30 -> 17:30 WIB (09:30 -> 10:30 UTC), 30 kWh; true split = 15/15
for (const mins of [60, 61, 59, 7, 3, 1]) {
  const start = new Date('2026-08-24T09:30:00Z');
  const end = new Date(start.getTime()+mins*60000);
  const s = splitSession(start, end, 30000, [], 'Asia/Jakarta');
  const trueWbp = Math.max(0, Math.min(mins, mins-30)) ; // minutes after 17:00
  L(`  ${mins} min from 16:30 -> WBP=${s.tou.WBP} Wh LWBP=${s.tou.LWBP}; true WBP minutes=${Math.max(0,mins-30)} => ${Math.round(30000*Math.max(0,mins-30)/mins)} Wh`);
}

L('\n=== S2. sub-minute and 90-second sessions ===');
for (const secs of [30, 90, 150]) {
  const start=new Date('2026-08-24T09:59:30Z'); const end=new Date(start.getTime()+secs*1000);
  const s=splitSession(start,end,1000,[],'Asia/Jakarta');
  L(`  ${secs}s spanning 16:59:30->${new Date(end).toISOString()}: WBP=${s.tou.WBP} LWBP=${s.tou.LWBP} (17:00 WIB = 10:00Z)`);
}

L('\n=== S3. prepaid allowance under a WBP/LWBP differential when the session crosses the boundary ===');
const diff: Tariff = { id:'d',name:'d',currency:'IDR',plnScheme:'layanan_khusus',plnBaseRate:1645,plnMultiplier:1.5, components:[
  {kind:'energy',rate:2467.5,touBlock:'WBP',fromKwh:0,sortOrder:0},
  {kind:'energy',rate:1600,touBlock:'LWBP',fromKwh:0,sortOrder:1},
  {kind:'session',rate:21000,touBlock:'ANY',sortOrder:2},
]};
// checkout at 16:30 WIB assuming 45 min
const t0 = new Date('2026-08-24T09:30:00Z');
const ctxQuote = { startedAt:t0, endedAt:new Date(t0.getTime()+45*60000), connectorMaxPowerW:60000, pbjtRateBps:500, timezone:'Asia/Jakarta' };
const allow = energyAllowanceWh(diff, 200_000, ctxQuote);
L(`  quoted allowance for Rp 200,000 = ${allow} Wh (quote assumes 45 min from 16:30)`);
for (const realMin of [45, 20, 120]) {
  const r = rateSession(diff, { ...ctxQuote, endedAt:new Date(t0.getTime()+realMin*60000), energyWh: allow });
  L(`    session actually ran ${realMin} min -> billed Rp ${r.tax.totalIdr} (paid 200,000, delta ${r.tax.totalIdr-200000})`);
}

L('\n=== S4. same, quote made entirely inside LWBP but session slips into WBP ===');
const t1 = new Date('2026-08-24T08:00:00Z'); // 15:00 WIB
const ctxQ2 = { startedAt:t1, endedAt:new Date(t1.getTime()+45*60000), connectorMaxPowerW:60000, pbjtRateBps:500, timezone:'Asia/Jakarta' };
const allow2 = energyAllowanceWh(diff, 200_000, ctxQ2);
L(`  quoted allowance = ${allow2} Wh (15:00-15:45 WIB, all LWBP @1600)`);
const r2 = rateSession(diff, { ...ctxQ2, endedAt:new Date(t1.getTime()+180*60000), energyWh: allow2 });
L(`  actual 15:00-18:00 WIB -> Rp ${r2.tax.totalIdr}; paid 200,000; SHORTFALL Rp ${r2.tax.totalIdr-200000}`);
L(`  lines ${JSON.stringify(r2.lines.map(l=>[l.description,l.quantity,l.amountIdr]))}`);

L('\n=== S5. rounding: per-line vs single-line for a banded tariff, 10k random energies ===');
const band: Tariff = { ...diff, components:[
  {kind:'energy',rate:2467.5,touBlock:'ANY',fromKwh:0,toKwh:20,sortOrder:0},
  {kind:'energy',rate:2467.5,touBlock:'ANY',fromKwh:20,sortOrder:1},
  {kind:'session',rate:21000,touBlock:'ANY',sortOrder:2},
]};
const flat: Tariff = { ...diff, components:[
  {kind:'energy',rate:2467.5,touBlock:'ANY',fromKwh:0,sortOrder:0},
  {kind:'session',rate:21000,touBlock:'ANY',sortOrder:1},
]};
let worst=0, worstWh=0, n=0;
for (let wh=1; wh<=100000; wh+=7) {
  const a=rateSession(band,{...ctxQuote,energyWh:wh}).tax.totalIdr;
  const b=rateSession(flat,{...ctxQuote,energyWh:wh}).tax.totalIdr;
  if(a!==b){n++; if(Math.abs(a-b)>worst){worst=Math.abs(a-b);worstWh=wh;}}
}
L(`  identical-rate banded vs flat differ on ${n} energies, max delta Rp ${worst} (at ${worstWh} Wh)`);

L('\n=== S6. cap-adjustment line + tax: is PPN computed on the capped or uncapped amount? ===');
const capT: Tariff = { ...diff, components:[
  {kind:'energy',rate:2467.5,touBlock:'ANY',fromKwh:0,sortOrder:0},
  {kind:'session',rate:21000,touBlock:'ANY',sortOrder:1},
  {kind:'idle',rate:2000,touBlock:'ANY',fromMinutes:0,toMinutes:300,sortOrder:2},
]};
const rc = rateSession(capT,{...ctxQuote,energyWh:40000,idleMinutes:200});
L(`  lines ${JSON.stringify(rc.lines.map(l=>[l.kind,l.amountIdr]))}`);
L(`  tax ${JSON.stringify(rc.tax)}`);
L(`  flags ${JSON.stringify(rc.flags.map(f=>f.code))}  <- violation => rateAndCreateCdr parks it, so this invoice never issues`);
