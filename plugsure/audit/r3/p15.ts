import {computeTax} from '../../src/services/tax.js';
const a=computeTax({subtotalIdr:218400,pbjtRateBps:500}), b=computeTax({subtotalIdr:119700,pbjtRateBps:500});
console.log('B-03 double-billed: billed',a.totalIdr,'correct',b.totalIdr,'over Rp',a.totalIdr-b.totalIdr);
const c=computeTax({subtotalIdr:400000+21000,pbjtRateBps:500}), d=computeTax({subtotalIdr:98700+21000,pbjtRateBps:500});
console.log('B-07 plnScheme none @Rp10k/kWh: billed',c.totalIdr,'at ceiling',d.totalIdr,'over Rp',c.totalIdr-d.totalIdr);
