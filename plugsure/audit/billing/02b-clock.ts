import { splitEnergyByTou, rateSession, type Tariff } from '../../plugsure/src/services/tariff.js';
const L=(s:string)=>console.log(s);
L('=== splitEnergyByTou cost vs session span (Intl.DateTimeFormat per minute) ===');
for (const mins of [60, 1440, 10080, 43200]) {
  const a = new Date('2026-01-01T00:00:00Z');
  const b = new Date(a.getTime() + mins*60_000);
  const t0=process.hrtime.bigint();
  splitEnergyByTou(a,b,20_000);
  const ms = Number(process.hrtime.bigint()-t0)/1e6;
  L(`  span ${String(mins).padStart(6)} min -> ${ms.toFixed(1)} ms  (${(ms/mins*1000).toFixed(1)} us/iteration)`);
}
const perMin = (() => {
  const a=new Date('2026-01-01T00:00:00Z'), b=new Date(a.getTime()+43200*60_000);
  const t0=process.hrtime.bigint(); splitEnergyByTou(a,b,20_000);
  return Number(process.hrtime.bigint()-t0)/1e6/43200;
})();
for (const [label, mins] of [['1 year clock skew', 525_600],['charger clock at 1970 epoch (56.6 y)', 56.6*525_600]] as [string,number][]) {
  L(`  ${label}: ${Math.round(mins).toLocaleString('en-US')} iterations -> projected ${(perMin*mins/1000).toFixed(0)} s = ${(perMin*mins/1000/60).toFixed(1)} min of BLOCKED event loop`);
}
