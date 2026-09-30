import { EventEmitter } from 'node:events';
import { randomUUID, generateKeyPairSync, type KeyObject } from 'node:crypto';
import WebSocket from 'ws';
import { buildCsr, certInfo, hashDataOf, name, pemToDer, sameSerial, splitPemChain } from '../pnc/der.js';
import { Ocpp2Shim } from './ocpp2-shim.js';
import { buildOcmf, formatOcmfTime } from '../services/ocmf.js';

/** ISO 15118 Plug & Charge over OCPP 1.6 (OCA application note). */
const PNC_VENDOR = 'org.openchargealliance.iso15118pnc';

/**
 * VirtualChargePoint — a reusable OCPP charge point client: 1.6J natively, 2.0.1 and 2.1
 * through a translation layer (ocpp2-shim.ts), with an optional signing meter (OCMF)
 * and an optional bidirectional car (ISO 15118-20, on 2.1).
 *
 * This exists because a bench unit will not reproduce, on demand, the failure
 * modes that actually matter in Indonesia: a 4G backhaul that drops mid-session,
 * a charger that boots believing it is 1970, a three-phase meter that reports
 * per phase, a retry storm after a mass power cut. Everything here is a real
 * behaviour observed in field firmware, made switchable.
 *
 * Design rules it obeys, because the CSMS under test depends on them:
 *   - Framing is [2|3|4, uniqueId, ...]. Nothing else.
 *   - ONE outstanding CALL at a time, per direction. Outbound calls are queued.
 *   - The BootNotification.conf `interval` governs the heartbeat, not a constant.
 *   - Transactional messages (Start / MeterValues / Stop) are NEVER dropped when
 *     the link is down. They are queued with the timestamp at which they
 *     OCCURRED and replayed on reconnect. This is store-and-forward, and it is
 *     the single most important thing this file does.
 */

// ------------------------------------------------------------------ types

export type VcpState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'booted'
  | 'backoff'
  | 'disconnected'
  | 'stopped';

export interface VcpStats {
  connections: number;
  reconnects: number;
  framesIn: number;
  framesOut: number;
  callsIn: number;
  callsOut: number;
  callErrorsIn: number;
  callErrorsOut: number;
  sessions: number;
  queuedOffline: number;
  replayed: number;
  duplicatesSent: number;
  energyWh: number;
  errors: number;
}

export interface VcpOptions {
  /** OCPP identity — becomes the final path segment of the websocket URL. */
  id: string;
  /** Gateway base URL, e.g. ws://127.0.0.1:9341/ocpp (the id is appended). */
  url: string;
  connectors: number;
  dc: boolean;
  idTag: string;
  vendor: string;
  model: string;
  firmware: string;

  // --- reconnect -----------------------------------------------------------
  reconnect: boolean;
  /** First backoff delay in ms; doubles each attempt. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** 0 = retry forever. */
  backoffMaxAttempts: number;
  /** Jitter fraction, 0..1. 0.5 means +/-50% of the computed delay. */
  backoffJitter: number;

  // --- charging model ------------------------------------------------------
  /** Lifetime energy register at boot, Wh. */
  meterStartWh: number;
  /** Simulated seconds per real second. */
  speed: number;
  /** Simulated seconds between MeterValues samples. */
  meterIntervalS: number;
  /** Energy to deliver in a scripted session, kWh. */
  targetKwh: number;
  maxPowerW: number;
  phases: number;
  voltage: number;
  /** Report Energy.Active.Import.Register per phase instead of one total. */
  perPhase: boolean;
  /** Wrap the energy register at this width in Wh. 0 = never wrap. */
  rolloverWh: number;
  /** Use an accelerated clock for payload timestamps (matches --speed). */
  simTime: boolean;

  // --- offline replay ------------------------------------------------------
  /** Shuffle the offline queue before replay, to test order independence. */
  replayShuffle: boolean;
  /** Replay every queued item twice, to test idempotency. */
  replayDuplicate: boolean;

  // --- fault injection -----------------------------------------------------
  /** Config keys to answer Rejected on (the documented Autel quirk). */
  rejectConfigKeys: string[];
  /** Fraction 0..1 of inbound CSMS calls answered with a CALLERROR. */
  callErrorRate: number;
  /** Accept the socket, answer nothing. */
  silent: boolean;
  /** Clock offset applied to every timestamp we emit, in ms. */
  clockSkewMs: number;
  /** Omit meterStop from StopTransaction. */
  omitMeterStop: boolean;
  /** Wh added to transactionData so it disagrees with meterStop. 0 = agree. */
  transactionDataSkewWh: number;

  // --- transport -----------------------------------------------------------
  /** Basic auth password; username is always the identity. */
  authKey: string | null;
  /** Force wss:// (upgrades a ws:// base URL). */
  wss: boolean;
  /** Accept a self-signed certificate. Local testing only. */
  insecure: boolean;
  /** Subprotocols to offer on the upgrade. */
  offer: string[];

  /** Print frames as they go by. */
  verbose: boolean;

  // --- sandbox -------------------------------------------------------------
  /** Obtain the socket some other way than dialling `url` (the sandbox's in-memory pair). */
  transport: (() => Promise<SocketLike>) | null;
  /** Honour ReserveNow / CancelReservation (default: Rejected, like much field firmware). */
  reservations: boolean;
  /** Act out UpdateFirmware: report each stage, then reboot on the version this returns. */
  firmwareVersionFor: ((location: string) => Promise<string | null>) | null;
  /** Answer GetDiagnostics by uploading a small generated log to the given location. */
  diagnostics: boolean;

  // --- protocol and metering ---------------------------------------------
  /** The protocol spoken: 1.6 natively, 2.0.1 / 2.1 through ocpp2-shim.ts. */
  protocol: 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1';
  /** The meter's signing key (OCMF, like a calibration-law meter). null: readings are not signed. */
  meterKey: { privateKey: KeyObject; publicKeyHex: string } | null;
  /** The meter's serial, as signed into each reading (MS). */
  meterSerial: string | null;
  /** The car offers bidirectional power transfer (ISO 15118-20; the charger must speak OCPP 2.1). */
  bidirectional: boolean;
  /** The most the car gives back, W. */
  evMaxDischargeW: number;
}

/** The part of a `ws` WebSocket this class uses; an in-memory socket provides it too. */
export interface SocketLike {
  readyState: number;
  protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: string, fn: (...args: any[]) => void): unknown;
  once(event: string, fn: (...args: any[]) => void): unknown;
}

export const DEFAULTS: VcpOptions = {
  id: 'AUTEL-SIM-0001',
  url: 'ws://127.0.0.1:9220/ocpp',
  connectors: 1,
  dc: false,
  idTag: 'ID-RFID-0001',
  vendor: 'Autel',
  model: 'MaxiCharger AC Wallbox',
  firmware: 'V1.4.12',

  reconnect: true,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  backoffMaxAttempts: 0,
  backoffJitter: 0.3,

  meterStartWh: 1_234_000,
  speed: 60,
  meterIntervalS: 60,
  targetKwh: 8,
  maxPowerW: 22_000,
  phases: 3,
  voltage: 230,
  perPhase: false,
  rolloverWh: 0,
  simTime: false,

  replayShuffle: false,
  replayDuplicate: false,

  rejectConfigKeys: [],
  callErrorRate: 0,
  silent: false,
  clockSkewMs: 0,
  omitMeterStop: false,
  transactionDataSkewWh: 0,

  authKey: null,
  wss: false,
  insecure: false,
  offer: ['ocpp1.6'],

  verbose: false,

  transport: null,
  reservations: false,
  firmwareVersionFor: null,
  diagnostics: false,

  protocol: 'ocpp1.6',
  meterKey: null,
  meterSerial: null,
  bidirectional: false,
  evMaxDischargeW: 11_000,
};

/** A transactional message captured while the link was down. */
export interface QueuedMessage {
  action: 'StartTransaction' | 'MeterValues' | 'StopTransaction';
  payload: any;
  /** When the event actually happened on the charger. */
  occurredAt: string;
  /** This is the Start: adopt the transactionId its CALLRESULT hands back. */
  needsTxId?: boolean;
  /** Stamp the live transactionId onto this payload at replay time. */
  bindTxId?: boolean;
}

