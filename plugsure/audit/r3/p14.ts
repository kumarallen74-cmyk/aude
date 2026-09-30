import { computeTax } from '../../src/services/tax.js';
const L=(s:any)=>console.log(s);
L('=== PBJT base: applied to the full subtotal including biaya layanan + admin ===');
const energy=Math.round(40*2467.5), fees=25000;
const asBuilt=computeTax({subtotalIdr:energy+fees,pbjtRateBps:500});
// PBJT on tenaga listrik only
const pbjtEnergyOnly=Math.round(energy*0.05);
const base2=energy+fees+pbjtEnergyOnly;
const dpp2=Math.round(base2*11/12), ppn2=Math.round(dpp2*0.12);
L(`  as built : PBJT=${asBuilt.pbjtIdr} DPP=${asBuilt.ppnDppIdr} PPN=${asBuilt.ppnIdr} TOTAL=${asBuilt.totalIdr}`);
L(`  energy-only PBJT base: PBJT=${pbjtEnergyOnly} DPP=${dpp2} PPN=${ppn2} TOTAL=${base2+ppn2}`);
L(`  delta per session = Rp ${asBuilt.totalIdr-(base2+ppn2)}  (x 1,000 sessions/day = Rp ${((asBuilt.totalIdr-(base2+ppn2))*1000).toLocaleString('en-US')}/day)`);
