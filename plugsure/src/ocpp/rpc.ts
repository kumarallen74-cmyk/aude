import type { WebSocket } from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { MessageBudget } from './throttle.js';
import { validateCallDetailed, validateCallResult, isKnownAction, type ValidationFailure } from './validate.js';
import type { OcppVersion } from '../domain/canonical.js';

/**
 * OCPP-J RPC framing.
 *
 *   CALL        [2, uniqueId, action, payload]
 *   CALLRESULT  [3, uniqueId, payload]
 *   CALLERROR   [4, uniqueId, errorCode, errorDescription, errorDetails]
 *
 * Three rules this layer enforces, each of which an audit found violated:
 *
 *  1. ONLY ONE OUTSTANDING CALL PER DIRECTION. Outbound CALLs are queued, never
 *     pipelined.
 *  2. EVERY malformed frame gets a CALLERROR. Silently dropping a frame leaves
 *     the charger waiting out its own timeout with no diagnostic, and is an
 *     automatic conformance failure.
 *  3. EVERY inbound payload is schema-validated before it reaches a handler, so
 *     database and runtime error text can never reach the wire.
 */

export const MessageType = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 } as const;

/** OCPP 1.6 §4.2.3. */
export type OcppErrorCode =
  | 'NotImplemented'
  | 'NotSupported'
  | 'InternalError'
  | 'ProtocolError'
  | 'SecurityError'
  | 'FormationViolation'
  | 'PropertyConstraintViolation'
  | 'OccurrenceConstraintViolation'
  | 'TypeConstraintViolation'
  | 'GenericError';

const VALID_ERROR_CODES: ReadonlySet<string> = new Set<OcppErrorCode>([
  'NotImplemented',
  'NotSupported',
  'InternalError',
  'ProtocolError',
  'SecurityError',
  'FormationViolation',
  'PropertyConstraintViolation',
  'OccurrenceConstraintViolation',
  'TypeConstraintViolation',
  'GenericError',
]);

/** Spec cap on MessageId. A charger sending more is malformed, not merely odd. */
const MAX_UNIQUE_ID = 36;

/** Used when the frame is so malformed we cannot recover a MessageId. */
const UNKNOWN_ID = '-1';

export class OcppCallError extends Error {
  constructor(
    public code: OcppErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OcppCallError';
  }
}

export type InboundHandler = (action: string, payload: any) => Promise<any>;
export type FrameSink = (f: {
  direction: 'in' | 'out';
  messageType: number;
  action?: string;
  uniqueId?: string;
  payload: unknown;
}) => void;

/**
 * Call priority. Provisioning is chatty and slow; an operator stopping a live
 * session must not queue behind sixteen configuration writes.
 *   0 = operator/control (RemoteStop, Reset, Unlock, charging profiles)
 *   1 = background (provisioning, local auth list sync)
 */
export type CallPriority = 0 | 1;

interface Pending {
  action: string;
  uniqueId: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Queued {
  action: string;
  payload: unknown;
  priority: CallPriority;
  seq: number;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

interface CachedReply {
  frame: unknown[];
  at: number;
  /** What was actually asked. A MessageId alone does not identify a request. */
  action: string;
  payloadHash: string;
}

/**
 * Stable fingerprint of a request payload. Key order must not matter — two
 * JSON objects with the same content are the same request — so keys are sorted
 * before hashing.
 */
function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonical(payload)).digest('hex').slice(0, 32);
}

/**
 * Remove C0 control characters (including NUL) from every string in a payload,
 * reporting which fields were touched. Newline and tab survive — they appear
 * legitimately in vendor diagnostic strings.
 */
function stripControlChars(v: unknown): { value: unknown; stripped: string[] } {
  const stripped: string[] = [];
  const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === 'string') {
      if (!CONTROL.test(node)) return node;
      CONTROL.lastIndex = 0;
      stripped.push(path || '/');
      return node.replace(CONTROL, '');
    }
    if (Array.isArray(node)) return node.map((x, i) => walk(x, `${path}/${i}`));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(val, `${path}/${k}`);
      }
      return out;
    }
    return node;
  };

  const value = walk(v, '');
  return { value, stripped };
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

const REPLAY_CACHE_MAX = 256;
const REPLAY_CACHE_TTL_MS = 5 * 60_000;

/** Frames waiting in one connection's inbox before it is closed as a flood. */
const MAX_INBOX = 5_000;

export class OcppRpcConnection {
  /** The single in-flight outbound call, or null. Never split across fields. */
  private pending: Pending | null = null;
  private queue: Queued[] = [];
  private seq = 0;
  private closed = false;

  /**
   * Recently answered inbound MessageIds. A charger that retries after a
   * reconnect must get the same answer, not a second execution of the handler.
   */
  private replayCache = new Map<string, CachedReply>();

