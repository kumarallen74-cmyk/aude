import type { HostedState, HostedStatus, RoamingState, RoamingStatus } from '@/api/types';

/**
 * The charge session as the app models it, for hosted (direct) and partner (roaming) charges alike.
 * Pure and deterministic (tests drive it with explicit timestamps). Rules from spec §1.3 / §6.6 / §6.7:
 *   - never leave "starting" without an exit: after the start timeout (hosted 45 s, roaming 90 s) the UI says so
 *     and offers next steps while it keeps asking the server, which resolves the hold / refund;
 *   - Stop is always available while charging, also offline (queued; the charger can be stopped physically);
 *   - a lost connection freezes the figures with "Reconnecting…" instead of guessing;
 *   - a session the server does not know (404) is an end state, not a lost connection: polling stops.
 */
export type SessionKind = 'charge' | 'roaming';
export type Phase = 'paying' | 'starting' | 'charging' | 'finishing' | 'completed' | 'failed' | 'refunding' | 'refunded' | 'released' | 'unknown';

export const TERMINAL: ReadonlySet<Phase> = new Set(['completed', 'failed', 'refunded', 'released']);
export const START_TIMEOUT_MS: Record<SessionKind, number> = { charge: 45_000, roaming: 90_000 };
/** Consecutive failed polls before showing "Reconnecting…". */
const OFFLINE_AFTER_FAILURES = 2;

export interface Snapshot {
  energyKwh: number;
  powerKw: number | null;
  socPercent: number | null;
  costMinor: number | null;
  /** The prepaid amount, or a roaming card hold. */
  limitMinor: number | null;
  currency: string | null;
  progressPct: number | null;
  startedAt: string | null;
  durationMin: number;
  siteName: string;
  connectorLabel: string;
  operator: string | null;
  problem: string | null;
  refundMinor: number | null;
  receiptRef: string | null;
  costFinal: boolean;
  /** What the cost so far is made of (hosted charges): it includes fixed fees and tax, so it starts above zero. */
  costParts?: { subtotalMinor: number; taxMinor: number; idleMinor: number; discountMinor: number } | null;
}

export interface SessionState {
  kind: SessionKind;
  id: string;
  phase: Phase;
  /** When the current phase was entered (ms). */
  since: number;
  snapshot: Snapshot | null;
  startTimedOut: boolean;
  stop: 'idle' | 'requested' | 'sent' | 'failed';
  stopError: string | null;
  connection: 'online' | 'reconnecting';
  failures: number;
  lastUpdate: number | null;
  /** Energy samples for the power sparkline (last 30). */
  powerHistory: number[];
  /** The server does not know this session (404): nothing more to follow. */
  missing: boolean;
}

export type SessionEvent =
  | { type: 'snapshot'; status: HostedStatus | RoamingStatus; at: number }
  | { type: 'poll_failed'; at: number }
  | { type: 'not_found'; at: number }
  | { type: 'tick'; at: number }
  | { type: 'stop_requested'; at: number }
  | { type: 'stop_sent'; at: number }
  | { type: 'stop_failed'; message: string; at: number };

export function initialSession(kind: SessionKind, id: string, at: number): SessionState {
  return { kind, id, phase: 'unknown', since: at, snapshot: null, startTimedOut: false, stop: 'idle', stopError: null, connection: 'online', failures: 0, lastUpdate: null, powerHistory: [], missing: false };
}

export function hostedPhase(s: HostedState): Phase {
  switch (s) {
    case 'awaiting_payment':
      return 'paying';
    case 'awaiting_start':
      return 'starting';
    case 'charging':
      return 'charging';
    case 'finishing':
      return 'finishing';
    case 'ended':
    case 'rated':
      return 'completed';
    case 'refund_pending':
      return 'refunding';
    case 'refunded':
      return 'refunded';
    case 'released':
      return 'released';
    default:
      return 'unknown';
  }
}

export function roamingPhase(s: RoamingState): Phase {
  switch (s) {
    case 'paying':
      return 'paying';
    case 'starting':
      return 'starting';
    case 'rejected':
      return 'failed';
    case 'charging':
      return 'charging';
    case 'finishing':
      return 'finishing';
    case 'billed':
      return 'completed';
    default:
      return 'unknown';
  }
}

function isRoaming(s: HostedStatus | RoamingStatus): s is RoamingStatus {
  return 'canStop' in s;
}

