import type { HostedStatus, RoamingStatus } from '@/api/types';
import { canStop, hostedPhase, initialSession, pollInterval, reduceSession, roamingPhase, startSteps, toSnapshot, type SessionState } from '../sessionMachine';

const hosted = (state: HostedStatus['state'], extra: Partial<HostedStatus> = {}): HostedStatus => ({
  state, chargeId: 'c1', mode: 'prepaid', energyKwh: 0, powerKw: null, durationMin: 0, startedAt: null, amountMinor: 100000, allowanceKwh: null,
  progressPct: null, estimatedMinor: null, currency: 'IDR', siteName: 'Senayan', connectorLabel: 'DC 120 kW', hasReceipt: false, ...extra,
});
const roaming = (state: RoamingStatus['state'], extra: Partial<RoamingStatus> = {}): RoamingStatus => ({
  chargeId: 'r1', state, problem: null, energyKwh: 0, durationMin: 0, startedAt: null, totalMinor: null, currency: 'SGD',
  hold: { amountMinor: 8000, currency: 'SGD', state: 'authorised', holdState: 'held', capturedMinor: null, checkoutUrl: null },
  cdrId: null, siteName: 'Woodlands', operator: 'Bay Charge SG', connectorLabel: 'CCS2', canStop: state === 'charging', ...extra,
});
const run = (st: SessionState, ...evs: Parameters<typeof reduceSession>[1][]) => evs.reduce(reduceSession, st);

describe('phase mapping', () => {
  it('maps every hosted server state', () => {
    expect(hostedPhase('awaiting_payment')).toBe('paying');
    expect(hostedPhase('awaiting_start')).toBe('starting');
    expect(hostedPhase('charging')).toBe('charging');
    expect(hostedPhase('finishing')).toBe('finishing');
    expect(hostedPhase('ended')).toBe('completed');
    expect(hostedPhase('rated')).toBe('completed');
    expect(hostedPhase('refund_pending')).toBe('refunding');
    expect(hostedPhase('refunded')).toBe('refunded');
    expect(hostedPhase('released')).toBe('released');
    expect(hostedPhase('unknown')).toBe('unknown');
  });
  it('maps every roaming server state', () => {
    expect(roamingPhase('paying')).toBe('paying');
    expect(roamingPhase('starting')).toBe('starting');
    expect(roamingPhase('rejected')).toBe('failed');
    expect(roamingPhase('charging')).toBe('charging');
    expect(roamingPhase('finishing')).toBe('finishing');
    expect(roamingPhase('billed')).toBe('completed');
  });
  it('builds the snapshot from either shape (cost, limit, SoC, receipt ref)', () => {
    const h = toSnapshot(hosted('rated', { energyKwh: 12.5, cost: { totalMinor: 34000, subtotalMinor: 30000, taxTotalMinor: 4000, discountMinor: 0, idleFeeMinor: 0, idleMinutes: 0, asOf: '', final: true }, hasReceipt: true, socPercent: 80 }));
    expect(h.snapshot).toMatchObject({ energyKwh: 12.5, costMinor: 34000, limitMinor: 100000, socPercent: 80, receiptRef: 'c1', costFinal: true });
    const r = toSnapshot(roaming('billed', { cdrId: 'cdr9', totalMinor: 2239 }));
    expect(r.phase).toBe('completed');
    expect(r.snapshot).toMatchObject({ costMinor: 2239, limitMinor: 8000, operator: 'Bay Charge SG', receiptRef: 'cdr9', currency: 'SGD' });
  });
});

describe('start timeout — never stuck in "starting"', () => {
  it('hosted: times out after 45 s in starting', () => {
    let st = run(initialSession('charge', 'c1', 0), { type: 'snapshot', status: hosted('awaiting_start'), at: 1000 });
    st = reduceSession(st, { type: 'tick', at: 45_000 });
    expect(st.startTimedOut).toBe(false);
    st = reduceSession(st, { type: 'tick', at: 46_001 });
    expect(st.startTimedOut).toBe(true);
    // Charging clears it.
    st = reduceSession(st, { type: 'snapshot', status: hosted('charging', { energyKwh: 0.1 }), at: 50_000 });
    expect(st.startTimedOut).toBe(false);
    expect(st.phase).toBe('charging');
  });
  it('roaming: allows 90 s (partner CPOs are slower)', () => {
    let st = run(initialSession('roaming', 'r1', 0), { type: 'snapshot', status: roaming('starting'), at: 0 });
    st = reduceSession(st, { type: 'tick', at: 60_000 });
    expect(st.startTimedOut).toBe(false);
    st = reduceSession(st, { type: 'tick', at: 90_000 });
    expect(st.startTimedOut).toBe(true);
  });
  it('the timeout counts from entering starting, not from the first poll', () => {
    let st = run(initialSession('charge', 'c1', 0), { type: 'snapshot', status: hosted('awaiting_payment'), at: 0 });
    st = reduceSession(st, { type: 'snapshot', status: hosted('awaiting_start'), at: 120_000 });
    st = reduceSession(st, { type: 'tick', at: 130_000 });
    expect(st.startTimedOut).toBe(false);
  });
  it('a refused partner start ends in failed with the operator reason', () => {
    const st = run(initialSession('roaming', 'r1', 0), { type: 'snapshot', status: roaming('rejected', { problem: 'Charger is in use.' }), at: 1 });
    expect(st.phase).toBe('failed');
    expect(st.snapshot?.problem).toBe('Charger is in use.');
    expect(pollInterval(st, true)).toBeNull();
  });
});

