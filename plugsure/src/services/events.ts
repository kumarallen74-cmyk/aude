import { EventEmitter } from 'node:events';

/**
 * In-process event bus.
 *
 * This is a stand-in for Redis Streams. The gateway publishes canonical events;
 * the core consumes them. Keeping the seam explicit from day one means moving
 * the gateway to a separate process is a transport swap, not a refactor.
 */
/**
 * Every tenant-scoped event carries the owning organisation.
 *
 * This is a TYPE-LEVEL requirement rather than a convention because the operator
 * console's SSE stream fans these out to logged-in users, and the filter it used
 * was `if (payload.orgId && payload.orgId !== mine) drop`. Almost no event
 * actually carried an orgId, so almost every event fell through the guard: any
 * authenticated tenant saw every other tenant's connector status changes, live
 * session energy, and charge point connects. Making the field mandatory means
 * the compiler, not a reviewer, catches the next event that forgets it.
 */
interface OrgScoped {
  orgId: string;
}

export interface PlugSureEvents {
  'charge_point.connected': OrgScoped & { ocppIdentity: string; version: string };
  'charge_point.disconnected': OrgScoped & { ocppIdentity: string };
  'charge_point.booted': OrgScoped & { ocppIdentity: string; vendor: string; model: string; firmware?: string };
  'connector.status_changed': OrgScoped & {
    ocppIdentity: string;
    evseId: number;
    connectorId: number;
    status: string;
    errorCode?: string;
  };
  'session.started': OrgScoped & { sessionId: string; ocppIdentity: string; connectorId: number };
  'session.updated': OrgScoped & { sessionId: string; energyWh: number; powerW?: number };
  'session.ended': OrgScoped & { sessionId: string; energyWh: number; durationS: number; stopReason?: string };
  'cdr.created': OrgScoped & { cdrId: string; sessionId: string; totalMinor: number; currency: string };
  /** A prepaid session has consumed its purchased energy and must be stopped. */
  'prepaid.exhausted': OrgScoped & {
    sessionId: string;
    chargePointId: string;
    connectorNo: number;
    transactionId: string;
    allowanceWh: number;
    deliveredWh: number;
  };
  'alert.raised': OrgScoped & {
    kind: string;
    severity: string;
    message: string;
    /** What the alert is about, so it can be resolved automatically (e.g. a charger back online). */
    targetType?: string;
    targetId?: string;
  };
  /** Money is owed back to a driver (unused prepaid balance, or paid but never started). */
  'refund.due': OrgScoped & { paymentIntentId: string; amountMinor: number; currency: string; reason: string };
  'refund.completed': OrgScoped & { paymentIntentId: string; amountMinor: number; currency: string; method: 'provider' | 'manual'; reference: string };
  /** An unpaid session (expired card hold, failed post-pay charge) was paid by the driver in the app. */
  'payment.unpaid_settled': OrgScoped & { paymentIntentId: string };
  /** A card hold was captured for what the session cost; the rest was released. */
  'payment.hold_captured': OrgScoped & { paymentIntentId: string; capturedMinor: number; releasedMinor: number; currency: string };
  /** A card hold was released entirely (never used, or nothing delivered). */
  'payment.hold_released': OrgScoped & { paymentIntentId: string; releasedMinor: number; currency: string };
  'firmware.status': OrgScoped & { ocppIdentity: string; status: string; jobId?: string | null };
  'diagnostics.status': OrgScoped & { ocppIdentity: string; status: string; requestId?: string | null };
  /**
   * Deliberately NOT org-scoped: a vendor quirk is a property of the firmware,
   * shared across every tenant that owns that hardware. It is on the explicit
   * global allowlist in the SSE filter, and carries no tenant data.
   */
  'quirk.discovered': { vendor: string; model: string; firmware?: string | null; finding: string };
}

/**
 * The only event kinds that may be delivered to a subscriber whose organisation
 * does not match. Anything not on this list and not carrying a matching orgId is
 * dropped — the stream fails closed.
 */
export const GLOBAL_EVENT_KINDS: ReadonlySet<string> = new Set(['quirk.discovered']);

/** Should this subscriber see this event? Fails closed on an unscoped event. */
export function eventVisibleTo(e: { kind: string; payload: unknown }, orgId: string): boolean {
  if (GLOBAL_EVENT_KINDS.has(e.kind)) return true;
  const p = e.payload as { orgId?: unknown } | null | undefined;
  return typeof p?.orgId === 'string' && p.orgId === orgId;
}

class TypedBus {
  private ee = new EventEmitter({ captureRejections: true });

  constructor() {
    this.ee.setMaxListeners(100);
    this.ee.on('error', () => {});
  }

  emit<K extends keyof PlugSureEvents>(k: K, payload: PlugSureEvents[K]): void {
    this.ee.emit(k as string, payload);
    this.ee.emit('*', { kind: k, payload });
  }

  /**
   * Re-emit an event relayed from ANOTHER process (see ocpp/bridge.ts).
   *
   * Only wildcard subscribers — the SSE streams — receive it. Named listeners
   * (alert persistence, prepaid enforcement, operator limits) already ran in the
   * process that raised the event; running them again here would insert every
   * alert twice and send every RemoteStop twice.
   */
  emitRelayed(kind: string, payload: unknown): void {
    this.ee.emit('*', { kind, payload });
  }

  on<K extends keyof PlugSureEvents>(k: K, fn: (p: PlugSureEvents[K]) => void): void {
    this.ee.on(k as string, fn as any);
  }

  /** Returns an unsubscribe function — SSE clients must call it on disconnect. */
  onAny(fn: (e: { kind: string; payload: unknown }) => void): () => void {
    this.ee.on('*', fn as any);
    return () => this.ee.off('*', fn as any);
  }
}

export const bus = new TypedBus();
