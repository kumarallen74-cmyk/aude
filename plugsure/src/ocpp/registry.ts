import type { WebSocket } from 'ws';
import type { OcppRpcConnection } from './rpc.js';
import type { OcppVersion } from '../domain/canonical.js';

/**
 * Connection registry.
 *
 * In this scaffold it is an in-process Map. In production each gateway node
 * registers `cp:{identity} -> node:{nodeId}` in Redis with a heartbeat-refreshed
 * TTL, and commands are routed over Redis pub/sub to the owning node. The API
 * never holds a socket; it correlates a command to a reply.
 *
 * Design assumption: any gateway node may die at any moment and the only cost is
 * a charger reconnect.
 *
 * Two correctness rules learned the hard way:
 *
 *  1. RECONNECT RACES. A charger that reconnects registers under the same
 *     identity, and only THEN does the old socket's close event fire. Without a
 *     generation token that late close evicts the live connection and the charge
 *     point silently becomes uncommandable. Every registration carries a token
 *     and unregister only removes its own generation.
 *
 *  2. STALE ENTRIES LIE. A socket can be dead while the map still holds it, so
 *     lookups verify readyState. Reporting a charger as online when it cannot be
 *     commanded is worse than reporting it offline.
 */
export interface Registered {
  ocppIdentity: string;
  chargePointId: string;
  version: OcppVersion;
  rpc: OcppRpcConnection;
  ws: WebSocket;
  connectedAt: Date;
  quirkProfileId?: string | null;
  /** Generation token, assigned by register(). */
  token: number;
  /**
   * True when a ping is outstanding. A 4G socket behind carrier NAT can go
   * half-open and never emit 'close'; a missed pong is the only timely signal.
   */
  awaitingPong: boolean;
  lastPongAt: Date;
}

const OPEN = 1; // ws.OPEN

const conns = new Map<string, Registered>();
let nextToken = 1;

export function register(r: Omit<Registered, 'token' | 'awaitingPong' | 'lastPongAt'>): number {
  const token = nextToken++;
  conns.set(r.ocppIdentity, { ...r, token, awaitingPong: false, lastPongAt: new Date() });
  return token;
}

export function markPingSent(ocppIdentity: string): void {
  const r = conns.get(ocppIdentity);
  if (r) r.awaitingPong = true;
}

export function markPong(ocppIdentity: string): void {
  const r = conns.get(ocppIdentity);
  if (r) {
    r.awaitingPong = false;
    r.lastPongAt = new Date();
  }
}

/** Only removes the entry if it is the generation the caller registered. */
export function unregister(ocppIdentity: string, token?: number): boolean {
  const cur = conns.get(ocppIdentity);
  if (!cur) return false;
  if (token !== undefined && cur.token !== token) return false; // a newer connection owns this identity
  conns.delete(ocppIdentity);
  return true;
}

export function get(ocppIdentity: string): Registered | undefined {
  const r = conns.get(ocppIdentity);
  if (!r) return undefined;
  if (r.ws.readyState !== OPEN) {
    conns.delete(ocppIdentity);
    return undefined;
  }
  return r;
}

export function all(): Registered[] {
  for (const [id, r] of conns) if (r.ws.readyState !== OPEN) conns.delete(id);
  return [...conns.values()];
}

export function isOnline(ocppIdentity: string): boolean {
  return get(ocppIdentity) !== undefined || remoteOnline(ocppIdentity);
}

export function clear() {
  conns.clear();
  remote = null;
}

// ------------------------------------------------------------ remote mirror
//
// In the split deployment the sockets live in the GATEWAY process and this
// module, loaded in the API process, holds none — so every `isOnline()` in the
// API (fleet list, driver app, load management) answered false for every charger.
// The API's bridge client (ocpp/bridge.ts) refreshes this mirror from the
// gateway every few seconds. It is ONLY consulted when no local socket exists,
// so the single-process deployment is unaffected (the mirror stays null).

export interface RemoteConnection {
  ocppIdentity: string;
  version: OcppVersion;
  connectedAt: string;
}

let remote: { at: number; byId: Map<string, RemoteConnection> } | null = null;
/** A mirror older than this is treated as unknown, i.e. offline. */
const REMOTE_STALE_MS = 20_000;

export function setRemoteSnapshot(list: RemoteConnection[]): void {
  remote = { at: Date.now(), byId: new Map(list.map((c) => [c.ocppIdentity, c])) };
}

export function remoteConnection(ocppIdentity: string): RemoteConnection | undefined {
  if (!remote || Date.now() - remote.at > REMOTE_STALE_MS) return undefined;
  return remote.byId.get(ocppIdentity);
}

function remoteOnline(ocppIdentity: string): boolean {
  return remoteConnection(ocppIdentity) !== undefined;
}

/** Negotiated version for a charger, local or mirrored. */
export function versionOf(ocppIdentity: string): OcppVersion | undefined {
  return get(ocppIdentity)?.version ?? remoteConnection(ocppIdentity)?.version;
}

/**
 * A stored transaction id in the form this charger's protocol expects on the wire:
 * 1.6 transaction ids are integers, 2.0.1 ids are the station's own strings.
 * Every command that addresses a transaction (stop, TxProfile) must go through
 * this. `Number()` on a 2.0.1 id sends "NaN", which the station cannot match —
 * the prepaid cut-off silently failed that way and let paid sessions overrun.
 */
export function wireTransactionId(ocppIdentity: string, stored: string | number): string | number {
  const v = versionOf(ocppIdentity);
  return v === 'ocpp2.0.1' || v === 'ocpp2.1' ? String(stored) : Number(stored);
}

/** Every identity reachable from this process, local or through the bridge. */
export function onlineIdentities(): string[] {
  const ids = new Set(all().map((r) => r.ocppIdentity));
  if (remote && Date.now() - remote.at <= REMOTE_STALE_MS) for (const id of remote.byId.keys()) ids.add(id);
  return [...ids];
}