describe('connection and stop', () => {
  it('shows reconnecting after two failed polls, recovers on the next snapshot', () => {
    let st = run(initialSession('charge', 'c1', 0), { type: 'snapshot', status: hosted('charging'), at: 0 }, { type: 'poll_failed', at: 5000 });
    expect(st.connection).toBe('online');
    st = reduceSession(st, { type: 'poll_failed', at: 10_000 });
    expect(st.connection).toBe('reconnecting');
    expect(canStop(st)).toBe(true); // Stop stays available offline.
    expect(pollInterval(st, true)).toBe(8000);
    st = reduceSession(st, { type: 'snapshot', status: hosted('charging'), at: 15_000 });
    expect(st.connection).toBe('online');
    expect(st.failures).toBe(0);
  });
  it('stop: requested → sent → finishing clears it; failure keeps the message', () => {
    let st = run(initialSession('charge', 'c1', 0), { type: 'snapshot', status: hosted('charging'), at: 0 }, { type: 'stop_requested', at: 1 });
    expect(st.stop).toBe('requested');
    st = reduceSession(st, { type: 'stop_sent', at: 2 });
    expect(st.stop).toBe('sent');
    expect(canStop(st)).toBe(false);
    expect(pollInterval(st, true)).toBe(2500);
    st = reduceSession(st, { type: 'snapshot', status: hosted('finishing'), at: 3 });
    expect(st.stop).toBe('idle');

    let f = run(initialSession('charge', 'c1', 0), { type: 'snapshot', status: hosted('charging'), at: 0 }, { type: 'stop_requested', at: 1 }, { type: 'stop_failed', message: 'Charger offline', at: 2 });
    expect(f.stop).toBe('failed');
    expect(f.stopError).toBe('Charger offline');
    expect(canStop(f)).toBe(true);
    f = reduceSession(f, { type: 'stop_requested', at: 3 });
    expect(f.stopError).toBeNull();
  });
  it('a session the server does not know (404) is an end state: polling stops, no "Reconnecting…", no start timeout', () => {
    let st = run(initialSession('charge', 'c1', 0), { type: 'poll_failed', at: 1000 }, { type: 'not_found', at: 2000 });
    expect(st.missing).toBe(true);
    expect(st.connection).toBe('online');
    expect(pollInterval(st, true)).toBeNull();
    st = run(initialSession('charge', 'c1', 0), { type: 'snapshot', status: hosted('awaiting_start'), at: 0 }, { type: 'not_found', at: 1 }, { type: 'tick', at: 120_000 });
    expect(st.startTimedOut).toBe(false);
    expect(pollInterval(st, true)).toBeNull();
  });
  it('ignores stop outside charging', () => {
    const st = run(initialSession('charge', 'c1', 0), { type: 'snapshot', status: hosted('awaiting_start'), at: 0 }, { type: 'stop_requested', at: 1 });
    expect(st.stop).toBe('idle');
  });
});

describe('polling cadence', () => {
  const at = (s: HostedStatus['state']) => run(initialSession('charge', 'c1', 0), { type: 'snapshot', status: hosted(s), at: 0 });
  it('polls fast while paying/starting, 5 s while charging, never when terminal or backgrounded', () => {
    expect(pollInterval(at('awaiting_payment'), true)).toBe(2500);
    expect(pollInterval(at('awaiting_start'), true)).toBe(2000);
    expect(pollInterval(at('charging'), true)).toBe(5000);
    expect(pollInterval(at('rated'), true)).toBeNull();
    expect(pollInterval(at('refunded'), true)).toBeNull();
    expect(pollInterval(at('charging'), false)).toBeNull();
  });
  it('keeps the last 30 power samples for the sparkline', () => {
    let st = initialSession('charge', 'c1', 0);
    for (let i = 0; i < 40; i++) st = reduceSession(st, { type: 'snapshot', status: hosted('charging', { powerKw: i }), at: i });
    expect(st.powerHistory).toHaveLength(30);
    expect(st.powerHistory[29]).toBe(39);
  });
});

describe('start timeline', () => {
  it('marks steps as the session progresses', () => {
    let st = run(initialSession('charge', 'c1', 0), { type: 'snapshot', status: hosted('awaiting_payment'), at: 0 });
    expect(startSteps(st).map((s) => [s.key, s.done, s.active])).toEqual([
      ['paid', false, true], ['accepted', false, false], ['connected', false, false], ['charging', false, false],
    ]);
    st = reduceSession(st, { type: 'snapshot', status: hosted('awaiting_start'), at: 1000 });
    expect(startSteps(st)[0]).toMatchObject({ done: true });
    expect(startSteps(st)[1]).toMatchObject({ active: true });
    st = reduceSession(st, { type: 'snapshot', status: hosted('awaiting_start'), at: 6000 });
    expect(startSteps(st)[1]).toMatchObject({ done: true });
    expect(startSteps(st)[2]).toMatchObject({ active: true });
    st = reduceSession(st, { type: 'snapshot', status: hosted('charging'), at: 8000 });
    expect(startSteps(st).every((s) => s.done)).toBe(true);
  });
});
