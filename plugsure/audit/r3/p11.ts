// Replicate detectRollover exactly (sessions.ts:671) and map its false-positive band.
function detectRollover(startWh:number, stopWh:number){
  const candidates: Array<[string,number]> = [['32-bit',2**32],['24-bit',2**24],['16-bit',2**16],['8-digit Wh',100_000_000],['7-digit Wh',10_000_000],['6-digit Wh',1_000_000],['6-digit kWh',1_000_000_000]];
  for (const [width,max] of candidates){ if(startWh>=max) continue; const e=max-startWh+stopWh; if(e>0&&e<500_000) return {width,energyWh:Math.round(e)}; }
  return null;
}
const L=(s:any)=>console.log(s);
L('start_wh | stop_wh | verdict | phantom kWh billed | phantom Rp (2467.5/kWh + 25k fees + 11% PPN + 5% PBJT)');
const money=(wh:number)=>{const sub=Math.round(wh/1000*2467.5)+25000;const pbjt=Math.round(sub*0.05);const dpp=Math.round((sub+pbjt)*11/12);return sub+pbjt+Math.round(dpp*0.12);};
for (const [a,b,label] of [[45_000,0,'new charger, firmware sends meterStop=0'],[60_000,55_000,'meter swap, register restarts lower'],[10_000,9_000,'per-session register, 1 kWh backwards'],[64_000,100,'near 16-bit boundary'],[65_536,60_000,'just above 16-bit'],[500_000,400_000,'mid-life register backwards'],[5_000_000,0,'mid-life, meterStop=0'],[16_000_000,15_900_000,'24-bit range backwards'],[16_400_000,16_300_000,'inside 24-bit false band'],[99_900_000,99_800_000,'8-digit false band'],[9_999_000,5_000,'GENUINE 7-digit wrap']] as any[]) {
  const r=detectRollover(a,b);
  L(`${String(a).padStart(11)} | ${String(b).padStart(9)} | ${r? 'WRAP('+r.width+')':'parked (backwards)'} | ${r? (r.energyWh/1000).toFixed(3):'-'} | ${r? 'Rp '+money(r.energyWh).toLocaleString('en-US'):'-'}  ${label}`);
}
L('\nFalse-positive bands (any stopWh < startWh is silently treated as a wrap and billed):');
for (const [lo,hi,w] of [[0,65_536,'16-bit'],[16_277_216,16_777_216,'24-bit'],[9_500_000,10_000_000,'7-digit Wh'],[99_500_000,100_000_000,'8-digit Wh'],[500_000,1_000_000,'6-digit Wh']] as any[]) {
  // check the whole band accepts a "backwards by 1 Wh" event
  let all=true; for(let s=lo+1;s<hi;s+=Math.max(1,Math.floor((hi-lo)/500))){ if(!detectRollover(s,s-1)) {all=false;break;} }
  L(`  startWh in [${lo.toLocaleString()}, ${hi.toLocaleString()}) via ${w}: every backwards reading accepted = ${all}`);
}
