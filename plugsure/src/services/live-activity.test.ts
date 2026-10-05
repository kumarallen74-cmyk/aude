import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveActivityPayload, planFor, contentOf, MIN_INTERVAL_S, HEARTBEAT_S, ESTIMATE_STEP_IDR, STALE_S, DISMISS_S, END_WITHOUT_CDR_S, type Snapshot, type ContentState } from './live-activity.js';

const t0 = new Date('2026-09-28T10:00:00Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  sessionState: 'active', energyWh: 5000, powerW: 50_000, socPercent: 40, progressPct: null,
  startedAt: t0, endedAt: null, cdrTotalMinor: null, ...over,
});

test('payloads: update with a stale date, end with a dismissal date, start (push-to-start) with attributes and an alert', () => {
  const c = contentOf(snap());
  assert.deepEqual(c, { status: 'charging', energyWh: 5000, powerW: 50_000, socPercent: 40, progressPct: null, costIdr: null, estimateIdr: null, startedAt: t0.getTime() / 1000, endedAt: null });
  const u = liveActivityPayload('update', c, at(60).getTime()).aps as any;
  assert.equal(u.event, 'update');
  assert.equal(u.timestamp, t0.getTime() / 1000 + 60);
  assert.equal(u['stale-date'], u.timestamp + STALE_S);
  assert.equal(u['dismissal-date'], undefined);
  assert.deepEqual(u['content-state'], c);
  const e = liveActivityPayload('end', { ...c, status: 'finished' }, at(60).getTime()).aps as any;
  assert.equal(e['dismissal-date'], e.timestamp + DISMISS_S);
  assert.equal(e['stale-date'], undefined);
  const s = liveActivityPayload('start', c, t0.getTime(), {
    attributes: { ref: 'abc', site: 'Hub', connector: 'DC 60 kW', appName: 'NusaCharge', accentHex: '#ff8a00' }, alert: { title: 'Pengisian dimulai', body: 'Hub' },
  }).aps as any;
  assert.equal(s['attributes-type'], 'ChargingAttributes', 'must match the Swift type name');
  assert.equal(s.attributes.ref, 'abc');
  assert.equal(s.alert.title, 'Pengisian dimulai', 'push-to-start requires an alert');
});

test('planning: the first update at once (priority 10), then only real changes at most every 30 s at priority 5, and a heartbeat for the stale date', () => {
  const none = { content: null, status: null, sentAt: null };
  const first = planFor(none, snap(), at(5));
  assert.deepEqual([first.action, (first as any).priority], ['update', 10]);
  const last = { content: contentOf(snap()) as ContentState, status: 'charging', sentAt: at(5) };
  assert.equal(planFor(last, snap({ energyWh: 5200 }), at(5 + MIN_INTERVAL_S - 1)).action, 'none', 'too soon');
  const later = planFor(last, snap({ energyWh: 5200 }), at(5 + MIN_INTERVAL_S));
  assert.deepEqual([later.action, (later as any).priority], ['update', 5]);
  assert.equal(planFor(last, snap({ energyWh: 5020 }), at(5 + MIN_INTERVAL_S)).action, 'none', '20 Wh is not worth an update');
  assert.equal(planFor(last, snap(), at(5 + HEARTBEAT_S)).action, 'update', 'nothing changed, but the stale date must move');
  assert.equal(planFor(last, snap({ socPercent: 41 }), at(5 + MIN_INTERVAL_S)).action, 'update', 'battery level changed');
});

test('planning the end: "finished" once, then the end with the cost when rated, or after 5 minutes without', () => {
  const charging = { content: contentOf(snap()) as ContentState, status: 'charging', sentAt: at(100) };
  const ended = snap({ sessionState: 'ended', endedAt: at(120), energyWh: 12_500 });
  const fin = planFor(charging, ended, at(121));
  assert.deepEqual([fin.action, (fin as any).priority, (fin as any).content.status, (fin as any).content.powerW], ['update', 10, 'finished', null]);
  const finished = { content: (fin as any).content, status: 'finished', sentAt: at(121) };
  assert.equal(planFor(finished, ended, at(150)).action, 'none', 'said once');
  const rated = planFor(finished, snap({ sessionState: 'rated', endedAt: at(120), energyWh: 12_500, cdrTotalMinor: 31_450 }), at(160));
  assert.deepEqual([rated.action, (rated as any).content.costIdr], ['end', 31_450]);
  assert.equal(planFor(finished, ended, at(120 + END_WITHOUT_CDR_S)).action, 'end', 'no charge record: end anyway');
});

test('the cost so far: carried while charging, replaced by the final cost, and an update only for a real change', () => {
  assert.equal(contentOf(snap({ estimateIdr: 23_415.4 })).estimateIdr, 23_415, 'whole rupiah');
  const rated = contentOf(snap({ sessionState: 'rated', endedAt: at(120), cdrTotalMinor: 31_450, estimateIdr: 31_000 }));
  assert.deepEqual([rated.costIdr, rated.estimateIdr], [31_450, null], 'never an estimate beside the final cost');
  // Finished but not rated yet: the estimate stays, so the lock screen is not blank for up to 5 minutes.
  assert.equal(contentOf(snap({ sessionState: 'ended', endedAt: at(120), estimateIdr: 31_000 })).estimateIdr, 31_000);

  const last = { content: contentOf(snap({ estimateIdr: 20_000 })) as ContentState, status: 'charging', sentAt: at(5) };
  const soon = at(5 + MIN_INTERVAL_S);
  assert.equal(planFor(last, snap({ estimateIdr: 20_000 + ESTIMATE_STEP_IDR - 1 }), soon).action, 'none', 'a few rupiah is not worth an update');
  // Idle fee: the car is full (energy flat) but the cost keeps rising; the driver must see it.
  assert.equal(planFor(last, snap({ estimateIdr: 20_000 + ESTIMATE_STEP_IDR }), soon).action, 'update', 'idle fee rising');
  assert.equal(planFor(last, snap({ estimateIdr: 25_000 }), at(5 + MIN_INTERVAL_S - 1)).action, 'none', 'still at most every 30 s');
  assert.equal(planFor({ ...last, content: contentOf(snap()) as ContentState }, snap({ estimateIdr: 100 }), soon).action, 'update', 'the first estimate arrives');
});

test('a ringgit or Singapore-dollar session carries no cost: the installed widget formats costIdr / estimateIdr as rupiah', () => {
  for (const currency of ['MYR', 'SGD']) {
    const running = contentOf({ ...snap(), currency, estimateIdr: 1234 });
    assert.equal(running.estimateIdr, null);
    assert.equal(running.costIdr, null);
    assert.equal(running.currency, currency);
    assert.equal(contentOf({ ...snap(), currency, sessionState: 'rated', cdrTotalMinor: 1234 }).costIdr, null);
  }
  // Rupiah exactly as v1.6.
  assert.equal(contentOf({ ...snap(), currency: 'IDR', estimateIdr: 12345 }).estimateIdr, 12345);
  assert.equal(contentOf({ ...snap(), sessionState: 'rated', cdrTotalMinor: 30000 }).costIdr, 30000);
});
