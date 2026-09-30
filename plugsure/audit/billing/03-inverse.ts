import { energyAllowanceWh, rateSession, type Tariff } from '../../plugsure/src/services/tariff.js';
const L = (s: string) => console.log(s);

const ctx = {
  startedAt: new Date('2026-08-23T02:00:00Z'),
  endedAt: new Date('2026-08-23T02:45:00Z'),
  connectorMaxPowerW: 60_000,
  pbjtRateBps: 500,
};

const shapes: Array<[string, Tariff]> = [
  ['energy only 2467.5', { id: 'a', name: 'a', currency: 'IDR', plnScheme: 'none', components: [{ kind: 'energy', rate: 2467.5, touBlock: 'ANY' }] }],
  ['energy + 25k session + 4k admin', { id: 'b', name: 'b', currency: 'IDR', plnScheme: 'none', components: [
    { kind: 'energy', rate: 2467.5, touBlock: 'ANY' }, { kind: 'session', rate: 25_000, touBlock: 'ANY' }, { kind: 'admin', rate: 4_000, touBlock: 'ANY' }] }],
  ['session fee 250k (>> prepaid)', { id: 'c', name: 'c', currency: 'IDR', plnScheme: 'none', components: [
    { kind: 'energy', rate: 2467.5, touBlock: 'ANY' }, { kind: 'session', rate: 250_000, touBlock: 'ANY' }] }],
  ['ZERO energy rate, no PLN scheme', { id: 'd', name: 'd', currency: 'IDR', plnScheme: 'none', components: [{ kind: 'energy', rate: 0, touBlock: 'ANY' }] }],
  ['no components, PLN formula only', { id: 'e', name: 'e', currency: 'IDR', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, components: [] }],
  ['time component only (energy-free)', { id: 'f', name: 'f', currency: 'IDR', plnScheme: 'none', components: [{ kind: 'time', rate: 500, touBlock: 'ANY' }] }],
  ['very cheap 1 IDR/kWh', { id: 'g', name: 'g', currency: 'IDR', plnScheme: 'none', components: [{ kind: 'energy', rate: 1, touBlock: 'ANY' }] }],
];

L('=== 4a. round trip: is rateSession(allowance).total ever ABOVE the prepaid amount? ===');
let overcharges = 0;
let worstOver = 0, worstCase = '';
let worstUnder = 0, worstUnderCase = '';
for (const [name, t] of shapes) {
  const rows: string[] = [];
  for (const amt of [1, 100, 1_000, 5_000, 10_000, 25_000, 50_000, 75_000, 100_000, 150_000, 500_000, 2_000_000, 10_000_000]) {
    const t0 = Date.now();
    let wh: number;
    try { wh = energyAllowanceWh(t, amt, ctx); } catch (e: any) { rows.push(`  amt ${amt}: THREW ${e.message}`); continue; }
    const ms = Date.now() - t0;
    const back = rateSession(t, { ...ctx, energyWh: wh });
    const delta = back.tax.totalIdr - amt;
    if (delta > 0) { overcharges++; if (delta > worstOver) { worstOver = delta; worstCase = `${name} @ Rp ${amt}`; } }
    const under = amt - back.tax.totalIdr;
    if (under > worstUnder && wh > 0) { worstUnder = under; worstUnderCase = `${name} @ Rp ${amt}`; }
    // also check one Wh more is strictly over budget (tightness)
    const plus1 = rateSession(t, { ...ctx, energyWh: wh + 1 });
    rows.push(`  amt ${String(amt).padStart(9)} -> ${String(wh).padStart(9)} Wh, rated ${String(back.tax.totalIdr).padStart(9)} (delta ${delta > 0 ? '+' : ''}${delta})  +1Wh=${plus1.tax.totalIdr}${plus1.tax.totalIdr <= amt ? '  <-- NOT TIGHT' : ''} [${ms}ms]`);
  }
  L(`\n-- ${name}`);
  rows.forEach((r) => L(r));
}
L(`\novercharging round trips: ${overcharges}; worst overcharge Rp ${worstOver} (${worstCase})`);
L(`worst underspend: Rp ${worstUnder} (${worstUnderCase})`);

L('\n=== 4b. 500 kWh hard ceiling ===');
const cheap: Tariff = { id: 'g', name: 'g', currency: 'IDR', plnScheme: 'none', components: [{ kind: 'energy', rate: 1, touBlock: 'ANY' }] };
for (const amt of [400_000, 500_000, 600_000, 1_000_000]) {
  const wh = energyAllowanceWh(cheap, amt, ctx);
  const back = rateSession(cheap, { ...ctx, energyWh: wh });
  L(`  Rp ${amt} at 1 IDR/kWh -> ${wh} Wh (${wh / 1000} kWh), rated Rp ${back.tax.totalIdr}; driver overpaid Rp ${amt - back.tax.totalIdr} (${(((amt - back.tax.totalIdr) / amt) * 100).toFixed(1)}% of the payment buys nothing)`);
}

L('\n=== 4c. zero energy rate: divergence / hang? ===');
const zero: Tariff = { id: 'd', name: 'd', currency: 'IDR', plnScheme: 'none', components: [{ kind: 'energy', rate: 0, touBlock: 'ANY' }] };
const t0 = Date.now();
const zwh = energyAllowanceWh(zero, 100_000, ctx);
L(`  allowance for Rp 100,000 at 0 IDR/kWh = ${zwh} Wh (${zwh / 1000} kWh) in ${Date.now() - t0} ms -> capped at the hardcoded bound, not infinite`);

L('\n=== 4d. session fee > prepaid amount ===');
const bigfee: Tariff = { id: 'c', name: 'c', currency: 'IDR', plnScheme: 'none', components: [
  { kind: 'energy', rate: 2467.5, touBlock: 'ANY' }, { kind: 'session', rate: 250_000, touBlock: 'ANY' }] };
for (const amt of [50_000, 100_000, 250_000, 300_000]) {
  const wh = energyAllowanceWh(bigfee, amt, ctx);
  const back = rateSession(bigfee, { ...ctx, energyWh: wh });
  L(`  paid Rp ${amt} -> allowance ${wh} Wh; rating that allowance costs Rp ${back.tax.totalIdr} (${back.tax.totalIdr > amt ? 'ABOVE what was paid' : 'ok'})`);
}

L('\n=== 4e. 40 iterations over a 500,000 Wh range: resolution ===');
L(`  500000 / 2^40 = ${500_000 / 2 ** 40} Wh -> converged; but the search then Math.floor()s. Check monotonic tightness above.`);

L('\n=== 4f. does the allowance context match the real session? (API uses now..now+45min) ===');
const short = { ...ctx, endedAt: new Date(ctx.startedAt.getTime() + 45 * 60_000) };
const longSession = { ...ctx, endedAt: new Date(ctx.startedAt.getTime() + 180 * 60_000) };
const timed: Tariff = { id: 'f', name: 'f', currency: 'IDR', plnScheme: 'none', components: [
  { kind: 'energy', rate: 2467.5, touBlock: 'ANY' }, { kind: 'time', rate: 500, touBlock: 'ANY' }] };
const whShort = energyAllowanceWh(timed, 100_000, short);
const ratedLong = rateSession(timed, { ...longSession, energyWh: whShort });
L(`  allowance computed assuming a 45-min session: ${whShort} Wh`);
L(`  the driver actually stays 180 min -> rated Rp ${ratedLong.tax.totalIdr} vs Rp 100,000 prepaid = OVERRUN Rp ${ratedLong.tax.totalIdr - 100_000}`);