interface Outbound {
  action: string;
  payload: unknown;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export interface FrameEvent {
  direction: 'in' | 'out';
  messageType: number;
  action?: string;
  uniqueId?: string;
  frame: unknown[];
}

export interface StateEvent {
  from: VcpState;
  to: VcpState;
  attempt?: number;
  delayMs?: number;
  reason?: string;
}

// ------------------------------------------------------------------ class

export class VirtualChargePoint extends EventEmitter {
  readonly opts: VcpOptions;
  readonly stats: VcpStats = {
    connections: 0,
    reconnects: 0,
    framesIn: 0,
    framesOut: 0,
    callsIn: 0,
    callsOut: 0,
    callErrorsIn: 0,
    callErrorsOut: 0,
    sessions: 0,
    queuedOffline: 0,
    replayed: 0,
    duplicatesSent: 0,
    energyWh: 0,
    errors: 0,
  };

  private ws: WebSocket | SocketLike | null = null;
  private _state: VcpState = 'idle';
  private stopping = false;
  private attempt = 0;
  private backoffTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** One outstanding CALL at a time. */
  private pending: { uid: string; action: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private outbox: Outbound[] = [];

  /** Store-and-forward buffer for transactional messages. */
  private offlineQueue: QueuedMessage[] = [];

  /**
   * Every CS->CP action we have been sent, in order. Kept on the object rather
   * than left to a listener because the gateway's provisioning burst starts the
   * instant BootNotification.conf is written — before any caller of start() has
   * had a chance to subscribe.
   */
  readonly inboundCalls: { action: string; at: number }[] = [];

  // charging state
  private rawMeterWh: number;
  private limitW: number;
  private limitSource = 'none';
  private txId: number | null = null;
  private activeConnector = 1;
  private sessionAbort = false;
  private inSession = false;
  private lastPowerW = 0;
  private simDriftMs = 0;
  private heartbeatIntervalS = 300;

  /** OCPP 2.0.1 / 2.1: the translation layer (null on 1.6). */
  private shim: Ocpp2Shim | null = null;
  /** Bidirectional charging: what the CSMS asked the car to give back, and whether the car may. */
  private dischargeW = 0;
  private bidiAllowed = true;
  private sessionBidi = false;
  /** The car's battery, and the charger's export register. */
  private socPercent = 18;
  private capacityWh = 50_000;
  private rawExportWh = 0;
  /** OCMF pagination counter (PG). */
  private pagination = 0;

  /** Plug & Charge: this charger's V2G key and certificate chain, and its trust store. */
  private pnc: { keys: { publicKey: KeyObject; privateKey: KeyObject } | null; chain: string | null; roots: Array<{ type: string; pem: string }> } = { keys: null, chain: null, roots: [] };

  constructor(options: Partial<VcpOptions> & { id?: string }) {
    super();
    const dc = options.dc ?? DEFAULTS.dc;
    this.opts = {
      ...DEFAULTS,
      ...(dc ? { model: 'MaxiCharger DC Compact', firmware: 'V2.1.7', maxPowerW: 40_000, phases: 3, voltage: 400 } : {}),
      ...stripUndefined(options),
    };
    // DEFAULTS is shared; never hand an instance a reference into it.
    this.opts.offer = [...this.opts.offer];
    this.opts.rejectConfigKeys = [...this.opts.rejectConfigKeys];
    this.rawMeterWh = this.opts.meterStartWh;
    this.limitW = this.opts.maxPowerW;
    if (this.opts.protocol !== 'ocpp1.6') {
      this.opts.offer = [this.opts.protocol];
      this.shim = new Ocpp2Shim(this.opts.protocol, {
        identity: this.opts.id,
        vendor: this.opts.vendor,
        model: this.opts.model,
        firmware: this.opts.firmware,
        discharging: () => this.inSession && this.dischargeW > 0,
        send: (action, payload) => this.call(action, payload),
        setBidirectionalAllowed: (allowed) => {
          this.bidiAllowed = allowed;
          if (!allowed) this.dischargeW = 0;
        },
        onVariable: (component, variable, value) => {
          if (component === 'OCPPCommCtrlr' && variable === 'HeartbeatInterval' && Number(value) > 0) {
            this.heartbeatIntervalS = Number(value);
            if (this.isOpen) this.startHeartbeat();
          }
        },
      }, !!this.opts.dc);
    }
    // EventEmitter throws on an unhandled 'error'. A charge point losing its
    // backhaul is normal operation, not a reason to kill the process, so keep a
    // sink here; callers still get their own listener called first.
    this.on('error', () => {});
  }

  get state(): VcpState {
    return this._state;
  }

  get transactionId(): number | null {
    return this.txId;
  }

  get pendingOffline(): QueuedMessage[] {
    return [...this.offlineQueue];
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Register value as reported on the wire (after any configured rollover). */
  get meterWh(): number {
    return this.opts.rolloverWh > 0 ? this.rawMeterWh % this.opts.rolloverWh : this.rawMeterWh;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Connect and boot. Resolves once BootNotification is accepted. */
  async start(): Promise<void> {
    this.stopping = false;
    await this.openSocket();
  }

  /** Stop for good: no further reconnects. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.sessionAbort = true;
    this.clearTimers();
    this.setState('stopped');
    const ws = this.ws;
    this.ws = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          try {
            ws.terminate();
          } catch {}
          res();
        }, 1_000);
        ws.once('close', () => {
          clearTimeout(t);
          res();
        });
        try {
          ws.close();
        } catch {
          clearTimeout(t);
          res();
        }
      });
    }
    this.failPending(new Error('stopped'));
  }

  /** FAULT: rip the TCP connection out from under the session. */
  dropConnection(reason = 'injected drop'): void {
    this.emit('fault', { kind: 'drop', reason });
    const ws = this.ws;
    this.ws = null;
    this.failPending(new Error(reason));
    this.stopHeartbeat();
    try {
      ws?.terminate();
    } catch {}
    this.setState('disconnected', { reason });
    if (this.opts.reconnect && !this.stopping) this.scheduleReconnect();
  }

  /** FAULT: emit a frame that is not valid OCPP-J. */
  sendMalformed(kind: 'truncated-json' | 'not-array' | 'bad-type' | 'short-array' = 'truncated-json'): void {
    const body =
      kind === 'truncated-json'
        ? '[2,"' + randomUUID() + '","Heartbeat",{'
        : kind === 'not-array'
          ? JSON.stringify({ messageTypeId: 2, action: 'Heartbeat' })
          : kind === 'short-array'
            ? JSON.stringify([2])
            : JSON.stringify([9, randomUUID(), 'Heartbeat', {}]);
    this.emit('fault', { kind: 'malformed', detail: kind });
    try {
      this.ws?.send(body);
      this.stats.framesOut++;
    } catch {
      /* socket already gone */
    }
  }

  // ---------------------------------------------------------------- connect

  /** Connect through an injected transport (the sandbox): no URL, no upgrade. */
  private async openInjected(): Promise<void> {
    this.setState('connecting', { attempt: this.attempt });
    let ws: SocketLike;
    try {
      ws = await this.opts.transport!();
    } catch (e) {
      this.stats.errors++;
      this.emit('error', e as Error);
      if (this.opts.reconnect && !this.stopping) this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('message', (data: Buffer | string) => void this.onMessage(data.toString()));
    ws.on('close', (code: number, reasonBuf?: Buffer) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const reason = `code=${code} ${reasonBuf?.toString() ?? ''}`.trim();
      this.stopHeartbeat();
      this.failPending(new Error(`socket closed (${reason})`));
      if (this.stopping) this.setState('stopped', { reason });
      else {
        this.setState('disconnected', { reason });
        if (this.opts.reconnect) this.scheduleReconnect();
      }
    });
    this.stats.connections++;
    if (this.attempt > 0) this.stats.reconnects++;
    this.attempt = 0;
    this.setState('connected', { reason: `subprotocol=${ws.protocol || 'none'}` });
    this.emit('open', { protocol: ws.protocol });
    await this.bootSequence().catch((e) => {
      this.stats.errors++;
      this.emit('error', e as Error);
    });
  }

  private openSocket(): Promise<void> {
    if (this.opts.transport) return this.openInjected();
    return new Promise<void>((resolve, reject) => {
      const url = this.socketUrl();
      const headers: Record<string, string> = {};
      if (this.opts.authKey) {
        const basic = Buffer.from(`${this.opts.id}:${this.opts.authKey}`).toString('base64');
        headers['Authorization'] = `Basic ${basic}`;
      }
      this.setState('connecting', { attempt: this.attempt });

      const ws = new WebSocket(url, this.opts.offer, {
        headers,
        ...(this.opts.insecure ? { rejectUnauthorized: false } : {}),
        handshakeTimeout: 15_000,
      });
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        this.stats.connections++;
        if (this.attempt > 0) this.stats.reconnects++;
        this.attempt = 0;
        this.setState('connected', { reason: `subprotocol=${ws.protocol || 'none'}` });
        this.emit('open', { protocol: ws.protocol });
        void this.bootSequence()
          .then(() => {
            if (!settled) {
              settled = true;
              resolve();
            }
          })
          .catch((e) => {
            this.stats.errors++;
            this.emit('error', e);
            if (!settled) {
              settled = true;
              // A failed boot is not fatal; reconnect logic still applies.
              resolve();
            }
          });
      });

      ws.on('message', (data) => void this.onMessage(data.toString()));

      ws.on('unexpected-response', (_req, res) => {
        const err = new Error(`upgrade rejected: HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim());
        this.stats.errors++;
        this.emit('error', err);
        this.emit('upgrade-rejected', { status: res.statusCode });
        if (!settled) {
          settled = true;
          if (this.opts.reconnect && !this.stopping) resolve();
          else reject(err);
        }
      });

      ws.on('error', (e) => {
        this.stats.errors++;
        this.emit('error', e);
        if (!settled && !this.opts.reconnect) {
          settled = true;
          reject(e);
        }
      });

      ws.on('close', (code, reasonBuf) => {
        const reason = `code=${code} ${reasonBuf?.toString() ?? ''}`.trim();
        // A socket we have already abandoned (dropConnection, or a reconnect
        // that beat this event) must not evict the live one.
        const stale = this.ws !== ws;
        if (!stale) this.ws = null;
        if (stale) {
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        this.stopHeartbeat();
        this.failPending(new Error(`socket closed (${reason})`));
        if (this.stopping) {
          this.setState('stopped', { reason });
        } else {
          this.setState('disconnected', { reason });
          if (this.opts.reconnect) this.scheduleReconnect();
        }
        if (!settled) {
          settled = true;
          if (this.opts.reconnect) resolve();
          else reject(new Error(`socket closed before boot (${reason})`));
        }
      });
    });
  }

  private socketUrl(): string {
    let base = this.opts.url.replace(/\/+$/, '');
    if (this.opts.wss && base.startsWith('ws://')) base = 'wss://' + base.slice(5);
    return `${base}/${encodeURIComponent(this.opts.id)}`;
  }

  /**
   * Exponential backoff with jitter, the way field firmware does it. Without
   * jitter a site-wide power cut brings every charger back on the same tick and
   * the gateway takes a synchronised stampede.
   */
  private scheduleReconnect(): void {
    if (this.backoffTimer) return;
    this.attempt++;
    if (this.opts.backoffMaxAttempts > 0 && this.attempt > this.opts.backoffMaxAttempts) {
      this.setState('stopped', { reason: `gave up after ${this.attempt - 1} attempts` });
      this.emit('gave-up', { attempts: this.attempt - 1 });
      return;
    }
    const raw = Math.min(this.opts.backoffBaseMs * 2 ** (this.attempt - 1), this.opts.backoffMaxMs);
    const jitter = 1 + (Math.random() * 2 - 1) * this.opts.backoffJitter;
    const delayMs = Math.max(50, Math.round(raw * jitter));
    this.setState('backoff', { attempt: this.attempt, delayMs });
    this.emit('reconnect-scheduled', { attempt: this.attempt, delayMs });
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      if (this.stopping) return;
      void this.openSocket().catch((e) => this.emit('error', e));
    }, delayMs);
    this.backoffTimer.unref?.();
  }

  // ---------------------------------------------------------------- boot

  private async bootSequence(): Promise<void> {
    if (this.opts.silent) {
      this.emit('fault', { kind: 'silent', reason: 'connected but will not speak' });
      return;
    }
    const boot = await this.call('BootNotification', {
      chargePointVendor: this.opts.vendor,
      chargePointModel: this.opts.model,
      chargePointSerialNumber: this.opts.id,
      firmwareVersion: this.opts.firmware,
    });
    this.heartbeatIntervalS = Number(boot?.interval) > 0 ? Number(boot.interval) : 300;
    this.setState('booted', { reason: `status=${boot?.status} interval=${this.heartbeatIntervalS}s` });
    this.emit('boot', boot);

    for (let i = 1; i <= this.opts.connectors; i++) {
      await this.call('StatusNotification', {
        connectorId: i,
        errorCode: 'NoError',
        status: this.txId && i === this.activeConnector ? 'Charging' : 'Available',
        timestamp: this.now(),
      });
    }

    this.startHeartbeat();

    if (this.offlineQueue.length > 0) await this.replayOfflineQueue();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isOpen || this.opts.silent) return;
      void this.call('Heartbeat', {}).catch(() => {});
    }, this.heartbeatIntervalS * 1_000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
  }

  // ---------------------------------------------------------------- RPC out

  /** Issue a CALL. Queued behind any outstanding call — one at a time. */
  call<T = any>(action: string, payload: unknown = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error(`not connected (${action})`));
    return new Promise<T>((resolve, reject) => {
      this.outbox.push({ action, payload, resolve, reject });
      this.drain(timeoutMs);
    });
  }

  private drain(timeoutMs = 30_000): void {
    if (this.pending || this.outbox.length === 0) return;
    if (!this.isOpen) {
      this.failPending(new Error('not connected'));
      return;
    }
    const next = this.outbox.shift()!;
    const uid = randomUUID();
    // One vocabulary inside (1.6); the wire form of the negotiated protocol outside.
    const wire = this.shim ? this.shim.out(next.action, next.payload) : { action: next.action, payload: strip16(next.payload), map: (r: any) => r };
    const timer = setTimeout(() => {
      const p = this.pending;
      this.pending = null;
      p?.reject(new Error(`timeout waiting for ${next.action}.conf`));
      this.drain(timeoutMs);
    }, timeoutMs);
    timer.unref?.();
    this.pending = { uid, action: wire.action, resolve: (v: any) => next.resolve(wire.map(v)), reject: next.reject, timer };
    this.sendFrame([2, uid, wire.action, wire.payload], wire.action, uid);
    this.stats.callsOut++;
  }

  private failPending(err: Error): void {
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    for (const q of this.outbox.splice(0)) q.reject(err);
  }

  private sendFrame(frame: unknown[], action?: string, uid?: string): void {
    if (this.opts.silent) return;
    const text = JSON.stringify(frame);
    try {
      this.ws?.send(text);
    } catch {
      return;
    }
    this.stats.framesOut++;
    const ev: FrameEvent = { direction: 'out', messageType: frame[0] as number, frame };
    if (action !== undefined) ev.action = action;
    if (uid !== undefined) ev.uniqueId = uid;
    this.emit('frame', ev);
    if (this.opts.verbose) console.log(`[${this.opts.id}] -> ${text.slice(0, 400)}`);
  }

  // ---------------------------------------------------------------- RPC in

  private async onMessage(text: string): Promise<void> {
    this.stats.framesIn++;
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.emit('error', new Error(`unparseable frame from CSMS: ${text.slice(0, 120)}`));
      return;
    }
    if (!Array.isArray(frame) || frame.length < 2) return;
    const messageType = frame[0] as number;
    const uid = String(frame[1]);
    const inEv: FrameEvent = { direction: 'in', messageType, uniqueId: uid, frame };
    if (messageType === 2) inEv.action = frame[2] as string;
    this.emit('frame', inEv);
    if (this.opts.verbose) console.log(`[${this.opts.id}] <- ${text.slice(0, 400)}`);

    if (messageType === 3 || messageType === 4) {
      if (!this.pending || this.pending.uid !== uid) {
        this.emit('stale-reply', { uniqueId: uid });
        return;
      }
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      if (messageType === 3) {
        p.resolve(frame[2]);
      } else {
        this.stats.callErrorsIn++;
        p.reject(Object.assign(new Error(`CALLERROR ${frame[2]}: ${frame[3]}`), { callError: frame }));
      }
      this.drain();
      return;
    }

    if (messageType !== 2) return;
    this.stats.callsIn++;
    const action = String(frame[2]);
    const payload = (frame[3] ?? {}) as any;
    this.inboundCalls.push({ action, at: Date.now() });
    this.emit('call', { action, payload, uniqueId: uid });

    if (this.opts.silent) return; // FAULT: accept, never answer.

    if (this.opts.callErrorRate > 0 && Math.random() < this.opts.callErrorRate) {
      this.stats.callErrorsOut++;
      this.emit('fault', { kind: 'callerror', action });
      this.sendFrame([4, uid, 'InternalError', 'injected fault', {}]);
      return;
    }

    try {
      let result: any;
      if (this.shim) {
        const t = this.shim.in(action, payload);
        if (t.direct) result = await t.direct();
        else {
          const r = await this.handleCall(t.action!, t.payload);
          result = r === undefined ? undefined : t.map!(r);
        }
      } else {
        result = await this.handleCall(action, payload);
      }
      if (result === undefined) {
        this.stats.callErrorsOut++;
        this.sendFrame([4, uid, 'NotImplemented', `${action} is not supported by this charge point`, {}]);
        return;
      }
      this.sendFrame([3, uid, result]);
    } catch (e) {
      this.stats.callErrorsOut++;
      this.sendFrame([4, uid, 'InternalError', (e as Error).message, {}]);
    }
  }

  /** Returns undefined to mean "answer CALLERROR NotImplemented". */
  private async handleCall(action: string, p: any): Promise<any | undefined> {
    switch (action) {
      case 'GetConfiguration': {
        const all = this.configurationKeys();
        const asked: string[] | undefined = Array.isArray(p.key) ? p.key : p.key ? [p.key] : undefined;
        if (!asked?.length) return { configurationKey: all, unknownKey: [] };
        const known = all.filter((k) => asked.includes(k.key));
        const unknownKey = asked.filter((k) => !all.some((a) => a.key === k));
        return { configurationKey: known, unknownKey };
      }

      case 'ChangeConfiguration': {
        // The documented Autel quirk: certain metering keys are rejected. A CSMS
        // that treats this as fatal strands the fleet.
        if (this.opts.rejectConfigKeys.includes(String(p.key))) {
          this.emit('fault', { kind: 'config-rejected', key: p.key });
          return { status: 'Rejected' };
        }
        this.configStore.set(String(p.key), String(p.value ?? ''));
        if (p.key === 'HeartbeatInterval') {
          const v = Number(p.value);
          if (v > 0) {
            this.heartbeatIntervalS = v;
            if (this.isOpen) this.startHeartbeat();
          }
        }
        return { status: 'Accepted' };
      }

      case 'TriggerMessage': {
        const msg = String(p.requestedMessage ?? '');
        const supported = [
          'BootNotification',
          'Heartbeat',
          'StatusNotification',
          'MeterValues',
          'DiagnosticsStatusNotification',
          'FirmwareStatusNotification',
        ];
        if (!supported.includes(msg)) return { status: 'NotImplemented' };
        setTimeout(() => void this.honourTrigger(msg, p.connectorId).catch(() => {}), 50);
        return { status: 'Accepted' };
      }

      case 'RemoteStartTransaction': {
        if (this.txId != null) return { status: 'Rejected' };
        const connectorId = Number(p.connectorId ?? 1);
        const idTag = String(p.idTag ?? this.opts.idTag);
        if (this.faults.has(connectorId)) return { status: 'Rejected' };
        const held = this.reserved.get(connectorId);
        if (held && held.idTag !== idTag) return { status: 'Rejected' };
        setTimeout(
          () =>
            void this.runSession({ connectorId, idTag, remote: true }).catch((e) =>
              this.emit('error', e as Error),
            ),
          100,
        );
        return { status: 'Accepted' };
      }

      case 'RemoteStopTransaction': {
        if (this.txId == null || Number(p.transactionId) !== this.txId) return { status: 'Rejected' };
        this.sessionAbort = true;
        this.stopReason = 'Remote';
        return { status: 'Accepted' };
      }

      case 'SetChargingProfile': {
        const applied = this.applyChargingProfile(p.csChargingProfiles);
        return { status: applied ? 'Accepted' : 'Rejected' };
      }

      case 'ClearChargingProfile':
        this.limitW = this.opts.maxPowerW;
        this.dischargeW = 0;
        this.limitSource = 'cleared';
        this.emit('limit', { limitW: this.limitW, source: 'ClearChargingProfile' });
        return { status: 'Accepted' };

      case 'GetCompositeSchedule': {
        const connectorId = Number(p.connectorId ?? 1);
        const duration = Number(p.duration ?? 3600);
        const unit = p.chargingRateUnit ?? (this.opts.dc ? 'W' : 'A');
        const limit =
          unit === 'A' ? round2(this.limitW / (this.opts.phases * this.opts.voltage)) : Math.round(this.limitW);
        return {
          status: 'Accepted',
          connectorId,
          scheduleStart: this.now(),
          chargingSchedule: {
            duration,
            chargingRateUnit: unit,
            chargingSchedulePeriod: [{ startPeriod: 0, limit, numberPhases: this.opts.phases }],
          },
        };
      }

      case 'ClearCache':
        return { status: 'Accepted' };

      case 'Reset': {
        const type = String(p.type ?? 'Soft');
        setTimeout(() => this.simulateReset(type), 200);
        return { status: 'Accepted' };
      }

      case 'UnlockConnector':
        return { status: this.txId == null ? 'Unlocked' : 'UnlockFailed' };

      case 'ChangeAvailability':
        return { status: this.txId == null ? 'Accepted' : 'Scheduled' };

      case 'GetLocalListVersion':
        return { listVersion: this.localListVersion };

      case 'SendLocalList': {
        const v = Number(p.listVersion);
        if (Number.isFinite(v)) this.localListVersion = v;
        this.localListSize =
          p.updateType === 'Full'
            ? (p.localAuthorizationList?.length ?? 0)
            : this.localListSize + (p.localAuthorizationList?.length ?? 0);
        return { status: 'Accepted' };
      }

      case 'DataTransfer':
        return p?.vendorId === PNC_VENDOR ? this.onPncDataTransfer(p) : { status: 'UnknownVendorId' };

      case 'ReserveNow': {
        if (!this.opts.reservations) return { status: 'Rejected' };
        const c = Number(p.connectorId ?? 1);
        if (c < 1 || c > this.opts.connectors) return { status: 'Rejected' };
        if (this.faults.has(c)) return { status: 'Faulted' };
        if ((this.txId != null && c === this.activeConnector) || this.reserved.has(c)) return { status: 'Occupied' };
        const until = Date.parse(String(p.expiryDate ?? '')) || Date.now() + 15 * 60_000;
        const timer = setTimeout(() => {
          if (this.reserved.get(c)?.id !== Number(p.reservationId)) return;
          this.reserved.delete(c);
          void this.statusSafe(c, 'Available');
        }, Math.max(1000, until - Date.now()));
        timer.unref?.();
        this.reserved.set(c, { id: Number(p.reservationId), idTag: String(p.idTag ?? ''), timer });
        setTimeout(() => void this.statusSafe(c, 'Reserved'), 50);
        return { status: 'Accepted' };
      }

      case 'CancelReservation': {
        if (!this.opts.reservations) return { status: 'Rejected' };
        for (const [c, r] of this.reserved) {
          if (r.id !== Number(p.reservationId)) continue;
          clearTimeout(r.timer);
          this.reserved.delete(c);
          setTimeout(() => void this.statusSafe(c, 'Available'), 50);
          return { status: 'Accepted' };
        }
        return { status: 'Rejected' };
      }

      case 'GetDiagnostics': {
        if (!this.opts.diagnostics) return {};
        const fileName = `${this.opts.id}-${new Date().toISOString().replace(/[:.]/g, '')}.log`;
        setTimeout(() => void this.uploadDiagnostics(String(p.location ?? ''), fileName).catch((e) => this.emit('error', e)), 200);
        return { fileName };
      }

      case 'UpdateFirmware':
        if (this.opts.firmwareVersionFor) {
          setTimeout(() => void this.actOutFirmware(String(p.location ?? '')).catch((e) => this.emit('error', e)), 200);
        }
        return {};

      default:
        // Genuinely unsupported -> CALLERROR NotImplemented, per spec.
        return undefined;
    }
  }

  /** Connectors held by ReserveNow, and connectors reporting a fault. */
  private reserved = new Map<number, { id: number; idTag: string; timer: NodeJS.Timeout }>();
  private faults = new Map<number, { errorCode: string; vendorErrorCode?: string; info?: string }>();

  /** Stop the running session as the driver or the car would. */
  stopSession(reason: 'Local' | 'EVDisconnected' | 'Remote' | 'EmergencyStop' | 'PowerLoss' = 'Local'): boolean {
    if (!this.inSession) return false;
    this.stopReason = reason;
    this.sessionAbort = true;
    return true;
  }

  get charging(): boolean {
    return this.inSession;
  }

  /** What the sandbox reports about this charger. */
  snapshot() {
    return {
      online: this.isOpen,
      state: this._state,
      charging: this.inSession,
      connectorId: this.inSession ? this.activeConnector : null,
      transactionId: this.txId,
      meterWh: Math.round(this.meterWh),
      powerW: this.inSession ? Math.round(this.lastPowerW) : 0,
      limitW: this.limitW,
      firmware: this.opts.firmware,
      queuedOffline: this.offlineQueue.length,
      faults: [...this.faults].map(([connectorId, f]) => ({ connectorId, ...f })),
      reservations: [...this.reserved].map(([connectorId, r]) => ({ connectorId, reservationId: r.id, idTag: r.idTag })),
      pnc: this.pncSnapshot(),
      protocol: this.opts.protocol,
      signing: this.signingOn(),
      socPercent: this.inSession ? Math.round(this.socPercent) : null,
      bidirectional: this.inSession ? this.sessionBidi : this.opts.bidirectional && this.opts.protocol === 'ocpp2.1',
      dischargeW: this.inSession ? this.dischargeW : 0,
      exportWh: Math.round(this.rawExportWh),
    };
  }

  // ------------------------------------------------------------------ metering and the car

  /** Readings are signed when the meter has a key (and, on 2.x, SampledDataCtrlr.SignReadings is on). */
  private signingOn(): boolean {
    if (!this.opts.meterKey) return false;
    return this.shim ? this.shim.variable('SampledDataCtrlr.SignReadings') === 'true' : true;
  }

  /** One signed register reading, as a calibration-law meter produces it (OCMF), in 1.6 SignedData form. */
  private signReading(tx: 'B' | 'E', registerWh: number, idTag: string): any | null {
    if (!this.signingOn()) return null;
    const ocmf = buildOcmf({
      FV: '1.0', GI: 'PlugSure Sandbox', GS: this.opts.id, GV: this.opts.firmware, PG: `T${++this.pagination}`,
      MV: 'PlugSure', MM: 'Virtual meter', MS: this.opts.meterSerial ?? this.opts.id, MF: '1.0',
      IS: true, IL: 'VERIFIED', IF: ['RFID_PLAIN'], IT: 'ISO14443', ID: idTag,
      RD: [{ TM: formatOcmfTime(new Date(this.now())), TX: tx, RV: Number((registerWh / 1000).toFixed(3)), RI: '1-b:1.8.0', RU: 'kWh', RT: this.opts.dc ? 'DC' : 'AC', EF: '', ST: 'G' }],
    }, this.opts.meterKey!.privateKey);
    return {
      value: ocmf, format: 'SignedData', measurand: 'Energy.Active.Import.Register', context: tx === 'B' ? 'Transaction.Begin' : 'Transaction.End', unit: 'Wh',
      _wh: Math.round(registerWh), _publicKeyHex: this.opts.meterKey!.publicKeyHex,
    };
  }

  /** What the car tells the charger over ISO 15118 (NotifyEVChargingNeeds). BPT modes only exist in 2.1. */
  private chargingNeeds(evseId: number, targetWh: number) {
    const dc = !!this.opts.dc;
    const v21 = this.opts.protocol === 'ocpp2.1';
    const bpt = this.sessionBidi;
    return {
      evseId,
      ...(v21 ? { timestamp: this.now() } : {}),
      chargingNeeds: {
        requestedEnergyTransfer: bpt ? (dc ? 'DC_BPT' : 'AC_BPT') : dc ? 'DC' : 'AC_three_phase',
        ...(v21 ? { availableEnergyTransfer: bpt ? (dc ? ['DC', 'DC_BPT'] : ['AC_three_phase', 'AC_BPT']) : [dc ? 'DC' : 'AC_three_phase'], controlMode: 'ScheduledControl' } : {}),
        departureTime: new Date(Date.parse(this.now()) + 4 * 3_600_000).toISOString(),
        ...(dc
          ? { dcChargingParameters: { evMaxCurrent: 200, evMaxVoltage: 450, evEnergyCapacity: Math.round(this.capacityWh), stateOfCharge: Math.round(this.socPercent), energyAmount: Math.round(targetWh) } }
          : { acChargingParameters: { energyAmount: Math.round(targetWh), evMinCurrent: 6, evMaxCurrent: 32, evMaxVoltage: 400 } }),
        ...(bpt ? { v2xChargingParameters: { maxChargePower: this.opts.maxPowerW, maxDischargePower: this.opts.evMaxDischargeW } } : {}),
      },
    };
  }

  // ------------------------------------------------------------------ Plug & Charge (ISO 15118 over OCPP 1.6)

  private pncSnapshot() {
    const leaf = this.pnc.chain ? splitPemChain(this.pnc.chain)[0] : null;
    const info = leaf ? certInfo(leaf) : null;
    return {
      enabled: this.configStore.get('ISO15118PnCEnabled') === 'true',
      certificate: info ? { subject: info.subject, serial: info.serial, notAfter: info.notAfter.toISOString() } : null,
      roots: this.pnc.roots.map((r) => ({ type: r.type, subject: certInfo(r.pem).subject })),
    };
  }

  /** Why this charger cannot do Plug & Charge now, or null. */
  pncProblem(): string | null {
    const s = this.pncSnapshot();
    if (!s.enabled) return 'Plug & Charge is off at this charger (ISO15118PnCEnabled). Switch it on under Plug & Charge → Chargers.';
    if (!s.certificate) return 'This charger has no V2G certificate yet: request one under Plug & Charge → Chargers.';
    if (new Date(s.certificate.notAfter) < new Date()) return 'This charger\'s V2G certificate has expired.';
    return null;
  }

  /** A Plug & Charge message to the CSMS, wrapped in DataTransfer; returns the unwrapped answer. */
  private async pncCall(messageId: string, payload: unknown): Promise<any> {
    const r = await this.call('DataTransfer', { vendorId: PNC_VENDOR, messageId, data: JSON.stringify(payload) });
    if (r?.status !== 'Accepted') throw new Error(`${messageId}: DataTransfer ${r?.status}`);
    return typeof r.data === 'string' && r.data ? JSON.parse(r.data) : {};
  }

  private async requestV2gCertificate(): Promise<void> {
    this.pnc.keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const csr = buildCsr(name([['C', 'ID'], ['O', 'PlugSure Sandbox CPO'], ['CN', this.opts.id], ['DC', 'CPO']]), this.pnc.keys);
    const r = await this.pncCall('SignCertificate', { csr, certificateType: 'V2GCertificate' });
    this.emit('pnc', { kind: 'sign-certificate', status: r?.status });
  }

  /** The CSMS's Plug & Charge messages to the charger (OCA application note). */
  private onPncDataTransfer(p: any): { status: string; data?: string } {
    let d: any = {};
    try { d = typeof p.data === 'string' ? JSON.parse(p.data) : p.data ?? {}; } catch { return { status: 'Rejected' }; }
    const reply = (x: unknown) => ({ status: 'Accepted', data: JSON.stringify(x) });
    const hashOf = (pem: string) => {
      const issuer = this.pnc.roots.find((r) => { try { return certInfo(r.pem).subject === certInfo(pem).issuer; } catch { return false; } });
      return hashDataOf(pem, issuer?.pem ?? pem);
    };
    this.emit('pnc', { kind: String(p.messageId), payload: d });
    switch (String(p.messageId)) {
      case 'TriggerMessage':
        if (d.requestedMessage !== 'SignV2GCertificate') return reply({ status: 'NotImplemented' });
        setTimeout(() => void this.requestV2gCertificate().catch((e) => this.emit('error', e as Error)), 100);
        return reply({ status: 'Accepted' });
      case 'CertificateSigned': {
        const chain = String(d.certificateChain ?? '');
        const leaf = splitPemChain(chain)[0];
        if (!leaf || !this.pnc.keys) return reply({ status: 'Rejected' });
        // It must certify the key this charger generated.
        const mine = this.pnc.keys.publicKey.export({ type: 'spki', format: 'der' });
        if (!certInfo(leaf).spkiDer.equals(mine)) return reply({ status: 'Rejected' });
        this.pnc.chain = chain;
        return reply({ status: 'Accepted' });
      }
      case 'InstallCertificate': {
        const pem = String(d.certificate ?? '');
        try { pemToDer(pem); certInfo(pem); } catch { return reply({ status: 'Rejected' }); }
        if (!this.pnc.roots.some((r) => r.pem === pem)) this.pnc.roots.push({ type: String(d.certificateType), pem });
        return reply({ status: 'Accepted' });
      }
      case 'GetInstalledCertificateIds': {
        const types: string[] = Array.isArray(d.certificateType) ? d.certificateType : [];
        const list: any[] = this.pnc.roots.filter((r) => !types.length || types.includes(r.type)).map((r) => ({ certificateType: r.type, certificateHashData: hashDataOf(r.pem, r.pem) }));
        if (this.pnc.chain && (!types.length || types.includes('V2GCertificateChain'))) {
          const [leaf, sub] = splitPemChain(this.pnc.chain);
          list.push({ certificateType: 'V2GCertificateChain', certificateHashData: sub ? hashDataOf(leaf!, sub) : hashOf(leaf!) });
        }
        return reply({ status: list.length ? 'Accepted' : 'NotFound', ...(list.length ? { certificateHashDataChain: list } : {}) });
      }
      case 'DeleteCertificate': {
        const serial = String(d.certificateHashData?.serialNumber ?? '');
        const before = this.pnc.roots.length;
        this.pnc.roots = this.pnc.roots.filter((r) => !sameSerial(certInfo(r.pem).serial, serial));
        return reply({ status: this.pnc.roots.length < before ? 'Accepted' : 'NotFound' });
      }
      default:
        return { status: 'UnknownMessageId' };
    }
  }

  get activeConnectorId(): number {
    return this.activeConnector;
  }

  /** Report a connector fault (a real charger's StatusNotification Faulted), or clear it. */
  async setFault(connectorId: number, fault: { errorCode: string; vendorErrorCode?: string; info?: string } | null): Promise<void> {
    if (fault) {
      this.faults.set(connectorId, fault);
      if (this.inSession && this.activeConnector === connectorId) this.stopSession('EmergencyStop');
      if (!this.isOpen) return;
      await this.call('StatusNotification', {
        connectorId,
        errorCode: fault.errorCode,
        status: 'Faulted',
        timestamp: this.now(),
        ...(fault.vendorErrorCode ? { vendorErrorCode: fault.vendorErrorCode } : {}),
        ...(fault.info ? { info: fault.info } : {}),
      });
    } else {
      this.faults.delete(connectorId);
      await this.statusSafe(connectorId, 'Available');
    }
  }

  /** Report any status on a connector (Preparing when a cable is plugged in, …). */
  async reportStatus(connectorId: number, status: string): Promise<void> {
    await this.statusSafe(connectorId, status);
  }

  private async actOutFirmware(location: string): Promise<void> {
    const version = await this.opts.firmwareVersionFor!(location);
    for (const status of ['Downloading', 'Downloaded', 'Installing', 'Installed']) {
      if (!this.isOpen) return;
      await this.call('FirmwareStatusNotification', { status }).catch(() => {});
      await sleep(400);
    }
    if (version) this.opts.firmware = version;
    this.simulateReset('Hard');
  }

  private async uploadDiagnostics(location: string, fileName: string): Promise<void> {
    await this.call('DiagnosticsStatusNotification', { status: 'Uploading' }).catch(() => {});
    let ok = false;
    if (/^https?:\/\//i.test(location)) {
      const log = [
        `# ${this.opts.vendor} ${this.opts.model} ${this.opts.firmware} — ${this.opts.id} (PlugSure sandbox)`,
        `${this.now()} INFO  boot ok, ${this.opts.connectors} connector(s), heartbeat ${this.heartbeatIntervalS}s`,
        `${this.now()} INFO  meter register ${Math.round(this.meterWh)} Wh`,
        ...[...this.faults].map(([c, f]) => `${this.now()} ERROR connector ${c} ${f.errorCode} ${f.vendorErrorCode ?? ''}`),
      ].join('\n');
      try {
        const res = await fetch(`${location.replace(/\/+$/, '')}/${encodeURIComponent(fileName)}`, {
          method: 'PUT',
          headers: { 'content-type': 'text/plain' },
          body: log,
          signal: AbortSignal.timeout(15_000),
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
    }
    await this.call('DiagnosticsStatusNotification', { status: ok ? 'Uploaded' : 'UploadFailed' }).catch(() => {});
  }

  private configStore = new Map<string, string>();
  private localListVersion = 0;
  private localListSize = 0;
  private stopReason = 'Local';

  /**
   * FACTORY defaults, deliberately not what a CSMS wants. A charger that
   * arrives already configured is not a test of provisioning — the interesting
   * path is the one where the CSMS has to diff and write, and where one of
   * those writes comes back Rejected.
   */
  private configurationKeys(): { key: string; readonly: boolean; value: string }[] {
    const base: Record<string, string> = {
      NumberOfConnectors: String(this.opts.connectors),
      HeartbeatInterval: '86400',
      MeterValueSampleInterval: '0',
      MeterValuesSampledData: 'Energy.Active.Import.Register',
      StopTxnSampledData: '',
      SupportedFeatureProfiles:
        'Core,SmartCharging,RemoteTrigger,LocalAuthListManagement,FirmwareManagement,Reservation',
      ChargingScheduleAllowedChargingRateUnit: this.opts.dc ? 'Power' : 'Current',
      LocalAuthListMaxLength: '1000',
      ChargeProfileMaxStackLevel: '8',
      ConnectionTimeOut: '60',
      WebSocketPingInterval: '0',
      ClockAlignedDataInterval: '0',
      LocalAuthListEnabled: 'false',
      LocalAuthorizeOffline: 'false',
      AllowOfflineTxForUnknownId: 'true',
      StopTransactionOnInvalidId: 'false',
      TransactionMessageAttempts: '3',
      TransactionMessageRetryInterval: '60',
    };
    for (const [k, v] of this.configStore) base[k] = v;
    const readonlyKeys = new Set([
      'NumberOfConnectors',
      'SupportedFeatureProfiles',
      'ChargingScheduleAllowedChargingRateUnit',
      'LocalAuthListMaxLength',
      'ChargeProfileMaxStackLevel',
    ]);
    return Object.entries(base).map(([key, value]) => ({ key, readonly: readonlyKeys.has(key), value }));
  }

  private async honourTrigger(msg: string, connectorId: unknown): Promise<void> {
    const c = Number(connectorId ?? 1) || 1;
    switch (msg) {
      case 'StatusNotification':
        await this.status(c, this.txId != null && c === this.activeConnector ? 'Charging' : 'Available');
        break;
      case 'Heartbeat':
        await this.call('Heartbeat', {});
        break;
      case 'BootNotification':
        await this.call('BootNotification', {
          chargePointVendor: this.opts.vendor,
          chargePointModel: this.opts.model,
          chargePointSerialNumber: this.opts.id,
          firmwareVersion: this.opts.firmware,
        });
        break;
      case 'MeterValues':
        await this.sendMeterValues(c, 'Trigger');
        break;
      case 'DiagnosticsStatusNotification':
        await this.call('DiagnosticsStatusNotification', { status: 'Idle' });
        break;
      case 'FirmwareStatusNotification':
        await this.call('FirmwareStatusNotification', { status: 'Idle' });
        break;
    }
  }

  private simulateReset(type: string): void {
    this.emit('reset', { type });
    this.sessionAbort = true;
    // A reset drops the socket and comes back through the normal reconnect path.
    this.dropConnection(`${type} reset`);
  }

  /**
   * SetChargingProfile. Units matter: `A` is PER PHASE, so the power ceiling is
   * limit x numberPhases x voltage. Treating amps as a whole-station figure is
   * how a 3-phase site ends up delivering a third of what it was told to.
   */
  private applyChargingProfile(profile: any): boolean {
    const sched = profile?.chargingSchedule;
    const period = sched?.chargingSchedulePeriod?.[0];
    // OCPP 2.1 discharge: a negative setpoint (CentralSetpoint). Only a bidirectional car that may use it.
    if (period && typeof period.setpoint === 'number' && period.setpoint < 0) {
      if (!this.sessionBidi || !this.bidiAllowed) return false;
      this.dischargeW = Math.min(-period.setpoint, this.opts.evMaxDischargeW, this.opts.maxPowerW);
      this.limitSource = `setpoint ${period.setpoint}W`;
      this.emit('limit', { limitW: this.limitW, dischargeW: this.dischargeW, source: this.limitSource, stackLevel: profile?.stackLevel });
      return true;
    }
    if (!period || typeof period.limit !== 'number') return false;
    this.dischargeW = 0;
    const unit = String(sched.chargingRateUnit ?? (this.opts.dc ? 'W' : 'A'));
    const phases = Number(period.numberPhases ?? this.opts.phases) || this.opts.phases;
    const watts =
      unit.toUpperCase() === 'A' ? period.limit * phases * this.opts.voltage : period.limit;
    this.limitW = Math.max(0, Math.min(Math.round(watts), this.opts.maxPowerW));
    this.limitSource = `${period.limit}${unit}${unit.toUpperCase() === 'A' ? `x${phases}p` : ''}`;
    this.emit('limit', { limitW: this.limitW, source: this.limitSource, stackLevel: profile?.stackLevel });
    return true;
  }

  // ---------------------------------------------------------------- session

  /**
   * Run one full charging session. Survives disconnection: anything that cannot
   * be sent is queued with its real occurrence time and replayed on reconnect.
   */
  async runSession(opts: { connectorId?: number; idTag?: string; kwh?: number; remote?: boolean; contract?: { emaid: string; hashData: unknown[] }; soc?: number; bidirectional?: boolean } = {}): Promise<{
    transactionId: number | null;
    deliveredWh: number;
    queued: number;
  }> {
    const connectorId = opts.connectorId ?? 1;
    // Plug & Charge: the car's contract is the identity; the charger sends its eMAID.
    const idTag = opts.contract ? opts.contract.emaid : opts.idTag ?? this.opts.idTag;
    const targetWh = (opts.kwh ?? this.opts.targetKwh) * 1000;
    this.activeConnector = connectorId;
    this.sessionAbort = false;
    this.inSession = true;
    this.stopReason = opts.remote ? 'Remote' : 'Local';
    // The car: its battery, and whether it offers to give energy back (only over OCPP 2.1).
    this.capacityWh = targetWh / 0.8;
    this.socPercent = Math.max(0, Math.min(100, opts.soc ?? 18));
    this.sessionBidi = (opts.bidirectional ?? this.opts.bidirectional) && this.opts.protocol === 'ocpp2.1';
    this.bidiAllowed = true;
    this.dischargeW = 0;
    // Starting on a reserved connector uses the reservation up.
    const held = this.reserved.get(connectorId);
    if (held) {
      clearTimeout(held.timer);
      this.reserved.delete(connectorId);
    }

    await this.statusSafe(connectorId, 'Preparing');

    if (this.isOpen) {
      try {
        const auth = opts.contract
          ? await this.pncCall('Authorize', { idToken: { idToken: opts.contract.emaid, type: 'eMAID' }, iso15118CertificateHashData: opts.contract.hashData }).then((r) => ({ idTagInfo: r?.idTokenInfo, certificateStatus: r?.certificateStatus }))
          : await this.call('Authorize', { idTag });
        this.emit('authorize', auth?.idTagInfo?.status);
        if (opts.contract) this.emit('pnc-authorize', auth);
        if (auth?.idTagInfo?.status !== 'Accepted') {
          // Refused card: no session was ever running.
          this.inSession = false;
          await this.statusSafe(connectorId, 'Available');
          return { transactionId: null, deliveredWh: 0, queued: 0 };
        }
      } catch (e) {
        this.emit('error', e as Error);
      }
    } else {
      if (opts.contract) {
        // Plug & Charge needs the CSMS (contract check, OCSP); this charger does not validate offline.
        this.emit('authorize', 'OfflineRefused');
        this.inSession = false;
        await this.statusSafe(connectorId, 'Available');
        return { transactionId: null, deliveredWh: 0, queued: 0 };
      }
      // Offline authorisation from the local list — exactly why we sync one.
      this.emit('authorize', 'OfflineLocalList');
    }

    const startedAt = this.now();
    const meterStart = Math.round(this.meterWh);
    // A signing meter signs the register at the start (OCMF, TX "B").
    const signedBegin = this.signReading('B', meterStart, idTag);
    const startPayload = { connectorId, idTag, meterStart, timestamp: startedAt, ...(signedBegin ? { _signedBegin: signedBegin } : {}) };
    const startConf = await this.submit('StartTransaction', startPayload, startedAt, { needsTxId: true });
    if (startConf?.transactionId != null) {
      this.txId = Number(startConf.transactionId);
      if (startConf.idTagInfo?.status && startConf.idTagInfo.status !== 'Accepted') {
        this.emit('error', new Error(`StartTransaction rejected idTag: ${startConf.idTagInfo.status}`));
      }
    } else {
      // Offline: run on a provisional local id until the replayed Start returns one.
      this.txId = null;
    }
    this.stats.sessions++;
    this.emit('transaction-started', { transactionId: this.txId, connectorId, meterStart, timestamp: startedAt });
    await this.statusSafe(connectorId, 'Charging');
    // ISO 15118: on OCPP 2.x the charger passes on what the car needs (and, on 2.1, whether it can give energy back).
    if (this.shim && this.isOpen) await this.call('NotifyEVChargingNeeds', this.chargingNeeds(connectorId, targetWh)).catch(() => {});

    let delivered = 0;
    const stepS = this.opts.meterIntervalS;
    const realStepMs = Math.max(5, (stepS / this.opts.speed) * 1000);

    while (delivered < targetWh && !this.sessionAbort) {
      await sleep(realStepMs);
      if (this.opts.simTime) this.simDriftMs += stepS * 1000 - realStepMs;
      // Asked to give energy back (OCPP 2.1 CentralSetpoint): the car discharges, down to its own 10 % floor.
      if (this.dischargeW > 0 && this.bidiAllowed && this.socPercent > 10) {
        const w = Math.min(this.dischargeW, this.opts.evMaxDischargeW, this.opts.maxPowerW);
        const outWh = (w * stepS) / 3600;
        this.rawExportWh += outWh;
        this.socPercent = Math.max(10, this.socPercent - (outWh / this.capacityWh) * 100);
        await this.sendMeterValues(connectorId, 'Sample.Periodic', { delivered, targetWh, powerW: 0, exportW: w });
        this.emit('meter', { deliveredWh: delivered, registerWh: this.meterWh, powerW: -w, limitW: this.limitW, online: this.isOpen });
        continue;
      }
      const powerW = this.instantaneousPowerW(delivered, targetWh);
      const stepWh = Math.min((powerW * stepS) / 3600, targetWh - delivered);
      delivered += stepWh;
      this.rawMeterWh += stepWh;
      this.stats.energyWh += stepWh;
      this.socPercent = Math.min(100, this.socPercent + (stepWh / this.capacityWh) * 100);
      await this.sendMeterValues(connectorId, 'Sample.Periodic', { delivered, targetWh, powerW });
      this.emit('meter', {
        deliveredWh: delivered,
        registerWh: this.meterWh,
        powerW,
        limitW: this.limitW,
        online: this.isOpen,
      });
    }

    await this.statusSafe(connectorId, 'Finishing');
    const stoppedAt = this.now();
    const registerWh = Math.round(this.meterWh);
    // The signed end reading (TX "E"); on 1.6 the signed start travels here too, as Eichrecht firmware sends it.
    const signedEnd = this.signReading('E', registerWh, idTag);
    const stopPayload: any = {
      transactionId: this.txId ?? 0,
      idTag,
      timestamp: stoppedAt,
      reason: this.stopReason,
      transactionData: [
        {
          timestamp: stoppedAt,
          sampledValue: [
            ...this.energySamples(registerWh + this.opts.transactionDataSkewWh, 'Transaction.End'),
            ...(signedBegin ? [signedBegin] : []),
            ...(signedEnd ? [signedEnd] : []),
          ],
        },
      ],
    };
    // FAULT: some firmware omits meterStop entirely. The CSMS must not bill zero.
    if (!this.opts.omitMeterStop) stopPayload.meterStop = registerWh;

    await this.submit('StopTransaction', stopPayload, stoppedAt, { bindTxId: true });
    this.emit('transaction-stopped', {
      transactionId: this.txId,
      deliveredWh: delivered,
      meterStop: this.opts.omitMeterStop ? null : registerWh,
      timestamp: stoppedAt,
    });
    const finishedTx = this.txId;
    this.txId = null;
    this.inSession = false;
    this.dischargeW = 0;
    this.sessionBidi = false;
    await this.statusSafe(connectorId, 'Available');
    return { transactionId: finishedTx, deliveredWh: delivered, queued: this.offlineQueue.length };
  }

  /**
   * Send a protocol-legal duplicate StartTransaction: the exact retry a charger
   * performs when the CALLRESULT never reaches it. Same connector, same idTag,
   * same meterStart, same timestamp — byte-identical to the first attempt.
   */
  async duplicateStart(original: { connectorId: number; idTag: string; meterStart: number; timestamp: string }): Promise<any> {
    this.stats.duplicatesSent++;
    this.emit('fault', { kind: 'duplicate-start', original });
    return this.submit('StartTransaction', { ...original }, original.timestamp);
  }

  private instantaneousPowerW(deliveredWh: number, targetWh: number): number {
    const ceiling = Math.min(this.limitW, this.opts.maxPowerW);
    const frac = targetWh > 0 ? deliveredWh / targetWh : 0;
    // Real batteries taper: constant current, then constant voltage. Model the
    // last 20% of the session as a linear roll-off to 15% of the ceiling.
    const taper = frac <= 0.8 ? 1 : Math.max(0.15, 1 - ((frac - 0.8) / 0.2) * 0.85);
    return Math.max(0, ceiling * taper);
  }

  /**
   * The energy register, as this hardware reports it.
   *
   * Real 3-phase AC units publish one Energy.Active.Import.Register PER PHASE —
   * in MeterValues and in StopTransaction.transactionData alike. A CSMS that
   * takes the first Energy sample it finds, ignoring `phase`, bills a third of
   * the energy. That is a 3x under-billing bug and it is invisible on any
   * single-phase bench unit.
   */
  private energySamples(registerWh: number, context: string): any[] {
    if (!this.opts.perPhase || this.opts.dc) {
      return [{ measurand: 'Energy.Active.Import.Register', value: Math.round(registerWh), unit: 'Wh', context }];
    }
    const per = registerWh / this.opts.phases;
    return Array.from({ length: this.opts.phases }, (_, i) => ({
      measurand: 'Energy.Active.Import.Register',
      phase: `L${i + 1}`,
      value: Math.round(per),
      unit: 'Wh',
      context,
    }));
  }

  private async sendMeterValues(
    connectorId: number,
    context: string,
    live?: { delivered: number; targetWh: number; powerW: number; exportW?: number },
  ): Promise<void> {
    const ts = this.now();
    // A triggered MeterValues outside the metering loop reports the last known
    // power, not a recomputed one — that is what the hardware would say.
    if (live) this.lastPowerW = live.powerW;
    const powerW = live?.powerW ?? (this.inSession ? this.lastPowerW : 0);
    const register = Math.round(this.meterWh);
    const soc = Math.round(this.socPercent);
    const phaseCount = this.opts.dc ? 1 : this.opts.phases;
    const current = this.opts.dc
      ? powerW / this.opts.voltage
      : powerW / (phaseCount * this.opts.voltage);

    const sampled: any[] = this.energySamples(register, context);

    sampled.push({ measurand: 'Power.Active.Import', value: Math.round(powerW), unit: 'W', context });
    if (this.opts.perPhase && !this.opts.dc) {
      for (let i = 0; i < phaseCount; i++) {
        sampled.push({
          measurand: 'Current.Import',
          phase: `L${i + 1}`,
          value: round2(current),
          unit: 'A',
          context,
        });
        sampled.push({
          measurand: 'Voltage',
          phase: `L${i + 1}-N`,
          value: round2(this.opts.voltage + (Math.random() * 4 - 2)),
          unit: 'V',
          context,
        });
      }
    } else {
      sampled.push({ measurand: 'Current.Import', value: round2(current), unit: 'A', context });
      sampled.push({
        measurand: 'Voltage',
        value: round2(this.opts.voltage + (Math.random() * 4 - 2)),
        unit: 'V',
        context,
      });
    }
    if (this.sessionBidi) {
      // A bidirectional session reports the export register (and the power going out while discharging).
      sampled.push({ measurand: 'Energy.Active.Export.Register', value: Math.round(this.rawExportWh), unit: 'Wh', context });
      if (live?.exportW) sampled.push({ measurand: 'Power.Active.Export', value: Math.round(live.exportW), unit: 'W', context });
    }
    if (live) sampled.push({ measurand: 'SoC', value: soc, unit: 'Percent', context });

    const payload: any = { connectorId, meterValue: [{ timestamp: ts, sampledValue: sampled }] };
    if (this.txId != null) payload.transactionId = this.txId;
    await this.submit('MeterValues', payload, ts, { bindTxId: this.inSession });
  }

  private status(connectorId: number, status: string): Promise<any> {
    return this.call('StatusNotification', {
      connectorId,
      errorCode: 'NoError',
      status,
      timestamp: this.now(),
    });
  }

  /** StatusNotification is not transactional: if we are down, it is simply lost. */
  private async statusSafe(connectorId: number, status: string): Promise<void> {
    if (!this.isOpen) return;
    try {
      await this.status(connectorId, status);
    } catch {
      /* a lost status notification is recoverable via TriggerMessage */
    }
  }

  // ------------------------------------------------------ store and forward

  /**
   * Submit a transactional message. If the link is down — or drops while the
   * call is in flight — it is queued with the timestamp at which it OCCURRED and
   * replayed on reconnect. Nothing billable is ever thrown away.
   */
  private async submit(
    action: QueuedMessage['action'],
    payload: any,
    occurredAt: string,
    flags: { needsTxId?: boolean; bindTxId?: boolean } = {},
  ): Promise<any | null> {
    if (this.isOpen && !this.opts.silent) {
      try {
        return await this.call(action, payload);
      } catch (e) {
        // In flight when the link went away — queue it, do not lose it.
        if (this.isOpen) {
          this.emit('error', e as Error);
          return null;
        }
      }
    }
    this.enqueue({ action, payload, occurredAt, ...flags });
    return null;
  }

  private enqueue(item: QueuedMessage): void {
    this.offlineQueue.push(item);
    this.stats.queuedOffline++;
    this.emit('queued', { action: item.action, occurredAt: item.occurredAt, depth: this.offlineQueue.length });
  }

  /**
   * Replay the store-and-forward buffer, oldest first.
   *
   * `replayShuffle` and `replayDuplicate` deliberately break that ordering: real
   * chargers do both, and the CSMS is supposed to be keyed on charger-supplied
   * facts rather than arrival order. This is how you find out whether it is.
   */
  async replayOfflineQueue(): Promise<{ sent: number; duplicated: number }> {
    if (this.offlineQueue.length === 0) return { sent: 0, duplicated: 0 };
    let items = this.offlineQueue.splice(0);
    const originalCount = items.length;

    if (this.opts.replayShuffle) items = shuffle(items);
    if (this.opts.replayDuplicate) {
      const doubled: QueuedMessage[] = [];
      for (const it of items) doubled.push(it, { ...it, payload: { ...it.payload } });
      items = doubled;
    }

    this.emit('replay-start', {
      count: items.length,
      shuffled: this.opts.replayShuffle,
      duplicated: this.opts.replayDuplicate,
      oldest: items.reduce((a, b) => (a < b.occurredAt ? a : b.occurredAt), items[0]!.occurredAt),
    });

    let sent = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (!this.isOpen) {
        // Link died again mid-replay: put the rest back, in order.
        this.offlineQueue.unshift(...items.slice(i));
        break;
      }
      const payload = { ...item.payload };
      // A session that started offline has no CSMS transactionId until its Start
      // is replayed. Stamp the real id on as soon as we learn it.
      if (item.bindTxId && this.txId != null) payload.transactionId = this.txId;
      try {
        const conf = await this.call(item.action, payload);
        sent++;
        this.stats.replayed++;
        if (item.needsTxId && conf?.transactionId != null) this.txId = Number(conf.transactionId);
        this.emit('replayed', { action: item.action, occurredAt: item.occurredAt, conf });
      } catch (e) {
        this.emit('error', e as Error);
        this.offlineQueue.push(item);
      }
    }

    this.emit('replay-done', { sent, remaining: this.offlineQueue.length });
    return { sent, duplicated: this.opts.replayDuplicate ? sent - Math.min(sent, originalCount) : 0 };
  }

  // ---------------------------------------------------------------- helpers

  /** Every timestamp we emit goes through here, so clock skew is total. */
  now(): string {
    return new Date(Date.now() + this.opts.clockSkewMs + this.simDriftMs).toISOString();
  }

  private setState(to: VcpState, extra: Omit<StateEvent, 'from' | 'to'> = {}): void {
    const from = this._state;
    if (from === to && to !== 'backoff') return;
    this._state = to;
    this.emit('state', { from, to, ...extra } as StateEvent);
  }
}

// ------------------------------------------------------------------ util

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fields the model carries for the 2.x layer (a leading underscore: the signed Begin reading, a
 * signed sample's numeric value) never reach a 1.6 CSMS.
 */
function strip16(p: unknown): unknown {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (k.startsWith('_')) continue;
    out[k] = k === 'transactionData' || k === 'meterValue'
      ? (v as any[]).map((m) => ({ ...m, sampledValue: (m.sampledValue ?? []).map((s: any) => Object.fromEntries(Object.entries(s).filter(([sk]) => !sk.startsWith('_')))) }))
      : v;
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const ai = a[i]!;
    a[i] = a[j]!;
    a[j] = ai;
  }
  return a;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}