export function toSnapshot(s: HostedStatus | RoamingStatus): { phase: Phase; snapshot: Snapshot } {
  if (isRoaming(s)) {
    return {
      phase: roamingPhase(s.state),
      snapshot: {
        energyKwh: s.energyKwh,
        powerKw: null,
        socPercent: null,
        costMinor: s.totalMinor,
        limitMinor: s.hold?.amountMinor ?? null,
        currency: s.currency ?? s.hold?.currency ?? null,
        progressPct: null,
        startedAt: s.startedAt,
        durationMin: s.durationMin,
        siteName: s.siteName,
        connectorLabel: s.connectorLabel,
        operator: s.operator || null,
        problem: s.problem,
        refundMinor: null,
        receiptRef: s.cdrId,
        costFinal: s.state === 'billed',
      },
    };
  }
  return {
    phase: hostedPhase(s.state),
    snapshot: {
      energyKwh: s.energyKwh,
      powerKw: s.powerKw,
      socPercent: s.socPercent ?? s.v2x?.socPercent ?? null,
      costMinor: s.cost?.totalMinor ?? s.estimatedMinor,
      costParts: s.cost ? { subtotalMinor: s.cost.subtotalMinor, taxMinor: s.cost.taxTotalMinor, idleMinor: s.cost.idleFeeMinor, discountMinor: s.cost.discountMinor } : null,
      limitMinor: s.mode === 'prepaid' ? s.amountMinor : null,
      currency: s.currency,
      progressPct: s.progressPct,
      startedAt: s.startedAt,
      durationMin: s.durationMin,
      siteName: s.siteName,
      connectorLabel: s.connectorLabel,
      operator: null,
      problem: null,
      refundMinor: s.refund?.amountMinor ?? null,
      receiptRef: s.hasReceipt ? s.chargeId : null,
      costFinal: !!s.cost?.final,
    },
  };
}

export function reduceSession(st: SessionState, ev: SessionEvent): SessionState {
  switch (ev.type) {
    case 'snapshot': {
      const { phase, snapshot } = toSnapshot(ev.status);
      const changed = phase !== st.phase;
      const powerHistory = snapshot.powerKw != null && phase === 'charging' ? [...st.powerHistory, snapshot.powerKw].slice(-30) : st.powerHistory;
      let stop = st.stop;
      if (TERMINAL.has(phase) || phase === 'finishing') stop = 'idle';
      return {
        ...st,
        phase,
        since: changed ? ev.at : st.since,
        snapshot,
        startTimedOut: phase === 'starting' || phase === 'paying' ? (changed ? false : st.startTimedOut) : false,
        stop,
        stopError: stop === 'idle' ? null : st.stopError,
        connection: 'online',
        failures: 0,
        lastUpdate: ev.at,
        powerHistory,
        missing: false,
      };
    }
    case 'poll_failed': {
      const failures = st.failures + 1;
      return { ...st, failures, connection: failures >= OFFLINE_AFTER_FAILURES ? 'reconnecting' : st.connection };
    }
    case 'not_found':
      return { ...st, missing: true, connection: 'online', failures: 0, startTimedOut: false };
    case 'tick': {
      if (st.missing) return st;
      if (st.phase === 'starting' && !st.startTimedOut && ev.at - st.since >= START_TIMEOUT_MS[st.kind]) return { ...st, startTimedOut: true };
      return st;
    }
    case 'stop_requested':
      return canStop(st) ? { ...st, stop: 'requested', stopError: null } : st;
    case 'stop_sent':
      return st.stop === 'requested' ? { ...st, stop: 'sent' } : st;
    case 'stop_failed':
      return { ...st, stop: 'failed', stopError: ev.message };
    default:
      return st;
  }
}

/** Stop is offered while charging, even when the connection is lost (the request is retried / the charger can be unplugged). */
export function canStop(st: SessionState): boolean {
  return st.phase === 'charging' && st.stop !== 'sent';
}

/** How often to poll status (ms), or null to stop polling (terminal, or backgrounded: push takes over). */
export function pollInterval(st: SessionState, foreground: boolean): number | null {
  if (TERMINAL.has(st.phase) || st.missing) return null;
  if (!foreground) return null;
  if (st.connection === 'reconnecting') return 8_000;
  switch (st.phase) {
    case 'paying':
      return 2_500;
    case 'starting':
      return 2_000;
    case 'charging':
      return st.stop === 'sent' ? 2_500 : 5_000;
    case 'finishing':
    case 'refunding':
      return 5_000;
    default:
      return 3_000;
  }
}

/** The starting timeline (spec §6.6): which steps are done. */
export function startSteps(st: SessionState): { key: 'paid' | 'accepted' | 'connected' | 'charging'; done: boolean; active: boolean }[] {
  const order: Phase[] = ['paying', 'starting', 'charging'];
  const idx = order.indexOf(st.phase);
  const paid = idx >= 1 || st.phase === 'charging' || TERMINAL.has(st.phase);
  const accepted = st.phase === 'charging' || (st.phase === 'starting' && st.snapshot != null && st.lastUpdate != null && st.lastUpdate - st.since > 4_000);
  const charging = st.phase === 'charging' || st.phase === 'finishing' || st.phase === 'completed';
  return [
    { key: 'paid', done: paid, active: st.phase === 'paying' },
    { key: 'accepted', done: accepted || charging, active: st.phase === 'starting' && !accepted },
    { key: 'connected', done: charging, active: st.phase === 'starting' && accepted },
    { key: 'charging', done: charging, active: false },
  ];
}
