import { computeTax, clampBps, effectivePpnRateBps } from '../../plugsure/src/services/tax.js';
import { config } from '../../plugsure/src/config.js';

const L = (s: string) => console.log(s);

L('=== A. regulation worked example ===');
L(JSON.stringify(computeTax({ subtotalIdr: 12_000_000, pbjtRateBps: 0 })));

L('\n=== B. tiny amounts, pbjt=0 ===');
L('amt | dpp | ppn | total | effective%');
for (const a of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 23, 50, 99, 100]) {
  const r = computeTax({ subtotalIdr: a, pbjtRateBps: 0 });
  L(`${a} | ${r.ppnDppIdr} | ${r.ppnIdr} | ${r.totalIdr} | ${((r.ppnIdr / a) * 100).toFixed(3)}`);
}

L('\n=== C. is round(round(11/12*P)*0.12) ever != round(0.11*P)? (P=1..200000) ===');
let diffs = 0, firstDiffs: number[] = [], maxAbs = 0;
for (let p = 1; p <= 200_000; p++) {
  const r = computeTax({ subtotalIdr: p, pbjtRateBps: 0 });
  const flat = Math.round(p * 0.11);
  if (r.ppnIdr !== flat) {
    diffs++;
    if (firstDiffs.length < 12) firstDiffs.push(p);
    maxAbs = Math.max(maxAbs, Math.abs(r.ppnIdr - flat));
  }
}
L(`differs on ${diffs}/200000 amounts (${((diffs / 200000) * 100).toFixed(2)}%), max |delta| = Rp ${maxAbs}`);
L(`first differing amounts: ${firstDiffs.join(', ')}`);
for (const p of firstDiffs.slice(0, 4)) {
  const r = computeTax({ subtotalIdr: p, pbjtRateBps: 0 });
  L(`  P=${p}: 11/12*P=${((p * 11) / 12).toFixed(4)} -> DPP=${r.ppnDppIdr}, PPN=${r.ppnIdr}; flat 11% = ${Math.round(p * 0.11)}`);
}

L('\n=== D. exact-vs-rounded PPN per session, and monthly drift over 10,000 realistic sessions ===');
// realistic Indonesian public DC session: energy 5-60 kWh @ 2467.5 + 25000 service + 4000 admin
function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry(20260823);
const PBJT = 500;
let sumSub = 0, sumPbjt = 0, sumDpp = 0, sumPpn = 0, sumTotal = 0;
let sumExactPpn = 0;
const subs: number[] = [];
for (let i = 0; i < 10_000; i++) {
  const kwh = 5 + rnd() * 55;
  const sub = Math.round(kwh * 2467.5) + 25_000 + 4_000;
  subs.push(sub);
  const r = computeTax({ subtotalIdr: sub, pbjtRateBps: PBJT });
  sumSub += r.subtotalIdr;
  sumPbjt += r.pbjtIdr;
  sumDpp += r.ppnDppIdr;
  sumPpn += r.ppnIdr;
  sumTotal += r.totalIdr;
  const base = r.subtotalIdr + r.pbjtIdr;
  sumExactPpn += ((base * 11) / 12) * 0.12;
}
// aggregate (as a monthly faktur would compute it on the summed base)
const aggBase = sumSub + sumPbjt;
const aggDpp = Math.round((aggBase * 11) / 12);
const aggPpn = Math.round((aggDpp * 1200) / 10_000);
L(`sessions            : 10000`);
L(`sum subtotal        : Rp ${sumSub.toLocaleString('en-US')}`);
L(`sum PBJT (per-sess) : Rp ${sumPbjt.toLocaleString('en-US')}   agg PBJT = ${Math.round((sumSub * PBJT) / 10_000).toLocaleString('en-US')}  drift=${sumPbjt - Math.round((sumSub * PBJT) / 10_000)}`);
L(`sum DPP  (per-sess) : Rp ${sumDpp.toLocaleString('en-US')}`);
L(`agg DPP  (on sum)   : Rp ${aggDpp.toLocaleString('en-US')}   drift = Rp ${sumDpp - aggDpp}`);
L(`sum PPN  (per-sess) : Rp ${sumPpn.toLocaleString('en-US')}`);
L(`agg PPN  (on sum)   : Rp ${aggPpn.toLocaleString('en-US')}   drift = Rp ${sumPpn - aggPpn}`);
L(`exact (unrounded)PPN: Rp ${sumExactPpn.toFixed(2)}  vs per-sess ${sumPpn} drift=${(sumPpn - sumExactPpn).toFixed(2)}`);
L(`drift as ppm of PPN : ${(((sumPpn - aggPpn) / sumPpn) * 1e6).toFixed(2)} ppm`);
L(`sum total           : Rp ${sumTotal.toLocaleString('en-US')}`);

L('\n=== E. pbjtInsidePpnBase both ways (subtotal 100,000, pbjt 5%) ===');
const insideOn = computeTax({ subtotalIdr: 100_000, pbjtRateBps: 500 });
L(`inside=true : ${JSON.stringify(insideOn)}`);
(config.tax as any).pbjtInsidePpnBase = false;
const insideOff = computeTax({ subtotalIdr: 100_000, pbjtRateBps: 500 });
L(`inside=false: ${JSON.stringify(insideOff)}`);
L(`delta total = Rp ${insideOn.totalIdr - insideOff.totalIdr} (${(((insideOn.totalIdr - insideOff.totalIdr) / insideOff.totalIdr) * 100).toFixed(3)}%)`);
(config.tax as any).pbjtInsidePpnBase = true;

L('\n=== F. clampBps misconfiguration behaviour ===');
for (const v of [500, 1000, 1001, 5000, -1, NaN, Infinity, undefined as any, null as any, '750' as any, 0.4, 1e9]) {
  L(`clampBps(${String(v)}) = ${clampBps(v)}`);
}
L(`effectivePpnRateBps() = ${effectivePpnRateBps()}`);

L('\n=== G. rounding unit > 1 (e.g. Rp 100) ===');
(config.tax as any).roundingUnitIdr = 100;
const ru = computeTax({ subtotalIdr: 78_350, pbjtRateBps: 500 });
L(JSON.stringify(ru));
L(`components sum to ${ru.subtotalIdr + ru.pbjtIdr + ru.ppnIdr} but totalIdr = ${ru.totalIdr} -> unreconcilable delta Rp ${ru.totalIdr - (ru.subtotalIdr + ru.pbjtIdr + ru.ppnIdr)}`);
(config.tax as any).roundingUnitIdr = 1;

L('\n=== H. non-integer subtotal / negative subtotal ===');
L(`subtotal 100.5 -> ${JSON.stringify(computeTax({ subtotalIdr: 100.5, pbjtRateBps: 500 }))}`);
L(`subtotal -1000 -> ${JSON.stringify(computeTax({ subtotalIdr: -1000, pbjtRateBps: 500 }))}`);
L(`subtotal NaN   -> ${JSON.stringify(computeTax({ subtotalIdr: NaN, pbjtRateBps: 500 }))}`);