  constructor(
    public readonly id: string,
    private readonly ws: WebSocket,
    private readonly onCall: InboundHandler,
    private readonly opts: {
      callTimeoutMs: number;
      frameSink?: FrameSink;
      /** Spec deviations we accepted — routed to the vendor quirk registry. */
      deviationSink?: (action: string, deviations: ValidationFailure[]) => void;
      /**
       * Negotiated OCPP version for this connection. Selects the schema set used
       * to validate inbound payloads and our outbound replies. Defaults to 1.6,
       * so a caller that omits it gets the exact pre-2.0.1 behaviour.
       */
      version?: OcppVersion;
    },
  ) {
    // Per-charger message budget. Received frames go through an inbox, processed IN ORDER at the
    // budget's rate: a burst (a charger back from an outage uploading its queue) goes straight
    // through; a flood is paced instead of reaching the database at full speed. While frames wait,
    // the socket is not read (TCP slows the charger down). Nothing is refused or dropped, except
    // that a connection with an absurd backlog is closed: no real charger has thousands waiting.
    const budget = new MessageBudget(config.gateway.maxMessagesPerSecond, config.gateway.messageBurst);
    const inbox: string[] = [];
    let draining = false;
    let warnedAt = 0;
    const canPause = typeof (ws as any).pause === 'function';
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        while (inbox.length && !this.closed) {
          const wait = budget.take();
          void this.onMessage(inbox.shift()!);
          if (wait > 0) {
            if (Date.now() - warnedAt > 60_000) {
              warnedAt = Date.now();
              logger.warn({ cp: this.id, perSecond: config.gateway.maxMessagesPerSecond, burst: config.gateway.messageBurst, waiting: inbox.length },
                'charger is sending messages faster than its budget; they are processed more slowly (nothing dropped)');
            }
            await new Promise((r) => setTimeout(r, wait));
          }
        }
      } finally {
        draining = false;
        if (canPause && (ws as any).isPaused && !this.closed && ws.readyState === ws.OPEN) ws.resume();
      }
    };
    ws.on('message', (data) => {
      if (this.closed) return;
      inbox.push(data.toString());
      if (inbox.length > MAX_INBOX) {
        logger.error({ cp: this.id, waiting: inbox.length }, 'charger flooded the gateway; connection closed');
        inbox.length = 0;
        ws.close(1008, 'too many messages');
        return;
      }
      if (inbox.length > 1 && canPause && !(ws as any).isPaused) ws.pause();
      void drain();
    });
    ws.on('close', () => this.destroy(new Error('connection closed')));
    ws.on('error', (e) => logger.warn({ cp: this.id, err: e.message }, 'ws error'));
  }

  /** Issue a CALL. Resolves with the CALLRESULT payload, rejects on CALLERROR or timeout. */
  call<T = any>(action: string, payload: unknown = {}, priority: CallPriority = 0): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ action, payload, priority, seq: this.seq++, resolve, reject });
      // Stable sort: priority first, then arrival order within a priority.
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.drain();
    });
  }

  /** Depth of the outbound queue, for diagnostics. */
  get queueDepth(): number {
    return this.queue.length + (this.pending ? 1 : 0);
  }

  private drain() {
    if (this.pending || this.queue.length === 0 || this.closed) return;
    const next = this.queue.shift()!;
    const uniqueId = randomUUID();

    const timer = setTimeout(() => {
      const p = this.pending;
      this.pending = null;
      p?.reject(new Error(`OCPP call timeout: ${next.action}`));
      this.drain();
    }, this.opts.callTimeoutMs);

    this.pending = { action: next.action, uniqueId, resolve: next.resolve, reject: next.reject, timer };

    try {
      this.send([MessageType.CALL, uniqueId, next.action, next.payload], next.action, uniqueId);
    } catch (e) {
      // A serialisation failure must not wedge the queue for a full timeout.
      clearTimeout(timer);
      this.pending = null;
      next.reject(e instanceof Error ? e : new Error('failed to serialise CALL'));
      this.drain();
    }
  }

  private send(frame: unknown[], action?: string, uniqueId?: string) {
    const text = JSON.stringify(frame);
    this.ws.send(text);
    this.opts.frameSink?.({
      direction: 'out',
      messageType: frame[0] as number,
      action,
      uniqueId,
      payload: frame,
    });
  }

  private sendCallError(uniqueId: string, code: OcppErrorCode, description: string, details: Record<string, unknown> = {}) {
    this.send([MessageType.CALLERROR, uniqueId, code, description, details], undefined, uniqueId);
  }

  // ---------------------------------------------------------------- inbound

  private async onMessage(text: string) {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      // Spec: when the MessageId cannot be recovered, answer with "-1".
      logger.warn({ cp: this.id, sample: text.slice(0, 120) }, 'unparseable frame');
      this.sendCallError(UNKNOWN_ID, 'FormationViolation', 'Message is not valid JSON');
      return;
    }

    if (!Array.isArray(frame)) {
      this.sendCallError(UNKNOWN_ID, 'FormationViolation', 'Message must be a JSON array');
      return;
    }

    const rawId = frame[1];
    const uniqueId = typeof rawId === 'string' ? rawId : undefined;

    if (frame.length < 2) {
      this.sendCallError(uniqueId ?? UNKNOWN_ID, 'ProtocolError', 'Message array is too short');
      return;
    }
    if (uniqueId === undefined) {
      this.sendCallError(UNKNOWN_ID, 'ProtocolError', 'MessageId must be a string');
      return;
    }
    if (uniqueId.length === 0 || uniqueId.length > MAX_UNIQUE_ID) {
      this.sendCallError(UNKNOWN_ID, 'ProtocolError', `MessageId must be 1-${MAX_UNIQUE_ID} characters`, {
        length: uniqueId.length,
        limit: MAX_UNIQUE_ID,
      });
      return;
    }

    const messageType = frame[0];
    this.opts.frameSink?.({
      direction: 'in',
      messageType: typeof messageType === 'number' ? messageType : -1,
      action: messageType === MessageType.CALL && typeof frame[2] === 'string' ? frame[2] : undefined,
      uniqueId,
      payload: frame,
    });

    switch (messageType) {
      case MessageType.CALL:
        await this.handleCall(uniqueId, frame);
        return;
      case MessageType.CALLRESULT:
      case MessageType.CALLERROR:
        this.handleReply(uniqueId, messageType, frame);
        return;
      default:
        this.sendCallError(uniqueId, 'ProtocolError', 'Unsupported MessageTypeId', {
          messageTypeId: typeof messageType === 'number' ? messageType : String(messageType),
        });
        return;
    }
  }

  private async handleCall(uniqueId: string, frame: unknown[]) {
    const action = frame[2];
    if (typeof action !== 'string' || action.length === 0) {
      this.sendCallError(uniqueId, 'ProtocolError', 'Action must be a non-empty string');
      return;
    }

    /**
     * Strip control characters before anything touches the payload.
     *
     * A single NUL anywhere in an inbound string permanently bricked that
     * charger's BootNotification: Postgres rejects `0x00` in text
     * ("invalid byte sequence for encoding UTF8"), the handler threw, and the
     * charger got a deterministic InternalError on every retry until it gave up.
     * The frame-logging path already stripped NULs on the way to the database
     * (safeJson) and that half worked, which is what made the failure so
     * confusing: the evidence was recorded, the session was not.
     *
     * This is a spec deviation to record, not a reason to drop a frame.
     */
    const { value: cleaned, stripped } = stripControlChars(frame[3] ?? {});
    const payload = cleaned;
    if (stripped.length) {
      this.opts.deviationSink?.(action, [
        {
          code: 'PropertyConstraintViolation',
          message: `: control characters removed from ${stripped.slice(0, 5).join(', ')}`,
          details: { rule: 'controlCharacters', fields: stripped.slice(0, 20) },
        },
      ]);
    }

    /**
     * A retried MessageId gets the original answer, not a second execution.
     *
     * The MessageId ALONE is not an identity. OCPP 1.6 only requires it to be
     * unique among a charger's outstanding calls, and real firmware uses short
     * monotonic counters that restart at 0 or 1 on every reboot — so "1" is a
     * StartTransaction now and a Heartbeat forty seconds from now. Keying the
     * cache on the id alone answered the second request with the first one's
     * reply: a Heartbeat could be answered with a StartTransaction result
     * carrying a live transactionId, and a genuinely new StartTransaction could
     * be swallowed entirely, stranding the session and losing the revenue.
     *
     * A replay is a repeat of the SAME action with the SAME payload. Anything
     * else is a new request that happens to reuse an id.
     */
    const hash = payloadHash(payload);
    const cached = this.takeCached(uniqueId);
    if (cached) {
      if (cached.action === action && cached.payloadHash === hash) {
        logger.info({ cp: this.id, action, uniqueId }, 'duplicate MessageId — replaying cached reply');
        this.send(cached.frame, undefined, uniqueId);
        return;
      }
      logger.info(
        { cp: this.id, uniqueId, was: cached.action, now: action },
        'MessageId reused for a different request — handling as new',
      );
      this.replayCache.delete(uniqueId);
    }

    const version = this.opts.version ?? 'ocpp1.6';
    if (!isKnownAction(action, version)) {
      // Spec-correct, and it stops a typo or a vendor extension from looking handled.
      const safe = action.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
      this.reply(uniqueId, [MessageType.CALLERROR, uniqueId, 'NotImplemented', `Unsupported action: ${safe}`, {}]);
      return;
    }

    const { failure, tolerated } = validateCallDetailed(action, payload, version);
    if (failure) {
      logger.info({ cp: this.id, action, code: failure.code, msg: failure.message }, 'inbound payload rejected');
      this.reply(uniqueId, [MessageType.CALLERROR, uniqueId, failure.code, failure.message, failure.details]);
      return;
    }
    if (tolerated.length) {
      // Accepted, but not silently: a deviation the vendor should know about.
      logger.debug({ cp: this.id, action, deviations: tolerated.map((t) => t.message) }, 'spec deviation tolerated');
      this.opts.deviationSink?.(action, tolerated);
    }

    try {
      const result = (await this.onCall(action, payload)) ?? {};

      // Defence against our own bugs: never put a malformed response on the wire.
      const badOut = validateCallResult(action, result, version);
      if (badOut) {
        logger.error({ cp: this.id, action, msg: badOut.message }, 'CSMS produced an invalid response payload');
        this.reply(uniqueId, [MessageType.CALLERROR, uniqueId, 'InternalError', 'Response failed validation', {}]);
        return;
      }
      this.reply(uniqueId, [MessageType.CALLRESULT, uniqueId, result], { action, payloadHash: hash });
    } catch (e) {
      const err =
        e instanceof OcppCallError
          ? e
          : new OcppCallError('InternalError', 'Internal error handling request');
      if (!(e instanceof OcppCallError)) {
        // Log the real cause; never send it. This is where DDL text used to leak.
        logger.error({ cp: this.id, action, err: e }, 'CALL handler threw');
      }
      this.reply(uniqueId, [MessageType.CALLERROR, uniqueId, err.code, err.message, err.details]);
    }
  }

  /** Send a reply and remember it, so a retried MessageId is answered identically. */
  private reply(uniqueId: string, frame: unknown[], req?: { action: string; payloadHash: string }) {
    /**
     * Only successful replies are cached.
     *
     * A CALLERROR is very often transient — a database blip, a validation path
     * still warming up, an InternalError from a handler that has since been
     * fixed. Caching it turned a momentary failure into a permanent one for that
     * MessageId: the charger retried, got the SAME error back without the
     * handler ever running, and gave up. Errors must stay retryable.
     */
    if (req && frame[0] === MessageType.CALLRESULT) {
      this.rememberReply(uniqueId, frame, req.action, req.payloadHash);
    }
    this.send(frame, undefined, uniqueId);
  }

  private handleReply(uniqueId: string, messageType: number, frame: unknown[]) {
    const p = this.pending;
    if (!p || p.uniqueId !== uniqueId) {
      logger.warn({ cp: this.id, uniqueId }, 'reply for unknown or stale MessageId — ignoring');
      return;
    }
    this.pending = null;
    clearTimeout(p.timer);

    if (messageType === MessageType.CALLRESULT) {
      p.resolve(frame[2]);
    } else {
      const rawCode = frame[2];
      const code: OcppErrorCode =
        typeof rawCode === 'string' && VALID_ERROR_CODES.has(rawCode)
          ? (rawCode as OcppErrorCode)
          : 'GenericError';
      if (code === 'GenericError' && rawCode !== 'GenericError') {
        logger.warn({ cp: this.id, rawCode: String(rawCode) }, 'charger sent a non-standard CALLERROR code');
      }
      const description = typeof frame[3] === 'string' ? frame[3] : '';
      const details = frame[4] && typeof frame[4] === 'object' ? (frame[4] as Record<string, unknown>) : {};
      p.reject(new OcppCallError(code, description, details));
    }
    this.drain();
  }

  // ---------------------------------------------------------------- replay cache

  private rememberReply(uniqueId: string, frame: unknown[], action: string, payloadHash: string) {
    this.replayCache.set(uniqueId, { frame, at: Date.now(), action, payloadHash });
    if (this.replayCache.size > REPLAY_CACHE_MAX) {
      const oldest = this.replayCache.keys().next().value;
      if (oldest !== undefined) this.replayCache.delete(oldest);
    }
  }

  private takeCached(uniqueId: string): CachedReply | undefined {
    const hit = this.replayCache.get(uniqueId);
    if (!hit) return undefined;
    if (Date.now() - hit.at > REPLAY_CACHE_TTL_MS) {
      this.replayCache.delete(uniqueId);
      return undefined;
    }
    return hit;
  }

  // ---------------------------------------------------------------- teardown

  destroy(reason: Error) {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(reason);
      this.pending = null;
    }
    for (const q of this.queue.splice(0)) q.reject(reason);
    this.replayCache.clear();
  }
}
